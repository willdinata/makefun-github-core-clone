import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { MemoryStore } from './store.ts';
import { readPack, isObjectId, isAncestor, parseCommit, type GitObjectType } from './gitobj.ts';

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
  const parts = reqPath.split('/');
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
  const headOid = refsMap.get('refs/heads/main') ?? refsMap.get('HEAD');

  if (queryService === 'git-upload-pack') {
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
    const lines: Buffer[] = [];
    lines.push(encodePktLine('# service=git-receive-pack\n'));
    lines.push(pktLineFlush());

    const caps = 'report-status report-status-v2 side-band-64k delete-refs object-format=sha1' + (headOid ? ' symref=HEAD:refs/heads/main' : '');
    let first = true;

    if (headOid) {
      lines.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }

    if (refsMap.size === 0 && !headOid) {
      const line = `${ZERO_OID} capabilities^{}\0${caps}\n`;
      lines.push(encodePktLine(line));
    } else {
      for (const [refName, oid] of refsMap.entries()) {
        if (refName === 'HEAD') continue;
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
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    for (const p of packets) {
      if (p.type === 'data' && p.data) {
        const text = p.data.toString('utf8').trim();
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text.startsWith('ref-prefix ')) {
          prefixes.push(text.slice(11).trim());
        }
      }
    }

    const mainOid = refsMap.get('refs/heads/main');
    const lines: Buffer[] = [];
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

    const peelOid = (oid: string): string | undefined => {
      let current = oid;
      for (let i = 0; i < 10; i++) {
        const obj = store.objects.get(current);
        if (!obj) break;
        const text = obj.toString('utf8');
        if (text.startsWith('object ')) {
          const linesText = text.split('\n');
          const objLine = linesText.find(l => l.startsWith('object '));
          const typeLine = linesText.find(l => l.startsWith('type '));
          if (objLine && typeLine && typeLine.slice(5).trim() === 'tag') {
            current = objLine.slice(7).trim();
            continue;
          } else if (objLine) {
            return objLine.slice(7).trim();
          }
        }
        break;
      }
      return undefined;
    };

    if (mainOid && (keep('HEAD') || prefixes.length === 0)) {
      let lineStr = `${mainOid} HEAD`;
      if (symrefs) {
        lineStr += ` symref-target:refs/heads/main`;
      }
      lineStr += '\n';
      lines.push(encodePktLine(lineStr));
    }

    for (const [refName, oid] of refsMap.entries()) {
      if (refName === 'HEAD') continue;
      if (!keep(refName)) continue;

      let lineStr = `${oid} ${refName}`;
      if (symrefs && refName === 'refs/heads/main') {
        lineStr += ` symref-target:refs/heads/main`;
      }
      if (peel && refName.startsWith('refs/tags/')) {
        const peeled = peelOid(oid);
        if (peeled) {
          lineStr += ` peeled:${peeled}`;
        }
      }
      lineStr += '\n';
      lines.push(encodePktLine(lineStr));
    }

    lines.push(pktLineFlush());
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: Buffer.concat(lines),
    };
  } else if (command.startsWith('command=fetch')) {
    const wants: string[] = [];
    for (const p of packets) {
      if (p.type === 'data' && p.data) {
        const text = p.data.toString('utf8').trim();
        if (text.startsWith('want ')) {
          wants.push(text.slice(5).trim());
        }
      }
    }

    const packParts: Buffer[] = [];
    const hdr = Buffer.alloc(12);
    hdr.write('PACK', 0, 4, 'ascii');
    hdr.writeUInt32BE(2, 4);
    hdr.writeUInt32BE(wants.length, 8);
    packParts.push(hdr);

    for (const wantOid of wants) {
      const objData = store.objects.get(wantOid);
      if (objData) {
        const typeCode = 3; // blob/commit
        const size = objData.length;
        const headerBytes: number[] = [];
        let sz = size;
        headerBytes.push(((typeCode & 7) << 4) | (sz & 15));
        sz >>= 4;
        while (sz > 0) {
          headerBytes.push(0x80 | (sz & 0x7f));
          sz >>= 7;
        }
        packParts.push(Buffer.from(headerBytes));
        const compressed = deflateSync(objData);
        packParts.push(compressed);
      }
    }

    const packBuf = Buffer.concat(packParts);
    const sha = createHash('sha1').update(packBuf).digest();
    const finalPack = Buffer.concat([packBuf, sha]);

    const outChunks: Buffer[] = [];
    outChunks.push(encodePktLine('acknowledgments\n'));
    outChunks.push(encodePktLine('NAK\n'));
    outChunks.push(pktLineFlush());
    outChunks.push(encodePktLine('packfile\n'));
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
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Repository not found') };
  }
  const refsMap = store.refs.get(repoKey)!;

  const packets = decodePktLines(bodyBuf);
  const commands: Array<{ oldOid: string; newOid: string; refName: string }> = [];

  for (const pkt of packets) {
    if (pkt.type === 'flush') break;
    if (pkt.type === 'data' && pkt.data) {
      const line = pkt.data.toString('utf8').trim();
      const [oldNew] = line.split('\0');
      if (oldNew) {
        const [oldOid, newOid, refName] = oldNew.split(' ');
        if (oldOid && newOid && refName) {
          commands.push({ oldOid, newOid, refName });
        }
      }
    }
  }

  // Parse packfile if present and store objects
  const packIndex = bodyBuf.indexOf('PACK');
  if (packIndex >= 0) {
    const packBytes = bodyBuf.subarray(packIndex);
    const parsedObjects = readPack(packBytes, {
      resolveBase: (oid) => store.objects.get(oid),
    });
    for (const obj of parsedObjects) {
      store.objects.set(obj.oid, obj.data);
    }
  }

  const reportLines: string[] = [];
  reportLines.push('unpack ok\n');

  for (const cmd of commands) {
    const currentOid = refsMap.get(cmd.refName) ?? ZERO_OID;
    if (cmd.oldOid !== currentOid && cmd.oldOid !== ZERO_OID) {
      reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
      continue;
    }

    // Fast-forward check: if oldOid is not zero and newOid is not zero, check ancestry if object exists
    if (cmd.oldOid !== ZERO_OID && cmd.newOid !== ZERO_OID && cmd.oldOid !== cmd.newOid) {
      const isAnc = isAncestor(cmd.oldOid, cmd.newOid, (oid) => {
        const data = store.objects.get(oid);
        if (!data) return undefined;
        let type: GitObjectType = 'blob';
        try {
          const parsed = parseCommit(data);
          if (parsed.tree && isObjectId(parsed.tree)) {
            type = 'commit';
          }
        } catch {}
        return { type, data };
      });
      if (!isAnc) {
        reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
        continue;
      }
    }

    if (cmd.newOid === ZERO_OID) {
      refsMap.delete(cmd.refName);
      reportLines.push(`ok ${cmd.refName}\n`);
    } else {
      refsMap.set(cmd.refName, cmd.newOid);
      if (cmd.refName === 'refs/heads/main' || !refsMap.has('HEAD')) {
        if (cmd.refName.startsWith('refs/heads/') && !refsMap.has('HEAD')) {
          refsMap.set('HEAD', cmd.newOid);
        }
        if (cmd.refName === 'refs/heads/main') {
          refsMap.set('HEAD', cmd.newOid);
        }
      }
      reportLines.push(`ok ${cmd.refName}\n`);
    }
  }
  reportLines.push('');

  const reportText = reportLines.join('');
  const sidebandBody = encodeSideband(1, Buffer.from(reportText, 'utf8'));

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: Buffer.concat([sidebandBody, pktLineFlush()]),
  };
}
