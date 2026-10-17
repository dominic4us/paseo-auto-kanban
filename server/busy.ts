import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createKanbanError } from '../shared/core/domain.js';
import { renameOver } from './core/durable.js';

/**
 * REQ-84: work that is not an agent's turn — a lead's own test run, a person's build, a script — marked on a card while it
 * runs (`kanban card busy CARD "Testing"`, `--off` to end it). Like the agent signals it is passing state, so it never
 * enters the ledger (the core validator and PROCESS.md stay as they are): it sits beside `auto-cards.json` in the plugin's
 * data folder, `busy.json`, board id → card id → { text, since, by }. A missing or damaged file means nothing is marked.
 *
 * Writers are several processes (every `kanban` CLI, the plugin server's "Turn off"), so a write takes a small lock file
 * of its own (`.busy.json.lock`, created exclusively; one older than `STALE_MS` was left by a writer that died) and then
 * replaces the file through a temporary one in the same folder, as `auto-cards.json` is written. Reads take no lock.
 * An entry is never switched off by time: past `BUSY_OVERDUE_MS` the card asks a person to look (client/busy-view.ts).
 *
 * Research/174 J2: a mark turned off leaves when it ended (`cleared`, board id → card id → time) for `CLEARED_KEEP_MS`, so
 * REQ-86's "no agent at work for 2h" counts from the end of the run, not from before it. Dropped when the card is marked
 * again, archived or older than that; kept in the same file, so the ledger stays as it is.
 */
export const BUSY_FILE = 'busy.json';
export const BUSY_OVERDUE_MS = 2 * 3600_000;
export const BUSY_TEXT_LIMIT = 200;
/** REQ-130: who a mark turned on from the board screen's detail is recorded as (a person there; the CLI says "cli"). */
export const BUSY_BY_SCREEN = 'screen';
const BY_LIMIT = 256, CARD_LIMIT = 500, BOARD_LIMIT = 1000, BYTES_LIMIT = 1048576;
const LOCK = '.' + BUSY_FILE + '.lock', STALE_MS = 10_000;
/** Longer than REQ-86's quiet limit (2h, client/stage-time.ts): past it an ended run no longer holds a warning back. */
export const CLEARED_KEEP_MS = 3 * 3600_000;
export interface BusyEntry { text: string; since: string; by: string }
/** Board id → card id → its mark. */
export type BusyState = Record<string, Record<string, BusyEntry>>;
/** Board id → card id → when its mark was last turned off (J2). */
export type ClearedState = Record<string, Record<string, string>>;

const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));
/** The words a mark is shown with: one line, trimmed; null when nothing is left or too long. */
export function busyText(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  return text && [...text].length <= BUSY_TEXT_LIMIT ? text : null;
}
function readEntry(value: unknown): BusyEntry | null {
  const e = value as Partial<BusyEntry> | null;
  if (!e || typeof e !== 'object' || typeof e.text !== 'string' || !isTime(e.since) || typeof e.by !== 'string') return null;
  const text = busyText(e.text), by = e.by.trim();
  return text && by && by.length <= BY_LIMIT ? { text, since: e.since, by } : null;
}
function readBoards<T>(value: unknown, entry: (value: unknown) => T | null): Record<string, Record<string, T>> {
  const state: Record<string, Record<string, T>> = {};
  if (!value || typeof value !== 'object') return state;
  for (const [boardId, cards] of Object.entries(value as Record<string, unknown>).slice(0, BOARD_LIMIT)) {
    if (!/^board_[0-9a-f]{64}$/.test(boardId) || !cards || typeof cards !== 'object') continue;
    const kept: Record<string, T> = {};
    for (const [cardId, item] of Object.entries(cards as Record<string, unknown>).slice(0, CARD_LIMIT)) {
      const read = /^card_[0-9a-f-]{36}$/.test(cardId) ? entry(item) : null;
      if (read !== null) kept[cardId] = read;
    }
    if (Object.keys(kept).length) state[boardId] = kept;
  }
  return state;
}
/** The marks and the recent ends (J2); a missing or damaged file reads as neither. */
export async function readBusyFile(dataDir: string): Promise<{ marks: BusyState; cleared: ClearedState }> {
  try {
    const raw = await fs.readFile(path.join(dataDir, BUSY_FILE), 'utf8');
    if (raw.length > BYTES_LIMIT) return { marks: {}, cleared: {} };
    const value = JSON.parse(raw) as { schemaVersion?: unknown; boards?: unknown; cleared?: unknown };
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !value.boards || typeof value.boards !== 'object') return { marks: {}, cleared: {} };
    return { marks: readBoards(value.boards, readEntry), cleared: readBoards(value.cleared, v => isTime(v) ? v : null) };
  } catch { /* missing or damaged: nothing marked */ }
  return { marks: {}, cleared: {} };
}
export async function readBusy(dataDir: string): Promise<BusyState> {
  return (await readBusyFile(dataDir)).marks;
}
/** One board's marks (or, J2, its recent ends), for its read (server/read-model.ts). */
export function busyOf<T = BusyEntry>(state: Record<string, Record<string, T>> | null | undefined, boardId: string): ReadonlyMap<string, T> | undefined {
  const cards = state?.[boardId];
  return cards && Object.keys(cards).length ? new Map(Object.entries(cards)) : undefined;
}
/**
 * A short fingerprint of a board's marks, or undefined with none. A mark changes the plugin's file, not the ledger, so
 * the board's revision stays; the screens compare this too when they poll `revisions.get` (as REQ-76's `groups`).
 */
export function busyKey(marks: ReadonlyMap<string, BusyEntry> | undefined, active?: ReadonlySet<string>): string | undefined {
  const entries = marks ? [...marks].filter(([cardId]) => !active || active.has(cardId)) : [];
  if (!entries.length) return undefined;
  const text = entries.map(([cardId, e]) => [cardId, e.since, e.by, e.text].join('\u0000')).sort().join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function lock(dataDir: string, timeoutMs: number): Promise<() => Promise<void>> {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK), token = randomUUID(), deadline = Date.now() + timeoutMs;
  for (let pause = 5; ; pause = Math.min(100, pause * 2)) {
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
      return async () => {
        // Only our own lock is removed: a writer that took over a stale one keeps it.
        const held = await fs.readFile(file, 'utf8').catch(() => '');
        if (held.includes(token)) await fs.rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await fs.stat(file).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_MS) { await fs.rm(file, { force: true }).catch(() => {}); continue; }
    if (Date.now() >= deadline) throw createKanbanError('E_LOCK_TIMEOUT', 'Timed out waiting for the busy-mark lock.', file,
      `Retry; a lock left by a stopped writer is taken over after ${STALE_MS / 1000} seconds.`);
    await new Promise(resolve => setTimeout(resolve, pause + Math.random() * 5));
  }
}
async function write(dataDir: string, state: BusyState, cleared: ClearedState): Promise<void> {
  const boards = Object.entries(state).filter(([, cards]) => Object.keys(cards).length)
    .sort((a, b) => latest(b[1]).localeCompare(latest(a[1]))).slice(0, BOARD_LIMIT);
  // J2: only the ends recent enough to matter, newest first; with none the key is left out.
  const cutoff = Date.now() - CLEARED_KEEP_MS;
  const ends = Object.entries(cleared).map(([id, cards]) => [id, Object.entries(cards).filter(([, at]) => Date.parse(at) > cutoff)
    .sort((a, b) => b[1].localeCompare(a[1])).slice(0, CARD_LIMIT)] as const)
    .filter(([, cards]) => cards.length).sort((a, b) => b[1][0]![1].localeCompare(a[1][0]![1])).slice(0, BOARD_LIMIT)
    .map(([id, cards]) => [id, Object.fromEntries(cards)] as const);
  const bytes = JSON.stringify({ schemaVersion: 1, boards: Object.fromEntries(boards),
    ...(ends.length ? { cleared: Object.fromEntries(ends) } : {}) }, null, 2) + '\n';
  const file = path.join(dataDir, BUSY_FILE), temporary = path.join(dataDir, `.${BUSY_FILE}.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await renameOver(temporary, file);
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}
const latest = (cards: Record<string, BusyEntry>) => Object.values(cards).map(e => e.since).sort().at(-1) ?? '';
const same = (a: BusyEntry | undefined, b: BusyEntry | undefined) => a?.text === b?.text && a?.since === b?.since && a?.by === b?.by;

/**
 * Sets (`entry`) or clears (null) one card's mark, under the lock. `active`: the board's cards that are not archived — any
 * other mark of the board is dropped in the same write (an archived or vanished card keeps nothing). Written only when the
 * file changes. J2: turning off a mark that was on remembers when (`at`, now by default); marking the card again forgets it.
 */
export async function setBusy(dataDir: string, boardId: string, cardId: string, entry: BusyEntry | null,
  { active, timeoutMs = 5000, at }: { active?: ReadonlySet<string> | undefined; timeoutMs?: number; at?: string | undefined } = {}):
  Promise<{ busy: BusyEntry | null; changed: boolean }> {
  const release = await lock(dataDir, timeoutMs);
  try {
    const { marks: state, cleared } = await readBusyFile(dataDir), before = state[boardId] ?? {};
    const cards: Record<string, BusyEntry> = Object.fromEntries(Object.entries(before).filter(([id]) => !active || active.has(id)));
    if (entry) cards[cardId] = entry; else delete cards[cardId];
    const trimmed = Object.entries(cards).sort((a, b) => b[1].since.localeCompare(a[1].since)).slice(0, CARD_LIMIT);
    const next = Object.fromEntries(trimmed);
    const changed = Object.keys(before).length !== trimmed.length || trimmed.some(([id, e]) => !same(before[id], e));
    if (changed) {
      if (trimmed.length) state[boardId] = next; else delete state[boardId];
      const ends = Object.fromEntries(Object.entries(cleared[boardId] ?? {}).filter(([id]) => !active || active.has(id)));
      if (entry) delete ends[cardId]; else if (before[cardId]) ends[cardId] = at ?? new Date().toISOString();
      if (Object.keys(ends).length) cleared[boardId] = ends; else delete cleared[boardId];
      await write(dataDir, state, cleared);
    }
    return { busy: next[cardId] ?? null, changed };
  } finally { await release(); }
}
/**
 * Drops the marks and the recorded ends (J2) of a board's archived or vanished cards, and every end older than
 * `CLEARED_KEEP_MS` — also on a board with no mark on (REQ-108 ④), so an archived card's end goes when it is archived.
 * Reads first, so a file with nothing to drop costs no lock. Returns how many of the board's marks and ends were dropped.
 */
export async function pruneBusy(dataDir: string, boardId: string, active: ReadonlySet<string>): Promise<number> {
  const stale = (file: { marks: BusyState; cleared: ClearedState }, cutoff: number) =>
    Object.keys(file.marks[boardId] ?? {}).some(id => !active.has(id)) ||
    Object.keys(file.cleared[boardId] ?? {}).some(id => !active.has(id)) ||
    Object.values(file.cleared).some(cards => Object.values(cards).some(at => Date.parse(at) <= cutoff));
  if (!stale(await readBusyFile(dataDir), Date.now() - CLEARED_KEEP_MS)) return 0;
  const release = await lock(dataDir, 5000);
  try {
    const file = await readBusyFile(dataDir), cutoff = Date.now() - CLEARED_KEEP_MS;
    if (!stale(file, cutoff)) return 0;
    const { marks: state, cleared } = file, before = state[boardId] ?? {}, ended = cleared[boardId] ?? {};
    const kept = Object.fromEntries(Object.entries(before).filter(([id]) => active.has(id)));
    if (Object.keys(kept).length) state[boardId] = kept; else delete state[boardId];
    // An archived card's end goes with its mark: it is off the board. Old ends of any board are left out by `write`.
    const ends = Object.fromEntries(Object.entries(ended).filter(([id, at]) => active.has(id) && Date.parse(at) > cutoff));
    if (Object.keys(ends).length) cleared[boardId] = ends; else delete cleared[boardId];
    await write(dataDir, state, cleared);
    return Object.keys(before).length - Object.keys(kept).length + Object.keys(ended).length - Object.keys(ends).length;
  } finally { await release(); }
}
/**
 * After a write that may have archived cards (the CLI's `card update`/`apply`, the board screen's archive): drops what those
 * cards left here. `cards` reads the board only when the file has anything of it; a failure never fails the write itself.
 */
export async function pruneAfterWrite(dataDir: string, boardId: string,
  cards: () => Promise<readonly { id: string; archivedAt: string | null }[]>): Promise<void> {
  try {
    const file = await readBusyFile(dataDir);
    if (!file.marks[boardId] && !file.cleared[boardId]) return;
    await pruneBusy(dataDir, boardId, new Set((await cards()).filter(c => c.archivedAt === null).map(c => c.id)));
  } catch { /* the next busy write of this board prunes it too */ }
}
