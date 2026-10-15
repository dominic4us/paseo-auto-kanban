import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutoCards, worktreeRoot } from '../dist/server/auto-cards.js';
import { readLocale } from '../dist/server/handlers.js';
import { addProjectRoots, cwdKey, nameProjectRoots, overviewSelection, projectOptions, projectWorkspaceKeys,
  workspaceDetail, workspaceEntry, workspaceKey, workspaceLabel, workspaceName } from '../dist/client/presentation.js';
import { swimlaneModel } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, actor } from './helpers.mjs';

/**
 * D25: sample-app's Paseo workspaces are all worktrees, but an agent ran the CLI from the repository's
 * original path, so a board sits at the project root where no workspace is. That board belongs under
 * its project, and an agent in one of those worktrees records its card there when its worktree has no
 * board of its own. A board that really matches nothing still goes to "Not found in Paseo".
 */
const ROOT = '/work/MVP/sample-app';
const TREE = '/home/user/.paseo/worktrees/1ukmfvuw/splendid-pug';
const LOCAL = 'local_' + '7'.repeat(64);
const GONE = 'local_' + 'b'.repeat(64);

const entry = (id, cwd, projectId, projectName, name = projectName) =>
  ({ id, name, projectId, projectName, projectViewKey: projectId, labels: [], cwd });
/** The directory as `useDirectory` builds it: workspaces by id and directory, then the project roots. */
function directoryOf(workspaces, projects, locale = 'ko') {
  const directory = {};
  for (const w of workspaces) { directory[w.id] = w; directory[cwdKey(w.cwd)] = w; }
  addProjectRoots(directory, projects.map(p => ({ projectViewKey: p.projectId, ...p })));
  return nameProjectRoots(directory, copy(locale).projectRoot);
}
const summary = (id, workspaceId, cwd, extra = {}) => ({ id, workspaceId, cwd, workspaceStatus: 'active',
  revision: 'r:1', updatedAt: '2026-09-23T00:00:00.000Z', hasLedger: true,
  progress: { done: 0, requested: 1, draft: 0, archived: 0, percent: 0 }, ...extra });
function basicBoard(id, workspaceId, cwd, extra = {}) {
  const stages = [['todo', 'To Do'], ['doing', 'In progress'], ['review', 'Review'], ['done', 'Done']]
    .map(([stageId, name], index) => ({ stageId, name, countsAsDone: index === 3, cards: [], hiddenCount: 0, totalCount: 0 }));
  return { summary: summary(id, workspaceId, cwd, extra), agentLabels: {},
    template: { id: 'basic', version: 1, stages: stages.map(s => ({ stageId: s.stageId, name: s.name, countsAsDone: s.countsAsDone })) },
    stages };
}
const sample = { projectId: 'prj_d064', rootPath: ROOT, projectName: 'sample-app' };
const tree = entry('wks_2ede', TREE, 'prj_d064', 'sample-app');

test('D25 ① a board at a project root joins that project as its own named workspace row', () => {
  const directory = directoryOf([tree], [sample]);
  const root = workspaceEntry(directory, LOCAL, ROOT + '/');
  assert.equal(root.projectId, 'prj_d064');
  assert.equal(root.projectRoot, true);
  // REQ-65 ⑦: named after its project like the worktree beside it; "original path" is its detail, and the
  // worktree's folder is its own, so the two rows never read alike.
  assert.equal(workspaceName(LOCAL, ROOT, directory), 'sample-app');
  assert.equal(workspaceDetail(directory, LOCAL, ROOT), '원래 경로');
  assert.equal(workspaceLabel(LOCAL, ROOT, directoryOf([tree], [sample], 'en')), 'sample-app · original path');
  assert.equal(workspaceLabel('wks_2ede', TREE, directory), 'sample-app · splendid-pug');
  assert.equal(workspaceKey(directory, LOCAL, ROOT), 'root:prj_d064', 'a placed position has a stable key');
  // The worktree lane (empty, synthesized) and the root board share one project in both layouts.
  const boards = [basicBoard('board_root', LOCAL, ROOT),
    basicBoard('empty:wks_2ede', 'wks_2ede', TREE, { hasLedger: false, updatedAt: '', progress: { done: 0, requested: 0, draft: 0, archived: 0, percent: null } })];
  for (const model of [swimlaneModel(boards, directory, [], false), mobileSwimlaneModel(boards, directory, [], false, {}, 'todo')]) {
    assert.deepEqual(model.groups.map(g => g.projectId), ['prj_d064'], 'no "not found" group');
    const [group] = model.groups;
    assert.equal(group.merged, undefined, 'REQ-75: no merged form any more');
    assert.equal(group.workspaceCount, 2);
    assert.deepEqual(group.lanes.map(l => l.workspaceKey), ['root:prj_d064', 'wks_2ede']);
  }
  // Ordering: the root row is a key of the project like any other, so the order menu can move it.
  assert.deepEqual(projectWorkspaceKeys(boards, directory, 'prj_d064'), ['root:prj_d064', 'wks_2ede']);
  const arranged = swimlaneModel(boards, directory, [], false, {}, { order: { projects: [], workspaces: ['wks_2ede', 'root:prj_d064'] } });
  assert.deepEqual(arranged.groups[0].lanes.map(l => l.workspaceKey), ['wks_2ede', 'root:prj_d064']);
  // Hiding the project hides the root row with it, and the filter lists no leftover entry.
  assert.deepEqual(swimlaneModel(boards, directory, ['prj_d064'], false).groups, []);
  assert.deepEqual([...projectOptions(boards.map(b => b.summary), directory, 'x')], [['prj_d064', 'sample-app']]);
  // The list screen files it under the project too.
  const data = { locale: 'ko', observedAt: '', errors: [], attention: [],
    boards: [summary('board_gone', GONE, '/srv/deleted'), summary('board_root', LOCAL, ROOT)] };
  assert.deepEqual(overviewSelection(data, directory, [], 'all').boards.map(b => b.id), ['board_root', 'board_gone']);
});

test('D25 ① a root that already is a workspace, or that two projects claim, gets no extra row', () => {
  const checkout = entry('wks_main', ROOT, 'prj_d064', 'sample-app', 'main checkout');
  const directory = directoryOf([checkout, tree], [sample]);
  assert.equal(workspaceEntry(directory, LOCAL, ROOT), checkout, 'the real workspace keeps its directory');
  assert.equal(workspaceName(LOCAL, ROOT, directory), 'main checkout');
  const twice = directoryOf([], [sample, { projectId: 'prj_copy', rootPath: ROOT + '/', projectName: 'copy' }]);
  assert.equal(workspaceEntry(twice, LOCAL, ROOT), undefined, 'an ambiguous root is not guessed');
  // A project with no workspace at all still claims its root folder.
  assert.equal(workspaceEntry(directoryOf([], [sample]), LOCAL, ROOT).projectId, 'prj_d064');
});

test('D25 ③ a board that matches no workspace and no project root stays "Not found in Paseo", at the bottom', () => {
  const directory = directoryOf([tree], [sample]);
  const boards = [basicBoard('board_gone', GONE, '/work/MVP/somewhere-else'), basicBoard('board_root', LOCAL, ROOT)];
  const model = swimlaneModel(boards, directory, [], false);
  assert.deepEqual(model.groups.map(g => g.projectId), ['prj_d064', '']);
  assert.deepEqual(model.groups[1].lanes.map(l => l.board.summary.id), ['board_gone']);
  // A folder inside the root is not the root.
  assert.equal(workspaceEntry(directory, GONE, ROOT + '/packages/app'), undefined);
  const m = copy('ko');
  assert.deepEqual([...projectOptions(boards.map(b => b.summary), directory, m.unlinked)],
    [['prj_d064', 'sample-app'], ['', m.unlinked]]);
});

// ---- ② automatic cards ----

const listing = (entries) => {
  let calls = 0;
  return { calls: () => calls, workspaces: { list: async () => { calls++; return { entries, pageInfo: { nextCursor: null } }; } } };
};
const lister = (workspaces) => ({ agents: { list: async () => ({ entries: [], pageInfo: { nextCursor: null } }) }, workspaces });
const worktreeRow = (id, dir, root, kind = 'worktree') => ({ id, projectId: 'prj_d064', projectRootPath: root,
  workspaceDirectory: dir, workspaceKind: kind, name: 'splendid-pug', archivingAt: null });

/** A ledger whose only board sits at the project root (the fixture's own board plays that part). */
async function setup(t) {
  const f = await fixture(t);
  const auto = createAutoCards({ store: f.store, locale: readLocale, log: () => {} });
  const tree = join(f.root, 'worktrees', 'splendid-pug'); await fs.mkdir(tree, { recursive: true });
  const cardsOf = async (boardId, agentId) => (await f.store.readBoard(boardId)).cards.filter(c => c.agents.some(a => a.agentId === agentId));
  return { ...f, auto, tree, cardsOf };
}
const agentIn = (workspaceId, cwd, extra = {}) => ({ id: randomUUID(), workspaceId, parentAgentId: null, cwd,
  title: '[검증용] D25 — 곧 보관', ...extra });

test('D25 ② an agent in a worktree without a board of its own gets its card on the project root board', async t => {
  const s = await setup(t);
  const api = listing([worktreeRow('wks_tree01', s.tree, s.cwd + '/')]);
  const agent = agentIn('wks_tree01', s.tree);
  assert.equal(await s.auto.signal(agent, 'created', lister(api.workspaces)), 'created');
  const [card, ...more] = await s.cardsOf(s.id, agent.id);
  assert.equal(more.length, 0);
  assert.deepEqual([card.title, card.stageId], ['[검증용] D25 — 곧 보관', 'todo']);
  // Its later signals follow the card there — the joining rule is unchanged, and nothing is listed again.
  assert.equal(await s.auto.signal(agent, 'turn_started', lister(api.workspaces)), 'updated');
  assert.equal((await s.cardsOf(s.id, agent.id))[0].stageId, 'doing');
  assert.equal(api.calls(), 1, 'the listing is read only to place a new card');
  // Found by directory when the hook has no workspace id; a sub-agent is still left alone.
  const byCwd = agentIn(null, s.tree + '/');
  assert.equal(await s.auto.signal(byCwd, 'created', lister(api.workspaces)), 'created');
  const child = agentIn('wks_tree01', s.tree, { parentAgentId: agent.id });
  assert.equal(await s.auto.signal(child, 'created', lister(api.workspaces)), 'child');
  assert.equal((await s.store.listBoards()).length, 1, 'no board was made');
});

test('D25 ② a worktree that has its own board keeps its cards there', async t => {
  const s = await setup(t);
  const own = await s.store.initBoard({ cwd: s.tree, workspaceId: 'wks_tree01', actor, requestId: randomUUID() });
  const api = listing([worktreeRow('wks_tree01', s.tree, s.cwd)]);
  const agent = agentIn('wks_tree01', s.tree);
  assert.equal(await s.auto.signal(agent, 'created', lister(api.workspaces)), 'created');
  assert.equal((await s.cardsOf(own.data.boardId, agent.id)).length, 1);
  assert.equal((await s.cardsOf(s.id, agent.id)).length, 0);
  assert.equal(api.calls(), 0, 'its own board is found without asking Paseo');
});

test('D25 ② nothing happens without a root board, outside a worktree, or when Paseo cannot answer', async t => {
  const s = await setup(t);
  const elsewhere = join(s.root, 'elsewhere');
  const before = (await s.store.readBoard(s.id)).revision;
  const cases = [
    // The worktree's project root has no board.
    [worktreeRow('wks_tree01', s.tree, elsewhere), agentIn('wks_tree01', s.tree)],
    // A plain checkout elsewhere is not a worktree of this root, even if Paseo names the same root.
    [worktreeRow('wks_dir01', s.tree, s.cwd, 'local_checkout'), agentIn('wks_dir01', s.tree)],
    // The workspace is not in the listing at all.
    [worktreeRow('wks_other01', join(s.root, 'other'), s.cwd), agentIn('wks_tree01', s.tree)],
  ];
  for (const [row, agent] of cases)
    assert.equal(await s.auto.signal(agent, 'created', lister(listing([row]).workspaces)), 'no-board', JSON.stringify(row));
  const failing = { list: async () => { throw new Error('Synthetic listing failure'); } };
  assert.equal(await s.auto.signal(agentIn('wks_tree01', s.tree), 'created', lister(failing)), 'no-board');
  assert.equal(await s.auto.signal(agentIn('wks_tree01', s.tree), 'created'), 'no-board', 'no SDK, no fallback');
  assert.equal((await s.store.readBoard(s.id)).revision, before, 'the root board was not written');
  assert.equal((await s.store.listBoards()).length, 1, 'no board was made');
  // Switched off stays off.
  await s.auto.setEnabled('srv_test', false);
  assert.equal(await s.auto.signal(agentIn('wks_tree01', s.tree), 'created',
    lister(listing([worktreeRow('wks_tree01', s.tree, s.cwd)]).workspaces)), 'disabled');
});

test('D25 ② the workspace lookup: id before directory, archiving rows ignored by directory, pages followed', async t => {
  const pages = [
    { entries: [worktreeRow('wks_a', '/w/a', '/root/by-cwd'), { ...worktreeRow('wks_z', '/w/z', '/root/archiving'), archivingAt: 'x' }],
      pageInfo: { nextCursor: 'p2' } },
    { entries: [worktreeRow('wks_b', '/w/b', '/root/by-id')], pageInfo: { nextCursor: null } },
  ];
  const workspaces = { list: async ({ page }) => pages[page.cursor ? 1 : 0] };
  assert.equal(await worktreeRoot(workspaces, { workspaceId: 'wks_b', cwd: '/w/a' }), '/root/by-id');
  assert.equal(await worktreeRoot(workspaces, { workspaceId: null, cwd: '/w/a/' }), '/root/by-cwd');
  assert.equal(await worktreeRoot(workspaces, { workspaceId: null, cwd: '/w/z' }), null);
  assert.equal(await worktreeRoot({ list: async () => ({ entries: [], pageInfo: { nextCursor: 'loop' } }) },
    { workspaceId: 'wks_x', cwd: '' }), null, 'a cursor that does not advance ends the read');
});
