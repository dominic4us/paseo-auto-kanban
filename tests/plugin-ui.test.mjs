import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import ts from 'typescript';
import { enteredOf, stageEntries, stageEntry, toBoardDTO, toEmptyBoardDTO, toOverview } from '../dist/server/read-model.js';
import { palette, contrast, luminance, readable, crownColor, crownColors, medalColors, leaderOutline, selectedLine, selectedTint, markLine, replyColor, replyChip, viewedTint, fieldLine, PASEO_THEMES, resolveTheme } from '../dist/client/palette.js';
import { SWIMLANE, swimlaneWidth } from '../dist/client/swimlane-model.js';
import { projectHeaderHeight, STICKY } from '../dist/client/layout.js';
import { applyOperations } from '../dist/shared/core/domain.js';
import { cardParents, groupsKey } from '../dist/server/card-parents.js';
import { deviceClock } from '../dist/client/lead-status.js';
import { board, context, actor, add } from './helpers.mjs';
import { readWorkflow } from '../dist/server/workflow.js';
import { gateDefinition, gateFiles, otherDefinition, otherFiles, writeWorkspace } from './fixtures/workflow-fixtures.mjs';

const nativeRequire = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// REQ-69: the demo switch shows only behind the developer entry, a key in the browser's storage (client/demo.ts).
// Every harness starts without it; `devDemo()` sets it the way a headless script does.
const devStorage = new Map();
globalThis.localStorage = { getItem: key => devStorage.get(key) ?? null };
const devDemo = () => devStorage.set('paseo-kanban:dev-demo', '1');
/** Minimal agent snapshot: only the signal fields the plugin reads (see the installed protocol schema). */
function agentSnapshot(id, patch = {}) {
  return { id, status: 'idle', requiresAttention: false, attentionReason: null, pendingPermissions: [],
    archivedAt: null, title: 'Agent ' + id, ...patch };
}
const AGENT_A = '11111111-1111-4111-8111-111111111111', AGENT_B = '22222222-2222-4222-8222-222222222222';
const UNLISTED = ['33333333-3333-4333-8333-333333333331', '33333333-3333-4333-8333-333333333332',
  '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333335'];
// Every harness loads its own copy of the client modules (fresh module state, its own mocks), but the TypeScript
// output of an unchanged file is the same each time: transpiling the ~1MB client once per file, not once per harness,
// is what keeps this file's run time down. Keyed by the source text, so a file changed meanwhile is transpiled again.
const transpiled = new Map();
function transpile(file) {
  const source = fs.readFileSync(file, 'utf8'), hit = transpiled.get(file);
  if (hit?.source === source) return hit.output;
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  transpiled.set(file, { source, output });
  return output;
}
function harness({ mobile = false, sdkFails = false, panel = false, platform = 'ios', width = 390, fontScale = 1,
  labelsAvailable = true, link = [], agents = [], agentsFail = false, lookups = {}, holdLookups = false,
  // REQ-57: Paseo workspaces that have no ledger board yet, and what the ledger remembered for this host.
  empty = [], noCards = false, about = {version: '0.1.2'}, hiddenProjects = [], emptyProject = 'prj_example01',
  // REQ-59: the order the ledger remembered for this host.
  order = { projects: [], workspaces: [] },
  // REQ-61 ⑧: the auto-card switch the server remembered for this host (undefined = field absent).
  autoCards = undefined,
  // D25: the base board sits at its project's root folder, which no Paseo workspace carries.
  rootBoard = false,
  // REQ-65: the base project's and workspace's names, and the branch Paseo reports per workspace id.
  projectName = 'Example Project', workspaceName = 'Example Workspace', branches = {},
  // REQ-66: the settings the ledger remembered for this host (undefined = none saved yet).
  uiSettings = undefined,
  // REQ-70: the device's colour scheme as RN's useColorScheme reports it (null = not known).
  colorScheme = null,
  // D29: the system "reduce motion" setting a phone sheet's rise/drop checks before it animates.
  reduceMotion = false,
  // REQ-74: why the card is where it is and its automatic tracking, as card.get reports them (undefined = absent).
  cardAuto = undefined,
  // REQ-77 ②: who made the example card (the ledger's `createdBy`).
  author = actor,
  // REQ-77+78 gate a: the language the ledger is set to, as the overview and board reads report it.
  locale = 'en',
  // REQ-76: which card sits under which, as the server works it out (board → Map of card id → parent card id).
  groups = undefined,
  // REQ-83: the server's automatic tracking as every read reports it (undefined = field absent).
  autoHealth = undefined,
  // REQ-85 ⑧: the host's clipboard — 'ok', 'fail' (it rejects) or 'missing' (a host without copyText).
  copy = 'ok',
  // REQ-87 ⑦: the phone's whole screen height (the window is 844) and its status bar; equal means drawn edge to edge.
  screenHeight = 844, statusBar = 0,
  // REQ-97: the lead the confirmation sheet names (null = the workspace has none).
  dispatchLead = { agentId: AGENT_B, title: '총괄-07_Sample-App_Fable' },
  // v0.1.46-B: the board's language the server reports for the message (undefined = an older server, Korean).
  dispatchLocale = undefined,
  // 253-D3: why the preview names nobody (undefined = an older server, the "no agent" words).
  dispatchHeld = undefined,
  // REQ-90: what the server reads from the message folder (null = nothing there); said only while the host's lab badge is on.
  mailbox = null,
  // REQ-124: what the server reads as the base workspace's workflow; given, the overview marks its lane (`summary.workflow`).
  workflow = undefined,
  // REQ-128: the lab's message list as the server reads it (with the switch on and a folder set), and its threads by id.
  mailList = undefined, mailThreads = {},
  // REQ-126: each provider's model list (`providers.listModels`), 'fail' for one that rejects; undefined = a host without it.
  models = undefined } = {}) {
  const keyboardHandlers = [];
  let health = autoHealth;
  const copies = [];
  const withHealth = value => health ? { ...value, autoHealth: structuredClone(health) } : value;
  // REQ-90: like the server, the folder only with the host, the badge on and a folder set.
  const mailOn = () => !!mailbox && !!ui.settings?.labs?.mail && !!ui.settings?.labs?.mailDir;
  devStorage.clear();
  // REQ-76 F1: a parent remembered later changes the groups (`setGroups`) and not the ledger's revision.
  let groupsOf = groups;
  // REQ-70 F1: the device scheme behaves like the browser's MediaQueryList under react-native-web: a change
  // calls the listeners registered when it began, one at a time with React's updates flushed in between, and
  // skips one removed meanwhile.
  const scheme = { value: colorScheme, listeners: [] };
  const Appearance = { getColorScheme: () => scheme.value,
    addChangeListener: listener => { const entry = { listener }; scheme.listeners.push(entry);
      return { remove: () => { entry.removed = true; scheme.listeners = scheme.listeners.filter(e => e !== entry); } }; } };
  let base = applyOperations(board(), [{ ...add('Example card'), awaiting: 'user', nextAction: 'Check the result' }],
    author, context()).board;
  if (link.length) base = applyOperations(base, link.map(entry => ({ op: 'link', id: base.cards[0].id,
    role: 'worker', label: 'Agent ' + entry.slice(0, 4), agentId: entry })), actor, context()).board;
  if (noCards) base = board();
  const receipts = new Map(); let outcome = 'ok';
  let pending = [...empty], ui = { hiddenProjects: [...hiddenProjects], order: structuredClone(order),
    ...(uiSettings ? { settings: structuredClone(uiSettings) } : {}) };
  const uiWrites = [], ensureCalls = [], autoWrites = [];
  const extra = new Map();
  const emptyViews = () => pending.map(id => toEmptyBoardDTO(id, '/tmp/' + id, 'en'));
  const calls = [], sdkCalls = [], agentCalls = [], agentHandlers = new Set(), refCalls = [], refPending = [];
  const appStateHandlers = new Set(), motion = { started: 0, stopped: 0, config: null, calls: [] };
  let directoryAgents = agents.map(value => typeof value === 'string' ? agentSnapshot(value) : agentSnapshot(value.id, value));
  let fail = false;
  const respond = value => ({ok:true,data:{...value,about},committed:false,warnings:[]});
  // REQ-84/130: the base board's busy marks (card id → { text, since, by }), as the server reads busy.json; set by a test
  // (`setBusy`) or by the screen's busy.set / busy.clear, which change no revision — only the fingerprint below.
  const busyMarks = new Map(), busyOn = b => b === base && busyMarks.size ? new Map(busyMarks) : undefined;
  const busyKey = () => busyMarks.size ? 'k' + [...busyMarks].map(([id, e]) => id + e.since + e.text).join('').length + ':' + [...busyMarks].map(([, e]) => e.since + e.text).join('|').slice(0, 40) : undefined;
  const replies = {
    'kanban.v1.busy.set': input => {
      const text = input.text.replace(/\s+/g, ' ').trim();
      if (!text || [...text].length > 200) return { ok: false, committed: false, error: { code: 'E_VALIDATION', message: 'Busy text must be 1-200 characters.', target: 'text', nextAction: '' } };
      const mark = { text, since: new Date(Date.now()).toISOString(), by: 'screen' };
      busyMarks.set(input.cardId, mark); return respond({ changed: true, busy: mark }); },
    'kanban.v1.busy.clear': input => respond({ changed: busyMarks.delete(input.cardId) }),
    'kanban.v1.board.mutate': input => {
      if (receipts.has(input.requestId)) return { ...receipts.get(input.requestId), committed: false,
        data: { ...receipts.get(input.requestId).data, changed: false, replayed: true } };
      if (outcome === 'conflict') {
        outcome = 'ok'; base = applyOperations(base, [{ op: 'update', id: base.cards[0].id,
          patch: { notes: 'Remote notes', nextAction: 'Remote next action' } }], actor, context()).board;
      }
      if (input.ifRevision !== base.revision) return { ok: false, committed: false,
        error: { code: 'E_REVISION_CONFLICT', message: 'Board changed.', target: base.id, nextAction: 'Compare.', details: null } };
      if (outcome === 'failed') return { ok: false, committed: false,
        error: { code: 'E_LOCK_TIMEOUT', message: 'Synthetic refusal.', target: base.id, nextAction: 'Retry.', details: { reclaimableAtMs: Date.now() + 60000 } } };
      const operations = input.operations.map(op => op.op === 'add' ? { ...op, intent: 'draft', acceptanceCriteria: '' } : op);
      const result = applyOperations(base, operations, actor, context(), 'board'); base = result.board;
      // REQ-82: like the server (server/auto-cards.ts), a person's move is the card's reason and pauses its tracking.
      if (cardAuto !== undefined && result.changed && operations.some(op => op.op === 'move')) {
        const at = new Date().toISOString();
        cardAuto = { ...cardAuto, reason: { by: 'user', cause: null, agentId: null, at, created: false },
          ...(cardAuto.tracking ? { tracking: { state: 'paused', since: at } } : {}) };
      }
      const reply = { ok: true, committed: result.changed, warnings: [], data: { boardId: base.id,
        revision: base.revision, currentRevision: base.revision, requestId: input.requestId,
        cardIds: result.cardIds, changed: result.changed, replayed: false } };
      if (result.changed) receipts.set(input.requestId, reply);
      if (outcome === 'lost') { outcome = 'ok'; throw new Error('Synthetic lost response'); }
      return reply;
    },
    'kanban.v1.board.ensure': input => {
      ensureCalls.push(input);
      if (outcome === 'ensureFailed') { outcome = 'ok'; return { ok: false, committed: false,
        error: { code: 'E_CWD_MISSING', message: 'Workspace directory does not exist.', target: input.workspaceId,
          nextAction: 'Restore the directory.', details: null } }; }
      let created = extra.get(input.workspaceId);
      const fresh = !created;
      if (!created) { created = { ...board(), id: 'board_' + 'c'.repeat(63) + String(extra.size),
        workspaceId: input.workspaceId, cwd: '/tmp/' + input.workspaceId }; extra.set(input.workspaceId, created); }
      const result = applyOperations(created, input.operations.map(op => ({ ...op, intent: 'draft', acceptanceCriteria: '' })), actor, context());
      extra.set(input.workspaceId, result.board);
      pending = pending.filter(id => id !== input.workspaceId);
      return { ok: true, committed: true, warnings: [], data: { boardId: result.board.id, revision: result.board.revision,
        currentRevision: result.board.revision, requestId: input.requestId, cardIds: result.cardIds,
        changed: result.changed, replayed: false, created: fresh } };
    },
    'kanban.v1.ui.set': input => {
      // REQ-66: a refused write (disk full, lock) or a lost reply, once; nothing changes.
      if (outcome === 'uiFailed') { outcome = 'ok'; uiWrites.push(input); return { ok: false, committed: false,
        error: { code: 'E_IO', message: 'Synthetic write failure.', target: '', nextAction: 'Retry.', details: null } }; }
      if (outcome === 'uiLost') { outcome = 'ok'; uiWrites.push(input); throw new Error('Synthetic lost response'); }
      // Like the server: each field is optional and only a real difference counts as a change.
      const settings = input.settings ? { ...ui.settings, ...input.settings } : ui.settings;
      const next = { hiddenProjects: [...(input.hiddenProjects ?? ui.hiddenProjects)], order: structuredClone(input.order ?? ui.order),
        ...(settings ? { settings } : {}) };
      const changed = JSON.stringify(next) !== JSON.stringify(ui);
      uiWrites.push(input); if (changed) ui = next;
      return respond({ ...structuredClone(ui), changed }); },
    'kanban.v1.auto_cards.set': input => {
      if (outcome === 'autoFailed') { outcome = 'ok'; autoWrites.push(input); return { ok: false, committed: false,
        error: { code: 'E_IO', message: 'Synthetic write failure.', target: '', nextAction: 'Retry.', details: null } }; }
      const changed = input.enabled !== (autoCards ?? true);
      autoWrites.push(input); autoCards = input.enabled;
      return respond({ enabled: input.enabled, changed }); },
    'kanban.v1.overview.get': input => respond(withHealth({ ...toOverview([base, ...extra.values()], locale, base.updatedAt),
      boards: [...toOverview([base, ...extra.values()], locale, base.updatedAt).boards, ...emptyViews().map(b => ({ ...b.summary, needsHuman: 0 }))],
      ...(input.hostId !== undefined ? { ui: structuredClone(ui), ...(autoCards === undefined ? {} : { autoCards }) } : {}),
      ...(input.hostId !== undefined && input.includeBoards && mailOn() ? { mail: structuredClone(mailbox) } : {}),
      ...(input.includeBoards ? { boardViews: [...[base, ...extra.values()].map(b => toBoardDTO(b, locale, 'off', Date.now(), groupsOf?.(b), busyOn(b)))
        .map(v => workflow !== undefined && v.summary.id === base.id ? { ...v, summary: { ...v.summary, workflow: true } } : v), ...emptyViews()], removedIds: [], workspaceLabels: { available: labelsAvailable, source: labelsAvailable ? 'api' : 'none',
        definitions: labelsAvailable ? [{ name: 'Explore', color: 'violet' }, { name: 'Prototype', color: 'sky' }, { name: 'Polish', color: 'emerald' }] : [],
        byWorkspace: labelsAvailable ? { [base.workspaceId]: ['Explore', 'Prototype'] } : {} } } : {}) })),
    'kanban.v1.board.get': input => {
      const id = input.boardId ?? '';
      const workspace = id.startsWith('empty:') ? id.slice(6) : input.workspaceId;
      const made = workspace ? extra.get(workspace) : [...extra.values()].find(b => b.id === id);
      if (workspace && pending.includes(workspace) && !made)
        return respond({ board: toEmptyBoardDTO(workspace, '/tmp/' + workspace, 'en'), revision: '', locale: 'en', observedAt: base.updatedAt });
      const value = made ?? [...extra.values()].find(b => b.id === id) ?? base;
      // REQ-127: like the server, the board says it too when its workspace holds a workflow definition.
      const view = toBoardDTO(value, locale, 'off', Date.now(), groupsOf?.(value), busyOn(value));
      return respond(withHealth({ board: workflow !== undefined && value === base ? { ...view, summary: { ...view.summary, workflow: true } } : view,
        revision: value.revision, locale, observedAt: value.updatedAt,
        ...(input.hostId !== undefined && ui.settings ? { settings: structuredClone(ui.settings) } : {}),
        // REQ-67 ⑥: like the server, the auto-card switch rides along with the host id.
        ...(input.hostId !== undefined && autoCards !== undefined ? { autoCards } : {}) }));
    },
    'kanban.v1.card.get': input => respond({ boardId: base.id, card: base.cards.find(c => c.id === input.cardId), template: base.template,
      history: base.history.filter(entry => entry.cardId === input.cardId), revision: base.revision, locale: 'en', observedAt: base.updatedAt, ...(cardAuto ?? {}),
      busy: busyMarks.get(input.cardId) ?? null,
      // REQ-86: like the server, when the card entered its stage.
      ...(base.cards.some(c => c.id === input.cardId) ? enteredOf(stageEntry(stageEntries(base), base.cards.find(c => c.id === input.cardId))) : {}) }),
    // REQ-97: like the server, the lead the card would go to and the board's name; nothing is sent.
    'kanban.v1.dispatch.preview': input => respond({ lead: dispatchLead, ...(dispatchHeld ? { held: dispatchHeld } : {}), ...(dispatchLocale ? { locale: dispatchLocale } : {}), boardTitle: workspaceName, revision: base.revision,
      card: base.cards.find(c => c.id === input.cardId), to: 'doing' }),
    // REQ-124: like the server, the workspace's workflow as read (nothing written); none defined without `workflow`.
    // REQ-128: like the server, the list and a thread only with the lab's switch on and a folder set; 'off' otherwise. The list
    // says the folder's fingerprint it answers (research/236 D1), unless the test sets one (or answers each read itself).
    'kanban.v1.mail.list': () => { const list = typeof mailList === 'function' ? mailList() : mailList; return respond(ui.settings?.labs?.mail && ui.settings?.labs?.mailDir && list
      ? { ...structuredClone(list), ...(mailbox && list.source === undefined ? { source: mailbox.key } : {}) }
      : { state: 'off', key: 'off', threads: [], limits: [], readAt: base.updatedAt }); },
    'kanban.v1.mail.thread': input => respond(ui.settings?.labs?.mail && ui.settings?.labs?.mailDir && mailThreads[input.thread] ? structuredClone(mailThreads[input.thread])
      : { state: ui.settings?.labs?.mail ? 'missing' : 'off', id: input.thread, files: [], latest: 0, more: 0 }),
    'kanban.v1.workflow.get': () => respond(structuredClone(workflow ?? { defined: false, reason: 'missing', definitionPath: '.kanban/workflow.json' })),
    // REQ-74: like the server, resuming changes only the tracking the next card read reports.
    'kanban.v1.auto_cards.resume': () => { cardAuto = { ...cardAuto, tracking: { state: 'on', since: null } }; return respond({ resumed: 1 }); },
    // REQ-62: like the server, every board (or only the ones asked for), id and revision only — and REQ-76 F1 its
    // groups, when asked for.
    'kanban.v1.revisions.get': input => respond(withHealth({ observedAt: base.updatedAt, removedIds: [], errors: [],
      ...(input.hostId !== undefined && mailOn() ? { mail: mailbox.key } : {}),
      boards: [base, ...extra.values()].filter(b => !input.boardIds || input.boardIds.includes(b.id))
        .map(b => { const key = input.groups ? groupsKey(groupsOf?.(b)) : undefined;
          return { id: b.id, revision: b.revision, state: 'ready', ...(key ? { groups: key } : {}), ...(b === base && busyKey() ? { busy: busyKey() } : {}) }; }) })),
  };
  const rpc = new Map(Object.keys(replies).map(name => [name, async input => {
    calls.push({ name, input });
    if (fail) throw new Error('Synthetic connection failure');
    return replies[name](input);
  }]));
  // REQ-78: the workspace listing can be slow (held until released), fail, or grow by a workspace made later.
  const listing = { fail: sdkFails, projectsFail: false, hold: { projects: false, workspaces: false }, waiting: [], added: [] };
  const held = kind => listing.hold[kind] ? new Promise(resolve => listing.waiting.push({ kind, resolve })) : null;
  const sdk = {
    ...(models ? { providers: { listModels: async provider => {
      sdkCalls.push('models:' + provider);
      if (models[provider] === 'fail') throw new Error('Synthetic model list failure');
      return { provider, models: models[provider] ?? [], error: null, fetchedAt: '2026-10-01T00:00:00.000Z', requestId: 'models' };
    } } } : {}),
    projects: { list: async () => { sdkCalls.push('projects'); await held('projects');
      if (listing.projectsFail) throw new Error('Synthetic project listing failure');
      return { projects: [{ projectId: 'prj_example01', projectDisplayName: projectName,
      ...(rootBoard ? { projectRootPath: base.cwd } : {}) }, ...listing.added.map(w => ({ projectId: w.projectId, projectDisplayName: w.projectDisplayName }))] }; } },
    workspaces: { list: async () => {
      sdkCalls.push('workspaces'); await held('workspaces');
      if (listing.fail) throw new Error('Synthetic directory failure');
      const git = id => branches[id] ? { gitRuntime: { currentBranch: branches[id] } } : {};
      return { entries: [...(rootBoard ? [] : [{ id: base.workspaceId, name: workspaceName, projectId: 'prj_example01',
        projectDisplayName: projectName, ...git(base.workspaceId) }]),
        ...[...empty].map((id, index) => ({ id, name: 'Empty Workspace ' + index, projectId: emptyProject,
          projectDisplayName: emptyProject === 'prj_example01' ? projectName : 'Second Project', ...git(id),
          workspaceDirectory: '/tmp/' + id, projectRootPath: '/tmp/' + id })), ...listing.added],
        pageInfo: { nextCursor: null } };
    } },
    // The real SDK streams agent_update events and serves paged snapshots; both are driven by tests.
    agents: {
      list: async options => {
        agentCalls.push(options?.subscribe?.subscriptionId ?? null); sdkCalls.push('agents');
        if (agentsFail) throw new Error('Synthetic agent directory failure');
        return { requestId: 'agents', subscriptionId: options?.subscribe?.subscriptionId ?? null,
          entries: directoryAgents.map(agent => ({ agent, project: null })),
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } };
      },
      subscribe: handler => { agentHandlers.add(handler); return () => agentHandlers.delete(handler); },
      // REQ-41: the one-shot handle a missing agent id is resolved through. `lookups` picks the answer.
      ref: id => ({ id, refresh: async () => {
        refCalls.push(id);
        if (holdLookups) return await new Promise((resolve, reject) => refPending.push({ id, resolve, reject }));
        return refAnswer(id);
      } }),
    },
  };
  function refAnswer(id) {
    const mode = lookups[id] ?? 'missing';
    if (mode === 'error') throw new Error('Synthetic lookup refusal');
    if (mode === 'missing') return null;
    return { agent: agentSnapshot(id, mode === 'archived' ? { archivedAt: '2026-09-22T00:00:00.000Z' } : { status: 'running' }),
      project: null };
  }
  // The real host sheet renders its content outside the screen's React context (D18), so this mock
  // resets the signal context for everything inside it. Content must bring its own source to read signals.
  // REQ-72: Kanban no longer opens host sheets; the mock stays so a test would see one come back.
  const HostSheetBoundary = ({ children }) => React.createElement(
    load(path.resolve('client/signal-context.tsx')).SignalContext.Provider,
    { value: load(path.resolve('client/agent-signals.ts')).emptySignalSource }, children);
  const Modal = ({ open, children, ...props }) => open ? React.createElement('Modal', props, React.createElement(HostSheetBoundary, null, children)) : null;
  Modal.Content = props => React.createElement('ModalContent', props, props.children);
  const mocks = {
    'react-native': { Modal: props => {
      React.useEffect(() => { if (!props.visible) props.onDismiss?.(); }, [props.visible]);
      return props.visible ? React.createElement('NativeModal', props, props.children) : null;
    }, View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', KeyboardAvoidingView: 'KeyboardAvoidingView',
      // REQ-72: the sheet's pull-to-close gesture; tests drive its handlers directly.
      PanResponder: { create: config => ({ panHandlers: { onResponderRelease: (event, gesture) => config.onPanResponderRelease(event, gesture) } }) },
      // Animated.Value carries the scroll offset without React state. It serializes to a constant so a
      // rendered tree can be compared across scrolls, and read() exposes the value the handler wrote.
      Animated: { View: 'AnimatedView', Value: function Value(initial) {
        let current = initial;
        this.read = () => current; this.setValue = next => { current = next; };
        this.interpolate = config => ({ toJSON: () => 'AnimatedInterpolation', ...config });
        this.toJSON = () => 'AnimatedValue';
      },
        // The ring loop must never touch React state: the test only counts start/stop calls.
        // D29: the sheet's own rise/drop timing resolves synchronously — tests see the end state (and the
        // close callback fired) right after the triggering `act`, with no fake timers to advance.
        timing: (value, config) => { motion.config = config; motion.calls.push({ toValue: config.toValue, duration: config.duration, easing: config.easing });
          return { start: done => { value.setValue(config.toValue); done?.({ finished: true }); } }; },
        loop: animation => ({ start: () => { motion.started++; }, stop: () => { motion.stopped++; }, animation }) },
      Easing: { linear: 'linear', cubic: 'cubic', out: curve => curve },
      Platform: { OS: mobile ? platform : 'web' },
      AppState: { currentState: 'active', addEventListener: (type, handler) => {
        appStateHandlers.add(handler); return { remove: () => appStateHandlers.delete(handler) };
      } },
      AccessibilityInfo: { isReduceMotionEnabled: async () => reduceMotion,
        addEventListener: () => ({ remove: () => {} }) },
      useWindowDimensions: () => ({ width, height: 844, scale: 1, fontScale }),
      // REQ-87 ⑦: the screen under the window (an Android navigation bar is their difference), and the keyboard's events.
      Dimensions: { get: which => ({ width, height: which === 'screen' ? screenHeight : 844, scale: 1, fontScale }) },
      StatusBar: { currentHeight: statusBar }, Keyboard: { addListener: (type, handler) => { keyboardHandlers.push({ type, handler });
        return { remove: () => { const at = keyboardHandlers.findIndex(v => v.handler === handler); if (at >= 0) keyboardHandlers.splice(at, 1); } }; } },
      // react-native-web's useColorScheme as the Paseo web app ships it: it subscribes again after every render.
      Appearance, useColorScheme: () => {
        const [value, set] = React.useState(Appearance.getColorScheme());
        React.useEffect(() => Appearance.addChangeListener(event => set(event.colorScheme)).remove);
        return value;
      } },
    '@getpaseo/plugin/client/react-native': { Modal, Icon: 'Icon', ScrollView: 'ScrollView', TextInput: 'TextInput',
      ...(copy === 'missing' ? {} : { copyText: async value => { copies.push(value); if (copy === 'fail') throw new Error('Synthetic clipboard refusal'); } }) },
    '@getpaseo/plugin/client': {
      useRpc: contract => rpc.get(contract.name), usePaseo: () => sdk,
      useWorkspace: (_id, selector) => {
        assert.ok(panel, 'A surface must not use workspace panel context.');
        return selector({ name: 'Panel workspace', title: null });
      },
    },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const output = transpile(file);
    const localRequire = id => {
      if (mocks[id]) return mocks[id];
      if (!id.startsWith('.')) return nativeRequire(id);
      const target = path.resolve(path.dirname(file), id.replace(/\.js$/, ''));
      return load(['.ts', '.tsx'].map(ext => target + ext).find(name => fs.existsSync(name)));
    };
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  const colors = Object.fromEntries(['surface0', 'surface1', 'surface2', 'border', 'foreground', 'foregroundMuted',
    'accent', 'accentForeground', 'statusSuccess', 'statusWarning', 'statusDanger'].map(n => [n, '#222222']));
  const props = { theme: { colors }, host: { id: 'host_example', label: 'Example host' },
    layout: { platform: mobile ? platform : 'web', compact: mobile } };
  return { get base() { return base; }, calls, sdkCalls, props, outcome: value => { outcome = value; },
    // 253-D2: another agent named by the next preview (a newer chat opened meanwhile).
    dispatchTo: value => { dispatchLead = value; }, keyboard: type => { for (const v of [...keyboardHandlers]) if (v.type === type) v.handler(); },
    ui: { writes: uiWrites, get value() { return ui; } },
    scheme: async next => { scheme.value = next;
      for (const entry of [...scheme.listeners]) if (!entry.removed) await act(async () => entry.listener({ colorScheme: next })); }, auto: { writes: autoWrites }, ensure: { calls: ensureCalls, get pending() { return [...pending]; } },
    agents: { calls: agentCalls, motion, listeners: () => agentHandlers.size,
      refs: refCalls, waiting: () => refPending.map(entry => entry.id),
      settle: () => { for (const entry of refPending.splice(0)) {
        try { entry.resolve(refAnswer(entry.id)); } catch (error) { entry.reject(error); } } },
      set: list => { directoryAgents = list.map(value => typeof value === 'string' ? agentSnapshot(value) : agentSnapshot(value.id, value)); },
      emit: update => { for (const handler of [...agentHandlers]) handler(update); },
      upsert: (id, patch = {}, extra = {}) => { for (const handler of [...agentHandlers]) handler({ kind: 'upsert', agent: agentSnapshot(id, patch), ...extra }); },
      remove: (id, extra = {}) => { for (const handler of [...agentHandlers]) handler({ kind: 'remove', agentId: id, ...extra }); },
      appState: state => { for (const handler of [...appStateHandlers]) handler(state); } },
    addCard: (value, now, by = actor) => { base = applyOperations(base, [value], by, context(now), value.op === 'dispatched' ? 'dispatcher' : 'board').board; },
    // REQ-79: a later change to one card (its updatedAt), made at `now`.
    touch: (title, now) => { base = applyOperations(base, [{ op: 'update', id: base.cards.find(c => c.title === title).id,
      patch: { notes: 'Touched ' + now } }], actor, context(now)).board; },
    /** REQ-78: drive the workspace listing — hold it, fail it, release what waits, or add a workspace Paseo made since. */
    listing: { set: patch => Object.assign(listing, patch), hold: (kind, on = true) => { listing.hold[kind] = on; },
      waiting: () => listing.waiting.map(w => w.kind),
      release: kind => { for (const w of listing.waiting.filter(v => !kind || v.kind === kind)) { listing.waiting.splice(listing.waiting.indexOf(w), 1); w.resolve(); }
        if (kind) listing.hold[kind] = false; else listing.hold = { projects: false, workspaces: false }; },
      add: (id, projectId, projectDisplayName) => { pending.push(id); listing.added.push({ id, name: 'Later Workspace', projectId, projectDisplayName,
        workspaceDirectory: '/tmp/' + id, projectRootPath: '/tmp/' + id }); } },
    setGroups: value => { groupsOf = value; },
    /** REQ-84/130: a busy mark set (or, null, ended) as `kanban card busy` would, on the base board's card. */
    setBusy: (cardId, mark) => { if (mark) busyMarks.set(cardId, mark); else busyMarks.delete(cardId); },
    busyMarks,
    external: patch => { base = applyOperations(base, [{ op: 'update', id: base.cards[0].id, patch }], actor, context()).board; },
    // REQ-82 G1: a move made elsewhere (an agent's turn, the CLI) that the screen has not read yet.
    externalMove: (to, index = 0) => { base = applyOperations(base, [{ op: 'move', id: base.cards[index].id, to }], actor, context()).board; }, load: name => load(path.resolve(name)), fail: () => { fail = true; },
    // REQ-83: the connection back, and the server's tracking changing without a ledger change. REQ-85 ⑧: what was copied.
    recover: () => { fail = false; }, setHealth: value => { health = value; }, copies,
    /** REQ-90: the message folder changing (a new reply, a close) without a ledger change. */
    setMail: value => { mailbox = value; },
    /** REQ-128: what the server's message list reads from now on. */
    setMailList: value => { mailList = value; } };
}
/**
 * node:test keeps every after hook until the whole file ends (its per-run resource map), so a hook whose closure
 * reaches a rendered tree keeps that tree, the harness and its freshly loaded client modules alive: about 10MB per
 * test, which ran this file out of heap near its 283rd test. The hook registered here lets go of `fn` once it ran.
 */
function afterOnce(t, fn) {
  const held = { fn };
  t.after(() => { const run = held.fn; held.fn = null; return run?.(); });
}
async function render(t, Component, props, options = {}) {
  let root;
  await act(async () => { root = Renderer.create(React.createElement(Component, props), options); });
  afterOnce(t, async () => { await act(async () => root.unmount()); });
  return root;
}
function text(root) { return JSON.stringify(root.toJSON()); }
function nativeNode(root, id) {
  function find(node) {
    if (!node || typeof node === 'string') return undefined;
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    return node.props?.testID === id ? node : find(node.children);
  }
  return find(root.toJSON());
}
/** Host nodes only: a testID that is also a component prop matches the component element too. */
/** Every rendered host node with this testID, in tree order (nativeNode returns only the first). */
function jsonNodes(node, id, out = []) {
  if (!node || typeof node === 'string') return out;
  if (Array.isArray(node)) { for (const child of node) jsonNodes(child, id, out); return out; }
  if (node.props?.testID === id) out.push(node);
  return jsonNodes(node.children, id, out);
}
function agentStatus(row) {
  const icon = row.findAllByProps({testID:'agent-signal-icon'}).find(n=>typeof n.type==='string');
  // D45: a wide sheet's row says the state after the name, in its own words ("agent-signal-rest").
  const rest = row.findAll(n => n.props?.testID === 'agent-signal-rest' && typeof n.type === 'string')[0];
  return icon?.props.accessibilityLabel ?? String([].concat((rest ?? row.findAllByType('Text')[0]).props.children)[0]).split(' · ').at(-1);
}
/** REQ-75: the lane sections of the wide board, flat (straight in the scroll view) or grouped (inside project sections). */
function laneSections(root) {
  return nativeNode(root, 'swimlane-vertical').children.flatMap(n => n.props?.testID === 'swimlane-lane-section' ? [n]
    : (n.children ?? []).filter(v => v.props?.testID === 'swimlane-lane-section'));
}
/** REQ-75 A2: switch the board to "group by project" — the glyph beside the search, or the row in the 390px filter sheet. */
async function groupByProject(root, mobile = false) {
  if (mobile) await act(async () => sheetButton(root, 'open-filters').props.onPress());
  await act(async () => sheetButton(root, 'group-toggle').props.onPress());
  if (mobile) await act(async () => root.root.findByType('NativeModal').props.onRequestClose());
}
function hosts(root, testID) { return root.root.findAllByProps({ testID }).filter(node => typeof node.type === 'string'); }
/** REQ-142: a screen in no workspace (the overview) asks before it opens an agent — the sheet is there, and [Open] goes on. */
async function leaveOpen(root) {
  assert.equal(hosts(root, 'agent-leave-sheet').length, 1, 'REQ-142: asked first');
  await act(async () => hosts(root, 'agent-leave-open')[0].props.onPress());
  assert.equal(hosts(root, 'agent-leave-sheet').length, 0, 'REQ-142: the sheet is gone once opened');
}
function labelled(root, label) { return root.root.findAllByType('Pressable').find(p => p.props.accessibilityLabel === label); }

test('legacy list still renders DTO data without a panel provider and opens editable details', async t => {
  const h = harness(), { ListOverview } = h.load('client/overview.tsx');
  const root = await render(t, ListOverview, { ...h.props, onBoard: () => {} });
  assert.match(text(root), /Example Project/); assert.match(text(root), /Example Workspace/);
  const row = root.root.findAllByType('Pressable').find(p => p.findAllByType('Text').some(n => n.props.children === 'Example card'));
  await act(async () => row.props.onPress());
  assert.match(text(root), /Acceptance criteria/); assert.doesNotMatch(text(root), /Save changes/, 'REQ-88 ⑤: every field saves itself');
  assert.equal(hosts(root, 'detail-title').length, 1);
  assert.equal(h.calls.filter(c => c.name.endsWith('card.get')).length, 1);
  assert.ok(h.calls.every(c => !c.name.includes('mutate')));
});
test('board switches columns to mobile tabs and retains card content under a detail sheet', async t => {
  const h = harness({ mobile: true }), { BoardScreen } = h.load('client/board.tsx');
  const root = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id } });
  assert.equal(root.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab').length, 4);
  const plus = labelled(root, 'Create draft');
  assert.equal(plus.props.disabled, false); assert.equal(plus.props.style.width, 32); assert.equal(plus.props.hitSlop, 6);
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.equal(hosts(root, 'editor-sheet').length, 1); assert.equal(root.root.findAllByType('Modal').length, 0, 'REQ-72: no host sheet');
  assert.ok(labelled(root, 'Example card'));
  await act(async () => root.root.findByType('NativeModal').props.onRequestClose());
  assert.equal(hosts(root, 'editor-sheet').length, 0);
});
test('wide board uses stage columns, 30px controls and 104px next-action cards', async t => {
  const h = harness(), { BoardScreen } = h.load('client/board.tsx');
  const root = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id } });
  await act(async () => root.root.findAllByType('View').find(v => v.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  assert.equal(root.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab').length, 0);
  assert.equal(labelled(root, 'Refresh').props.style.width, 30);
  // REQ-145 ③ (gate 366): this card waits for a person, so it is one reply row taller (104 + 24).
  assert.equal(labelled(root, 'Example card').props.style.minHeight, 128);
  assert.ok(root.root.findAllByType('ScrollView').some(s => s.props.horizontal));
});
test('SDK failure is said, not guessed as "not found", while an RPC failure preserves last good overview', async t => {
  const h = harness({ sdkFails: true }), { ListOverview } = h.load('client/overview.tsx');
  const root = await render(t, ListOverview, { ...h.props, onBoard: () => {} });
  // REQ-78 ③ (was D22 ④'s fallback): without the SDK listing no board can be placed — or hidden — so none is filed
  // under "Not found in Paseo"; the screen says the listing failed and that it is read again on its own.
  assert.doesNotMatch(text(root), /Not found in Paseo/);
  assert.match(text(root), /Workspace names could not be read: Synthetic directory failure · trying again automatically/);
  h.fail(); await act(async () => labelled(root, 'Refresh').props.onPress());
  assert.match(text(root), /Showing the previous content/); assert.match(text(root), /Workspace names could not be read/);
});
test('panel wrapper selects the exact workspace and does not infer a board from cwd', async t => {
  const h = harness({ panel: true }), { WorkspacePanel } = h.load('client/panel.tsx');
  const root = await render(t, WorkspacePanel, { ...h.props, context: 'workspace', workspaceId: h.base.workspaceId });
  assert.doesNotMatch(text(root), /Panel workspace/); // D4: host already supplies the narrow panel title.
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  assert.match(text(root), /Panel workspace/);
  // REQ-66: the host id rides along only to bring the host's settings back (auto refresh off reaches the panel).
  assert.deepEqual(h.calls.find(c => c.name.endsWith('board.get')).input, { workspaceId: h.base.workspaceId, hostId: h.props.host.id });
});

function button(root, label) {
  return root.root.findAllByType('Pressable').find(p => p.props.accessibilityLabel === label ||
    p.findAllByType('Text').some(n => n.props.children === label));
}
/** The host Pressable of a CreateDraft workspace row, by the workspace name it shows. */
function boardChoice(root, name) {
  return root.root.findAllByType('Pressable').find(p => p.props.testID === 'create-board-choice' &&
    p.findAllByType('Text').some(n => String(n.props.children).includes(name)));
}
/** How many buttons say `label` in words (not a glyph or a backdrop that only carries it as its accessible name). */
function wordButtons(root, label) {
  return root.root.findAllByType('Pressable').filter(p => p.findAllByType('Text').some(n => n.props.children === label)).length;
}
function input(root, label) { return root.root.findAllByType('TextInput').find(p => p.props.accessibilityLabel === label); }
/** Lets a field's save (its write, then the card read after it) run to its end. */
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
/** REQ-88 ⑤: types into a detail field and leaves it — the leaving is its save. */
async function saveField(root, label, value) {
  await act(async () => input(root, label).props.onChangeText(value));
  await act(async () => input(root, label).props.onBlur());
  await settle();
}
/** REQ-88 ③: presses the title where it stands, types, and presses Enter (its save). */
async function saveTitle(root, value) {
  await act(async () => hosts(root, 'detail-title')[0].props.onPress());
  await act(async () => hosts(root, 'detail-title-input')[0].props.onChangeText(value));
  await act(async () => hosts(root, 'detail-title-input')[0].props.onSubmitEditing());
  await settle();
}
/** REQ-88 ①: a "label · value" line at the foot of the detail's side panel. */
function detailMeta(root, label) {
  // D45: on a wide sheet the author is one row of two words (the name that may be cut, the id that is not).
  const author = root.root.findAll(n => n.props?.testID === 'detail-author' && typeof n.type === 'string').map(allText);
  return [...author, ...root.root.findAllByType('Text').map(n => n.props.children)]
    .find(v => typeof v === 'string' && v.startsWith(label + ' · '))?.slice(label.length + 3);
}
async function detail(t, options = {}) {
  const h = harness(options), { Detail } = h.load('client/detail.tsx');
  let closed = 0;
  const root = await render(t, Detail, { ...h.props, boardId: h.base.id, cardId: h.base.cards[0].id,
    locale: 'en', onClose: () => { closed++; } });
  return { h, root, closed: () => closed };
}
test('REQ-88 ⑤ each field saves itself; a board changed elsewhere is sent again at once, the same field changed elsewhere asks', async t => {
  // Another field changed meanwhile (the notes and next action elsewhere): the title's save is read again and sent once more.
  const { h, root } = await detail(t);
  h.outcome('conflict');
  await saveTitle(root, 'My title');
  let writes = h.calls.filter(c => c.name.endsWith('mutate'));
  assert.equal(writes.length, 2, 'refused once for the changed board, then sent again against it');
  assert.notEqual(writes[0].input.ifRevision, writes[1].input.ifRevision); assert.notEqual(writes[0].input.requestId, writes[1].input.requestId);
  assert.deepEqual(writes[1].input.operations, [{ op: 'update', id: h.base.cards[0].id, patch: { title: 'My title' } }], 'the title alone');
  assert.equal(h.base.cards[0].title, 'My title'); assert.equal(h.base.cards[0].notes, 'Remote notes', 'the other change stays');
  assert.equal(input(root, 'Next action').props.value, 'Remote next action', 'the fields nobody typed in show the latest');
  assert.match(allText(hosts(root, 'field-status-title')[0]), /Saved/);
  assert.match(allText(hosts(root, 'detail-last-saved')[0]), /^Saved \d\d:\d\d$/, 'the head says when it last saved');
  // The same field changed elsewhere: it asks, and keeps what was typed.
  const b = await detail(t);
  b.h.outcome('conflict');
  await saveField(b.root, 'Notes', 'My notes');
  assert.equal(input(b.root, 'Notes').props.value, 'My notes'); assert.equal(b.h.base.cards[0].notes, 'Remote notes');
  assert.match(allText(hosts(b.root, 'field-status-notes')[0]), /Changed elsewhere just now/);
  await act(async () => hosts(b.root, 'field-mine-notes')[0].props.onPress()); await settle();
  assert.equal(b.h.base.cards[0].notes, 'My notes', '"Keep mine" saves it over the latest');
  assert.deepEqual(b.h.calls.filter(c => c.name.endsWith('mutate')).at(-1).input.operations[0].patch, { notes: 'My notes' });
  // …or "Show latest" puts the latest in the field and sends nothing.
  const l = await detail(t);
  l.h.outcome('conflict');
  await saveField(l.root, 'Next action', 'Mine');
  const count = l.h.calls.filter(c => c.name.endsWith('mutate')).length;
  await act(async () => hosts(l.root, 'field-latest-nextAction')[0].props.onPress());
  assert.equal(input(l.root, 'Next action').props.value, 'Remote next action');
  assert.equal(hosts(l.root, 'field-status-nextAction').length, 0);
  assert.equal(l.h.calls.filter(c => c.name.endsWith('mutate')).length, count);
  // A choice saves the moment it is pressed; several fields in a row go one after another, each on the latest revision.
  const r = await detail(t);
  await act(async () => { hosts(r.root, 'priority-choice-high')[0].props.onPress(); hosts(r.root, 'awaiting-choice-agent')[0].props.onPress(); });
  await settle();
  writes = r.h.calls.filter(c => c.name.endsWith('mutate'));
  assert.deepEqual(writes.map(w => w.input.operations[0].patch), [{ priority: 'high' }, { awaiting: 'agent' }]);
  assert.equal(r.h.base.cards[0].priority, 'high'); assert.equal(r.h.base.cards[0].awaiting, 'agent');
  assert.equal(hosts(r.root, 'priority-choice-high')[0].props.accessibilityState.checked, true);
  // Leaving a field without a change sends nothing.
  await act(async () => input(r.root, 'Notes').props.onBlur()); await settle();
  assert.equal(r.h.calls.filter(c => c.name.endsWith('mutate')).length, 2);
});
test('REQ-88 ⑤ a failed save keeps what was typed with "Try again"; closing tries once more and asks before losing it', async t => {
  const { h, root, closed } = await detail(t);
  h.outcome('failed'); await saveField(root, 'Notes', 'Preserved draft');
  assert.equal(h.base.cards[0].notes, ''); assert.equal(input(root, 'Notes').props.value, 'Preserved draft', 'not put back');
  assert.match(allText(hosts(root, 'field-status-notes')[0]), /Not saved — E_LOCK_TIMEOUT: Synthetic refusal\. Retry after .*seconds/);
  await act(async () => root.root.findAllByType('NativeModal')[0].props.onRequestClose()); await settle();
  assert.equal(closed(), 0, 'the close saved once more, failed, and stayed'); assert.match(text(root), /Some fields could not be saved/);
  h.outcome('ok');
  await act(async () => hosts(root, 'field-retry-notes')[0].props.onPress()); await settle();
  assert.equal(h.base.cards[0].notes, 'Preserved draft');
  await act(async () => root.root.findAllByType('NativeModal')[0].props.onRequestClose()); await settle();
  assert.equal(closed(), 1, 'nothing left unsaved: it closes');
  // Still failing, a second close (or "Discard changes") lets it go.
  const f = await detail(t);
  f.h.outcome('failed'); await saveField(f.root, 'Notes', 'Lost on purpose');
  await act(async () => f.root.root.findAllByType('NativeModal')[0].props.onRequestClose()); await settle();
  assert.equal(f.closed(), 0);
  await act(async () => button(f.root, 'Discard changes').props.onPress());
  assert.equal(f.closed(), 1);
});
test('REQ-88 ⑤ a lost reply says so under the field and "Try again" sends exactly the same request', async t => {
  const { h, root } = await detail(t);
  h.outcome('lost'); await saveField(root, 'Notes', 'Applied once');
  assert.match(allText(hosts(root, 'field-status-notes')[0]), /Could not confirm it was saved/);
  assert.equal(input(root, 'Notes').props.editable, true, 'the field stays open to edit');
  await act(async () => hosts(root, 'field-retry-notes')[0].props.onPress()); await settle();
  const writes = h.calls.filter(c => c.name.endsWith('mutate'));
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].input, writes[1].input);
  assert.equal(h.base.cards[0].notes, 'Applied once');
});
test('draft creation after a lost response is replayed once and never silently becomes requested', async t => {
  const h = harness({ mobile: true, platform: 'android' }), { CreateDraft } = h.load('client/create.tsx');
  const root = await render(t, CreateDraft, { ...h.props, boards: [{ id: h.base.id, workspaceId: h.base.workspaceId, cwd: h.base.cwd }],
    directory: {}, initialBoardId: h.base.id, locale: 'en', onClose: () => {}, onCreated: () => {}, onChanged: () => {} });
  await act(async () => input(root, 'Title').props.onChangeText('My draft'));
  h.outcome('lost'); await act(async () => button(root, 'Save draft').props.onPress());
  assert.equal(h.base.cards.length, 2); assert.equal(input(root, 'Title').props.editable, false);
  await act(async () => button(root, 'Retry the same request').props.onPress());
  assert.equal(h.base.cards.length, 2); assert.equal(h.base.cards[1].intent, 'draft');
  assert.equal(h.base.cards[1].stageId, 'todo'); assert.ok(button(root, 'Open saved card'));
});
test('Android tab and editor layouts reserve system clearance; the detail has no footer, the draft keeps its one action outside scrolling', async t => {
  const h = harness({ mobile: true, platform: 'android' }), { BoardScreen } = h.load('client/board.tsx');
  const root = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id } });
  const viewport = root.root.findAllByType('View').find(v => v.props.onLayout);
  assert.equal(viewport.props.style.paddingBottom, 56);
  const tab = root.root.findAllByType('View').find(v => v.props.testID === 'mobile-control-row');
  assert.equal(tab.props.style.height, 44); assert.equal(tab.props.style.flexGrow, 0);
  assert.ok(root.root.findAllByType('ScrollView').some(v => v.props.contentContainerStyle?.paddingBottom === 56));
  await act(async () => labelled(root, 'Example card').props.onPress());
  // REQ-88 ⑤: every field saves itself — no "Save changes" footer; REQ-87 ⑦: the sheet's content stops above the bar.
  assert.equal(hosts(root, 'editor-footer').length, 0);
  assert.equal(flatStyle(hosts(root, 'sheet-content')[0].props.style).paddingBottom, 56);
  // REQ-72: the Kanban sheet lifts itself above the keyboard (a window the system resized reports no overlap).
  const keyboard = root.root.findByType('KeyboardAvoidingView');
  assert.equal(keyboard.props.behavior, 'padding'); assert.equal(keyboard.props.enabled, true);
  assert.equal(input(root, 'Next action').props.style.minHeight, 44);
  // The draft still saves as a whole: one fixed button outside the scroll view.
  const d = harness({ mobile: true, platform: 'android' }), { CreateDraft } = d.load('client/create.tsx');
  const draft = await render(t, CreateDraft, { ...d.props, boards: [{ id: d.base.id, workspaceId: d.base.workspaceId, cwd: d.base.cwd }],
    directory: {}, initialBoardId: d.base.id, locale: 'en', onClose: () => {}, onCreated: () => {}, onChanged: () => {} });
  const footer = draft.root.findAllByType('View').find(v => v.props.testID === 'editor-footer');
  assert.equal(footer.findAllByType('Pressable').length, 1); assert.equal(footer.findByType('Pressable').props.style.minHeight, 48);
  let parent = footer.parent; while (parent) { assert.notEqual(parent.type, 'ScrollView'); parent = parent.parent; }
  assert.equal(input(draft, 'Title').props.style.minHeight, 44);
  assert.equal(wordButtons(draft, 'Close'), 0, 'REQ-87 ⑥: no "Close" row — the round × in the head closes it');
});
// REQ-82 ④ supersedes "stage selector requires explicit save": the stage bar moves the card at once, on its own.
test('REQ-82 ④ / REQ-88 ④ the detail stage flow moves at once, keeps a field being typed apart, preserves awaiting and offers undo', async t => {
  const at = '2026-09-25T05:03:00.000Z';
  const { h, root } = await detail(t, { cardAuto: { reason: { by: 'auto', cause: 'turn_started', agentId: null, at, created: true },
    tracking: { state: 'on', since: null } } });
  const bar = () => hosts(root, 'stage-bar')[0], seg = id => sheetButton(root, 'stage-bar-' + id);
  const pills = () => bar().children.map(n => n.props.testID).filter(id => id.startsWith('stage-bar-'));
  assert.deepEqual(pills(), ['stage-bar-todo', 'stage-bar-doing', 'stage-bar-review', 'stage-bar-done'], 'every stage of the template, always shown');
  assert.equal(bar().children.filter(n => n.props.testID === 'stage-flow-line').length, 3, 'pills joined by thin lines');
  assert.equal(bar().props.style.alignSelf, 'flex-start', 'as wide as its stages, not the window');
  // It sits right under the title, above every field, so a phone sheet shows it without scrolling.
  const words = text(root);
  assert.ok(words.indexOf('"stage-bar"') < words.indexOf('Next action'), 'above the fields');
  assert.equal(seg('todo').props.accessibilityState.checked, true);
  const c = palette(h.props.theme);
  assert.equal(seg('todo').props.style.backgroundColor, selectedTint(c, c.surface0), 'the current stage alone is tinted (REQ-85)');
  assert.equal(seg('todo').props.style.borderColor, 'transparent', 'no line');
  assert.equal(seg('doing').props.style.borderColor, fieldLine(c, c.surface0));
  await act(async () => input(root, 'Notes').props.onChangeText('Typed, not saved'));
  const before = h.calls.filter(call => call.name.endsWith('mutate')).length;
  await act(async () => seg('doing').props.onPress());
  const writes = h.calls.filter(call => call.name.endsWith('mutate'));
  assert.equal(writes.length, before + 1, 'pressed once, sent once');
  assert.deepEqual(writes.at(-1).input.operations, [{ op: 'move', id: h.base.cards[0].id, to: 'doing' }], 'the stage alone');
  assert.equal(h.base.cards[0].stageId, 'doing'); assert.equal(h.base.cards[0].awaiting, 'user');
  assert.equal(h.base.cards[0].notes, '', 'the typed notes were not sent with it');
  assert.equal(input(root, 'Notes').props.value, 'Typed, not saved', 'and they stay in the field');
  assert.equal(seg('doing').props.accessibilityState.checked, true);
  assert.equal(seg('todo').findAllByType('Icon').filter(n => n.props.name === 'Check').length, 1, 'a stage passed carries a ✓');
  assert.equal(seg('review').findAllByType('Icon').length, 0);
  const reason = allText(hosts(root, 'detail-move-reason')[0]).replace(/\u2060/g, '').replace(/\u00a0/g, ' ');
  assert.match(reason, /^Moved by a person · [\d-]+ \d\d:\d\d \(just now\)$/, 'the reason line is the person, just now, at once');
  assert.match(textOf(hosts(root, 'move-toast')[0]), /^Moved to In progressUndo/);
  // REQ-88 ⑤: the typed notes save themselves when the field is left, against the board the move produced.
  await act(async () => input(root, 'Notes').props.onBlur()); await settle();
  const save = h.calls.filter(call => call.name.endsWith('mutate')).at(-1);
  assert.deepEqual(save.input.operations, [{ op: 'update', id: h.base.cards[0].id, patch: { notes: 'Typed, not saved' } }]);
  assert.equal(h.base.cards[0].notes, 'Typed, not saved'); assert.equal(h.base.cards[0].stageId, 'doing');
  // Undo is one more move by a person, back where the card was.
  await act(async () => sheetButton(root, 'move-undo').props.onPress());
  assert.equal(h.base.cards[0].stageId, 'todo');
  assert.deepEqual(h.calls.filter(call => call.name.endsWith('mutate')).at(-1).input.operations, [{ op: 'move', id: h.base.cards[0].id, to: 'todo' }]);
  assert.match(textOf(hosts(root, 'move-toast')[0]), /^Moved back to To Do/);
  assert.equal(hosts(root, 'move-undo').length, 0, 'an undo is not undone again');
});
test('draft conflict consent pins the displayed revision instead of silently fetching a newer CAS', async t => {
  const h = harness(), { CreateDraft } = h.load('client/create.tsx');
  const root = await render(t, CreateDraft, { ...h.props, boards: [{ id: h.base.id, workspaceId: h.base.workspaceId, cwd: h.base.cwd }],
    directory: {}, initialBoardId: h.base.id, locale: 'en', onClose: () => {}, onCreated: () => {}, onChanged: () => {} });
  await act(async () => input(root, 'Title').props.onChangeText('Pending draft'));
  h.outcome('conflict'); await act(async () => button(root, 'Save draft').props.onPress());
  const reviewedRevision = h.base.revision;
  h.external({ title: 'A newer concurrent edit' });
  await act(async () => button(root, 'Use this revision and review before saving').props.onPress());
  await act(async () => button(root, 'Save draft').props.onPress());
  const writes = h.calls.filter(c => c.name.endsWith('mutate'));
  assert.equal(writes[1].input.ifRevision, reviewedRevision); assert.equal(h.base.cards.length, 1);
  assert.equal(input(root, 'Title').props.value, 'Pending draft');
});

test('wide first surface uses fixed swimlane columns, project icon and a button-only attention chip', async t => {
  const h = harness({ width: 1900 }); h.addCard(add('Quiet card'));
  h.props.theme.colors.surface1 = '#111111'; h.props.theme.colors.surface2 = '#333333';
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.equal(root.root.findAllByProps({ testID: 'swimlane-screen' }).length, 1);
  const columns = root.root.findAllByType('View').filter(v => v.props.testID?.startsWith('swimlane-cell-'));
  assert.equal(columns.length, 4); assert.ok(columns.every(v => Object.assign({}, ...v.props.style).width === 280));
  assert.ok(root.root.findAllByProps({ testID: 'swimlane-card-slot' }).every(v => v.props.style.width === 264));
  const icon = root.root.findByProps({ testID: 'project-icon' });
  assert.equal(icon.props.style.backgroundColor, '#5179b0'); assert.equal(icon.props.style.borderRadius, 4);
  assert.match(text(root), /Example Project/);
  assert.equal(root.root.findAllByProps({ testID: 'project-group-header' }).length, 0); // One workspace merges the two headers.
  const lane = root.root.findByProps({ testID: 'lane-section-header' });
  // D23 (replaces D17 here): the pinned lane header carries no full-width edge; each column's heading divider marks it.
  assert.equal(lane.props.style.borderBottomWidth, 0); assert.equal(lane.props.style.shadowOpacity, 0);
  const chip = () => root.root.findByProps({ testID: 'attention-chip' });
  assert.equal(chip().props.accessibilityRole, 'button'); assert.equal(chip().props.accessibilityState.selected, false);
  const beforeCalls = h.calls.length;
  await act(async () => chip().props.onPress());
  assert.equal(chip().props.accessibilityState.selected, true); assert.equal(chip().props.style.backgroundColor, '#333333');
  assert.equal(hosts(root, 'swimlane-card-slot').length, 1);
  await act(async () => chip().props.onPress());
  assert.equal(hosts(root, 'swimlane-card-slot').length, 2);
  assert.equal(h.calls.length, beforeCalls); // Local filters do not query or write.
  assert.equal(h.calls.filter(c => c.name.endsWith('overview.get')).length, 1);
});
test('REQ-92 the lane glyph and each column\'s "+N" open five at a time, "Collapse" at the end, and the done column offers the board', async t => {
  const h = harness({ width: 1400 });
  for (let i = 0; i < 5; i++) h.addCard(add(`Extra ${i}`));
  for (let i = 0; i < 12; i++) h.addCard({ ...add(`Completed ${i}`), stageId: 'done' });
  const { OverviewScreen } = h.load('client/overview.tsx'); const root = await render(t, OverviewScreen, h.props);
  const slots = stageId => hosts(root, 'swimlane-cell-' + stageId)[0].findAll(n => n.props?.testID === 'swimlane-card-slot' && typeof n.type === 'string').length;
  const shown = () => [slots('todo'), slots('done')];
  const inCell = (stageId, testID) => hosts(root, 'swimlane-cell-' + stageId)[0].findAll(n => n.props?.testID === testID && typeof n.type === 'string')[0];
  assert.deepEqual(shown(), [3, 3]);
  assert.equal(allText(inCell('todo', 'cell-more')), '+3'); assert.equal(allText(inCell('done', 'cell-more')), '+9');
  assert.equal(inCell('done', 'cell-more').props.accessibilityLabel, 'Show 5 more (9 not shown): Done');
  // The lane glyph: five more in each column that leaves cards out, then everything back to three.
  await act(async () => button(root, 'Show 5 more in each column (12 not shown)').props.onPress());
  assert.deepEqual(shown(), [6, 8], 'to-do all six, done eight — never ten at once');
  await act(async () => button(root, 'Collapse').props.onPress());
  assert.deepEqual(shown(), [3, 3]);
  // A column's own "+N": that column only.
  await act(async () => inCell('done', 'cell-more').props.onPress());
  assert.deepEqual(shown(), [3, 8], 'the to-do column stays as it was');
  assert.equal(allText(inCell('done', 'cell-more')), '+4', 'the rest, said again');
  const rest = inCell('done', 'cell-rest-in-board');
  assert.equal(allText(rest), '4 more in the board', 'REQ-75 B3: an opened done column also offers the board');
  // REQ-115: "Collapse" beside the "+N" left as soon as the column shows more than three, not only at the end.
  assert.equal(allText(inCell('done', 'cell-collapse')), 'Collapse', 'REQ-115: "Collapse" part way too');
  await act(async () => inCell('done', 'cell-more').props.onPress());
  assert.deepEqual(shown(), [3, 12]);
  assert.equal(inCell('done', 'cell-more'), undefined);
  assert.equal(inCell('done', 'cell-collapse').props.accessibilityLabel, 'Collapse: Done · Example Workspace');
  assert.equal(hosts(root, 'done-board-link').length, 0, 'REQ-75 B2: no "Board ›" on the done heading');
  await act(async () => inCell('todo', 'cell-more').props.onPress());
  assert.deepEqual(shown(), [6, 12]);
  await act(async () => inCell('done', 'cell-collapse').props.onPress());
  assert.deepEqual(shown(), [6, 3], '"Collapse" folds its own column only');
  assert.equal(writes(h).length, 0, 'opening is the session\'s, never written');
  await act(async () => inCell('done', 'cell-more').props.onPress());
  await act(async () => inCell('done', 'cell-rest-in-board').props.onPress());
  assert.equal(root.root.findAllByProps({ testID: 'workspace-board' }).length, 1);
  assert.equal(root.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab' && p.props.accessibilityState?.selected)
    .every(p => p.props.accessibilityLabel.startsWith('Done ')), true, 'the board opens on its done stage');
});
test('swimlane card opens the existing editor and reflects a saved title after closing', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await act(async () => labelled(root, 'Example card').props.onPress());
  await saveTitle(root, 'Updated in swimlane');
  await act(async () => { const native = root.root.findAllByType('NativeModal')[0];
    if (native) native.props.onRequestClose(); else root.root.findByType('Modal').props.onOpenChange(false); });
  assert.ok(labelled(root, 'Updated in swimlane'));
  assert.equal(h.calls.filter(c => c.name.endsWith('mutate')).length, 1);
});
test('D3 route and stage survive theme updates and a full React remount, without leaking to another host', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  for (let i = 0; i < 12; i++) h.addCard({ ...add(`Completed ${i}`), stageId: 'done' });
  const root = await render(t, OverviewScreen, h.props);
  // REQ-75 B1: the workspace name is the way into the existing board.
  await act(async () => hosts(root, 'workspace-name-link')[0].props.onPress());
  // A narrow board has stage tabs; preserve the chosen tab as well as the board route.
  await act(async () => root.root.findAllByType('View').find(v => v.props.testID === 'workspace-board')
    .props.onLayout({ nativeEvent: { layout: { width: 600 } } }));
  const tab = root.root.findAllByType('Pressable').find(p => p.props.accessibilityRole === 'tab' &&
    p.findAllByType('Text').some(n => JSON.stringify(n.props.children).includes('Done')));
  await act(async () => tab.props.onPress());
  const dark = { ...h.props, theme: { colors: { ...h.props.theme.colors, surface0: '#111111' } } };
  await act(async () => root.update(React.createElement(OverviewScreen, dark)));
  assert.equal(root.root.findAllByProps({ testID: 'workspace-board' }).length, 1);
  await act(async () => root.unmount());
  const remounted = await render(t, OverviewScreen, dark);
  assert.equal(remounted.root.findAllByProps({ testID: 'workspace-board' }).length, 1);
  assert.equal(remounted.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab' && p.props.accessibilityState.selected)[0]
    .props.accessibilityLabel.startsWith('Done '), true);
  await act(async () => remounted.update(React.createElement(OverviewScreen, { ...dark, host: { id: 'host_other', label: 'Other host' } })));
  assert.equal(remounted.root.findAllByProps({ testID: 'swimlane-screen' }).length, 1);
});
// REQ-68: the list is one glyph of the view switch (once ⋯ → "View as list" / "Back to Kanban").
test('list view is the view switch while R2 1b selects the new narrow stage layout', async t => {
  const h = harness({ width: 1000 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await act(async () => sheetButton(root, 'view-list').props.onPress());
  assert.equal(root.root.findAllByProps({ testID: 'swimlane-screen' }).length, 0);
  assert.match(text(root), /Cards needing your attention/);
  await act(async () => sheetButton(root, 'view-swimlane').props.onPress());
  assert.equal(root.root.findAllByProps({ testID: 'swimlane-screen' }).length, 1);
  await act(async () => root.root.findAllByType('View')[0].props.onLayout({ nativeEvent: { layout: { width: 759 } } }));
  assert.equal(root.root.findAllByProps({ testID: 'swimlane-screen' }).length, 0);
  assert.equal(root.root.findAllByProps({ testID: 'mobile-swimlane-screen' }).length, 1);
});

test('mobile first screen combines chip and counted tabs in one 44px row with a 168px reference budget', async t => {
  const h = harness({ mobile: true, platform: 'android' }); h.addCard({ ...add('In flight'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  assert.equal(root.root.findAllByProps({ testID: 'mobile-swimlane-screen' }).length, 1);
  assert.ok(labelled(root, 'In flight')); assert.equal(labelled(root, 'Example card'), undefined);
  const appbar = root.root.findByProps({ testID: 'mobile-appbar' });
  const controls = root.root.findByProps({ testID: 'mobile-control-row' });
  const heading = root.root.findByProps({ testID: 'mobile-workspace-heading' });
  assert.equal(64 + appbar.props.style.height + controls.props.style.height + heading.props.style.minHeight, 168);
  const body = root.root.findByProps({ testID: 'mobile-swimlane-screen' });
  assert.equal(body.props.style.paddingTop ?? 0, 0); assert.equal(body.props.style.gap ?? 0, 0);
  const native = nativeNode(root, 'mobile-swimlane-screen');
  assert.deepEqual(native.children.map(n => n.props?.testID),
    ['mobile-appbar', 'mobile-control-row', 'mobile-workspace-sections']);
  // REQ-75 A1: the flat board (the default) lists workspace sections straight under the scroll view.
  const section = native.children[2].children[0];
  assert.equal(section.props.style.marginTop, 0);
  assert.equal(section.children[0].props.testID, 'mobile-workspace-heading');
  // REQ-93: each card sits in its slot (the family's mark, summary and ring hang on it), the face first in it.
  assert.ok(section.children[1].children[0].props.testID.startsWith('linked-card-'));
  assert.equal(section.children[1].children[0].children[0].props.testID, 'card-shadow');
  assert.ok(section.children[1].children[0].children[0].children[0].props.testID.startsWith('kanban-card-'));
  assert.equal(section.children[1].props.style.paddingTop ?? 0, 0);
  assert.equal(root.root.findByProps({ testID: 'mobile-tab-doing' }).props.accessibilityLabel, 'In progress 1');
  assert.equal(root.root.findByProps({ testID: 'mobile-tab-todo' }).props.accessibilityLabel, 'To Do 1');
  assert.equal(root.root.findByProps({ testID: 'mobile-chip-face' }).props.style.height, 36); // REQ-71: as tall as a tab
  assert.ok([...appbar.findAllByType('Pressable'), ...controls.findAllByType('Pressable')]
    .every(p => !p.props.style.borderWidth && !p.props.style.borderBottomWidth));
  assert.ok(root.root.findAllByProps({ testID: 'mobile-tab-face' }).every(v => v.props.style.height === 36));
  assert.ok(root.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab').every(p => p.props.style.height === 44 && p.props.style.width >= 44));
  assert.equal(body.props.style.paddingBottom, 56);
  assert.equal(root.root.findByProps({ testID: 'mobile-workspace-sections' }).props.contentContainerStyle.paddingBottom, 56);
  assert.doesNotMatch(text(root), /Cards needing your attention/);
  assert.match(text(root), /Example Project/); assert.match(text(root), /Example Workspace/);
});
test('mobile tabs and expansion survive theme updates and remount/foreground without local-action RPCs', async t => {
  const h = harness({ mobile: true });
  for (let i = 0; i < 5; i++) h.addCard({ ...add(`Doing ${i}`), stageId: 'doing' });
  for (let i = 0; i < 4; i++) h.addCard({ ...add(`Review ${i}`), stageId: 'review' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const cards = tree => tree.root.findAllByType('Pressable').filter(p => p.props.testID?.startsWith('kanban-card-'));
  assert.equal(cards(root).length, 3);
  const count = h.calls.length;
  await act(async () => button(root, 'Show 5 more in each column (3 not shown)').props.onPress()); assert.equal(cards(root).length, 5);
  await act(async () => root.root.findByProps({ testID: 'mobile-tab-review' }).props.onPress()); assert.equal(cards(root).length, 4);
  const dark = { ...h.props, theme: { colors: { ...h.props.theme.colors, surface0: '#111111' } } };
  await act(async () => root.update(React.createElement(OverviewScreen, dark)));
  assert.equal(h.calls.length, count); assert.equal(cards(root).length, 4);
  await act(async () => root.unmount());
  const next = await render(t, OverviewScreen, dark);
  assert.equal(next.root.findByProps({ testID: 'mobile-tab-review' }).props.accessibilityState.selected, true);
  assert.equal(cards(next).length, 4);
  await act(async () => button(next, 'Collapse').props.onPress()); assert.equal(cards(next).length, 3);
});
test('REQ-18 mobile attention excludes done requests, chooses a populated stage and restores the previous tab when cleared', async t => {
  const h = harness({ mobile: true }); h.addCard({ ...add('Done request'), stageId: 'done', awaiting: 'user' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const count = h.calls.length;
  assert.equal(root.root.findByProps({ testID: 'mobile-attention-chip' }).props.accessibilityLabel, 'Needs attention 1');
  await act(async () => root.root.findByProps({ testID: 'mobile-attention-chip' }).props.onPress());
  assert.equal(root.root.findByProps({ testID: 'mobile-tab-todo' }).props.accessibilityState.selected, true);
  await act(async () => root.root.findByProps({ testID: 'mobile-tab-done' }).props.onPress());
  assert.equal(labelled(root, 'Done request'), undefined);
  await act(async () => root.root.findByProps({ testID: 'mobile-attention-chip' }).props.onPress());
  assert.equal(root.root.findByProps({ testID: 'mobile-tab-doing' }).props.accessibilityState.selected, true);
  assert.equal(h.calls.length, count);
});
// REQ-68: the phone's top bar carries list/filters(projects)/refresh as glyphs, once in ⋯.
test('mobile top bar keeps list/project/refresh and a saved card updates its selected-stage section', async t => {
  const h = harness({ mobile: true }); h.addCard({ ...add('Mobile edit'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  assert.equal(labelled(root, 'More'), undefined);
  assert.ok(labelled(root, 'View as list')); assert.ok(labelled(root, 'Filters and search')); assert.ok(labelled(root, 'Refresh'));
  await act(async () => labelled(root, 'Mobile edit').props.onPress());
  await saveTitle(root, 'Mobile saved');
  await act(async () => { const native = root.root.findAllByType('NativeModal')[0];
    if (native) native.props.onRequestClose(); else root.root.findByType('Modal').props.onOpenChange(false); });
  assert.ok(labelled(root, 'Mobile saved'));
  await act(async () => labelled(root, 'View as list').props.onPress());
  assert.match(text(root), /Cards needing your attention/);
  await act(async () => labelled(root, 'View as swimlanes').props.onPress());
  assert.ok(labelled(root, 'Mobile saved'));
});
test('D4 narrow workspace panels meet the 149px panel budget while wide board controls remain unchanged', async t => {
  const h = harness({ width: 600, panel: true }), { WorkspacePanel } = h.load('client/panel.tsx');
  const root = await render(t, WorkspacePanel, { ...h.props, context: 'workspace', workspaceId: h.base.workspaceId });
  const board = root.root.findByProps({ testID: 'workspace-board' });
  await act(async () => board.props.onLayout({ nativeEvent: { layout: { width: 600 } } }));
  assert.equal(board.props.style.padding, 0); assert.equal(board.props.style.gap, 0);
  assert.deepEqual(nativeNode(root, 'workspace-board').children.map(n => n.props?.testID),
    ['mobile-control-row', undefined]);
  assert.equal(root.root.findAllByProps({ testID: 'board-appbar' }).length, 0);
  const controls = root.root.findByProps({ testID: 'mobile-control-row' });
  const list = root.root.findAllByType('ScrollView').find(v => v.props.nestedScrollEnabled);
  assert.equal(101 + controls.props.style.height + list.props.contentContainerStyle.paddingTop, 149);
  const chip = root.root.findByProps({ testID: 'mobile-attention-chip' });
  assert.equal(chip.props.accessibilityState.selected, false);
  await act(async () => chip.props.onPress());
  assert.equal(chip.props.accessibilityState.selected, true);
  await act(async () => labelled(root, 'More').props.onPress());
  assert.ok(button(root, 'Create draft'));
  await act(async () => button(root, 'Close').props.onPress());
  assert.ok(labelled(root, 'Example card'));
  await act(async () => board.props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  assert.equal(root.root.findAllByProps({ testID: 'mobile-control-row' }).length, 0);
  assert.equal(labelled(root, 'Create draft').props.style.height, 30);
  assert.equal(board.props.style.gap, 8); assert.equal(board.props.style.padding, 12);
});
test('mobile section headers have no divider and project selection keeps a 44px action target', async t => {
  const h = harness({ mobile: true }); h.addCard({ ...add('Doing'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const section = root.root.findAllByType('View').find(v => v.props.testID?.startsWith('mobile-workspace-board_'));
  assert.ok(section); assert.equal(section.props.style?.borderBottomWidth, undefined);
  // REQ-75 A1: flat by default — no project group, the first workspace section starts the list.
  assert.equal(root.root.findAllByProps({ testID: 'mobile-project-group' }).length, 0);
  assert.equal(section.props.style.marginTop, 0);
  // REQ-68: the projects are in the filter sheet, now opened from its own glyph (once ⋯ → "Projects").
  await act(async () => sheetButton(root, 'open-filters').props.onPress());
  const trigger = root.root.findByProps({ testID: 'project-dropdown-trigger' });
  assert.equal(trigger.props.style.height, 44); await act(async () => trigger.props.onPress());
  const project = button(root, 'Example Project'); assert.equal(project.props.style.minHeight, 44);
  await act(async () => project.props.onPress());
  assert.equal(labelled(root, 'Doing'), undefined, 'REQ-57: unchecking the project hides its workspaces');
  await act(async () => button(root, 'Example Project').props.onPress());
  assert.ok(root.root.findAllByType('View').some(v => v.props.testID?.startsWith('mobile-workspace-board_')),
    'REQ-57: checking it back brings the workspace section back');
});

test('REQ-19 repeats headings per lane, stretches measurable panels, and keeps empty cells blank', async t => {
  const h = harness({ width: 1400 });
  h.addCard(add('Short card')); h.addCard({ ...add('Finished'), stageId: 'done', awaiting: 'user' });
  h.props.theme.colors.surface0 = '#ffffff'; h.props.theme.colors.surface1 = '#eeeeee';
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  assert.equal(root.root.findAllByProps({ testID: 'swimlane-column-header' }).length, 0);
  const panels = root.root.findAllByType('View').filter(v => v.props.testID?.startsWith('swimlane-cell-'));
  assert.equal(panels.length, 4);
  const styles = panels.map(p => Object.assign({}, ...p.props.style));
  assert.ok(styles.every(s => s.width === 280 && s.backgroundColor === palette(h.props.theme).panel && s.borderRadius === 8));
  assert.equal(new Set(styles.map(s => s.minHeight)).size, 1);
  assert.ok(panels.every(p => p.props.collapsable === false));
  assert.equal(nativeNode(root, 'swimlane-cells').props.style.alignItems, 'stretch');
  const empty = nativeNode(root, 'swimlane-cell-review');
  assert.equal(empty.children, null); // Stage headings moved into the direct scroll-child header.
  assert.equal(nativeNode(root, 'lane-stage-headers').children.length, 4);
  // REQ-67 ③: the count is the number alone, "(3)" rather than "(3 cards)".
  assert.match(text(root), /Example Workspace/); assert.match(textOf(hosts(root, 'swimlane-lane-header')[0]), /\(3\)/); assert.doesNotMatch(text(root), /3 cards/);
  assert.ok(root.root.findByProps({ testID: 'project-icon' }));
  const active = labelled(root, 'Example card'), done = labelled(root, 'Finished');
  assert.equal(active.props.style.backgroundColor, '#ffffff'); assert.equal(active.props.style.height, 128, 'REQ-145 ③: and its reply row');
  assert.equal(done.props.style.height, 84);
  assert.equal(active.findAllByProps({ testID: 'card-stage-stripe' }).length, 1);
  assert.equal(done.findAllByProps({ testID: 'card-stage-stripe' }).length, 1);
  const calls = h.calls.length;
  const dark = { ...h.props, theme: { colors: { ...h.props.theme.colors, surface0: '#181b1a', surface1: '#252927' } } };
  await act(async () => root.update(React.createElement(OverviewScreen, dark)));
  assert.equal(labelled(root, 'Example card').props.style.backgroundColor, palette(dark.theme).card);
  const darkPanel = nativeNode(root, 'swimlane-cell-todo');
  assert.equal(Object.assign({}, ...darkPanel.props.style).backgroundColor, palette(dark.theme).panel);
  assert.equal(h.calls.length, calls);
});
test('mobile sections reuse panel/card tokens without inserting space above the first card', async t => {
  const h = harness({ mobile: true }); h.addCard({ ...add('Doing'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const panel = nativeNode(root, 'mobile-cell-panel'), style = Object.assign({}, ...panel.props.style);
  assert.equal(style.paddingTop ?? 0, 0); assert.equal(style.backgroundColor, palette(h.props.theme).panel);
  assert.equal(panel.children[0].children[0].children[0].props.accessibilityLabel, 'Doing', 'REQ-93: the card in its slot, first');
  assert.equal(root.root.findAllByProps({ testID: 'cell-panel-heading' }).length, 0);
});

test('REQ-20/21 shadows stay outside rounded clipping and every stage stripe meets both ends', async t => {
  // The harness's first card waits for a person, whose stripe is REQ-95 ③'s orange (tested there); here it is its stage's.
  const h = harness({ width: 1400 }); h.external({ awaiting: null }); h.addCard({ ...add('Finished stripe'), stageId: 'done' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const cards = root.root.findAllByType('Pressable').filter(p => p.props.testID?.startsWith('kanban-card-'));
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.equal(card.props.style.overflow, 'hidden'); assert.equal(card.props.style.borderRadius, 8);
    assert.equal(card.parent.props.testID, 'card-shadow');
    assert.equal(card.parent.props.style.overflow, undefined); assert.equal(card.parent.props.style.borderRadius, 8);
    assert.equal(card.parent.props.style.elevation, 2); assert.ok(card.parent.props.style.shadowOpacity > 0);
    const stripe = card.findByProps({ testID: 'card-stage-stripe' });
    assert.equal(stripe.props.style.top, 0); assert.equal(stripe.props.style.bottom, 0); assert.equal(stripe.props.style.left, 0);
    assert.equal(stripe.props.style.width, 3); assert.equal(stripe.props.pointerEvents, 'none');
  }
  assert.equal(labelled(root, 'Finished stripe').findByProps({ testID: 'card-stage-stripe' }).props.style.backgroundColor,
    h.props.theme.colors.statusSuccess);
  assert.equal(labelled(root, 'Example card').findByProps({ testID: 'card-stage-stripe' }).props.style.backgroundColor,
    h.props.theme.colors.foregroundMuted);
});
test('REQ-23/29 headers pair a stage dot and separate numeric badge with a 96px progress track', async t => {
  const h = harness({ width: 1400 }); h.addCard({ ...add('Finished'), stageId: 'done' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const headings = root.root.findAllByType('View').filter(v => v.props.testID === 'cell-panel-heading');
  assert.equal(headings.length, 4);
  for (const heading of headings) {
    assert.equal(heading.props.style.height, 36); assert.equal(heading.props.style.borderBottomWidth, 1);
    assert.ok(heading.findByProps({ testID: 'stage-color-dot' }));
    const badge = heading.findAllByType('View').find(v => v.props.testID === 'stage-count-badge');
    assert.equal(badge.props.style.borderRadius, 5); assert.equal(badge.props.style.backgroundColor, palette(h.props.theme).badge);
  }
  assert.equal(root.root.findByProps({ testID: 'lane-progress-track' }).props.style.width, 96);
  assert.equal(root.root.findByProps({ testID: 'lane-progress-fill' }).props.style.width, 48);
});
test('REQ-57 the desktop project dropdown checks projects, clears and restores them all, and remembers the choice', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'], emptyProject: 'prj_second' });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props), calls = h.calls.length;
  const trigger = () => root.root.findByProps({ testID: 'project-dropdown-trigger' });
  assert.equal(trigger().props.accessibilityLabel, 'Projects: Projects (2/2)');
  assert.equal(trigger().props.accessibilityState.expanded, false);
  await act(async () => trigger().props.onPress());
  assert.equal(trigger().props.accessibilityState.expanded, true); assert.ok(labelled(root, 'All projects'));
  await act(async () => labelled(root, 'Example Project').props.onPress());
  assert.equal(trigger().props.accessibilityLabel, 'Projects: Projects (1/2)');
  assert.equal(trigger().props.accessibilityState.expanded, true, 'a multiple choice stays open');
  assert.equal(labelled(root, 'Example card'), undefined);
  assert.deepEqual(h.ui.writes.at(-1).hiddenProjects, ['prj_example01']);
  assert.equal(h.ui.writes.at(-1).hostId, h.props.host.id);
  // The all row ticks every box when some are off, and clears them when they are all on.
  await act(async () => labelled(root, 'All projects').props.onPress());
  assert.equal(trigger().props.accessibilityLabel, 'Projects: Projects (2/2)');
  await act(async () => labelled(root, 'All projects').props.onPress());
  assert.equal(trigger().props.accessibilityLabel, 'Projects: Projects (0/2)');
  assert.match(text(root), /No matching cards|No boards/);
  await act(async () => labelled(root, 'All projects').props.onPress());
  assert.equal(trigger().props.accessibilityLabel, 'Projects: Projects (2/2)');
  await act(async () => root.root.findByProps({ testID: 'project-dropdown-dismiss' }).props.onPress());
  assert.equal(trigger().props.accessibilityState.expanded, false);
  assert.ok(labelled(root, 'Example card'));
  assert.deepEqual(h.ui.value.hiddenProjects, []);
  assert.equal(h.ui.writes.length, 4, 'one write per change, never one for an unchanged selection');
  assert.equal(h.calls.length, calls + 4, 'only the filter writes, no re-read');
});
test('REQ-57 the remembered projects come back from the ledger and idle screens write nothing', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'], emptyProject: 'prj_second', hiddenProjects: ['prj_example01'] });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const trigger = () => root.root.findByProps({ testID: 'project-dropdown-trigger' });
  assert.equal(trigger().props.accessibilityLabel, 'Projects: Projects (1/2)');
  assert.equal(labelled(root, 'Example card'), undefined, 'the remembered project is hidden on load');
  assert.ok(text(root).includes('Empty Workspace 0'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.ui.writes.length, 0, 'no write while the screen only sits there');
  assert.ok(h.calls.some(c => c.name === 'kanban.v1.overview.get' && c.input.hostId === h.props.host.id));
});
test('REQ-28 / REQ-88 ① the wide detail is two columns in an 880px window, and a close saves what is still typed; mobile gets one column in the Kanban sheet', async t => {
  const h = harness({ width: 1400 }), { Detail } = h.load('client/detail.tsx'); let closed = 0;
  const root = await render(t, Detail, { ...h.props, boardId: h.base.id, cardId: h.base.cards[0].id, locale: 'en', onClose: () => closed++ });
  const dialog = root.root.findByProps({ testID: 'desktop-detail-dialog' }); assert.equal(dialog.props.style.width, 880);
  assert.equal(root.root.findByProps({ testID: 'detail-columns' }).props.style.flexDirection, 'row');
  const panel = root.root.findByProps({ testID: 'detail-panel' }), main = root.root.findByProps({ testID: 'detail-main' });
  assert.equal(panel.props.style.width, 280, 'a narrow state panel on the right');
  const inside = (node, id) => node.findAll(n => n.props?.testID === id && typeof n.type === 'string').length > 0;
  for (const id of ['stage-bar', 'priority-choice', 'awaiting-choice', 'field-blockedReason', 'detail-meta']) assert.ok(inside(panel, id), id + ' in the panel');
  for (const id of ['detail-title', 'field-nextAction', 'field-notes']) assert.ok(inside(main, id), id + ' on the left');
  assert.equal(hosts(root, 'stage-bar-todo')[0].props.style.height, 26, 'the panel\'s smaller flow');
  assert.equal(root.root.findAllByType('ScrollView')[0].props.contentContainerStyle.padding, 24);
  assert.equal(root.root.findAllByType('TextInput').filter(n => n.props.accessibilityLabel === 'Title').length, 0, 'REQ-88 ③: no second title field');
  // A close with a field still being typed in saves it, then closes (REQ-88 ⑤).
  await act(async () => input(root, 'Notes').props.onChangeText('Keep this edit'));
  await act(async () => root.root.findByType('NativeModal').props.onRequestClose()); await settle();
  assert.equal(h.base.cards[0].notes, 'Keep this edit'); assert.equal(closed, 1);
  const m = harness({ mobile: true }), NativeDetail = m.load('client/detail.tsx').Detail;
  const mobile = await render(t, NativeDetail, { ...m.props, boardId: m.base.id, cardId: m.base.cards[0].id, locale: 'en', onClose: () => {} });
  assert.equal(hosts(mobile, 'desktop-detail-dialog').length, 0); assert.equal(hosts(mobile, 'editor-sheet').length, 1);
  assert.equal(mobile.root.findAllByType('Modal').length, 0, 'REQ-72: no host sheet');
  assert.equal(hosts(mobile, 'detail-panel').length, 0, 'one column on a phone');
  const order = ['detail-title', 'stage-bar', 'field-nextAction', 'field-notes', 'priority-choice', 'awaiting-choice', 'field-blockedReason'];
  const words = text(mobile);
  assert.deepEqual(order.map(id => words.indexOf(`"testID":"${id}"`)).every((at, i, all) => at > 0 && (i === 0 || at > all[i - 1])), true,
    'title, stage flow, next action, notes, then the choices');
});
test('REQ-32/REQ-75 B1 mobile workspace context adds project context, a long press shows the full name and a tap opens the board', async t => {
  const h = harness({ mobile: true }); h.addCard({ ...add('Doing'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const heading = root.root.findByProps({ testID: 'mobile-workspace-heading' });
  assert.equal(heading.findByProps({ testID: 'project-icon' }).props.accessibilityLabel, 'Example Project');
  const name = heading.findByProps({ testID: 'workspace-name-link' });
  assert.equal(name.props.accessibilityRole, 'link');
  assert.equal(name.props.accessibilityLabel, 'Open board: Example Workspace · Example Project · example-workspace');
  assert.equal(name.props.accessibilityHint, 'Long press shows the full name');
  assert.equal(heading.findByProps({ testID: 'lane-name' }).props.style.flex, 1);
  assert.equal(heading.findByProps({ testID: 'workspace-name-primary' }).props.numberOfLines, 1, 'a long name is cut with …');
  await act(async () => name.props.onLongPress());
  assert.equal(name.props.accessibilityState.expanded, true);
  assert.equal(heading.findByProps({ testID: 'workspace-name-primary' }).props.numberOfLines, undefined, 'a long press shows it whole');
  assert.equal(hosts(root, 'lane-name-tooltip').length, 0, 'no hover tip on the phone heading');
  assert.equal(heading.props.style.minHeight, 16);
  await act(async () => name.props.onPress());
  assert.equal(root.root.findAllByProps({ testID: 'mobile-swimlane-screen' }).length, 0, 'a tap on the name opens the board');
});

test('G1 modal Escape, outside and selection all restore the measured project trigger after dismissal', async t => {
  const h = harness({ width: 1400 }), { ProjectDropdown } = h.load('client/project-dropdown.tsx');
  const m = h.load('client/i18n.ts').copy('en'), focus = [];
  function Controlled() {
    const [open, setOpen] = React.useState(false), [hidden, setHidden] = React.useState([]);
    return React.createElement(ProjectDropdown, { options: new Map([['prj_example', 'Example Project']]),
      hidden, open, onOpenChange: setOpen, onChange: setHidden, colors: palette(h.props.theme), m });
  }
  const root = await render(t, Controlled, {}, { createNodeMock: element => element.props.testID === 'project-dropdown-trigger'
    ? { focus: () => focus.push('trigger'), measureInWindow: callback => callback(120, 80, 220, 30) } : null });
  const trigger = () => root.root.findByProps({ testID: 'project-dropdown-trigger' });
  for (const reason of ['escape', 'outside', 'selection']) {
    const before = focus.length;
    await act(async () => trigger().props.onPress());
    assert.equal(focus.length, before + 1); assert.equal(trigger().props.accessibilityState.expanded, true);
    const menu = root.root.findAllByType('View').find(v => v.props.testID === 'project-dropdown-menu');
    assert.equal(menu.props.style.left, 120); assert.equal(menu.props.style.top, 114);
    await act(async () => {
      if (reason === 'escape') root.root.findByType('NativeModal').props.onRequestClose();
      else if (reason === 'outside') root.root.findByProps({ testID: 'project-dropdown-dismiss' }).props.onPress();
      else { labelled(root, 'Example Project').props.onPress();
        root.root.findByProps({ testID: 'project-dropdown-dismiss' }).props.onPress(); }
    });
    assert.equal(trigger().props.accessibilityState.expanded, false);
    assert.equal(root.root.findAllByType('NativeModal').length, 0);
    assert.equal(focus.length, before + 2, reason + ' restores focus after Modal dismissal');
  }
});

test('REQ-30/31 filters combine locally and clear all without new RPC or directory reads', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'], emptyProject: 'prj_second' }); h.addCard(add('Quiet task'));
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const before = h.calls.length, sdkBefore = h.sdkCalls.length;
  await act(async () => root.root.findByProps({ testID: 'project-dropdown-trigger' }).props.onPress());
  // REQ-57: unchecking a project is what "filter by project" now means.
  await act(async () => labelled(root, 'Second Project').props.onPress());
  await act(async () => root.root.findByProps({ testID: 'project-dropdown-dismiss' }).props.onPress());
  await act(async () => root.root.findByProps({ testID: 'label-dropdown-trigger' }).props.onPress());
  await act(async () => labelled(root, 'Explore').props.onPress());
  assert.equal(root.root.findByProps({ testID: 'label-dropdown-trigger' }).props.accessibilityState.expanded, true);
  await act(async () => labelled(root, 'Prototype').props.onPress());
  await act(async () => root.root.findByProps({ testID: 'label-dropdown-dismiss' }).props.onPress());
  await act(async () => root.root.findByProps({ testID: 'attention-chip' }).props.onPress());
  await act(async () => input(root, 'Search cards').props.onChangeText('  RESULT '));
  assert.ok(labelled(root, 'Example card')); assert.equal(labelled(root, 'Quiet task'), undefined);
  // REQ-114: the count is the filter glyph's badge now, and "Clear all" sits in the menu it opens.
  assert.equal(hosts(root, 'filter-menu')[0].props.accessibilityLabel, 'Filters: 5 applied');
  await act(async () => input(root, 'Search cards').props.onChangeText('not present'));
  assert.equal(root.root.findAllByProps({ testID: 'swimlane-card-slot' }).length, 0); assert.match(text(root), /No matching cards/);
  await clearAllFilters(root);
  assert.equal(input(root, 'Search cards').props.value, ''); assert.ok(labelled(root, 'Quiet task'));
  assert.equal(h.calls.length, before + h.ui.writes.length, 'only the project filter is remembered');
  assert.equal(h.sdkCalls.length, sdkBefore);
});
test('missing optional labels hide only the label dropdown', async t => {
  const h = harness({ width: 1400, labelsAvailable: false }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.equal(root.root.findAllByProps({ testID: 'label-dropdown-trigger' }).length, 0);
  assert.ok(root.root.findByProps({ testID: 'project-dropdown-trigger' })); assert.ok(input(root, 'Search cards'));
});
test('REQ-24/25/32 demo uses memory only, folds projects, expands names and blocks UI writes across layout changes', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const before = h.calls.length, sdkBefore = h.sdkCalls.length;
  await toggleDemo(root);
  assert.ok(root.root.findByProps({ testID: 'demo-banner' }));
  // REQ-75 A1: flat by default — thirteen workspace lanes and no project heading.
  assert.equal(root.root.findAllByType('View').filter(v => v.props.testID === 'project-group-header').length, 0);
  assert.equal(root.root.findAllByType('AnimatedView').filter(v => v.props.testID === 'swimlane-lane-header').length, 13);
  // A2: grouping in the demo changes the screen and writes nothing (checked with the other calls below).
  await act(async () => sheetButton(root, 'group-toggle').props.onPress());
  assert.equal(root.root.findAllByType('View').filter(v => v.props.testID === 'project-group-header').length, 6,
    'every project gets a heading, one-workspace projects too');
  assert.equal(root.root.findAllByType('AnimatedView').filter(v => v.props.testID === 'swimlane-lane-header').length, 13);
  const create = labelled(root, 'Create draft'); assert.equal(create.props.disabled, true);
  await act(async () => create.props.onPress()); assert.equal(input(root, 'Title'), undefined);
  const vertical = nativeNode(root, 'swimlane-vertical');
  assert.ok(!JSON.stringify(vertical).includes('swimlane-filters'), 'REQ-26: the filter row is not inside the scroll views');
  const projects = vertical.children.filter(n => n.props?.testID === 'swimlane-project-section');
  assert.ok(projects.length >= 1, 'REQ-42: every project owns a section that its lanes pin inside');
  const sections = projects.flatMap(n => n.children.filter(v => v.props?.testID === 'swimlane-lane-section'));
  assert.ok(sections.length >= 1);
  // REQ-60: the rail is an absolute overlay at the end of the section; the flow is unchanged.
  assert.deepEqual(sections[0].children.map(n => n.props?.testID).filter(id => id !== 'lane-rail'), ['lane-section-header', 'swimlane-cells']);
  const firstName = root.root.findAllByType('Pressable').find(p => p.props.testID === 'workspace-name-link');
  await act(async () => firstName.props.onLongPress()); assert.equal(firstName.props.accessibilityState.expanded, true);
  await act(async () => firstName.props.onPress());
  assert.ok(root.root.findByProps({ testID: 'demo-banner' }), 'REQ-75 B1: the demo stays put — it has no board to open');
  const fold = root.root.findAllByType('Pressable').find(p => p.props.accessibilityLabel?.startsWith('Collapse project:'));
  await act(async () => fold.props.onPress());
  assert.ok(root.root.findAllByType('AnimatedView').filter(v => v.props.testID === 'swimlane-lane-header').length < 12);
  const card = root.root.findAllByType('Pressable').find(p => p.props.testID?.startsWith('kanban-card-demo_'));
  await act(async () => card.props.onPress()); assert.match(text(root), /Demo data is read only/);
  assert.equal(wordButtons(root, 'Save changes'), 0, 'REQ-88 ⑤: no "Save changes" — and the demo has nothing to save');
  await act(async () => sheetButton(root, 'sheet-close').props.onPress());
  await act(async () => root.root.findAllByType('View').find(v => v.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
  assert.ok(root.root.findByProps({ testID: 'mobile-swimlane-screen' })); assert.ok(root.root.findByProps({ testID: 'demo-banner' }));
  assert.equal(h.calls.length, before); assert.equal(h.sdkCalls.length, sdkBefore);
  assert.equal(h.calls.filter(c => c.name.endsWith('mutate')).length, 0);
  await act(async () => button(root, 'Exit demo').props.onPress());
  assert.equal(root.root.findAllByProps({ testID: 'demo-banner' }).length, 0);
});
test('demo defaults off after an app remount, independently of saved filter/fold choices', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await toggleDemo(root);
  await act(async () => root.unmount());
  const next = await render(t, OverviewScreen, h.props);
  assert.equal(next.root.findAllByProps({ testID: 'demo-banner' }).length, 0); assert.ok(labelled(next, 'Example card'));
});
test('preview context and reserved IDs stop direct mutation calls before useRpc execution', async t => {
  const h = harness(), { PreviewContext } = h.load('client/preview-context.tsx');
  const { useMutation } = h.load('client/mutation.ts'); let flow;
  function Probe() { flow = useMutation(); return null; }
  function PreviewProbe() { return React.createElement(PreviewContext.Provider, { value: true }, React.createElement(Probe)); }
  await render(t, PreviewProbe, {});
  const payload = { boardId: h.base.id, ifRevision: h.base.revision, requestId: 'example-request', operations: [] };
  let reply; await act(async () => { reply = await flow.send(payload); });
  assert.equal(reply.error.code, 'E_READ_ONLY'); assert.equal(h.calls.length, 0);
  await act(async () => flow.retry()); assert.equal(h.calls.length, 0);
  await render(t, Probe, {});
  await act(async () => { reply = await flow.send({ ...payload, boardId: 'demo_board_0' }); });
  assert.equal(reply.error.code, 'E_READ_ONLY'); assert.equal(h.calls.length, 0);
});
test('D8 compact web menus use the same public Modal Escape path and keep existing dismissal actions', async t => {
  const h = harness({ mobile: true, platform: 'web' }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  // REQ-68: no ⋯ on the phone; its top bar opens the filter sheet and the settings sheet, both on the same path.
  assert.equal(labelled(root, 'More'), undefined);
  await act(async () => sheetButton(root, 'open-filters').props.onPress());
  assert.ok(root.root.findByProps({ testID: 'menu-sheet' })); assert.ok(input(root, 'Search cards'));
  await act(async () => root.root.findByType('NativeModal').props.onRequestClose());
  assert.equal(root.root.findAllByType('NativeModal').length, 0);
  await act(async () => sheetButton(root, 'open-settings').props.onPress());
  assert.ok(root.root.findByProps({ testID: 'settings-sheet' }));
  await act(async () => root.root.findByType('NativeModal').props.onRequestClose());
  assert.equal(root.root.findAllByType('NativeModal').length, 0);
});

// REQ-68: the sheet opens from its own glyph in the top bar (once from ⋯), and focus goes back to that glyph.
test('compact web Filters and search sheet returns focus to its button after Escape, outside and close', async t => {
  const h = harness({ mobile: true, platform: 'web' }), { OverviewScreen } = h.load('client/overview.tsx'), focus = [];
  const root = await render(t, OverviewScreen, h.props, { createNodeMock: element => element.props.accessibilityLabel === 'Filters and search'
    ? { focus: () => focus.push('filters') } : null });
  const closers = () => root.root.findAllByType('Pressable').filter(p => p.props.accessibilityLabel === 'Close');
  for (const reason of ['escape', 'outside', 'close button']) {
    const before = focus.length;
    await act(async () => sheetButton(root, 'open-filters').props.onPress());
    assert.ok(input(root, 'Search cards'));
    assert.equal(root.root.findAllByType('NativeModal').length, 1); assert.equal(focus.length, before, 'no focus change while open');
    await act(async () => {
      if (reason === 'escape') root.root.findByType('NativeModal').props.onRequestClose();
      else if (reason === 'outside') closers()[0].props.onPress();
      else closers()[1].props.onPress();
    });
    assert.equal(root.root.findAllByType('NativeModal').length, 0);
    assert.equal(focus.length, before + 1, reason + ' returns focus to the filter button');
  }
});

test('REQ-34 search input shows a decorative magnifier on desktop and in the mobile sheet', async t => {
  for (const [options, height, Component] of [[{ width: 1400 }, 30, 'client/overview.tsx'], [{ mobile: true, platform: 'web' }, 44, 'client/overview.tsx']]) {
    const h = harness(options), { OverviewScreen } = h.load(Component), root = await render(t, OverviewScreen, h.props);
    if (options.mobile) {
      await act(async () => sheetButton(root, 'open-filters').props.onPress());
    }
    const icon = root.root.findByProps({ testID: 'board-search-icon' });
    assert.equal(icon.props.pointerEvents, 'none'); assert.equal(icon.props.accessibilityElementsHidden, true);
    assert.equal(icon.props.importantForAccessibility, 'no-hide-descendants'); assert.equal(icon.props['aria-hidden'], true);
    assert.equal(icon.props.onPress, undefined);
    const glyph = icon.findByType('Icon'); assert.equal(glyph.props.name, 'Search');
    assert.ok(glyph.props.size >= 14 && glyph.props.size <= 16); assert.equal(glyph.props.color, palette(h.props.theme).foregroundMuted);
    const field = input(root, 'Search cards');
    assert.equal(field.props.style.height, height); assert.equal(field.props.accessibilityLabel, 'Search cards');
    assert.ok(field.props.style.paddingLeft >= icon.props.style.left + icon.props.style.width);
  }
});

test('REQ-37/REQ-75 B1·B2 wide swimlane headers have no open-board arrow; the workspace name is the way into the board', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  for (let i = 0; i < 12; i++) h.addCard({ ...add(`Completed ${i}`), stageId: 'done' });
  const root = await render(t, OverviewScreen, h.props);
  assert.ok(root.root.findAllByProps({ testID: 'swimlane-lane-header' }).length >= 1);
  assert.equal(root.root.findAllByType('Icon').filter(i => i.props.name === 'ArrowUpRight').length, 0);
  assert.equal(root.root.findAllByType('Pressable').filter(p => String(p.props.accessibilityLabel ?? '').startsWith('Open workspace board')).length, 0);
  // REQ-75 B2: the done heading no longer carries "Board ›"; B1: the name is a link, and the only one in the header.
  assert.equal(hosts(root, 'done-board-link').length, 0);
  const header = root.root.findAllByProps({ testID: 'swimlane-lane-header' })[0];
  const links = header.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'link');
  assert.deepEqual(links.map(p => p.props.accessibilityLabel), ['Open board: Example Workspace · Example Project · example-workspace']);
  assert.equal(header.findAllByType('Icon').filter(i => i.props.name === 'ArrowUpRight').length, 0);
  // Hover (or keyboard focus) underlines the name and shows what a press does (REQ-110); leaving takes both away.
  const primary = () => header.findByProps({ testID: 'workspace-name-primary' });
  assert.equal(primary().props.style.textDecorationLine, 'none');
  await act(async () => links[0].props.onHoverIn());
  assert.equal(primary().props.style.textDecorationLine, 'underline');
  assert.equal(allText(hosts(root, 'lane-name-tooltip')[0]), 'Open board', 'REQ-110: "Open board" alone, the name stays on the row');
  await act(async () => links[0].props.onHoverOut());
  assert.equal(primary().props.style.textDecorationLine, 'none'); assert.equal(hosts(root, 'lane-name-tooltip').length, 0);
  await act(async () => links[0].props.onFocus());
  assert.equal(primary().props.style.textDecorationLine, 'underline');
  await act(async () => links[0].props.onBlur());
  await act(async () => links[0].props.onPress());
  assert.equal(root.root.findAllByProps({ testID: 'workspace-board' }).length, 1, 'a click on the name opens the board');
});

test('REQ-36 search field is a fixed 260px on wide screens and full width in the mobile sheet', async t => {
  for (const [options, width] of [[{ width: 1400 }, 260], [{ mobile: true, platform: 'web' }, '100%']]) {
    const h = harness(options), { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
    if (options.mobile) {
      await act(async () => sheetButton(root, 'open-filters').props.onPress());
    }
    const field = root.root.findByProps({ testID: 'board-search-field' }).props.style;
    assert.equal(field.width, width); assert.equal(field.flex, undefined, 'the field must not grow to fill the filter row');
    assert.equal(field.maxWidth, '100%');
    assert.equal(root.root.findByProps({ testID: 'swimlane-filters' }).props.style.flexWrap, 'wrap');
    assert.equal(input(root, 'Search cards').props.style.height, options.mobile ? 44 : 30);
  }
});

test('D14 focused search keeps a full four-sided border in the host accent color without moving the layout, and D15 placeholder is muted', async t => {
  for (const options of [{ width: 1400 }, { width: 1400, dark: true }]) {
    const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
    const props = options.dark ? { ...h.props, theme: { colors: { ...h.props.theme.colors, surface0: '#111111', surface1: '#1b1b1b', surface2: '#242424' } } } : h.props;
    const root = await render(t, OverviewScreen, props), colors = palette(props.theme);
    const before = input(root, 'Search cards').props.style;
    assert.equal(before.borderColor, colors.border); assert.equal(before.borderWidth, 1); assert.equal(before.borderRadius, 6);
    assert.equal(before.outlineStyle, 'none', 'the browser outline is off; it was clipped by the scroll viewport');
    assert.equal(input(root, 'Search cards').props.placeholderTextColor, colors.foregroundMuted);
    await act(async () => input(root, 'Search cards').props.onFocus());
    const focused = input(root, 'Search cards').props.style;
    assert.equal(focused.borderColor, colors.accent); assert.equal(focused.borderWidth, before.borderWidth);
    assert.equal(focused.borderRadius, 6); assert.equal(focused.height, before.height); assert.equal(focused.paddingLeft, before.paddingLeft);
    await act(async () => input(root, 'Search cards').props.onBlur());
    assert.equal(input(root, 'Search cards').props.style.borderColor, colors.border);
  }
});

test('REQ-26 the filter row sits outside both scroll views and every lane owns a pinned section header', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  for (let i = 0; i < 3; i++) h.addCard({ ...add(`Queued ${i}`) });
  const root = await render(t, OverviewScreen, h.props);
  const screen = nativeNode(root, 'swimlane-screen');
  const order = screen.children.map(n => n.props?.testID);
  assert.ok(order.indexOf('swimlane-fixed-header') >= 0, 'the filter row is a direct child of the screen');
  assert.ok(order.indexOf('swimlane-fixed-header') < order.indexOf('swimlane-horizontal'), 'and it precedes the scrolling area');
  const fixed = nativeNode(root, 'swimlane-fixed-header');
  assert.equal(fixed.children[0].props.testID, 'swimlane-filters');
  const vertical = nativeNode(root, 'swimlane-vertical');
  assert.ok(!JSON.stringify(vertical).includes('swimlane-filters'), 'the filter row never scrolls away');
  // REQ-75 A1: flat by default — the lane sections sit straight in the vertical scroll view, no project section.
  assert.equal(vertical.children.filter(n => n.props?.testID === 'swimlane-project-section').length, 0);
  const sections = vertical.children.filter(n => n.props?.testID === 'swimlane-lane-section');
  assert.equal(sections.length, 1);
  // REQ-60: the expanded flat lane steps its columns in, and the rail trails each block as an overlay.
  assert.deepEqual(sections[0].children.map(n => n.props?.testID), ['lane-section-header', 'swimlane-cells', 'lane-rail']);
  // The pinned header owns the lane title row and the stage row together, as one replaceable block.
  const header = sections[0].children[0];
  assert.deepEqual(header.children.map(n => n.props?.testID), ['swimlane-lane-header', 'lane-stage-headers', 'lane-rail']);
  assert.equal(header.props.style.position, 'sticky'); assert.equal(header.props.style.top, 0);
  assert.equal(header.props.style.backgroundColor, palette(h.props.theme).surface0);
  // D23: the lane header stays above what scrolls under it but draws no full-width edge or shadow.
  assert.ok(header.props.style.zIndex > 0); assert.equal(header.props.style.shadowOpacity, 0);
  // The flat board has no project row to pin.
  assert.equal(nativeNode(root, 'swimlane-project'), undefined);
});

test('REQ-26 scrolling moves the anchored rows through an Animated value without re-rendering', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const before = text(root), calls = h.calls.length;
  const horizontal = root.root.findByProps({ testID: 'swimlane-horizontal' });
  const vertical = root.root.findByProps({ testID: 'swimlane-vertical' });
  const laneTitle = () => root.root.findAllByType('AnimatedView').find(v => v.props.testID === 'swimlane-lane-header');
  const offsetOf = node => node.props.style.transform[0].translateX;
  assert.equal(offsetOf(laneTitle()).read(), 0);
  // Called outside act() on purpose: a handler that set React state would warn and change the tree.
  for (let i = 1; i <= 30; i++) {
    horizontal.props.onScroll({ nativeEvent: { contentOffset: { x: i * 8, y: 0 } } });
    vertical.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: i * 12 } } });
  }
  assert.equal(offsetOf(laneTitle()).read(), 240, 'the lane title follows the horizontal offset');
  assert.equal(text(root), before, 'no re-render happened while scrolling');
  assert.equal(h.calls.length, calls, 'scrolling issues no RPC');
  // The stage row shares the columns' offset: it carries no counter-transform of its own.
  const stageRow = nativeNode(root, 'lane-stage-headers');
  assert.equal(stageRow.props.style.transform ?? undefined, undefined);
  assert.equal(nativeNode(root, 'swimlane-cells').props.style.transform ?? undefined, undefined);
});

test('REQ-26 ⑦ mobile keeps the stage tabs out of the scroll view and pins each workspace heading', async t => {
  for (const [platform, expected] of [['web', 'sticky'], ['android', undefined]]) {
    const h = harness({ mobile: true, platform }); h.addCard({ ...add('In flight'), stageId: 'doing' });
    const { OverviewScreen } = h.load('client/overview.tsx');
    const root = await render(t, OverviewScreen, h.props);
    const screen = nativeNode(root, 'mobile-swimlane-screen');
    assert.deepEqual(screen.children.map(n => n.props?.testID),
      ['mobile-appbar', 'mobile-control-row', 'mobile-workspace-sections']);
    const heading = nativeNode(root, 'mobile-workspace-heading');
    assert.equal(heading.props.style.position ?? undefined, expected);
    assert.equal(heading.props.style.backgroundColor, palette(h.props.theme).surface0);
    assert.equal(heading.props.style.minHeight, 16, 'the heading budget is unchanged');
    const sections = root.root.findByProps({ testID: 'mobile-workspace-sections' });
    sections.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 320 } } });
  }
});

test('REQ-22 ①②③ a card, its lane header and the detail show the most urgent linked agent, and an SDK event updates them without a refresh', async t => {
  const h = harness({ width: 1400, link: [AGENT_B, AGENT_A], agents: [
    { id: AGENT_A, status: 'idle', requiresAttention: true, attentionReason: 'finished' },
    { id: AGENT_B, status: 'running' }] });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const card = () => hosts(root, 'card-signal-icon')[0];
  assert.equal(card().props.accessibilityLabel, 'Working', 'running outranks a finished agent');
  assert.equal(hosts(root, 'lane-signal-icon').length, 0, 'REQ-44: the lane header no longer repeats the card icon');
  assert.equal(hosts(root, 'signal-ring').length, 1, 'only working draws the ring');
  // REQ-73: the lead is named by profile → model → title → id; this agent has only its title.
  // REQ-126: "· +1" is its own text beside the name, so a long name never pushes it out.
  assert.match(text(root), /"Agent 2222[^"]*"[\s\S]*"· \+1"/, 'the representative agent leads and the rest collapse into +N');
  assert.equal(labelled(root, 'Example card').props.style.minHeight, 128, 'REQ-22 ⑦ card height is unchanged (104 and, REQ-145 ③, its reply row)');
  assert.equal(nativeNode(root, 'swimlane-lane-header').props.style.minHeight, 44, 'REQ-22 ③ header height is unchanged');
  const calls = h.calls.length, listCalls = h.agents.calls.length;
  await act(async () => h.agents.upsert(AGENT_B, { status: 'error' }));
  assert.equal(card().props.accessibilityLabel, 'Error');
  await act(async () => h.agents.upsert(AGENT_B, { status: 'idle', pendingPermissions: [{ requestId: 'p1' }] }));
  assert.equal(card().props.accessibilityLabel, 'Waiting for input or permission');
  await act(async () => h.agents.remove(AGENT_B));
  assert.equal(card().props.accessibilityLabel, 'Finished · needs review', 'a removed agent drops out of the ranking');
  assert.ok(hosts(root, 'card-state-dot-success').length >= 1, 'REQ-73: finished-unseen is the sidebar\'s green dot');
  await act(async () => h.agents.remove(AGENT_A));
  assert.equal(hosts(root, 'card-signal-icon').length, 0, 'REQ-50: unknown has no actionable glyph');
  assert.equal(h.calls.length, calls, 'REQ-22 ⑦ signal events add no product RPC');
  assert.equal(h.agents.calls.length, listCalls, 'events do not re-list the directory');
  await act(async () => labelled(root, 'Example card').props.onPress());
  const rows = hosts(root, 'agent-signal');
  assert.equal(rows.length, 2, 'REQ-22 ② the detail lists every linked agent');
  assert.deepEqual(rows.map(agentStatus),
    ['Status unavailable', 'Status unavailable'], 'each row pairs an icon with the status words');
  assert.match(text(root), /Status unavailable/);
});

test('D18 the mobile real-data detail sheet (Kanban sheet, REQ-72) reads the same signal store as the tile and follows changes', async t => {
  const h = harness({ mobile: true, platform: 'web', width: 390, link: [AGENT_B, AGENT_A], agents: [
    { id: AGENT_A, status: 'idle', requiresAttention: true, attentionReason: 'finished' },
    { id: AGENT_B, status: 'running' }] });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const labels = () => hosts(root, 'agent-signal').map(agentStatus);
  const waiting = root.root.findAllByType('Pressable').find(p => p.props.accessibilityRole === 'tab' && JSON.stringify(p.findAllByType('Text').map(n => n.props.children)).includes('To Do'));
  await act(async () => waiting.props.onPress());
  assert.equal(hosts(root, 'card-signal-icon')[0].props.accessibilityLabel, 'Working');
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.equal(hosts(root, 'editor-sheet').length, 1, 'the 390px web detail is the Kanban sheet');
  assert.equal(root.root.findAllByType('Modal').length, 0);
  assert.deepEqual(labels(), ['Working', 'Finished · needs review'], 'sheet rows equal the tile store values, not the default');
  await act(async () => h.agents.upsert(AGENT_B, { status: 'error' }));
  assert.deepEqual(labels(), ['Error', 'Finished · needs review'], 'an open sheet follows store changes without a refresh');
  await act(async () => h.agents.remove(AGENT_A));
  assert.deepEqual(labels(), ['Error', 'Status unavailable']);
  assert.equal(h.agents.listeners(), 1, 'the sheet adds no subscription');
});

test('D18 the workspace panel detail sheet on a compact host also reads the panel signal store', async t => {
  const h = harness({ mobile: true, platform: 'web', width: 390, panel: true, link: [AGENT_B], agents: [{ id: AGENT_B, status: 'running' }] });
  const { WorkspacePanel } = h.load('client/panel.tsx');
  const root = await render(t, WorkspacePanel, { ...h.props, context: 'workspace', workspaceId: h.base.workspaceId });
  const waiting = root.root.findAllByType('Pressable').find(p => p.props.accessibilityRole === 'tab' && JSON.stringify(p.findAllByType('Text').map(n => n.props.children)).includes('To Do'));
  if (waiting) await act(async () => waiting.props.onPress());
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.equal(hosts(root, 'editor-sheet').length, 1, 'the panel detail is the Kanban sheet');
  const label = () => agentStatus(hosts(root, 'agent-signal')[0]);
  assert.equal(label(), 'Working');
  await act(async () => h.agents.upsert(AGENT_B, { status: 'idle' }));
  assert.equal(label(), 'Finished');
});

test('REQ-22 ④ the store buffers events during its snapshot, lets the host assign the subscription id and re-lists after a reconnect', async t => {
  const h = harness();
  const { signalStoreFor } = h.load('client/agent-signals.ts');
  const store = signalStoreFor('host_signal_store');
  const ids = [], released = []; let handler = null, gate = null, opened = 0;
  let entries = [agentSnapshot('a1', { status: 'running' }), agentSnapshot('archived', { archivedAt: '2026-01-01T00:00:00.000Z' })];
  const paseo = { agents: {
    list: async options => { ids.push(options?.subscribe?.subscriptionId ?? null); if (gate) await gate;
      // Paseo 0.9 answers a subscribed list with a handle the caller owns; 0.8 answers without one.
      const id = options?.subscribe ? 'sub' + ++opened : '';
      const subscription = id ? { subscriptionId: id, release: async () => { released.push(id); } } : undefined;
      return { entries: entries.map(agent => ({ agent, project: null })), subscriptionId: 'x',
        ...(subscription ? { subscription } : {}),
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }; },
    subscribe: fn => { handler = fn; return () => { handler = null; }; } } };
  let open; gate = new Promise(resolve => { open = resolve; });
  const detach = store.attach(paseo);
  handler({ kind: 'upsert', agent: agentSnapshot('a2', { status: 'error' }) });
  assert.equal(store.source.read('a2'), 'unknown', 'events that arrive before the snapshot are buffered, not dropped');
  gate = null; open(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.source.read('a1'), 'working');
  assert.equal(store.source.read('archived'), 'idle', 'REQ-50/51: positive archival evidence is retained');
  assert.equal(store.source.archived('archived'), true);
  assert.equal(store.source.read('a2'), 'error', 'the buffer is applied after the snapshot');
  assert.equal(store.source.ready(), true);
  entries = [agentSnapshot('a3', { status: 'idle', requiresAttention: true, attentionReason: 'finished' })];
  handler({ kind: 'upsert', agent: agentSnapshot('a1', { status: 'running' }), generation: 'g1' });
  handler({ kind: 'upsert', agent: agentSnapshot('a1', { status: 'running' }), generation: 'g2' });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.source.read('a3'), 'attention', 'a new stream generation re-lists instead of trusting deltas');
  assert.equal(store.source.read('a1'), 'unknown', 'the recovered snapshot replaces stale agents');
  // The installed daemon omits `generation`, so returning to the foreground is the live recovery path.
  entries = [agentSnapshot('a4', { status: 'running' })];
  const listed = ids.length;
  h.agents.appState('active');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.ok(ids.length > listed, 'returning to the foreground re-lists and re-arms the daemon stream');
  assert.equal(store.source.read('a4'), 'working');
  const quiet = [];
  const stop = store.source.subscribe(() => quiet.push(1));
  handler({ kind: 'upsert', agent: agentSnapshot('a4', { status: 'running' }) });
  assert.deepEqual(quiet, [], 'a repeated identical snapshot wakes no subscriber');
  stop();
  assert.deepEqual([...new Set(ids)], [null], 'Paseo 0.9 assigns the id; the plugin never sends one of its own');
  assert.deepEqual(released, ['sub1', 'sub2'], 'each re-list releases the daemon subscription it replaced');
  detach();
  assert.deepEqual(released, ['sub1', 'sub2', 'sub3'], 'the last subscription is released when the last user leaves');
  assert.equal(handler, null, 'detaching removes the local listener only');
  const source = fs.readFileSync(path.resolve('client/agent-signals.ts'), 'utf8');
  assert.ok(!/\.close\(|\.disconnect\(/.test(source), 'the borrowed host connection is never closed');
});

test('D35 a lead\'s agent is looked up ahead of the board\'s sorted ids, and held as archived (never as live) while its lookup is out', async () => {
  const h = harness();
  const { signalStoreFor, leadArchivedAgent } = h.load('client/agent-signals.ts');
  const { leadAgentIds } = h.load('client/card-groups.ts');
  const store = signalStoreFor('host_d35'), held = leadArchivedAgent(store.source), calls = [], pending = new Map();
  let open, gate = new Promise(resolve => { open = resolve; });
  const paseo = { agents: {
    // Paseo lists live agents only; an archived one is known through its one-shot lookup.
    list: async () => { await gate; return { entries: [agentSnapshot('live-lead', { status: 'idle' })].map(agent => ({ agent, project: null })),
      subscriptionId: 'x', pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }; },
    subscribe: () => () => {},
    ref: id => ({ id, refresh: () => { calls.push(id); return new Promise(resolve => pending.set(id, resolve)); } }) } };
  const detach = store.attach(paseo);
  assert.equal(held('old-lead'), false, 'before the listing nothing is known: a lead reads as before (live), so a live one never drops');
  assert.equal(held('live-lead'), false);
  open(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.source.ready(), true);
  assert.equal(held('live-lead'), false, 'a live lead is in the listing and never held');
  assert.equal(held('old-lead'), true, 'a lead the listing did not name is held as archived until its lookup answers');
  assert.equal(store.source.archived('old-lead'), false, 'REQ-51 keeps its positive-evidence rule (no orphan mark from the hold)');
  // The board asks for every id, sorted (the 142nd of 240 in the gate run); the lead's own ask moves it to the front.
  const sorted = Array.from({ length: 20 }, (_, i) => 'agent-' + String(i).padStart(2, '0')).concat('old-lead', 'gone-lead');
  store.source.request(sorted);
  const lead = [{ stages: [{ stageId: 'review', countsAsDone: false, cards: [{ id: 'c1', agentIds: ['gone-lead'], parentCardId: null },
    { id: 'c2', agentIds: ['agent-00'], parentCardId: 'c1' }] }, { stageId: 'done', countsAsDone: true, cards: [
    { id: 'c3', agentIds: ['old-lead'], parentCardId: null }, { id: 'c4', agentIds: ['agent-01'], parentCardId: 'c3' }] }] }];
  assert.deepEqual(leadAgentIds(lead), ['old-lead', 'gone-lead'], 'a completion column\'s leads first, then the others');
  store.source.request(leadAgentIds(lead), true);
  assert.deepEqual(calls.slice(0, 3), ['agent-00', 'agent-01', 'agent-02'], 'the three already out are not taken back');
  pending.get('agent-00')(null); await new Promise(resolve => setImmediate(resolve));
  pending.get('agent-01')(null); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(3, 5), ['old-lead', 'gone-lead'], 'the leads are looked up next, ahead of the 17 others');
  pending.get('old-lead')({ agent: agentSnapshot('old-lead', { archivedAt: '2026-09-22T00:00:00.000Z' }), project: null });
  pending.get('gone-lead')(null); await new Promise(resolve => setImmediate(resolve));
  assert.equal(held('old-lead'), true, 'the lookup confirms it: no change of look');
  assert.equal(store.source.archived('old-lead'), true);
  assert.equal(held('gone-lead'), false, 'a lookup that names no archived agent ends the hold');
  detach();
});

// ---- D41 (the owner's choice, 2026-09-28: a small fix, then watch): a running lead read "idle", its activity 15 hours old ----
test('D41 a lead\'s agent is read again ahead of the queue, at most once a minute; a newer answer moves its state and activity, and drift is logged', async t => {
  const h = harness();
  const { signalStoreFor } = h.load('client/agent-signals.ts');
  const store = signalStoreFor('host_d41'), calls = [], pending = new Map(), debug = t.mock.method(console, 'debug', () => {});
  let clock = Date.parse('2026-09-28T06:00:00.000Z'), handler = null;
  t.mock.method(Date, 'now', () => clock);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const paseo = { agents: {
    list: async () => ({ entries: [agentSnapshot('lead-x', { status: 'idle', lastActivityAt: '2026-09-27T13:54:00.000Z' })]
      .map(agent => ({ agent, project: null })), subscriptionId: 'x', pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }),
    subscribe: next => { handler = next; return () => {}; },
    ref: id => ({ id, refresh: () => { calls.push(id); return new Promise(resolve => pending.set(id, resolve)); } }) } };
  const answer = (id, patch) => pending.get(id)({ agent: agentSnapshot(id, patch), project: null });
  const detach = store.attach(paseo);
  store.source.recheck(['lead-x', 'demo_lead']);
  assert.deepEqual(calls, [], 'before the listing is read nothing is asked');
  await flush(); await flush();
  assert.deepEqual(calls, ['lead-x'], 'once the listing is read, the lead is read again though the listing named it; a demo id never');
  assert.equal(store.source.read('lead-x'), 'idle');
  answer('lead-x', { status: 'running', lastActivityAt: '2026-09-28T05:59:00.000Z' }); await flush();
  assert.equal(store.source.read('lead-x'), 'working', 'the answer stands in for the event that never came');
  assert.equal(store.source.activity('lead-x'), '2026-09-28T05:59:00.000Z');
  assert.equal(debug.mock.callCount(), 1);
  assert.equal(debug.mock.calls[0].arguments[0],
    '[kanban] lead signal drift lead-x idle→working activity 2026-09-27T13:54:00.000Z→2026-09-28T05:59:00.000Z');
  store.source.recheck(['lead-x']); clock += 30_000; store.source.recheck(['lead-x']);
  assert.deepEqual(calls, ['lead-x'], 'not again within the minute, however many cards ask');
  // D35's front of the queue: three lookups are out, two wait; the lead goes ahead of them.
  store.source.request(['a1', 'a2', 'a3', 'a4', 'a5']);
  clock += 30_000; store.source.recheck(['lead-x']);
  pending.get('a1')(null); await flush();
  assert.deepEqual(calls, ['lead-x', 'a1', 'a2', 'a3', 'lead-x'], 'ahead of a4 and a5');
  // A live event while it is out is newer than its answer: the state stays the event's, an earlier activity never wins.
  handler({ kind: 'upsert', agent: agentSnapshot('lead-x', { status: 'idle', lastActivityAt: '2026-09-28T06:00:30.000Z' }) });
  answer('lead-x', { status: 'running', lastActivityAt: '2026-09-28T06:00:10.000Z' }); await flush();
  assert.equal(store.source.read('lead-x'), 'idle');
  assert.equal(store.source.activity('lead-x'), '2026-09-28T06:00:30.000Z');
  // Without one, an answer the same as the store's (an earlier activity too) changes nothing and logs nothing.
  clock += 60_000; store.source.recheck(['lead-x']);
  for (const id of ['a2', 'a3', 'a4']) pending.get(id)?.(null);
  await flush();
  assert.equal(calls.filter(id => id === 'lead-x').length, 3, 'a minute on, once more');
  answer('lead-x', { status: 'idle', lastActivityAt: '2026-09-28T06:00:20.000Z' }); await flush();
  assert.equal(store.source.read('lead-x'), 'idle');
  assert.equal(store.source.activity('lead-x'), '2026-09-28T06:00:30.000Z', 'never moved back');
  assert.equal(debug.mock.callCount(), 1, 'nothing more to log');
  detach();
});
test('D41 a lead card reads its own agent once when it shows, then once a minute while someone looks; none when no one looks or it is gone', async t => {
  const debug = t.mock.method(console, 'debug', () => {});
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-09-28T06:00:00.000Z') });
  // The listing says the lead's agent is idle (a stale snapshot); asked on its own, it is running.
  const h = subCardHarness({ agents: [{ id: AGENT_A, status: 'idle' }], lookups: { [AGENT_A]: 'running' } });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const { noteActivity } = h.load('client/auto-refresh.ts');
  await wait();
  const reads = () => h.agents.refs.filter(id => id === AGENT_A).length;
  assert.ok(h.agents.refs.indexOf(AGENT_A) <= 3, 'at the front of the queue: next after the three lookups already out (the order: the test above)');
  assert.equal(reads(), 1, 'once when it shows');
  assert.match(textOf(hosts(root, 'lead-status')[0]), /^Lead working · <1m$/, 'the status row follows the answer, not the stale listing (REQ-130: timed from that change)');
  assert.match(debug.mock.calls[0]?.arguments[0] ?? '', new RegExp('^\\[kanban\\] lead signal drift ' + AGENT_A + ' idle→working '));
  const minute = async (n = 1) => { for (let i = 0; i < n; i++) { await act(async () => t.mock.timers.tick(60_000)); await wait(); } };
  await act(async () => t.mock.timers.tick(30_000)); await wait();
  assert.equal(reads(), 1, 'not before the minute');
  await act(async () => t.mock.timers.tick(30_000)); await wait();
  assert.equal(reads(), 2, 'a minute later');
  await minute();
  assert.equal(reads(), 3, 'two minutes without a touch: still looked at');
  await minute(2);
  assert.equal(reads(), 3, 'from three minutes without a touch, auto refresh\'s rule: no more reads');
  noteActivity(); await minute();
  assert.equal(reads(), 4, 'a touch brings the minute back');
  assert.equal(debug.mock.callCount(), 1, 'the same answer again logs nothing');
  await act(async () => root.update(React.createElement('View')));
  await minute(2);
  assert.equal(reads(), 4, 'no lead card on screen: no read');
});
test('REQ-22 ④ a failed agent subscription shows "unavailable"; REQ-83: and says, apart from the ledger\'s errors, that agent states could not be read', async t => {
  const h = harness({ width: 1400, link: [AGENT_A], agentsFail: true });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.equal(hosts(root, 'card-signal-icon').length, 0, 'REQ-50: unavailable has no glyph');
  assert.doesNotMatch(text(root), /Some data could not be read/, 'not the ledger\'s partial-read line');
  // REQ-83 (research/124 §5): a failed subscription used to be silent. Now one quiet line names the feature and the
  // reason, and blames no version: the connection is named too.
  assert.equal(hosts(root, 'tracking-signals-error').length, 1);
  assert.match(allText(hosts(root, 'tracking-signals-error')[0]),
    /^Paseo information could not be read\. Automatic tracking may have stopped\. \(Agent states: Synthetic agent directory failure\) · check the connection and the Paseo version/);
  assert.equal(hosts(root, 'directory-error').length, 0, 'the workspace listing is fine and says nothing');
});

test('REQ-22 ⑤ demo data shows every bucket and never receives a real SDK event', async t => {
  const h = harness({ width: 1400, link: [AGENT_A], agents: [{ id: AGENT_A, status: 'running' }] });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.equal(h.agents.listeners(), 1);
  await toggleDemo(root);
  assert.equal(h.agents.listeners(), 0, 'the demo screen does not subscribe at all');
  const labels = new Set(hosts(root, 'card-signal-icon').map(node => node.props.accessibilityLabel));
  // REQ-73: line one draws the sidebar's marks (finished included); the orphaned warning moved to line two.
  assert.deepEqual([...labels].sort(), ['Error', 'Finished', 'Finished · needs review',
    'Waiting for input or permission', 'Working'], 'every signal is visible in the demo');
  assert.ok(hosts(root, 'card-orphaned-mark').some(node => node.props.accessibilityLabel === 'Agent archived · confirm it is done'));
  assert.match(text(root), /\+2/, 'a demo card shows "+N"');
  const before = text(root);
  await act(async () => h.agents.upsert('demo_agent_working', { status: 'error' }));
  assert.equal(text(root), before, 'a real event cannot land on a demo card');
  const demoCard = root.root.findAllByType('Pressable').find(p => p.props.testID?.startsWith('kanban-card-demo_'));
  await act(async () => demoCard.props.onPress());
  assert.ok(hosts(root, 'agent-signal').length >= 1, 'the demo detail pairs icons with status words');
});

test('REQ-22 ⑥⑦ one changed signal re-renders only its own subscriber, and only working animates', async t => {
  const h = harness({ width: 1400, link: [AGENT_B], agents: [{ id: AGENT_B, status: 'running' }] });
  const { useSignalSummary, signalStoreFor } = h.load('client/agent-signals.ts');
  const { ringClockRunning } = h.load('client/status-icon.tsx');
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.equal(h.agents.motion.started, 1, 'one shared loop drives every ring');
  assert.equal(h.agents.motion.config.duration, 900); assert.equal(h.agents.motion.config.easing, 'linear');
  assert.equal(h.agents.motion.config.useNativeDriver, false, 'web uses the JS driver; native uses the native one');
  assert.equal(ringClockRunning(), true);
  await act(async () => h.agents.appState('background'));
  assert.equal(ringClockRunning(), false, 'the loop stops while the app is not active');
  assert.ok(h.agents.motion.stopped >= 1);
  await act(async () => h.agents.appState('active'));
  await act(async () => h.agents.upsert(AGENT_B, { status: 'idle' }));
  assert.equal(hosts(root, 'signal-ring').length, 0, 'a finished agent is static');
  assert.equal(ringClockRunning(), false, 'no ring is mounted, so nothing animates');

  const store = signalStoreFor('host_scope'); let handler = null;
  const paseo = { agents: {
    list: async () => ({ entries: [agentSnapshot('s1', { status: 'running' }), agentSnapshot('s2')].map(agent => ({ agent, project: null })),
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }),
    subscribe: fn => { handler = fn; return () => { handler = null; }; } } };
  const detach = store.attach(paseo); afterOnce(t, () => detach());
  await new Promise(resolve => setImmediate(resolve));
  const renders = { s1: 0, s2: 0 };
  function Probe({ id }) { renders[id]++; return React.createElement('Text', null, useSignalSummary(store.source, [id]).bucket); }
  const probes = await render(t, () => React.createElement('View', null,
    React.createElement(Probe, { id: 's1' }), React.createElement(Probe, { id: 's2' })), {});
  assert.deepEqual(renders, { s1: 1, s2: 1 });
  await act(async () => handler({ kind: 'upsert', agent: agentSnapshot('s1', { status: 'error' }) }));
  assert.deepEqual(renders, { s1: 2, s2: 1 }, 'only the card whose own signal changed re-renders');
  await act(async () => handler({ kind: 'upsert', agent: agentSnapshot('s2') }));
  assert.deepEqual(renders, { s1: 2, s2: 1 }, 'an unchanged bucket re-renders nothing');
  assert.match(text(probes), /error/);
});

test('REQ-39 the search field sits at the right end of the filter row and a wrapped line starts at the left', async t => {
  for (const [options, width] of [[{ width: 1400 }, 260], [{ mobile: true, platform: 'web' }, '100%']]) {
    const h = harness(options), { OverviewScreen } = h.load('client/overview.tsx');
    const root = await render(t, OverviewScreen, h.props);
    if (options.mobile) {
      await act(async () => sheetButton(root, 'open-filters').props.onPress());
    }
    const row = nativeNode(root, 'swimlane-filters');
    // REQ-75 A2: the grouping switch opens the sheet as its own row (390px), with REQ-79's card order under it.
    // REQ-81: the wide screen has both on its title row, so nothing but the search is in board-tools there.
    // REQ-85 ⑦: on 390px "fold all · expand all" sits right under the grouping switch.
    const layout = options.mobile ? ['group-toggle-row', 'fold-all-row', 'sort-choice-row', 'filter-controls', 'board-tools'] : ['filter-controls', 'board-tools'];
    assert.deepEqual(row.children.map(n => n.props?.testID), layout,
      'the project, label and attention controls stay left; the search is last');
    const tools = nativeNode(root, 'board-tools');
    assert.equal(tools.children.at(-1).props.testID, 'board-search-field');
    if (!options.mobile) assert.equal(jsonNodes(tools, 'group-toggle').length, 0, 'REQ-81: the glyph left the search for the view switch');
    const controls = root.root.findByProps({ testID: 'filter-controls' }).props.style;
    assert.equal(controls.flexGrow, 1, 'the control group absorbs the leftover width, which pushes the search right');
    assert.equal(controls.flexWrap, 'wrap');
    assert.equal(row.props.style.flexWrap, 'wrap');
    assert.equal(row.props.style.justifyContent ?? undefined, undefined);
    const field = root.root.findByProps({ testID: 'board-search-field' }).props.style;
    assert.equal(field.width, width); assert.equal(field.maxWidth, '100%');
    assert.equal(field.flex ?? undefined, undefined, 'the field must not grow to fill the filter row');
    assert.equal(field.marginLeft ?? undefined, undefined,
      'no auto margin: a wrapped second line has to start at the left, not stay pinned right');
    assert.equal(input(root, 'Search cards').props.style.height, options.mobile ? 44 : 30);
    // An active filter keeps its count and reset in the left group, so nothing ever sits right of the search.
    await act(async () => input(root, 'Search cards').props.onChangeText('card'));
    // REQ-114: on a wide screen the count is the filter glyph's badge, in the same left group.
    assert.ok(jsonNodes(nativeNode(root, 'filter-controls'), options.mobile ? 'active-filter-count' : 'filter-menu').length === 1);
    assert.deepEqual(nativeNode(root, 'swimlane-filters').children.map(n => n.props?.testID), layout);
  }
});

test('REQ-41 an unlisted linked agent is looked up once: archived reads as finished, a refusal stays unavailable', async t => {
  const h = harness({ width: 1400, link: [AGENT_A, AGENT_B], agents: [],
    lookups: { [AGENT_A]: 'archived', [AGENT_B]: 'error' } });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const calls = h.calls.length, listCalls = h.agents.calls.length;
  await act(async () => {});
  const card = () => hosts(root, 'card-signal-icon')[0];
  assert.deepEqual([...h.agents.refs].sort(), [AGENT_A, AGENT_B].sort(), 'each id the directory never listed is asked once');
  // REQ-73: the archived agent is finished, drawn as the sidebar's faint dot; one unknown id means no proven orphan.
  assert.deepEqual(hosts(root, 'card-signal-icon').map(node => node.props.accessibilityLabel), ['Finished']);
  assert.equal(hosts(root, 'card-orphaned-mark').length, 0, 'archived + unknown is not a proven orphan');
  assert.equal(h.calls.length, calls, 'the lookup adds no product RPC');
  assert.equal(h.agents.calls.length, listCalls, 'and no extra directory listing');
  await act(async () => labelled(root, 'Example card').props.onPress());
  const rows = hosts(root, 'agent-signal').map(agentStatus);
  assert.deepEqual([...rows].sort(), ['Finished', 'Status unavailable'], 'a refused lookup stays unavailable');
  await act(async () => button(root, 'Close').props.onPress());
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running' }));
  assert.equal(card().props.accessibilityLabel, 'Working', 'a live event outranks the remembered answer');
  await act(async () => h.agents.remove(AGENT_A));
  assert.equal(hosts(root, 'card-signal-icon').length, 0, 'REQ-50: removed agents stay quiet');
  assert.equal(h.agents.refs.length, 2, 'nothing is looked up twice in a session');
});

test('REQ-41 at most three lookups run at once and the demo never asks about its demo_ agents', async t => {
  const h = harness({ width: 1400, link: UNLISTED, agents: [], holdLookups: true,
    lookups: Object.fromEntries(UNLISTED.map(id => [id, 'archived'])) });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await act(async () => {});
  assert.equal(h.agents.waiting().length, 3, 'three in flight, the rest queued');
  assert.equal(h.agents.refs.length, 3);
  await act(async () => { h.agents.settle(); });
  assert.equal(h.agents.refs.length, 5, 'the queue drains as each answer arrives');
  await act(async () => { h.agents.settle(); });
  assert.equal(hosts(root, 'card-orphaned-mark')[0].props.accessibilityLabel, 'Agent archived · confirm it is done');
  assert.equal(new Set(h.agents.refs).size, 5, 'never the same id twice');
  const before = h.agents.refs.length;
  await toggleDemo(root);
  await act(async () => {});
  assert.ok(text(root).includes('Aurora Workshop'), 'the demo board is showing');
  assert.equal(h.agents.refs.length, before, 'demo_ agents are client fiction; the daemon is never asked');
  assert.ok(h.agents.refs.every(id => !id.startsWith('demo_')));
});

test('REQ-42 two pinned levels: the project header owns its section, lane headers pin under it with the task name alone', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await toggleDemo(root);
  // REQ-75 A1: flat, every lane is its own top-level section and pins at the top.
  const flat = nativeNode(root, 'swimlane-vertical').children.filter(n => n.props?.testID === 'swimlane-lane-section');
  assert.equal(flat.length, 13);
  assert.ok(flat.every(n => n.children[0].props.style.top === 0));
  await act(async () => sheetButton(root, 'group-toggle').props.onPress());
  const vertical = nativeNode(root, 'swimlane-vertical');
  const sections = vertical.children.filter(n => n.props?.testID === 'swimlane-project-section');
  assert.equal(sections.length, 6, 'the demo has six projects and each is its own sticky container');
  const multi = sections.filter(n => jsonNodes(n, 'swimlane-project').length === 1);
  assert.equal(multi.length, 6, 'REQ-75 A2: a one-workspace project gets a project header too — no merged row');
  for (const section of multi) {
    const header = section.children[0];
    assert.equal(header.props.testID, 'swimlane-project', 'the project header opens its own section');
    assert.equal(header.props.style.position, 'sticky');
    assert.equal(header.props.style.top, 0);
    assert.equal(header.props.style.zIndex, STICKY.projectZIndex);
    const lanes = section.children.filter(n => n.props?.testID === 'swimlane-lane-section');
    assert.ok(lanes.length >= 1);
    for (const lane of lanes) {
      const pinned = lane.children[0];
      assert.equal(pinned.props.testID, 'lane-section-header');
      assert.equal(pinned.props.style.position, 'sticky');
      assert.equal(pinned.props.style.top, projectHeaderHeight(), 'a lane pins directly under its project header');
      assert.ok(pinned.props.style.zIndex < header.props.style.zIndex, 'so the project header paints over it');
    }
  }
  // Acceptance ④: a pinned lane header carries the workspace name only — pinned or not, it looks the same.
  const laneHeaders = root.root.findAllByType('AnimatedView').filter(v => v.props.testID === 'swimlane-lane-header');
  assert.equal(laneHeaders.length, 13);
  for (const header of laneHeaders) {
    // REQ-65 nests the muted detail as its own Text, so only the strings are read (every Text is visited anyway).
    const words = JSON.stringify(header.findAllByType('Text').map(n => [n.props.children].flat().filter(v => typeof v !== 'object')));
    assert.ok(!words.includes('Aurora Workshop'), 'no project name in a lane header');
    assert.ok(!words.includes('Harbor Atelier'));
  }
  assert.match(text(root), /Aurora Workshop/, 'the project name still appears in the project header');
  assert.equal(nativeNode(root, 'project-group-header').props.style.minHeight, 44, 'project header height unchanged');
  assert.equal(nativeNode(root, 'swimlane-lane-header').props.style.minHeight, 44, 'lane header height unchanged');
});

test('REQ-43 the show-all toggle reserves one width, so the figures beside it hold their place', async t => {
  const h = harness({ width: 1400 });
  for (let i = 0; i < 5; i++) h.addCard({ ...add('Queued ' + i) });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const toggle = () => root.root.findAllByType('Pressable').find(p => p.props.testID === 'lane-toggle');
  // REQ-67 ①: the text button became one glyph; its words live in the accessible name (and the hover tooltip).
  const label = () => String(toggle().props.accessibilityLabel);
  const glyph = () => toggle().findByType('Icon').props.name;
  const row = () => nativeNode(root, 'swimlane-lane-header').children.map(n => n.props?.testID ?? n.type);
  assert.match(label(), /^Show 5 more in each column \(/); assert.equal(glyph(), 'ChevronsUpDown');
  assert.equal(toggle().props.style.width, 30, 'a fixed 30px box replaces the reserved text width');
  const before = { ...toggle().props.style }, order = row();
  await act(async () => toggle().props.onPress());
  assert.equal(label(), 'Collapse', 'the label flipped to the short state'); assert.equal(glyph(), 'ChevronsDownUp');
  assert.deepEqual({ ...toggle().props.style }, before, 'both states reserve exactly the same box');
  assert.deepEqual(row(), order, 'and the row keeps the same sequence, so the progress and attention x never move');
  await act(async () => toggle().props.onPress());
  assert.match(label(), /^Show 5 more in each column \(/); assert.deepEqual(row(), order);
});

test('REQ-44 a folded lane keeps only the urgent tally, and pressing a card signal names the status without hover', async t => {
  const h = harness({ width: 1400, link: [AGENT_A, AGENT_B], agents: [
    { id: AGENT_A, status: 'error' }, { id: AGENT_B, status: 'idle', pendingPermissions: [{ requestId: 'p1' }] }] });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.equal(hosts(root, 'lane-signal-icon').length, 0, 'the representative icon is gone from the header');
  assert.equal(hosts(root, 'lane-urgent-badge').length, 0, 'an open lane says nothing: its own cards already show it');
  await act(async () => labelled(root, 'Collapse workspace: Example Workspace').props.onPress());
  assert.equal(hosts(root, 'card-signal-icon').length, 0, 'the cards are hidden while the lane is folded');
  const badge = hosts(root, 'lane-urgent-badge')[0];
  assert.equal(badge.props.accessibilityLabel, 'Error 1 · Waiting 1');
  assert.equal(nativeNode(root, 'swimlane-lane-header').props.style.minHeight, 44, 'the badge does not grow the header');
  await act(async () => labelled(root, 'Expand workspace: Example Workspace').props.onPress());
  assert.equal(hosts(root, 'lane-urgent-badge').length, 0);
  const press = () => root.root.findAllByType('Pressable').find(p => p.props.testID === 'card-signal-press');
  const bubble = () => hosts(root, 'card-signal-tooltip')[0];
  assert.equal(hosts(root, 'card-signal-tooltip').length, 0);
  await act(async () => press().props.onPress({}));
  // REQ-73: the bubble also names the agent and its provider, since line two may cut the name short.
  assert.match(bubble().findAllByType('Text')[0].props.children, / · Error$/, 'the bubble names the glyph');
  assert.equal(press().props.accessibilityState.expanded, true);
  assert.equal(hosts(root, 'card-signal-icon')[0].props.accessibilityLabel, 'Error', 'the icon keeps its accessible name');
  // The wide detail is the public RN modal, which this harness renders as NativeModal.
  const detail = () => root.root.findAllByType('NativeModal').length;
  await act(async () => root.root.findAllByType('Pressable').find(p => p.props.testID === 'card-signal-dismiss').props.onPress({}));
  assert.equal(hosts(root, 'card-signal-tooltip').length, 0, 'a press outside the bubble closes it');
  assert.equal(detail(), 0, 'and never opens the card behind it');
  await act(async () => press().props.onLongPress({}));
  assert.equal(hosts(root, 'card-signal-tooltip').length, 1, 'a long press shows the same bubble');
  await act(async () => { press().props.onPress({}); labelled(root, 'Example card').props.onPress(); });
  assert.equal(detail(), 0, 'a press that bubbles up to the card is swallowed');
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.equal(detail(), 1, 'the very next card press opens the detail as usual');
  // REQ-67 ①②⑤ added hover hints (the toggle glyph's tooltip, the faint links brightening); each also carries
  // its words as the accessible name, so the rule this guards is narrowed to what REQ-44 is about: the card signal.
  // REQ-68 adds the same kind of hint to the view switch and ⚙ (tooltips of glyphs that carry their label).
  assert.equal(root.root.findAllByType('Pressable').filter(p => (p.props.onHoverIn || p.props.onMouseEnter) &&
    !['lane-toggle', 'cell-more', 'view-swimlane', 'view-list', 'open-settings', 'workspace-name-link', 'group-toggle', 'sort-menu', 'fold-all',
      // REQ-85 ⑥: the state mark's hover hint repeats what its press (the bubble above) and its icon's accessible name say.
      'card-signal-press',
      // REQ-124: the lane's "Board | Workflow" takes the view switch's hover fill; its words always show.
      'lane-view-board', 'lane-view-workflow',
      // REQ-125: "Try a workflow" in the same place takes the same hover fill; its words always show.
      'lane-workflow-try',
      // REQ-88 ②③④: the detail's title (pencil), stage flow and choices take a hover look; each says its words to a screen reader.
      'detail-title'].includes(p.props.testID) && !/^(stage-bar-|priority-choice-|awaiting-choice-)/.test(String(p.props.testID)) &&
    // REQ-80: every glyph button takes a hover fill; its words are its accessible name, so nothing is hover-only there.
    !(p.props.testID !== 'card-signal-press' && p.props.accessibilityLabel && p.children.some(child => child?.type === 'Icon')) &&
    // REQ-82 ②③: a wide card shows its "Done" and ⋯ on hover; the keyboard's focus shows them too, and a phone always has them.
    !String(p.props.testID).startsWith('kanban-card-')).length, 0,
    'nothing but the REQ-67/68/75/82 hints depends on hover');
});

test('REQ-45/60 lane rows step in one indent behind a quiet small arrow while projects keep the filled square arrow', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await toggleDemo(root); await groupByProject(root);
  assert.equal(nativeNode(root, 'lane-section-header').props.style.paddingLeft, SWIMLANE.laneIndent,
    'the pinned band keeps a full-width background and indents the rows inside it');
  assert.equal(nativeNode(root, 'swimlane-cells').props.style.marginLeft, SWIMLANE.laneIndent,
    'the columns line up with the indented stage headers above them');
  assert.equal(nativeNode(root, 'swimlane-project').props.style.paddingLeft ?? undefined, undefined,
    'the project row itself is not indented');
  assert.equal(root.root.findByProps({ testID: 'swimlane-vertical' }).props.style.width, swimlaneWidth(),
    'the scroll content grows by the indent so the last column stays reachable');
  const laneArrow = root.root.findAllByType('Pressable').find(p => p.props.testID === 'lane-disclosure');
  assert.equal(laneArrow.props.style.backgroundColor, 'transparent');
  assert.equal(laneArrow.props.style.width, 30, 'the touch target is unchanged');
  assert.equal(laneArrow.findAllByType('Icon')[0].props.size, 14);
  const projectArrow = root.root.findAllByType('Pressable').find(p => p.props.accessibilityLabel?.startsWith('Collapse project:'));
  assert.equal(projectArrow.props.style.backgroundColor, palette(h.props.theme).surface2);
  assert.equal(projectArrow.findAllByType('Icon')[0].props.size, 17);
});

test('REQ-42 ⑧ the 390px board pins the project heading with the workspace heading under it', async t => {
  const h = harness({ mobile: true, platform: 'web', width: 390 });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await toggleDemo(root);
  // REQ-75 A1: flat, every workspace heading is the top level and pins at 0, with no project group.
  assert.equal(jsonNodes(root.toJSON(), 'mobile-project-group').length, 0);
  assert.ok(jsonNodes(root.toJSON(), 'mobile-workspace-heading').every(n => n.props.style.top === 0 && n.props.style.marginLeft === -SWIMLANE.mobileLaneIndent));
  await groupByProject(root, true);
  const groups = jsonNodes(root.toJSON(), 'mobile-project-group');
  assert.ok(groups.length >= 2);
  let multi = 0, single = 0;
  for (const group of groups) {
    const project = jsonNodes(group, 'mobile-project-heading')[0];
    const headings = jsonNodes(group, 'mobile-workspace-heading');
    assert.ok(headings.length >= 1);
    if (project) {
      multi++;
      assert.equal(project.props.style.position, 'sticky');
      assert.equal(project.props.style.top, 0);
      assert.equal(project.props.style.zIndex, STICKY.projectZIndex);
      for (const heading of headings) assert.equal(heading.props.style.top, projectHeaderHeight());
    } else {
      single++;
      for (const heading of headings) assert.equal(heading.props.style.top, 0);
    }
    for (const heading of headings) {
      assert.equal(heading.props.style.position, 'sticky');
      assert.equal(heading.props.style.minHeight, 16, 'the heading budget is unchanged');
    }
  }
  assert.ok(multi >= 2 && single === 0, 'REQ-75 A2: every project has its heading, a one-workspace project too');
  assert.equal(hosts(root, 'lane-signal-icon').length, 0, 'REQ-44 applies on 390px too');
});

test('REQ-57 a card-less workspace is a folded lane that says so, opens into four empty columns and offers its first card', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'] });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const headers = root.root.findAllByType('AnimatedView').filter(v => v.props.testID === 'swimlane-lane-header');
  assert.equal(headers.length, 2, 'both the ledger workspace and the board-less one are listed');
  // ⑤ the lane that holds cards leads; the card-less one sits under it.
  assert.deepEqual(headers.map(v => v.findByProps({ testID: 'workspace-name-link' }).props.accessibilityLabel),
    ['Open board: Example Workspace · Example Project · example-workspace', 'Open board: Empty Workspace 0 · Example Project · wks_empty01'],
    'REQ-75 A1: a flat lane names its project, and its folder for a screen reader (REQ-65 ⑥)');
  const lane = headers[1];
  assert.equal(lane.findByProps({ testID: 'lane-empty' }).props.children, 'No cards');
  assert.equal(headers[0].findAllByProps({ testID: 'lane-empty' }).length, 0);
  // ② nothing pretends to be a percentage — REQ-103 ③: the words say the cards counted, "Cards 0/0", and never a percent.
  const progress = lane.findByProps({ testID: 'lane-progress' });
  assert.equal(progress.props.accessibilityValue.now, 0);
  assert.equal(progress.findByProps({ testID: 'lane-progress-fill' }).props.style.width, 0);
  assert.equal(allText(progress.findAllByType('Text').at(-1)), 'Cards 0/0');
  assert.doesNotMatch(JSON.stringify(progress.findAllByType('Text').map(n => n.props.children)), /%/);
  // It starts folded: no columns, no + until it is opened.
  const section = laneSections(root).at(-1);
  assert.equal(jsonNodes(section, 'swimlane-cells').length, 0);
  assert.equal(lane.findAllByProps({ testID: 'lane-create' }).length, 0);
  const disclosure = lane.findAllByProps({ testID: 'lane-disclosure' }).find(n => n.props.accessibilityLabel);
  assert.equal(disclosure.props.accessibilityLabel, 'Expand workspace: Empty Workspace 0');
  await act(async () => disclosure.props.onPress());
  const opened = root.root.findAllByType('AnimatedView').filter(v => v.props.testID === 'swimlane-lane-header')[1];
  const cells = laneSections(root).at(-1);
  const panels = jsonNodes(cells, 'swimlane-cells')[0].children;
  assert.equal(panels.length, 4, 'four empty stage columns');
  assert.ok(panels.every(p => !p.children || p.children.length <= 1));
  const plus = opened.findAllByProps({ testID: 'lane-create' }).find(n => n.props.accessibilityLabel);
  assert.equal(plus.props.accessibilityLabel, 'Add the first card: Empty Workspace 0');
  // ③ the + writes through board.ensure, which creates the board and the card in one request.
  await act(async () => plus.props.onPress());
  const choice = boardChoice(root, 'Empty Workspace 0');
  assert.equal(choice.props.accessibilityState.selected, true, 'the lane that was pressed is preselected');
  assert.match(String(choice.findAllByType('Text')[0].props.children), /No cards$/);
  await act(async () => input(root, 'Title').props.onChangeText('First idea'));
  await act(async () => button(root, 'Save draft').props.onPress());
  assert.equal(h.ensure.calls.length, 1);
  assert.equal(h.ensure.calls[0].workspaceId, 'wks_empty01');
  assert.deepEqual(h.ensure.calls[0].operations.map(o => [o.op, o.title]), [['add', 'First idea']]);
  assert.ok(!h.calls.some(c => c.name === 'kanban.v1.board.mutate' && String(c.input.boardId).startsWith('empty:')),
    'a synthesized board id is never sent to a mutation');
  assert.deepEqual(h.ensure.pending, [], 'the workspace now has a real board');
});
test('REQ-57 an initialization that fails reports it and adds no card', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'] });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await act(async () => labelled(root, 'Create draft').props.onPress());
  const choice = boardChoice(root, 'Empty Workspace 0');
  await act(async () => choice.props.onPress());
  await act(async () => input(root, 'Title').props.onChangeText('Will not land'));
  h.outcome('ensureFailed');
  await act(async () => button(root, 'Save draft').props.onPress());
  assert.match(text(root), /Could not save|Workspace directory does not exist/);
  assert.deepEqual(h.ensure.pending, ['wks_empty01'], 'the workspace still has no board');
  assert.equal(input(root, 'Title').props.value, 'Will not land', 'and the draft is preserved');
  // Saving again once the cause is gone creates the board and the card.
  await act(async () => button(root, 'Save draft').props.onPress());
  assert.deepEqual(h.ensure.pending, []);
  assert.equal(h.ensure.calls.length, 2);
  assert.equal(new Set(h.ensure.calls.map(c => c.requestId)).size, 2, 'a refused write is retried under a new id');
});
test('REQ-57 the mobile screen and the workspace panel show the same card-less workspace', async t => {
  const h = harness({ mobile: true, empty: ['wks_empty01'] });
  h.addCard({ ...add('Doing'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const headings = root.root.findAllByType('View').filter(v => v.props.testID === 'mobile-workspace-heading');
  assert.equal(headings.length, 2);
  assert.equal(headings[1].findByProps({ testID: 'lane-empty' }).props.children, 'No cards');
  assert.equal(headings[0].findAllByProps({ testID: 'lane-empty' }).length, 0);
  assert.ok(button(root, 'Add the first card'), 'the first card is reachable on 390px too');
  // REQ-67 F1 (390 gate) dropped the old "Open workspace board" button; REQ-75 B1·B2 dropped "Board ›" too —
  // the workspace name on every heading is the way into its board.
  h.addCard({ ...add('Finished'), stageId: 'done' });
  const done = await render(t, OverviewScreen, h.props);
  await act(async () => done.root.findByProps({ testID: 'mobile-tab-done' }).props.onPress());
  assert.equal(shownText(done).includes('Open workspace board'), false);
  assert.equal(hosts(done, 'done-board-link').length, 0);
  assert.deepEqual(hosts(done, 'workspace-name-link').map(n => n.props.accessibilityRole), ['link', 'link']);
  // The panel for a workspace with no ledger shows the empty board rather than an error.
  const p = harness({ panel: true, empty: ['wks_empty01'] });
  const { WorkspacePanel } = p.load('client/panel.tsx');
  const panel = await render(t, WorkspacePanel, { ...p.props, workspaceId: 'wks_empty01' });
  assert.ok(!text(panel).includes('No board is registered'), 'a workspace without a board is not an error');
  assert.deepEqual(['todo', 'doing', 'review', 'done'].map(id => nativeNode(panel, 'mobile-tab-' + id).props.accessibilityLabel),
    ['To Do 0', 'In progress 0', 'Review 0', 'Done 0']);
  assert.equal(nativeNode(panel, 'board-cell-todo').children[0].children, null, 'four empty stages, no card');
  await act(async () => labelled(panel, 'More').props.onPress());
  const create = button(panel, 'Create draft');
  assert.equal(create.props.disabled, false, 'and its first card is reachable from the panel menu');
  await act(async () => create.props.onPress());
  assert.ok(boardChoice(panel, 'Empty Workspace 0'));
});

test('R2-B orphaned cards join attention once, survive filtering/folding, and update on archive-only events without RPC', async t => {
  const h=harness({width:1400,link:[AGENT_A],agents:[{id:AGENT_A,status:'idle'}]});
  h.external({awaiting:null});
  const {OverviewScreen}=h.load('client/overview.tsx'); const root=await render(t,OverviewScreen,h.props);
  assert.equal(nativeNode(root,'attention-count').children[0],'0');
  assert.deepEqual(hosts(root,'card-signal-icon').map(n=>n.props.accessibilityLabel),['Finished'],'REQ-73: the sidebar\'s finished dot');
  const calls=h.calls.length;
  await act(async()=>h.agents.upsert(AGENT_A,{status:'idle',archivedAt:'2026-09-22'}));
  assert.equal(hosts(root,'card-orphaned-mark')[0].props.accessibilityLabel,'Agent archived · confirm it is done');
  assert.equal(nativeNode(root,'attention-count').children[0],'1');
  await act(async()=>hosts(root,'card-signal-press')[0].props.onPress({stopPropagation(){}}));
  assert.match(JSON.stringify(nativeNode(root,'card-signal-tooltip')),/Agent archived · confirm it is done/);
  await act(async()=>hosts(root,'attention-chip')[0].props.onPress());
  assert.ok(labelled(root,'Example card'),'orphan with no stored human reason survives attention filter');
  const disclosure=root.root.findAllByProps({testID:'lane-disclosure'}).find(n=>n.props.onPress);
  await act(async()=>disclosure.props.onPress());
  assert.match(text(root),/Confirm done 1/,'folded badge counts lost cards (REQ-82: in the words of what they wait for)');
  assert.equal(h.calls.length,calls,'archive and filter changes add no product RPC');
  await act(async()=>h.agents.upsert(AGENT_A,{status:'idle',archivedAt:null}));
  assert.equal(nativeNode(root,'attention-count').children[0],'0');
  assert.equal(hosts(root,'lane-urgent-badge').length,0);
});
test('R2-B/REQ-74 ④ detail rows name the agent as the card does (sidebar mark, provider mark, short model), with model-only live updates', async t => {
  for(const platform of ['web','android']) {
    const h=harness({width:platform==='web'?1400:390,mobile:platform!=='web',platform,link:[AGENT_A],
      agents:[{id:AGENT_A,status:'running',provider:'claude',model:'claude-opus-5',thinkingOptionId:'high'}]});
    const {OverviewScreen}=h.load('client/overview.tsx'); const root=await render(t,OverviewScreen,h.props);
    if(platform!=='web') await act(async()=>labelled(root,'To Do 1').props.onPress());
    // REQ-73 supersedes REQ-53 here: with no profile label the tile names the model. REQ-126: with its version and thinking level.
    assert.match(JSON.stringify(nativeNode(root,'card-agent')),/"Opus-5-High"/,'tile names the model');
    assert.doesNotMatch(JSON.stringify(nativeNode(root,'card-agent')),/\(high\)/,'tile stays compact');
    await act(async()=>labelled(root,'Example card').props.onPress());
    // REQ-74 ④ supersedes REQ-53 here: the card's name (no thinking option), then the link label and the state.
    assert.match(textOf(nativeNode(root,'agent-signal')),/^Opus-5-High · Agent 1111 · Working/);
    assert.match(JSON.stringify(nativeNode(root,'agent-signal')),/signal-ring[\s\S]*provider-claude/,'the sidebar ring, then the provider mark');
    const before=h.calls.length;
    await act(async()=>h.agents.upsert(AGENT_A,{status:'running',provider:'codex',model:'gpt-6-astra',thinkingOptionId:'high'}));
    assert.match(JSON.stringify(nativeNode(root,'agent-signal')),/provider-codex[\s\S]*"GPT-6-Astra-High · Agent 1111/);
    assert.match(textOf(nativeNode(root,'agent-signal')),/^GPT-6-Astra-High · Agent 1111 · Working/);
    assert.doesNotMatch(JSON.stringify(nativeNode(root,'agent-signal')),/Astra \(high\)/,'the old label is gone');
    if(platform==='web') assert.match(JSON.stringify(nativeNode(root,'card-agent')),/provider-codex[\s\S]*"GPT-6-Astra-High"/);
    assert.equal(h.calls.length,before);
  }
});
test('REQ-74 ③ the detail says why the card is where it is; a paused card offers "Resume automatic tracking"', async t => {
  const at = '2026-09-25T05:03:00.000Z';
  const h = harness({ width: 1400, link: [AGENT_A], agents: [{ id: AGENT_A, status: 'running' }],
    cardAuto: { reason: { by: 'user', cause: null, agentId: null, at, created: false }, tracking: { state: 'paused', since: at } } });
  const { OverviewScreen } = h.load('client/overview.tsx'); const root = await render(t, OverviewScreen, h.props);
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.match(JSON.stringify(nativeNode(root, 'detail-move-reason')), /Moved by a person · \d\d-\d\d \d\d:\d\d/);
  assert.match(JSON.stringify(nativeNode(root, 'detail-tracking')), /Paused — moved outside automatic tracking/);
  const calls = h.calls.length;
  await act(async () => button(root, 'Resume automatic tracking').props.onPress());
  assert.deepEqual(h.calls.slice(calls).map(c => c.name), ['kanban.v1.auto_cards.resume', 'kanban.v1.card.get']);
  assert.deepEqual(Object.keys(h.calls[calls].input).sort(), ['boardId', 'cardId'], 'the resume names one card');
  assert.match(JSON.stringify(nativeNode(root, 'detail-tracking')), /On — the stage follows the agent/);
  assert.match(text(root), /Resumed — the agent's next signal moves the card/);
  assert.equal(root.root.findAllByType('Pressable').filter(p => p.props.accessibilityLabel === 'Resume automatic tracking').length, 0);
  // An automatic move names its signal; a card nothing tracks shows no tracking line.
  const auto = harness({ width: 1400, cardAuto: { reason: { by: 'auto', cause: 'turn_ended', agentId: AGENT_A, at, created: false }, tracking: null } });
  const { OverviewScreen: Screen } = auto.load('client/overview.tsx'); const other = await render(t, Screen, auto.props);
  await act(async () => labelled(other, 'Example card').props.onPress());
  assert.match(JSON.stringify(nativeNode(other, 'detail-move-reason')), /Automatic — work finished/);
  assert.equal(nativeNode(other, 'detail-tracking'), undefined);
});
test('R2-B quiet transitions remove both the glyph and an open tooltip; completed cards cannot become orphaned', async t=>{
  const h=harness({width:1400,link:[AGENT_A],agents:[{id:AGENT_A,status:'running'}]});
  const {OverviewScreen}=h.load('client/overview.tsx');const root=await render(t,OverviewScreen,h.props);
  await act(async()=>hosts(root,'card-signal-press')[0].props.onPress({stopPropagation(){}}));
  assert.equal(hosts(root,'card-signal-tooltip').length,1);
  // REQ-73: finished is the sidebar's faint dot, so the mark stays and the open bubble now says so.
  await act(async()=>h.agents.upsert(AGENT_A,{status:'idle'}));
  assert.deepEqual(hosts(root,'card-signal-icon').map(n=>n.props.accessibilityLabel),['Finished']);
  assert.match(JSON.stringify(nativeNode(root,'card-signal-tooltip')),/Finished/);
  await act(async()=>h.agents.remove(AGENT_A));
  assert.equal(hosts(root,'card-signal-icon').length,0);assert.equal(hosts(root,'card-signal-tooltip').length,0);
  assert.equal(hosts(root,'card-signal-dismiss').length,0,'an unknown agent has no mark and no bubble');
  const {CardTile}=h.load('client/components.tsx'), {SignalContext}=h.load('client/signal-context.tsx');
  const {staticSignalSource}=h.load('client/agent-signals.ts'),{copy}=h.load('client/i18n.ts');
  const done=await render(t,SignalContext.Provider,{value:staticSignalSource({[AGENT_A]:'idle'},[AGENT_A]),
    children:React.createElement(CardTile,{card:{...toBoardDTO(h.base).stages[0].cards[0],stageId:'done'},countsAsDone:true,
      stages:h.base.template.stages,labels:{[AGENT_A]:'Archived'},colors:palette(h.props.theme),m:copy('en'),onPress(){}})});
  assert.equal(hosts(done,'card-orphaned-mark').length,0,'a completed card is never orphaned');
  assert.match(text(done),/11111111/,'REQ-73: link labels stay in the detail; no profile, model or title leaves the id');
});
test('REQ-73 the card face: sidebar mark + title / provider mark + name (+N), flags, age / → next action', async t => {
  const h = harness({ width: 1400 });
  const { CardTile } = h.load('client/components.tsx'), { SignalContext } = h.load('client/signal-context.tsx');
  const { staticSignalSource } = h.load('client/agent-signals.ts'), { copy } = h.load('client/i18n.ts');
  const base = toBoardDTO(h.base).stages[0].cards[0];
  const models = { [AGENT_A]: { provider: 'codex', model: 'gpt-6-astra', title: 'Check the sort order', profile: 'review_Astra' },
    [AGENT_B]: { provider: 'claude', model: 'claude-opus-5-5', title: 'Build it', profile: null } };
  const tile = (card, map, archived = [], countsAsDone = false) => render(t, SignalContext.Provider, {
    value: staticSignalSource(map, archived, models), children: React.createElement(CardTile, { card, countsAsDone,
      stages: h.base.template.stages, labels: { [AGENT_A]: 'Link label' }, colors: palette(h.props.theme), m: copy('ko'), onPress() {} }) });
  const updatedAt = new Date(Date.now() - 3 * 86400000 - 60000).toISOString();
  const card = { ...base, priority: 'normal', awaiting: 'user', blocked: true, intent: 'requested', nextAction: 'Pick one',
    agentIds: [AGENT_B, AGENT_A], agents: 2, updatedAt };
  const root = await tile(card, { [AGENT_A]: 'permission', [AGENT_B]: 'working' });
  const content = nativeNode(root, 'card-content');
  // REQ-145 ③ (gate 366): a card that waits for a person: line two, its reply row, then "Blocked" on a row of its own.
  const [first, second, replyRow, heldRow, third] = content.children;
  assert.equal(first.children[0].props.testID, 'card-signal-press', 'line one starts with the state mark');
  assert.equal(jsonNodes(first, 'card-signal-icon')[0].props.accessibilityLabel, '입력·권한 대기', 'the most urgent agent leads');
  assert.equal(jsonNodes(first, 'card-state-alert-fill').length, 1, 'permission is the filled CircleAlert');
  assert.equal(first.children[1].children[0], base.title);
  const words = JSON.stringify(second);
  assert.match(words, /provider-codex/, 'the lead\'s provider mark');
  assert.match(words, /"review_Astra-6"[\s\S]*"· 외 1명"/, 'profile label (REQ-126: with its version), then 외 n명');
  assert.doesNotMatch(words, /Link label/, 'link labels stay in the detail');
  assert.match(words, /"3일 전"/, 'the age ends line two');
  assert.doesNotMatch(words, /"응답 필요"|"차단"/, 'the chip and "Blocked" are not on line two');
  assert.equal(replyRow.props.testID, 'card-reply-row'); assert.match(JSON.stringify(replyRow), /"응답 필요"/);
  assert.equal(heldRow.props.testID, 'card-held-row'); assert.match(JSON.stringify(heldRow), /"차단"/);
  assert.doesNotMatch(text(root), /"보통"/, 'research/88: "Normal" is not written');
  assert.equal(jsonNodes(second, 'card-age')[0].props.accessibilityLabel, '마지막 변경 3일 전');
  assert.equal(third.children[0], '→ Pick one', 'the next action reads as the step after');
  assert.equal(labelled(root, base.title).props.style.height, 104 + 48, 'a next action, and (REQ-145 ③) the reply row and the row of "Blocked"');
  // A working lead: the ring, and the model when the agent carries no profile label.
  const working = await tile({ ...card, awaiting: null, blocked: false, nextAction: '', priority: 'high', agentIds: [AGENT_B], agents: 1 },
    { [AGENT_B]: 'working' });
  assert.equal(hosts(working, 'signal-ring').length, 1);
  assert.match(JSON.stringify(nativeNode(working, 'card-agent')), /provider-claude[\s\S]*"Opus-5\.5"/);
  assert.match(text(working), /"높음"/); assert.equal(labelled(working, base.title).props.style.height, 84);
  // Finished leads fade; an orphaned card keeps the sidebar dot on line one and the warning on line two.
  const orphan = await tile({ ...card, awaiting: null, blocked: false, agentIds: [AGENT_A], agents: 1, priority: 'low' },
    { [AGENT_A]: 'idle' }, [AGENT_A]);
  assert.equal(hosts(orphan, 'card-state-dot-idle').length, 1);
  assert.equal(hosts(orphan, 'card-orphaned-mark')[0].props.accessibilityLabel, '에이전트 보관됨 · 완료 확인 필요');
  // REQ-77 ③ supersedes "No assignee · name": the words alone, the archived name only in the tooltip.
  // REQ-82 ① supersedes "담당 없음": the words say what the card waits for.
  assert.match(JSON.stringify(nativeNode(orphan, 'card-agent')), /"children":\["보관됨 · 완료 확인"\]/);
  assert.doesNotMatch(JSON.stringify(nativeNode(orphan, 'card-agent')), /review_Astra/);
  assert.match(text(orphan), /"낮음"/);
  // No agent at all: no mark slot, the title starts at the edge, and the age still shows.
  const none = await tile({ ...card, agentIds: [], agents: 0, awaiting: null, blocked: false, intent: 'draft' }, {});
  assert.equal(nativeNode(none, 'card-content').children[0].children[0].children[0], base.title);
  assert.match(text(none), /"지시 초안"[\s\S]*"3일 전"/);
});
// Gate F3 (research/99): the alert's fill was a positioned box and the glyph a static one, so the web painted the
// fill over the "!". Both layers must be absolutely placed siblings, fill first, glyph last — in every renderer.
test('REQ-73 gate F3: the permission mark stacks its warning fill under the CircleAlert glyph', async t => {
  const h = harness({ width: 390 }), { SidebarStateMark } = h.load('client/status-icon.tsx');
  for (const theme of ['light', 'dark']) {
    const colors = palette(PASEO_THEMES[theme]);
    const root = await render(t, SidebarStateMark, { mark: 'alert', colors, label: 'Waiting' });
    const mark = nativeNode(root, 'card-state-mark');
    assert.deepEqual(mark.children.map(c => c.props.testID), ['card-state-alert-back', 'card-state-alert-glyph'],
      'the fill layer renders first and the glyph layer last, so the glyph paints on top');
    for (const layer of mark.children)
      assert.deepEqual([layer.props.style.position, layer.props.style.top, layer.props.style.left, layer.props.style.width,
        layer.props.style.height], ['absolute', 0, 0, 14, 14], 'both layers are positioned the same way over the 14px slot');
    const [back, front] = mark.children;
    assert.deepEqual(jsonNodes(back, 'card-state-alert-fill').length, 1);
    assert.equal(jsonNodes(back, 'card-state-alert-fill')[0].props.style.position, undefined, 'the fill itself is not re-positioned');
    assert.equal(JSON.stringify(back).includes('CircleAlert'), false, 'no glyph under the fill');
    const glyph = front.children[0];
    assert.deepEqual([glyph.type, glyph.props.name, glyph.props.size, glyph.props.color], ['Icon', 'CircleAlert', 12, colors.card],
      'a 12px CircleAlert in the card colour');
    assert.equal(jsonNodes(back, 'card-state-alert-fill')[0].props.style.backgroundColor, readable(colors.statusDotWarning, colors.card, 3));
  }
});
// Gate F1: Paseo's StatusRingFrame — 12px ring, 1.5px stroke, .3 track; the head is .9 with its other sides transparent.
test('REQ-73 gate F1: the working ring matches the sidebar ring, the track showing under the head', async t => {
  const h = harness({ width: 390 }), { SidebarStateMark, SignalIcon, RING } = h.load('client/status-icon.tsx');
  const { copy } = h.load('client/i18n.ts');
  assert.deepEqual({ ...RING }, { size: 14, centre: 6, ring: 12, stroke: 1.5, trackOpacity: .3, headOpacity: .9, durationMs: 900 });
  const colors = palette(PASEO_THEMES.dark);
  for (const root of [await render(t, SidebarStateMark, { mark: 'ring', colors, label: 'Working' }),
    await render(t, SignalIcon, { bucket: 'working', colors, m: copy('en') })]) {
    const ring = nativeNode(root, 'signal-ring'), [centre, track] = ring.children, arc = nativeNode(root, 'signal-ring-arc');
    const style = [arc.props.style].flat().reduce((a, b) => ({ ...a, ...b }), {});
    assert.deepEqual([style.width, style.borderWidth, style.opacity, style.borderColor], [12, 1.5, .9, 'transparent']);
    assert.ok(style.borderTopColor && style.borderTopColor !== 'transparent', 'only the head is coloured');
    for (const side of ['borderRightColor', 'borderBottomColor', 'borderLeftColor'])
      assert.ok(style[side] === undefined || style[side] === 'transparent', side + ' does not hide the track');
    assert.deepEqual([track.props.style.width, track.props.style.opacity, track.props.style.borderColor], [12, .3, style.borderTopColor]);
    assert.deepEqual([centre.props.style.width, centre.props.style.backgroundColor], [6, style.borderTopColor]);
  }
});
test('R2-B title/filter/banner width shares layout calculation without changing search width or wrapping policy',async t=>{
  for(const width of [1900,1400,1100,900]) {
    const h=harness({width,platform:'web'}),{OverviewScreen}=h.load('client/overview.tsx');
    const root=await render(t,OverviewScreen,h.props);
    assert.equal(nativeNode(root,'swimlane-title-row').props.style.maxWidth,Math.min(width-32,swimlaneWidth()));
    assert.equal(nativeNode(root,'swimlane-fixed-header').props.style.maxWidth,Math.min(width-32,swimlaneWidth()));
    assert.equal(nativeNode(root,'board-search-field').props.style.width,260);
    await toggleDemo(root);
    assert.equal(nativeNode(root,'swimlane-demo-row').props.style.maxWidth,Math.min(width-32,swimlaneWidth()));
  }
});
// REQ-68: the ⋯ footer went with the ⋯; the same line is the settings window's About → Version (REQ-66), still no RPC.
test('R2-B the version shows release or development in the settings About, adds no RPC on web/native',async t=>{
  for(const [platform,about,want] of [['web',{version:'0.1.2',release:'6ac9a9c'},'Version 0.1.2 · Release 6ac9a9c'],
    ['android',{version:'0.1.2'},'Version 0.1.2 · Development build']]) {
    const h=harness({width:platform==='web'?1400:390,platform,about}),{OverviewScreen}=h.load('client/overview.tsx');
    const root=await render(t,OverviewScreen,h.props),before=h.calls.length;
    await openSettings(root,'about');
    assert.equal(hosts(root,'plugin-about').length,0);
    assert.equal(sheetButton(root,'settings-version').props.children,want);
    assert.equal(h.calls.length,before);
  }
});
test('R2-B D20 empty ledger and absent ledger share empty lanes; only list discloses board existence',async t=>{
  const h=harness({width:1400,platform:'web',noCards:true,empty:['wks_empty01']}),{OverviewScreen,ListOverview}=h.load('client/overview.tsx');
  const root=await render(t,OverviewScreen,h.props);
  assert.equal(hosts(root,'lane-empty').length,2); assert.equal(hosts(root,'lane-create').length,0,'both default folded');
  assert.doesNotMatch(text(root),/Board created|Retry/);
  const disclosures=root.root.findAllByProps({testID:'lane-disclosure'}).filter(n=>typeof n.type==='string');
  for(const d of disclosures)await act(async()=>d.props.onPress());
  assert.equal(hosts(root,'lane-create').length,2);assert.equal(hosts(root,'swimlane-cells').length,2);
  const list=await render(t,ListOverview,{...h.props,onBoard(){}});
  assert.deepEqual(hosts(list,'overview-ledger-state').map(n=>n.props.children).sort(),['Board created','No cards']);
  const {BoardScreen}=h.load('client/board.tsx');
  const panel=await render(t,BoardScreen,{...h.props,selector:{boardId:h.base.id}});
  assert.match(text(panel),/No cards/);assert.doesNotMatch(text(panel),/Board created|Retry/);
});
test('R2-B removal supersedes a one-shot lookup and notifies an open card/detail', async t=>{
  const h=harness({width:1400,link:[AGENT_A],lookups:{[AGENT_A]:'running'}});
  const {OverviewScreen}=h.load('client/overview.tsx');const root=await render(t,OverviewScreen,h.props);
  assert.equal(hosts(root,'card-signal-icon')[0].props.accessibilityLabel,'Working');
  await act(async()=>labelled(root,'Example card').props.onPress());
  const before=h.calls.length;
  await act(async()=>h.agents.remove(AGENT_A));
  assert.equal(hosts(root,'card-signal-icon').length,0);
  assert.match(JSON.stringify(nativeNode(root,'agent-signal')),/Status unavailable/);
  assert.equal(h.calls.length,before);
});

/** REQ-59: the ⋯ of a heading, its sheet, and the three moves inside it. */
function orderMenu(root, testID, name) {
  return hosts(root, testID).find(p => p.props.accessibilityLabel === 'Order: ' + name);
}
function sheetButton(root, testID) { return hosts(root, testID)[0]; }
/** REQ-114: "Clear all" — in the wide filter glyph's menu, or the phone sheet's button. */
async function clearAllFilters(root) {
  const glyph = hosts(root, 'filter-menu')[0];
  if (!glyph) { await act(async () => button(root, 'Clear all').props.onPress()); return; }
  await act(async () => glyph.props.onPress());
  await act(async () => hosts(root, 'filter-clear-all')[0].props.onPress());
}
/** A lane's name as its link reads it (REQ-75 B1), without the "Open board: " (REQ-110) in front. */
const laneLabel = node => node.props.accessibilityLabel.replace(/^Open board: /, '');
/** The grouped board (REQ-75 A2) as project → workspace names. */
function sectionNames(root) {
  return hosts(root, 'swimlane-project-section').map(section => {
    const lanes = section.findAll(n => n.props?.testID === 'workspace-name-link' && typeof n.type === 'string').map(laneLabel);
    const project = section.findAll(n => n.props?.testID === 'project-icon' && typeof n.type === 'string')[0].props.accessibilityLabel;
    return { project, lanes };
  });
}
/** The flat board (REQ-75 A1) as its workspace names, top to bottom. */
function flatNames(root) { return hosts(root, 'workspace-name-link').map(laneLabel); }
async function move(root, testID, name, direction) {
  await act(async () => orderMenu(root, testID, name).props.onPress());
  await act(async () => sheetButton(root, 'order-move-' + direction).props.onPress());
}
test('REQ-59 ① the ⋯ on project and workspace headings moves them, disables the ends and writes one small record per move', async t => {
  // REQ-64: moves stay inside a layer, so both projects are card-less here (one layer); the two-layer case is its own test.
  // REQ-75 A3: the grouped board, as the host remembered it.
  const h = harness({ width: 1400, empty: ['wks_empty01', 'wks_empty02'], emptyProject: 'prj_second', noCards: true,
    uiSettings: { groupByProject: true } });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props), before = h.calls.length;
  assert.deepEqual(sectionNames(root).map(s => s.project), ['Example Project', 'Second Project'], 'the automatic order first');
  // REQ-75 A2: a one-workspace project has its own heading too, so its ⋯ is a project ⋯ with the reset (nothing to reset yet).
  await act(async () => orderMenu(root, 'project-order-menu', 'Example Project').props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(root, 'order-move-' + d).props.disabled), [true, true, false]);
  assert.equal(sheetButton(root, 'order-reset').props.disabled, true);
  await act(async () => button(root, 'Close').props.onPress());
  await act(async () => orderMenu(root, 'project-order-menu', 'Second Project').props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(root, 'order-move-' + d).props.disabled), [false, false, true],
    'the last project can only go up');
  assert.equal(sheetButton(root, 'order-reset').props.disabled, true, 'nothing arranged yet, nothing to reset');
  await act(async () => sheetButton(root, 'order-move-top').props.onPress());
  assert.deepEqual(sectionNames(root).map(s => s.project), ['Second Project', 'Example Project']);
  assert.deepEqual(h.ui.writes.at(-1), { hostId: h.props.host.id, order: { projects: ['prj_second', 'prj_example01'], workspaces: [], flatWorkspaces: [] } },
    'only the order travels; the project filter is not rewritten');
  // Workspaces move inside their own project.
  assert.deepEqual(sectionNames(root)[0].lanes, ['Empty Workspace 0 · wks_empty01', 'Empty Workspace 1 · wks_empty02']);
  await act(async () => orderMenu(root, 'lane-order-menu', 'Empty Workspace 1 · wks_empty02').props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(root, 'order-move-' + d).props.disabled), [false, false, true]);
  await act(async () => sheetButton(root, 'order-move-up').props.onPress());
  assert.deepEqual(sectionNames(root)[0].lanes, ['Empty Workspace 1 · wks_empty02', 'Empty Workspace 0 · wks_empty01']);
  assert.deepEqual(h.ui.writes.at(-1).order.workspaces, ['wks_empty02', 'wks_empty01']);
  assert.deepEqual(sectionNames(root).map(s => s.project), ['Second Project', 'Example Project'], 'a workspace move keeps the projects');
  // "Reset to automatic order" on the project heading releases its workspaces only.
  await act(async () => orderMenu(root, 'project-order-menu', 'Second Project').props.onPress());
  assert.equal(sheetButton(root, 'order-reset').props.disabled, false);
  await act(async () => sheetButton(root, 'order-reset').props.onPress());
  assert.deepEqual(sectionNames(root)[0].lanes, ['Empty Workspace 0 · wks_empty01', 'Empty Workspace 1 · wks_empty02']);
  assert.deepEqual(h.ui.writes.at(-1).order, { projects: ['prj_second', 'prj_example01'], workspaces: [], flatWorkspaces: [] });
  // The settings window releases everything at once (REQ-68: once the screen's ⋯).
  await openSettings(root, 'display');
  await act(async () => sheetButton(root, 'order-reset-all').props.onPress());
  assert.deepEqual(sectionNames(root).map(s => s.project), ['Example Project', 'Second Project']);
  assert.deepEqual(h.ui.writes.at(-1).order, { projects: [], workspaces: [], flatWorkspaces: [] });
  assert.equal(sheetButton(root, 'order-reset-all').props.disabled, true, 'nothing left to reset');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.ui.writes.length, 4, 'one write per move or reset, none while the screen sits there');
  assert.equal(h.calls.length, before + 4, 'no re-read and no other RPC');
  assert.ok(h.ui.writes.every(w => w.hiddenProjects === undefined));
});
test('REQ-59 ②④ the remembered order comes back on a fresh screen, on 390px and on the list screen, and 390px moves too', async t => {
  const order = { projects: ['prj_second'], workspaces: ['wks_empty02', 'wks_empty01'] };
  const options = { empty: ['wks_empty01', 'wks_empty02'], emptyProject: 'prj_second', order, uiSettings: { groupByProject: true } };
  const wide = harness({ width: 1400, ...options }), { OverviewScreen } = wide.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, wide.props);
  // REQ-64 ①: the stored order puts the card-less project first, yet the project with a card stays above it.
  assert.deepEqual(sectionNames(root), [{ project: 'Example Project', lanes: ['Example Workspace · example-workspace'] },
    { project: 'Second Project', lanes: ['Empty Workspace 1 · wks_empty02', 'Empty Workspace 0 · wks_empty01'] }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(wide.ui.writes.length, 0, 'reading the order writes nothing');
  // 390px: same order, the ⋯ closes each workspace's button row, and a move works there too.
  const mobile = harness({ mobile: true, ...options }), MobileOverview = mobile.load('client/overview.tsx').OverviewScreen;
  const phone = await render(t, MobileOverview, mobile.props);
  const headings = () => hosts(phone, 'mobile-workspace-heading').map(n =>
    laneLabel(n.findAll(v => v.props?.testID === 'workspace-name-link' && typeof v.type === 'string')[0]));
  assert.deepEqual(headings(), ['Empty Workspace 1 · wks_empty02', 'Empty Workspace 0 · wks_empty01']);
  assert.ok(orderMenu(phone, 'project-order-menu', 'Second Project'));
  assert.equal(orderMenu(phone, 'lane-order-menu', 'Empty Workspace 0 · wks_empty01').props.style.width, 32, 'a 44px touch target on 390px');
  await move(phone, 'lane-order-menu', 'Empty Workspace 0 · wks_empty01', 'top');
  assert.deepEqual(headings(), ['Empty Workspace 0 · wks_empty01', 'Empty Workspace 1 · wks_empty02']);
  assert.deepEqual(mobile.ui.writes.at(-1).order.workspaces, ['wks_empty01', 'wks_empty02']);
  assert.ok(hosts(phone, 'order-reset-all').length === 0);
  await openSettings(phone, 'display');
  assert.equal(sheetButton(phone, 'order-reset-all').props.disabled, false);
  // The list screen lists the arranged project first.
  const list = harness({ width: 1400, ...options }), { ListOverview } = list.load('client/overview.tsx');
  const rows = await render(t, ListOverview, { ...list.props, onBoard: () => {} });
  const listed = rows.root.findAll(n => typeof n.type === 'string' && ['overview-empty-row', 'overview-board-row'].includes(n.props?.testID))
    .map(n => [n.findAllByType('Text')[0].props.children].flat()[0]);
  assert.deepEqual(listed, ['Example Workspace', 'Empty Workspace 1', 'Empty Workspace 0'], 'REQ-64 ③: the same two layers on the list');
  assert.equal(list.ui.writes.length, 0);
});
test('REQ-59 the demo arranges in memory and never saves', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await toggleDemo(root); await groupByProject(root);
  const names = sectionNames(root).map(s => s.project), before = h.calls.length;
  await move(root, 'project-order-menu', names[1], 'up');
  assert.deepEqual(sectionNames(root).map(s => s.project).slice(0, 2), [names[1], names[0]]);
  assert.equal(h.calls.length, before); assert.equal(h.ui.writes.length, 0);
});
test('REQ-60 ⑤⑥ workspace rows and their columns step in 24px beside a border-coloured rail, a flat header stays on the project line, and the right edge holds', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await toggleDemo(root);
  const c = palette(h.props.theme), edge = Math.min(1400 - 32, swimlaneWidth());
  assert.equal(edge, SWIMLANE.laneIndent + 4 * SWIMLANE.columnWidth + 3 * SWIMLANE.columnGap);
  // The title, filter and demo rows keep the project's left line and end on the board's right edge.
  for (const id of ['swimlane-title-row', 'swimlane-fixed-header', 'swimlane-demo-row'])
    assert.equal(nativeNode(root, id).props.style.maxWidth, edge, id);
  assert.equal(nativeNode(root, 'swimlane-vertical').props.style.width, edge);
  // REQ-75 A1: flat (the default) — every lane takes the old one-workspace form: its header on the project line at
  // full width, pinned at 0; only what hangs below it steps in, so the columns sit where they do when grouped.
  const flatLanes = nativeNode(root, 'swimlane-vertical').children.filter(n => n.props?.testID === 'swimlane-lane-section');
  assert.equal(flatLanes.length, 13);
  const open = flatLanes.find(l => l.children.some(n => n.props?.testID === 'swimlane-cells'));
  const section = open, header = section.children[0];
  assert.equal(header.props.style.paddingLeft, 0); assert.equal(header.props.style.top, 0);
  assert.equal(header.children[0].props.style.width, edge);
  assert.equal(header.children.find(n => n.props?.testID === 'lane-stage-headers').props.style.marginLeft, 24);
  assert.equal(section.children.find(n => n.props?.testID === 'swimlane-cells').props.style.marginLeft, 24);
  assert.equal(section.children.at(-1).props.style.top, SWIMLANE.headerHeight, 'the rail starts under the flat header');
  assert.equal(section.children.at(-1).props.style.bottom, 0, 'and ends with its own lane');
  assert.deepEqual(flatLanes.map(l => l.props.style.marginTop), [0, ...Array(12).fill(SWIMLANE.projectGap)],
    'flat lanes are as far apart as projects are');
  await groupByProject(root);
  const vertical = nativeNode(root, 'swimlane-vertical');
  const projects = vertical.children.filter(n => n.props?.testID === 'swimlane-project-section');
  assert.ok(projects.every(p => p.children[0].props.testID === 'swimlane-project'), 'REQ-75 A2: every project has its heading');
  const nested = projects.find(p => p.children.filter(n => n.props?.testID === 'swimlane-lane-section').length > 1);
  // Project row: pinned at 0 above the lanes, not indented, full width.
  const projectRow = nested.children[0];
  assert.equal(projectRow.props.style.top, 0); assert.equal(projectRow.props.style.zIndex, STICKY.projectZIndex);
  assert.equal(projectRow.props.style.paddingLeft ?? 0, 0); assert.equal(projectRow.children[0].props.style.width, edge);
  // Workspace rows: one indent in, still ending on the same right edge; pinned under the project row.
  for (const lane of nested.children.filter(n => n.props?.testID === 'swimlane-lane-section')) {
    const header = lane.children[0];
    assert.equal(header.props.style.paddingLeft, 24); assert.equal(header.props.style.top, projectHeaderHeight());
    assert.equal(header.props.style.zIndex, STICKY.zIndex); assert.equal(header.props.style.position, 'sticky');
    assert.equal(24 + header.children[0].props.style.width, edge, 'the ⋯ of a workspace row ends on the right edge');
    const cells = lane.children.find(n => n.props?.testID === 'swimlane-cells');
    if (cells) assert.equal(cells.props.style.marginLeft, 24);
    // The rail runs inside the indent, in the host border colour, once in the section and once in its pinned header.
    const rails = [lane.children.at(-1), header.children.at(-1)];
    for (const rail of rails) {
      assert.equal(rail.props.testID, 'lane-rail');
      assert.deepEqual([rail.props.style.position, rail.props.style.left, rail.props.style.width, rail.props.style.backgroundColor, rail.props.style.top],
        ['absolute', SWIMLANE.railInset, 1, c.border, 0]);
      assert.equal(rail.props.pointerEvents, 'none');
    }
  }
  const lanes = nested.children.filter(n => n.props?.testID === 'swimlane-lane-section');
  assert.equal(lanes[0].children.at(-1).props.style.bottom, -SWIMLANE.laneGap, 'the rail bridges the gap to the next workspace');
  assert.equal(lanes.at(-1).children.at(-1).props.style.bottom, 0, 'and stops at the last one');
  // A narrow window keeps the same right edge for every row.
  const narrow = harness({ width: 1100 }), Narrow = narrow.load('client/overview.tsx').OverviewScreen;
  const small = await render(t, Narrow, narrow.props);
  assert.equal(nativeNode(small, 'swimlane-title-row').props.style.maxWidth, 1068);
  assert.equal(nativeNode(small, 'swimlane-lane-header').props.style.width, 1068, 'a flat lane header spans the whole row');
});
test('D23 the line under the stage headings stays inside each column box, never on a full-width row', async t => {
  const flat = style => Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style ?? {};
  for (const width of [1400, 1600]) {
    const h = harness({ width }), { OverviewScreen } = h.load('client/overview.tsx');
    const root = await render(t, OverviewScreen, h.props);
    await toggleDemo(root);
    const headers = jsonNodes(root.toJSON(), 'lane-section-header'), c = palette(h.props.theme);
    assert.ok(headers.some(n => jsonNodes(n, 'lane-stage-headers').length), 'the demo has expanded lanes');
    for (const header of headers) {
      assert.equal(flat(header.props.style).position, 'sticky');
      assert.equal(flat(header.props.style).borderBottomWidth, 0, 'the full-width pinned row draws no bottom line');
      assert.equal(flat(header.props.style).shadowOpacity, 0, 'nor a shadow that reads as one in light');
      // Every bottom line inside the pinned row is a stage heading's divider, inside a column-wide box.
      (function walk(node, parent) {
        if (!node || typeof node === 'string') return;
        if (Array.isArray(node)) return node.forEach(n => walk(n, parent));
        const style = flat(node.props?.style);
        if (style.borderBottomWidth > 0) {
          assert.equal(node.props.testID, 'cell-panel-heading', width + ': only stage headings draw a line');
          assert.equal(style.borderBottomColor, c.divider);
          assert.equal(flat(parent.props.style).width, SWIMLANE.columnWidth, 'the line is one column wide');
        }
        walk(node.children, node);
      })(header.children, header);
    }
  }
});
test('REQ-60 ⑥ 390px steps workspace sections in 12px and pulls the flat heading back to the project line', async t => {
  // RN Web at 390px, where the headings really pin (REQ-42) — the indent must not disturb that.
  const h = harness({ mobile: true, platform: 'web', empty: ['wks_empty01', 'wks_empty02'], emptyProject: 'prj_second',
    uiSettings: { groupByProject: true } });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  assert.equal(hosts(root, 'mobile-swimlane-screen').length, 1);
  const c = palette(h.props.theme);
  const sections = hosts(root, 'mobile-project-group');
  const nested = sections.find(s => s.findAll(n => n.props?.testID === 'mobile-project-heading').length);
  const heading = nested.findAll(n => n.props?.testID === 'mobile-project-heading' && typeof n.type === 'string')[0];
  assert.equal(heading.props.style.paddingLeft ?? 0, 0);
  for (const workspace of nested.findAll(n => typeof n.type === 'string' && n.props?.testID?.startsWith('mobile-workspace-empty:'))) {
    assert.equal(workspace.props.style.paddingLeft, SWIMLANE.mobileLaneIndent);
    const rails = workspace.findAll(n => n.props?.testID === 'lane-rail' && typeof n.type === 'string');
    assert.equal(rails.length, 1); const rail = rails[0];
    assert.equal(rail.props.style.position, 'absolute'); assert.equal(rail.props.style.left, SWIMLANE.mobileRailInset);
    assert.equal(rail.props.style.backgroundColor, c.border);
    const inner = workspace.findAll(n => n.props?.testID === 'mobile-workspace-heading' && typeof n.type === 'string')[0];
    assert.equal(inner.props.style.marginLeft, 0); assert.equal(inner.props.style.top, projectHeaderHeight());
  }
  const single = harness({ mobile: true, platform: 'web' }); single.addCard({ ...add('Doing'), stageId: 'doing' });
  const phone = await render(t, single.load('client/overview.tsx').OverviewScreen, single.props);
  const mergedHeading = hosts(phone, 'mobile-workspace-heading')[0];
  assert.equal(mergedHeading.props.style.marginLeft, -SWIMLANE.mobileLaneIndent, 'REQ-75 A1: a flat heading stays on the project line');
  assert.equal(mergedHeading.props.style.top, 0);
  assert.equal(mergedHeading.parent.props.style.paddingLeft, SWIMLANE.mobileLaneIndent, 'its cards step in');
});

// REQ-66 moved this switch from the screen ⋯ into the settings window (Automation); the rest is REQ-61 ⑧ as it was.
test('REQ-61 ⑧ the settings window switches agent auto cards per host: on by default, one write per press, remembered, en/ko', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const before = h.calls.length;
  // REQ-68: the screen has no ⋯ any more; ⚙ opens the window.
  assert.equal(labelled(root, 'More'), undefined);
  assert.equal(hosts(root, 'auto-cards-toggle').length, 0, 'not on the screen itself');
  await act(async () => sheetButton(root, 'open-settings').props.onPress());
  await act(async () => sheetButton(root, 'settings-tab-automation').props.onPress());
  const toggle = () => sheetButton(root, 'auto-cards-toggle');
  assert.equal(toggle().props.accessibilityLabel, 'Agent auto cards');
  assert.equal(toggle().props.accessibilityState.checked, true, 'on unless this host turned it off');
  await act(async () => toggle().props.onPress());
  assert.equal(toggle().props.accessibilityState.checked, false);
  assert.deepEqual(h.auto.writes, [{ hostId: h.props.host.id, enabled: false }]);
  await act(async () => toggle().props.onPress());
  assert.deepEqual(h.auto.writes.at(-1), { hostId: h.props.host.id, enabled: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.auto.writes.length, 2, 'one write per press, none while the window sits open');
  assert.equal(h.calls.length, before + 2, 'no re-read and no other RPC');
  assert.equal(h.ui.writes.length, 0, 'the filter and order file is not touched');
  // A host that turned it off sees "Off" on a fresh screen, also on 390px; the demo cannot switch it.
  const off = harness({ mobile: true, autoCards: false }), phone = await render(t, off.load('client/overview.tsx').OverviewScreen, off.props);
  await act(async () => sheetButton(phone, 'open-settings').props.onPress());
  await act(async () => sheetButton(phone, 'settings-open-automation').props.onPress());
  assert.equal(sheetButton(phone, 'auto-cards-toggle').props.accessibilityState.checked, false);
  assert.equal(off.auto.writes.length, 0, 'reading the switch writes nothing');
  const { copy } = h.load('client/i18n.ts');
  assert.equal(copy('ko').autoCardsOn, '에이전트 자동 카드: 켬');
  assert.equal(copy('ko').autoCardsOff, '에이전트 자동 카드: 끔');
});

// REQ-62: the auto refresh. Each harness loads its own module copy, so shortening its timings stays local.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fastRefresh(h, values) { Object.assign(h.load('client/refresh-model.ts').AUTO_REFRESH, values); }
const countOf = (h, name) => h.calls.filter(c => c.name === name).length;
const writes = h => h.calls.filter(c => /mutate|ensure|ui\.set|auto_cards/.test(c.name));
test('REQ-62 ① the swimlane looks at revisions while shown and re-reads only when one changed', async t => {
  const h = harness({ width: 1400 }); fastRefresh(h, { intervalMs: 25, idleMs: 60_000, minGapMs: 0 });
  const { OverviewScreen } = h.load('client/overview.tsx');
  let renders = 0;
  const Counted = props => React.createElement(React.Profiler, { id: 'overview', onRender: () => { renders++; } },
    React.createElement(OverviewScreen, props));
  const root = await render(t, Counted, h.props);
  await act(async () => { await pause(30); });
  const reads = countOf(h, 'kanban.v1.overview.get'), before = text(root), rendered = renders;
  assert.match(before, /Check the result/);
  await act(async () => { await pause(120); });
  assert.ok(countOf(h, 'kanban.v1.revisions.get') >= 3, 'it keeps looking');
  assert.deepEqual(h.calls.find(c => c.name === 'kanban.v1.revisions.get').input, { groups: true }, 'every board, so a new one is seen too');
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads, 'the same revisions read nothing again');
  assert.equal(renders, rendered, 'and render nothing');
  assert.equal(text(root), before);
  // Another agent or a person changes the ledger through the CLI.
  h.external({ nextAction: 'Changed from the CLI' });
  await act(async () => { await pause(90); });
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads + 1, 'one re-read for one change');
  assert.match(text(root), /Changed from the CLI/);
  assert.doesNotMatch(text(root), /Loading/, 'no loading state in between');
  assert.equal(writes(h).length, 0, 'looking never writes');
});
/**
 * H6 (research/133): a hand-driven clock for a screen's poller (`POLL_CLOCK`), so a test counts looks by the time it
 * moves, however busy the machine is. `advance` fires the due timers in order and lets each look finish.
 */
function pollClock(h) {
  let now = 0, next = 1;
  const due = new Map(), flush = () => new Promise(resolve => setImmediate(resolve));
  Object.assign(h.load('client/refresh-model.ts').POLL_CLOCK, { now: () => now,
    timers: { set: (run, ms) => { const id = next++; due.set(id, { at: now + ms, run }); return id; }, clear: id => { due.delete(id); } } });
  return { pending: () => due.size,
    async advance(ms) {
      await flush(); const end = now + ms;
      for (;;) {
        const first = [...due].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at; due.delete(first[0]); first[1].run(); await flush(); await flush();
      }
      now = end; await flush();
    } };
}
test('REQ-62 ②③ idle stops every request; a touch or the foreground looks at once; unmount leaves nothing', async t => {
  const h = harness({ mobile: true }); fastRefresh(h, { intervalMs: 20, idleMs: 150, minGapMs: 0 });
  // H6: the poller's time is this clock's, not the machine's: 20ms looks and a 150ms idle hold under any load.
  const clock = pollClock(h);
  const { OverviewScreen } = h.load('client/overview.tsx'), refresh = h.load('client/auto-refresh.ts');
  let root;
  await act(async () => { root = Renderer.create(React.createElement(OverviewScreen, h.props)); });
  let mounted = true;
  afterOnce(t, async () => { if (mounted) await act(async () => root.unmount()); });
  assert.equal(refresh.activePollers(), 1);
  await act(async () => { await clock.advance(260); });
  const stopped = countOf(h, 'kanban.v1.revisions.get');
  assert.equal(stopped, 7, 'a look every 20ms until 150ms without a touch (20 … 140)');
  await act(async () => { await clock.advance(10_000); });
  assert.equal(countOf(h, 'kanban.v1.revisions.get'), stopped, 'zero requests once idle');
  assert.equal(clock.pending(), 0, 'and no timer waiting');
  // A touch anywhere on the screen reaches the root and looks at once, then polling resumes.
  const surface = root.root.findAll(node => typeof node.type === 'string' && node.props.onTouchStart)[0];
  await act(async () => { surface.props.onTouchStart(); });
  assert.equal(countOf(h, 'kanban.v1.revisions.get'), stopped + 1, 'a touch looks at once');
  await act(async () => { await clock.advance(70); });
  const resumed = countOf(h, 'kanban.v1.revisions.get');
  assert.equal(resumed, stopped + 4, 'and keeps looking (20, 40, 60)');
  // Background: nothing. Foreground: one look at once.
  await act(async () => { h.agents.appState('background'); await clock.advance(80); });
  const hidden = countOf(h, 'kanban.v1.revisions.get');
  assert.equal(hidden, resumed, 'the background stops it at once');
  await act(async () => { await clock.advance(80); });
  assert.equal(countOf(h, 'kanban.v1.revisions.get'), hidden, 'nothing in the background');
  await act(async () => { h.agents.appState('active'); });
  assert.equal(countOf(h, 'kanban.v1.revisions.get'), hidden + 1, 'the foreground looks at once');
  await act(async () => root.unmount()); mounted = false;
  assert.equal(refresh.activePollers(), 0, 'no poller survives the screen');
  assert.equal(clock.pending(), 0, 'no timer left behind');
  const gone = countOf(h, 'kanban.v1.revisions.get');
  await act(async () => { await clock.advance(80); refresh.noteActivity(); h.agents.appState('active'); });
  assert.equal(countOf(h, 'kanban.v1.revisions.get'), gone, 'no timer or listener left behind');
  assert.equal(writes(h).length, 0);
});
test('REQ-62 ④ the board watches only itself, a card being edited keeps its draft, and its own save is read once', async t => {
  const h = harness(); fastRefresh(h, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  const { BoardScreen } = h.load('client/board.tsx');
  const root = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id } });
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  await act(async () => labelled(root, 'Example card').props.onPress());
  await act(async () => input(root, 'Notes').props.onChangeText('My unsaved notes'));
  await act(async () => { await pause(60); });
  assert.deepEqual(h.calls.find(c => c.name === 'kanban.v1.revisions.get').input, { boardIds: [h.base.id], groups: true });
  const boardReads = countOf(h, 'kanban.v1.board.get'), cardReads = countOf(h, 'kanban.v1.card.get');
  h.external({ nextAction: 'Remote next action' });
  await act(async () => { await pause(60); });
  assert.equal(countOf(h, 'kanban.v1.board.get'), boardReads + 1, 'the changed board is read again');
  assert.match(text(root), /Remote next action/);
  assert.equal(input(root, 'Notes').props.value, 'My unsaved notes', 'the open editor keeps the draft');
  assert.equal(countOf(h, 'kanban.v1.card.get'), cardReads, 'and is not re-read under the person typing');
  // Its own save: onChanged reads the board once; the next looks find the same revision and stay quiet.
  const other = harness(); fastRefresh(other, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  const own = await render(t, other.load('client/board.tsx').BoardScreen, { ...other.props, selector: { boardId: other.base.id } });
  await act(async () => labelled(own, 'Example card').props.onPress());
  await act(async () => input(own, 'Notes').props.onChangeText('Saved by me'));
  const reads = countOf(other, 'kanban.v1.board.get');
  await act(async () => input(own, 'Notes').props.onBlur());
  await act(async () => { await pause(100); });
  assert.equal(countOf(other, 'kanban.v1.board.mutate'), 1);
  assert.equal(countOf(other, 'kanban.v1.board.get'), reads + 1, 'one read after its own write, none from the looks');
  assert.ok(countOf(other, 'kanban.v1.revisions.get') >= 2);
});
test('REQ-62 ⑤ the list overview refreshes itself the same way', async t => {
  const h = harness(); fastRefresh(h, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  const { ListOverview } = h.load('client/overview.tsx');
  const root = await render(t, ListOverview, { ...h.props, onBoard: () => {} });
  await act(async () => { await pause(50); });
  const reads = countOf(h, 'kanban.v1.overview.get');
  assert.ok(countOf(h, 'kanban.v1.revisions.get') >= 1);
  h.addCard({ ...add('Card from the CLI'), awaiting: 'user' });
  await act(async () => { await pause(60); });
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads + 1);
  assert.match(text(root), /Card from the CLI/);
});

// F1: Paseo keeps a plugin screen mounted when the person opens History or an agent; it only hides the
// screen's DOM (display:none ancestor) or takes it out of the page. The roots get a fake DOM box here.
function hostDom(t) {
  const live = new Set(), roots = [];
  class Observer { constructor(report) { this.report = report; } observe() { live.add(this); } disconnect() { live.delete(this); } }
  const before = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = Observer;
  t.after(() => { if (before === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = before; });
  return { live, roots,
    // Only the screen roots (they carry onTouchStart) are elements; every other ref stays null as before.
    createNodeMock: node => { if (!node.props.onTouchStart) return null;
      const root = { isConnected: true, rects: 1, getClientRects() { return { length: this.rects }; } }; roots.push(root); return root; },
    show(shown, { report = true } = {}) {
      for (const root of roots) root.rects = shown ? 1 : 0;
      if (report) for (const o of [...live]) o.report([{ isIntersecting: shown }]);
    } };
}
test('F1 the swimlane asks nothing while the host shows another screen and looks at once when it is back', async t => {
  const h = harness({ width: 1400 }); fastRefresh(h, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  const dom = hostDom(t), { OverviewScreen } = h.load('client/overview.tsx'), refresh = h.load('client/auto-refresh.ts');
  const root = await render(t, OverviewScreen, h.props, { createNodeMock: dom.createNodeMock });
  assert.equal(dom.roots.length, 1, 'the surface root is watched');
  await act(async () => { await pause(70); });
  assert.ok(countOf(h, 'kanban.v1.revisions.get') >= 2, 'looks while shown');
  for (let trip = 0; trip < 3; trip++) {
    await act(async () => { dom.show(false); });
    const away = countOf(h, 'kanban.v1.revisions.get');
    await act(async () => { await pause(100); });
    // A click or focus elsewhere in Paseo is activity, but a hidden screen still asks nothing.
    await act(async () => { refresh.noteActivity(); await pause(30); });
    assert.equal(countOf(h, 'kanban.v1.revisions.get'), away, 'zero requests while hidden (trip ' + trip + ')');
    h.external({ nextAction: 'Changed while away ' + trip });
    await act(async () => { dom.show(true); });
    assert.equal(countOf(h, 'kanban.v1.revisions.get'), away + 1, 'coming back looks at once');
    await act(async () => { await pause(20); });
    assert.match(text(root), new RegExp('Changed while away ' + trip), 'and shows what changed');
  }
  // Round trips never pile up pollers: one screen, one poller, one look per interval.
  assert.equal(refresh.activePollers(), 1);
  const start = countOf(h, 'kanban.v1.revisions.get');
  await act(async () => { await pause(100); });
  assert.ok(countOf(h, 'kanban.v1.revisions.get') - start <= 6, 'a single poller\'s pace');
  assert.equal(writes(h).length, 0);
});
test('F1 a hidden board asks nothing even before the observer reports; the list stops the same way', async t => {
  const h = harness(); fastRefresh(h, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  const dom = hostDom(t), { BoardScreen } = h.load('client/board.tsx');
  await render(t, BoardScreen, { ...h.props, panel: true, selector: { workspaceId: h.base.workspaceId } }, { createNodeMock: dom.createNodeMock });
  await act(async () => { await pause(50); });
  assert.ok(countOf(h, 'kanban.v1.revisions.get') >= 1);
  // The DOM is gone from the page but no report arrived yet: every look checks the box first.
  await act(async () => { dom.show(false, { report: false }); });
  const away = countOf(h, 'kanban.v1.revisions.get');
  await act(async () => { await pause(100); });
  assert.equal(countOf(h, 'kanban.v1.revisions.get'), away, 'zero requests from a board without a box');
  await act(async () => { dom.show(true, { report: false }); await pause(50); });
  assert.ok(countOf(h, 'kanban.v1.revisions.get') > away, 'and it looks again once shown');
  const list = harness(); fastRefresh(list, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  // The list reads the surface root's watch from the context OverviewScreen provides.
  const { ListOverview } = list.load('client/overview.tsx'), { ShownContext } = list.load('client/auto-refresh.ts');
  const watch = list.load('client/refresh-model.ts').createShownWatch(globalThis.IntersectionObserver);
  watch.ref(dom.createNodeMock({ props: { onTouchStart: () => {} } }));
  await render(t, props => React.createElement(ShownContext.Provider, { value: watch }, React.createElement(ListOverview, props)),
    { ...list.props, onBoard: () => {} });
  await act(async () => { await pause(40); });
  assert.ok(countOf(list, 'kanban.v1.revisions.get') >= 1);
  await act(async () => { dom.show(false); });
  const hidden = countOf(list, 'kanban.v1.revisions.get');
  await act(async () => { await pause(80); });
  assert.equal(countOf(list, 'kanban.v1.revisions.get'), hidden, 'the list asks nothing while hidden');
  await act(async () => { dom.show(true); });
  // J3 (research/143): shown again it looks at once; on a busy machine the 20 ms poll may add one more look in the same
  // act, so this counts that it looked, not how often (the zero while hidden, above, is the exact check).
  assert.ok(countOf(list, 'kanban.v1.revisions.get') > hidden, 'and looks again once shown');
});

// REQ-63: the way back from a board.
test('REQ-63 ⑦ a wide board shows a quiet "All boards ›" path before its title instead of a bordered button', async t => {
  const h = harness(), { BoardScreen } = h.load('client/board.tsx');
  let back = 0;
  const root = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id }, onBack: () => { back++; } });
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  const crumb = hosts(root, 'board-breadcrumb')[0];
  assert.ok(crumb, 'the path is there');
  assert.equal(crumb.props.accessibilityLabel, 'Back to all boards');
  const label = crumb.findAllByType('Text')[0];
  assert.equal(label.props.children, 'All boards ›');
  assert.ok(label.props.style.fontSize < 18, 'smaller than the title');
  assert.equal(label.props.style.color, h.props.theme.colors.foregroundMuted);
  const appbar = root.root.findByProps({ testID: 'board-appbar' });
  assert.ok(!appbar.findAllByType('Pressable').some(p => p.findAllByType('Text').some(n => n.props.children === 'Overview')),
    'the bordered "Overview" button is gone from the top bar');
  assert.equal(hosts(root, 'board-back').length, 0, 'no phone ‹ on a wide screen');
  // It sits in the title row, before the title.
  const row = crumb.parent;
  const texts = row.findAllByType('Text').map(n => n.props.children);
  assert.deepEqual(texts.slice(0, 1), ['All boards ›']);
  await act(async () => crumb.props.onHoverIn());
  assert.equal(crumb.findAllByType('Text')[0].props.style.textDecorationLine, 'underline', 'hover shows it can be pressed');
  await act(async () => crumb.props.onFocus());
  assert.ok(crumb.props.style.backgroundColor, 'keyboard focus is visible');
  await act(async () => crumb.props.onPress());
  assert.equal(back, 1);
  // Without a way back (the workspace panel) there is no path.
  const panel = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id } });
  await act(async () => panel.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  assert.equal(hosts(panel, 'board-breadcrumb').length, 0);
  const { copy } = h.load('client/i18n.ts');
  assert.equal(copy('ko').allBoards, '전체 칸반');
  assert.equal(copy('ko').backToAll, '전체 칸반으로');
  assert.equal(copy('ko').overview, '전체 현황', '⑨ the overview wording stays');
});
// REQ-68: the board's ⋯ is gone, and with it the "Overview" entry that duplicated ‹ (was: "the ⋯ entry stays").
test('REQ-63 ⑧ a phone board has a 44px ‹ at the far left of the top bar and no ⋯', async t => {
  const h = harness({ mobile: true }), { BoardScreen } = h.load('client/board.tsx');
  let back = 0;
  const root = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id }, onBack: () => { back++; } });
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
  const appbar = nativeNode(root, 'board-appbar');
  const first = appbar.children[0];
  assert.equal(first.props.style.width, 44); assert.equal(first.props.style.height, 44);
  assert.equal(first.children[0].props.testID, 'board-back', 'the leftmost control');
  const press = hosts(root, 'board-back')[0];
  assert.equal(press.props.accessibilityLabel, 'Back to all boards');
  assert.equal(press.props.style.width + 2 * press.props.hitSlop, 44, 'a 44px target');
  assert.equal(hosts(root, 'board-breadcrumb').length, 0);
  await act(async () => press.props.onPress());
  assert.equal(back, 1);
  assert.equal(labelled(root, 'More'), undefined, 'no ⋯ on the board top bar');
  assert.equal(button(root, 'Overview'), undefined, '‹ is the way back');
});

test('D25 ① a board at the project root is a workspace row of that project on the wide board, 390px and the list', async t => {
  const options = { rootBoard: true, empty: ['wks_tree01'], uiSettings: { groupByProject: true } };
  // REQ-64: both rows card-less, so they share a layer and the root row can be moved below the worktree.
  // REQ-65 ⑦: the root row is named after its project and says "original path" in its detail.
  const wide = harness({ width: 1400, noCards: true, ...options }), { OverviewScreen } = wide.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, wide.props), rootName = 'Example Project · original path · example-workspace';
  assert.deepEqual(sectionNames(root), [{ project: 'Example Project', lanes: [rootName, 'Empty Workspace 0 · wks_tree01'] }],
    'one project with two workspace rows, no "not found" group');
  assert.doesNotMatch(text(root), /Not found in Paseo/);
  assert.equal(orderMenu(root, 'project-order-menu', 'Example Project').props.disabled, false);
  await move(root, 'lane-order-menu', rootName, 'down');
  assert.deepEqual(sectionNames(root)[0].lanes, ['Empty Workspace 0 · wks_tree01', rootName]);
  assert.deepEqual(wide.ui.writes.at(-1).order.workspaces, ['wks_tree01', 'root:prj_example01']);
  // 390px lists a workspace under a stage when it has cards there or none at all; a card-less root board shows under any.
  const mobile = harness({ mobile: true, noCards: true, ...options }), phone = await render(t, mobile.load('client/overview.tsx').OverviewScreen, mobile.props);
  const headings = hosts(phone, 'mobile-workspace-heading').map(n =>
    laneLabel(n.findAll(v => v.props?.testID === 'workspace-name-link' && typeof v.type === 'string')[0]));
  assert.deepEqual(headings, [rootName, 'Empty Workspace 0 · wks_tree01']);
  assert.doesNotMatch(text(phone), /Not found in Paseo/);
  const list = harness(options), listRoot = await render(t, list.load('client/overview.tsx').ListOverview, { ...list.props, onBoard: () => {} });
  assert.match(text(listRoot), /original path/);
  assert.doesNotMatch(text(listRoot), /Not found in Paseo/);
});

/** REQ-65/REQ-75: what a LaneName shows — its lead text (the workspace), the muted part (if any) and the lead's weight. */
function nameParts(node) {
  const lead = node.findAll(v => v.props?.testID === 'workspace-name-primary' && typeof v.type === 'string')[0];
  const quiet = node.findAll(v => v.props?.testID === 'workspace-name-detail' && typeof v.type === 'string')[0];
  return { lead: lead.children.filter(v => typeof v === 'string').join(''), weight: lead.props.style.fontWeight,
    numberOfLines: lead.props.numberOfLines, quiet: quiet ? allText(quiet).replace(/^ · /, '') : '', quietColor: quiet?.props.style.color };
}
/** Every string under a host node, nested Text included, in order. */
function allText(node) { return node.children.map(v => typeof v === 'string' ? v : allText(v)).join(''); }
const disclosures = root => hosts(root, 'lane-name');
const linkOf = node => node.findAll(v => v.props?.testID === 'workspace-name-link' && typeof v.type === 'string')[0];

test('REQ-64 ①④ card-less rows form a lower layer: a stored order cannot lift them, and a move never leaves its layer', async t => {
  // Projects: Example Project holds a card, Second Project has only card-less workspaces. The stored order is the
  // symptom's — every project listed, the card-less one first — yet the project with a card stays on top.
  const legacy = { projects: ['prj_second', 'prj_example01'], workspaces: [] };
  const h = harness({ width: 1400, empty: ['wks_empty01', 'wks_empty02'], emptyProject: 'prj_second', order: legacy, uiSettings: { groupByProject: true } });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  assert.deepEqual(sectionNames(root).map(s => s.project), ['Example Project', 'Second Project']);
  // Each project is alone in its layer, so every move is disabled on both.
  await act(async () => orderMenu(root, 'project-order-menu', 'Example Project').props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(root, 'order-move-' + d).props.disabled), [true, true, true]);
  await act(async () => button(root, 'Close').props.onPress());
  await act(async () => orderMenu(root, 'project-order-menu', 'Second Project').props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(root, 'order-move-' + d).props.disabled), [true, true, true],
    'the card-less project cannot go above the one with a card');
  await act(async () => button(root, 'Close').props.onPress());
  // Workspaces: one lane with a card, two without, in one project.
  const lanes = harness({ width: 1400, empty: ['wks_empty01', 'wks_empty02'], uiSettings: { groupByProject: true },
    order: { projects: [], workspaces: ['wks_empty02', 'wks_empty01', 'wks_example01'] } });
  const board = await render(t, lanes.load('client/overview.tsx').OverviewScreen, lanes.props);
  const e0 = 'Empty Workspace 0 · wks_empty01', e1 = 'Empty Workspace 1 · wks_empty02', ex = 'Example Workspace · example-workspace';
  assert.deepEqual(sectionNames(board)[0].lanes, [ex, e1, e0], 'the lane with a card leads though the stored order lists it last');
  await act(async () => orderMenu(board, 'lane-order-menu', ex).props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(board, 'order-move-' + d).props.disabled), [true, true, true]);
  await act(async () => button(board, 'Close').props.onPress());
  await act(async () => orderMenu(board, 'lane-order-menu', e1).props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(board, 'order-move-' + d).props.disabled), [true, true, false],
    'the first card-less lane is the top of its layer');
  await act(async () => button(board, 'Close').props.onPress());
  await move(board, 'lane-order-menu', e0, 'top');
  assert.deepEqual(sectionNames(board)[0].lanes, [ex, e0, e1], '"to the top" means the top of the layer');
  assert.deepEqual(lanes.ui.writes.at(-1).order.workspaces, ['wks_empty01', 'wks_empty02', 'wks_example01'],
    'the moved layer takes its slots in the stored list; the other key keeps its own');
  // 390px: the same layers, and the same bounds on the ⋯.
  const mobile = harness({ mobile: true, empty: ['wks_empty01', 'wks_empty02'], emptyProject: 'prj_second', order: legacy, uiSettings: { groupByProject: true } });
  const phone = await render(t, mobile.load('client/overview.tsx').OverviewScreen, mobile.props);
  assert.ok(orderMenu(phone, 'project-order-menu', 'Second Project').props.accessibilityLabel);
  await act(async () => orderMenu(phone, 'project-order-menu', 'Second Project').props.onPress());
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(phone, 'order-move-' + d).props.disabled), [true, true, true]);
});

test('REQ-75 A1 (was REQ-65 ⑤) a flat lane leads with the workspace in bold and adds the project, small and muted, only when it is another name', async t => {
  // Acme_Logotype / acme_logotype: the same name up to case, so it is said once — the workspace's own spelling.
  for (const mobile of [false, true]) {
    const h = harness({ ...(mobile ? { mobile: true } : { width: 1400 }), projectName: 'Acme_Logotype', workspaceName: 'acme_logotype' });
    if (mobile) h.addCard({ ...add('Doing'), stageId: 'doing' });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    const [name] = disclosures(root);
    assert.deepEqual(nameParts(name), { lead: 'acme_logotype', weight: '600', numberOfLines: 1, quiet: '', quietColor: undefined });
    assert.equal(linkOf(name).props.accessibilityLabel, 'Open board: acme_logotype · example-workspace', 'the folder is for a screen reader');
  }
  // Another name: the workspace leads in bold, the project follows smaller in the muted colour.
  const h = harness({ width: 1400, workspaceName: 'Landing page', branches: { wks_example01: 'main' } });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const parts = nameParts(disclosures(root)[0]);
  assert.equal(parts.lead, 'Landing page'); assert.equal(parts.weight, '600');
  assert.equal(allText(disclosures(root)[0]), 'Landing page · Example Project (1)');
  assert.equal(parts.quiet, 'Example Project', 'no branch or folder on screen — the menu and the tip carry those');
  assert.equal(parts.quietColor, palette(h.props.theme).foregroundMuted);
  const quiet = disclosures(root)[0].findAll(v => v.props?.testID === 'workspace-name-detail' && typeof v.type === 'string')[0];
  const lead = disclosures(root)[0].findAll(v => v.props?.testID === 'workspace-name-primary' && typeof v.type === 'string')[0];
  assert.ok(quiet.props.style.fontSize < lead.props.style.fontSize, 'the project is the smaller text');
  assert.equal(linkOf(disclosures(root)[0]).props.accessibilityLabel, 'Open board: Landing page · Example Project · main · example-workspace');
  assert.ok(orderMenu(root, 'lane-order-menu', 'Landing page · Example Project'), 'the ⋯ names the workspace and its project');
  // Grouped, the project heading carries the project; the lane under it does not repeat it (REQ-65 ⑥ keeps its detail).
  const g = harness({ width: 1400, workspaceName: 'Landing page', branches: { wks_example01: 'main' }, uiSettings: { groupByProject: true } });
  const grouped = await render(t, g.load('client/overview.tsx').OverviewScreen, g.props);
  assert.deepEqual(nameParts(disclosures(grouped)[0]).quiet, 'main · example-workspace');
  assert.equal(nameParts(disclosures(grouped)[0]).weight, '400');
});

test('REQ-65 ⑥ under a project header a lane names its branch and folder, muted, on the wide board, 390px and the list', async t => {
  const options = { empty: ['wks_empty01', 'wks_empty02'], branches: { wks_empty01: 'feature/login', wks_example01: 'main' }, uiSettings: { groupByProject: true } };
  const h = harness({ width: 1400, ...options }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const byLead = Object.fromEntries(disclosures(root).map(n => { const p = nameParts(n); return [p.lead, p]; }));
  assert.equal(byLead['Example Workspace'].quiet, 'main · example-workspace');
  assert.equal(byLead['Example Workspace'].weight, '400', 'the project header above is the bold one');
  assert.equal(byLead['Empty Workspace 0'].quiet, 'feature/login · wks_empty01');
  assert.equal(byLead['Empty Workspace 1'].quiet, 'wks_empty02', 'no branch, the folder alone');
  assert.equal(nativeNode(root, 'project-group-header') !== undefined, true);
  // The order menu names the row in full, so two rows of one project never share a menu title.
  assert.ok(orderMenu(root, 'lane-order-menu', 'Empty Workspace 0 · feature/login · wks_empty01'));
  // 390px: the same parts in the compact size.
  const m = harness({ mobile: true, ...options }), phone = await render(t, m.load('client/overview.tsx').OverviewScreen, m.props);
  const small = disclosures(phone).map(nameParts).find(p => p.lead === 'Empty Workspace 0');
  assert.equal(small.quiet, 'feature/login · wks_empty01'); assert.equal(small.numberOfLines, 1);
  // The list screen: the project heading is bold and in the main colour, each row carries its detail.
  const l = harness(options), list = await render(t, l.load('client/overview.tsx').ListOverview, { ...l.props, onBoard: () => {} });
  const heading = hosts(list, 'overview-project-heading')[0];
  assert.equal(heading.props.style.fontWeight, '600'); assert.equal(heading.props.style.color, palette(l.props.theme).foreground);
  assert.equal(heading.props.numberOfLines, 1);
  const rows = hosts(list, 'overview-workspace-name').map(allText);
  assert.deepEqual(rows, ['Example Workspace · main · example-workspace', 'Empty Workspace 0 · feature/login · wks_empty01',
    'Empty Workspace 1 · wks_empty02']);
  assert.equal(hosts(list, 'overview-workspace-name')[0].props.numberOfLines, 1);
});

test('REQ-65 ⑦⑧ the root row and the board title use the same hierarchy', async t => {
  // ⑦ The root row takes its project's name and says "original path" in the muted part; its worktree row names its folder.
  const h = harness({ width: 1400, rootBoard: true, empty: ['wks_tree01'], branches: { wks_tree01: 'feature/x' }, uiSettings: { groupByProject: true } });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const parts = disclosures(root).map(nameParts).map(p => [p.lead, p.quiet]);
  assert.deepEqual(parts, [['Example Project', 'original path · example-workspace'], ['Empty Workspace 0', 'feature/x · wks_tree01']]);
  // ⑧ The board title (REQ-77 ④: in the flat lane heading's order): the workspace in bold, then, muted, the project and its branch and folder.
  const b = harness({ branches: { wks_example01: 'main' } }), { BoardScreen } = b.load('client/board.tsx');
  const screen = await render(t, BoardScreen, { ...b.props, selector: { boardId: b.base.id } });
  const title = hosts(screen, 'board-title')[0];
  assert.equal(title.props.numberOfLines, 1); assert.equal(title.props.style.fontWeight, '600');
  assert.equal(allText(title), 'Example Workspace · Example Project · main · example-workspace');
  const muted = title.findAll(n => typeof n.type === 'string' && n !== title)[0];
  assert.equal(muted.props.style.color, palette(b.props.theme).foregroundMuted);
  // Same name up to case: the board title says it once.
  const k = harness({ projectName: 'Acme_Logotype', workspaceName: 'acme_logotype' });
  const acme = await render(t, k.load('client/board.tsx').BoardScreen, { ...k.props, selector: { boardId: k.base.id } });
  assert.equal(allText(hosts(acme, 'board-title')[0]), 'acme_logotype · example-workspace');
});

// REQ-66: the Kanban settings window.
const marginOf = (root, id) => hosts(root, id)[0].props.style.marginLeft;
const blockOffsets = root => ['swimlane-title-row', 'swimlane-fixed-header', 'swimlane-horizontal'].map(id => marginOf(root, id));
async function openSettings(root, category) {
  // REQ-68: ⚙ opens the window directly (once ⋯ → "Kanban settings…").
  await act(async () => sheetButton(root, 'open-settings').props.onPress());
  if (category) await act(async () => (hosts(root, 'settings-tab-' + category)[0] ?? sheetButton(root, 'settings-open-' + category)).props.onPress());
}
async function closeSettings(root) {
  await act(async () => sheetButton(root, 'settings-close').props.onPress());
}
/**
 * REQ-68: the demo switch is in the settings window's About (once "Preview demo data" in ⋯).
 * REQ-69: behind the developer entry, which the tests open first.
 */
async function toggleDemo(root) {
  devDemo();
  await openSettings(root, 'about');
  await act(async () => sheetButton(root, 'demo-toggle').props.onPress());
  await closeSettings(root);
}
const inRow = (root, row, id) => sheetButton(root, row).findAll(n => n.props?.testID === id && typeof n.type === 'string');
const modalOf = (root, id) => root.root.findAll(n => n.type === 'NativeModal').find(n => n.findAll(c => c.props?.testID === id).length);
// REQ-68: ⚙ took ⋯'s place as the way in, so the window opens in one press and focus goes back to ⚙.
test('REQ-66 ① ⚙ opens the settings window: 720 wide, centred on the plugin area, categories switch, close/Escape/backdrop close it and focus returns to ⚙', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const focused = [];
  const root = await render(t, OverviewScreen, h.props, { createNodeMock: element => element.props.testID === 'swimlane-screen'
    ? { measureInWindow: done => done(320, 40, 1400, 900) } : { focus: () => focused.push(element.props.accessibilityLabel) } });
  assert.equal(labelled(root, 'More'), undefined);
  assert.equal(sheetButton(root, 'open-settings').props.accessibilityLabel, 'Kanban settings');
  await act(async () => sheetButton(root, 'open-settings').props.onPress());
  assert.equal(hosts(root, 'menu-sheet').length, 0);
  const win = sheetButton(root, 'settings-window');
  assert.equal(win.props.style.width, 720); assert.equal(win.props.style.height, 560);
  assert.equal(win.props.style.left, 320 + (1400 - 720) / 2, 'centred on the measured plugin area, not the window');
  assert.equal(win.props.style.top, 40 + (900 - 560) / 2);
  assert.equal(win.props.style.borderRadius, 12); assert.equal(win.props.role, 'dialog');
  assert.equal(sheetButton(root, 'settings-nav').props.style.width, 180);
  const selected = () => ['display', 'automation', 'about'].filter(id => sheetButton(root, 'settings-tab-' + id).props.accessibilityState.selected);
  assert.deepEqual(selected(), ['display']);
  assert.equal(hosts(root, 'setting-board-align').length, 1);
  await act(async () => sheetButton(root, 'settings-tab-automation').props.onPress());
  assert.deepEqual(selected(), ['automation']);
  assert.equal(hosts(root, 'setting-board-align').length, 0);
  assert.equal(hosts(root, 'setting-auto-cards').length, 1); assert.equal(hosts(root, 'setting-auto-refresh').length, 1);
  await act(async () => sheetButton(root, 'settings-tab-about').props.onPress());
  assert.equal(sheetButton(root, 'settings-version').props.children, 'Version 0.1.2 · Development build', 'the line the ⋯ footer had');
  // Close button, then Escape (the RN modal's request to close), then the backdrop.
  await act(async () => sheetButton(root, 'settings-close').props.onPress());
  assert.equal(hosts(root, 'settings-window').length, 0);
  assert.deepEqual(focused, ['Kanban settings'], 'focus goes back to ⚙');
  await openSettings(root);
  assert.deepEqual(selected(), ['display'], 'every opening starts at the first category');
  await act(async () => modalOf(root, 'settings-window').props.onRequestClose());
  assert.equal(hosts(root, 'settings-window').length, 0);
  await openSettings(root);
  const backdrop = modalOf(root, 'settings-window').findAllByType('Pressable').find(p => p.props.style?.position === 'absolute');
  await act(async () => backdrop.props.onPress());
  assert.equal(hosts(root, 'settings-window').length, 0);
  assert.equal(h.ui.writes.length + h.auto.writes.length, 0, 'opening and browsing writes nothing');
});
test('REQ-66 ① a narrower area shrinks the window; below 760px and on phones it is a one-column sheet: categories, then rows with ‹', async t => {
  const narrow = harness({ width: 800 }), wide = await render(t, narrow.load('client/overview.tsx').OverviewScreen, narrow.props);
  await openSettings(wide);
  assert.equal(sheetButton(wide, 'settings-window').props.style.width, 704, 'min(720, 800 − 96)');
  assert.equal(sheetButton(wide, 'settings-nav').props.style.width, 150);
  const h = harness({ mobile: true, platform: 'web' }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await openSettings(root);
  assert.equal(hosts(root, 'settings-window').length, 0);
  assert.equal(sheetButton(root, 'settings-sheet').props.style.width, 390, 'a bottom sheet the width of the phone');
  assert.equal(hosts(root, 'settings-category-list').length, 1);
  await act(async () => sheetButton(root, 'settings-open-display').props.onPress());
  assert.equal(hosts(root, 'settings-category-list').length, 0);
  assert.equal(hosts(root, 'setting-board-align').length, 1);
  await act(async () => sheetButton(root, 'settings-back').props.onPress());
  assert.equal(hosts(root, 'settings-category-list').length, 1);
  await act(async () => modalOf(root, 'settings-sheet').props.onRequestClose());
  assert.equal(hosts(root, 'settings-sheet').length, 0);
  // A native host gets the same Kanban sheet (REQ-72), with the same one column inside.
  const ios = harness({ mobile: true }), phone = await render(t, ios.load('client/overview.tsx').OverviewScreen, ios.props);
  await openSettings(phone);
  assert.equal(hosts(phone, 'settings-sheet').length, 1); assert.equal(phone.root.findAllByType('Modal').length, 0);
  assert.equal(hosts(phone, 'settings-category-list').length, 1);
});
test('REQ-66 ② board position moves the title, filter and board together (centre by default), is saved per row and comes back', async t => {
  const h = harness({ width: 1600 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.deepEqual(blockOffsets(root), [200, 200, 200], 'centre when nothing is saved: (1600 − 32 − 1168) / 2');
  assert.equal(hosts(root, 'swimlane-title-row')[0].props.style.maxWidth, hosts(root, 'swimlane-fixed-header')[0].props.style.maxWidth,
    'one right edge for the title and the filter (REQ-54)');
  await openSettings(root, 'display');
  assert.equal(sheetButton(root, 'board-align-center').props.accessibilityState.checked, true);
  assert.equal(hosts(root, 'board-align-picture-left').length, 1, 'each choice draws where the board sits');
  await act(async () => sheetButton(root, 'board-align-left').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1), { hostId: h.props.host.id, settings: { boardAlign: 'left' } }, 'this row only');
  assert.deepEqual(blockOffsets(root), [0, 0, 0]);
  await act(async () => sheetButton(root, 'board-align-right').props.onPress());
  assert.deepEqual(blockOffsets(root), [400, 400, 400]);
  assert.equal(sheetButton(root, 'board-align-right').props.accessibilityState.checked, true);
  assert.equal(h.ui.writes.length, 2);
  await act(async () => sheetButton(root, 'board-align-right').props.onPress());
  assert.equal(h.ui.writes.length, 2, 'the current choice again writes nothing');
  assert.deepEqual(h.ui.value.settings, { boardAlign: 'right' });
  assert.deepEqual(h.ui.value.hiddenProjects, [], 'the filter is untouched');
  await act(async () => sheetButton(root, 'settings-close').props.onPress());
  // The demo banner moves with the block, and the demo cannot change the setting.
  await toggleDemo(root);
  assert.equal(marginOf(root, 'swimlane-demo-row'), 400);
  await openSettings(root, 'display');
  assert.equal(sheetButton(root, 'board-align-left').props.accessibilityState.disabled, true);
  // A fresh screen of a host that saved "right" starts there; a plugin area narrower than the board starts left.
  const saved = harness({ width: 1600, uiSettings: { boardAlign: 'right' } });
  const again = await render(t, saved.load('client/overview.tsx').OverviewScreen, saved.props);
  assert.deepEqual(blockOffsets(again), [400, 400, 400]);
  const small = harness({ width: 1080, uiSettings: { boardAlign: 'right' } });
  const scrolled = await render(t, small.load('client/overview.tsx').OverviewScreen, small.props);
  assert.deepEqual(blockOffsets(scrolled), [0, 0, 0], 'left start and sideways scroll whatever the setting');
  await openSettings(scrolled, 'display');
  assert.equal(sheetButton(scrolled, 'board-align-right').props.accessibilityState.checked, true, 'the setting itself is kept');
  assert.equal(small.ui.writes.length, 0);
});
test('REQ-66 ③ a refused or lost save keeps the previous value, says so on the row and tries the same write again', async t => {
  const h = harness({ width: 1600 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await openSettings(root, 'display');
  h.outcome('uiFailed');
  await act(async () => sheetButton(root, 'board-align-left').props.onPress());
  assert.equal(hosts(root, 'setting-error').length, 1);
  assert.match(text(root), /Could not save\. The previous value is kept\./);
  assert.equal(sheetButton(root, 'board-align-center').props.accessibilityState.checked, true, 'the old choice stays selected');
  assert.deepEqual(blockOffsets(root), [200, 200, 200], 'and the board did not move');
  await act(async () => sheetButton(root, 'setting-retry').props.onPress());
  assert.equal(hosts(root, 'setting-error').length, 0);
  assert.deepEqual(h.ui.writes.slice(-2).map(w => w.settings), [{ boardAlign: 'left' }, { boardAlign: 'left' }], 'the same write again');
  assert.deepEqual(blockOffsets(root), [0, 0, 0]);
  h.outcome('uiLost');
  await act(async () => sheetButton(root, 'board-align-right').props.onPress());
  assert.equal(hosts(root, 'setting-error').length, 1, 'a lost reply is not taken as saved either');
  assert.deepEqual(blockOffsets(root), [0, 0, 0]);
  // The agent auto-card switch used to swallow a failure (catch(() => {})) and show the new value anyway.
  await act(async () => sheetButton(root, 'settings-tab-automation').props.onPress());
  h.outcome('autoFailed');
  await act(async () => sheetButton(root, 'auto-cards-toggle').props.onPress());
  assert.equal(sheetButton(root, 'auto-cards-toggle').props.accessibilityState.checked, true, 'still on, as the server has it');
  assert.equal(inRow(root, 'setting-auto-cards', 'setting-error').length, 1, 'the error sits on its own row');
  assert.equal(inRow(root, 'setting-auto-refresh', 'setting-error').length, 0);
  await act(async () => inRow(root, 'setting-auto-cards', 'setting-retry')[0].props.onPress());
  assert.equal(sheetButton(root, 'auto-cards-toggle').props.accessibilityState.checked, false);
  assert.deepEqual(h.auto.writes.map(w => w.enabled), [false, false]);
});
test('REQ-66 ③④ auto refresh: the status says live, paused since HH:MM, or off; off means zero looks and the refresh button still reads', async t => {
  const h = harness({ width: 1400 }); fastRefresh(h, { intervalMs: 20, idleMs: 150, minGapMs: 0 });
  const { OverviewScreen } = h.load('client/overview.tsx'), refresh = h.load('client/auto-refresh.ts');
  const root = await render(t, OverviewScreen, h.props);
  const status = () => sheetButton(root, 'refresh-status').props.children;
  assert.equal(status(), 'Auto refresh on');
  await act(async () => { await pause(260); });
  assert.match(status(), /^Paused · last checked \d\d:\d\d$/, 'the 3-minute pause (shortened here) is not a failure');
  const surface = root.root.findAll(node => typeof node.type === 'string' && node.props.onTouchStart)[0];
  await act(async () => { surface.props.onTouchStart(); await pause(5); });
  assert.equal(status(), 'Auto refresh on', 'a touch resumes it');
  await openSettings(root, 'automation');
  assert.equal(sheetButton(root, 'auto-refresh-toggle').props.accessibilityState.checked, true, 'on by default');
  await act(async () => sheetButton(root, 'auto-refresh-toggle').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1), { hostId: h.props.host.id, settings: { autoRefresh: false } });
  assert.equal(status(), 'Auto refresh off');
  assert.equal(refresh.activePollers(), 0);
  const looks = countOf(h, 'kanban.v1.revisions.get'), reads = countOf(h, 'kanban.v1.overview.get');
  await act(async () => { await pause(100); surface.props.onTouchStart(); await pause(60); });
  assert.equal(countOf(h, 'kanban.v1.revisions.get'), looks, 'zero looks while off, even after a touch');
  await act(async () => sheetButton(root, 'settings-close').props.onPress());
  await act(async () => labelled(root, 'Refresh').props.onPress());
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads + 1, 'the refresh button still reads');
  await openSettings(root, 'automation');
  await act(async () => sheetButton(root, 'auto-refresh-toggle').props.onPress());
  assert.equal(refresh.activePollers(), 1, 'on again');
  assert.equal(status(), 'Auto refresh on');
  // A failed save of this row leaves it on and polling.
  h.outcome('uiFailed');
  await act(async () => sheetButton(root, 'auto-refresh-toggle').props.onPress());
  assert.equal(sheetButton(root, 'auto-refresh-toggle').props.accessibilityState.checked, true);
  assert.equal(refresh.activePollers(), 1);
  const { copy } = h.load('client/i18n.ts');
  assert.equal(copy('ko').refreshLive, '자동 갱신 중');
  assert.equal(copy('ko').refreshPaused('14:05'), '일시 정지 · 마지막 확인 14:05');
  assert.equal(copy('ko').openSettings, '칸반 설정…');
});
test('REQ-66 ③ auto refresh saved off reaches the list, the 390px board and a workspace panel opened first', async t => {
  const settings = { autoRefresh: false };
  const list = harness({ uiSettings: settings }); fastRefresh(list, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  await render(t, list.load('client/overview.tsx').ListOverview, { ...list.props, onBoard: () => {} });
  const phone = harness({ mobile: true, platform: 'web', uiSettings: settings }); fastRefresh(phone, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  const mobile = await render(t, phone.load('client/overview.tsx').OverviewScreen, phone.props);
  const panel = harness({ panel: true, uiSettings: settings }); fastRefresh(panel, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  await render(t, panel.load('client/panel.tsx').WorkspacePanel, { ...panel.props, context: 'workspace', workspaceId: panel.base.workspaceId });
  await act(async () => { await pause(120); });
  for (const h of [list, phone, panel]) assert.equal(countOf(h, 'kanban.v1.revisions.get'), 0);
  assert.equal(sheetButton(mobile, 'refresh-status').props.children, 'Auto refresh off', 'the phone says so beside the title');
});

// REQ-67: header glyph, faint "+N", counts without a unit, the done heading's board link, settings from every ⋯.
/** What is written on screen (Text children), not accessibility labels. */
const shownText = root => root.root.findAllByType('Text').map(n => [].concat(n.props.children).filter(v => typeof v === 'string' || typeof v === 'number').join('')).join(' | ');
const headerChildren = header => header.children.filter(n => typeof n !== 'string');
const endsWith = (header, ...ids) => {
  const tail = headerChildren(header).slice(-ids.length).map(n => n.findAll(c => typeof c.type === 'string' && c.props?.testID)[0]?.props.testID);
  assert.deepEqual(tail, ids);
};
test('REQ-67 ① one glyph beside ⋯ opens every column of the workspace (REQ-92: five more each) and folds it back; its words are its name and tooltip', async t => {
  const h = harness({ width: 1400 });
  for (let i = 0; i < 5; i++) h.addCard(add('Queued ' + i));
  for (let i = 0; i < 4; i++) h.addCard({ ...add('Shipped ' + i), stageId: 'done' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const header = () => hosts(root, 'swimlane-lane-header')[0];
  const toggle = () => sheetButton(root, 'lane-toggle');
  endsWith(header(), 'lane-toggle', 'lane-order-menu');
  assert.equal(hosts(root, 'lane-toggle').length, 1);
  assert.equal(toggle().props.accessibilityLabel, 'Show 5 more in each column (4 not shown)');
  assert.equal(toggle().findByType('Icon').props.name, 'ChevronsUpDown');
  assert.equal(root.root.findAllByType('Pressable').filter(p => /^(Show|Collapse)/.test(p.findAllByType('Text')[0]?.props.children ?? '')).length, 0,
    'no "Show 5 more" / "Collapse" words on screen');
  // Hover (or keyboard focus) shows the same words. REQ-80: below the glyph, never beside it.
  await act(async () => toggle().props.onHoverIn());
  assert.equal(hosts(root, 'icon-tooltip')[0].findByType('Text').props.children, 'Show 5 more in each column (4 not shown)');
  assert.ok(hosts(root, 'icon-tooltip')[0].props.style.top >= 30, 'below the glyph');
  assert.ok(!(hosts(root, 'icon-tooltip')[0].props.style.right > 0), 'not out to its left');
  await act(async () => toggle().props.onHoverOut());
  assert.equal(hosts(root, 'icon-tooltip').length, 0);
  const cards = () => hosts(root, 'swimlane-card-slot').length;
  assert.equal(cards(), 6);
  await act(async () => toggle().props.onPress());
  assert.equal(cards(), 10, 'every column of the band opens');
  assert.equal(toggle().props.accessibilityLabel, 'Collapse'); assert.equal(toggle().findByType('Icon').props.name, 'ChevronsDownUp');
  endsWith(header(), 'lane-toggle', 'lane-order-menu');
  await act(async () => toggle().props.onPress());
  assert.equal(cards(), 6, 'and back to three per column');
  assert.equal(h.ui.writes.length, 0, 'a local view choice writes nothing');
});
test('REQ-67 ① the glyph sits beside ⋯ on a workspace row under a project header too, and the ⋯ right edge stays the board edge', async t => {
  const h = harness({ width: 1920, empty: ['wks_empty01'], uiSettings: { groupByProject: true } });
  for (let i = 0; i < 4; i++) h.addCard(add('Queued ' + i));
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const [filled, empty] = hosts(root, 'swimlane-lane-header');
  endsWith(filled, 'lane-toggle', 'lane-order-menu');
  assert.equal(empty.findAll(n => n.props?.testID === 'lane-toggle').length, 0, 'nothing to open in a card-less workspace');
  // REQ-54/66: the lane row is exactly as wide as before (the board edge), whatever sits at its right end.
  assert.equal(filled.props.style.width, swimlaneWidth() - SWIMLANE.laneIndent);
  assert.equal(hosts(root, 'swimlane-title-row')[0].props.style.maxWidth, swimlaneWidth());
});
test('REQ-67 ② a faint "+N" under a column says what the preview leaves out and (REQ-92) shows five more of it; none once all shown', async t => {
  const h = harness({ width: 1400 });
  for (let i = 0; i < 5; i++) h.addCard(add('Queued ' + i));
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const more = () => hosts(root, 'cell-more');
  assert.equal(more().length, 1, 'only the column with more than three');
  const link = sheetButton(root, 'cell-more');
  assert.equal(link.findByType('Text').props.children, '+3');
  // D27: the resting colour is nudged up to 4.5:1 against the panel it sits on, so it may differ from the raw token.
  assert.equal(link.findByType('Text').props.style.color, readable(palette(h.props.theme).foregroundMuted, palette(h.props.theme).panel), 'faint');
  assert.equal(link.props.accessibilityLabel, 'Show 3 more (3 not shown): To Do', 'read out as the action it takes');
  assert.ok(hosts(root, 'swimlane-cell-todo')[0].findAll(n => n.props?.testID === 'cell-more').length, 'under its own column');
  await act(async () => link.props.onPress());
  assert.equal(hosts(root, 'swimlane-card-slot').length, 6);
  assert.equal(more().length, 0, 'nothing once every card shows');
  assert.equal(allText(sheetButton(root, 'cell-collapse')), 'Collapse', 'REQ-92: "Collapse" in its place');
  assert.equal(sheetButton(root, 'lane-toggle').props.accessibilityLabel, 'Collapse', 'the same state as the glyph');
});
test('REQ-67 ③ counts are the number alone: "(6)" in the header, no "cards" / "more completed" words', async t => {
  const h = harness({ width: 1400 });
  for (let i = 0; i < 12; i++) h.addCard({ ...add('Shipped ' + i), stageId: 'done' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  await act(async () => sheetButton(root, 'lane-toggle').props.onPress());
  assert.equal(allText(hosts(root, 'lane-name')[0]), 'Example Workspace · Example Project (13)', 'REQ-75 A1: workspace first');
  assert.doesNotMatch(shownText(root), /\d+ cards|more completed|장/);
});
test('REQ-75 B1·B2·B5 (was REQ-67 ⑤) no "Board ›" on the done heading: the name opens the board, and so does the flat lane ⋯', async t => {
  const h = harness({ width: 1400 });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  assert.equal(hosts(root, 'done-board-link').length, 0);
  const heading = hosts(root, 'lane-stage-headers')[0].children.at(-1);
  assert.equal(heading.findAll(n => typeof n.type === 'string' && n.props?.accessibilityRole === 'button').length, 0, 'the done heading is a heading only');
  await act(async () => sheetButton(root, 'lane-toggle')?.props.onPress());
  assert.equal(hosts(root, 'done-board-link').length, 0, 'nor once the band is open');
  await act(async () => sheetButton(root, 'workspace-name-link').props.onPress());
  assert.equal(hosts(root, 'workspace-board').length, 1, 'the name opens that workspace board');
  // B5: the lane's ⋯ keeps "Open in board".
  const again = harness({ width: 1400 }), second = await render(t, again.load('client/overview.tsx').OverviewScreen, again.props);
  await act(async () => sheetButton(second, 'lane-order-menu').props.onPress());
  assert.equal(sheetButton(second, 'order-open-board').findByType('Text').props.children, 'Open in board');
  await act(async () => sheetButton(second, 'order-open-board').props.onPress());
  assert.equal(hosts(second, 'workspace-board').length, 1);
});
test('REQ-67 ⑤ under a project header each workspace ⋯ opens its own board; the project ⋯ has no board; the demo has none', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'], uiSettings: { groupByProject: true } });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  await act(async () => sheetButton(root, 'project-order-menu').props.onPress());
  assert.equal(hosts(root, 'order-open-board').length, 0, 'a project spans several boards');
  const menus = hosts(root, 'lane-order-menu');
  assert.equal(menus.length, 2);
  await act(async () => menus[0].props.onPress());
  assert.equal(hosts(root, 'order-open-board').length, 1);
  await act(async () => sheetButton(root, 'order-open-board').props.onPress());
  assert.equal(hosts(root, 'workspace-board').length, 1);
  // Demo data: the name is there but opens nothing (REQ-75 B1), and the ⋯ does not offer a board.
  const d = harness({ width: 1400 }), demo = await render(t, d.load('client/overview.tsx').OverviewScreen, d.props);
  await toggleDemo(demo);
  assert.ok(hosts(demo, 'workspace-name-link').length > 0);
  assert.ok(hosts(demo, 'workspace-name-link').every(l => l.props.accessibilityState.disabled === true));
  await act(async () => hosts(demo, 'lane-order-menu')[0].props.onPress());
  assert.equal(hosts(demo, 'order-open-board').length, 0);
});
test('REQ-67 ①②⑤ on 390px: the glyph beside ⋯, a faint "+N", ⋯ opens the board, and no "N more completed" button', async t => {
  const h = harness({ mobile: true });
  for (let i = 0; i < 5; i++) h.addCard({ ...add('Doing ' + i), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const cards = () => root.root.findAllByType('Pressable').filter(p => p.props.testID?.startsWith('kanban-card-')).length;
  assert.equal(cards(), 3);
  const toggle = () => sheetButton(root, 'lane-toggle');
  assert.equal(toggle().findByType('Icon').props.name, 'ChevronsUpDown');
  const row = toggle().parent.parent.parent;
  const ids = row.findAll(n => typeof n.type === 'string' && ['lane-toggle', 'lane-order-menu'].includes(n.props?.testID)).map(n => n.props.testID);
  assert.deepEqual(ids, ['lane-toggle', 'lane-order-menu'], 'the glyph sits right before ⋯');
  assert.equal(sheetButton(root, 'cell-more').findByType('Text').props.children, '+2');
  await act(async () => sheetButton(root, 'cell-more').props.onPress());
  assert.equal(cards(), 5); assert.equal(hosts(root, 'cell-more').length, 0);
  assert.equal(toggle().findByType('Icon').props.name, 'ChevronsDownUp');
  await act(async () => toggle().props.onPress());
  assert.equal(cards(), 3);
  assert.doesNotMatch(shownText(root), /more completed|Show all \(|Collapse/, 'no words, only the glyph');
  await act(async () => sheetButton(root, 'lane-order-menu').props.onPress());
  await act(async () => sheetButton(root, 'order-open-board').props.onPress());
  assert.equal(hosts(root, 'workspace-board').length, 1);
});
test('REQ-67 F1·F2/REQ-75 B2 on 390px: the glyph and ⋯ close the workspace heading, which keeps its 16px line; no "Board ›"', async t => {
  const h = harness({ mobile: true, platform: 'web', empty: ['wks_empty01'] });
  for (let i = 0; i < 5; i++) h.addCard({ ...add('Done ' + i), stageId: 'done' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  await act(async () => root.root.findByProps({ testID: 'mobile-tab-done' }).props.onPress());
  const section = () => hosts(root, 'mobile-workspace-heading')
    .find(n => n.findAll(v => v.props?.testID === 'lane-toggle' && typeof v.type === 'string').length);
  const heading = section();
  const ids = heading.findAll(n => typeof n.type === 'string' && ['done-board-link', 'lane-toggle', 'lane-order-menu'].includes(n.props?.testID))
    .map(n => n.props.testID);
  assert.deepEqual(ids, ['lane-toggle', 'lane-order-menu'], 'the glyph right before ⋯, both in the heading');
  const controls = heading.findAll(n => n.props?.testID === 'mobile-heading-controls' && typeof n.type === 'string')[0];
  assert.equal(heading.props.style.minHeight, 16, 'D1: the first card still starts at 168px');
  assert.equal(controls.props.style.height, 44); assert.equal(controls.props.style.marginVertical, -14, 'the 44px boxes hang over the line');
  assert.equal(sheetButton(root, 'lane-toggle').props.style.width, 32, 'a 44px touch target on 390px');
  // Nothing of this workspace is left under its cards: no old button, no second glyph or ⋯.
  const workspace = heading.parent, after = workspace.children.slice(workspace.children.indexOf(heading) + 1);
  assert.equal(after.flatMap(n => typeof n === 'string' ? [] : n.findAll(v => typeof v.type === 'string' &&
    ['lane-toggle', 'lane-order-menu', 'done-board-link'].includes(v.props?.testID))).length, 0);
  assert.equal(shownText(root).includes('Open workspace board'), false);
  assert.equal(hosts(root, 'done-board-link').length, 0);
  const link = heading.findAll(n => n.props?.testID === 'workspace-name-link' && typeof n.type === 'string')[0];
  assert.equal(link.props.accessibilityLabel, 'Open board: Example Workspace · Example Project · example-workspace');
  // F2: once opened the glyph still sits in the (pinned) heading, and folds the cards back from there.
  const cards = () => root.root.findAllByType('Pressable').filter(p => p.props.testID?.startsWith('kanban-card-')).length;
  assert.equal(cards(), 3);
  await act(async () => sheetButton(root, 'lane-toggle').props.onPress());
  assert.equal(cards(), 5);
  assert.equal(section().findAll(n => n.props?.testID === 'lane-toggle' && typeof n.type === 'string')[0].props.accessibilityLabel, 'Collapse');
  // REQ-75 B4 on 390px: "Collapse" where the "+2" was.
  assert.equal(allText(sheetButton(root, 'cell-collapse')), 'Collapse');
  await act(async () => sheetButton(root, 'cell-collapse').props.onPress());
  assert.equal(cards(), 3);
  await act(async () => section().findAll(n => n.props?.testID === 'workspace-name-link' && typeof n.type === 'string')[0].props.onPress());
  assert.equal(hosts(root, 'workspace-board').length, 1, 'the name opens that workspace board');
  // The heading ⋯ opens the board too, and the demo link is there but does nothing.
  const again = harness({ mobile: true }); again.addCard({ ...add('Done'), stageId: 'done' });
  const second = await render(t, again.load('client/overview.tsx').OverviewScreen, again.props);
  await act(async () => second.root.findByProps({ testID: 'mobile-tab-done' }).props.onPress());
  await act(async () => sheetButton(second, 'lane-order-menu').props.onPress());
  await act(async () => sheetButton(second, 'order-open-board').props.onPress());
  assert.equal(hosts(second, 'workspace-board').length, 1);
  const d = harness({ mobile: true }), demo = await render(t, d.load('client/overview.tsx').OverviewScreen, d.props);
  await toggleDemo(demo);
  await act(async () => demo.root.findByProps({ testID: 'mobile-tab-done' }).props.onPress());
  assert.ok(hosts(demo, 'workspace-name-link').length > 0);
  assert.ok(hosts(demo, 'workspace-name-link').every(l => l.props.accessibilityState.disabled === true));
});
test('REQ-67 ⑥ the list and the board ⋯ open the same settings window, which shows the server\'s values', async t => {
  const h = harness({ width: 1400, autoCards: false, uiSettings: { boardAlign: 'left' } });
  const { ListOverview } = h.load('client/overview.tsx');
  const list = await render(t, ListOverview, { ...h.props, onBoard: () => {} });
  await openSettings(list, 'automation');
  assert.equal(hosts(list, 'settings-window').length, 1, 'the wide window, as on the Kanban screen');
  assert.equal(sheetButton(list, 'auto-cards-toggle').props.accessibilityState.checked, false);
  await act(async () => sheetButton(list, 'settings-tab-display').props.onPress());
  assert.equal(sheetButton(list, 'board-align-left').props.accessibilityState.checked, true);
  await act(async () => sheetButton(list, 'settings-close').props.onPress());
  const b = harness({ width: 1400, autoCards: false });
  const { BoardScreen } = b.load('client/board.tsx');
  const board = await render(t, BoardScreen, { ...b.props, selector: { boardId: b.base.id }, onBack: () => {} });
  await openSettings(board, 'automation');
  assert.equal(sheetButton(board, 'auto-cards-toggle').props.accessibilityState.checked, false, 'board.get brought the switch');
  await act(async () => sheetButton(board, 'auto-cards-toggle').props.onPress());
  assert.deepEqual(b.auto.writes.map(w => w.enabled), [true]);
  assert.equal(sheetButton(board, 'auto-cards-toggle').props.accessibilityState.checked, true);
  // The workspace panel is a board too.
  const p = harness({ panel: true });
  const panel = await render(t, p.load('client/panel.tsx').WorkspacePanel, { ...p.props, workspaceId: 'wks_example01' });
  await act(async () => labelled(panel, 'More').props.onPress());
  assert.ok(sheetButton(panel, 'open-settings'));
});
test('REQ-67 ⑥ closing and reopening the settings window clears the last row errors', async t => {
  const h = harness({ width: 1600 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await openSettings(root, 'display');
  h.outcome('uiFailed');
  await act(async () => sheetButton(root, 'board-align-left').props.onPress());
  assert.equal(hosts(root, 'setting-error').length, 1);
  await act(async () => sheetButton(root, 'settings-close').props.onPress());
  await openSettings(root, 'display');
  assert.equal(hosts(root, 'setting-error').length, 0, 'the old error is gone');
  assert.equal(sheetButton(root, 'board-align-center').props.accessibilityState.checked, true, 'and the value is still the saved one');
  await act(async () => sheetButton(root, 'board-align-left').props.onPress());
  assert.equal(sheetButton(root, 'board-align-left').props.accessibilityState.checked, true, 'a new try works as before');
});

// REQ-68: the top right of the Kanban screens — no ⋯; refresh, +, the view and ⚙ as glyphs, the rest in settings.
/** What each control of a top row is: a testID, or the accessible name of the glyph an IconButton wraps. */
const rowControls = node => node.children.filter(n => typeof n !== 'string' && n.type !== 'Text')
  .map(n => n.props.testID ?? n.children?.find(c => c?.type === 'Pressable')?.props.accessibilityLabel ?? null).filter(Boolean);
test('REQ-68 ① the wide Kanban and list screens end their top row with refresh, +, the view switch and ⚙, and have no ⋯', async t => {
  const h = harness({ width: 1400, platform: 'web' }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props), before = h.calls.length;
  assert.equal(labelled(root, 'More'), undefined, 'no ⋯ on the Kanban screen');
  // REQ-81: "group by project" and the card order sit right before the view switch.
  // REQ-85 ⑦: and "fold all workspaces" beside the card order.
  assert.deepEqual(rowControls(nativeNode(root, 'swimlane-title-row')).slice(-7), ['Refresh', 'Create draft', 'Group by project',
    'Sort cards: Default (priority, then oldest)', 'Collapse all workspaces', 'view-switch', 'Kanban settings']);
  const glyphs = () => ['view-swimlane', 'view-list'].map(id => sheetButton(root, id));
  assert.deepEqual(glyphs().map(g => [g.props.accessibilityLabel, g.props.accessibilityState.checked]),
    [['View as swimlanes', true], ['View as list', false]], 'the current view is the checked one');
  assert.equal(sheetButton(root, 'view-switch').props.style.height, 30, 'as tall as the other glyphs: the row keeps its height');
  // REQ-85 ② (②C): the current view is filled with the main colour's tint and its glyph drawn in the main colour; no line.
  const pc = palette(h.props.theme), tint = selectedTint(pc, pc.surface0);
  assert.deepEqual(glyphs().map(g => [g.props.style.borderWidth, g.props.style.backgroundColor]), [[0, tint], [0, 'transparent']], 'the current view is tinted');
  assert.equal(glyphs()[0].findByType('Icon').props.color, selectedLine(pc, tint));
  // The label shows below the glyph on hover and focus (and is the accessible name without it).
  await act(async () => glyphs()[1].props.onHoverIn());
  assert.equal(hosts(root, 'icon-tooltip')[0].findAllByType('Text')[0].props.children, 'View as list');
  await act(async () => glyphs()[1].props.onHoverOut());
  assert.equal(hosts(root, 'icon-tooltip').length, 0);
  await act(async () => glyphs()[0].props.onPress());
  assert.equal(hosts(root, 'swimlane-screen').length, 1, 'pressing the current view does nothing');
  await act(async () => glyphs()[1].props.onPress());
  assert.equal(hosts(root, 'swimlane-screen').length, 0);
  assert.match(text(root), /Cards needing your attention/);
  assert.equal(labelled(root, 'More'), undefined, 'no ⋯ on the list screen either');
  assert.deepEqual(['view-swimlane', 'view-list'].map(id => sheetButton(root, id).props.accessibilityState.checked), [false, true]);
  const listRow = nativeNode(root, 'view-switch');
  assert.ok(listRow, 'the list shows the same switch');
  await act(async () => sheetButton(root, 'view-swimlane').props.onPress());
  assert.equal(hosts(root, 'swimlane-screen').length, 1);
  assert.ok(h.calls.slice(before).every(c => !/mutate|ensure|set$/.test(c.name)), 'switching views only reads');
  assert.equal(h.ui.writes.length, 0);
  // The demo has no list: its list glyph is disabled.
  await toggleDemo(root);
  assert.equal(sheetButton(root, 'view-list').props.accessibilityState.disabled, true);
});
test('REQ-68 ① ⚙ = the search field = the done column on the right edge, whatever the board position', async t => {
  for (const align of ['left', 'center', 'right']) {
    const h = harness({ width: 1920, platform: 'web', uiSettings: { boardAlign: align } }), { OverviewScreen } = h.load('client/overview.tsx');
    const root = await render(t, OverviewScreen, { ...h.props });
    const row = nativeNode(root, 'swimlane-title-row'), filter = nativeNode(root, 'swimlane-fixed-header');
    assert.equal(rowControls(row).at(-1), 'Kanban settings', '⚙ closes the title row');
    assert.equal(row.props.style.marginLeft, filter.props.style.marginLeft, align + ': one offset for the row and the filters');
    assert.equal(row.props.style.maxWidth, filter.props.style.maxWidth, align + ': and one right edge');
  }
});
test('REQ-68 ⑤ on 390px the top bars are 44px glyphs: filters, refresh, +, the other view, ⚙', async t => {
  for (const platform of ['web', 'ios']) {
    const h = harness({ mobile: true, platform }), { OverviewScreen } = h.load('client/overview.tsx');
    const root = await render(t, OverviewScreen, h.props);
    assert.equal(labelled(root, 'More'), undefined);
    const bar = nativeNode(root, 'mobile-appbar');
    assert.deepEqual(rowControls(bar), ['Filters and search', 'Refresh', 'Create draft', 'View as list', 'Kanban settings']);
    assert.ok(bar.children.slice(1).every(n => n.props.style.width === 44 && n.props.style.height === 44), 'each a 44px box');
    assert.equal(hosts(root, 'view-switch').length, 0, 'one glyph to the other view instead of the joined pair');
    await act(async () => sheetButton(root, 'open-filters').props.onPress());
    assert.ok(input(root, 'Search cards'), 'the filter sheet (projects included) opens from its glyph');
    await act(async () => { const native = root.root.findAllByType('NativeModal')[0];
      if (native) native.props.onRequestClose(); else root.root.findByType('Modal').props.onOpenChange(false); });
    const reads = h.calls.length;
    await act(async () => labelled(root, 'Refresh').props.onPress());
    assert.ok(h.calls.length > reads, 'refresh reads again');
    await act(async () => sheetButton(root, 'view-toggle').props.onPress());
    assert.match(text(root), /Cards needing your attention/);
    assert.equal(labelled(root, 'More'), undefined);
    assert.deepEqual(rowControls(nativeNode(root, 'list-title-row')),
      ['Projects (1/1)', 'Refresh', 'Create draft', 'View as swimlanes', 'Kanban settings']);
    await act(async () => sheetButton(root, 'view-toggle').props.onPress());
    assert.equal(hosts(root, 'mobile-swimlane-screen').length, 1);
    // REQ-91: filters on — the same glyph, on, with the number applied (no "Filters (1)" words any more).
    await act(async () => sheetButton(root, 'open-filters').props.onPress());
    await act(async () => input(root, 'Search cards').props.onChangeText('Example'));
    await act(async () => { const native = root.root.findAllByType('NativeModal')[0];
      if (native) native.props.onRequestClose(); else root.root.findByType('Modal').props.onOpenChange(false); });
    assert.equal(wordButtons(root, 'Filters (1)'), 0);
    assert.equal(sheetButton(root, 'open-filters').props.accessibilityLabel, 'Filters: 1 applied');
    assert.equal(allText(hosts(root, 'open-filters-badge')[0]), '1');
  }
});
test('REQ-68 ① what ⋯ held works from the settings window: the demo switch and the order reset', async t => {
  const h = harness({ width: 1400, order: { projects: [], workspaces: ['wks_example01'] } }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  devDemo(); // REQ-69: the demo row is behind the developer entry (its absence without it: the REQ-69 test).
  await openSettings(root, 'about');
  const demo = () => sheetButton(root, 'demo-toggle');
  assert.equal(demo().props.accessibilityState.checked, false);
  assert.deepEqual(hosts(root, 'setting-demo')[0].findAllByType('Text').map(n => n.props.children).slice(0, 2),
    ['Demo data', 'Shows sample boards to look around Kanban. Nothing is saved while it is on.']);
  await act(async () => demo().props.onPress());
  assert.equal(hosts(root, 'demo-banner').length, 1, 'the demo shows behind the window');
  assert.equal(demo().props.accessibilityState.checked, true);
  assert.equal(demo().props.accessibilityState.disabled, false, 'the switch still works in the demo, to turn it off');
  await act(async () => demo().props.onPress());
  assert.equal(hosts(root, 'demo-banner').length, 0);
  await act(async () => sheetButton(root, 'settings-tab-display').props.onPress());
  assert.deepEqual(['setting-board-align', 'setting-order-reset', 'setting-theme'].map(id => hosts(root, id).length), [1, 1, 1]);
  assert.equal(sheetButton(root, 'order-reset-all').props.accessibilityState.disabled, false);
  await act(async () => sheetButton(root, 'order-reset-all').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).order, { projects: [], workspaces: [], flatWorkspaces: [] }, 'one write releases every order');
  assert.equal(sheetButton(root, 'order-reset-all').props.accessibilityState.disabled, true, 'nothing left to reset');
  assert.equal(h.ui.writes.length, 1);
  // The list screen's window offers both too; its demo switch shows the demo on the Kanban screen.
  const l = harness({ width: 1400, order: { projects: [], workspaces: ['wks_example01'] } }); devDemo();
  const shown = await render(t, l.load('client/overview.tsx').OverviewScreen, l.props);
  await act(async () => sheetButton(shown, 'view-list').props.onPress());
  await openSettings(shown, 'display');
  await act(async () => sheetButton(shown, 'order-reset-all').props.onPress());
  assert.deepEqual(l.ui.writes.at(-1).order, { projects: [], workspaces: [], flatWorkspaces: [] });
  await act(async () => sheetButton(shown, 'settings-tab-about').props.onPress());
  await act(async () => sheetButton(shown, 'demo-toggle').props.onPress());
  assert.equal(hosts(shown, 'demo-banner').length, 1); assert.equal(hosts(shown, 'swimlane-screen').length, 1);
  // A board has no demo and no order of its own: neither row, the theme row stays.
  const { BoardScreen } = h.load('client/board.tsx');
  const board = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id }, onBack: () => {} });
  await act(async () => board.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  await openSettings(board, 'display');
  assert.deepEqual(['setting-order-reset', 'setting-theme'].map(id => hosts(board, id).length), [0, 1]);
  await act(async () => sheetButton(board, 'settings-tab-about').props.onPress());
  assert.equal(hosts(board, 'setting-demo').length, 0);
  assert.equal(hosts(board, 'setting-version').length, 1);
});
// REQ-70 replaces REQ-68 ④ (a read-only "Follows Paseo" row): the user asked on 09-24 for the theme to lead the
// display settings with four choices. The harness host theme is dark (#222222 everywhere).
const themeRadios = root => ['light', 'dark', 'system', 'paseo'].map(id => sheetButton(root, 'theme-' + id));
const checkedTheme = root => themeRadios(root).find(r => r.props.accessibilityState.checked)?.props.testID;
const screenBackground = (root, id) => sheetButton(root, id).props.style.backgroundColor;
test('REQ-70 ① the theme leads the display settings: four glyphs with words, Paseo chosen until another is', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await openSettings(root, 'display');
  const rows = hosts(root, 'settings-category-display')[0].findAll(n => typeof n.type === 'string' && /^setting-/.test(n.props?.testID ?? ''));
  assert.equal(rows[0].props.testID, 'setting-theme', 'the first row');
  // REQ-139: the screen size follows the theme.
  assert.deepEqual(rows.map(r => r.props.testID), ['setting-theme', 'setting-ui-scale', 'setting-board-align', 'setting-order-reset']);
  const row = hosts(root, 'setting-theme')[0];
  assert.deepEqual(row.findAllByType('Text').map(n => n.props.children), ['Theme',
    'The colors of the Kanban screens. Paseo\'s sidebar and header keep Paseo\'s theme.', 'Light', 'Dark', 'System', 'Paseo']);
  assert.deepEqual(row.findAllByType('Icon').map(n => n.props.name), ['Sun', 'Moon', 'Monitor', 'AppWindow']);
  assert.equal(row.findAll(n => n.props?.role === 'radiogroup' && typeof n.type === 'string').length, 1);
  assert.deepEqual(themeRadios(root).map(r => [r.props.accessibilityLabel, r.props.accessibilityHint]), [
    ['Light', 'Always light'], ['Dark', 'Always dark'], ['System', 'Follows your device\'s light or dark setting'],
    ['Paseo', 'Follows the theme set in Paseo']]);
  assert.equal(checkedTheme(root), 'theme-paseo', 'the default');
  // The hint shows on hover or focus, below the glyph.
  await act(async () => sheetButton(root, 'theme-system').props.onHoverIn());
  assert.deepEqual(hosts(root, 'theme-tooltip').map(n => n.findByType('Text').props.children), ['Follows your device\'s light or dark setting']);
  await act(async () => sheetButton(root, 'theme-system').props.onHoverOut());
  assert.equal(hosts(root, 'theme-tooltip').length, 0);
  const { copy } = h.load('client/i18n.ts'), ko = copy('ko');
  assert.deepEqual([ko.theme, ko.themeLight, ko.themeDark, ko.themeSystem, ko.themePaseo, ko.themeHelp],
    ['테마', '라이트', '다크', '시스템', 'Paseo', '칸반 화면의 색입니다. Paseo 사이드바와 머리글은 Paseo 테마 그대로입니다.']);
  assert.deepEqual([ko.themeLightHint, ko.themeDarkHint, ko.themeSystemHint, ko.themePaseoHint],
    ['항상 라이트', '항상 다크', '기기의 라이트·다크 설정을 따릅니다', 'Paseo에서 고른 테마를 따릅니다']);
  assert.deepEqual([ko.swimlaneView, ko.listView], ['스윔레인으로 보기', '목록으로 보기']);
});
test('REQ-70 ②③ a choice repaints the screen and its window at once; the host mode keeps the host colours', async t => {
  const h = harness({ width: 1400, colorScheme: 'light' }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await openSettings(root, 'display');
  assert.equal(screenBackground(root, 'swimlane-screen'), '#222222');
  await act(async () => sheetButton(root, 'theme-light').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).settings, { theme: 'light' }, 'one field, so no other row is overwritten');
  assert.equal(checkedTheme(root), 'theme-light');
  assert.deepEqual([screenBackground(root, 'swimlane-screen'), screenBackground(root, 'settings-window')], ['#ffffff', '#ffffff'],
    'Paseo\'s default light set');
  // Dark on a dark host is the host's own colours, not the built-in dark set.
  await act(async () => sheetButton(root, 'theme-dark').props.onPress());
  assert.deepEqual([screenBackground(root, 'swimlane-screen'), screenBackground(root, 'settings-window')], ['#222222', '#222222']);
  // System follows the device, and changes with it.
  await act(async () => sheetButton(root, 'theme-system').props.onPress());
  assert.equal(screenBackground(root, 'swimlane-screen'), '#ffffff');
  await h.scheme('dark');
  assert.equal(screenBackground(root, 'swimlane-screen'), '#222222');
  await h.scheme('light');
  assert.equal(screenBackground(root, 'settings-window'), '#ffffff');
  await h.scheme(null);
  assert.equal(screenBackground(root, 'swimlane-screen'), '#222222', 'a device that does not say: the host');
  await act(async () => sheetButton(root, 'theme-paseo').props.onPress());
  assert.equal(screenBackground(root, 'swimlane-screen'), '#222222');
  assert.deepEqual(h.ui.writes.map(w => w.settings.theme), ['light', 'dark', 'system', 'paseo']);
  // Paseo is the host theme exactly, so a host theme change still repaints it.
  await h.scheme('light');
  const next = { ...h.props, theme: { colors: { ...h.props.theme.colors, surface0: '#101010' } } };
  await act(async () => root.update(React.createElement(OverviewScreen, next)));
  assert.equal(screenBackground(root, 'settings-window'), '#101010');
  // The list screen and what it opens use the same choice.
  await act(async () => sheetButton(root, 'theme-light').props.onPress());
  await closeSettings(root);
  await act(async () => sheetButton(root, 'view-list').props.onPress());
  assert.equal(root.root.findAll(n => n.props?.testID === 'list-title-row').length > 0, true);
  const list = root.root.findAll(n => typeof n.type === 'string' && n.props?.style?.backgroundColor === '#ffffff');
  assert.ok(list.length > 0, 'the list screen is light too');
});
test('REQ-70 ② the choice is remembered per host with the other settings, and a board or panel obeys it', async t => {
  const h = harness({ width: 1400, hiddenProjects: ['prj_hidden'], uiSettings: { boardAlign: 'left', autoRefresh: false, theme: 'light' } });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  assert.equal(screenBackground(root, 'swimlane-screen'), '#ffffff', 'reopened in the saved theme');
  await openSettings(root, 'display');
  assert.equal(checkedTheme(root), 'theme-light');
  assert.equal(sheetButton(root, 'board-align-left').props.accessibilityState.checked, true);
  await act(async () => sheetButton(root, 'theme-system').props.onPress());
  assert.deepEqual(h.ui.value.settings, { boardAlign: 'left', autoRefresh: false, theme: 'system' });
  assert.deepEqual(h.ui.value.hiddenProjects, ['prj_hidden'], 'the filter stays');
  // A workspace panel opened on its own reads the host's settings from its board read.
  const p = harness({ width: 1400, uiSettings: { theme: 'light' } }), { BoardScreen } = p.load('client/board.tsx');
  const board = await render(t, BoardScreen, { ...p.props, selector: { boardId: p.base.id }, panel: true });
  await act(async () => board.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  assert.equal(screenBackground(board, 'workspace-board'), '#ffffff');
  // A failed save keeps the old choice and says so on the row; retrying saves it.
  p.outcome('uiFailed');
  await openSettings(board, 'display');
  await act(async () => sheetButton(board, 'theme-paseo').props.onPress());
  assert.equal(checkedTheme(board), 'theme-light');
  assert.equal(screenBackground(board, 'workspace-board'), '#ffffff');
  assert.equal(hosts(board, 'setting-theme')[0].findAll(n => n.props?.testID === 'setting-error' && typeof n.type === 'string').length, 1);
  await act(async () => hosts(board, 'setting-theme')[0].findAll(n => n.props?.testID === 'setting-retry' && typeof n.type === 'string')[0].props.onPress());
  assert.equal(checkedTheme(board), 'theme-paseo');
  assert.equal(screenBackground(board, 'workspace-board'), '#222222');
});
// F1 (gate 78): the board under the Kanban screen resolves the theme a second time, so two device listeners
// ran; the first one's update re-rendered the board and dropped the board's listener before it was called.
test('REQ-70 F1 System follows every device change on a board, in its settings window and in a workspace panel', async t => {
  const hosts_ = [['a dark host', '#222222', 'light', 'dark', '#ffffff'], ['a light host', '#fafafa', 'dark', 'light', '#181B1A']];
  for (const [label, hostPage, start, same, other] of hosts_) {
    const h = harness({ width: 1400, colorScheme: start, uiSettings: { theme: 'system' } });
    const props = { ...h.props, theme: { colors: { ...h.props.theme.colors, surface0: hostPage } } };
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, props);
    await act(async () => sheetButton(root, 'workspace-name-link').props.onPress());
    await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
    assert.equal(screenBackground(root, 'workspace-board'), other, label + ': the board opens in the device mode');
    // The window opened from the board re-renders the board alone first, as the board's own reads do.
    await openSettings(root, 'display');
    await h.scheme(same);
    assert.deepEqual([screenBackground(root, 'workspace-board'), screenBackground(root, 'settings-window')], [hostPage, hostPage],
      label + ': the board and its window follow the device');
    await closeSettings(root);
    await h.scheme(start);
    assert.equal(screenBackground(root, 'workspace-board'), other, label + ': and back, with the window closed');
    await h.scheme(same);
    assert.equal(screenBackground(root, 'workspace-board'), hostPage, label + ': every time');
    // Back on the Kanban screen it still follows.
    await act(async () => sheetButton(root, 'board-breadcrumb').props.onPress());
    await h.scheme(start);
    assert.equal(screenBackground(root, 'swimlane-screen'), other, label + ': the Kanban screen too');
  }
  // A workspace panel resolves it once, on its own.
  const p = harness({ width: 1400, colorScheme: 'light', uiSettings: { theme: 'system' } });
  const panel = await render(t, p.load('client/board.tsx').BoardScreen, { ...p.props, selector: { boardId: p.base.id }, panel: true });
  await act(async () => panel.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  await openSettings(panel, 'display');
  await p.scheme('dark');
  assert.deepEqual([screenBackground(panel, 'workspace-board'), screenBackground(panel, 'settings-window')], ['#222222', '#222222']);
  await p.scheme('light');
  assert.deepEqual([screenBackground(panel, 'workspace-board'), screenBackground(panel, 'settings-window')], ['#ffffff', '#ffffff']);
});
test('REQ-68 ② the board top bar: refresh, +, ↗ workspace, ⚙ — no ⋯; only the narrow panel keeps one', async t => {
  const h = harness({ width: 1400, platform: 'web' }), { BoardScreen } = h.load('client/board.tsx'), opened = [];
  const props = { ...h.props, navigation: { openWorkspace: target => opened.push(target) }, selector: { boardId: h.base.id }, onBack: () => {} };
  const root = await render(t, BoardScreen, props);
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  assert.equal(labelled(root, 'More'), undefined);
  // REQ-79: the card order on a wide board too.
  assert.deepEqual(rowControls(nativeNode(root, 'board-appbar')), ['Refresh', 'Create draft', 'Sort cards: Default (priority, then oldest)',
    'Open workspace', 'Kanban settings']);
  await act(async () => sheetButton(root, 'open-workspace').props.onPress());
  assert.deepEqual(opened, [{ workspaceId: 'wks_example01' }]);
  await act(async () => sheetButton(root, 'open-settings').props.onPress());
  assert.equal(hosts(root, 'settings-window').length, 1);
  // A phone board: the same glyphs at 44px after ‹ (refresh was only in ⋯ there).
  const phone = harness({ mobile: true }), p = await render(t, phone.load('client/board.tsx').BoardScreen,
    { ...phone.props, navigation: { openWorkspace: () => {} }, selector: { boardId: phone.base.id }, onBack: () => {} });
  await act(async () => p.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
  const bar = nativeNode(p, 'board-appbar');
  assert.deepEqual(rowControls(bar).filter(v => v !== 'Back to all boards'), ['Refresh', 'Create draft', 'Open workspace', 'Kanban settings']);
  assert.ok(bar.children.filter(n => n.props.style?.width === 44).length >= 5, '‹ and four 44px glyphs');
  // The narrow workspace panel has no top bar; its one slot keeps ⋯ with create, refresh and settings.
  const w = harness({ panel: true });
  const panel = await render(t, w.load('client/panel.tsx').WorkspacePanel, { ...w.props, workspaceId: 'wks_example01' });
  await act(async () => labelled(panel, 'More').props.onPress());
  const items = hosts(panel, 'menu-sheet').length ? hosts(panel, 'menu-sheet')[0] : panel.root.findByType('Modal');
  assert.deepEqual(items.findAllByType('Pressable').map(p => p.props.accessibilityLabel ?? p.findAllByType('Text')[0]?.props.children)
    .filter(v => !['Close', 'More'].includes(v)), ['Create draft', 'Refresh', 'Kanban settings…']);
});
test('REQ-68 the list folds its attention section from the heading (once "Workspace progress" in ⋯)', async t => {
  const h = harness({ width: 1400 }), { ListOverview } = h.load('client/overview.tsx');
  const list = await render(t, ListOverview, { ...h.props, onBoard: () => {} });
  const fold = () => sheetButton(list, 'attention-fold');
  assert.equal(fold().props.accessibilityLabel, 'Collapse cards needing your attention');
  assert.match(text(list), /Example card/);
  await act(async () => fold().props.onPress());
  assert.doesNotMatch(text(list), /Example card/, 'the attention cards fold away');
  assert.match(text(list), /Cards needing your attention/, 'the heading stays to bring them back');
  assert.match(text(list), /Workspace progress/);
  assert.equal(fold().props.accessibilityLabel, 'Expand cards needing your attention');
  await act(async () => fold().props.onPress());
  assert.match(text(list), /Example card/);
});

// REQ-69: the demo is for tests and headless checks only; About shows the host and the last read instead.
const clock = iso => { const d = new Date(iso), pad = n => String(n).padStart(2, '0'); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
test('REQ-69 ① without the developer entry no screen offers the demo; About says the host and when it last read', async t => {
  const screens = [['wide swimlane', { width: 1400 }, false], ['wide list', { width: 1400 }, true],
    ['390 web', { mobile: true, platform: 'web' }, false], ['390 ios', { mobile: true, platform: 'ios' }, false]];
  for (const [name, options, list] of screens) {
    const h = harness(options), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    if (list) await act(async () => sheetButton(root, options.mobile ? 'view-toggle' : 'view-list').props.onPress());
    await openSettings(root, 'about');
    assert.deepEqual(['setting-demo', 'demo-toggle'].map(id => hosts(root, id).length), [0, 0], name + ': no demo row');
    assert.deepEqual(['setting-connection', 'setting-version'].map(id => hosts(root, id).length), [1, 1], name);
    assert.deepEqual(hosts(root, 'setting-connection')[0].findAllByType('Text').map(n => n.props.children),
      ['Connected host', 'Example host · Last checked ' + clock(h.base.updatedAt)], name);
    assert.equal(hosts(root, 'demo-banner').length, 0, name);
  }
  // The board's window says the same, from the board's own read.
  const h = harness({ width: 1400 }), { BoardScreen } = h.load('client/board.tsx');
  const board = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id }, onBack: () => {} });
  await act(async () => board.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  await openSettings(board, 'about');
  assert.equal(sheetButton(board, 'settings-connection').props.children, 'Example host · Last checked ' + clock(h.base.updatedAt));
  const { copy } = h.load('client/i18n.ts');
  assert.deepEqual([copy('ko').connectedHost, copy('ko').lastCheckedAt('09:04')], ['연결된 호스트', '마지막 확인 09:04']);
});
test('REQ-69 ② the developer entry turns the demo on and off, and the switch stays to turn it off', async t => {
  const h = harness({ width: 1400 }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const { DEV_DEMO_KEY, devDemoEntry } = h.load('client/demo.ts');
  assert.equal(DEV_DEMO_KEY, 'paseo-kanban:dev-demo'); assert.equal(devDemoEntry(), false);
  devDemo(); assert.equal(devDemoEntry(), true);
  await openSettings(root, 'about');
  await act(async () => sheetButton(root, 'demo-toggle').props.onPress());
  assert.equal(hosts(root, 'demo-banner').length, 1);
  assert.equal(sheetButton(root, 'settings-connection').props.children, 'Example host', 'the demo reads nothing, so no time');
  devStorage.clear();
  await act(async () => sheetButton(root, 'settings-tab-display').props.onPress());
  await act(async () => sheetButton(root, 'settings-tab-about').props.onPress());
  assert.equal(sheetButton(root, 'demo-toggle').props.accessibilityState.checked, true, 'a demo that is on can always be turned off');
  await act(async () => sheetButton(root, 'demo-toggle').props.onPress());
  assert.equal(hosts(root, 'demo-banner').length, 0);
  assert.equal(hosts(root, 'setting-demo').length, 0, 'and once off, it is gone without the entry');
  // Storage that cannot be read (a native host, a locked-down browser) is no entry.
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => { throw new Error('denied'); } };
  t.after(() => { globalThis.localStorage = saved; });
  assert.equal(devDemoEntry(), false);
  delete globalThis.localStorage; assert.equal(devDemoEntry(), false);
});

// REQ-71: the phone's control row reads [stage tabs] │ [attention], and the list's attention section is one line a card.
const CONTROL_PARTS = ['mobile-stage-tabs', 'mobile-control-divider', 'mobile-attention-chip', 'panel-actions'];
function controlOrder(root) {
  const out = [], walk = node => { if (!node || typeof node === 'string') return; if (Array.isArray(node)) return node.forEach(walk);
    if (CONTROL_PARTS.includes(node.props?.testID)) out.push(node.props.testID); walk(node.children); };
  walk(nativeNode(root, 'mobile-control-row')); return out;
}
test('REQ-71 ① the phone row puts the four stage tabs left and a 76px, tab-high attention chip right past a divider', async t => {
  const h = harness({ mobile: true, platform: 'web' }), { MobileControls } = h.load('client/mobile-controls.tsx');
  const { copy } = h.load('client/i18n.ts'), c = palette(h.props.theme);
  const stages = ['todo', 'doing', 'review', 'done'].map((stageId, i) => ({ stageId, name: stageId, count: i }));
  const row = await render(t, MobileControls, { width: 390, stages, selected: 'doing', attention: false, count: 9,
    onStage: () => {}, onAttention: () => {}, colors: c, m: copy('ko') });
  assert.deepEqual(controlOrder(row), ['mobile-stage-tabs', 'mobile-control-divider', 'mobile-attention-chip']);
  const chip = row.root.findByProps({ testID: 'mobile-attention-chip' }), face = row.root.findByProps({ testID: 'mobile-chip-face' });
  assert.equal(chip.props.style.width, 76); assert.equal(chip.props.style.height, 44);
  const tabs = row.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab');
  assert.deepEqual(tabs.map(p => p.props.testID), ['mobile-tab-todo', 'mobile-tab-doing', 'mobile-tab-review', 'mobile-tab-done']);
  assert.ok(row.root.findAllByProps({ testID: 'mobile-tab-face' }).every(v => v.props.style.height === face.props.style.height));
  assert.equal(face.props.style.height, 36);
  // The tabs share what is left evenly and stay touchable: 390 − 16 padding = 4 tabs + 4 + 1 divider + 4 + 76.
  assert.ok(tabs.every(p => p.props.style.width === tabs[0].props.style.width && p.props.style.height === 44));
  assert.equal(tabs[0].props.style.width, (374 - 85) / 4); assert.ok(tabs[0].props.style.width > 67, 'wider than with the 104px chip');
  const divider = row.root.findByProps({ testID: 'mobile-control-divider' });
  assert.equal(divider.props.style.width, 1); assert.equal(divider.props.style.backgroundColor, c.divider);
  assert.equal(chip.props.accessibilityLabel, '확인 필요 9');

  // English words need more room: the chip keeps them whole and the tabs still get at least 44px.
  const en = await render(t, MobileControls, { width: 390, stages, selected: 'doing', attention: true, count: 12,
    onStage: () => {}, onAttention: () => {}, colors: c, m: copy('en') });
  assert.equal(en.root.findByProps({ testID: 'mobile-attention-chip' }).props.style.width, 104);
  assert.ok(en.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab').every(p => p.props.style.width >= 44));
  assert.equal(en.root.findByProps({ testID: 'mobile-chip-face' }).props.style.backgroundColor, c.surface2, 'on reads as selected');
});
test('REQ-71 ① the same order on the 390 Kanban screen, the phone board and the narrow workspace panel', async t => {
  const s = harness({ mobile: true }), screen = await render(t, s.load('client/overview.tsx').OverviewScreen, s.props);
  assert.deepEqual(controlOrder(screen), ['mobile-stage-tabs', 'mobile-control-divider', 'mobile-attention-chip']);
  const count = s.calls.length;
  await act(async () => screen.root.findByProps({ testID: 'mobile-attention-chip' }).props.onPress());
  assert.equal(screen.root.findByProps({ testID: 'mobile-attention-chip' }).props.accessibilityState.selected, true);
  assert.equal(s.calls.length, count, 'the chip still filters locally');
  const b = harness({ mobile: true }), phone = await render(t, b.load('client/board.tsx').BoardScreen, { ...b.props, selector: { boardId: b.base.id } });
  assert.deepEqual(controlOrder(phone), ['mobile-stage-tabs', 'mobile-control-divider', 'mobile-attention-chip']);
  const p = harness({ width: 600, panel: true }), panel = await render(t, p.load('client/panel.tsx').WorkspacePanel,
    { ...p.props, context: 'workspace', workspaceId: p.base.workspaceId });
  await act(async () => panel.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 600 } } }));
  assert.deepEqual(controlOrder(panel), ['mobile-stage-tabs', 'mobile-control-divider', 'mobile-attention-chip', 'panel-actions']);
  assert.ok(panel.root.findAllByType('Pressable').filter(v => v.props.accessibilityRole === 'tab').every(v => v.props.style.width >= 44));
});
test('REQ-71 ② the list attention section is one line a card: glyph, one-line title, small workspace; opens the card', async t => {
  for (const [name, options, rows, height] of [['wide', { width: 1400 }, 3, 32], ['phone', { mobile: true, platform: 'web' }, 2, 44]]) {
    const h = harness(options);
    for (let i = 0; i < 4; i++) h.addCard({ ...add(`Waiting on a reply ${i} with a title long enough to need cutting to one line`), awaiting: 'user' });
    const list = await render(t, h.load('client/overview.tsx').ListOverview, { ...h.props, onBoard: () => {} });
    const shown = () => list.root.findAllByProps({ testID: 'attention-row' }).filter(n => n.props.accessibilityRole === 'button');
    assert.equal(shown().length, rows, name + ': the "show all" rule is unchanged');
    for (const row of shown()) {
      assert.equal(row.props.style.minHeight, height, name);
      assert.equal(row.props.style.flexDirection, 'row', name + ': one line');
      const texts = row.findAllByType('Text');
      assert.equal(texts.length, 2, name + ': title and workspace only');
      assert.equal(texts[0].props.numberOfLines, 1); assert.equal(texts[0].props.style.flex, 1);
      assert.equal(texts[1].props.numberOfLines, 1); assert.equal(texts[1].props.children, 'Example Workspace');
      assert.ok(texts[1].props.style.fontSize < texts[0].props.style.fontSize, name + ': the workspace is small');
      assert.equal(row.findAllByType('Icon').length, 1, name + ': the reason glyph');
      assert.match(row.props.accessibilityHint, /Response needed/, name + ': the reason is still said');
    }
    assert.doesNotMatch(text(list), /Check the result/, name + ': the next action is in the card it opens');
    await act(async () => button(list, 'Show all').props.onPress());
    assert.equal(shown().length, 5, name);
    await act(async () => button(list, 'Show less').props.onPress());
    assert.equal(shown().length, rows, name);
    await act(async () => shown()[0].props.onPress());
    assert.equal(h.calls.filter(c => c.name.endsWith('card.get')).length, 1, name + ': a row opens the card as before');
  }
});

// REQ-72 (user's phone, 09-24, after D26): the host sheets kept the host's background, grab handle and title bar, so the
// settings, the card and every menu stayed in Paseo's colours whatever the Kanban theme. Every window is Kanban's own
// now (KanbanSheet, or the wide windows drawn before): background, handle, title bar and content from the chosen set.
const flatStyle = style => Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : (style ?? {});
/**
 * Every Text and TextInput under `sheet` whose colour does not read on the nearest background behind it (`page`
 * when nothing inside paints one): 4.5:1, or 3:1 for large text. Disabled (dimmed) controls are exempt, as in WCAG.
 */
function unreadable(sheet, page) {
  const bad = [];
  for (const node of sheet.findAll(n => n.type === 'Text' || n.type === 'TextInput')) {
    let color, background, dimmed = false, size = 14, bold = false;
    for (let p = node; p && p !== sheet; p = p.parent) {
      if (typeof p.type !== 'string') continue;
      const style = flatStyle(p.props.style);
      if (style.opacity !== undefined && style.opacity < 1) dimmed = true;
      if ((p.type === 'Text' || p.type === 'TextInput') && color === undefined && style.color) {
        color = style.color; size = style.fontSize ?? size; bold = ['600', '700', 'bold'].includes(String(style.fontWeight));
      }
      if (background === undefined && style.backgroundColor && style.backgroundColor !== 'transparent') background = style.backgroundColor;
    }
    if (color === undefined || dimmed) continue;
    const needed = size >= 18 || (size >= 14 && bold) ? 3 : 4.5, ratio = contrast(color, background ?? page);
    if (ratio < needed) bad.push(`${JSON.stringify(node.props.children ?? node.props.accessibilityLabel)} ${color} on ${background ?? page}: ${ratio.toFixed(2)}`);
  }
  return bad;
}
/** The one Kanban window open: a sheet or menu (KanbanSheet) or a wide window. There is never a host sheet. */
const WINDOWS = ['menu-sheet', 'editor-sheet', 'settings-sheet', 'settings-window', 'desktop-detail-dialog'];
function kanbanWindow(root) {
  assert.equal(root.root.findAllByType('Modal').length, 0, 'no host sheet');
  const open = WINDOWS.flatMap(id => hosts(root, id));
  assert.equal(open.length, 1, 'one Kanban window open: ' + open.map(n => n.props.testID));
  return open[0];
}
const closeWindow = async root => act(async () => root.root.findAllByType('NativeModal').at(-1).props.onRequestClose());
// Every theme choice on a light and a dark host; System follows a device scheme opposite to the host.
const REQ72_COMBOS = ['light', 'dark'].flatMap(hostMode => ['light', 'dark', 'system', 'paseo'].map(theme => {
  const device = theme === 'system' ? (hostMode === 'light' ? 'dark' : 'light') : null;
  const chosen = palette(resolveTheme(PASEO_THEMES[hostMode], theme, device));
  return { label: `host ${hostMode} · Kanban ${theme}${device ? ' (device ' + device + ')' : ''}`, hostMode, uiSettings: { theme }, device, chosen };
}));
/** The window is drawn from the chosen set only, its background is the chosen page, and everything on it reads. */
function oneSet(root, combo, what, sheet = true) {
  const win = kanbanWindow(root), page = combo.chosen.surface0, chosen = Object.values(combo.chosen);
  // REQ-85 ③: a chosen row's tint is made of the chosen set too — its main colour mixed into one of its surfaces.
  const set = new Set([...chosen, ...chosen.filter(v => typeof v === 'string' && v.startsWith('#')).flatMap(v => [selectedTint(combo.chosen, v),
    // REQ-88 ②: a field's faint edge — the set's border moved toward its own text colour.
    fieldLine(combo.chosen, v)])]);
  const style = flatStyle(win.props.style);
  assert.equal(style.backgroundColor, page, combo.label + ' · ' + what + ': the window background is the chosen page');
  assert.equal(hosts(root, 'sheet-handle').length, sheet ? 1 : 0, combo.label + ' · ' + what + (sheet ? ': a grab handle' : ': no handle'));
  assert.deepEqual(unreadable(win, page), [], combo.label + ' · ' + what);
  const painted = win.findAll(n => typeof n.type === 'string').flatMap(n => { const s = flatStyle(n.props.style);
    return [s.color, s.backgroundColor, s.borderColor].filter(v => typeof v === 'string' && v.startsWith('#')); });
  assert.ok(painted.length > 3, what);
  assert.deepEqual([...new Set(painted.filter(v => !set.has(v)))], [], combo.label + ' · ' + what + ': the chosen set only');
}
test('REQ-72 ① on a phone every window — settings, filters, order ⋯, create, card, projects — is a Kanban sheet in the chosen theme', async t => {
  for (const platform of ['android', 'web']) for (const combo of REQ72_COMBOS) {
    const h = harness({ mobile: true, platform, uiSettings: combo.uiSettings, colorScheme: combo.device });
    h.addCard({ ...add('In flight'), stageId: 'doing' }); // the phone opens on the in-progress tab
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, theme: PASEO_THEMES[combo.hostMode] });
    const label = { ...combo, label: combo.label + ' · ' + platform + ' 390' };
    assert.equal(screenBackground(root, 'mobile-swimlane-screen'), combo.chosen.surface0, label.label + ': the screen');
    await openSettings(root);
    oneSet(root, label, 'settings categories');
    for (const category of ['display', 'automation', 'about']) {
      await act(async () => sheetButton(root, 'settings-open-' + category).props.onPress());
      oneSet(root, label, 'settings ' + category);
      await act(async () => sheetButton(root, 'settings-back').props.onPress());
    }
    await closeWindow(root);
    for (const [what, open] of [['filters', () => sheetButton(root, 'open-filters')], ['order ⋯', () => sheetButton(root, 'lane-order-menu')],
      ['create', () => labelled(root, 'Create draft')],
      ['card detail', () => root.root.findAllByType('Pressable').find(p => p.props.testID?.startsWith('kanban-card-'))]]) {
      await act(async () => open().props.onPress());
      oneSet(root, label, what);
      await closeWindow(root);
      assert.equal(root.root.findAllByType('NativeModal').length, 0, label.label + ' · ' + what + ' closes');
    }
    await act(async () => sheetButton(root, 'view-toggle').props.onPress());
    await act(async () => sheetButton(root, 'projects-button').props.onPress());
    oneSet(root, label, 'projects');
    await closeWindow(root);
  }
});
test('REQ-72 ① a workspace panel on a phone: ⋯, settings and the card are Kanban sheets in the chosen theme', async t => {
  for (const combo of REQ72_COMBOS) {
    const p = harness({ mobile: true, platform: 'android', uiSettings: combo.uiSettings, colorScheme: combo.device });
    const panel = await render(t, p.load('client/board.tsx').BoardScreen,
      { ...p.props, theme: PASEO_THEMES[combo.hostMode], selector: { boardId: p.base.id }, panel: true });
    await act(async () => panel.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
    assert.equal(screenBackground(panel, 'workspace-board'), combo.chosen.surface0, combo.label + ': the panel');
    await act(async () => labelled(panel, 'More').props.onPress());
    oneSet(panel, combo, 'panel ⋯');
    await act(async () => button(panel, 'Kanban settings…').props.onPress());
    await act(async () => sheetButton(panel, 'settings-open-display').props.onPress());
    oneSet(panel, combo, 'panel settings');
    await closeWindow(panel);
    await act(async () => labelled(panel, 'Example card').props.onPress());
    oneSet(panel, combo, 'panel card detail');
  }
});
test('REQ-72 ① at 1400 the settings window, the draft and the card are Kanban windows in the chosen theme (no handle)', async t => {
  for (const combo of REQ72_COMBOS) {
    const h = harness({ width: 1400, uiSettings: combo.uiSettings, colorScheme: combo.device });
    h.addCard({ ...add('In flight'), stageId: 'doing' });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, theme: PASEO_THEMES[combo.hostMode] });
    const label = { ...combo, label: combo.label + ' · 1400' };
    for (const category of ['display', 'automation', 'about']) {
      await openSettings(root, category);
      oneSet(root, label, 'settings ' + category, false);
      await closeSettings(root);
    }
    await act(async () => labelled(root, 'Create draft').props.onPress());
    oneSet(root, label, 'create', false);
    assert.equal(flatStyle(hosts(root, 'editor-sheet')[0].props.style).borderRadius, 12, 'a centred window, all corners round');
    await closeWindow(root);
    await act(async () => root.root.findAllByType('Pressable').find(p => p.props.testID?.startsWith('kanban-card-')).props.onPress());
    oneSet(root, label, 'wide card detail', false);
    await closeWindow(root);
  }
});
/** A sheet's pull handle — not a screen root, which on a phone app takes the touches nothing else took (REQ-93 C′). */
const sheetGrip = root => root.root.findAll(n => typeof n.type === 'string' && n.props.onResponderRelease
  && !['mobile-swimlane-screen', 'swimlane-screen', 'workspace-board'].includes(n.props.testID))[0];
test('REQ-72 ② a phone sheet rises from the bottom and closes by the backdrop, back, ✕ and a pull on the handle — not by a short pull', async t => {
  for (const platform of ['android', 'ios', 'web']) {
    const h = harness({ mobile: true, platform }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    const open = async () => { await act(async () => sheetButton(root, 'open-filters').props.onPress()); return hosts(root, 'menu-sheet')[0]; };
    const shown = () => hosts(root, 'menu-sheet').length;
    const sheet = await open(), style = flatStyle(sheet.props.style), modal = root.root.findByType('NativeModal');
    assert.equal(sheet.parent.props.style.justifyContent, 'flex-end', platform + ': from the bottom');
    assert.equal(style.borderTopLeftRadius, 16); assert.equal(style.borderTopRightRadius, 16); assert.equal(style.width, 390);
    assert.equal(modal.props.transparent, true); assert.equal(modal.props.statusBarTranslucent, true);
    assert.equal(root.root.findByType('KeyboardAvoidingView').props.enabled, platform !== 'web', platform + ': keyboard lifts native sheets');
    // REQ-87 ⑦ (was: 56/44 at the end of the scrolled content): the content box itself ends the system bar's height + 8px
    // above the bottom — an Android window drawn edge to edge reads no bar, so the 3-button bar's 48 is assumed.
    const content = flatStyle(sheet.findAll(n => n.props?.testID === 'sheet-content' && typeof n.type === 'string')[0].props.style).paddingBottom;
    assert.equal(content, platform === 'android' ? 56 : platform === 'ios' ? 42 : 8);
    assert.equal(sheet.findAllByType('ScrollView')[0].props.contentContainerStyle.paddingBottom, 8);
    await act(async () => sheetButton(root, 'menu-sheet-backdrop').props.onPress());
    assert.equal(shown(), 0, platform + ': backdrop');
    await open(); await act(async () => root.root.findByType('NativeModal').props.onRequestClose());
    assert.equal(shown(), 0, platform + ': Android back / Escape');
    await open(); await act(async () => labelled(root, 'Close').props.onPress());
    assert.equal(shown(), 0, platform + ': ✕');
    await open();
    const grip = () => sheetGrip(root);
    await act(async () => grip().props.onResponderRelease({}, { dy: 40, vy: 0.2 }));
    assert.equal(shown(), 1, platform + ': a short pull springs back');
    await act(async () => grip().props.onResponderRelease({}, { dy: 120, vy: 0.2 }));
    assert.equal(shown(), 0, platform + ': a long pull closes');
  }
});
test('D29 a phone sheet slides up from the bottom and the backdrop fades in with it; every close path drops it back down first', async t => {
  for (const platform of ['android', 'web']) {
    const h = harness({ mobile: true, platform }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    const readOffset = sheet => flatStyle(sheet.props.style).transform[0].translateY.read();
    const readDim = () => flatStyle(hosts(root, 'menu-sheet-backdrop')[0].parent.props.style).opacity.read();
    const shown = () => hosts(root, 'menu-sheet').length;
    h.agents.motion.calls.length = 0;
    await act(async () => sheetButton(root, 'open-filters').props.onPress());
    const sheet = hosts(root, 'menu-sheet')[0];
    // D29: 240ms ease-out, the sheet to 0 and the backdrop to fully dim, in step.
    const entrance = h.agents.motion.calls.filter(call => call.duration === 240);
    assert.ok(entrance.some(call => call.toValue === 0), platform + ': the sheet rises to 0');
    assert.ok(entrance.some(call => call.toValue === 1), platform + ': the backdrop fades to opaque');
    assert.ok(entrance.every(call => call.easing === 'cubic'), platform + ': eased out, not linear');
    assert.equal(readOffset(sheet), 0, platform + ': risen');
    assert.equal(readDim(), 1, platform + ': dim');
    // The backdrop, ✕, Escape/back and a long pull all animate the same drop before the sheet actually closes.
    for (const closeIt of [
      () => sheetButton(root, 'menu-sheet-backdrop').props.onPress(),
      () => root.root.findByType('NativeModal').props.onRequestClose(),
      () => labelled(root, 'Close').props.onPress(),
      () => sheetGrip(root).props.onResponderRelease({}, { dy: 120, vy: 0.2 }),
    ]) {
      await act(async () => sheetButton(root, 'open-filters').props.onPress());
      h.agents.motion.calls.length = 0;
      await act(async () => closeIt());
      assert.equal(shown(), 0, platform + ': closed');
      const exit = h.agents.motion.calls.filter(call => call.duration === 240);
      assert.ok(exit.some(call => call.toValue === 884), platform + ': the sheet drops fully off-screen (844 + 40) before closing');
      assert.ok(exit.some(call => call.toValue === 0), platform + ': the backdrop fades back out');
      assert.ok(exit.every(call => call.easing === 'cubic'), platform + ': the drop eases the same way the rise did');
    }
    // A short pull is not a close: it springs back with no drop animation and the sheet stays open.
    await act(async () => sheetButton(root, 'open-filters').props.onPress());
    h.agents.motion.calls.length = 0;
    const grip = () => sheetGrip(root);
    await act(async () => grip().props.onResponderRelease({}, { dy: 40, vy: 0.2 }));
    assert.equal(shown(), 1, platform + ': a short pull stays open');
    assert.equal(h.agents.motion.calls.filter(call => call.duration === 240).length, 0, platform + ': no drop animation for a spring-back');
  }
});
test('D29 the centred desktop window keeps its own fade — no rise/drop or backdrop-dim animation added to it', async t => {
  const h = harness({ width: 1400 }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  h.agents.motion.calls.length = 0;
  await act(async () => labelled(root, 'Create draft').props.onPress());
  assert.ok(hosts(root, 'editor-sheet').length, 'the centred window is still a KanbanSheet dialog');
  assert.equal(h.agents.motion.calls.filter(call => call.duration === 240).length, 0, 'no D29 timing on a centred window');
  await act(async () => root.root.findByType('NativeModal').props.onRequestClose());
  assert.equal(hosts(root, 'editor-sheet').length, 0, 'still closes, via the old (immediate) path');
});
test('D29 "reduce motion" shows and drops the sheet instantly: no rise/drop or fade timing runs', async t => {
  const h = harness({ mobile: true, reduceMotion: true }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  h.agents.motion.calls.length = 0;
  await act(async () => sheetButton(root, 'open-filters').props.onPress());
  const sheet = hosts(root, 'menu-sheet')[0];
  assert.equal(h.agents.motion.calls.length, 0, 'no entrance timing under reduce motion');
  assert.equal(flatStyle(sheet.props.style).transform[0].translateY.read(), 0, 'shown immediately');
  assert.equal(flatStyle(hosts(root, 'menu-sheet-backdrop')[0].parent.props.style).opacity.read(), 1, 'dim immediately');
  await act(async () => sheetButton(root, 'menu-sheet-backdrop').props.onPress());
  assert.equal(hosts(root, 'menu-sheet').length, 0, 'closes');
  assert.equal(h.agents.motion.calls.length, 0, 'no exit timing under reduce motion either');
});
test('REQ-72 ③ no Kanban window uses the host sheet: the SDK Modal is imported nowhere, the windows draw through KanbanSheet', () => {
  const files = fs.readdirSync('client').filter(name => /\.tsx?$/.test(name));
  for (const name of files) {
    const source = fs.readFileSync(path.join('client', name), 'utf8');
    const sdk = source.match(/import \{([^}]*)\} from '@getpaseo\/plugin\/client\/react-native'/);
    assert.ok(!sdk || !/\bModal\b/.test(sdk[1]), name + ' imports the host Modal');
  }
  for (const name of ['menu-sheet.tsx', 'editor-ui.tsx', 'settings-sheet.tsx'])
    assert.match(fs.readFileSync(path.join('client', name), 'utf8'), /<KanbanSheet /, name);
  assert.equal(fs.existsSync('client/host-theme.ts'), false, 'D26 host colours are gone with the host sheets');
});

test('REQ-75 A2·A3 "group by project" is a glyph beside the view switch (REQ-81), one settings write, not a filter; on 390px a row in the filter sheet', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'], emptyProject: 'prj_second' }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props), before = h.calls.length;
  const toggle = () => sheetButton(root, 'group-toggle');
  assert.equal(toggle().props.accessibilityRole, 'switch'); assert.equal(toggle().props.accessibilityLabel, 'Group by project');
  assert.equal(toggle().props.accessibilityState.checked, false, 'flat by default');
  assert.equal(toggle().findByType('Icon').props.name, 'FolderTree');
  assert.equal(hosts(root, 'swimlane-project-section').length, 0);
  await act(async () => toggle().props.onHoverIn());
  assert.equal(allText(hosts(root, 'icon-tooltip')[0]), 'Group by project', 'its name shows on hover');
  await act(async () => toggle().props.onHoverOut());
  await act(async () => toggle().props.onPress());
  assert.equal(toggle().props.accessibilityState.checked, true);
  // REQ-85 ②: tinted while on, its glyph in the main colour, like the current view (no line; its 1px edge turns clear).
  const gc = palette(h.props.theme), gTint = selectedTint(gc, gc.surface0);
  assert.equal(toggle().props.style.backgroundColor, gTint);
  assert.deepEqual([toggle().props.style.borderWidth, toggle().props.style.borderColor], [1, 'transparent']);
  assert.equal(toggle().findByType('Icon').props.color, selectedLine(gc, gTint));
  assert.deepEqual(sectionNames(root).map(s => s.project), ['Example Project', 'Second Project']);
  assert.deepEqual(h.ui.writes, [{ hostId: h.props.host.id, settings: { groupByProject: true } }], 'one settings row, nothing else');
  assert.equal(h.ui.value.settings.groupByProject, true);
  assert.equal(h.calls.length, before + 1);
  // Not a filter: no count, and "Clear all" leaves it alone.
  assert.equal(hosts(root, 'active-filter-count').length, 0);
  await act(async () => input(root, 'Search cards').props.onChangeText('x'));
  await clearAllFilters(root);
  assert.equal(toggle().props.accessibilityState.checked, true);
  // Remembered per host: a fresh screen that reads it comes up grouped, and the phone shares it.
  const again = harness({ width: 1400, uiSettings: { groupByProject: true } });
  const fresh = await render(t, again.load('client/overview.tsx').OverviewScreen, again.props);
  assert.equal(sheetButton(fresh, 'group-toggle').props.accessibilityState.checked, true);
  assert.equal(hosts(fresh, 'swimlane-project-section').length, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(again.ui.writes.length, 0, 'reading it writes nothing');
  // 390px: a full-width row at the top of the filter sheet, and the same write.
  const m = harness({ mobile: true, platform: 'web', empty: ['wks_empty01'], emptyProject: 'prj_second' });
  const phone = await render(t, m.load('client/overview.tsx').OverviewScreen, m.props);
  assert.equal(hosts(phone, 'group-toggle').length, 0, 'not in the 390px top bar');
  await act(async () => sheetButton(phone, 'open-filters').props.onPress());
  const row = sheetButton(phone, 'group-toggle');
  assert.equal(row.props.style.minHeight, 44); assert.equal(allText(row), 'Group by project');
  await act(async () => row.props.onPress());
  assert.equal(sheetButton(phone, 'group-toggle').props.accessibilityState.checked, true);
  assert.deepEqual(m.ui.writes, [{ hostId: m.props.host.id, settings: { groupByProject: true } }]);
  await act(async () => phone.root.findByType('NativeModal').props.onRequestClose());
  assert.ok(hosts(phone, 'mobile-project-group').length >= 1, 'the phone board is grouped');
  assert.equal(m.load('client/i18n.ts').copy('ko').groupByProject, '프로젝트로 묶어 보기');
});

test('REQ-75 F1 the wide name tip lifts every layer between it and the board, so stage headings and the next lane never cover it', async t => {
  const z = node => flatStyle(node.props.style).zIndex ?? 0;
  for (const grouped of [false, true]) {
    const h = harness({ width: 1400, empty: ['wks_empty01'], emptyProject: 'prj_second', uiSettings: { groupByProject: grouped } });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props), label = grouped ? 'grouped' : 'flat';
    const sections = () => hosts(root, 'swimlane-lane-section'), projects = () => hosts(root, 'swimlane-project-section');
    assert.ok(sections().length >= 2, label + ': a lane below the first one');
    // Inside a lane's pinned header the stage headings come after the name row, so the row must sit above them.
    const header = hosts(root, 'lane-section-header')[0];
    const row = header.findAll(n => n.props.testID === 'swimlane-lane-header')[0], stages = hosts(root, 'lane-stage-headers')[0];
    assert.ok(z(row) > z(stages), label + ': the name row is drawn over the stage headings');
    const link = sections()[0].findAll(n => n.props.testID === 'workspace-name-link' && n.props.onHoverIn)[0];
    assert.deepEqual(sections().map(z), sections().map(() => 0), label + ': nothing lifted before a hover');
    await act(async () => link.props.onHoverIn());
    assert.equal(hosts(root, 'lane-name-tooltip').length, 1);
    assert.ok(z(hosts(root, 'lane-name')[0]) > 0, label + ': the name over the rest of its row');
    assert.deepEqual(sections().map(z), sections().map((_, i) => i ? 0 : 1), label + ': its lane over the lanes after it');
    if (grouped) assert.deepEqual(projects().map(z), projects().map((_, i) => i ? 0 : 1), 'its project over the projects after it');
    await act(async () => link.props.onHoverOut());
    assert.deepEqual(sections().map(z), sections().map(() => 0), label + ': all back once the tip goes');
    if (grouped) assert.deepEqual(projects().map(z), projects().map(() => 0));
    // Keyboard focus shows the same tip, so it lifts the same layers.
    await act(async () => link.props.onFocus());
    assert.equal(z(sections()[0]), 1, label + ': focus lifts too');
    await act(async () => link.props.onBlur());
    assert.equal(z(sections()[0]), 0);
  }
});

test('REQ-75 G1 a click on "group by project" leaves no label behind; keyboard focus still shows it', async t => {
  const h = harness({ width: 1400 }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const toggle = () => sheetButton(root, 'group-toggle'), tip = () => hosts(root, 'icon-tooltip').length;
  await act(async () => toggle().props.onHoverIn());
  assert.equal(tip(), 1, 'hover shows it');
  // A mouse click: press, the browser focuses the glyph, the switch flips.
  await act(async () => toggle().props.onPressIn({ nativeEvent: { type: 'pointerdown' } }));
  await act(async () => toggle().props.onFocus());
  await act(async () => toggle().props.onPress());
  assert.equal(toggle().props.accessibilityState.checked, true);
  assert.equal(tip(), 0, 'gone once clicked');
  await act(async () => toggle().props.onHoverOut());
  assert.equal(tip(), 0, 'and the focus the click left does not bring it back over "Clear all"');
  await act(async () => toggle().props.onHoverIn());
  assert.equal(tip(), 1, 'the mouse coming back shows it again');
  await act(async () => toggle().props.onHoverOut());
  await act(async () => toggle().props.onBlur());
  // Keyboard: Tab onto it shows the label, and Space keeps it (the key press is not a click).
  await act(async () => toggle().props.onFocus());
  assert.equal(tip(), 1, 'keyboard focus shows it');
  await act(async () => toggle().props.onPressIn({ nativeEvent: { type: 'keydown' } }));
  await act(async () => toggle().props.onPress());
  assert.equal(tip(), 1, 'a key press keeps it');
  await act(async () => toggle().props.onBlur());
  assert.equal(tip(), 0);
});

test('REQ-75 G2 "group by project" on stands out from the page at 3:1 in every theme, wide and in the phone sheet', async t => {
  for (const combo of REQ72_COMBOS) for (const mobile of [false, true]) {
    const h = harness({ ...(mobile ? { mobile: true, platform: 'web' } : { width: 1400 }), uiSettings: { ...combo.uiSettings, groupByProject: true },
      colorScheme: combo.device });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, theme: PASEO_THEMES[combo.hostMode] });
    if (mobile) await act(async () => sheetButton(root, 'open-filters').props.onPress());
    const node = sheetButton(root, 'group-toggle'), on = flatStyle(node.props.style), label = combo.label + (mobile ? ' · 390' : ' · 1400');
    const behind = mobile ? combo.chosen.surface1 : combo.chosen.surface0;
    // REQ-85 ②③ (research/128): "on" is a tint of the main colour over what the switch sits on — it alone stands ~1.3:1
    // from it, so what carries 3:1 is the glyph in the main colour (wide) or the check mark and words (the sheet row).
    assert.equal(on.backgroundColor, selectedTint(combo.chosen, behind), label + ': tinted');
    assert.notEqual(on.backgroundColor, behind, label + ': not the resting fill');
    const icon = node.findAllByType('Icon')[0].props.color;
    if (!mobile) assert.ok(contrast(icon, on.backgroundColor) >= 3, label + ': the "on" glyph against its tint ' + contrast(icon, on.backgroundColor).toFixed(2));
    else {
      assert.ok(node.findAllByType('Icon').some(i => i.props.name === 'Check'), label + ': the row keeps its check mark');
      assert.ok(contrast(combo.chosen.foreground, on.backgroundColor) >= 4.5, label + ': its words read on the tint');
    }
  }
});

test('REQ-75 A4 the flat ⋯ moves a lane in the flat order only; the grouped board keeps its own order', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01', 'wks_empty02'], emptyProject: 'prj_second', noCards: true,
    order: { projects: ['prj_second'], workspaces: ['wks_empty02', 'wks_empty01'] } });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const e0 = 'Empty Workspace 0 · Second Project', e1 = 'Empty Workspace 1 · Second Project';
  const shown = () => flatNames(root).map(n => n.split(' · ')[0]);
  assert.deepEqual(shown(), ['Example Workspace', 'Empty Workspace 0', 'Empty Workspace 1'], 'the grouped order does not arrange the flat board');
  // The flat ⋯ is named "workspace · project", opens the board, and moves among every lane of the layer.
  await act(async () => orderMenu(root, 'lane-order-menu', e1).props.onPress());
  assert.equal(hosts(root, 'order-open-board').length, 1); assert.equal(hosts(root, 'order-reset').length, 0, 'no project reset on a lane');
  assert.deepEqual(['top', 'up', 'down'].map(d => sheetButton(root, 'order-move-' + d).props.disabled), [false, false, true]);
  await act(async () => sheetButton(root, 'order-move-top').props.onPress());
  assert.deepEqual(shown(), ['Empty Workspace 1', 'Example Workspace', 'Empty Workspace 0']);
  assert.deepEqual(h.ui.writes.at(-1).order, { projects: ['prj_second'], workspaces: ['wks_empty02', 'wks_empty01'],
    flatWorkspaces: ['wks_empty02', 'wks_example01', 'wks_empty01'] }, 'the grouped lists travel unchanged');
  await move(root, 'lane-order-menu', e0, 'up');
  assert.deepEqual(shown(), ['Empty Workspace 1', 'Empty Workspace 0', 'Example Workspace']);
  // Grouped: the order arranged before is still there.
  await groupByProject(root);
  assert.deepEqual(sectionNames(root), [{ project: 'Second Project', lanes: ['Empty Workspace 1 · wks_empty02', 'Empty Workspace 0 · wks_empty01'] },
    { project: 'Example Project', lanes: ['Example Workspace · example-workspace'] }]);
  // Back to flat: the flat order is still there too.
  await groupByProject(root);
  assert.deepEqual(shown(), ['Empty Workspace 1', 'Empty Workspace 0', 'Example Workspace']);
  // The settings window's reset releases both.
  await openSettings(root, 'display');
  await act(async () => sheetButton(root, 'order-reset-all').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).order, { projects: [], workspaces: [], flatWorkspaces: [] });
});

test('REQ-75 B3·B4 / REQ-92 on 390px: "+N" shows five more, "Collapse" once all show, and an opened done tab says what it leaves to the board', async t => {
  const h = harness({ mobile: true });
  for (let i = 0; i < 12; i++) h.addCard({ ...add('Shipped ' + i), stageId: 'done' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  await act(async () => root.root.findByProps({ testID: 'mobile-tab-done' }).props.onPress());
  assert.equal(allText(sheetButton(root, 'cell-more')), '+9');
  assert.equal(sheetButton(root, 'cell-more').props.accessibilityLabel, 'Show 5 more (9 not shown): Example Workspace');
  assert.equal(hosts(root, 'cell-rest-in-board').length, 0, 'nothing about the board while folded');
  await act(async () => sheetButton(root, 'cell-more').props.onPress());
  const cards = () => root.root.findAllByType('Pressable').filter(p => p.props.testID?.startsWith('kanban-card-')).length;
  assert.equal(cards(), 8, 'five more, not ten');
  const links = () => hosts(root, 'cell-open-links')[0].findAll(n => typeof n.type === 'string'
    && ['cell-more', 'cell-rest-in-board', 'cell-collapse'].includes(n.props?.testID)).map(allText);
  assert.deepEqual(links(), ['+4', '4 more in the board', 'Collapse'], 'REQ-115: "Collapse" part way too');
  await act(async () => sheetButton(root, 'cell-more').props.onPress());
  assert.equal(cards(), 12);
  assert.deepEqual(links(), ['Collapse'], '"Collapse" where "+N" was');
  await act(async () => sheetButton(root, 'cell-collapse').props.onPress());
  assert.equal(cards(), 3);
  await act(async () => sheetButton(root, 'cell-more').props.onPress());
  assert.equal(sheetButton(root, 'cell-rest-in-board').props.accessibilityLabel, '4 more in the board: Example Workspace');
  await act(async () => sheetButton(root, 'cell-rest-in-board').props.onPress());
  assert.equal(hosts(root, 'workspace-board').length, 1);
  assert.equal(root.root.findAllByType('Pressable').filter(p => p.props.accessibilityRole === 'tab' && p.props.accessibilityState?.selected)
    .every(p => p.props.accessibilityLabel.startsWith('Done ')), true, 'on its done stage');
});

// REQ-77: six small display fixes.
test('REQ-77 ① a detail agent is one row: the id closes it once, small, and the row itself opens the agent', async t => {
  for (const mobile of [false, true]) {
    const h = harness({ ...(mobile ? { mobile: true, platform: 'web', width: 390 } : { width: 1400 }), link: [AGENT_A, AGENT_B],
      agents: [{ id: AGENT_A, status: 'idle', provider: 'claude', model: 'claude-opus-5' }] });
    const opened = [], props = { ...h.props, navigation: { openAgent: target => opened.push(target), openWorkspace: () => {} } };
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, props), label = mobile ? '390' : '1400';
    if (mobile) await act(async () => labelled(root, 'To Do 1').props.onPress());
    await act(async () => labelled(root, 'Example card').props.onPress());
    const rows = hosts(root, 'agent-open');
    assert.equal(rows.length, 2, label + ': one row per agent');
    for (const row of rows) assert.equal(row.findAll(n => n.props?.testID === 'agent-signal' && typeof n.type === 'string').length, 1);
    // No second row that repeats the id as a button.
    assert.equal(root.root.findAllByType('Pressable').filter(p => /^[0-9a-f]{8}$/.test(allText(p))).length, 0, label + ': no id-only button');
    const [known, unknown] = rows.map(allText);
    assert.equal(known, 'Opus-5 · Agent 1111 · Finished · 11111111', label + ': name first, the id once at the end');
    const id = hosts(root, 'agent-id');
    assert.equal(id.length, 1, label + ': only the named agent gets an id suffix');
    const words = mobile ? hosts(root, 'agent-signal-text')[0] : hosts(root, 'agent-name')[0];
    assert.ok(id[0].props.style.fontSize < words.props.style.fontSize, label + ': the id is smaller');
    if (mobile) assert.ok(hosts(root, 'agent-signal-text')[0].findAll(n => n === id[0]).length === 1, label + ': inside the same line of words, so it wraps with them');
    // D45: the wide side panel keeps the row on one line — the id closes it, after the name and the state that may be cut.
    else assert.ok(hosts(root, 'agent-signal-text')[0].findAll(n => n === id[0]).length === 1 && hosts(root, 'agent-signal-rest')[0].findAll(n => n === id[0]).length === 0,
      label + ': its own word after the state, never cut');
    assert.equal(unknown, '22222222 · Agent 2222 · Status unavailable', label + ': an agent Kanban cannot read says its id once');
    assert.equal((unknown.match(/22222222/g) ?? []).length, 1);
    assert.ok(!text(root).includes(AGENT_A) && !text(root).includes(AGENT_B), label + ': no full agent UUID on the sheet');
    assert.equal(rows[0].props.style.minHeight, mobile ? 44 : 24, label + ': a phone keeps the 44px target');
    assert.equal(rows[0].props.accessibilityLabel, 'Open agent Opus-5 11111111');
    await act(async () => rows[1].props.onPress());
    await leaveOpen(root);
    assert.deepEqual(opened, [{ agentId: AGENT_B }], label + ': the row opens its agent');
  }
});

test('D45 the wide detail keeps each assignee row and the author on one line: the name and the state lose their end, the id never; a phone wraps as before', async t => {
  const long = { id: AGENT_A, status: 'idle', provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'xhigh', labels: { profile: '산출물정리담당_Opus' } };
  // A label from before 09-30 ends with its version and takes the thinking level only.
  const old = { id: AGENT_B, status: 'running', provider: 'codex', model: 'gpt-6.1-sol', thinkingOptionId: 'xhigh', labels: { profile: '검토_Sol-6' } };
  for (const mobile of [false, true]) {
    const h = harness({ ...(mobile ? { mobile: true, platform: 'web', width: 390 } : { width: 1920 }), link: [AGENT_A, AGENT_B],
      models: REQ126_MODELS, author: { kind: 'agent', agentId: AGENT_A }, agents: [long, old] });
    const props = { ...h.props, navigation: { openAgent: () => {}, openWorkspace: () => {} } };
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, props), label = mobile ? '390' : '1920';
    if (mobile) await act(async () => labelled(root, 'To Do 1').props.onPress());
    await act(async () => labelled(root, 'Example card').props.onPress());
    const rows = hosts(root, 'agent-open').map(allText);
    assert.deepEqual(rows.map(r => r.replace(/ · Agent \d+/, '')), ['산출물정리담당_Opus-5.5-XHigh · Finished · 11111111', '검토_Sol-6-XHigh · Working · 22222222'], label + ': the same words');
    assert.equal(detailMeta(root, 'Created by'), '산출물정리담당_Opus-5.5-XHigh · 11111111', label + ': the author');
    if (mobile) {
      assert.equal(hosts(root, 'agent-name').length + hosts(root, 'detail-author').length, 0, label + ': a phone keeps its wrapping words');
      continue;
    }
    for (const name of hosts(root, 'agent-name')) assert.equal(name.props.numberOfLines, 1, 'the name is one line, cut at its end');
    // research/236 D5: the state is one line too ("Waiting for input or permission" wrapped before); the id never cut.
    // D47: a short state and the id sit in a tail that never shrinks — the name alone gives way (it used to shrink with it: "끝남" → "…").
    assert.equal(hosts(root, 'agent-signal-tail').length, 2);
    for (const tail of hosts(root, 'agent-signal-tail')) assert.deepEqual([tail.props.style.flexShrink, tail.props.style.maxWidth], [0, undefined],
      'a short state and the id never give way to the name');
    for (const name of hosts(root, 'agent-name')) assert.deepEqual([name.props.style.flexShrink, name.props.style.minWidth, name.props.style.maxWidth], [1, 0, undefined]);
    for (const rest of hosts(root, 'agent-signal-rest')) assert.deepEqual([rest.props.numberOfLines, rest.props.style.flexShrink, rest.props.style.maxWidth], [1, 1, undefined],
      'the state is one line, cut at its end only inside the tail');
    assert.deepEqual(hosts(root, 'agent-signal-rest').map(allText), [' · Finished', ' · Working']);
    assert.deepEqual(hosts(root, 'agent-id').map(n => [allText(n), n.props.numberOfLines, n.props.style.flexShrink]), [[' · 11111111', 1, 0], [' · 22222222', 1, 0]], 'the id whole');
    // Asking for a permission: the longest state, on the same one line — the mark before the name says it in full.
    await act(async () => h.agents.upsert(AGENT_A, { ...long, pendingPermissions: [{ requestId: 'p1' }] }));
    assert.equal(allText(hosts(root, 'agent-signal-rest')[0]), ' · Waiting for input or permission');
    assert.deepEqual([hosts(root, 'agent-signal-rest')[0].props.numberOfLines, allText(hosts(root, 'agent-id')[0])], [1, ' · 11111111']);
    // D47: a state that long (more than 20 columns) is the one that may give way: the name keeps up to 38%, the state the rest.
    assert.deepEqual([hosts(root, 'agent-name')[0].props.style.flexShrink, hosts(root, 'agent-name')[0].props.style.maxWidth], [0, '38%']);
    assert.deepEqual([hosts(root, 'agent-signal-tail')[0].props.style.flexShrink, hosts(root, 'agent-signal-tail')[0].props.style.minWidth], [1, 0]);
    assert.deepEqual([hosts(root, 'agent-name')[1].props.style.flexShrink, hosts(root, 'agent-signal-tail')[1].props.style.flexShrink], [1, 0], 'the other row keeps its short state whole');
    assert.equal(hosts(root, 'agent-signal-icon')[0].props.accessibilityLabel, 'Waiting for input or permission');
    const [name, id] = [hosts(root, 'detail-author-name')[0], hosts(root, 'detail-author-id')[0]];
    assert.deepEqual([name.props.numberOfLines, name.props.style.flexShrink, id.props.style.flexShrink, allText(id)], [1, 1, 0, ' · 11111111'], 'the author: the name may be cut, the id not');
  }
});

test('D47 which states may lose their end on the wide detail\'s one-line row: every Korean one whole, only the longest English ones may', () => {
  const h = harness({ width: 1920 }), { textColumns, ONE_LINE_LONG_STATE } = h.load('client/status-icon.tsx'), { copy } = h.load('client/i18n.ts');
  assert.deepEqual([textColumns('끝남'), textColumns('끝남 · 확인 필요'), textColumns('Finished'), textColumns('입력·권한 대기')], [4, 16, 8, 14]);
  const keys = ['signalError', 'signalPermission', 'signalWorking', 'signalAttention', 'signalIdle', 'signalUnknown'];
  const long = lang => keys.filter(key => textColumns(copy(lang)[key]) > ONE_LINE_LONG_STATE);
  assert.deepEqual(long('ko'), [], 'no Korean state may be cut');
  assert.deepEqual(long('en'), ['signalPermission', 'signalAttention'], '"Waiting for input or permission" and "Finished · needs review" may');
});

test('REQ-77 ② detail times read as this device\'s MM-DD HH:mm and the author is named as an assignee row names it', async t => {
  const h = harness({ width: 1400, author: { kind: 'agent', agentId: AGENT_B },
    agents: [{ id: AGENT_B, status: 'idle', provider: 'claude', model: 'claude-opus-5', labels: {} }] });
  const { localStamp } = h.load('client/move-reason.ts');
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => labelled(root, 'Example card').props.onPress());
  const card = h.base.cards[0], all = text(root);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(all), 'no raw ISO moment anywhere on the sheet');
  const fields = root.root.findAllByType('Text').filter(n => typeof n.props.children === 'string');
  const after = heading => fields[fields.findIndex(n => n.props.children === heading) + 1]?.props.children;
  const stamp = localStamp(card.createdAt, Date.now());
  assert.match(stamp, /^(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}$/);
  // REQ-88 ①: who made it and when are small "label · value" lines at the foot of the side panel.
  assert.equal(detailMeta(root, 'Created'), stamp);
  assert.equal(detailMeta(root, 'Updated'), localStamp(card.updatedAt, Date.now()));
  assert.equal(after('Retained stage history'), stamp + ' · — → To Do · Opus-5 · 22222222', 'REQ-126: an agent\'s line names it; REQ-136 H4: the stage by its name, not its id');
  assert.equal(detailMeta(root, 'Created by'), 'Opus-5 · 22222222', 'the author by name (REQ-126: with its version), then the short id, never the full UUID');
  assert.ok(!all.includes(AGENT_B));
  // An author Kanban cannot read is its short id alone.
  const k = harness({ width: 1400, author: { kind: 'agent', agentId: AGENT_A } });
  const other = await render(t, k.load('client/overview.tsx').OverviewScreen, k.props);
  await act(async () => labelled(other, 'Example card').props.onPress());
  assert.equal(detailMeta(other, 'Created by'), '11111111');
  // The shared stamp: the year only when it is not this year's.
  assert.equal(localStamp('2025-03-04T05:06:00', Date.parse('2026-09-25T12:00:00')), '2025-03-04 05:06');
  assert.equal(localStamp('2026-03-04T05:06:00', Date.parse('2026-09-25T12:00:00')), '03-04 05:06');
});

// REQ-82 ① supersedes the words: "Archived · confirm done" (what the card waits for), no longer "No assignee".
test('REQ-77 ③ a card whose every agent is archived says one thing alone; the archived agent\'s name stays in the tooltip', async t => {
  const h = harness({ width: 1400, link: [AGENT_A], agents: [{ id: AGENT_A, status: 'idle', provider: 'claude', model: 'claude-opus-5' }] });
  h.external({ awaiting: null });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const face = () => allText(hosts(root, 'card-agent')[0]);
  assert.equal(face(), 'Opus-5', 'a live agent is named');
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', archivedAt: '2026-09-22', provider: 'claude', model: 'claude-opus-5' }));
  assert.equal(face(), 'Archived · confirm done', 'one meaning: the work waits to be confirmed — no name beside the words');
  const name = hosts(root, 'card-agent-name')[0];
  assert.equal(name.props.style.color, readable(palette(h.props.theme).statusDotWarning, palette(h.props.theme).card), 'in the warning colour');
  assert.equal(hosts(root, 'card-orphaned-mark').length, 1, 'the warning glyph stays');
  assert.equal(nativeNode(root, 'attention-count').children[0], '1', 'and it still counts as needing a person');
  await act(async () => hosts(root, 'card-signal-press')[0].props.onPress({ stopPropagation() {} }));
  assert.match(allText(hosts(root, 'card-signal-tooltip')[0]), /^Opus-5 · Claude · Agent archived · confirm it is done$/, 'who it was, on request');
});

test('REQ-77 ④ the board title reads like the flat lane heading: workspace bold, project muted and small, said once', async t => {
  const b = harness({ branches: { wks_example01: 'main' } }), { BoardScreen } = b.load('client/board.tsx');
  const screen = await render(t, BoardScreen, { ...b.props, selector: { boardId: b.base.id } });
  const title = hosts(screen, 'board-title')[0];
  assert.equal(title.children[0], 'Example Workspace', 'the workspace leads');
  assert.equal(title.props.style.fontWeight, '600');
  const muted = title.findAll(n => typeof n.type === 'string' && n !== title)[0];
  assert.equal(allText(muted), ' · Example Project · main · example-workspace', 'then the project, then branch · folder');
  assert.equal(muted.props.style.color, palette(b.props.theme).foregroundMuted);
  assert.ok(muted.props.style.fontSize < title.props.style.fontSize);
  // The lane heading of the same workspace, flat: the same two names in the same order.
  const o = harness({ width: 1400, branches: { wks_example01: 'main' } });
  const overview = await render(t, o.load('client/overview.tsx').OverviewScreen, o.props);
  assert.equal(allText(hosts(overview, 'workspace-name-primary')[0]), 'Example Workspace');
  assert.equal(allText(hosts(overview, 'workspace-name-detail')[0]), ' · Example Project');
  const k = harness({ projectName: 'Acme_Logotype', workspaceName: 'acme_logotype' });
  const acme = await render(t, k.load('client/board.tsx').BoardScreen, { ...k.props, selector: { boardId: k.base.id } });
  assert.equal(allText(hosts(acme, 'board-title')[0]), 'acme_logotype · example-workspace', 'the same name up to case, once');
});

test('REQ-77 ⑤ Space flips "group by project" from the keyboard, once per press, without scrolling the page', async t => {
  for (const mobile of [false, true]) {
    const h = harness(mobile ? { mobile: true, platform: 'web', width: 390 } : { width: 1400 });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props), label = mobile ? '390' : '1400';
    if (mobile) await act(async () => sheetButton(root, 'open-filters').props.onPress());
    const toggle = () => sheetButton(root, 'group-toggle');
    let prevented = 0;
    const key = (k, repeat = false) => act(async () => toggle().props.onKeyDown({ key: k, repeat, preventDefault: () => { prevented++; } }));
    await key(' ');
    assert.equal(toggle().props.accessibilityState.checked, true, label + ': Space turns it on');
    assert.equal(prevented, 1, label + ': and the page does not scroll');
    await key(' ', true);
    assert.equal(toggle().props.accessibilityState.checked, true, label + ': a held key does not flip it back');
    await key('Spacebar');
    assert.equal(toggle().props.accessibilityState.checked, false, label + ': the old key name too');
    await key('Enter');
    assert.equal(toggle().props.accessibilityState.checked, false, label + ': Enter stays with the Pressable (no double flip)');
    assert.equal(prevented, 3);
  }
});

test('REQ-77 ⑥ a click on ⚙ (any IconButton with a label) leaves no label behind; keyboard focus still shows it', async t => {
  const b = harness({ width: 1400 }), { BoardScreen } = b.load('client/board.tsx');
  const root = await render(t, BoardScreen, { ...b.props, selector: { boardId: b.base.id } });
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  const gear = () => sheetButton(root, 'open-settings'), tip = () => hosts(root, 'icon-tooltip').length;
  await act(async () => gear().props.onHoverIn());
  assert.equal(tip(), 1, 'hover shows it');
  await act(async () => gear().props.onPressIn({ nativeEvent: { type: 'pointerdown' } }));
  await act(async () => gear().props.onFocus());
  await act(async () => gear().props.onPress());
  assert.equal(tip(), 0, 'gone once clicked');
  await act(async () => gear().props.onHoverOut());
  assert.equal(tip(), 0, 'the focus the click left does not bring it back');
  await act(async () => gear().props.onHoverIn());
  assert.equal(tip(), 1, 'the mouse coming back shows it again');
  await act(async () => gear().props.onHoverOut());
  await act(async () => gear().props.onBlur());
  await act(async () => gear().props.onFocus());
  assert.equal(tip(), 1, 'keyboard focus shows it');
  await act(async () => gear().props.onPressIn({ nativeEvent: { type: 'keydown' } }));
  assert.equal(tip(), 1, 'a key press keeps it');
  assert.equal(flatStyle(gear().props.style).outlineStyle, undefined, 'the browser focus ring is left alone');
  await act(async () => gear().props.onBlur());
  assert.equal(tip(), 0);
});

/** REQ-77 F1: a page the focus origin listens on. `tab()` is the key-down whose default action moves focus. */
function keyPage(t) {
  const had = 'document' in globalThis, saved = globalThis.document, keys = [];
  globalThis.document = { addEventListener: (type, listener) => { if (type === 'keydown') keys.push(listener); }, removeEventListener: () => {} };
  t.after(() => { if (had) globalThis.document = saved; else delete globalThis.document; });
  return { tab: () => { for (const listener of keys) listener({ key: 'Tab' }); }, listeners: () => keys.length };
}
test('REQ-77 F1 ⚙ given focus back by a closing settings window shows no label — clicked or keyed open, closed by ✕ or Escape; Tab still shows it', async t => {
  const page = keyPage(t);
  for (const screen of ['board', 'swimlane', 'list']) {
    const h = harness({ width: 1400 }), { BoardScreen } = h.load('client/board.tsx'), { OverviewScreen } = h.load('client/overview.tsx');
    const returned = [];
    // The browser's focus(): the Pressable (as rendered now) gets its focus event, with no Tab key-down in front of it.
    const createNodeMock = element => element.props.testID === 'open-settings'
      ? { focus: () => { returned.push(screen); sheetButton(root, 'open-settings').props.onFocus?.(); } } : null;
    const root = screen === 'board' ? await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id } }, { createNodeMock })
      : await render(t, OverviewScreen, h.props, { createNodeMock });
    if (screen === 'board') await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
    if (screen === 'list') await act(async () => sheetButton(root, 'view-list').props.onPress());
    assert.ok(page.listeners() > 0, screen + ': Tab is listened for from the start');
    const gear = () => sheetButton(root, 'open-settings'), tip = () => hosts(root, 'icon-tooltip').length;
    for (const [open, close] of [['click', 'close'], ['click', 'escape'], ['click', 'escape, mouse reported first'], ['key', 'close'], ['key', 'escape']]) {
      const label = screen + ' · ' + open + ' · ' + close;
      if (open === 'click') {
        await act(async () => gear().props.onHoverIn());
        await act(async () => gear().props.onPressIn({ nativeEvent: { type: 'pointerdown' } }));
        await act(async () => gear().props.onFocus());
      } else {
        await act(async () => { page.tab(); gear().props.onFocus(); });
        assert.equal(tip(), 1, label + ': Tab onto ⚙ shows the label');
        await act(async () => gear().props.onPressIn({ nativeEvent: { type: 'keydown' } }));
      }
      await act(async () => gear().props.onPress());
      // The window takes focus and the mouse moves over it.
      await act(async () => { gear().props.onBlur(); gear().props.onHoverOut(); });
      assert.equal(tip(), 0, label + ': none while the window is open');
      await act(async () => { await pause(5); });
      const before = returned.length;
      await act(async () => {
        // The window goes from under a mouse that never moved: the browser may report it over ⚙ before focus is back.
        if (close === 'escape, mouse reported first') gear().props.onHoverIn();
        return close === 'close' ? sheetButton(root, 'settings-close').props.onPress() : modalOf(root, 'settings-window').props.onRequestClose();
      });
      assert.equal(hosts(root, 'settings-window').length, 0);
      assert.equal(returned.length, before + 1, label + ': focus goes back to ⚙');
      assert.equal(tip(), 0, label + ': and brings no label with it');
      await act(async () => { await pause(5); });
      assert.equal(tip(), 0, label + ': nor later, with the mouse elsewhere');
      if (open === 'click' && close !== 'close') {
        // The mouse never left ⚙: once the window is gone the browser reports it over ⚙ again, unmoved.
        if (close === 'escape') await act(async () => gear().props.onHoverIn());
        assert.equal(tip(), 0, label + ': the mouse still resting where it clicked brings none either');
        await act(async () => gear().props.onHoverOut());
        await act(async () => gear().props.onHoverIn());
        assert.equal(tip(), 1, label + ': once it has left, coming back shows it');
        await act(async () => gear().props.onHoverOut());
      }
      await act(async () => gear().props.onBlur());
    }
    // A mouse that comes to ⚙ well after the window closed is an ordinary hover.
    const { RETURNED_HOVER_MS } = h.load('client/focus-origin.ts');
    await act(async () => { gear().props.onFocus(); });
    await act(async () => { await pause(RETURNED_HOVER_MS + 50); });
    await act(async () => gear().props.onHoverIn());
    assert.equal(tip(), 1, screen + ': a later hover shows it');
    await act(async () => { gear().props.onHoverOut(); gear().props.onBlur(); });
    // Tab away and back: the keyboard's focus shows it again.
    await act(async () => { page.tab(); gear().props.onFocus(); });
    assert.equal(tip(), 1, screen + ': Tab back onto ⚙ shows it');
    await act(async () => gear().props.onBlur());
    assert.equal(tip(), 0);
  }
});

/**
 * REQ-78: one of the three screens that place workspaces — the wide board, the 390px board or the list — opened on
 * a harness `prepare` can slow down or break first. A card in "doing" shows on each of them once placed.
 */
async function openPlaced(t, kind, options = {}, prepare = () => {}) {
  const h = kind === 'wide' ? harness({ width: 1400, ...options }) : kind === 'phone' ? harness({ mobile: true, ...options }) : harness(options);
  const timing = h.load('client/directory-retry.ts').DIRECTORY_TIMING;
  h.addCard({ ...add('In flight'), stageId: 'doing' });
  prepare(h, timing);
  const { OverviewScreen, ListOverview } = h.load('client/overview.tsx');
  const root = await render(t, kind === 'list' ? ListOverview : OverviewScreen, kind === 'list' ? { ...h.props, onBoard: () => {} } : h.props);
  return { h, root, timing };
}
const REQ78_SCREENS = ['wide', 'phone', 'list'];
const wait = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const listings = (h, kind) => h.sdkCalls.filter(call => call === kind).length;
/** A retry's answer renders when its act ends, so a longer wait is taken in short acts. */
async function waitSteps(ms, step = 10) { for (let spent = 0; spent < ms; spent += step) await wait(step); }
/**
 * J3 (research/136): waits, in the same short acts, until `ready()` holds or `ms` of real time pass. A busy machine only
 * makes timers late, never early, so a test waits for what it expects instead of assuming it happened within a window.
 */
async function until(ready, ms = 5000) { const end = Date.now() + ms; while (!ready() && Date.now() < end) await wait(10); return ready(); }
/** What a placed board shows: the "doing" card on either board, the workspace row on the list. */
const placedText = kind => kind === 'list' ? /Example Workspace/ : /In flight/;

test('REQ-78 ① until the workspace listing answers, no screen says "Not found in Paseo" or counts projects; it says it is loading', async t => {
  for (const kind of REQ78_SCREENS) {
    const { h, root } = await openPlaced(t, kind, {}, h => { h.listing.hold('projects'); h.listing.hold('workspaces'); });
    assert.ok(h.calls.some(c => c.name === 'kanban.v1.overview.get'), kind + ': the boards have arrived');
    assert.deepEqual(h.listing.waiting().sort(), ['projects', 'workspaces'], kind + ': the listing has not');
    const early = text(root);
    assert.doesNotMatch(early, /Not found in Paseo/, kind);
    assert.doesNotMatch(early, /Projects \(\d+\/\d+\)/, kind + ': no "1/1" before any project is known');
    assert.doesNotMatch(early, /In flight|Example Workspace|example-workspace|No boards registered|No matching cards|No cards yet/, kind + ': no board, and no "empty" either');
    assert.equal(hosts(root, 'directory-loading').length, 1, kind + ': one quiet line in their place');
    assert.equal(hosts(root, 'directory-ready').length, 0, kind);
    if (kind === 'wide') assert.equal(hosts(root, 'project-dropdown-trigger')[0].props.accessibilityLabel, 'Projects: Projects …');
    if (kind === 'wide') assert.equal(hosts(root, 'swimlane-progress')[0].props.children, '…', 'wide: the progress sum waits too');
    if (kind === 'list') assert.match(early, /Projects …/, 'list: the projects button waits too');
    if (kind === 'phone') {
      await act(async () => sheetButton(root, 'open-filters').props.onPress());
      assert.equal(hosts(root, 'project-dropdown-trigger')[0].props.accessibilityLabel, 'Projects: Projects …', 'phone: in the filter sheet');
      await act(async () => root.root.findByType('NativeModal').props.onRequestClose());
    }
    await act(async () => h.listing.release()); await wait();
    const placed = text(root);
    assert.match(placed, placedText(kind), kind + ': placed once the listing answers');
    assert.doesNotMatch(placed, /Not found in Paseo/, kind);
    assert.equal(hosts(root, 'directory-loading').length, 0, kind);
    assert.equal(hosts(root, 'directory-ready').length, 1, kind + ': the mark a headless check waits for');
    if (kind === 'wide') assert.equal(hosts(root, 'project-dropdown-trigger')[0].props.accessibilityLabel, 'Projects: Projects (1/1)');
  }
});

test('REQ-78 ② a hidden project is never drawn while the listing is read — not for one render', async t => {
  for (const kind of REQ78_SCREENS) {
    const { h, root } = await openPlaced(t, kind, { hiddenProjects: ['prj_example01'] }, h => { h.listing.hold('projects'); h.listing.hold('workspaces'); });
    const hidden = /In flight|Example card|example-workspace|Example Workspace/;
    assert.doesNotMatch(text(root), hidden, kind + ': the first render with boards');
    await act(async () => h.listing.release('projects')); await wait();
    assert.doesNotMatch(text(root), hidden, kind + ': with the project names only');
    await act(async () => h.listing.release()); await wait();
    assert.doesNotMatch(text(root), hidden, kind + ': and once placed');
    assert.equal(hosts(root, 'directory-ready').length, 1, kind);
  }
});

test('REQ-78 ② reopening places the known workspaces at once; one made since waits for the new listing, hidden or not', async t => {
  for (const kind of REQ78_SCREENS) {
    const { h, root: first } = await openPlaced(t, kind, { hiddenProjects: ['prj_second'] });
    assert.match(text(first), placedText(kind), kind);
    await act(async () => first.unmount());
    // Paseo made a workspace of a hidden project since; the session's last listing does not know it yet.
    h.listing.add('wks_later01', 'prj_second', 'Second Project');
    h.listing.hold('projects'); h.listing.hold('workspaces');
    const { OverviewScreen, ListOverview } = h.load('client/overview.tsx');
    const root = await render(t, kind === 'list' ? ListOverview : OverviewScreen, kind === 'list' ? { ...h.props, onBoard: () => {} } : h.props);
    const early = text(root);
    assert.match(early, placedText(kind), kind + ': the last listing places the known workspace at once');
    assert.doesNotMatch(early, /Later Workspace|wks_later01|Not found in Paseo/, kind + ': the new one is held back, not "not found"');
    assert.equal(hosts(root, 'directory-loading').length, 1, kind + ': and the screen says it is still loading');
    assert.equal(hosts(root, 'directory-ready').length, 0, kind);
    await act(async () => h.listing.release()); await wait();
    assert.doesNotMatch(text(root), /Later Workspace|wks_later01|Not found in Paseo/, kind + ': its project is hidden');
    assert.equal(hosts(root, 'directory-loading').length, 0, kind);
    assert.equal(hosts(root, 'directory-ready').length, 1, kind);
  }
});

test('REQ-78 ③ a failed listing is said quietly, read again with growing pauses, and the notice goes once it succeeds', async t => {
  for (const kind of REQ78_SCREENS) {
    const { h, root } = await openPlaced(t, kind, {}, (h, timing) => { h.listing.set({ fail: true }); timing.retryFirstMs = 20; });
    assert.match(text(root), /Workspace names could not be read: Synthetic directory failure · trying again automatically/, kind);
    assert.equal(hosts(root, 'directory-error').length, 1, kind);
    assert.doesNotMatch(text(root), /Not found in Paseo|In flight|Example Workspace/, kind);
    const first = listings(h, 'workspaces');
    assert.ok(await until(() => listings(h, 'workspaces') >= first + 2), kind + ': read again on its own (20 ms, then 40 ms)');
    // The next pause is at least 80 ms and a timer never fires early, so 40 ms more bring no read — a tight loop would.
    const reached = listings(h, 'workspaces');
    await waitSteps(40);
    assert.equal(listings(h, 'workspaces'), reached, kind + ': with pauses that grow, not a tight loop');
    h.listing.set({ fail: false });
    assert.ok(await until(() => hosts(root, 'directory-error').length === 0), kind + ': the notice goes');
    assert.match(text(root), placedText(kind), kind);
  }
  const { retryPause } = harness().load('client/directory-retry.ts');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(n => retryPause(n)), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('REQ-78 ③ a listing that times out is said, and Refresh reads it again at once', async t => {
  for (const kind of REQ78_SCREENS) {
    const { h, root } = await openPlaced(t, kind, {}, (h, timing) => { timing.timeoutMs = 30; timing.retryFirstMs = 60_000; h.listing.hold('workspaces'); });
    await until(() => /workspaces\.list timed out/.test(text(root)));
    assert.match(text(root), /workspaces\.list timed out/, kind);
    assert.doesNotMatch(text(root), /Not found in Paseo|In flight|Example Workspace/, kind);
    // The late answer to the timed-out listing is dropped; Refresh asks again without waiting for the minute.
    await act(async () => h.listing.release());
    const asked = listings(h, 'workspaces');
    await act(async () => labelled(root, 'Refresh').props.onPress()); await wait();
    assert.equal(listings(h, 'workspaces'), asked + 1, kind);
    assert.equal(hosts(root, 'directory-error').length, 0, kind);
    assert.match(text(root), placedText(kind), kind);
  }
});

test('REQ-78 ③ a failed project listing still places the boards, says why, and is read again', async t => {
  for (const kind of REQ78_SCREENS) {
    const { h, root } = await openPlaced(t, kind, {}, (h, timing) => { h.listing.set({ projectsFail: true }); timing.retryFirstMs = 20; });
    assert.match(text(root), placedText(kind), kind + ': the workspaces carry their projects');
    assert.match(text(root), /projects\.list: Synthetic project listing failure/, kind);
    h.listing.set({ projectsFail: false });
    assert.ok(await until(() => hosts(root, 'directory-error').length === 0), kind);
  }
});

test('REQ-78 ④ an agent still being looked up is "…" with no provider mark; the id shows only once the lookup ends nameless', async t => {
  for (const kind of ['wide', 'phone']) {
    for (const [answer, name] of [['missing', UNLISTED[0].slice(0, 8)], ['running', 'Agent ' + UNLISTED[0]]]) {
      const h = kind === 'wide' ? harness({ width: 1400, link: [UNLISTED[0]], holdLookups: true, lookups: { [UNLISTED[0]]: answer } })
        : harness({ mobile: true, link: [UNLISTED[0]], holdLookups: true, lookups: { [UNLISTED[0]]: answer } });
      if (kind === 'phone') h.addCard({ op: 'move', id: h.base.cards[0].id, to: 'doing' });
      const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
      assert.deepEqual(h.agents.waiting(), [UNLISTED[0]], kind + ': the lookup is on its way');
      const card = () => hosts(root, 'card-agent')[0];
      const nameOf = () => card().findAll(n => n.props?.testID === 'card-agent-name' && typeof n.type === 'string')[0];
      assert.equal(nameOf().props.children, '…', kind + ': neutral, not the id');
      assert.equal(nameOf().props.accessibilityLabel, 'Loading…', kind);
      assert.equal(card().findAll(n => n.props?.testID === 'card-provider-pending').length > 0, true, kind + ': the mark\'s place is empty');
      assert.equal(card().findAll(n => n.props?.testID === 'card-provider-mark').length, 0, kind);
      assert.doesNotMatch(text(root), new RegExp(UNLISTED[0].slice(0, 8)), kind);
      await act(async () => h.agents.settle()); await wait();
      assert.equal(nameOf().props.children, name, kind + ': ' + answer);
      assert.equal(card().findAll(n => n.props?.testID === 'card-provider-mark').length > 0, true, kind);
    }
  }
  const { assigneeName, PENDING_NAME } = harness().load('client/card-meta.ts');
  assert.equal(assigneeName(UNLISTED[1], undefined, true), PENDING_NAME);
  assert.equal(assigneeName(UNLISTED[1], undefined, false), UNLISTED[1].slice(0, 8));
  assert.equal(assigneeName(UNLISTED[1], { title: 'Named' }, true), 'Named', 'a known name always wins');
});

test('REQ-78 ④ a failed agent listing leaves no "…": the id is the name at once, as before', async t => {
  const h = harness({ width: 1400, link: [UNLISTED[0]], agentsFail: true });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const name = hosts(root, 'card-agent-name')[0];
  assert.equal(name.props.children, UNLISTED[0].slice(0, 8));
});

test('REQ-78 ⑤ the project names and the workspaces are asked for at once', async t => {
  for (const kind of REQ78_SCREENS) {
    const { h, root } = await openPlaced(t, kind, {}, h => h.listing.hold('projects'));
    assert.deepEqual(h.listing.waiting(), ['projects'], kind);
    assert.ok(h.sdkCalls.includes('workspaces'), kind + ': the workspace listing did not wait for the project names');
    assert.equal(hosts(root, 'directory-ready').length, 0, kind + ': joining them still waits for both');
    await act(async () => h.listing.release()); await wait();
    assert.equal(hosts(root, 'directory-ready').length, 1, kind);
  }
});

/**
 * REQ-77+78 gate a: a screen's first frame — rendered with its read already asked but not yet answered — and
 * every word it puts on screen or reads out (text, labels, placeholders).
 */
function firstFrame(t, Component, props) {
  let root, gone = false; act(() => { root = Renderer.create(React.createElement(Component, props)); });
  const unmount = root.unmount.bind(root);
  root.unmount = () => { if (!gone) { gone = true; unmount(); } };
  afterOnce(t, async () => { await act(async () => root.unmount()); });
  return root;
}
function frameWords(root) {
  const words = [];
  for (const node of root.root.findAll(n => typeof n.type === 'string')) {
    for (const child of node.children) if (typeof child === 'string') words.push(child);
    for (const key of ['accessibilityLabel', 'placeholder']) if (typeof node.props[key] === 'string') words.push(node.props[key]);
  }
  return words;
}
/** The English phrases a Korean screen must never show, even for a frame (those the Korean copy says differently). */
function englishOnly(h) {
  const { copy } = h.load('client/i18n.ts'), en = copy('en'), ko = copy('ko');
  return Object.keys(en).filter(key => typeof en[key] === 'string' && en[key] !== ko[key] && /[A-Za-z]{3}/.test(en[key])).map(key => en[key]);
}
const GATE_A_SCREENS = [['wide', { width: 1400 }], ['phone', { mobile: true }], ['list', { width: 1400 }], ['board', { width: 1400 }]];
function openFirstFrame(t, h, kind) {
  if (kind === 'list') h.load('client/session-store.ts').sessionFor(h.props.host.id + ':surface').set('mode', 'list');
  return kind === 'board' ? firstFrame(t, h.load('client/board.tsx').BoardScreen, { ...h.props, selector: { boardId: h.base.id } })
    : firstFrame(t, h.load('client/overview.tsx').OverviewScreen, h.props);
}
test('REQ-77+78 gate a: a Korean ledger never shows English first — no words before its first read ever answered, then the kept language at once', async t => {
  const saved = globalThis.localStorage, kept = new Map();
  globalThis.localStorage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)) };
  t.after(() => { globalThis.localStorage = saved; });
  for (const [kind, options] of GATE_A_SCREENS) {
    kept.clear();
    const h = harness({ ...options, locale: 'ko' }), english = englishOnly(h);
    const shown = root => frameWords(root).filter(word => english.some(phrase => word.includes(phrase)));
    // Never opened in this browser: the screen's background only, until the read answers in Korean.
    const first = openFirstFrame(t, h, kind);
    assert.equal(hosts(first, 'locale-pending').length, 1, kind + ': nothing kept, so no words yet');
    assert.deepEqual(frameWords(first), [], kind + ': not one word before the language is known');
    await wait(); await wait();
    assert.equal(hosts(first, 'locale-pending').length, 0, kind + ': the read answered');
    assert.deepEqual(shown(first), [], kind + ': in Korean');
    assert.ok(frameWords(first).some(word => /[가-힣]/.test(word)), kind + ': Korean words on screen');
    assert.equal(kept.get('paseo-kanban:locale:host_example'), 'ko', kind + ': the language is kept as a hint');
    await act(async () => first.unmount());
    // Reopened in this app session: Korean from the first frame, before the new read answers.
    const again = openFirstFrame(t, h, kind);
    assert.equal(hosts(again, 'locale-pending').length, 0, kind + ': reopened');
    assert.deepEqual(shown(again), [], kind + ': reopened, no English frame');
    assert.ok(frameWords(again).some(word => /[가-힣]/.test(word)), kind + ': reopened, Korean at once');
    await wait(); await act(async () => again.unmount());
    // A reload (a new app session, nothing in memory): the browser's hint gives Korean from the first frame.
    const reload = harness({ ...options, locale: 'ko' }), fresh = openFirstFrame(t, reload, kind);
    assert.equal(hosts(fresh, 'locale-pending').length, 0, kind + ': after a reload');
    assert.deepEqual(shown(fresh), [], kind + ': after a reload, no English frame');
    assert.ok(frameWords(fresh).some(word => /[가-힣]/.test(word)), kind + ': after a reload, Korean at once');
    await wait(); await act(async () => fresh.unmount());
    // The read always wins over the hint: a ledger switched to English shows English and keeps that.
    const switched = harness({ ...options, locale: 'en' }), turned = openFirstFrame(t, switched, kind);
    await wait(); await wait();
    assert.ok(frameWords(turned).some(word => englishOnly(switched).some(phrase => word.includes(phrase))), kind + ': English once the read says so');
    assert.equal(kept.get('paseo-kanban:locale:host_example'), 'en', kind + ': and keeps it');
    await act(async () => turned.unmount());
  }
});
test('REQ-77+78 gate b: the Kanban surface mounted twice (Paseo restoring the route) asks for the listing once, and both are placed', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  h.listing.hold('projects'); h.listing.hold('workspaces');
  const one = await render(t, OverviewScreen, h.props), two = await render(t, OverviewScreen, h.props);
  assert.deepEqual([listings(h, 'projects'), listings(h, 'workspaces')], [1, 1], 'one project listing and one workspace listing between them');
  await act(async () => h.listing.release()); await wait();
  for (const root of [one, two]) assert.equal(hosts(root, 'directory-ready').length, 1, 'each screen is placed by the shared answer');
  assert.deepEqual([listings(h, 'projects'), listings(h, 'workspaces')], [1, 1]);
});
test('REQ-77+78 gate b: switching to the list before the board\'s listing answered asks once; a manual refresh still asks at once', async t => {
  for (const [from, to] of [['view-list', 'wide'], ['view-toggle', 'phone']]) {
    const { h, root } = await openPlaced(t, to, {}, h => { h.listing.hold('projects'); h.listing.hold('workspaces'); });
    await act(async () => sheetButton(root, from).props.onPress());
    assert.equal(hosts(root, 'list-title-row').length, 1, to + ': now on the list');
    assert.deepEqual([listings(h, 'projects'), listings(h, 'workspaces')], [1, 1], to + ': the list shares the board\'s listing');
    await act(async () => labelled(root, 'Refresh').props.onPress());
    assert.deepEqual([listings(h, 'projects'), listings(h, 'workspaces')], [2, 2], to + ': a refresh does not wait for the one on its way');
    await act(async () => h.listing.release()); await wait();
    assert.equal(hosts(root, 'directory-ready').length, 1, to);
    assert.match(text(root), /Example Workspace/, to + ': placed');
  }
});
test('REQ-77+78 gate a: with nothing kept, a first read that fails still shows its error (in English, as before), not a blank screen', async t => {
  for (const [kind, options] of GATE_A_SCREENS) {
    const h = harness(options); h.fail();
    const root = openFirstFrame(t, h, kind);
    await wait(); await wait();
    assert.equal(hosts(root, 'locale-pending').length, 0, kind);
    assert.ok(frameWords(root).some(word => word.includes('Synthetic connection failure')), kind + ': the error is on screen');
    await act(async () => root.unmount());
  }
});

// ---- REQ-82: an archived card says it waits to be confirmed done, and any card moves at once ----
/** Every string under a rendered node (a node with no children has none). */
function textOf(node) { return (node?.children ?? []).map(v => typeof v === 'string' ? v : textOf(v)).join(''); }
/** The host nodes with this testID inside the card titled `title`. */
function inCard(root, title, testID) {
  return labelled(root, title).findAll(n => n.props?.testID === testID && typeof n.type === 'string');
}
/** The box around the card titled `title`: it follows the pointer and the focus for the whole card (REQ-82 F1·F2). */
function cardArea(root, title) {
  let node = labelled(root, title);
  while (node && !(node.props?.testID === 'card-shadow' && node.props.onPointerEnter)) node = node.parent;
  return node;
}
/** Line two of the card titled `title`: the row that holds its name. */
function lineTwo(root, title) {
  return labelled(root, title).findAll(n => typeof n.type === 'string' && n.props?.testID === 'card-agent')[0].parent;
}
async function archivedBoard(t, options = {}) {
  const h = harness({ width: 1400, link: [AGENT_A], agents: [{ id: AGENT_A, status: 'idle' }], ...options });
  h.external({ awaiting: null });
  h.addCard(add('Loose card'));
  h.addCard({ ...add('Loose idea'), intent: 'draft', acceptanceCriteria: '' });
  const { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  if (options.mobile) await act(async () => labelled(root, options.locale === 'ko' ? '대기 3' : 'To Do 3').props.onPress());
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', archivedAt: '2026-09-22' }));
  return { h, root };
}
test('REQ-82 ① "Archived · confirm done" only where every agent is archived; "No assignee" only where none was ever linked', async t => {
  const { h, root } = await archivedBoard(t);
  const face = title => allText(inCard(root, title, 'card-agent')[0]);
  assert.equal(face('Example card'), 'Archived · confirm done', 'what the card waits for');
  assert.equal(inCard(root, 'Example card', 'card-orphaned-mark')[0].props.accessibilityLabel, 'Agent archived · confirm it is done');
  assert.match(JSON.stringify(nativeNode(root, 'card-orphaned-mark')), /"name":"Archive"/, 'an archive mark, not a missing person');
  assert.doesNotMatch(face('Example card'), /No assignee/);
  assert.equal(face('Loose card'), 'No assignee', 'a card no agent was linked to');
  const loose = inCard(root, 'Loose card', 'card-agent-name')[0];
  assert.equal(loose.props.style.color, readable(palette(h.props.theme).foregroundMuted, palette(h.props.theme).card), 'quietly');
  assert.equal(face('Loose idea'), '', 'a draft already says "Instruction draft"');
  // The attention count takes the archived card (and the draft, as before), not the unassigned one; the folded lane says why.
  assert.equal(nativeNode(root, 'attention-count').children[0], '2');
  await act(async () => labelled(root, 'Collapse workspace: Example Workspace').props.onPress());
  assert.equal(hosts(root, 'lane-urgent-badge')[0].props.accessibilityLabel, 'Confirm done 1');
  assert.doesNotMatch(text(root), /No assignee 1/);
  // In Korean too.
  const ko = copy => [copy.archivedReview, copy.signalOrphaned, copy.signalOrphanedCount(2), copy.noAssignee];
  assert.deepEqual(ko(h.load('client/i18n.ts').copy('ko')), ['보관됨 · 완료 확인', '에이전트 보관됨 · 완료 확인 필요', '완료 확인 2', '담당 없음']);
});
test('REQ-82 ① a done card says neither, and a done card that loses its agent is not asked to be confirmed again', async t => {
  const { h, root } = await archivedBoard(t);
  const { CardTile } = h.load('client/components.tsx'), { SignalContext } = h.load('client/signal-context.tsx');
  const { staticSignalSource } = h.load('client/agent-signals.ts'), { copy } = h.load('client/i18n.ts');
  const { QuickMoveContext } = h.load('client/quick-move.tsx');
  const tile = (card, countsAsDone) => render(t, SignalContext.Provider, { value: staticSignalSource({ [AGENT_A]: 'idle' }, [AGENT_A]),
    children: React.createElement(QuickMoveContext.Provider, { value: { touch: true, move() {}, openMenu() {}, busy: () => false } },
      React.createElement(CardTile, { card, countsAsDone, boardId: h.base.id, stages: h.base.template.stages, labels: {},
        colors: palette(h.props.theme), m: copy('en'), onPress() {} })) });
  const base = toBoardDTO(h.base).stages[0].cards[0];
  const done = await tile({ ...base, stageId: 'done', agentIds: [AGENT_A], agents: 1 }, true);
  assert.equal(hosts(done, 'card-orphaned-mark').length, 0); assert.equal(hosts(done, 'card-done').length, 0);
  const none = await tile({ ...base, stageId: 'done', agentIds: [], agents: 0 }, true);
  assert.doesNotMatch(text(none), /No assignee/);
  assert.ok(root);
});
test('REQ-82 ② the wide card shows "→ Done" on hover or keyboard focus without changing size, and one press moves it with undo', async t => {
  const page = keyPage(t);
  const { h, root } = await archivedBoard(t);
  const id = h.base.cards[0].id, card = () => labelled(root, 'Example card');
  const height = card().props.style.height, row = () => flatStyle(lineTwo(root, 'Example card').props.style);
  assert.equal(inCard(root, 'Example card', 'card-done').length, 0, 'hidden until the card is pointed at');
  assert.equal(row().minHeight, 18, 'line two keeps the button\'s room while it is hidden');
  // research/117 F1: the card's own hover ends as the pointer enters "Done" (the web keeps only the innermost
  // Pressable hovered), so it is the box around the card that follows the pointer. The browser test drives the real
  // pointer (spike/plugin-hello/evidence/r2-REQ82-fix/fix82-ui.mjs).
  assert.equal(card().props.onHoverIn, undefined); assert.equal(card().props.onHoverOut, undefined);
  const area = () => cardArea(root, 'Example card');
  await act(async () => area().props.onPointerEnter());
  const done = () => inCard(root, 'Example card', 'card-done')[0];
  assert.equal(done().props.accessibilityLabel, 'Move to Done');
  assert.equal(textOf(done()), '→ Done');
  assert.equal(done().props.style.height, 18); assert.equal(row().minHeight, 18);
  assert.equal(card().props.style.height, height, 'the card keeps its size');
  assert.equal(inCard(root, 'Loose card', 'card-done').length, 0, 'only the archived card offers it');
  await act(async () => area().props.onPointerLeave());
  assert.equal(inCard(root, 'Example card', 'card-done').length, 0);
  // A click's focus shows nothing (research/113); Tab onto the card does. As on the web, a control's own focus
  // handlers hear it and the box around the card hears it handed up.
  const focusOn = node => { node.props.onFocus(); area().props.onFocus(); };
  const blurFrom = node => { node.props.onBlur(); area().props.onBlur(); };
  const shown = () => [inCard(root, 'Example card', 'card-done').length, inCard(root, 'Example card', 'card-move-menu').length];
  await act(async () => focusOn(card()));
  assert.deepEqual(shown(), [0, 0], 'focus a click left');
  await act(async () => blurFrom(card())); await wait();
  await act(async () => { page.tab(); focusOn(card()); });
  assert.deepEqual(shown(), [1, 1], 'the keyboard\'s focus');
  // research/117 F2: Tab goes card → state mark → "Done" → ⋯, the order they are in, and none of it hides them.
  assert.deepEqual(labelled(root, 'Example card').findAll(n => typeof n.type === 'string'
    && ['card-signal-press', 'card-done', 'card-move-menu'].includes(n.props?.testID)).map(n => n.props.testID),
  ['card-signal-press', 'card-done', 'card-move-menu']);
  const mark = () => inCard(root, 'Example card', 'card-signal-press')[0], menu = () => inCard(root, 'Example card', 'card-move-menu')[0];
  await act(async () => { blurFrom(card()); page.tab(); focusOn(mark()); }); await wait();
  assert.deepEqual(shown(), [1, 1], 'Tab on to the state mark keeps them');
  await act(async () => { blurFrom(mark()); page.tab(); focusOn(done()); }); await wait();
  assert.deepEqual(shown(), [1, 1], 'Tab on to "Done" keeps them');
  await act(async () => { blurFrom(done()); page.tab(); focusOn(menu()); }); await wait();
  assert.deepEqual(shown(), [1, 1], 'Tab on to ⋯ keeps them');
  await act(async () => { blurFrom(menu()); page.tab(); focusOn(done()); }); await wait();
  assert.deepEqual(shown(), [1, 1], 'Shift+Tab back to "Done"');
  await act(async () => blurFrom(done())); await wait();
  assert.deepEqual(shown(), [0, 0], 'focus leaving the card hides them');
  // A click on the state mark (no keyboard) shows nothing either.
  await act(async () => focusOn(mark())); await wait();
  assert.deepEqual(shown(), [0, 0], 'a click on the state mark');
  await act(async () => blurFrom(mark())); await wait();
  await act(async () => { page.tab(); focusOn(card()); });
  const opened = () => root.root.findAllByType('NativeModal').filter(n => n.findAll(c => c.props?.testID === 'desktop-detail-dialog').length).length;
  await act(async () => { done().props.onPress({ stopPropagation() {} }); card().props.onPress(); });
  assert.equal(opened(), 0, 'the press is the button\'s, not the card\'s');
  const write = h.calls.filter(c => c.name === 'kanban.v1.board.mutate').at(-1);
  assert.deepEqual(write.input.operations, [{ op: 'move', id, to: 'done' }], 'the person\'s move through board.mutate (REQ-74 applies)');
  assert.equal(h.base.cards[0].stageId, 'done');
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Moved to DoneUndo/);
  await act(async () => sheetButton(root, 'move-undo').props.onPress());
  assert.equal(h.base.cards[0].stageId, 'todo', 'undo moves it back');
  assert.deepEqual(h.calls.filter(c => c.name === 'kanban.v1.board.mutate').at(-1).input.operations, [{ op: 'move', id, to: 'todo' }]);
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Moved back to To Do/);
});
test('REQ-82 ② on a phone "완료로" always shows on the archived card, with a 44px reach, and a tap still opens the card', async t => {
  const { h, root } = await archivedBoard(t, { mobile: true, platform: 'android', width: 390, locale: 'ko' });
  const done = () => inCard(root, 'Example card', 'card-done')[0];
  assert.ok(done(), 'no hover on a phone');
  assert.equal(textOf(done()), '완료로'); assert.equal(done().props.accessibilityLabel, '완료로 옮기기');
  assert.equal(18 + done().props.hitSlop.top + done().props.hitSlop.bottom, 44);
  assert.equal(inCard(root, 'Example card', 'card-move-menu').length, 0, 'no ⋯ on a phone: a long press opens the menu');
  // A screen reader gets both moves from the card itself.
  assert.deepEqual(labelled(root, 'Example card').props.accessibilityActions.map(a => a.label), ['다른 단계로 옮기기', '완료로 옮기기']);
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.equal(hosts(root, 'editor-sheet').length, 1, 'a tap opens the detail as before');
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.board.mutate').length, 0);
});
test('REQ-82 ③ a wide card\'s ⋯ opens its stages and one pick moves it at once; the card press still opens the detail', async t => {
  const { h, root } = await archivedBoard(t);
  const card = () => labelled(root, 'Loose card'), id = h.base.cards[1].id;
  assert.equal(inCard(root, 'Loose card', 'card-move-menu').length, 0);
  await act(async () => cardArea(root, 'Loose card').props.onPointerEnter());
  const menu = inCard(root, 'Loose card', 'card-move-menu')[0];
  assert.equal(menu.props.accessibilityLabel, 'Move to another stage: Loose card');
  assert.equal(flatStyle(menu.props.style).position, 'absolute', 'over the card, so it never grows');
  await act(async () => { menu.props.onPress({ stopPropagation() {} }); card().props.onPress(); });
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 0, 'the ⋯ press is not the card\'s');
  const sheet = hosts(root, 'menu-sheet')[0];
  assert.equal(sheet.props['aria-label'], 'Move: Loose card');
  const pick = stage => sheetButton(root, 'move-to-' + stage);
  assert.equal(pick('todo').props.accessibilityState.disabled, true, 'the current stage is marked, not offered');
  assert.match(textOf(pick('todo')), /To Do · Current stage/);
  await act(async () => pick('review').props.onPress());
  assert.equal(hosts(root, 'menu-sheet').length, 0, 'the menu closes');
  assert.deepEqual(h.calls.filter(c => c.name === 'kanban.v1.board.mutate').at(-1).input.operations, [{ op: 'move', id, to: 'review' }]);
  assert.equal(h.base.cards[1].stageId, 'review');
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Moved to ReviewUndo/);
  await act(async () => labelled(root, 'Loose card').props.onPress());
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 1, 'the card opens its detail as before');
});
test('REQ-82 ③ a phone long-presses a card for its stages; a draft is offered the first stage and (REQ-97) the working one', async t => {
  const { h, root } = await archivedBoard(t, { mobile: true, platform: 'ios', width: 390 });
  const idea = labelled(root, 'Loose idea');
  assert.equal(idea.props.accessibilityHint, 'Long press to move it to another stage');
  await act(async () => idea.props.onLongPress());
  assert.equal(hosts(root, 'editor-sheet').length, 0, 'a long press is not a tap');
  assert.match(text(root), /Drafts stay in the first stage/);
  assert.equal(sheetButton(root, 'move-to-doing').props.accessibilityState.disabled, false, 'REQ-97: sent to the lead from there');
  for (const stage of ['review', 'done']) assert.equal(sheetButton(root, 'move-to-' + stage).props.accessibilityState.disabled, true, stage);
  await act(async () => root.root.findAllByType('NativeModal').at(-1).props.onRequestClose());
  await act(async () => labelled(root, 'Loose card').props.onLongPress());
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  assert.equal(h.base.cards[1].stageId, 'doing');
  assert.equal(h.base.cards[2].stageId, 'todo', 'the draft never moved');
});
test('REQ-82 ③ a card moved on a board the server changed meanwhile is sent once more against the latest board', async t => {
  const { h, root } = await archivedBoard(t);
  h.external({ notes: 'Changed elsewhere' });
  await act(async () => cardArea(root, 'Loose card').props.onPointerEnter());
  await act(async () => inCard(root, 'Loose card', 'card-move-menu')[0].props.onPress({ stopPropagation() {} }));
  await act(async () => sheetButton(root, 'move-to-review').props.onPress());
  const writes = h.calls.filter(c => c.name === 'kanban.v1.board.mutate');
  assert.equal(writes.length, 2, 'refused once for the old revision, then sent against the new one');
  assert.notEqual(writes[0].input.ifRevision, writes[1].input.ifRevision);
  assert.equal(h.base.cards[1].stageId, 'review');
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Moved to Review/);
});
test('REQ-82 G1 undo goes back where the ledger had the card, not where the screen showed it — and not at all once it moved again', async t => {
  const { h, root } = await archivedBoard(t);
  const pick = async to => {
    await act(async () => cardArea(root, 'Loose card').props.onPointerEnter());
    await act(async () => inCard(root, 'Loose card', 'card-move-menu')[0].props.onPress({ stopPropagation() {} }));
    await act(async () => sheetButton(root, 'move-to-' + to).props.onPress());
  };
  const writes = () => h.calls.filter(c => c.name === 'kanban.v1.board.mutate');
  // An agent's turn moved it to In progress; the screen, not read since, still shows it in To Do.
  h.externalMove('doing', 1);
  await pick('review');
  assert.equal(h.base.cards[1].stageId, 'review');
  await act(async () => sheetButton(root, 'move-undo').props.onPress());
  assert.equal(h.base.cards[1].stageId, 'doing', 'the stage the ledger had before the move, not the one on screen');
  assert.deepEqual(writes().at(-1).input.operations, [{ op: 'move', id: h.base.cards[1].id, to: 'doing' }]);
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Moved back to In progress/);
  // Moved again in between: the undo sends nothing and says why.
  await pick('done');
  assert.equal(h.base.cards[1].stageId, 'done');
  h.externalMove('review', 1);
  const before = writes().length;
  await act(async () => sheetButton(root, 'move-undo').props.onPress());
  assert.equal(writes().length, before, 'nothing sent');
  assert.equal(h.base.cards[1].stageId, 'review', 'the later move stands');
  assert.equal(textOf(nativeNode(root, 'move-toast')).startsWith('The card was moved again meanwhile, so it was not moved back.'), true);
  assert.equal(hosts(root, 'move-undo').length, 0);
});
test('REQ-82 ③ the demo offers no quick move', async t => {
  devDemo();
  const h = harness({ width: 1400 }); devDemo();
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await toggleDemo(root);
  const demoCard = root.root.findAllByType('Pressable').find(p => p.props.testID?.startsWith('kanban-card-demo_'));
  assert.equal(demoCard.props.onHoverIn, undefined); assert.equal(demoCard.props.onLongPress, undefined);
  assert.equal(hosts(root, 'card-done').length, 0);
});
test('REQ-82 ④ / REQ-88 ④ an archived card\'s detail offers "Confirm and move to Done" at the end of the flow with its reason; a draft\'s flow offers only the first stage', async t => {
  const { h, root } = await archivedBoard(t);
  await act(async () => labelled(root, 'Example card').props.onPress());
  const confirm = () => sheetButton(root, 'detail-confirm-done');
  assert.equal(textOf(confirm()), 'Confirm and move to Done');
  const words = text(root);
  assert.ok(words.indexOf('"stage-bar"') < words.indexOf('detail-confirm-done'), 'after the flow — right of "Done" on a wide screen');
  assert.equal(confirm().props.style.minHeight, 28, 'a small button there');
  assert.match(allText(hosts(root, 'detail-confirm-reason')[0]), /Every linked agent is archived — confirm it is done/, 'and why it is offered');
  const c = palette(h.props.theme);
  assert.equal(confirm().props.style.backgroundColor, c.accent, 'the main action');
  await act(async () => confirm().props.onPress());
  assert.equal(h.base.cards[0].stageId, 'done');
  assert.equal(hosts(root, 'detail-confirm-done').length, 0, 'done: nothing left to confirm');
  assert.match(textOf(hosts(root, 'move-toast')[0]), /^Moved to DoneUndo/);
  // A phone: the reason, then a 44px button under the flow.
  const phone = await archivedBoard(t, { mobile: true, platform: 'ios', width: 390 });
  await act(async () => labelled(phone.root, 'Example card').props.onPress());
  const small = sheetButton(phone.root, 'detail-confirm-done'), text2 = text(phone.root);
  assert.equal(small.props.style.minHeight, 44); assert.equal(small.props.style.alignSelf, 'stretch');
  assert.ok(text2.indexOf('detail-confirm-reason') < text2.indexOf('detail-confirm-done'), 'under the reason line');
  // A draft: the other stages are there, and not offered — REQ-97: but the working one, which sends it to the lead.
  const d = await detail(t);
  d.h.addCard({ ...add('Idea'), intent: 'draft', acceptanceCriteria: '' });
  const { Detail } = d.h.load('client/detail.tsx');
  const draft = await render(t, Detail, { ...d.h.props, boardId: d.h.base.id, cardId: d.h.base.cards[1].id, locale: 'en', onClose() {} });
  assert.equal(sheetButton(draft, 'stage-bar-doing').props.accessibilityState.disabled, false);
  for (const stage of ['review', 'done']) assert.equal(sheetButton(draft, 'stage-bar-' + stage).props.accessibilityState.disabled, true);
  assert.equal(hosts(draft, 'detail-confirm-done').length, 0);
});
test('REQ-82 ④ / REQ-88 ④ five or more stages scroll sideways, open on the current one and show there is more; the flow reads in every theme choice', async t => {
  const h = harness({ width: 1400 });
  const { StageBar } = h.load('client/quick-move.tsx'), { copy } = h.load('client/i18n.ts');
  const stages = ['a', 'b', 'c', 'd', 'e'].map(id => ({ stageId: id, name: 'Stage ' + id }));
  const bar = (list, colors, current = list[0].stageId) => render(t, StageBar, { stages: list, current, allowed: () => true, disabled: false,
    onPick() {}, colors, m: copy('en'), mobile: true, background: colors.surface0 });
  const five = await bar(stages, palette(h.props.theme));
  assert.equal(hosts(five, 'stage-bar-scroll').length, 1, 'five stages scroll sideways');
  assert.equal(sheetButton(five, 'stage-bar-a').props.style.flex, undefined, 'a pill is as wide as its name');
  const four = await bar(stages.slice(0, 4), palette(h.props.theme));
  assert.equal(hosts(four, 'stage-bar-scroll').length, 0, 'four sit on one line');
  // research/117 G2: a 390 phone fits about four; it opens on the current stage and shows there is more.
  const six = [...stages, { stageId: 'f', name: 'Stage f' }], scrolled = [];
  const sixBar = current => render(t, StageBar, { stages: six, current, allowed: () => true, disabled: false, onPick() {},
    colors: palette(h.props.theme), m: copy('en'), mobile: true, background: palette(h.props.theme).surface0 },
  { createNodeMock: element => element.props.testID === 'stage-bar-scroll' ? { scrollTo: value => scrolled.push(value.x) } : null });
  const lay = async root => {
    const scroll = root.root.findAll(n => n.props?.testID === 'stage-bar-scroll' && n.props.onLayout)[0];
    await act(async () => { scroll.props.onLayout({ nativeEvent: { layout: { width: 356 } } }); scroll.props.onContentSizeChange(552, 44);
      six.forEach((stage, index) => sheetButton(root, 'stage-bar-' + stage.stageId).props.onLayout({ nativeEvent: { layout: { x: index * 92, width: 88 } } })); });
    return scroll;
  };
  const edges = root => ['start', 'end'].map(side => hosts(root, 'stage-bar-more-' + side).length);
  const first = await sixBar('a'); await lay(first);
  assert.deepEqual(scrolled, [], 'the first stage is in view already');
  assert.deepEqual(edges(first), [0, 1], 'more to the right');
  const fifth = await sixBar('e'), scroll = await lay(fifth);
  assert.deepEqual(scrolled, [196], 'scrolled so the fifth stage (x 368) is in view — as far as the bar goes');
  assert.deepEqual(edges(fifth), [1, 0], 'more to the left');
  await act(async () => scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 100 } } }));
  assert.deepEqual(edges(fifth), [1, 1]);
  await act(async () => sheetButton(fifth, 'stage-bar-more-end').props.onPress());
  assert.equal(scrolled.at(-1), 196, 'the chevron scrolls on');
  assert.equal(sheetButton(fifth, 'stage-bar-more-start').props.accessibilityElementsHidden, true, 'a screen reader moves along the stages themselves');
  const pill = sheetButton(four, 'stage-bar-a').props.style;
  assert.equal(pill.height, 32); assert.equal(pill.height + 2 * pill.marginVertical, 44, 'a phone\'s 44px reach');
  for (const host of [PASEO_THEMES.light, PASEO_THEMES.dark]) for (const choice of ['paseo', 'system', 'light', 'dark']) for (const system of ['light', 'dark']) {
    const colors = palette(resolveTheme(host, choice, system)), root = await bar(stages.slice(0, 4), colors, 'b');
    const tint = sheetButton(root, 'stage-bar-b').props.style.backgroundColor, name = id => sheetButton(root, 'stage-bar-' + id).findAllByType('Text')[0].props.style;
    assert.equal(tint, selectedTint(colors, colors.surface0), `${choice}/${system}: the current stage is the main colour's tint (REQ-85)`);
    assert.ok(contrast(name('b').color, tint) >= 4.5 && name('b').fontWeight === '600', 'its name reads, in bold');
    assert.ok(contrast(name('a').color, colors.surface0) >= 4.5, 'a stage passed reads');
    assert.ok(contrast(name('c').color, colors.surface0) >= 4.5, 'the next stages\' names read');
    assert.ok(contrast(readable(colors.accentForeground, colors.accent), colors.accent) >= 4.5, 'the Done buttons\' words');
    assert.ok(contrast(readable(colors.accent, colors.surface2), colors.surface2) >= 4.5, 'Undo');
    assert.ok(contrast(readable(colors.statusDotWarning, colors.card), colors.card) >= 4.5, '"Archived · confirm done"');
  }
});

// REQ-79/80/81: the card order, the tool glyphs' hover and on line, their tips below, and where the layout tools sit.
/** The titles of the cards a cell shows, top to bottom. */
const cellTitles = (root, testID) => hosts(root, testID)[0].findAllByType('Pressable')
  .filter(p => typeof p.type === 'string' && String(p.props.testID).startsWith('kanban-card-')).map(p => p.props.accessibilityLabel);
/** Example card (made 01-01) plus three more a day apart; "Made second" changed last. */
function orderedHarness(options = {}) {
  const h = harness({ width: 1400, ...options });
  h.addCard(add('Made second'), '2026-01-02T00:00:00.000Z');
  h.addCard(add('Made third'), '2026-01-03T00:00:00.000Z');
  h.addCard(add('Made fourth'), '2026-01-04T00:00:00.000Z');
  h.touch('Made second', '2026-01-05T00:00:00.000Z');
  return h;
}
const ORDERS = { default: ['Example card', 'Made second', 'Made third'], updated: ['Made second', 'Made fourth', 'Made third'],
  created: ['Made fourth', 'Made third', 'Made second'] };

test('REQ-79 ① the sort glyph opens a menu of the three orders; a choice sorts every cell at once, closes the menu and is one write', async t => {
  const h = orderedHarness(), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props), before = h.calls.length;
  const trigger = () => sheetButton(root, 'sort-menu'), menu = () => hosts(root, 'sort-menu-list');
  assert.deepEqual(cellTitles(root, 'swimlane-cell-todo'), ORDERS.default, 'the ledger order to begin with');
  assert.equal(trigger().props.accessibilityLabel, 'Sort cards: Default (priority, then oldest)');
  assert.equal(trigger().findByType('Icon').props.name, 'ArrowDownWideNarrow');
  assert.equal(menu().length, 0);
  await act(async () => trigger().props.onPress());
  assert.equal(menu().length, 1, 'a press opens the menu');
  assert.equal(trigger().props.accessibilityState.expanded, true);
  const options = () => ['default', 'updated', 'created'].map(id => sheetButton(root, 'sort-option-' + id));
  assert.deepEqual(options().map(o => o.props.accessibilityLabel), ['Default (priority, then oldest)', 'Latest change first', 'Newest first']);
  assert.deepEqual(options().map(o => o.props.accessibilityState.checked), [true, false, false]);
  const c = palette(h.props.theme);
  // REQ-85 ③ (③B): the chosen row is tinted only — bold words and a check mark, no line.
  assert.equal(options()[0].props.style.backgroundColor, selectedTint(c, c.surface1), 'the chosen row is tinted');
  assert.equal(options()[0].props.style.borderWidth, undefined, 'no line');
  await act(async () => options()[1].props.onPress());
  assert.equal(menu().length, 0, 'choosing closes it');
  assert.deepEqual(cellTitles(root, 'swimlane-cell-todo'), ORDERS.updated, 'and sorts the cell at once, before the 3-card cut');
  assert.deepEqual(h.ui.writes, [{ hostId: h.props.host.id, settings: { cardOrder: 'updated' } }], 'one settings row');
  assert.equal(h.calls.length, before + 1);
  assert.equal(trigger().props.style.backgroundColor, selectedTint(c, c.surface0), 'on (tinted) while the order is not the default');
  assert.equal(trigger().findByType('Icon').props.color, selectedLine(c, selectedTint(c, c.surface0)));
  await act(async () => trigger().props.onPress());
  await act(async () => sheetButton(root, 'sort-menu-dismiss').props.onPress());
  assert.equal(menu().length, 0, 'a press outside closes it unchanged');
  await act(async () => trigger().props.onPress());
  await act(async () => root.root.findAllByType('NativeModal').find(n => n.props.testID === 'sort-menu-modal').props.onRequestClose());
  assert.equal(menu().length, 0, 'so does Escape');
  assert.equal(h.ui.writes.length, 1);
  await act(async () => trigger().props.onPress());
  await act(async () => sheetButton(root, 'sort-option-created').props.onPress());
  assert.deepEqual(cellTitles(root, 'swimlane-cell-todo'), ORDERS.created);
  await act(async () => trigger().props.onPress());
  await act(async () => sheetButton(root, 'sort-option-default').props.onPress());
  assert.deepEqual(cellTitles(root, 'swimlane-cell-todo'), ORDERS.default);
  assert.deepEqual(h.ui.writes.map(w => w.settings.cardOrder), ['updated', 'created', 'default']);
  assert.equal(trigger().props.style.borderWidth, 1, 'back to the thin edge of a switch that is off');
  // Opening all the columns keeps the order; the preview "+1" counts what the cut left.
  assert.equal(allText(sheetButton(root, 'cell-more')), '+1');
});

test('REQ-79 ② the order is remembered per host and the workspace board and the phone follow it; the demo never saves', async t => {
  const h = orderedHarness({ uiSettings: { cardOrder: 'created' } });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  assert.deepEqual(cellTitles(root, 'swimlane-cell-todo'), ORDERS.created, 'read back from ui-state');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.ui.writes.length, 0, 'reading it writes nothing');
  // The board: every column in the same order, and its own sort glyph shares the choice (same scope).
  const { BoardScreen } = h.load('client/board.tsx');
  const b = await render(t, BoardScreen, { ...h.props, selector: { boardId: h.base.id }, onBack: () => {} });
  await act(async () => b.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  assert.deepEqual(cellTitles(b, 'board-cell-todo'), ['Made fourth', 'Made third', 'Made second', 'Example card']);
  await act(async () => sheetButton(b, 'sort-menu').props.onPress());
  await act(async () => sheetButton(b, 'sort-option-updated').props.onPress());
  assert.deepEqual(cellTitles(b, 'board-cell-todo'), ['Made second', 'Made fourth', 'Made third', 'Example card']);
  assert.deepEqual(cellTitles(root, 'swimlane-cell-todo'), ORDERS.updated, 'the swimlane board follows at once');
  assert.deepEqual(h.ui.writes, [{ hostId: h.props.host.id, settings: { cardOrder: 'updated' } }]);
  // 390px: the filter sheet's second row, three 44px choices; the phone board follows.
  const m = orderedHarness({ mobile: true, platform: 'web', width: 390 });
  const phone = await render(t, m.load('client/overview.tsx').OverviewScreen, m.props);
  assert.equal(hosts(phone, 'sort-menu').length, 0, 'no glyph in the 390px top bar');
  await act(async () => sheetButton(phone, 'open-filters').props.onPress());
  const row = nativeNode(phone, 'swimlane-filters');
  assert.deepEqual(row.children.slice(0, 3).map(n => n.props.testID), ['group-toggle-row', 'fold-all-row', 'sort-choice-row'],
    'under "group by project" (and REQ-85 ⑦\'s fold row)');
  const choices = ['default', 'updated', 'created'].map(id => sheetButton(phone, 'sort-choice-' + id));
  assert.deepEqual(choices.map(n => allText(n)), ['Default', 'Changed', 'Newest']);
  assert.ok(choices.every(n => n.props.style.minHeight >= 44), 'thumb-sized');
  assert.equal(choices[0].props.accessibilityState.checked, true);
  await act(async () => choices[2].props.onPress());
  assert.equal(sheetButton(phone, 'sort-choice-created').props.accessibilityState.checked, true);
  // REQ-85 ③ (③B): the chosen choice is tinted only.
  const pc = palette(m.props.theme);
  assert.equal(sheetButton(phone, 'sort-choice-created').props.style.backgroundColor, selectedTint(pc, pc.surface1));
  assert.equal(sheetButton(phone, 'sort-choice-created').props.style.borderColor, 'transparent');
  assert.deepEqual(m.ui.writes, [{ hostId: m.props.host.id, settings: { cardOrder: 'created' } }]);
  // The demo sorts too, and writes nothing.
  const d = harness({ width: 1400 }); devDemo();
  const demo = await render(t, d.load('client/overview.tsx').OverviewScreen, d.props);
  await toggleDemo(demo);
  await act(async () => sheetButton(demo, 'sort-menu').props.onPress());
  await act(async () => sheetButton(demo, 'sort-option-created').props.onPress());
  const dc = palette(d.props.theme);
  assert.equal(sheetButton(demo, 'sort-menu').props.style.backgroundColor, selectedTint(dc, dc.surface0), 'on (REQ-85 ② tint)');
  assert.equal(d.ui.writes.length, 0, 'the demo never saves');
  assert.equal(m.load('client/i18n.ts').copy('ko').sortUpdated, '최근 변경순');
});

test('REQ-79 × REQ-82 a quick move under "latest change first" leads its new column; in the ledger order it takes its own place', async t => {
  // "Already doing" was made (and last changed) an hour before the example card, which is then moved beside it.
  for (const [order, expected] of [['updated', ['Example card', 'Already doing']], ['default', ['Already doing', 'Example card']]]) {
    const h = harness({ width: 1400, uiSettings: { cardOrder: order } });
    h.addCard({ ...add('Already doing'), stageId: 'doing' }, '2025-12-31T00:00:00.000Z');
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    assert.deepEqual(cellTitles(root, 'swimlane-cell-doing'), ['Already doing']);
    await act(async () => cardArea(root, 'Example card').props.onPointerEnter());
    await act(async () => inCard(root, 'Example card', 'card-move-menu')[0].props.onPress({ stopPropagation() {} }));
    await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
    assert.deepEqual(cellTitles(root, 'swimlane-cell-doing'), expected, order + ': the moved card, then the ledger read');
  }
});

test('REQ-80 ① a tool glyph under the mouse takes the hover fill; one that is on is outlined in the main colour', async t => {
  const h = harness({ width: 1400 }), props = { ...h.props, theme: PASEO_THEMES.dark };
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, props);
  const c = palette(props.theme), { hoverFill } = h.load('client/palette.ts');
  const refresh = () => labelled(root, 'Refresh'), group = () => sheetButton(root, 'group-toggle'), sort = () => sheetButton(root, 'sort-menu');
  const settings = () => sheetButton(root, 'open-settings'), list = () => sheetButton(root, 'view-list');
  const fills = () => [refresh(), group(), sort(), settings(), list()].map(n => n.props.style.backgroundColor);
  const rest = fills();
  for (const [index, node] of [refresh, group, sort, settings, list].entries()) {
    await act(async () => node().props.onHoverIn());
    assert.equal(fills()[index], hoverFill(c, index === 0 || index === 3 ? c.surface2 : c.surface0), 'hovered: glyph ' + index);
    assert.notEqual(fills()[index], rest[index]);
    await act(async () => node().props.onHoverOut());
    assert.deepEqual(fills(), rest, 'back when the mouse leaves');
  }
  // REQ-85 ② (②C): on, group by project and the current view are tinted with the main colour and their glyphs drawn in
  // it, with no line; off ones are not. The mouse over an "on" glyph deepens the tint instead of turning it grey.
  await act(async () => group().props.onPress());
  const tint = selectedTint(c, c.surface0), mark = selectedLine(c, tint);
  assert.deepEqual([group(), sheetButton(root, 'view-swimlane')].map(n => [n.props.style.backgroundColor, n.findByType('Icon').props.color,
    n.props.style.borderColor]), [[tint, mark, 'transparent'], [tint, mark, 'transparent']]);
  assert.deepEqual([list().props.style.borderWidth, sort().props.style.borderWidth], [0, 1]);
  await act(async () => group().props.onHoverIn());
  assert.equal(group().props.style.backgroundColor, selectedTint(c, c.surface0, true), 'hovered while on: a deeper tint');
  assert.notEqual(group().props.style.backgroundColor, hoverFill(c, c.surface0), 'never the grey of hover');
  await act(async () => group().props.onHoverOut());
  // A disabled glyph never lights up.
  const d = harness({ width: 1400 }); devDemo();
  const demo = await render(t, d.load('client/overview.tsx').OverviewScreen, { ...d.props, theme: PASEO_THEMES.dark });
  await toggleDemo(demo);
  const dimmed = labelled(demo, 'Refresh');
  await act(async () => dimmed.props.onHoverIn());
  assert.equal(labelled(demo, 'Refresh').props.style.backgroundColor, c.surface2);
});

test('REQ-80 ② every tool glyph\'s tip hangs below it (above near the bottom of the window), by the click and keyboard rule', async t => {
  const h = harness({ width: 1400 }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const tip = () => hosts(root, 'icon-tooltip')[0];
  for (const [name, node] of [['refresh', () => labelled(root, 'Refresh')], ['group', () => sheetButton(root, 'group-toggle')],
    ['sort', () => sheetButton(root, 'sort-menu')], ['view', () => sheetButton(root, 'view-list')], ['settings', () => sheetButton(root, 'open-settings')]]) {
    await act(async () => node().props.onHoverIn());
    const style = tip().props.style;
    assert.ok(style.top >= 30 && style.bottom === undefined, name + ': below the glyph');
    assert.ok(!(style.right > 0) && !(style.left > 0), name + ': never out to its side');
    // A click hides it and the focus the click leaves does not bring it back (research/113).
    await act(async () => node().props.onPressIn({ nativeEvent: { type: 'pointerdown' } }));
    await act(async () => node().props.onFocus());
    assert.equal(hosts(root, 'icon-tooltip').length, 0, name + ': gone once clicked');
    await act(async () => node().props.onHoverOut());
    await act(async () => node().props.onBlur());
    if (name === 'sort') { const modal = root.root.findAllByType('NativeModal').find(n => n.props.testID === 'sort-menu-modal');
      if (modal) await act(async () => modal.props.onRequestClose()); }
    if (name === 'view') await act(async () => sheetButton(root, 'view-swimlane').props.onPress());
    if (name === 'settings' && hosts(root, 'settings-window').length) await closeSettings(root);
  }
  // Keyboard focus shows the view switch's tip too (it used to show on any focus, a click's included).
  const view = () => sheetButton(root, 'view-list');
  await act(async () => view().props.onFocus());
  assert.equal(allText(tip()), 'View as list');
  await act(async () => view().props.onBlur());
  // Measured: near the bottom of the window the tip goes above, and on the left half it is anchored left.
  const { tipPlace } = h.load('client/components.tsx');
  assert.deepEqual(tipPlace({ x: 1300, y: 20, width: 30, height: 30 }, { width: 1400, height: 844 }), { side: 'below', align: 'right' });
  assert.deepEqual(tipPlace({ x: 40, y: 820, width: 30, height: 20 }, { width: 1400, height: 844 }), { side: 'above', align: 'left' });
  assert.deepEqual(tipPlace({ x: 40, y: 2, width: 30, height: 838 }, { width: 1400, height: 844 }), { side: 'below', align: 'left' },
    'no room either way: below');
  const low = harness({ width: 1400 });
  const measured = await render(t, low.load('client/overview.tsx').OverviewScreen, low.props,
    { createNodeMock: () => ({ measureInWindow: callback => callback(1300, 820, 30, 20), focus: () => {} }) });
  await act(async () => sheetButton(measured, 'open-settings').props.onHoverIn());
  const up = hosts(measured, 'icon-tooltip')[0].props.style;
  assert.ok(up.bottom >= 30 && up.top === undefined && up.right === 0, 'above, anchored at its right edge');
});

test('REQ-80 ③ the lane name and theme tips follow the same rule: gone after a click, shown for the keyboard', async t => {
  const h = harness({ width: 1400 }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const link = () => sheetButton(root, 'workspace-name-link'), tip = () => hosts(root, 'lane-name-tooltip').length;
  await act(async () => link().props.onHoverIn());
  assert.equal(tip(), 1);
  assert.ok(hosts(root, 'lane-name-tooltip')[0].props.style.top > 0, 'below the name');
  // A mouse click: press, the browser focuses the link; the mouse then leaves.
  await act(async () => link().props.onPressIn({ nativeEvent: { type: 'pointerdown' } }));
  await act(async () => link().props.onFocus());
  assert.equal(tip(), 0, 'a click hides it');
  await act(async () => link().props.onHoverOut());
  assert.equal(tip(), 0, 'the focus a click leaves is not the keyboard\'s');
  await act(async () => link().props.onBlur());
  await act(async () => link().props.onFocus());
  assert.equal(tip(), 1, 'Tab onto the name shows it');
  await act(async () => link().props.onBlur());
  await openSettings(root, 'display');
  const dark = () => sheetButton(root, 'theme-dark'), themeTip = () => hosts(root, 'theme-tooltip').length;
  await act(async () => dark().props.onHoverIn());
  assert.equal(themeTip(), 1);
  await act(async () => dark().props.onPressIn({ nativeEvent: { type: 'pointerdown' } }));
  await act(async () => dark().props.onFocus());
  assert.equal(themeTip(), 0, 'a click on a theme leaves no tip');
});

test('D51 a centred tip stays inside what can be seen of the window — a panel beside the plugin on either side — and wraps past 320px', async t => {
  const { centeredTip, tipMaxWidth, visibleSpan, TIP } = harness({ width: 1400 }).load('client/components.tsx');
  // A 30px glyph at the window's right end, a 190px tip: pulled left to 8px inside the edge.
  assert.equal(centeredTip(30, 190, { x: 1380, width: 30, window: 1400 }), 1400 - 8 - 190 - 1380);
  // The same glyph by the right edge of a pane that ends at 1180 (a host panel beside it): inside the pane, not the window.
  assert.equal(centeredTip(30, 190, { x: 1150, width: 30, window: 1180 }), 1180 - 8 - 190 - 1150);
  // A panel on the left over the window's first 300px: the tip starts 8px right of it.
  assert.equal(centeredTip(30, 211, { x: 320, width: 30, window: 1920, start: 300 }), 308 - 320);
  // Room for it centred: centred.
  assert.equal(centeredTip(30, 100, { x: 700, width: 30, window: 1400, start: 0 }), -35);
  // Too wide for the room: its left edge is the one kept.
  assert.equal(centeredTip(30, 400, { x: 100, width: 30, window: 300, start: 0 }), 8 - 100);
  assert.equal(TIP.maxWidth, 320);
  assert.equal(tipMaxWidth(undefined, 1920), 320, 'no more than 320, a longer tip wraps');
  assert.equal(tipMaxWidth({ x: 0, width: 30, window: 260, start: 0 }, 1920), 244, 'no wider than what can be seen');
  assert.equal(tipMaxWidth({ x: 0, width: 30, window: 1920, start: 0 }, 1920, 420), 420, 'a given width (the lane\'s mail) kept where it fits');
  assert.equal(tipMaxWidth({ x: 0, width: 30, window: 390, start: 0 }, 390, 420), 374, 'and cut to the room where it does not');
  // Nothing to read from (native, the renderer): the window's whole width.
  assert.deepEqual(visibleSpan(null, 1400), { start: 0, end: 1400 });
});
test('REQ-135 the family line\'s parts at each fit and how wide they are read: no count cut, the check giving way first', async t => {
  const h = harness({ width: 1400 }), { familyItems, familyWidth, lineTextWidth } = h.load('client/components.tsx');
  const en = h.load('client/i18n.ts').copy('en'), ko = h.load('client/i18n.ts').copy('ko');
  const status = { running: ['a'], testing: { at: '21:40', ids: ['c'] }, awaiting: ['b'], self: false, idle: null, working: false, me: { kind: 'working', since: '', agent: 'x' } };
  const moved = ['running', 'awaiting', 'testing'], family = { total: 11, open: 3 };
  const say = (fit, m = en) => familyItems(fit, family, status, moved, m).map(i => (i.icon ? '[' + i.icon + ']' : '') + i.label).join(' · ');
  assert.equal(say('full'), 'Sub-cards 11 · Running 1 · not done 3 · Needs you 1 · Testing 21:40~', 'the owner\'s order: running beside "Sub-cards"');
  assert.equal(say('full', ko), '하위 11 · 실행 중 1 · 미완료 3 · 결정 대기 1 · 테스트 중 21:40~');
  assert.equal(say('short'), 'Sub-cards 11 · Run 1 · open 3 · Needs 1 · Test 21:40~');
  assert.equal(say('clock', ko), '하위 11 · 실행 1 · 미완 3 · 대기 1 · [Clock]21:40~');
  assert.equal(say('icon'), 'Sub-cards 11 · Run 1 · open 3 · Needs 1 · [Clock]');
  assert.equal(say('drop'), 'Sub-cards 11 · Run 1 · open 3 · Needs 1');
  // research/275 F1: past 'drop' the words give way, the counts never — "Sub-cards" to its tree (FamilyPart draws it), then letters.
  assert.equal(say('tight'), '11 · Run 1 · open 3 · Needs 1');
  assert.equal(say('bare'), '11 · R 1 · o 3 · N 1');
  assert.equal(say('bare', ko), '11 · 실 1 · 미 3 · 대 1');
  // A screen reader always hears a part's whole words.
  assert.deepEqual(familyItems('icon', family, status, moved, en).filter(i => i.spoken).map(i => i.spoken), ['Running 1', 'Needs you 1', 'Testing 21:40~']);
  assert.deepEqual(familyItems('bare', family, status, moved, en).filter(i => i.spoken).map(i => i.spoken), ['Running 1', 'Needs you 1']);
  // No part moved (a lead with no agent of its own): the family line as before, whatever the fit.
  assert.equal(familyItems('drop', family, status, [], en).map(i => i.label).join('·'), 'Sub-cards 11·not done 3');
  // Each fit is narrower than the one before; a touch screen keeps every part 32px wide.
  const widths = ['full', 'short', 'clock', 'icon', 'drop', 'tight', 'bare'].map(fit => familyWidth(familyItems(fit, family, status, moved, en), false));
  assert.deepEqual([...widths].sort((a, b) => b - a), widths);
  // The gate's case (research/275 F1): 101 sub-cards, 100 running and awaiting, at 264px (246 inside) — 'tight' fits, as four figures do;
  // 'bare' keeps four figures in every part inside a 210px card (192 inside).
  const { familyFit } = h.load('client/lead-status.ts'), big = n => ({ ...status, running: Array(n).fill('a'), awaiting: Array(n).fill('b') });
  const fitAt = (n, room, m = en) => familyFit(fit => familyWidth(familyItems(fit, { total: n + 1, open: n + 1 }, big(n), moved, m), false), room);
  assert.equal(fitAt(100, 246), 'tight');
  assert.equal(fitAt(1000, 246), 'tight');
  assert.equal(fitAt(100, 246, ko), 'drop', 'Korean keeps its short words there');
  assert.ok(familyWidth(familyItems('bare', { total: 1001, open: 1001 }, big(1000), moved, en), false) <= 192);
  assert.ok(familyWidth(familyItems('icon', family, status, moved, en), true) > widths[3], 'a touch screen\'s 32px parts are wider');
  assert.ok(lineTextWidth('하위') === 22 && lineTextWidth('Ab1 ') === Math.ceil(7.2 + 5.6 + 6.2 + 3.5));
});
test('research/121 F1 a lane tip near the bottom of the board flips above against the scroll view, not the window', async t => {
  const { tipPlace } = harness({ width: 1400 }).load('client/components.tsx');
  const glyph = { x: 900, y: 806, width: 30, height: 30 }, window = { width: 1400, height: 900 };
  assert.equal(tipPlace(glyph, window).side, 'below', 'the window alone has room below');
  assert.equal(tipPlace(glyph, window, 22, { x: 0, y: 180, width: 1368, height: 666 }).side, 'above', 'the board ends at 846');
  assert.equal(tipPlace({ ...glyph, y: 770 }, window, 22, { x: 0, y: 180, width: 1368, height: 666 }).side, 'below', 'room left inside the board');
  assert.equal(tipPlace({ ...glyph, y: 190 }, window, 22, { x: 0, y: 180, width: 1368, height: 666 }).side, 'below', 'no room above inside it: below');
  assert.equal(tipPlace(glyph, window, 22, { x: 0, y: 0, width: 0, height: 0 }).side, 'below', 'an unmeasured area falls back to the window');
  // On the screen (an 844px window): the board's scroll view measures 180..740 and every glyph and name sits at 720.
  const mock = board => element => element.props?.testID === 'swimlane-vertical'
    ? (board ? { measureInWindow: callback => callback(0, 180, 1368, 560) } : {})
    : { measureInWindow: callback => callback(900, 720, 30, 30), focus: () => {} };
  for (const [board, side] of [[true, 'above'], [false, 'below']]) {
    const h = harness({ width: 1400 });
    // REQ-92: the lane glyph shows where a column leaves cards out, so this lane holds four to-do cards.
    for (let i = 0; i < 3; i++) h.addCard(add('Queued ' + i));
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props, { createNodeMock: mock(board) });
    const toggle = () => sheetButton(root, 'lane-toggle'), link = () => sheetButton(root, 'workspace-name-link');
    await act(async () => toggle().props.onHoverIn());
    const glyphTip = hosts(root, 'icon-tooltip')[0].props.style;
    assert.equal(glyphTip.top === undefined ? 'above' : 'below', side, 'the lane glyph tip, board measured: ' + board);
    await act(async () => toggle().props.onHoverOut());
    await act(async () => link().props.onHoverIn());
    const nameTip = hosts(root, 'lane-name-tooltip')[0].props.style;
    assert.equal(nameTip.top === undefined ? 'above' : 'below', side, 'the lane name tip, board measured: ' + board);
    await act(async () => link().props.onHoverOut());
  }
});

test('REQ-81 wide: group by project and the sort glyph sit right before the view switch, off the filter row; the list view has neither', async t => {
  const h = harness({ width: 1400 }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const row = rowControls(nativeNode(root, 'swimlane-title-row'));
  const at = row.indexOf('view-switch');
  assert.deepEqual(row.slice(at - 3, at + 1), ['Group by project', 'Sort cards: Default (priority, then oldest)', 'Collapse all workspaces', 'view-switch']);
  assert.equal(jsonNodes(nativeNode(root, 'swimlane-filters'), 'group-toggle').length, 0, 'not beside the search any more');
  assert.equal(flatStyle(nativeNode(root, 'swimlane-title-row').props.style).zIndex, 1, 'drawn over the filter row its tips hang into');
  await act(async () => sheetButton(root, 'view-list').props.onPress());
  assert.deepEqual([hosts(root, 'group-toggle').length, hosts(root, 'sort-menu').length], [0, 0], 'the list has no columns to lay out');
  const list = rowControls(nativeNode(root, 'list-title-row'));
  assert.equal(list.length - list.indexOf('view-switch'), row.length - at, 'the view switch keeps its distance from the right edge');
});

// ---- REQ-76/REQ-93: sub-agent cards and the card of their top-level agent ----
const SUB_ONE = '44444444-4444-4444-8444-444444444441', SUB_TWO = '44444444-4444-4444-8444-444444444442',
  SUB_DONE = '44444444-4444-4444-8444-444444444443';
/** SUB_TWO is SUB_ONE's own sub-agent: it sits flat under the same card (REQ-76 ②). */
const SUB_PARENTS = { [SUB_ONE]: { parentAgentId: AGENT_A }, [SUB_TWO]: { parentAgentId: SUB_ONE }, [SUB_DONE]: { parentAgentId: AGENT_A } };
function subCardHarness(options = {}) {
  const h = harness({ width: 1400, groups: value => cardParents(value, { agents: {}, parents: SUB_PARENTS }), ...options });
  h.external({ awaiting: null });
  for (const [index, [title, stageId, agentId]] of [['Lead card', 'review', AGENT_A], ['Worker one', 'doing', SUB_ONE],
    ['Worker two', 'todo', SUB_TWO], ['Worker done', 'done', SUB_DONE]].entries()) {
    // A minute apart, so the default order (priority, then the oldest) is the order they were made in.
    const at = '2026-01-01T02:0' + index + ':00.000Z';
    h.addCard({ ...add(title), stageId }, at);
    h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId, role: 'worker' }, at);
  }
  return h;
}
async function subCardBoard(t, options = {}) {
  const h = subCardHarness(options);
  const id = title => h.base.cards.find(c => c.title === title).id;
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  return { h, root, id };
}
/** The titles of the cards drawn inside a node, in order. */
const cardTitles = node => node ? node.findAll(n => typeof n.type === 'string' && /^kanban-card-/.test(n.props?.testID ?? ''))
  .map(n => n.props.accessibilityLabel) : [];
const cell = (root, stageId) => hosts(root, 'swimlane-cell-' + stageId)[0];
// ---- REQ-93 (research/141 C, replacing REQ-76's gathering and REQ-89's lines): sub-cards in their own columns ----
/** The card slots (mark, card, summary) drawn inside a node, by card title. */
const familyLit = root => hosts(root, 'family-highlight').map(n => cardTitles(n.parent)[0]);
const slotOf = (root, h, title) => hosts(root, 'linked-card-' + h.base.cards.find(c => c.title === title).id)[0];
const press = node => node.props.onPress({ stopPropagation() {} });
test('REQ-93 ① wide: every sub-card in its own column with "↳ parent" over its title; the parent says its sub-cards; the columns count every card', async t => {
  const { h, root, id } = await subCardBoard(t);
  assert.deepEqual(cardTitles(cell(root, 'review')), ['Lead card'], 'nothing is folded under the parent');
  assert.deepEqual(cardTitles(cell(root, 'doing')), ['Worker one'], 'the running sub-card is in progress');
  assert.deepEqual(cardTitles(cell(root, 'todo')), ['Example card', 'Worker two']);
  assert.deepEqual(cardTitles(cell(root, 'done')), ['Worker done']);
  // REQ-52: the done head ends in "Tidy" while Done holds a card (no finished card archived here, so no "Archived N").
  assert.match(textOf(hosts(root, 'lane-stage-headers')[0]), /^To Do2In progress1Review1Done1Tidy$/, 'every card counted, no "(+sub n)"');
  const summary = hosts(root, 'family-summary');
  assert.equal(summary.length, 1, 'one summary line, under the parent only');
  assert.equal(textOf(summary[0]), 'Sub-cards 3·not done 2');
  // REQ-109: two presses on it, each with its own label.
  assert.equal(hosts(root, 'family-summary-all')[0].props.accessibilityLabel, 'Sub-cards 3 — press to highlight the sub-cards: Lead card');
  assert.equal(hosts(root, 'family-summary-open')[0].props.accessibilityLabel, 'Not done 2 — press to highlight only the sub-cards not done: Lead card');
  // REQ-99: inside the parent card (under "→ next action" when there is one), not under the card; REQ-104: the status row last.
  const lead = inCard(root, 'Lead card', 'card-content')[0];
  assert.deepEqual(lead.children.slice(-2).map(n => n.props.testID), ['family-summary', 'lead-status'], 'the parent card\'s last rows');
  // REQ-116: its short title fits one line, so no second title line is kept: 84 + 44 − 18.
  assert.equal(flatStyle(labelled(root, 'Lead card').props.style).height, 84 + 44 - 18, 'two rows taller for them, one title line less');
  for (const title of ['Worker one', 'Worker two', 'Worker done']) {
    const mark = inCard(root, title, 'family-mark')[0];
    assert.equal(textOf(mark), 'Lead card', title + ': the parent over its title');
    assert.equal(mark.props.accessibilityLabel, 'Sub-card of Lead card: highlight its family');
  }
  assert.equal(inCard(root, 'Example card', 'family-mark').length, 0);
  assert.equal(inCard(root, 'Lead card', 'family-mark').length, 0);
  for (const gone of ['card-group-toggle', 'card-group-children', 'card-stage-badge', 'stage-sub-count']) assert.equal(hosts(root, gone).length, 0, gone);
  assert.equal(root.root.findAll(n => /^sub-ref-/.test(n.props?.testID ?? '')).length, 0, 'no reference lines');
  // A sub-card's box is one row taller, and its mark sits above the title inside the card.
  const content = inCard(root, 'Worker one', 'card-content')[0];
  assert.equal(content.children[0].props.testID, 'family-mark');
  assert.equal(flatStyle(labelled(root, 'Worker one').props.style).height, 84 + 22);
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.board.mutate').length, 0);
  assert.ok(id('Lead card'));
});
test('REQ-93 C′ wide: the mark or the summary highlights the family and dims the board\'s other cards; again, or a click on an empty spot, ends it', async t => {
  // The web page's own click listener (the harness has no document): what it is handed is what a click lands on.
  const listeners = new Set(), doc = { addEventListener: (type, run) => { if (type === 'click') listeners.add(run); },
    removeEventListener: (type, run) => listeners.delete(run) };
  globalThis.document = doc; t.after(() => { delete globalThis.document; });
  const pointer = async target => act(async () => { for (const run of [...listeners]) run({ target }); });
  const before = () => listeners.size;
  const { h, root } = await subCardBoard(t);
  const family = ['Worker two', 'Worker one', 'Lead card', 'Worker done'], idle = before();
  assert.deepEqual(familyLit(root), []);
  await act(async () => press(inCard(root, 'Worker one', 'family-mark')[0]));
  assert.deepEqual(familyLit(root), family, 'the parent and every sub-card, in every column');
  assert.equal(flatStyle(slotOf(root, h, 'Example card').props.style).opacity, .45, 'the other cards step back');
  assert.equal(flatStyle(slotOf(root, h, 'Worker one').props.style).opacity, undefined);
  assert.equal(inCard(root, 'Worker two', 'family-mark')[0].props.accessibilityState.selected, true);
  assert.equal(hosts(root, 'family-summary-all')[0].props.accessibilityState.selected, true);
  const ring = flatStyle(hosts(root, 'family-highlight')[0].props.style), c = palette(h.props.theme);
  assert.equal(ring.borderColor, selectedLine(c, c.panel), 'the ring is the main colour');
  assert.ok(contrast(ring.borderColor, c.panel) >= 3);
  assert.equal(ring.borderWidth, 2); assert.deepEqual([ring.position, ring.top, ring.left], ['absolute', -4, -4], '2px out from the card');
  assert.equal(hosts(root, 'family-highlight')[0].props.pointerEvents, 'none', 'drawn over the card, never taking its presses');
  // The same mark again ends it; a click on it is left to it by the page listener.
  await pointer({ closest: selector => /family-mark/.test(selector) ? {} : null });
  assert.deepEqual(familyLit(root), family, 'a click on a toggle is the toggle\'s to decide');
  // A click on a card or on any control ("+N", ⇕, a tab, the top bar's glyphs) keeps it; the page listener asks for each.
  const keeps = selector => ['[data-testid^="linked-card-"]', '[role="button"]', '[role="tab"]', 'button'].every(k => selector.includes(k));
  await pointer({ closest: selector => keeps(selector) ? {} : null });
  assert.deepEqual(familyLit(root), family, 'a card or a control keeps it');
  await act(async () => press(inCard(root, 'Worker one', 'family-mark')[0]));
  assert.deepEqual(familyLit(root), []);
  assert.equal(flatStyle(slotOf(root, h, 'Example card').props.style).opacity, undefined);
  // The summary does the same; a press anywhere else ends it.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(familyLit(root), family);
  await pointer({ closest: () => null });
  assert.deepEqual(familyLit(root), [], 'a click on an empty spot ends it');
  assert.equal(listeners.size, idle, 'and the page is no longer listened to for it');
  // A card pressed while it is on opens the card and keeps it.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  await act(async () => labelled(root, 'Worker one').props.onPress());
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 1);
  assert.deepEqual(familyLit(root), family);
  assert.equal(writes(h).length, 0, 'highlighting writes nothing');
});
test('REQ-93 ② wide: a sub-card opens its detail and moves on its own into its new column; moving the parent leaves them', async t => {
  const { h, root, id } = await subCardBoard(t);
  await act(async () => labelled(root, 'Worker one').props.onPress());
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.card.get').at(-1).input.cardId, id('Worker one'));
  await act(async () => root.root.findAllByType('NativeModal').at(-1).props.onRequestClose());
  await act(async () => cardArea(root, 'Worker one').props.onPointerEnter());
  await act(async () => press(inCard(root, 'Worker one', 'card-move-menu')[0]));
  await act(async () => sheetButton(root, 'move-to-review').props.onPress());
  assert.deepEqual(writes(h).at(-1).input.operations, [{ op: 'move', id: id('Worker one'), to: 'review' }]);
  assert.deepEqual(cardTitles(cell(root, 'review')), ['Lead card', 'Worker one'], 'drawn in review, as any card');
  assert.equal(textOf(inCard(root, 'Worker one', 'family-mark')[0]), 'Lead card', 'still naming its parent');
  await act(async () => cardArea(root, 'Lead card').props.onPointerEnter());
  await act(async () => press(inCard(root, 'Lead card', 'card-move-menu')[0]));
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  assert.deepEqual(['Worker one', 'Worker two', 'Worker done'].map(title => h.base.cards.find(c => c.title === title).stageId),
    ['review', 'todo', 'done'], 'no sub-card followed it');
  assert.deepEqual(cardTitles(cell(root, 'doing')), ['Lead card']);
  // A press on the mark is the mark's: it opens no detail.
  const reads = h.calls.filter(c => c.name === 'kanban.v1.card.get').length;
  await act(async () => press(inCard(root, 'Worker two', 'family-mark')[0]));
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.card.get').length, reads);
});
test('REQ-93 ③ a search finds a sub-card in its own column, with its mark; the parent alone matching shows the parent', async t => {
  const { root } = await subCardBoard(t);
  await act(async () => input(root, 'Search cards').props.onChangeText('worker two'));
  assert.deepEqual(cardTitles(cell(root, 'todo')), ['Worker two']);
  assert.deepEqual(cardTitles(cell(root, 'review')), []);
  assert.equal(inCard(root, 'Worker two', 'family-mark').length, 1);
  await act(async () => input(root, 'Search cards').props.onChangeText('lead'));
  assert.deepEqual(cardTitles(cell(root, 'review')), ['Lead card']);
  assert.equal(textOf(hosts(root, 'family-summary')[0]), 'Sub-cards 3·not done 2', 'the summary counts every sub-card, found or not');
});
test('REQ-93 ④ 390px: each tab counts every card of its stage; the mark is a touch target; a tap highlights, a scroll or a tab keeps it, a tap on an empty spot ends it', async t => {
  const { h, root, id } = await subCardBoard(t, { mobile: true, platform: 'ios', width: 390 });
  assert.ok(labelled(root, 'In progress 1'), 'the running sub-card counts in its tab');
  assert.ok(labelled(root, 'Review 1')); assert.ok(labelled(root, 'To Do 2')); assert.ok(labelled(root, 'Done 1'));
  assert.equal(hosts(root, 'mobile-tab-sub').length, 0, 'no "+n" beside a tab');
  await act(async () => labelled(root, 'In progress 1').props.onPress());
  const mark = () => inCard(root, 'Worker one', 'family-mark')[0];
  // A 32×32 press area around the 16px mark — padding, not hitSlop (which a phone's web page ignores); the card's rows stay.
  const area = flatStyle(mark().props.style), face = flatStyle(inCard(root, 'Worker one', 'family-mark-face')[0].props.style);
  assert.deepEqual([area.minHeight, area.minWidth, area.marginVertical, face.height, mark().props.hitSlop], [32, 32, -8, 16, undefined]);
  const screen = () => hosts(root, 'mobile-swimlane-screen')[0];
  // The screen takes a touch only when nothing inside did (a card, a control and the toggles are pressables that do).
  const tap = async node => { await act(async () => press(node)); };
  const empty = async ending => act(async () => {
    if (screen().props.onStartShouldSetResponder?.()) screen().props[ending === 'scroll' ? 'onResponderTerminate' : 'onResponderRelease']();
  });
  assert.equal(screen().props.onStartShouldSetResponder(), false, 'nothing highlighted: the screen takes no touch');
  await tap(mark());
  assert.deepEqual(familyLit(root), ['Worker one'], 'this tab shows one of the family');
  await empty('scroll');
  assert.deepEqual(familyLit(root), ['Worker one'], 'a scroll (the list takes the touch over) keeps it');
  await act(async () => labelled(root, 'Review 1').props.onPress());
  assert.deepEqual(familyLit(root), ['Lead card'], 'another stage tab keeps it, and shows its part of the family');
  await tap(hosts(root, 'family-summary-all')[0]);
  assert.deepEqual(familyLit(root), [], 'tapping the summary again ends it');
  await tap(hosts(root, 'family-summary-all')[0]);
  assert.deepEqual(familyLit(root), ['Lead card']);
  // A tap on an empty spot ends it.
  await empty('tap');
  assert.deepEqual(familyLit(root), []);
  await act(async () => labelled(root, 'Lead card').props.onLongPress());
  assert.ok(sheetButton(root, 'move-to-doing'), 'a long press still offers the stages');
  assert.equal(writes(h).length, 0);
  assert.ok(id('Worker one'));
});
test('REQ-99 the family line is the parent card\'s last row: 11px and muted like "→ next action"; a press highlights the family and opens no detail', async t => {
  const { h, root } = await subCardBoard(t);
  const summary = () => hosts(root, 'family-summary-all')[0];
  const content = inCard(root, 'Lead card', 'card-content')[0];
  assert.equal(content.children.at(-2).props.testID, 'family-summary', 'over the status row (REQ-104)');
  assert.equal(content.findAll(n => n.props?.testID === 'family-summary').length, 1, 'inside the card');
  const c = palette(h.props.theme), face = flatStyle(inCard(root, 'Lead card', 'family-summary-face')[0].props.style);
  const text = flatStyle(summary().findAllByType('Text')[0].props.style);
  assert.deepEqual([text.fontSize, text.lineHeight, face.height], [11, 16, 16], 'the next-action line\'s size');
  assert.equal(text.color, readable(c.foregroundMuted, c.card), 'and its muted colour');
  assert.equal(flatStyle(hosts(root, 'family-summary')[0].props.style).marginLeft, -4, 'its words line up with the rows above; the tint takes the 4px left of them');
  assert.equal(summary().props.accessibilityLabel, 'Sub-cards 3 — press to highlight the sub-cards: Lead card', 'REQ-109: the "Sub-cards" part\'s label');
  // A press on it, bubbling to the card as a browser's does, highlights the family and opens nothing.
  const reads = () => h.calls.filter(v => v.name === 'kanban.v1.card.get').length, before = reads();
  await act(async () => { press(summary()); labelled(root, 'Lead card').props.onPress(); });
  assert.deepEqual(familyLit(root), ['Worker two', 'Worker one', 'Lead card', 'Worker done']);
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 0, 'no detail');
  assert.equal(reads(), before);
  assert.equal(summary().props.accessibilityState.selected, true);
  assert.equal(flatStyle(inCard(root, 'Lead card', 'family-summary-face')[0].props.style).backgroundColor, selectedTint(c, c.card), 'tinted while on');
  // REQ-99 ③: the ring goes round the card alone — the slot holds the card and the ring, nothing under the card.
  const slot = hosts(root, 'family-highlight')[0].parent;
  assert.deepEqual([slot.children.length, slot.children[1].props.testID], [2, 'family-highlight']);
  assert.equal(slot.children[0].findAll(n => n.props?.testID === 'card-shadow').length, 1, 'the card, its line inside it');
  await act(async () => { press(summary()); labelled(root, 'Lead card').props.onPress(); });
  assert.deepEqual(familyLit(root), [], 'again ends it, still no detail');
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 0);
  // The card itself still opens its detail.
  await act(async () => labelled(root, 'Lead card').props.onPress());
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 1);
  assert.equal(writes(h).length, 0);
  // A phone: the gap over it and half the gap under it (REQ-104: the status row under it takes the other half), the rows where they were.
  const phone = await subCardBoard(t, { mobile: true, platform: 'ios', width: 390 });
  await act(async () => labelled(phone.root, 'Review 1').props.onPress());
  for (const part of ['family-summary-all', 'family-summary-open']) {
    const area = flatStyle(hosts(phone.root, part)[0].props.style);
    assert.deepEqual([area.paddingTop, area.paddingBottom, area.marginTop, area.marginBottom, area.minWidth, hosts(phone.root, part)[0].props.hitSlop],
      [6, 3, -6, -3, 32, undefined], part + ': each part has the reach');
  }
  assert.equal(inCard(phone.root, 'Lead card', 'card-content')[0].children.at(-2).props.testID, 'family-summary');
});
// ---- REQ-104: a lead's status row under its family line — what it waits for; each part highlights its cards ----
/**
 * The sub-card board with Worker one's agent at work, Worker two awaiting you, and the lead's own check card in progress,
 * started ten minutes ago (`CHECK`: how the row writes that, KST).
 *
 * research/166 T1: the screens' clock is pinned (`pinClock`, 21:50 KST unless `clock` says), so what the row writes and
 * what is expected are read from the same instant — a run crossing midnight KST no longer splits them.
 */
const PINNED = '2026-09-27T12:50:00.000Z';
// A test that pins twice (two boards in one test) moves its one mock instead of stacking a second on the first: node
// restores stacked mocks oldest first, so the first one stayed on Date.now for every later test, its call records keeping
// each later harness alive (and their clock shifted).
const realNow = Date.now.bind(Date), pinned = new WeakMap();
function pinClock(t, at) {
  const shift = Date.parse(at) - realNow(), now = () => realNow() + shift;
  if (pinned.get(t)?.fn === Date.now) pinned.get(t).fn.mock.mockImplementation(now);
  else pinned.set(t, { fn: t.mock.method(Date, 'now', now) });
}
let CHECK = '';
/** REQ-136 F1: a check's "시작 HH:MM" is written in Korea's time whatever the device's zone. */
const kstClock = ms => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);
async function leadStatusBoard(t, { clock = PINNED, prepare, ...options } = {}) {
  pinClock(t, clock);
  CHECK = deviceClock(Date.now() - 10 * 60000, Date.now());
  const h = subCardHarness(options);
  const id = title => h.base.cards.find(c => c.title === title).id, now = new Date(Date.now()).toISOString();
  h.addCard({ op: 'update', id: id('Worker two'), patch: { awaiting: 'user' } });
  h.addCard({ ...add('총괄 확인 — tests'), stageId: 'doing', nextAction: '총괄 테스트 중 · 시작 ' + kstClock(Date.now() - 10 * 60000) + ' · 예상 +30분' }, now);
  h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId: AGENT_A, role: 'lead' }, now);
  prepare?.(h, id, now);
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => h.agents.upsert(SUB_ONE, { status: 'running' }));
  return { h, root, id };
}
/** REQ-130: the lead's own state, first on its row — its agent resting since the lead card's last change (no activity known). */
const RESTING = 'Idle · since 01-01 11:00·';
/** REQ-135: the row is the lead's own state alone; its sub-cards' parts are on the family line. */
const RESTED = 'Idle · since 01-01 11:00';
/**
 * REQ-135: the sub-cards' parts the family line says, in its order, by their whole words (what a screen reader hears) —
 * whatever fit a narrow card says them at. '' with none.
 */
const famParts = root => (hosts(root, 'family-summary')[0]?.findAll(n => typeof n.type === 'string' && /^lead-status-(running|testing|awaiting)$/.test(n.props?.testID ?? '')) ?? [])
  .map(n => n.props.accessibilityLabel.replace(/(: highlight those cards of | — 해당 카드 강조: ).*$/, '')).join('·');
/** REQ-135: a lead card's inner box laid out `width` wide (the renderer lays nothing out: a 264px card's until then). */
const layCard = (root, title, width) => act(async () => inCard(root, title, 'card-content')[0].props.onLayout({ nativeEvent: { layout: { width } } }));
test('REQ-104 the lead\'s status row: its last row, 11px and muted, on the lead alone; running, testing and awaiting you, each left out at zero', async t => {
  const { h, root } = await leadStatusBoard(t);
  assert.equal(hosts(root, 'lead-status').length, 1, 'the lead card alone');
  const content = inCard(root, 'Lead card', 'card-content')[0];
  assert.deepEqual(content.children.slice(-2).map(n => n.props.testID), ['family-summary', 'lead-status'], 'under the family line, last');
  // REQ-135: the row is the lead's own state; the sub-cards' parts follow "Sub-cards N" on the family line.
  assert.equal(textOf(hosts(root, 'lead-status')[0]), RESTED);
  assert.equal(famParts(root), 'Running 1·Needs you 1·Testing ' + CHECK + '~');
  // A 264px card (English): shorter words, the check as its clock alone — every count whole.
  assert.equal(textOf(hosts(root, 'family-summary')[0]), 'Sub-cards 3·Run 1·open 2·Needs 1·', 'REQ-135 the narrow rule');
  assert.equal(hosts(root, 'family-summary')[0].findAll(n => n.props?.testID === 'lead-status-face-testing')[0].findByType('Icon').props.name, 'Clock');
  await layCard(root, 'Lead card', 480);
  assert.equal(textOf(hosts(root, 'family-summary')[0]), 'Sub-cards 3·Running 1·not done 2·Needs you 1·Testing ' + CHECK + '~', 'room for every word');
  assert.equal(hosts(root, 'lead-status')[0].findAllByType('Icon').length, 0, 'REQ-130: the lead\'s own state in the clock\'s place');
  assert.equal(hosts(root, 'lead-status-me-rest').length, 1);
  const c = palette(h.props.theme), text = flatStyle(hosts(root, 'lead-status-running')[0].findAllByType('Text')[0].props.style);
  assert.deepEqual([text.fontSize, text.lineHeight, text.color], [11, 16, readable(c.foregroundMuted, c.card)], 'the family line\'s size and colour');
  assert.equal(hosts(root, 'lead-status-testing')[0].props.accessibilityLabel, 'Testing ' + CHECK + '~: highlight those cards of Lead card');
  assert.equal(flatStyle(labelled(root, 'Lead card').props.style).height, 84 + 44 - 18, 'two rows taller: the family line and this (REQ-116: one title line)');
  // The sub-card stops: its part goes; the others stay.
  await act(async () => h.agents.upsert(SUB_ONE, { status: 'idle' }));
  assert.equal(textOf(hosts(root, 'lead-status')[0]), RESTED);
  assert.equal(textOf(hosts(root, 'family-summary')[0]), 'Sub-cards 3·not done 2·Needs you 1·Testing ' + CHECK + '~');
  assert.equal(hosts(root, 'lead-status-running').length, 0);
  assert.equal(writes(h).length, 0);
});
test('REQ-104 a part highlights the lead and just its cards with the family ring; again, or an empty spot, ends it; no detail opens', async t => {
  const listeners = new Set(), doc = { addEventListener: (type, run) => { if (type === 'click') listeners.add(run); },
    removeEventListener: (type, run) => listeners.delete(run) };
  globalThis.document = doc; t.after(() => { delete globalThis.document; });
  const pointer = async target => act(async () => { for (const run of [...listeners]) run({ target }); });
  const { h, root } = await leadStatusBoard(t);
  const part = kind => hosts(root, 'lead-status-' + kind)[0];
  const reads = () => h.calls.filter(v => v.name === 'kanban.v1.card.get').length, before = reads();
  // A press bubbling to the card, as a browser's does, is the part's alone.
  const tap = async kind => act(async () => { press(part(kind)); labelled(root, 'Lead card').props.onPress(); });
  await tap('running');
  assert.deepEqual(familyLit(root), ['Worker one', 'Lead card'], 'the running sub-card and the lead');
  assert.equal(flatStyle(slotOf(root, h, 'Worker two').props.style).opacity, .45, 'the rest step back, the family\'s other cards too');
  assert.equal(part('running').props.accessibilityState.selected, true);
  assert.equal(hosts(root, 'family-summary-all')[0].props.accessibilityState.selected, false, 'the family line is not what is on');
  assert.equal(inCard(root, 'Worker one', 'family-mark')[0].props.accessibilityState.selected, false);
  const c = palette(h.props.theme);
  assert.equal(flatStyle(hosts(root, 'lead-status-face-running')[0].props.style).backgroundColor, selectedTint(c, c.card), 'tinted while on');
  assert.equal(flatStyle(hosts(root, 'family-highlight')[0].props.style).borderColor, selectedLine(c, c.panel), 'the family ring');
  await tap('testing');
  assert.deepEqual(familyLit(root), ['총괄 확인 — tests', 'Lead card'], 'another part moves it: the check card, no sub-card');
  await tap('awaiting');
  assert.deepEqual(familyLit(root), ['Worker two', 'Lead card']);
  await tap('awaiting');
  assert.deepEqual(familyLit(root), [], 'the same part again ends it');
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 0, 'no detail');
  assert.equal(reads(), before);
  // The family line still highlights the whole family; a part after it moves to its cards.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(familyLit(root), ['Worker two', 'Worker one', 'Lead card', 'Worker done']);
  await tap('awaiting');
  assert.deepEqual(familyLit(root), ['Worker two', 'Lead card']);
  // A click on a part is left to it by the page; a click on an empty spot ends it.
  await pointer({ closest: selector => selector.includes('[data-testid^="lead-status-"]') ? {} : null });
  assert.deepEqual(familyLit(root), ['Worker two', 'Lead card']);
  await pointer({ closest: () => null });
  assert.deepEqual(familyLit(root), []);
  // The card itself still opens its detail.
  await act(async () => labelled(root, 'Lead card').props.onPress());
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 1);
  assert.equal(writes(h).length, 0, 'highlighting writes nothing');
});
test('REQ-104 idle: none of the three — "Idle · last activity HH:MM" (KST) of the lead\'s agent, and nothing to press', async t => {
  pinClock(t, PINNED);
  const { h, root } = await subCardBoard(t);
  // No activity known yet: the lead card's last change, a day before today.
  assert.equal(textOf(hosts(root, 'lead-status')[0]), 'Idle · since 01-01 11:00', 'REQ-130: the lead\'s own state, resting');
  const at = new Date(Date.now() - 5 * 60000).toISOString();
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', lastActivityAt: at }));
  assert.equal(textOf(hosts(root, 'lead-status')[0]), 'Idle · since ' + deviceClock(at, Date.now()));
  assert.equal(hosts(root, 'lead-status')[0].findAll(n => n.props?.accessibilityRole === 'button').length, 0, 'nothing to press');
  assert.equal(hosts(root, 'lead-status-me-rest').length, 1);
});
test('REQ-104 phone and the workspace board: the same row; a part is a finger-sized press that highlights its cards', async t => {
  const phone = await leadStatusBoard(t, { mobile: true, platform: 'ios', width: 390 });
  await act(async () => labelled(phone.root, 'Review 1').props.onPress());
  await layCard(phone.root, 'Lead card', 345);
  assert.equal(textOf(hosts(phone.root, 'lead-status')[0]), RESTED);
  assert.equal(famParts(phone.root), 'Running 1·Needs you 1·Testing ' + CHECK + '~');
  const area = flatStyle(hosts(phone.root, 'lead-status-running')[0].props.style);
  // REQ-135: on the family line, a part reaches as "Sub-cards N" does — the 6px gap over it and half the gap under it (the
  // row takes the other half): 25px tall, 32 wide.
  assert.deepEqual([area.paddingTop, area.marginTop, area.paddingBottom, area.marginBottom, area.minWidth, hosts(phone.root, 'lead-status-running')[0].props.hitSlop],
    [6, -6, 3, -3, 32, undefined]);
  // research/166 J2: the card awaiting you is in no card of this tab — the screen moves to its tab, where it is ringed.
  await act(async () => press(hosts(phone.root, 'lead-status-awaiting')[0]));
  assert.equal(labelled(phone.root, 'To Do 2').props.accessibilityState.selected, true, 'moved to the tab of the card awaiting you');
  assert.deepEqual(familyLit(phone.root), ['Worker two']);
  await act(async () => labelled(phone.root, 'Review 1').props.onPress());
  assert.deepEqual(familyLit(phone.root), ['Lead card'], 'another tab keeps it');
  // research/275 J3: the family line fills the card's middle — a long press on any of its parts is the card's (its stage menu),
  // and it rings nothing more; a tap still rings (above).
  for (const id of ['family-summary-all', 'lead-status-running', 'family-summary-open', 'lead-status-awaiting']) {
    assert.equal(hosts(phone.root, 'move-to-doing').length, 0);
    const part = inCard(phone.root, 'Lead card', id)[0];
    assert.equal(part.props.delayLongPress, 450, id + ': the card\'s own hold');
    await act(async () => part.props.onLongPress({ stopPropagation() {} }));
    assert.ok(sheetButton(phone.root, 'move-to-doing'), id + ': a long press offers the stages');
    assert.deepEqual(familyLit(phone.root), ['Lead card'], id + ': and rings nothing more');
    await act(async () => sheetButton(phone.root, 'menu-sheet-backdrop').props.onPress());
    assert.equal(hosts(phone.root, 'move-to-doing').length, 0, id + ': closed again, so the next hold opens it anew');
  }
  const wide = await leadStatusBoard(t);
  const board = await render(t, wide.h.load('client/board.tsx').BoardScreen, { ...wide.h.props, selector: { boardId: wide.h.base.id } });
  await act(async () => board.root.findAllByType('View').find(v => v.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  // Rendered on its own here, the board has no agent signals (the screens hand it theirs): no part for the running card.
  assert.equal(textOf(hosts(board, 'lead-status')[0]), RESTED);
  assert.equal(famParts(board), 'Needs you 1·Testing ' + CHECK + '~');
  await act(async () => press(hosts(board, 'lead-status-testing')[0]));
  assert.deepEqual(familyLit(board), ['총괄 확인 — tests', 'Lead card']);
  // A wide screen has its ⋯ for the menu: no part takes a long press (research/275 J3 is a phone's).
  assert.equal(hosts(board, 'lead-status-testing')[0].props.onLongPress, undefined);
});
// ---- research/166: the v0.1.32 gate's findings on REQ-104 ----
test('research/166 T1 the row and its expectation read one pinned clock: before and after midnight KST alike', async t => {
  // 23:59:30 KST: the check started 23:49 today. 00:05 KST: it started 23:55 yesterday, so the day is written.
  for (const [clock, at] of [['2026-09-27T14:59:30.000Z', '23:49'], ['2026-09-27T15:05:00.000Z', '09-27 23:55']]) {
    await t.test(clock, async s => {
      const { root } = await leadStatusBoard(s, { clock });
      assert.equal(CHECK, at);
      assert.equal(textOf(hosts(root, 'lead-status')[0]), RESTED);
      assert.equal(famParts(root), 'Running 1·Needs you 1·Testing ' + at + '~');
    });
  }
});
test('research/166 D1 a sub-card whose agent asks for a permission is awaiting you, as its own "Response needed" says', async t => {
  pinClock(t, PINNED);
  const { h, root } = await subCardBoard(t);
  assert.equal(hosts(root, 'lead-status-awaiting').length, 0);
  await act(async () => h.agents.upsert(SUB_ONE, { status: 'running', pendingPermissions: [{ requestId: 'p1' }] }));
  assert.equal(inCard(root, 'Worker one', 'card-reply').length + inCard(root, 'Worker one', 'card-reply-text').length, 1, 'the sub-card says "Response needed"');
  assert.equal(textOf(hosts(root, 'lead-status')[0]), RESTED);
  assert.equal(famParts(root), 'Needs you 1', 'a permission wait is no running part');
  await act(async () => press(hosts(root, 'lead-status-awaiting')[0]));
  assert.deepEqual(familyLit(root), ['Worker one', 'Lead card']);
  await act(async () => h.agents.upsert(SUB_ONE, { status: 'idle', pendingPermissions: [] }));
  assert.match(textOf(hosts(root, 'lead-status')[0]), /^Idle/, 'answered: nothing waits');
  assert.equal(writes(h).length, 0);
});
test('D43 the lead asking you itself (a question): never idle, its wait is the "Awaiting answer" mark alone (REQ-130, no second count) and that mark is the press; with sub-cards waiting, their count and press ring them', async t => {
  pinClock(t, PINNED);
  for (const options of [{}, { mobile: true, platform: 'ios', width: 390 }]) {
    await t.test(options.mobile ? 'phone' : 'wide', async s => {
      const h = subCardHarness(options), { opened, navigation } = opener();
      const root = await render(s, h.load('client/overview.tsx').OverviewScreen, { ...h.props, navigation });
      if (options.mobile) await act(async () => labelled(root, 'Review 1').props.onPress());
      await act(async () => h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [{ id: 'q', kind: 'question' }] }));
      // REQ-130: its own state says "Awaiting answer" (REQ-133) — first seen asking, so timed from its last activity.
      assert.match(textOf(hosts(root, 'lead-status')[0]), /^Needs your answer · [^·]+$/, 'not idle, and its own wait is not counted again');
      assert.equal(hosts(root, 'lead-status-me-rest').length + hosts(root, 'lead-status-me-working').length, 0);
      assert.equal(inCard(root, 'Lead card', 'card-reply').length, 1, 'the card\'s own "Response needed" as before');
      assert.equal(hosts(root, 'lead-status-awaiting').length, 1, 'the "Needs your answer" mark is the press');
      assert.equal(hosts(root, 'lead-status-awaiting')[0].props.accessibilityRole, 'button');
      await act(async () => press(hosts(root, 'lead-status-awaiting')[0]));
      await leaveOpen(root);
      assert.deepEqual(opened, [['agent', AGENT_A]], 'no sub-card to ring: where "Response needed" goes');
      assert.deepEqual(familyLit(root), []);
      assert.equal(hosts(root, 'editor-sheet').length + hosts(root, 'desktop-detail-dialog').length, 0, 'no detail');
      // A sub-card asking too: it alone is counted, and the press rings the waiting cards as before.
      await act(async () => h.agents.upsert(SUB_ONE, { status: 'running', pendingPermissions: [{ id: 'p' }] }));
      assert.match(textOf(hosts(root, 'lead-status')[0]), /^Needs your answer · [^·]+$/);
      assert.equal(famParts(root), 'Needs you 1', 'REQ-135: the sub-card\'s count on the family line');
      await act(async () => press(hosts(root, 'lead-status-awaiting')[0]));
      assert.deepEqual(opened.length, 1);
      if (!options.mobile) assert.deepEqual(familyLit(root), ['Worker one', 'Lead card']);
      else assert.deepEqual(familyLit(root), ['Worker one'], 'moved to the tab of the sub-card, ringed there (research/166 J2)');
      await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', pendingPermissions: [] }));
      await act(async () => h.agents.upsert(SUB_ONE, { status: 'idle', pendingPermissions: [] }));
      if (options.mobile) await act(async () => labelled(root, 'Review 1').props.onPress());
      assert.match(textOf(hosts(root, 'lead-status')[0]), /^Idle/, 'answered: idle again');
      assert.equal(writes(h).length, 0);
    });
  }
  // A host without navigation: the lead's own wait rings the lead's card alone — the press (its "Awaiting answer" mark) is never a dead one.
  const { h, root } = await subCardBoard(t);
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [{ id: 'q', kind: 'question' }] }));
  await act(async () => press(hosts(root, 'lead-status-awaiting')[0]));
  assert.deepEqual(familyLit(root), ['Lead card']);
});
test('research/166 J1 idle: a press on the row does nothing — no detail, no highlight, no read', async t => {
  pinClock(t, PINNED);
  const { h, root } = await subCardBoard(t);
  const reads = () => h.calls.filter(v => v.name === 'kanban.v1.card.get').length, before = reads();
  const quiet = hosts(root, 'lead-status-quiet')[0];
  assert.equal(quiet.props.accessibilityRole, undefined, 'no button for a screen reader');
  // A press bubbling to the card, as a browser's does, stops at the row.
  await act(async () => { press(quiet); labelled(root, 'Lead card').props.onPress(); });
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 0, 'no detail');
  assert.deepEqual(familyLit(root), []);
  assert.equal(reads(), before);
  // The card elsewhere still opens it.
  await act(async () => labelled(root, 'Lead card').props.onPress());
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 1);
  assert.equal(writes(h).length, 0);
});
test('research/166 J3 the lead\'s own agent at work with nothing else: "Working · last activity HH:MM", nothing to press', async t => {
  pinClock(t, PINNED);
  const { h, root } = await subCardBoard(t);
  const at = new Date(Date.now() - 2 * 60000).toISOString();
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', lastActivityAt: at }));
  assert.equal(textOf(hosts(root, 'lead-status')[0]), 'Lead working', 'REQ-130: first seen at work — no start to time it from');
  assert.equal(hosts(root, 'lead-status-me-working').length, 1);
  assert.equal(hosts(root, 'lead-status')[0].findAll(n => n.props?.accessibilityRole === 'button').length, 0, 'nothing to press');
  // A part to show wins over it; with none again and the agent stopped, idle.
  await act(async () => h.agents.upsert(SUB_ONE, { status: 'running' }));
  assert.equal(textOf(hosts(root, 'lead-status')[0]), 'Lead working', 'REQ-130: its own state stays first');
  assert.equal(famParts(root), 'Running 1', 'REQ-135: the part on the family line');
  await act(async () => { h.agents.upsert(SUB_ONE, { status: 'idle' }); h.agents.upsert(AGENT_A, { status: 'idle', lastActivityAt: at }); });
  assert.equal(textOf(hosts(root, 'lead-status')[0]), 'Idle · since 21:48');
});
test('research/166 J2 phone: a part whose cards are in this tab keeps the tab; all in others moves to the first one\'s', async t => {
  // Worker two, awaiting you, sits in Review with the lead; the check card is in progress.
  const phone = await leadStatusBoard(t, { mobile: true, platform: 'ios', width: 390,
    prepare: (h, id, now) => h.addCard({ op: 'move', id: id('Worker two'), to: 'review' }, now) });
  await act(async () => labelled(phone.root, 'Review 2').props.onPress());
  await layCard(phone.root, 'Lead card', 345);
  await act(async () => press(hosts(phone.root, 'lead-status-awaiting')[0]));
  assert.equal(labelled(phone.root, 'Review 2').props.accessibilityState.selected, true, 'kept: its card is here');
  assert.deepEqual(familyLit(phone.root), ['Lead card', 'Worker two']);
  await act(async () => press(hosts(phone.root, 'lead-status-testing')[0]));
  assert.equal(labelled(phone.root, 'In progress 2').props.accessibilityState.selected, true, 'moved to the check card\'s tab');
  assert.deepEqual(familyLit(phone.root), ['총괄 확인 — tests']);
  assert.equal(writes(phone.h).length, 0);
});
// ---- REQ-109: a highlight's "+N" folds back when it ends; "not done M" highlights the not-done sub-cards alone ----
/** Four high-priority cards in progress and six in done put Worker one, the check card and Worker done behind "+N". */
function hideFamily(h) {
  const urgent = (title, stageId) => {
    h.addCard({ ...add(title), stageId });
    h.addCard({ op: 'update', id: h.base.cards.at(-1).id, patch: { priority: 'high' } });
  };
  for (let i = 0; i < 4; i++) urgent('Queued work ' + i, 'doing');
  for (let i = 0; i < 6; i++) urgent('Settled ' + i, 'done');
}
function pageClicks(t) {
  const listeners = new Set();
  globalThis.document = { addEventListener: (type, run) => { if (type === 'click') listeners.add(run); },
    removeEventListener: (type, run) => listeners.delete(run) };
  t.after(() => { delete globalThis.document; });
  return async target => act(async () => { for (const run of [...listeners]) run({ target }); });
}
const emptySpot = { closest: () => null };
test('REQ-109 wide: a highlight opens the "+N" its family is behind; its end folds them back and keeps the columns the user opened', async t => {
  const click = pageClicks(t);
  const { h, root } = await leadStatusBoard(t, { prepare: hideFamily });
  const inCell = (stageId, testID) => cell(root, stageId).findAll(n => n.props?.testID === testID && typeof n.type === 'string')[0];
  const shown = stageId => cardTitles(cell(root, stageId));
  const view = () => ['doing', 'done'].map(s => shown(s).length);
  assert.deepEqual(view(), [3, 3], 'three in each, the family\'s behind "+N"');
  assert.ok(!shown('doing').includes('Worker one') && !shown('done').includes('Worker done'));
  // ① "Sub-cards N": the whole family, its columns opened; an empty spot folds them back.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.ok(shown('doing').includes('Worker one') && shown('done').includes('Worker done'), 'opened to show it');
  assert.deepEqual(view(), [6, 7]);
  await click(emptySpot);
  assert.deepEqual(familyLit(root), []);
  assert.deepEqual(view(), [3, 3], 'back as it was before the highlight');
  // Pressed again: the same press ends it the same way.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(view(), [3, 3], 'the same press again folds back too');
  // A column the user opened beforehand stays open; the one the highlight opened folds back.
  await act(async () => inCell('doing', 'cell-more').props.onPress());
  assert.deepEqual(view(), [6, 3]);
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(view(), [6, 7]);
  await click(emptySpot);
  assert.deepEqual(view(), [6, 3], 'the user\'s own "+N" kept');
  await act(async () => inCell('doing', 'cell-collapse').props.onPress());
  // A column the user presses while it is on is theirs: it stays as they left it.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  await act(async () => inCell('done', 'cell-collapse').props.onPress());
  assert.deepEqual(view(), [6, 3]);
  await click(emptySpot);
  assert.deepEqual(view(), [3, 3], 'the done column folded by the user, in progress folded back');
  // ③ "not done M": the lead and its sub-cards not done; the done column's "+N" stays as it is.
  const open = () => hosts(root, 'family-summary-open')[0];
  await act(async () => press(open()));
  assert.deepEqual(familyLit(root).sort(), ['Lead card', 'Worker one', 'Worker two'], 'no done sub-card');
  assert.deepEqual(view(), [6, 3], 'the done column is left folded');
  assert.equal(open().props.accessibilityState.selected, true);
  assert.equal(hosts(root, 'family-summary-all')[0].props.accessibilityState.selected, false);
  const c = palette(h.props.theme);
  assert.equal(flatStyle(hosts(root, 'family-summary-open-face')[0].props.style).backgroundColor, selectedTint(c, c.card), 'its part tinted');
  assert.equal(flatStyle(hosts(root, 'family-summary-face')[0].props.style).backgroundColor, 'transparent');
  // From "not done" to the whole family: one highlight ends, the next opens what it needs.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(view(), [6, 7]);
  await act(async () => press(open()));
  assert.deepEqual(view(), [6, 3], 'the done column the family opened folds back');
  await act(async () => press(open()));
  assert.deepEqual(view(), [3, 3]);
  // ④ a status part: its cards' columns only, the same fold back.
  await act(async () => press(hosts(root, 'lead-status-testing')[0]));
  assert.deepEqual(familyLit(root), ['총괄 확인 — tests', 'Lead card']);
  assert.deepEqual(view(), [6, 3]);
  await click(emptySpot);
  assert.deepEqual(view(), [3, 3]);
  assert.equal(writes(h).length, 0, 'highlighting writes nothing');
});
test('REQ-109 "not done 0" presses nothing; the labels say what each part highlights (Korean too)', async t => {
  const h = subCardHarness(), id = title => h.base.cards.find(c => c.title === title).id;
  for (const title of ['Worker one', 'Worker two']) h.addCard({ op: 'move', id: id(title), to: 'done' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.equal(textOf(hosts(root, 'family-summary')[0]), 'Sub-cards 3·not done 0');
  assert.equal(hosts(root, 'family-summary-open').length, 0, 'nothing to press');
  assert.equal(hosts(root, 'family-summary-open-quiet').length, 1);
  const ko = h.load('client/i18n.ts').copy('ko');
  assert.equal(ko.familyLabel(46, 'Lead'), '하위 46 — 누르면 하위 카드 강조: Lead');
  assert.equal(ko.familyOpenLabel(1, 'Lead'), '미완료 1 — 누르면 미완료 하위만 강조: Lead');
  assert.equal(ko.subCount(46) + ' · ' + ko.openCount(1), '하위 46 · 미완료 1', 'the line reads as before');
});
test('REQ-109 phone: a status part that moved the tab goes back to it when it ends, unless another tab was chosen; its "+N" folds back', async t => {
  const phone = await leadStatusBoard(t, { mobile: true, platform: 'ios', width: 390, prepare: hideFamily });
  const { root } = phone, screen = () => hosts(root, 'mobile-swimlane-screen')[0];
  const empty = async () => act(async () => { if (screen().props.onStartShouldSetResponder()) screen().props.onResponderRelease(); });
  const tab = label => labelled(root, label).props.accessibilityState.selected;
  const listed = () => hosts(root, 'mobile-cell-panel')[0].findAll(n => typeof n.type === 'string' && /^kanban-card-/.test(n.props?.testID ?? '')).length;
  await act(async () => labelled(root, 'Review 1').props.onPress());
  await layCard(root, 'Lead card', 345);
  await act(async () => press(hosts(root, 'lead-status-testing')[0]));
  assert.equal(tab('In progress 6'), true, 'moved to the check card\'s tab (J2)');
  assert.equal(listed(), 6, 'opened far enough to show it');
  await empty();
  assert.equal(tab('Review 1'), true, 'back to the tab it was on');
  await act(async () => labelled(root, 'In progress 6').props.onPress());
  assert.equal(listed(), 3, 'and the list folded back');
  // Another tab chosen while it is on stays chosen. (A tab draws its cards anew: laid out again, as a phone does.)
  await act(async () => labelled(root, 'Review 1').props.onPress());
  await layCard(root, 'Lead card', 345);
  await act(async () => press(hosts(root, 'lead-status-testing')[0]));
  await act(async () => labelled(root, 'To Do 2').props.onPress());
  await empty();
  assert.equal(tab('To Do 2'), true, 'the user\'s tab kept');
  // "not done" is a part too (J2): from Review, where none of those sub-cards is, to the first one's tab, and back.
  await act(async () => labelled(root, 'Review 1').props.onPress());
  await act(async () => press(hosts(root, 'family-summary-open')[0]));
  assert.equal(tab('To Do 2'), true);
  assert.deepEqual(familyLit(root), ['Worker two']);
  await empty();
  assert.equal(tab('Review 1'), true);
  await act(async () => labelled(root, 'Done 7').props.onPress());
  assert.equal(listed(), 3, 'the done list never opened');
  assert.equal(writes(phone.h).length, 0);
});
test('REQ-109 the auto refresh keeps what a highlight opened, and its end still folds it back', async t => {
  const click = pageClicks(t);
  const h = subCardHarness();
  hideFamily(h);
  fastRefresh(h, { intervalMs: 25, idleMs: 60_000, minGapMs: 0 });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const view = () => ['doing', 'done'].map(s => cardTitles(cell(root, s)).length);
  assert.deepEqual(view(), [3, 3]);
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(view(), [5, 7]);
  const reads = countOf(h, 'kanban.v1.overview.get');
  h.addCard({ ...add('Arrived meanwhile'), stageId: 'todo' });
  await act(async () => { await pause(150); });
  assert.ok(countOf(h, 'kanban.v1.overview.get') > reads, 'read again');
  assert.ok(cardTitles(cell(root, 'todo')).includes('Arrived meanwhile'));
  assert.deepEqual(view(), [5, 7], 'still open, still highlighted');
  assert.deepEqual(familyLit(root).length, 4);
  await click(emptySpot);
  assert.deepEqual(view(), [3, 3], 'folded back after the refresh');
});
test('REQ-93 ⑤ the workspace board: sub-cards in their own columns and tabs, marked, highlighted by a press', async t => {
  const wide = await subCardBoard(t);
  const root = await render(t, wide.h.load('client/board.tsx').BoardScreen, { ...wide.h.props, selector: { boardId: wide.h.base.id } });
  await act(async () => root.root.findAllByType('View').find(v => v.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  assert.deepEqual(cardTitles(hosts(root, 'board-cell-doing')[0]), ['Worker one']);
  assert.match(textOf(hosts(root, 'board-cell-doing')[0]), /^In progress1/);
  assert.deepEqual(cardTitles(hosts(root, 'board-cell-review')[0]), ['Lead card']);
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(familyLit(root), ['Worker two', 'Worker one', 'Lead card', 'Worker done']);
  const phone = await subCardBoard(t, { mobile: true, platform: 'ios', width: 390 });
  const small = await render(t, phone.h.load('client/board.tsx').BoardScreen, { ...phone.h.props, selector: { boardId: phone.h.base.id } });
  await act(async () => small.root.findAllByType('View').find(v => v.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
  assert.ok(labelled(small, 'In progress 1'), 'the board\'s phone tabs count every card');
  await act(async () => labelled(small, 'In progress 1').props.onPress());
  assert.equal(inCard(small, 'Worker one', 'family-mark').length, 1);
});
test('REQ-93 F1 a parent remembered after the read reaches the swimlane and the board by the auto refresh, without ⟳', async t => {
  const h = subCardHarness();
  // The file had no parents at the first read (just updated, or restarted after sub-agents were made).
  h.setGroups(undefined);
  fastRefresh(h, { intervalMs: 25, idleMs: 60_000, minGapMs: 0 });
  const wide = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const board = await render(t, h.load('client/board.tsx').BoardScreen, { ...h.props, selector: { boardId: h.base.id } });
  await act(async () => board.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
  await act(async () => { await pause(90); });
  assert.equal(hosts(wide, 'family-summary').length, 0, 'no family yet');
  const reads = countOf(h, 'kanban.v1.overview.get'), boardReads = countOf(h, 'kanban.v1.board.get'), revision = h.base.revision;
  await act(async () => { await pause(90); });
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads, 'nothing changed: nothing read again');
  h.setGroups(value => cardParents(value, { agents: {}, parents: SUB_PARENTS }));
  await act(async () => { await pause(120); });
  assert.equal(h.base.revision, revision, 'the ledger\'s revision is the same');
  assert.equal(textOf(hosts(wide, 'family-summary')[0]), 'Sub-cards 3·not done 2', 'the swimlane marks them by itself');
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads + 1, 'one re-read for the one change');
  assert.equal(hosts(board, 'family-summary').length, 1, 'and so does the open board');
  assert.ok(countOf(h, 'kanban.v1.board.get') > boardReads);
  const settled = countOf(h, 'kanban.v1.overview.get');
  await act(async () => { await pause(120); });
  assert.equal(countOf(h, 'kanban.v1.overview.get'), settled, 'and then it rests: the same groups read nothing again');
  assert.equal(writes(h).length, 0, 'looking never writes');
});
// ---- REQ-95 (replacing REQ-94): a lead card's edge in its stage's colour, a crown, first in its column, its title's head ----
test('REQ-95 ①② / REQ-105 a card with sub-cards has a 1px grey edge (not its stage\'s colour) and a filled gold crown; others keep the border; the tint and the ring stay apart', async t => {
  const { h, root } = await subCardBoard(t);
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running' }));
  const c = palette(h.props.theme), edge = title => flatStyle(inCard(root, title, 'card-content')[0].props.style);
  const stripe = title => flatStyle(inCard(root, title, 'card-stage-stripe')[0].props.style).backgroundColor;
  // The lead card is in review: the stripe keeps the stage's purple, but the edge is now plain grey (REQ-105) —
  // not the ring's blue of its agent at work (REQ-94's rule) and not the stripe's purple either.
  assert.equal(edge('Lead card').borderColor, leaderOutline(c, c.card), 'review: plain grey, not the stripe\'s purple');
  assert.equal(stripe('Lead card'), c.stagePurple);
  assert.equal(edge('Lead card').borderWidth, 1);
  assert.ok(contrast(edge('Lead card').borderColor, c.card) >= 3 && contrast(edge('Lead card').borderColor, c.panel) >= 3);
  for (const title of ['Worker one', 'Example card']) assert.equal(edge(title).borderColor, c.border, title + ' keeps the plain border');
  await act(async () => h.agents.upsert(AGENT_A, { status: 'error' }));
  assert.equal(edge('Lead card').borderColor, leaderOutline(c, c.card), 'the agent\'s state does not change it');
  // ②: a filled gold crown before the title, on the lead only (REQ-106: filled, not lined). REQ-100: a fixed gold, not the edge's colour.
  const crown = inCard(root, 'Lead card', 'card-leader');
  assert.equal(crown.length, 1);
  const image = crown[0].findAllByType('Image')[0];
  assert.equal(image.props.testID, 'card-leader-filled');
  assert.equal(flatStyle(image.props.style).tintColor, crownColor(c, c.card));
  assert.equal(hosts(root, 'card-leader').length, 1, 'no crown on a sub-card or a plain card');
  // Just looked at (REQ-85 ⑨ → REQ-95 ④): the face is grey-tinted, the edge still plain grey, read against the tint.
  await act(async () => labelled(root, 'Lead card').props.onPress());
  await act(async () => root.root.findAllByType('NativeModal').at(-1).props.onRequestClose());
  const tint = viewedTint(c, c.card);
  assert.equal(flatStyle(labelled(root, 'Lead card').props.style).backgroundColor, tint);
  assert.equal(edge('Lead card').borderColor, leaderOutline(c, tint));
  // Highlighted (C′): the 2px ring sits 2px outside the card, so the 1px edge stays.
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.equal(edge('Lead card').borderColor, leaderOutline(c, tint));
  const ring = flatStyle(hosts(root, 'family-highlight')[0].props.style);
  assert.deepEqual([ring.borderWidth, ring.top, edge('Lead card').borderWidth], [2, -4, 1]);
});
test('REQ-95 ③ an awaited answer turns the stripe orange on every card whatever its stage, and a lead\'s edge too', async t => {
  const { h, root } = await subCardBoard(t);
  const c = palette(h.props.theme), edge = title => flatStyle(inCard(root, title, 'card-content')[0].props.style).borderColor;
  const stripe = title => flatStyle(inCard(root, title, 'card-stage-stripe')[0].props.style).backgroundColor;
  const orange = markLine(replyColor(c), c, c.card);
  assert.deepEqual([stripe('Lead card'), stripe('Worker one'), stripe('Worker done')], [c.stagePurple, c.stageBlue, c.stageDone]);
  // A permission asked for: orange on the lead in review and on the sub-card at work, the edge with it; "Response needed" said.
  await act(async () => { h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [{ id: 'p' }] });
    h.agents.upsert(SUB_ONE, { status: 'running', pendingPermissions: [{ id: 'q' }] }); h.agents.upsert(SUB_DONE, { status: 'running', pendingPermissions: [{ id: 'r' }] }); });
  assert.deepEqual([stripe('Lead card'), edge('Lead card'), stripe('Worker one'), edge('Worker one')], [orange, orange, orange, c.border]);
  // REQ-100: the crown keeps its gold — the orange is the stripe's and the edge's, told apart from the crown by shape.
  assert.equal(flatStyle(inCard(root, 'Lead card', 'card-leader')[0].findAllByType('Image')[0].props.style).tintColor, crownColor(c, c.card));
  assert.equal(stripe('Worker done'), orange, 'in done too: an agent asking is waiting whatever the stage');
  for (const title of ['Lead card', 'Worker one']) assert.match(allText(labelled(root, title)), /Response needed/);
  assert.ok(contrast(orange, c.card) >= 3 && contrast(orange, c.panel) >= 3);
  await act(async () => { for (const id of [AGENT_A, SUB_ONE, SUB_DONE]) h.agents.upsert(id, { status: 'idle', pendingPermissions: [] }); });
  assert.deepEqual([stripe('Lead card'), edge('Lead card')], [c.stagePurple, leaderOutline(c, c.card)], 'answered: plain grey again, not its stage');
  assert.doesNotMatch(allText(labelled(root, 'Lead card')), /Response needed/);
});
test('REQ-100/106 a lead\'s crown is a filled gold PNG in light and dark whatever its stage; an archived lead\'s is the same filled crown in the toned-down gold', async t => {
  for (const mode of ['light', 'dark']) {
    const h = subCardHarness(), props = { ...h.props, theme: PASEO_THEMES[mode] };
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, props), { LEADER_ICON } = h.load('client/components.tsx');
    const c = palette(props.theme), gold = crownColor(c, c.card), crown = () => inCard(root, 'Lead card', 'card-leader')[0];
    assert.equal(gold, { light: '#bb8e14', dark: '#F2C230' }[mode], mode + ': the gold, 3:1 on the card');
    const active = crown().findAll(n => n.props?.testID === 'card-leader-filled')[0];
    assert.match(active.props.source.uri, /^data:image\/png;base64,iVBOR/);
    let look = flatStyle(active.props.style);
    assert.deepEqual([look.width, look.height, look.tintColor], [LEADER_ICON, LEADER_ICON, gold], mode + ': filled, gold, active');
    // REQ-122: its beads, a second PNG laid on the same spot, in a deep amber.
    const beads = () => flatStyle(crown().findAll(n => n.props?.testID === 'card-leader-beads')[0].props.style);
    assert.deepEqual([beads().width, beads().position, beads().tintColor], [LEADER_ICON, 'absolute', crownColors(c, c.card).beads], mode + ': the beads, active');
    assert.equal(crown().findAllByType('Icon').length, 0, mode + ': no line crown (REQ-106)');
    // REQ-105: the edge is plain grey, not its stage's colour.
    assert.equal(flatStyle(inCard(root, 'Lead card', 'card-content')[0].props.style).borderColor, leaderOutline(c, c.card), mode + ': grey edge, active');
    // Archived: the same filled PNG, in the archived gold; its edge goes a darker grey (REQ-105, replacing REQ-98's).
    await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', archivedAt: '2026-09-22' }));
    const filled = crown().findAll(n => n.props?.testID === 'card-leader-filled')[0];
    assert.match(filled.props.source.uri, /^data:image\/png;base64,iVBOR/);
    look = flatStyle(filled.props.style);
    assert.deepEqual([look.width, look.height, look.tintColor], [LEADER_ICON, LEADER_ICON, c.crownArchived]);
    assert.equal(beads().tintColor, c.crownArchivedBead, mode + ': the beads sink with it');
    assert.equal(c.crownArchived, { light: '#aba491', dark: '#79725e' }[mode]);
    assert.equal(flatStyle(inCard(root, 'Lead card', 'card-content')[0].props.style).borderColor, leaderOutline(c, c.card, true),
      mode + ': darker grey edge, archived');
    assert.notEqual(leaderOutline(c, c.card, true), leaderOutline(c, c.card), mode + ': apart from the active grey');
    assert.equal(hosts(root, 'card-leader').length, 1, 'still the lead only');
    // Back again: the gold, active grey edge.
    await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', archivedAt: null }));
    assert.equal(flatStyle(crown().findAll(n => n.props?.testID === 'card-leader-filled')[0].props.style).tintColor, gold);
  }
});
test('REQ-95 ⑤⑥ a lead card is first in its column in every order, and an automatic title shows its head, the whole in its hint and label', async t => {
  const h = subCardHarness();
  const lead = h.base.cards.find(c => c.title === 'Lead card');
  h.addCard({ op: 'update', id: lead.id, patch: { title: '총괄-03_example-app_Opus', priority: 'low' } }, '2026-01-01T03:00:00.000Z');
  h.addCard({ ...add('High in review'), stageId: 'review', priority: 'high' }, '2026-01-01T04:00:00.000Z');
  h.addCard({ ...add('Newer in review'), stageId: 'review' }, '2026-01-01T05:00:00.000Z');
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  for (const order of ['default', 'updated', 'created']) {
    if (order !== 'default') { await act(async () => press(hosts(root, 'sort-menu')[0]));
      await act(async () => press(hosts(root, 'sort-option-' + order)[0])); }
    assert.equal(cardTitles(cell(root, 'review'))[0], '총괄-03_example-app_Opus', order + ': the lead first');
  }
  const title = inCard(root, '총괄-03_example-app_Opus', 'card-title')[0];
  assert.equal(allText(title), '총괄-03', 'the head only');
  assert.equal(title.props.accessibilityLabel, '총괄-03_example-app_Opus');
  await act(async () => title.props.onPointerEnter());
  assert.equal(allText(hosts(root, 'card-hint-title')[0]), '총괄-03_example-app_Opus', 'the whole title under the mouse');
  // A card that is no lead keeps its whole title.
  assert.equal(allText(inCard(root, 'Worker one', 'card-title')[0]), 'Worker one');
});
test('REQ-102 wide: an archived lead no longer holds the top of "완료" — the column\'s own order takes over there, and there alone', async t => {
  // A sub-card elsewhere is what makes "Lead card" a family head (`family`, card-groups.ts) in the first place.
  const h = harness({ width: 1400, agents: [AGENT_A],
    groups: value => cardParents(value, { agents: {}, parents: { [SUB_ONE]: { parentAgentId: AGENT_A } } }) });
  h.addCard({ ...add('Old done'), stageId: 'done' }, '2026-01-01T02:00:00.000Z');
  h.addCard({ ...add('Lead card'), stageId: 'done' }, '2026-01-01T02:01:00.000Z');
  h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId: AGENT_A, role: 'worker' }, '2026-01-01T02:01:00.000Z');
  h.addCard({ ...add('Newer done'), stageId: 'done' }, '2026-01-01T02:02:00.000Z');
  h.addCard({ ...add('Sub card'), stageId: 'doing' }, '2026-01-01T02:03:00.000Z');
  h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId: SUB_ONE, role: 'worker' }, '2026-01-01T02:03:00.000Z');
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => press(hosts(root, 'sort-menu')[0]));
  await act(async () => press(hosts(root, 'sort-option-updated')[0]));
  // While its agent is around, the lead still leads "완료" — REQ-95 ⑤'s rule, whatever the stage.
  assert.deepEqual(cardTitles(cell(root, 'done')), ['Lead card', 'Newer done', 'Old done'], 'unarchived: the lead first');
  // Archived: it falls into "최근 변경순"'s own place — behind "Newer done", changed after its own link.
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', archivedAt: '2026-09-22' }));
  assert.deepEqual(cardTitles(cell(root, 'done')), ['Newer done', 'Lead card', 'Old done'],
    'archived: sorted by its own updatedAt, no longer pinned first');
});
test('D35 phone: the "완료" tab\'s archived lead never reads as a live one while its lookup is out, and is looked up first', async t => {
  // Paseo lists live agents only: the lead's AGENT_A is absent and waits for its one-shot lookup behind the others' ids.
  const others = Array.from({ length: 6 }, (_, i) => '00000000-0000-4000-8000-00000000d0' + String(i).padStart(2, '0'));
  const h = harness({ mobile: true, agents: [], holdLookups: true, lookups: { [AGENT_A]: 'archived' },
    groups: value => cardParents(value, { agents: {}, parents: { [SUB_ONE]: { parentAgentId: AGENT_A } } }) });
  for (const [i, id] of others.entries()) {
    h.addCard({ ...add('Other ' + i), stageId: 'doing' }, '2026-01-01T01:0' + i + ':00.000Z');
    h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId: id, role: 'worker' }, '2026-01-01T01:0' + i + ':00.000Z');
  }
  h.addCard({ ...add('Old done'), stageId: 'done' }, '2026-01-01T02:00:00.000Z');
  h.addCard({ ...add('Lead card'), stageId: 'done' }, '2026-01-01T02:01:00.000Z');
  h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId: AGENT_A, role: 'worker' }, '2026-01-01T02:01:00.000Z');
  h.addCard({ ...add('Newer done'), stageId: 'done' }, '2026-01-01T02:02:00.000Z');
  h.addCard({ ...add('Sub card'), stageId: 'doing' }, '2026-01-01T02:03:00.000Z');
  h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId: SUB_ONE, role: 'worker' }, '2026-01-01T02:03:00.000Z');
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => root.root.findByProps({ testID: 'mobile-tab-done' }).props.onPress());
  // Three lookups (LOOKUP_LIMIT) went out with the board's first asks; the lead's agent waits at the queue's front.
  assert.deepEqual(h.agents.waiting(), others.slice(0, 3), 'the board\'s first three, sorted');
  // Before the lookup answers: REQ-102's order, REQ-100/106's filled crown and REQ-105's darker grey edge already — no live look to jump from.
  const c = palette(h.props.theme);
  const check = when => {
    assert.deepEqual(cardTitles(root.root), ['Old done', 'Lead card', 'Newer done'], when + ': the column\'s own order, not pinned first');
    assert.equal(inCard(root, 'Lead card', 'card-leader-filled').length > 0, true, when + ': the filled crown');
    assert.equal(flatStyle(inCard(root, 'Lead card', 'card-content')[0].props.style).borderColor, leaderOutline(c, c.card, true), when + ': darker grey edge');
  };
  check('held, before its lookup');
  await act(async () => h.agents.settle()); await wait();
  assert.equal(h.agents.refs[3], AGENT_A, 'the next lookup is the lead\'s, ahead of the other agents: ' + h.agents.refs.join(','));
  check('held, lookup out');
  await act(async () => h.agents.settle()); await wait();
  check('answered');
});

// ---- REQ-96: from a card straight to its agent's conversation in Paseo ----
const opener = () => { const opened = []; return { opened, navigation: {
  openAgent: target => opened.push(['agent', target.agentId]), openWorkspace: target => opened.push(['workspace', target.workspaceId]) } }; };
test('REQ-96 wide: "Go to agent ↗" shows with ⋯ on hover and opens the first agent, else the workspace; the ⋯ menu starts with it', async t => {
  const h = subCardHarness(), { opened, navigation } = opener();
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, navigation },
    { createNodeMock: () => ({ measureInWindow: done => done(300, 200, 24, 24), focus: () => {} }) });
  assert.equal(inCard(root, 'Lead card', 'card-jump').length, 0, 'hidden until the mouse is over the card');
  await act(async () => cardArea(root, 'Lead card').props.onPointerEnter());
  const jump = inCard(root, 'Lead card', 'card-jump')[0], menu = inCard(root, 'Lead card', 'card-move-menu')[0];
  assert.equal(jump.props.accessibilityLabel, 'Go to agent: Lead card');
  assert.deepEqual([flatStyle(jump.props.style).top, flatStyle(jump.props.style).right, flatStyle(menu.props.style).right], [4, 32, 4], 'beside the ⋯, never over it');
  assert.equal(jump.findByType('Icon').props.name, 'SquareArrowOutUpRight');
  await act(async () => press(jump));
  await leaveOpen(root);
  assert.deepEqual(opened, [['agent', AGENT_A]]);
  assert.equal(hosts(root, 'editor-sheet').length, 0, 'the card\'s own press (the detail) is not taken');
  await act(async () => cardArea(root, 'Lead card').props.onPointerLeave());
  assert.equal(inCard(root, 'Lead card', 'card-jump').length, 0);
  // No agent: its workspace.
  await act(async () => cardArea(root, 'Example card').props.onPointerEnter());
  assert.equal(inCard(root, 'Example card', 'card-jump')[0].props.accessibilityLabel, 'Go to workspace: Example card');
  await act(async () => press(inCard(root, 'Example card', 'card-jump')[0]));
  assert.deepEqual(opened.at(-1), ['workspace', h.base.workspaceId]);
  // ⋯: the first row, then a line, then the stages; pressing it closes the menu and opens the agent.
  await act(async () => cardArea(root, 'Lead card').props.onPointerEnter());
  await act(async () => press(inCard(root, 'Lead card', 'card-move-menu')[0]));
  const rows = hosts(root, 'card-menu')[0].findAll(n => typeof n.type === 'string' && /^(card-menu-jump|move-to-todo)$/.test(n.props?.testID ?? ''));
  assert.deepEqual(rows.map(n => n.props.testID), ['card-menu-jump', 'move-to-todo']);
  assert.equal(allText(rows[0]), 'Go to agent');
  await act(async () => press(rows[0]));
  assert.equal(hosts(root, 'card-menu').length, 0);
  await leaveOpen(root);
  assert.deepEqual(opened.at(-1), ['agent', AGENT_A]);
  // An older host without navigation: nothing to go to, nothing drawn.
  const plain = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => cardArea(plain, 'Lead card').props.onPointerEnter());
  assert.equal(inCard(plain, 'Lead card', 'card-jump').length, 0);
  await act(async () => press(inCard(plain, 'Lead card', 'card-move-menu')[0]));
  assert.equal(hosts(plain, 'card-menu-jump').length, 0);
});
test('REQ-96 "Response needed" opens the agent that waits — the one asking, else the first; the detail says the same', async t => {
  const h = subCardHarness(), { opened, navigation } = opener();
  const lead = h.base.cards.find(c => c.title === 'Lead card');
  h.addCard({ op: 'link', id: lead.id, agentId: AGENT_B, role: 'worker' });
  h.external({ awaiting: 'user' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, navigation });
  assert.equal(inCard(root, 'Lead card', 'card-reply').length, 0, 'nobody waits yet');
  await act(async () => h.agents.upsert(AGENT_B, { status: 'running', pendingPermissions: [{ id: 'p' }] }));
  const reply = inCard(root, 'Lead card', 'card-reply')[0];
  assert.equal(reply.props.accessibilityLabel, 'Response needed — go to the agent that waits: Lead card');
  assert.equal(allText(reply), 'Response needed');
  // J5 (research/149): a chip — a 1px orange edge on a faint orange fill, words and ↗ in the chip's colour; only it presses.
  const c = palette(h.props.theme), chip = flatStyle(inCard(root, 'Lead card', 'card-reply-chip')[0].props.style), look = replyChip(c, c.card);
  assert.deepEqual([chip.borderWidth, chip.borderColor, chip.backgroundColor, chip.height], [1, look.borderColor, look.backgroundColor, 18]);
  assert.equal(reply.findByType('Icon').props.name, 'ArrowUpRight');
  assert.ok(contrast(look.color, look.backgroundColor) >= 4.5 && contrast(look.borderColor, look.backgroundColor) >= 3);
  assert.equal(reply.props.hitSlop, undefined, 'the chip, nothing around it');
  await act(async () => reply.props.onHoverIn());
  const lit = inCard(root, 'Lead card', 'card-reply-chip')[0];
  assert.equal(flatStyle(lit.findAllByType('Text')[0].props.style).textDecorationLine, 'underline', 'underlined under the mouse');
  assert.equal(flatStyle(lit.props.style).backgroundColor, replyChip(c, c.card, true).backgroundColor, 'and deeper');
  await act(async () => press(reply));
  await leaveOpen(root);
  assert.deepEqual(opened, [['agent', AGENT_B]], 'the agent asking, not the first');
  assert.equal(hosts(root, 'editor-sheet').length, 0);
  // A card waiting for a person with no agent: its workspace.
  await act(async () => press(inCard(root, 'Example card', 'card-reply')[0]));
  assert.deepEqual(opened.at(-1), ['workspace', h.base.workspaceId]);
  // The detail: under who is awaited, the same way to the agent asking. J2 (research/149): once its card is read.
  // T2: the chip's press swallows the card's own press until its task ends (`afterThisTask`, a 0 ms timer, 1 ms in Node).
  // Pressed at once, the card's press could land before it and open nothing (no dialog, seen in whole-file runs); a person's
  // next press is always later, so this waits past that timer first.
  await wait(2);
  await act(async () => labelled(root, 'Lead card').props.onPress());
  const shown = () => ['desktop-detail-dialog', 'awaiting-choice', 'detail-reply'].map(id => id + ' ' + hosts(root, id).length).join(', ');
  assert.ok(await until(() => hosts(root, 'detail-reply').length > 0), 'the detail is read (' + shown() + ')');
  const link = hosts(root, 'detail-reply')[0];
  assert.match(allText(link), /Response needed · Go answer/);
  const detailChip = flatStyle(hosts(root, 'detail-reply-chip')[0].props.style);
  assert.deepEqual([detailChip.borderWidth, detailChip.backgroundColor], [1, replyChip(c, c.surface0).backgroundColor], 'the same chip');
  await act(async () => press(link));
  await leaveOpen(root);
  assert.deepEqual(opened.at(-1), ['agent', AGENT_B]);
});
test('REQ-145 ③ (gate 366) a card that needs a response gets a reply row: the chip and its flags there, line two keeps the name\'s 72px', async t => {
  const h = subCardHarness(), { navigation } = opener();
  const lead = h.base.cards.find(c => c.title === 'Lead card');
  h.addCard({ op: 'link', id: lead.id, agentId: AGENT_B, role: 'worker' });
  h.external({ awaiting: 'user', priority: 'high' });
  const { NAME_MIN_WIDTH, EXPENDABLE_SHRINK } = h.load('client/components.tsx');
  const { cardDimensions } = h.load('client/swimlane-model.ts');
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, navigation });
  const minOf = title => flatStyle(inCard(root, title, 'card-agent')[0].props.style).minWidth;
  assert.equal(inCard(root, 'Lead card', 'card-reply-row').length, 0, 'nobody waits: no reply row');
  await act(async () => h.agents.upsert(AGENT_B, { status: 'running', pendingPermissions: [{ id: 'p' }] }));
  assert.equal(inCard(root, 'Lead card', 'card-reply-row').length, 1);
  for (const title of ['Lead card', 'Example card']) assert.equal(minOf(title), NAME_MIN_WIDTH, title + ': the name keeps its 72px (REQ-126)');
  // The chip and the priority are on the reply row, not on line two.
  const row = inCard(root, 'Example card', 'card-reply-row')[0];
  assert.equal(row.findAll(n => n.props?.testID === 'card-reply' && typeof n.type === 'string').length, 1);
  assert.equal(row.findAll(n => n.props?.testID === 'card-priority' && typeof n.type === 'string').length, 1);
  // Priority and draft give way first, the chip after them (gate 367: "Blocked" and the request's state never, on their own row).
  const chip = flatStyle(inCard(root, 'Example card', 'card-reply')[0].props.style), high = flatStyle(inCard(root, 'Example card', 'card-priority')[0].props.style);
  assert.deepEqual([chip.flexShrink, high.flexShrink, high.minWidth], [1, EXPENDABLE_SHRINK, 0]);
  assert.ok(60 * 117 / (117 + EXPENDABLE_SHRINK * 20) < 1 / 64, 'the chip\'s share while the priority still has 20px');
  assert.equal(allText(inCard(root, 'Example card', 'card-reply')[0]), 'Response needed');
  assert.equal(cardDimensions(false, 1, false, 0, false, 2, 1).height - cardDimensions(false).height, 24, 'the reply row (18) and its gap (6)');
  assert.equal(cardDimensions(false, 1, false, 0, false, 2, 2).height - cardDimensions(false).height, 48, 'and the row of "Blocked" and the request\'s state');
  assert.equal(inCard(root, 'Example card', 'card-held-row').length, 0, 'no blocked flag or request: no second row');
  // Gate 367: "Blocked" on any card — waiting for a person or not — has the row of its own and never shrinks.
  const other = subCardHarness(); other.external({ awaiting: null, blockedReason: 'Waiting for a key' });
  const plain = await render(t, other.load('client/overview.tsx').OverviewScreen, other.props);
  const held = inCard(plain, 'Example card', 'card-held-row');
  assert.equal(held.length, 1); assert.equal(inCard(plain, 'Example card', 'card-reply-row').length, 0);
  const blocked = held[0].findAll(n => n.props?.testID === 'card-blocked' && typeof n.type === 'string')[0];
  assert.equal(flatStyle(blocked.props.style).flexShrink, 0);
});
test('REQ-96 phone: the long-press sheet starts with "Go to agent"; "Response needed" takes a tap', async t => {
  const h = subCardHarness({ mobile: true, platform: 'ios', width: 390 }), { opened, navigation } = opener();
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, navigation });
  await act(async () => labelled(root, 'Review 1').props.onPress());
  assert.equal(inCard(root, 'Lead card', 'card-jump').length, 0, 'no hover button on a phone');
  await act(async () => labelled(root, 'Lead card').props.onLongPress());
  const sheet = hosts(root, 'menu-sheet')[0];
  const first = sheet.findAll(n => typeof n.type === 'string' && /^(card-menu-jump|move-to-)/.test(n.props?.testID ?? ''))[0];
  assert.equal(first.props.testID, 'card-menu-jump', 'the top of the sheet');
  assert.equal(first.props.style.minHeight, 44);
  await act(async () => press(first));
  await leaveOpen(root);
  assert.deepEqual(opened, [['agent', AGENT_A]]);
  assert.equal(hosts(root, 'menu-sheet').length, 0);
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [{ id: 'p' }] }));
  const reply = inCard(root, 'Lead card', 'card-reply')[0], box = flatStyle(reply.props.style);
  // J5: 32px — the 6px gap over the 18px chip and 8px under it, never the title (the web has no hitSlop).
  assert.deepEqual([box.paddingTop, box.marginTop, box.paddingBottom, box.marginBottom, box.minWidth], [6, -6, 8, -8, 32], 'a finger-sized press');
  await act(async () => press(reply));
  await leaveOpen(root);
  assert.deepEqual(opened.at(-1), ['agent', AGENT_A]);
});


// ---- REQ-142 (research/336): closing a parentless agent's tab archives it (and its sub-agents) — ask before opening one elsewhere ----
test('REQ-142 the overview is in no workspace: "Go to agent ↗" asks first, [Cancel] opens nothing, [Open] goes on; the words in both languages', async t => {
  const h = subCardHarness(), { opened, navigation } = opener();
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, { ...h.props, navigation },
    { createNodeMock: () => ({ measureInWindow: done => done(300, 200, 24, 24), focus: () => {} }) });
  await act(async () => cardArea(root, 'Lead card').props.onPointerEnter());
  await act(async () => press(inCard(root, 'Lead card', 'card-jump')[0]));
  assert.deepEqual(opened, [], 'nothing opened before the answer');
  assert.equal(hosts(root, 'agent-leave-sheet').length, 1);
  assert.equal(allText(hosts(root, 'agent-leave-text')[0]),
    'This agent is in another workspace. Closing the tab that opens may archive the agent (and its sub-agents).');
  assert.deepEqual([allText(hosts(root, 'agent-leave-cancel')[0]), allText(hosts(root, 'agent-leave-open')[0])], ['Cancel', 'Open']);
  await act(async () => press(hosts(root, 'agent-leave-cancel')[0]));
  assert.deepEqual(opened, [], '[Cancel] opens nothing');
  assert.equal(hosts(root, 'agent-leave-sheet').length, 0);
  // A workspace (no agent on the card) is not a tab that archives anything: no question.
  await act(async () => cardArea(root, 'Example card').props.onPointerEnter());
  await act(async () => press(inCard(root, 'Example card', 'card-jump')[0]));
  assert.deepEqual(opened, [['workspace', h.base.workspaceId]]);
  assert.equal(hosts(root, 'agent-leave-sheet').length, 0);
  await act(async () => cardArea(root, 'Lead card').props.onPointerEnter());
  await act(async () => press(inCard(root, 'Lead card', 'card-jump')[0]));
  await leaveOpen(root);
  assert.deepEqual(opened.at(-1), ['agent', AGENT_A], '[Open] opens the agent');
  const { copy } = h.load('client/i18n.ts'), ko = copy('ko');
  assert.equal(ko.agentLeaveText, '다른 워크스페이스의 에이전트입니다. 열린 탭을 닫으면 그 에이전트(와 하위)가 보관될 수 있습니다.');
  assert.deepEqual([ko.agentLeaveOpen, ko.cancel, ko.goToAgent], ['열기', '취소', '에이전트로 이동']);
});
test('REQ-142 the workspace panel opens its own workspace\'s agents at once — the card\'s ↗, the menu, the detail\'s rows — wide and phone', async t => {
  for (const options of [{ panel: true, platform: 'web' }, { panel: true, mobile: true, platform: 'web', width: 390 }]) {
    await t.test(options.mobile ? 'phone' : 'wide', async s => {
      // Gate 340 F1: what decides is the agent's own workspace, as the host lists it — here the panel's.
      const h = subCardHarness({ ...options, agents: [{ id: AGENT_A, workspaceId: 'wks_example01' }] }), { opened, navigation } = opener(), { WorkspacePanel } = h.load('client/panel.tsx');
      const root = await render(s, WorkspacePanel, { ...h.props, navigation, context: 'workspace', workspaceId: h.base.workspaceId },
        { createNodeMock: () => ({ measureInWindow: done => done(300, 200, 24, 24), focus: () => {} }) });
      if (options.mobile) {
        await act(async () => labelled(root, 'Review 1').props.onPress());
        await act(async () => labelled(root, 'Lead card').props.onLongPress());
        await act(async () => press(hosts(root, 'card-menu-jump')[0]));
      } else {
        await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
        await act(async () => cardArea(root, 'Lead card').props.onPointerEnter());
        await act(async () => press(inCard(root, 'Lead card', 'card-jump')[0]));
      }
      assert.deepEqual(opened, [['agent', AGENT_A]], 'opened at once');
      assert.equal(hosts(root, 'agent-leave-sheet').length, 0, 'no question in its own workspace');
      await wait(2);
      await act(async () => labelled(root, 'Lead card').props.onPress());
      assert.ok(await until(() => hosts(root, 'agent-open').length > 0), 'the detail is read');
      await act(async () => hosts(root, 'agent-open')[0].props.onPress());
      assert.deepEqual(opened.at(-1), ['agent', AGENT_A], 'the detail\'s row too');
      assert.equal(hosts(root, 'agent-leave-sheet').length, 0);
    });
  }
});
// Gate 340 F1: a card on this board may carry an agent of another workspace (a worktree agent's card on its project root's
// board, or one linked by `kanban card link`): opening it goes there, so it asks — as does an agent the listing does not know.
for (const [home, label] of [['wks_remote', 'an agent of another workspace on this board'], [null, 'an agent the listing does not know']]) {
  test('REQ-142 gate 340 F1 the workspace panel asks first for ' + label + ' — the card\'s ↗ or menu, the detail\'s row and reply; wide and phone', async t => {
    for (const mobile of [false, true]) {
      await t.test(mobile ? 'phone' : 'wide', async s => {
        const opened = [], navigation = { openAgent: ({ agentId }) => opened.push(agentId), openWorkspace: () => {} };
        const h = harness({ panel: true, platform: 'web', width: mobile ? 390 : 1400, mobile, link: [AGENT_A],
          agents: home ? [{ id: AGENT_A, workspaceId: home, cwd: '/remote/workspace', status: 'idle' }] : [] });
        const root = await render(s, h.load('client/panel.tsx').WorkspacePanel, { ...h.props, navigation, context: 'workspace', workspaceId: h.base.workspaceId },
          { createNodeMock: () => ({ measureInWindow: done => done(300, 200, 24, 24), focus: () => {} }) });
        if (mobile) {
          await act(async () => labelled(root, 'To Do 1').props.onPress());
          await act(async () => labelled(root, 'Example card').props.onLongPress());
          await act(async () => press(hosts(root, 'card-menu-jump')[0]));
        } else {
          await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
          await act(async () => cardArea(root, 'Example card').props.onPointerEnter());
          await act(async () => press(inCard(root, 'Example card', 'card-jump')[0]));
        }
        assert.deepEqual(opened, [], 'nothing opened before the answer');
        assert.equal(hosts(root, 'agent-leave-sheet').length, 1, 'the card asks');
        await act(async () => press(hosts(root, 'agent-leave-cancel')[0]));
        assert.deepEqual(opened, [], '[Cancel] opens nothing');
        await wait(2);
        await act(async () => labelled(root, 'Example card').props.onPress());
        assert.ok(await until(() => hosts(root, 'agent-open').length > 0), 'the detail is read');
        await act(async () => hosts(root, 'agent-open')[0].props.onPress());
        await leaveOpen(root);
        assert.deepEqual(opened, [AGENT_A], 'the detail\'s row asks, then opens');
        await act(async () => press(hosts(root, 'detail-reply')[0]));
        await leaveOpen(root);
        assert.deepEqual(opened, [AGENT_A, AGENT_A], 'the detail\'s reply asks, then opens');
      });
    }
  });
}
// ---- REQ-83: what could not be read is said per feature, on every screen, and never blamed on a version ----
const HELD = { state: 'held', held: 2, issue: 'unknown-status', detail: 'future-running', at: '2026-09-26T05:00:00.000Z' };
const FAILED = { state: 'failed', held: 0, issue: 'list-failed', detail: 'Error: timed out', at: '2026-09-26T05:00:00.000Z' };
async function screenOf(t, kind, options) {
  const h = harness({ ...(kind === 'phone' ? { mobile: true, platform: 'web' } : { width: 1400 }), ...options });
  // The workspace board inside the Kanban screen (it shares the screen's agent source), as the session left it open —
  // a failed workspace listing places no lane to open it from.
  if (kind === 'board') h.load('client/session-store.ts').sessionFor(h.props.host.id + ':surface').set('board', h.base.id);
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  if (kind === 'list') await act(async () => sheetButton(root, 'view-list').props.onPress());
  if (kind === 'board') assert.equal(hosts(root, 'workspace-board').length, 1);
  return { h, root };
}
test('REQ-83 ② the workspace board now says a failed workspace listing and a failed agent subscription, each apart', async t => {
  const { root } = await screenOf(t, 'board', { sdkFails: true, agentsFail: true, link: [AGENT_A] });
  assert.equal(hosts(root, 'directory-error').length, 1, 'REQ-78\'s line, on the board too (research/124 §5)');
  assert.match(allText(hosts(root, 'directory-error')[0]), /Workspace names could not be read: Synthetic directory failure · trying again automatically/);
  assert.equal(hosts(root, 'tracking-signals-error').length, 1);
  assert.match(allText(hosts(root, 'tracking-signals-error')[0]), /\(Agent states: Synthetic agent directory failure\) · check the connection and the Paseo version/);
  assert.equal(hosts(root, 'tracking-signals-error')[0].props.accessibilityRole, 'alert');
});
test('REQ-83 ② the server\'s tracking — held quietly, failed as an alert — on the swimlane, the list, the phone and the board; nothing while auto cards are off', async t => {
  for (const kind of ['swimlane', 'list', 'phone', 'board']) {
    const held = await screenOf(t, kind, { autoHealth: HELD });
    const line = hosts(held.root, 'tracking-server-held');
    assert.equal(line.length, 1, kind + ': held');
    assert.equal(allText(line[0]), 'Automatic tracking: 2 agent states could not be read; those cards stay where they are (future-running) · check the connection and the Paseo version');
    assert.notEqual(line[0].props.accessibilityRole, 'alert', kind + ': a hold is quiet');
    const failed = await screenOf(t, kind, { autoHealth: FAILED });
    assert.match(allText(hosts(failed.root, 'tracking-server-failed')[0]),
      /^Paseo information could not be read\. Automatic tracking may have stopped\. \(Automatic tracking: Error: timed out\)/, kind + ': failed');
    const off = await screenOf(t, kind, { autoHealth: FAILED, autoCards: false });
    assert.equal(hosts(off.root, 'tracking-server-failed').length, 0, kind + ': auto cards off, nothing is being moved');
    const fine = await screenOf(t, kind, { autoHealth: { state: 'ok', held: 0, issue: null, detail: null, at: null } });
    assert.equal(['tracking-server-held', 'tracking-server-failed', 'tracking-signals-error', 'tracking-refresh-error']
      .reduce((n, id) => n + hosts(fine.root, id).length, 0), 0, kind + ': all well says nothing');
  }
  const ko = harness({ width: 1400 }).load('client/i18n.ts').copy('ko');
  assert.equal(ko.hostReadFailed, 'Paseo 정보를 읽지 못했습니다. 자동 추적이 멈췄을 수 있습니다.');
  assert.equal(ko.checkHost, '연결 상태와 Paseo 버전을 확인해 주세요', 'the connection is named with the version, never the version alone');
});
test('H1·H3 a hold of hook inputs is named so, and failed agent states with a failed tracking listing make one line naming both', async t => {
  const at = '2026-09-26T05:00:00.000Z';
  for (const kind of ['swimlane', 'phone']) {
    const line = async health => allText(hosts((await screenOf(t, kind, { autoHealth: health })).root, 'tracking-server-held')[0]);
    assert.equal(await line({ state: 'held', held: 1, issue: 'bad-hook', detail: 'cwd', at, inputs: 1 }),
      'Automatic tracking: 1 hook input could not be read; those cards stay where they are (cwd) · check the connection and the Paseo version',
      kind + ': H1 a hook input is not an agent state');
    assert.match(await line({ state: 'held', held: 3, issue: 'unknown-status', detail: 'future-running', at, inputs: 1 }),
      /^Automatic tracking: 2 agent states and 1 hook input could not be read;/, kind + ': both, counted apart');
    assert.match(await line({ state: 'held', held: 1, issue: 'bad-hook', detail: 'cwd', at }), /^Automatic tracking: 1 hook input could not/,
      kind + ': an older server without the count: its latest problem says which');
    const both = (await screenOf(t, kind, { agentsFail: true, link: [AGENT_A], autoHealth: FAILED })).root;
    assert.equal(hosts(both, 'tracking-host-failed').length, 1, kind + ': H3 one line');
    assert.equal(hosts(both, 'tracking-signals-error').length + hosts(both, 'tracking-server-failed').length, 0, kind + ': not two opening alike');
    assert.equal(allText(hosts(both, 'tracking-host-failed')[0]), 'Paseo information could not be read. Automatic tracking may have stopped. '
      + '(Agent states: Synthetic agent directory failure · Automatic tracking: Error: timed out) · check the connection and the Paseo version · trying again automatically');
    assert.equal(hosts(both, 'tracking-host-failed')[0].props.accessibilityRole, 'alert');
  }
  const ko = harness({ width: 1400 }).load('client/i18n.ts').copy('ko');
  assert.equal(ko.trackingHeld(0, 1), '읽을 수 없는 입력 1건은 자동으로 옮기지 않고 그대로 둡니다');
  assert.equal(ko.trackingHeld(2, 1), '읽을 수 없는 에이전트 상태 2건·입력 1건은 자동으로 옮기지 않고 그대로 둡니다');
  assert.equal(ko.trackingHeld(2), '읽을 수 없는 에이전트 상태 2건은 자동으로 옮기지 않고 그대로 둡니다', 'as before for states alone');
});
test('H4 a state mark\'s press tooltip is one at a time and goes when another card or a card\'s menu is pressed', async t => {
  const { root } = await subCardBoard(t, { agents: [{ id: AGENT_A, status: 'running' }, { id: SUB_ONE, status: 'idle' }] });
  // REQ-93: the sub-card is in its own column already; nothing to open first.
  const mark = title => inCard(root, title, 'card-signal-press')[0];
  const open = () => hosts(root, 'card-signal-tooltip').length;
  await act(async () => mark('Lead card').props.onPress({ stopPropagation() {} }));
  assert.equal(open(), 1);
  await act(async () => mark('Worker one').props.onPress({ stopPropagation() {} }));
  assert.equal(open(), 1, 'one at a time');
  assert.deepEqual([mark('Lead card'), mark('Worker one')].map(p => p.props.accessibilityState.expanded), [false, true], 'the newer one');
  // Another card pressed: its detail opens and the tooltip goes.
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.equal(open(), 0, 'a press on another card closes it');
  await act(async () => root.root.findAllByType('NativeModal').at(-1).props.onRequestClose());
  // A card's ⋯ menu.
  await act(async () => mark('Lead card').props.onPress({ stopPropagation() {} }));
  assert.equal(open(), 1);
  await act(async () => cardArea(root, 'Example card').props.onPointerEnter());
  await act(async () => inCard(root, 'Example card', 'card-move-menu')[0].props.onPress({ stopPropagation() {} }));
  assert.equal(open(), 0, 'opening a card\'s menu closes it');
});
test('REQ-83 ② the auto refresh: two failed looks in a row are said, one good look clears it; tracking news arrives with a look', async t => {
  const h = harness({ width: 1400 }); fastRefresh(h, { intervalMs: 20, idleMs: 60_000, minGapMs: 0 });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => { await pause(30); });
  assert.equal(hosts(root, 'tracking-refresh-error').length, 0);
  h.fail();
  await act(async () => { await pause(25); });
  const once = countOf(h, 'kanban.v1.revisions.get');
  await act(async () => { await pause(120); });
  assert.ok(countOf(h, 'kanban.v1.revisions.get') >= once + 2, 'it keeps looking');
  assert.match(allText(hosts(root, 'tracking-refresh-error')[0]), /^Auto refresh: the boards could not be read again from the Kanban server · trying again automatically$/);
  assert.match(text(root), /Check the result/, 'the board keeps what it shows');
  h.recover();
  await act(async () => { await pause(80); });
  assert.equal(hosts(root, 'tracking-refresh-error').length, 0, 'one good look clears it');
  // The server holds a move meanwhile: the next look says so, with no ledger change and no re-read.
  const reads = countOf(h, 'kanban.v1.overview.get');
  h.setHealth(HELD);
  await act(async () => { await pause(80); });
  assert.equal(hosts(root, 'tracking-server-held').length, 1);
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads, 'no re-read for it');
});

// ---- REQ-85: tool tips centred, "on" as a tint, card hints, fold all, the ⋯ menu with the card id, the card just seen ----
test('REQ-85 ① a tool glyph\'s tip is centred on it, and pushed inside the window only at an edge', async t => {
  const h = harness({ width: 1400 }), { centeredTip, TIP } = h.load('client/components.tsx');
  assert.equal(centeredTip(30, 100), -35, 'its middle on the glyph\'s middle');
  assert.equal(centeredTip(30, 100, { x: 600, width: 30, window: 1400 }), -35);
  assert.equal(1360 + centeredTip(30, 100, { x: 1360, width: 30, window: 1400 }) + 100, 1400 - TIP.margin, 'at the right edge: kept 8px inside');
  assert.equal(0 + centeredTip(30, 100, { x: 0, width: 30, window: 1400 }), TIP.margin, 'at the left edge: kept 8px inside');
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  for (const id of ['group-toggle', 'sort-menu', 'fold-all', 'view-list', 'open-settings']) {
    await act(async () => sheetButton(root, id).props.onHoverIn());
    const tip = () => hosts(root, 'icon-tooltip')[0];
    // Until its own width is known it waits unseen on the web (one frame), then it is centred.
    assert.equal(tip().props.style.opacity, 0, id + ': unseen before it is measured');
    await act(async () => tip().props.onLayout({ nativeEvent: { layout: { width: 90 } } }));
    assert.equal(tip().props.style.left, -30, id + ': centred under a 30px glyph');
    assert.equal(tip().props.style.right, undefined); assert.equal(tip().props.style.opacity, undefined);
    await act(async () => sheetButton(root, id).props.onHoverOut());
  }
});
test('REQ-85 ② ③ "on" is a tint of the main colour: its glyph in the main colour clears 3:1, chosen words 4.5:1, hover stays grey — every theme', async t => {
  for (const combo of REQ72_COMBOS) {
    const c = combo.chosen;
    for (const onto of [c.surface0, c.surface1]) {
      const tint = selectedTint(c, onto), hot = selectedTint(c, onto, true), mark = selectedLine(c, tint);
      assert.ok(contrast(mark, tint) >= 3.5, combo.label + ': the "on" glyph on its tint ' + contrast(mark, tint).toFixed(2));
      assert.ok(contrast(mark, hot) >= 3, combo.label + ': and on the deeper hover tint');
      assert.ok(contrast(c.foreground, tint) >= 4.5 && contrast(c.foreground, hot) >= 4.5, combo.label + ': chosen words read on it');
      assert.notEqual(tint, onto); assert.notEqual(hot, tint);
    }
    const { hoverFill } = harness({ width: 1400 }).load('client/palette.ts');
    assert.notEqual(hoverFill(c, c.surface0), selectedTint(c, c.surface0), combo.label + ': hover is not "on"');
  }
  // research/128 ②: the light default tint is the 16% mix the sample drew.
  const light = palette(PASEO_THEMES.light);
  assert.equal(selectedTint(light, '#ffffff'), '#dbe9e2');
});
test('REQ-85 ⑥ each card element says what it is under the mouse: state, model and provider, a title cut short', async t => {
  const h = harness({ width: 1400, link: [AGENT_A], agents: [{ id: AGENT_A, status: 'running', provider: 'claude', model: 'claude-opus-5-5' }] });
  const clippedTitle = { scrollHeight: 40, clientHeight: 36 };
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props,
    { createNodeMock: element => element.props?.testID === 'card-title' ? clippedTitle : {} });
  const inside = id => cardArea(root, 'Example card').findAll(n => n.props?.testID === id && typeof n.type === 'string');
  const mark = () => inCard(root, 'Example card', 'card-signal-press')[0];
  await act(async () => mark().props.onHoverIn());
  assert.equal(allText(inside('card-hint-state')[0]), 'Working');
  // A click hides it, as on the tool glyphs; the press still shows the whole line (REQ-44).
  await act(async () => mark().props.onPressIn({ nativeEvent: { type: 'pointerdown' } }));
  assert.equal(inside('card-hint-state').length, 0, 'gone after a click');
  await act(async () => mark().props.onHoverOut());
  const agent = () => inCard(root, 'Example card', 'card-agent')[0];
  await act(async () => agent().props.onPointerEnter());
  assert.equal(allText(inside('card-hint-model')[0]), 'Opus 5.5 · Claude');
  await act(async () => agent().props.onPointerLeave());
  assert.equal(inside('card-hint-model').length, 0);
  const title = () => inCard(root, 'Example card', 'card-title')[0];
  await act(async () => title().props.onPointerEnter());
  assert.equal(allText(inside('card-hint-title')[0]), 'Example card', 'a clamped title shows whole');
  await act(async () => title().props.onPointerLeave());
  clippedTitle.scrollHeight = 36;
  await act(async () => title().props.onPointerEnter());
  assert.equal(inside('card-hint-title').length, 0, 'a title shown whole says nothing more');
});
test('REQ-85 ⑦ fold every workspace from the wide title row, and open them again from the same glyph; on 390px two buttons in the filter sheet', async t => {
  const h = harness({ width: 1400, empty: ['wks_empty01'] });
  h.addCard({ ...add('In flight'), stageId: 'doing' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const glyph = () => sheetButton(root, 'fold-all'), open = () => hosts(root, 'swimlane-cells').length;
  assert.ok(open() > 0);
  assert.equal(glyph().props.accessibilityLabel, 'Collapse all workspaces');
  assert.equal(glyph().findByType('Icon').props.name, 'ListChevronsDownUp');
  await act(async () => glyph().props.onPress());
  assert.equal(open(), 0, 'every workspace folded');
  assert.equal(glyph().props.accessibilityLabel, 'Expand all workspaces', 'the same place now opens them');
  await act(async () => glyph().props.onPress());
  assert.equal(open(), 2, 'every workspace open, the empty one too');
  assert.equal(h.ui.writes.length, 0, 'a view choice, never saved');
  const m = harness({ mobile: true, platform: 'web' });
  m.addCard({ ...add('In flight'), stageId: 'doing' });
  const phone = await render(t, m.load('client/overview.tsx').OverviewScreen, m.props);
  const cards = () => phone.root.findAllByType('Pressable').filter(p => p.props.testID?.startsWith('kanban-card-')).length;
  assert.ok(cards() > 0);
  await act(async () => sheetButton(phone, 'open-filters').props.onPress());
  const [fold, unfold] = ['fold-all', 'open-all'].map(id => sheetButton(phone, id));
  assert.deepEqual([fold, unfold].map(b => [allText(b), b.props.style.minHeight]), [['Collapse all', 44], ['Expand all', 44]]);
  await act(async () => fold.props.onPress());
  await closeWindow(phone);
  assert.equal(cards(), 0, 'folded on the phone');
  await act(async () => sheetButton(phone, 'open-filters').props.onPress());
  await act(async () => sheetButton(phone, 'open-all').props.onPress());
  await closeWindow(phone);
  assert.ok(cards() > 0, 'and open again');
});
test('REQ-85 ⑧ the ⋯ menu hangs under the ⋯: stages as they are, a line, "Copy card ID"; a copy that fails shows the id to select', async t => {
  for (const copy of ['ok', 'fail', 'missing']) {
    const h = harness({ width: 1400, copy });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props,
      { createNodeMock: () => ({ measureInWindow: done => done(300, 200, 24, 24), focus: () => {} }) });
    const id = h.base.cards[0].id;
    await act(async () => cardArea(root, 'Example card').props.onPointerEnter());
    await act(async () => inCard(root, 'Example card', 'card-move-menu')[0].props.onPress({ stopPropagation() {} }));
    const menu = hosts(root, 'card-menu');
    assert.equal(menu.length, 1, copy + ': the dropdown, not the centred window');
    assert.equal(hosts(root, 'menu-sheet').length, 0);
    const box = flatStyle(menu[0].props.style);
    assert.ok(box.top >= 224, copy + ': under the ⋯');
    const rows = menu[0].findAll(n => typeof n.type === 'string' && /^(move-to-|menu-divider|copy-card-id)/.test(n.props?.testID ?? '')).map(n => n.props.testID);
    assert.deepEqual(rows, ['move-to-todo', 'move-to-doing', 'move-to-review', 'move-to-done', 'menu-divider', 'copy-card-id']);
    const current = sheetButton(root, 'move-to-todo'), c = palette(h.props.theme);
    assert.equal(current.props.style.backgroundColor, selectedTint(c, c.surface1), 'the current stage is tinted (③B)');
    assert.equal(current.props.accessibilityState.disabled, true);
    await act(async () => sheetButton(root, 'copy-card-id').props.onPress());
    await act(async () => { await pause(0); });
    assert.equal(hosts(root, 'card-menu').length, 0, 'the menu closes');
    const toast = allText(hosts(root, 'move-toast')[0]);
    if (copy === 'ok') {
      assert.deepEqual(h.copies, [id]);
      assert.match(toast, new RegExp('^Card ID copied · ' + id));
      assert.equal(hosts(root, 'move-toast-selectable').length, 0);
    } else {
      assert.match(toast, /Could not copy\. Select the ID below to copy it:/);
      const shown = hosts(root, 'move-toast-selectable')[0];
      assert.equal(allText(shown), id); assert.equal(shown.props.selectable, true);
    }
  }
  // Without a place to hang from (a screen reader's action, a long press), the centred window or the sheet has the same rows.
  const h = harness({ width: 1400 }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => cardArea(root, 'Example card').props.onPointerEnter());
  await act(async () => inCard(root, 'Example card', 'card-move-menu')[0].props.onPress({ stopPropagation() {} }));
  assert.equal(hosts(root, 'card-menu').length, 0);
  assert.equal(hosts(root, 'copy-card-id').length, 1);
  assert.equal(hosts(root, 'menu-divider').length, 1);
});
test('REQ-85 ⑨ the card whose detail was just closed is tinted until another card is opened', async t => {
  for (const kind of ['swimlane', 'board']) {
    const h = harness({ width: 1400 });
    h.addCard(add('Second card'));
    if (kind === 'board') h.load('client/session-store.ts').sessionFor(h.props.host.id + ':surface').set('board', h.base.id);
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    // REQ-95 ④: grey now, no longer the main colour's tint.
    const c = palette(h.props.theme), plain = h.load('client/panel-style.ts').cardDecoration(c).backgroundColor, tint = viewedTint(c, plain);
    const face = title => flatStyle(labelled(root, title).props.style).backgroundColor;
    const box = title => { let node = labelled(root, title); while (node && node.props?.testID !== 'card-shadow') node = node.parent; return flatStyle(node.props.style); };
    assert.deepEqual([face('Example card'), face('Second card')], [plain, plain]);
    await act(async () => labelled(root, 'Example card').props.onPress());
    await closeWindow(root);
    assert.deepEqual([face('Example card'), box('Example card').backgroundColor, face('Second card')], [tint, tint, plain], kind + ': tinted once closed');
    assert.equal(box('Example card').borderWidth, undefined, kind + ': no line (⑨ tint only)');
    await act(async () => labelled(root, 'Second card').props.onPress());
    assert.equal(face('Example card'), plain, kind + ': another card opened takes it away');
    await closeWindow(root);
    assert.deepEqual([face('Example card'), face('Second card')], [plain, tint], kind + ': and the one just seen is tinted');
  }
});

// ---- REQ-87 · REQ-88 · REQ-91 (research/129 samples, research/146) -------------------------------------------------
test('REQ-88 ② a text field\'s edge is faint at rest and the main colour at the same 1px under the mouse and while typing; a phone has no hover', async t => {
  const { h, root } = await detail(t, { width: 1400 });
  const c = palette(h.props.theme), field = () => input(root, 'Next action'), box = () => hosts(root, 'field-nextAction-box')[0];
  const edge = () => [field().props.style.borderColor, field().props.style.borderWidth];
  assert.deepEqual(edge(), [fieldLine(c, c.surface1), 1], 'at rest');
  await act(async () => box().props.onPointerEnter());
  assert.deepEqual(edge(), [selectedLine(c, c.surface1), 1], 'under the mouse: the main colour, no thicker');
  await act(async () => box().props.onPointerLeave());
  assert.deepEqual(edge(), [fieldLine(c, c.surface1), 1]);
  await act(async () => field().props.onFocus());
  assert.deepEqual(edge(), [selectedLine(c, c.surface1), 1], 'while typing');
  assert.match(allText(hosts(root, 'field-nextAction-hint')[0]), /Enter or leaving the field saves/);
  await act(async () => field().props.onBlur()); await settle();
  assert.deepEqual(edge(), [fieldLine(c, c.surface1), 1]);
  const phone = await detail(t, { mobile: true });
  assert.equal(hosts(phone.root, 'field-nextAction-box')[0].props.onPointerEnter, undefined, 'a phone has no hover');
});
test('REQ-88 ③ the title is edited where it stands: Enter saves, Escape puts it back without closing the window, an empty title is refused', async t => {
  const { h, root, closed } = await detail(t, { width: 1400 });
  assert.equal(root.root.findAllByType('TextInput').filter(n => n.props.accessibilityLabel === 'Title').length, 0, 'no title field until pressed');
  const title = () => hosts(root, 'detail-title')[0], field = () => hosts(root, 'detail-title-input')[0];
  assert.equal(title().props.accessibilityLabel, 'Edit title: Example card');
  await act(async () => title().props.onHoverIn());
  assert.equal(hosts(root, 'detail-title-pencil').length, 1, 'the mouse shows a pencil over a faint fill');
  // Escape: the old title back, nothing sent, and the same key's close of the window is not taken.
  await act(async () => title().props.onPress());
  await act(async () => field().props.onChangeText('Not this'));
  await act(async () => field().props.onKeyPress({ nativeEvent: { key: 'Escape' } }));
  await act(async () => root.root.findByType('NativeModal').props.onRequestClose()); await settle();
  assert.equal(closed(), 0, 'Escape undid the typing; the window stays');
  assert.equal(allText(title()), 'Example card'); assert.equal(h.calls.filter(c => c.name.endsWith('mutate')).length, 0);
  // Enter (a text area's newline) saves the title alone.
  await act(async () => title().props.onPress());
  await act(async () => field().props.onChangeText('New title\n')); await settle();
  assert.equal(h.base.cards[0].title, 'New title'); assert.equal(hosts(root, 'detail-title-input').length, 0, 'back to the heading');
  assert.deepEqual(h.calls.filter(c => c.name.endsWith('mutate')).at(-1).input.operations[0].patch, { title: 'New title' });
  // Empty: refused under the title, nothing sent.
  await act(async () => title().props.onPress());
  await act(async () => field().props.onChangeText('   '));
  await act(async () => field().props.onBlur()); await settle();
  assert.match(allText(hosts(root, 'field-status-title')[0]), /A title is needed/);
  assert.equal(h.base.cards[0].title, 'New title'); assert.equal(h.calls.filter(c => c.name.endsWith('mutate')).length, 1);
});
test('REQ-88 ③ a phone edits the title with × and ✓ under the field: × cancels even though the field is left first', async t => {
  const { h, root } = await detail(t, { mobile: true, platform: 'android' });
  const field = () => hosts(root, 'detail-title-input')[0];
  await act(async () => hosts(root, 'detail-title')[0].props.onPress());
  assert.equal(hosts(root, 'detail-title-save').length, 1); assert.equal(hosts(root, 'detail-title-cancel').length, 1);
  assert.equal(hosts(root, 'detail-title-save')[0].props.style.width, 44, '44px reach');
  await act(async () => field().props.onChangeText('Dropped'));
  // The press begins, the field is left (web), then the press ends.
  await act(async () => { hosts(root, 'detail-title-cancel')[0].props.onPressIn(); field().props.onBlur(); }); await settle();
  if (hosts(root, 'detail-title-cancel').length) await act(async () => hosts(root, 'detail-title-cancel')[0].props.onPress());
  assert.equal(h.calls.filter(c => c.name.endsWith('mutate')).length, 0); assert.equal(allText(hosts(root, 'detail-title')[0]), 'Example card');
  await act(async () => hosts(root, 'detail-title')[0].props.onPress());
  await act(async () => field().props.onChangeText('Kept'));
  await act(async () => hosts(root, 'detail-title-save')[0].props.onPress()); await settle();
  assert.equal(h.base.cards[0].title, 'Kept');
});
test('REQ-87 ⑥ every phone sheet closes by one round × in its head; no list ends in a "Close" row', async t => {
  const { root } = await archivedBoard(t, { mobile: true, platform: 'android', width: 390 });
  const round = (id = 'sheet-close') => { const x = hosts(root, id)[0];
    assert.ok(x, id); assert.equal(x.props.style.borderRadius, 16); assert.equal(x.props.style.width, 32); return x; };
  const open = [
    ['filters', async () => act(async () => sheetButton(root, 'open-filters').props.onPress()), 'sheet-close'],
    ['⋯ stages', async () => act(async () => labelled(root, 'Loose card').props.onLongPress()), 'sheet-close'],
    ['card', async () => act(async () => labelled(root, 'Loose card').props.onPress()), 'sheet-close'],
    ['order ⋯', async () => act(async () => sheetButton(root, 'lane-order-menu').props.onPress()), 'sheet-close'],
    ['settings', async () => openSettings(root), 'settings-close']];
  for (const [what, show, id] of open) {
    await show();
    assert.equal(root.root.findAllByType('NativeModal').length, 1, what + ' open');
    assert.equal(wordButtons(root, 'Close'), 0, what + ': no "Close" row');
    await act(async () => round(id).props.onPress()); await settle();
    assert.equal(root.root.findAllByType('NativeModal').length, 0, what + ': the × closed it');
  }
});
test('REQ-87 ⑦ a phone sheet\'s content ends the system bar + 8px above the bottom: the measured Android bar, else 48; iPhone 34; not while typing', async t => {
  const content = root => flatStyle(hosts(root, 'sheet-content')[0].props.style).paddingBottom;
  const sheetOn = async options => { const h = harness({ mobile: true, ...options });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    await act(async () => sheetButton(root, 'open-filters').props.onPress()); return { h, root }; };
  // A gesture bar the window leaves out (screen 844 + 24 status + 24 bar): 24 + 8.
  assert.equal(content((await sheetOn({ platform: 'android', screenHeight: 892, statusBar: 24 })).root), 32);
  // A 3-button bar: 48 + 8.
  assert.equal(content((await sheetOn({ platform: 'android', screenHeight: 916, statusBar: 24 })).root), 56);
  // Edge to edge (nothing to read): the 3-button bar's 48 is assumed.
  const edge = await sheetOn({ platform: 'android' });
  assert.equal(content(edge.root), 56);
  // The keyboard up: the sheet sits on it, not on the bar.
  await act(async () => edge.h.keyboard('keyboardDidShow'));
  assert.equal(content(edge.root), 8);
  await act(async () => edge.h.keyboard('keyboardDidHide'));
  assert.equal(content(edge.root), 56);
  assert.equal(content((await sheetOn({ platform: 'ios' })).root), 42, 'iPhone home indicator 34 + 8');
  // The sheet's own background still runs to the bottom edge behind the bar.
  const sheet = hosts(edge.root, 'menu-sheet')[0];
  assert.equal(flatStyle(sheet.props.style).borderBottomWidth, 0); assert.equal(sheet.parent.props.style.justifyContent, 'flex-end');
});
test('REQ-91 the phone\'s filter glyph stays one glyph: on with a count badge when filters apply, "Filters: n applied" to a screen reader', async t => {
  const h = harness({ mobile: true, platform: 'ios' }), root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const glyph = () => sheetButton(root, 'open-filters'), c = palette(h.props.theme);
  assert.equal(glyph().props.accessibilityLabel, 'Filters and search'); assert.equal(glyph().props.accessibilityState.selected, false);
  assert.equal(hosts(root, 'open-filters-badge').length, 0, 'no badge while nothing is filtered');
  await act(async () => glyph().props.onPress());
  await act(async () => input(root, 'Search cards').props.onChangeText('Example'));
  await act(async () => sheetButton(root, 'attention-chip')?.props.onPress?.());
  await act(async () => root.root.findAllByType('NativeModal')[0].props.onRequestClose());
  const on = glyph();
  assert.equal(on.findAllByType('Icon')[0].props.name, 'ListFilter', 'the same glyph');
  assert.equal(on.props.accessibilityState.selected, true);
  assert.equal(on.props.style.backgroundColor, selectedTint(c, c.surface2), 'REQ-85: tinted');
  assert.equal(on.findAllByType('Icon')[0].props.color, selectedLine(c, selectedTint(c, c.surface2)), 'glyph in the main colour');
  const count = allText(hosts(root, 'open-filters-badge')[0]);
  assert.equal(on.props.accessibilityLabel, 'Filters: ' + count + ' applied');
  assert.ok(Number(count) >= 1);
  const ko = harness({ mobile: true, platform: 'ios', locale: 'ko' }), kr = await render(t, ko.load('client/overview.tsx').OverviewScreen, ko.props);
  await act(async () => sheetButton(kr, 'open-filters').props.onPress());
  await act(async () => input(kr, '카드 검색').props.onChangeText('Example'));
  await act(async () => kr.root.findAllByType('NativeModal')[0].props.onRequestClose());
  assert.equal(sheetButton(kr, 'open-filters').props.accessibilityLabel, '필터 1개 적용');
});

// ---- REQ-103 1단계: acceptance criteria as a checklist, measured on the card and ticked in the detail ----
/** A wide board: the example card awaits the user; cards with each kind of criteria in doing, review and done. */
async function criteriaBoard(t, options = {}) {
  const h = harness({ width: 1900, ...options });
  h.addCard({ ...add('Plain criteria'), stageId: 'doing' });
  h.addCard({ ...add('Two of three'), stageId: 'doing', acceptanceCriteria: '- [x] One\n- [x] Two\n- [ ] Three' });
  h.addCard({ ...add('All ticked'), stageId: 'review', acceptanceCriteria: '- [x] One\n- [X] Two\n- [x] Three' });
  h.addCard({ ...add('Done unticked'), stageId: 'done', acceptanceCriteria: '- [x] One\n- [ ] Two' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  return { h, root };
}
test('REQ-103 ② the card says "Criteria 2/3" on its second row, a check with "Criteria 3/3", nothing without a checklist', async t => {
  const { h, root } = await criteriaBoard(t), c = palette(h.props.theme);
  const plain = inCard(root, 'Two of three', 'card-criteria')[0];
  // REQ-145 ③ (gate 367): the word and the numbers are two texts — on a narrow line the word gives way, the numbers never.
  const words = node => node.findAllByType('Text').map(allText);
  assert.deepEqual(words(plain), ['Criteria', '2/3']);
  assert.deepEqual(plain.findAllByType('Text').map(t => flatStyle(t.props.style).flexShrink), [1, 0]);
  assert.equal(plain.findAllByType('Icon').length, 0, 'no check until every line is ticked');
  assert.equal(plain.findAllByType('Text')[0].props.style.color, readable(c.foregroundMuted, c.card), 'muted like the age');
  assert.ok(plain.parent === lineTwo(root, 'Two of three'), 'on the row with the assignee and the age');
  const all = inCard(root, 'All ticked', 'card-criteria')[0];
  assert.deepEqual(words(all), ['Criteria', '3/3']);
  assert.equal(all.findAllByType('Icon')[0].props.name, 'Check');
  assert.equal(all.props.accessibilityLabel, 'All 3 criteria ticked');
  assert.equal(inCard(root, 'Plain criteria', 'card-criteria').length + inCard(root, 'Plain criteria', 'card-criteria-unmet').length, 0);
  assert.equal(inCard(root, 'Example card', 'card-criteria').length, 0);
  assert.equal(inCard(root, 'Two of three', 'card-criteria-unmet').length, 0, 'not done: no mark');
});
test('REQ-103 ② a done card with unticked lines is marked "Criteria unchecked" in plain orange words, not a chip, and never counted', async t => {
  const { h, root } = await criteriaBoard(t), c = palette(h.props.theme);
  const mark = inCard(root, 'Done unticked', 'card-criteria-unmet')[0];
  assert.deepEqual(mark.findAllByType('Text').map(allText), ['Criteria unchecked', '1/2'], 'gate 367: the numbers a text of their own');
  assert.equal(mark.props.accessibilityLabel, 'Done with criteria unchecked: 1 of 2 ticked');
  const words = mark.findAllByType('Text')[0].props.style;
  assert.equal(words.color, readable(c.statusWarning, c.card)); assert.notEqual(words.fontWeight, '600', 'not bold like "Response needed"');
  const box = flatStyle(mark.props.style);
  assert.equal(box.borderWidth ?? 0, 0); assert.equal(box.backgroundColor, undefined, 'no chip: no edge, no fill');
  assert.equal(mark.findAllByType('Icon')[0].props.name, 'CircleAlert');
  assert.equal(inCard(root, 'Done unticked', 'card-reply-chip').length + inCard(root, 'Done unticked', 'card-reply-text').length, 0);
  // Needs attention counts the example card (awaiting the user) alone, as it would without the checklist.
  assert.equal(nativeNode(root, 'attention-count').children[0], '1');
  assert.match(text(root), /Needs attention 1/);
  const other = harness({ width: 1900 }); other.addCard({ ...add('Done unticked'), stageId: 'done' });
  const plain = await render(t, other.load('client/overview.tsx').OverviewScreen, other.props);
  assert.equal(nativeNode(plain, 'attention-count').children[0], '1', 'the same count without a checklist');
  // Korean.
  const ko = await criteriaBoard(t, { locale: 'ko' });
  assert.deepEqual(inCard(ko.root, 'Done unticked', 'card-criteria-unmet')[0].findAllByType('Text').map(allText), ['기준 미확인 완료', '1/2']);
  assert.deepEqual(inCard(ko.root, 'Two of three', 'card-criteria')[0].findAllByType('Text').map(allText), ['기준', '2/3']);
});
test('REQ-103 ③ the top and each lane head say "Cards N/M" beside the bar, with no percent', async t => {
  const { root } = await criteriaBoard(t);
  assert.equal(allText(hosts(root, 'swimlane-progress')[0]), 'Cards 1/5');
  const lane = hosts(root, 'lane-progress')[0];
  assert.equal(allText(lane), 'Cards 1/5'); assert.equal(hosts(root, 'lane-progress-fill').length, 1, 'the bar stays');
  assert.doesNotMatch(allText(hosts(root, 'swimlane-title-row')[0]) + allText(lane), /%/);
  const ko = await criteriaBoard(t, { locale: 'ko' });
  assert.equal(allText(hosts(ko.root, 'swimlane-progress')[0]), '카드 1/5');
  assert.equal(allText(hosts(ko.root, 'lane-progress')[0]), '카드 1/5');
  // The phone's lane heading too.
  const phone = harness({ mobile: true, platform: 'ios' }); phone.addCard({ ...add('In flight'), stageId: 'doing' });
  const small = await render(t, phone.load('client/overview.tsx').OverviewScreen, phone.props);
  const heading = JSON.stringify(nativeNode(small, 'mobile-workspace-heading'));
  assert.match(heading, /Cards 0\/2/); assert.doesNotMatch(heading, /%/);
});
test('REQ-103 ② the detail ticks a checklist line on a press and saves the criteria as its own field (REQ-88 ⑤)', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  h.external({ acceptanceCriteria: '- [ ] First\nKeep this note\n  - [x] Second' });
  const root = await render(t, h.load('client/detail.tsx').Detail, { ...h.props, boardId: h.base.id, cardId: h.base.cards[0].id,
    locale: 'en', onClose: () => {} });
  assert.equal(allText(hosts(root, 'detail-criteria-progress')[0]), 'Criteria 1/2');
  assert.match(allText(hosts(root, 'detail-criteria')[0]), /Keep this note/, 'other lines are shown as written');
  const first = () => hosts(root, 'detail-criterion-0')[0];
  assert.equal(first().props.accessibilityRole, 'checkbox'); assert.equal(first().props.accessibilityState.checked, false);
  assert.equal(first().props.accessibilityLabel, 'Tick criterion: First');
  assert.equal(hosts(root, 'detail-criterion-1').length, 0, 'the note is no box');
  await act(async () => first().props.onPress()); await settle();
  const writes = () => h.calls.filter(c => c.name.endsWith('mutate'));
  assert.deepEqual(writes().at(-1).input.operations, [{ op: 'update', id: h.base.cards[0].id,
    patch: { acceptanceCriteria: '- [x] First\nKeep this note\n  - [x] Second' } }], 'the criteria alone, the other lines as they were');
  assert.equal(h.base.cards[0].acceptanceCriteria, '- [x] First\nKeep this note\n  - [x] Second');
  assert.equal(first().props.accessibilityState.checked, true);
  assert.equal(allText(hosts(root, 'detail-criteria-progress')[0]), 'Criteria 2/2');
  assert.match(allText(hosts(root, 'field-status-acceptanceCriteria')[0]), /Saved/);
  // Unticking saves again, on the latest revision.
  await act(async () => hosts(root, 'detail-criterion-2')[0].props.onPress()); await settle();
  assert.equal(writes().length, 2); assert.equal(writes()[1].input.ifRevision !== writes()[0].input.ifRevision, true);
  assert.equal(h.base.cards[0].acceptanceCriteria, '- [x] First\nKeep this note\n  - [ ] Second');
  // A failed tick keeps it ticked with "Try again", which sends it once more.
  h.outcome('failed');
  await act(async () => hosts(root, 'detail-criterion-2')[0].props.onPress()); await settle();
  assert.equal(hosts(root, 'detail-criterion-2')[0].props.accessibilityState.checked, true);
  assert.match(allText(hosts(root, 'field-status-acceptanceCriteria')[0]), /Try again/);
  h.outcome('ok');
  await act(async () => hosts(root, 'field-retry-acceptanceCriteria')[0].props.onPress()); await settle();
  assert.equal(h.base.cards[0].acceptanceCriteria, '- [x] First\nKeep this note\n  - [x] Second');
});
test('REQ-103 ② criteria without a checklist stay plain text in the detail, and a phone\'s box is 44px tall', async t => {
  const plain = await detail(t);
  assert.equal(hosts(plain.root, 'detail-criteria').length, 0);
  assert.match(text(plain.root), /A reviewable result exists\./);
  const h = harness({ mobile: true, platform: 'ios' });
  h.external({ acceptanceCriteria: '- [ ] Only' });
  const root = await render(t, h.load('client/detail.tsx').Detail, { ...h.props, boardId: h.base.id, cardId: h.base.cards[0].id,
    locale: 'en', onClose: () => {} });
  assert.equal(flatStyle(hosts(root, 'detail-criterion-0')[0].props.style).minHeight, 44);
});
test('REQ-103 J1: Space ticks a checklist line like a click, once per press, without scrolling the page', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  h.external({ acceptanceCriteria: '- [ ] First\n- [x] Second' });
  const root = await render(t, h.load('client/detail.tsx').Detail, { ...h.props, boardId: h.base.id, cardId: h.base.cards[0].id,
    locale: 'en', onClose: () => {} });
  const first = () => hosts(root, 'detail-criterion-0')[0];
  let prevented = 0;
  const key = (k, repeat = false) => act(async () => first().props.onKeyDown({ key: k, repeat, preventDefault: () => { prevented++; } }));
  assert.equal(first().props.accessibilityState.checked, false);
  await key(' '); await settle();
  assert.equal(first().props.accessibilityState.checked, true, 'Space ticks it');
  assert.equal(prevented, 1, 'and the page does not scroll');
  const writes = () => h.calls.filter(c => c.name.endsWith('mutate'));
  assert.deepEqual(writes().at(-1).input.operations, [{ op: 'update', id: h.base.cards[0].id,
    patch: { acceptanceCriteria: '- [x] First\n- [x] Second' } }], 'the same save as a click');
  await key(' ', true);
  assert.equal(first().props.accessibilityState.checked, true, 'a held key does not flip it back');
  await key('Spacebar'); await settle();
  assert.equal(first().props.accessibilityState.checked, false, 'the old key name too');
  assert.equal(prevented, 3);
});
test('REQ-103 J1: Enter still ticks a checklist line (native Pressable behaviour, no double flip)', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  h.external({ acceptanceCriteria: '- [ ] First' });
  const root = await render(t, h.load('client/detail.tsx').Detail, { ...h.props, boardId: h.base.id, cardId: h.base.cards[0].id,
    locale: 'en', onClose: () => {} });
  const first = () => hosts(root, 'detail-criterion-0')[0];
  let prevented = 0;
  await act(async () => first().props.onKeyDown({ key: 'Enter', repeat: false, preventDefault: () => { prevented++; } }));
  assert.equal(first().props.accessibilityState.checked, false, 'onKeyDown leaves Enter to the Pressable itself');
  assert.equal(prevented, 0);
  await act(async () => first().props.onPress()); await settle();
  assert.equal(first().props.accessibilityState.checked, true, 'the Pressable\'s own Enter handling still ticks it');
});

// ---- REQ-97: a draft moved to the working stage is sent to the workspace's lead, after a confirmation sheet ----
const dispatchWrites = h => h.calls.filter(c => c.name === 'kanban.v1.board.mutate');
async function openIdeaMenu(root) {
  await act(async () => cardArea(root, 'Loose idea').props.onPointerEnter());
  await act(async () => inCard(root, 'Loose idea', 'card-move-menu')[0].props.onPress({ stopPropagation() {} }));
}
test('REQ-97 a draft moved to In progress asks first — the lead, the card, the words it gets; Cancel leaves it a draft', async t => {
  const { h, root } = await archivedBoard(t);
  const idea = () => h.base.cards.find(c => c.title === 'Loose idea');
  const before = dispatchWrites(h).length;
  await openIdeaMenu(root);
  assert.equal(sheetButton(root, 'move-to-review').props.accessibilityState.disabled, true, 'review stays closed to a draft');
  assert.equal(sheetButton(root, 'move-to-done').props.accessibilityState.disabled, true, 'so does done');
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  await settle();
  const sheet = hosts(root, 'dispatch-sheet')[0];
  assert.equal(sheet.props['aria-label'], 'Send to 총괄-07?', 'the lead by its short name');
  assert.equal(textOf(nativeNode(root, 'dispatch-card-title')), 'Loose idea');
  const words = () => textOf(nativeNode(root, 'dispatch-message'));
  assert.equal(words(), ['[칸반 요청] Loose idea', `카드: ${idea().id} · 보드: Example Workspace`, '완료 기준: Loose idea',
    '할 일: 위 요청을 처리해 주세요. 완료 기준을 채우면 무엇을 했는지 짧게 알려 주세요.',
    `(kanban CLI가 있으면 이 카드를 담당 카드로 이어 쓰세요: kanban card link ${idea().id} --agent ${AGENT_B} — CLI가 없으면 이 줄은 건너뛰세요)`].join('\n'),
    'no criteria yet: the title stands in; an older server names no language: Korean');
  assert.match(textOf(nativeNode(root, 'dispatch-when')), /Sent when 총괄-07 is idle/);
  await act(async () => input(root, 'Acceptance criteria').props.onChangeText('A sample result is shown'));
  assert.match(words(), /완료 기준: A sample result is shown/, 'the preview follows the typed criteria');
  assert.equal(dispatchWrites(h).length, before, 'nothing written while asking');
  await act(async () => sheetButton(root, 'dispatch-cancel').props.onPress());
  assert.equal(hosts(root, 'dispatch-sheet').length, 0);
  assert.equal(dispatchWrites(h).length, before, 'Cancel writes nothing');
  assert.equal(idea().stageId, 'todo'); assert.equal(idea().intent, 'draft');
  // × and a press outside cancel too.
  await openIdeaMenu(root);
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  await settle();
  await act(async () => sheetButton(root, 'dispatch-sheet-backdrop').props.onPress());
  assert.equal(hosts(root, 'dispatch-sheet').length, 0);
  assert.equal(dispatchWrites(h).length, before);
});
test('REQ-97 Send moves the card to In progress as requested work waiting to be sent; its face says so, then "Sent HH:MM"', async t => {
  const { h, root } = await archivedBoard(t);
  const idea = () => h.base.cards.find(c => c.title === 'Loose idea');
  await openIdeaMenu(root);
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  await settle();
  await act(async () => input(root, 'Acceptance criteria').props.onChangeText('A sample result is shown'));
  await act(async () => sheetButton(root, 'dispatch-send').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet').length, 0, 'the sheet closes');
  assert.deepEqual(dispatchWrites(h).at(-1).input.operations, [{ op: 'dispatch', id: idea().id, to: 'doing', acceptanceCriteria: 'A sample result is shown',
    targetAgentId: AGENT_B }], '253-D2: the agent the sheet named goes with the request');
  assert.equal(idea().stageId, 'doing'); assert.equal(idea().intent, 'requested');
  assert.equal(idea().acceptanceCriteria, 'A sample result is shown'); assert.equal(idea().dispatch.state, 'pending');
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Waiting to send to 총괄-07/);
  const chip = inCard(root, 'Loose idea', 'card-dispatch-pending')[0];
  assert.equal(textOf(chip), 'Waiting to send ⏳');
  assert.equal(inCard(root, 'Loose idea', 'card-dispatch-pending').length, 1);
  // The server sends it and records it; the next read shows the time instead.
  h.addCard({ op: 'dispatched', id: idea().id, state: 'sent', targetAgentId: AGENT_B }, '2026-01-01T05:07:00.000Z');
  const again = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const sent = inCard(again, 'Loose idea', 'card-dispatch-sent')[0];
  const local = new Date('2026-01-01T05:07:00.000Z'), hhmm = String(local.getHours()).padStart(2, '0') + ':' + String(local.getMinutes()).padStart(2, '0');
  assert.equal(textOf(sent), 'Sent ' + hhmm);
  assert.equal(sent.props.style.fontSize, 11, 'small words');
  assert.equal(sent.props.style.color, readable(palette(h.props.theme).foregroundMuted, palette(h.props.theme).card), 'muted');
});
test('REQ-97 v0.1.46-B a phone in Korean with no agent at all: the sheet says to open a chat, the card waits as "받을 에이전트 없음" in a quiet orange', async t => {
  const { h, root } = await archivedBoard(t, { mobile: true, platform: 'ios', width: 390, locale: 'ko', dispatchLead: null });
  const idea = () => h.base.cards.find(c => c.title === 'Loose idea');
  await act(async () => labelled(root, 'Loose idea').props.onLongPress());
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet')[0].props['aria-label'], '보낼 에이전트가 없습니다');
  assert.match(textOf(nativeNode(root, 'dispatch-when')), /보낼 에이전트가 없습니다 — 새 채팅을 먼저 여세요\. 보내 두면 에이전트가 생길 때 보냅니다/);
  assert.doesNotMatch(textOf(nativeNode(root, 'dispatch-message')), /kanban card link/, 'no agent yet: no command line');
  assert.equal(sheetButton(root, 'dispatch-send').props.style.minHeight, 44, 'a phone\'s reach');
  await act(async () => sheetButton(root, 'dispatch-send').props.onPress());
  await settle();
  assert.equal(idea().dispatch.state, 'pending');
  assert.match(textOf(nativeNode(root, 'move-toast')), /받을 에이전트 없음 — 에이전트가 생기면 보냅니다/);
  h.addCard({ op: 'dispatched', id: idea().id, state: 'noLead', targetAgentId: null });
  const again = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => again.root.findAllByType('Pressable').find(p => /^진행 \d/.test(p.props.accessibilityLabel ?? '')).props.onPress());
  const chip = inCard(again, 'Loose idea', 'card-dispatch-noLead')[0];
  assert.equal(textOf(chip), '받을 에이전트 없음');
  const c = palette(h.props.theme);
  assert.equal(chip.props.style.color, readable(c.statusWarning, c.card)); assert.notEqual(chip.props.style.fontWeight, '600', 'plain, not bold');
});
test('253-D3 a held preview says why in the sheet and the toast, not "open a new chat"', async t => {
  const { h, root } = await archivedBoard(t, { mobile: true, platform: 'ios', width: 390, locale: 'ko', dispatchLead: null, dispatchHeld: 'settings' });
  const idea = () => h.base.cards.find(c => c.title === 'Loose idea');
  await act(async () => labelled(root, 'Loose idea').props.onLongPress());
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet')[0].props['aria-label'], '지금은 보내지 않습니다');
  assert.equal(textOf(nativeNode(root, 'dispatch-when')), h.load('client/i18n.ts').copy('ko').dispatchHeld('settings'));
  assert.doesNotMatch(textOf(nativeNode(root, 'dispatch-when')), /새 채팅을 먼저/);
  await act(async () => sheetButton(root, 'dispatch-send').props.onPress());
  await settle();
  assert.equal(idea().dispatch.state, 'pending');
  assert.deepEqual(dispatchWrites(h).at(-1).input.operations.map(o => o.targetAgentId), [undefined], 'nobody confirmed: no agent named');
  assert.equal(textOf(nativeNode(root, 'move-toast')), '전송 보류 — 설정 확인');
});
test('253-D2 the agent changed while the sheet was open: after the conflict it shows the new one and waits for Send again', async t => {
  const { h, root } = await archivedBoard(t, { locale: 'en', dispatchLocale: 'en' });
  const idea = () => h.base.cards.find(c => c.title === 'Loose idea');
  await openIdeaMenu(root);
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  await settle();
  assert.match(textOf(nativeNode(root, 'dispatch-message')), new RegExp('--agent ' + AGENT_B));
  const before = dispatchWrites(h).length;
  h.outcome('conflict'); h.dispatchTo({ agentId: AGENT_A, title: '총괄-08_Sample-App_Fable' });
  await act(async () => sheetButton(root, 'dispatch-send').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet').length, 1, 'still open');
  assert.equal(textOf(nativeNode(root, 'dispatch-target-changed')), 'The agent to send to has changed — check the new one above and press Send again.');
  assert.match(textOf(nativeNode(root, 'dispatch-message')), new RegExp('--agent ' + AGENT_A), 'the words name the new agent');
  assert.equal(hosts(root, 'dispatch-sheet')[0].props['aria-label'], 'Send to 총괄-08?');
  assert.equal(dispatchWrites(h).length, before + 1, 'the refused write only');
  assert.equal(idea().intent, 'draft');
  await act(async () => sheetButton(root, 'dispatch-send').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet').length, 0);
  assert.equal(dispatchWrites(h).at(-1).input.operations[0].targetAgentId, AGENT_A);
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Waiting to send to 총괄-08/);
});
test('v0.1.46-B no lead by name: the sheet names the latest agent, says so, and shows the English words with its id', async t => {
  const { h, root } = await archivedBoard(t, { mobile: true, platform: 'ios', width: 390, locale: 'en', dispatchLocale: 'en',
    dispatchLead: { agentId: AGENT_B, title: 'Sample chat', fallback: true } });
  const idea = () => h.base.cards.find(c => c.title === 'Loose idea');
  await act(async () => labelled(root, 'Loose idea').props.onLongPress());
  await act(async () => sheetButton(root, 'move-to-doing').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet')[0].props['aria-label'], 'Send to Sample chat?');
  assert.match(textOf(nativeNode(root, 'dispatch-when')), /^Sent to the latest agent — Sample chat, the newest chat in this workspace/);
  assert.equal(textOf(nativeNode(root, 'dispatch-message')), ['[Kanban request] Loose idea', `Card: ${idea().id} · Board: Example Workspace`,
    'Done when: Loose idea', 'To do: please handle the request above. When the done-when line is met, reply with a short note on what you did.',
    `(If you have the kanban CLI, keep this card as yours: kanban card link ${idea().id} --agent ${AGENT_B} — no CLI? skip this line)`].join('\n'));
  await act(async () => sheetButton(root, 'dispatch-send').props.onPress());
  await settle();
  assert.equal(idea().dispatch.state, 'pending');
  assert.match(textOf(nativeNode(root, 'move-toast')), /^Waiting to send to the latest agent, Sample chat/);
});
test('REQ-97 the detail\'s stage flow asks the same way and shows the request\'s line; a requested card moves at once as before', async t => {
  const d = await detail(t);
  d.h.addCard({ ...add('Idea'), intent: 'draft', acceptanceCriteria: 'Own criteria' });
  const { Detail } = d.h.load('client/detail.tsx');
  const root = await render(t, Detail, { ...d.h.props, boardId: d.h.base.id, cardId: d.h.base.cards[1].id, locale: 'en', onClose() {} });
  await act(async () => sheetButton(root, 'stage-bar-doing').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet').length, 1);
  assert.equal(root.root.findAllByType('TextInput').filter(n => n.props.testID === 'dispatch-criteria').length, 0, 'criteria already there: no field');
  assert.match(textOf(nativeNode(root, 'dispatch-message')), /완료 기준: Own criteria/);
  await act(async () => sheetButton(root, 'dispatch-send').props.onPress());
  await settle();
  assert.deepEqual(d.h.calls.filter(c => c.name === 'kanban.v1.board.mutate').at(-1).input.operations, [{ op: 'dispatch', id: d.h.base.cards[1].id, to: 'doing', targetAgentId: AGENT_B }]);
  assert.equal(textOf(nativeNode(root, 'detail-dispatch')), 'Request to an agent · Waiting to send ⏳');
  assert.match(textOf(nativeNode(root, 'move-toast')), /Waiting to send to 총괄-07/);
  // Requested now: the flow moves it at once, no sheet.
  await act(async () => sheetButton(root, 'stage-bar-review').props.onPress());
  await settle();
  assert.equal(hosts(root, 'dispatch-sheet').length, 0);
  assert.equal(d.h.base.cards[1].stageId, 'review');
});

// ---- REQ-86 (research/128 ④C·⑤W2): the time a card has sat in its column, and an orange ⚠ past the limit ----
/**
 * Pinned at 21:50 KST (`PINNED`). In review: 14h (past 12h) and half an hour. In progress (three, the column's preview): 3h
 * with no agent; 5h with its agent at work; 5h with its agent asking for a permission. Waiting: 20h. Done: 20h. The example
 * card waits for you in "To Do".
 */
const ASKER = '55555555-5555-4555-8555-555555555551';
async function dwellBoard(t, options = {}) {
  pinClock(t, PINNED);
  const h = harness({ width: 1400, agents: [{ id: AGENT_A, status: 'running' }, { id: ASKER, status: 'idle', pendingPermissions: [{ requestId: 'p1' }] }],
    ...options });
  const at = hours => new Date(Date.now() - hours * 3600_000).toISOString();
  // Oldest first: the ledger's clock never runs back.
  for (const [title, stageId, hours, agentId] of [['Old waiting', 'todo', 20], ['Old done', 'done', 20], ['Long review', 'review', 14],
    ['Busy doing', 'doing', 5, AGENT_A], ['Asking doing', 'doing', 5, ASKER], ['Quiet doing', 'doing', 3], ['Fresh review', 'review', .5]]) {
    h.addCard({ ...add(title), stageId }, at(hours));
    if (agentId) h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId, role: 'worker' }, at(hours));
  }
  // A later change of the long one: its age would say "5m ago", its time in the column stays 14h.
  h.addCard({ op: 'update', id: h.base.cards.find(c => c.title === 'Long review').id, patch: { notes: 'Looked at' } }, at(5 / 60));
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  return { h, root };
}
const dwellOf = (root, title) => [...inCard(root, title, 'card-dwell'), ...inCard(root, title, 'card-dwell-warn')][0];
test('REQ-86 line two\'s right: a clock and the time in progress and review from an hour on; orange ⚠ past the limit; the card as tall', async t => {
  const { h, root } = await dwellBoard(t), c = palette(h.props.theme);
  const warnColor = readable(c.statusWarning, c.card), mute = readable(c.foregroundMuted, c.card);
  const look = title => { const node = dwellOf(root, title); return node && { id: node.props.testID, text: allText(node),
    icon: node.findAllByType('Icon')[0].props.name, color: flatStyle(node.findAllByType('Text')[0].props.style).color }; };
  assert.deepEqual(look('Long review'), { id: 'card-dwell-warn', text: '14h', icon: 'TriangleAlert', color: warnColor }, 'review past 12h');
  assert.deepEqual(look('Quiet doing'), { id: 'card-dwell-warn', text: '3h', icon: 'TriangleAlert', color: warnColor }, 'no agent for 3h');
  assert.deepEqual(look('Busy doing'), { id: 'card-dwell', text: '5h', icon: 'Clock', color: mute }, 'its agent at work: no warning');
  assert.deepEqual(look('Asking doing'), { id: 'card-dwell', text: '5h', icon: 'Clock', color: mute }, 'a permission wait: already "Response needed"');
  assert.equal(inCard(root, 'Asking doing', 'card-reply').length + inCard(root, 'Asking doing', 'card-reply-text').length, 1);
  for (const title of ['Fresh review', 'Old waiting', 'Old done']) assert.equal(dwellOf(root, title), undefined, title + ': none');
  assert.equal(allText(inCard(root, 'Fresh review', 'card-age')[0]), '30m ago', 'under an hour the age stays');
  assert.equal(inCard(root, 'Long review', 'card-age').length, 0, 'the time takes the age\'s place');
  // 4.5:1 on the card, like "Response needed"'s words; bold, the mark in the same orange.
  assert.ok(contrast(warnColor, c.card) >= 4.5);
  assert.equal(flatStyle(dwellOf(root, 'Long review').findAllByType('Text')[0].props.style).fontWeight, '600');
  assert.equal(dwellOf(root, 'Long review').findAllByType('Icon')[0].props.color, warnColor);
  // The last thing on line two, never giving way; the card no taller than one without it.
  const row = lineTwo(root, 'Long review');
  assert.ok(dwellOf(root, 'Long review').parent === row, 'on the row with the assignee');
  const kids = row.findAll(n => typeof n.type === 'string' && n.parent === row);
  assert.equal(kids.at(-1).props.testID, 'card-dwell-warn', 'at the right end');
  assert.equal(flatStyle(dwellOf(root, 'Long review').props.style).flexShrink, 0);
  const height = title => flatStyle(labelled(root, title).props.style).height;
  assert.equal(height('Long review'), height('Fresh review'));
  assert.equal(height('Quiet doing'), height('Old waiting'));
  assert.equal(height('Busy doing'), height('Old waiting'));
  // Its words say it all to a screen reader.
  assert.match(dwellOf(root, 'Long review').props.accessibilityLabel, /^In this stage for 14h · Entered this stage \d{2}-\d{2} \d{2}:\d{2} · Waiting in review over 12h · Updated 5m ago$/);
  // Not "needs attention": the count is the example card's alone, as before.
  assert.match(text(root), /Needs attention 1/);
  assert.equal(writes(h).length, 0);
});
test('REQ-86 under the mouse: when it came in, why it warns, and the last change; the detail says when it came in', async t => {
  const { h, root } = await dwellBoard(t);
  const { localStamp } = h.load('client/move-reason.ts');
  const card = h.base.cards.find(c => c.title === 'Long review');
  const entered = h.base.history.filter(r => r.cardId === card.id).at(-1).at;
  const inside = id => cardArea(root, 'Long review').findAll(n => n.props?.testID === id && typeof n.type === 'string');
  await act(async () => dwellOf(root, 'Long review').props.onPointerEnter());
  assert.equal(allText(inside('card-hint-dwell')[0]), 'Entered this stage ' + localStamp(entered, Date.now()) + '\nWaiting in review over 12h\nUpdated 5m ago');
  assert.notEqual(flatStyle(inside('card-hint-dwell')[0].props.style).right, undefined,
    'held to the card\'s right, under the time');
  await act(async () => dwellOf(root, 'Long review').props.onPointerLeave());
  assert.equal(inside('card-hint-dwell').length, 0);
  await act(async () => dwellOf(root, 'Quiet doing').props.onPointerEnter());
  assert.match(allText(cardArea(root, 'Quiet doing').findAll(n => n.props?.testID === 'card-hint-dwell' && typeof n.type === 'string')[0]),
    /\nNo linked agent working for over 2h\n/);
  await act(async () => dwellOf(root, 'Quiet doing').props.onPointerLeave());
  // The detail: "Entered this stage · MM-DD HH:MM" with the other moments.
  await act(async () => labelled(root, 'Long review').props.onPress());
  await settle();
  assert.equal(detailMeta(root, 'Entered this stage'), localStamp(entered, Date.now()));
  assert.equal(detailMeta(root, 'Updated'), localStamp(card.updatedAt, Date.now()), 'its last change is another line');
});
test('REQ-86 the detail marks an entry the records no longer hold "(estimated)"; a phone shows the same time', async t => {
  pinClock(t, PINNED);
  const h = harness({ width: 1400 });
  const { Detail } = h.load('client/detail.tsx'), { localStamp } = h.load('client/move-reason.ts');
  // The card's record is gone (1000 a board): the server stands its last change in.
  h.addCard({ ...add('Cut record'), stageId: 'review' }, new Date(Date.now() - 20 * 3600_000).toISOString());
  const cut = h.base.cards.at(-1);
  h.base.history.splice(0, h.base.history.length, ...h.base.history.filter(r => r.cardId !== cut.id));
  const root = await render(t, Detail, { ...h.props, boardId: h.base.id, cardId: cut.id, locale: 'en', onClose: () => {} });
  await settle();
  assert.equal(detailMeta(root, 'Entered this stage'), localStamp(cut.updatedAt, Date.now()) + ' (estimated)');
  const phone = await dwellBoard(t, { mobile: true, width: 390 });
  await act(async () => phone.root.root.findByProps({ testID: 'mobile-tab-review' }).props.onPress());
  assert.equal(allText(dwellOf(phone.root, 'Long review')), '14h');
  assert.equal(dwellOf(phone.root, 'Long review').props.testID, 'card-dwell-warn');
  await act(async () => phone.root.root.findByProps({ testID: 'mobile-tab-doing' }).props.onPress());
  assert.equal(dwellOf(phone.root, 'Quiet doing').props.testID, 'card-dwell-warn');
  assert.equal(dwellOf(phone.root, 'Busy doing').props.testID, 'card-dwell');
});

test('174 D2: the swimlanes\' overdue key follows the minute clock and re-renders only when it changes', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-09-28T04:00:00.000Z') });
  const h = harness({ width: 1400 });
  const { useMinuteKey } = h.load('client/minute-clock.ts');
  const { overdueKey } = h.load('client/swimlane-model.ts');
  const since = new Date(Date.now() - 2 * 3600_000 + 30_000).toISOString();
  const boards = [{ stages: [{ cards: [{ id: 'card_a', busy: { text: 'Testing', since, by: 'cli' } }] }] }];
  const seen = [];
  function Probe({ active }) { seen.push(useMinuteKey(now => overdueKey(boards, now), active)); return null; }
  const root = await render(t, Probe, { active: true });
  assert.deepEqual(seen, [''], '1h59m30s: not over yet');
  await act(async () => { t.mock.timers.tick(60_000); });
  assert.deepEqual(seen, ['', 'card_a'], 'over two hours on the next minute: the model is rebuilt (count and filter)');
  await act(async () => { t.mock.timers.tick(60_000); t.mock.timers.tick(60_000); });
  assert.equal(seen.length, 2, 'the same key: no re-render every minute');
  await act(async () => root.update(React.createElement(Probe, { active: false })));
  const after = seen.length;
  await act(async () => { t.mock.timers.tick(180_000); });
  assert.equal(seen.length, after, 'no marks: no clock');
});

test('174 J3: "by" in the card\'s hint and the detail names the agent by its title, asks for one not yet named', async t => {
  const h = harness({ width: 1400 });
  const { useBusyBy } = h.load('client/agent-signals.ts');
  const listeners = new Set(), names = {}, asked = [];
  const source = { read: () => 'unknown', ready: () => true, subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    model: id => names[id], request: ids => asked.push(...ids) };
  const seen = [];
  function Probe({ by }) { seen.push(useBusyBy(source, by)); return null; }
  const root = await render(t, Probe, { by: AGENT_A });
  assert.equal(seen.at(-1), AGENT_A.slice(0, 8), 'not named yet: the id\'s first 8 characters, never the whole id');
  assert.deepEqual(asked, [AGENT_A], 'the agent is asked for');
  names[AGENT_A] = { provider: null, model: null, thinkingOptionId: null, title: 'Lead-07', profile: null };
  await act(async () => { for (const l of listeners) l(); });
  assert.equal(seen.at(-1), 'Lead-07', 'named: its title');
  await act(async () => root.update(React.createElement(Probe, { by: 'cli' })));
  assert.equal(seen.at(-1), 'cli');
  await act(async () => root.update(React.createElement(Probe, { by: 'reviewer' })));
  assert.equal(seen.at(-1), 'reviewer');
  await act(async () => root.update(React.createElement(Probe, { by: undefined })));
  assert.equal(seen.at(-1), '');
  assert.deepEqual(asked, [AGENT_A], 'a name is never looked up');
});

// ---- REQ-90: the lab (settings.labs), shown only behind the developer key, and its "messages waiting" badge ---------------
// The base board's folder is /tmp/example-workspace, so its short name is "example-workspace"; the rest are made up.
const MAIL_DIR = '/data/example-mail';
const MAILBOX = { key: 'k1', threads: [
  { thread: '20260928-0900_wsB_one', file: MAIL_DIR + '/20260928-0900_wsB_one/20260928-0910_wsB_회신.md', to: 'example-workspace' },
  { thread: '20260928-0901_wsB_two', file: MAIL_DIR + '/20260928-0901_wsB_two/20260928-0901_wsB_요청.md', to: 'example-workspace' },
  { thread: '20260928-0902_wsB_person', file: MAIL_DIR + '/20260928-0902_wsB_person/20260928-0902_wsB_요청.md', to: '사람 (기록: example-workspace)' },
  { thread: '20260928-0903_wsA_other', file: MAIL_DIR + '/20260928-0903_wsA_other/20260928-0903_wsA_요청.md', to: 'wsB' }],
  unknown: [{ thread: '20260928-0904_wsB_odd', file: MAIL_DIR + '/20260928-0904_wsB_odd/20260928-0904_wsB_요청.md' }] };
const LAB_ON = { labs: { mail: true, mailDir: MAIL_DIR } };
test('REQ-90 ① the lab: hidden without the developer key, shown with it; its note, every feature off, nothing written', async t => {
  for (const mobile of [false, true]) {
    const h = harness(mobile ? { mobile: true } : { width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
    const root = await render(t, OverviewScreen, h.props);
    await openSettings(root);
    assert.equal(hosts(root, 'settings-tab-labs').length + hosts(root, 'settings-open-labs').length, 0, 'no key: no lab');
    await act(async () => sheetButton(root, 'settings-close').props.onPress());
    devDemo();
    await openSettings(root, 'labs');
    assert.equal(hosts(root, 'settings-category-labs').length, 1, mobile ? 'phone' : 'wide');
    assert.equal(sheetButton(root, 'labs-note').props.children, 'Beta · developer devices only. Trial features, each off until switched on.');
    assert.equal(sheetButton(root, 'labs-mail-toggle').props.accessibilityState.checked, false, 'off by default');
    assert.equal(sheetButton(root, 'labs-mail-dir').props.value, '', 'no folder by default');
    assert.equal(sheetButton(root, 'labs-alias-compact').props.accessibilityState.checked, true, 'the compact short-name rule');
    assert.equal(hosts(root, 'lane-mail-badge').length, 0);
    assert.equal(h.ui.writes.length, 0, 'opening the lab writes nothing');
    assert.ok(h.calls.filter(c => c.name === 'kanban.v1.overview.get').every(c => !('mail' in c.input)));
  }
  const { copy } = harness().load('client/i18n.ts');
  assert.equal(copy('ko').settingsLabs, '실험실');
  assert.match(copy('ko').labsNote, /^베타 · 개발 기기 전용/);
  assert.equal(copy('ko').mailBadge(2), '교신 2');
});
test('REQ-90 ② the lab\'s rows save the whole lab, and turning the badge on reads it at once', async t => {
  devDemo();
  const h = harness({ width: 1400, mailbox: MAILBOX }); devDemo();
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const reads = () => h.calls.filter(c => c.name === 'kanban.v1.overview.get').length;
  await openSettings(root, 'labs');
  const before = reads();
  await act(async () => sheetButton(root, 'labs-mail-toggle').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1), { hostId: 'host_example', settings: { labs: { mail: true } } });
  assert.equal(reads(), before + 1, 'saved: the swimlane reads again');
  assert.equal(hosts(root, 'lane-mail-badge').length, 0, 'no folder yet: nothing to show');
  // The folder: typed, then saved with its button — not on every key.
  await act(async () => sheetButton(root, 'labs-mail-dir').props.onChangeText('  ' + MAIL_DIR + ' '));
  assert.equal(h.ui.writes.length, 1, 'typing writes nothing');
  await act(async () => sheetButton(root, 'labs-mail-dir-save').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).settings, { labs: { mail: true, mailDir: MAIL_DIR } });
  assert.equal(sheetButton(root, 'labs-mail-status').props.children, '4 open threads read · unknown format 1');
  await act(async () => sheetButton(root, 'settings-close').props.onPress());
  assert.equal(sheetButton(root, 'lane-mail-badge').props.accessibilityLabel, 'Messages 2: 20260928-0900_wsB_one, 20260928-0901_wsB_two');
  // The rule: the whole lab again, with the other rule.
  await openSettings(root, 'labs');
  await act(async () => sheetButton(root, 'labs-alias-folder').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).settings, { labs: { mail: true, mailDir: MAIL_DIR, mailAlias: 'folder' } });
  // Off: the badge goes at once, without a read.
  await act(async () => sheetButton(root, 'labs-mail-toggle').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).settings, { labs: { mail: false, mailDir: MAIL_DIR, mailAlias: 'folder' } });
  assert.equal(hosts(root, 'lane-mail-badge').length, 0);
});
test('REQ-90 ③ the badge: this lane\'s open threads only, the tip lists them and their newest files and the unknown ones', async t => {
  const h = harness({ width: 1400, mailbox: MAILBOX, uiSettings: LAB_ON, empty: ['wsB'] });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const badges = hosts(root, 'lane-mail-badge');
  assert.equal(badges.length, 2, 'the example lane and wsB\'s — without the developer key too');
  assert.equal(badges[0].props.accessibilityLabel, 'Messages 2: 20260928-0900_wsB_one, 20260928-0901_wsB_two',
    'the person\'s turn "사람 (기록: …)" is not the workspace\'s');
  assert.match(text(root), /Messages 2/); assert.match(text(root), /Messages 1/);
  assert.deepEqual(hosts(root, 'lane-mail-badge-text').map(textOf), ['Messages 2', 'Messages 1'], 'the wide board keeps the words (research/179 J3)');
  assert.equal(hosts(root, 'lane-mail-tip').length, 0);
  await act(async () => badges[0].props.onHoverIn());
  const tip = JSON.stringify(nativeNode(root, 'lane-mail-tip'));
  for (const part of ['2 waiting for example-workspace', '· 20260928-0900_wsB_one', MAIL_DIR + '/20260928-0900_wsB_one/20260928-0910_wsB_회신.md',
    '· 20260928-0901_wsB_two', 'Unknown format 1']) assert.ok(tip.includes(part), part);
  assert.ok(!tip.includes('wsB_person'), 'not the relayed one');
  await act(async () => badges[0].props.onHoverOut());
  assert.equal(hosts(root, 'lane-mail-tip').length, 0);
  // The badge reads; it never writes or opens anything.
  assert.equal(h.ui.writes.length, 0);
  assert.ok(h.calls.every(c => !/mutate|ensure|ui\.set/.test(c.name)));
});
test('REQ-90 ③ on a phone: the badge in the workspace heading, a long press shows its threads', async t => {
  const h = harness({ mobile: true, mailbox: MAILBOX, uiSettings: LAB_ON }); h.addCard({ ...add('In flight'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const badge = sheetButton(root, 'lane-mail-badge');
  assert.ok(badge, 'shown in the heading');
  assert.equal(badge.props.accessibilityLabel.split(':')[0], 'Messages 2');
  // research/179 J3: the envelope and the number only on a phone ("Messages 2" is what a screen reader hears), at the
  // heading's right end by the controls, after the counts — never between the name and its count.
  assert.equal(textOf(nativeNode(root, 'lane-mail-badge-text')), '2');
  const heading = hosts(root, 'mobile-workspace-heading')[0].children.filter(n => typeof n.type !== 'string' || n.props.testID);
  const order = heading.map(n => n.props.testID ?? (n.props.mail !== undefined ? 'mail' : n.type?.name ?? String(n.type)));
  assert.ok(order.indexOf('mail') > order.indexOf('LaneName') && order.indexOf('mail') === order.indexOf('mobile-heading-controls') - 1, JSON.stringify(order));
  // research/179 D1: while the tip shows, its section (and nothing else) lifts over the next one; a second press puts it back.
  const z = node => flatStyle(node.props.style).zIndex ?? 0, sections = () => root.root.findAll(n => typeof n.type === 'string' && /^mobile-workspace-board_/.test(n.props.testID ?? ''));
  assert.deepEqual(sections().map(z), sections().map(() => 0), 'nothing lifted before a press');
  // REQ-134 MA: with the message list there a tap opens it (tests/req134 …); the tip is the long press's.
  await act(async () => badge.props.onLongPress());
  assert.match(JSON.stringify(nativeNode(root, 'lane-mail-tip')), /20260928-0900_wsB_one/);
  const lifted = sections().map(z);
  assert.equal(lifted.filter(Boolean).length, 1, JSON.stringify(lifted));
  assert.ok(sections()[lifted.indexOf(1)].findAll(n => n.props.testID === 'lane-mail-tip').length > 0, 'the section holding the tip');
  await act(async () => sheetButton(root, 'lane-mail-badge').props.onLongPress());
  assert.equal(hosts(root, 'lane-mail-tip').length, 0, 'a second press closes it');
  assert.deepEqual(sections().map(z), sections().map(() => 0), 'all back once the tip goes');
});
test('research/179 D1 on a phone grouped by project: the tip lifts its project over the next one too', async t => {
  const h = harness({ mobile: true, mailbox: MAILBOX, uiSettings: { ...LAB_ON, groupByProject: true }, empty: ['wks_empty01'], emptyProject: 'prj_second' });
  h.addCard({ ...add('In flight'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const z = node => flatStyle(node.props.style).zIndex ?? 0, groups = () => hosts(root, 'mobile-project-group');
  assert.ok(groups().length >= 1);
  await act(async () => sheetButton(root, 'lane-mail-badge').props.onLongPress());
  const lifted = groups().map(z);
  assert.equal(lifted.filter(Boolean).length, 1, JSON.stringify(lifted));
  assert.ok(groups()[lifted.indexOf(1)].findAll(n => n.props.testID === 'lane-mail-tip').length > 0);
  await act(async () => sheetButton(root, 'lane-mail-badge').props.onLongPress());
  assert.deepEqual(groups().map(z), groups().map(() => 0));
});
test('REQ-90 ④ auto refresh: looks carry the host only while the badge is on, and a new fingerprint reads once', async t => {
  const h = harness({ width: 1400, mailbox: MAILBOX, uiSettings: LAB_ON }); fastRefresh(h, { intervalMs: 25, idleMs: 60_000, minGapMs: 0 });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  await act(async () => { await pause(40); });
  const reads = countOf(h, 'kanban.v1.overview.get');
  await act(async () => { await pause(120); });
  const looks = h.calls.filter(c => c.name === 'kanban.v1.revisions.get');
  assert.ok(looks.length >= 3);
  assert.deepEqual(looks[0].input, { groups: true, hostId: 'host_example' });
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads, 'the same fingerprint reads nothing again');
  // A reply lands in the folder: one re-read, and the badge follows.
  h.setMail({ ...MAILBOX, key: 'k2', threads: MAILBOX.threads.slice(1) });
  await act(async () => { await pause(90); });
  assert.equal(countOf(h, 'kanban.v1.overview.get'), reads + 1, 'one re-read for one change');
  assert.equal(sheetButton(root, 'lane-mail-badge').props.accessibilityLabel, 'Messages 1: 20260928-0901_wsB_two');
  // Off (saved elsewhere, then read): the looks stop saying the host.
  h.setMail({ ...MAILBOX, key: 'k3', threads: [] });
  await act(async () => { await pause(90); });
  assert.equal(hosts(root, 'lane-mail-badge').length, 0, 'nothing waiting: no badge');
  assert.equal(writes(h).length, 0, 'looking never writes');
  const off = harness({ width: 1400, mailbox: MAILBOX }); fastRefresh(off, { intervalMs: 25, idleMs: 60_000, minGapMs: 0 });
  await render(t, off.load('client/overview.tsx').OverviewScreen, off.props);
  await act(async () => { await pause(90); });
  assert.ok(off.calls.filter(c => c.name === 'kanban.v1.revisions.get').every(c => !('hostId' in c.input)), 'the lab off: no host, no folder');
});
// ---- REQ-110~116 (the owner's screenshots, 2026-09-28): the lane's tip and ⋯, the detail's warning, To Do "+", the filter
// glyph, "Collapse" part way, a lead card as tall as what it holds ----
test('REQ-110 the workspace name\'s tip says only "Open board" ("보드로 이동"), and its link starts with the same words', async t => {
  for (const [locale, words] of [['en', 'Open board'], ['ko', '보드로 이동']]) {
    const h = harness({ width: 1400, platform: 'web', locale });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    const link = hosts(root, 'workspace-name-link').find(n => n.props.onHoverIn);
    assert.ok(link.props.accessibilityLabel.startsWith(words + ': Example Workspace'), link.props.accessibilityLabel);
    await act(async () => link.props.onHoverIn());
    assert.equal(allText(hosts(root, 'lane-name-tooltip')[0]), words, locale + ': the words alone, no folder or branch');
    await act(async () => link.props.onHoverOut());
  }
});
test('REQ-111 a lane\'s ⋯ opens a small menu right under it on a wide web screen, the same items; a phone keeps the sheet', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => hosts(root, 'lane-order-menu')[0].props.onPress());
  const menu = hosts(root, 'order-popover')[0];
  assert.ok(menu, 'the popover');
  assert.equal(menu.props.accessibilityRole, 'menu');
  assert.equal(hosts(root, 'menu-sheet').length, 0, 'no sheet from the bottom');
  assert.deepEqual(menu.findAll(n => typeof n.type === 'string' && n.props.accessibilityRole === 'menuitem').map(n => n.props.testID),
    // REQ-52: a workspace's archived cards, right under "Open in board".
    ['order-open-board', 'order-archived', 'order-move-top', 'order-move-up', 'order-move-down']);
  assert.deepEqual(['top', 'up', 'down'].map(d => hosts(root, 'order-move-' + d)[0].props.accessibilityState.disabled), [true, true, true], 'one lane: nowhere to go');
  await act(async () => hosts(root, 'order-popover-dismiss')[0].props.onPress());
  assert.equal(root.root.findByProps({ testID: 'order-popover-modal' }).props.visible, false, 'a press outside closes it');
  await act(async () => hosts(root, 'lane-order-menu')[0].props.onPress());
  await act(async () => hosts(root, 'order-open-board')[0].props.onPress());
  assert.equal(root.root.findAllByProps({ testID: 'workspace-board' }).length, 1, '"Open in board" still opens it');
  const phone = harness({ mobile: true });
  const small = await render(t, phone.load('client/overview.tsx').OverviewScreen, phone.props);
  await act(async () => small.root.findByProps({ testID: 'mobile-tab-todo' }).props.onPress());
  await act(async () => hosts(small, 'lane-order-menu')[0].props.onPress());
  assert.equal(hosts(small, 'order-popover').length, 0, 'no popover on a phone');
  assert.ok(hosts(small, 'order-move-top')[0], 'the sheet\'s items');
});
test('REQ-112 the detail says why the time in the column warns, right under "Entered this stage"; nothing where it does not', async t => {
  const { root } = await dwellBoard(t);
  const reason = async title => {
    await act(async () => labelled(root, title).props.onPress());
    await settle();
    const meta = hosts(root, 'detail-meta')[0], warn = hosts(root, 'detail-dwell-warn')[0];
    const lines = meta.children.map(n => n.props?.testID === 'detail-dwell-warn' ? 'warn' : allText(n).split(' · ')[0]);
    const words = warn ? allText(hosts(root, 'detail-dwell-warn-text')[0]) : null;
    await act(async () => root.root.findAllByType('NativeModal').at(-1).props.onRequestClose());
    await settle();
    return { words, after: warn ? lines[lines.indexOf('warn') - 1] : null };
  };
  assert.deepEqual(await reason('Long review'), { words: 'Waiting in review over 12h', after: 'Entered this stage' }, 'the hint\'s words');
  assert.deepEqual(await reason('Quiet doing'), { words: 'No linked agent working for over 2h', after: 'Entered this stage' });
  assert.deepEqual(await reason('Fresh review'), { words: null, after: null }, 'no warning: no line');
  assert.deepEqual(await reason('Busy doing'), { words: null, after: null }, 'its agent at work: no line');
});
test('REQ-113 the To Do heading\'s "+" drafts straight into that workspace: no workspace to pick, a title needed, criteria too', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const heading = hosts(root, 'lane-stage-headers')[0];
  const plus = heading.findAll(n => n.props?.testID === 'todo-create' && typeof n.type === 'string');
  assert.equal(plus.length, 1, 'on the To Do heading alone');
  assert.equal(plus[0].props.accessibilityLabel, 'New draft in To Do: Example Workspace');
  assert.ok(labelled(root, 'Create draft'), 'the tool row\'s + stays');
  await act(async () => plus[0].props.onPress());
  await settle();
  assert.equal(boardChoice(root, 'Example Workspace'), undefined, 'no workspace to choose');
  assert.match(text(root), /New draft in To Do: Example Workspace/);
  const save = () => button(root, 'Save draft');
  assert.equal(save().props.disabled, true, 'a title is needed');
  await act(async () => input(root, 'Title').props.onChangeText('Quick idea'));
  await act(async () => input(root, 'Acceptance criteria').props.onChangeText('- [ ] it works'));
  assert.equal(save().props.disabled, false);
  const before = h.calls.filter(c => c.name.endsWith('mutate')).length;
  await act(async () => save().props.onPress());
  await settle();
  const sent = h.calls.filter(c => c.name.endsWith('mutate')).slice(before);
  assert.deepEqual(sent.map(c => c.input.operations.map(o => o.op)), [['add'], ['update']], 'the add, then the criteria with an ordinary update');
  assert.equal(sent[0].input.boardId, h.base.id);
  const made = h.base.cards.find(c => c.title === 'Quick idea');
  assert.deepEqual([made.stageId, made.intent, made.acceptanceCriteria], ['todo', 'draft', '- [ ] it works'], 'a draft in To Do');
  assert.equal(hosts(root, 'create-criteria').length, 0, 'the sheet closed at once');
  assert.ok(labelled(root, 'Quick idea'), 'the card is in the column');
  // The tool row's + keeps its choice of workspace, and no criteria field.
  await act(async () => labelled(root, 'Create draft').props.onPress());
  await settle();
  assert.ok(boardChoice(root, 'Example Workspace'));
  assert.equal(hosts(root, 'create-criteria').length, 0);
});
test('research/187 J2 phone: no "+" on any workspace heading; the lane ⋯ sheet opens with "초안 만들기", a draft into To Do from any tab', async t => {
  const h = harness({ mobile: true, locale: 'ko' });
  h.addCard({ ...add('In flight'), stageId: 'doing' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  for (const tab of ['todo', 'doing']) {
    await act(async () => root.root.findByProps({ testID: 'mobile-tab-' + tab }).props.onPress());
    assert.equal(hosts(root, 'todo-create').length, 0, 'no "+" on the ' + tab + ' tab\'s heading');
  }
  // From the in-progress tab: the sheet's first item, then the lane's draft sheet — that workspace, criteria too.
  await act(async () => hosts(root, 'lane-order-menu')[0].props.onPress());
  const sheet = hosts(root, 'menu-sheet')[0];
  const items = sheet.findAll(n => typeof n.type === 'string' && /^order-/.test(n.props?.testID ?? '') && n.props.accessibilityRole === 'button')
    .map(n => n.props.testID);
  assert.deepEqual(items.slice(0, 2), ['order-draft', 'order-open-board'], 'first in the sheet');
  assert.equal(allText(hosts(root, 'order-draft')[0]), '초안 만들기');
  await act(async () => hosts(root, 'order-draft')[0].props.onPress());
  await settle();
  assert.equal(boardChoice(root, 'Example Workspace'), undefined, 'no workspace to choose');
  assert.match(text(root), /대기에 초안 만들기: Example Workspace/);
  assert.ok(hosts(root, 'create-criteria')[0]);
  await act(async () => input(root, '제목').props.onChangeText('Phone idea'));
  await act(async () => button(root, '초안 저장').props.onPress());
  await settle(); await settle();
  const made = h.base.cards.find(c => c.title === 'Phone idea');
  assert.deepEqual([made.stageId, made.intent], ['todo', 'draft'], 'in To Do though the sheet was opened on another tab');
  assert.equal(hosts(root, 'create-criteria').length, 0, 'the sheet closed');
  // research/187 J3 on a phone: the To Do tab is shown, the new card in it with the ring.
  assert.equal(labelled(root, 'In flight'), undefined, 'moved to the To Do tab');
  assert.equal(hosts(root, 'linked-card-' + made.id)[0].findAll(n => n.props?.testID === 'fresh-highlight' && typeof n.type === 'string').length, 1);
});
test('research/187 J2 wide: the To Do heading keeps its "+", and the lane ⋯ menu has no draft row', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  assert.equal(hosts(root, 'lane-stage-headers')[0].findAll(n => n.props?.testID === 'todo-create' && typeof n.type === 'string').length, 1);
  await act(async () => hosts(root, 'lane-order-menu')[0].props.onPress());
  assert.equal(hosts(root, 'order-draft').length, 0);
});
test('research/187 J3 wide: a draft made behind "+N" opens its column to show it, rings for two seconds; "Collapse" then wins', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  // Eight high-priority cards ahead of it: in the default order the normal draft is behind "+N".
  for (let i = 0; i < 8; i++) { h.addCard(add('Extra ' + i)); h.addCard({ op: 'update', id: h.base.cards.at(-1).id, patch: { priority: 'high' } }); }
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const shown = () => cardTitles(cell(root, 'todo'));
  assert.equal(shown().length, 3);
  await act(async () => hosts(root, 'todo-create')[0].props.onPress());
  await settle();
  await act(async () => input(root, 'Title').props.onChangeText('Quick idea'));
  await act(async () => button(root, 'Save draft').props.onPress());
  await settle(); await settle();
  const made = h.base.cards.find(c => c.title === 'Quick idea');
  const todo = h.base.cards.filter(c => c.stageId === 'todo').length;
  assert.ok(todo > 8, 'the new draft is behind the eight in the default order');
  assert.ok(shown().includes('Quick idea'), 'the draft shows');
  const opened = shown().length;
  assert.ok(opened === Math.min(todo, 3 + Math.ceil((todo - 3) / 5) * 5), 'five at a time, as far as it needs: ' + opened + ' of ' + todo);
  const ring = () => hosts(root, 'fresh-highlight');
  assert.equal(ring().length, 1, 'a ring on it');
  assert.ok(hosts(root, 'linked-card-' + made.id)[0].findAll(n => n.props?.testID === 'fresh-highlight').length > 0, 'on the new card');
  await act(async () => new Promise(resolve => setTimeout(resolve, 2100)));
  assert.equal(ring().length, 0, 'gone after two seconds');
  assert.ok(shown().includes('Quick idea'), 'the column stays open after the ring');
  // The person's fold wins: "Collapse" takes it back to three and nothing opens it again.
  await act(async () => cell(root, 'todo').findAll(n => n.props?.testID === 'cell-collapse' && typeof n.type === 'string')[0].props.onPress());
  await settle();
  assert.equal(shown().length, 3);
  assert.ok(!shown().includes('Quick idea'), 'behind "+N" again, as the person asked');
});
test('REQ-114 wide: the filters are one glyph with a count; its menu clears one at a time or all; none: no count, "Clear all" faded', async t => {
  const h = harness({ width: 1400, platform: 'web' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const glyph = () => hosts(root, 'filter-menu')[0];
  assert.equal(glyph().props.accessibilityLabel, 'Filters: 0 applied');
  assert.equal(hosts(root, 'filter-menu-badge').length, 0, 'no count');
  assert.equal(wordButtons(root, 'Clear all'), 0, 'no words in the row');
  assert.equal(hosts(root, 'active-filter-count').length, 0);
  assert.ok(hosts(root, 'filter-controls')[0].findAll(n => n.props?.testID === 'filter-menu').length > 0, 'beside "needs attention"');
  await act(async () => glyph().props.onPress());
  assert.ok(hosts(root, 'filter-menu-empty')[0]);
  assert.equal(hosts(root, 'filter-clear-all')[0].props.accessibilityState.disabled, true, 'nothing to clear');
  await act(async () => hosts(root, 'filter-menu-list-dismiss')[0].props.onPress());
  await act(async () => root.root.findByProps({ testID: 'attention-chip' }).props.onPress());
  await act(async () => input(root, 'Search cards').props.onChangeText('card'));
  assert.equal(glyph().props.accessibilityLabel, 'Filters: 2 applied');
  assert.equal(allText(hosts(root, 'filter-menu-badge')[0]), '2');
  assert.equal(glyph().props.accessibilityState.selected, true, 'on while filters apply');
  await act(async () => glyph().props.onPress());
  const rows = () => hosts(root, 'filter-menu-list')[0].findAll(n => typeof n.type === 'string' && /^filter-clear-/.test(n.props?.testID ?? ''))
    .map(n => [n.props.testID, n.props.accessibilityLabel]);
  assert.deepEqual(rows(), [['filter-clear-attention', 'Clear filter: Needs attention'], ['filter-clear-query', 'Clear filter: Search: card'],
    ['filter-clear-all', 'Clear all']]);
  await act(async () => hosts(root, 'filter-clear-query')[0].props.onPress());
  assert.equal(input(root, 'Search cards').props.value, '', 'that one alone');
  assert.equal(root.root.findByProps({ testID: 'attention-chip' }).props.accessibilityState.selected, true);
  assert.equal(glyph().props.accessibilityLabel, 'Filters: 1 applied');
  assert.deepEqual(rows().map(r => r[0]), ['filter-clear-attention', 'filter-clear-all'], 'the menu stays open on the rest');
  await act(async () => hosts(root, 'filter-clear-all')[0].props.onPress());
  assert.equal(root.root.findByProps({ testID: 'attention-chip' }).props.accessibilityState.selected, false);
  assert.equal(glyph().props.accessibilityLabel, 'Filters: 0 applied');
  assert.equal(root.root.findByProps({ testID: 'filter-menu-list-modal' }).props.visible, false, '"Clear all" closes it');
});
test('REQ-115 "Collapse" beside "+N" as soon as a column shows more than three; a person\'s fold wins over a highlight\'s', async t => {
  // Part way: to-do 8 of 13, done 8 of 12 (with "… in the board"): "Collapse" beside them, back to three.
  const w = harness({ width: 1400 });
  for (let i = 0; i < 12; i++) w.addCard(add('Extra ' + i));
  for (let i = 0; i < 12; i++) w.addCard({ ...add('Completed ' + i), stageId: 'done' });
  const board = await render(t, w.load('client/overview.tsx').OverviewScreen, w.props);
  const wide = (stageId, testID) => cell(board, stageId).findAll(n => n.props?.testID === testID && typeof n.type === 'string');
  const links = stageId => cell(board, stageId).findAll(n => typeof n.type === 'string'
    && ['cell-more', 'cell-rest-in-board', 'cell-collapse'].includes(n.props?.testID)).map(n => allText(n));
  assert.deepEqual([links('todo'), links('done')], [['+10'], ['+9']], 'three shown: no "Collapse"');
  for (const stageId of ['todo', 'done']) await act(async () => wide(stageId, 'cell-more')[0].props.onPress());
  assert.deepEqual([links('todo'), links('done')], [['+5', 'Collapse'], ['+4', '4 more in the board', 'Collapse']], 'part way: side by side');
  await act(async () => wide('todo', 'cell-collapse')[0].props.onPress());
  assert.deepEqual([cardTitles(cell(board, 'todo')).length, cardTitles(cell(board, 'done')).length], [3, 8], 'its own column, back to three');
  // A highlight opens both; the person folds the done column and opens it again; the highlight's end leaves that as it is.
  const click = pageClicks(t);
  const { root } = await leadStatusBoard(t, { prepare: hideFamily });
  const inCell = (stageId, testID) => cell(root, stageId).findAll(n => n.props?.testID === testID && typeof n.type === 'string')[0];
  const view = () => ['doing', 'done'].map(s => cardTitles(cell(root, s)).length);
  await act(async () => press(hosts(root, 'family-summary-all')[0]));
  assert.deepEqual(view(), [6, 7]);
  await act(async () => inCell('done', 'cell-collapse').props.onPress());
  await act(async () => inCell('done', 'cell-more').props.onPress());
  assert.deepEqual(view(), [6, 7]);
  await click(emptySpot);
  assert.deepEqual(view(), [3, 7], 'in progress folds back; the done column is the person\'s now');
});
test('REQ-116 a lead card is as tall as what it holds: its short title keeps no second line; a long one does, a plain card as before', async t => {
  const { root } = await leadStatusBoard(t);
  assert.equal(flatStyle(labelled(root, 'Lead card').props.style).height, 84 + 44 - 18);
  assert.equal(labelled(root, 'Lead card').findAll(n => n.props?.testID === 'card-title' && typeof n.type === 'string')[0].props.numberOfLines, 1);
  const plain = root.root.findAllByType('Pressable').find(p => /^kanban-card-/.test(p.props.testID ?? '') && !p.findAll(n => n.props?.testID === 'family-summary').length);
  assert.equal(flatStyle(plain.props.style).height % 2, 0);
  assert.ok([84, 104, 106, 126].includes(flatStyle(plain.props.style).height), 'a plain card keeps two title lines: ' + flatStyle(plain.props.style).height);
  const dot = hosts(root, 'family-summary-dot')[0];
  assert.equal(flatStyle(dot.props.style).marginHorizontal, 1, 'research/185: 3px each side of "·" (2px face + 1px)');
});

// ---- REQ-119: a lead by name with no sub-card yet is a lead's card from the start (tests/req119.test.mjs) ----
const NEW_LEAD = '총괄-08_Sample-App_Opus';
async function newLeadBoard(t, options = {}) {
  const h = harness({ agents: [{ id: AGENT_A, status: 'idle', title: NEW_LEAD, labels: { profile: '총괄_Opus-5.5' } },
    { id: AGENT_B, status: 'idle', title: 'Build it', labels: { profile: 'build_Opus' } }], ...options });
  for (const [index, [title, agentId]] of [['Older card', AGENT_B], [NEW_LEAD, AGENT_A]].entries()) {
    const at = '2026-01-01T02:0' + index + ':00.000Z';
    h.addCard({ ...add(title), stageId: 'doing' }, at);
    h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId, role: 'worker' }, at);
  }
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  return { h, root };
}
for (const [name, options] of [['wide', { width: 1400 }], ['390', { mobile: true }]]) {
  test('REQ-119 ' + name + ': a lead by name with no sub-card — crown, outline, first in its column, short title, status row, no "Sub-cards 0"', async t => {
    const { h, root } = await newLeadBoard(t, options);
    const cards = root.root.findAll(n => typeof n.type === 'string' && /^kanban-card-/.test(n.props?.testID ?? '')).map(n => n.props.accessibilityLabel);
    assert.deepEqual(cards.filter(v => v === NEW_LEAD || v === 'Older card'), [NEW_LEAD, 'Older card'], 'pinned over the older card');
    assert.equal(inCard(root, NEW_LEAD, 'card-leader').length, 1, 'the crown');
    assert.equal(hosts(root, 'card-leader').length, 1, 'on the lead alone');
    assert.equal(textOf(inCard(root, NEW_LEAD, 'card-title')[0]), '총괄-08', 'the short title');
    assert.equal(hosts(root, 'family-summary').length, 0, 'no "Sub-cards 0 · not done 0" with nothing to press');
    assert.equal(inCard(root, NEW_LEAD, 'lead-status').length, 1, 'its status row');
    assert.equal(flatStyle(labelled(root, NEW_LEAD).props.style).height, 84 + 22 - 18, 'one lead row (the status row), one title line');
    const c = palette(h.props.theme), edge = title => flatStyle(inCard(root, title, 'card-content')[0].props.style).borderColor;
    assert.equal(edge(NEW_LEAD), leaderOutline(c, c.card), 'the lead\'s grey outline (REQ-105)');
    assert.equal(edge('Older card'), c.border);
  });
}

// ---- REQ-120: a topic lead's two-tone medal (REQ-123 antique gold), 16px, in the crown's place (tests/req120.test.mjs). REQ-121: a petrol ribbon
// layer under it; REQ-122: the lead's crown two-toned, 16px (tests/req121-122.test.mjs) ----
for (const [name, options] of [['wide', {}], ['390', { mobile: true, width: 390 }]]) {
  test('REQ-120·121·122 ' + name + ': a topic lead wears the gold medal — ribbon, base, face: three PNGs in one 16px box, each tinted; the lead a 16px two-tone gold crown', async t => {
    for (const mode of ['light', 'dark']) {
      const h = subCardHarness({ ...options, theme: PASEO_THEMES[mode], agents: [{ id: AGENT_A, status: 'idle' },
        { id: SUB_ONE, status: 'running', labels: { role: '주제총괄', 'paseo.parent-agent-id': AGENT_A } },
        { id: SUB_TWO, status: 'idle', labels: { 'paseo.parent-agent-id': SUB_ONE } }, { id: SUB_DONE, status: 'idle', labels: { 'paseo.parent-agent-id': AGENT_A } }] });
      const props = { ...h.props, theme: PASEO_THEMES[mode] };
      const root = await render(t, h.load('client/overview.tsx').OverviewScreen, props), { LEADER_ICON, TOPIC_LEADER_ICON } = h.load('client/components.tsx');
      const c = palette(props.theme), { MEDAL_RIBBON_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG, CROWN_FILLED_PNG, CROWN_BEADS_PNG } = h.load('client/leader-icons.ts');
      assert.deepEqual([TOPIC_LEADER_ICON, LEADER_ICON], [16, 16]);
      // A phone shows one stage at a time: the topic lead is in progress, the lead in review.
      const tab = async id => { if (options.mobile) await act(async () => root.root.findByProps({ testID: 'mobile-tab-' + id }).props.onPress()); };
      await tab('doing');
      assert.equal(hosts(root, 'card-leader').length, options.mobile ? 1 : 2, mode + ': the lead and the topic lead');
      assert.equal(inCard(root, 'Worker one', 'card-leader')[0].props.accessibilityLabel, 'Topic lead card (under the lead)');
      const layers = () => { const box = inCard(root, 'Worker one', 'card-leader-medal')[0];
        return { box, images: box.findAll(n => typeof n.type === 'string' && n.props?.source).map(n => ({ id: n.props.testID, uri: n.props.source.uri, style: flatStyle(n.props.style) })) }; };
      let { box, images } = layers();
      assert.deepEqual([flatStyle(box.props.style).width, flatStyle(box.props.style).height], [16, 16], mode + ': a 16px box');
      assert.deepEqual(images.map(i => i.id), ['card-leader-ribbon', 'card-leader-filled', 'card-leader-light'], mode + ': the ribbon, the base over it, the face on top');
      assert.deepEqual(images.map(i => i.uri), [MEDAL_RIBBON_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG]);
      assert.deepEqual(images.map(i => [i.style.width, i.style.height]), [[16, 16], [16, 16], [16, 16]]);
      for (const i of images.slice(1)) assert.deepEqual([i.style.position, i.style.left, i.style.top], ['absolute', 0, 0], mode + ': laid on the same spot');
      const want = medalColors(c, c.card);
      assert.deepEqual(images.map(i => i.style.tintColor), [want.ribbon, want.base, want.light], mode + ': petrol, then the antique gold and champagne');
      assert.deepEqual([want.base, want.light], { light: ['#987a59', '#f1e7d2'], dark: ['#bba07f', '#f5eedc'] }[mode], mode + ': REQ-123 gold medal B');
      assert.equal(want.ribbon, { light: '#497b83', dark: '#82b5be' }[mode]);
      assert.ok(contrast(want.base, c.card) >= 3 && contrast(want.ribbon, c.card) >= 3);
      // The lead: the gold crown, 16px, its beads over it (REQ-122).
      await tab('review');
      const crown = inCard(root, 'Lead card', 'card-leader')[0].findAll(n => typeof n.type === 'string' && n.props?.source);
      assert.deepEqual(crown.map(n => [n.props.testID, n.props.source.uri, flatStyle(n.props.style).width, flatStyle(n.props.style).height, flatStyle(n.props.style).tintColor]),
        [['card-leader-filled', CROWN_FILLED_PNG, 16, 16, crownColor(c, c.card)], ['card-leader-beads', CROWN_BEADS_PNG, 16, 16, crownColors(c, c.card).beads]],
        mode + ': the gold crown and its beads');
      assert.equal(crownColor(c, c.card), { light: '#bb8e14', dark: '#F2C230' }[mode], mode + ': the gold as before');
      const beads = flatStyle(crown[1].props.style);
      assert.deepEqual([beads.position, beads.left, beads.top], ['absolute', 0, 0], mode + ': the beads on the same spot');
      assert.equal(flatStyle(inCard(root, 'Lead card', 'card-leader')[0].props.style).height, flatStyle(inCard(root, 'Lead card', 'card-title')[0].props.style).lineHeight,
        mode + ': the lead\'s title row keeps its line height');
      assert.equal(inCard(root, 'Lead card', 'card-leader-medal').length, 0);
      // The title row keeps its line height; the medal sits in it.
      await tab('doing');
      assert.equal(flatStyle(inCard(root, 'Worker one', 'card-leader')[0].props.style).height, flatStyle(inCard(root, 'Worker one', 'card-title')[0].props.style).lineHeight);
      // Archived: the same two layers, sunk.
      await act(async () => h.agents.upsert(SUB_ONE, { status: 'idle', archivedAt: '2026-09-29' }));
      ({ images } = layers());
      assert.deepEqual(images.map(i => i.style.tintColor), [c.crownSubRibbonArchived, c.crownSubArchived, c.crownSubArchivedLight], mode + ': archived');
      assert.deepEqual(medalColors(c, c.card, true), { ribbon: c.crownSubRibbonArchived, base: c.crownSubArchived, light: c.crownSubArchivedLight });
      assert.equal(c.crownSubRibbonArchived, { light: '#9cafb2', dark: '#5b6d70' }[mode]);
      assert.deepEqual([c.crownSubArchived, c.crownSubArchivedLight], { light: ['#b5a99b', '#e5e1d9'], dark: ['#71675b', '#8c8982'] }[mode], mode + ': REQ-123 archived');
      assert.equal(h.calls.filter(x => x.name === 'kanban.v1.board.mutate').length, 0);
    }
  });
}

// ---- REQ-124 2단위 (research/215·216·217): a lane's workflow, switched from its lane heading in place of REQ-103 2단계-1's
// big picture — only on a lane whose workspace holds a definition, never on 390px in this release. What the server reads is
// the real reader over the made-up workspaces of tests/fixtures/workflow-fixtures.mjs. ----
async function readFixture(t, definition, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-req124-pui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return readWorkflow(await writeWorkspace(dir, definition, files), { now: () => new Date('2026-03-03T07:00:00.000Z') });
}
const flowNodes = root => root.root.findAll(n => typeof n.type === 'string' && /^flow-node-/.test(n.props?.testID ?? '')).map(n => n.props.testID.slice(10));
test('REQ-124 wide: "Board | Workflow" on the lane with a definition shows the flow, the table and a cell\'s evidence in place of the columns, and writes nothing', async t => {
  const workflow = await readFixture(t, gateDefinition, gateFiles);
  const h = harness({ width: 1400, workflow });
  h.addCard({ ...add('Stuck work'), stageId: 'doing', blockedReason: 'Waiting on a key' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  const header = hosts(root, 'swimlane-lane-header')[0];
  const sw = header.findAll(n => n.props?.testID === 'lane-view-switch' && typeof n.type === 'string')[0];
  assert.ok(sw, 'the switch sits in the lane heading');
  assert.equal(sw.props.accessibilityLabel, 'Board or workflow: Example Workspace');
  assert.deepEqual([textOf(sheetButton(root, 'lane-view-board')), textOf(sheetButton(root, 'lane-view-workflow'))], ['Board', 'Workflow']);
  assert.equal(sheetButton(root, 'lane-view-board').props.accessibilityState.checked, true, 'the board first');
  assert.equal(hosts(root, 'lane-view-waiting').length + hosts(root, 'big-picture').length, 0, 'REQ-103 2단계-1\'s dot and big picture are gone');
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.workflow.get').length, 0, 'nothing read before it opens');
  await act(async () => sheetButton(root, 'lane-view-workflow').props.onPress());
  assert.equal(sheetButton(root, 'lane-view-workflow').props.accessibilityState.checked, true);
  assert.deepEqual(h.calls.filter(c => c.name === 'kanban.v1.workflow.get').map(c => c.input), [{ workspaceId: h.base.workspaceId }]);
  assert.equal(hosts(root, 'swimlane-cells').length + hosts(root, 'lane-stage-headers').length + hosts(root, 'lane-toggle').length, 0, 'the columns give way');
  assert.equal(flatStyle(sheetButton(root, 'workflow').props.style).width, SWIMLANE.columnWidth * 4 + SWIMLANE.columnGap * 3, 'the lane\'s width');
  assert.deepEqual(flowNodes(root).sort(), gateDefinition.stages.map(s => s.id).sort());
  assert.equal(textOf(sheetButton(root, 'workflow-name')), '합성 개발 절차(게이트 있음)');
  assert.equal(textOf(sheetButton(root, 'workflow-unknown')), 'Unknown format 1');
  assert.equal(sheetButton(root, 'workflow-release-0.2.6').props.accessibilityState.selected, true, 'the newest release first');
  assert.deepEqual(hosts(root, 'flow-note-gate').map(textOf), ['60 불통과 → 조건부']);
  assert.deepEqual(hosts(root, 'flow-note-commit').map(textOf), ['6666666', 'Commit title', 'unread'], 'laid in lines, not cut');
  assert.deepEqual(hosts(root, 'flow-note-tester').map(textOf), ['No record']);
  assert.deepEqual(hosts(root, 'flow-note-phone').map(textOf), ['Nothing to read', 'a person checks']);
  assert.equal(textOf(sheetButton(root, 'flow-loop-label')), '재게이트 ×1: 61→62');
  assert.deepEqual(sheetButton(root, 'flow-count-gate').findAll(n => n.type === 'Text').map(textOf), ['First 6 · Fail 3', 'Conditional 0 · Unknown format 1'], 'two even lines in the column');
  assert.equal(sheetButton(root, 'flow-edge-gate-pass').props.accessibilityState.selected, true, 'the way it went');
  assert.equal(sheetButton(root, 'flow-edge-stable-tester').props.accessibilityState.selected, false);
  // The table: six releases, the states told apart.
  const row = v => sheetButton(root, 'workflow-row-' + v), cellOf = (v, id) => row(v).findAll(n => n.props?.testID === 'workflow-cell-' + id && typeof n.type === 'string')[0];
  assert.equal(hosts(root, 'workflow-row-0.2.6').length, 1);
  assert.equal(root.root.findAll(n => typeof n.type === 'string' && /^workflow-row-0/.test(n.props?.testID ?? '')).length, 6);
  assert.equal(textOf(cellOf('0.2.6', 'tester')), 'No record');
  assert.equal(textOf(cellOf('0.2.2', 'gate')), 'Unknown format 40');
  assert.equal(textOf(cellOf('0.2.6', 'commit')), '6666666 · Commit title unread');
  assert.equal(cellOf('0.2.6', 'phone'), undefined, 'no column for a step with nothing to read');
  assert.equal(cellOf('0.2.6', 'tester').props.accessibilityLabel, '테스터 배포, 0.2.6: No record');
  // A cell's evidence: the verdict lines and where they are; "No record" says what it means.
  await act(async () => cellOf('0.2.6', 'gate').props.onPress());
  assert.deepEqual(hosts(root, 'workflow-evidence-place').map(textOf), ['docs/60_v0206_게이트검증.md:5 · 2026-03-03 12:00 · release from the file name',
    'docs/62_v0206_재게이트.md:5 · 2026-03-03 14:00 · release from the file name']);
  assert.deepEqual(hosts(root, 'workflow-evidence-excerpt').map(textOf), ['“## 종합 판정: 불통과 — 결함 1”', '“## 종합 판정: 조건부 통과 — 판단 1”']);
  await act(async () => cellOf('0.2.6', 'tester').props.onPress());
  assert.equal(textOf(sheetButton(root, 'workflow-evidence-why')), 'The reading rule for this step found nothing for this release. That does not say it was not done.');
  await act(async () => sheetButton(root, 'workflow-evidence-close').props.onPress());
  assert.equal(hosts(root, 'workflow-evidence').length, 0);
  // Another release: its own way and loops.
  await act(async () => sheetButton(root, 'workflow-release-0.2.4').props.onPress());
  assert.equal(textOf(sheetButton(root, 'flow-loop-label')), '재게이트 ×2: 51→52 · 53→54');
  assert.equal(sheetButton(root, 'workflow-release-0.2.4').props.accessibilityState.selected, true);
  await act(async () => sheetButton(root, 'workflow-unknown').props.onPress());
  assert.match(textOf(sheetButton(root, 'workflow-unknown-list')), /docs\/40_v0202_게이트검증\.md/);
  // "Read the workflow again" asks the server again (it answers from its one-minute reading).
  await act(async () => sheetButton(root, 'workflow-refresh').props.onPress());
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.workflow.get').length, 2);
  // Back to the board: the columns return.
  await act(async () => sheetButton(root, 'lane-view-board').props.onPress());
  assert.equal(hosts(root, 'workflow').length, 0); assert.equal(hosts(root, 'swimlane-cells').length, 1);
  assert.ok(h.calls.every(c => !/mutate|ensure|ui\.set|busy/.test(c.name)), 'nothing written: ' + h.calls.map(c => c.name).join());
  assert.equal(h.ui.writes.length, 0);
});
test('REQ-124 wide: no definition, no button — a board with cards included; a definition gone since says so', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  h.addCard({ ...add('In flight'), stageId: 'doing', awaiting: 'user' });
  const root = await render(t, OverviewScreen, h.props);
  assert.equal(hosts(root, 'lane-view-switch').length, 0);
  // The overview said there was one, the read says it is gone (or unreadable): the words, and a way to read again.
  const gone = harness({ width: 1400, workflow: { defined: false, reason: 'unknown-format', definitionPath: '.kanban/workflow.json', problems: ['stages.0.shape: Invalid option'] } });
  const shown = await render(t, gone.load('client/overview.tsx').OverviewScreen, gone.props);
  await act(async () => sheetButton(shown, 'lane-view-workflow').props.onPress());
  assert.equal(textOf(sheetButton(shown, 'workflow-absent')), 'The workflow definition is in a format this version does not read.');
  assert.deepEqual(hosts(shown, 'workflow-problem').map(textOf), ['stages.0.shape: Invalid option']);
  assert.equal(hosts(shown, 'flow-canvas').length, 0);
});
test('REQ-124 ⑤ wide: another field\'s procedure (no gate, no commit) is drawn by the same screen — "No record" where nothing was read', async t => {
  const workflow = await readFixture(t, otherDefinition, otherFiles);
  const h = harness({ width: 1400, workflow }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await act(async () => sheetButton(root, 'lane-view-workflow').props.onPress());
  assert.deepEqual(flowNodes(root).sort(), ['deliver', 'draft', 'grasp', 'ok', 'reply', 'review', 'revise']);
  const cellOf = (v, id) => sheetButton(root, 'workflow-row-' + v).findAll(n => n.props?.testID === 'workflow-cell-' + id && typeof n.type === 'string')[0];
  assert.deepEqual(['draft', 'review', 'revise', 'deliver'].map(id => textOf(cellOf('0.1.3', id))), ['No record', 'No record', 'No record', '04-05 09:00']);
  assert.equal(textOf(cellOf('0.1.2', 'review')), '9 반려');
  assert.deepEqual(hosts(root, 'flow-note-grasp').map(textOf), ['Nothing to read']);
  assert.deepEqual(hosts(root, 'flow-loop-label').map(textOf), ['다시 검토', '새 요청'], 'no loop read for the newest release');
  await act(async () => sheetButton(root, 'workflow-release-0.1.1').props.onPress());
  assert.deepEqual(hosts(root, 'flow-loop-label').map(textOf), ['다시 검토 ×1: 5→6', '새 요청']);
  assert.deepEqual(hosts(root, 'flow-note-review').map(textOf), ['4 반려 → 승인']);
  assert.ok(h.calls.every(c => !/mutate|ensure|ui\.set/.test(c.name)));
});
test('REQ-124 ③ on 390px: no workflow button in this release (a lane with a definition included), the heading keeps its 16px line and nothing reads the workflow', async t => {
  const workflow = await readFixture(t, gateDefinition, gateFiles);
  const h = harness({ mobile: true, platform: 'web', workflow });
  h.addCard({ ...add('In flight'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  await act(async () => root.root.findByProps({ testID: 'mobile-tab-doing' }).props.onPress());
  const heading = hosts(root, 'mobile-workspace-heading')[0];
  assert.equal(heading.props.style.minHeight, 16, 'D1: the first card still starts at 168px');
  assert.equal(hosts(root, 'lane-view-toggle').length + hosts(root, 'lane-view-switch').length + hosts(root, 'lane-view-workflow').length, 0);
  assert.equal(hosts(root, 'mobile-cell-panel').length, 1, 'the tab\'s cards as ever');
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.workflow.get').length, 0);
});
test('research/210 (208-D1) on 390px: the name keeps its first characters beside the heading\'s figures and controls, which give way first; a press still opens its board', async t => {
  const h = harness({ mobile: true, platform: 'web' });
  h.addCard({ ...add('In flight'), stageId: 'doing' });
  const { nameFloor, textWidth, NAME_FLOOR } = h.load('client/group-header.tsx');
  // Names shaped like the gate's: ten characters' room (an ellipsis takes one or two), a short name whole.
  assert.equal(NAME_FLOOR.chars, 10);
  assert.equal(nameFloor('Sample-Long-Board', 11), textWidth('Sample-Lon', 11));
  assert.ok(nameFloor('Sample-Long-Board', 11) >= 60, 'eight Latin characters and an ellipsis fit');
  assert.equal(nameFloor('2026 가상실증기술 지원사업', 11), textWidth('2026 가상실증기', 11));
  assert.equal(textWidth('한글', 11), 22, 'a Hangul character as wide as the font');
  assert.equal(nameFloor('ui', 11), textWidth('ui', 11), 'a short name keeps only its own width');
  const { OverviewScreen } = h.load('client/overview.tsx'), root = await render(t, OverviewScreen, h.props);
  await act(async () => root.root.findByProps({ testID: 'mobile-tab-doing' }).props.onPress());
  const heading = hosts(root, 'mobile-workspace-heading')[0], lane = heading.findByProps({ testID: 'lane-name' });
  assert.equal(lane.props.style.flex, 1);
  assert.equal(lane.props.style.minWidth, nameFloor('Example Workspace', 11) + textWidth(' (2)', 11), 'the name and its count keep their floor');
  assert.equal(flatStyle(heading.findByProps({ testID: 'workspace-name-detail' }).props.style).flexShrink, 100, 'the folder after the name goes first');
  for (const id of ['lane-cards-progress', 'lane-needs-human']) {
    const figure = heading.findByProps({ testID: id });
    assert.equal(figure.props.numberOfLines, 1, id + ' cut with …');
    assert.equal(flatStyle(figure.props.style).flexShrink, 1, id + ' gives way');
    assert.equal(flatStyle(figure.props.style).minWidth, 0, id);
  }
  // The wide heading is as it was: no floor there.
  const wide = harness({ width: 1400 }), wideRoot = await render(t, wide.load('client/overview.tsx').OverviewScreen, wide.props);
  assert.equal(hosts(wideRoot, 'lane-name')[0].props.style.minWidth, 0);
  await act(async () => heading.findByProps({ testID: 'workspace-name-link' }).props.onPress());
  assert.equal(root.root.findAllByType('View').filter(v => v.props.testID === 'workspace-board').length, 1, 'the name opens its board');
});

// ---- REQ-127: the board screen a lane's name opens has the lane's "Board | Workflow" beside its title — a definition and a wide
// window only (not the workspace panel, not 390px in this release). The workflow takes the board's width, its flow columns capped
// at FLOW.wideCol and centred; the choice is the lane's own session value, so the lane shows what its board showed. ----
test('REQ-127 wide: the board screen\'s "Board | Workflow" shows the workflow at the board\'s width in place of its columns, shared with the lane', async t => {
  const workflow = await readFixture(t, gateDefinition, gateFiles);
  const h = harness({ width: 1400, workflow });
  h.addCard({ ...add('In flight'), stageId: 'doing' });
  const { OverviewScreen } = h.load('client/overview.tsx'), { FLOW } = h.load('client/workflow-model.ts');
  const root = await render(t, OverviewScreen, h.props);
  const link = () => hosts(root, 'swimlane-lane-header')[0].findAll(n => n.props?.testID === 'workspace-name-link' && typeof n.type === 'string')[0];
  await act(async () => link().props.onPress());
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  const appbar = () => root.root.findByProps({ testID: 'board-appbar' });
  const sw = appbar().findAll(n => n.props?.testID === 'lane-view-switch' && typeof n.type === 'string')[0];
  assert.ok(sw, 'the switch in the board\'s top bar');
  assert.equal(sw.props.accessibilityLabel, 'Board or workflow: Example Workspace');
  // Right after the title block, a spacer, then the tools as before.
  const bar = nativeNode(root, 'board-appbar').children, at = bar.findIndex(n => n.props?.testID === 'lane-view-switch');
  assert.equal(flatStyle(bar[at - 1].props.style).flexShrink, 1, 'the title block keeps its width, cut with … when crowded');
  assert.equal(flatStyle(bar[at + 1].props.style).flex, 1, 'then the room before the tools');
  assert.equal(sheetButton(root, 'lane-view-board').props.accessibilityState.checked, true, 'the board first');
  assert.ok(hosts(root, 'board-cell-doing').length === 1 && hosts(root, 'board-workflow').length === 0);
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.workflow.get').length, 0, 'nothing read before it opens');
  await act(async () => sheetButton(root, 'lane-view-workflow').props.onPress());
  assert.equal(sheetButton(root, 'lane-view-workflow').props.accessibilityState.checked, true);
  assert.deepEqual(h.calls.filter(c => c.name === 'kanban.v1.workflow.get').map(c => c.input), [{ workspaceId: h.base.workspaceId }]);
  assert.equal(root.root.findAll(n => typeof n.type === 'string' && /^board-cell-/.test(n.props?.testID ?? '')).length, 0, 'the columns give way');
  assert.equal(flatStyle(sheetButton(root, 'workflow').props.style).width, 1400 - 24, 'the board\'s width inside its padding');
  assert.deepEqual(flowNodes(root).sort(), gateDefinition.stages.map(s => s.id).sort());
  const canvas = flatStyle(sheetButton(root, 'flow-canvas').props.style), node = id => flatStyle(sheetButton(root, 'flow-node-' + id).props.style);
  assert.equal(canvas.width, 1400 - 24 - 26, 'the flow as wide as its box, no sideways scroll');
  assert.equal(hosts(root, 'flow-scroll').length, 0);
  assert.ok(node('pass').left - node('gate').left > (1118 - 40) / 7, 'wider apart than on the lane');
  assert.ok(node('impl').left - node('req').left <= FLOW.wideCol, 'never more than a capped column apart');
  assert.deepEqual(hosts(root, 'flow-note-gate').map(textOf), ['60 불통과 → 조건부'], 'the same reading as the lane');
  assert.equal(textOf(sheetButton(root, 'flow-loop-label')), '재게이트 ×1: 61→62');
  assert.equal(root.root.findAll(n => typeof n.type === 'string' && /^workflow-row-0/.test(n.props?.testID ?? '')).length, 6);
  await act(async () => sheetButton(root, 'workflow-release-0.2.4').props.onPress());
  assert.equal(textOf(sheetButton(root, 'flow-loop-label')), '재게이트 ×2: 51→52 · 53→54');
  // Back with the workflow open: the lane shows it too; the lane's "Board" opens the board with its columns again.
  await act(async () => sheetButton(root, 'board-breadcrumb').props.onPress());
  assert.equal(hosts(root, 'workspace-board').length, 0);
  assert.equal(sheetButton(root, 'lane-view-workflow').props.accessibilityState.checked, true, 'the lane shows what its board showed');
  assert.equal(hosts(root, 'workflow').length, 1);
  await act(async () => sheetButton(root, 'lane-view-board').props.onPress());
  await act(async () => link().props.onPress());
  await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  assert.equal(sheetButton(root, 'lane-view-board').props.accessibilityState.checked, true);
  assert.equal(hosts(root, 'board-cell-doing').length, 1);
  assert.ok(h.calls.every(c => !/mutate|ensure|ui\.set|busy/.test(c.name)), 'nothing written: ' + h.calls.map(c => c.name).join());
  assert.equal(h.ui.writes.length, 0);
});
test('REQ-127 no switch on a board without a definition, on 390px, in a narrow window or in the workspace panel; the top bar as it was', async t => {
  const plain = harness({ width: 1400 }), { BoardScreen } = plain.load('client/board.tsx');
  const none = await render(t, BoardScreen, { ...plain.props, selector: { boardId: plain.base.id }, onBack: () => {} });
  await act(async () => none.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 1400 } } }));
  assert.equal(hosts(none, 'lane-view-switch').length, 0);
  const bar = nativeNode(none, 'board-appbar').children;
  assert.equal(flatStyle(bar.find(n => jsonNodes(n, 'board-title').length).props.style).flex, 1, 'the title block fills the bar as before');
  const workflow = await readFixture(t, gateDefinition, gateFiles);
  for (const [name, options, props, width] of [['390', { mobile: true, workflow }, { onBack: () => {} }, 390], ['narrow', { width: 700, workflow }, { onBack: () => {} }, 700],
    ['panel', { width: 1400, workflow }, { panel: true }, 1400]]) {
    const h = harness(options), { BoardScreen: Screen } = h.load('client/board.tsx');
    const root = await render(t, Screen, { ...h.props, selector: { boardId: h.base.id }, ...props });
    await act(async () => root.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width } } }));
    assert.equal(hosts(root, 'lane-view-switch').length + hosts(root, 'board-workflow').length, 0, name);
    assert.equal(h.calls.filter(c => c.name === 'kanban.v1.workflow.get').length, 0, name + ': nothing read');
  }
  // A phone keeps its board even when the lane's choice (made on a wide window) is the workflow.
  const h = harness({ mobile: true, workflow }), { BoardScreen: Screen } = h.load('client/board.tsx'), { sessionFor } = h.load('client/session-store.ts');
  sessionFor(h.props.host.id + ':surface').set('laneViews', { [h.base.id]: 'workflow' });
  const phone = await render(t, Screen, { ...h.props, selector: { boardId: h.base.id }, onBack: () => {} });
  await act(async () => phone.root.findByProps({ testID: 'workspace-board' }).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
  assert.equal(hosts(phone, 'board-workflow').length, 0);
  assert.ok(hosts(phone, 'mobile-tab-todo').length + hosts(phone, 'board-cell-todo').length >= 1, 'its stage tabs and cards as ever');
});

// ---- REQ-126: an agent's name carries its model's version and thinking level — "<label>-<version>-<thinking>" — on the card and in
// the detail (assignees, author, the move's reason, the stage history). The format itself: tests/req126-model-names.test.mjs ----
const REQ126_MODELS = { claude: [{ provider: 'claude', id: 'claude-opus-5-5', label: 'Opus 5.5' }],
  codex: [{ provider: 'codex', id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { provider: 'codex', id: 'gpt-6-astra', label: 'GPT-6-Astra' }] };
const REQ126_LEAD = '총괄-09_Sample-App_Opus', REQ126_TOPIC = 'T02_Sample-Topic', REQ126_WORK = 'Build the sample';
const REQ126_TOPIC_AGENT = '44444444-4444-4444-8444-444444444444';
async function req126Board(t, options = {}) {
  const h = harness({ models: REQ126_MODELS, ...options,
    agents: [{ id: AGENT_A, status: 'idle', title: REQ126_LEAD, provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'high',
      labels: { profile: '총괄_Opus' } },
    { id: REQ126_TOPIC_AGENT, status: 'running', title: REQ126_TOPIC, provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'xhigh',
      labels: { profile: '산출물_Opus', role: '주제총괄', 'paseo.parent-agent-id': AGENT_A } },
    { id: AGENT_B, status: 'running', title: REQ126_WORK, provider: 'codex', model: 'gpt-6.1-sol', thinkingOptionId: 'high',
      labels: { profile: '실행_Sol', 'paseo.parent-agent-id': AGENT_A } }] });
  for (const [index, [title, agentId]] of [[REQ126_WORK, AGENT_B], [REQ126_TOPIC, REQ126_TOPIC_AGENT], [REQ126_LEAD, AGENT_A]].entries()) {
    const at = '2026-01-01T02:0' + index + ':00.000Z';
    h.addCard({ ...add(title), stageId: 'doing' }, at);
    h.addCard({ op: 'link', id: h.base.cards.at(-1).id, agentId, role: 'worker' }, at);
  }
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  return { h, root };
}
for (const [name, options] of [['wide', { width: 1400 }], ['390', { mobile: true }]]) {
  test('REQ-126 ' + name + ': line two names the lead, the topic lead and a worker by label, the model list\'s version and the thinking level', async t => {
    const { h, root } = await req126Board(t, options);
    const nameIn = title => textOf(inCard(root, title, 'card-agent-name')[0]);
    assert.equal(nameIn(REQ126_LEAD), '총괄_Opus-5.5-High', 'the lead card, under its title');
    assert.equal(inCard(root, REQ126_LEAD, 'card-leader').length, 1, 'still a lead card');
    assert.equal(nameIn(REQ126_TOPIC), '산출물_Opus-5.5-XHigh', 'a topic lead');
    assert.equal(nameIn(REQ126_WORK), '실행_Sol-6.1-High', 'the version from "GPT-6.1-Sol"');
    assert.deepEqual(h.sdkCalls.filter(call => call.startsWith('models:')).sort(), ['models:claude', 'models:codex'],
      'each provider\'s model list is read once, however many agents use it');
  });
}
test('REQ-126 the model list\'s name wins over the id; without it (no list, a failed list, a model not in it) the id is read', async t => {
  const agent = (id, provider, model, thinkingOptionId, profile) => ({ id, status: 'idle', title: 'Agent', provider, model, thinkingOptionId,
    labels: profile ? { profile } : {} });
  const cases = [
    // A label the list names differently from its id: the list's version is the one shown.
    [{ claude: [{ provider: 'claude', id: 'claude-sample-model', label: 'Sample 7.2' }] }, agent(AGENT_A, 'claude', 'claude-sample-model', 'max', '조사_Sample'), '조사_Sample-7.2-Max'],
    [undefined, agent(AGENT_A, 'codex', 'gpt-6-astra', 'xhigh', '검증_Astra'), '검증_Astra-6-XHigh'],
    ['fail', agent(AGENT_A, 'codex', 'gpt-6.1-sol', 'medium', '실행_Sol'), '실행_Sol-6.1-Medium'],
    [{ codex: [] }, agent(AGENT_A, 'codex', 'gpt-6.1-sol', 'low', null), 'GPT-6.1-Sol-Low'],
    [undefined, agent(AGENT_A, 'gemini', 'gemini-3.5-flash', null, null), 'Gemini-3.5-Flash'],
    // A label from before 09-30 already ends with its version: the thinking level alone follows.
    [REQ126_MODELS, agent(AGENT_A, 'codex', 'gpt-6-sol', 'high', '실행_Sol-6'), '실행_Sol-6-High'],
    [REQ126_MODELS, agent(AGENT_A, 'claude', 'claude-opus-5-5', 'high', '총괄_Opus-5.5'), '총괄_Opus-5.5-High'],
  ];
  for (const [models, value, want] of cases) {
    const h = harness({ width: 1400, link: [AGENT_A], agents: [value], models: models === 'fail' ? { codex: 'fail' } : models });
    const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
    await settle();
    assert.equal(textOf(hosts(root, 'card-agent-name')[0]), want, JSON.stringify(value));
  }
});
test('REQ-126 a long name gives way from its end; "· +1" keeps its place beside it', async t => {
  const h = harness({ width: 1400, link: [AGENT_A, AGENT_B], models: REQ126_MODELS,
    agents: [{ id: AGENT_A, status: 'running', provider: 'codex', model: 'gpt-6.1-sol', thinkingOptionId: 'xhigh', labels: { profile: '실행_환경_Sol' } },
      { id: AGENT_B, status: 'idle', provider: 'claude', model: 'claude-opus-5-5', labels: {} }] });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  const name = hosts(root, 'card-agent-name')[0], others = hosts(root, 'card-agent-others')[0];
  assert.equal(textOf(name), '실행_환경_Sol-6.1-XHigh');
  assert.equal(name.props.numberOfLines, 1, 'one line, cut at its end (the label it starts with stays)');
  assert.equal(name.props.style.flexShrink, 1);
  assert.equal(textOf(others), '· +1');
  assert.equal(others.props.style.flexShrink, 0, 'the count never gives way to the name');
});
test('REQ-126 an archived agent keeps the last name the host gave', async t => {
  const h = harness({ width: 1400, link: [AGENT_A], models: REQ126_MODELS,
    agents: [{ id: AGENT_A, status: 'idle', provider: 'codex', model: 'gpt-6.1-sol', thinkingOptionId: 'high', labels: { profile: '실행_Sol' } }] });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', archivedAt: '2026-10-01T00:00:00.000Z', provider: 'codex', model: 'gpt-6.1-sol',
    thinkingOptionId: 'high', labels: { profile: '실행_Sol' } }));
  await act(async () => hosts(root, 'card-signal-press')[0].props.onPress({ stopPropagation() {} }));
  assert.match(allText(hosts(root, 'card-signal-tooltip')[0]), /^실행_Sol-6\.1-High · Codex · /, 'who it was, with its model');
  await act(async () => labelled(root, 'Example card').props.onPress());
  assert.match(textOf(hosts(root, 'agent-signal-text')[0]), /^실행_Sol-6\.1-High · /, 'and in the detail');
});
test('REQ-126 the detail names every agent the same way: assignees, author, the move\'s reason, the stage history; an unknown one by its id', async t => {
  const moved = '2026-01-01T03:00:00.000Z';
  const h = harness({ width: 1400, link: [AGENT_A], author: { kind: 'agent', agentId: AGENT_B }, models: REQ126_MODELS,
    cardAuto: { reason: { by: 'agent', cause: null, agentId: AGENT_B, at: moved, created: false } },
    agents: [{ id: AGENT_A, status: 'idle', provider: 'codex', model: 'gpt-6.1-sol', thinkingOptionId: 'high', labels: { profile: '실행_Sol' } },
      { id: AGENT_B, status: 'idle', provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'high', labels: { profile: '총괄_Opus' } }] });
  const card = h.base.cards[0].id;
  h.addCard({ op: 'move', id: card, to: 'doing' }, moved, { kind: 'agent', agentId: AGENT_B });
  h.addCard({ op: 'move', id: card, to: 'review' }, '2026-01-01T04:00:00.000Z', { kind: 'agent', agentId: UNLISTED[0] });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  await act(async () => labelled(root, 'Example card').props.onPress());
  await settle();
  assert.match(textOf(hosts(root, 'agent-signal-text')[0]), /^실행_Sol-6\.1-High · /, 'the assignee row');
  assert.equal(detailMeta(root, 'Created by'), '총괄_Opus-5.5-High · 22222222', 'the author, then its short id');
  const reason = allText(hosts(root, 'detail-move-reason')[0]).replace(/⁠/g, '').replace(/ /g, ' ');
  assert.match(reason, /^Moved by another agent \(총괄_Opus-5\.5-High · 22222222\) · /, 'the agent that moved it');
  const fields = root.root.findAllByType('Text').filter(n => typeof n.props.children === 'string');
  const history = fields[fields.findIndex(n => n.props.children === 'Retained stage history') + 1]?.props.children.split('\n');
  assert.match(history[0], / · — → To Do · 총괄_Opus-5\.5-High · 22222222$/, 'made by the agent (REQ-136 H4: its stage by name)');
  assert.match(history[1], / · To Do → In progress · 총괄_Opus-5\.5-High · 22222222$/, 'an agent\'s line names it');
  assert.match(history[2], / · In progress → Review · 33333333$/, 'an agent Kanban cannot read: its short id, as before');
});

// ---- REQ-128: the lab's message list — a glyph on the wide title row (count: a person's decisions + left waiting), its panel
// over the board, the filter row 1 (From [and/or] To State · title), a thread's newest file beside the list. Made-up names:
// workspaces "wsA", "wsB", "example-workspace" (the base board's folder), a person "검토자".
const REQ128_DAY = 86_400_000, req128At = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const req128Name = (ms, from, kind) => req128At(ms).replace(/[-:]/g, '').replace(' ', '-') + '_' + from + '_' + kind + '.md';
const req128File = (ms, from, kind, to, extra = {}) => ({ name: req128Name(ms, from, kind), at: req128At(ms), from, kind, title: extra.title ?? kind + ' — ' + from,
  to, due: extra.due ?? null });
function req128List() {
  const now = Date.now();
  const thread = (id, subject, files, latest) => ({ id, subject, files, latest });
  return { state: 'ready', root: '/data/example-mail', key: 'list1', limits: [], readAt: new Date(now).toISOString(), threads: [
    thread('t1-decision', '정리 단계 확인', 4, [req128File(now - 3600e3, 'wsA', '재질의', '검토자 (기록: wsB)', { due: req128At(now + 2 * REQ128_DAY).slice(0, 10) })]),
    thread('t2-stale', '이름 규칙', 1, [req128File(now - 10 * REQ128_DAY, 'wsA', '요청', 'wsB')]),
    thread('t3-open', '설정 채우기', 2, [req128File(now - 7200e3, 'wsB', '요청', 'example-workspace')]),
    thread('t4-tie', '두 파일', 3, [req128File(now - 600e3, 'wsB', '회신', 'wsA'), req128File(now - 600e3, 'example-workspace', '질문', 'wsB')]),
    thread('t5-closed', '닫힌 하나', 2, [req128File(now - 2 * REQ128_DAY, 'wsA', '종결', '없음')]),
    thread('t6-closed', '닫힌 둘', 2, [req128File(now - 3 * REQ128_DAY, 'wsB', '종결', '없음')]),
    thread('t7-closed', '닫힌 셋', 2, [req128File(now - 4 * REQ128_DAY, 'wsB', '종결', '없음')]),
  ] };
}
const REQ128_THREAD = { state: 'ready', id: 't1-decision', path: '/data/example-mail/t1-decision', latest: 1, more: 0, files: [
  { name: '20261001-0910_wsA_재질의.md', at: '2026-10-01 09:10', from: 'wsA', kind: '재질의', title: '재질의 — 남은 하나', to: '검토자 (기록: wsB)', due: '2026-10-05',
    head: ['# 재질의 — 남은 하나', '스레드: x · 보낸 곳: wsA (총괄-07) · 재질의 · 2026-10-01 09:10 KST', '받는 곳: 검토자 (기록: wsB)', '기한: 2026-10-05', '승인: 해당없음'],
    excerpt: ['- 쟁점 1', '- 쟁점 2'] },
  { name: '20260930-1700_wsB_회신.md', at: '2026-09-30 17:00', from: 'wsB', kind: '회신', title: '회신 — 정리 완료', to: 'wsA', due: null },
  { name: '20260930-1600_wsA_요청.md', at: '2026-09-30 16:00', from: 'wsA', kind: '요청', title: '요청 — 정리 단계 확인', to: 'wsB', due: null }] };
const req128Rows = root => root.root.findAll(n => typeof n.type === 'string' && /^mailbox-row-/.test(n.props.testID ?? '')).map(n => n.props.testID.slice(12));
test('REQ-128 ① the glyph: only with the lab\'s switch on and a folder set, on the wide board; its count is decisions + left waiting', async t => {
  // Off (no lab): no glyph, nothing read.
  const off = harness({ width: 1400, mailbox: MAILBOX, mailList: req128List() });
  const root = await render(t, off.load('client/overview.tsx').OverviewScreen, off.props);
  assert.equal(hosts(root, 'mailbox-button').length, 0);
  assert.equal(off.calls.filter(c => c.name === 'kanban.v1.mail.list').length, 0, 'nothing read while off');
  // A folder but the switch off: still none.
  const noSwitch = harness({ width: 1400, mailbox: MAILBOX, mailList: req128List(), uiSettings: { labs: { mailDir: MAIL_DIR } } });
  const r2 = await render(t, noSwitch.load('client/overview.tsx').OverviewScreen, noSwitch.props);
  assert.equal(hosts(r2, 'mailbox-button').length, 0);
  // On: the glyph, with the count, and one reading (the host only — never a folder).
  const on = harness({ width: 1400, mailbox: MAILBOX, mailList: req128List(), uiSettings: LAB_ON });
  const r3 = await render(t, on.load('client/overview.tsx').OverviewScreen, on.props);
  await settle();
  const button = sheetButton(r3, 'mailbox-button');
  assert.ok(button, 'the glyph on the title row');
  assert.equal(button.props.accessibilityLabel, 'Messages · 2 to look at');
  assert.equal(textOf(hosts(r3, 'mailbox-button-badge')[0]), '2');
  assert.deepEqual(on.calls.filter(c => c.name === 'kanban.v1.mail.list').map(c => c.input), [{ hostId: on.props.host.id }]);
  const row = hosts(r3, 'swimlane-title-row')[0], ids = row.findAll(n => typeof n.type === 'string' && n.props.testID).map(n => n.props.testID);
  assert.ok(ids.indexOf('mailbox-button') > ids.indexOf('fold-all') && ids.indexOf('mailbox-button') < ids.indexOf('open-settings'), 'with the ways of looking at the board');
  assert.equal(hosts(r3, 'mailbox-panel').length, 0, 'closed until pressed');
  assert.equal(on.ui.writes.length, 0);
});
test('REQ-128 ① → REQ-134 MA on a phone (390): the glyph in the top bar, the list read for its count, a lane badge opens it filtered', async t => {
  const h = harness({ mobile: true, mailbox: MAILBOX, mailList: req128List(), uiSettings: LAB_ON }); h.addCard({ ...add('In flight'), stageId: 'doing' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  assert.equal(hosts(root, 'mailbox-button').length, 1, 'REQ-134: the glyph on a phone too');
  assert.equal(hosts(root, 'mailbox-panel').length, 0, 'closed until pressed');
  assert.deepEqual(h.calls.filter(c => /kanban\.v1\.mail\./.test(c.name)).map(c => c.name), ['kanban.v1.mail.list'], 'the list for its count, no thread');
  assert.ok(sheetButton(root, 'lane-mail-badge'), 'REQ-90\'s badge stays');
  await act(async () => sheetButton(root, 'lane-mail-badge').props.onPress());
  await settle();
  assert.equal(hosts(root, 'mailbox-panel').length, 1, 'a tap on the lane badge opens the list');
  assert.equal(hosts(root, 'lane-mail-tip').length, 0, 'not the tip');
  assert.match(textOf(hosts(root, 'mailbox-to-trigger-label')[0] ?? hosts(root, 'mailbox-to-label')[0]), /^To /, 'filtered to its workspace');
  assert.equal(h.ui.writes.length, 0);
});
test('REQ-128 ② the panel: groups in order, closed folded to two, the filter row (or inside, and between, the pill, the person, state, title)', async t => {
  const h = harness({ width: 1400, mailbox: MAILBOX, mailList: req128List(), uiSettings: LAB_ON, locale: 'ko' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  await act(async () => sheetButton(root, 'mailbox-button').props.onPress());
  assert.ok(sheetButton(root, 'mailbox-panel'));
  assert.equal(sheetButton(root, 'mailbox-button').props.accessibilityState.selected, true, 'tinted while open');
  assert.deepEqual(['decision', 'stale', 'open', 'closed'].map(s => textOf(hosts(root, 'mailbox-group-' + s + '-title')[0])), ['검토자 결정 1', '방치 1', '진행 2', '종결 3'],
    'the person named from the record line');
  assert.deepEqual(req128Rows(root), ['t1-decision', 't2-stale', 't4-tie', 't3-open', 't5-closed', 't6-closed']);
  assert.match(textOf(hosts(root, 'mailbox-meta')[0]), /^\/data\/example-mail · 스레드 7 · /);
  assert.equal(textOf(hosts(root, 'mailbox-shown')[0]), '7/7 스레드');
  await act(async () => sheetButton(root, 'mailbox-closed-toggle').props.onPress());
  assert.equal(req128Rows(root).length, 7, 'closed opened');
  // State pills and the two newest of a tie.
  const pills = hosts(root, 'mailbox-state').map(textOf);
  assert.equal(pills[0], '검토자 결정'); assert.equal(pills[1], '방치 · 7일 넘음');
  assert.equal(textOf(sheetButton(root, 'mailbox-row-t4-tie').findAll(n => typeof n.type === 'string' && n.props.testID === 'mailbox-who')[0]), 'wsB · example-workspace → wsA · wsB', 'both newest files');
  // From: the choices, most first, with the workspaces Paseo lists (0 kept); several = or.
  await act(async () => sheetButton(root, 'mailbox-from-trigger').props.onPress());
  const fromOptions = root.root.findAll(n => typeof n.type === 'string' && /^mailbox-from-option-/.test(n.props.testID ?? '') && !/-count$/.test(n.props.testID)).map(n => n.props.testID.slice(20));
  assert.deepEqual(fromOptions.slice(0, 3), ['wsB', 'wsA', 'example-workspace'], 'wsB sent 4, wsA 3');
  await act(async () => sheetButton(root, 'mailbox-from-search').props.onChangeText('wsb'));
  assert.deepEqual(root.root.findAll(n => typeof n.type === 'string' && /^mailbox-from-option-/.test(n.props.testID ?? '') && !/-count$/.test(n.props.testID)).map(n => n.props.testID.slice(20)), ['wsB'], 'found by typing');
  await act(async () => sheetButton(root, 'mailbox-from-option-wsB').props.onPress());
  await act(async () => sheetButton(root, 'mailbox-from-dismiss').props.onPress());
  assert.equal(textOf(hosts(root, 'mailbox-from-label')[0]), '보낸 곳 wsB');
  assert.deepEqual(req128Rows(root), ['t4-tie', 't3-open', 't6-closed', 't7-closed']);
  // To: the person pinned on top; and between them.
  await act(async () => sheetButton(root, 'mailbox-to-trigger').props.onPress());
  const toRows = root.root.findAll(n => typeof n.type === 'string' && /^mailbox-to-option-/.test(n.props.testID ?? '') && !/-count$/.test(n.props.testID)).map(n => n.props.testID.slice(18));
  assert.equal(toRows[0], '@person');
  assert.equal(textOf(hosts(root, 'mailbox-to-option-@person-count')[0]), '1');
  await act(async () => sheetButton(root, 'mailbox-to-option-@person').props.onPress());
  await act(async () => sheetButton(root, 'mailbox-to-option-example-workspace').props.onPress());
  await act(async () => sheetButton(root, 'mailbox-to-dismiss').props.onPress());
  assert.equal(textOf(hosts(root, 'mailbox-to-label')[0]), '받는 곳'); assert.equal(textOf(hosts(root, 'mailbox-to-count')[0]), '2');
  assert.deepEqual(req128Rows(root), ['t3-open'], 'from wsB and to (the person or example-workspace)');
  assert.match(textOf(hosts(root, 'mailbox-rule-text')[0]), /^보낸 곳 wsB 그리고 받는 곳 \(검토자 결정 또는 example-workspace\)/);
  assert.equal(textOf(hosts(root, 'mailbox-shown')[0]), '1/7 스레드');
  await act(async () => sheetButton(root, 'mailbox-join').props.onPress());
  assert.equal(textOf(hosts(root, 'mailbox-join-text')[0]), '또는');
  assert.deepEqual(req128Rows(root).sort(), ['t1-decision', 't3-open', 't4-tie', 't6-closed', 't7-closed'], 'or: any thread they are part of');
  // State and title narrow it further.
  await act(async () => sheetButton(root, 'mailbox-state-filter-trigger').props.onPress());
  await act(async () => sheetButton(root, 'mailbox-state-filter-option-closed').props.onPress());
  await act(async () => sheetButton(root, 'mailbox-state-filter-dismiss').props.onPress());
  assert.deepEqual(req128Rows(root).sort(), ['t6-closed', 't7-closed']);
  await act(async () => sheetButton(root, 'mailbox-search').props.onChangeText('셋'));
  assert.deepEqual(req128Rows(root), ['t7-closed']);
  await act(async () => sheetButton(root, 'mailbox-search').props.onChangeText('없는 말'));
  assert.ok(sheetButton(root, 'mailbox-no-match'));
  // Clear all; a dropdown's ✕ alone.
  await act(async () => sheetButton(root, 'mailbox-clear').props.onPress());
  assert.equal(req128Rows(root).length, 7); assert.equal(hosts(root, 'mailbox-rule').length, 0);
  assert.equal(h.ui.writes.length, 0, 'filters are memory only');
  assert.ok(h.calls.every(c => !/mutate|ensure|ui\.set/.test(c.name)));
});
test('REQ-128 ③ a thread pressed: the list stays on the left, the newest file\'s head, excerpt and earlier files on the right', async t => {
  const h = harness({ width: 1400, mailbox: MAILBOX, mailList: req128List(), mailThreads: { 't1-decision': REQ128_THREAD }, uiSettings: LAB_ON, locale: 'ko' });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await settle();
  await act(async () => sheetButton(root, 'mailbox-button').props.onPress());
  assert.equal(h.calls.filter(c => c.name === 'kanban.v1.mail.thread').length, 0, 'no thread read before one is pressed');
  await act(async () => sheetButton(root, 'mailbox-row-t1-decision').props.onPress());
  await settle();
  const asked = h.calls.filter(c => c.name === 'kanban.v1.mail.thread').map(c => c.input);
  assert.deepEqual(asked, [{ hostId: h.props.host.id, thread: 't1-decision' }], 'the host and the thread only (research/236 J3: no file name sent)');
  assert.ok(sheetButton(root, 'mailbox-detail'));
  assert.equal(hosts(root, 'mailbox-columns').length, 0, 'the list narrows to two lines a row');
  assert.equal(req128Rows(root).length, 6, 'the list stays');
  assert.equal(textOf(hosts(root, 'mailbox-detail-subject')[0]), '정리 단계 확인');
  assert.match(textOf(hosts(root, 'mailbox-detail-turn')[0]), /^차례: 검토자 \(기록: wsB\)/);
  assert.equal(textOf(hosts(root, 'mailbox-detail-path')[0]), '폴더 /data/example-mail/t1-decision');
  assert.deepEqual(hosts(root, 'mailbox-detail-head').map(textOf), REQ128_THREAD.files[0].head);
  assert.deepEqual(hosts(root, 'mailbox-detail-excerpt').map(textOf), ['- 쟁점 1', '- 쟁점 2']);
  assert.equal(textOf(hosts(root, 'mailbox-detail-earlier-title')[0]), '이전 파일 2');
  assert.equal(hosts(root, 'mailbox-detail-earlier').length, 2);
  assert.match(textOf(hosts(root, 'mailbox-detail-note')[0]), /읽기만/);
  // A thread the server cannot read: said, nothing else.
  await act(async () => sheetButton(root, 'mailbox-row-t2-stale').props.onPress());
  await settle();
  assert.ok(sheetButton(root, 'mailbox-detail-error'));
  await act(async () => sheetButton(root, 'mailbox-detail-close').props.onPress());
  assert.equal(hosts(root, 'mailbox-detail').length, 0);
  await act(async () => sheetButton(root, 'mailbox-close').props.onPress());
  assert.equal(hosts(root, 'mailbox-panel').length, 0);
  assert.equal(h.ui.writes.length, 0);
});
test('REQ-128 ④ a new fingerprint (a file landed) reads the list again and the count follows; the same one reads nothing', async t => {
  const h = harness({ width: 1400, mailbox: MAILBOX, mailList: req128List(), uiSettings: LAB_ON }); fastRefresh(h, { intervalMs: 25, idleMs: 60_000, minGapMs: 0 });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  await act(async () => { await pause(120); });
  const lists = () => h.calls.filter(c => c.name === 'kanban.v1.mail.list').length;
  assert.equal(lists(), 1, 'the same fingerprint reads nothing again');
  assert.equal(textOf(hosts(root, 'mailbox-button-badge')[0]), '2');
  const next = req128List(); next.key = 'list2'; next.threads = next.threads.filter(th => th.id !== 't2-stale');
  h.setMailList(next); h.setMail({ ...MAILBOX, key: 'k2' });
  await act(async () => { await pause(120); });
  assert.equal(lists(), 2, 'one read for one change');
  assert.equal(textOf(hosts(root, 'mailbox-button-badge')[0]), '1');
  assert.equal(writes(h).length, 0);
});
test('research/236 D1: a list answering another fingerprint than the board\'s is read again, until they agree — then nothing more', async t => {
  // The list's first reading was made under an older fingerprint (it came before the board's first read said the new one).
  const first = { ...req128List(), source: 'k-old' }, fresh = req128List(); fresh.threads = fresh.threads.filter(th => th.id !== 't2-stale');
  let answered = 0;
  const h = harness({ width: 1400, mailbox: MAILBOX, mailList: () => answered++ ? fresh : first, uiSettings: LAB_ON }); fastRefresh(h, { intervalMs: 25, idleMs: 60_000, minGapMs: 0 });
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, h.props);
  const lists = () => h.calls.filter(c => c.name === 'kanban.v1.mail.list').length;
  await act(async () => { await pause(160); });
  assert.equal(lists(), 2, 'read once more, as it answered another fingerprint');
  assert.equal(textOf(hosts(root, 'mailbox-button-badge')[0]), '1', 'the newer reading shows');
  await act(async () => { await pause(160); });
  assert.equal(lists(), 2, 'they agree: nothing more');
  assert.equal(writes(h).length, 0);
});

// ---- REQ-130 (research/260 C): the lead's own state first on its row, and its one-line memo ----------------------------
const RM = 60_000;
/** A lead card (with sub-cards) on the overview, its clock in the test's hand: `clock.at` moves it, `clock.minute()` ticks the screen's minute. */
async function leadSelfBoard(t, { start = PINNED, theme, ...options } = {}) {
  const clock = { now: Date.parse(start) };
  t.mock.method(Date, 'now', () => clock.now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = subCardHarness(options), id = title => h.base.cards.find(c => c.title === title).id;
  options.prepare?.(h, id);
  const props = theme === 'dark' ? { ...h.props, theme: { colors: { ...h.props.theme.colors, surface0: '#111111', surface1: '#1b1b1b', surface2: '#242424' } } } : h.props;
  const root = await render(t, h.load('client/overview.tsx').OverviewScreen, props);
  if (options.mobile) await act(async () => root.root.findAllByType('Pressable').find(p => /^(Review|검토) 1$/.test(p.props.accessibilityLabel ?? '')).props.onPress());
  return { h, root, id, c: palette(props.theme), clock: {
    at: minutes => { clock.now += minutes * RM; },
    minute: () => act(async () => { t.mock.timers.tick(60000); }),
    iso: (minutes = 0) => new Date(clock.now - minutes * RM).toISOString(), get now() { return clock.now; } } };
}
const rowText = root => textOf(hosts(root, 'lead-status')[0]);
test('REQ-130 ① the lead\'s own state leads its row — working, your turn, resting × its sub-cards\' parts or none × wide and phone × en and ko × light and dark', async t => {
  for (const mobile of [false, true]) for (const locale of ['en', 'ko']) for (const theme of ['light', 'dark']) {
    await t.test([mobile ? 'phone' : 'wide', locale, theme].join(' '), async s => {
      const { h, root, c, clock } = await leadSelfBoard(s, { locale, theme, ...(mobile ? { mobile: true, platform: 'ios', width: 390 } : {}) });
      const m = { en: ['Idle · since ', 'Lead working · <1m', 'Ready to check · <1m', 'Running 1'], ko: ['쉼 · ', '총괄 작업 중 · 1분 미만', '확인 대기 · 1분 미만', '실행 중 1'] }[locale];
      const rest = clock.iso(48);
      await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', lastActivityAt: rest }));
      const restText = locale === 'en' ? m[0] + deviceClock(rest, clock.now) : m[0] + deviceClock(rest, clock.now) + '부터';
      assert.equal(rowText(root), restText, 'resting, since its last activity (KST)');
      assert.equal(hosts(root, 'lead-status-me-circle').length, 1);
      assert.equal(flatStyle(hosts(root, 'lead-status-me-text')[0].props.style).color, readable(c.foregroundMuted, c.card));
      await act(async () => h.agents.upsert(AGENT_A, { status: 'running', lastActivityAt: clock.iso() }));
      assert.equal(rowText(root), m[1]);
      assert.equal(hosts(root, 'lead-status-me-ring').length, 1, 'the turning ring of an agent at work');
      const working = flatStyle(hosts(root, 'lead-status-me-text')[0].props.style);
      assert.deepEqual([working.color, working.fontWeight, working.fontSize], [readable(c.running, c.card), '600', 11]);
      // A sub-card at work: its part after the lead's own state, nothing cut.
      // REQ-135: its part on the family line, the row the lead's own state alone.
      await act(async () => h.agents.upsert(SUB_ONE, { status: 'running' }));
      assert.equal(rowText(root), m[1]);
      assert.equal(famParts(root), m[3]);
      assert.equal(hosts(root, 'lead-status-running').length, 1);
      await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', requiresAttention: true, attentionReason: 'finished', lastActivityAt: clock.iso() }));
      assert.equal(rowText(root), m[2], 'its turn done, waiting for you to look');
      assert.equal(famParts(root), m[3]);
      assert.equal(hosts(root, 'lead-status-me-hollow').length, 1);
      assert.equal(flatStyle(hosts(root, 'lead-status-me-text')[0].props.style).color, readable(c.statusWarning, c.card));
      await act(async () => h.agents.upsert(SUB_ONE, { status: 'idle' }));
      assert.equal(rowText(root), m[2], 'no part: its own state alone');
      assert.equal(hosts(root, 'lead-status-quiet').length, 1, 'a press that does nothing (research/166 J1)');
      assert.equal(writes(h).length + h.calls.filter(v => /busy/.test(v.name)).length, 0, 'nothing written');
    });
  }
});
test('REQ-130 ① a state is timed from when the screen saw it begin: at work 12m, your turn 5m, then resting since the last activity once you looked', async t => {
  const { h, root, clock } = await leadSelfBoard(t);
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', lastActivityAt: clock.iso(30) }));
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', lastActivityAt: clock.iso() }));
  assert.equal(rowText(root), 'Lead working · <1m');
  clock.at(12); await clock.minute();
  assert.equal(rowText(root), 'Lead working · 12m');
  // Its activity moves on every event of a run; the time does not restart with it.
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', lastActivityAt: clock.iso() }));
  assert.equal(rowText(root), 'Lead working · 12m');
  const finished = clock.iso();
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', requiresAttention: true, attentionReason: 'finished', lastActivityAt: finished }));
  assert.equal(rowText(root), 'Ready to check · <1m');
  assert.equal(hosts(root, 'lead-status-awaiting').length, 0, 'finished and not looked at: REQ-133 "Ready to check", nothing asked — nothing to press');
  clock.at(5); await clock.minute();
  assert.equal(rowText(root), 'Ready to check · 5m');
  // You opened the chat: Paseo clears its attention (research/261) — resting, since the turn ended.
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', requiresAttention: false, attentionReason: null, lastActivityAt: finished }));
  assert.equal(rowText(root), 'Idle · since ' + deviceClock(finished, clock.now));
  clock.at(61); await clock.minute();
  assert.equal(rowText(root), 'Idle · since ' + deviceClock(finished, clock.now), 'resting says since when, not how long');
  // It asks you (a permission) and you answer: your turn, then at work again from that moment.
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [{ id: 'p' }], lastActivityAt: clock.iso() }));
  assert.equal(rowText(root), 'Needs your answer · <1m', 'REQ-130 its own wait is the mark, not counted twice');
  clock.at(2); await clock.minute();
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [], lastActivityAt: clock.iso() }));
  assert.equal(rowText(root), 'Lead working · <1m');
});
test('REQ-130 ② the lead\'s busy mark is its memo: a pencil line under the row, the card\'s own edge, orange and dashed past 2h; other cards as before', async t => {
  const { h, root, c, clock, id } = await leadSelfBoard(t, { prepare: (h, id) => {
    h.setBusy(id('Lead card'), { text: 'Release tests', since: new Date(Date.parse(PINNED) - 12 * RM).toISOString(), by: 'screen' });
    h.setBusy(id('Worker one'), { text: 'Build', since: new Date(Date.parse(PINNED) - 3 * RM).toISOString(), by: 'cli' });
  } });
  const content = inCard(root, 'Lead card', 'card-content')[0];
  assert.deepEqual(content.children.slice(-3).map(n => n.props.testID), ['family-summary', 'lead-status', 'lead-memo'], 'the memo under the status row, last');
  assert.equal(textOf(inCard(root, 'Lead card', 'lead-memo')[0]), 'Release tests · 12m');
  assert.equal(inCard(root, 'Lead card', 'lead-memo')[0].findByType('Icon').props.name, 'Pencil');
  assert.equal(inCard(root, 'Lead card', 'card-busy').length, 0, 'not the dashed busy row');
  assert.equal(rowText(root), RESTED);
  assert.equal(famParts(root), 'Testing ' + deviceClock(Date.parse(PINNED) - 3 * RM, clock.now) + '~',
    'its own mark is the memo, not a "Testing" part: the sub-card\'s mark alone, from its own start');
  assert.equal(flatStyle(content.props.style).borderStyle, undefined, 'the lead\'s own edge');
  assert.equal(flatStyle(labelled(root, 'Lead card').props.style).height, 84 + 44 - 18 + 22, 'one row taller, as a busy card');
  // A sub-card keeps REQ-84's look.
  assert.equal(inCard(root, 'Worker one', 'card-busy').length, 1);
  assert.equal(inCard(root, 'Worker one', 'lead-memo').length, 0);
  assert.equal(flatStyle(inCard(root, 'Worker one', 'card-content')[0].props.style).borderStyle, 'dashed');
  // Past two hours: orange, "Busy over 2h", the dashed edge in orange — the REQ-84 rule.
  clock.at(2 * 60 - 11); await clock.minute();
  const late = inCard(root, 'Lead card', 'lead-memo-overdue')[0];
  assert.equal(textOf(late), 'Release tests · 2h· Over 2h');
  assert.equal(flatStyle(inCard(root, 'Lead card', 'lead-memo-text')[0].props.style).color, readable(c.statusWarning, c.card));
  const edge = flatStyle(inCard(root, 'Lead card', 'card-content')[0].props.style);
  assert.deepEqual([edge.borderStyle, edge.borderColor], ['dashed', markLine(c.statusWarning, c, c.card)]);
  assert.equal(late.props.accessibilityLabel, 'Memo: Release tests · 2h — over 2h, check it');
});
test('REQ-130 ② the detail of a lead turns its memo on and off — the same busy.set/busy.clear the board reads; wide and phone; never on another card', async t => {
  for (const mobile of [false, true]) await t.test(mobile ? 'phone' : 'wide', async s => {
    const { h, root, id } = await leadSelfBoard(s, mobile ? { mobile: true, platform: 'ios', width: 390 } : {});
    await act(async () => labelled(root, 'Lead card').props.onPress());
    await settle();
    assert.equal(hosts(root, 'detail-memo').length, 1, 'a lead\'s detail offers the memo');
    const field = () => input(root, 'Memo'), on = () => hosts(root, 'detail-memo-on')[0];
    assert.equal(on().props.disabled, true, 'nothing written yet');
    await act(async () => field().props.onChangeText('x'.repeat(201)));
    await act(async () => on().props.onPress());
    assert.equal(hosts(root, 'detail-memo')[0].findAll(n => n.props?.text === 'Write 1–200 characters on one line.').length, 1);
    assert.equal(h.calls.filter(v => v.name === 'kanban.v1.busy.set').length, 0, 'refused before it is sent');
    await act(async () => field().props.onChangeText('  Release\n tests '));
    await act(async () => on().props.onPress());
    await settle();
    assert.deepEqual(h.calls.filter(v => v.name === 'kanban.v1.busy.set').map(v => v.input), [{ boardId: h.base.id, cardId: id('Lead card'), text: 'Release tests' }]);
    assert.equal(textOf(hosts(root, 'detail-busy-text')[0]), 'Release tests · <1m');
    assert.match(textOf(hosts(root, 'detail-busy-meta')[0]), / · by the board screen$/);
    assert.equal(hosts(root, 'detail-busy')[0].findAllByType('Icon').some(n => n.props.name === 'Pencil'), true);
    assert.equal(hosts(root, 'detail-memo').length, 0, 'on: the mark and its "Turn off"');
    await act(async () => hosts(root, 'detail-busy-off')[0].props.onPress());
    await settle();
    assert.deepEqual(h.calls.filter(v => v.name === 'kanban.v1.busy.clear').map(v => v.input), [{ boardId: h.base.id, cardId: id('Lead card') }]);
    assert.equal(h.busyMarks.size, 0);
    assert.equal(hosts(root, 'detail-memo').length, 1, 'off: the memo can be written again');
    assert.equal(writes(h).length, 0, 'the ledger is never written');
  });
  // Another card's detail: no memo (its busy mark stays a CLI's).
  const { root } = await leadSelfBoard(t);
  await act(async () => labelled(root, 'Worker one').props.onPress());
  await settle();
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 1);
  assert.equal(hosts(root, 'detail-memo').length, 0);
});
// ---- REQ-133 (research/264 J7·J1·J3): the lead's wait says what it wants, timed by the host where it can, and the list's detail has the memo ----
test('REQ-133 ① five states lead the row — working, awaiting answer, awaiting review, error, resting × a sub-card\'s part or none × wide and phone × en and ko × light and dark', async t => {
  for (const mobile of [false, true]) for (const locale of ['en', 'ko']) for (const theme of ['light', 'dark']) {
    await t.test([mobile ? 'phone' : 'wide', locale, theme].join(' '), async s => {
      const { h, root, c, clock } = await leadSelfBoard(s, { locale, theme, ...(mobile ? { mobile: true, platform: 'ios', width: 390 } : {}) });
      const w = { en: { working: 'Lead working · <1m', asking: 'Needs your answer · <1m', unseen: 'Ready to check · <1m', error: 'Error · <1m', run: 'Running 1' },
        ko: { working: '총괄 작업 중 · 1분 미만', asking: '답변 대기 · 1분 미만', unseen: '확인 대기 · 1분 미만', error: '오류 · 1분 미만', run: '실행 중 1' } }[locale];
      const states = [
        ['working', { status: 'running' }, 'lead-status-me-ring', c.running],
        ['asking', { status: 'running', pendingPermissions: [{ id: 'q', kind: 'question' }] }, 'lead-status-me-dot', c.statusWarning],
        ['unseen', { status: 'idle', requiresAttention: true, attentionReason: 'finished' }, 'lead-status-me-hollow', c.statusWarning],
        ['error', { status: 'error', requiresAttention: true, attentionReason: 'error' }, 'lead-status-me-danger', c.statusDanger],
      ];
      const rest = clock.iso(48), restText = locale === 'en' ? 'Idle · since ' + deviceClock(rest, clock.now) : '쉼 · ' + deviceClock(rest, clock.now) + '부터';
      for (const sub of [false, true]) {
        await act(async () => h.agents.upsert(SUB_ONE, { status: sub ? 'running' : 'idle' }));
        const tail = sub ? w.run : '';
        for (const [kind, patch, glyph, tone] of states) {
          await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', lastActivityAt: rest }));
          assert.equal(rowText(root), restText, 'resting');
          assert.equal(famParts(root), tail, 'REQ-135: the sub-card\'s part on the family line');
          assert.equal(hosts(root, 'lead-status-me-circle').length, 1);
          await act(async () => h.agents.upsert(AGENT_A, { ...patch, lastActivityAt: clock.iso() }));
          assert.equal(rowText(root), w[kind], kind + (sub ? ' with a sub-card at work' : ' alone') + ' — the answer it waits for is not counted again');
          assert.equal(famParts(root), tail);
          assert.equal(hosts(root, 'lead-status-me-' + kind).length, 1, kind);
          assert.equal(hosts(root, glyph).length, 1, kind + ': ' + glyph);
          for (const other of ['lead-status-me-ring', 'lead-status-me-dot', 'lead-status-me-hollow', 'lead-status-me-danger', 'lead-status-me-circle'])
            if (other !== glyph) assert.equal(hosts(root, other).length, 0, kind + ' draws no ' + other);
          const text = flatStyle(hosts(root, 'lead-status-me-text')[0].props.style);
          assert.deepEqual([text.color, text.fontWeight], [readable(tone, c.card), '600'], kind + ' colour');
          assert.equal(hosts(root, 'lead-status-running').length, sub ? 1 : 0);
        }
      }
      assert.equal(writes(h).length + h.calls.filter(v => /busy/.test(v.name)).length, 0, 'nothing written');
    });
  }
});
test('REQ-133 ① "Awaiting you" counts the lead itself unless its mark already says "Awaiting answer"', async t => {
  pinClock(t, PINNED);
  const { h, root } = await subCardBoard(t);
  await act(async () => h.agents.upsert(SUB_ONE, { status: 'running', pendingPermissions: [{ id: 'p' }] }));
  for (const [patch, words] of [[{ status: 'idle', requiresAttention: true, attentionReason: 'finished' }, 'Ready to check'],
    [{ status: 'error', requiresAttention: true, attentionReason: 'error' }, 'Error'],
    [{ status: 'running', pendingPermissions: [{ id: 'q', kind: 'question' }] }, 'Needs your answer']]) {
    await act(async () => h.agents.upsert(AGENT_A, patch));
    assert.match(rowText(root), new RegExp('^' + words + ' · [^·]+$'), words);
    assert.equal(famParts(root), 'Needs you 1', words + ': the sub-card asking you, once');
  }
});
test('REQ-133 ② a press on the lead\'s own wait opens its chat — "Awaiting answer" as D43, "Awaiting review" and "Error" too; with no host navigation, nothing to press; wide and phone', async t => {
  pinClock(t, PINNED);
  const waits = [[{ status: 'idle', requiresAttention: true, attentionReason: 'finished' }, 'Ready to check'],
    [{ status: 'error', requiresAttention: true, attentionReason: 'error' }, 'Error']];
  for (const options of [{}, { mobile: true, platform: 'ios', width: 390 }]) {
    await t.test(options.mobile ? 'phone' : 'wide', async s => {
      const h = subCardHarness(options), { opened, navigation } = opener();
      const root = await render(s, h.load('client/overview.tsx').OverviewScreen, { ...h.props, navigation });
      if (options.mobile) await act(async () => labelled(root, 'Review 1').props.onPress());
      for (const [patch, words] of waits) {
        await act(async () => h.agents.upsert(AGENT_A, patch));
        const mark = hosts(root, 'lead-status-me-open');
        assert.equal(mark.length, 1, words + ': the mark is a press');
        assert.equal(mark[0].props.accessibilityRole, 'button');
        assert.match(mark[0].props.accessibilityLabel, new RegExp('^' + words + ' · [^:]+: open the chat of Lead card$'));
        assert.equal(mark[0].props['aria-pressed'], undefined, 'a way to the chat, not a switch');
        assert.equal(hosts(root, 'lead-status-awaiting').length + hosts(root, 'lead-status-quiet').length, 0, 'nothing asked: no "Awaiting you" press');
        const count = opened.length;
        await act(async () => press(mark[0]));
        await leaveOpen(root);
        assert.deepEqual(opened.slice(count), [['agent', AGENT_A]], words + ': the lead\'s chat, where a look clears it or the error is read');
        assert.deepEqual(familyLit(root), []);
        assert.equal(hosts(root, 'editor-sheet').length + hosts(root, 'desktop-detail-dialog').length, 0, 'no detail');
      }
      // A sub-card asking you too: its "Awaiting you 1" rings it, the lead's mark still opens the lead's chat.
      await act(async () => h.agents.upsert(SUB_ONE, { status: 'running', pendingPermissions: [{ id: 'p' }] }));
      assert.equal(hosts(root, 'lead-status-me-open').length, 1);
      assert.equal(hosts(root, 'lead-status-awaiting').length, 1);
      await act(async () => h.agents.upsert(SUB_ONE, { status: 'idle', pendingPermissions: [] }));
      // Awaiting answer: D43's press, as before.
      await act(async () => h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [{ id: 'q', kind: 'question' }] }));
      assert.equal(hosts(root, 'lead-status-me-open').length, 0);
      const count = opened.length;
      await act(async () => press(hosts(root, 'lead-status-awaiting')[0]));
      await leaveOpen(root);
      assert.deepEqual(opened.slice(count), [['agent', AGENT_A]]);
      // At work or resting: nothing to press.
      for (const patch of [{ status: 'running', pendingPermissions: [] }, { status: 'idle', pendingPermissions: [] }]) {
        await act(async () => h.agents.upsert(AGENT_A, patch));
        assert.equal(hosts(root, 'lead-status-me-open').length + hosts(root, 'lead-status-awaiting').length, 0, patch.status);
      }
      assert.equal(writes(h).length, 0);
    });
  }
  // A host without navigation: "Awaiting review" and "Error" are the quiet row (research/166 J1) — no dead press.
  const { h, root } = await subCardBoard(t);
  for (const [patch, words] of waits) {
    await act(async () => h.agents.upsert(AGENT_A, patch));
    assert.equal(hosts(root, 'lead-status-me-open').length, 0, words);
    assert.equal(hosts(root, 'lead-status-quiet').length, 1, words);
  }
});
test('REQ-133 ③ the time is the host\'s own where it says one — a turn\'s startedAt, an attention\'s timestamp — else when the screen saw it change; a time far ahead or unreadable is not believed', async t => {
  const { h, root, clock } = await leadSelfBoard(t);
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', activeTurn: { turnId: 't1', startedAt: clock.iso(12) } }));
  assert.equal(rowText(root), 'Lead working · 12m', 'begun before the screen saw it');
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', activeTurn: { turnId: 't2', startedAt: clock.iso(2) } }));
  assert.equal(rowText(root), 'Lead working · 2m', 'a new turn, with no change the screen could see');
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', activeTurn: null, requiresAttention: true, attentionReason: 'finished', attentionTimestamp: clock.iso(7) }));
  assert.equal(rowText(root), 'Ready to check · 7m');
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', activeTurn: { turnId: 't3', startedAt: clock.iso(9) }, pendingPermissions: [{ id: 'p' }],
    requiresAttention: true, attentionReason: 'permission', attentionTimestamp: clock.iso(3) }));
  assert.equal(rowText(root), 'Needs your answer · 3m', 'the question\'s time, not the turn\'s');
  await act(async () => h.agents.upsert(AGENT_A, { status: 'error', activeTurn: null, pendingPermissions: [], requiresAttention: true, attentionReason: 'error', attentionTimestamp: clock.iso(4) }));
  assert.equal(rowText(root), 'Error · 4m');
  // An attention of another reason says nothing of the question asked since: the screen's own time.
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', requiresAttention: false, attentionReason: null, attentionTimestamp: null }));
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', pendingPermissions: [{ id: 'p2' }], requiresAttention: true, attentionReason: 'finished', attentionTimestamp: clock.iso(40) }));
  assert.equal(rowText(root), 'Needs your answer · <1m');
  // Not believed — over a minute ahead, unreadable, before 2020, empty: the change the screen saw (3 minutes on, it says <1m).
  for (const startedAt of [new Date(clock.now + 5 * RM).toISOString(), 'not a time', '1999-12-31T00:00:00.000Z', '', null]) {
    await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', pendingPermissions: [], requiresAttention: false, attentionReason: null, activeTurn: null }));
    clock.at(3); await clock.minute();
    await act(async () => h.agents.upsert(AGENT_A, { status: 'running', activeTurn: { turnId: 'x', startedAt } }));
    assert.equal(rowText(root), 'Lead working · <1m', JSON.stringify(startedAt));
    clock.at(2); await clock.minute();
    assert.equal(rowText(root), 'Lead working · 2m', JSON.stringify(startedAt) + ': timed from the change seen');
  }
  for (const attentionTimestamp of [new Date(clock.now + 5 * RM).toISOString(), 'soon']) {
    await act(async () => h.agents.upsert(AGENT_A, { status: 'running', activeTurn: null }));
    await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', requiresAttention: true, attentionReason: 'finished', attentionTimestamp }));
    assert.equal(rowText(root), 'Ready to check · <1m', JSON.stringify(attentionTimestamp));
  }
  // A little ahead (the two clocks drift): now, not the five minutes since the change was seen.
  await act(async () => h.agents.upsert(AGENT_A, { status: 'idle', requiresAttention: false, attentionReason: null, attentionTimestamp: null }));
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running' }));
  clock.at(5); await clock.minute();
  assert.equal(rowText(root), 'Lead working · 5m');
  await act(async () => h.agents.upsert(AGENT_A, { status: 'running', activeTurn: { turnId: 'y', startedAt: new Date(clock.now + 30_000).toISOString() } }));
  assert.equal(rowText(root), 'Lead working · <1m');
});
test('REQ-133 ③ the store: a listing\'s first sight carries the host\'s start of each state, none without one or with one not believed, and drops it when the state moves on', async () => {
  const h = harness();
  const { signalStoreFor } = h.load('client/agent-signals.ts');
  const store = signalStoreFor('host_req133_since');
  const now = Date.now(), iso = minutes => new Date(now - minutes * RM).toISOString();
  let handler = null;
  const entries = [
    agentSnapshot('run', { status: 'running', activeTurn: { turnId: 't', startedAt: iso(12) } }),
    agentSnapshot('look', { requiresAttention: true, attentionReason: 'finished', attentionTimestamp: iso(7) }),
    agentSnapshot('ask', { status: 'running', pendingPermissions: [{ id: 'p' }], requiresAttention: true, attentionReason: 'permission', attentionTimestamp: iso(3),
      activeTurn: { turnId: 't', startedAt: iso(30) } }),
    agentSnapshot('fail', { status: 'error', requiresAttention: true, attentionReason: 'error', attentionTimestamp: iso(4) }),
    agentSnapshot('plain', { status: 'running' }),
    agentSnapshot('ahead', { status: 'running', activeTurn: { turnId: 't', startedAt: new Date(now + 5 * RM).toISOString() } }),
    agentSnapshot('garbled', { requiresAttention: true, attentionReason: 'finished', attentionTimestamp: 'yesterday' }),
    agentSnapshot('other', { status: 'running', pendingPermissions: [{ id: 'p' }], requiresAttention: true, attentionReason: 'finished', attentionTimestamp: iso(9) }),
    agentSnapshot('idle', { activeTurn: { turnId: 't', startedAt: iso(5) }, attentionTimestamp: iso(5) }),
  ];
  const paseo = { agents: { list: async () => ({ entries: entries.map(agent => ({ agent, project: null })),
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }), subscribe: fn => { handler = fn; return () => { handler = null; }; } } };
  const detach = store.attach(paseo);
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(['run', 'look', 'ask', 'fail', 'plain', 'ahead', 'garbled', 'other', 'idle'].map(id => [id, store.source.read(id), store.source.since(id)]), [
    ['run', 'working', iso(12)], ['look', 'attention', iso(7)], ['ask', 'permission', iso(3)], ['fail', 'error', iso(4)],
    ['plain', 'working', undefined], ['ahead', 'working', undefined], ['garbled', 'attention', undefined], ['other', 'permission', undefined],
    ['idle', 'idle', undefined]]);
  // The state moves on: the host's time for the old one goes with it; the change seen stands in where the new one has none.
  handler({ kind: 'upsert', agent: agentSnapshot('run', { requiresAttention: true, attentionReason: 'finished' }) });
  assert.equal(store.source.read('run'), 'attention');
  const seen = store.source.since('run');
  assert.ok(seen && seen !== iso(12) && Math.abs(Date.parse(seen) - Date.now()) < 5000, 'seen to change just now: ' + seen);
  handler({ kind: 'upsert', agent: agentSnapshot('plain', { status: 'running', activeTurn: { turnId: 'u', startedAt: iso(1) } }) });
  assert.equal(store.source.since('plain'), iso(1), 'a later event brings the host\'s start');
  handler({ kind: 'remove', agentId: 'look' });
  assert.equal(store.source.since('look'), undefined);
  detach();
});
test('REQ-133 ④ a lead\'s detail opened from the list offers its memo as from the board — on and off by the same busy.set/busy.clear; another card\'s does not; wide and phone', async t => {
  for (const mobile of [false, true]) await t.test(mobile ? 'phone' : 'wide', async s => {
    const h = subCardHarness(mobile ? { mobile: true, platform: 'ios', width: 390 } : {});
    const id = title => h.base.cards.find(c => c.title === title).id;
    h.addCard({ op: 'update', id: id('Lead card'), patch: { awaiting: 'user' } });
    const { ListOverview } = h.load('client/overview.tsx');
    const root = await render(s, ListOverview, { ...h.props, onBoard: () => {} });
    await settle();
    const row = title => hosts(root, 'attention-row').find(n => textOf(n).startsWith(title));
    assert.ok(row('Lead card'), 'the lead waits for you, so the list has it');
    await act(async () => row('Lead card').props.onPress());
    await settle();
    assert.equal(hosts(root, 'detail-memo').length, 1, 'the lead\'s detail offers the memo, as from the board');
    assert.ok(h.calls.some(v => v.name === 'kanban.v1.board.get' && v.input.boardId === h.base.id), 'its board read to tell it is a lead\'s');
    const field = () => input(root, 'Memo'), on = () => hosts(root, 'detail-memo-on')[0];
    await act(async () => field().props.onChangeText('  Release\n tests '));
    await act(async () => on().props.onPress());
    await settle();
    assert.deepEqual(h.calls.filter(v => v.name === 'kanban.v1.busy.set').map(v => v.input), [{ boardId: h.base.id, cardId: id('Lead card'), text: 'Release tests' }]);
    assert.equal(textOf(hosts(root, 'detail-busy-text')[0]), 'Release tests · <1m');
    assert.equal(hosts(root, 'detail-memo').length, 0, 'on: the mark and its "Turn off"');
    await act(async () => hosts(root, 'detail-busy-off')[0].props.onPress());
    await settle();
    assert.deepEqual(h.calls.filter(v => v.name === 'kanban.v1.busy.clear').map(v => v.input), [{ boardId: h.base.id, cardId: id('Lead card') }]);
    assert.equal(h.busyMarks.size, 0);
    assert.equal(hosts(root, 'detail-memo').length, 1, 'off: the memo can be written again');
    assert.equal(writes(h).length, 0, 'the ledger is never written');
  });
  // Another card's detail from the list (a sub-card waiting for you): no memo.
  const h = subCardHarness();
  h.addCard({ op: 'update', id: h.base.cards.find(c => c.title === 'Worker two').id, patch: { awaiting: 'user' } });
  const { ListOverview } = h.load('client/overview.tsx');
  const root = await render(t, ListOverview, { ...h.props, onBoard: () => {} });
  await settle();
  await act(async () => hosts(root, 'attention-row').find(n => textOf(n).startsWith('Worker two')).props.onPress());
  await settle();
  assert.equal(hosts(root, 'desktop-detail-dialog').length, 1);
  assert.equal(hosts(root, 'detail-memo').length, 0);
});

// REQ-139: the Kanban screens' own size, from the Display settings — the whole screen drawn again at each step.
const scaleValue = root => sheetButton(root, 'ui-scale-value').props.children;
const slotWidths = root => [...new Set(hosts(root, 'swimlane-card-slot').map(v => v.props.style.width))];
test('REQ-139 ① the size row: after the theme, − 100% + and "Back to 100%"; one write a press, the screen redrawn at that size', async t => {
  const h = harness({ width: 1400 }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  assert.deepEqual(slotWidths(root), [264], '100%: the cards as they were');
  await openSettings(root, 'display');
  const row = hosts(root, 'setting-ui-scale')[0];
  assert.deepEqual(row.findAllByType('Text').slice(0, 2).map(n => n.props.children),
    ['Screen size', 'Draws the Kanban screens larger or smaller, from 80% to 150%. Paseo\'s sidebar and chat keep their size.']);
  assert.deepEqual(row.findAllByType('Icon').map(n => n.props.name), ['Minus', 'Plus']);
  assert.equal(scaleValue(root), '100%');
  assert.equal(sheetButton(root, 'ui-scale-reset').props.accessibilityState?.disabled ?? sheetButton(root, 'ui-scale-reset').props.disabled, true, 'already 100%');
  await act(async () => sheetButton(root, 'ui-scale-larger').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).settings, { uiScale: 110 }, 'one field, so no other row is overwritten');
  assert.equal(scaleValue(root), '110%');
  assert.deepEqual(slotWidths(root), [290.4], 'the board behind the window, at 110%');
  assert.equal(sheetButton(root, 'settings-window').props.style.width, 792, 'the window too (720 at 110%)');
  await act(async () => sheetButton(root, 'ui-scale-smaller').props.onPress());
  await act(async () => sheetButton(root, 'ui-scale-smaller').props.onPress());
  assert.deepEqual(h.ui.writes.slice(-2).map(w => w.settings), [{ uiScale: 100 }, { uiScale: 90 }]);
  assert.deepEqual(slotWidths(root), [237.6]);
  await act(async () => sheetButton(root, 'ui-scale-reset').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).settings, { uiScale: 100 });
  assert.deepEqual(slotWidths(root), [264]);
  // The other rows were never written by it, and the remembered settings keep them.
  assert.equal(h.ui.writes.every(w => Object.keys(w.settings).length === 1), true);
  const { copy } = h.load('client/i18n.ts'), ko = copy('ko');
  assert.deepEqual([ko.uiScale, ko.uiScaleSmaller, ko.uiScaleLarger, ko.uiScaleReset, ko.uiScaleValue(120)], ['화면 크기', '작게', '크게', '100%로', '120%']);
});
test('REQ-139 ② a saved size is drawn from the first read on; at 150% "+" is off, at 80% "−"; a refused write keeps the size', async t => {
  for (const [percent, slot, off] of [[150, 396, 'ui-scale-larger'], [80, 211.2, 'ui-scale-smaller']]) {
    const h = harness({ width: 1400, uiSettings: { theme: 'dark', uiScale: percent } }), { OverviewScreen } = h.load('client/overview.tsx');
    const root = await render(t, OverviewScreen, h.props);
    assert.deepEqual(slotWidths(root), [slot], percent + '%');
    await openSettings(root, 'display');
    assert.equal(scaleValue(root), percent + '%');
    assert.equal(sheetButton(root, off).props.disabled, true, percent + '%: ' + off + ' is off');
    assert.equal(h.ui.writes.length, 0, 'opening writes nothing');
  }
  // A write the server refuses keeps the size it had and says so on the row (REQ-66), like any row; trying again saves it.
  const h = harness({ width: 1400, uiSettings: { uiScale: 120 } }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  await openSettings(root, 'display');
  h.outcome('uiFailed');
  await act(async () => sheetButton(root, 'ui-scale-larger').props.onPress());
  assert.deepEqual(h.ui.writes.at(-1).settings, { uiScale: 130 });
  assert.equal(scaleValue(root), '120%');
  assert.deepEqual(slotWidths(root), [316.8]);
  assert.equal(hosts(root, 'setting-error').length, 1);
  await act(async () => sheetButton(root, 'setting-retry').props.onPress());
  assert.equal(scaleValue(root), '130%');
  assert.deepEqual(slotWidths(root), [343.2]);
});
test('REQ-139 ③ the workspace panel and the phone draw at the host\'s size; the phone row stays touchable', async t => {
  const h = harness({ mobile: true, platform: 'web', uiSettings: { uiScale: 150 } }), { OverviewScreen } = h.load('client/overview.tsx');
  const root = await render(t, OverviewScreen, h.props);
  const divider = hosts(root, 'mobile-control-divider')[0];
  assert.equal(divider.props.style.width, 1, 'a line stays a line');
  assert.equal(divider.props.style.height, 36 * 1.5 - 16 * 1.5);
  await openSettings(root);
  await act(async () => sheetButton(root, 'settings-open-display').props.onPress());
  assert.equal(scaleValue(root), '150%');
  assert.equal(sheetButton(root, 'settings-sheet').props.style.width, 390, 'the sheet is still the phone\'s width');
  // The phone's glyphs keep a 44px touch box at 100% and grow with the size.
  await act(async () => sheetButton(root, 'ui-scale-smaller').props.onPress());
  await act(async () => sheetButton(root, 'ui-scale-smaller').props.onPress());
  await act(async () => sheetButton(root, 'ui-scale-smaller').props.onPress());
  assert.equal(scaleValue(root), '120%');
  const p = harness({ panel: true, uiSettings: { uiScale: 130 } }), { WorkspacePanel } = p.load('client/panel.tsx');
  const panel = await render(t, WorkspacePanel, p.props);
  assert.ok(hosts(panel, 'mobile-control-row').length, 'the panel drew');
  assert.equal(p.load('client/ui-scale.ts').uiScaleFactor(), 1.3, 'the panel\'s root set its host\'s size');
  assert.ok(Math.abs(hosts(panel, 'mobile-control-divider')[0].props.style.height - 26) < 1e-9, '(36 − 16) at 130%');
});
