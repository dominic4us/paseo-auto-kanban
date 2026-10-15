import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { createKanbanError, dispatchStage, isKanbanError, normalizeOperations, type Board, type Card, type Locale } from '../shared/core/domain.js';
import { normalizeCwd } from '../shared/rpc.js';
import { dispatchHeld, dispatchMessage, isTopicRole, leadRank, type DispatchHeld } from '../shared/dispatch.js';
import type { Store } from './core/store.js';
import { designatedLead, readAutoState } from './core/auto-state.js';
import { readHookAgent, sameFolder, type Signal } from './auto-cards.js';

/**
 * REQ-97: a draft a person moved to the working stage (after the confirmation sheet) is sent to the workspace's lead
 * as a prompt — only while the lead is idle, because a message sent during a turn cuts that turn off (research/152 ②).
 *
 * - The lead: the newest unarchived top-level agent of the board's workspace (its id, or its directory) whose title
 *   starts with "총괄-" or whose `profile` label starts with "총괄_" (`pickLead`). REQ-137: or "Lead-" / "Lead_" in any
 *   case — and before any of them, the chat a person marked as the lead (`auto-cards.json` `leads`, the card ⋯ "Mark as
 *   lead"), while it is listed (not archived), top-level and admitted; archived, the next rule takes over until it is
 *   restored. One judgement for the server and the screens: `leadRank` (shared/dispatch.ts). A file that cannot be read
 *   knows no mark (fail closed: the lead by name alone, and no fallback).
 * - v0.1.46-B (research/239, P1): no such lead, the newest unarchived top-level agent there that is not a topic lead —
 *   a sub-agent remembered in `auto-cards.json` (REQ-76 `parents`) counts as a sub-agent — so a person who never named
 *   a lead still gets the request delivered (`fallback`). Only a card requested at or after this version's first run
 *   (`fallbackFloor`, D44's `autoBoardFloor`) goes to it: a card left waiting for a lead before the upgrade is not
 *   sent all at once to whichever agent is newest. A file that cannot be read means no fallback (fail closed).
 *   No agent at all: the card says so (`noLead`) and is tried again at the next signal of an agent there.
 * - 253-D1: a worktree workspace whose cards land on its project root's board (D25, no board of its own) counts as that
 *   board's workspace too — its agents come after the board's own, so a chat of the root folder is asked first.
 * - 253-D2: a card keeps the agent the person confirmed in the sheet (`targetAgentId` from the start). It goes to that agent
 *   while it is still one to send to, even when a newer chat opens meanwhile; once it is not, only a lead by name takes the
 *   card — never another chat nobody confirmed (it waits, `targetGone`).
 * - 255-D2: a chat whose workspace Paseo is archiving (or has archived) takes no request — Paseo marks the workspace first
 *   and archives its chats a moment later, so such a chat can still look alive. Told by Paseo's workspace listing; a
 *   worktree's chat is asked only when that listing is read (none when it cannot be), a chat of the board's own workspace as before.
 * - 253-D3: why a card waits with nobody to go to (`DispatchHeld`) is told apart when read: no agent, requested before the
 *   start line, the start line unreadable, the confirmed agent gone.
 * - 257 (research/258): whether a request may go to a chat *now* is one question with one answer (`admission`), asked the same
 *   way when candidates are chosen, when the sheet previews, and right before `send` — of the agent, the board, Paseo's
 *   workspace listing *and how much of it was read* (`WorkspaceListing`). What was read is kept: a row read before a later
 *   page failed still closes its chats. What was not read is not guessed: a chat whose workspace the listing did not name
 *   while the listing is incomplete (a page failed, the time ran out, or the host has no listing) is neither sent to nor
 *   written off — the card is left as it is (`listing`) and looked at again at the next signal or sweep.
 * - When: right after the confirmation, at every `turn_ended` (after a short grace, so a person about to type is not
 *   overtaken), when an agent is created or archived, and — at most every `sweepMs` — on a board read, which repairs
 *   what a restart missed. The lead's own snapshot is read again (`refresh()`) before anything is sent: idle, no
 *   active turn, no permission asked for, not archived (a message to an archived agent brings it back, research/152 ⑤).
 * - Once: one card per idle moment (a second message would cut off the turn the first one started), sent with the
 *   request's `messageId` (the daemon refuses a repeat with `agent_request_key_conflict`), then recorded `sent` by a
 *   compare-and-set on the board's revision — in the same write the agent it went to is linked to the card (once), so
 *   the card shows who has it even when that agent never runs the kanban CLI (research/239 decision (다)). Every board has its own serial queue, so one daemon never sends twice.
 * - Nothing leaves a hook: every failure is caught and logged; the card simply stays `pending`.
 */
export type DispatchOutcome = 'none' | 'noLead' | 'busy' | 'sent' | 'failed' | 'list-failed';
/** `fallback`: not a lead by name, the workspace's newest agent (v0.1.46-B). */
export interface LeadAgent { id: string; title: string; createdAt: string; cwd: string; workspaceId: string | null; fallback: boolean }
interface ListedLead extends Omit<LeadAgent, 'fallback'> { profile: string; role?: string; parent: string | null; archived: boolean }
/** The smallest part of the Paseo SDK the dispatch uses; the hook and handler contexts both have it. */
export interface DispatchApi {
  agents: {
    list(options: { filter: { includeArchived: boolean }; page: { limit: number; cursor?: string } }):
      Promise<{ entries: readonly unknown[]; pageInfo: { nextCursor?: string | null | undefined } }>;
    ref(id: string): { refresh(): Promise<unknown>; send(text: string, options?: { messageId?: string }): Promise<void> };
  };
  workspaces?: { list(options: { page: { limit: number; cursor?: string } }):
    Promise<{ entries: readonly unknown[]; pageInfo: { nextCursor?: string | null | undefined } }> };
}
export interface DispatcherOptions {
  store: Store | Promise<Store>;
  log?: (message: string, detail?: unknown) => void;
  /** How long after a `turn_ended` the lead's state is read again before sending. */
  graceMs?: number;
  /** The least time between two sweeps of every board on a board read. */
  sweepMs?: number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** The board's language for the message (`readLocale`); Korean when not given or unreadable. */
  locale?: (store: Store) => Promise<Locale>;
  /**
   * v0.1.46-B: the line a card must be requested at or after to go to a fallback agent — this version's first run
   * (`AutoCards.dispatchFloor`). Not given: the `autoBoardFloor` already kept in `auto-cards.json`. Null: no fallback.
   */
  fallbackFloor?: () => Promise<string | null>;
}

const text = (value: unknown) => typeof value === 'string' ? value : '';
/** One `agents.list` entry (`{ agent }` or the agent itself), reduced to what finding the lead needs. */
export function readLeadEntry(entry: unknown): ListedLead | null {
  const raw = (entry && typeof entry === 'object' && 'agent' in entry ? (entry as { agent: unknown }).agent : entry) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const labels = raw.labels && typeof raw.labels === 'object' ? raw.labels as Record<string, unknown> : {};
  const parent = text(labels['paseo.parent-agent-id']) || text(raw.parentAgentId) || null;
  return { id: raw.id, title: text(raw.title), createdAt: text(raw.createdAt), cwd: text(raw.cwd),
    workspaceId: text(raw.workspaceId) || null, profile: text(labels.profile), role: text(labels.role), parent, archived: !!raw.archivedAt };
}
/**
 * A lead: the chat marked as the workspace's lead (REQ-137 `designated`), or a lead by name — titled "총괄-…"/"Lead-…" or
 * given a "총괄_…"/"Lead_…" profile — top-level and not archived, and not a topic lead by its `role` label (REQ-117,
 * research/191 D1), which is never the workspace's lead even when it has no parent mark (`leadRank`).
 */
export function isLeadAgent(agent: Pick<ListedLead, 'title' | 'profile' | 'role' | 'parent' | 'archived'> & { id?: string },
  designated?: string | null): boolean {
  return !agent.archived && leadRank(agent, designated) !== null;
}
/**
 * v0.1.46-B: an agent a request may fall back to — top-level by its own record and by the parents this plugin remembers
 * (REQ-76), not archived, and not a topic lead (REQ-117).
 */
export function isFallbackAgent(agent: Pick<ListedLead, 'id' | 'role' | 'parent' | 'archived'>, parents: Readonly<Record<string, unknown>>): boolean {
  return !agent.archived && !agent.parent && !Object.hasOwn(parents, agent.id) && !isTopicRole(agent.role);
}
/** Whether an agent is in the board's own workspace: the same id, or the same directory. */
export function inBoardWorkspace(agent: Pick<ListedLead, 'workspaceId' | 'cwd'>, board: Pick<Board, 'workspaceId' | 'cwd'>): boolean {
  return agent.workspaceId === board.workspaceId || (!!agent.cwd && normalizeCwd(agent.cwd) === normalizeCwd(board.cwd));
}
const asTarget = (a: ListedLead, fallback: boolean): LeadAgent =>
  ({ id: a.id, title: a.title, createdAt: a.createdAt, cwd: a.cwd, workspaceId: a.workspaceId, fallback });
/**
 * The agent a board's requests go to: REQ-137 the chat marked as its lead (`designated`) when it is among `agents`, a lead
 * and in the board's workspace or a related worktree; else a lead by name in its workspace (same id, or same directory), the
 * newest if there are several; with `parents` given and no lead, the newest fallback agent there (`fallback: true`).
 * 253-D1: `related` — an agent of a worktree whose cards land on this board — is asked after the board's own workspace, at each step.
 */
export function pickLead(agents: readonly ListedLead[], board: Pick<Board, 'workspaceId' | 'cwd'>,
  parents?: Readonly<Record<string, unknown>> | null, related: (agent: ListedLead) => boolean = () => false,
  designated?: string | null): LeadAgent | null {
  const here = (a: ListedLead) => inBoardWorkspace(a, board);
  const near = (a: ListedLead) => !here(a) && related(a);
  const newest = (list: ListedLead[]) => list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0];
  const marked = designated ? agents.find(a => a.id === designated && (here(a) || near(a)) && isLeadAgent(a, designated)) : undefined;
  const lead = marked ?? newest(agents.filter(a => isLeadAgent(a) && here(a))) ?? newest(agents.filter(a => isLeadAgent(a) && near(a)));
  const found = lead ?? (parents ? newest(agents.filter(a => isFallbackAgent(a, parents) && here(a))) ??
    newest(agents.filter(a => isFallbackAgent(a, parents) && near(a))) : undefined);
  return found ? asTarget(found, !lead) : null;
}
export type WorkspaceRow = Record<string, unknown>;
/**
 * 257: Paseo's workspace listing as it was read for one judgement — the rows, and how much of the listing they are.
 * `complete`: every page was read. `partial`: some pages (maybe none) were read before an error, the time limit or the page
 * cap — what was read is kept and holds, what was not read is unknown. `none`: the host offers no listing, so nothing is known.
 */
export interface WorkspaceListing { rows: readonly WorkspaceRow[]; read: 'complete' | 'partial' | 'none' }
export const COMPLETE_LISTING = (rows: readonly WorkspaceRow[]): WorkspaceListing => ({ rows, read: 'complete' });
const folderOf = (w: WorkspaceRow) => typeof w.workspaceDirectory === 'string' ? w.workspaceDirectory : null;
/** 255-D2: a workspace Paseo is archiving or has archived. */
const closing = (w: WorkspaceRow) => !!w.archivingAt || !!w.archivedAt;
/** The listing's row for the workspace an agent works in: by id, else by folder (an open row for the folder before a closing one). */
const rowOf = (agent: Pick<ListedLead, 'workspaceId' | 'cwd'>, rows: readonly WorkspaceRow[]): WorkspaceRow | undefined =>
  (agent.workspaceId ? rows.find(w => w.id === agent.workspaceId) : undefined) ??
  (agent.cwd ? sameFolder(rows.filter(w => !closing(w)), agent.cwd, folderOf) ?? sameFolder(rows, agent.cwd, folderOf) : undefined);
/**
 * 255-D2 / 257: what Paseo's listing says of the workspace an agent works in. `closing`: its row is being archived (or is).
 * `open`: its row is not — or the listing is complete and names no such workspace (nothing to archive). `unknown`: the listing
 * names it not and is incomplete (257-D1: a row read before a later page failed still counts; one never read is not guessed).
 * Only whether the agent takes requests: the board its cards land on (`boardOfAgent`, as automatic cards choose it) is apart.
 */
export type WorkspaceAccess = 'open' | 'closing' | 'unknown';
export function workspaceAccess(agent: Pick<ListedLead, 'workspaceId' | 'cwd'>, listing: WorkspaceListing): WorkspaceAccess {
  const row = rowOf(agent, listing.rows);
  if (row) return closing(row) ? 'closing' : 'open';
  return listing.read === 'complete' ? 'open' : 'unknown';
}
/** 255-D2 (kept for its callers): whether an agent's workspace is being archived (or is), by a listing taken as complete. */
export function inClosingWorkspace(agent: Pick<ListedLead, 'workspaceId' | 'cwd'>, rows: readonly WorkspaceRow[]): boolean {
  return workspaceAccess(agent, COMPLETE_LISTING(rows)) === 'closing';
}
/**
 * 257: the one answer to "may a request of this board go to this chat now?" — asked of every candidate, of the agent the sheet
 * shows, and of the very agent right before `send`, always from one listing. `yes`: in the board's own workspace (same id or
 * folder) or a worktree whose cards land here (`related`), and that workspace is open. `closing`: its workspace is being
 * archived — not one to send to, whoever it is (255-D2). `unknown`: its workspace is not in an incomplete listing — neither
 * sent to nor written off. `outside`: another workspace's chat. Whether the agent itself takes cards (a lead by name, a fallback
 * agent under the start line, archived, a sub-agent) is the caller's — this is only the workspace's side of the question.
 */
export type Admission = 'yes' | 'closing' | 'unknown' | 'outside';
export function admission(agent: Pick<ListedLead, 'workspaceId' | 'cwd'>, board: Pick<Board, 'workspaceId' | 'cwd'>, listing: WorkspaceListing,
  related: (agent: Pick<ListedLead, 'workspaceId' | 'cwd'>) => boolean = () => false): Admission {
  const access = workspaceAccess(agent, listing);
  if (access === 'closing') return 'closing';
  if (inBoardWorkspace(agent, board)) return access === 'open' ? 'yes' : 'unknown';
  // A worktree's relation to this board is read from its row: with the row, it is known; without one, only when the listing is whole.
  if (related(agent)) return 'yes';
  return access === 'unknown' ? 'unknown' : 'outside';
}
/**
 * 253-D1: the board an agent's cards land on, as automatic cards choose it (auto-cards `boardFor`, D22/D25) from one
 * listing of Paseo's workspaces: the board of its workspace id, else of its folder, else — for a worktree workspace — the
 * board at its project's root folder. Null with none.
 */
export function boardOfAgent(agent: Pick<ListedLead, 'workspaceId' | 'cwd'>, boards: readonly { id: string; workspaceId: string | null; cwd: string }[],
  rows: readonly WorkspaceRow[]): string | null {
  const byId = agent.workspaceId ? boards.find(b => b.workspaceId === agent.workspaceId) : undefined;
  const own = byId ?? (agent.cwd ? sameFolder(boards, agent.cwd, b => b.cwd) : undefined);
  if (own) return own.id;
  const row = (agent.workspaceId ? rows.find(w => w.id === agent.workspaceId) : undefined) ??
    (agent.cwd ? sameFolder(rows.filter(w => !w.archivingAt), agent.cwd, folderOf) : undefined);
  const root = row?.workspaceKind === 'worktree' && typeof row.projectRootPath === 'string' ? row.projectRootPath : '';
  return root ? sameFolder(boards, root, b => b.cwd)?.id ?? null : null;
}
/** 281 F1: the server's answer of who leads a board's workspace now — the board views' `summary.leadNow`. */
export type LeadNow = { agentId: string | null; title: string; by: 'set' | 'name' | null; mark?: 'archived' | 'unusable' };
/**
 * 281 F1: who leads a board's workspace now, as a draft finds it — the very `pickLead` of `targetOf` over the chats the listing
 * admits (`admission`, 257): the mark first, then by name, the board's own workspace before a related worktree's, the newest
 * chat by its own `createdAt` (never a card's). `by`: `set` when the marked chat is the one, `name` for a lead by name, null
 * with neither (a fallback or nobody — the screens' own words). `mark`: why a kept mark is not in effect — `archived` (not
 * listed, and its own snapshot says so), else `unusable` (another board's chat, a sub-chat, a topic lead, a closing workspace).
 * Null — not judged — when the marked chat's workspace is not in an incomplete listing (257-D1: what was not read is not guessed).
 */
export function judgeLead(listed: readonly ListedLead[], board: Pick<Board, 'workspaceId' | 'cwd'>, listing: WorkspaceListing,
  related: (agent: Pick<ListedLead, 'workspaceId' | 'cwd'>) => boolean, designated: string | null, archived = false): LeadNow | null {
  const admit = (a: ListedLead) => admission(a, board, listing, related);
  const marked = designated ? listed.find(a => a.id === designated) : undefined;
  if (marked && admit(marked) === 'unknown') return null;
  const lead = pickLead(listed.filter(a => admit(a) === 'yes'), board, null, related, designated);
  const by = !lead ? null : designated && lead.id === designated ? 'set' as const : 'name' as const;
  return { agentId: lead?.id ?? null, title: lead?.title ?? '', by,
    ...(designated && by !== 'set' ? { mark: !marked && archived ? 'archived' as const : 'unusable' as const } : {}) };
}
/** v0.1.46-B: whether a card may go to this agent — a lead by name takes every card, a fallback agent only those requested since `floor`. */
export function takesCard(target: Pick<LeadAgent, 'fallback'> | null, requestedAt: string, floor: string | null): boolean {
  if (!target) return false;
  if (!target.fallback) return true;
  const at = Date.parse(requestedAt), since = floor ? Date.parse(floor) : NaN;
  return !Number.isNaN(at) && !Number.isNaN(since) && at >= since;
}
/** The cards of a board waiting to be sent, the one requested first first. */
export function waitingCards(board: Pick<Board, 'cards'>): Card[] {
  return board.cards.filter(c => c.archivedAt === null && (c.dispatch?.state === 'pending' || c.dispatch?.state === 'noLead'))
    .sort((a, b) => a.dispatch!.requestedAt.localeCompare(b.dispatch!.requestedAt) || a.id.localeCompare(b.id));
}
/**
 * What a refreshed snapshot says about sending now. `idle`: no turn, nothing asked, not archived. A snapshot that
 * cannot be read counts as busy (wait for the next signal), one that names no agent as gone.
 */
export function leadReadiness(snapshot: unknown): 'idle' | 'busy' | 'archived' | 'gone' {
  if (snapshot === null) return 'gone';
  const agent = (snapshot && typeof snapshot === 'object' && 'agent' in snapshot ? (snapshot as { agent: unknown }).agent : snapshot) as Record<string, unknown> | null;
  if (!agent || typeof agent !== 'object') return 'busy';
  if (agent.archivedAt) return 'archived';
  const permissions = agent.pendingPermissions;
  return agent.status === 'idle' && (agent.activeTurn === null || agent.activeTurn === undefined) &&
    (!Array.isArray(permissions) || permissions.length === 0) ? 'idle' : 'busy';
}
/** The daemon refused a message id it has already seen: that request was delivered before. */
export const alreadyDelivered = (error: unknown) => /agent_request_key_conflict/.test(String((error as { code?: unknown })?.code ?? '') + ' ' +
  String(error instanceof Error ? error.message : error));

export function createDispatcher(options: DispatcherOptions) {
  const log = options.log ?? ((message: string, detail?: unknown) => console.warn('[kanban dispatch] ' + message, detail ?? ''));
  const graceMs = options.graceMs ?? 3000, sweepMs = options.sweepMs ?? 30000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const newId = options.newId ?? randomUUID;
  const storePromise = Promise.resolve(options.store);
  const USER = { kind: 'user' as const };

  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  };

  async function listAgents(paseo: DispatchApi): Promise<ListedLead[]> {
    const listed: ListedLead[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 30; page++) {
      const result = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      if (!result || !Array.isArray(result.entries)) throw new Error('agents.list answered in an unknown shape');
      for (const entry of result.entries) { const agent = readLeadEntry(entry); if (agent) listed.push(agent); }
      cursor = result.pageInfo?.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return listed;
  }
  /** The board's name as Paseo shows it (the workspace's title), from the listing the judgement used (257: one read for both), else its folder. */
  function boardTitle(listing: WorkspaceListing | null, board: Board): string {
    const folder = path.basename(normalizeCwd(board.cwd)) || board.workspaceId;
    for (const raw of listing?.rows ?? []) {
      const dir = text(raw?.workspaceDirectory) || text(raw?.projectRootPath);
      if (raw?.id === board.workspaceId || (dir && normalizeCwd(dir) === normalizeCwd(board.cwd)))
        return text(raw.title).trim() || text(raw.name).trim() || folder;
    }
    return folder;
  }
  async function refreshed(paseo: DispatchApi, id: string): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([paseo.agents.ref(id).refresh(),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000); })]);
    } catch { return undefined; } finally { if (timer) clearTimeout(timer); }
  }
  /** v0.1.46-B: what a fallback needs — the start line and the remembered parents — or null (no fallback) when either cannot be read. */
  async function fallbackRule(store: Store): Promise<{ floor: string; parents: Readonly<Record<string, unknown>> } | null> {
    try {
      const state = await readAutoState(store.dataDir);
      if (state.damaged) return null;
      const floor = options.fallbackFloor ? await options.fallbackFloor() : state.autoBoardFloor ?? null;
      // 253-D3: a start line that is not a time cannot be read either.
      return floor && !Number.isNaN(Date.parse(floor)) ? { floor, parents: state.parents ?? {} } : null;
    } catch (error) { log('the fallback start line could not be read; no fallback', String(error)); return null; }
  }
  /** REQ-137: the chat marked as the board's lead, or null — none, or the file unreadable (fail closed: by name alone). */
  async function markedLead(store: Store, board: Board): Promise<string | null> {
    try { return designatedLead(await readAutoState(store.dataDir), board.cwd); }
    catch (error) { log('the marked lead could not be read; the lead is found by name', String(error)); return null; }
  }
  async function localeOf(store: Store): Promise<Locale> {
    try { return options.locale ? await options.locale(store) : 'ko'; } catch { return 'ko'; }
  }
  /**
   * 253-D1 / 257: Paseo's workspaces, read once for one judgement (at most 10 pages, given up on after 5s). The rows read
   * before an error, the time limit or the page cap are kept and the listing is said to be `partial` (257-D1); a host without
   * the listing gives `none`. Only a listing read to its last page is `complete`.
   */
  async function readWorkspaces(paseo: DispatchApi): Promise<WorkspaceListing> {
    if (!paseo.workspaces) return { rows: [], read: 'none' };
    const rows: WorkspaceRow[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<WorkspaceListing['read']> => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await paseo.workspaces!.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        if (!result || !Array.isArray(result.entries)) throw new Error('workspaces.list answered in an unknown shape');
        // Each row is copied: a judgement reads the listing as it was at this read, not as the host's object changes later.
        for (const w of result.entries) if (w && typeof w === 'object') rows.push({ ...(w as WorkspaceRow) });
        cursor = result.pageInfo?.nextCursor ?? undefined;
        if (!cursor) return 'complete';
        if (seen.has(cursor)) return 'partial';
        seen.add(cursor);
      }
      return 'partial';
    };
    try {
      const outcome = await Promise.race([read().catch(error => { log('workspaces.list failed; what was read is kept', String(error)); return 'partial' as const; }),
        new Promise<'partial'>(resolve => { timer = setTimeout(() => resolve('partial'), 5000); })]);
      return { rows: [...rows], read: outcome };
    } finally { if (timer) clearTimeout(timer); }
  }
  /** 253-D1: which agents outside the board's own workspace have their cards on this board (a worktree's, D25). */
  async function relatedTo(store: Store, board: Board, agents: readonly ListedLead[], rows: readonly WorkspaceRow[]): Promise<(agent: Pick<ListedLead, 'workspaceId' | 'cwd'>) => boolean> {
    if (!agents.some(a => !inBoardWorkspace(a, board))) return () => false;
    const boards = await store.listBoardIdentities();
    return agent => boardOfAgent(agent, boards, rows) === board.id;
  }
  /**
   * Who takes the board's cards now, from one workspace listing (257: the same judgement, `admission`, for every candidate
   * and for a confirmed agent — the sheet and the moment before `send` call this again with their own listing): the target
   * (a lead by name, else — with the start line read — the fallback agent), the rule a fallback is held to (null: unreadable),
   * and `forCard`, the agent one card goes to (253-D2: the one it was confirmed for while it still may) or why it waits
   * (253-D3; 257: `listing` — its chat's workspace is not in an incomplete listing, so nothing is said of it yet).
   */
  async function targetOf(paseo: DispatchApi, store: Store, listed: readonly ListedLead[], board: Board, listing?: WorkspaceListing) {
    listing ??= await readWorkspaces(paseo);
    const related = await relatedTo(store, board, listed, listing.rows);
    const admit = (a: ListedLead) => admission(a, board, listing!, related);
    // 255-D2: a chat of a workspace being archived is not one to send to — not a lead, not a fallback, not a confirmed agent.
    const agents = listed.filter(a => admit(a) === 'yes');
    // 257-D1: while some chat's workspace is unread, "no agent" and "chat closed" cannot be said — a lead by name may be among them.
    const uncertain = listed.some(a => admit(a) === 'unknown');
    const designated = await markedLead(store, board);
    const named = pickLead(agents, board, null, related, designated);
    const rule = await fallbackRule(store);
    const target = named ?? (rule ? pickLead(agents, board, rule.parents, related) : null);
    const floor = rule?.floor ?? null;
    /** Whether the agent itself takes this card: a lead (marked or by name) always, a fallback agent under the start line. */
    const takes = (a: ListedLead, dispatch: { requestedAt: string }): 'lead' | 'fallback' | null => isLeadAgent(a, designated) ? 'lead'
      : rule && isFallbackAgent(a, rule.parents) && takesCard({ fallback: true }, dispatch.requestedAt, floor) ? 'fallback' : null;
    const forCard = (dispatch: { targetAgentId: string | null; requestedAt: string }): { agent: LeadAgent | null; held: DispatchHeld | null } => {
      const pinned = dispatch.targetAgentId ? listed.find(a => a.id === dispatch.targetAgentId) : undefined;
      if (pinned) {
        const kind = takes(pinned, dispatch), where = admit(pinned);
        if (kind && where === 'yes') return { agent: asTarget(pinned, kind === 'fallback'), held: null };
        // 257-D1/D2: the confirmed chat may well be fine, only its workspace is unread — not sent to, not given up on.
        if (kind && where === 'unknown') return { agent: null, held: 'listing' };
        // Closing or outside: gone (below). Barred by the start line: held by it (255-D1, below), whatever its workspace.
      }
      // The confirmed agent is gone: a lead by name still takes the card, no other chat does.
      const agent = dispatch.targetAgentId ? named : takesCard(target, dispatch.requestedAt, floor) ? target : null;
      if (agent) return { agent, held: null };
      const held = dispatchHeld(dispatch, floor);
      return { agent: null, held: uncertain && (held === 'noAgent' || held === 'targetGone') ? 'listing' : held };
    };
    return { target, floor, forCard, listing, designated };
  }
  /**
   * Records a card's new state against the revision it was read at; a board changed meanwhile is read again. `sent` also
   * links the agent it went to, in the same write, unless the card already has it.
   */
  async function mark(store: Store, boardId: string, cardId: string, state: 'pending' | 'sent' | 'noLead', targetAgentId: string | null): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const board = await store.readBoard(boardId);
      const card = board.cards.find(c => c.id === cardId);
      if (!card || card.archivedAt !== null || !waitingCards({ cards: [card] }).length) return false;
      if (card.dispatch!.state === state && state !== 'sent') return true;
      const link = state === 'sent' && targetAgentId && !card.agents.some(a => a.agentId === targetAgentId)
        ? [{ op: 'link' as const, id: cardId, agentId: targetAgentId, role: 'worker' }] : [];
      try {
        await store.mutateBoard(boardId, { actor: USER, requestId: newId(), ifRevision: board.revision,
          operations: normalizeOperations([{ op: 'dispatched', id: cardId, state, targetAgentId }, ...link]) }, 'dispatcher');
        return true;
      } catch (error) { if (!(isKanbanError(error) && error.code === 'E_REVISION_CONFLICT')) throw error; }
    }
    return false;
  }

  /** One look at one board: find its lead, and send its oldest waiting card if the lead is idle. */
  async function runBoard(paseo: DispatchApi, boardId: string, grace: number): Promise<DispatchOutcome> {
    const store = await storePromise;
    let board = await store.readBoard(boardId);
    if (!waitingCards(board).length) return 'none';
    let agents: ListedLead[];
    try { agents = await listAgents(paseo); }
    catch (error) { log('agents.list failed; the request waits', String(error)); return 'list-failed'; }
    const { forCard } = await targetOf(paseo, store, agents, board);
    const toOf = (card: Card) => forCard(card.dispatch!).agent;
    const unread = (card: Card) => forCard(card.dispatch!).held === 'listing';
    for (const card of waitingCards(board)) {
      // 257: a card whose chat's workspace is unread is left as it is — neither sent nor written off until the listing can be read.
      if (unread(card)) continue;
      const to = toOf(card);
      if (!to) { if (card.dispatch!.state === 'pending') await mark(store, boardId, card.id, 'noLead', null); }
      else if (card.dispatch!.state === 'noLead') await mark(store, boardId, card.id, 'pending', to.id);
    }
    // One card per idle moment: the oldest one with an agent to go to, and that agent.
    const first = waitingCards(board).find(c => toOf(c));
    if (!first) {
      if (waitingCards(board).some(unread)) { log('the workspace listing could not be read whole; the request waits', boardId); return 'list-failed'; }
      return 'noLead';
    }
    const lead = toOf(first)!;
    const takes = (card: Card) => toOf(card)?.id === lead.id;
    if (grace > 0) await sleep(grace);
    const readiness = leadReadiness(await refreshed(paseo, lead.id));
    if (readiness === 'archived' || readiness === 'gone') {
      board = await store.readBoard(boardId);
      for (const card of waitingCards(board).filter(takes)) await mark(store, boardId, card.id, 'noLead', null);
      log('the lead is ' + readiness + '; the request waits for a lead', lead.id);
      return 'noLead';
    }
    if (readiness !== 'idle') return 'busy';
    // The board may have changed during the grace: the card moved back, or sent by another run.
    board = await store.readBoard(boardId);
    const card = waitingCards(board).find(takes);
    if (!card) return 'none';
    // 257-D2: right before sending, the listing is read again and the same judgement asked of the very agent and card — its
    // workspace may have begun to archive since the candidates were chosen (Paseo marks the row first, the chats later). The
    // one read also names the board. Not a promise about the instant between this read and `send`: that would take the host.
    const latest = await targetOf(paseo, store, agents, board, await readWorkspaces(paseo));
    const again = latest.forCard(card.dispatch!);
    if (again.agent?.id !== lead.id) {
      if (again.held === 'listing') { log('the workspace listing could not be read right before sending; the request waits', { cardId: card.id, leadId: lead.id }); return 'list-failed'; }
      if (!again.agent) {
        await mark(store, boardId, card.id, 'noLead', null);
        log('the agent is no longer one to send to (its workspace is closing, or it is gone); the request waits', { cardId: card.id, leadId: lead.id, held: again.held });
        return 'noLead';
      }
      log('another agent takes the card now; looked at again at the next signal', { cardId: card.id, was: lead.id, now: again.agent.id });
      return 'none';
    }
    const message = dispatchMessage({ title: card.title, cardId: card.id, boardTitle: boardTitle(latest.listing, board),
      notes: card.notes, criteria: card.acceptanceCriteria, locale: await localeOf(store), agentId: lead.id });
    try {
      await paseo.agents.ref(lead.id).send(message, { messageId: card.dispatch!.messageId });
      log('sent', { boardId, cardId: card.id, leadId: lead.id, fallback: lead.fallback, messageId: card.dispatch!.messageId });
    } catch (error) {
      if (!alreadyDelivered(error)) { log('send failed; the request waits', { cardId: card.id, error: String(error) }); return 'failed'; }
      log('already delivered', { cardId: card.id, messageId: card.dispatch!.messageId });
    }
    if (!await mark(store, boardId, card.id, 'sent', lead.id)) log('sent, but the card changed before it was recorded', card.id);
    return 'sent';
  }
  const run = (paseo: DispatchApi, boardId: string, grace: number) =>
    enqueue(boardId, () => runBoard(paseo, boardId, grace)).catch(error => { log('dispatch failed', String(error)); return 'failed' as const; });
  const usable = (paseo: unknown): paseo is DispatchApi => !!paseo && typeof (paseo as DispatchApi).agents?.list === 'function' &&
    typeof (paseo as DispatchApi).agents?.ref === 'function';

  /** Right after a person confirmed the sheet: no grace, the lead may already be idle. */
  function kick(paseo: unknown, boardId: string): Promise<DispatchOutcome> {
    return usable(paseo) ? run(paseo, boardId, 0) : Promise.resolve('none');
  }
  /** An agent's lifecycle signal: its workspace's boards are looked at (a turn that ended waits the grace first). */
  async function signal(agent: unknown, name: Signal, paseo: unknown): Promise<DispatchOutcome[]> {
    try {
      if (!usable(paseo) || !['turn_ended', 'created', 'archived'].includes(name)) return [];
      const read = readHookAgent(agent);
      if (!read.agent || read.agent.parentAgentId) return [];
      const store = await storePromise, cwd = normalizeCwd(read.agent.cwd);
      const identities = await store.listBoardIdentities();
      const boards = identities.filter(b => b.workspaceId === read.agent!.workspaceId || normalizeCwd(b.cwd) === cwd).map(b => b.id);
      // 253-D1: a worktree's agent wakes the board its cards land on (its project root's, D25).
      if (!boards.length && paseo.workspaces) {
        const id = boardOfAgent(read.agent, identities, (await readWorkspaces(paseo)).rows);
        if (id) boards.push(id);
      }
      return await Promise.all(boards.map(id => run(paseo, id, name === 'archived' ? 0 : graceMs)));
    } catch (error) { log('signal failed', String(error)); return []; }
  }
  /** A board read: every board with a waiting card is looked at, at most once per `sweepMs`. */
  let lastSweep = -Infinity;
  async function wake(paseo: unknown, now = Date.now()): Promise<DispatchOutcome[]> {
    if (!usable(paseo) || now - lastSweep < sweepMs) return [];
    lastSweep = now;
    try {
      const store = await storePromise, waiting: string[] = [];
      for (const identity of await store.listBoardIdentities()) {
        try { if (waitingCards(await store.readBoard(identity.id)).length) waiting.push(identity.id); } catch { /* read by the screens' errors */ }
      }
      return await Promise.all(waiting.map(id => run(paseo, id, 0)));
    } catch (error) { log('sweep failed', String(error)); return []; }
  }
  /**
   * REQ-97: what the confirmation sheet shows — the agent it would go to (a lead, else v0.1.46-B's fallback, said so), or
   * none, the board's name and language (the sheet builds the very message the server sends from them). The ledger is only
   * read; the start line may be kept once in `auto-cards.json` (`fallbackFloor`).
   */
  async function preview(paseo: unknown, boardId: string, cardId: string) {
    const store = await storePromise;
    const board = await store.readBoard(boardId);
    const card = board.cards.find(c => c.id === cardId);
    if (!card) throw createKanbanError('E_NOT_FOUND', 'Card not found.', cardId, 'List the board and select an existing card.');
    // 257: the sheet asks the very judgement the sender will, of one listing — which also names the board.
    const found = usable(paseo) ? await targetOf(paseo, store, await listAgents(paseo), board) : null;
    // A draft not yet sent would be requested now (by no agent yet); a card already waiting keeps its moment and agent.
    const waiting = !!card.dispatch && waitingCards({ cards: [card] }).length > 0;
    const look = found?.forCard(waiting ? card.dispatch! : { targetAgentId: null, requestedAt: new Date().toISOString() });
    const lead = look?.agent ?? null;
    return { lead: lead ? { agentId: lead.id, title: lead.title, fallback: lead.fallback } : null,
      ...(look?.held ? { held: look.held } : {}), locale: await localeOf(store),
      boardTitle: boardTitle(found?.listing ?? null, board),
      revision: board.revision, card, to: dispatchStage(board.template.stages)?.stageId ?? null };
  }
  /**
   * 281 F1: who leads each board now (`judgeLead`), for the board views — one agents list and one workspace listing for them
   * all, kept for `LEAD_TTL_MS` since every screen's read asks. Not judged (left out of the map: the screens keep their own
   * reading) without the host's listing, on an error, or past `LEAD_WAIT_MS` — a board read never waits longer on it.
   */
  let leadReads: { at: number; value: Promise<{ agents: ListedLead[]; listing: WorkspaceListing }> } | null = null;
  async function leadsNow(paseo: unknown, boards: readonly Board[]): Promise<ReadonlyMap<string, LeadNow>> {
    if (!usable(paseo) || !boards.length) return new Map();
    const store = await storePromise;
    const work = async () => {
      if (!leadReads || Date.now() - leadReads.at > LEAD_TTL_MS)
        leadReads = { at: Date.now(), value: Promise.all([listAgents(paseo), readWorkspaces(paseo)]).then(([agents, listing]) => ({ agents, listing })) };
      const { agents, listing } = await leadReads.value;
      const state = await readAutoState(store.dataDir).catch(() => null), found = new Map<string, LeadNow>();
      for (const board of boards) {
        const designated = designatedLead(state, board.cwd);
        const archived = !!designated && !agents.some(a => a.id === designated) && leadReadiness(await refreshed(paseo, designated)) === 'archived';
        const lead = judgeLead(agents, board, listing, await relatedTo(store, board, agents, listing.rows), designated, archived);
        if (lead) found.set(board.id, lead);
      }
      return found;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(), new Promise<Map<string, LeadNow>>(resolve => { timer = setTimeout(() => resolve(new Map()), LEAD_WAIT_MS); })]);
    } catch (error) {
      leadReads = null;
      log('who leads could not be judged; the screens keep their own reading', String(error));
      return new Map();
    } finally { if (timer) clearTimeout(timer); }
  }
  return { kick, signal, wake, preview, leadsNow, runBoard: (paseo: DispatchApi, boardId: string, grace = 0) => run(paseo, boardId, grace) };
}
const LEAD_TTL_MS = 2000, LEAD_WAIT_MS = 4000;
export type Dispatcher = ReturnType<typeof createDispatcher>;
