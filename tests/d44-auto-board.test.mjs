import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, exportCommittedBoard, exportBoard, quietBoard, normalizeCwd as coreNormalizeCwd } from '../dist/server/core/index.js';
import { createAutoCards, readAutoState, workspaceSetting, workspacesOff, workspaceTarget } from '../dist/server/auto-cards.js';
import { createEnsureHandler } from '../dist/server/mutations.js';
import { createReadHandlers, readLocale } from '../dist/server/handlers.js';
import { folderKey, normalizeCwd } from '../dist/shared/rpc.js';
import { copy } from '../dist/client/i18n.js';

/**
 * D44: a new Paseo project showed its lane but chatting made no card — the board came only from `kanban init`, which a
 * person with no skill and no CLI never runs. Now the first new agent of a workspace with no board makes one, with no
 * PROCESS.md, and only agents made after this version first ran (or after the switch came back on) count.
 */
const START = '2026-10-01T05:00:00.000Z';
const before = (minutes) => new Date(Date.parse(START) - minutes * 60_000).toISOString();
const after = (minutes) => new Date(Date.parse(START) + minutes * 60_000).toISOString();

async function setup(t, { file } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-d44-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const dataDir = join(root, 'data');
  if (file) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(join(dataDir, 'auto-cards.json'), JSON.stringify(file)); }
  // No real Paseo home: the store reads no workspace record of its own.
  const store = await openStore({ dataDir, homeDir: join(root, 'home'), environment: {}, afterCommit: exportCommittedBoard, lockTimeoutMs: 5000 });
  let clock = START;
  const logs = [];
  const auto = createAutoCards({ store, locale: readLocale, now: () => clock, log: (message) => logs.push(message) });
  const agents = new Map(), rows = [];
  let refreshes = 0;
  const paseo = {
    agents: {
      list: async () => ({ entries: [...agents.values()].map(agent => ({ agent, project: null })), pageInfo: { nextCursor: null } }),
      ref: id => ({ refresh: async () => { refreshes++; const agent = agents.get(id); return agent ? { agent, project: null } : null; } }),
    },
    workspaces: { list: async () => ({ entries: rows, pageInfo: { nextCursor: null } }) },
  };
  const folder = async (name) => { const dir = join(root, name); await fs.mkdir(dir, { recursive: true }); return dir; };
  const row = (id, dir, extra = {}) => { const r = { id, projectId: 'prj_d44', projectRootPath: dir, workspaceDirectory: dir,
    workspaceKind: 'local_checkout', name: id, archivingAt: null, ...extra }; rows.push(r); return r; };
  /** An agent Paseo knows (snapshot) and the hook's view of it (creation title, no creation time). */
  const agent = (workspaceId, cwd, overrides = {}) => {
    const snapshot = { id: randomUUID(), workspaceId, cwd, title: '새 채팅', labels: {}, status: 'idle', pendingPermissions: [],
      archivedAt: null, lastUserMessageAt: null, createdAt: clock, ...overrides };
    agents.set(snapshot.id, snapshot);
    return { snapshot, hook: { id: snapshot.id, workspaceId, parentAgentId: null, provider: 'claude', cwd, title: snapshot.title } };
  };
  const boards = async () => store.listBoards();
  const cardsOf = async (boardId, agentId) => (await store.readBoard(boardId)).cards.filter(c => c.agents.some(a => a.agentId === agentId));
  const exists = async (file) => fs.lstat(file).then(() => true, () => false);
  // The restart repair runs once, before the agents below exist, so each test reads its own signals.
  const settle = async () => { auto.wake(paseo); await auto.idle(); };
  return { root, store, auto, paseo, agents, rows, row, folder, agent, boards, cardsOf, exists, settle, logs,
    refreshes: () => refreshes, tick: at => { clock = at; } };
}

test('D44 (a) a workspace with no board gets one at its first new agent, with its card and no PROCESS.md', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('new-project');
  s.row('wks_new01', dir);
  s.tick(after(1));
  const { hook, snapshot } = s.agent('wks_new01', dir);
  assert.equal(await s.auto.signal(hook, 'created', s.paseo), 'created');
  const [board, ...more] = await s.boards();
  assert.equal(more.length, 0);
  assert.deepEqual([board.workspaceId, normalizeCwd(board.cwd)], ['wks_new01', normalizeCwd(dir)]);
  const [card] = await s.cardsOf(board.id, hook.id);
  assert.deepEqual([card.title, card.stageId], [snapshot.title, 'todo']);
  assert.equal(await s.exists(join(dir, 'PROCESS.md')), false, 'no file the person was not told about');
  const state = await readAutoState(s.store.dataDir);
  assert.deepEqual(Object.keys(state.boards), [board.id]);
  assert.equal(state.autoBoardFloor, START, 'the first run of this version is kept');
  // Later commits write no PROCESS.md either, and the card follows the agent as any other.
  assert.equal(await s.auto.signal(hook, 'turn_started', s.paseo), 'updated');
  assert.equal(await s.auto.signal(hook, 'turn_ended', s.paseo), 'updated');
  assert.equal((await s.cardsOf(board.id, hook.id))[0].stageId, 'review');
  assert.equal(await s.exists(join(dir, 'PROCESS.md')), false);
  // A person who asks for it (`kanban export`) gets it, and from then on it is kept up to date.
  assert.equal((await exportBoard(s.store, board.id)).data.status, 'written');
  const first = await fs.readFile(join(dir, 'PROCESS.md'), 'utf8');
  assert.equal(await s.auto.signal(hook, 'turn_started', s.paseo), 'updated');
  assert.notEqual(await fs.readFile(join(dir, 'PROCESS.md'), 'utf8'), first);
  // A second new agent of the workspace joins the same board.
  s.tick(after(5));
  const second = s.agent('wks_new01', dir);
  assert.equal(await s.auto.signal(second.hook, 'created', s.paseo), 'created');
  assert.equal((await s.boards()).length, 1);
  assert.equal((await s.store.readBoard(board.id)).cards.length, 2);
});

test('D44 (a) no board without Paseo naming the workspace, for a sub-agent, an archived or an unanswered agent', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('elsewhere');
  s.tick(after(1));
  // Paseo does not list the workspace.
  const unlisted = s.agent('wks_unlisted01', dir);
  assert.equal(await s.auto.signal(unlisted.hook, 'created', s.paseo), 'no-board');
  // No workspace listing, or no snapshot to read the creation time from.
  s.row('wks_listed01', dir);
  const noList = s.agent('wks_listed01', dir);
  assert.equal(await s.auto.signal(noList.hook, 'created', { agents: s.paseo.agents }), 'no-board');
  assert.equal(await s.auto.signal(noList.hook, 'created', { agents: { list: s.paseo.agents.list }, workspaces: s.paseo.workspaces }), 'no-board');
  // A sub-agent never makes a card or a board; an archived agent's late signal neither.
  assert.equal(await s.auto.signal({ ...noList.hook, id: randomUUID(), parentAgentId: noList.hook.id }, 'created', s.paseo), 'child');
  const archived = s.agent('wks_listed01', dir, { archivedAt: after(1) });
  assert.equal(await s.auto.signal(archived.hook, 'turn_ended', s.paseo), 'no-card');
  // A workspace being archived.
  s.rows[0].archivingAt = after(1);
  const archiving = s.agent('wks_listed01', dir);
  assert.equal(await s.auto.signal(archiving.hook, 'created', s.paseo), 'no-board');
  assert.equal((await s.boards()).length, 0);
});

test('D44 (b) after an upgrade older agents and old chats make no board and no card; the next new chat does', async t => {
  // A host that ran auto cards before: the start line it kept is long before this version.
  const s = await setup(t, { file: { schemaVersion: 1, activatedAt: '2026-09-01T00:00:00.000Z', hosts: {}, agents: {} } });
  const dir = await s.folder('old-project');
  s.row('wks_old01', dir);
  // Five agents from before the upgrade: idle, still chatting after it (D33-b), asking a permission, archived, running.
  const old = [
    s.agent('wks_old01', dir, { createdAt: before(600) }),
    s.agent('wks_old01', dir, { createdAt: before(300), lastUserMessageAt: after(2), updatedAt: after(2) }),
    s.agent('wks_old01', dir, { createdAt: before(200), pendingPermissions: [{}], status: 'running' }),
    s.agent('wks_old01', dir, { createdAt: before(100), archivedAt: before(10) }),
    s.agent('wks_old01', dir, { createdAt: before(1), status: 'running', lastUserMessageAt: after(3), updatedAt: after(3) }),
  ];
  // The restart repair lists them all, then each keeps signalling.
  s.tick(after(4));
  await s.settle();
  for (const { hook } of old) for (const signal of ['turn_started', 'permission_requested', 'turn_ended'])
    assert.equal(await s.auto.signal(hook, signal, s.paseo), 'no-card', signal);
  assert.equal((await s.boards()).length, 0, 'no board from older agents');
  const asked = s.refreshes();
  for (const { hook } of old) await s.auto.signal(hook, 'turn_started', s.paseo);
  assert.equal(s.refreshes(), asked, 'an agent found too old is not asked again');
  // The first chat opened after the upgrade makes the board and its card, at once.
  s.tick(after(6));
  const fresh = s.agent('wks_old01', dir);
  assert.equal(await s.auto.signal(fresh.hook, 'created', s.paseo), 'created');
  const [board] = await s.boards();
  assert.equal((await s.store.readBoard(board.id)).cards.length, 1);
  // The old ones still stay off the board this feature made, at their next signal and after a restart's repair.
  for (const { hook } of old) assert.equal(await s.auto.signal(hook, 'turn_started', s.paseo), 'no-card');
  const restarted = createAutoCards({ store: s.store, locale: readLocale, now: () => after(30), log: () => {} });
  restarted.wake(s.paseo); await restarted.idle();
  for (const { hook } of old) assert.equal(await restarted.signal(hook, 'turn_ended', s.paseo), 'no-card');
  const cards = (await s.store.readBoard(board.id)).cards;
  assert.deepEqual(cards.map(c => c.agents[0].agentId), [fresh.hook.id], 'one card, the new chat\'s');
  assert.equal((await readAutoState(s.store.dataDir)).autoBoardFloor, START, 'the floor is the first run, not the restart');
  assert.equal((await s.boards()).length, 1);
});

test('D44 (b) a new agent whose signals the daemon missed gets its board at the restart repair', async t => {
  const s = await setup(t);
  const dir = await s.folder('missed');
  s.row('wks_missed01', dir);
  s.tick(after(2));
  const missed = s.agent('wks_missed01', dir, { status: 'running', lastUserMessageAt: after(2) });
  await s.settle();
  const [board, ...more] = await s.boards();
  assert.equal(more.length, 0);
  const [card] = await s.cardsOf(board.id, missed.hook.id);
  assert.equal(card.stageId, 'doing');
});

test('D44 (c) a workspace switched off makes no board, no card and no move; back on, only new agents count', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('quiet');
  s.row('wks_quiet01', dir);
  // Switched off by the folder as the lane shows it (any spelling of it).
  assert.deepEqual(await s.auto.setWorkspaceEnabled(dir + '/', false), { enabled: false, changed: true });
  assert.deepEqual(await s.auto.setWorkspaceEnabled(dir, false), { enabled: false, changed: false });
  s.tick(after(1));
  const off = s.agent('wks_quiet01', dir);
  for (const signal of ['created', 'turn_started', 'turn_ended']) assert.equal(await s.auto.signal(off.hook, signal, s.paseo), 'disabled');
  assert.equal((await s.boards()).length, 0);
  const state = await readAutoState(s.store.dataDir);
  assert.deepEqual(workspacesOff(state), [normalizeCwd(dir)]);
  // The read RPCs tell the screens which of the folders they show are off (249-D3: by the spelling their rows carry).
  const read = createReadHandlers(s.store);
  const overview = await read.overview({ hostId: 'srv_test', includeWorkspaces: true }, s.paseo);
  assert.deepEqual(overview.data.autoCardsOff, [normalizeCwd(dir)]);
  assert.deepEqual((await read.overview({ hostId: 'srv_test' })).data.autoCardsOff, [], 'no board or workspace shown, nothing to list');
  // A workspace with a board: the card stays where it is while off.
  const other = await s.folder('kept');
  s.row('wks_kept01', other);
  s.tick(after(2));
  const kept = s.agent('wks_kept01', other);
  assert.equal(await s.auto.signal(kept.hook, 'created', s.paseo), 'created');
  const [keptBoard] = (await s.boards()).filter(b => b.workspaceId === 'wks_kept01');
  await s.auto.setWorkspaceEnabled(other, false);
  assert.equal(await s.auto.signal(kept.hook, 'turn_started', s.paseo), 'disabled');
  assert.equal((await s.cardsOf(keptBoard.id, kept.hook.id))[0].stageId, 'todo');
  // Back on: the agent made while it was off stays out, the next new one makes the board.
  s.tick(after(10));
  assert.deepEqual(await s.auto.setWorkspaceEnabled(dir, true), { enabled: true, changed: true });
  assert.equal(await s.auto.signal(off.hook, 'turn_started', s.paseo), 'no-card');
  assert.equal((await s.boards()).length, 1);
  s.tick(after(11));
  const on = s.agent('wks_quiet01', dir);
  assert.equal(await s.auto.signal(on.hook, 'created', s.paseo), 'created');
  assert.equal((await s.boards()).length, 2);
  // The host switch off still wins over a workspace's.
  await s.auto.setEnabled('srv_test', false);
  assert.equal(await s.auto.signal(s.agent('wks_quiet01', dir).hook, 'created', s.paseo), 'disabled');
});

test('D44 (d) agents and a person starting one folder at the same moment leave one board', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('together');
  const link = join(s.root, 'together-link'); await fs.symlink(dir, link);
  // Two Paseo workspaces name the folder, one through a link, so their signals go through different queues.
  s.row('wks_one01', dir); s.row('wks_two01', link);
  s.tick(after(1));
  const agents = [s.agent('wks_one01', dir), s.agent('wks_two01', link), s.agent('wks_one01', dir), s.agent(null, dir + '/')];
  const ensure = createEnsureHandler(s.store, async (_paseo, id) => ({ id, cwd: s.rows.find(r => r.id === id).workspaceDirectory }));
  const [tap, ...outcomes] = await Promise.all([
    ensure({ workspaceId: 'wks_two01', requestId: randomUUID(), operations: [{ op: 'add', title: 'A first card' }] }),
    ...agents.map(a => s.auto.signal(a.hook, 'created', s.paseo))]);
  assert.equal(tap.ok, true, JSON.stringify(tap));
  assert.deepEqual(outcomes, ['created', 'created', 'created', 'created']);
  const [board, ...more] = await s.boards();
  assert.equal(more.length, 0, 'one board for the folder');
  assert.equal(board.cards.length, 5);
});

test('D44 (e) a worktree\'s board is made at its project root; a link and the real folder are one board', async t => {
  const s = await setup(t);
  await s.settle();
  const root = await s.folder('project');
  const tree = await s.folder('worktrees/feature');
  s.row('wks_root01', root);
  s.row('wks_tree01', tree, { workspaceKind: 'worktree', projectRootPath: root + '/' });
  s.tick(after(1));
  const inTree = s.agent('wks_tree01', tree);
  assert.equal(await s.auto.signal(inTree.hook, 'created', s.paseo), 'created');
  const [board, ...more] = await s.boards();
  assert.equal(more.length, 0);
  assert.deepEqual([board.workspaceId, normalizeCwd(board.cwd)], ['wks_root01', normalizeCwd(root)], 'the root\'s own workspace, as D25 reads it');
  // An agent at the root joins it; a worktree with a board of its own keeps its cards there (D25 unchanged).
  const atRoot = s.agent('wks_root01', root);
  assert.equal(await s.auto.signal(atRoot.hook, 'created', s.paseo), 'created');
  assert.equal((await s.store.readBoard(board.id)).cards.length, 2);
  // A root Paseo does not list as a workspace of its own: the board takes no workspace's id but its folder's.
  const lone = await s.folder('lone');
  const loneTree = await s.folder('worktrees/lone-feature');
  s.row('wks_lonetree01', loneTree, { workspaceKind: 'worktree', projectRootPath: lone });
  const loner = s.agent('wks_lonetree01', loneTree);
  assert.equal(await s.auto.signal(loner.hook, 'created', s.paseo), 'created');
  const loneBoard = (await s.boards()).find(b => normalizeCwd(b.cwd) === normalizeCwd(lone));
  assert.match(loneBoard.workspaceId, /^local_[0-9a-f]{64}$/);
  // A symbolic link: the board's folder is the real one, and an agent seen through the link finds it without Paseo.
  const real = await s.folder('linked-real');
  const link = join(s.root, 'linked'); await fs.symlink(real, link);
  s.row('wks_link01', link);
  const viaLink = s.agent('wks_link01', link);
  assert.equal(await s.auto.signal(viaLink.hook, 'created', s.paseo), 'created');
  const linked = (await s.boards()).find(b => b.workspaceId === 'wks_link01');
  assert.equal(normalizeCwd(linked.cwd), normalizeCwd(await fs.realpath(real)));
  const byReal = s.agent(null, real);
  assert.equal(await s.auto.signal(byReal.hook, 'created', { agents: s.paseo.agents }), 'created');
  const byLink = s.agent(null, link + '/');
  assert.equal(await s.auto.signal(byLink.hook, 'created', { agents: s.paseo.agents }), 'created');
  assert.equal((await s.store.readBoard(linked.id)).cards.length, 3);
  assert.equal((await s.boards()).length, 3);
});

test('D44 (e) Windows spellings of one folder are one folder', async () => {
  for (const spelling of ['C:\\Work\\app', 'c:/Work/app/', 'C:/Work\\app\\', 'c:\\Work\\app\\\\', 'C:/Work/app'])
    assert.equal(normalizeCwd(spelling), 'c:/Work/app', spelling);
  assert.equal(normalizeCwd('\\\\server\\share\\app\\'), '//server/share/app');
  assert.equal(normalizeCwd('C:\\'), 'c:');
  // A POSIX folder keeps a backslash inside a name, and its case.
  assert.equal(normalizeCwd('/Work/a\\b'), '/Work/a\\b');
  assert.equal(normalizeCwd('/Work/App/'), '/Work/App');
  assert.equal(coreNormalizeCwd, normalizeCwd, 'the core and the plugin spell it alike');
  // The workspace is found by its folder in any spelling, and the switch reads any spelling too.
  const workspaces = { list: async () => ({ entries: [{ id: 'wks_win01', workspaceDirectory: 'C:\\Work\\app', workspaceKind: 'local_checkout' }],
    pageInfo: { nextCursor: null } }) };
  assert.deepEqual(await workspaceTarget(workspaces, { workspaceId: null, cwd: 'c:/Work/app/' }), { cwd: 'C:\\Work\\app', workspaceId: 'wks_win01' });
  const state = { activatedAt: null, hosts: {}, agents: {}, parents: {}, workspaces: { 'c:/Work/app': { enabled: false, changedAt: START } } };
  assert.equal(workspaceSetting(state, ['C:\\Work\\app\\']).enabled, false);
  assert.equal(workspaceSetting(state, ['C:\\Work\\other']).enabled, true);
});

test('D44 (f) a board made with kanban init keeps its PROCESS.md and its D33 rules', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('init-project');
  s.row('wks_init01', dir);
  const init = await s.store.initBoard({ cwd: dir, workspaceId: 'wks_init01', actor: { kind: 'user' }, requestId: randomUUID() });
  assert.equal(await s.exists(join(dir, 'PROCESS.md')), true, 'init exports as before');
  const first = await fs.readFile(join(dir, 'PROCESS.md'), 'utf8');
  s.tick(after(1));
  const agent = s.agent('wks_init01', dir);
  assert.equal(await s.auto.signal(agent.hook, 'created', s.paseo), 'created');
  assert.notEqual(await fs.readFile(join(dir, 'PROCESS.md'), 'utf8'), first, 'every commit still exports');
  // D33-b: an older agent still at work after the start line gets its card on a board a person made.
  const busy = s.agent('wks_init01', dir, { createdAt: before(60), status: 'running', lastUserMessageAt: after(1), updatedAt: after(1) });
  assert.equal(await s.auto.signal(busy.hook, 'turn_started', s.paseo), 'created');
  const state = await readAutoState(s.store.dataDir);
  assert.deepEqual(Object.keys(state.boards ?? {}), [], 'not a board this feature made');
  assert.equal((await s.store.readBoard(init.data.boardId)).cards.length, 2);
});

test('D44 a folder that cannot take a board is not tried again for a minute; nothing is made', async t => {
  const s = await setup(t);
  await s.settle();
  const gone = join(s.root, 'gone');
  s.row('wks_gone01', gone);
  s.tick(after(1));
  const a = s.agent('wks_gone01', gone), b = s.agent('wks_gone01', gone);
  assert.equal(await s.auto.signal(a.hook, 'created', s.paseo), 'no-board');
  assert.equal(await s.auto.signal(b.hook, 'created', s.paseo), 'no-board');
  assert.equal(s.logs.filter(line => line.startsWith('board for ')).length, 1, 'tried once');
  assert.equal((await s.boards()).length, 0);
  // The folder appears; a minute later the next signal makes the board.
  await fs.mkdir(gone);
  s.tick(after(3));
  assert.equal(await s.auto.signal(s.agent('wks_gone01', gone).hook, 'created', s.paseo), 'created');
  assert.equal((await s.boards()).length, 1);
});

test('D44 a person with no skill reads how a board comes, not kanban init', () => {
  for (const locale of ['ko', 'en']) {
    const m = copy(locale);
    assert.doesNotMatch(m.initialize, /kanban init|orchestrator|총괄/);
    assert.doesNotMatch(m.autoCardsHelp + m.autoCardsWorkspacesHelp, /kanban init|skill|스킬/);
  }
});

// ---- research/247: the gate's five defects, each kept from coming back ----

/** Fails the next write of the plugin's file whose content `when` picks (an EIO on its rename), until restored. */
function failStateWrite(t, file, when) {
  const original = fsp.rename;
  const restore = () => { fsp.rename = original; syncBuiltinESMExports(); };
  fsp.rename = async (from, to) => {
    if (to === file && when(JSON.parse(await fs.readFile(from, 'utf8')))) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
    return original(from, to);
  };
  syncBuiltinESMExports();
  t.after(restore);
  return restore;
}
/** Holds the first `statBoards` (where a signal looks for the agent's card) until released. */
function holdLookup(store) {
  const original = store.statBoards.bind(store);
  let entered, release, first = true;
  const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  store.statBoards = async (...args) => { if (first) { first = false; entered(); await gate; } return original(...args); };
  return { reached, release: () => { store.statBoards = original; release(); } };
}

test('247-D1 a made board keeps its quiet rule when the write after it fails; with no mark kept, no board is made', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('mark-fails');
  s.row('wks_mark01', dir);
  s.tick(after(1));
  const file = join(s.store.dataDir, 'auto-cards.json');
  // The folder's mark cannot be kept: no board at all (fail closed).
  let restore = failStateWrite(t, file, value => !!value.boardIntents);
  const first = s.agent('wks_mark01', dir);
  assert.equal(await s.auto.signal(first.hook, 'created', s.paseo), 'no-board');
  restore();
  assert.equal((await s.boards()).length, 0);
  // The mark is kept, the board is made, and moving the mark to the board's id fails: the folder's mark keeps it quiet.
  restore = failStateWrite(t, file, value => !!value.boards && Object.keys(value.boards).length > 0);
  const second = s.agent('wks_mark01', dir);
  assert.equal(await s.auto.signal(second.hook, 'created', s.paseo), 'created');
  restore();
  const [board, ...more] = await s.boards();
  assert.equal(more.length, 0);
  const state = await readAutoState(s.store.dataDir);
  assert.deepEqual([Object.keys(state.boards), Object.keys(state.boardIntents)], [[], [folderKey(board.cwd)]]);
  assert.equal(await quietBoard(s.store, board), true);
  assert.equal(await s.auto.signal(second.hook, 'turn_started', s.paseo), 'updated');
  assert.equal(await s.exists(join(dir, 'PROCESS.md')), false, 'no file after the failed write either');
  // An older chat still at work never joins it.
  const old = s.agent('wks_mark01', dir, { createdAt: before(30), status: 'running', lastUserMessageAt: after(1) });
  assert.equal(await s.auto.signal(old.hook, 'turn_started', s.paseo), 'no-card');
  assert.equal((await s.store.readBoard(board.id)).cards.length, 1);
});

test('247-D1 marks are never pushed out; past the limit no board is made; a damaged file stops everything and stays', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('first');
  s.row('wks_keep01', dir);
  s.tick(after(1));
  const a = s.agent('wks_keep01', dir);
  assert.equal(await s.auto.signal(a.hook, 'created', s.paseo), 'created');
  const [board] = await s.boards();
  const file = join(s.store.dataDir, 'auto-cards.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  for (let i = 0; i < 4998; i++) raw.boards['board_' + i.toString(16).padStart(64, '0')] = { cwd: join(s.root, 'synthetic-' + i), agentId: randomUUID(), at: after(2) };
  await fs.writeFile(file, JSON.stringify(raw));
  const next = await s.folder('next');
  s.row('wks_keep02', next);
  s.tick(after(3));
  assert.equal(await s.auto.signal(s.agent('wks_keep02', next).hook, 'created', s.paseo), 'created');
  const state = await readAutoState(s.store.dataDir);
  assert.equal(Object.keys(state.boards).length, 5000);
  assert.ok(state.boards[board.id], 'the oldest mark stays');
  assert.equal(await s.auto.signal(a.hook, 'turn_started', s.paseo), 'updated');
  assert.equal(await s.exists(join(dir, 'PROCESS.md')), false);
  // At the limit no further board is made, and no mark is pushed out for it.
  const third = await s.folder('third');
  s.row('wks_keep03', third);
  s.tick(after(4));
  assert.equal(await s.auto.signal(s.agent('wks_keep03', third).hook, 'created', s.paseo), 'no-board');
  assert.equal((await s.boards()).length, 2);
  // A file that cannot be read: nothing is made or moved, it is never written over, the screens hear of it, and the core
  // creates no PROCESS.md for a board whose maker it cannot tell.
  await fs.writeFile(file, '{nope');
  assert.equal(await s.auto.signal(a.hook, 'turn_ended', s.paseo), 'held');
  assert.equal(await s.auto.signal(s.agent('wks_keep03', third).hook, 'created', s.paseo), 'held');
  assert.deepEqual([s.auto.health().state, s.auto.health().detail], ['held', 'auto-cards.json']);
  await assert.rejects(s.auto.setWorkspaceEnabled(dir, false));
  assert.equal(await fs.readFile(file, 'utf8'), '{nope');
  assert.equal(await quietBoard(s.store, board), true);
  assert.equal((await readAutoState(s.store.dataDir)).damaged, true);
  assert.equal(workspaceSetting(await readAutoState(s.store.dataDir), [dir]).enabled, false, 'unknown reads as off');
  // 249-D1: the file gone, its backup still answers for the board; only both gone is the plain start.
  await fs.rm(file);
  assert.equal(await quietBoard(s.store, board), true);
  await fs.rm(join(s.store.dataDir, 'auto-cards.backup.json'));
  assert.equal(await quietBoard(s.store, board), false);
});

test('247-D2 a card or board is made from the switches and marks as they are when it is made', async t => {
  const s = await setup(t);
  await s.settle();
  // An old chat's signal looked before a new chat made the folder's board: it still never joins that board.
  const dir = await s.folder('race');
  s.row('wks_race_new', dir); s.row('wks_race_old', dir);
  s.tick(after(1));
  const old = s.agent('wks_race_old', dir, { createdAt: before(30), status: 'running', lastUserMessageAt: after(1) });
  const fresh = s.agent('wks_race_new', dir);
  let held = holdLookup(s.store);
  const pending = s.auto.signal(old.hook, 'turn_started', s.paseo);
  await held.reached;
  assert.equal(await s.auto.signal(fresh.hook, 'created', s.paseo), 'created');
  held.release();
  assert.equal(await pending, 'no-card');
  const [board, ...more] = await s.boards();
  assert.equal(more.length, 0);
  assert.deepEqual((await s.store.readBoard(board.id)).cards.map(c => c.agents.map(x => x.agentId)), [[fresh.hook.id]]);
  // A switch saved while a new chat's signal was on its way: no board and no card after it.
  const other = await s.folder('toggled');
  s.row('wks_toggle01', other);
  const late = s.agent('wks_toggle01', other);
  held = holdLookup(s.store);
  const waiting = s.auto.signal(late.hook, 'created', s.paseo);
  await held.reached;
  assert.deepEqual(await s.auto.setWorkspaceEnabled(other, false), { enabled: false, changed: true });
  held.release();
  assert.equal(await waiting, 'disabled');
  assert.equal((await s.boards()).length, 1);
  // The host switch, the same.
  const third = await s.folder('host-off');
  s.row('wks_toggle02', third);
  const another = s.agent('wks_toggle02', third);
  held = holdLookup(s.store);
  const queued = s.auto.signal(another.hook, 'created', s.paseo);
  await held.reached;
  await s.auto.setEnabled('host_a', false);
  held.release();
  assert.equal(await queued, 'disabled');
  assert.equal((await s.boards()).length, 1);
});

test('247-D3 a board this feature made takes only an agent Paseo confirms; a board made with init keeps REQ-61', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('confirm');
  s.row('wks_confirm01', dir);
  s.tick(after(1));
  // An agent archived by the time it is asked about makes no board.
  const archived = s.agent('wks_confirm01', dir, { archivedAt: after(1) });
  assert.equal(await s.auto.signal(archived.hook, 'created', s.paseo), 'no-board');
  assert.equal((await s.boards()).length, 0);
  const fresh = s.agent('wks_confirm01', dir);
  assert.equal(await s.auto.signal(fresh.hook, 'created', s.paseo), 'created');
  const [board] = await s.boards();
  // No way to ask, no record, no creation time, a parent in the record, archived: no card.
  const noRef = s.agent('wks_confirm01', dir);
  assert.equal(await s.auto.signal(noRef.hook, 'created', { agents: { list: s.paseo.agents.list }, workspaces: s.paseo.workspaces }), 'no-card');
  const unknown = s.agent('wks_confirm01', dir);
  s.agents.delete(unknown.hook.id);
  assert.equal(await s.auto.signal(unknown.hook, 'created', s.paseo), 'no-card');
  const unborn = s.agent('wks_confirm01', dir, { createdAt: null });
  assert.equal(await s.auto.signal(unborn.hook, 'created', s.paseo), 'no-card');
  const child = s.agent('wks_confirm01', dir, { labels: { 'paseo.parent-agent-id': fresh.hook.id } });
  assert.equal(await s.auto.signal(child.hook, 'created', s.paseo), 'no-card');
  const gone = s.agent('wks_confirm01', dir, { archivedAt: after(1) });
  assert.equal(await s.auto.signal(gone.hook, 'created', s.paseo), 'no-card');
  assert.equal((await s.store.readBoard(board.id)).cards.length, 1);
  // A board a person made with init: a created signal still makes the card without asking Paseo (REQ-61).
  const own = await s.folder('init-made');
  s.row('wks_confirm02', own);
  const init = await s.store.initBoard({ cwd: own, workspaceId: 'wks_confirm02', actor: { kind: 'user' }, requestId: randomUUID() });
  const plain = s.agent('wks_confirm02', own);
  assert.equal(await s.auto.signal(plain.hook, 'created', { agents: { list: s.paseo.agents.list } }), 'created');
  assert.equal((await s.store.readBoard(init.data.boardId)).cards.length, 1);
});

test('247-D4 Windows folders compare without case; POSIX folders and two listed Windows folders stay apart', async t => {
  for (const [a, b] of [['C:\\A\\B', 'c:/a/b/'], ['\\\\Server\\Share\\a', '//server/share/a/'], ['C:/Work/App', 'c:\\work\\app\\']])
    assert.equal(folderKey(a), folderKey(b), a);
  assert.notEqual(folderKey('/A/B'), folderKey('/a/b'));
  assert.notEqual(folderKey('C:\\a\\b'), folderKey('C:\\a\\bc'));
  assert.equal(normalizeCwd('C:\\Work\\App'), 'c:/Work/App', 'the spelling that is opened and shown keeps its case');
  const state = { activatedAt: null, hosts: {}, agents: {}, parents: {}, workspaces: { 'c:/A/B': { enabled: false, changedAt: START } } };
  assert.equal(workspaceSetting(state, ['C:\\a\\b']).enabled, false);
  assert.equal(workspaceSetting({ ...state, workspaces: { '//Server/Share/a': { enabled: false, changedAt: START } } }, ['//server/share/a/']).enabled, false);
  assert.deepEqual(workspacesOff(state), ['c:/A/B'], 'the saved spelling');
  const listing = entries => ({ list: async () => ({ entries, pageInfo: { nextCursor: null } }) });
  assert.deepEqual(await workspaceTarget(listing([{ id: 'wks_case01', workspaceDirectory: 'C:\\A\\B', workspaceKind: 'local_checkout' }]),
    { workspaceId: null, cwd: 'c:/a/b' }), { cwd: 'C:\\A\\B', workspaceId: 'wks_case01' });
  // Two listed folders differing only in case (a case-sensitive Windows directory) are two folders.
  const pair = listing([{ id: 'wks_case02', workspaceDirectory: 'C:\\X\\a', workspaceKind: 'local_checkout' },
    { id: 'wks_case03', workspaceDirectory: 'C:\\X\\A', workspaceKind: 'local_checkout' }]);
  assert.equal((await workspaceTarget(pair, { workspaceId: null, cwd: 'c:/X/A' }))?.workspaceId, 'wks_case03');
  assert.equal(await workspaceTarget(pair, { workspaceId: null, cwd: 'c:/x/a' }), null);
  // Off in one spelling is off in every spelling of the folder. 249-D3: a switch belongs to the spelling it was saved under —
  // another spelling of it may be another folder — so "on" in a never-saved spelling while one is off is refused, and the
  // folder is turned back on in the spelling it was turned off in (one entry per spelling, trailing separators dropped).
  const s = await setup(t);
  assert.deepEqual(await s.auto.setWorkspaceEnabled('C:\\Work\\App', false), { enabled: false, changed: true });
  assert.equal(workspaceSetting(await readAutoState(s.store.dataDir), ['c:/work/app/']).enabled, false);
  s.tick(after(1));
  await assert.rejects(s.auto.setWorkspaceEnabled('c:/work/app/', true), error => error.code === 'E_CONFLICT');
  assert.deepEqual(await s.auto.setWorkspaceEnabled('C:\\Work\\App\\', true), { enabled: true, changed: true });
  const kept = await readAutoState(s.store.dataDir);
  assert.deepEqual(Object.keys(kept.workspaces), ['c:/Work/App']);
  assert.deepEqual(workspaceSetting(kept, ['C:\\WORK\\APP']), { enabled: true, since: after(1) });
});

test('247-D5 a further switch is refused at the limit; no saved "off" is ever dropped', async t => {
  const s = await setup(t);
  const first = join(s.root, 'switch-0');
  for (let i = 0; i < 201; i++) { s.tick(new Date(Date.parse(START) + i * 1000).toISOString()); await s.auto.setWorkspaceEnabled(join(s.root, 'switch-' + i), false); }
  assert.equal(workspaceSetting(await readAutoState(s.store.dataDir), [first]).enabled, false, 'the 201st kept the first');
  const file = join(s.store.dataDir, 'auto-cards.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  for (let i = 201; i < 1000; i++) raw.workspaces[normalizeCwd(join(s.root, 'switch-' + i))] = { enabled: false, changedAt: after(1) };
  await fs.writeFile(file, JSON.stringify(raw));
  const bytes = await fs.readFile(file, 'utf8');
  await assert.rejects(s.auto.setWorkspaceEnabled(join(s.root, 'one-more'), false), error => error.code === 'E_LIMIT');
  assert.equal(await fs.readFile(file, 'utf8'), bytes, 'nothing changed');
  assert.equal(workspaceSetting(await readAutoState(s.store.dataDir), [first]).enabled, false);
  // A saved switch can still be turned back on, which makes room for the next.
  s.tick(after(2));
  assert.deepEqual(await s.auto.setWorkspaceEnabled(first, true), { enabled: true, changed: true });
  assert.equal(workspaceSetting(await readAutoState(s.store.dataDir), [join(s.root, 'switch-1')]).enabled, false);
  // A file holding more switches than that is not trimmed on reading: it is damaged, and nothing is made.
  raw.workspaces[normalizeCwd(join(s.root, 'over'))] = { enabled: false, changedAt: after(1) };
  raw.workspaces[normalizeCwd(join(s.root, 'over-2'))] = { enabled: false, changedAt: after(1) };
  await fs.writeFile(file, JSON.stringify(raw));
  assert.equal((await readAutoState(s.store.dataDir)).damaged, true);
});

// ---- 249: one judgement of a damaged or uncertain policy, obeyed by every path ----

/**
 * 249-D1/D2: the plugin's file is read in one place (server/core/auto-state.ts). Whatever the damage — the bytes, a rule
 * map that is an array or a string, one rule of the wrong type, a start line of the wrong type, another schema, too large,
 * a read error — the engine makes and moves nothing, the core creates no PROCESS.md, no switch is saved, the bytes stay,
 * and the screens show the folder as off and the tracking as held.
 */
const DAMAGE = [
  ['syntax', () => '{nope'],
  ['schema', v => ({ ...v, schemaVersion: 2 })],
  ['boards-null', v => ({ ...v, boards: null })],
  ['boards-string', v => ({ ...v, boards: 'broken' })],
  ['boards-array', v => ({ ...v, boards: [] })],
  ['intents-array', v => ({ ...v, boards: null, boardIntents: [] })],
  ['intent-rule', v => ({ ...v, boardIntents: { '/x': { cwd: '/x', agentId: '', at: after(1) } } })],
  ['workspaces-array', v => ({ ...v, workspaces: [] })],
  ['workspace-rule', v => ({ ...v, workspaces: { '/x': { enabled: 'no', changedAt: after(1) } } })],
  ['hosts-array', v => ({ ...v, hosts: [] })],
  ['host-rule', v => ({ ...v, hosts: { srv_test: { enabled: false, changedAt: 'invalid' } } })],
  ['floor', v => ({ ...v, autoBoardFloor: 'soon' })],
  ['activated', v => ({ ...v, activatedAt: 5 })],
  ['parents-array', v => ({ ...v, parents: [] })],
  ['agents-array', v => ({ ...v, agents: [] })],
  ['too-large', v => JSON.stringify(v).slice(0, -1) + ',"pad":"' + 'x'.repeat(8 * 1024 * 1024) + '"}'],
];
test('249-D1/D2 every damaged form of the file fails closed on every path: engine, export, saves and screens', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('made');
  s.row('wks_dmg01', dir);
  s.tick(after(1));
  const a = s.agent('wks_dmg01', dir);
  assert.equal(await s.auto.signal(a.hook, 'created', s.paseo), 'created');
  const [board] = await s.boards();
  const file = join(s.store.dataDir, 'auto-cards.json');
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  const read = createReadHandlers(s.store, undefined, undefined, undefined, () => s.auto.health());
  for (const [name, damage] of [...DAMAGE, ['read-error', null]]) {
    await fs.rm(file, { recursive: true, force: true });
    if (damage) { const bytes = damage(valid); await fs.writeFile(file, typeof bytes === 'string' ? bytes : JSON.stringify(bytes)); }
    else await fs.mkdir(file); // a directory in its place: the read fails with EISDIR, not ENOENT
    const before = damage ? await fs.readFile(file) : null;
    const state = await readAutoState(s.store.dataDir);
    assert.equal(state.damaged, true, name + ': damaged');
    // The engine: no move, no card, no board, and the screens hear of it.
    assert.equal(await s.auto.signal(a.hook, 'turn_ended', s.paseo), 'held', name + ': move');
    const next = await s.folder('next-' + name);
    s.row('wks_' + name.replace(/-/g, '').slice(0, 8), next);
    assert.equal(await s.auto.signal(s.agent('wks_' + name.replace(/-/g, '').slice(0, 8), next).hook, 'created', s.paseo), 'held', name + ': create');
    assert.deepEqual([s.auto.health().state, s.auto.health().detail], ['held', 'auto-cards.json'], name + ': health');
    assert.equal((await s.boards()).length, 1, name + ': boards');
    // The core's export: the board's maker cannot be told, so a person's commit creates no file.
    assert.equal(await quietBoard(s.store, board), true, name + ': quiet');
    await s.store.mutateBoard(board.id, { actor: { kind: 'user' }, requestId: randomUUID(),
      operations: [{ op: 'add', title: 'manual ' + name, intent: 'requested', acceptanceCriteria: 'none' }] });
    assert.equal(await s.exists(join(dir, 'PROCESS.md')), false, name + ': no PROCESS.md');
    // The saves: refused, and the bytes untouched.
    await assert.rejects(s.auto.setWorkspaceEnabled(dir, false), name + ': workspace save');
    await assert.rejects(s.auto.setEnabled('srv_test', false), name + ': host save');
    if (before) assert.ok((await fs.readFile(file)).equals(before), name + ': bytes');
    // The screens: every folder shown reads as off (nothing runs), and the tracking as held.
    const overview = await read.overview({ hostId: 'srv_test' });
    assert.deepEqual(overview.data.autoCardsOff, [normalizeCwd(board.cwd)], name + ': shown off');
    assert.equal(overview.data.autoHealth?.state, 'held', name + ': shown held');
    assert.equal(workspaceSetting(state, [dir]).enabled, false, name + ': judged off');
  }
  // Repaired (the valid bytes back): everything runs again, and the manual cards stayed.
  await fs.rm(file, { recursive: true, force: true });
  await fs.writeFile(file, JSON.stringify(valid));
  assert.equal(await s.auto.signal(a.hook, 'turn_ended', s.paseo), 'updated');
  assert.equal(s.auto.health().state, 'ok');
  assert.equal(await quietBoard(s.store, board), true);
  assert.equal(await s.exists(join(dir, 'PROCESS.md')), false);
  assert.equal((await s.store.readBoard(board.id)).cards.length, 1 + DAMAGE.length + 1);
});

test('249-D2 an "off" whose rule is damaged never reads as on: the host switch and the workspace switch alike', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('kept-off');
  s.row('wks_off01', dir);
  const file = join(s.store.dataDir, 'auto-cards.json');
  // The host switched off, then its rule damaged: not "no host entry, so on".
  await s.auto.setEnabled('srv_test', false);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...raw, hosts: { srv_test: { enabled: false, changedAt: 'invalid' } } }));
  const bytes = await fs.readFile(file, 'utf8');
  s.tick(after(1));
  assert.equal(await s.auto.signal(s.agent('wks_off01', dir).hook, 'created', s.paseo), 'held');
  assert.deepEqual(await s.boards(), []);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.equal(await s.auto.isEnabled('srv_test'), true, '249-J1: the host switch still shows what a missing rule would mean; the engine does not run');
  // The workspace switched off, then the map made an array: not "an empty map, so on".
  await fs.writeFile(file, JSON.stringify(raw));
  await s.auto.setWorkspaceEnabled(dir, false);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...saved, workspaces: [] }));
  assert.equal(await s.auto.signal(s.agent('wks_off01', dir).hook, 'created', s.paseo), 'held');
  assert.deepEqual(await s.boards(), []);
});

test('249-D1 the file is kept in a backup: deleted, its rules live on; a damaged backup is damage; both gone is the plain start', async t => {
  const s = await setup(t);
  await s.settle();
  const dir = await s.folder('backed');
  s.row('wks_bak01', dir);
  s.tick(after(1));
  const a = s.agent('wks_bak01', dir);
  assert.equal(await s.auto.signal(a.hook, 'created', s.paseo), 'created');
  const [board] = await s.boards();
  const file = join(s.store.dataDir, 'auto-cards.json'), backup = join(s.store.dataDir, 'auto-cards.backup.json');
  assert.ok((await fs.readFile(file)).equals(await fs.readFile(backup)), 'the same bytes');
  // The file deleted (248 §4 once called that a repair): the board stays quiet and older chats stay out, from the backup.
  await fs.rm(file);
  const state = await readAutoState(s.store.dataDir);
  assert.deepEqual([state.damaged, Object.keys(state.boards)], [undefined, [board.id]]);
  assert.equal(await quietBoard(s.store, board), true);
  await s.store.mutateBoard(board.id, { actor: { kind: 'user' }, requestId: randomUUID(),
    operations: [{ op: 'add', title: 'manual', intent: 'requested', acceptanceCriteria: 'none' }] });
  assert.equal(await s.exists(join(dir, 'PROCESS.md')), false);
  const again = createAutoCards({ store: s.store, locale: readLocale, now: () => after(2), log: () => {} });
  again.wake(s.paseo); await again.idle();
  const old = s.agent('wks_bak01', dir, { createdAt: before(30), status: 'running', lastUserMessageAt: after(2) });
  assert.equal(await again.signal(old.hook, 'turn_started', s.paseo), 'no-card');
  assert.equal((await s.store.readBoard(board.id)).cards.filter(c => c.agents.length).length, 1);
  // The next write puts the file back, equal to its backup.
  assert.equal(await again.signal(a.hook, 'turn_ended', s.paseo), 'updated');
  assert.ok((await fs.readFile(file)).equals(await fs.readFile(backup)));
  // The file gone and the backup unreadable: damage, not a first run.
  await fs.rm(file);
  await fs.writeFile(backup, '{nope');
  assert.equal((await readAutoState(s.store.dataDir)).damaged, true);
  assert.equal(await s.auto.signal(a.hook, 'turn_ended', s.paseo), 'held');
  assert.equal(await quietBoard(s.store, board), true);
  // Both gone: the plain start (a reset somebody chose), as documented.
  await fs.rm(backup);
  assert.deepEqual(await readAutoState(s.store.dataDir), { activatedAt: null, hosts: {}, agents: {}, parents: {}, autoBoardFloor: null, workspaces: {}, boards: {}, boardIntents: {}, leads: {} });
  assert.equal(await quietBoard(s.store, board), false);
});

test('249-D3 two Windows folders differing only in case keep their own switches; off in any spelling is off; a later off wins', async t => {
  const s = await setup(t);
  const A = 'C:\\Fixture\\A', a = 'C:\\Fixture\\a';
  const setting = async cwd => workspaceSetting(await readAutoState(s.store.dataDir), [cwd]);
  // Both off, each under its own spelling; then one back on: the other stays off.
  assert.deepEqual(await s.auto.setWorkspaceEnabled(A, false), { enabled: false, changed: true });
  assert.deepEqual(await s.auto.setWorkspaceEnabled(a, false), { enabled: false, changed: true });
  assert.deepEqual(await s.auto.setWorkspaceEnabled(a, false), { enabled: false, changed: false });
  s.tick(after(1));
  assert.deepEqual(await s.auto.setWorkspaceEnabled(a, true), { enabled: true, changed: true });
  assert.deepEqual([(await setting(A)).enabled, (await setting(a)).enabled], [false, true]);
  assert.deepEqual(Object.keys((await readAutoState(s.store.dataDir)).workspaces).sort(), ['c:/Fixture/A', 'c:/Fixture/a']);
  // A third spelling of the folder: off while any spelling of it is off (fail closed), and refused to be turned on.
  assert.equal((await setting('c:/fixture/a')).enabled, false);
  await assert.rejects(s.auto.setWorkspaceEnabled('c:/fixture/a', true), error => error.code === 'E_CONFLICT' && /c:\/Fixture\/A/.test(error.nextAction));
  // Turned off again under the other spelling later: the folder reads off until its own spelling is turned on again.
  s.tick(after(2));
  assert.deepEqual(await s.auto.setWorkspaceEnabled(A, true), { enabled: true, changed: true });
  s.tick(after(3));
  assert.deepEqual(await s.auto.setWorkspaceEnabled(a, false), { enabled: false, changed: true });
  assert.deepEqual([(await setting(A)).enabled, (await setting(a)).enabled], [false, false], 'a later off in another spelling wins');
  s.tick(after(4));
  assert.deepEqual(await s.auto.setWorkspaceEnabled(A, true), { enabled: true, changed: true });
  assert.deepEqual([await setting(A), (await setting(a)).enabled], [{ enabled: true, since: after(4) }, false]);
  // POSIX folders never fold.
  await s.auto.setWorkspaceEnabled('/Fixture/A', false);
  assert.equal((await setting('/Fixture/a')).enabled, true);
  // The screens: of the boards they show, the off ones by the spelling their rows carry; two rows for two folders.
  const read = createReadHandlers(s.store);
  const lower = await s.folder('posix-a'), upper = await s.folder('posix-A');
  await s.store.initBoard({ cwd: lower, actor: { kind: 'user' }, requestId: randomUUID(), export: false });
  await s.store.initBoard({ cwd: upper, actor: { kind: 'user' }, requestId: randomUUID(), export: false });
  await s.auto.setWorkspaceEnabled(upper, false);
  assert.deepEqual((await read.overview({ hostId: 'srv_test' })).data.autoCardsOff, [normalizeCwd(upper)]);
});

test('249-J5 at the limit the refusal names what frees room; turning a saved switch back on keeps its entry', async t => {
  const s = await setup(t);
  const file = join(s.store.dataDir, 'auto-cards.json');
  await s.auto.setWorkspaceEnabled(join(s.root, 'switch-0'), false);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  for (let i = 1; i < 1000; i++) raw.workspaces[normalizeCwd(join(s.root, 'switch-' + i))] = { enabled: false, changedAt: after(1) };
  await fs.writeFile(file, JSON.stringify(raw));
  s.tick(after(2));
  assert.deepEqual(await s.auto.setWorkspaceEnabled(join(s.root, 'switch-0'), true), { enabled: true, changed: true });
  assert.equal(Object.keys((await readAutoState(s.store.dataDir)).workspaces).length, 1000, 'an "on" keeps its start line, so its entry stays');
  await assert.rejects(s.auto.setWorkspaceEnabled(join(s.root, 'one-more'), false), error => error.code === 'E_LIMIT' &&
    /auto-cards\.json/.test(error.nextAction) && /remove/i.test(error.nextAction) && !/back on/.test(error.nextAction));
});
