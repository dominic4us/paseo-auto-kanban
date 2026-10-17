import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyOperations } from '../dist/server/core/index.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { swimlaneModel, beginAttentionFilter, expandLane } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel, attentionStage } from '../dist/client/mobile-model.js';
import { MOBILE, firstCardY, mobileControls, surfaceLayout, sectionGap } from '../dist/client/mobile-layout.js';
import { bottomClearance } from '../dist/client/layout.js';
import { board, add, actor, context } from './helpers.mjs';

function example(key, entries) {
  const b = board(); b.id = 'board_' + createHash('sha256').update(key).digest('hex'); b.workspaceId = 'wks_' + key;
  return toBoardDTO(applyOperations(b, entries.map((entry, i) => ({ ...add(key + i), ...entry })), actor, context()).board);
}
function names(boards) {
  return Object.fromEntries(boards.map((b, i) => [b.summary.workspaceId, { id: b.summary.workspaceId,
    name: 'Workspace ' + i, projectId: i % 2 ? 'prj_second' : 'prj_first', projectName: 'Example Project ' + (i % 2) }]));
}
test('mobile projection retains the common ordering and removes workspaces empty in the selected stage', () => {
  const a = example('one', [{ stageId: 'doing', awaiting: 'user' }]);
  const b = example('two', [{ stageId: 'todo', awaiting: 'user' }]);
  const c = example('three', [{ stageId: 'doing' }]);
  b.summary.updatedAt = '2026-02-01T00:00:00.000Z';
  const boards = [c, b, a], directory = names(boards);
  const common = swimlaneModel(boards, directory, [], false);
  const mobile = mobileSwimlaneModel(boards, directory, [], false, {}, 'doing');
  const expected = common.groups.flatMap(g => g.lanes).filter(l => l.cells.find(c => c.stageId === 'doing').matchingCount > 0);
  assert.deepEqual(mobile.sections.map(s => s.lane.board.summary.id), expected.map(l => l.board.summary.id));
  assert.equal(mobile.sections.length, 2); assert.equal(mobile.sections[0].lane.board.summary.id, a.summary.id);
  assert.deepEqual(mobile.stages.map(s => s.count), [1, 2, 0, 0]);
  assert.equal(mobileSwimlaneModel(boards, directory, [], false, {}, 'review').sections.length, 0);
});
test('one shared lane expansion applies across selected stages without changing another workspace', () => {
  const a = example('one', Array.from({ length: 6 }, () => ({ stageId: 'doing' }))
    .concat(Array.from({ length: 5 }, () => ({ stageId: 'todo' }))));
  const b = example('two', Array.from({ length: 5 }, () => ({ stageId: 'doing' })));
  let states = {};
  let view = mobileSwimlaneModel([a, b], {}, [], false, states, 'doing');
  assert.ok(view.sections.every(s => s.cell.cards.length === 3));
  states = expandLane(states, a.summary.id, true, false);
  view = mobileSwimlaneModel([a, b], {}, [], false, states, 'doing');
  assert.equal(view.sections.find(s => s.lane.board.summary.id === a.summary.id).cell.cards.length, 6);
  assert.equal(view.sections.find(s => s.lane.board.summary.id === b.summary.id).cell.cards.length, 3);
  assert.equal(mobileSwimlaneModel([a, b], {}, [], false, states, 'todo').sections[0].cell.cards.length, 5);
  states = expandLane(states, a.summary.id, false, false);
  assert.equal(mobileSwimlaneModel([a], {}, [], false, states, 'doing').sections[0].cell.cards.length, 3);
});
test('done-only initial folding and the opened done column (REQ-92: five at a time) remain exactly the common policy', () => {
  const a = example('done', Array.from({ length: 12 }, () => ({ stageId: 'done' })));
  const folded = mobileSwimlaneModel([a], {}, [], false, {}, 'done').sections[0];
  assert.equal(folded.lane.collapsed, true); assert.equal(folded.cell.cards.length, 0);
  const states = expandLane({}, a.summary.id, true, false);
  const expanded = mobileSwimlaneModel([a], {}, [], false, states, 'done').sections[0];
  assert.equal(expanded.cell.cards.length, 8); assert.equal(expanded.cell.remaining, 4); assert.equal(expanded.cell.openBoard, true);
});
test('REQ-18 excludes done cards from mobile attention and retains progress', () => {
  const a = example('done', [{ stageId: 'done', awaiting: 'user' }, { stageId: 'doing' }]);
  const common = swimlaneModel([a], {}, [], false);
  const filtered = mobileSwimlaneModel([a], {}, [], true, {}, 'done');
  assert.equal(filtered.attention, common.attention); assert.equal(filtered.attention, 0);
  assert.equal(filtered.sections.length, 0);
  assert.deepEqual(filtered.stages.map(s => s.count), [0, 0, 0, 0]);
  assert.equal(filtered.requested, 2); assert.equal(filtered.done, 1);
});
test('attention entry chooses the most populated stage, breaking ties in template order', () => {
  assert.equal(attentionStage([{ stageId: 'todo', count: 2 }, { stageId: 'doing', count: 2 }, { stageId: 'done', count: 1 }]), 'todo');
  assert.equal(attentionStage([{ stageId: 'todo', count: 0 }, { stageId: 'doing', count: 1 }, { stageId: 'done', count: 3 }]), 'done');
});
test('attention fold choices do not destroy the ordinary view and stage projection uses the same helper', () => {
  const initial = { one: { collapsed: false, steps: { doing: 1 } }, two: { collapsed: true } };
  const filtered = expandLane(beginAttentionFilter(initial), 'one', false, true);
  assert.deepEqual(filtered.one.steps, { doing: 1 }); assert.deepEqual(filtered.one.attentionSteps, {});
  assert.equal(filtered.two.collapsed, true); assert.deepEqual(initial.one, { collapsed: false, steps: { doing: 1 } });
});
test('project filtering affects stage counts and excludes unrelated workspace sections', () => {
  const a = example('one', [{ stageId: 'doing', awaiting: 'user' }]), b = example('two', [{ stageId: 'doing' }]);
  const directory = names([a, b]);
  const view = mobileSwimlaneModel([a, b], directory, ['prj_second'], false, {}, 'doing');
  assert.equal(view.sections.length, 1); assert.equal(view.stages[1].count, 1); assert.equal(view.attention, 1);
});
test('header budgets explicitly include the observed 64px host chrome, not just plugin content', () => {
  assert.equal(64 + 8 + 44 + 8 + 44 + 6 + 44 + 6, 224); // Previous overview geometry.
  assert.equal(64 + 8 + 44 + 8 + 44 + 8, 176); // Previous workspace board geometry.
  assert.equal(firstCardY('surface'), 168); assert.equal(firstCardY('board'), 156);
  assert.ok(firstCardY('surface') <= 170); assert.ok(firstCardY('board') <= 170);
  assert.equal(firstCardY('surface', 80), 184); // Do not claim a larger host inset magically meets the target.
  assert.equal(MOBILE.appbarHeight, 44); assert.equal(MOBILE.controlHeight, 44);
});
test('combined control row keeps 36px faces and disjoint 44px targets at 320/390/759 widths', () => {
  for (const width of [320, 390, 759]) {
    const result = mobileControls(width);
    assert.ok(result.tabWidth >= 44); assert.equal(result.contentWidth, width - 16);
    assert.equal(result.tabWidth * 4 + 4 + 1 + 4 + 76, result.contentWidth); // REQ-71: tabs │ 76px chip
  }
  // REQ-71: the chip's face is as tall as a tab's.
  assert.equal(MOBILE.touchSize, 44); assert.equal(MOBILE.chipFace, 36); assert.equal(MOBILE.tabFace, 36);
  assert.ok(mobileControls(240).contentWidth > 240 - 16); // Tiny panels scroll controls instead of shrinking targets.
  assert.equal(sectionGap('prj_first'), 0); assert.equal(sectionGap('prj_first', 'prj_first'), 0);
  assert.equal(sectionGap('prj_second', 'prj_first'), 12);
  assert.equal(bottomClearance('android'), 56); assert.equal(bottomClearance('ios'), 44);
});
test('760px boundary preserves all previously wide/native-wide branches', () => {
  assert.equal(surfaceLayout(759, 'web'), 'mobile'); assert.equal(surfaceLayout(760, 'web'), 'wide');
  assert.equal(surfaceLayout(1900, 'web'), 'wide'); assert.equal(surfaceLayout(390, 'android'), 'mobile');
  assert.equal(surfaceLayout(390, 'ios'), 'mobile'); assert.equal(surfaceLayout(1000, 'android'), 'legacy');
});
