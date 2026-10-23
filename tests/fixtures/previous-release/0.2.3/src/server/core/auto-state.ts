import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { folderKey, folderSwitch, normalizeCwd, type Board, type FolderSwitch } from '../../shared/core/domain.js';
import { renameOver } from './durable.js';

/**
 * `auto-cards.json`, the plugin's own file beside `ui-state.json` (never inside a board): the agent auto cards' switches,
 * the marks of the boards the feature made by itself, and what it last applied per agent. The ledger cannot hold any of
 * it (the core validator rejects unknown fields).
 *
 * 249-D1/D2 — one reading for every path. The engine (server/auto-cards.ts), the core's export (`quietBoard`, whether a
 * commit may create PROCESS.md), the read handlers (what the screens show) and the switch saves all read the file through
 * `readAutoState`, and judge "is this a board the feature made" through `autoMadeBoard` and "is this folder switched off"
 * through `workspaceSetting`. The file holds two kinds of thing:
 * - rules (`hosts`, `workspaces`, `boards`, `boardIntents`, REQ-137 `leads`, the start lines `activatedAt` and `autoBoardFloor`): a switch
 *   somebody set, a board that must stay quiet, the line older chats stay behind. A rule that cannot be read — the wrong
 *   shape, a value of the wrong type, a map that is an array, more entries than the file may hold — makes the whole file
 *   `damaged`: its rules are unknown, so nothing is made or moved, no file is created, and the bytes are never written
 *   over (fail closed);
 * - records (`agents`, `parents`): what was last applied and which sub-agents were seen. A map of them that is not a map is
 *   damage too; a single record that cannot be read is skipped, as before 249 (the ledger's receipts stop a repeated card,
 *   and a sub-agent's hook still carries its parent).
 * A file that is missing is the plain start ("on, nothing applied yet") only when its backup is missing too: every write
 * keeps the same bytes in `auto-cards.backup.json`, so a deleted file is read from the backup and no switch, mark or start
 * line is lost. A backup that cannot be read is `damaged` like the file. Recovery from a damaged file is a repair of its
 * bytes or a copy of the backup — never a deletion, which would turn every quiet board into an ordinary one.
 */
export const AUTO_STATE_FILE = 'auto-cards.json';
export const AUTO_STATE_BACKUP = 'auto-cards.backup.json';
/** 247-D1: the largest `auto-cards.json` read; a larger one cannot be read and counts as damaged. */
export const AUTO_STATE_BYTES = 8 * 1024 * 1024;
export const AGENT_LIMIT = 1000;
/** D44/247-D5: at most this many workspace switches. A switch is never pushed out to make room, and a file holding more is damaged. */
export const WORKSPACE_LIMIT = 1000;
/** 247-D1: at most this many boards this feature made (and folders it is about to make one in); never pushed out either. */
export const AUTO_BOARD_LIMIT = 5000;
export const HOST_LIMIT = 100;

/** `done` is kept for state files written before REQ-74; no signal leads there any more. */
export type Bucket = 'waiting' | 'working' | 'review' | 'done';
export type Signal = 'created' | 'turn_started' | 'turn_ended' | 'permission_requested' | 'permission_resolved' | 'archived';
/** What made this feature move a card: a live signal, or the repair after a restart. */
export type MoveCause = Signal | 'reconcile';
/**
 * REQ-74 fields: `moved` is the last move this feature made (its ledger revision tells it apart from a person's), `pausedAt`
 * the time of the person's move that stopped the automatic moves, and `resumedAt` the moment a person turned them back on.
 */
export interface AutoMove { cause: MoveCause; revision: string; at: string }
export interface AppliedState { boardId: string; cardId: string; bucket: Bucket | null; awaiting: boolean; title: string | null; at: string;
  moved?: AutoMove | null; pausedAt?: string | null; resumedAt?: string | null }
export type HostSetting = FolderSwitch;
/** REQ-76: the parent an agent had when this feature first saw it (the direct parent; the top is found by following). */
export interface ParentMemory { parentAgentId: string; at: string }
/**
 * REQ-137: the chat a person marked as the lead of a board's workspace (the card ⋯ "Mark as lead"), and when. Kept under the
 * board's folder (`normalizeCwd` of the board's `cwd`: a worktree's chat on its project root's board is kept under the root,
 * D25), one per folder. A rule like the switches: an entry that cannot be read makes the file `damaged`.
 * 281 F2: taking the mark off keeps the entry, `agentId: null`, with the time — so a request sent before the mark last changed
 * is known to be one whose rule was not kept (`dispatchMode`), and one sent after it is judged by the mark as it still is.
 */
export interface LeadMark { agentId: string | null; changedAt: string }
/** D44: a board this feature made by itself — the folder it was made for, the agent whose signal made it, and when. */
export interface AutoBoard { cwd: string; agentId: string; at: string }
export interface AutoState { activatedAt: string | null; hosts: Record<string, HostSetting>; agents: Record<string, AppliedState>;
  /** REQ-76: absent in files written before it, read as none. Never overwritten: the first parent seen stays. */
  parents: Record<string, ParentMemory>;
  /** D44: the first moment this version ran. Only an agent created at or after it makes a board. Set once and never moved. */
  autoBoardFloor?: string | null;
  /** D44: the per-workspace switch, by the folder's spelling (`normalizeCwd`; 249-D3: judged by `folderSwitch`). Absent means on. */
  workspaces?: Record<string, HostSetting>;
  /** D44: the boards this feature made, by board id. */
  boards?: Record<string, AutoBoard>;
  /**
   * 247-D1: the folders (`folderKey`) this feature is making a board in, kept before the board exists and moved to `boards`
   * once its id is known. A board at such a folder is treated as one this feature made (no PROCESS.md, no older chats).
   */
  boardIntents?: Record<string, AutoBoard>;
  /** REQ-137: the marked lead of each board folder (`LeadMark`). Absent means none: the lead is found by name, as before. */
  leads?: Record<string, LeadMark>;
  /** 247-D1/249-D1: the file (or its backup) is there but could not be read: its rules are unknown, so nothing is made or moved and it is never written over. */
  damaged?: boolean }
const BUCKETS: readonly Bucket[] = ['waiting', 'working', 'review', 'done'];
const CAUSES: readonly MoveCause[] = ['created', 'turn_started', 'turn_ended', 'permission_requested', 'permission_resolved', 'archived', 'reconcile'];
export const isText = (v: unknown, limit = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= limit;
export const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const freshState = (): AutoState => ({ activatedAt: null, hosts: {}, agents: {}, parents: {}, autoBoardFloor: null, workspaces: {}, boards: {}, boardIntents: {}, leads: {} });
const damagedState = (): AutoState => ({ ...freshState(), damaged: true });

/** The state as the file (or, the file missing, its backup) holds it; `damaged` when either is there but cannot be read. */
export async function readAutoState(dataDir: string): Promise<AutoState> {
  let raw: string;
  try { raw = await fs.readFile(path.join(dataDir, AUTO_STATE_FILE), 'utf8'); }
  catch (error) {
    if (codeOf(error) !== 'ENOENT') return damagedState();
    // 249-D1: the file gone but its backup there is not a first run — the rules live on in the backup.
    try { raw = await fs.readFile(path.join(dataDir, AUTO_STATE_BACKUP), 'utf8'); }
    catch (second) { return codeOf(second) === 'ENOENT' ? freshState() : damagedState(); }
  }
  return parseAutoState(raw);
}
/** The one parsing of the file's bytes; `damaged` for anything whose rules cannot be read. */
export function parseAutoState(raw: string): AutoState {
  const state = freshState();
  try {
    if (raw.length > AUTO_STATE_BYTES) return damagedState();
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!isMap(value) || value.schemaVersion !== 1) return damagedState();
    if (value.activatedAt !== undefined && value.activatedAt !== null && !isTime(value.activatedAt)) return damagedState();
    if (value.autoBoardFloor !== undefined && value.autoBoardFloor !== null && !isTime(value.autoBoardFloor)) return damagedState();
    if (isTime(value.activatedAt)) state.activatedAt = value.activatedAt;
    if (isTime(value.autoBoardFloor)) state.autoBoardFloor = value.autoBoardFloor;
    // A rule map: absent, or a plain object of readable entries, no more than its limit. Anything else is damage.
    const rules = <T>(field: unknown, limit: number, keyLimit: number, read: (entry: unknown) => T | null, into: Record<string, T>) => {
      if (field === undefined) return true;
      if (!isMap(field)) return false;
      const entries = Object.entries(field);
      if (entries.length > limit) return false;
      for (const [key, entry] of entries) { const e = read(entry); if (!isText(key, keyLimit) || !e) return false; into[key] = e; }
      return true;
    };
    const setting = (entry: unknown): HostSetting | null => { const e = entry as Partial<HostSetting> | null;
      return isMap(e) && typeof e.enabled === 'boolean' && isTime(e.changedAt) ? { enabled: e.enabled, changedAt: e.changedAt } : null; };
    const made = (entry: unknown): AutoBoard | null => { const e = entry as Partial<AutoBoard> | null;
      return isMap(e) && isText(e.cwd, 4096) && isText(e.agentId, 256) && isTime(e.at) ? { cwd: e.cwd, agentId: e.agentId, at: e.at } : null; };
    const lead = (entry: unknown): LeadMark | null => { const e = entry as Partial<LeadMark> | null;
      return isMap(e) && (e.agentId === null || isText(e.agentId, 256)) && isTime(e.changedAt) ? { agentId: e.agentId, changedAt: e.changedAt } : null; };
    const parent = (id: string) => (entry: unknown): ParentMemory | null => { const e = entry as Partial<ParentMemory> | null;
      return isMap(e) && isText(e.parentAgentId, 64) && e.parentAgentId !== id && isTime(e.at) ? { parentAgentId: e.parentAgentId, at: e.at } : null; };
    if (!rules(value.hosts, HOST_LIMIT, 256, setting, state.hosts) || !rules(value.workspaces, WORKSPACE_LIMIT, 4096, setting, state.workspaces!) ||
      !rules(value.boards, AUTO_BOARD_LIMIT, 80, made, state.boards!) || !rules(value.boardIntents, AUTO_BOARD_LIMIT, 4096, made, state.boardIntents!) ||
      !rules(value.leads, WORKSPACE_LIMIT, 4096, lead, state.leads!))
      return damagedState();
    // REQ-76: parents are records like the agents' (a file from before it has none): an unreadable one is skipped, the 1000 seen most recently are kept.
    if (value.parents !== undefined) {
      if (!isMap(value.parents)) return damagedState();
      for (const [id, entry] of Object.entries(value.parents).slice(0, AGENT_LIMIT)) {
        const e = isText(id, 64) ? parent(id)(entry) : null;
        if (e) state.parents[id] = e;
      }
    }
    if (value.agents !== undefined) {
      if (!isMap(value.agents)) return damagedState();
      for (const [id, entry] of Object.entries(value.agents).slice(0, AGENT_LIMIT)) {
        const e = entry as Partial<AppliedState> | null;
        if (!isText(id, 64) || !isMap(e) || !isText(e.boardId, 80) || !isText(e.cardId, 80) || !isTime(e.at)) continue;
        state.agents[id] = { boardId: e.boardId, cardId: e.cardId,
          bucket: BUCKETS.includes(e.bucket as Bucket) ? e.bucket as Bucket : null,
          awaiting: e.awaiting === true, title: typeof e.title === 'string' ? e.title : null, at: e.at,
          moved: readMove(e.moved), pausedAt: isTime(e.pausedAt) ? e.pausedAt : null, resumedAt: isTime(e.resumedAt) ? e.resumedAt : null };
      }
    }
  } catch { return damagedState(); }
  return state;
}
function readMove(value: unknown): AutoMove | null {
  const m = value as Partial<AutoMove> | null;
  return isMap(m) && CAUSES.includes(m.cause as MoveCause) && isText(m.revision, 80) && isTime(m.at)
    ? { cause: m.cause as MoveCause, revision: m.revision, at: m.at } : null;
}
/**
 * Writes the state — the file first, then the same bytes to its backup — through a same-directory temporary file and
 * rename. A damaged state is never written: nothing read from it can be trusted to write back.
 */
export async function writeAutoState(dataDir: string, state: AutoState): Promise<void> {
  if (state.damaged) throw new Error(AUTO_STATE_FILE + ' could not be read; it is not written over.');
  const agents = Object.entries(state.agents).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, AGENT_LIMIT);
  // REQ-76: the same bound; the sub-agents first seen longest ago give way first.
  const parents = Object.entries(state.parents ?? {}).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, AGENT_LIMIT);
  // 247-D1/D5: switches and made boards are rules and are all kept; their limits are kept where they are added.
  const workspaces = Object.entries(state.workspaces ?? {}).sort((a, b) => b[1].changedAt.localeCompare(a[1].changedAt));
  const boards = Object.entries(state.boards ?? {}).sort((a, b) => b[1].at.localeCompare(a[1].at));
  const intents = Object.entries(state.boardIntents ?? {}).sort((a, b) => b[1].at.localeCompare(a[1].at));
  const leads = Object.entries(state.leads ?? {}).sort((a, b) => b[1].changedAt.localeCompare(a[1].changedAt));
  const bytes = JSON.stringify({ schemaVersion: 1, activatedAt: state.activatedAt, hosts: state.hosts,
    agents: Object.fromEntries(agents), ...(parents.length ? { parents: Object.fromEntries(parents) } : {}),
    ...(state.autoBoardFloor ? { autoBoardFloor: state.autoBoardFloor } : {}),
    ...(workspaces.length ? { workspaces: Object.fromEntries(workspaces) } : {}),
    ...(boards.length ? { boards: Object.fromEntries(boards) } : {}),
    ...(intents.length ? { boardIntents: Object.fromEntries(intents) } : {}),
    ...(leads.length ? { leads: Object.fromEntries(leads) } : {}) }, null, 2) + '\n';
  await fs.mkdir(dataDir, { recursive: true });
  await replaceFile(dataDir, AUTO_STATE_FILE, bytes);
  await replaceFile(dataDir, AUTO_STATE_BACKUP, bytes);
}
async function replaceFile(dataDir: string, name: string, bytes: string): Promise<void> {
  const temporary = path.join(dataDir, `.${name}.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await renameOver(temporary, path.join(dataDir, name));
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * 247-D1/249-D1: whether this feature made the board — by its id, or (its id not yet kept) by the folder it was being made
 * in. Of a damaged file nothing is known, so the answer is "maybe": true, the side on which no file is created.
 */
export const autoMadeBoard = (state: AutoState, board: Pick<Board, 'id' | 'cwd'>) =>
  !!state.damaged || !!state.boards?.[board.id] || !!state.boardIntents?.[folderKey(board.cwd)];
/**
 * D44/249-D3: the switch of the workspaces at these folders (`folderSwitch`: by the spelling each switch was saved under).
 * Turned back on, the start line moves to that moment, as for the host switch. 247-D1: nothing is known of a damaged file,
 * so it reads as off.
 */
export function workspaceSetting(state: AutoState, cwds: readonly (string | null | undefined)[]): { enabled: boolean; since: string | null } {
  if (state.damaged) return { enabled: false, since: null };
  return folderSwitch(state.workspaces ?? {}, cwds);
}
/**
 * REQ-137: the chat marked as the lead of the board at this folder — by the folder's own spelling (`normalizeCwd`), as it
 * was saved from that board; another spelling of the folder is not guessed at. Of a damaged file nothing is known, so no
 * chat is marked: the lead is found by name alone (fail closed — the start line is unreadable then too, so nothing falls back).
 */
export function designatedLead(state: AutoState | null | undefined, cwd: string | null | undefined): string | null {
  return leadRecord(state, cwd)?.agentId ?? null;
}
/**
 * 281 F2: the folder's mark as the file keeps it — the chat (null: taken off) and when it last changed; null when no mark was
 * ever kept there; undefined when the file is unknown (not read, or damaged), so nothing can be said of an earlier request.
 */
export function leadRecord(state: AutoState | null | undefined, cwd: string | null | undefined): LeadMark | null | undefined {
  if (!state || state.damaged) return undefined;
  return cwd ? state.leads?.[normalizeCwd(cwd)] ?? null : null;
}
