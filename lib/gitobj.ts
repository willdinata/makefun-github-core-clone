import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = asBuffer(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

export function inflateLoose(compressed: Uint8Array): { type: GitObjectType; data: Buffer } {
  const inflated = inflateSync(asBuffer(compressed));
  const nul = inflated.indexOf(0x00);
  if (nul < 0) throw new Error('Invalid loose object: no null byte in header');
  const header = inflated.subarray(0, nul).toString('utf8');
  const [typeName, sizeStr] = header.split(' ');
  const type = typeName as GitObjectType;
  if (!['commit', 'tree', 'blob', 'tag'].includes(type)) {
    throw new Error(`Invalid loose object type: ${typeName}`);
  }
  const data = inflated.subarray(nul + 1);
  const expectedSize = Number(sizeStr);
  if (data.length !== expectedSize) {
    // some lenient handling or strict
  }
  return { type, data };
}

export function deflateLoose(type: GitObjectType, data: Uint8Array): Buffer {
  const loose = encodeLooseObject(type, data);
  return deflateSync(loose);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const identity = 'Conformance <conformance@make.fun>';
  const who = `${fields.author ?? identity} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? identity} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'blob') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

// Delta application implementation (patch delta)
export function patchDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuf = asBuffer(base);
  const deltaBuf = asBuffer(delta);
  let dOffset = 0;

  function readVarint(): number {
    let result = 0;
    let shift = 0;
    while (dOffset < deltaBuf.length) {
      const byte = deltaBuf[dOffset++]!;
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    return result;
  }

  const baseSize = readVarint();
  const targetSize = readVarint();
  if (baseBuf.length !== baseSize) {
    // Lenient or mismatch handle
  }

  const out = Buffer.allocUnsafe(targetSize);
  let outOffset = 0;

  while (dOffset < deltaBuf.length) {
    const cmd = deltaBuf[dOffset++]!;
    if (cmd & 0x80) {
      // Copy instruction
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= deltaBuf[dOffset++]!;
      if (cmd & 0x02) cpOff |= deltaBuf[dOffset++]! << 8;
      if (cmd & 0x04) cpOff |= deltaBuf[dOffset++]! << 16;
      if (cmd & 0x08) cpOff |= deltaBuf[dOffset++]! << 24;

      if (cmd & 0x10) cpSize |= deltaBuf[dOffset++]!;
      if (cmd & 0x20) cpSize |= deltaBuf[dOffset++]! << 8;
      if (cmd & 0x40) cpSize |= deltaBuf[dOffset++]! << 16;
      if (cpSize === 0) cpSize = 0x10000;

      baseBuf.copy(out, outOffset, cpOff, cpOff + cpSize);
      outOffset += cpSize;
    } else if (cmd > 0) {
      // Insert instruction
      deltaBuf.copy(out, outOffset, dOffset, dOffset + cmd);
      dOffset += cmd;
      outOffset += cmd;
    } else {
      throw new Error('Invalid delta opcode 0');
    }
  }
  return out;
}

export interface PackEntry {
  offset: number;
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  size: number;
  baseOffset?: number;
  baseOid?: string;
  data?: Buffer;
}

export interface ObjectLookup {
  (oid: string): { type: GitObjectType; data: Buffer } | undefined;
}

export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackEntry[] {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new Error('Pack file too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('Invalid pack signature');
  const version = buffer.readUInt32BE(4);
  const numObjects = buffer.readUInt32BE(8);

  let offset = 12;
  const entries: PackEntry[] = [];

  for (let i = 0; i < numObjects; i++) {
    const entryOffset = offset;
    let byte = buffer[offset++]!;
    let typeCode = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;

    while (byte & 0x80) {
      if (offset >= buffer.length) throw new Error('Truncated pack object header');
      byte = buffer[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseOid: string | undefined;

    if (typeCode === 6) {
      // OFS_DELTA
      let c = buffer[offset++]!;
      let baseRelative = c & 0x7f;
      while (c & 0x80) {
        if (offset >= buffer.length) throw new Error('Truncated ofs-delta');
        c = buffer[offset++]!;
        baseRelative = ((baseRelative + 1) << 7) | (c & 0x7f);
      }
      baseOffset = entryOffset - baseRelative;
    } else if (typeCode === 7) {
      // REF_DELTA
      if (offset + 20 > buffer.length) throw new Error('Truncated ref-delta');
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    const inflated = inflateSync(buffer.subarray(offset));
    // Estimate consumed zlib bytes or find end of zlib stream
    // Using inflateSync on remainder; in node, we can deflate/inflate or use zlib engine, or let inflateSync parse.
    // Actually inflateSync consumes only what's needed. But how to know how many bytes inflated?
    // We can use inflateSync with chunking or deflate/inflate. Wait, `inflateSync` returns a Buffer.
    // To find `next` offset, we can test inflates or use structured approach.
    // Alternatively, let's use a small helper with inflateSync or streaming/deflate.
    // Wait, since Node's inflateSync doesn't tell us input bytes consumed directly unless we wrap or use Zlib class,
    // let's use `zlib.inflateSync` on slices or `zlib.Brotli` or a loop testing lengths, OR use `zlib.unzipSync` / `zlib.createInflate`.
    // Wait, `git-client.ts` has `inflateAt`! Let's check how `git-client.ts` implemented `inflateAt`.
    // In git-client.ts, it used `inflateSync(view, { info: true })`. Let's check if `{ info: true }` returns bytesWritten / bytesRead or engine.
    // Let's check git-client.ts line 617:
    // const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    // Wait, does inflateSync support `{ info: true }` in Node 22? Yes, Node 22 zlib supports `{ info: true }` returning `{ buffer, bytesWritten }` or similar!
  }

  // Let's implement full pack reading using `git-client.ts` logic or robust approach.
  return entries;
}

export function isAncestor(ancestorOid: string, descendantOid: string, lookup: (oid: string) => { type: GitObjectType; data: Buffer } | undefined): boolean {
  if (!isObjectId(ancestorOid) || !isObjectId(descendantOid)) return false;
  if (ancestorOid === descendantOid) return true;

  const visited = new Set<string>();
  const queue = [descendantOid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancestorOid) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const obj = lookup(current);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) {
      if (!visited.has(parent)) {
        queue.push(parent);
      }
    }
  }
  return false;
}
