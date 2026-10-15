import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { readWorkspaceLabels } from './workspace-labels.js';
import { createKanbanError, isKanbanError, type Board, type Locale } from '../shared/core/domain.js';
import { type Store } from './core/store.js';
import { boardGet, busyClear, busySet, cardGet, normalizeCwd, overviewGet, revisionsGet, uiStateSet, workflowGet, workflowPickSet, workflowExport, mailListGet, mailThreadGet, workspaceOfEmptyBoard, type MailDTO, type ReadError, type UiSettingsDTO } from '../shared/rpc.js';
import { BUSY_BY_SCREEN, busyKey, busyOf, busyText, readBusyFile, setBusy, type BusyState, type ClearedState } from './busy.js';
import { confirmGone, dispatchFloorOf, dispatchMode, emptyGoneBoards, emptyWorkspaces, enteredOf, heldOf, stageEntries, stageEntry, toBoardDTO, toEmptyBoardDTO, toOverview } from './read-model.js';
import { listWorkspaces, type ActiveWorkspace } from './workspaces.js';
import { emptyUiState, readUiState, writeUiState } from './ui-state.js';
import { cardTracking, designatedLead, foldersOff, hostEnabled, leadRecord, readAutoState, type AutoHealth, type AutoState } from './auto-cards.js';
import type { LeadNow } from './dispatch.js';
import { cardParents, groupsKey } from './card-parents.js';
import { createMailReader, mailExcluded, type MailReader } from './mailbox.js';
import { createMailListReader, type MailBoundary, type MailListReader } from './mail-list.js';
import type { MailListDTO, MailThreadDTO } from '../shared/mail-list.js';
import { createWorkflowReader, type WorkflowReader } from './workflow.js';
import { exportDefinition, type ExportResult } from './workflow-export.js';
import { pickFor, readPicks, setPick, type PicksState } from './workflow-picks.js';
import { builtinDefinition, builtinWorkflow, type BuiltinWorkflow, type WorkflowLocale } from '../shared/workflow-templates.js';
import type { WorkflowDefinition } from '../shared/workflow.js';
import { PACKAGE_VERSION, BUILD_RELEASE } from './version.js';
import { readArchiveSettings } from './auto-archive.js';
import { z } from 'zod';

// Paseo 0.8 evaluates a string with no plugin-root path; version/release are build metadata.
const about = { version: PACKAGE_VERSION, ...(BUILD_RELEASE ? { release: BUILD_RELEASE } : {}) };
export type WorkspaceContext = Pick<PluginHandlerContext['paseo'], 'workspaces'>;
export function readError(error: unknown): ReadError {
  if (error instanceof z.ZodError) return { code: 'E_VALIDATION', message: 'Invalid RPC request.',
    target: '', nextAction: 'Use the documented fields and complete identifiers.', details: error.issues };
  if (isKanbanError(error)) return { code: error.code, message: error.message,
    target: error.target, nextAction: error.nextAction, details: error.details };
  return { code: 'E_IO', message: 'Could not read the ledger.', target: '',
    nextAction: 'Check the data directory and retry.', details: null };
}
/** The language a screen falls back to when the ledger's setting cannot be read — the same as core and the CLI. */
export const FALLBACK_LOCALE: Locale = 'en';
/**
 * REQ-141 W1 (D3): a new install (no `config.json` yet) starts in English, like core and the CLI. A `config.json`
 * without a `locale` key was written by an earlier build that showed it in Korean, so it stays Korean — an existing
 * install does not change language on update. Read-only either way.
 */
export async function readLocale(store: Store): Promise<Locale> {
  const config = await store.readConfig();
  const raw = await readFile(join(store.dataDir, 'config.json'), 'utf8').then(JSON.parse)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (raw === null) return 'en';
  return raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'locale') ? 'ko' : config.locale;
}
async function respond<T>(action: () => Promise<T>) {
  try { return { ok: true as const, data: await action(), committed: false as const, warnings: [] }; }
  catch (error) { return { ok: false as const, error: readError(error), committed: false as const }; }
}
/**
 * A cache belongs to one store/host; it never writes or holds a writer lock. REQ-83: `health` is the daemon's automatic
 * tracking (`AutoCards.health`), said with every read so a screen can tell when tracking may have stopped.
 * REQ-90: `mail` reads the message folder for the lab's badge (server/mailbox.ts, 60 s cache).
 * REQ-124: `flows` reads a workspace's workflow documents (server/workflow.ts, 60 s cache), only when a lane asks.
 * REQ-128: `mailList` reads the whole message folder for the lab's message list (server/mail-list.ts, 60 s cache bound to `mail`'s key).
 */
/**
 * REQ-125 2단계 J2 (research/293): the file a built-in becomes — its steps and lines as they are, named without the
 * "— built-in" tail (it is the project's own file now); the note still says where it came from.
 */
export function exportedDefinition(template: BuiltinWorkflow, locale: WorkflowLocale): WorkflowDefinition {
  const def = builtinDefinition(template, locale), name = template.name[locale];
  return { ...def, name, note: locale === 'ko'
    ? `칸반 기본 틀 '${name}'(${template.id} v${template.version})에서 내보냄 — 단계와 선만 있고 문서를 읽는 규칙은 아직 없다.`
    : `Exported from the Kanban built-in "${name}" (${template.id} v${template.version}) — steps and lines only, no rules for reading documents yet.` };
}
export function createReadHandlers(store: Store, now = () => new Date().toISOString(), labels = readWorkspaceLabels,
  workspaces = listWorkspaces, health: () => AutoHealth | null = () => null, mail: MailReader = createMailReader(),
  flows: WorkflowReader = createWorkflowReader(), mailList: MailListReader = createMailListReader(),
  leadsNow?: (paseo: WorkspaceContext | undefined, boards: readonly Board[]) => Promise<ReadonlyMap<string, LeadNow>>) {
  /** 281 F1: the server's own judgement of who leads each board (`judgeLead`), for its view; none known without the host's. */
  const leadsOf = async (paseo: WorkspaceContext | undefined, boards: readonly Board[]): Promise<ReadonlyMap<string, LeadNow>> => {
    try { return leadsNow && paseo ? await leadsNow(paseo, boards) : new Map(); } catch { return new Map(); }
  };
  const leadOf = (auto: AutoState | null, board: Board, leads: ReadonlyMap<string, LeadNow>) => ({ record: leadRecord(auto, board.cwd), now: leads.get(board.id) });
  const autoHealth = () => { try { const value = health(); return value ? { autoHealth: value } : {}; } catch { return {}; } };
  const cache = new Map<string, { stamp: string; board: Board }>();
  async function scan(ids?: string[]) {
    const { entries, errors: failures } = await store.statBoards(ids);
    const errors = failures.map(readError);
    const present = new Set(entries.map(e => e.id));
    const removedIds = (ids ?? [...cache.keys()]).filter(id => !present.has(id) &&
      !failures.some(e => e.target === id));
    for (const id of removedIds) cache.delete(id);
    const boards: Board[] = [];
    const workspaces = new Set<string>();
    for (const entry of entries) {
      try {
        let cached = cache.get(entry.id);
        if (!cached || cached.stamp !== entry.stamp) {
          cached = { stamp: entry.stamp, board: await store.readBoard(entry.id) };
          cache.set(entry.id, cached);
        }
        if (workspaces.has(cached.board.workspaceId))
          throw createKanbanError('E_CORRUPT', 'Duplicate workspace id.', entry.id,
            'Inspect the duplicate ledgers before making changes.', { workspaceId: cached.board.workspaceId });
        workspaces.add(cached.board.workspaceId);
        boards.push(cached.board);
      } catch (error) { cache.delete(entry.id); errors.push(readError(error)); }
    }
    return { boards, errors, removedIds };
  }
  const locale = () => readLocale(store);
  /** REQ-52: the automatic archive's days for the settings window; a file that cannot be read at all says nothing. */
  const autoArchive = async () => { try { return { autoArchive: await readArchiveSettings(store.dataDir) }; } catch { return {}; } };
  /** REQ-76: the plugin's own file, for which card sits under which. Missing or damaged reads as "no groups". */
  const autoState = async (): Promise<AutoState | null> => { try { return await readAutoState(store.dataDir); } catch { return null; } };
  const parentsOf = (board: Board, state: AutoState | null) => state ? cardParents(board, state) : undefined;
  /** REQ-84: the busy marks and (J2) their recent ends, from the plugin's own file; missing or damaged reads as none (server/busy.ts). */
  const busyState = async (): Promise<{ marks: BusyState; cleared: ClearedState } | null> => {
    try { return await readBusyFile(store.dataDir); } catch { return null; }
  };
  /**
   * REQ-90: the message folder, only while this host's lab badge is on and a folder is set — otherwise it is never touched.
   * A read failure (the settings file, the folder) reads as no badge.
   */
  const mailFor = async (settings: UiSettingsDTO | undefined): Promise<MailDTO | undefined> => {
    const labs = settings?.labs;
    if (!labs?.mail || !labs.mailDir) return undefined;
    try { return await mail.read(labs.mailDir); } catch { return undefined; }
  };
  /** REQ-128: the message folder this host's lab names, while its switch is on; a settings file that cannot be read names none. */
  const labDir = async (hostId: string): Promise<string | null> => {
    let labs: UiSettingsDTO['labs'];
    try { labs = (await readUiState(store.dataDir, hostId)).settings?.labs; } catch { return null; }
    return labs?.mail && labs.mailDir ? labs.mailDir : null;
  };
  /**
   * research/236 D1: the folder's fingerprint as the lanes' badge reads it (the same 60 s reading) — the list's cache is bound to it.
   * research/242 D1: with the threads that reading left out at the boundary, which the list and a thread leave out too.
   */
  const mailMark = async (dir: string): Promise<{ mark: string; skip?: ReadonlySet<string> }> => {
    try { const read = await mail.read(dir); return { mark: read.key, skip: mailExcluded(read) }; } catch { return { mark: '' }; }
  };
  /**
   * research/242 D1: a request's badge, fingerprint, list and thread leave out the same threads. One the list or a thread
   * finds swapped at the boundary leaves the badge's reading too, and is asked once more under the fingerprint so moved.
   */
  const underMailMark = async <T>(dir: string, ask: (mark: string, boundary: MailBoundary) => Promise<T>): Promise<T> => {
    const found: string[] = [], first = await mailMark(dir);
    const value = await ask(first.mark, { ...(first.skip ? { skip: first.skip } : {}), found: thread => { found.push(thread); } });
    if (!found.length) return value;
    mail.exclude(dir, found);
    const again = await mailMark(dir);
    return ask(again.mark, { ...(again.skip ? { skip: again.skip } : {}), found: thread => mail.exclude(dir, [thread]) });
  };
  async function select(input: { boardId?: string | undefined; workspaceId?: string | undefined }) {
    if (input.boardId) {
      const result = await scan([input.boardId]);
      if (result.errors.length) throw createKanbanError(result.errors[0]!.code,
        result.errors[0]!.message, input.boardId, result.errors[0]!.nextAction);
      if (result.boards[0]) return result.boards[0];
    } else {
      const result = await scan();
      const matches = result.boards.filter(b => b.workspaceId === input.workspaceId);
      const duplicate = result.errors.some(e => e.message === 'Duplicate workspace id.' &&
        (e.details as { workspaceId?: string } | null)?.workspaceId === input.workspaceId);
      if (duplicate) throw createKanbanError('E_CORRUPT', 'Duplicate workspace identity.', input.workspaceId,
        'Inspect duplicate board files.');
      if (matches[0]) return matches[0];
      if (result.errors.length) throw createKanbanError('E_CORRUPT',
        'Workspace lookup is incomplete because some boards could not be read.', input.workspaceId,
        'Inspect the overview errors before initializing another board.', result.errors);
    }
    throw createKanbanError('E_NOT_FOUND', 'No board is registered for this workspace.',
      input.boardId ?? input.workspaceId, 'Ask the orchestrator to initialize this workspace with kanban init.');
  }
  /** REQ-57: Paseo is the authority on which workspaces exist and where they live on disk. */
  async function activeWorkspace(paseo: WorkspaceContext | undefined, workspaceId: string): Promise<ActiveWorkspace> {
    if (!paseo) throw createKanbanError('E_NOT_FOUND', 'No board is registered for this workspace.', workspaceId,
      'Ask the orchestrator to initialize this workspace with kanban init.');
    const found = (await workspaces(paseo)).active.find(w => w.id === workspaceId);
    if (!found) throw createKanbanError('E_NOT_FOUND', 'No active Paseo workspace has this id.', workspaceId,
      'Open the workspace in Paseo, or initialize a board with kanban init.');
    return found;
  }
  /** REQ-125: the plugin's `workflow-picks.json`; one that cannot be read counts as no picks (server/workflow-picks.ts). */
  const picksState = async (): Promise<PicksState | null> => { try { return await readPicks(store.dataDir); } catch { return null; } };
  /**
   * REQ-124: marks the board views whose workspace folder holds a workflow definition — their lane's "Workflow" button,
   * and (REQ-127) their board screen's. REQ-125: or, with no file, the built-in the workspace is trying (`workflowPick`).
   */
  const withWorkflow = async <T extends { summary: { cwd: string } }>(views: T[]) => {
    const picks = views.length ? await picksState() : null;
    return Promise.all(views.map(async view => {
      const cwd = normalizeCwd(view.summary.cwd);
      if (await flows.defined(cwd).catch(() => false)) return { ...view, summary: { ...view.summary, workflow: true as const } };
      const pick = pickFor(picks, cwd);
      return pick ? { ...view, summary: { ...view.summary, workflow: true as const, workflowPick: pick } } : view;
    }));
  };
  /** REQ-124: the workspace folder from the server's own knowledge — Paseo's listing, else the workspace's board — never from the screen. */
  const workflowCwd = async (paseo: WorkspaceContext | undefined, workspaceId: string) => {
    let cwd: string | null = null;
    if (paseo) { try { cwd = (await workspaces(paseo)).active.find(w => w.id === workspaceId)?.cwd ?? null; } catch { cwd = null; } }
    return normalizeCwd(cwd ?? (await select({ workspaceId })).cwd);
  };
  return {
    overview:(input: z.input<typeof overviewGet.input>, paseo?: WorkspaceContext) => respond(async () => {
      const value = overviewGet.input.parse(input);
      const partial = value.boardIds !== undefined;
      const result = await scan(partial ? [...new Set(value.boardIds!)] : undefined);
      // Read failures fall back to FALLBACK_LOCALE (REQ-141 W1) and still report the error.
      let language: Locale = FALLBACK_LOCALE;
      try { language = await locale(); } catch (error) { result.errors.push(readError(error)); }
      // One workspace listing per request feeds both the label names and the empty-workspace rows.
      const wanted = (value.includeWorkspaces ?? false) || (value.includeBoards ?? false);
      let listing: Awaited<ReturnType<typeof listWorkspaces>> | null = null;
      if (paseo && wanted && !partial) { try { listing = await workspaces(paseo); } catch { listing = null; } }
      // A refresh of named boards must not replace the whole list, so it never synthesizes rows.
      const empties = listing && !partial
        ? emptyWorkspaces(result.boards, listing.active).map(w => toEmptyBoardDTO(w.id, w.cwd, language)) : [];
      // REQ-138: with no listing (none asked, or it failed) — or one naming no workspace at all, as a daemon starting up may
      // answer — no board is judged gone, so nothing is left out.
      // 321 F2: and checked by the real folder, so a symbolic link to the same folder under a new id keeps the board shown.
      // 321 J5: a live workspace listed without its folder could be any board's folder, so that answer hides nothing.
      const folderless = !!listing && (listing.liveIds ?? []).some(id => !listing.active.some(w => w.id === id));
      const gone = listing && listing.entries.length && !partial && !folderless
        ? await confirmGone(emptyGoneBoards(result.boards, listing.active, listing.liveIds), result.boards, listing.active) : new Set<string>();
      const goneMark = (id: string) => gone.has(id) ? { emptyGone: true as const } : {};
      const file = await busyState(), marks = file?.marks, ends = file?.cleared;
      const overview = toOverview(result.boards, language, now(), id => busyOf(marks, id), id => busyOf(ends, id));
      const base = { ...overview, boards: overview.boards.map(b => ({ ...b, ...goneMark(b.id) })) };
      let ui = emptyUiState();
      let autoCards = true;
      const auto = value.hostId !== undefined || value.includeBoards ? await autoState() : null;
      if (value.hostId !== undefined) { try { ui = await readUiState(store.dataDir, value.hostId); } catch { ui = emptyUiState(); } }
      if (value.hostId !== undefined) autoCards = auto ? hostEnabled(auto, value.hostId) : true;
      // REQ-90: only the swimlane screens (includeBoards) draw the badge; the list view never reads the folder.
      const messages = value.hostId !== undefined && value.includeBoards ? await mailFor(ui.settings) : undefined;
      return { ...base, errors: result.errors, ...(messages ? { mail: messages } : {}),
        boards: [...base.boards, ...empties.map(b => ({ ...b.summary, needsHuman: 0 }))],
        about, ...autoHealth(),
        // D44/249-D3: of the boards this answer shows, the folders switched off, in the spelling their rows carry.
        ...(value.hostId !== undefined ? { ui, autoCards, autoCardsOff: auto ? foldersOff(auto, [...result.boards.map(b => b.cwd), ...empties.map(b => b.summary.cwd)]) : [],
          ...await autoArchive() } : {}),
        ...(value.includeBoards ? { ...(paseo ? { workspaceLabels: await labels({ api: async () =>
          ({ entries: (listing ?? await workspaces(paseo)).entries }) }) } : {}),
          boardViews: await withWorkflow([...await (async () => { const leads = await leadsOf(paseo, result.boards);
            return result.boards.map(board => { const view = toBoardDTO(board, language, 'off', Date.now(), parentsOf(board, auto), busyOf(marks, board.id), busyOf(ends, board.id), dispatchFloorOf(auto), leadOf(auto, board, leads));
              return gone.has(board.id) ? { ...view, summary: { ...view.summary, emptyGone: true as const } } : view; }); })(), ...empties]),
          removedIds: result.removedIds } : {}) };
    }),
    board: (input: z.input<typeof boardGet.input>, paseo?: WorkspaceContext) => respond(async () => {
      const value = boardGet.input.parse(input);
      // REQ-57: opening a workspace that has no board yet shows the same empty board the first screen does.
      const pending = value.boardId ? workspaceOfEmptyBoard(value.boardId) : null;
      const selector = pending ? { workspaceId: pending } : value;
      // REQ-66: the host's settings ride along, so a panel opened before the Kanban screen obeys them.
      let settings: UiSettingsDTO | undefined;
      if (value.hostId !== undefined) { try { settings = (await readUiState(store.dataDir, value.hostId)).settings; } catch { settings = {}; } }
      // REQ-67 ⑥: and the auto-card switch, so the settings window opened from a board shows the real value.
      let autoCards = true;
      const auto = await autoState();
      if (value.hostId !== undefined) autoCards = auto ? hostEnabled(auto, value.hostId) : true;
      // D44/249-D3: this board's folder switched off or not, in the spelling its row carries.
      const archive = value.hostId !== undefined ? await autoArchive() : {};
      const extra = (cwd: string) => ({ ...(settings ? { settings } : {}),
        ...(value.hostId !== undefined ? { autoCards, autoCardsOff: auto ? foldersOff(auto, [cwd]) : [], ...archive } : {}), ...autoHealth() });
      let board: Board;
      try { board = await select(selector); }
      catch (error) {
        if (!isKanbanError(error) || error.code !== 'E_NOT_FOUND' || !selector.workspaceId) throw error;
        const workspace = await activeWorkspace(paseo, selector.workspaceId);
        const language = await locale();
        // REQ-127: the board screen's "Board | Workflow" too, by the same one cached stat per folder as the overview's lanes.
        const [empty] = await withWorkflow([toEmptyBoardDTO(workspace.id, workspace.cwd, language)]);
        return { board: empty!, about, revision: '', locale: language, observedAt: now(), ...extra(workspace.cwd) };
      }
      const language = await locale();
      const file = await busyState();
      const [view] = await withWorkflow([toBoardDTO(board, language, value.hideDone, Date.parse(now()), parentsOf(board, auto), busyOf(file?.marks, board.id),
        busyOf(file?.cleared, board.id), dispatchFloorOf(auto), leadOf(auto, board, await leadsOf(paseo, [board])))]);
      return { board: view!,
        about, revision: board.revision, locale: language, observedAt: now(), ...extra(board.cwd) };
    }),
    card: (input: z.input<typeof cardGet.input>) => respond(async () => {
      const value = cardGet.input.parse(input);
      const board = await select(value);
      const card = board.cards.find(c => c.id === value.cardId && c.archivedAt === null);
      if (!card) throw createKanbanError('E_NOT_FOUND', 'Card not found.', value.cardId,
        'Refresh the board and select an active card.');
      const language = await locale();
      // REQ-74: why the card is where it is, and whether its automatic moves are paused. A missing or
      // damaged auto-card file reads as empty: no tracking line, the reason still comes from the ledger.
      const autoFile = await autoState();
      const auto = cardTracking(board, card, autoFile ?? await readAutoState(store.dataDir));
      // 253-D3: why its request waits, if it waits for another reason than "no agent there".
      const held = card.dispatch ? heldOf(card.dispatch, dispatchFloorOf(autoFile)).held : undefined;
      // 281 F2: the rule a sent request went by, from the mark as it was then (`dispatchMode`), as on the board card.
      const mode = card.dispatch ? dispatchMode(card.dispatch, leadRecord(autoFile, board.cwd)) : {};
      return { boardId: board.id, card, template: toBoardDTO(board, language).template,
        history: board.history.filter(h => h.cardId === card.id), revision: board.revision,
        locale: language, observedAt: now(), reason: auto.reason, tracking: auto.tracking,
        ...enteredOf(stageEntry(stageEntries(board), card)), busy: busyOf((await busyState())?.marks, board.id)?.get(card.id) ?? null,
        ...(held ? { dispatchHeld: held } : {}), ...(mode.marked || mode.modeUnknown ? { dispatchMode: mode } : {}) };
    }),
    ui: (input: z.input<typeof uiStateSet.input>) => respond(async () => {
      const value = uiStateSet.input.parse(input);
      return writeUiState(store.dataDir, value.hostId,
        { ...(value.hiddenProjects ? { hiddenProjects: value.hiddenProjects } : {}), ...(value.order ? { order: value.order } : {}),
          ...(value.settings ? { settings: value.settings } : {}) });
    }),
    activeWorkspace,
    /**
     * REQ-124: the workspace folder comes from the server's own knowledge — Paseo's listing, else the workspace's board —
     * never from the screen. Reads only (server/workflow.ts).
     */
    workflow: (input: z.input<typeof workflowGet.input>, paseo?: WorkspaceContext) => respond(async () => {
      const value = workflowGet.input.parse(input);
      const cwd = await workflowCwd(paseo, value.workspaceId);
      // REQ-125: the built-in this workspace is trying, named in the screen's language; the reading uses it only with no file.
      const pick = pickFor(await picksState(), cwd);
      let language: Locale = FALLBACK_LOCALE;
      if (pick) { try { language = await locale(); } catch { language = FALLBACK_LOCALE; } }
      return flows.read(cwd, value.window, pick ? { template: pick, locale: language } : undefined);
    }),
    /**
     * REQ-125 C안 1단계: the workspace tries a built-in workflow, or stops using it — only `workflow-picks.json` changes,
     * under the folder `workflow` reads (server/workflow-picks.ts: a damaged file is never written over).
     */
    workflowPick: (input: z.input<typeof workflowPickSet.input>, paseo?: WorkspaceContext) => respond(async () => {
      const value = workflowPickSet.input.parse(input);
      return setPick(store.dataDir, await workflowCwd(paseo, value.workspaceId), value.template);
    }),
    /**
     * REQ-125 2단계 (research/288): the pick written into the workspace folder as `.kanban/workflow.json` — the only write
     * there, on the owner's press. The template must be the folder's pick now (another screen may have changed it). Once
     * written the file wins; the pick is then taken out, so it does not rest unseen behind the file and come back if the
     * file is deleted (a failed take-out leaves the written file as it is: `pickCleared: false`).
     */
    workflowExport: (input: z.input<typeof workflowExport.input>, paseo?: WorkspaceContext) => respond(async () => {
      const value = workflowExport.input.parse(input);
      const cwd = await workflowCwd(paseo, value.workspaceId);
      const pick = pickFor(await picksState(), cwd), template = builtinWorkflow(pick);
      if (!template || pick !== value.template) throw createKanbanError('E_CONFLICT', 'This workspace is not trying that built-in workflow now.',
        value.template, 'Read the workflow again.');
      let language: Locale = FALLBACK_LOCALE;
      try { language = await locale(); } catch { language = FALLBACK_LOCALE; }
      let written: ExportResult;
      // Whatever happened, the folder is read again next time: a file found there (E_EXISTS) or written wins at once.
      try { written = await exportDefinition(cwd, exportedDefinition(template, language)); } finally { flows.forget(cwd); }
      let pickCleared = true;
      try { await setPick(store.dataDir, cwd, null); } catch { pickCleared = false; }
      return { path: written.path, template: template.id, pickCleared, ...(written.left ? { left: written.left } : {}) };
    }),
    /**
     * REQ-128: the message list and one thread, from the folder this host's lab names — never a path from the screen. With the
     * lab's switch off or no folder set, `off` and nothing is read. Reads only (server/mail-list.ts).
     */
    mailList: (input: z.input<typeof mailListGet.input>) => respond(async (): Promise<MailListDTO> => {
      const value = mailListGet.input.parse(input), dir = await labDir(value.hostId);
      return dir ? underMailMark(dir, (mark, boundary) => mailList.list(dir, mark, boundary)) : { state: 'off', key: 'off', threads: [], limits: [], readAt: now() };
    }),
    mailThread: (input: z.input<typeof mailThreadGet.input>) => respond(async (): Promise<MailThreadDTO> => {
      const value = mailThreadGet.input.parse(input), dir = await labDir(value.hostId);
      return dir ? underMailMark(dir, (mark, boundary) => mailList.thread(dir, value.thread, mark, boundary)) : { state: 'off', id: value.thread, files: [], latest: 0, more: 0 };
    }),
    /** REQ-84 ⑤: a person turns a card's busy mark off from the detail; only `busy.json` changes. */
    clearBusy: (input: z.input<typeof busyClear.input>) => respond(async () => {
      const value = busyClear.input.parse(input);
      const board = await select({ boardId: value.boardId });
      const active = new Set(board.cards.filter(c => c.archivedAt === null).map(c => c.id));
      return { changed: (await setBusy(store.dataDir, board.id, value.cardId, null, { active })).changed };
    }),
    /**
     * REQ-130: a person turns a card's memo (its busy mark) on from the detail — under the board's lock, as the CLI does, so
     * the card exists and is not archived; only `busy.json` changes.
     */
    setBusy: (input: z.input<typeof busySet.input>) => respond(async () => {
      const value = busySet.input.parse(input), text = busyText(value.text);
      if (text === null) throw createKanbanError('E_VALIDATION', 'Busy text must be 1-200 characters.', 'text', 'Write one line, for example "Testing".');
      const board = await select({ boardId: value.boardId });
      const result = await store.withBoardLock(board.id, async current => {
        const card = current.cards.find(c => c.id === value.cardId);
        if (!card) throw createKanbanError('E_NOT_FOUND', 'Card not found.', value.cardId, 'Refresh the board.');
        if (card.archivedAt !== null) throw createKanbanError('E_VALIDATION', 'Archived cards cannot be marked busy.', card.id, 'Restore the card first.');
        const active = new Set(current.cards.filter(c => c.archivedAt === null).map(c => c.id));
        return setBusy(store.dataDir, current.id, card.id, { text, since: now(), by: BUSY_BY_SCREEN }, { active });
      });
      return { changed: result.data.changed, busy: result.data.busy };
    }),
    revisions: (input: z.input<typeof revisionsGet.input>) => respond(async () => {
      const value = revisionsGet.input.parse(input);
      const result = await scan(value.boardIds);
      // REQ-76 F1: a parent remembered since the screen's read changes `groups`, not the ledger's revision.
      const auto = value.groups ? await autoState() : null;
      const groups = (board: Board) => { const key = groupsKey(parentsOf(board, auto), designatedLead(auto, board.cwd)); return key ? { groups: key } : {}; };
      // REQ-84: a busy mark set or turned off changes the plugin's file, not the revision; its fingerprint says so.
      const marks = (await busyState())?.marks;
      const busy = (board: Board) => {
        const key = busyKey(busyOf(marks, board.id), new Set(board.cards.filter(c => c.archivedAt === null).map(c => c.id)));
        return key ? { busy: key } : {};
      };
      // REQ-90: a screen whose lab badge is on sends its host; the folder's fingerprint changes without the ledger.
      let messages: MailDTO | undefined;
      if (value.hostId !== undefined) {
        try { messages = await mailFor((await readUiState(store.dataDir, value.hostId)).settings); } catch { messages = undefined; }
      }
      return { boards: result.boards.map(b => ({ id: b.id, revision: b.revision, state: 'ready' as const, ...groups(b), ...busy(b) })),
        errors: result.errors, removedIds: result.removedIds, observedAt: now(), ...autoHealth(), ...(messages ? { mail: messages.key } : {}) };
    }),
  };
}
