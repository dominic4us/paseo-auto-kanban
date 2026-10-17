import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, createKanbanError } from '../dist/server/core/index.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { createEnsureHandler } from '../dist/server/mutations.js';
import { emptyWorkspaces } from '../dist/server/read-model.js';
import { overviewGet, boardEnsure, normalizeCwd } from '../dist/shared/rpc.js';
import { cwdKey, overviewSelection, projectOptions, workspaceEntry, workspaceName, workspaceProjectId } from '../dist/client/presentation.js';
import { swimlaneModel } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { createDemoData } from '../dist/client/demo.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, request, add, actor } from './helpers.mjs';

/**
 * D22: three boards on this machine were initialized before Paseo had a workspace at their directory,
 * so their ledger identity is `local_<hash(cwd)>` and `workspaces.list` has never contained it. These
 * tests hold the repair: the directory re-matches the board to its workspace, the lane is not drawn
 * twice, a card still lands in the original ledger, and the leftovers are named for what they are.
 */
const LOCAL = 'local_' + 'a'.repeat(64);
const OTHER = 'local_' + 'b'.repeat(64);

function ok(result, contract) {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (contract) contract.output.parse(result);
  return result.data;
}
function workspaceApi(entries) {
  let calls = 0;
  return { calls: () => calls, paseo: { workspaces: { list: async () => { calls++;
    return { entries, pageInfo: { nextCursor: null } }; } } } };
}
const entry = (id, cwd, projectId, projectName) =>
  ({ id, name: id, projectId, projectName, projectViewKey: projectId, labels: [], cwd });
/** The directory exactly as `useDirectory` builds it: one key per id and one per canonical directory. */
function directoryOf(...rows) {
  const directory = {};
  for (const row of rows) { directory[row.id] = row; directory[cwdKey(row.cwd)] = row; }
  return directory;
}
const summary = (id, workspaceId, cwd, extra = {}) => ({ id, workspaceId, cwd, workspaceStatus: 'active',
  revision: 'r:1', updatedAt: '2026-01-01T00:00:00.000Z',
  progress: { done: 0, requested: 0, draft: 0, archived: 0, percent: null }, ...extra });
function basicBoard(id, workspaceId, cwd) {
  const stages = [['todo', 'To Do'], ['doing', 'In progress'], ['review', 'Review'], ['done', 'Done']]
    .map(([stageId, name], index) => ({ stageId, name, countsAsDone: index === 3, cards: [], hiddenCount: 0, totalCount: 0 }));
  return { summary: summary(id, workspaceId, cwd), agentLabels: {},
    template: { id: 'basic', version: 1, stages: stages.map(s => ({ stageId: s.stageId, name: s.name, countsAsDone: s.countsAsDone })) },
    stages };
}

test('D22 ① a board keeps its workspace when only the directory still matches', () => {
  const real = entry('wks_real01', '/srv/projects/MVP/toolbox', 'prj_a', 'MVP');
  const directory = directoryOf(real);
  // Trailing separators and NFD spelling are the two differences the same directory can have.
  for (const cwd of ['/srv/projects/MVP/toolbox', '/srv/projects/MVP/toolbox/', '/srv/projects/MVP/toolbox//']) {
    assert.equal(workspaceEntry(directory, LOCAL, cwd), real, cwd);
    assert.equal(workspaceProjectId(directory, LOCAL, cwd), 'prj_a');
    assert.equal(workspaceName(LOCAL, cwd, directory), 'wks_real01');
  }
  const decomposed = entry('wks_ko01', '로고타입'.normalize('NFD'), 'prj_k', '한투');
  const koreanDirectory = directoryOf(decomposed);
  assert.equal(workspaceEntry(koreanDirectory, LOCAL, '로고타입'.normalize('NFC')), decomposed);
  assert.equal(normalizeCwd('로고타입'.normalize('NFD')), normalizeCwd('로고타입'.normalize('NFC')));
  // A board Paseo really has no workspace for still falls back to the directory's last segment.
  assert.equal(workspaceEntry(directory, OTHER, '/srv/projects/gone'), undefined);
  assert.equal(workspaceName(OTHER, '/srv/projects/gone', directory), 'gone');
});

test('D22 ① a re-matched board joins its project and the unmatched ones sort to the bottom', () => {
  const directory = directoryOf(entry('wks_real01', '/srv/projects/MVP/toolbox', 'prj_a', 'MVP'));
  const boards = [basicBoard('board_1', LOCAL, '/srv/projects/MVP/toolbox'),
    basicBoard('board_2', OTHER, '/srv/projects/deleted')];
  const model = swimlaneModel(boards, directory, [], false);
  assert.deepEqual(model.groups.map(g => g.projectId), ['prj_a', ''], 'the leftovers group is last');
  assert.deepEqual(model.groups[0].lanes.map(l => l.board.summary.id), ['board_1']);
  assert.equal(model.groups[0].projectName, 'MVP');
  // Hiding the project hides the re-matched lane, which is what the filter promises.
  assert.deepEqual(swimlaneModel(boards, directory, ['prj_a'], false).groups.map(g => g.projectId), ['']);
  assert.deepEqual(mobileSwimlaneModel(boards, directory, [], false, {}, 'todo').groups.map(g => g.projectId), ['prj_a', '']);
  const m = copy('ko');
  assert.deepEqual([...projectOptions(boards.map(b => b.summary), directory, m.unlinked)],
    [['prj_a', 'MVP'], ['', m.unlinked]]);
  // ①: with nothing left over the filter has no "not found" row at all.
  assert.deepEqual([...projectOptions([boards[0].summary], directory, m.unlinked)], [['prj_a', 'MVP']]);
});

test('D22 ④ the leftover group says the workspace is not in Paseo', () => {
  assert.equal(copy('ko').unlinked, 'Paseo에 없는 워크스페이스');
  assert.equal(copy('en').unlinked, 'Not found in Paseo');
});

test('D22 ⑥ the list screen groups and sorts a re-matched board by its real project', () => {
  const directory = directoryOf(entry('wks_real01', '/srv/projects/MVP/toolbox', 'prj_a', 'MVP'));
  const data = { locale: 'en', observedAt: '', errors: [],
    boards: [summary('board_1', LOCAL, '/srv/projects/MVP/toolbox', { needsHuman: 0 }),
      summary('board_2', OTHER, '/srv/projects/deleted', { needsHuman: 0 })],
    attention: [{ id: 'card_1', workspaceId: LOCAL, cwd: '/srv/projects/MVP/toolbox', reasons: ['awaitingUser'] }] };
  assert.deepEqual(overviewSelection(data, directory, [], 'all').boards.map(b => b.id), ['board_1', 'board_2']);
  assert.deepEqual(overviewSelection(data, directory, ['prj_a'], 'all').boards.map(b => b.id), ['board_2']);
  assert.equal(overviewSelection(data, directory, ['prj_a'], 'all').attention.length, 0,
    'attention follows the same re-match, so a hidden project hides its cards');
  // The demo data has no leftovers, so its filter never grows a "not found" row.
  const demo = createDemoData();
  assert.ok([...projectOptions(demo.boards.map(b => b.summary), demo.directory, 'x')].every(([id]) => id !== ''));
});

test('D22 ① one lane, not two: a directory that already has a board is never synthesized as empty', async t => {
  const f = await fixture(t);
  const local = join(f.root, 'legacy'); await fs.mkdir(local);
  await f.store.initBoard({ cwd: local, actor, requestId: randomUUID() });
  const boards = await f.store.listBoards();
  const legacy = boards.find(b => b.cwd === local);
  assert.match(legacy.workspaceId, /^local_[0-9a-f]{64}$/, 'no Paseo record here, so the id stays local');
  assert.deepEqual(emptyWorkspaces([{ workspaceId: legacy.workspaceId, cwd: local }],
    [{ id: 'wks_later01', cwd: local + '/' }]), [], 'the same directory is one workspace');
  const api = workspaceApi([
    { id: 'wks_example01', name: 'Has board', projectId: 'prj_a', workspaceDirectory: f.cwd },
    { id: 'wks_later01', name: 'Made after the board', projectId: 'prj_a', workspaceDirectory: local },
    { id: 'wks_empty01', name: 'Really empty', projectId: 'prj_b', workspaceDirectory: '/tmp/empty-one' },
  ]);
  const handlers = createReadHandlers(f.store, () => '2026-01-01T00:00:00.000Z');
  const data = ok(await handlers.overview({ includeBoards: true }, api.paseo), overviewGet);
  assert.equal(api.calls(), 1, '② no extra round trip: the re-match uses the listing already read');
  const ids = data.boardViews.map(b => b.summary.workspaceId);
  assert.equal(ids.filter(id => id === 'wks_later01').length, 0, 'no synthesized twin for the legacy board');
  assert.equal(ids.filter(id => id === legacy.workspaceId).length, 1, 'the ledger board is the only lane');
  assert.deepEqual(data.boardViews.filter(b => b.summary.hasLedger === false).map(b => b.summary.workspaceId), ['wks_empty01']);
});

test('D22 ③ the + of a re-matched lane writes into the existing board, never a second one', async t => {
  const f = await fixture(t);
  const local = join(f.root, 'legacy'); await fs.mkdir(local);
  const init = await f.store.initBoard({ cwd: local, actor, requestId: randomUUID() });
  const before = (await f.store.listBoards()).length;
  const resolve = async (_paseo, workspaceId) => {
    if (workspaceId !== 'wks_later01') throw createKanbanError('E_NOT_FOUND', 'Unknown.', workspaceId, 'Open it in Paseo.');
    return { id: 'wks_later01', cwd: local + '/' };
  };
  const ensure = createEnsureHandler(f.store, resolve);
  const reply = ok(await ensure({ workspaceId: 'wks_later01', requestId: randomUUID(),
    operations: [{ op: 'add', title: 'First idea' }] }), boardEnsure);
  assert.equal(reply.boardId, init.data.boardId, 'the existing ledger takes the card');
  assert.equal(reply.created, false, 'nothing was initialized');
  assert.equal((await f.store.listBoards()).length, before, 'no second board at this directory');
  const board = await f.store.readBoard(init.data.boardId);
  assert.match(board.workspaceId, /^local_/, 'the ledger keeps its identity; migration is out of scope');
  assert.deepEqual(board.cards.map(c => c.title), ['First idea']);
});

/** ⑤ the root cause: `kanban init` had no source for a workspace id, so it minted a local one. */
async function paseoHomeFixture(t, rows) {
  const home = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'kanban-paseo-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(join(home, 'projects'), { recursive: true });
  if (rows !== null) await fs.writeFile(join(home, 'projects', 'workspaces.json'), JSON.stringify(rows));
  return home;
}
async function initAt(t, home, cwd, options = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'kanban-init-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const store = await openStore({ dataDir: join(root, 'data'), environment: { PASEO_HOME: home }, ...options });
  const result = await store.initBoard({ cwd, actor, requestId: randomUUID() });
  return { store, board: await store.readBoard(result.data.boardId) };
}
test('D22 ⑤ init takes the workspace id from Paseo\'s own record instead of minting a local one', async t => {
  const cwd = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'kanban-cwd-'));
  t.after(async () => { await fs.rm(cwd, { recursive: true, force: true }); });
  const home = await paseoHomeFixture(t, [
    { workspaceId: 'wks_gone01', cwd, archivedAt: '2026-01-01T00:00:00.000Z' },
    { workspaceId: 'wks_found01', cwd: cwd + '/', archivedAt: null },
    { workspaceId: 'wks_other01', cwd: cwd + '/child', archivedAt: null },
  ]);
  const found = await initAt(t, home, cwd);
  assert.equal(found.board.workspaceId, 'wks_found01', 'the live record wins over the archived one');
  // An existing board at the directory still owns it: identities never move under a running board.
  const again = await found.store.initBoard({ cwd, actor, requestId: randomUUID() });
  assert.equal((await found.store.readBoard(again.data.boardId)).workspaceId, 'wks_found01');
  // No record, a malformed record and an ambiguous directory all leave the local id in place.
  for (const rows of [null, { not: 'an array' }, 'garbage',
    [{ workspaceId: 'wks_one01', cwd, archivedAt: null }, { workspaceId: 'wks_two01', cwd, archivedAt: null }],
    [{ workspaceId: 'not-a-workspace', cwd, archivedAt: null }]]) {
    const other = await paseoHomeFixture(t, rows);
    const made = await initAt(t, other, cwd);
    assert.match(made.board.workspaceId, /^local_[0-9a-f]{64}$/, JSON.stringify(rows));
  }
  // An explicit id always wins, so `kanban init --workspace-id` and board.ensure are unaffected.
  const explicitRoot = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'kanban-init-'));
  t.after(async () => { await fs.rm(explicitRoot, { recursive: true, force: true }); });
  const store = await openStore({ dataDir: join(explicitRoot, 'data'), environment: { PASEO_HOME: home } });
  const explicit = await store.initBoard({ cwd, workspaceId: 'wks_explicit01', actor, requestId: randomUUID() });
  assert.equal((await store.readBoard(explicit.data.boardId)).workspaceId, 'wks_explicit01');
});
