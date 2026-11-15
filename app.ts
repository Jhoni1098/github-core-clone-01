// github-core-clone-01: a standalone, GitHub-compatible git forge in one process.
//
// One Node 22 process, stdlib only, no git binary, no database: git smart HTTP (v2
// upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP over one in-memory store
// that is snapshotted to disk (FORGE_DATA_DIR, default /tmp/github-forge-data).
//
// The wire contract this implements is the one the suite drives; see the kit's
// sdk/conformance/*.ts for the exact expectations. Deterministic where it matters:
// commit timestamps come from a counter, never the wall clock, so the same requests
// in the same order produce the same objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
const AGENT_NAME = 'github-core-clone/1.0';
const FIXED_DATE = '2025-01-01T00:00:00Z';
const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the suite presents; empty means "any non-empty Bearer token" (local runs). */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** Where the store snapshot lives on disk. */
const DATA_DIR = process.env.FORGE_DATA_DIR ?? '/tmp/github-forge-data';

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** base64url without padding: the opaque global ids. */
function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

/** A deterministic, monotonically increasing timestamp (seconds since the scenario epoch). */
let tsCounter = 1735689600;
function nextTs(): number {
  tsCounter += 1;
  return tsCounter;
}
function isoOf(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommit(fields: { tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const who = (ident: string): string => `${ident} ${fields.timestamp} +0000`;
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${who(fields.author)}\n`;
  out += `committer ${who(fields.committer)}\n`;
  out += `\n${message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view: TagView = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) view.tag = line.slice(4);
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines; throws on a malformed header or truncation. */
function decodePktLines(buf: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      lines.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > buf.length) throw new Error('truncated pkt-line');
      lines.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfile codec (plain objects on write; deltas resolved on read)
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: GitObj[]): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    // Level 1 is several times faster than the default for 1 KiB blobs and still
    // valid zlib; the pack checks verify structure and checksums, not the level.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

/** Read a packfile and resolve every object (OFS_DELTA and REF_DELTA included). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor held`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
  /** Fetch packs, keyed by the sorted send-set: identical fetches reuse the bytes. */
  packCache: Map<string, Buffer>;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentSeq = 1;
let repoSeq = 0;
let issueSeq = 0;
let dirty = false;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    seq: ++repoSeq,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    nextCommentId: 1,
    packCache: new Map(),
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  dirty = true;
  return repo;
}

/** The objects reachable from `tips` (commits, trees, blobs, tags), missing ones skipped. */
export function reachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (following every parent). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits: the common one with the greatest depth. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const depthA = new Map<string, number>();
  const stackA: Array<[string, number]> = [[a, 0]];
  while (stackA.length > 0) {
    const [oid, depth] = stackA.pop()!;
    if (depthA.has(oid)) continue;
    depthA.set(oid, depth);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackA.push([parent, depth + 1]);
  }
  let best: string | null = null;
  let bestDepth = -1;
  const stackB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const [oid, depth] = stackB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = depthA.get(oid);
    if (da !== undefined) {
      const score = da + depth;
      if (score > bestDepth) {
        bestDepth = score;
        best = oid;
      }
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackB.push([parent, depth + 1]);
  }
  return best;
}

/** Flatten a tree into path -> {oid, mode}, walking subtrees. */
function treeToMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) a tree from a flat path map; returns the root tree oid. */
function mapToTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store an object, returning its oid. */
function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Create a commit on `branch` from a file map; updates the ref. Returns the commit oid. */
function commitFiles(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const treeOid = mapToTree(repo, files);
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const ts = nextTs();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    message,
    author: ident,
    committer: ident,
    timestamp: ts,
  });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitOid);
  repo.packCache.clear();
  dirty = true;
  return commitOid;
}

/** The tip commit oid of a branch, or undefined when the branch does not exist. */
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid, or undefined. */
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed !== undefined) return headed;
  const tagged = repo.refs.get(`refs/tags/${ref}`);
  if (tagged !== undefined) return tagged;
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  return undefined;
}

/** First-parent commit history from a tip, newest first. */
function commitHistory(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  let current: string | undefined = tip;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') break;
    out.push(current);
    current = parseCommit(obj.data).parents[0];
  }
  return out;
}

/** Peel a ref's object to its commit (following annotated tags). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------
// snapshot persistence (best-effort; the trial pod starts empty, so a missing
// snapshot simply means a fresh store)
// ---------------------------------------------------------------------------

function snapshotPath(): string {
  return join(DATA_DIR, 'snapshot.json');
}

function saveSnapshot(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const data = {
      version: 1,
      nextRepoId,
      nextIssueId,
      nextPullId,
      nextCommentSeq,
      repoSeq,
      issueSeq,
      tsCounter,
      repos: [...repos.values()].map((repo) => ({
        id: repo.id,
        name: repo.name,
        owner: repo.owner,
        description: repo.description,
        isPrivate: repo.isPrivate,
        defaultBranch: repo.defaultBranch,
        seq: repo.seq,
        refs: [...repo.refs.entries()],
        objects: [...repo.objects.entries()].map(([oid, obj]) => [oid, obj.type, obj.data.toString('base64')] as const),
        labels: [...repo.labels.entries()],
        issues: repo.issues,
        pulls: repo.pulls,
        nextNumber: repo.nextNumber,
        nextCommentId: repo.nextCommentId,
      })),
    };
    writeFileSync(snapshotPath(), JSON.stringify(data));
    dirty = false;
  } catch {
    // A snapshot failure must never take the server down.
  }
}

function loadSnapshot(): void {
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      nextRepoId: number;
      nextIssueId: number;
      nextPullId: number;
      nextCommentSeq: number;
      repoSeq: number;
      issueSeq: number;
      tsCounter: number;
      repos: Array<{
        id: number;
        name: string;
        owner: string;
        description: string;
        isPrivate: boolean;
        defaultBranch: string;
        seq: number;
        refs: Array<[string, string]>;
        objects: Array<[string, ObjType, string]>;
        labels: Array<[string, { name: string; color: string }]>;
        issues: Issue[];
        pulls: Pull[];
        nextNumber: number;
        nextCommentId: number;
      }>;
    };
    nextRepoId = data.nextRepoId;
    nextIssueId = data.nextIssueId;
    nextPullId = data.nextPullId;
    nextCommentSeq = data.nextCommentSeq;
    repoSeq = data.repoSeq;
    issueSeq = data.issueSeq;
    tsCounter = data.tsCounter;
    repos.clear();
    for (const raw of data.repos) {
      const repo: Repo = {
        id: raw.id,
        name: raw.name,
        owner: raw.owner,
        description: raw.description,
        isPrivate: raw.isPrivate,
        defaultBranch: raw.defaultBranch,
        seq: raw.seq,
        refs: new Map(raw.refs),
        objects: new Map(raw.objects.map(([oid, type, b64]) => [oid, { type, data: Buffer.from(b64, 'base64') }] as const)),
        labels: new Map(raw.labels),
        issues: raw.issues,
        pulls: raw.pulls,
        nextNumber: raw.nextNumber,
        nextCommentId: raw.nextCommentId,
        packCache: new Map(),
      };
      repos.set(repoKey(repo.owner, repo.name), repo);
    }
  } catch {
    // A corrupt snapshot is ignored: the store starts fresh.
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let reqCounter = 1;

function nextRequestId(): string {
  const n = reqCounter++;
  return `req-${n.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  if (TOKEN !== '') return token === TOKEN;
  return true;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; returns null and answers 400 when it is malformed. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      sendErr(res, 400, 'the request body must be a JSON object');
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    sendErr(res, 400, 'the request body is not valid JSON');
    return null;
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function gitCapsUploadPack(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not agent=${AGENT_NAME} object-format=sha1`;
}

function gitCapsReceivePack(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=${AGENT_NAME} object-format=sha1`;
}

/** Sorted ref entries (heads then tags), each with its oid. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** GET /:owner/:repo.git/info/refs?service=... */
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): void {
  if (!authed(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }
  if (owner !== VIEWER_LOGIN) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const repo = getRepo(owner, repoName);
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  if (wantV2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine(`agent=${AGENT_NAME}\n`));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
  } else {
    const caps = service === 'git-upload-pack' ? gitCapsUploadPack(repo) : gitCapsReceivePack(repo);
    const refs = sortedRefs(repo);
    const tip = branchTip(repo, repo.defaultBranch);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      // HEAD first, carrying the capabilities after a NUL.
      parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
      for (const ref of refs) {
        parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
        const obj = repo.objects.get(ref.oid);
        if (obj && obj.type === 'tag') {
          parts.push(pktLine(`${peelToCommit(repo, ref.oid)} ${ref.name}^{}\n`));
        }
      }
    }
    parts.push(PKT_FLUSH);
  }
  sendBytes(res, 200, Buffer.concat(parts), contentType);
}

interface LsRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** POST git-upload-pack, command=ls-refs (v2). */
function handleLsRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, lines: PktLine[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: LsRef[] = [];
  const tip = branchTip(repo, repo.defaultBranch);
  if (repo.refs.size === 0) {
    if (unborn && keep('HEAD')) out.push({ oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    if (keep('HEAD')) {
      out.push({
        oid: tip ?? ZERO_OID,
        name: 'HEAD',
        ...(symrefs ? { symrefTarget: `refs/heads/${repo.defaultBranch}` } : {}),
      });
    }
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      const entry: LsRef = { oid: ref.oid, name: ref.name };
      const obj = repo.objects.get(ref.oid);
      if (peel && obj && obj.type === 'tag') entry.peeled = peelToCommit(repo, ref.oid);
      out.push(entry);
    }
  }
  const parts: Buffer[] = [];
  for (const ref of out) {
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn ${ref.name}${ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface FetchPlan {
  /** The objects to send, as a set of oids. */
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out what a fetch sends: the closure of the wants, minus the closure of the haves,
 * limited to `depth` commit generations when given. `previousShallow` is the client's current
 * shallow boundary (from its `shallow` lines).
 */
function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, previousShallow: string[]): FetchPlan {
  const haveClosure = reachable(repo, haves);
  const heldCommits = new Set(haves);
  // A want that is not a commit (an annotated tag) is sent as-is, and its peeled
  // commit seeds the traversal. A commit want seeds the traversal directly.
  const extraWants = new Set<string>();
  const seedCommits: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraWants.add(want);
      seedCommits.push(peelToCommit(repo, want));
    } else if (obj.type === 'commit') {
      seedCommits.push(want);
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  let closure: Set<string>;
  if (depth === null) {
    // Every commit reachable from a want that the client does not already hold.
    const wantCommits = new Set<string>();
    const stack = [...seedCommits];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (haveClosure.has(oid)) continue;
      wantCommits.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    closure = reachable(repo, wantCommits);
  } else {
    // Commits within `depth` generations of a want (a want itself is generation 1).
    // The traversal runs through held commits too: a shallow boundary is held, but
    // its parent is exactly what a deepen asks for.
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = seedCommits.map((oid) => [oid, 1] as [string, number]);
    while (queue.length > 0) {
      const [oid, d] = queue.shift()!;
      if (dist.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (d > depth) continue;
      dist.set(oid, d);
      if (d < depth) for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
    }
    const includedCommits = new Set<string>();
    for (const oid of dist.keys()) if (!heldCommits.has(oid)) includedCommits.add(oid);
    // A boundary commit is an included one with a parent the client ends up without
    // (neither included in this fetch nor already held).
    for (const oid of includedCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((parent) => !includedCommits.has(parent) && !heldCommits.has(parent))) shallow.push(oid);
    }
    // A previous boundary whose parent this fetch delivers is no longer shallow.
    for (const boundary of previousShallow) {
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.some((parent) => includedCommits.has(parent))) unshallow.push(boundary);
    }
    // The closure of a depth-limited fetch is each included commit plus its own
    // tree — never its parents (those are what the depth limit cuts off).
    closure = new Set<string>();
    for (const oid of includedCommits) {
      closure.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const entry of reachable(repo, [parseCommit(obj.data).tree])) closure.add(entry);
      }
    }
  }
  for (const oid of extraWants) closure.add(oid);
  // What the client already holds, with shallow boundaries honoured: below a
  // boundary the client holds nothing, even though the boundary's parents are
  // reachable from its haves.
  const held = new Set(haveClosure);
  for (const boundary of previousShallow) {
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      for (const oid of reachable(repo, [parent])) held.delete(oid);
    }
  }
  const send = new Set<string>();
  for (const oid of closure) if (!held.has(oid)) send.add(oid);
  return { send, shallow, unshallow };
}

/** The pack for a fetch's send-set, cached per repo: identical fetches (the 50
 * concurrent clones of one repo in the benchmark) build the bytes once. The cache
 * is cleared whenever the repo's objects or refs change. */
function fetchPack(repo: Repo, send: Set<string>): Buffer {
  const key = [...send].sort().join(',');
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const objects = [...send]
    .sort()
    .map((oid) => repo.objects.get(oid)!)
    .filter((obj) => obj !== undefined);
  const pack = writePack(objects);
  if (repo.packCache.size > 16) repo.packCache.clear();
  repo.packCache.set(key, pack);
  return pack;
}

/** Sideband pkt-lines carrying a pack (band 1), chunked under the pkt-line maximum. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(framed));
  }
  return parts;
}

/** POST git-upload-pack, command=fetch (v2). */
function handleFetchV2(req: IncomingMessage, res: ServerResponse, repo: Repo, lines: PktLine[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowLines.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const uniqueWants = [...new Set(wants)];
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(PKT_FLUSH);
  if (uniqueWants.length === 0) {
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  const plan = planFetch(repo, uniqueWants, haves, depth, shallowLines);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  if (plan.send.size > 0) {
    const pack = fetchPack(repo, plan.send);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** POST git-upload-pack, v0 fetch (want/have/done). */
function handleFetchV0(req: IncomingMessage, res: ServerResponse, repo: Repo, lines: PktLine[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      wants.push(rest.split(' ')[0]!);
    } else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowLines.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const uniqueWants = [...new Set(wants)];
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  if (uniqueWants.length === 0) {
    parts.push(PKT_FLUSH);
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  const plan = planFetch(repo, uniqueWants, haves, depth, shallowLines);
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.size > 0) {
    parts.push(...sidebandPack(fetchPack(repo, plan.send)));
  }
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** POST git-upload-pack: dispatch ls-refs / fetch (v2) or a v0 fetch by the request shape. */
async function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  if (!authed(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }
  if (owner !== VIEWER_LOGIN) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const repo = getRepo(owner, repoName);
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const body = await readBody(req);
  let lines: PktLine[];
  try {
    lines = decodePktLines(body);
  } catch {
    sendErr(res, 400, 'malformed pkt-line request');
    return;
  }
  const first = lines.find((line) => line.kind === 'data')?.payload.toString('utf8') ?? '';
  if (first.startsWith('command=ls-refs')) {
    handleLsRefs(req, res, repo, lines);
    return;
  }
  if (first.startsWith('command=fetch')) {
    handleFetchV2(req, res, repo, lines);
    return;
  }
  if (first.startsWith('want ')) {
    handleFetchV0(req, res, repo, lines);
    return;
  }
  sendErr(res, 400, 'unknown git-upload-pack command');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: unpack, apply the command list, answer report-status over sideband. */
async function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  if (!authed(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }
  if (owner !== VIEWER_LOGIN) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const repo = getRepo(owner, repoName);
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const body = await readBody(req);
  // The command list is pkt-lined up to the first flush; the pack follows raw.
  let flushEnd = -1;
  let offset = 0;
  try {
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        flushEnd = offset + 4;
        break;
      }
      if (length < 4 || length > 65520 || offset + length > body.length) throw new Error('invalid pkt-line');
      offset += length;
    }
    if (flushEnd < 0) throw new Error('no flush after the command list');
  } catch {
    sendErr(res, 400, 'malformed receive-pack request');
    return;
  }
  let commands: PushCommand[];
  try {
    commands = decodePktLines(body.subarray(0, flushEnd))
      .filter((line) => line.kind === 'data')
      .map((line) => {
        let text = line.payload.toString('utf8').replace(/\n$/, '');
        const nul = text.indexOf('\0');
        if (nul >= 0) text = text.slice(0, nul);
        const parts = text.split(' ');
        if (parts.length < 3) throw new Error('bad push command');
        return { oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') };
      });
  } catch {
    sendErr(res, 400, 'malformed receive-pack command list');
    return;
  }
  const packBytes = body.subarray(flushEnd);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
      dirty = true;
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} no such ref\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} old ref does not match\n`);
        } else {
          repo.refs.delete(command.ref);
          dirty = true;
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      const newObj = repo.objects.get(command.newOid);
      if (!newObj) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          dirty = true;
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Update: the old value must match, and the new tip must descend from it.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} no such ref\n`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} old ref does not match\n`);
      } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        dirty = true;
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  }
  const reportBody = Buffer.concat([
    ...reportLines.map((line) => pktLine(line)),
    PKT_FLUSH,
  ]);
  // The push may have added objects or moved refs: any cached fetch pack is stale.
  repo.packCache.clear();
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), reportBody])), PKT_FLUSH];
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// REST v3: JSON shapes
// ---------------------------------------------------------------------------

function gidRepo(repo: Repo): string {
  return b64url(`R:${repo.id}`);
}

function gidIssue(repo: Repo, issue: Issue): string {
  return b64url(`I:${repo.id}:${issue.number}`);
}

function gidPull(repo: Repo, pull: Pull): string {
  return b64url(`P:${repo.id}:${pull.number}`);
}

function gidComment(repo: Repo, issue: Issue, comment: Comment): string {
  return b64url(`C:${repo.id}:${issue.number}:${comment.id}`);
}

function decodeGlobalId(id: string): { kind: string; repoId: number; number: number; commentId: number } | null {
  try {
    const text = unb64url(id);
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repoId = Number.parseInt(parts[1]!, 10);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
    return {
      kind,
      repoId,
      number: parts.length > 2 ? Number.parseInt(parts[2]!, 10) : 0,
      commentId: parts.length > 3 ? Number.parseInt(parts[3]!, 10) : 0,
    };
  } catch {
    return null;
  }
}

function findRepoById(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gidRepo(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: b64url(`U:${VIEWER_ID}`), type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    homepage: null,
    size: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gidIssue(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', default: false, description: null, url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}` };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: issue.state === 'closed' ? FIXED_DATE : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gidPull(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    labels: [],
    milestone: null,
    comments: 0,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: pull.state === 'closed' ? FIXED_DATE : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gidComment(repo, issue, comment),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const authorLine = commit.author;
  const name = authorLine.split('<')[0]?.trim() ?? VIEWER_NAME;
  const email = authorLine.includes('<') ? authorLine.split('<')[1]!.split('>')[0]! : VIEWER_EMAIL;
  return {
    sha,
    node_id: b64url(`M:${repo.id}:${sha}`),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author: { name, email, date: FIXED_DATE },
      committer: { name, email, date: FIXED_DATE },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------------------
// REST v3: shared helpers
// ---------------------------------------------------------------------------

/** Parse page/per_page (defaults 1/30) and slice a list, returning the page and Link header. */
function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (pageNum < totalPages) {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(pageNum + 1));
    url.searchParams.set('per_page', String(perPage));
    link = `<${url.toString()}>; rel="next"`;
    const last = new URL(baseUrl);
    last.searchParams.set('page', String(totalPages));
    last.searchParams.set('per_page', String(perPage));
    link += `, <${last.toString()}>; rel="last"`;
  }
  return { page, link };
}

function requestBase(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Load a repository for a REST route: owner must be the viewer, else 404 (never 403). */
function loadRepoForRest(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendErr(res, 404, 'Not Found');
    return null;
  }
  const repo = getRepo(owner, name);
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

// ---------------------------------------------------------------------------
// REST v3: repositories, branches, commits, contents
// ---------------------------------------------------------------------------

function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: ++issueSeq,
  };
  repo.issues.push(issue);
  dirty = true;
  return issue;
}

function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
  const pull: Pull = {
    id: nextPullId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeSha: null,
    seq: ++issueSeq,
  };
  repo.pulls.push(pull);
  dirty = true;
  return pull;
}

/** Line counts for a changed file: multiset difference of the two contents' lines. */
function lineCounts(oldContent: string | null, newContent: string | null): { additions: number; deletions: number } {
  const oldLines = oldContent === null ? [] : oldContent.split('\n');
  const newLines = newContent === null ? [] : newContent.split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The file diff between two commits' trees (base -> head). */
function diffTrees(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  const baseMap = baseObj && baseObj.type === 'commit' ? treeToMap(repo, parseCommit(baseObj.data).tree) : new Map<string, { oid: string; mode: string }>();
  const headMap = headObj && headObj.type === 'commit' ? treeToMap(repo, parseCommit(headObj.data).tree) : new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const files: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const base = baseMap.get(path);
    const head = headMap.get(path);
    if (base && !head) {
      const old = repo.objects.get(base.oid)?.data.toString('utf8') ?? '';
      const counts = lineCounts(old, null);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (!base && head) {
      const content = repo.objects.get(head.oid)?.data.toString('utf8') ?? '';
      const counts = lineCounts(null, content);
      files.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (base && head && base.oid !== head.oid) {
      const old = repo.objects.get(base.oid)?.data.toString('utf8') ?? '';
      const content = repo.objects.get(head.oid)?.data.toString('utf8') ?? '';
      const counts = lineCounts(old, content);
      files.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return files;
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request, by the merge rule below. */
function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return mergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
}

/**
 * The conflict check a merge uses: a file the head changed (against the merge base) that the
 * base tip also changed to different bytes. Returns the first conflicting path, or null.
 */
function mergeConflict(repo: Repo, pull: Pull): string | null {
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === undefined) return pull.headRef;
  const base = mergeBase(repo, pull.headSha, baseTip);
  if (base === null) return null;
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(pull.headSha);
  const tipObj = repo.objects.get(baseTip);
  if (!baseObj || !headObj || !tipObj) return null;
  const baseMap = treeToMap(repo, parseCommit(baseObj.data).tree);
  const headMap = treeToMap(repo, parseCommit(headObj.data).tree);
  const tipMap = treeToMap(repo, parseCommit(tipObj.data).tree);
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const atBase = baseMap.get(path)?.oid ?? null;
    const atHead = headMap.get(path)?.oid ?? null;
    if (atBase === atHead) continue; // the head did not change this file
    const atTip = tipMap.get(path)?.oid ?? null;
    if (atTip !== atBase && atTip !== atHead) return path;
  }
  return null;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
function mergePullRequest(repo: Repo, pull: Pull): string | null {
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === undefined) return null;
  if (mergeConflict(repo, pull) !== null) return null;
  const base = mergeBase(repo, pull.headSha, baseTip);
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(pull.headSha);
  if (!baseObj || !headObj) return null;
  const tipMap = treeToMap(repo, parseCommit(baseObj.data).tree);
  const baseMap = base === null ? new Map<string, { oid: string; mode: string }>() : treeToMap(repo, parseCommit(repo.objects.get(base)!.data).tree);
  const headMap = treeToMap(repo, parseCommit(headObj.data).tree);
  // Apply the head's changes (against the merge base) onto the base tip's tree.
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const atBase = baseMap.get(path);
    const atHead = headMap.get(path);
    if (atBase?.oid === atHead?.oid) continue;
    if (atHead === undefined) tipMap.delete(path);
    else tipMap.set(path, atHead);
  }
  const treeOid = mapToTree(repo, tipMap);
  const ts = nextTs();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message,
    author: ident,
    committer: ident,
    timestamp: ts,
  });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOf(ts);
  pull.mergeSha = mergeSha;
  dirty = true;
  return mergeSha;
}

// ---------------------------------------------------------------------------
// REST v3: route handlers
// ---------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  // GET /api/v3/ — the API root (no auth, as the starter serves it).
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // GET /api/v3/meta — no auth.
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // Everything else under /api/v3 needs the bearer token.
  if (!authed(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: b64url(`U:${VIEWER_ID}`),
        type: 'User',
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        html_url: `https://example.invalid/${VIEWER_LOGIN}`,
        url: '/api/v3/user',
      });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()]
        .filter((repo) => repo.owner === VIEWER_LOGIN)
        .sort((a, b) => a.seq - b.seq)
        .map((repo) => repoJson(repo));
      const base = `${requestBase(req)}/api/v3/user/repos`;
      const { page, link } = paginate(all, query, base);
      sendJson(res, 200, page, link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendErr(res, 422, 'name is invalid');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendJson(res, 422, { message: `Repository ${VIEWER_LOGIN}/${name} already exists`, errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = createRepoRecord(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      sendJson(res, 201, repoJson(repo));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeSegment(segments[1]!);
    const name = decodeSegment(segments[2]!);
    const rest = segments.slice(3);
    await handleRepoRoutes(req, res, method, query, owner, name, rest);
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function handleRepoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  query: URLSearchParams,
  owner: string,
  name: string,
  rest: string[],
): Promise<void> {
  const repo = loadRepoForRest(res, owner, name);
  if (repo === null) return;
  const base = `${requestBase(req)}/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && branchTip(repo, body.default_branch) !== undefined) repo.defaultBranch = body.default_branch;
      dirty = true;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, name));
      dirty = true;
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /repos/{o}/{r}/branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeSegment(rest[1]!);
      const tip = branchTip(repo, branch);
      if (tip === undefined) {
        sendErr(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /repos/{o}/{r}/commits
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (tip === undefined) {
        sendErr(res, 404, 'Not Found');
        return;
      }
      const commits = commitHistory(repo, tip)
        .map((sha) => commitJson(repo, sha))
        .filter((entry) => entry !== null);
      const { page, link } = paginate(commits, query, `${base}/commits`);
      sendJson(res, 200, page, link === null ? {} : { link });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /repos/{o}/{r}/git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || sha === '') {
        sendErr(res, 422, 'ref and sha are required');
        return;
      }
      if (repo.refs.has(ref)) {
        sendErr(res, 422, `Reference ${ref} already exists`);
        return;
      }
      const obj = repo.objects.get(sha);
      if (!obj) {
        sendErr(res, 422, `Object ${sha} does not exist`);
        return;
      }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      dirty = true;
      sendJson(res, 201, { ref, object: { sha, type: obj.type, url: `/api/v3/repos/${owner}/${name}/git/${obj.type}s/${sha}` } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map(decodeSegment).join('/');
      const fullRef = `refs/${ref}`;
      const oid = repo.refs.get(fullRef);
      if (oid === undefined) {
        sendErr(res, 404, 'Not Found');
        return;
      }
      const obj = repo.objects.get(oid);
      sendJson(res, 200, { ref: fullRef, object: { sha: oid, type: obj?.type ?? 'commit', url: '' } });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /repos/{o}/{r}/contents/{path...}
  if (rest[0] === 'contents') {
    await handleContents(req, res, method, query, repo, rest.slice(1).map(decodeSegment));
    return;
  }

  // /repos/{o}/{r}/labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') {
        sendErr(res, 422, 'name is required');
        return;
      }
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      dirty = true;
      sendJson(res, 201, { name: labelName, color, default: false, description: null, url: `${base}/labels/${encodeURIComponent(labelName)}` });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ ...label, default: false, description: null })));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (rest[0] === 'issues') {
    await handleIssues(req, res, method, query, repo, base, rest.slice(1).map(decodeSegment));
    return;
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (rest[0] === 'pulls') {
    await handlePulls(req, res, method, query, repo, base, rest.slice(1).map(decodeSegment));
    return;
  }

  sendErr(res, 404, 'Not Found');
}

/** Resolve the tree map of a branch (or an unborn branch's empty map). */
function branchFiles(repo: Repo, branch: string): { map: Map<string, { oid: string; mode: string }>; tip: string | undefined } {
  const tip = branchTip(repo, branch);
  if (tip === undefined) return { map: new Map(), tip: undefined };
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return { map: new Map(), tip };
  return { map: treeToMap(repo, parseCommit(obj.data).tree), tip };
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  query: URLSearchParams,
  repo: Repo,
  pathParts: string[],
): Promise<void> {
  const path = pathParts.join('/');
  if (path === '') {
    sendErr(res, 404, 'Not Found');
    return;
  }
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === undefined) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') {
      sendErr(res, 404, 'Not Found');
      return;
    }
    const files = treeToMap(repo, parseCommit(obj.data).tree);
    const file = files.get(path);
    if (file) {
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: b64encode(data),
        sha: file.oid,
      });
      return;
    }
    // A directory: its immediate children.
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; oid: string; path: string; size: number }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        if (!children.has(first)) {
          // Find the subtree oid for this directory.
          let treeOid = parseCommit(obj.data).tree;
          for (const segment of `${path}/${first}`.split('/')) {
            const treeObj = repo.objects.get(treeOid);
            if (!treeObj) break;
            const found = parseTree(treeObj.data).find((candidate) => candidate.name === segment);
            if (!found) break;
            treeOid = found.oid;
          }
          children.set(first, { type: 'dir', oid: treeOid, path: `${path}/${first}`, size: 0 });
        }
      } else {
        children.set(first, { type: 'file', oid: entry.oid, path: filePath, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
      }
    }
    if (children.size === 0) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    sendJson(
      res,
      200,
      [...children.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([childName, child]) => ({ type: child.type, size: child.size, name: childName, path: child.path, sha: child.oid })),
    );
    return;
  }

  if (method === 'PUT') {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const message = typeof body.message === 'string' ? body.message : 'update';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const { map, tip } = branchFiles(repo, branch);
    if (tip === undefined && branch !== repo.defaultBranch) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    if (typeof body.content !== 'string') {
      sendErr(res, 422, 'content is required');
      return;
    }
    const content = b64decode(body.content);
    const blobOid = putObject(repo, 'blob', content);
    const existing = map.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing) {
      if (givenSha === undefined || givenSha !== existing.oid) {
        sendErr(res, 409, 'the file has changed since the given sha');
        return;
      }
      map.set(path, { oid: blobOid, mode: existing.mode });
      const commitOid = commitFiles(repo, branch, map, message);
      sendJson(res, 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
        commit: { sha: commitOid, message },
      });
      return;
    }
    if (givenSha !== undefined) {
      sendErr(res, 422, 'the file does not exist');
      return;
    }
    map.set(path, { oid: blobOid, mode: '100644' });
    const commitOid = commitFiles(repo, branch, map, message);
    sendJson(res, 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const message = typeof body.message === 'string' ? body.message : 'delete';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const { map, tip } = branchFiles(repo, branch);
    if (tip === undefined) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    const existing = map.get(path);
    if (!existing) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) {
      sendErr(res, 409, 'the file has changed since the given sha');
      return;
    }
    map.delete(path);
    const commitOid = commitFiles(repo, branch, map, message);
    sendJson(res, 200, { commit: { sha: commitOid, message } });
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  query: URLSearchParams,
  repo: Repo,
  base: string,
  rest: string[],
): Promise<void> {
  // POST /issues and GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendErr(res, 422, `Label '${label}' does not exist`);
          return;
        }
      }
      const issue = createIssueRecord(repo, title, issueBody, labels);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), query, `${base}/issues`);
      sendJson(res, 200, page, link === null ? {} : { link });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) {
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /issues/{n}
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      dirty = true;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment: Comment = { id: repo.nextCommentId++, body: commentBody };
      issue.comments.push(comment);
      dirty = true;
      sendJson(res, 201, commentJson(repo, issue, comment));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  query: URLSearchParams,
  repo: Repo,
  base: string,
  rest: string[],
): Promise<void> {
  // POST /pulls and GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const title = typeof body.title === 'string' ? body.title : '';
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const baseRef = typeof body.base === 'string' ? body.base : '';
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) {
        sendErr(res, 422, 'head or base branch does not exist');
        return;
      }
      const existing = repo.pulls.find((pull) => pull.headRef === head && pull.state === 'open');
      if (existing) {
        sendErr(res, 422, 'A pull request already exists for this head branch');
        return;
      }
      const pull = createPullRecord(repo, title, pullBody, head, baseRef, headSha, baseSha);
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((pull) => pullJson(repo, pull));
      const { page, link } = paginate(list, query, `${base}/pulls`);
      sendJson(res, 200, page, link === null ? {} : { link });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (!pull) {
    sendErr(res, 404, 'Not Found');
    return;
  }

  // GET /pulls/{n}
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, diffTrees(repo, pull.baseSha, pull.headSha));
    return;
  }

  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged) {
      sendErr(res, 405, 'Pull request is already merged');
      return;
    }
    if (pull.state !== 'open') {
      sendErr(res, 405, 'Pull request is closed');
      return;
    }
    // Consume the body (merge_method) so the request is fully read.
    await readBody(req);
    const mergeSha = mergePullRequest(repo, pull);
    if (mergeSha === null) {
      sendErr(res, 405, 'Merge conflict: the pull request cannot be merged cleanly');
      return;
    }
    sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull request #${pull.number} successfully merged` });
    return;
  }

  sendErr(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser for the documents gh sends, and an executor over
// the same store the REST surface uses.
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: GqlValue[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[];
}

interface GqlInlineFragment {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

interface GqlSpread {
  kind: 'Spread';
  name: string;
}

type GqlSelection = GqlField | GqlInlineFragment | GqlSpread;

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; required: boolean; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

interface GqlFragment {
  name: string;
  typeCondition: string;
  selections: GqlSelection[];
}

class GqlParseError extends Error {}

class GqlLexer {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  peekName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    return match ? match[0] : '';
  }

  readName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!match) throw new GqlParseError(`expected a name at offset ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  readPunct(punct: string): boolean {
    this.skipIgnored();
    if (this.text.startsWith(punct, this.pos)) {
      this.pos += punct.length;
      return true;
    }
    return false;
  }

  expectPunct(punct: string): void {
    if (!this.readPunct(punct)) throw new GqlParseError(`expected ${JSON.stringify(punct)} at offset ${this.pos}`);
  }

  readString(): string {
    this.skipIgnored();
    if (this.text[this.pos] !== '"') throw new GqlParseError(`expected a string at offset ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw new GqlParseError('unterminated string');
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const esc = this.text[this.pos + 1];
        this.pos += 2;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === '/') out += '/';
        else if (esc === '\\') out += '\\';
        else if (esc === '"') out += '"';
        else if (esc === 'u') {
          const hex = this.text.slice(this.pos, this.pos + 4);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
        } else out += esc ?? '';
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  readNumber(): GqlValue {
    this.skipIgnored();
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos));
    if (!match) throw new GqlParseError(`expected a number at offset ${this.pos}`);
    this.pos += match[0].length;
    const raw = match[0];
    if (raw.includes('.') || raw.includes('e') || raw.includes('E')) return { kind: 'Float', value: Number.parseFloat(raw) };
    return { kind: 'Int', value: Number.parseInt(raw, 10) };
  }

  atEnd(): boolean {
    this.skipIgnored();
    return this.pos >= this.text.length;
  }
}

function parseGqlValue(lexer: GqlLexer): GqlValue {
  const ch = lexer.peek();
  if (ch === '$') {
    lexer.readPunct('$');
    return { kind: 'Variable', name: lexer.readName() };
  }
  if (ch === '"') return { kind: 'String', value: lexer.readString() };
  if (ch === '[') {
    lexer.expectPunct('[');
    const values: GqlValue[] = [];
    while (!lexer.readPunct(']')) values.push(parseGqlValue(lexer));
    return { kind: 'List', values };
  }
  if (ch === '{') {
    lexer.expectPunct('{');
    const fields: Array<{ name: string; value: GqlValue }> = [];
    while (!lexer.readPunct('}')) {
      const name = lexer.readName();
      lexer.expectPunct(':');
      fields.push({ name, value: parseGqlValue(lexer) });
    }
    return { kind: 'Object', fields };
  }
  if (ch === '-' || (ch >= '0' && ch <= '9')) return lexer.readNumber();
  const name = lexer.readName();
  if (name === 'true') return { kind: 'Boolean', value: true };
  if (name === 'false') return { kind: 'Boolean', value: false };
  if (name === 'null') return { kind: 'Null' };
  return { kind: 'Enum', value: name };
}

function parseGqlSelections(lexer: GqlLexer): GqlSelection[] {
  lexer.expectPunct('{');
  const selections: GqlSelection[] = [];
  while (!lexer.readPunct('}')) {
    if (lexer.readPunct('...')) {
      const name = lexer.peekName();
      if (name === 'on') {
        lexer.readName();
        const typeCondition = lexer.readName();
        selections.push({ kind: 'InlineFragment', typeCondition, selections: parseGqlSelections(lexer) });
      } else if (name !== '') {
        selections.push({ kind: 'Spread', name: lexer.readName() });
      } else {
        selections.push({ kind: 'InlineFragment', typeCondition: null, selections: parseGqlSelections(lexer) });
      }
      continue;
    }
    const first = lexer.readName();
    let alias: string | null = null;
    let name = first;
    if (lexer.readPunct(':')) {
      alias = first;
      name = lexer.readName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (lexer.readPunct('(')) {
      while (!lexer.readPunct(')')) {
        const argName = lexer.readName();
        lexer.expectPunct(':');
        args.push({ name: argName, value: parseGqlValue(lexer) });
      }
    }
    // Directives (@include/@skip): parsed and ignored.
    while (lexer.readPunct('@')) {
      lexer.readName();
      if (lexer.readPunct('(')) {
        while (!lexer.readPunct(')')) {
          lexer.readName();
          lexer.expectPunct(':');
          parseGqlValue(lexer);
        }
      }
    }
    const subSelections = lexer.peek() === '{' ? parseGqlSelections(lexer) : [];
    selections.push({ kind: 'Field', alias, name, args, selections: subSelections });
  }
  return selections;
}

function parseGqlType(lexer: GqlLexer): { required: boolean } {
  if (lexer.readPunct('[')) {
    parseGqlType(lexer);
    lexer.expectPunct(']');
  } else {
    lexer.readName();
  }
  const required = lexer.readPunct('!');
  return { required };
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

function parseGqlDocument(text: string): GqlDocument {
  const lexer = new GqlLexer(text);
  const operations: GqlOperation[] = [];
  const fragments = new Map<string, GqlFragment>();
  while (!lexer.atEnd()) {
    const keyword = lexer.peekName();
    if (keyword === 'fragment') {
      lexer.readName();
      const name = lexer.readName();
      const on = lexer.readName();
      if (on !== 'on') throw new GqlParseError('expected "on" in a fragment definition');
      const typeCondition = lexer.readName();
      fragments.set(name, { name, typeCondition, selections: parseGqlSelections(lexer) });
      continue;
    }
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (keyword === 'query' || keyword === 'mutation') {
      type = keyword as 'query' | 'mutation';
      lexer.readName();
      if (lexer.peek() !== '(' && lexer.peek() !== '{') name = lexer.readName();
    }
    const variables: GqlOperation['variables'] = [];
    if (lexer.readPunct('(')) {
      while (!lexer.readPunct(')')) {
        if (lexer.readPunct('$')) {
          const varName = lexer.readName();
          lexer.expectPunct(':');
          const parsed = parseGqlType(lexer);
          let defaultValue: GqlValue | null = null;
          if (lexer.readPunct('=')) defaultValue = parseGqlValue(lexer);
          variables.push({ name: varName, required: parsed.required, defaultValue });
        } else {
          lexer.readName();
          lexer.expectPunct(':');
          parseGqlType(lexer);
        }
      }
    }
    operations.push({ type, name, variables, selections: parseGqlSelections(lexer) });
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------------------
// GraphQL execution
// ---------------------------------------------------------------------------

interface GqlExecError {
  message: string;
}

interface GqlValueNode {
  __typename: string;
  [key: string]: unknown;
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'closedAt', 'locked'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'closedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  LabelConnection: ['nodes', 'totalCount'],
  Label: ['name', 'color', 'description'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function gqlArgValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'Variable':
      return variables[value.name] ?? null;
    case 'String':
    case 'Enum':
      return value.value;
    case 'Int':
    case 'Float':
    case 'Boolean':
      return value.value;
    case 'Null':
      return null;
    case 'List':
      return value.values.map((entry) => gqlArgValue(entry, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = gqlArgValue(field.value, variables);
      return out;
    }
  }
}

function gqlArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = gqlArgValue(arg.value, variables);
  return out;
}

function cursorEncode(index: number): string {
  return b64url(`c:${index}`);
}

function cursorDecode(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = unb64url(cursor);
    if (!text.startsWith('c:')) return -1;
    const n = Number.parseInt(text.slice(2), 10);
    return Number.isSafeInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}

interface PageInfoNode {
  __typename: 'PageInfo';
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function paginateConnection<T>(ordered: T[], first: unknown, after: unknown): { nodes: T[]; pageInfo: PageInfoNode; totalCount: number } {
  const limit = typeof first === 'number' && Number.isFinite(first) && first >= 0 ? Math.trunc(first) : ordered.length;
  const start = cursorDecode(after) + 1;
  const nodes = ordered.slice(start, start + limit);
  const endIndex = nodes.length === 0 ? -1 : start + nodes.length - 1;
  return {
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + nodes.length < ordered.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length === 0 ? null : cursorEncode(start),
      endCursor: endIndex < 0 ? null : cursorEncode(endIndex),
    },
    totalCount: ordered.length,
  };
}

function issueNode(repo: Repo, issue: Issue): GqlValueNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): GqlValueNode {
  return { __typename: 'PullRequest', repo, pull };
}

function repoNode(repo: Repo): GqlValueNode {
  return { __typename: 'Repository', repo };
}

function viewerNode(): GqlValueNode {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
}

class GqlExecutor {
  private errors: GqlExecError[] = [];
  private readonly variables: Record<string, unknown>;
  private readonly fragments: Map<string, GqlFragment>;

  constructor(variables: Record<string, unknown>, fragments: Map<string, GqlFragment>) {
    this.variables = variables;
    this.fragments = fragments;
  }

  executeOperation(op: GqlOperation): { data: Record<string, unknown>; errors: GqlExecError[] } {
    this.errors = [];
    const root: GqlValueNode = { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' };
    const data = this.executeSelections(root, op.selections);
    return { data, errors: this.errors };
  }

  private executeSelections(parent: GqlValueNode, selections: GqlSelection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'InlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
        Object.assign(out, this.executeSelections(parent, selection.selections));
        continue;
      }
      if (selection.kind === 'Spread') {
        const fragment = this.fragments.get(selection.name);
        if (!fragment) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".` });
          continue;
        }
        if (fragment.typeCondition !== parent.__typename) continue;
        Object.assign(out, this.executeSelections(parent, fragment.selections));
        continue;
      }
      const key = selection.alias ?? selection.name;
      out[key] = this.executeField(parent, selection);
    }
    return out;
  }

  private executeField(parent: GqlValueNode, field: GqlField): unknown {
    const value = this.resolveField(parent, field);
    if (value === undefined) {
      // resolveField records the error itself.
      return null;
    }
    return this.completeValue(parent, field, value);
  }

  /** Resolve one field to a value node (or a scalar); undefined means "error recorded". */
  private resolveField(parent: GqlValueNode, field: GqlField): unknown {
    const typeName = parent.__typename;
    const args = gqlArgs(field, this.variables);
    const known = GQL_TYPE_FIELDS[typeName];
    if (typeName !== 'Query' && typeName !== 'Mutation' && known !== undefined && !known.includes(field.name) && field.name !== '__typename') {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return undefined;
    }
    switch (typeName) {
      case 'Query':
        return this.resolveQuery(field, args);
      case 'Mutation':
        return this.resolveMutation(field, args);
      case 'Repository':
        return this.resolveRepository(parent, field, args);
      case 'Issue':
        return this.resolveIssue(parent, field, args);
      case 'PullRequest':
        return this.resolvePullRequest(parent, field, args);
      case 'User':
        return this.resolveUser(parent, field);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection':
      case 'IssueCommentConnection':
      case 'LabelConnection':
        return this.resolveConnection(parent, field);
      case 'PageInfo':
        return (parent as unknown as Record<string, unknown>)[field.name] ?? null;
      case '__Type':
        return this.resolveTypeField(parent, field, args);
      case '__Field':
      case '__EnumValue':
      case 'Ref':
      case 'Label':
      case 'IssueComment':
      case 'PullRequestChangedFile':
        return (parent as unknown as Record<string, unknown>)[field.name] ?? null;
      default:
        return (parent as unknown as Record<string, unknown>)[field.name] ?? null;
    }
  }

  private resolveQuery(field: GqlField, args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'viewer':
        return viewerNode();
      case 'repository': {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = getRepo(owner, name);
        return repo === undefined ? null : repoNode(repo);
      }
      case 'node': {
        const id = args.id;
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        const repo = findRepoById(decoded.repoId);
        if (repo === undefined) return null;
        if (decoded.kind === 'R') return repoNode(repo);
        if (decoded.kind === 'I') {
          const issue = repo.issues.find((entry) => entry.number === decoded.number);
          return issue === undefined ? null : issueNode(repo, issue);
        }
        if (decoded.kind === 'P') {
          const pull = repo.pulls.find((entry) => entry.number === decoded.number);
          return pull === undefined ? null : pullNode(repo, pull);
        }
        if (decoded.kind === 'C') {
          const issue = repo.issues.find((entry) => entry.number === decoded.number);
          const comment = issue?.comments.find((entry) => entry.id === decoded.commentId);
          if (!issue || !comment) return null;
          return { __typename: 'IssueComment', repo, issue, comment, id: gidComment(repo, issue, comment), body: comment.body };
        }
        return null;
      }
      case '__type': {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (GQL_TYPE_FIELDS[name] !== undefined) {
          return { __typename: '__Type', name, kind: 'OBJECT', fields: GQL_TYPE_FIELDS[name], enumValues: null };
        }
        if (GQL_ENUM_VALUES[name] !== undefined) {
          return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: GQL_ENUM_VALUES[name] };
        }
        return null;
      }
      case '__schema':
        return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      case '__typename':
        return 'Query';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
        return undefined;
    }
  }

  private resolveMutation(field: GqlField, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded !== null && decoded.kind === 'R' ? findRepoById(decoded.repoId) : undefined;
        if (repo === undefined) {
          this.errors.push({ message: 'createIssue: the repositoryId names no repository.' });
          return undefined;
        }
        const issue = createIssueRecord(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
        return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
      }
      case 'closeIssue': {
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        const repo = decoded !== null && decoded.kind === 'I' ? findRepoById(decoded.repoId) : undefined;
        const issue = repo?.issues.find((entry) => entry.number === decoded?.number);
        if (repo === undefined || issue === undefined) {
          this.errors.push({ message: 'closeIssue: the issueId names no issue.' });
          return undefined;
        }
        issue.state = 'closed';
        dirty = true;
        return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
      }
      case 'createPullRequest': {
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded !== null && decoded.kind === 'R' ? findRepoById(decoded.repoId) : undefined;
        if (repo === undefined) {
          this.errors.push({ message: 'createPullRequest: the repositoryId names no repository.' });
          return undefined;
        }
        const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
        const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = branchTip(repo, headRef);
        const baseSha = branchTip(repo, baseRef);
        if (headSha === undefined || baseSha === undefined) {
          this.errors.push({ message: 'createPullRequest: the head or base branch does not exist.' });
          return undefined;
        }
        const pull = createPullRecord(
          repo,
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
          headRef,
          baseRef,
          headSha,
          baseSha,
        );
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
      }
      case 'mergePullRequest': {
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        const repo = decoded !== null && decoded.kind === 'P' ? findRepoById(decoded.repoId) : undefined;
        const pull = repo?.pulls.find((entry) => entry.number === decoded?.number);
        if (repo === undefined || pull === undefined) {
          this.errors.push({ message: 'mergePullRequest: the pullRequestId names no pull request.' });
          return undefined;
        }
        if (pull.merged || pull.state !== 'open') {
          this.errors.push({ message: 'mergePullRequest: the pull request is not open.' });
          return undefined;
        }
        const merged = mergePullRequest(repo, pull);
        if (merged === null) {
          this.errors.push({ message: 'mergePullRequest: the pull request has a merge conflict.' });
          return undefined;
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
      }
      case 'addComment': {
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        const repo = decoded !== null ? findRepoById(decoded.repoId) : undefined;
        const body = typeof input.body === 'string' ? input.body : '';
        if (repo === undefined || decoded === null) {
          this.errors.push({ message: 'addComment: the subjectId names nothing.' });
          return undefined;
        }
        if (decoded.kind === 'I') {
          const issue = repo.issues.find((entry) => entry.number === decoded.number);
          if (issue === undefined) {
            this.errors.push({ message: 'addComment: the subjectId names no issue.' });
            return undefined;
          }
          const comment: Comment = { id: repo.nextCommentId++, body };
          issue.comments.push(comment);
          dirty = true;
          return {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo, issue, comment, id: gidComment(repo, issue, comment), body } },
            subject: issueNode(repo, issue),
          };
        }
        // A pull-request subject: no stored thread, echo the comment.
        const node = { __typename: 'IssueComment', id: b64url(`C:${repo.id}:${decoded.number}:${nextCommentSeq++}`), body };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node },
          subject: null,
        };
      }
      case '__typename':
        return 'Mutation';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
        return undefined;
    }
  }

  private resolveRepository(parent: GqlValueNode, field: GqlField, args: Record<string, unknown>): unknown {
    const repo = parent.repo as Repo;
    switch (field.name) {
      case 'id':
        return gidRepo(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: repo.owner, id: VIEWER_ID };
      case 'defaultBranchRef':
        return { __typename: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.isPrivate;
      case 'url':
        return `/api/v3/repos/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_DATE;
      case 'issue': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => (a.seq - b.seq) * direction);
        const page = paginateConnection(list, args.first, args.after);
        return {
          __typename: 'IssueConnection',
          nodes: page.nodes.map((issue) => issueNode(repo, issue)),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
        };
      }
      case 'pullRequests': {
        let list = repo.pulls.filter((pull) => pull.state === 'open');
        list.sort((a, b) => b.seq - a.seq);
        const page = paginateConnection(list, args.first, args.after);
        return {
          __typename: 'PullRequestConnection',
          nodes: page.nodes.map((pull) => pullNode(repo, pull)),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
        };
      }
      case 'pullRequest': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      case '__typename':
        return 'Repository';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
        return undefined;
    }
  }

  private resolveIssue(parent: GqlValueNode, field: GqlField, args: Record<string, unknown>): unknown {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    switch (field.name) {
      case 'id':
        return gidIssue(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'url':
        return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_DATE;
      case 'closedAt':
        return issue.state === 'closed' ? FIXED_DATE : null;
      case 'locked':
        return false;
      case 'author':
        return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
      case 'repository':
        return repoNode(repo);
      case 'labels': {
        const nodes = issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', description: null }));
        return { __typename: 'LabelConnection', nodes, totalCount: nodes.length };
      }
      case 'comments': {
        const nodes = issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment, id: gidComment(repo, issue, comment), body: comment.body }));
        const page = paginateConnection(nodes, args.first, args.after);
        return { __typename: 'IssueCommentConnection', nodes: page.nodes, pageInfo: page.pageInfo, totalCount: page.totalCount };
      }
      case '__typename':
        return 'Issue';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
        return undefined;
    }
  }

  private resolvePullRequest(parent: GqlValueNode, field: GqlField, args: Record<string, unknown>): unknown {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (field.name) {
      case 'id':
        return gidPull(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pullMergeable(repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommit':
        return pull.mergeSha === null ? null : { __typename: 'Commit', oid: pull.mergeSha };
      case 'createdAt':
      case 'updatedAt':
        return FIXED_DATE;
      case 'closedAt':
        return pull.state === 'closed' ? FIXED_DATE : null;
      case 'author':
        return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
      case 'repository':
        return repoNode(repo);
      case 'files': {
        const files = diffTrees(repo, pull.baseSha, pull.headSha).map((file) => ({
          __typename: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
        const page = paginateConnection(files, args.first, args.after);
        return { __typename: 'PullRequestChangedFileConnection', nodes: page.nodes, pageInfo: page.pageInfo, totalCount: page.totalCount };
      }
      case '__typename':
        return 'PullRequest';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
        return undefined;
    }
  }

  private resolveUser(parent: GqlValueNode, field: GqlField): unknown {
    switch (field.name) {
      case 'login':
        return parent.login ?? VIEWER_LOGIN;
      case 'id':
        return String(parent.id ?? VIEWER_ID);
      case 'name':
        return VIEWER_NAME;
      case 'email':
        return VIEWER_EMAIL;
      case 'url':
        return `https://example.invalid/${parent.login ?? VIEWER_LOGIN}`;
      case '__typename':
        return 'User';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "User".` });
        return undefined;
    }
  }

  private resolveConnection(parent: GqlValueNode, field: GqlField): unknown {
    switch (field.name) {
      case 'nodes':
        return parent.nodes ?? [];
      case 'edges':
        return ((parent.nodes ?? []) as unknown[]).map((node) => ({ __typename: 'Edge', node, cursor: '' }));
      case 'pageInfo':
        return parent.pageInfo ?? { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      case 'totalCount':
        return parent.totalCount ?? ((parent.nodes ?? []) as unknown[]).length;
      case '__typename':
        return parent.__typename;
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
        return undefined;
    }
  }

  private resolveTypeField(parent: GqlValueNode, field: GqlField, args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'name':
        return parent.name ?? null;
      case 'kind':
        return parent.kind ?? null;
      case 'description':
        return null;
      case 'fields': {
        const names = (parent.fields ?? null) as string[] | null;
        if (names === null) return null;
        return names.map((name) => ({ __typename: '__Field', name, description: null }));
      }
      case 'enumValues': {
        const names = (parent.enumValues ?? null) as string[] | null;
        if (names === null) return null;
        return names.map((name) => ({ __typename: '__EnumValue', name, description: null }));
      }
      case '__typename':
        return '__Type';
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "__Type".` });
        return undefined;
    }
  }

  /** Apply a field's sub-selections to a resolved value (objects, lists, scalars). */
  private completeValue(parent: GqlValueNode, field: GqlField, value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (field.selections.length === 0) return value;
    if (Array.isArray(value)) {
      return value.map((entry) => (typeof entry === 'object' && entry !== null ? this.executeSelections(entry as GqlValueNode, field.selections) : entry));
    }
    if (typeof value === 'object') {
      return this.executeSelections(value as GqlValueNode, field.selections);
    }
    return value;
  }
}

/** Run one GraphQL operation document (or a batch) and build the response body. */
function executeGraphQL(body: unknown): { status: number; payload: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'the request body must be a JSON object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    const queryText = record.query;
    if (typeof queryText !== 'string' || queryText.trim() === '') {
      return { data: null, errors: [{ message: 'the request body must carry a query string' }] };
    }
    let document: GqlDocument;
    try {
      document = parseGqlDocument(queryText);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operation: GqlOperation | null = document.operations[0] ?? null;
    if (operationName !== null) {
      operation = document.operations.find((candidate) => candidate.name === operationName) ?? null;
    }
    if (operation === null) {
      return { data: null, errors: [{ message: 'the document carries no operation' }] };
    }
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const variable of operation.variables) {
      if (!(variable.name in mergedVariables) && variable.defaultValue !== null) {
        mergedVariables[variable.name] = gqlArgValue(variable.defaultValue, mergedVariables);
      }
    }
    const executor = new GqlExecutor(mergedVariables, document.fragments);
    const result = executor.executeOperation(operation);
    return { data: result.data, errors: result.errors };
  };
  if (Array.isArray(body)) {
    return { status: 200, payload: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, payload: runOne(body) };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { data: null, errors: [{ message: 'the request body is not valid JSON' }] });
    return;
  }
  const { status, payload } = executeGraphQL(body);
  sendJson(res, status, payload);
}

// ---------------------------------------------------------------------------
// MCP: the JSON-RPC 2.0 tools surface, over the same store as REST and GraphQL.
// ---------------------------------------------------------------------------

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
] as const;

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function mcpOk(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function mcpErr(message: string): McpToolResult {
  const value = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

function mcpFindRepo(args: Record<string, unknown>): Repo | null {
  const owner = args.owner;
  const repoName = args.repo;
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(owner, repoName) ?? null;
}

function callMcpTool(name: string, args: unknown): McpToolResult {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return mcpErr('the tool arguments must be a JSON object');
  }
  const params = args as Record<string, unknown>;
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return mcpErr(`unknown tool "${name}"`);
  const required = tool.inputSchema.required;
  for (const key of required) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      return mcpErr(`missing required argument "${key}" for tool "${name}"`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(params.name);
      if (getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return mcpErr(`a repository named "${repoName}" already exists`);
      }
      const repo = createRepoRecord(repoName, params.private === true, typeof params.description === 'string' ? params.description : '');
      const json = repoJson(repo);
      return mcpOk(json);
    }
    case 'get_repo': {
      const repo = mcpFindRepo(params);
      if (repo === null) return mcpErr('the repository was not found');
      return mcpOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mcpFindRepo(params);
      if (repo === null) return mcpErr('the repository was not found');
      const issue = createIssueRecord(repo, String(params.title), typeof params.body === 'string' ? params.body : '', []);
      return mcpOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpFindRepo(params);
      if (repo === null) return mcpErr('the repository was not found');
      let list = [...repo.issues];
      if (typeof params.state === 'string' && params.state !== 'all') {
        list = list.filter((issue) => issue.state === params.state);
      }
      list.sort((a, b) => a.seq - b.seq);
      const items = list.map((issue) => issueJson(repo, issue));
      return mcpOk({ issues: items });
    }
    case 'create_pull_request': {
      const repo = mcpFindRepo(params);
      if (repo === null) return mcpErr('the repository was not found');
      const headRef = String(params.head);
      const baseRef = String(params.base);
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) {
        return mcpErr('the head or base branch does not exist');
      }
      const pull = createPullRecord(repo, String(params.title), typeof params.body === 'string' ? params.body : '', headRef, baseRef, headSha, baseSha);
      return mcpOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = mcpFindRepo(params);
      if (repo === null) return mcpErr('the repository was not found');
      const pull = repo.pulls.find((entry) => entry.number === params.pull_number);
      if (pull === undefined) return mcpErr('the pull request was not found');
      if (pull.merged || pull.state !== 'open') return mcpErr('the pull request is not open');
      const merged = mergePullRequest(repo, pull);
      if (merged === null) return mcpErr('the pull request has a merge conflict');
      return mcpOk(pullJson(repo, pull));
    }
    default:
      return mcpErr(`unknown tool "${name}"`);
  }
}

const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

function mcpResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error: the request body is not valid JSON'));
    return;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error: the request body must be a JSON-RPC object'));
    return;
  }
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      _meta: { serverInfo: MCP_SERVER_INFO },
    }));
    return;
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    sendJson(res, 200, mcpResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    }));
    return;
  }
  if (method === 'tools/list') {
    // A module-level constant, so every call serialises byte-identically.
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = MCP_TOOLS.find((entry) => entry.name === toolName);
    if (tool === undefined) {
      sendJson(res, 200, mcpError(id, -32602, `unknown tool "${toolName}"`));
      return;
    }
    const result = callMcpTool(toolName, params.arguments ?? {});
    sendJson(res, 200, mcpResult(id, result));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Router + server factory
// ---------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Dispatch a git smart-HTTP path to the matching handler. */
async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, repoName: string, service: string): Promise<void> {
  if (service === 'info/refs') {
    const requested = url.searchParams.get('service') ?? '';
    if (requested !== 'git-upload-pack' && requested !== 'git-receive-pack') {
      sendErr(res, 400, 'unknown service');
      return;
    }
    handleInfoRefs(req, res, owner, repoName, requested);
    return;
  }
  if (service === 'git-upload-pack') {
    await handleUploadPack(req, res, owner, repoName);
    return;
  }
  await handleReceivePack(req, res, owner, repoName);
}

export function createApp(): Server {
  loadSnapshot();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (pathname === '/api/graphql' && method === 'POST') {
          await handleGraphQL(req, res);
          return;
        }
        if (pathname === '/mcp' && method === 'POST') {
          await handleMcp(req, res);
          return;
        }
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const segments = pathname.split('/').filter((part) => part !== '').slice(2);
          await handleRest(req, res, segments);
          return;
        }
        const gitMatch = GIT_PATH.exec(pathname);
        if (gitMatch !== null) {
          await handleGit(req, res, url, gitMatch[1]!, gitMatch[2]!, gitMatch[3]!);
          return;
        }
        sendErr(res, 404, 'Not Found');
      } catch (err) {
        process.stderr.write(`[forge] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) sendErr(res, 500, 'Internal Server Error');
        else res.destroy();
      }
    })();
  });
  const timer = setInterval(() => {
    if (dirty) saveSnapshot();
  }, 15_000);
  timer.unref();
  return server;
}
