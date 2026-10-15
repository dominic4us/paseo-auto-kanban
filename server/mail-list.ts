import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { MAIL_HEAD_BYTES, nfc } from '../shared/mailbox.js';
import { isMailBoundary, mailRoot, mailThreadFolder, realMailFsIo, type MailFsIo } from './mail-fs.js';
import { mailFileHead, mailFileName, mailFileParts, mailNewestOnes, mailSubject, type MailFileDTO, type MailListDTO, type MailListThreadDTO,
  type MailThreadDTO } from '../shared/mail-list.js';

/**
 * REQ-128: the lab's message list reads the whole message folder here, on the server only. It only reads — folder listings
 * and each file's first `MAIL_HEAD_BYTES`; nothing is ever written, renamed or created.
 *
 * - Boundary: the folder set in the lab (its real path) is the root. A thread is a real sub-folder of it and a message a
 *   regular `.md` file in a thread: a symbolic link (folder or file) is never followed, a name starting with `.`, `@` or `#`
 *   is skipped, and every path is checked to lie under the root's real path before it is listed or read (as REQ-124's
 *   `confine`). A thread asked for by name (`readMailThread`) must be such a sub-folder — `..`, a separator or a link is "missing".
 * - Caps (`MAIL_LIST_LIMITS`): threads, files listed per thread, files read per reading. A reached cap is said in `limits`.
 * - Per thread, the list reads the newest file (last by name), any file sharing its time, and the first file (the subject).
 * - research/236 D3, research/240 D1: every listing and file read goes through server/mail-fs.ts, as the lanes' badge does.
 *   A thread where something was found swapped for a link (`MailBoundaryError`) is left out; nothing of it is read.
 * - research/242 D1: a thread the lanes' badge left out so in the same request (`skip`) is left out here too, unread — a link
 *   it found in a file's place is, by now, merely a listed link and would no longer tell. One found here is said (`found`).
 *
 * `createMailListReader` keeps one reading for 60 s (`MAIL_CACHE_MS`, as the lanes' badge), and one per thread — and only
 * while the folder's fingerprint (REQ-90's `key`, server/mailbox.ts) is the one it was read under (research/236 D1).
 */
export const MAIL_LIST_LIMITS = { threads: 1000, filesPerThread: 500, reads: 3000, detailFiles: 100, detailHeads: 4 };
type Limits = typeof MAIL_LIST_LIMITS;
const skipped = (name: string) => /^[.@#]/.test(name);
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const byName = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** The reading's way in is server/mail-fs.ts, shared with the lanes' badge (research/240 D1). */
export type MailListIo = MailFsIo;
export const realMailListIo: MailListIo = realMailFsIo;
/** research/242 D1: the threads (NFC names) left out at the boundary by the badge's reading, and who hears of one found here. */
export interface MailBoundary { skip?: ReadonlySet<string>; found?: (thread: string) => void }
/** A thread's message files (`.md`, real files, not hidden), sorted by name, the newest last. */
async function messageFiles(folder: string, io: MailListIo): Promise<string[]> {
  return (await io.list(folder)).filter(e => e.file && !skipped(e.name) && nfc(e.name).endsWith('.md')).map(e => e.name).sort(byName);
}
const fileOf = (raw: string, text: string | null): MailFileDTO => ({ name: nfc(raw), ...mailFileName(raw),
  ...(text === null ? { title: null, to: null, due: null } : mailFileHead(text)) });

/** One reading of the folder: every thread, its newest file(s) and subject. Nothing written. */
export async function readMailList(dir: string, io: MailListIo = realMailListIo, limits: Limits = MAIL_LIST_LIMITS, now = () => new Date(),
  boundary: MailBoundary = {}): Promise<MailListDTO> {
  const readAt = now().toISOString();
  const root = await mailRoot(dir, io);
  const unreadable = (): MailListDTO => ({ state: 'unreadable', root: dir, key: key(['unreadable', dir]), threads: [], limits: [], readAt });
  if (!root) return unreadable();
  let entries: Awaited<ReturnType<MailListIo['list']>>;
  try { entries = await io.list(root.real); } catch { return unreadable(); }
  const hit = new Set<MailListDTO['limits'][number]>();
  let folders = entries.filter(e => e.directory && !skipped(e.name)).map(e => e.name).sort(byName);
  if (folders.length > limits.threads) { hit.add('threads'); folders = folders.slice(-limits.threads); }
  let reads = 0;
  // A head that cannot be read is null; one found swapped for a link throws, and its thread is left out.
  const head = async (file: string): Promise<string | null> => {
    if (reads >= limits.reads) { hit.add('reads'); return null; }
    reads++;
    try { return (await io.head(file, MAIL_HEAD_BYTES)).text; } catch (error) { if (isMailBoundary(error)) throw error; return null; }
  };
  const threads: MailListThreadDTO[] = [];
  // Newest threads first, so a reached read cap leaves the oldest unread rather than the newest.
  for (const raw of [...folders].reverse()) {
    const id = nfc(raw);
    if (boundary.skip?.has(id)) continue;
    const folder = await mailThreadFolder(root, raw, io);
    if (!folder) continue;
    let names: string[];
    try { names = await messageFiles(folder, io); } catch (error) { if (isMailBoundary(error)) boundary.found?.(id); continue; }
    const count = names.length;
    if (names.length > limits.filesPerThread) { hit.add('files'); names = [names[0]!, ...names.slice(-(limits.filesPerThread - 1))]; }
    const latest: MailFileDTO[] = [];
    let first: MailFileDTO | null;
    try {
      for (const name of mailNewestOnes(names)) latest.push(fileOf(name, await head(path.join(folder, name))));
      const firstName = names[0];
      first = firstName === undefined ? null : latest.find(f => f.name === nfc(firstName))
        ?? fileOf(firstName, await head(path.join(folder, firstName)));
    } catch (error) { if (isMailBoundary(error)) boundary.found?.(id); continue; }
    threads.push({ id, subject: mailSubject(first?.title ?? null, id), files: count, latest });
  }
  threads.reverse();
  const limitsHit = [...hit];
  return { state: 'ready', root: dir, key: key([dir, threads, limitsHit]), threads, limits: limitsHit, readAt };
}

/** One thread by its id: every file's head line (up to `detailFiles`, newest first), the newest ones' head and excerpt. */
export async function readMailThread(dir: string, id: string, io: MailListIo = realMailListIo, limits: Limits = MAIL_LIST_LIMITS,
  boundary: MailBoundary = {}): Promise<MailThreadDTO> {
  const missing: MailThreadDTO = { state: 'missing', id, files: [], latest: 0, more: 0 };
  if (!id || id === '.' || id === '..' || /[\\/\0]/.test(id) || skipped(id) || boundary.skip?.has(nfc(id))) return missing;
  const root = await mailRoot(dir, io);
  if (!root) return missing;
  let entries: Awaited<ReturnType<MailListIo['list']>>;
  try { entries = await io.list(root.real); } catch { return missing; }
  // The name must be one the root lists as a real folder (its NFC spelling may differ on disk).
  const raw = entries.find(e => e.directory && !skipped(e.name) && nfc(e.name) === nfc(id))?.name;
  const folder = raw === undefined ? null : await mailThreadFolder(root, raw, io);
  if (!folder) return missing;
  let names: string[];
  try { names = await messageFiles(folder, io); } catch (error) { if (isMailBoundary(error)) boundary.found?.(nfc(raw!)); return missing; }
  const newest = new Set(mailNewestOnes(names)), shown = [...names].reverse().slice(0, limits.detailFiles);
  const files: MailThreadDTO['files'] = [];
  let reads = 0;
  for (const name of shown) {
    let text: string | null = null;
    if (reads < limits.detailFiles) {
      reads++;
      try { text = (await io.head(path.join(folder, name), MAIL_HEAD_BYTES)).text; } catch (error) { if (isMailBoundary(error)) { boundary.found?.(nfc(raw!)); return missing; } text = null; }
    }
    const file = fileOf(name, text);
    files.push(newest.has(name) && files.length < limits.detailHeads && text !== null ? { ...file, ...mailFileParts(text) } : file);
  }
  return { state: 'ready', id: nfc(raw!), path: path.join(dir, raw!), files, latest: Math.min(newest.size, files.length), more: names.length - shown.length };
}

export const MAIL_LIST_CACHE_MS = 60_000;
/**
 * The 60 s cache over both readings, per folder (and per thread), bound to the folder's fingerprint (`mark`, REQ-90's `key`):
 * a reading made under another fingerprint is never given back, so the list moves the moment the lanes' badge does
 * (research/236 D1). The list says the fingerprint it answers (`source`). `reads` counts the folder readings (tests).
 * research/242 D1: the threads that reading left out at the boundary (`boundary.skip`) are bound to it as well.
 */
export function createMailListReader({ now = () => Date.now(), list = (dir: string, boundary: MailBoundary) => readMailList(dir, realMailListIo, MAIL_LIST_LIMITS, undefined, boundary),
  thread = (dir: string, id: string, boundary: MailBoundary) => readMailThread(dir, id, realMailListIo, MAIL_LIST_LIMITS, boundary), ttlMs = MAIL_LIST_CACHE_MS }: {
  now?: () => number; list?: (dir: string, boundary: MailBoundary) => Promise<MailListDTO>;
  thread?: (dir: string, id: string, boundary: MailBoundary) => Promise<MailThreadDTO>; ttlMs?: number } = {}) {
  const bound = (mark: string, boundary: MailBoundary) => boundary.skip?.size ? mark + '\0' + [...boundary.skip].sort(byName).join('\0') : mark;
  let cached: { dir: string; mark: string; at: number; value: Promise<MailListDTO> } | null = null, reads = 0;
  const threads = new Map<string, { at: number; value: Promise<MailThreadDTO> }>();
  return {
    list: (dir: string, mark = '', boundary: MailBoundary = {}): Promise<MailListDTO> => {
      const time = now(), under = bound(mark, boundary);
      if (cached && cached.dir === dir && cached.mark === under && time - cached.at < ttlMs) return cached.value;
      reads++;
      const source = mark ? { source: mark } : {};
      const value = list(dir, boundary).then(v => ({ ...v, ...source }), (): MailListDTO => ({ state: 'unreadable', root: dir, key: key(['unreadable', dir]), threads: [], limits: [],
        readAt: new Date(time).toISOString(), ...source }));
      cached = { dir, mark: under, at: time, value };
      return value;
    },
    thread: (dir: string, id: string, mark = '', boundary: MailBoundary = {}): Promise<MailThreadDTO> => {
      const time = now(), at = dir + '\0' + id + '\0' + bound(mark, boundary), hit = threads.get(at);
      if (hit && time - hit.at < ttlMs) return hit.value;
      for (const [k, v] of threads) if (time - v.at >= ttlMs) threads.delete(k);
      if (threads.size >= 200) threads.clear();
      const value = thread(dir, id, boundary).catch((): MailThreadDTO => ({ state: 'missing', id, files: [], latest: 0, more: 0 }));
      threads.set(at, { at: time, value });
      return value;
    },
    reads: () => reads,
  };
}
export type MailListReader = ReturnType<typeof createMailListReader>;
