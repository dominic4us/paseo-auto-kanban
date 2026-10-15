import test from 'node:test';
import assert from 'node:assert/strict';
import { filledLanes, filledProjects, swimlaneModel } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { emptyLaneOrder, layerOf, orderActions } from '../dist/client/order-model.js';
import { addProjectRoots, cwdKey, nameProjectRoots, overviewSelection, sameName, workspaceDetail, workspaceLabel,
  workspaceName } from '../dist/client/presentation.js';
import { copy } from '../dist/client/i18n.js';

/**
 * REQ-64: rows with cards and card-less rows are two layers. The user's order (REQ-59) and then the automatic
 * keys apply inside a layer; a move never crosses layers. REQ-65: names follow Paseo's sidebar hierarchy.
 */
const STAGES = [['todo', 'To Do'], ['doing', 'In progress'], ['review', 'Review'], ['done', 'Done']];
function lane(id, workspaceId, cards = 0, { attention = false, updatedAt = '2026-09-01T00:00:00.000Z' } = {}) {
  const stages = STAGES.map(([stageId, name], index) => ({ stageId, name, countsAsDone: index === 3, hiddenCount: 0,
    totalCount: index === 0 ? cards : 0,
    cards: index === 0 ? Array.from({ length: cards }, (_, n) => ({ id: id + '_c' + n, title: 'Card ' + n, nextAction: '',
      awaiting: attention && n === 0 ? 'user' : null, blocked: false, priority: 'normal', intent: 'requested',
      updatedAt, agents: [], labels: [] })) : [] }));
  return { summary: { id, workspaceId, cwd: '/w/' + workspaceId, workspaceStatus: 'active', revision: 'r', updatedAt,
    hasLedger: true, progress: { done: 0, requested: cards, draft: 0, archived: 0, percent: cards ? 0 : null } },
    agentLabels: {}, stages,
    template: { id: 'basic', version: 1, stages: stages.map(s => ({ stageId: s.stageId, name: s.name, countsAsDone: s.countsAsDone })) } };
}
const entry = (id, projectId, name, extra = {}) =>
  ({ id, name, projectId, projectName: projectId.toUpperCase(), projectViewKey: projectId, labels: [], cwd: '/w/' + id, ...extra });
// Four projects: a and c hold cards, b and d do not. Project a has one lane with cards and two without.
const directory = {
  a1: entry('a1', 'pa', 'A one'), a2: entry('a2', 'pa', 'A two'), a3: entry('a3', 'pa', 'A three'),
  b1: entry('b1', 'pb', 'B one'), c1: entry('c1', 'pc', 'C one'), d1: entry('d1', 'pd', 'D one'),
};
const boards = [lane('A1', 'a1', 2), lane('A2', 'a2'), lane('A3', 'a3'), lane('B1', 'b1'),
  lane('C1', 'c1', 1, { attention: true, updatedAt: '2026-09-02T00:00:00.000Z' }), lane('D1', 'd1'), lane('X1', 'local_gone', 3)];
const projects = model => model.groups.map(g => g.projectId);
const lanesOf = (model, id) => model.groups.find(g => g.projectId === id).lanes.map(l => l.workspaceKey);

test('REQ-64 ①②③ two layers: a stored order arranges each layer but never lifts a card-less row, and D22 stays last', () => {
  const auto = swimlaneModel(boards, directory, [], false);
  assert.deepEqual(projects(auto), ['pc', 'pa', 'pb', 'pd', ''], 'automatic: attention first, then the other with cards, then the rest');
  assert.deepEqual(lanesOf(auto, 'pa'), ['a1', 'a3', 'a2'], 'card-less lanes last, then by name');
  // The symptom: one use of the menu stored every project, card-less ones first. The layers still hold.
  const legacy = { projects: ['pd', 'pb', 'pa', 'pc'], workspaces: ['a2', 'a3', 'a1'] };
  const arranged = swimlaneModel(boards, directory, [], false, {}, { order: legacy });
  assert.deepEqual(projects(arranged), ['pa', 'pc', 'pd', 'pb', ''], 'inside each layer the stored order wins over the automatic keys');
  assert.deepEqual(lanesOf(arranged, 'pa'), ['a1', 'a2', 'a3'], 'a1 leads though listed last: it holds the cards');
  // A card arriving moves a project up a layer; a card leaving moves it down — no write needed.
  const later = boards.map(b => b.summary.id === 'D1' ? lane('D1', 'd1', 1) : b.summary.id === 'C1' ? lane('C1', 'c1') : b);
  assert.deepEqual(projects(swimlaneModel(later, directory, [], false, {}, { order: legacy })), ['pd', 'pa', 'pb', 'pc', '']);
  // An unplaced row sorts automatically behind the placed ones of its own layer.
  assert.deepEqual(projects(swimlaneModel(boards, directory, [], false, {}, { order: { projects: ['pa'], workspaces: [] } })),
    ['pa', 'pc', 'pb', 'pd', '']);
  // 390px reads the same model.
  assert.deepEqual(projects(mobileSwimlaneModel(boards, directory, [], false, {}, 'todo', { order: legacy })), ['pa', 'pc', 'pd', 'pb', '']);
  // A search shows only the matching rows, still in layer order (the orphan group keeps the bottom).
  const searched = swimlaneModel(boards, directory, [], false, {}, { order: legacy, query: 'Card 1' });
  assert.deepEqual(projects(searched), ['pa', '']);
  assert.deepEqual(filledProjects(arranged.groups), new Set(['pa', 'pc', '']));
  assert.deepEqual(filledLanes(arranged.groups[0].lanes), new Set(['a1']));
});

test('REQ-64 ③ the list screen lists the same two layers', () => {
  const data = { locale: 'en', observedAt: '', errors: [], attention: [], boards: boards.map(b => ({ ...b.summary, needsHuman: 0 })) };
  const legacy = { projects: ['pd', 'pb', 'pa', 'pc'], workspaces: ['a2', 'a3', 'a1'] };
  assert.deepEqual(overviewSelection(data, directory, [], 'all', legacy).boards.map(b => b.id), ['A1', 'A2', 'A3', 'C1', 'D1', 'B1', 'X1']);
  // A draft counts as a card, like on the board.
  const drafted = { ...data, boards: data.boards.map(b => b.id === 'B1' ? { ...b, progress: { ...b.progress, draft: 1 } } : b) };
  assert.deepEqual(overviewSelection(drafted, directory, [], 'all', legacy).boards.map(b => b.id), ['B1', 'A1', 'A2', 'A3', 'C1', 'D1', 'X1']);
});

test('REQ-64 ④ a move stays in its layer, disables at the layer ends, and pins that layer only', () => {
  const model = swimlaneModel(boards, directory, [], false);
  const movable = model.groups.filter(g => g.projectId), ids = movable.map(g => g.projectId);
  assert.deepEqual(layerOf(ids, filledProjects(movable), 'pb'), ['pb', 'pd']);
  assert.deepEqual(layerOf(ids, undefined, 'pb'), ids, 'without layers the whole group is one');
  let order = emptyLaneOrder();
  const arrange = orderActions(order, next => { order = next; }, ids, filledProjects(movable));
  const bounds = id => [arrange.project(id).canUp, arrange.project(id).canDown];
  assert.deepEqual(ids.map(bounds), [[false, true], [true, false], [false, true], [true, false]],
    'pc/pa and pb/pd: the last row with cards cannot go down, the first card-less row cannot go up');
  arrange.project('pd').onMove('top');
  assert.deepEqual(order, { projects: ['pd', 'pb'], workspaces: [] }, 'only the card-less layer is pinned');
  assert.deepEqual(projects(swimlaneModel(boards, directory, [], false, {}, { order })), ['pc', 'pa', 'pd', 'pb', '']);
  // Lanes: the one lane with cards is alone in its layer.
  const group = model.groups.find(g => g.projectId === 'pa'), keys = group.lanes.map(l => l.workspaceKey);
  const filled = filledLanes(group.lanes);
  assert.deepEqual([arrange.lane(keys, 'a1', filled).canUp, arrange.lane(keys, 'a1', filled).canDown], [false, false]);
  assert.deepEqual([arrange.lane(keys, 'a3', filled).canUp, arrange.lane(keys, 'a3', filled).canDown], [false, true]);
  assert.deepEqual([arrange.lane(keys, 'a2', filled).canUp, arrange.lane(keys, 'a2', filled).canDown], [true, false]);
  order = emptyLaneOrder();
  orderActions(order, next => { order = next; }, ids, filledProjects(movable)).lane(keys, 'a2', filled).onMove('top');
  assert.deepEqual(order.workspaces, ['a2', 'a3'], '"top" is the top of the card-less layer, under a1');
  assert.deepEqual(lanesOf(swimlaneModel(boards, directory, [], false, {}, { order }), 'pa'), ['a1', 'a2', 'a3']);
  // A stored list from before REQ-64 is read as is and rewritten in the same shape: the moved layer takes the
  // slots it already had, keys of the other layer keep theirs.
  order = { projects: ['pd', 'pb', 'pa', 'pc'], workspaces: [] };
  const shown = swimlaneModel(boards, directory, [], false, {}, { order }).groups.filter(g => g.projectId);
  orderActions(order, next => { order = next; }, shown.map(g => g.projectId), filledProjects(shown)).project('pc').onMove('up');
  assert.deepEqual(order.projects, ['pd', 'pb', 'pc', 'pa']);
});

test('REQ-65 ⑤⑥⑦ names: same name up to case, `branch · folder`, and the root row', () => {
  assert.equal(sameName('Acme_Logotype', 'acme_logotype'), true);
  assert.equal(sameName(' Pine  Yard ', 'pine yard'), true);
  assert.equal(sameName('Acme_Logotype', 'acme-logotype'), false, 'only case and spacing are ignored');
  const dir = {
    w1: entry('w1', 'pa', 'Landing', { branch: 'feature/landing', cwd: '/wt/brave-otter' }),
    w2: entry('w2', 'pa', 'main', { branch: 'main', cwd: '/repo/app' }),
    w3: entry('w3', 'pa', 'app', { cwd: '/repo/app/' }),
    w4: entry('w4', 'pa', 'Brave-Otter', { branch: 'brave-otter', cwd: '/wt/brave-otter' }),
  };
  assert.equal(workspaceDetail(dir, 'w1', ''), 'feature/landing · brave-otter');
  assert.equal(workspaceDetail(dir, 'w2', ''), 'app', 'a workspace named after its branch does not say it twice');
  assert.equal(workspaceDetail(dir, 'w3', ''), '', 'nor after its folder');
  assert.equal(workspaceDetail(dir, 'w4', ''), '', 'branch and folder equal to the name up to case');
  assert.equal(workspaceDetail(dir, 'local_gone', '/srv/old/thing'), '', 'a board Paseo does not know shows its folder as its name');
  assert.equal(workspaceLabel('w1', '', dir), 'Landing · feature/landing · brave-otter');
  // ⑦ the root row: the project's name, "original path" and its folder when that is another name.
  for (const [locale, place] of [['ko', '원래 경로'], ['en', 'original path']]) {
    const roots = { ...dir };
    addProjectRoots(roots, [{ projectId: 'pa', rootPath: '/repo/landing-site', projectName: 'Landing', projectViewKey: 'pa' }]);
    const named = nameProjectRoots(roots, copy(locale).projectRoot);
    assert.equal(workspaceName('local_x', '/repo/landing-site', named), 'Landing');
    assert.equal(workspaceDetail(named, 'local_x', '/repo/landing-site'), place + ' · landing-site');
    assert.notEqual(workspaceLabel('local_x', '/repo/landing-site', named), workspaceLabel('w1', '', named),
      'the root row and a worktree of the same name never read alike');
    assert.equal(named[cwdKey('/repo/landing-site')].projectRoot, true);
  }
});
