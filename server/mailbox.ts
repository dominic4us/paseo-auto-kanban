import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { MailDTO } from '../shared/rpc.js';
import { MAIL_HEAD_BYTES, nfc } from '../shared/mailbox.js';
import { mailFileHead, mailFileName, mailNewestOnes, mailStatus, type MailFileDTO, type MailStatus } from '../shared/mail-list.js';
import { isMailBoundary, mailRoot, mailThreadFolder, realMailFsIo, type MailFsIo } from './mail-fs.js';

/**
 * REQ-90: the lab's "messages waiting" badge reads the message folder here, on the server only (a screen cannot read files).
 * It only reads: folder listings and the first `MAIL_HEAD_BYTES` of each thread's newest files. Nothing is written.
 *
 * - A thread is a sub-folder; names starting with `.`, `@` or `#` (hidden, a NAS's `@eaDir`, `#recycle`) are skipped.
 * - Its newest files are the last `.md` by name and any sharing its time. Whose turn it is is REQ-128's own verdict
 *   (`mailStatus`), so the lanes and the message list never disagree (research/236 D2): a close among them is over, not
 *   counted; each recipient they name is one entry; when none is named and a head has no `받는 곳:` line the thread is
 *   `unknown` ("형식 모름"), never counted for a lane.
 * - `key` fingerprints every thread, closed ones too: its message count, first file, and its newest files' names, sizes and
 *   modification times — a file added at the newest time moves it. The message list's cache is bound to it (server/mail-list.ts,
 *   research/236 D1).
 * - A folder that cannot be read reads as nothing, with `error`.
 * - research/240 D1: every listing and file read goes through server/mail-fs.ts, as the message list does — the root by its
 *   real path, a thread a real sub-folder, a file read only once opened and found to be that very regular file. A thread
 *   where something was found swapped for a link is left out of the threads, the unknown and the fingerprint; nothing of
 *   it is read. A file's size and time come from the opened file itself.
 * - research/242 D1: the threads so left out go with the reading (`mailExcluded`), so the message list and a thread asked in
 *   the same request leave them out too (server/handlers.ts); one the list finds so is taken off the kept reading
 *   (`mailWithout`, the reader's `exclude`). A link already there when a thread is listed is merely not a message — skipped,
 *   as an empty folder is merely empty; only one found in a file's or folder's place after the listing leaves the thread out.
 *
 * `createMailReader` keeps one reading for `MAIL_CACHE_MS` (60 s): the screens' auto refresh asks every 4 s, the folder is
 * read at most once a minute. The handlers ask only while a host's lab badge is on and a folder is set — otherwise never.
 */
export const MAIL_CACHE_MS = 60_000;
export const MAIL_THREAD_LIMIT = 1000;
const skipped = (name: string) => /^[.@#]/.test(name);
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const unreadable = (): MailDTO => ({ key: key('unreadable'), threads: [], unknown: [], error: 'unreadable' });

export type MailIo = MailFsIo;
const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** One reading of the folder: the open threads with their recipients, those we cannot read the recipient of, and the fingerprint. */
export async function readMailbox(dir: string, io: MailIo = realMailFsIo): Promise<MailDTO> {
  const root = await mailRoot(dir, io);
  if (!root) return unreadable();
  let entries: Awaited<ReturnType<MailIo['list']>>;
  try { entries = await io.list(root.real); } catch { return unreadable(); }
  const folders = entries.filter(e => e.directory && !skipped(e.name)).sort(byName).slice(-MAIL_THREAD_LIMIT);
  const now = Date.now(), excluded = new Set<string>();
  const read = await Promise.all(folders.map(async (folder): Promise<MailItem | null> => {
    const at = path.join(dir, folder.name), thread = nfc(folder.name);
    try {
      const real = await mailThreadFolder(root, folder.name, io);
      if (!real) return null;
      const names = (await io.list(real)).filter(e => e.file && !skipped(e.name) && nfc(e.name).endsWith('.md')).sort(byName).map(e => e.name);
      const files = await Promise.all(mailNewestOnes(names).map(async name => {
        let head: Awaited<ReturnType<MailIo['head']>> | null;
        try { head = await io.head(path.join(real, name), MAIL_HEAD_BYTES); } catch (error) { if (isMailBoundary(error)) throw error; head = null; }
        const dto: MailFileDTO = { name: nfc(name), ...mailFileName(name), ...(head === null ? { title: null, to: null, due: null } : mailFileHead(head.text)) };
        return { file: path.join(at, name), dto, mark: [dto.name, head?.size ?? null, head?.mtimeMs ?? null] };
      }));
      const mark = [thread, names.length, names[0] === undefined ? null : nfc(names[0]), files.map(f => f.mark)];
      const status = files.length ? mailStatus({ id: thread, subject: thread, files: names.length, latest: files.map(f => f.dto) }, now, []) : null;
      return { thread, at, mark, status, files };
    } catch (error) {
      if (isMailBoundary(error)) { excluded.add(thread); return null; }
      return { thread, at, mark: [thread, 'unreadable'], status: undefined, files: [] };
    }
  })).then(all => all.filter(item => item !== null));
  return summarize(read, excluded);
}
type MailItem = { thread: string; at: string; mark: unknown[]; status: MailStatus | null | undefined; files: { file: string; dto: MailFileDTO }[] };
/** A reading's threads as read and those it left out at the boundary — kept by the reading's own object, on the server only. */
const readings = new WeakMap<MailDTO, { items: MailItem[]; excluded: ReadonlySet<string> }>();
const none: ReadonlySet<string> = new Set();
function summarize(items: MailItem[], excluded: ReadonlySet<string>): MailDTO {
  const threads: MailDTO['threads'] = [], unknown: MailDTO['unknown'] = [];
  for (const item of items) {
    if (item.status === undefined) { unknown.push({ thread: item.thread, file: item.at }); continue; }
    if (!item.status || item.status.state === 'closed') continue;
    // Each recipient once, with the newest file naming it.
    for (const to of item.status.to) threads.push({ thread: item.thread, file: (item.files.find(f => f.dto.to === to) ?? item.files[0]!).file, to });
    if (!item.status.to.length && item.status.unknown) unknown.push({ thread: item.thread, file: item.files[0]!.file });
  }
  const dto: MailDTO = { key: key(items.map(item => item.mark)), threads, unknown };
  readings.set(dto, { items, excluded });
  return dto;
}
/** research/242 D1: the threads (by their NFC names) a reading left out at the boundary; none for a reading not made here. */
export const mailExcluded = (dto: MailDTO): ReadonlySet<string> => readings.get(dto)?.excluded ?? none;
/** research/242 D1: the same reading with these threads left out too — of the threads, the unknown and the fingerprint. */
export function mailWithout(dto: MailDTO, threads: Iterable<string>): MailDTO {
  const reading = readings.get(dto);
  if (!reading) return dto;
  const excluded = new Set([...reading.excluded, ...threads]);
  return excluded.size === reading.excluded.size ? dto : summarize(reading.items.filter(item => !excluded.has(item.thread)), excluded);
}


/** The 60 s cache over `readMailbox`, per folder. Two asks at once share one reading. `reads` counts the readings (tests). */
export function createMailReader({ now = () => Date.now(), read = (dir: string) => readMailbox(dir), ttlMs = MAIL_CACHE_MS }: {
  now?: () => number; read?: (dir: string) => Promise<MailDTO>; ttlMs?: number } = {}) {
  let cached: { dir: string; at: number; value: Promise<MailDTO> } | null = null, reads = 0;
  return {
    read: (dir: string): Promise<MailDTO> => {
      const time = now();
      if (cached && cached.dir === dir && time - cached.at < ttlMs) return cached.value;
      reads++;
      const value = read(dir).catch(() => unreadable());
      cached = { dir, at: time, value };
      return value;
    },
    /**
     * research/242 D1: threads the message list or a thread found swapped at the boundary leave the kept reading too — the
     * badge and the fingerprint move, and the list asked again leaves them out. The reading keeps its time.
     */
    exclude: (dir: string, threads: readonly string[]) => {
      if (cached && cached.dir === dir && threads.length) cached.value = cached.value.then(dto => mailWithout(dto, threads));
    },
    reads: () => reads,
  };
}
export type MailReader = ReturnType<typeof createMailReader>;
