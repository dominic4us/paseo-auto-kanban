import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, type Dirent } from 'node:fs';
import * as path from 'node:path';
import {
  WORKFLOW_DEFINITION_PATH, WORKFLOW_FORMAT_2, workflowDataSchema, workflowDefinitionSchema, workflowDefinition2Schema, unreadFeatures, versionParts,
  type CellState, type VersionPart, type WorkflowSource2, type Verdict, type WorkflowDefinition, type WorkflowDefinition2, type WorkflowDTO, type WorkflowEventDTO, type WorkflowModelDTO,
  type WorkflowReleaseDTO, type WorkflowTally,
} from '../shared/workflow.js';
import { builtinDefinition, builtinWorkflow, type WorkflowLocale } from '../shared/workflow-templates.js';
import { clipText, decide, endTag, kstNow, logTime, readRecord, type LogNames, type LogNote, type LogRule } from './workflow-log.js';

/**
 * REQ-124: the "workflow" view reads what happened in a workspace from its own documents, on the server only (a screen
 * cannot read files). It only reads — the definition file (shared/workflow.ts), folder listings, the first bytes of
 * reports and result files, the REQ table, and the branch's reflog as plain text. Nothing is written, and git is never
 * run (the owner's decision, 2026-09-30): a commit whose title cannot be read is filled from the stable result's hash instead.
 *
 * - Every path stays inside the workspace folder: patterns are relative with `*` inside one segment, and each file's real
 *   path (symbolic links followed) must lie under the folder's real path — checked by `confine` before any folder is listed
 *   or any file stat'ed or read, the definition file and a lane's button included. The one exception is a worktree's `.git`
 *   file, whose `gitdir:` may point to `<repository>/.git/worktrees/<name>` outside, and that repository's own `.git`.
 *   REQ-125 U0: a folder is then listed only through a hold on it, never by its name again (`listFolder`).
 * - Caps (`WORKFLOW_LIMITS`): a reached cap is said in `limits`, so short numbers are never silent.
 * - Releases are joined by version: a report's file name (`v0142`), a commit title ("bump to 0.1.42"), a result's head.
 *
 * `createWorkflowReader` keeps one reading per folder for `WORKFLOW_CACHE_MS` (60 s), as the message folder does.
 *
 * REQ-125: a workspace with no definition file may try a built-in workflow (`pick`, kept by the plugin in
 * `workflow-picks.json`, server/workflow-picks.ts). Only a missing file gives way to it — a file that is there, readable or
 * not, wins and the pick rests. A built-in has no reading rules, so nothing in the workspace is read for it.
 * REQ-125 2단계 (research/288): the one write into a workspace, "Export to the project folder", lives apart in
 * server/workflow-export.ts (this module stays free of writes) and passes the same `confine`.
 */
export const WORKFLOW_CACHE_MS = 60_000;
export const WORKFLOW_LIMITS = {
  definitionBytes: 64 * 1024,
  /** A file read whole (the REQ table); a larger one is read up to this and said in `limits`. */
  wholeFileBytes: 2 * 1024 * 1024,
  filesPerPattern: 2000,
  files: 4000,
  bytes: 32 * 1024 * 1024,
  reflogBytes: 2 * 1024 * 1024,
  defaultHeadBytes: 4096,
  /** REQ-125 U0 (research/290 2.10): entries read from one folder; past it the listing stops, said in `limits`. */
  folderEntries: 5000,
  /** Entries read over every listing of one reading. */
  visits: 20_000,
  /** Folder listings one reading may start, counted before each starts. */
  listings: 2000,
  /** Listings open at once; more wait. */
  concurrentListings: 4,
  /** REQ-125 U1 (research/290 2.10): 건 one reading shows; past it the first ones by name, said in `limits` ("instances"). */
  instances: 200,
  /**
   * REQ-125 U2 (research/290 2.10 "규칙당 사건 500"): the versions and unreadable files one `file-versions` rule takes from one
   * 건; past it the rest is not taken, that cell says "일부만 읽음" and "events-per-rule:<stage>" goes into `limits`.
   */
  eventsPerRule: 500,
};
export type Limits = typeof WORKFLOW_LIMITS;

// ---- fixed vocabulary ------------------------------------------------------------------------------------------------
const VERSION = /\bv?(\d+\.\d+\.\d+)\b/;
/** `name-version`: v0142 in a file name → 0.1.42. */
export function nameVersion(name: string): string | null {
  const m = name.match(/(?:^|_)v(\d)(\d)(\d{2})(?:_|\.|$)/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3])}` : null;
}
/** `kst`: the first "YYYY-MM-DD HH:MM[:SS] KST" (minutes written xx stay xx). */
export function kstTime(text: string): string | null {
  const m = text.match(/(20\d\d-\d\d-\d\d) (\d\d):(\d\d|xx|\dx)(?::(\d\d))?\**\s*KST/);
  return m ? `${m[1]} ${m[2]}:${/x/.test(m[3]!) ? 'xx' : m[3]}${m[4] ? ':' + m[4] : ''}` : null;
}
/** `req-or-defect`: REQ-n and Dnn ids. `REQ110-116`/`REQ-117~120` are ranges, `REQ62_63`/`REQ-121·122` lists. */
export function idsOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/REQ-?(\d+)((?:[_\-·~]\d{2,3}(?![0-9단]))*)/g)) {
    let prev = Number(m[1]);
    out.add('REQ-' + prev);
    for (const part of m[2]!.matchAll(/([_\-·~])(\d{2,3})/g)) {
      const n = Number(part[2]);
      if ((part[1] === '-' || part[1] === '~') && n > prev && n - prev < 20) for (let k = prev + 1; k <= n; k++) out.add('REQ-' + k);
      else out.add('REQ-' + n);
      prev = n;
    }
  }
  for (const m of text.matchAll(/(?:^|[^A-Za-z])D(\d{2})(?![0-9])/g)) out.add('D' + Number(m[1]));
  return [...out];
}
const docNo = (name: string) => { const m = name.match(/^(\d+)_/); return m ? Number(m[1]) : undefined; };
type Words = { pass: string[]; conditional: string[]; fail: string[] };
/** The first verdict word in `text`; at one position the longer word wins ("불통과" over "통과"). */
function verdictOf(text: string, words: Words): { kind: Exclude<Verdict, 'unknown'>; word: string } | null {
  let best: { i: number; word: string; kind: Exclude<Verdict, 'unknown'> } | null = null;
  for (const kind of ['pass', 'conditional', 'fail'] as const) for (const word of words[kind]) {
    const i = text.indexOf(word);
    if (i >= 0 && (!best || i < best.i || (i === best.i && word.length > best.word.length))) best = { i, word, kind };
  }
  return best && { kind: best.kind, word: best.word };
}
// 317-F1: cut in the reply schema's unit (UTF-16) and only between graphemes — the same rule as a record excerpt (`clipText`).
const clip = (text: string, n = 160) => clipText(text.trim().replace(/\*\*/g, ''), n);
/**
 * `verdict`: the line holding a marker, the first verdict word after the marker; a marker with nothing after it (a heading
 * like "## 최종 판정") reads the next non-empty line. A marker counts only as a whole word — "최종 집계는 …" in prose and
 * "종합 판정표" do not. Lines that start with a marker (after `#`, `-`, `*`, `>`) are tried before lines that only hold
 * one further on; table rows are skipped.
 */
export function readVerdict(text: string, markers: string[], words: Words) {
  const lines = text.split('\n');
  const leads = (line: string) => line.replace(/^[\s#*>\-]+/, '');
  /** Where `marker` stands as a whole word in `line` (not followed by a letter, digit or Hangul syllable), or -1. */
  const word = (line: string, marker: string) => {
    for (let at = line.indexOf(marker); at >= 0; at = line.indexOf(marker, at + 1))
      if (!/[0-9A-Za-z\uAC00-\uD7A3]/.test(line.charAt(at + marker.length))) return at;
    return -1;
  };
  for (const strong of [true, false]) for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('|')) continue;
    const marker = markers.find(m => strong ? leads(line).startsWith(m) && word(leads(line), m) === 0 : word(line, m) >= 0);
    if (!marker) continue;
    let rest = line.slice(word(line, marker) + marker.length).replace(/[*:#—\-\s]/g, ' ').trim(), at = i;
    if (!rest) for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) if (lines[j]!.trim()) { rest = lines[j]!; at = j; break; }
    const v = verdictOf(rest, words);
    if (v) return { verdict: v.kind, word: v.word, marker, line: at + 1, excerpt: clip(lines[at]!) };
  }
  return null;
}
/** `after:<word>`: the first x.y.z within 40 characters after a `<word>`. */
function afterVersion(text: string, key: string): string | null {
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + 1)) {
    const v = text.slice(at + key.length, at + key.length + 40).match(VERSION)?.[1];
    if (v) return v;
  }
  return null;
}
const rulesOf = (release: string | string[] | undefined): string[] => release === undefined ? [] : Array.isArray(release) ? release : [release];
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
const kstOfEpoch = (epoch: number) =>
  new Date(epoch * 1000 + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' KST';

// ---- safe reading ----------------------------------------------------------------------------------------------------
interface Reading {
  root: string; limits: Limits; files: number; bytes: number; hit: Set<string>;
  /** U0: listings started, entries read over them, listings open now and the ones waiting for a turn. */
  listings: number; visits: number; open: number; waiting: (() => void)[];
}
const newReading = (root: string, limits: Limits): Reading =>
  ({ root, limits, files: 0, bytes: 0, hit: new Set(), listings: 0, visits: 0, open: 0, waiting: [] });
const within = (root: string, real: string) => real === root || real.startsWith(root + path.sep);
type Place = { state: 'inside'; real: string } | { state: 'outside' } | { state: 'gone'; code?: string | undefined };
/**
 * The one boundary check, made before any folder listing, stat or read (222-F1): the path's real path, symbolic links
 * followed, when it lies under one of `bases` (real paths — the workspace, or the git folders a worktree's `.git` names).
 * Anything else is `outside` and is neither listed, stat'ed nor read; a dangling link or a gone path is `gone`. Callers
 * touch only the real path returned.
 */
export async function confine(file: string, ...bases: string[]): Promise<Place> {
  let real: string;
  try { real = await fs.realpath(file); } catch (error) { return { state: 'gone', code: (error as NodeJS.ErrnoException).code }; }
  return bases.some(base => within(base, real)) ? { state: 'inside', real } : { state: 'outside' };
}
/**
 * research/238: a file `confine` let through, opened — and kept only if, once open, it is still a regular file at that
 * real path (no link in its last place, the same device and inode as the path names now), as server/mail-fs.ts reads a
 * message. A folder swapped for a link between the check and the open is never read. Null otherwise; the caller closes.
 */
async function openConfined(real: string): Promise<fs.FileHandle | null> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const opened = await handle.stat();
    const again = await fs.realpath(real), there = await fs.stat(again);
    if (opened.isFile() && again === real && there.dev === opened.dev && there.ino === opened.ino) return handle;
  } catch { /* gone or moved */ }
  await handle.close().catch(() => undefined);
  return null;
}
/** A small confined file's text (at most `limit` bytes), or null. */
async function smallText(real: string, limit: number): Promise<string | null> {
  const handle = await openConfined(real);
  if (!handle) return null;
  try { return (await handle.stat()).size < limit ? await handle.readFile('utf8') : null; }
  catch { return null; } finally { await handle.close().catch(() => undefined); }
}
/** The file's real path when it is inside the workspace, else null (outside, a dangling link, gone). */
async function inside(r: Reading, file: string): Promise<string | null> {
  const place = await confine(file, r.root);
  return place.state === 'inside' ? place.real : null;
}
const rel = (r: Reading, file: string) => path.relative(r.root, file).split(path.sep).join('/');
const skipped = (name: string) => /^[.@#]/.test(name);

/** What a listing says of one entry: its name as on disk, and its kind as the listing gives it ('unknown' when it does not). */
export interface FolderEntry { name: string; kind: 'file' | 'folder' | 'link' | 'other' | 'unknown' }
/**
 * How a listing ended. `listed`: whole. `partial`: stopped at a cap, said in `limits`. `unsupported`: this host cannot list
 * through a held folder, so nothing was listed (said in `limits`). `outside`/`gone`: the boundary check refused the path or
 * found nothing there. `refused`: the folder could not be held at the place that was checked — a part of its path became a
 * link, it moved, it is not a folder, or it could not be read — so nothing from it is used. `linked` (REQ-125 U1, asked with
 * `exact`): the path is inside but its real place is not the path itself — a link on the way — so it is not listed.
 */
export type ListingState = 'listed' | 'partial' | 'unsupported' | 'outside' | 'gone' | 'refused' | 'linked';
const HOLD_FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);
/** Entries Node reads from the folder at a time (`opendir`'s buffer): the most a listing holds in memory besides its matches. */
export const LISTING_BUFFER = 32;
const cap = (r: Reading, name: 'folderEntries' | 'visits' | 'listings' | 'concurrentListings') => r.limits[name] ?? WORKFLOW_LIMITS[name];
const kindOf = (d: Dirent): FolderEntry['kind'] => d.isFile() ? 'file' : d.isDirectory() ? 'folder' : d.isSymbolicLink() ? 'link'
  : d.isFIFO() || d.isSocket() || d.isBlockDevice() || d.isCharacterDevice() ? 'other' : 'unknown';
/** A turn among the listings open at once; a finished listing hands its turn to the next one waiting. */
async function turn(r: Reading): Promise<void> {
  if (r.open < cap(r, 'concurrentListings')) { r.open++; return; }
  await new Promise<void>(resolve => r.waiting.push(resolve));
}
const done = (r: Reading) => { const next = r.waiting.shift(); if (next) next(); else r.open--; };
/**
 * REQ-125 U0 (research/290 2.9·2.10, 291 F6·F7): the one way a folder in the workspace is listed.
 * 1. The boundary check (`confine`) gives the folder's real path R inside the workspace.
 * 2. R is held, not named again: the workspace folder is opened, then each part of R below it is opened through the part
 *    above (`/proc/self/fd/<fd>/<part>`) with O_DIRECTORY|O_NOFOLLOW — a part swapped for a link since the check (the
 *    folder itself or one above it) is not followed, so nothing outside is ever opened. The held folder must still be at R.
 * 3. The listing goes through the held folder only (`opendir` of `/proc/self/fd/<fd>`), one entry at a time with a small
 *    buffer, counted against the caps before each entry: entries per folder, entries per reading, listings per reading
 *    (counted before a listing starts) and listings at once. A cap reached stops the listing and is said in `limits`;
 *    a folder holding exactly the per-folder cap is said cut too (no entry is read past a cap to tell).
 * 4. A host with no `/proc/self/fd` (not Linux) lists nothing — never by name instead — and says `listing-unsupported`.
 * 5. Once listed, the held folder must still be at R; moved meanwhile, the listing is `refused` and its entries go unused.
 * Entry kinds come from the listing itself (`take` gets them); deciding what an entry is stays with the caller.
 * `exact` (REQ-125 U1, every `/2` listing): the folder's real path must be the path asked — no link anywhere on its way,
 * so a 건's id, its place and what is read are one (research/290 1.1, 291 F5) — else `linked`, nothing listed.
 */
async function listFolder(r: Reading, folder: string, take: (entry: FolderEntry) => void, { exact = false } = {}): Promise<{ state: ListingState; code?: string }> {
  const place = await confine(folder, r.root);
  if (place.state === 'outside') return { state: 'outside' };
  if (place.state === 'gone') return { state: 'gone', ...(place.code ? { code: place.code } : {}) };
  const real = place.real;
  if (exact && real !== path.resolve(folder)) return { state: 'linked' };
  if (process.platform !== 'linux') { r.hit.add('listing-unsupported'); return { state: 'unsupported' }; }
  if (r.listings >= cap(r, 'listings')) { r.hit.add('listings'); return { state: 'partial' }; }
  if (r.visits >= cap(r, 'visits')) { r.hit.add('visits'); return { state: 'partial' }; }
  r.listings++;
  await turn(r);
  const held: fs.FileHandle[] = [];
  const at = (handle: fs.FileHandle) => '/proc/self/fd/' + handle.fd;
  try {
    held.push(await fs.open(r.root, HOLD_FOLDER));
    // A host whose /proc does not name the workspace folder as its real path cannot confirm any place: said, not silent.
    let rootPlace: string | null = null;
    try { rootPlace = await fs.readlink(at(held[0]!)); } catch { /* no /proc/self/fd */ }
    if (rootPlace !== r.root) { r.hit.add('listing-unsupported'); return { state: 'unsupported' }; }
    for (const part of path.relative(r.root, real).split(path.sep).filter(Boolean))
      held.push(await fs.open(at(held.at(-1)!) + '/' + part, HOLD_FOLDER));
    const folderHeld = held.at(-1)!;
    if (await fs.readlink(at(folderHeld)) !== real) return { state: 'refused' };
    let state: ListingState = 'listed', seen = 0;
    const dir = await fs.opendir(at(folderHeld), { bufferSize: LISTING_BUFFER });
    try {
      for (;;) {
        if (seen >= cap(r, 'folderEntries')) { r.hit.add('folder-entries:' + (rel(r, real) || '.')); state = 'partial'; break; }
        if (r.visits >= cap(r, 'visits')) { r.hit.add('visits'); state = 'partial'; break; }
        // The entry is counted before it is read, so listings open at once cannot pass the cap together.
        r.visits++;
        const entry = await dir.read().catch((error: unknown) => { r.visits--; throw error; });
        if (!entry) { r.visits--; break; }
        seen++;
        take({ name: entry.name, kind: kindOf(entry) });
      }
    } finally { await dir.close().catch(() => undefined); }
    if (await fs.readlink(at(folderHeld)) !== real) return { state: 'refused' };
    return { state };
  } catch (error) {
    return { state: 'refused', ...((error as NodeJS.ErrnoException).code ? { code: (error as NodeJS.ErrnoException).code! } : {}) };
  } finally {
    for (const handle of held.reverse()) await handle.close().catch(() => undefined);
    done(r);
  }
}
/**
 * A pattern's matches, sorted by name: `*` matches inside one segment and never a hidden, `@` or `#` name. Folders are
 * listed by `listFolder` only (U0); `/1` matches names as it always has, whatever their kind, so a link inside the
 * workspace still leads where it did (research/292 J3) — each match's own place is checked below before it is stat'ed.
 */
async function glob(r: Reading, pattern: string): Promise<{ file: string; directory: boolean }[]> {
  let bases = [r.root];
  const parts = pattern.normalize('NFC').split('/');
  for (const part of parts) {
    const next: string[] = [];
    for (const base of bases) {
      if (!part.includes('*')) { next.push(path.join(base, part)); continue; }
      const star = part.indexOf('*'), pre = part.slice(0, star), post = part.slice(star + 1);
      // Only the matches are kept (never the whole listing), then sorted by name as the full listing was before U0.
      const found: string[] = [];
      const { state } = await listFolder(r, base, ({ name: raw }) => {
        const name = raw.normalize('NFC');
        if (!skipped(name) && name.length >= pre.length + post.length && name.startsWith(pre) && name.endsWith(post)) found.push(raw);
      });
      if (state !== 'listed' && state !== 'partial') continue;
      for (const raw of found.sort()) next.push(path.join(base, raw));
    }
    bases = next;
    if (bases.length > r.limits.filesPerPattern) { r.hit.add(`files-per-pattern:${pattern}`); bases = bases.slice(0, r.limits.filesPerPattern); }
  }
  const out: { file: string; directory: boolean }[] = [];
  for (const file of bases) {
    const real = await inside(r, file);
    if (!real) continue;
    try { const stat = await fs.stat(real); if (stat.isFile() || stat.isDirectory()) out.push({ file, directory: stat.isDirectory() }); } catch { /* gone */ }
  }
  return out;
}
function spend(r: Reading, bytes: number): boolean {
  if (r.files + 1 > r.limits.files) { r.hit.add('files'); return false; }
  if (r.bytes + bytes > r.limits.bytes) { r.hit.add('bytes'); return false; }
  r.files++; r.bytes += bytes;
  return true;
}
/** The first `bytes` of a file inside the workspace (a cut character at the end dropped), or null. */
async function head(r: Reading, file: string, bytes: number): Promise<string | null> {
  const real = await inside(r, file);
  if (!real || !spend(r, bytes)) return null;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await openConfined(real);
    if (!handle) return null;
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/�+$/, '');
  } catch { return null; } finally { await handle?.close().catch(() => undefined); }
}
async function whole(r: Reading, file: string): Promise<string | null> {
  const real = await inside(r, file);
  if (!real) return null;
  let size = 0;
  try { size = (await fs.stat(real)).size; } catch { return null; }
  if (size > r.limits.wholeFileBytes) r.hit.add(`file-too-large:${rel(r, file)}`);
  return head(r, file, Math.min(size, r.limits.wholeFileBytes));
}

// ---- git without git -------------------------------------------------------------------------------------------------
const gitFolder = (real: string) => /(?:^|[\\/])\.git(?:[\\/]worktrees[\\/][^\\/]+)?$/.test(real);
const worktreeFolder = (real: string) => /(?:^|[\\/])\.git[\\/]worktrees[\\/][^\\/]+$/.test(real);
/** The branch's reflog text (its tail past the cap), from `.git` as a folder or a worktree's `gitdir:` file. */
async function readReflog(r: Reading, branch: string): Promise<{ state: 'read' | 'no-repo' | 'no-log'; text: string; source: string }> {
  const noRepo = { state: 'no-repo' as const, text: '', source: '' };
  // `.git` itself must be inside (a link to a file or folder outside is not followed).
  const dotGit = await inside(r, path.join(r.root, '.git'));
  if (!dotGit) return noRepo;
  let gitDir: string | null = null;
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) gitDir = dotGit;
    else if (stat.isFile() && stat.size < 4096) {
      const pointer = (await smallText(dotGit, 4096))?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      // The one exception, kept narrow: a worktree's `gitdir:` may name a folder outside, only a `.git/worktrees/<name>`.
      const target = pointer ? path.resolve(r.root, pointer) : null;
      const place = target ? await confine(target, r.root, ...(worktreeFolder(target) ? [target] : [])) : null;
      if (place?.state === 'inside') gitDir = place.real;
    }
  } catch { return noRepo; }
  if (!gitDir) return noRepo;
  let common = gitDir;
  try {
    // A worktree's common folder is only its own repository's `.git` — the folder two levels above `.git/worktrees/<name>`.
    const commondir = await confine(path.join(gitDir, 'commondir'), gitDir);
    if (commondir.state === 'inside') {
      const text = await smallText(commondir.real, 4096);
      if (text === null) throw new Error('commondir unreadable');
      const real = await fs.realpath(path.resolve(gitDir, text.trim()));
      if (gitFolder(real) && (within(r.root, real) || path.dirname(path.dirname(gitDir)) === real)) common = real;
    }
  } catch { /* not a worktree */ }
  const logs: [string, string][] = [[path.join(common, 'logs', 'refs', 'heads', ...branch.split('/')), `.git/logs/refs/heads/${branch}`],
    [path.join(gitDir, 'logs', 'HEAD'), '.git/logs/HEAD']];
  for (const [file, source] of logs) {
    let handle: fs.FileHandle | null = null;
    try {
      const place = await confine(file, common, gitDir);
      if (place.state !== 'inside') continue;
      handle = await openConfined(place.real);
      if (!handle) continue;
      const size = (await handle.stat()).size, length = Math.min(size, r.limits.reflogBytes);
      if (!spend(r, length)) return { state: 'no-log', text: '', source };
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      let text = buffer.toString('utf8');
      if (size > length) { r.hit.add('reflog-tail'); text = text.slice(text.indexOf('\n') + 1); }
      return { state: 'read', text, source };
    } catch { /* try the next log */ } finally { await handle?.close().catch(() => undefined); }
  }
  return { state: 'no-log', text: '', source: '' };
}
/** Commit entries of a reflog: hash, time, title. Names and e-mail addresses on the line are never kept. */
function reflogCommits(text: string) {
  const out: { sha: string; epoch: number; subject: string }[] = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(' '), message = line.slice(tab + 1);
    const colon = message.indexOf(': ');
    if (colon < 0 || !/^commit\b/.test(message.slice(0, colon))) continue;
    const sha = meta[1] ?? '', epoch = Number(meta.at(-2));
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !Number.isFinite(epoch)) continue;
    out.push({ sha, epoch, subject: message.slice(colon + 2) });
  }
  return out;
}

// ---- one reading -----------------------------------------------------------------------------------------------------
type Event = WorkflowEventDTO;
const emptyTally = (): WorkflowTally => ({ count: 0, pass: 0, conditional: 0, fail: 0, unknown: 0 });
function count(list: Event[]): WorkflowTally {
  const t = emptyTally();
  for (const e of list) { t.count++; if (e.verdict) t[e.verdict]++; }
  return t;
}
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Where the definition file really is, through the one boundary check; both the reading and a lane's button use it. */
async function locateDefinition(cwd: string): Promise<{ root: string; real: string } | { reason: 'missing' | 'outside' | 'unreadable' }> {
  if (!cwd || !path.isAbsolute(cwd)) return { reason: 'unreadable' };
  let root: string;
  try { root = await fs.realpath(cwd); } catch { return { reason: 'unreadable' }; }
  const place = await confine(path.join(root, WORKFLOW_DEFINITION_PATH), root);
  if (place.state === 'inside') return { root, real: place.real };
  return { reason: place.state === 'outside' ? 'outside' : place.code === 'ENOENT' ? 'missing' : 'unreadable' };
}
/** Reads the definition, or says why there is none. The definition is read whole, up to its cap, and must stay inside. */
export async function readDefinition(cwd: string, limits: Limits = WORKFLOW_LIMITS):
  Promise<{ def: WorkflowDefinition | WorkflowDefinition2; root: string } | Extract<WorkflowDTO, { defined: false }>> {
  const absent = (reason: 'missing' | 'unknown-format' | 'too-large' | 'outside' | 'unreadable' | 'needs-update', problems?: string[]) =>
    ({ defined: false as const, reason, definitionPath: WORKFLOW_DEFINITION_PATH, ...(problems ? { problems } : {}) });
  const found = await locateDefinition(cwd);
  if ('reason' in found) return absent(found.reason);
  const { root, real } = found;
  let text: string;
  const handle = await openConfined(real);
  if (!handle) return absent('unreadable');
  try {
    const stat = await handle.stat();
    if (stat.size > limits.definitionBytes) return absent('too-large');
    text = await handle.readFile('utf8');
  } catch { return absent('unreadable'); } finally { await handle.close().catch(() => undefined); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return absent('unknown-format', ['Not JSON.']); }
  // REQ-125 U1: a `/2` file's features this build does not read come first — "update Kanban", not a part read.
  const unread = unreadFeatures(raw);
  if (unread.length) return absent('needs-update', unread);
  const parsed = (raw as { format?: unknown } | null)?.format === WORKFLOW_FORMAT_2 ? workflowDefinition2Schema.safeParse(raw) : workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) return absent('unknown-format',
    parsed.error.issues.slice(0, 10).map(i => `${i.path.join('.') || '(file)'}: ${i.message}`.slice(0, 200)));
  return { def: parsed.data, root };
}

/** REQ-125: the built-in a workspace is trying, and the language its steps are named in. */
export interface WorkflowPickOption { template: string; locale: WorkflowLocale }
/** One reading of a workspace's workflow: the definition's sources, joined by release. */
export async function readWorkflow(cwd: string, options: { window?: number; limits?: Limits; now?: () => Date; pick?: WorkflowPickOption | undefined } = {}): Promise<WorkflowDTO> {
  const started = performance.now();
  const limits = options.limits ?? WORKFLOW_LIMITS;
  let found = await readDefinition(cwd, limits);
  const picked = options.pick ? builtinWorkflow(options.pick.template) : undefined;
  let builtin: typeof picked;
  if (!('def' in found)) {
    if (found.reason !== 'missing' || !picked) return picked ? { ...found, restingPick: picked.id } : found;
    // REQ-125: no file — the built-in's steps; with no sources the reading below touches nothing in the workspace.
    builtin = picked;
    found = { def: builtinDefinition(picked, options.pick!.locale), root: cwd };
  }
  if (found.def.format === WORKFLOW_FORMAT_2)
    return { ...await readInstances(found.def, found.root, limits, options.now, started), ...(picked ? { restingPick: picked.id } : {}) };
  const { def, root } = found as { def: WorkflowDefinition; root: string };
  const r = newReading(root, limits);
  const events: Event[] = [], unknownFormat: { stage: string; path: string }[] = [], missing: { stage: string; path: string }[] = [];
  const reqRelease = new Map<string, { release: string; path: string; line: number }>();
  let git: WorkflowModelDTO['git'] = { state: 'unused', commits: 0 };

  // 1. The REQ table first: the other rules' `req` fallback reads it.
  for (const src of def.sources) {
    if (src.read !== 'headings') continue;
    for (const { file, directory } of (await Promise.all(src.files.map(p => glob(r, p)))).flat()) {
      if (directory) continue;
      const text = await whole(r, file);
      if (text === null) continue;
      text.split('\n').forEach((line, i) => {
        if (!line.startsWith(src.heading + ' ') || !line.includes(src.verb)) return;
        const id = idsOf(line.slice(0, line.indexOf(src.verb)))[0];
        if (!id) return;
        const after = line.slice(line.indexOf(src.verb)), done = after.search(/완료|커밋/);
        const release = done >= 0 ? after.slice(done).match(VERSION)?.[1] ?? null : null;
        const times = [...line.matchAll(/(20\d\d-\d\d-\d\d \d\d:(?:\d\d|xx|\dx))\s*KST/g)].map(m => m[1]!);
        if (release) reqRelease.set(id, { release, path: rel(r, file), line: i + 1 });
        events.push({ stage: src.stage, kind: 'heading', release, releaseFrom: release ? 'text' : null, path: rel(r, file), line: i + 1,
          ids: [id], excerpt: clip(line.replace(/^#+\s*/, '')), ...(src.time ? { time: times.at(-1) ?? null } : {}) });
      });
    }
  }
  // 2. Documents, reports, results, commits — releases read directly; `req` ones are settled in step 3.
  const pending: { event: Event; ids: string[] }[] = [];
  for (const src of def.sources) {
    if (src.read === 'names' || src.read === 'verdict') {
      const matches = (await Promise.all(src.files.map(p => glob(r, p)))).flat();
      const seen = new Set<string>();
      for (const { file, directory } of matches) {
        if (seen.has(file)) continue;
        seen.add(file);
        const name = path.basename(file).normalize('NFC');
        const ids = src.read === 'names' && !src.id ? [] : idsOf(name);
        const event: Event = { stage: src.stage, kind: src.read === 'verdict' ? 'verdict' : 'document', release: null, releaseFrom: null,
          path: rel(r, file), ...(docNo(name) !== undefined ? { doc: docNo(name)! } : {}) };
        let text: string | null = null;
        if (src.read === 'verdict') {
          if (directory) continue;
          text = await head(r, file, src.headBytes ?? limits.defaultHeadBytes);
          event.round = src.round;
          const title = text?.split('\n').find(l => l.startsWith('# '));
          for (const id of title ? idsOf(title) : []) if (!ids.includes(id)) ids.push(id);
          const v = text === null ? null : readVerdict(text, src.markers, src.words);
          if (src.time) event.time = text === null ? null : kstTime(text);
          if (v) Object.assign(event, { verdict: v.verdict, word: v.word, marker: v.marker, line: v.line, excerpt: v.excerpt });
          else { event.verdict = 'unknown'; unknownFormat.push({ stage: src.stage, path: event.path }); }
        }
        if (ids.length) event.ids = ids;
        for (const rule of rulesOf(src.release)) {
          const v = rule === 'name-version' ? nameVersion(name) : rule.startsWith('after:') && text !== null ? afterVersion(text, rule.slice(6)) : null;
          if (v) { event.release = v; event.releaseFrom = rule === 'name-version' ? 'name' : 'text'; break; }
        }
        if (!event.release && (src.releaseFallback === 'req' || ('releaseVia' in src && src.releaseVia === 'req'))) pending.push({ event, ids });
        events.push(event);
      }
    } else if (src.read === 'result-head') {
      for (const pattern of src.files) {
        const matches = await glob(r, pattern);
        for (const { file, directory } of matches) {
          if (directory) continue;
          const text = await head(r, file, src.headBytes ?? limits.defaultHeadBytes);
          const title = (text ?? '').split('\n')[0] ?? '';
          let release: string | null = null, approx = false;
          for (const rule of rulesOf(src.release)) {
            if (rule.startsWith('after:') && text !== null) release = afterVersion(text, rule.slice(6));
            if (release) break;
          }
          if (!release && text !== null) { release = text.split('\n').slice(0, 3).join('\n').match(VERSION)?.[1] ?? null; approx = !!release; }
          const sha = src.sha === 'dir-suffix' ? path.basename(path.dirname(file)).match(/-([0-9a-f]{7,40})$/)?.[1] : undefined;
          const event: Event = { stage: src.stage, kind: 'result', release, releaseFrom: release ? 'text' : null, path: rel(r, file), line: 1,
            excerpt: clip(title.replace(/^#+\s*/, '')), ok: !(src.failWords ?? []).some(w => title.includes(w)),
            ...(sha ? { sha } : {}), ...(approx ? { approx: true as const } : {}), ...(src.time ? { time: text === null ? null : kstTime(text) } : {}) };
          events.push(event);
          if (!release) unknownFormat.push({ stage: src.stage, path: event.path });
        }
        // A folder the pattern names whose result file is not there: "자료 없음", not "형식 모름".
        const parts = pattern.split('/');
        if (parts.length < 2) continue;
        for (const { file: dir, directory } of await glob(r, parts.slice(0, -1).join('/'))) {
          if (!directory || matches.some(m => path.dirname(m.file) === dir)) continue;
          const sha = src.sha === 'dir-suffix' ? path.basename(dir).match(/-([0-9a-f]{7,40})$/)?.[1] : undefined;
          missing.push({ stage: src.stage, path: rel(r, dir) });
          events.push({ stage: src.stage, kind: 'result', release: null, releaseFrom: null, path: rel(r, dir), missing: true, ...(sha ? { sha } : {}) });
        }
      }
    } else if (src.read === 'git-reflog') {
      const log = await readReflog(r, src.branch);
      const commits = reflogCommits(log.text);
      git = { state: log.state === 'read' && !commits.length ? 'no-commits' : log.state, commits: commits.length };
      for (const c of commits) {
        const release = c.subject.match(/bump to (\d+\.\d+\.\d+)/)?.[1] ?? null;
        events.push({ stage: src.stage, kind: 'commit', release, releaseFrom: release ? 'bump' : null, sha: c.sha.slice(0, 7),
          time: kstOfEpoch(c.epoch), subject: clip(c.subject), path: log.source });
      }
    }
  }
  // 3. REQ-103: a REQ can span releases. Its releases are the REQ table's done version and every release whose report
  //    (a verdict read with a version of its own) names it in its title. A document without a version goes to the release
  //    whose first report follows it (document order); with no such report, to the REQ table's version.
  const reportIds = new Map<string, Map<string, Event>>(), firstReport = new Map<string, number>();
  for (const e of events) if (e.kind === 'verdict' && e.release && e.releaseFrom !== 'req') {
    const ids = reportIds.get(e.release) ?? new Map<string, Event>();
    for (const id of e.ids ?? []) if (!ids.has(id)) ids.set(id, e);
    reportIds.set(e.release, ids);
    if (e.doc !== undefined) firstReport.set(e.release, Math.min(firstReport.get(e.release) ?? Infinity, e.doc));
  }
  for (const { event, ids } of pending) {
    const tally = new Map<string, number>();
    for (const id of ids) { const v = reqRelease.get(id)?.release; if (v) tally.set(v, (tally.get(v) ?? 0) + 1); }
    const byTable = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const candidates = new Set<string>(byTable ? [byTable] : []);
    for (const [release, named] of reportIds) if (ids.some(id => named.has(id))) candidates.add(release);
    let chosen = byTable, from: Event['releaseFrom'] = byTable ? 'req' : null;
    if (candidates.size > 1 && event.doc !== undefined) {
      const next = [...candidates].filter(v => (firstReport.get(v) ?? -Infinity) > event.doc!)
        .sort((a, b) => firstReport.get(a)! - firstReport.get(b)!)[0];
      if (next && next !== byTable) { chosen = next; from = 'order'; }
    }
    event.release = chosen; event.releaseFrom = from;
  }

  // 4. Releases: versions read directly from a report, a commit title or a result (not the REQ table), newest first.
  const direct = new Set<string>();
  for (const e of events) if (e.release && !e.approx && (e.kind === 'commit' || e.kind === 'result' || (e.kind === 'verdict' && e.releaseFrom !== 'req'))) direct.add(e.release);
  const window = Math.min(options.window ?? def.releaseWindow ?? 10, 100);
  const shown = [...direct].sort(compareVersions).reverse().slice(0, window);
  const stagesWithSource = new Set(def.sources.map(s => s.stage));
  const commitStages = new Set(def.sources.filter(s => s.read === 'git-reflog').map(s => s.stage));
  const shaStages = new Set(def.sources.filter(s => s.read === 'result-head' && s.sha === 'dir-suffix').map(s => s.stage));
  const loopStages = new Set(def.edges.filter(e => e.back).flatMap(e => [e.from, e.to]));
  const col = new Map(def.stages.map(s => [s.id, s.col]));
  const loopRank = Math.min(...[...loopStages].map(s => col.get(s) ?? Infinity));
  const byDoc = (a: Event, b: Event) => (a.doc ?? 0) - (b.doc ?? 0) || Number(a.round === 'again') - Number(b.round === 'again');
  const releases: WorkflowReleaseDTO[] = shown.map(release => {
    const of = (stage: string) => events.filter(e => e.stage === stage && e.release === release);
    const reqs: WorkflowReleaseDTO['reqs'] = [];
    for (const [id, at] of reqRelease) if (at.release === release) reqs.push({ id, via: 'heading', path: at.path, line: at.line });
    for (const [id, e] of reportIds.get(release) ?? []) if (!reqs.some(q => q.id === id))
      reqs.push({ id, via: 'report', path: e.path, ...(e.line !== undefined ? { line: e.line } : {}) });
    const warnings: WorkflowReleaseDTO['warnings'] = [];
    const cells = def.stages.map(stage => {
      let list = of(stage.id), state: CellState;
      if (!stagesWithSource.has(stage.id)) state = stage.shape === 'diamond' ? 'decision' : 'no-source';
      else if (list.length) state = list.every(e => e.verdict === 'unknown') ? 'unknown-format' : 'found';
      else if (commitStages.has(stage.id)) {
        // Decided 2026-09-30: no commit title for this release → the stable result's hash, said as such.
        const stable = events.find(e => shaStages.has(e.stage) && e.release === release && e.sha && !e.missing);
        list = stable ? [{ stage: stage.id, kind: 'commit', release, releaseFrom: 'stable-sha', sha: stable.sha!.slice(0, 7), path: stable.path,
          ...(stable.time !== undefined ? { time: stable.time } : {}) }] : [];
        state = stable ? 'title-unread' : 'no-record';
      } else state = 'no-record';
      if (commitStages.has(stage.id) && state === 'found') {
        const commit = list.at(-1)!;
        for (const result of events.filter(e => shaStages.has(e.stage) && e.release === release && e.sha && !e.missing))
          if (commit.sha && !commit.sha.startsWith(result.sha!.slice(0, 7)) && !result.sha!.startsWith(commit.sha))
            warnings.push({ kind: 'sha-mismatch', stage: stage.id, sha: commit.sha, resultStage: result.stage, resultSha: result.sha!, path: result.path });
      }
      return { stage: stage.id, state, events: [...list].sort(byDoc) };
    });
    const verdicts = events.filter(e => e.kind === 'verdict' && e.release === release).sort(byDoc);
    const known = verdicts.filter(e => e.verdict !== 'unknown');
    const path: WorkflowReleaseDTO['path'] = [];
    const ranked = def.stages.filter(s => cells.find(c => c.stage === s.id)!.events.length)
      .map(s => ({ s, rank: loopStages.has(s.id) ? loopRank : s.col })).sort((a, b) => a.rank - b.rank || a.s.col - b.s.col);
    const loop = events.filter(e => loopStages.has(e.stage) && e.release === release).sort(byDoc);
    let loopDone = false;
    for (const { s } of ranked) {
      if (!loopStages.has(s.id)) { path.push({ stage: s.id }); continue; }
      if (loopDone) continue;
      loopDone = true;
      for (const e of loop) path.push({ stage: e.stage, ...(e.doc !== undefined ? { doc: e.doc } : {}), ...(e.round ? { round: e.round } : {}),
        ...(e.verdict ? { verdict: e.verdict } : {}) });
    }
    return { release, reqs, firstVerdict: known.find(e => e.round === 'first')?.verdict ?? verdicts.find(e => e.round === 'first')?.verdict ?? null,
      finalVerdict: known.at(-1)?.verdict ?? null, regates: verdicts.filter(e => e.round === 'again').length, cells, path, warnings };
  });

  // 5. Counts per stage (and round) over the releases shown and over everything read.
  const inWindow = new Set(shown);
  const totals: WorkflowModelDTO['totals'] = [];
  for (const stage of def.stages) {
    const rounds = def.sources.some(s => s.stage === stage.id && s.read === 'verdict')
      ? [...new Set(def.sources.filter(s => s.stage === stage.id && s.read === 'verdict').map(s => (s as { round: 'first' | 'again' }).round))] : [undefined];
    for (const round of rounds) {
      if (!stagesWithSource.has(stage.id)) continue;
      const all = events.filter(e => e.stage === stage.id && !e.missing && (round === undefined || e.round === round));
      totals.push({ stage: stage.id, ...(round ? { round } : {}), window: count(all.filter(e => e.release && inWindow.has(e.release))), all: count(all) });
    }
  }
  const reports = events.filter(e => e.kind === 'verdict').sort(byDoc);
  const body = { releases, reports, unknownFormat, missing, git, limits: [...r.hit].sort() };
  return {
    defined: true, definitionPath: builtin ? 'builtin:' + builtin.id : WORKFLOW_DEFINITION_PATH, key: key([def, body]), readAt: (options.now?.() ?? new Date()).toISOString(),
    definition: { name: def.name, ...(def.note ? { note: def.note } : {}), releaseWindow: def.releaseWindow ?? 10, stages: def.stages, edges: def.edges },
    totals, ...body, cost: { files: r.files, bytes: r.bytes, ms: Math.round(performance.now() - started) },
    ...(builtin ? { builtin: { id: builtin.id, version: builtin.version, grade: builtin.grade } } : picked ? { restingPick: picked.id } : {}),
  };
}

// ---- REQ-125 U1: 건 rows from a `/2` file (research/290 1.1·1.2·2.1·2.9·2.10) ---------------------------------------------
type ExcludedWhy = NonNullable<WorkflowModelDTO['excluded']>[number]['why'];
/** What a `/2` reading notes besides events: folders left out and why, folders read only in part — workspace-relative, NFC. */
interface Notes { excluded: Map<string, ExcludedWhy>; incomplete: Set<string> }
/** A place a `/2` walk reached: where it is on disk (names as written there), its workspace-relative path in NFC, its kind. */
interface Reached { file: string; rel: string; kind: 'file' | 'folder' }
const nfc = (name: string) => name.normalize('NFC');
const joinRel = (base: string, name: string) => base ? base + '/' + name : name;
const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
/** `README`, `README.md`, `readme.txt` …: a folder's own guide, not its data (research/290 2.1). */
const readme = (name: string) => /^readme(?:\.|$)/i.test(name);
/** A folder name's `_YYYYMMDD` end as `YYYY-MM-DD`, when that day is on the calendar; a file time is never used. */
export function folderDate(name: string): string | null {
  const m = nfc(name).match(/_(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])], day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** `strip-number-prefix`: one leading `01_`, `2-`, `3.` or `4 ` dropped — the name as it is when nothing would be left. */
export function instanceLabel(name: string, rule: 'as-is' | 'strip-number-prefix' = 'as-is'): string {
  if (rule === 'as-is') return name;
  const stripped = name.replace(/^\d{1,3}[_\-. ]/, '');
  return stripped || name;
}
/** How a `/2` listing ended, said in the notes: `true` when its entries can be used (whole or cut at a cap). */
function noted(state: ListingState, rel: string, notes: Notes): boolean {
  if (state === 'listed') return true;
  if (state === 'gone') return false;
  if (state === 'linked') { notes.excluded.set(rel, 'link'); return false; }
  if (state === 'outside') { notes.excluded.set(rel, 'outside'); return false; }
  notes.incomplete.add(rel);
  return state === 'partial';
}
/**
 * A `/2` pattern's segments under `base` (a real folder reached without links). Every segment is matched by listing its
 * folder through `listFolder` (`exact`) — a literal segment too, by its NFC name, so a name written in another normal form is
 * found and two names that are one in NFC are both left out (`nfc-collision`), never one picked. A link is never followed
 * (`link`); an entry whose kind the listing does not say is not counted and leaves its folder read in part; a folder cut at a
 * cap or not listable here is read in part. A `*` never matches a hidden, `@` or `#` name, as in `/1`; a segment written in full
 * matches its own name whatever it starts with (302-F1).
 */
async function walk(r: Reading, base: Reached, parts: string[], notes: Notes, lastFits?: (name: string) => boolean): Promise<{ reached: Reached[]; partial: boolean }> {
  let bases: Reached[] = [base], partial = false;
  for (const [i, raw] of parts.entries()) {
    const part = nfc(raw), last = i === parts.length - 1, star = part.indexOf('*');
    const pre = star < 0 ? part : part.slice(0, star), post = star < 0 ? '' : part.slice(star + 1);
    const next: Reached[] = [];
    for (const at of bases) {
      if (at.kind !== 'folder') continue;
      const matched: { raw: string; name: string; kind: FolderEntry['kind'] }[] = [];
      const { state } = await listFolder(r, at.file, entry => {
        const name = nfc(entry.name);
        // A segment written in full is taken as written (`@사업`, `#계약`); only `*` passes over hidden, `@` and `#` names, as in `/1`.
        // U2: a `file-versions` rule's file segment says itself which names fit (`lastFits`).
        if (last && lastFits ? lastFits(name)
          : star < 0 ? name === part : !skipped(name) && name.length >= pre.length + post.length && name.startsWith(pre) && name.endsWith(post))
          matched.push({ raw: entry.name, name, kind: entry.kind });
      }, { exact: true });
      if (state !== 'listed') partial ||= state !== 'gone' && state !== 'linked' && state !== 'outside';
      if (!noted(state, at.rel, notes)) continue;
      const times = new Map<string, number>();
      for (const m of matched) times.set(m.name, (times.get(m.name) ?? 0) + 1);
      for (const m of matched.sort(byName)) {
        const rel = joinRel(at.rel, m.name);
        if (times.get(m.name)! > 1) notes.excluded.set(rel, 'nfc-collision');
        else if (m.kind === 'link') notes.excluded.set(rel, 'link');
        else if (m.kind === 'unknown') { notes.excluded.set(rel, 'unknown-kind'); notes.incomplete.add(at.rel); partial = true; }
        else if (m.kind === 'folder' || (last && m.kind === 'file')) next.push({ file: path.join(at.file, m.raw), rel, kind: m.kind });
      }
    }
    bases = next;
    if (bases.length > r.limits.filesPerPattern) { r.hit.add('files-per-pattern:' + parts.join('/')); bases = bases.slice(0, r.limits.filesPerPattern); partial = true; }
  }
  return { reached: bases, partial };
}
/**
 * `folder` (research/290 2.1): how many data files a folder holds — regular files right inside it, not hidden (`.`), not
 * README.*; links and special files are not counted. `@견적.pdf` and `#계약.pdf` are data (302-F1): the `@`/`#` rule is the
 * 건 list's and a wildcard's only. U3 311-F2: a data file `held` (a common rule took it as 규칙 충돌) is not counted; its path
 * comes back in `held` so the cell can say why.
 */
const dataFile = (name: string) => !name.startsWith('.') && !readme(name);
async function dataIn(r: Reading, at: Reached, notes: Notes, isHeld: (rel: string) => boolean = () => false): Promise<{ files: number; partial: boolean; held: string[] }> {
  let files = 0, unknown = false;
  const held: string[] = [];
  const { state } = await listFolder(r, at.file, entry => {
    const name = nfc(entry.name);
    if (entry.kind === 'unknown') unknown = true;
    else if (entry.kind === 'file' && dataFile(name)) { if (isHeld(joinRel(at.rel, name))) held.push(joinRel(at.rel, name)); else files++; }
  }, { exact: true });
  const usable = noted(state, at.rel, notes);
  // A kind the listing did not say may have been the one data file: with none found, the folder is read in part.
  const partial = (state !== 'listed' && usable) || state === 'unsupported' || state === 'refused' || (usable && unknown && !files);
  if (partial) notes.incomplete.add(at.rel);
  return { files: usable ? files : 0, partial, held: usable ? held.sort() : [] };
}
// ---- REQ-125 U2: `file-versions` (research/290 2.2, 291 F2) -----------------------------------------------------------
const escapeText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** What one `{ver}` shape reads: whole numbers of up to six digits, as many as the shape has. */
const VER_SHAPE = { 'major.minor': '\\d{1,6}\\.\\d{1,6}', 'major.minor.patch': '\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}', integer: '\\d{1,6}' } as const;
type VerShape = keyof typeof VER_SHAPE;
/** A day `YYYYMMDD` as `YYYY-MM-DD` when it is on the calendar, else null. */
export function calendarDay(text: string): string | null {
  const m = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])], day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** A version read as numbers, leading zeros gone: "01.0" → "1.0". */
export const versionKey = (text: string) => text.split('.').map(n => String(Number(n))).join('.');
export function compareVersionKeys(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
/**
 * One file segment of a `file-versions` pattern, ready to read names (NFC) with:
 * - `fits`: its written letters stand in the name in order — the first at the start, the last at the end — whatever is
 *   between them (tokens, `*`). A name that fits is this document's, read (`read`) or "형식 모름". A segment that does not
 *   start with written letters never fits a hidden, `@` or `#` name, as `*` never does (a Mac's `._` copy is no version).
 *   No regular expression with more than one open repeat is run: the letters are looked for in order, left to right.
 * - `read`: the version, its day (null when the pattern has no `{yyyymmdd}`), and the chain's name — the name with each
 *   token's letters put back as the token (`{nn}`, `{ver}`, `{yyyymmdd}`, `{ext}`) and `*`'s letters kept. Null when a token
 *   does not read (not digits, a day not on the calendar): then the name is "형식 모름".
 * The format is never part of a chain (research/290 2.2, 306-F1): the pattern's extension place — `.{ext}`, written letters
 * ending in a "." and one to ten letters or digits (`.docx`), or `.*` at the very end — is always said `.{ext}` in the chain,
 * so `보고서_v{ver}.docx`, `보고서_v{ver}.pdf`, `보고서_v{ver}.*` and `보고서_v{ver}.{ext}` read one document. A pattern that ends
 * otherwise (`안_v{ver}`, `안_v{ver}_*`) has no extension place, and a "." inside a token is never taken for one.
 * 306-J9: Office's lock file (`~$…`, there only while a document is open) is passed over like a hidden name where no letters
 * are written first; a pattern that writes `~$` itself reads it.
 */
export function versionReader(segment: string, shape: VerShape) {
  const parts = versionParts(nfc(segment))!;
  const texts = parts.map(p => 'text' in p ? p.text : null), lead = texts[0] !== null;
  const fits = (name: string): boolean => {
    if (!lead && (skipped(name) || name.startsWith('~$'))) return false;
    let at = 0;
    for (const [i, text] of texts.entries()) {
      if (text === null) continue;
      if (i === 0) { if (!name.startsWith(text)) return false; at = text.length; continue; }
      if (i === texts.length - 1) return name.length - text.length >= at && name.endsWith(text);
      const found = name.indexOf(text, at);
      if (found < 0) return false;
      at = found + text.length;
    }
    return true;
  };
  const token = (p: VersionPart) => 'text' in p ? escapeText(p.text) : p.token === 'ver' ? `(${VER_SHAPE[shape]})` : p.token === 'yyyymmdd' ? '(\\d{8})'
    : p.token === 'ext' ? '([A-Za-z0-9]{1,10})' : p.token === 'nn' ? '(\\d{1,3})' : '(.*)';
  // One open repeat at most (`*`); every token is bounded, so a name is matched in a time its length bounds.
  const strict = new RegExp('^' + parts.map(token).join('') + '$', 'su');
  // The extension place (306-F1): the last part's written ".xxx", or a "*" right after a written "." at the very end.
  const lastPart = parts.at(-1)!, beforeLast = parts.at(-2);
  const writtenExt = 'text' in lastPart ? /\.[A-Za-z0-9]{1,10}$/.exec(lastPart.text) : null;
  const starExt = 'token' in lastPart && lastPart.token === 'star' && !!beforeLast && 'text' in beforeLast && beforeLast.text.endsWith('.');
  const read = (name: string): { ver: string; day: string | null; chain: string } | null => {
    if (!fits(name)) return null;
    const m = strict.exec(name);
    if (!m) return null;
    let group = 1, ver = '', day: string | null = null, chain = '';
    for (const p of parts) {
      if ('text' in p) { chain += p === lastPart && writtenExt ? p.text.slice(0, writtenExt.index) + '.{ext}' : p.text; continue; }
      const value = m[group++]!;
      if (p.token === 'star') { chain += p === lastPart && starExt ? '{ext}' : value; continue; }
      if (p.token === 'ver') ver = versionKey(value);
      if (p.token === 'yyyymmdd') { day = calendarDay(value); if (!day) return null; }
      chain += '{' + p.token + '}';
    }
    return { ver, day, chain };
  };
  return { fits, read };
}
type VersionRule = Extract<WorkflowSource2, { read: 'file-versions' }>;
/**
 * A `file-versions` rule over one 건: its documents' versions as events (research/290 2.2). Each pattern's folders are walked
 * as a `folder` rule's (U0 `listFolder`, `exact`: no link followed); in the last folder the names that fit are taken, files
 * only. A file several patterns reach counts once, read by the first of them (in the rule's order) that reads it. A chain is
 * (its folder inside the 건, its name without the tokens and its format); a version is the chain's distinct version number —
 * its files (any format, however the pattern names it) are one event, at its earliest day. `observed` keeps the lowest version, the ones above it, or both. A file
 * that fits but reads no version is one event without `ver` ("형식 모름"). Past `eventsPerRule` the rest is not taken.
 */
async function readVersions(r: Reading, src: VersionRule, inst: { id: string; file: string }, notes: Notes, owner: (rel: string) => string | null = () => null):
  Promise<{ events: Event[]; unread: string[]; partial: boolean; conflicts: string[] }> {
  const home: Reached = { file: inst.file, rel: inst.id, kind: 'folder' };
  // U3: a program rule (its `inst` the workspace folder, id '') walks its whole pattern; a 건 rule's starts after `{instance}`.
  const program = src.scope === 'program', segments = (pattern: string) => program ? pattern.split('/') : pattern.split('/').slice(1);
  const readers = src.files.map(p => versionReader(p.split('/').at(-1)!, src.ver));
  const reached = new Map<string, { at: Reached; by: number[] }>(), conflicts: string[] = [];
  let partial = false;
  for (const [i, pattern] of src.files.entries()) {
    const walked = await walk(r, home, segments(pattern), notes, readers[i]!.fits);
    partial ||= walked.partial;
    for (const at of walked.reached) {
      if (at.kind !== 'file') continue;
      const seen = reached.get(at.rel);
      if (seen) seen.by.push(i); else reached.set(at.rel, { at, by: [i] });
    }
  }
  const chains = new Map<string, Map<string, { paths: string[]; days: Set<string> }>>(), unread: string[] = [];
  for (const [rel, { at, by }] of [...reached].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    // U3: a program rule's file inside a 건 folder is no version of anything — "규칙 충돌", said by the caller.
    if (owner(rel) !== null) { conflicts.push(rel); continue; }
    const name = path.posix.basename(rel);
    const read = by.map(i => readers[i]!.read(name)).find(Boolean);
    if (!read) { unread.push(rel); continue; }
    const dir = path.posix.dirname(at.rel);
    const folder = program ? (dir === '.' ? '' : dir) : path.posix.relative(inst.id, dir), chain = folder ? folder + '/' + read.chain : read.chain;
    const versions = chains.get(chain) ?? new Map<string, { paths: string[]; days: Set<string> }>();
    const version = versions.get(read.ver) ?? { paths: [], days: new Set<string>() };
    version.paths.push(rel);
    if (read.day) version.days.add(read.day);
    versions.set(read.ver, version); chains.set(chain, versions);
  }
  const events: Event[] = [];
  for (const chain of [...chains.keys()].sort()) {
    const versions = [...chains.get(chain)!].sort((a, b) => compareVersionKeys(a[0], b[0]));
    for (const [i, [ver, { paths, days }]] of versions.entries()) {
      const observed = i === 0 ? 'lowest' as const : 'later' as const;
      if (src.observed && src.observed !== observed) continue;
      const sorted = [...days].sort();
      events.push({ stage: src.stage, kind: 'version', release: program ? null : inst.id, releaseFrom: null, path: paths[0]!, paths, ver, chain, observed,
        seen: versions.length, ...(sorted.length ? { time: sorted[0]! } : {}), ...(sorted.length > 1 ? { days: sorted.length } : {}) });
    }
  }
  for (const rel of unread) events.push({ stage: src.stage, kind: 'version', release: program ? null : inst.id, releaseFrom: null, path: rel });
  const most = r.limits.eventsPerRule ?? WORKFLOW_LIMITS.eventsPerRule;
  if (events.length > most) { r.hit.add('events-per-rule:' + src.stage); events.length = most; partial = true; }
  return { events, unread: unread.filter(rel => events.some(e => e.path === rel && e.ver === undefined)), partial, conflicts };
}
/** A cell's evidence that something is there: any event but a file whose version could not be read. */
const holds = (e: Event) => e.kind !== 'version' || e.ver !== undefined;

interface Instance { id: string; file: string; name: string; label: string }
/**
 * U4a (research/309 2.4): the list's other side — every folder name under the 건 folder no row shows (NFC: a link, two names one
 * in NFC, a hidden, `@` or `#` name, an excluded one, one past `instances`), cut from the list before the cap. `whole`: the 건
 * folder was listed to its end with every entry's kind told — else a tag naming no row cannot be told apart (일부만 읽음).
 */
interface Listing { hidden: string[]; whole: boolean }
/**
 * The 건 (research/290 1.1): each real folder right under the 건 folder. Left out and said: a link, two names one in NFC
 * (both), a hidden, `@` or `#` name, an entry of unknown kind; `exclude` names quietly. Past `instances` (200) the first ones
 * by name stay and "instances" goes into `limits` — never called "the latest".
 */
async function listInstances(r: Reading, def: WorkflowDefinition2, notes: Notes): Promise<{ folder: { path: string; found: boolean }; instances: Instance[]; listing: Listing }> {
  const parts = def.instanceKey.path.split('/').slice(0, -1).map(nfc), folderPath = parts.join('/');
  const root: Reached = { file: r.root, rel: '', kind: 'folder' };
  const walked = parts.length ? await walk(r, root, parts, notes) : { reached: [root], partial: false };
  const parent = walked.reached.find(v => v.kind === 'folder');
  // Not found only when it is known not to be there: a way read in part leaves it unknown (said as 일부만 읽음).
  if (!parent) return { folder: { path: folderPath, found: walked.partial }, instances: [], listing: { hidden: [], whole: !walked.partial } };
  const entries: { raw: string; name: string; kind: FolderEntry['kind'] }[] = [];
  const { state } = await listFolder(r, parent.file, entry => {
    if (entry.kind === 'folder' || entry.kind === 'link' || entry.kind === 'unknown') entries.push({ raw: entry.name, name: nfc(entry.name), kind: entry.kind });
  }, { exact: true });
  if (!noted(state, folderPath, notes)) return { folder: { path: folderPath, found: state !== 'gone' }, instances: [], listing: { hidden: [], whole: state === 'gone' } };
  const skip = new Set((def.instanceKey.exclude ?? []).map(nfc)), times = new Map<string, number>();
  const kept = entries.filter(e => !skip.has(e.name)).sort(byName);
  const hidden = entries.filter(e => skip.has(e.name)).map(e => e.name);
  let whole = state === 'listed' && !walked.partial;
  for (const e of kept) times.set(e.name, (times.get(e.name) ?? 0) + 1);
  const found: Instance[] = [];
  for (const e of kept) {
    const id = joinRel(folderPath, e.name);
    if (skipped(e.name)) notes.excluded.set(id, 'hidden');
    else if (times.get(e.name)! > 1) notes.excluded.set(id, 'nfc-collision');
    else if (e.kind === 'link') notes.excluded.set(id, 'link');
    else if (e.kind === 'unknown') { notes.excluded.set(id, 'unknown-kind'); notes.incomplete.add(folderPath); whole = false; }
    else { found.push({ id, file: path.join(parent.file, e.raw), name: e.name, label: instanceLabel(e.name, def.instanceKey.label) }); continue; }
    hidden.push(e.name);
  }
  const most = r.limits.instances ?? WORKFLOW_LIMITS.instances;
  if (found.length > most) { r.hit.add('instances'); notes.incomplete.add(folderPath); hidden.push(...found.slice(most).map(v => v.name)); found.length = most; }
  // Two 건 whose shown names would be one keep their folder names (research/290 1.1).
  // Checked again until none is shared (302-F4): a name put back can meet another 건's stripped one (`01_A` and `01_01_A`).
  // Folder names are unique (NFC collisions are out), so each round puts back at least one and it ends.
  for (;;) {
    const shown = new Map<string, number>();
    for (const v of found) shown.set(v.label, (shown.get(v.label) ?? 0) + 1);
    const shared = found.filter(v => shown.get(v.label)! > 1 && v.label !== v.name);
    if (!shared.length) break;
    for (const v of shared) v.label = v.name;
  }
  return { folder: { path: folderPath, found: true }, instances: found, listing: { hidden: [...new Set(hidden)].sort(), whole } };
}
// ---- REQ-125 U4a: `state-log` (research/309 5판) -----------------------------------------------------------------------
/** What a file's bytes are read from: an open handle, or a test's stand-in. */
export interface ReadsAt { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }
/**
 * research/309 5절 J4: a file of `size` bytes (its open handle's size) read to its end, or null when it was not — fewer bytes
 * than that (cut short) or more (it grew while read). An error is thrown to the caller. Never its first part as if whole.
 */
export async function readWhole(handle: ReadsAt, size: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(size + 1);
  let got = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, got, buffer.length - got, got);
    if (bytesRead <= 0) break;
    got += bytesRead;
    if (got > size) return null;
  }
  return got === size ? buffer.subarray(0, size) : null;
}
type RecordText = { state: 'read'; text: string } | { state: 'missing' } | { state: 'partial' };
/**
 * A record file (research/309 5절): found through `walk` (U0 `listFolder`, `exact` — each part by its NFC name, no link followed),
 * opened through `openConfined` and read whole once. Past `wholeFileBytes` (2 MB) it is not read at all, not even its start
 * (`file-too-large:<path>`); a read cut short, grown, failed or over the byte budget, a link (or a kind not told) on its way, a
 * listing cut short — all "일부만 읽음" (`partial`), never "기록 없음". Not there: `missing`.
 */
async function readRecordFile(r: Reading, rel: string, notes: Notes): Promise<RecordText> {
  const partial = (why?: string): RecordText => { notes.incomplete.add(rel); if (why) r.hit.add(why); return { state: 'partial' }; };
  const parts = rel.split('/'), walked = await walk(r, { file: r.root, rel: '', kind: 'folder' }, parts, notes);
  if (walked.partial) return partial();
  const at = walked.reached.find(v => v.kind === 'file');
  // A link, two names one in NFC or a kind not told on its way or in its place: left out (`excluded`) and read in part.
  if (!at) return parts.some((_, i) => notes.excluded.has(parts.slice(0, i + 1).join('/'))) ? partial() : { state: 'missing' };
  const real = await inside(r, at.file);
  if (real !== at.file) return partial('record-unread:' + rel);
  const handle = await openConfined(real);
  if (!handle) return partial('record-unread:' + rel);
  try {
    const size = (await handle.stat()).size;
    if (size > (r.limits.wholeFileBytes ?? WORKFLOW_LIMITS.wholeFileBytes)) return partial('file-too-large:' + rel);
    if (!spend(r, size)) return partial();
    const bytes = await readWhole(handle, size);
    return bytes ? { state: 'read', text: bytes.toString('utf8') } : partial('record-unread:' + rel);
  } catch { return partial('record-unread:' + rel); } finally { await handle.close().catch(() => undefined); }
}
type LogSource = Extract<WorkflowSource2, { read: 'state-log' }>;
interface LogReading { own: Event[]; shared: Map<string, Event[]>; partial: Set<string>; notes: LogNote[] }
/**
 * The `state-log` rules (research/309 5판 2·5): each record file read once for all of them, so every rule sees the same text;
 * a tag's 건 matched with the rows' final shown names and, for what no row shows, the list before its cap (`listing`). A list not
 * read whole, a file read in part, or a step whose shared evidence passes `eventsPerRule` leaves the step "일부만 읽음".
 */
async function readLog(r: Reading, def: WorkflowDefinition2, instances: Instance[], listing: Listing, notes: Notes, when: Date): Promise<LogReading> {
  const rules = def.sources.filter((s): s is LogSource => s.read === 'state-log');
  const strip = (name: string) => instanceLabel(name, 'strip-number-prefix');
  const names: LogNames = { shown: new Map(instances.map(v => [v.label, v.id])), shownNames: new Set(instances.map(v => v.name)),
    shownStripped: new Set(instances.map(v => strip(v.name))), hidden: new Set(listing.hidden), hiddenStripped: new Set(listing.hidden.map(strip)) };
  const logNotes: LogNote[] = [];
  // A 건 whose shown name has a bracket or passes 40 characters cannot be named in a tag: said, so its empty cells are understood.
  for (const v of instances) if (/[[\]\n]/.test(v.label) || Array.from(v.label).length > 40) logNotes.push({ kind: 'untaggable', path: v.id, name: v.label });
  const files = new Map<string, LogRule[]>();
  for (const s of rules) {
    const words = new Map<string, 'yes' | 'no' | null>();
    if (Array.isArray(s.words)) for (const w of s.words) words.set(nfc(w), null);
    else { for (const w of s.words.yes) words.set(nfc(w), 'yes'); for (const w of s.words.no) words.set(nfc(w), 'no'); }
    for (const f of new Set(s.files.map(nfc))) files.set(f, [...files.get(f) ?? [], { stage: s.stage, section: nfc(s.section), words }]);
  }
  const own: Event[] = [], shared = new Map<string, Event[]>(), partial = new Set<string>();
  // 2.4 끝: with the 건 list read in part, a name no row shows cannot be told apart — every record step is read in part.
  if (!listing.whole) for (const s of rules) partial.add(s.stage);
  const now = kstNow(when);
  for (const [file, fileRules] of [...files].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const got = await readRecordFile(r, file, notes);
    if (got.state === 'partial') { for (const x of fileRules) partial.add(x.stage); continue; }
    if (got.state === 'missing') { for (const section of [...new Set(fileRules.map(x => x.section))].sort()) logNotes.push({ kind: 'no-section', path: file, section, missing: true }); continue; }
    const read = readRecord(file, got.text, fileRules, names, now);
    own.push(...read.own);
    for (const e of read.shared) shared.set(e.stage, [...shared.get(e.stage) ?? [], e]);
    logNotes.push(...read.notes);
  }
  const most = r.limits.eventsPerRule ?? WORKFLOW_LIMITS.eventsPerRule;
  for (const [stage, list] of shared) if (list.length > most) { r.hit.add('events-per-rule:' + stage); partial.add(stage); list.length = most; }
  return { own, shared, partial, notes: logNotes };
}
type ProgramDTO = NonNullable<WorkflowModelDTO['program']>;
/**
 * REQ-125 U3 (research/290 1.2·2.4, 291 F5): the `scope: "program"` rules, read once from the workspace folder with the same
 * walk as a 건 rule's (U0 `listFolder`, `exact`). What one finds inside a 건 folder — a folder holding data, a file that fits —
 * is neither the program's nor that 건's: it goes into `conflicts` and `excluded` (`rule-conflict`), so a common document copied
 * into a 건 shows once, as common. Inside a 건 folder is decided by path parts, never by text: the part right under the 건 folder
 * names a 건 unless it is excluded by name or hidden (`.`, `@`, `#` — those are no 건) — so `A` is not `AB`, and a 건 past the
 * `instances` cap or one whose folder could not be listed whole is still a 건. A cell: read in part > data > only files whose
 * version could not be read (형식 모름) > 기록 없음. Null when the file has no program rule.
 */
/**
 * 311-F2 (research/290 1.2·2.4): what the common rules took as 규칙 충돌 — a folder holding data inside a 건 (its data files right
 * inside it, never its subfolders) and a file that fits inside a 건 (that file only). No 건 rule of any step may count it.
 */
interface Taken { folders: Set<string>; files: Set<string> }
const isTaken = (taken: Taken, rel: string) => taken.files.has(rel) || (taken.folders.has(path.posix.dirname(rel)) && dataFile(path.posix.basename(rel)));
async function readProgram(r: Reading, def: WorkflowDefinition2, folderPath: string, notes: Notes, unknownFormat: { stage: string; path: string }[]): Promise<{ program: ProgramDTO | null; taken: Taken }> {
  const rules = def.sources.filter((s): s is Exclude<WorkflowSource2, LogSource> => s.read !== 'state-log' && s.scope === 'program'), taken: Taken = { folders: new Set(), files: new Set() };
  if (!rules.length) return { program: null, taken };
  const prefix = folderPath ? folderPath + '/' : '', skip = new Set((def.instanceKey.exclude ?? []).map(nfc));
  // The 건 whose folder holds `rel` (a folder: the 건 folder itself too; a file right in the 건 folder's parent is no 건's).
  const owner = (rel: string, file = false): string | null => {
    if (!rel.startsWith(prefix)) return null;
    const parts = rel.slice(prefix.length).split('/'), name = parts[0]!;
    return name && parts.length > (file ? 1 : 0) && !skip.has(name) && !skipped(name) ? prefix + name : null;
  };
  const root: Reached = { file: r.root, rel: '', kind: 'folder' };
  const events: Event[] = [], partial = new Set<string>(), conflicts: ProgramDTO['conflicts'] = [];
  const conflict = (stage: string, rel: string) => {
    if (!conflicts.some(c => c.stage === stage && c.path === rel)) conflicts.push({ stage, path: rel });
    if (!notes.excluded.has(rel)) notes.excluded.set(rel, 'rule-conflict');
  };
  for (const src of rules) {
    if (src.read === 'file-versions') {
      const read = await readVersions(r, src, { id: '', file: r.root }, notes, rel => owner(rel, true));
      events.push(...read.events);
      for (const rel of read.unread) if (!unknownFormat.some(u => u.path === rel)) unknownFormat.push({ stage: src.stage, path: rel });
      for (const rel of read.conflicts) { conflict(src.stage, rel); taken.files.add(rel); }
      if (read.partial) partial.add(src.stage);
      continue;
    }
    const reached = new Map<string, Reached>(), most = r.limits.eventsPerRule ?? WORKFLOW_LIMITS.eventsPerRule;
    let kept = 0;
    for (const pattern of src.files) {
      const walked = await walk(r, root, pattern.split('/'), notes);
      if (walked.partial) partial.add(src.stage);
      for (const v of walked.reached) if (!reached.has(v.rel)) reached.set(v.rel, v);
    }
    for (const at of [...reached.values()].sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)) {
      if (at.kind !== 'folder') continue;
      const data = await dataIn(r, at, notes), inside = owner(at.rel) !== null;
      // A folder inside a 건 never counts for the program, so how much of it was read does not change the program's cell.
      if (data.partial && !inside) partial.add(src.stage);
      if (!data.files) continue;
      if (inside) { conflict(src.stage, at.rel); taken.folders.add(at.rel); continue; }
      // 311-F1 (research/290 2.10): a rule's events stop at `eventsPerRule` and its cell is read in part — the folders after it are
      // still looked at for 규칙 충돌, so a copy past the cap is never left for a 건 rule to take.
      if (kept >= most) { r.hit.add('events-per-rule:' + src.stage); partial.add(src.stage); continue; }
      kept++;
      const day = folderDate(path.basename(at.file));
      events.push({ stage: src.stage, kind: 'folder', release: null, releaseFrom: null, path: at.rel, files: data.files, ...(day ? { time: day } : {}) });
    }
  }
  const stages = def.stages.filter(s => rules.some(x => x.stage === s.id));
  const cells = stages.map(stage => {
    const list = events.filter(e => e.stage === stage.id);
    const state: CellState = partial.has(stage.id) ? 'incomplete' : list.some(holds) ? 'found' : list.length ? 'unknown-format' : 'no-record';
    return { stage: stage.id, state, events: list };
  });
  conflicts.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0);
  return { program: { cells, conflicts }, taken };
}
/**
 * One reading of a `/2` file: its 건 as rows (`releases`, `unit: 'instance'`), each step's cell from its `folder` rules —
 * "자료 있음" (`found`) with the folders that hold data, "일부만 읽음" (`incomplete`) where a folder could not be read whole
 * and nothing was found, else "기록 없음". A decision (◇) takes no rule in this format, so it stays out of the table, and the
 * way of a 건 never passes one. Rows: the latest date read (a folder name's `_YYYYMMDD`, a version's day) first, then those
 * without one, by name. U2: a `file-versions` rule's cell holds its versions (`readVersions`); one with only files whose
 * version could not be read is "형식 모름" (`unknown-format`), and those files are listed in `unknownFormat` too.
 */
async function readInstances(def: WorkflowDefinition2, root: string, limits: Limits, now: (() => Date) | undefined, started: number): Promise<WorkflowModelDTO> {
  const r = newReading(root, limits), notes: Notes = { excluded: new Map(), incomplete: new Set() };
  const { folder, instances, listing } = await listInstances(r, def, notes);
  const events: Event[] = [], partialCells = new Set<string>(), unknownFormat: { stage: string; path: string }[] = [];
  const { program, taken } = await readProgram(r, def, folder.path, notes, unknownFormat);
  // U4a: the record rules' steps — read once from their files, apart from the 건 loop (research/309 8.1).
  const logStages = new Set(def.sources.filter(s => s.read === 'state-log').map(s => s.stage)), when = logStages.size ? now?.() ?? new Date() : null;
  const log = when ? await readLog(r, def, instances, listing, notes, when) : null;
  // 311-F2: what a common rule took as 규칙 충돌 is no 건's data in any step — held out, and said in the cell (`conflicts`).
  const held = new Map<string, string[]>(), hold = (inst: string, stage: string, rels: string[]) => {
    if (!rels.length) return;
    const list = held.get(inst + '\0' + stage) ?? [];
    for (const rel of rels) if (!list.includes(rel)) list.push(rel);
    held.set(inst + '\0' + stage, list.sort());
  };
  for (const src of def.sources) for (const inst of instances) {
    if (src.read === 'state-log' || src.scope === 'program') continue;
    if (src.read === 'file-versions') {
      const read = await readVersions(r, src, inst, notes, rel => isTaken(taken, rel) ? rel : null);
      hold(inst.id, src.stage, read.conflicts);
      events.push(...read.events);
      // One file once in the list (the first step that read it), though each step's cell says 형식 모름 — the heading counts files.
      for (const rel of read.unread) if (!unknownFormat.some(u => u.path === rel)) unknownFormat.push({ stage: src.stage, path: rel });
      if (read.partial) partialCells.add(inst.id + '\0' + src.stage);
      continue;
    }
    const home: Reached = { file: inst.file, rel: inst.id, kind: 'folder' }, reached = new Map<string, Reached>();
    let partial = false;
    for (const pattern of src.files) {
      const rest = pattern.split('/').slice(1);
      if (!rest.length) { reached.set(home.rel, home); continue; }
      const walked = await walk(r, home, rest, notes);
      partial ||= walked.partial;
      for (const v of walked.reached) if (!reached.has(v.rel)) reached.set(v.rel, v);
    }
    for (const at of [...reached.values()].sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)) {
      if (at.kind !== 'folder') continue;
      const data = await dataIn(r, at, notes, rel => isTaken(taken, rel));
      partial ||= data.partial;
      hold(inst.id, src.stage, data.held);
      if (!data.files) continue;
      const day = folderDate(path.basename(at.file));
      events.push({ stage: src.stage, kind: 'folder', release: inst.id, releaseFrom: null, path: at.rel, files: data.files, ...(day ? { time: day } : {}) });
    }
    if (partial) partialCells.add(inst.id + '\0' + src.stage);
  }
  // U3: a program step is in no row and no column — the "공통" band says it once (`program`).
  const common = new Set(program?.cells.map(c => c.stage) ?? []);
  const ruled = new Set(def.sources.filter(s => !('scope' in s) || s.scope !== 'program').map(s => s.stage));
  // U4a: a record's confirmed day counts among the dates read (ambiguous evidence says nothing happened then).
  const dated = log ? [...events, ...log.own.filter(e => e.strength === 'confirmed')] : events;
  const latest = new Map(instances.map(v => [v.id, dated.filter(e => e.release === v.id && e.time).map(e => e.time!).sort().at(-1) ?? '']));
  // U4a: evidence standing in every 건 is kept once (`logShared`); a cell counts its step's and marks which were earlier.
  const most = r.limits.eventsPerRule ?? WORKFLOW_LIMITS.eventsPerRule, logShared: Event[] = [], sharedAt = new Map<string, number>();
  for (const stage of def.stages) { const list = log?.shared.get(stage.id); if (list?.length) { sharedAt.set(stage.id, logShared.length); logShared.push(...list); } }
  /**
   * A record step's cell (research/309 3.2·5절): read in part first (a file, the 건 list, the step's evidence past `eventsPerRule`
   * counting the shared), then `decide` — no evidence: 기록 없음; no confirmed piece, two latest answers, or any piece standing
   * against the latest: 모호; else 확인됨 (a decision with its answer).
   */
  const logCell = (stage: string, inst: Instance) => {
    const shared = log!.shared.get(stage) ?? [], offset = sharedAt.get(stage) ?? 0;
    let own = log!.own.filter(e => e.release === inst.id && e.stage === stage), state: CellState, answer: 'yes' | 'no' | undefined, earlierShared: number[] = [];
    if (own.length + shared.length > most) { r.hit.add('events-per-rule:' + stage); own = own.slice(0, Math.max(0, most - shared.length)); state = 'incomplete'; }
    else if (log!.partial.has(stage)) state = 'incomplete';
    else {
      const decided = decide([...own, ...shared].map(e => ({ strength: e.strength!, answer: e.answer, time: logTime(e.time) })));
      const earlier = new Set(decided.earlier);
      state = decided.state; answer = decided.answer;
      own = own.map((e, i) => earlier.has(i) ? { ...e, earlier: true as const } : e);
      earlierShared = shared.flatMap((_, k) => earlier.has(own.length + k) ? [offset + k] : []);
    }
    return { stage, state, events: own, ...(answer ? { answer } : {}), shared: shared.length, ...(earlierShared.length ? { earlierShared } : {}) };
  };
  // The way and a step's figure (research/309 4.1·4.2): a record step — a decision too (U4b) — only when its cell is confirmed.
  const counts = (stage: WorkflowDefinition2['stages'][number], cell: { state: CellState; events: Event[] }) =>
    logStages.has(stage.id) ? cell.state === 'found' : cell.events.some(holds);
  const ordered = [...instances].sort((a, b) => (latest.get(b.id)! > latest.get(a.id)! ? 1 : latest.get(b.id)! < latest.get(a.id)! ? -1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const releases: WorkflowReleaseDTO[] = ordered.map(inst => {
    const cells = def.stages.filter(stage => !common.has(stage.id)).map(stage => {
      if (logStages.has(stage.id)) return logCell(stage.id, inst);
      const list = events.filter(e => e.stage === stage.id && e.release === inst.id);
      const state: CellState = !ruled.has(stage.id) ? (stage.shape === 'diamond' ? 'decision' : 'no-source')
        // Read in part comes first (302-F2): what was found is kept as evidence, but the cell never claims it read all.
        // U2: files that fit a document's name but read no version say "형식 모름" — never a version, never "기록 없음".
        : partialCells.has(inst.id + '\0' + stage.id) ? 'incomplete' : list.some(holds) ? 'found' : list.length ? 'unknown-format' : 'no-record';
      const withheld = held.get(inst.id + '\0' + stage.id);
      return { stage: stage.id, state, events: list, ...(withheld ? { conflicts: withheld } : {}) };
    });
    // The way and a step's figure: the steps where data was found, read whole or in part (a file whose version could not be read is not).
    // U3: a program step with data is on every 건's way — it is every 건's step (research/290 2.4).
    // U4b (research/309 4.2): a decision whose record cell is confirmed is on the way too — never one read from the steps around it.
    const way = def.stages.filter(s => counts(s, [...cells, ...program?.cells ?? []].find(c => c.stage === s.id)!)).sort((a, b) => a.col - b.col || a.row - b.row);
    // U4b (4.3): where the 건 ended, weighed over its own cells (the common band's aside) with every record piece that counts in them.
    const tag = log ? endTag(def.stages, def.edges, cells.map(c => ({ stage: c.stage, state: c.state, answer: 'answer' in c ? c.answer : undefined, log: logStages.has(c.stage),
      events: [...c.events, ...logStages.has(c.stage) ? log.shared.get(c.stage) ?? [] : []] }))) : undefined;
    return { release: inst.id, label: inst.label, reqs: [], firstVerdict: null, finalVerdict: null, regates: 0, cells,
      path: way.map(s => ({ stage: s.id })), warnings: [], ...(tag ? { endTag: tag } : {}) };
  });
  // A step's figure: how many 건 hold data for it.
  const totals: WorkflowModelDTO['totals'] = def.stages.filter(s => ruled.has(s.id)).map(s => {
    const t = { ...emptyTally(), count: releases.filter(v => v.cells.some(c => c.stage === s.id && counts(s, c))).length };
    return { stage: s.id, window: t, all: { ...t } };
  });
  const excluded = [...notes.excluded].map(([p, why]) => ({ path: p, why })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  unknownFormat.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0);
  const body = { releases, reports: [] as Event[], unknownFormat, missing: [], git: { state: 'unused' as const, commits: 0 }, limits: [...r.hit].sort(),
    unit: 'instance' as const, instanceFolder: folder, excluded, incomplete: [...notes.incomplete].sort(), ...(program ? { program } : {}),
    ...(log ? { logShared, logNotes: log.notes } : {}) };
  return {
    defined: true, definitionPath: WORKFLOW_DEFINITION_PATH, key: key([def, body]), readAt: (when ?? now?.() ?? new Date()).toISOString(),
    definition: { name: def.name, ...(def.note ? { note: def.note } : {}), releaseWindow: r.limits.instances ?? WORKFLOW_LIMITS.instances,
      stages: def.stages, edges: def.edges },
    totals, ...body, cost: { files: r.files, bytes: r.bytes, ms: Math.round(performance.now() - started) },
  };
}

/**
 * 317-F1: a reading checked against the reply's own schema (`workflowGet.output`) before it leaves the server. One that does not
 * fit (a length past a limit, whatever the cause) never goes out to be refused on the screen — where the last good reading, with
 * its confirmed answers, would stay up unsaid — but as "could not be read" with the first problems, which replaces what was shown.
 */
export function replyable(value: WorkflowDTO): WorkflowDTO {
  const checked = workflowDataSchema.safeParse(value);
  if (checked.success) return value;
  return { defined: false, reason: 'unreadable', definitionPath: value.definitionPath.slice(0, 200),
    problems: checked.error.issues.slice(0, 3).map(i => `reply: ${i.path.join('.') || '(reading)'}: ${i.message}`.slice(0, 200)) };
}
/**
 * The 60 s cache over `readWorkflow`, per folder and window; two asks at once share one reading. `reads` counts readings
 * (tests). `defined(cwd)` is the cheap check a lane's button needs — one stat of the definition file, cached alike.
 */
export function createWorkflowReader({ now = () => Date.now(), read = readWorkflow, ttlMs = WORKFLOW_CACHE_MS, size = 32 }: {
  now?: () => number; read?: (cwd: string, options: { window?: number; pick?: WorkflowPickOption }) => Promise<WorkflowDTO>; ttlMs?: number; size?: number } = {}) {
  const cache = new Map<string, { at: number; value: Promise<WorkflowDTO> }>();
  const probes = new Map<string, { at: number; value: Promise<boolean> }>();
  let reads = 0;
  const remember = <T>(map: Map<string, { at: number; value: Promise<T> }>, id: string, make: () => Promise<T>) => {
    const time = now(), hit = map.get(id);
    if (hit && time - hit.at < ttlMs) return hit.value;
    const value = make();
    map.delete(id); map.set(id, { at: time, value });
    while (map.size > size) map.delete(map.keys().next().value!);
    return value;
  };
  return {
    // REQ-125: the pick and its language are part of the key, so a lane shows a new pick (or none) at once.
    read: (cwd: string, window?: number, pick?: WorkflowPickOption): Promise<WorkflowDTO> => remember(cache,
      `${cwd}\0${window ?? ''}\0${pick ? pick.template + '\0' + pick.locale : ''}`, () => {
      reads++;
      return read(cwd, { ...(window === undefined ? {} : { window }), ...(pick ? { pick } : {}) }).then(replyable)
        .catch((): WorkflowDTO => ({ defined: false, reason: 'unreadable', definitionPath: WORKFLOW_DEFINITION_PATH }));
    }),
    defined: (cwd: string): Promise<boolean> => remember(probes, cwd, async () => {
      // A definition that resolves outside the workspace gets no button: it is never stat'ed, as the reading refuses it.
      const found = await locateDefinition(cwd);
      return 'real' in found && fs.stat(found.real).then(s => s.isFile(), () => false);
    }),
    /** REQ-125 2단계: a folder's readings and button check dropped, so a file just written wins at once, not a minute later. */
    forget: (cwd: string) => {
      probes.delete(cwd);
      for (const id of [...cache.keys()]) if (id.startsWith(cwd + '\0')) cache.delete(id);
    },
    reads: () => reads,
  };
}
export type WorkflowReader = ReturnType<typeof createWorkflowReader>;
