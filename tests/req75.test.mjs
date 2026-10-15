import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filledLanes, flatTier, swimlaneModel, SWIMLANE } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { emptyLaneOrder, flatOrder, orderActions, sameOrder } from '../dist/client/order-model.js';
import { overviewSelection } from '../dist/client/presentation.js';
import { readUiState, writeUiState } from '../dist/server/ui-state.js';
import { uiStateSet, uiStateSchema } from '../dist/shared/rpc.js';

/**
 * REQ-75 A: the swimlane board is flat by default (one lane per workspace) and grouped under project headings
 * on request. The two views keep their own order: `order.projects`/`order.workspaces` stay the grouped one (what
 * was arranged before REQ-75), `order.flatWorkspaces` is the flat one.
 */
const STAGES = [['todo', 'To Do'], ['doing', 'In progress'], ['review', 'Review'], ['done', 'Done']];
function lane(id, workspaceId, cards = 0, { attention = false, updatedAt = '2026-09-01T00:00:00.000Z', done = 0 } = {}) {
  const make = (prefix, n, stage) => Array.from({ length: n }, (_, i) => ({ id: id + prefix + i, title: 'Card ' + i, nextAction: '',
    awaiting: attention && i === 0 && stage === 0 ? 'user' : null, blocked: false, priority: 'normal', intent: 'requested',
    updatedAt, agents: [], labels: [] }));
  const stages = STAGES.map(([stageId, name], index) => ({ stageId, name, countsAsDone: index === 3, hiddenCount: 0,
    totalCount: index === 0 ? cards : index === 3 ? done : 0,
    cards: index === 0 ? make('_c', cards, 0) : index === 3 ? make('_d', done, 3) : [] }));
  return { summary: { id, workspaceId, cwd: '/w/' + workspaceId, workspaceStatus: 'active', revision: 'r', updatedAt,
    hasLedger: true, progress: { done, requested: cards + done, draft: 0, archived: 0, percent: cards + done ? 0 : null } },
    agentLabels: {}, stages,
    template: { id: 'basic', version: 1, stages: stages.map(s => ({ stageId: s.stageId, name: s.name, countsAsDone: s.countsAsDone })) } };
}
const entry = (id, projectId, name) =>
  ({ id, name, projectId, projectName: projectId.toUpperCase(), projectViewKey: projectId, labels: [], cwd: '/w/' + id });
// pa: a1 (cards), a2 (none); pb: b1 (cards, attention); pc: c1 (none). X1 is a board Paseo no longer lists (D22).
const directory = { a1: entry('a1', 'pa', 'A one'), a2: entry('a2', 'pa', 'A two'), b1: entry('b1', 'pb', 'B one'), c1: entry('c1', 'pc', 'C one') };
const boards = [lane('A1', 'a1', 2), lane('A2', 'a2'), lane('B1', 'b1', 1, { attention: true, updatedAt: '2026-09-02T00:00:00.000Z' }),
  lane('C1', 'c1'), lane('X1', 'local_gone', 3)];
const flat = model => model.lanes.map(l => l.workspaceKey);

test('REQ-75 A1 the flat board lists every lane once, in REQ-64 layers, with D22 lanes last', () => {
  const model = swimlaneModel(boards, directory, [], false, {}, { grouped: false });
  assert.deepEqual(flat(model), ['b1', 'a1', 'a2', 'c1', 'local_gone'],
    'lanes with cards first (attention leads), then card-less ones, and the workspace Paseo lost at the bottom');
  assert.ok(model.lanes.every(l => l.group && typeof l.group.projectId === 'string'), 'each lane still knows its project');
  assert.equal(model.groups.some(g => 'merged' in g), false, 'no merged form any more');
  // The grouped model is untouched: projects in their layers, lanes inside them.
  assert.deepEqual(model.groups.map(g => g.projectId), ['pb', 'pa', 'pc', '']);
  // 390px reads the flat order too, stage by stage.
  const phone = mobileSwimlaneModel(boards, directory, [], false, {}, 'todo', { grouped: false });
  assert.deepEqual(phone.sections.map(s => s.lane.workspaceKey), ['b1', 'a1', 'a2', 'c1', 'local_gone']);
  const grouped = mobileSwimlaneModel(boards, directory, [], false, {}, 'todo', { grouped: true });
  assert.deepEqual(grouped.sections.map(s => s.lane.workspaceKey), ['b1', 'a1', 'a2', 'c1', 'local_gone']);
  const phoneOrder = { projects: ['pa'], workspaces: [], flatWorkspaces: ['a1', 'b1'] };
  assert.deepEqual(mobileSwimlaneModel(boards, directory, [], false, {}, 'todo', { grouped: true, order: phoneOrder }).sections
    .map(s => s.lane.workspaceKey), ['a1', 'a2', 'b1', 'c1', 'local_gone'], 'grouped: project by project');
  assert.deepEqual(mobileSwimlaneModel(boards, directory, [], false, {}, 'todo', { grouped: false, order: phoneOrder }).sections
    .map(s => s.lane.workspaceKey), ['a1', 'b1', 'a2', 'c1', 'local_gone'], 'flat: its own order');
});

test('REQ-75 A4 the flat order and the grouped order are kept apart, and a stored order still cannot lift a card-less lane', () => {
  // The grouped order arranged before REQ-75 never rearranges the flat board…
  const legacy = { projects: ['pa', 'pb'], workspaces: ['a2', 'a1'] };
  assert.deepEqual(flat(swimlaneModel(boards, directory, [], false, {}, { grouped: false, order: legacy })), ['b1', 'a1', 'a2', 'c1', 'local_gone']);
  assert.deepEqual(swimlaneModel(boards, directory, [], false, {}, { order: legacy }).groups.map(g => g.projectId), ['pa', 'pb', 'pc', '']);
  // …and the flat order never rearranges the grouped one.
  const both = { ...legacy, flatWorkspaces: ['c1', 'a2', 'a1', 'b1'] };
  const arranged = swimlaneModel(boards, directory, [], false, {}, { grouped: false, order: both });
  assert.deepEqual(flat(arranged), ['a1', 'b1', 'c1', 'a2', 'local_gone'], 'each layer in the flat order; c1 and a2 stay card-less below');
  assert.deepEqual(swimlaneModel(boards, directory, [], false, {}, { order: both }).groups.map(g => g.projectId), ['pa', 'pb', 'pc', '']);
  // A move on the flat board pins flatWorkspaces only, inside its layer and its D22 tier.
  let order = legacy;
  const lanes = swimlaneModel(boards, directory, [], false, {}, { grouped: false, order }).lanes;
  const arrange = orderActions(order, next => { order = next; }, ['pb', 'pa', 'pc']);
  assert.deepEqual(flatTier(lanes, 'pa'), ['b1', 'a1', 'a2', 'c1'], 'the lost workspace is not among the real ones');
  assert.deepEqual(flatTier(lanes, ''), ['local_gone']);
  const control = arrange.flatLane(flatTier(lanes, 'pa'), 'a1', filledLanes(lanes));
  assert.deepEqual([control.canUp, control.canDown], [true, false], 'a1 is the last lane with cards');
  control.onMove('top');
  assert.deepEqual(order, { ...legacy, flatWorkspaces: ['a1', 'b1'] }, 'the grouped lists are untouched');
  assert.deepEqual(flat(swimlaneModel(boards, directory, [], false, {}, { grouped: false, order })), ['a1', 'b1', 'a2', 'c1', 'local_gone']);
  const cardless = arrange.flatLane(flatTier(lanes, 'pc'), 'c1', filledLanes(lanes));
  assert.deepEqual([cardless.canUp, cardless.canDown], [true, false], 'c1 moves among the card-less lanes only');
  // Reset everything forgets both orders; `arranged` notices a flat order alone.
  assert.equal(orderActions({ projects: [], workspaces: [], flatWorkspaces: ['a1'] }, () => {}, []).arranged, true);
  assert.equal(sameOrder(emptyLaneOrder(), { projects: [], workspaces: [], flatWorkspaces: [] }), true);
  assert.equal(sameOrder(emptyLaneOrder(), { projects: [], workspaces: [], flatWorkspaces: ['a1'] }), false);
  assert.deepEqual(flatOrder(emptyLaneOrder()), []);
  // The list screen keeps following the grouped order (it lists projects with their workspaces).
  const data = { locale: 'en', observedAt: '', errors: [], attention: [], boards: boards.map(b => ({ ...b.summary, needsHuman: 0 })) };
  assert.deepEqual(overviewSelection(data, directory, [], 'all', both).boards.map(b => b.id),
    overviewSelection(data, directory, [], 'all', legacy).boards.map(b => b.id));
});

test('REQ-75 A2 a project fold belongs to the grouped board: the flat board never folds a lane because of its project', () => {
  const folded = { pa: true };
  const grouped = swimlaneModel(boards, directory, [], false, {}, { projects: folded });
  assert.ok(grouped.groups.find(g => g.projectId === 'pa').lanes.every(l => l.collapsed));
  const flatModel = swimlaneModel(boards, directory, [], false, {}, { grouped: false, projects: folded });
  assert.equal(flatModel.lanes.find(l => l.workspaceKey === 'a1').collapsed, false);
  assert.equal(flatModel.groups.find(g => g.projectId === 'pa').collapsed, false);
});

test('REQ-75 B3 an opened done column (REQ-92: five at a time) offers the board while it leaves cards out', () => {
  const [board] = [lane('D1', 'a1', 4, { done: 14 })];
  const shut = swimlaneModel([board], directory, [], false, {}, { grouped: false }).lanes[0];
  const done = shut.cells.find(c => c.countsAsDone);
  assert.deepEqual([done.cards.length, done.remaining, done.openBoard], [3, 11, false]);
  const open = swimlaneModel([board], directory, [], false, { D1: { steps: { todo: 1, done: 1 } } }, { grouped: false }).lanes[0];
  const cell = open.cells.find(c => c.countsAsDone), todo = open.cells.find(c => c.stageId === 'todo');
  assert.deepEqual([cell.cards.length, cell.remaining, cell.openBoard], [SWIMLANE.previewCount + SWIMLANE.moreStep, 6, true], '"6 more in the board"');
  assert.deepEqual([todo.cards.length, todo.remaining, todo.openBoard, todo.open], [4, 0, false, true]);
  const all = swimlaneModel([board], directory, [], false, { D1: { steps: { done: 3 } } }, { grouped: false }).lanes[0].cells.find(c => c.countsAsDone);
  assert.deepEqual([all.cards.length, all.remaining, all.openBoard, all.open], [14, 0, false, true], 'every done card: "Collapse", no board link');
});

test('REQ-75 A3 the RPC takes "group by project" as a settings row and the flat order beside the grouped one', () => {
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { groupByProject: true } }).success, true);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { groupByProject: 'yes' } }).success, false);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', order: { projects: [], workspaces: [], flatWorkspaces: ['a1'] } }).success, true);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', order: { projects: [], workspaces: [] } }).success, true, 'an older client still writes');
  assert.equal(uiStateSchema.safeParse({ hiddenProjects: [], order: { projects: [], workspaces: [] } }).success, true, 'an older reply still reads');
});

async function dataDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-req75-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

test('REQ-75 A3·A4 ui-state: the new fields are added beside the old ones, an old file reads unchanged, an old client keeps the flat order', async t => {
  const dir = await dataDir(t), host = 'host_a', file = join(dir, 'ui-state.json');
  // A file written before REQ-75: the grouped order the user arranged, a board position.
  const old = { schemaVersion: 1, hosts: { [host]: { hiddenProjects: ['prj_h'], order: { projects: ['pa', 'pb'], workspaces: ['a2', 'a1'] },
    settings: { boardAlign: 'left' } } } };
  await writeFile(file, JSON.stringify(old, null, 2) + '\n');
  const before = await readFile(file, 'utf8');
  assert.deepEqual(await readUiState(dir, host), { hiddenProjects: ['prj_h'], order: { projects: ['pa', 'pb'], workspaces: ['a2', 'a1'] },
    settings: { boardAlign: 'left' } }, 'no new field appears until it holds something');
  assert.equal(await readFile(file, 'utf8'), before, 'reading writes nothing');
  // The toggle: one settings row; the order and the other rows keep what the file holds.
  let result = await writeUiState(dir, host, { settings: { groupByProject: true } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings, { boardAlign: 'left', groupByProject: true });
  assert.deepEqual(result.order, { projects: ['pa', 'pb'], workspaces: ['a2', 'a1'] });
  assert.equal((await writeUiState(dir, host, { settings: { groupByProject: true } })).changed, false, 'the same value writes nothing');
  // A flat move: the grouped lists travel unchanged, the flat list is added.
  result = await writeUiState(dir, host, { order: { projects: ['pa', 'pb'], workspaces: ['a2', 'a1'], flatWorkspaces: ['b1', 'a1'] } });
  assert.deepEqual(result.order, { projects: ['pa', 'pb'], workspaces: ['a2', 'a1'], flatWorkspaces: ['b1', 'a1'] });
  // An older client (the stable build) writes the grouped order without the flat list: the flat order survives.
  result = await writeUiState(dir, host, { order: { projects: ['pb'], workspaces: [] } });
  assert.deepEqual(result.order, { projects: ['pb'], workspaces: [], flatWorkspaces: ['b1', 'a1'] });
  // Reset all: every list empties, and the empty flat list leaves the file.
  result = await writeUiState(dir, host, { order: { projects: [], workspaces: [], flatWorkspaces: [] } });
  assert.deepEqual(result.order, { projects: [], workspaces: [] });
  const stored = JSON.parse(await readFile(file, 'utf8')).hosts[host];
  assert.deepEqual(stored, { hiddenProjects: ['prj_h'], order: { projects: [], workspaces: [] }, settings: { boardAlign: 'left', groupByProject: true } });
  // Damaged values read as the defaults.
  await writeFile(file, JSON.stringify({ schemaVersion: 1, hosts: { [host]: { order: { projects: [], workspaces: [], flatWorkspaces: 'x' },
    settings: { groupByProject: 'yes' } } } }));
  assert.deepEqual(await readUiState(dir, host), { hiddenProjects: [], order: { projects: [], workspaces: [] } });
});
