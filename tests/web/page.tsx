// REQ-79~81 headless page: the real Kanban screen (client/overview.tsx) under react-native-web, against a fake server
// that answers from the fixture run.mjs wrote (window.__FIXTURE__). Settings writes are kept in window.__writes.
import { createRoot } from 'react-dom/client';
import { OverviewScreen } from '../../client/overview.js';
import { BoardScreen } from '../../client/board.js';
import { SignalContext } from '../../client/signal-context.js';
import { useLiveSignals } from '../../client/agent-signals.js';

type Reads = { overview: Record<string, unknown>; boards: Record<string, Record<string, unknown>> };
type Snapshot = { boardId: string; revision: string; card: Record<string, unknown> & { id: string; stageId: string };
  history: { cardId: string; from: string | null; to: string; at: string; revision: string; actor: unknown }[] };
type Fixture = Reads & { later?: Reads; ui: Record<string, unknown>; agents?: unknown[]; cards?: Record<string, Snapshot>;
  /** REQ-126: each provider's model list, as `providers.listModels` answers it; absent = a host without it. */
  models?: Record<string, unknown[]>;
  projects: unknown; workspaces: unknown; theme: { colors: Record<string, string> }; width: number; mobile: boolean;
  /** REQ-142: the workspace panel of this workspace instead of the overview (client/panel.tsx without the host's title). */
  panel?: string };
declare global { interface Window { __FIXTURE__: Fixture; __writes: unknown[]; __calls: string[]; __inputs: { name: string; input: unknown }[];
  __remember: () => void; __failNext: 'failed' | 'lost' | null; __cards: Map<string, Snapshot>; __opened: [string, string][];
  __busyOff: (cardId: string) => boolean;
  /** REQ-130: a busy mark turned on (the detail's memo, kanban.v1.busy.set) and a live agent event (the host's directory). */
  __busyOn: (cardId: string, mark: { text: string; since: string; by: string }) => void; __agentUpsert: (agent: Record<string, unknown>) => void;
  /** REQ-125: the next pick refused with this code (E_CORRUPT: the picks file could not be read). */
  __pickFail?: string | null; __exportFail?: string | null; __exportFailDetails?: unknown; __exportPickKept?: boolean } }
const fixture = window.__FIXTURE__;
// REQ-76 F1: what the server reads now; __remember() is the plugin remembering parents after the screen's first read.
let reads: Reads = fixture;
window.__remember = () => { if (fixture.later) reads = fixture.later; };
let ui = structuredClone(fixture.ui) as { settings?: Record<string, unknown> };
window.__writes = []; window.__calls = []; window.__inputs = [];
/** D44: the workspace folders whose auto cards are off, as the server keeps them (the settings window's switches). */
let autoOff: string[] = [];
const respond = (value: unknown) => ({ ok: true, data: { ...(value as object), about: { version: 'harness' } }, committed: false, warnings: [] });
// REQ-88: every card as `kanban.v1.card.get` answers it, changed by the writes below (a field's update, a move), each write
// one revision later on its board. `window.__failNext` refuses the next write ('failed') or loses its reply after applying it ('lost').
const cards = new Map(Object.entries(structuredClone(fixture.cards ?? {})));
window.__cards = cards; window.__failNext = null;
const next = (revision: string) => { const [epoch, seq] = revision.split(':'); return epoch + ':' + (Number(seq) + 1); };
/**
 * REQ-84: a busy mark turned off — by the detail's "Turn off" (kanban.v1.busy.clear) or, from outside the screen, by
 * `window.__busyOff` (a `kanban card busy --off`). As on the server, only the mark and its board's fingerprint change; the
 * revision stays, so an open screen hears of it through `summary.busy` in revisions.get. Research/174 J2: the card then says
 * when the mark ended (`busyEndedAt`), as the server's read does.
 */
type BoardView = { summary: { id: string; busy?: string }; stages: { cards: { id: string; busy?: unknown; busyEndedAt?: string }[] }[] };
window.__busyOff = cardId => {
  let had = false;
  const views = [...Object.values(reads.boards).map(b => b.board as BoardView), ...((reads.overview.boardViews ?? []) as BoardView[])];
  for (const view of views) {
    let hit = false;
    for (const stage of view.stages) for (const card of stage.cards) if (card.id === cardId && card.busy) { delete card.busy; card.busyEndedAt = new Date().toISOString(); hit = had = true; }
    if (!hit) continue;
    if (view.stages.some(stage => stage.cards.some(card => card.busy))) view.summary.busy = (view.summary.busy ?? '') + '~';
    else delete view.summary.busy;
  }
  const snapshot = cards.get(cardId) as (Snapshot & { busy?: unknown }) | undefined;
  if (snapshot?.busy) { snapshot.busy = null; had = true; }
  return had;
};
/** REQ-130: a mark turned on — as `__busyOff` in reverse: the mark on every read of the card, the fingerprint moved. */
window.__busyOn = (cardId, mark) => {
  const views = [...Object.values(reads.boards).map(b => b.board as BoardView), ...((reads.overview.boardViews ?? []) as BoardView[])];
  for (const view of views) for (const stage of view.stages) for (const card of stage.cards) if (card.id === cardId) {
    card.busy = mark; delete card.busyEndedAt; view.summary.busy = (view.summary.busy ?? '') + '+'; }
  const snapshot = cards.get(cardId) as (Snapshot & { busy?: unknown }) | undefined;
  if (snapshot) snapshot.busy = mark;
};
/** research/187 J3: a draft added to `boardId`'s first column in every read of that board, one revision later. */
let drafts = 0;
type DraftView = { summary: { id: string; revision: string }; stages: { stageId: string; cards: Record<string, unknown>[] }[] };
function addDraft(boardId: string, op: { title?: string; nextAction?: string; priority?: string }): string {
  const id = 'card_' + String(++drafts).padStart(8, '0') + '-0187-4000-8000-000000000000', at = new Date().toISOString();
  for (const entry of Object.values(reads.boards)) {
    const view = entry.board as DraftView;
    if (view.summary.id === boardId) { entry.revision = next(String(entry.revision)); view.summary.revision = String(entry.revision); }
  }
  const views = [...Object.values(reads.boards).map(b => b.board as DraftView), ...((reads.overview.boardViews ?? []) as DraftView[])];
  for (const view of new Set(views)) if (view.summary.id === boardId && view.stages[0]) view.stages[0].cards.push({ id, title: op.title ?? '',
    stageId: view.stages[0].stageId, priority: op.priority ?? 'normal', intent: 'draft', blocked: false, nextAction: op.nextAction ?? '',
    agents: 0, awaiting: null, agentIds: [], completedAt: null, updatedAt: at, createdAt: at, stageEnteredAt: at });
  return id;
}
/** REQ-125: the built-in each workspace is trying, as `workflow-picks.json` would keep it (memory only). */
const workflowPicks: Record<string, string> = { ...((window.__FIXTURE__ as { workflowPicks?: Record<string, string> }).workflowPicks ?? {}) };
/** 281 F1: each board view's `leadNow` as the fixture gave it, before a mark was set from the menu. */
const leadBase = new WeakMap<object, unknown>();
window.__rpc = async (name, input) => {
  window.__calls.push(name); window.__inputs.push({ name, input });
  const value = input as Record<string, unknown>;
  // REQ-90: the folder's reading only while the lab's badge is on, as the server says it.
  if (name === 'kanban.v1.overview.get') { const { mail, ...rest } = reads.overview as { mail?: unknown };
    return respond({ ...rest, ui, autoCardsOff: autoOff, ...(mail && (ui.settings as { labs?: { mail?: boolean } } | undefined)?.labs?.mail ? { mail } : {}) }); }
  if (name === 'kanban.v1.board.get') {
    // REQ-142: the workspace panel asks by its workspace, as client/panel.tsx does.
    const id = value.boardId ?? Object.keys(reads.boards).find(key => (reads.boards[key].board as { summary: { workspaceId: string } }).summary.workspaceId === value.workspaceId);
    return respond({ ...reads.boards[String(id)], ...(ui.settings ? { settings: ui.settings } : {}) });
  }
  // Like the server: the groups only when asked for (REQ-76 F1).
  if (name === 'kanban.v1.revisions.get') return respond({ observedAt: '2026-09-26T00:00:00.000Z', removedIds: [], errors: [],
    boards: Object.values(reads.boards).map(b => { const summary = (b.board as { summary: { id: string; groups?: string } }).summary;
      return { id: summary.id, revision: b.revision, state: 'ready', ...(value.groups && summary.groups ? { groups: summary.groups } : {}),
        ...((summary as { busy?: string }).busy ? { busy: (summary as { busy?: string }).busy } : {}) }; }),
    // REQ-90: like the server, the message folder's fingerprint to a look that says its host, while the lab's badge is on.
    ...(value.hostId && (reads.overview as { mail?: { key: string } }).mail && (ui.settings as { labs?: { mail?: boolean } } | undefined)?.labs?.mail
      ? { mail: (reads.overview as { mail: { key: string } }).mail.key } : {}) });
  // REQ-124: a lane's workflow as the server read it from the fixture's made-up workspace (tests/fixtures/workflow-fixtures.mjs).
  if (name === 'kanban.v1.workflow.get') {
    const data = (reads as { workflow?: Record<string, unknown> }).workflow?.[String(value.workspaceId)];
    // REQ-125: like the server, a workspace with no file shows the built-in it is trying (the real reader's model, both languages).
    const picked = workflowPicks[String(value.workspaceId)], locale = String((reads.overview as { locale?: string }).locale ?? 'ko');
    const builtin = picked ? (reads as { builtins?: Record<string, unknown> }).builtins?.[picked + '-' + locale] : undefined;
    if (data && picked && (data as { defined?: boolean }).defined) return respond({ ...data, restingPick: picked });
    return respond(data ?? builtin ?? { defined: false, reason: 'missing', definitionPath: '.kanban/workflow.json' });
  }
  // REQ-125: a pick kept (here: in memory) and the board views' summaries saying it, as the server's next reading would.
  if (name === 'kanban.v1.workflow.pick.set') {
    const fail = window.__pickFail; window.__pickFail = null;
    if (fail) return { ok: false, committed: false, error: { code: fail, message: 'Synthetic refusal.', target: '', nextAction: 'Retry.', details: null } };
    const workspace = String(value.workspaceId), template = value.template === null ? null : String(value.template), before = workflowPicks[workspace] ?? null;
    if (template) workflowPicks[workspace] = template; else delete workflowPicks[workspace];
    const hasFile = !!(reads as { workflow?: Record<string, unknown> }).workflow?.[workspace];
    const views = [...Object.values(reads.boards).map(b => b.board as { summary: Record<string, unknown> }), ...((reads.overview.boardViews ?? []) as { summary: Record<string, unknown> }[])];
    for (const view of views) if (view.summary.workspaceId === workspace && !hasFile) {
      if (template) { view.summary.workflow = true; view.summary.workflowPick = template; } else { delete view.summary.workflow; delete view.summary.workflowPick; }
    }
    return respond({ template, changed: before !== template });
  }
  // REQ-52 (research/294): the automatic archive's days, the done column's "Tidy", the archived list and its restore — as the
  // server would answer, changing every read of the board (`reads.archived` is the list, latest first).
  type Archived = { cards: { id: string; title: string; stageId: string; archivedAt: string; auto?: true; done: boolean }[]; total: number; archivedDone: number };
  type View52 = { summary: { id: string; progress: { archivedDone?: number } }; stages: { stageId: string; countsAsDone: boolean; totalCount: number; cards: Record<string, unknown>[] }[] };
  const archived52 = (reads as { archived?: Record<string, Archived> }).archived;
  const views52 = (id: string) => [...new Set([...Object.values(reads.boards).map(b => b.board as View52), ...((reads.overview.boardViews ?? []) as View52[])])]
    .filter(v => v.summary.id === id);
  if (name === 'kanban.v1.archive.settings.set') {
    const before = (reads.overview.autoArchive as { days?: number } | undefined)?.days, days = Number(value.days);
    reads.overview.autoArchive = { days };
    for (const b of Object.values(reads.boards)) (b as Record<string, unknown>).autoArchive = { days };
    return respond({ days, changed: before !== days });
  }
  if (name === 'kanban.v1.archived.list') return respond(structuredClone(archived52?.[String(value.boardId)] ?? { cards: [], total: 0, archivedDone: 0 }));
  if (name === 'kanban.v1.archive.tidy') {
    const id = String(value.boardId), list = archived52?.[id], at = new Date().toISOString();
    const moved: { id: string; title: string; stageId: string }[] = [];
    for (const [i, view] of views52(id).entries()) for (const stage of view.stages) if (stage.countsAsDone) {
      if (!i) moved.push(...stage.cards.map(c => ({ id: String(c.id), title: String(c.title), stageId: stage.stageId })));
      stage.cards = []; stage.totalCount = 0;
    }
    for (const view of views52(id)) view.summary.progress.archivedDone = (view.summary.progress.archivedDone ?? 0) + moved.length;
    if (list) { list.cards.unshift(...moved.map(c => ({ ...c, archivedAt: at, done: true }))); list.total += moved.length; list.archivedDone += moved.length; }
    return respond({ archived: moved.length });
  }
  if (name === 'kanban.v1.archived.restore') {
    const id = String(value.boardId), list = archived52?.[id], index = list ? list.cards.findIndex(c => c.id === value.cardId) : -1;
    if (!list || index < 0) return respond({ changed: false });
    const [card] = list.cards.splice(index, 1); list.total--; if (card!.done) list.archivedDone--;
    const at = new Date().toISOString();
    for (const view of views52(id)) {
      if (card!.done) view.summary.progress.archivedDone = Math.max(0, (view.summary.progress.archivedDone ?? 0) - 1);
      const stage = view.stages.find(s => s.stageId === card!.stageId);
      if (stage) { stage.cards.push({ id: card!.id, title: card!.title, stageId: stage.stageId, priority: 'normal', intent: 'requested', blocked: false, nextAction: '',
        agents: 0, awaiting: null, agentIds: [], completedAt: stage.countsAsDone ? at : null, updatedAt: at, createdAt: at, stageEnteredAt: at }); stage.totalCount++; }
    }
    return respond({ changed: true });
  }
  // REQ-125 2단계: an export — the workspace then has the file (the real reader's answer for the written built-in, `exported`),
  // the pick is taken out and the summaries say "a file, no pick", as the server's next reading would. `__exportFail` refuses once.
  if (name === 'kanban.v1.workflow.export') {
    const fail = window.__exportFail, details = window.__exportFailDetails ?? null; window.__exportFail = null; window.__exportFailDetails = null;
    // 295-F4: `__exportFailDetails` — the server's `details` (a folder moved while writing: `{ left: [full paths] }`).
    if (fail) return { ok: false, committed: false, error: { code: fail, message: 'Synthetic refusal.', target: '', nextAction: 'Retry.', details } };
    const workspace = String(value.workspaceId), template = String(value.template), locale = String((reads.overview as { locale?: string }).locale ?? 'ko');
    if (workflowPicks[workspace] !== template) return { ok: false, committed: false, error: { code: 'E_CONFLICT', message: 'Not the pick.', target: '', nextAction: '', details: null } };
    const store = reads as { workflow?: Record<string, unknown>; exported?: Record<string, unknown> };
    (store.workflow ??= {})[workspace] = store.exported?.[template + '-' + locale];
    // 293-J3: `__exportPickKept` — the pick could not be taken out: it stays (and rests under the file).
    const kept = !!window.__exportPickKept; window.__exportPickKept = false;
    if (!kept) delete workflowPicks[workspace];
    const views = [...Object.values(reads.boards).map(b => b.board as { summary: Record<string, unknown> }), ...((reads.overview.boardViews ?? []) as { summary: Record<string, unknown> }[])];
    for (const view of views) if (view.summary.workspaceId === workspace) { view.summary.workflow = true; delete view.summary.workflowPick; }
    return respond({ path: '.kanban/workflow.json', template, pickCleared: !kept });
  }
  // REQ-128: the lab's message list and its threads as the server would read them, only while the lab's switch is on.
  if (name === 'kanban.v1.mail.list' || name === 'kanban.v1.mail.thread') {
    const labs = (ui.settings as { labs?: { mail?: boolean; mailDir?: string } } | undefined)?.labs, on = !!labs?.mail && !!labs.mailDir;
    const mail = reads as { mailList?: unknown; mailThreads?: Record<string, unknown> };
    if (name === 'kanban.v1.mail.list') return respond(on && mail.mailList ? mail.mailList : { state: 'off', key: 'off', threads: [], limits: [], readAt: '2026-10-01T00:00:00.000Z' });
    return respond((on && mail.mailThreads?.[String(value.thread)]) ?? { state: on ? 'missing' : 'off', id: String(value.thread), files: [], latest: 0, more: 0 });
  }
  // v0.1.46-B: like the server, the agent a draft would go to (the fixture's `dispatchPreview`) with the card as read; nothing is sent.
  if (name === 'kanban.v1.dispatch.preview') {
    const snapshot = cards.get(String(value.cardId)), base = (reads as { dispatchPreview?: Record<string, unknown> }).dispatchPreview;
    if (snapshot && base) return respond({ ...base, revision: snapshot.revision, card: snapshot.card, to: 'doing' });
  }
  if (name === 'kanban.v1.busy.clear') return respond({ changed: window.__busyOff(String(value.cardId)) });
  if (name === 'kanban.v1.busy.set') {
    const mark = { text: String(value.text).replace(/\s+/g, ' ').trim(), since: new Date().toISOString(), by: 'screen' };
    window.__busyOn(String(value.cardId), mark);
    return respond({ changed: true, busy: mark });
  }
  if (name === 'kanban.v1.card.get') {
    const snapshot = cards.get(String(value.cardId));
    if (snapshot) return respond({ ...structuredClone(snapshot), history: snapshot.history.filter(h => h.cardId === value.cardId),
      // research/236 D5: a scene may read its cards in another language (`cardLocale`).
      locale: (reads as { cardLocale?: string }).cardLocale ?? 'en',
      observedAt: '2026-09-26T00:00:00.000Z' });
  }
  // REQ-76: a quick move is accepted and nothing else changes on the board read; the screen keeps drawing it moved (REQ-82 ③).
  // REQ-88: the card read (above) takes the write, so the detail sees its own saves and moves.
  if (name === 'kanban.v1.board.mutate') {
    const fail = window.__failNext; window.__failNext = null;
    if (fail === 'failed') return { ok: false, committed: false, error: { code: 'E_LOCK_TIMEOUT', message: 'Synthetic refusal.', target: String(value.boardId),
      nextAction: 'Retry.', details: null } };
    const own = [...cards.values()].filter(c => c.boardId === value.boardId);
    const revision = own.length ? next(own[0]!.revision) : 'harness:2';
    const added: string[] = [];
    for (const op of value.operations as { op: string; id: string; patch?: Record<string, unknown>; to?: string }[]) {
      // research/187 J3: an add puts a plain draft at the end of the board's first column, as the server's read would
      // show it (a normal-priority draft, newest), so the screen can bring it into sight.
      if (op.op === 'add') { added.push(addDraft(String(value.boardId), op as unknown as { title?: string; nextAction?: string; priority?: string })); continue; }
      const snapshot = cards.get(op.id);
      if (!snapshot) continue;
      if (op.op === 'update') snapshot.card = { ...snapshot.card, ...op.patch };
      if (op.op === 'move' && op.to) { snapshot.history = [...snapshot.history, { cardId: op.id, from: snapshot.card.stageId, to: op.to,
        at: new Date().toISOString(), revision, actor: { kind: 'user' } }]; snapshot.card = { ...snapshot.card, stageId: op.to }; }
    }
    for (const snapshot of own) snapshot.revision = revision;
    if (fail === 'lost') throw new Error('Synthetic lost reply');
    return { ok: true, committed: true, warnings: [], data: { boardId: value.boardId,
      revision, currentRevision: revision, requestId: value.requestId, cardIds: added, changed: true, replayed: false } };
  }
  // REQ-137: the card ⋯ "Mark as lead" — as the server, the board views' `summary.lead` and their fingerprint change, the ledger not.
  // 281 F1: and the server's judgement (`leadNow`): the marked chat while marked, the fixture's own answer once taken off.
  if (name === 'kanban.v1.auto_cards.lead.set') {
    type LeadView = { summary: { id: string; lead?: string; groups?: string; leadNow?: unknown }; stages: { cards: { id: string; agentIds: string[] }[] }[] };
    const views = [...Object.values(reads.boards).map(b => b.board as LeadView), ...((reads.overview.boardViews ?? []) as LeadView[])].filter(v => v.summary.id === value.boardId);
    const card = views.flatMap(v => v.stages.flatMap(s => s.cards)).find(c => c.id === value.cardId);
    const agentId = card?.agentIds.find(id => !!id) ?? null, previous = views[0]?.summary.lead ?? null;
    const lead = value.lead === true ? agentId : previous && card?.agentIds.includes(previous) ? null : previous;
    for (const view of views) {
      if (!leadBase.has(view)) leadBase.set(view, view.summary.leadNow);
      if (lead) { view.summary.lead = lead; view.summary.leadNow = { agentId: lead, title: '', by: 'set' }; }
      else { delete view.summary.lead; if (leadBase.get(view) === undefined) delete view.summary.leadNow; else view.summary.leadNow = leadBase.get(view); }
      view.summary.groups = (view.summary.groups ?? '') + '*';
    }
    return respond({ lead, previous, changed: lead !== previous });
  }
  if (name === 'kanban.v1.auto_cards.workspace.set') {
    const key = String(value.cwd).replace(/[\\/]+$/, ''), on = value.enabled === true;
    autoOff = on ? autoOff.filter(k => k !== key) : [...new Set([...autoOff, key])];
    return respond({ enabled: on, changed: true });
  }
  if (name === 'kanban.v1.ui.set') {
    window.__writes.push(input);
    const settings = value.settings ? { ...ui.settings, ...(value.settings as object) } : ui.settings;
    ui = { ...ui, ...(settings ? { settings } : {}) };
    return respond({ ...ui, changed: true });
  }
  return { ok: false, committed: false, error: { code: 'E_HARNESS', message: 'Not in the headless page: ' + name, target: '', nextAction: '', details: null } };
};
const agentHandlers = new Set<(update: unknown) => void>();
window.__agentUpsert = agent => { for (const handler of [...agentHandlers]) handler({ kind: 'upsert', agent }); };
window.__sdk = {
  ...(fixture.models ? { providers: { listModels: async (provider: string) => ({ provider, models: fixture.models?.[provider] ?? [], error: null,
    fetchedAt: '2026-10-01T00:00:00.000Z', requestId: 'models' }) } } : {}),
  projects: { list: async () => fixture.projects },
  workspaces: { list: async () => fixture.workspaces },
  // REQ-85 ⑥: the fixture's agents, so a card has a state mark and a model to explain.
  agents: { list: async () => ({ requestId: 'agents', subscriptionId: null, entries: (fixture.agents ?? []).map(agent => ({ agent, project: null })),
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }),
    // REQ-130: live events, as the host's directory sends them (`window.__agentUpsert`).
    subscribe: (handler: (update: unknown) => void) => { agentHandlers.add(handler); return () => { agentHandlers.delete(handler); }; },
    ref: (id: string) => ({ id, refresh: async () => null }) },
};
// REQ-96: the host's navigation, as Paseo hands it to a surface; what was opened is kept in window.__opened.
window.__opened = [];
const navigation = { openAgent: (input: { agentId: string }) => window.__opened.push(['agent', input.agentId]),
  openWorkspace: (input: { workspaceId: string }) => window.__opened.push(['workspace', input.workspaceId]) };
const props = { theme: fixture.theme, host: { id: 'host_example', label: 'Example host' },
  layout: { platform: 'web', compact: fixture.mobile }, navigation } as never;
const root = createRoot(document.getElementById('root')!);
let mounted = 0;
function Panel(surface: Record<string, unknown> & { host: { id: string } }) {
  const signals = useLiveSignals(surface.host.id, true);
  return <SignalContext.Provider value={signals}><BoardScreen {...(surface as never)} panel selector={{ workspaceId: fixture.panel! }} /></SignalContext.Provider>;
}
const draw = (theme: unknown) => root.render(fixture.panel ? <Panel key={mounted} {...(props as object as { host: { id: string } })} theme={theme} />
  : <OverviewScreen key={mounted} {...(props as object)} theme={theme} />);
draw(fixture.theme);
/** D48: the host handing over its other theme — `remount` as Paseo does, drawing the surface anew (its React state gone). */
(window as unknown as { __hostTheme: (theme: unknown, remount: boolean) => void }).__hostTheme = (theme, remount) => { if (remount) mounted++; draw(theme); };
