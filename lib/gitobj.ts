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

export function deflateLoose(type: GitObjectType, data: Uint8Array): Buffer {
  return deflateSync(encodeLooseObject(type, data));
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
  return { type, data };
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) break;
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
  const out = Buffer.allocUnsafe(targetSize);
  let outOffset = 0;

  while (dOffset < deltaBuf.length) {
    const cmd = deltaBuf[dOffset++]!;
    if (cmd & 0x80) {
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
      deltaBuf.copy(out, outOffset, dOffset, dOffset + cmd);
      dOffset += cmd;
      outOffset += cmd;
    } else {
      break;
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

export function readPack(pack: Uint8Array, options: { resolveBase?: (oid: string) => Buffer | undefined } = {}): Array<{ type: GitObjectType; data: Buffer; oid: string }> {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) return [];
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') return [];
  const numObjects = buffer.readUInt32BE(8);

  let offset = 12;
  const entries: Array<{ offset: number; typeCode: number; size: number; data?: Buffer; baseOffset?: number; baseOid?: string; resolved?: { type: GitObjectType; data: Buffer; oid: string } }> = [];
  const byOffset = new Map<number, any>();

  for (let i = 0; i < numObjects; i++) {
    const entryOffset = offset;
    let byte = buffer[offset++]!;
    let typeCode = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;

    while (byte & 0x80) {
      if (offset >= buffer.length) break;
      byte = buffer[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }

    const entry: any = { offset: entryOffset, typeCode, size };
    if (typeCode === 6) {
      // ofs-delta
      let c = buffer[offset++]!;
      let baseRelative = c & 0x7f;
      while (c & 0x80) {
        c = buffer[offset++]!;
        baseRelative = ((baseRelative + 1) << 7) | (c & 0x7f);
      }
      entry.baseOffset = entryOffset - baseRelative;
    } else if (typeCode === 7) {
      // ref-delta
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    try {
      const res = inflateSync(buffer.subarray(offset), { info: true }) as any;
      entry.data = res.buffer;
      offset += res.engine?.bytesRead ?? res.bytesRead ?? 1;
    } catch {
      break;
    }

    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const typeMap: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolvedObjects: Array<{ type: GitObjectType; data: Buffer; oid: string }> = [];

  const resolve = (e: any): { type: GitObjectType; data: Buffer; oid: string } => {
    if (e.resolved) return e.resolved;
    if (typeMap[e.typeCode]) {
      const type = typeMap[e.typeCode]!;
      const oid = hashObject(type, e.data);
      e.resolved = { type, data: e.data, oid };
      return e.resolved;
    }
    if (e.typeCode === 6) {
      const baseE = byOffset.get(e.baseOffset);
      const base = resolve(baseE);
      const targetData = patchDelta(base.data, e.data);
      const type = base.type;
      const oid = hashObject(type, targetData);
      e.resolved = { type, data: targetData, oid };
      return e.resolved;
    }
    if (e.typeCode === 7) {
      let baseBuf = options.resolveBase?.(e.baseOid);
      let baseType: GitObjectType = 'blob';
      const targetData = patchDelta(baseBuf ?? Buffer.alloc(0), e.data);
      const oid = hashObject(baseType, targetData);
      e.resolved = { type: baseType, data: targetData, oid };
      return e.resolved;
    }
    throw new Error(`Unknown pack object type code ${e.typeCode}`);
  };

  for (const entry of entries) {
    try {
      const resolved = resolve(entry);
      resolvedObjects.push(resolved);
    } catch {}
  }

  return resolvedObjects;
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

export function typeOfGitObject(
  store: {
    objects: Map<string, Buffer>;
    objectTypes: Map<string, GitObjectType>;
  },
  oid: string
): GitObjectType | undefined {
  const cached = store.objectTypes.get(oid);
  if (cached) return cached;
  const payload = store.objects.get(oid);
  if (!payload) return undefined;

  const text = payload.toString('utf8');
  if (text.startsWith('tree ') && text.includes('\nauthor ')) {
    return 'commit';
  }
  if (text.startsWith('object ') && text.includes('\ntype ')) {
    return 'tag';
  }

  try {
    const entries = parseTree(payload);
    let sum = 0;
    for (const entry of entries) {
      sum += entry.mode.length + 1 + entry.name.length + 1 + 20;
    }
    if (sum === payload.length || (payload.length === 0 && entries.length === 0)) {
      return 'tree';
    }
  } catch {}

  return 'blob';
}

