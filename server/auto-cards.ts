import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fail, folderKey, normalizeOperations, type Board, type Card, type Locale, type Operation, type Stage } from '../shared/core/domain.js';
import { AUTO_STATE_BACKUP, AUTO_STATE_FILE, AUTO_BOARD_LIMIT, WORKSPACE_LIMIT, autoMadeBoard, isText, readAutoState, workspaceSetting, writeAutoState,
  type AppliedState, type AutoMove, type AutoState, type Bucket, type HostSetting, type MoveCause, type ParentMemory, type Signal } from './core/auto-state.js';
import { normalizeCwd } from '../shared/rpc.js';
import type { Store } from './core/store.js';
import { boardCreateKey, serially } from './serial.js';

/**
 * REQ-61: a card for every top-level Paseo agent, in the kanban of the workspace it runs in, moved by the
 * agent's own lifecycle signals. Testers who never run an orchestrator still get a record of the work.
 *
 * Boundaries, all measured in research/56:
 * - A workspace with a board gets the card there. A worktree without a board of its own falls back to the
 *   board at its project's root folder, if there is one (D25). D33: a board made after the agent (an
 *   orchestrator's `kanban init`) gets the agent's card at its next live signal.
 * - D44: a workspace with no board gets one, made by this feature, when a top-level agent created after the
 *   start line for it (`autoBoardFloor`, the first run of this version, or later) sends a signal — a person with no
 *   skill and no CLI never runs `kanban init`. The board is made where Paseo says the workspace lives (a worktree's
 *   at its project's root, as D25 reads it), once per folder (`serially`), and writes no PROCESS.md (`boards`,
 *   server/core/export.ts `quietBoard`). On such a board only agents made after that start line get a card, so
 *   older chats in the workspace never fill it.
 * - D44: a person can switch it all off for one workspace (`workspaces`, keyed by `normalizeCwd` of its folder).
 * - Only top-level agents (`parentAgentId === null`). An orchestrator's workers are its own business;
 *   it links them to its cards itself.
 * - A card that already carries the agent (for example one the orchestrator linked) is updated instead
 *   of a second card being made.
 * - The daemon fires hooks without waiting, so `turn_started` can arrive while the card is still being
 *   written. Every signal goes through a serial queue per workspace, so none is lost or reordered.
 * - A write happens only when the agent's bucket, the permission flag or the auto title changes.
 *   A quiet agent, or no agent at all, writes nothing.
 * - Nothing leaves a hook: every failure is caught and logged, and the daemon never waits on the ledger.
 *
 * REQ-76: a sub-agent still gets no card of its own, but the parent it had when it was first seen is kept in this
 * plugin's file (`parents`), so the screen can gather its cards under the card of its top-level agent even after
 * Paseo drops the parent label (a detach, or the orchestrator being archived). A remembered sub-agent stays one:
 * its signals never make or move a card, as before the label was dropped.
 *
 * REQ-74: a stage a person chose is never overruled. Any move of the card that this feature did not make
 * (the board, the detail view, `kanban card move` by a person or an orchestrator) after the agent joined
 * the card pauses the card's automatic moves; the permission flag and the automatic title still follow
 * the agent. "Resume automatic tracking" in the detail view lifts the pause. Archiving an agent no longer
 * completes its card: the work waits in review until a person moves it to done.
 */

export interface AutoAgent { id: string; workspaceId: string | null; parentAgentId: string | null; cwd: string; title: string | null }
/**
 * What a signal asks for. `create` makes a missing card; the rest update an existing one, or — D33 — make the card of
 * an agent whose `created` found no board (see `late`).
 */
export interface Change { create?: boolean; bucket?: Bucket; awaiting?: boolean; adopt?: boolean; cause?: MoveCause }
/** The smallest part of the Paseo SDK the reconciliation reads; the hook and handler contexts both have it. */
export interface AgentLister {
  agents: { list(options: { filter: { includeArchived: boolean }; page: { limit: number; cursor?: string } }):
    Promise<{ entries: readonly unknown[]; pageInfo: { nextCursor?: string | null | undefined } }>;
    /** One agent's current snapshot. Hook payloads keep the title the agent was created with (measured). */
    ref?(id: string): { refresh(): Promise<unknown> } };
  /** D25: the workspace listing, read only when an agent's own workspace has no board. */
  workspaces?: { list(options: { page: { limit: number; cursor?: string } }):
    Promise<{ entries: readonly unknown[]; pageInfo: { nextCursor?: string | null | undefined } }> };
}
export interface AutoCardsOptions {
  store: Store | Promise<Store>;
  locale: (store: Store) => Promise<Locale>;
  now?: () => string;
  newId?: () => string;
  log?: (message: string, detail?: unknown) => void;
}

/** One signal → one change. `turn_ended` covers completed, failed and canceled alike: the agent stopped and waits. */
export function changeFor(signal: Signal): Change {
  switch (signal) {
    case 'created': return { create: true };
    case 'turn_started': return { bucket: 'working' };
    case 'turn_ended': return { bucket: 'review', awaiting: false };
    case 'permission_requested': return { awaiting: true };
    case 'permission_resolved': return { awaiting: false };
    // REQ-74: an archived agent says nothing about whether its work was accepted; a person decides that.
    case 'archived': return { bucket: 'review', awaiting: false };
  }
}

/**
 * The stage a bucket lands in, by position so custom templates work too: the first open stage waits,
 * the second works, the last open stage is review, and the first completion stage is done.
 */
export function stageFor(stages: readonly Pick<Stage, 'stageId' | 'countsAsDone'>[], bucket: Bucket): string | null {
  const open = stages.filter(s => !s.countsAsDone);
  const done = stages.find(s => s.countsAsDone);
  if (!open.length) return null;
  switch (bucket) {
    case 'waiting': return open[0]!.stageId;
    case 'working': return (open[1] ?? open[0]!).stageId;
    case 'review': return open[open.length - 1]!.stageId;
    case 'done': return done?.stageId ?? null;
  }
}

const TEXT: Record<Locale, { criteria: string; notes: string; fallback: string }> = {
  ko: { criteria: '에이전트가 맡은 작업을 마치고, 사람이 결과를 확인한다.',
    notes: 'Paseo 에이전트가 만들어질 때 자동으로 생긴 카드입니다. 단계는 에이전트 상태를 따라 바뀌고, 사람이 옮기면 그 뒤로는 자동으로 옮기지 않습니다. 완료는 사람이 옮깁니다.',
    fallback: '에이전트 ' },
  en: { criteria: 'The agent finishes its work and a person reviews the result.',
    notes: 'Created automatically when the Paseo agent started. The stage follows the agent\'s status until a person moves the card; completion is a person\'s call.',
    fallback: 'Agent ' },
};
/** A card title from an agent title: one line, at most 200 characters, or null when there is none. */
export function cleanTitle(title: string | null | undefined): string | null {
  if (typeof title !== 'string') return null;
  const line = title.replace(/\s+/g, ' ').trim();
  return line ? [...line].slice(0, 200).join('').trim() : null;
}
export function autoCardText(agent: Pick<AutoAgent, 'id' | 'title'>, locale: Locale) {
  const text = TEXT[locale] ?? TEXT.en;
  return { title: cleanTitle(agent.title) ?? text.fallback + agent.id.slice(0, 8), criteria: text.criteria, notes: text.notes };
}

/** The title in a refreshed snapshot (`{ agent }` or the agent itself), or null. */
function snapshotTitle(value: unknown): string | null {
  const agent = value && typeof value === 'object' && 'agent' in value ? (value as { agent: unknown }).agent : value;
  const title = agent && typeof agent === 'object' ? (agent as { title?: unknown }).title : null;
  return typeof title === 'string' ? title : null;
}
/** A stable UUID per agent and purpose, so a repeated create replays through the ledger's receipts. */
export function uuidFrom(value: string): string {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const addRequest = (agentId: string) => uuidFrom('kanban-auto-card:add:' + agentId);
const linkRequest = (agentId: string) => uuidFrom('kanban-auto-card:link:' + agentId);

// ---- The plugin's own file, beside ui-state.json and never inside a board ----

/**
 * 249-D1/D2: the file is read, parsed, judged and written in one place, server/core/auto-state.ts, so the engine here, the
 * core's export (no PROCESS.md for a board the feature made, nor for one whose maker it cannot tell), the read handlers
 * and the switch saves all see the same rules — and the same `damaged`. The names are kept here for the callers.
 */
export { readAutoState, parseAutoState, writeAutoState, autoMadeBoard, workspaceSetting, designatedLead, leadRecord, AUTO_STATE_FILE, AUTO_STATE_BACKUP, AUTO_STATE_BYTES,
  AGENT_LIMIT, WORKSPACE_LIMIT, AUTO_BOARD_LIMIT } from './core/auto-state.js';
export type { Bucket, Signal, MoveCause, AutoMove, AppliedState, HostSetting, ParentMemory, AutoBoard, AutoState, LeadMark } from './core/auto-state.js';
const FILE = AUTO_STATE_FILE;
/**
 * The switch the daemon obeys. One daemon serves one host, so in practice there is one entry; if several
 * hosts ever share a data directory, the most recent choice wins. Turning it back on moves the start
 * line to that moment, so agents made while it was off are not back-filled.
 */
export function effectiveSetting(state: AutoState): { enabled: boolean; since: string | null } {
  let latest: HostSetting | null = null;
  for (const entry of Object.values(state.hosts)) if (!latest || entry.changedAt > latest.changedAt) latest = entry;
  if (latest && !latest.enabled) return { enabled: false, since: null };
  const since = [state.activatedAt, latest?.changedAt ?? null].filter((v): v is string => !!v).sort().at(-1) ?? null;
  return { enabled: true, since };
}
export const hostEnabled = (state: AutoState, hostId: string) => state.hosts[hostId]?.enabled ?? effectiveSetting(state).enabled;
/**
 * D44/249-D3: of these folders (the boards one answer shows), the ones whose automatic cards are off — each in the spelling
 * the screen knows it by (`normalizeCwd`), judged by the one judgement (`workspaceSetting`). The screen matches its rows by that
 * spelling and never folds two spellings itself. Of a damaged file nothing is known: every folder reads as off.
 */
export const foldersOff = (state: AutoState, cwds: readonly (string | null | undefined)[]): string[] =>
  [...new Set(cwds.filter((v): v is string => !!v).map(normalizeCwd))].filter(cwd => !workspaceSetting(state, [cwd]).enabled).sort();
/** The saved "off" switches, by the spelling they were saved under — a listing of the file, not a judgement (the screens use `foldersOff`); none of a damaged file. */
export const workspacesOff = (state: AutoState): string[] =>
  state.damaged ? [] : [...new Set(Object.entries(state.workspaces ?? {}).filter(([, e]) => !e.enabled).map(([key]) => normalizeCwd(key)))].sort();

const latest = (...times: (string | null | undefined)[]) =>
  times.filter((v): v is string => !!v && !Number.isNaN(Date.parse(v))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
/** D44: made at or after the line, read as times (Paseo's and this daemon's clocks may spell an instant differently). */
const bornSince = (createdAt: string | null | undefined, line: string) => !!createdAt && !Number.isNaN(Date.parse(createdAt)) &&
  Date.parse(createdAt) >= Date.parse(line);

// ---- Reconciliation input ----

/**
 * REQ-83: the statuses Paseo 0.8–0.9 report (protocol `AGENT_LIFECYCLE_STATUSES`). A status outside them, or a field
 * the bucket is read from being absent or of another type, is not guessed at: the agent's automatic move is held
 * (`hold`) and the screen is told (`health`). A later Paseo may mean something else by a new status.
 */
export const KNOWN_STATUSES: readonly string[] = ['initializing', 'idle', 'running', 'error', 'closed'];
export type HoldIssue = 'unknown-status' | 'missing-field' | 'bad-hook';
export interface Hold { issue: HoldIssue; detail: string }
/** A host value quoted in a diagnosis: one line, at most 40 characters — H2: a cut one ends in "…", so it never reads as a typo. */
export const quote = (value: unknown) => { const chars = [...String(value).replace(/\s+/g, ' ')];
  return chars.length > 40 ? chars.slice(0, 39).join('') + '…' : chars.join(''); };
/** One entry of `agents.list`, reduced to what a card needs. The SDK entry has no `parentAgentId`; the label does. */
export interface ListedAgent extends AutoAgent { createdAt: string | null; bucket: Bucket; awaiting: boolean;
  /** D33-b: the latest of `lastUserMessageAt` and `updatedAt`, and whether it is archived — see `newEnough`. */
  activeAt?: string | null; archived?: boolean;
  /** REQ-83: set when the entry cannot be read; `bucket` and `awaiting` then mean nothing and nothing is applied. */
  hold?: Hold }
function listedHold(raw: Record<string, unknown>): Hold | null {
  const archived = raw.archivedAt;
  if (archived !== undefined && archived !== null && typeof archived !== 'string') return { issue: 'missing-field', detail: 'archivedAt' };
  // An archived agent is read from `archivedAt` alone, whatever its status says.
  if (archived) return null;
  if (typeof raw.status !== 'string') return { issue: 'missing-field', detail: 'status' };
  if (!KNOWN_STATUSES.includes(raw.status)) return { issue: 'unknown-status', detail: quote(raw.status) };
  if (!Array.isArray(raw.pendingPermissions)) return { issue: 'missing-field', detail: 'pendingPermissions' };
  if (raw.lastUserMessageAt !== null && typeof raw.lastUserMessageAt !== 'string') return { issue: 'missing-field', detail: 'lastUserMessageAt' };
  return null;
}
export function readListedAgent(entry: unknown): ListedAgent | null {
  const raw = (entry && typeof entry === 'object' && 'agent' in entry ? (entry as { agent: unknown }).agent : entry) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const labels = raw.labels && typeof raw.labels === 'object' ? raw.labels as Record<string, unknown> : {};
  const parent = typeof labels['paseo.parent-agent-id'] === 'string' && labels['paseo.parent-agent-id']
    ? labels['paseo.parent-agent-id'] as string : typeof raw.parentAgentId === 'string' ? raw.parentAgentId : null;
  const hold = listedHold(raw);
  const pending = Array.isArray(raw.pendingPermissions) ? raw.pendingPermissions.length : 0;
  const status = typeof raw.status === 'string' ? raw.status : '';
  const prompted = typeof raw.lastUserMessageAt === 'string' && !!raw.lastUserMessageAt;
  const bucket: Bucket = raw.archivedAt ? 'review' : pending || status === 'running' ? 'working'
    : status === 'initializing' || !prompted ? 'waiting' : 'review';
  return { id: raw.id, workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null, parentAgentId: parent,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '', title: typeof raw.title === 'string' ? raw.title : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null, bucket, awaiting: pending > 0 && !raw.archivedAt,
    activeAt: [raw.lastUserMessageAt, raw.updatedAt].filter((v): v is string => typeof v === 'string' && !!v).sort().at(-1) ?? null,
    archived: !!raw.archivedAt, ...(hold ? { hold } : {}) };
}
/**
 * Whether an agent with no card yet is new enough to get one: made at or after the start line — or, D33-b, made before
 * it but not archived and active after it (an orchestrator still at work when the feature was switched on). Old
 * finished agents stay out.
 */
export function newEnough(agent: Pick<ListedAgent, 'createdAt' | 'activeAt' | 'archived'>, since: string): boolean {
  if (agent.createdAt !== null && agent.createdAt >= since) return true;
  return !agent.archived && !!agent.activeAt && agent.activeAt > since;
}
/**
 * REQ-83: a hook's agent as Paseo 0.8–0.9 hands it over (`PluginHookAgent`), or why it cannot be read. The fields a
 * card is placed by must be there with their types; a title may be missing (it only names the card).
 */
export function readHookAgent(agent: unknown): { agent: AutoAgent; hold: null } | { agent: null; id: string | null; hold: Hold } {
  const raw = agent as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return { agent: null, id: null, hold: { issue: 'bad-hook', detail: 'agent' } };
  const id = typeof raw.id === 'string' && raw.id && raw.id.length <= 256 ? raw.id : null;
  const wrong = !id ? 'id' : raw.parentAgentId !== null && typeof raw.parentAgentId !== 'string' ? 'parentAgentId'
    : raw.workspaceId !== null && typeof raw.workspaceId !== 'string' ? 'workspaceId' : typeof raw.cwd !== 'string' ? 'cwd'
    : raw.title !== undefined && raw.title !== null && typeof raw.title !== 'string' ? 'title' : null;
  if (wrong) return { agent: null, id, hold: { issue: 'bad-hook', detail: wrong } };
  return { agent: { id: id!, workspaceId: raw.workspaceId as string | null, parentAgentId: raw.parentAgentId as string | null,
    cwd: raw.cwd as string, title: typeof raw.title === 'string' ? raw.title : null }, hold: null };
}

// ---- REQ-83: how automatic tracking is doing, for the screens ----

/**
 * `failed`: the agent listing the repair after a restart reads could not be read (an error, a timeout, or an answer
 * of another shape) — tracking may have stopped. `held`: some agents' states or hook inputs could not be read, and
 * their automatic moves wait. Memory only: it describes this daemon's run. `issue`/`detail`/`at` are the latest problem.
 */
export type HealthIssue = HoldIssue | 'list-failed' | 'list-shape';
export interface AutoHealth { state: 'ok' | 'held' | 'failed'; held: number; issue: HealthIssue | null; detail: string | null; at: string | null;
  /** H1: how many of `held` are hook inputs of another shape (not agents' states), so the screen names them apart. */
  inputs?: number }
export const HEALTHY: AutoHealth = { state: 'ok', held: 0, issue: null, detail: null, at: null };
/** Why the listing failed, told apart: an answer of another shape is not a network error. */
class ShapeError extends Error {}

// ---- REQ-74: who moved a card, and whether its automatic moves are paused ----

type MoveRecord = Board['history'][number];
/** What the pause of a card is judged from, per agent entry. */
export type TrackedEntry = readonly [agentId: string, entry: Pick<AppliedState, 'moved' | 'pausedAt' | 'resumedAt'>];
/**
 * Every entry this feature remembers for the card, linked or not. An agent unlinked from the card keeps
 * its entry, so the moves this feature made for it stay automatic: unlinking is not a move (G1).
 */
export function cardEntries(state: AutoState, boardId: string, cardId: string): TrackedEntry[] {
  return Object.entries(state.agents).filter(([, e]) => e.boardId === boardId && e.cardId === cardId);
}
/** The agents of a card this feature tracks: those with a remembered entry for it that are still linked to it. */
export function trackedEntries(state: AutoState, boardId: string, card: Pick<Card, 'id' | 'agents'>): TrackedEntry[] {
  return cardEntries(state, boardId, card.id).filter(([id]) => card.agents.some(a => a.agentId === id));
}
/**
 * The entry whose automatic move a stage record is: it carries the revision this feature last wrote for
 * any of the card's entries — an agent unlinked since included — or, in a state from before REQ-74 that
 * kept no revision, its actor is that entry's agent while still linked to the card.
 */
function automaticMove<E extends TrackedEntry>(record: MoveRecord, card: Pick<Card, 'agents'>, entries: readonly E[]): E | undefined {
  return entries.find(([id, e]) => e.moved ? record.revision === e.moved.revision
    : record.actor.kind === 'agent' && record.actor.agentId === id && card.agents.some(a => a.agentId === id));
}
/**
 * The move that pauses the card's automatic moves, or null. The pause belongs to the card, not to one of
 * its agents: an agent linked later obeys a move made before it joined. `entries` are the card's entries
 * (`cardEntries`). Only real moves count (not the card being added), only after automatic tracking of
 * the card began — the earliest link among its linked agents, so an orchestrator arranging the card
 * before any of them joined is not a choice (REQ-61 ③) — and after the last resume, and only the latest
 * one, unless this feature made it (`automaticMove`). Anything else is somebody's choice: a person on the
 * board or in the detail view, or `kanban card move` by a person, an orchestrator or the agent itself.
 */
export function foreignMove(history: readonly MoveRecord[], card: Pick<Card, 'id' | 'agents'>, entries: readonly TrackedEntry[]): MoveRecord | null {
  const linked = entries.map(([id]) => card.agents.find(a => a.agentId === id)?.linkedAt).filter((v): v is string => !!v).sort();
  if (!linked.length) return null;
  const since = [linked[0]!, ...entries.map(([, e]) => e.resumedAt ?? '')].sort().at(-1)!;
  let last: MoveRecord | null = null;
  for (const record of history) if (record.cardId === card.id && record.from !== null && record.at > since) last = record;
  return last && !automaticMove(last, card, entries) ? last : null;
}
/**
 * REQ-74: when the card's automatic moves were paused, or null while they follow its agents. The one
 * judgement both the engine (whether a signal may move the card) and the detail view (what it shows) use.
 * A pause already kept in the plugin's file counts first, so it outlives the ledger's bounded history;
 * an unlinked agent's kept pause counts too, since unlinking neither pauses nor resumes a card.
 */
export function cardPause(history: readonly MoveRecord[], card: Pick<Card, 'id' | 'agents'>, entries: readonly TrackedEntry[]): string | null {
  const kept = entries.map(([, e]) => e.pausedAt).filter((v): v is string => !!v).sort();
  return kept[0] ?? foreignMove(history, card, entries)?.at ?? null;
}
/** Why the card is where it is: its latest stage record, told apart as this feature's, a person's or another agent's. */
export interface MoveReason { by: 'auto' | 'user' | 'agent'; cause: MoveCause | null; agentId: string | null; at: string; created: boolean }
/** Automatic tracking of one card: following its agent, paused by somebody's move (since when), or switched off. */
export interface Tracking { state: 'on' | 'paused' | 'off'; since: string | null }
export function cardTracking(board: Pick<Board, 'id' | 'history'>, card: Pick<Card, 'id' | 'agents'>, state: AutoState):
  { reason: MoveReason | null; tracking: Tracking | null } {
  const entries = cardEntries(state, board.id, card.id) as [string, AppliedState][];
  const last = board.history.filter(h => h.cardId === card.id).at(-1);
  let reason: MoveReason | null = null;
  if (last) {
    const mine = automaticMove(last, card, entries);
    reason = mine ? { by: 'auto', cause: mine[1].moved?.revision === last.revision ? mine[1].moved.cause : null, agentId: mine[0], at: last.at, created: last.from === null }
      : { by: last.actor.kind, cause: null, agentId: last.actor.kind === 'agent' ? last.actor.agentId : null, at: last.at, created: last.from === null };
  }
  if (!trackedEntries(state, board.id, card).length) return { reason, tracking: null };
  if (!effectiveSetting(state).enabled) return { reason, tracking: { state: 'off', since: null } };
  const paused = cardPause(board.history, card, entries);
  return { reason, tracking: paused ? { state: 'paused', since: paused } : { state: 'on', since: null } };
}

// ---- The engine ----

export type Outcome = 'child' | 'disabled' | 'no-board' | 'no-card' | 'archived-card' | 'unlinked' | 'created' | 'updated' | 'unchanged' | 'paused'
  /** REQ-83: the hook's agent could not be read; nothing was written. */
  | 'held';
/** REQ-83: after the three tries of a restart's repair failed, it may be tried again this long after the last failure. */
export const RECONCILE_RETRY_MS = 5 * 60_000;
/**
 * H5: a listing that failed on the way (not one that answered in another shape, which waits for a new Paseo) is tried
 * again as soon as Paseo is seen answering — a readable hook, or another read of Paseo that succeeded — once this long
 * has passed since the failure, so the screens' "could not be read" goes within a look of the connection coming back.
 */
export const RECOVERY_RETRY_MS = 30_000;

export function createAutoCards(options: AutoCardsOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;
  const log = options.log ?? ((message: string, detail?: unknown) => console.warn('[kanban auto-cards] ' + message, detail ?? ''));
  const startedAt = now();
  const storePromise = Promise.resolve(options.store);

  // The state file has its own chain: queues of different workspaces may finish at the same time.
  let stateChain: Promise<unknown> = Promise.resolve();
  const withState = <T>(task: (state: AutoState) => Promise<{ value: T; changed: boolean }>): Promise<T> => {
    const run = stateChain.then(async () => {
      const dataDir = (await storePromise).dataDir;
      const state = await readAutoState(dataDir);
      // 247-D1: a file that cannot be read is neither judged from nor written over; the caller hears of it.
      if (state.damaged) throw new Error(FILE + ' could not be read; it is not written over.');
      const result = await task(state);
      if (result.changed) await writeAutoState(dataDir, state);
      return result.value;
    });
    stateChain = run.catch(() => {});
    return run;
  };
  const readState = async () => readAutoState((await storePromise).dataDir);
  /**
   * 247-D2: the policy queue. Making a card or a board — from reading the switches and marks as they are now to its last
   * write — and saving a switch take turns here, so a switch saved before a card is made is always read by it, and a card
   * made first lands before the switch is answered. Paseo is asked before a task enters (it can take seconds).
   * Order: policy → a folder's board queue (`serially`) → the ledger → `withState`; never the other way round.
   */
  let policyChain: Promise<unknown> = Promise.resolve();
  const policy = <T>(task: () => Promise<T>): Promise<T> => {
    const run = policyChain.then(task, task);
    policyChain = run.catch(() => {});
    return run;
  };
  /** 247-D1: a damaged `auto-cards.json` stops every card, move and board; the screens say so as a held input. */
  const STATE_HOLD = 'file:' + FILE;
  const unreadable = (state: AutoState) => {
    if (!state.damaged) { holds.delete(STATE_HOLD); return false; }
    hold(STATE_HOLD, { issue: 'missing-field', detail: FILE }, 'state'); return true;
  };
  /** D44: the first run of this version, kept once in the file so a restart never moves it. */
  const floorOf = (state: AutoState) => state.autoBoardFloor ?? startedAt;
  let floorKept = false;
  const keepFloor = async (state: AutoState) => {
    if (floorKept || state.autoBoardFloor) { floorKept = true; return; }
    await withState(async current => {
      if (current.autoBoardFloor) return { value: undefined, changed: false };
      current.autoBoardFloor = startedAt; return { value: undefined, changed: true };
    });
    state.autoBoardFloor = startedAt; floorKept = true;
  };
  /**
   * D44: the line an agent must be created at or after to make a board, or to get a card on a board this feature made:
   * this version's first run, the host switch turned back on, the workspace's switch turned back on — the latest.
   */
  const bornLine = (state: AutoState, cwds: readonly (string | null | undefined)[]) =>
    latest(floorOf(state), effectiveSetting(state).since, workspaceSetting(state, cwds).since)!;

  // REQ-83: what could not be read, per agent ('' for a hook whose agent has no id), and the listing's last failure.
  const holds = new Map<string, Hold & { at: string }>();
  let listFailure: { issue: HealthIssue; detail: string; at: string } | null = null;
  const hold = (key: string, value: Hold, what: string) => {
    if (!holds.has(key)) log(what + ' held: ' + value.issue + ' ' + value.detail, key || undefined);
    holds.set(key, { ...value, at: now() });
  };
  function health(): AutoHealth {
    const inputs = [...holds.values()].filter(h => h.issue === 'bad-hook').length;
    if (listFailure) return { state: 'failed', held: holds.size, ...listFailure, ...(inputs ? { inputs } : {}) };
    const latest = [...holds.values()].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    return latest ? { state: 'held', held: holds.size, issue: latest.issue, detail: latest.detail, at: latest.at, ...(inputs ? { inputs } : {}) } : HEALTHY;
  }

  // Serial queue per workspace: a card's create always finishes before its first move is looked at.
  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  };
  const queueKey = (agent: AutoAgent) => agent.workspaceId ?? 'cwd:' + folderKey(agent.cwd);
  /** REQ-74: a second queue per board, entered from a workspace queue (never the other way round) and by a resume. */
  const boardKey = (boardId: string) => 'board:' + boardId;

  // Boards unchanged since the last scan are not read again (same stamp idea as the read handlers).
  const boardCache = new Map<string, { stamp: string; board: Board }>();
  async function readBoardSafe(store: Store, id: string, stamp?: string): Promise<Board | null> {
    const cached = boardCache.get(id);
    if (stamp && cached?.stamp === stamp) return cached.board;
    try {
      const board = await store.readBoard(id);
      if (stamp) boardCache.set(id, { stamp, board }); else boardCache.delete(id);
      return board;
    } catch { boardCache.delete(id); return null; }
  }
  /** The card that already carries this agent: the one remembered first, otherwise any board's. */
  async function locate(store: Store, agentId: string, remembered: AppliedState | undefined) {
    if (remembered) {
      const board = await readBoardSafe(store, remembered.boardId);
      const card = board?.cards.find(c => c.id === remembered.cardId && c.agents.some(a => a.agentId === agentId));
      if (board && card) return { board, card };
    }
    let archived: { board: Board; card: Card } | null = null;
    const { entries } = await store.statBoards().catch(() => ({ entries: [] as { id: string; stamp: string }[] }));
    for (const entry of entries) {
      const board = await readBoardSafe(store, entry.id, entry.stamp);
      for (const card of board?.cards ?? []) {
        if (!card.agents.some(a => a.agentId === agentId)) continue;
        if (card.archivedAt === null) return { board: board!, card };
        archived ??= { board: board!, card };
      }
    }
    return archived;
  }
  /**
   * Only an existing board: by Paseo workspace id, else the one board at the same directory (D22), else —
   * for an agent in a worktree workspace — the board at that project's root folder (D25). The worktree's
   * own board always wins; with neither, nothing is written and no board is made.
   */
  async function boardFor(store: Store, agent: AutoAgent, paseo?: AgentLister): Promise<string | null> {
    const identities = await store.listBoardIdentities();
    const byId = agent.workspaceId ? identities.find(b => b.workspaceId === agent.workspaceId) : undefined;
    if (byId) return byId.id;
    const at = (cwd: string) => sameFolder(identities, cwd, b => b.cwd)?.id ?? null;
    // D44: a board's folder is its real path; an agent in a symbolic link to it is in the same folder.
    const own = agent.cwd ? at(agent.cwd) ?? await realCwd(store, agent.cwd).then(real => real ? at(real) : null) : null;
    if (own || !paseo?.workspaces) return own;
    const root = await worktreeRoot(paseo.workspaces, agent);
    return root ? at(root) : null;
  }
  /** D44: folders whose board could not be made, and when; not tried again for a minute (a missing folder, a refusal). */
  const unmade = new Map<string, number>();
  /**
   * D44: the board for an agent whose workspace has none, made now — or null, and nothing is written. Only for a workspace
   * Paseo lists (`target`, from `workspaceTarget`: the folder Paseo names, never the agent's say); the caller has checked
   * the switches and the agent, inside the policy queue. One queue per real folder, shared with a person's first card
   * (`board.ensure`), and the boards are looked at again inside it: two agents of one new folder starting together leave
   * one board. 247-D1: the folder is marked in `boardIntents` before the board is made — no mark, no board — and the mark
   * moves to the board's id after, so the board is never without its quiet rule (no PROCESS.md, no older chats), even
   * when a write after it fails. Marks are never pushed out; past `AUTO_BOARD_LIMIT` no board is made.
   */
  async function autoBoard(store: Store, agent: AutoAgent, target: { cwd: string; workspaceId: string | null }, state: AutoState): Promise<string | null> {
    let real: string;
    try { real = normalizeCwd(await store.assertAllowedPath(target.cwd)); } catch { return null; }
    const key = folderKey(real);
    const failedAt = unmade.get(key);
    if (failedAt !== undefined && Date.parse(now()) - failedAt < 60_000) return null;
    return serially(boardCreateKey(real), async () => {
      const identities = await store.listBoardIdentities();
      const found = (target.workspaceId ? identities.find(b => b.workspaceId === target.workspaceId) : undefined) ??
        sameFolder(identities, real, b => b.cwd) ?? sameFolder(identities, target.cwd, b => b.cwd);
      if (found) return found.id;
      if (Object.keys(state.boards ?? {}).length + Object.keys(state.boardIntents ?? {}).length >= AUTO_BOARD_LIMIT) {
        log('no board for ' + real + ': ' + AUTO_BOARD_LIMIT + ' boards made already'); return null;
      }
      try {
        await withState(async current => {
          current.boardIntents ??= {};
          current.boardIntents[key] = { cwd: real, agentId: agent.id, at: now() };
          return { value: undefined, changed: true };
        });
      } catch (error) { log('board for ' + real + ' not made: its mark could not be kept', describe(error)); return null; }
      let init: Awaited<ReturnType<Store['initBoard']>>;
      try {
        init = await store.initBoard({ cwd: real, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
          actor: { kind: 'user' }, requestId: uuidFrom('kanban-auto-board:' + real), export: false });
      } catch (error) {
        unmade.set(key, Date.parse(now()));
        log('board for ' + real + ' failed', describe(error));
        // The mark goes only when no board is there; if it cannot go, it keeps a later board of the folder quiet (safe).
        const after = await store.listBoardIdentities().catch(() => null);
        if (after && !sameFolder(after, real, b => b.cwd)) await forget(key).catch(() => {});
        return null;
      }
      const boardId = init.data.boardId;
      unmade.delete(key);
      if (!init.data.changed && !init.data.replayed) { await forget(key).catch(() => {}); return boardId; }
      // One write moves the mark to the board's id; if it fails, the folder's mark stays and the board stays quiet.
      await withState(async current => {
        current.boards ??= {}; current.boardIntents ??= {};
        current.boards[boardId] ??= { cwd: real, agentId: agent.id, at: now() };
        delete current.boardIntents[key];
        return { value: undefined, changed: true };
      }).catch(error => log('board ' + boardId + ' keeps its folder mark', describe(error)));
      log('made a board for ' + real, boardId);
      return boardId;
    });
  }
  const forget = (key: string) => withState(async current => {
    if (!current.boardIntents?.[key]) return { value: undefined, changed: false };
    delete current.boardIntents[key]; return { value: undefined, changed: true };
  });
  const remember = (agentId: string, entry: Omit<AppliedState, 'at'>) => withState(async state => {
    const before = state.agents[agentId];
    const next = { ...entry, at: now() };
    const same = before && before.boardId === next.boardId && before.cardId === next.cardId && before.bucket === next.bucket &&
      before.awaiting === next.awaiting && before.title === next.title && (before.moved?.revision ?? null) === (next.moved?.revision ?? null) &&
      (before.pausedAt ?? null) === (next.pausedAt ?? null) && (before.resumedAt ?? null) === (next.resumedAt ?? null);
    if (same) return { value: undefined, changed: false };
    state.agents[agentId] = next;
    if (!state.activatedAt) state.activatedAt = startedAt;
    return { value: undefined, changed: true };
  });
  /**
   * REQ-76: keeps the parent each sub-agent had when first seen. An agent already remembered keeps its first parent,
   * so a label Paseo later drops or changes never undoes the grouping. Written whether or not auto cards are on: it
   * makes and moves no card. Answers the remembered map after the write.
   */
  const rememberParents = (pairs: readonly (readonly [agentId: string, parentAgentId: string])[]) =>
    withState<Record<string, ParentMemory>>(async state => {
      state.parents ??= {};
      let changed = false;
      for (const [id, parent] of pairs) {
        if (!isText(id, 64) || !isText(parent, 64) || id === parent || state.parents[id]) continue;
        state.parents[id] = { parentAgentId: parent, at: now() }; changed = true;
      }
      return { value: state.parents, changed };
    });

  /**
   * `birth` answers Paseo's own record of the agent (from the listing, or its snapshot asked once). D44 reads it to make a
   * board and to keep older agents off a board this feature made; D33 to judge a late card.
   *
   * 247-D2: Paseo is asked first; then, in the policy queue, the switches, the marks and the agent's own record are read
   * again as they are now and the card (and board) are made only if they still allow it. A switch saved meanwhile, or a
   * board another signal made meanwhile (with its start line), is obeyed.
   * 247-D3: a board this feature made (or makes) takes only an agent Paseo confirms: its record read, created at or after
   * the start line, not archived and not a sub-agent. Without that record nothing is made — fail closed. A board made by
   * `kanban init` keeps REQ-61: a `created` signal makes the card without asking Paseo.
   */
  async function create(store: Store, agent: AutoAgent, change: Change, paseo?: AgentLister, late = false,
    birth?: () => Promise<Birth | null>): Promise<Outcome> {
    const boardId = await boardFor(store, agent, paseo);
    const target = boardId ? null : paseo?.workspaces && birth ? await workspaceTarget(paseo.workspaces, agent) : null;
    if (!boardId && !target) return 'no-board';
    if (birth && (target || late || autoMadeBoard(await readState(), await store.readBoard(boardId!)))) await birth();
    return policy(async () => {
      let current = await readState();
      if (unreadable(current)) return 'held';
      if (!effectiveSetting(current).enabled) return 'disabled';
      if (current.parents?.[agent.id]) return 'child';
      const remembered = current.agents[agent.id];
      if (late && remembered) return 'no-card';
      /** Whether Paseo's record lets the agent onto a board this feature made, at these folders' start line. */
      const confirmed = async (cwds: readonly (string | null | undefined)[]) => {
        const record = birth ? await birth() : null;
        return !!record && !record.archived && record.parentAgentId === null && bornSince(record.createdAt, bornLine(current, cwds));
      };
      let id = boardId;
      if (!id) {
        if (!workspaceSetting(current, [agent.cwd, target!.cwd]).enabled) return 'disabled';
        if (!await confirmed([agent.cwd, target!.cwd])) return 'no-board';
        id = await autoBoard(store, agent, target!, current);
        if (!id) return 'no-board';
        current = await readState();
        if (unreadable(current)) return 'held';
      }
      const actor = { kind: 'agent' as const, agentId: agent.id };
      const board = await store.readBoard(id);
      // D44: the workspace's switch, by the board's folder too (a worktree's card on its root's board).
      if (!workspaceSetting(current, [agent.cwd, board.cwd, target?.cwd]).enabled) return 'disabled';
      // D44: a board this feature made takes only agents made after the start line — an older chat never joins it.
      if (autoMadeBoard(current, board)) { if (!await confirmed([agent.cwd, board.cwd])) return 'no-card'; }
      else if (late) {
        // D33: judged again from the switches as they are now (a switch turned back on since moves the start line).
        const record = birth ? await birth() : null;
        const since = latest(effectiveSetting(current).since ?? startedAt, workspaceSetting(current, [agent.cwd, board.cwd]).since)!;
        if (!record || record.archived || record.parentAgentId !== null || !newEnough(record, since)) return 'no-card';
      }
      const addId = addRequest(agent.id);
      const receipt = board.receipts.find(r => r.requestId === addId);
      let cardId = receipt?.cardIds[0];
      const bucket = change.bucket ?? 'waiting';
      const text = autoCardText(agent, await options.locale(store));
      let moved: AutoMove | null = null;
      if (cardId && board.cards.some(c => c.id === cardId)) {
        // Made before. If it was linked and remembered, a person unlinked it since — respect that. D33: a late card
        // is only ever made for an agent nothing is remembered for, so a card made before means the same.
        if (remembered?.cardId === cardId || late) return 'unlinked';
      } else {
        const stageId = stageFor(board.template.stages, bucket) ?? board.template.stages[0]!.stageId;
        const added = await store.mutateBoard(id, { actor, requestId: addId, operations: normalizeOperations([{
          op: 'add', title: text.title, acceptanceCriteria: text.criteria, notes: text.notes, intent: 'requested', stageId,
          ...(change.awaiting ? { awaiting: 'user' } : {}) }]) });
        cardId = added.data.cardIds[0];
        moved = { cause: change.cause ?? 'created', revision: added.data.revision, at: now() };
      }
      if (!cardId) return 'no-card';
      // The link is its own commit (an add cannot carry agents); a retry after a crash picks it up here.
      await store.mutateBoard(id, { actor, requestId: linkRequest(agent.id),
        operations: normalizeOperations([{ op: 'link', id: cardId, agentId: agent.id, role: 'worker' }]) });
      await remember(agent.id, { boardId: id, cardId, bucket, awaiting: !!change.awaiting, title: text.title,
        moved: moved ?? remembered?.moved ?? null, pausedAt: null, resumedAt: null });
      return 'created';
    });
  }

  /** Brings one existing card up to date. Writes only what differs from what was last applied. */
  async function update(store: Store, agent: AutoAgent, change: Change, board: Board, card: Card,
    state: AutoState, lookup?: () => Promise<string | null>): Promise<Outcome> {
    const remembered = state.agents[agent.id];
    const known = remembered?.boardId === board.id && remembered.cardId === card.id ? remembered : undefined;
    const next: Omit<AppliedState, 'at'> = { boardId: board.id, cardId: card.id, bucket: known?.bucket ?? null,
      awaiting: known?.awaiting ?? false, title: known?.title ?? null, moved: known?.moved ?? null,
      pausedAt: known?.pausedAt ?? null, resumedAt: known?.resumedAt ?? null };
    // REQ-74: a move outside automatic tracking since it began on the card (or since the last resume)
    // pauses the card for all its agents, this one too if it joined later. The same judgement as the
    // detail view's. The time is kept here too, so the pause outlives the ledger's bounded history.
    const entries: TrackedEntry[] = [...cardEntries(state, board.id, card.id).filter(([id]) => id !== agent.id), [agent.id, next]];
    next.pausedAt = cardPause(board.history, card, entries);
    const operations: Operation[] = [];
    const patch: { awaiting?: 'user' | null; title?: string } = {};
    let held = false, to: string | null = null;
    if (change.bucket && change.bucket !== next.bucket) {
      to = stageFor(board.template.stages, change.bucket);
      // A card this feature never touched (for example linked by the orchestrator) is adopted during
      // reconciliation: its current place is kept, nothing counts as applied, and the next live signal
      // moves it (measured: otherwise the turn_started that triggered the listing was swallowed).
      if (change.adopt && !known) { /* adopt only */ }
      // Paused: the stage stays where the person put it, and the bucket is not taken as applied either.
      else if (next.pausedAt) held = true;
      else {
        if (to && to !== card.stageId) operations.push({ op: 'move', id: card.id, to });
        next.bucket = change.bucket;
      }
    }
    if (change.awaiting === true && card.awaiting !== 'user' && !(change.adopt && !known)) {
      patch.awaiting = 'user'; next.awaiting = true;
    } else if (change.awaiting === false && next.awaiting) {
      // Only the flag this feature raised is lowered; a person's own "awaiting" stays.
      if (card.awaiting === 'user') patch.awaiting = null;
      next.awaiting = false;
    }
    // REQ-61 ⑦: follow a renamed agent (the orchestrator starts as "/orchestrator") while the card still
    // carries the title this feature wrote. Hook payloads keep the creation title, so the current one is
    // looked up — once per finished turn, and only for a card whose title is still automatic. A hook's
    // own title is never used here: it would put the old name back. The reconciliation list is current.
    let title = change.adopt ? cleanTitle(agent.title) : null;
    if (known?.title && card.title === known.title && lookup) title = cleanTitle(await lookup()) ?? title;
    if (known?.title && card.title === known.title && title && title !== card.title) { patch.title = title; next.title = title; }
    if (Object.keys(patch).length) operations.push({ op: 'update', id: card.id, patch });
    if (operations.length) {
      const result = await store.mutateBoard(board.id, { actor: { kind: 'agent', agentId: agent.id },
        requestId: newId(), operations: normalizeOperations(operations) });
      if (operations.some(o => o.op === 'move')) next.moved = { cause: change.cause ?? 'reconcile', revision: result.data.revision, at: now() };
    }
    await remember(agent.id, next);
    return operations.length ? 'updated' : held && to !== card.stageId ? 'paused' : 'unchanged';
  }

  async function apply(agent: AutoAgent & { createdAt?: string | null }, change: Change, lookup?: () => Promise<string | null>,
    paseo?: AgentLister, born?: () => Promise<unknown>): Promise<Outcome> {
    if (agent.parentAgentId !== null) return 'child';
    const state = await readState();
    if (unreadable(state)) return 'held';
    // REQ-76: a sub-agent whose parent label Paseo has since dropped (detach) is still a sub-agent.
    if (state.parents?.[agent.id]) return 'child';
    if (!effectiveSetting(state).enabled) return 'disabled';
    await keepFloor(state);
    // D44: switched off for the agent's workspace: no card, no move, no board.
    if (!workspaceSetting(state, [agent.cwd]).enabled) return 'disabled';
    const store = await storePromise;
    const remembered = state.agents[agent.id];
    const found = await locate(store, agent.id, remembered);
    if (found && found.card.archivedAt !== null) return 'archived-card';
    if (found && !workspaceSetting(state, [found.board.cwd]).enabled) return 'disabled';
    // REQ-74: a card's agents may run in different workspaces, and a resume may come in at any time, so
    // the pause is judged and written for one board at a time, from the board and state as they are now.
    if (found) return enqueue(boardKey(found.board.id), async () => {
      const current = await readState();
      if (!effectiveSetting(current).enabled) return 'disabled';
      const board = await store.readBoard(found.board.id);
      if (!workspaceSetting(current, [agent.cwd, board.cwd]).enabled) return 'disabled';
      const card = board.cards.find(c => c.id === found.card.id && c.agents.some(a => a.agentId === agent.id));
      if (!card) return 'no-card';
      if (card.archivedAt !== null) return 'archived-card';
      return update(store, agent, change, board, card, current, lookup);
    });
    // D44/247-D3: Paseo's record of the agent — the listing's, or its snapshot asked once (null when it cannot be read).
    let asked: Promise<Birth | null> | null = null;
    const listed = agent as Partial<ListedAgent>;
    const birth = agent.createdAt !== undefined ? async (): Promise<Birth> => ({ createdAt: agent.createdAt ?? null,
      activeAt: listed.activeAt ?? null, archived: !!listed.archived, parentAgentId: agent.parentAgentId, title: agent.title })
      : born ? () => asked ??= born().then(value => snapshotBirth(value, agent.id), () => null) : undefined;
    if (change.create) return create(store, agent, change, paseo, false, birth);
    return late(store, agent, change, state, remembered, paseo, birth);
  }

  /** D33: agents asked about and found never to get a late card (older than the start line, archived, a sub-agent). */
  const settled = new Set<string>();
  /** D44: agents asked about and found too old (or archived, or a sub-agent) to make a board; they still join one made later. */
  const boardless = new Set<string>();
  /**
   * D33: an agent whose `created` came while its workspace had no board (an orchestrator runs `kanban init` a minute
   * later) gets its card at its next live signal once there is one, in the stage that signal means. Only a top-level
   * agent nothing is remembered for — an unlinked, archived-card or switched-off agent never gets here — new enough
   * (`newEnough`: made at or after the start line, or D33-b active after it) and not archived, which the hook cannot tell (its payload has no creation time), so Paseo is
   * asked once. An agent that has gone quiet sends no signal and gets nothing: boards do not suddenly fill up.
   */
  async function late(store: Store, agent: AutoAgent, change: Change, state: AutoState, remembered: AppliedState | undefined,
    paseo?: AgentLister, birth?: () => Promise<Birth | null>): Promise<Outcome> {
    if (remembered || change.adopt || change.cause === 'archived' || !birth || settled.has(agent.id)) return 'no-card';
    // D44: with no board, a workspace Paseo lists may still get one, for an agent new enough to make it.
    const existing = await boardFor(store, agent, paseo);
    if (!existing && (!paseo?.workspaces || boardless.has(agent.id))) return 'no-card';
    const current = await birth();
    if (!current) return 'no-card';
    if (!existing) {
      if (current.archived || current.parentAgentId !== null || !bornSince(current.createdAt, bornLine(state, [agent.cwd]))) {
        boardless.add(agent.id); return 'no-card';
      }
    } else {
      // D44: a board this feature made takes only agents made after the start line (no D33-b "active since"). A first
      // look from the state read with the signal; `create` judges again from the state as it is then (247-D2).
      const since = latest(effectiveSetting(state).since ?? startedAt, workspaceSetting(state, [agent.cwd]).since)!;
      const fresh = autoMadeBoard(state, await store.readBoard(existing)) ? bornSince(current.createdAt, bornLine(state, [agent.cwd])) : newEnough(current, since);
      if (current.archived || current.parentAgentId !== null || !fresh) { settled.add(agent.id); return 'no-card'; }
    }
    // A permission is asked for in the middle of a turn. The title is the current one: the hook's is the creation title.
    const outcome = await create(store, { ...agent, title: current.title ?? agent.title }, { ...change, bucket: change.bucket ?? 'working' },
      paseo, true, birth);
    return outcome === 'no-board' ? 'no-card' : outcome;
  }

  let reconciling: Promise<void> | null = null;
  let attempts = 0;
  /**
   * After a restart the missed signals are gone for good (the daemon does not replay), so the first hook
   * or the first board read lists the agents once and repairs their cards. Only agents new enough (`newEnough`)
   * get a new card; older finished ones never flood a board.
   */
  async function reconcile(paseo: AgentLister): Promise<number> {
    const state = await readState();
    // 247-D1: nothing is listed or written while the file cannot be read; the attempt is not spent.
    if (unreadable(state)) return -1;
    const setting = effectiveSetting(state);
    if (!setting.enabled) return -1;
    const since = setting.since ?? startedAt;
    await keepFloor(state);
    if (!state.activatedAt) await withState(async s => {
      if (s.activatedAt) return { value: undefined, changed: false };
      s.activatedAt = startedAt; return { value: undefined, changed: true };
    });
    const listed: ListedAgent[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    // REQ-83: a listing that fails part way, or answers in another shape, applies nothing — an agent missing from a
    // partial listing is never taken as gone or finished (a whole listing's absences are not read that way either).
    try {
      if (typeof paseo.agents?.list !== 'function') throw new ShapeError('agents.list is not available');
      for (let page = 0; page < 30; page++) {
        const result = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        if (!result || !Array.isArray(result.entries) || !result.pageInfo || typeof result.pageInfo !== 'object')
          throw new ShapeError('agents.list answered in an unknown shape');
        for (const entry of result.entries) { const agent = readListedAgent(entry); if (agent) listed.push(agent); }
        cursor = result.pageInfo.nextCursor ?? undefined;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
    } catch (error) {
      listFailure = { issue: error instanceof ShapeError ? 'list-shape' : 'list-failed', detail: quote(describe(error)), at: now() };
      throw error;
    }
    listFailure = null;
    // REQ-76: every listed sub-agent's parent is kept, the ones made before this version too.
    const parents = await rememberParents(listed.flatMap(a => a.parentAgentId !== null ? [[a.id, a.parentAgentId] as const] : []));
    // D44: an agent's own workspace switched back on moves its start line too.
    const sinceFor = (a: ListedAgent) => latest(since, workspaceSetting(state, [a.cwd]).since)!;
    const candidates = listed.filter(a => a.parentAgentId === null && !parents[a.id] &&
      (state.agents[a.id] || newEnough(a, sinceFor(a))));
    // REQ-83: an agent whose state cannot be read keeps its card where it is (or gets none yet) until it can be read.
    for (const agent of candidates) if (agent.hold) hold(agent.id, agent.hold, 'reconcile ' + agent.id); else holds.delete(agent.id);
    const wanted = candidates.filter(a => !a.hold)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    await Promise.all(wanted.map(agent => enqueue(queueKey(agent), () =>
      apply(agent, { create: newEnough(agent, sinceFor(agent)), bucket: agent.bucket, awaiting: agent.awaiting, adopt: true, cause: 'reconcile' },
        undefined, paseo)
        .catch(error => { log('reconcile ' + agent.id + ' failed', describe(error)); return 'unchanged' as const; }))));
    return wanted.length;
  }
  const ensureReconciled = (paseo: AgentLister | undefined, answering = false): Promise<void> => {
    if (!paseo) return Promise.resolve();
    // REQ-83: a listing that failed three times is not given up for the daemon's life; it is tried again after a pause —
    // H5: a short one when Paseo was just seen answering and the failure was the connection's.
    if (!reconciling && attempts >= 3 && listFailure) {
      const since = Date.parse(now()) - Date.parse(listFailure.at);
      if (since >= RECONCILE_RETRY_MS || answering && listFailure.issue === 'list-failed' && since >= RECOVERY_RETRY_MS) attempts = 2;
    }
    if (!reconciling && attempts < 3) {
      attempts++;
      // While switched off nothing is listed, and the attempt is not spent.
      reconciling = reconcile(paseo).then(count => { if (count < 0) { reconciling = null; attempts--; } },
        error => { log('reconcile failed', describe(error)); reconciling = null; });
    }
    return reconciling ?? Promise.resolve();
  };

  return {
    /**
     * The hook entry point. Never throws and never makes the daemon wait: the returned promise is for
     * tests only. A pending reconciliation is listed first, so its repairs land before this signal.
     */
    signal(input: unknown, signal: Signal, paseo?: AgentLister): Promise<Outcome | 'failed'> {
      try {
        // REQ-83: a hook's agent that cannot be read moves nothing; the screens say so instead.
        const read = readHookAgent(input);
        if (!read.agent) { hold(read.id ?? '', read.hold, signal); return Promise.resolve('held'); }
        const agent = read.agent;
        holds.delete(agent.id); holds.delete('');
        // REQ-76: a sub-agent makes no card; its parent is only remembered, for the screen's grouping.
        if (agent.parentAgentId !== null) return rememberParents(typeof agent.id === 'string' && typeof agent.parentAgentId === 'string'
          ? [[agent.id, agent.parentAgentId]] : []).then(() => 'child' as const,
          error => { log('parent ' + agent.id + ' failed', describe(error)); return 'child' as const; });
        const change: Change = { ...changeFor(signal), cause: signal };
        // H5: a readable hook is Paseo answering, so a listing that failed on the way is tried again now.
        const ready = paseo ? ensureReconciled(paseo, true) : Promise.resolve();
        const handle = paseo?.agents.ref;
        const refresh = handle ? () => fetchSnapshot(() => handle.call(paseo!.agents, agent.id).refresh()) : undefined;
        const lookup = refresh && signal === 'turn_ended' ? async () => snapshotTitle(await refresh()) : undefined;
        return ready.catch(() => {}).then(() => enqueue(queueKey(agent), () => apply(agent, change, lookup, paseo, refresh)))
          .catch(error => { log(signal + ' ' + agent.id + ' failed', describe(error)); return 'failed' as const; });
      } catch (error) {
        log(signal + ' failed', describe(error));
        return Promise.resolve('failed');
      }
    },
    /** First board read after a restart: repair in the background, never delay the screen. */
    wake(paseo: AgentLister | undefined): void {
      try { void ensureReconciled(paseo).catch(() => {}); } catch { /* never reaches the RPC */ }
    },
    /** REQ-83: how automatic tracking is doing in this daemon, for the read RPCs. */
    health,
    /**
     * v0.1.46-B: this version's first run (`autoBoardFloor`, kept once) for the dispatch's fallback — a request made before
     * it never falls back to the newest agent. Null when the file cannot be read or written: no fallback (fail closed).
     */
    async dispatchFloor(): Promise<string | null> {
      try {
        const state = await readState();
        if (state.damaged) return null;
        await keepFloor(state);
        return floorOf(state);
      } catch (error) { log('dispatch start line failed', describe(error)); return null; }
    },
    /** H5: another read of Paseo (the workspace listing) just succeeded; a listing that failed on the way is tried again. */
    answered(paseo: AgentLister | undefined): void {
      try { if (listFailure) void ensureReconciled(paseo, true).catch(() => {}); } catch { /* never reaches the RPC */ }
    },
    async isEnabled(hostId: string): Promise<boolean> {
      try { return hostEnabled(await readState(), hostId); } catch { return true; }
    },
    setEnabled(hostId: string, enabled: boolean): Promise<{ enabled: boolean; changed: boolean }> {
      return policy(() => withState<{ enabled: boolean; changed: boolean }>(async state => {
        // Choosing what is already in force writes nothing and keeps the start line where it was.
        if (hostEnabled(state, hostId) === enabled) return { value: { enabled, changed: false }, changed: false };
        state.hosts[hostId] = { enabled, changedAt: now() };
        if (!state.activatedAt) state.activatedAt = startedAt;
        return { value: { enabled, changed: true }, changed: true };
      }));
    },
    /**
     * D44: the switch of one workspace, by its folder. Off stops its cards, their moves and its automatic board; back on,
     * only agents made from then on get cards. Choosing what is already in force writes nothing.
     * 249-D3: the switch is saved under the folder's spelling (`normalizeCwd`) and judged by `folderSwitch`. "Off" is always
     * saved under its own spelling, even when another spelling of the folder is already off: on a Windows directory that
     * tells case apart those may be two folders, and each must keep its own switch. "On" turns on only its own spelling;
     * when the folder has no switch under its own spelling and another spelling of it is off, whether that is the same
     * folder cannot be told here, so the save is refused (`E_CONFLICT`) instead of turning a folder on that somebody turned
     * off — turn it on in the spelling it was turned off in, or turn this spelling off and then on.
     */
    setWorkspaceEnabled(cwd: string, enabled: boolean): Promise<{ enabled: boolean; changed: boolean }> {
      const spelled = normalizeCwd(cwd), key = folderKey(cwd);
      // 247-D2: in the policy queue, so a card or board being made either lands before this switch or reads it.
      return policy(() => withState<{ enabled: boolean; changed: boolean }>(async state => {
        state.workspaces ??= {};
        const own = Object.keys(state.workspaces).filter(k => normalizeCwd(k) === spelled);
        const latestOwn = own.map(k => state.workspaces![k]!).sort((a, b) => a.changedAt.localeCompare(b.changedAt)).at(-1) ?? null;
        const others = Object.keys(state.workspaces).filter(k => folderKey(k) === key && normalizeCwd(k) !== spelled);
        if (enabled) {
          if (workspaceSetting(state, [cwd]).enabled) return { value: { enabled, changed: false }, changed: false };
          if (!latestOwn) {
            const off = others.filter(k => !state.workspaces![k]!.enabled);
            fail('E_CONFLICT', 'Automatic cards for this folder were switched off under another spelling of it.', cwd,
              `Turn them on for ${off.join(', ')}, or turn this folder off and then on.`);
          }
        } else if (latestOwn && !latestOwn.enabled) return { value: { enabled, changed: false }, changed: false };
        // 247-D5: no other folder's switch is pushed out to make room; a further folder's switch is refused and nothing changes.
        if (!own.length && Object.keys(state.workspaces).length >= WORKSPACE_LIMIT)
          fail('E_LIMIT', `At most ${WORKSPACE_LIMIT} workspaces can have their own automatic-card switch.`, cwd,
            'Every workspace switched off, or on again, keeps an entry in ' + FILE + ' in the plugin\'s data directory. ' +
            'Stop Paseo, remove the entries of folders you no longer use from "workspaces" there (and in ' + AUTO_STATE_BACKUP + '), then try again.');
        // 247-D4: one folder keeps one entry per spelling, whatever spelling an older entry of it was kept in.
        for (const k of own) delete state.workspaces[k];
        state.workspaces[spelled] = { enabled, changedAt: now() };
        if (!state.activatedAt) state.activatedAt = startedAt;
        return { value: { enabled, changed: true }, changed: true };
      }));
    },
    /**
     * REQ-137 (research/273 B): a person marks a card's chat as the lead of its board's workspace (`lead: true`), or takes the
     * mark off (`false`). The chat is the card's first agent; the mark is kept under the board's folder (`leads`, by
     * `normalizeCwd` of the board's `cwd` — a worktree's chat on its project root's board under the root, D25), one per
     * folder, so marking another chat moves it. Taking it off from a card whose chat is not the marked one changes nothing.
     * A sub-agent (REQ-76 `parents`) cannot be marked. Only this plugin's file changes, in the policy queue like the switches;
     * the ledger is only read. A damaged file is never written over (the save fails, nothing changes).
     * 281 F2: taken off, the folder keeps `{ agentId: null, changedAt }` — when the mark last changed, for `dispatchMode`. Such an
     * entry is the one that makes room when the file is full (the oldest first); a mark never is.
     */
    setLead(boardId: string, cardId: string, lead: boolean): Promise<{ lead: string | null; previous: string | null; changed: boolean }> {
      return policy(async () => {
        const board = await (await storePromise).readBoard(boardId);
        const card = board.cards.find(c => c.id === cardId);
        if (!card) fail('E_NOT_FOUND', 'Card not found.', cardId, 'Refresh the board.');
        const agentId = card.agents.find(a => !!a.agentId)?.agentId ?? null;
        const key = normalizeCwd(board.cwd);
        return withState<{ lead: string | null; previous: string | null; changed: boolean }>(async state => {
          state.leads ??= {};
          const previous = state.leads[key]?.agentId ?? null;
          if (!lead) {
            if (!previous || !card.agents.some(a => a.agentId === previous)) return { value: { lead: previous, previous, changed: false }, changed: false };
            state.leads[key] = { agentId: null, changedAt: now() };
            return { value: { lead: null, previous, changed: true }, changed: true };
          }
          if (card.archivedAt !== null) fail('E_VALIDATION', 'An archived card cannot be marked as the lead.', cardId, 'Restore the card first.');
          if (!agentId) fail('E_VALIDATION', 'This card has no chat to mark as the lead.', cardId, 'Link a chat to the card first.');
          if (Object.hasOwn(state.parents ?? {}, agentId)) fail('E_VALIDATION', 'A sub-chat cannot be marked as the lead.', cardId, 'Mark its lead\'s card instead.');
          if (previous === agentId) return { value: { lead: agentId, previous, changed: false }, changed: false };
          // 247-D5: no other folder's mark is pushed out to make room — only the oldest record of a mark taken off (281 F2).
          const off = Object.entries(state.leads).filter(([, v]) => v.agentId === null).sort((a, b) => a[1].changedAt.localeCompare(b[1].changedAt))[0];
          if (!state.leads[key] && Object.keys(state.leads).length >= WORKSPACE_LIMIT && off) delete state.leads[off[0]];
          if (!state.leads[key] && Object.keys(state.leads).length >= WORKSPACE_LIMIT)
            fail('E_LIMIT', `At most ${WORKSPACE_LIMIT} workspaces can have a marked lead.`, board.cwd,
              'Take the mark off the leads of workspaces you no longer use, then try again.');
          state.leads[key] = { agentId, changedAt: now() };
          return { value: { lead: agentId, previous, changed: true }, changed: true };
        });
      });
    },
    /**
     * REQ-74: "resume automatic tracking" for one card. Moves before this moment stop counting and the
     * bucket is forgotten, so the agent's next signal places the card again. The card stays where it is
     * until then. Only this plugin's file is written; the ledger is not touched. The pause is the card's,
     * so every agent entry of the card resumes; it waits in the board's queue, so a signal being handled
     * for the card cannot write its older entry back over the resume.
     */
    resume(boardId: string, cardId: string): Promise<{ resumed: number }> {
      return enqueue(boardKey(boardId), () => withState<{ resumed: number }>(async state => {
        const at = now();
        let resumed = 0;
        for (const entry of Object.values(state.agents)) {
          if (entry.boardId !== boardId || entry.cardId !== cardId) continue;
          entry.resumedAt = at; entry.pausedAt = null; entry.bucket = null; entry.at = at;
          resumed++;
        }
        return { value: { resumed }, changed: resumed > 0 };
      }));
    },
    /** Waits until every queued signal has been handled (tests and shutdown). */
    async idle(): Promise<void> {
      for (let round = 0; round < 100; round++) {
        await (reconciling ?? Promise.resolve());
        if (!queues.size) break;
        await Promise.all([...queues.values()]);
      }
      await stateChain;
    },
  };
}
/**
 * D25: the root folder of the project whose worktree workspace the agent runs in, or null when that
 * workspace is not a worktree or cannot be found. The workspace is matched by id first, then by
 * directory; the listing is the one Paseo serves, read at most 10 pages and given up on after 5s.
 */
export async function worktreeRoot(workspaces: NonNullable<AgentLister['workspaces']>, agent: Pick<AutoAgent, 'workspaceId' | 'cwd'>): Promise<string | null> {
  const found = await findWorkspace(workspaces, agent);
  return found ? rootOf(found.row) : null;
}
type WorkspaceRow = Record<string, unknown>;
/**
 * D25/D44: the agent's workspace row in Paseo's listing (by id first, then by directory, archiving rows skipped by
 * directory) and every row read, or null when it cannot be found. At most 10 pages, given up on after 5s.
 */
async function findWorkspace(workspaces: NonNullable<AgentLister['workspaces']>, agent: Pick<AutoAgent, 'workspaceId' | 'cwd'>):
  Promise<{ row: WorkspaceRow; rows: WorkspaceRow[] } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const rows: WorkspaceRow[] = [];
    let byId: WorkspaceRow | null = null, cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = await workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      for (const entry of result.entries) {
        const w = entry as WorkspaceRow | null;
        if (!w || typeof w !== 'object') continue;
        rows.push(w);
        if (agent.workspaceId && w.id === agent.workspaceId) byId ??= w;
      }
      cursor = result.pageInfo.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    // 247-D4: by directory, the same spelling first, else one differing only in a Windows path's case.
    const row = byId ?? (agent.cwd ? sameFolder(rows.filter(w => !w.archivingAt), agent.cwd, directoryOf) : undefined);
    return row ? { row, rows } : null;
  };
  try {
    return await Promise.race([read().catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
const directoryOf = (w: WorkspaceRow) => typeof w.workspaceDirectory === 'string' ? w.workspaceDirectory : null;
/**
 * D22/247-D4: the one row (a board, a workspace) at this folder: the same spelling (`normalizeCwd`) first, else the one whose
 * folder differs only in a Windows path's case (`folderKey`). Rows at two folders differing only in case (a case-sensitive
 * Windows directory) are two folders, and a third spelling takes neither.
 */
export function sameFolder<T>(rows: readonly T[], cwd: string, folderOf: (row: T) => string | null | undefined): T | undefined {
  const spelled = normalizeCwd(cwd);
  const exact = rows.find(r => { const f = folderOf(r); return !!f && normalizeCwd(f) === spelled; });
  if (exact) return exact;
  const key = folderKey(cwd);
  const folded = rows.filter(r => { const f = folderOf(r); return !!f && folderKey(f) === key; });
  return new Set(folded.map(r => normalizeCwd(folderOf(r)!))).size === 1 ? folded[0] : undefined;
}
const WORKSPACE_ID = /^(wks_[A-Za-z0-9_-]{1,128}|local_[0-9a-f]{64})$/;
/**
 * D44: where a board for the agent's workspace belongs — the folder Paseo names for that workspace and its id, or, for a
 * worktree, its project's root folder (D25) and the id of the root's own workspace when Paseo lists one. Null when the
 * workspace is not listed, is being archived, or names no folder.
 */
export async function workspaceTarget(workspaces: NonNullable<AgentLister['workspaces']>, agent: Pick<AutoAgent, 'workspaceId' | 'cwd'>):
  Promise<{ cwd: string; workspaceId: string | null } | null> {
  const found = await findWorkspace(workspaces, agent);
  if (!found || found.row.archivingAt || found.row.archivedAt) return null;
  const root = rootOf(found.row);
  if (root) {
    const home = sameFolder(found.rows.filter(w => w.workspaceKind !== 'worktree' && !w.archivingAt && !w.archivedAt), root, directoryOf);
    return { cwd: root, workspaceId: typeof home?.id === 'string' && WORKSPACE_ID.test(home.id) ? home.id : null };
  }
  const cwd = typeof found.row.workspaceDirectory === 'string' && found.row.workspaceDirectory ? found.row.workspaceDirectory
    : typeof found.row.projectRootPath === 'string' ? found.row.projectRootPath : '';
  if (!cwd) return null;
  return { cwd, workspaceId: typeof found.row.id === 'string' && WORKSPACE_ID.test(found.row.id) ? found.row.id : null };
}
/** D44: the agent's folder with symbolic links followed, or null (not absolute here, protected, unreadable). */
async function realCwd(store: Store, cwd: string): Promise<string | null> {
  if (!path.isAbsolute(cwd)) return null;
  try { return await store.assertAllowedPath(cwd); } catch { return null; }
}
function rootOf(workspace: Record<string, unknown>): string | null {
  return workspace.workspaceKind === 'worktree' && typeof workspace.projectRootPath === 'string' && workspace.projectRootPath
    ? workspace.projectRootPath : null;
}
/** Never holds the queue for long and never fails the signal: no answer in 5s means null ("keep the known title"). */
async function fetchSnapshot(refresh: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([refresh().catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}
/** D33/D44: what a late card or a board this feature made judges an agent by — Paseo's record of it, never the hook's say. */
interface Birth { createdAt: string | null; activeAt: string | null; archived: boolean; parentAgentId: string | null; title: string | null }
/** D33: what a late card is judged by, from one agent's refreshed snapshot, or null when it is not that agent's. */
function snapshotBirth(value: unknown, id: string): Birth | null {
  const listed = readListedAgent(value);
  if (!listed || listed.id !== id) return null;
  return { createdAt: listed.createdAt, activeAt: listed.activeAt ?? null, title: listed.title, parentAgentId: listed.parentAgentId,
    archived: !!listed.archived };
}
const describe = (error: unknown) => error instanceof Error ? error.name + ': ' + error.message : String(error);
export type AutoCards = ReturnType<typeof createAutoCards>;
