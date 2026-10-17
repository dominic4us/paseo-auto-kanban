import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archivedDone, createKanbanError, isKanbanError, type Board, type Card } from '../shared/core/domain.js';
import { archiveClock, archiveDue, cleanArchiveDays, DEFAULT_ARCHIVE_DAYS, MAX_ARCHIVE_DAYS } from '../shared/archive.js';
import type { Store } from './core/store.js';
import { stageEntries, stageEntry } from './read-model.js';
import { pruneAfterWrite } from './busy.js';
import { renameOver } from './core/durable.js';

/**
 * REQ-52: the automatic archive of finished cards and the board screen's "Tidy", archived list and restore.
 *
 * Where it runs: in the plugin's server only, never in the core nor the `kanban` CLI. The CLI is what agents run while they
 * work; a read or a write of theirs archiving other cards on the side would be a write nobody asked for, by a process that
 * cannot say whose setting it obeyed. The number of days is a setting of the plugin (this file), so the plugin is the one
 * writer: it sweeps when a screen reads the boards (`wake`, at most every ten minutes) and at once when the days change.
 * With Paseo closed nothing is archived; nothing is lost by waiting.
 *
 * What it leaves: the card stays in its board file with `archivedAt` (when) and `archiveReason: 'auto'` (why), so the
 * archived list says "Archived automatically" and a restore brings it back as it was; a restore sets `restoredAt`, from
 * which the card gets its full days again (`archiveClock`). The days count from when the card entered its completion stage
 * (`stageEntry`: the card's own `stageEnteredAt`, else its last movement record, else its last change — never earlier).
 *
 * `auto-archive.json` is the plugin's own file beside `ui-state.json` (the core's `config.json` rejects unknown fields):
 * `{ schemaVersion: 1, days, changedAt }`. Missing: the default, 7 days. Damaged: off (fail closed — a file that cannot be
 * read never archives anything) and the settings window says so; saving a value writes a sound file again.
 */
export const ARCHIVE_SETTINGS_FILE = 'auto-archive.json';
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const BATCH = 100;
export interface ArchiveSettings { days: number; damaged?: true }

export async function readArchiveSettings(dataDir: string): Promise<ArchiveSettings> {
  let raw: string;
  try { raw = await fs.readFile(path.join(dataDir, ARCHIVE_SETTINGS_FILE), 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { days: DEFAULT_ARCHIVE_DAYS } : { days: 0, damaged: true }; }
  try {
    const value = JSON.parse(raw) as { schemaVersion?: unknown; days?: unknown };
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || cleanArchiveDays(value.days) !== value.days) return { days: 0, damaged: true };
    return { days: value.days as number };
  } catch { return { days: 0, damaged: true }; }
}
/** Writes through a temporary file in the same folder, and only when the value differs (a damaged file is always rewritten). */
export async function writeArchiveSettings(dataDir: string, days: number, now = () => new Date().toISOString()): Promise<{ days: number; changed: boolean }> {
  if (!Number.isInteger(days) || days < 0 || days > MAX_ARCHIVE_DAYS)
    throw createKanbanError('E_VALIDATION', 'Days must be a whole number from 0 to 365.', 'days', 'Choose one of the offered values.');
  const current = await readArchiveSettings(dataDir);
  if (!current.damaged && current.days === days) return { days, changed: false };
  const file = path.join(dataDir, ARCHIVE_SETTINGS_FILE), temporary = path.join(dataDir, `.${ARCHIVE_SETTINGS_FILE}.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, days, changedAt: now() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await renameOver(temporary, file);
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  return { days, changed: true };
}

/** The live cards of `board` in a completion stage whose days ran out at `now` (ms). */
export function dueCards(board: Board, now: number, days: number): Card[] {
  if (days <= 0) return [];
  const done = new Set(board.template.stages.filter(s => s.countsAsDone).map(s => s.stageId)), entries = stageEntries(board);
  return board.cards.filter(c => c.archivedAt === null && c.intent === 'requested' && done.has(c.stageId) &&
    archiveDue(archiveClock(stageEntry(entries, c).at, c.restoredAt), now, days));
}
/** The live cards of `board` in a completion stage — what "Tidy" puts away. */
export function doneCards(board: Board): Card[] {
  const done = new Set(board.template.stages.filter(s => s.countsAsDone).map(s => s.stageId));
  return board.cards.filter(c => c.archivedAt === null && done.has(c.stageId));
}

/**
 * Archives `ids` of one board in batches of a hundred, each on the revision the last one left (compare-and-swap: a board
 * changed in between stops the rest; what was archived stays). Returns how many were archived.
 */
async function archiveAll(store: Store, board: Board, ids: readonly string[], auto: boolean): Promise<number> {
  let revision = board.revision, archived = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    const result = await store.mutateBoard(board.id, { actor: { kind: 'user' }, requestId: randomUUID(), ifRevision: revision,
      operations: part.map(id => auto ? { op: 'archive', id, reason: 'auto' } : { op: 'archive', id }) }, auto ? 'archiver' : 'board');
    revision = result.data.revision;
    if (result.data.changed) archived += part.length;
  }
  if (archived) await pruneAfterWrite(store.dataDir, board.id, async () => (await store.readBoard(board.id)).cards);
  return archived;
}

export interface ArchivedCardDTO { id: string; title: string; stageId: string; archivedAt: string; auto?: true; done: boolean }
export const ARCHIVED_LIST_LIMIT = 300;

export function createAutoArchiver(store: Store, clock: () => number = Date.now, interval = SWEEP_INTERVAL_MS) {
  let last = -Infinity, running: Promise<number> | null = null;
  const sweep = async (): Promise<number> => {
    const settings = await readArchiveSettings(store.dataDir);
    if (settings.damaged || settings.days <= 0) return 0;
    let total = 0;
    for (const identity of await store.listBoardIdentities()) {
      try {
        const board = await store.readBoard(identity.id), due = dueCards(board, clock(), settings.days);
        if (due.length) total += await archiveAll(store, board, due.map(c => c.id), true);
      } catch { /* a board changed meanwhile or could not be read: the next sweep looks again */ }
    }
    return total;
  };
  const run = (): Promise<number> => {
    if (running) return running;
    last = clock();
    running = sweep().catch(() => 0).finally(() => { running = null; });
    return running;
  };
  return {
    /** A screen read the boards: sweep in the background unless one ran in the last ten minutes. Never throws. */
    wake(): void { if (!running && clock() - last >= interval) void run(); },
    /** Resolves once no sweep is running (tests, and a caller that must read after one). */
    settled: async (): Promise<void> => { await running; },
    /** Sweep now (after the days changed); resolves to how many cards were archived. */
    sweep: run,
    settings: () => readArchiveSettings(store.dataDir),
    async setDays(days: number) { const result = await writeArchiveSettings(store.dataDir, days); if (result.changed) void run(); return result; },
    /** "Tidy": every live card in a completion stage of the board, archived as the person's own act. */
    async tidy(boardId: string): Promise<{ archived: number }> {
      const board = await store.readBoard(boardId);
      return { archived: await archiveAll(store, board, doneCards(board).map(c => c.id), false) };
    },
    /** The board's archived cards, latest first, the first 300; `done` tells finished work from a cancelled card. */
    async list(boardId: string): Promise<{ cards: ArchivedCardDTO[]; total: number; archivedDone: number }> {
      const board = await store.readBoard(boardId), stages = board.template.stages;
      const all = board.cards.filter(c => c.archivedAt !== null)
        .sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!) || a.id.localeCompare(b.id));
      return { total: all.length, archivedDone: all.filter(c => archivedDone(c, stages)).length,
        cards: all.slice(0, ARCHIVED_LIST_LIMIT).map(c => ({ id: c.id, title: c.title, stageId: c.stageId, archivedAt: c.archivedAt!,
          ...(c.archiveReason === 'auto' ? { auto: true as const } : {}), done: archivedDone(c, stages) })) };
    },
    /** A person brings an archived card back; no revision is held — restoring is the same whatever changed meanwhile. */
    async restore(boardId: string, cardId: string): Promise<{ changed: boolean }> {
      try {
        const result = await store.mutateBoard(boardId, { actor: { kind: 'user' }, requestId: randomUUID(),
          operations: [{ op: 'restore', id: cardId }] }, 'board');
        return { changed: result.data.changed };
      } catch (error) {
        if (isKanbanError(error) && error.code === 'E_NOT_FOUND') throw createKanbanError('E_NOT_FOUND', 'Card not found.', cardId, 'Read the archived list again.');
        throw error;
      }
    },
  };
}
export type AutoArchiver = ReturnType<typeof createAutoArchiver>;
