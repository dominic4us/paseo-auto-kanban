import { z } from 'zod';
import { MAIL_CLOSE_SUFFIX, nfc } from './mailbox.js';

/**
 * REQ-128: the lab's message list — every thread of the message folder in one place, read only. The server reads the
 * folder (server/mail-list.ts); this file holds what both sides share: the shapes, and the protocol's verdicts, pure.
 *
 * The protocol (the orchestrator skill's chapter 10, read here as it is):
 * - A thread is a sub-folder; its files are `<YYYYMMDD-HHMM>_<from>_<kind>.md` (KST), one per message, never edited.
 * - Whose turn: the newest file's `받는 곳:` line. A thread whose newest file is `…_종결.md` is over.
 * - When two files share the newest time, both are read: each says who it waits for.
 * - A recipient written `<person> (기록: <short name>)` waits for a person's decision; `<short name>` only keeps the record.
 * - Left waiting (방치): the newest file's day is before the day 7 days ago, or its `기한:` date has passed (KST days).
 *
 * The person's name is never written in the code: it is learned from the folder's own `(기록: …)` lines (`mailPeople`), so a
 * bare `받는 곳: <person>` counts once that name has been seen with a record.
 */
export const mailFileSchema = z.object({
  /** The file's name, NFC. */
  name: z.string(),
  /** `YYYY-MM-DD HH:MM` (KST) from the name's first part; null when the name does not start with a time. */
  at: z.string().nullable(),
  from: z.string().nullable(), kind: z.string().nullable(),
  /** The head's lines, when the file was read: the `# ` title, `받는 곳:` and `기한:` (null: none, or not read). */
  title: z.string().nullable(), to: z.string().nullable(), due: z.string().nullable(),
});
export type MailFileDTO = z.infer<typeof mailFileSchema>;
export const mailListThreadSchema = z.object({
  /** The folder's name, NFC — the thread id. */
  id: z.string(),
  /** The first file's title (its leading kind dropped), else the id. */
  subject: z.string(),
  /** How many message files the thread holds. */
  files: z.number().int().min(0),
  /** The newest file (last by name) first, then the files sharing its time; empty when the thread holds no message yet. */
  latest: z.array(mailFileSchema),
});
export type MailListThreadDTO = z.infer<typeof mailListThreadSchema>;
export const MAIL_LIMIT_KINDS = ['threads', 'files', 'reads'] as const;
export const mailListSchema = z.object({
  /** `off`: the lab's switch is off or no folder is set — nothing was read. */
  state: z.enum(['off', 'ready', 'unreadable']),
  /** The folder as set (shown, never sent back). */
  root: z.string().optional(),
  key: z.string().max(64),
  threads: z.array(mailListThreadSchema),
  /** A cap reached (server/mail-list.ts `MAIL_LIST_LIMITS`): the list is partial and says so. */
  limits: z.array(z.enum(MAIL_LIMIT_KINDS)),
  readAt: z.string(),
  /** The folder's fingerprint (REQ-90's `key`) this reading answers: a screen holding another reads again (research/236 D1). */
  source: z.string().max(64).optional(),
});
export type MailListDTO = z.infer<typeof mailListSchema>;
export const mailThreadFileSchema = mailFileSchema.extend({
  /** The head's first lines (up to 5, blank lines skipped) and the body's first lines after them — the newest files only. */
  head: z.array(z.string()).optional(), excerpt: z.array(z.string()).optional(),
});
export const mailThreadSchema = z.object({
  state: z.enum(['off', 'ready', 'missing']),
  id: z.string(),
  /** The folder's path, to be copied by hand (a plugin cannot open a file). */
  path: z.string().optional(),
  /** Newest first; the newest ones (`latest`) carry their head and excerpt. */
  files: z.array(mailThreadFileSchema),
  latest: z.number().int().min(0),
  /** Older files beyond the cap, not listed. */
  more: z.number().int().min(0),
});
export type MailThreadDTO = z.infer<typeof mailThreadSchema>;

// ---- reading a file's name and head ------------------------------------------------------------------------------------
/** `<YYYYMMDD-HHMM>_<from>_<kind>.md`: the time, who wrote it, its kind. A short name may hold `_`; the kind is the last part. */
export function mailFileName(name: string): Pick<MailFileDTO, 'at' | 'from' | 'kind'> {
  const base = nfc(name).replace(/\.md$/i, ''), m = base.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:_(.*))?$/);
  if (!m) return { at: null, from: null, kind: null };
  const rest = (m[6] ?? '').split('_'), kind = rest.length > 1 ? rest.pop()! : null;
  return { at: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`, from: rest.join('_') || null, kind: kind || null };
}
/**
 * The files that share the newest's time (the newest, last by name, first); a name with no time stands alone. One rule for
 * the lanes' badge (server/mailbox.ts) and the message list (server/mail-list.ts).
 */
export function mailNewestOnes(names: readonly string[]): string[] {
  const newest = names.at(-1);
  if (newest === undefined) return [];
  const at = mailFileName(newest).at;
  if (!at) return [newest];
  return names.filter(n => mailFileName(n).at === at).reverse();
}
const lineValue = (lines: string[], prefix: string) => {
  const line = lines.find(l => l.startsWith(prefix));
  if (line === undefined) return null;
  return line.slice(prefix.length).trim() || null;
};
/** The head's title, recipient and due line (the file's first bytes, NFC). */
export function mailFileHead(text: string): Pick<MailFileDTO, 'title' | 'to' | 'due'> {
  const lines = nfc(text).split(/\r?\n/).map(l => l.trim());
  const title = lines.find(l => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() || null;
  return { title, to: lineValue(lines, '받는 곳:'), due: lineValue(lines, '기한:') };
}
/** The head (up to 5 lines that are not blank) and the body after it (up to `body` lines, each cut at 300 characters). */
export function mailFileParts(text: string, body = 6): { head: string[]; excerpt: string[] } {
  const lines = nfc(text).split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim());
  const cut = (l: string) => l.length > 300 ? l.slice(0, 299) + '…' : l;
  return { head: lines.slice(0, 5).map(cut), excerpt: lines.slice(5, 5 + body).map(cut) };
}
const KINDS = ['요청', '의견', '알림', '질문', '접수', '회신', '재질의', '결정', '종결'];
/** A title without the kind it starts with ("요청 — X" → "X"). */
export function mailSubject(title: string | null, id: string): string {
  if (!title) return id;
  const m = title.match(/^(\S+)\s*[—–:-]\s*(.+)$/);
  return m && KINDS.includes(m[1]!) ? m[2]!.trim() : title;
}
export const isMailCloseFile = (file: Pick<MailFileDTO, 'name'>) => nfc(file.name).endsWith(MAIL_CLOSE_SUFFIX);

// ---- the protocol's verdicts -------------------------------------------------------------------------------------------
const RECORD = /^(.*?)\s*\(\s*기록\s*:\s*([^)]*)\)\s*$/;
/** `<person> (기록: <short name>)` → the person and the record keeper; any other value → null. */
export function mailRecord(to: string): { person: string; keeper: string } | null {
  const m = nfc(to).trim().match(RECORD);
  return m && m[1]!.trim() ? { person: m[1]!.trim(), keeper: m[2]!.trim() } : null;
}
/** The people the folder's records name (the part before `(기록: …)`), most often first. */
export function mailPeople(threads: readonly MailListThreadDTO[]): string[] {
  const seen = new Map<string, number>();
  for (const t of threads) for (const f of t.latest) {
    const record = f.to ? mailRecord(f.to) : null;
    if (record) seen.set(record.person, (seen.get(record.person) ?? 0) + 1);
  }
  return [...seen].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
}
/** A recipient that is a person's decision: a record line, or a value starting with a person the records name. */
export function isPersonTurn(to: string | null, people: readonly string[]): boolean {
  if (!to) return false;
  if (mailRecord(to)) return true;
  const value = nfc(to).trim();
  return people.some(p => value === p || value.startsWith(p + ' ') || value.startsWith(p + '('));
}
/** No one: a close's `받는 곳: 없음`. */
export const isNoOne = (to: string | null) => !to || nfc(to).trim() === '없음';

const DAY = 86_400_000, KST = 9 * 3600_000;
/** The KST day of an instant, as YYYYMMDD. */
export const kstDay = (ms: number) => Number(new Date(ms + KST).toISOString().slice(0, 10).replace(/-/g, ''));
/** A `기한:` value's date as YYYYMMDD, or null ("없음", no date). */
export function dueDay(due: string | null): number | null {
  if (!due) return null;
  const m = nfc(due).match(/(20\d\d)\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/) ?? nfc(due).match(/(20\d\d)(\d\d)(\d\d)/);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}
const fileDay = (at: string | null) => at ? Number(at.slice(0, 10).replace(/-/g, '')) : null;
export type MailState = 'decision' | 'stale' | 'open' | 'closed';
export const MAIL_STATES: readonly MailState[] = ['decision', 'stale', 'open', 'closed'];
export interface MailStatus {
  state: MailState;
  /** Left waiting, and why: 7 days since the newest file, or the due date passed (also on a person's decision). */
  stale: null | 'age' | 'due';
  /** The newest files' senders and recipients (a close's "없음" left out), in file order, each once. */
  from: string[]; to: string[];
  /** A recipient that could not be read (no `받는 곳:` line). */
  unknown: boolean;
  kind: string | null; at: string | null;
  /** The earliest due date among the newest files (YYYYMMDD), and whether it is today. */
  due: number | null; dueToday: boolean;
  /** More than one file shares the newest time. */
  tie: boolean;
}
const once = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];
/** A thread's state at `now`: closed, a person's decision, left waiting, or open (in that order of precedence). */
export function mailStatus(thread: MailListThreadDTO, now: number, people: readonly string[]): MailStatus {
  const latest = thread.latest, first = latest[0];
  const to = once(latest.map(f => isNoOne(f.to) ? null : f.to)), dues = latest.map(f => dueDay(f.due)).filter((d): d is number => d !== null);
  const due = dues.length ? Math.min(...dues) : null, today = kstDay(now), day = fileDay(first?.at ?? null);
  const closed = latest.some(isMailCloseFile);
  // A passed due date is said first: it is the sharper of the two reasons.
  const stale = closed ? null : due !== null && due < today ? 'due' as const : day !== null && day < kstDay(now - 7 * DAY) ? 'age' as const : null;
  const state: MailState = closed ? 'closed' : latest.some(f => isPersonTurn(f.to, people)) ? 'decision' : stale ? 'stale' : 'open';
  return { state, stale, from: once(latest.map(f => f.from)), to, unknown: !closed && latest.some(f => f.to === null), kind: first?.kind ?? null,
    at: first?.at ?? null, due, dueToday: due === today, tie: latest.length > 1 };
}
/** The icon's count: threads waiting for a person's decision or left waiting. */
export function mailAttention(threads: readonly MailListThreadDTO[], now: number, people = mailPeople(threads)): number {
  return threads.filter(t => { const s = mailStatus(t, now, people); return s.state === 'decision' || s.state === 'stale'; }).length;
}
