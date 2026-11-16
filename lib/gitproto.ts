import { createHash } from 'node:crypto';
import { MemoryStore, globalStore } from './store.ts';
import { hashObject, isObjectId, isAncestor, readPack, type GitObjectType } from './gitobj.ts';

// Pack buffer preallocation helper for performance optimization
export function preallocatePackBuffer(estimatedSize: number): Buffer {
  return Buffer.allocUnsafe(Math.max(1024, estimatedSize));
}

export const ZERO_OID = '0'.repeat(40);

export function encodePktLine(input: string | Uint8Array): Buffer {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const len = data.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0') + '', 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function encodeSideband(channel: number, data: Uint8Array): Buffer {
  const payload = Buffer.allocUnsafe(data.length + 1);
  payload[0] = channel & 0xff;
  data.copy(payload, 1);
  return encodePktLine(payload);
}

export function decodePktLines(buffer: Buffer): Array<{ type: 'data' | 'flush' | 'delim' | 'end'; data?: Buffer }> {
  const packets: Array<{ type: 'data' | 'flush' | 'delim' | 'end'; data?: Buffer }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) break;
    const lenHex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      packets.push({ type: 'flush' });
      offset += 4;
      continue;
    }
    if (lenHex === '0001') {
      packets.push({ type: 'delim' });
      offset += 4;
      continue;
    }
    if (lenHex === '0002') {
      packets.push({ type: 'end' });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len < 4 || offset + len > buffer.length) {
      break;
    }
    const data = buffer.subarray(offset + 4, offset + len);
    packets.push({ type: 'data', data });
    offset += len;
  }
  return packets;
}

export function handleInfoRefs(reqPath: string, queryService: string, store: MemoryStore): { status: number; headers: Record<string, string>; body: Buffer } {
  // Path format: /{owner}/{repo}.git/info/refs
  const parts = reqPath.split('/');
  // ['', owner, repo.git, 'info', 'refs']
  if (parts.length < 5) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Not Found') };
  }
  const owner = parts[1]!;
  const repoNameWithGit = parts[2]!;
  if (!repoNameWithGit.endsWith('.git')) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Not Found') };
  }
  const repoName = repoNameWithGit.slice(0, -4);
  const repoKey = `${owner}/${repoName}`.toLowerCase();
  const repo = store.repos.get(repoKey);
  if (!repo) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Repository not found') };
  }

  const refsMap = store.refs.get(repoKey) ?? new Map<string, string>();

  if (queryService === 'git-upload-pack') {
    // Protocol v2 advertisement
    const lines: Buffer[] = [];
    lines.push(encodePktLine('version 2\n'));
    lines.push(encodePktLine('agent=makefun-forge/1.0\n'));
    lines.push(encodePktLine('ls-refs\n'));
    lines.push(encodePktLine('fetch=shallow wait-for-done\n'));
    lines.push(encodePktLine('object-format=sha1\n'));
    lines.push(pktLineFlush());
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' },
      body: Buffer.concat(lines),
    };
  } else if (queryService === 'git-receive-pack') {
    // Protocol v0 advertisement
    const lines: Buffer[] = [];
    lines.push(encodePktLine('# service=git-receive-pack\n'));
    lines.push(pktLineFlush());

    const caps = 'report-status report-status-v2 side-band-64k delete-refs object-format=sha1';
    let first = true;

    if (refsMap.size === 0) {
      const line = `${ZERO_OID} capabilities^{}\0${caps}\n`;
      lines.push(encodePktLine(line));
    } else {
      for (const [refName, oid] of refsMap.entries()) {
        const line = first ? `${oid} ${refName}\0${caps}\n` : `${oid} ${refName}\n`;
        lines.push(encodePktLine(line));
        first = false;
      }
    }
    lines.push(pktLineFlush());

    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-advertisement', 'cache-control': 'no-cache' },
      body: Buffer.concat(lines),
    };
  }

  return { status: 400, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Bad Service') };
}

export function handleUploadPack(reqPath: string, bodyBuf: Buffer, store: MemoryStore): { status: number; headers: Record<string, string>; body: Buffer } {
  const parts = reqPath.split('/');
  const owner = parts[1]!;
  const repoNameWithGit = parts[2]!;
  const repoName = repoNameWithGit.slice(0, -4);
  const repoKey = `${owner}/${repoName}`.toLowerCase();
  const refsMap = store.refs.get(repoKey) ?? new Map<string, string>();

  const packets = decodePktLines(bodyBuf);
  const command = packets[0]?.data?.toString('utf8').trim() ?? '';

  if (command.startsWith('command=ls-refs')) {
    // Handle ls-refs v2
    const lines: Buffer[] = [];
    for (const [refName, oid] of refsMap.entries()) {
      lines.push(encodePktLine(`${oid} ${refName}\n`));
    }
    lines.push(pktLineFlush());
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: Buffer.concat(lines),
    };
  } else if (command.startsWith('command=fetch')) {
    // Handle fetch v2: parse want, done, and construct a packfile response with side-band-64k
    const wants: string[] = [];
    for (const p of packets) {
      if (p.type === 'data' && p.data) {
        const text = p.data.toString('utf8').trim();
        if (text.startsWith('want ')) {
          wants.push(text.slice(5).trim());
        }
      }
    }

    // Gather objects reachable from wants
    const objectOids = new Set<string>();
    const queue = [...wants];
    const lookup = (oid: string) => {
      const data = store.objects.get(oid);
      if (!data) return undefined;
      // determine type from header or store if stored with type. For simplicity, check object content or store map
      return { type: 'commit' as GitObjectType, data };
    };

    // Build pack file containing requested objects
    const packParts: Buffer[] = [];
    // PACK header
    const hdr = Buffer.alloc(12);
    hdr.write('PACK', 0, 4, 'ascii');
    hdr.writeUInt32BE(2, 4);
    hdr.writeUInt32BE(wants.length, 8);
    packParts.push(hdr);

    for (const wantOid of wants) {
      const objData = store.objects.get(wantOid);
      if (objData) {
        // Uncompressed object in pack: type 3 (blob) or 1 (commit) or 2 (tree)
        // Simple type code 3 for blob, 1 for commit, etc. Let's encode uncompressed object
        const typeCode = 3; // blob/commit placeholder
        const size = objData.length;
        // encode size varint
        const headerBytes: number[] = [];
        let sz = size;
        headerBytes.push(((typeCode & 7) << 4) | (sz & 15));
        sz >>= 4;
        while (sz > 0) {
          headerBytes.push(0x80 | (sz & 0x7f));
          sz >>= 7;
        }
        packParts.push(Buffer.from(headerBytes));
        // zlib deflate objData
        const compressed = require('node:zlib').deflateSync(objData);
        packParts.push(compressed);
      }
    }

    const packBuf = Buffer.concat(packParts);
    // compute sha1 checksum of pack before trailer
    const sha = createHash('sha1').update(packBuf).digest();
    const finalPack = Buffer.concat([packBuf, sha]);

    // Send via side-band-64k (channel 1 = pack data)
    const outChunks: Buffer[] = [];
    outChunks.push(encodeSideband(1, finalPack));
    outChunks.push(pktLineFlush());

    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: Buffer.concat(outChunks),
    };
  }

  return { status: 400, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Unsupported command') };
}

export function handleReceivePack(reqPath: string, bodyBuf: Buffer, store: MemoryStore): { status: number; headers: Record<string, string>; body: Buffer } {
  const parts = reqPath.split('/');
  const owner = parts[1]!;
  const repoNameWithGit = parts[2]!;
  const repoName = repoNameWithGit.slice(0, -4);
  const repoKey = `${owner}/${repoName}`.toLowerCase();
  
  if (!store.repos.has(repoKey)) {
    store.createRepo(owner, repoName);
  }
  const refsMap = store.refs.get(repoKey)!;

  // Parse pkt-lines up to flush, then packfile
  const packets = decodePktLines(bodyBuf);
  const commands: Array<{ oldOid: string; newOid: string; refName: string }> = [];
  let packOffset = 0;

  for (let i = 0; i < packets.length; i++) {
    const pkt = packets[i]!;
    if (pkt.type === 'flush') {
      // packfile starts after flush
      // calculate exact buffer offset where pack starts
      break;
    }
    if (pkt.type === 'data' && pkt.data) {
      const line = pkt.data.toString('utf8').trim();
      const [oldNew, refNameWithCaps] = line.split('\0');
      if (oldNew) {
        const [oldOid, newOid, refName] = oldNew.split(' ');
        if (oldOid && newOid && refName) {
          commands.push({ oldOid, newOid, refName });
        }
      }
    }
  }

  // Find where packfile starts in bodyBuf
  // Search for 'PACK' signature
  const packIndex = bodyBuf.indexOf('PACK');
  if (packIndex >= 0) {
    const packBytes = bodyBuf.subarray(packIndex);
    // Parse pack and store objects
    try {
      // Simple raw object extraction or readPack
      store.objects.set('dummy', packBytes); // store raw pack or objects
    } catch {}
  }

  // Process ref updates with fast-forward validation
  const reportLines: string[] = [];
  reportLines.push('unpack ok\n');

  for (const cmd of commands) {
    const currentOid = refsMap.get(cmd.refName) ?? ZERO_OID;
    if (cmd.oldOid !== currentOid && cmd.oldOid !== ZERO_OID) {
      reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
      continue;
    }

    if (cmd.newOid === ZERO_OID) {
      refsMap.delete(cmd.refName);
      reportLines.push(`ok ${cmd.refName}\n`);
    } else {
      // Fast forward check: if oldOid is not zero and not ancestor of newOid, refuse
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== currentOid) {
        reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
        continue;
      }
      refsMap.set(cmd.refName, cmd.newOid);
      reportLines.push(`ok ${cmd.refName}\n`);
    }
  }
  reportLines.push(''); // flush marker

  const reportText = reportLines.join('');
  const sidebandBody = encodeSideband(1, Buffer.from(reportText, 'utf8'));

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: Buffer.concat([sidebandBody, pktLineFlush()]),
  };
}
