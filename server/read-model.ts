import { builtinTemplate, cardSummary, needsHuman, sortedCards, summarizeBoard,
  type Board, type CardDispatch, type Locale } from '../shared/core/domain.js';
import { dispatchHeld, type DispatchHeld } from '../shared/dispatch.js';
import { emptyBoardView, folderKey, normalizeCwd, type BoardCardDTO, type BoardDTO, type HideDone, type OverviewDTO } from '../shared/rpc.js';
import { criteriaProgress } from '../shared/criteria.js';
import { groupsKey } from './card-parents.js';
import { BUSY_OVERDUE_MS, busyKey, type BusyEntry } from './busy.js';
import type { LeadMark } from './core/auto-state.js';
import { realpath } from 'node:fs/promises';

/** Fold only retained movement records. Missing entry history never implies a completion date. */
export function completionTimes(board: Board): Map<string, string | null> {
  const done = new Set(board.template.stages.filter(s => s.countsAsDone).map(s => s.stageId));
  const times = new Map<string, string | null>();
  for (const record of board.history) {
    if (!done.has(record.to)) times.set(record.cardId, null);
    else if (record.from === null || !done.has(record.from)) times.set(record.cardId, record.at);
    else if (!times.has(record.cardId)) times.set(record.cardId, null);
  }
  return times;
}
/**
 * REQ-86: when each card entered the stage it is in — the latest retained movement record that took it there. The ledger
 * keeps the last 1000 records of a board (`applyOperations`), so a card that has sat still longer may have none left: it then
 * reads its last change instead, marked `estimated` (the dwell is at least that long). REQ-108: a card that says its own
 * entry (`Card.stageEnteredAt`, set by the write that moved it) is taken at its word before any record. Nothing is written
 * on a read. The fold is cached per board and revision, so a board read — every 4 s — walks the history only after a change.
 */
export type StageEntry = { at: string; estimated: boolean };
const entryCache = new Map<string, { revision: string; history: readonly unknown[]; entered: Map<string, string> }>();
export function stageEntries(board: Pick<Board, 'id' | 'revision' | 'history'>): ReadonlyMap<string, string> {
  const cached = entryCache.get(board.id);
  // The same revision of the same read (the server keeps a board's object while its file is unchanged).
  if (cached && cached.revision === board.revision && cached.history === board.history) return cached.entered;
  // A card's last record is where it went last; `stageEntry` takes it only while the card is still in that stage.
  const entered = new Map<string, string>();
  for (const record of board.history) entered.set(record.cardId, record.to + '\u0000' + record.at);
  if (entryCache.size >= 256) entryCache.delete(entryCache.keys().next().value!);
  entryCache.set(board.id, { revision: board.revision, history: board.history, entered });
  return entered;
}
export function stageEntry(entries: ReadonlyMap<string, string>,
  card: Pick<Board['cards'][number], 'id' | 'stageId' | 'updatedAt' | 'stageEnteredAt'>): StageEntry {
  if (card.stageEnteredAt) return { at: card.stageEnteredAt, estimated: false };
  const last = entries.get(card.id), cut = last ? last.indexOf('\u0000') : -1;
  return last && last.slice(0, cut) === card.stageId ? { at: last.slice(cut + 1), estimated: false } : { at: card.updatedAt, estimated: true };
}
/** REQ-86: the entry on the card's read — `stageEnteredEstimated` only when neither the card nor a record says it. */
export function enteredOf(entry: StageEntry): { stageEnteredAt: string; stageEnteredEstimated?: true } {
  return { stageEnteredAt: entry.at, ...(entry.estimated ? { stageEnteredEstimated: true as const } : {}) };
}
function localizedTemplate(board: Board, locale: Locale) {
  return board.template.id === 'basic' && board.template.version === 1
    ? builtinTemplate(locale) : board.template;
}
/** REQ-103 ①: a card's checklist count rides on the board; its criteria text stays in the card's own read. */
function criteriaOf(text: string): { criteria?: { checked: number; total: number } } {
  const progress = criteriaProgress(text);
  return progress ? { criteria: progress } : {};
}
/**
 * `parents`: REQ-76, card id → the card it sits under (`cardParents`); absent means every card on its own.
 * `busy`: REQ-84, card id → its busy mark (server/busy.ts `busyOf`); only a card still on the board carries one.
 * `ended`: research/174 J2, card id → when its mark was last turned off; said on a card with no mark on.
 */
/**
 * 253-D3: why a card waits with nobody to go to, when it is not "no agent there" — from the dispatch start line (`floor`:
 * null when it cannot be read; undefined when not asked, then nothing is said).
 */
export function heldOf(dispatch: Pick<CardDispatch, 'state' | 'targetAgentId' | 'requestedAt'>, floor: string | null | undefined): { held?: DispatchHeld } {
  if (dispatch.state !== 'noLead' || floor === undefined) return {};
  const held = dispatchHeld(dispatch, floor);
  return held === 'noAgent' ? {} : { held };
}
/** 253-D3: the dispatch start line as the dispatcher reads it — null when the auto-card file cannot be read or is damaged. */
export function dispatchFloorOf(state: { damaged?: boolean; autoBoardFloor?: string | null } | null): string | null {
  return state && !state.damaged ? state.autoBoardFloor ?? null : null;
}
/**
 * 281 F2: what a card's request line may say of the rule it waits or went by, from the board's mark as kept (`leadRecord`).
 * Waiting: by the mark as it is now (the receiver is judged again when it is sent). Sent: by the mark as it was then — the
 * same mark when it has not changed since (`changedAt` not after `sentAt`). Sent before the mark last changed, or with the
 * file unknown, the rule it went by is not kept (the ledger keeps no receiver's role, v0.1.47): `modeUnknown`, a plain "Sent".
 * No mark ever kept for the folder: nothing to say here (the screens tell a lead by name from the latest agent, as before).
 */
export function dispatchMode(dispatch: Pick<CardDispatch, 'state' | 'sentAt' | 'targetAgentId'>, record: LeadMark | null | undefined):
  { marked?: true; modeUnknown?: true } {
  const target = dispatch.targetAgentId ?? null;
  if (dispatch.state !== 'sent') return target && record?.agentId === target ? { marked: true } : {};
  if (record === null) return {};
  const sent = dispatch.sentAt ? Date.parse(dispatch.sentAt) : NaN, changed = record ? Date.parse(record.changedAt) : NaN;
  if (!record || !(changed <= sent)) return { modeUnknown: true };
  return target && record.agentId === target ? { marked: true } : {};
}
/**
 * REQ-137 / 281: what a board view says of its lead — `record`, the folder's mark as kept (`leadRecord`: undefined when the
 * file is unknown), and `now`, the server's judgement of who leads (`judgeLead`; absent when not judged). A bare agent id
 * (older callers) is a mark kept from the start.
 */
export type BoardLeadInput = { record: LeadMark | null | undefined; now?: NonNullable<BoardDTO['summary']['leadNow']> | undefined };
const leadInput = (lead: BoardLeadInput | string | null | undefined): BoardLeadInput =>
  typeof lead === 'string' ? { record: { agentId: lead, changedAt: new Date(0).toISOString() } } : lead ?? { record: null };
export function toBoardDTO(board: Board, locale: Locale = 'en', hide: HideDone = 'off', now = Date.now(),
  parents?: ReadonlyMap<string, string>, busy?: ReadonlyMap<string, BusyEntry>, ended?: ReadonlyMap<string, string>,
  dispatchFloor?: string | null, leadOf?: BoardLeadInput | string | null): BoardDTO {
  const { record, now: leadNow } = leadInput(leadOf), lead = record?.agentId ?? null;
  const times = completionTimes(board), entries = stageEntries(board);
  const template = localizedTemplate(board, locale);
  const cards = sortedCards(board);
  const agentLabels: Record<string, string> = {};
  for (const c of cards) for (const a of c.agents) if (a.label) agentLabels[a.agentId] = a.label;
  const groups = groupsKey(parents, lead), marks = busyKey(busy, new Set(cards.map(c => c.id)));
  return {
    summary: { ...summarizeBoard(board), ...(groups ? { groups } : {}), ...(marks ? { busy: marks } : {}), ...(lead ? { lead } : {}),
      ...(leadNow ? { leadNow } : {}) }, template, agentLabels,
    stages: template.stages.map(stage => {
      const all: BoardCardDTO[] = cards.filter(c => c.stageId === stage.stageId).map(c => ({
        ...cardSummary(c), agentIds: c.agents.map(a => a.agentId), updatedAt: c.updatedAt, createdAt: c.createdAt,
        ...enteredOf(stageEntry(entries, c)),
        completedAt: stage.countsAsDone && c.intent === 'requested' ? times.get(c.id) ?? null : null,
        ...(parents?.has(c.id) ? { parentCardId: parents.get(c.id)! } : {}),
        ...criteriaOf(c.acceptanceCriteria),
        // REQ-97: the chip on the card's face; a request moved back before it was sent says nothing.
        ...(c.dispatch && c.dispatch.state !== 'cancelled' ? { dispatch: { state: c.dispatch.state, sentAt: c.dispatch.sentAt, targetAgentId: c.dispatch.targetAgentId,
          ...heldOf(c.dispatch, dispatchFloor), ...dispatchMode(c.dispatch, record) } } : {}),
        ...(busy?.has(c.id) ? { busy: { ...busy.get(c.id)! } } : ended?.has(c.id) ? { busyEndedAt: ended.get(c.id)! } : {}),
      }));
      const visible = all.filter(c => hide === 'off' || c.completedAt === null ||
        now - Date.parse(c.completedAt) < (hide === '7d' ? 7 : 30) * 86400000);
      return { ...stage, cards: visible, hiddenCount: all.length - visible.length, totalCount: all.length };
    }),
  };
}
/**
 * REQ-84 ④: a busy mark on for more than two hours (`BUSY_OVERDUE_MS`) asks a person to look — never switched off by
 * itself, since a mark that went quiet could hide a run that failed. Only a card still on the board counts.
 */
export function busyOverdue(mark: Pick<BusyEntry, 'since'> | undefined, now: number): boolean {
  const since = mark ? Date.parse(mark.since) : NaN;
  return Number.isFinite(since) && now - since > BUSY_OVERDUE_MS;
}
/**
 * `busy`: REQ-84, board id → its busy marks; an overdue one counts as needing a person (`busyOverdue`). Each board says their
 * fingerprint (`summary.busy`, as `revisions.get`), so a screen comparing the two sees no change where there is none
 * (research/174 D1). `ended`: J2, board id → its cards' last turned-off marks (`toBoardDTO`).
 */
export function toOverview(boards: Board[], locale: Locale, observedAt: string,
  busy?: (boardId: string) => ReadonlyMap<string, BusyEntry> | undefined,
  ended?: (boardId: string) => ReadonlyMap<string, string> | undefined): OverviewDTO {
  const now = Date.parse(observedAt);
  const overdue = (board: Board, card: Board['cards'][number]) => card.archivedAt === null && busyOverdue(busy?.(board.id)?.get(card.id), now);
  const human = (board: Board, card: Board['cards'][number]) => needsHuman(card, board.template.stages) || overdue(board, card);
  return {
    locale, observedAt, errors: [],
    boards: boards.map(b => {
      const key = busyKey(busy?.(b.id), new Set(b.cards.filter(c => c.archivedAt === null).map(c => c.id)));
      return { ...summarizeBoard(b), ...(key ? { busy: key } : {}), needsHuman: b.cards.filter(c => human(b, c)).length };
    }),
    attention: boards.flatMap(board => {
      const dto = toBoardDTO(board, locale, 'off', now, undefined, busy?.(board.id), ended?.(board.id));
      const late = new Set(board.cards.filter(c => overdue(board, c)).map(c => c.id));
      const human = new Set(board.cards.filter(c => needsHuman(c, board.template.stages) || late.has(c.id)).map(c => c.id));
      return dto.stages.flatMap(stage => stage.cards.filter(c => human.has(c.id)).map(c => ({
        ...c, boardId: board.id, workspaceId: board.workspaceId, cwd: board.cwd, stageName: stage.name,
        agentLabels: Object.fromEntries(c.agentIds.map(id => [id, dto.agentLabels[id] ?? ''])),
        reasons: [c.awaiting === 'user' ? 'awaitingUser' as const : null,
          c.blocked ? 'blocked' as const : null, c.intent === 'draft' ? 'draft' as const : null,
          late.has(c.id) ? 'busyOverdue' as const : null]
          .filter((v): v is 'awaitingUser' | 'blocked' | 'draft' | 'busyOverdue' => v !== null),
      })));
    }),
  };
}

/**
 * REQ-57 ①: a workspace Paseo knows about but that has no ledger board yet is presented as an empty
 * board of the built-in template, so every screen, filter and sort works on it without a second shape.
 * It carries no ledger identity — `hasLedger: false` and an `empty:` view id — so a write can never be
 * addressed to it by mistake; board.ensure turns it into a real board on the first card.
 */
export function toEmptyBoardDTO(workspaceId: string, cwd: string, locale: Locale = 'en'): BoardDTO {
  const template = builtinTemplate(locale);
  return {
    summary: { id: emptyBoardView(workspaceId), workspaceId, cwd, workspaceStatus: 'active', hasLedger: false,
      revision: '', updatedAt: '', progress: { done: 0, requested: 0, draft: 0, archived: 0, percent: null } },
    template, agentLabels: {},
    stages: template.stages.map(stage => ({ ...stage, cards: [], hiddenCount: 0, totalCount: 0 })),
  };
}
/**
 * Workspaces with no board file, in the order Paseo listed them.
 *
 * D22 ①: a board created before Paseo had a workspace here carries a `local_` id that the listing does
 * not contain, so identity alone would report its workspace as boardless and the screen would show the
 * real lane and a synthetic empty one side by side. The directory settles it: one board at a directory
 * means that workspace already has a board.
 */
export function emptyWorkspaces(boards: { workspaceId: string; cwd: string }[],
  active: readonly { id: string; cwd: string }[]): { id: string; cwd: string }[] {
  const known = new Set(boards.map(b => b.workspaceId));
  const occupied = new Set(boards.map(b => normalizeCwd(b.cwd)));
  return active.filter(w => !known.has(w.id) && !occupied.has(normalizeCwd(w.cwd)));
}
/**
 * REQ-138: the ledger boards whose workspace Paseo no longer lists as live — archived, being archived, or gone — and that
 * hold no live card (archived cards alone count as none). A board the listing still names by id or, D22, by folder is live.
 * Judged afresh on every read, so a new card or the workspace back shows the board again; nothing is written.
 * 320 F1: hidden only when sure. Folders compare by the ledger's own key (`folderKey`: Windows drive and UNC paths ignore
 * case, slashes and a trailing separator), and a folder that differs from a live one only in case is taken as the same one
 * even on a POSIX path (a Mac volume ignores case by default) — a board wrongly shown costs less than one wrongly hidden.
 * 320 J2: `liveIds`, the live workspaces Paseo listed without a folder, keep their boards by id.
 */
const hideFolderKey = (cwd: string): string => folderKey(cwd).toLowerCase();
export function emptyGoneBoards(boards: readonly Pick<Board, 'id' | 'workspaceId' | 'cwd' | 'cards'>[],
  active: readonly { id: string; cwd: string }[], liveIds: readonly string[] = []): Set<string> {
  const ids = new Set([...active.map(w => w.id), ...liveIds]), folders = new Set(active.map(w => hideFolderKey(w.cwd)));
  return new Set(boards.filter(b => !ids.has(b.workspaceId) && !folders.has(hideFolderKey(b.cwd)) &&
    !b.cards.some(c => c.archivedAt === null)).map(b => b.id));
}
/** 321 F2: a folder's real path, or why there is none — `missing` (no such folder), `unsure` (it could not be read). */
type RealFolder = { path: string } | { missing: true } | { unsure: true };
async function realFolder(cwd: string, real: (path: string) => Promise<string>): Promise<RealFolder> {
  try { return { path: await real(cwd) }; } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { missing: true } : { unsure: true };
  }
}
/**
 * 321 F2: the boards `emptyGoneBoards` judged gone, checked once more by the real folder — a workspace opened again through
 * a symbolic link (or another path to the same folder) under a new id still has its board. Only those boards are looked at,
 * and only when there are any. Hidden only when sure: a board whose own folder cannot be read for another reason than "no
 * such folder", or any live workspace whose folder cannot be read, keeps every board shown. A board whose folder is gone
 * stays hidden (no live folder can be it). Reads the file system only; nothing is written.
 */
export async function confirmGone(gone: ReadonlySet<string>, boards: readonly Pick<Board, 'id' | 'cwd'>[],
  active: readonly { cwd: string }[], real: (path: string) => Promise<string> = realpath): Promise<Set<string>> {
  if (!gone.size) return new Set();
  const live = await Promise.all(active.map(w => realFolder(w.cwd, real)));
  if (live.some(r => 'unsure' in r)) return new Set();
  const folders = new Set(live.flatMap(r => 'path' in r ? [hideFolderKey(r.path)] : []));
  const sure = new Set<string>();
  for (const board of boards) {
    if (!gone.has(board.id)) continue;
    const own = await realFolder(board.cwd, real);
    if ('unsure' in own || ('path' in own && folders.has(hideFolderKey(own.path)))) continue;
    sure.add(board.id);
  }
  return sure;
}
