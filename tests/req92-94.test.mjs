// REQ-92: a column's "+N" shows five more cards of that column in that lane only, the done column too; "Collapse" once
// all are shown. REQ-93 (research/141 C, replacing REQ-89's reference lines): sub-cards sit in their own stage's column,
// so the columns and the phone's tabs add up to the lane. (REQ-94's parent edge: now REQ-95, tests/req95-96.test.mjs.)
// The screens are exercised in plugin-ui.test.mjs ("REQ-92"/"REQ-93"/"REQ-94") and tests/web/run.mjs (real input).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBoardDTO } from '../dist/server/read-model.js';
import { cardParents } from '../dist/server/card-parents.js';
import { applyOperations } from '../dist/shared/core/domain.js';
import { laneModel, swimlaneModel, stepCell, foldCell, expandLane, beginAttentionFilter, cardDimensions, revealFamily, SWIMLANE } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { lanePanelHeight } from '../dist/client/panel-style.js';
import { board, add, context, actor } from './helpers.mjs';

const WORKSPACE = 'wks_example01';
const LEAD = '00000000-0000-4000-8000-0000000000b1';
const W1 = '00000000-0000-4000-8000-0000000000c1', W2 = '00000000-0000-4000-8000-0000000000c2', W3 = '00000000-0000-4000-8000-0000000000c3';
const T = minute => `2026-09-26T0${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
const directory = { [WORKSPACE]: { id: WORKSPACE, name: 'Example Workspace', projectId: 'prj_example01', projectName: 'Example Project' } };
const titles = cards => cards.map(c => c.title);

/**
 * The stable release's case (REQ-89): the lead card waits in review while its sub-agents work — two in progress, one
 * waiting, one done — and nothing else is in progress. `extra` adds cards.
 */
function sample(extra = () => {}) {
  let value = board(), minute = 1;
  const make = (title, stageId, agentId) => {
    value = applyOperations(value, [{ ...add(title), stageId }], actor, context(T(minute++))).board;
    const id = value.cards.at(-1).id;
    if (agentId) value = applyOperations(value, [{ op: 'link', id, agentId }], actor, context(T(minute++))).board;
    return id;
  };
  const ids = { lead: make('Lead card', 'review', LEAD) };
  ids.a = make('Worker a', 'doing', W1); ids.b = make('Worker b', 'doing', W1);
  ids.wait = make('Waiting worker', 'todo', W2); ids.done = make('Done worker', 'done', W3);
  make('Plain waiting', 'todo');
  extra(make);
  const parents = { [W1]: { parentAgentId: LEAD, at: T(0) }, [W2]: { parentAgentId: LEAD, at: T(0) }, [W3]: { parentAgentId: LEAD, at: T(0) } };
  return { dto: toBoardDTO(value, 'en', 'off', Date.now(), cardParents(value, { agents: {}, parents })), ids };
}
const cellOf = (lane, id) => lane.cells.find(c => c.stageId === id);

test('REQ-93 ① the running sub-cards are in the In progress column, and the columns add up to the lane', () => {
  const { dto, ids } = sample();
  const lane = laneModel(dto);
  assert.deepEqual(titles(cellOf(lane, 'doing').cards), ['Worker a', 'Worker b'], 'no longer 0 while they run');
  assert.deepEqual(cellOf(lane, 'doing').cards.map(c => c.parent?.id), [ids.lead, ids.lead]);
  assert.deepEqual(titles(cellOf(lane, 'todo').cards), ['Waiting worker', 'Plain waiting']);
  assert.deepEqual(titles(cellOf(lane, 'done').cards), ['Done worker']);
  assert.deepEqual(cellOf(lane, 'review').cards[0].family, { total: 4, open: 3 });
  assert.deepEqual(lane.cells.map(c => c.matchingCount), [2, 2, 1, 1]);
  assert.equal(lane.cells.reduce((n, c) => n + c.matchingCount, 0), lane.total, 'column counts sum to the lane total');
  for (const cell of lane.cells) assert.equal('refs' in cell || 'subCount' in cell, false, 'no reference lines any more');
});

test('REQ-93 ② 390px: each tab counts every card of its stage, and a lane is listed in a tab for its own cards', () => {
  const { dto } = sample();
  const phone = mobileSwimlaneModel([dto], directory, [], false, {}, 'doing', {});
  assert.deepEqual(phone.stages.map(s => [s.stageId, s.count]), [['todo', 2], ['doing', 2], ['review', 1], ['done', 1]]);
  assert.equal(phone.stages.reduce((n, s) => n + s.count, 0), phone.groups[0].total, 'the tabs add up to the workspace');
  assert.equal(phone.sections.length, 1);
  assert.deepEqual(titles(phone.sections[0].cell.cards), ['Worker a', 'Worker b']);
  assert.equal(phone.stages.some(s => 'sub' in s), false, 'no "+n" beside a tab');
  const none = mobileSwimlaneModel([dto], directory, [], false, {}, 'doing', { query: 'plain' });
  assert.equal(none.sections.length, 0, 'a search the sub-cards do not match lists no lane in the tab');
  assert.equal(none.stages.find(s => s.stageId === 'todo').count, 1);
});

test('REQ-93 ③ the card order (REQ-79) sorts a sub-card among the others; a sub-card is a row taller, a parent has its line', () => {
  const { dto } = sample(make => make('Plain doing', 'doing'));
  assert.deepEqual(titles(cellOf(laneModel(dto), 'doing').cards), ['Worker a', 'Worker b', 'Plain doing']);
  assert.deepEqual(titles(cellOf(laneModel(dto, {}, false, '', new Set(), 'created'), 'doing').cards), ['Plain doing', 'Worker b', 'Worker a']);
  assert.equal(cardDimensions(false, 1, true).minHeight - cardDimensions(false).minHeight, 22, 'the mark row and its gap');
  const lane = laneModel(dto);
  const plain = cardDimensions(false).minHeight;
  // REQ-99: the parent's summary line is inside it — the same 16 and gap as the mark row; REQ-104: its status row under that.
  assert.equal(cardDimensions(false, 1, false, true).minHeight - plain, 44, 'the family line, the status row and their gaps');
  // REQ-116: its short title ("Lead card") fits one line, so it keeps no second title line (18).
  assert.equal(lanePanelHeight([cellOf(lane, 'review')]), SWIMLANE.columnHeaderHeight + 16 + plain + 44 - 18, 'the parent, its two rows inside it');
  assert.equal(lanePanelHeight([cellOf(lane, 'doing')]), SWIMLANE.columnHeaderHeight + 16 + 2 * (plain + 22) + plain + 16);
});

/** A lane with ten cards in progress, twelve done and two waiting, for the "+N" steps. */
function long() {
  return sample(make => {
    for (let i = 0; i < 8; i++) make('Doing ' + i, 'doing');
    for (let i = 0; i < 11; i++) make('Done ' + i, 'done');
  });
}
test('REQ-92 ① "+N" gives five more to its own column of its own lane; the rest stays as it was', () => {
  const { dto } = long();
  const id = dto.summary.id, other = { ...dto, summary: { ...dto.summary, id: 'board_' + 'e'.repeat(64) } };
  let states = {};
  const cells = (board = dto) => laneModel(board, states[board.summary.id]).cells.map(c => [c.stageId, c.cards.length, c.remaining]);
  assert.deepEqual(cells(), [['todo', 2, 0], ['doing', 3, 7], ['review', 1, 0], ['done', 3, 9]]);
  states = stepCell(states, id, 'doing', false);
  assert.deepEqual(cells(), [['todo', 2, 0], ['doing', 8, 2], ['review', 1, 0], ['done', 3, 9]], '+7 → five more, "+2" left; done untouched');
  assert.deepEqual(cells(other), [['todo', 2, 0], ['doing', 3, 7], ['review', 1, 0], ['done', 3, 9]], 'another lane untouched');
  assert.equal(laneModel(dto, states[id]).expanded, true, 'the lane glyph now folds');
  states = stepCell(states, id, 'doing', false);
  const doing = cellOf(laneModel(dto, states[id]), 'doing');
  assert.deepEqual([doing.cards.length, doing.remaining, doing.open], [10, 0, true], 'the last two, then "Collapse"');
  states = stepCell(states, id, 'done', false);
  const done = cellOf(laneModel(dto, states[id]), 'done');
  assert.deepEqual([done.cards.length, done.remaining, done.openBoard, done.open], [8, 4, true, true], 'done: five at a time too, never ten; REQ-115: "Collapse" part way too');
  states = foldCell(states, id, 'doing', false);
  assert.deepEqual(cells(), [['todo', 2, 0], ['doing', 3, 7], ['review', 1, 0], ['done', 8, 4]], '"Collapse" folds that column only');
  assert.deepEqual(states[id].steps, { done: 1 });
});

test('REQ-92 ② the lane glyph gives five more to each column that leaves cards out, and folds them all back', () => {
  const { dto } = long();
  const id = dto.summary.id;
  let states = expandLane({}, id, true, false, ['doing', 'done']);
  assert.deepEqual(laneModel(dto, states[id]).cells.map(c => c.cards.length), [2, 8, 1, 8]);
  states = expandLane(states, id, true, false, ['doing', 'done']);
  assert.deepEqual(laneModel(dto, states[id]).cells.map(c => c.cards.length), [2, 10, 1, 12]);
  states = expandLane(states, id, false, false);
  assert.deepEqual(laneModel(dto, states[id]).cells.map(c => c.cards.length), [2, 3, 1, 3]);
  assert.equal(laneModel(dto, states[id]).expanded, false);
  // Opening a folded lane opens it (the glyph and "+N" never act on a lane you cannot see).
  assert.equal(laneModel(dto, stepCell({ [id]: { collapsed: true } }, id, 'doing', false)[id]).collapsed, false);
});

test('REQ-92 ③ the attention filter and a search keep their own steps; kept for the session only (lane state, not ui-state)', () => {
  const { dto } = long();
  const id = dto.summary.id;
  let states = stepCell({}, id, 'doing', false);
  states = beginAttentionFilter(states);
  assert.deepEqual(states[id].attentionSteps, { doing: 1 }, 'a filter starts from the columns as they were');
  states = stepCell(states, id, 'doing', true);
  assert.deepEqual([states[id].steps, states[id].attentionSteps], [{ doing: 1 }, { doing: 2 }]);
  assert.equal(cellOf(laneModel(dto, states[id], false, 'doing'), 'doing').step, 2, 'a search reads the filtered steps');
  assert.equal(cellOf(laneModel(dto, states[id]), 'doing').step, 1, 'and without it the ordinary ones');
  // The model's grouped board folds a project's lanes with their opened columns.
  const grouped = swimlaneModel([dto], directory, [], false, states, { projects: { prj_example01: true } });
  assert.deepEqual(grouped.groups[0].lanes[0].cells.map(c => [c.cards.length, c.remaining, c.open]), [[0, 0, false], [0, 0, false], [0, 0, false], [0, 0, false]]);
  assert.equal(grouped.groups[0].lanes[0].expanded, false);
});

test('REQ-93 C′ (보완) a highlighted family cut off behind "+N" opens its columns five at a time until it shows; nothing folds', () => {
  const { dto, ids } = sample(make => {
    for (let i = 0; i < 8; i++) make('Doing ' + i, 'doing');
    make('Worker late', 'doing', W1);
    for (let i = 0; i < 4; i++) make('Done ' + i, 'done');
    make('Done late', 'done', W3);
  });
  const id = dto.summary.id, lane = states => laneModel(dto, states[id]);
  const hidden = states => lane(states).cells.flatMap(c => c.matching.filter(card => card.id === ids.lead || card.parent?.id === ids.lead)
    .filter(card => !c.cards.includes(card)).map(card => card.title));
  assert.deepEqual(hidden({}), ['Worker late', 'Done late'], 'two of the family are behind "+N"');
  // Worker late is the 11th card in progress: two "+N" presses' worth (3 + 5 + 5); Done late is the 6th done: one.
  let states = revealFamily({}, lane({}), ids.lead, false);
  assert.deepEqual(states[id].steps, { doing: 2, done: 1 });
  assert.deepEqual(hidden(states), [], 'every card of the family shows');
  assert.deepEqual(lane(states).cells.map(c => [c.stageId, c.cards.length]), [['todo', 2], ['doing', 11], ['review', 1], ['done', 6]]);
  assert.equal(revealFamily(states, lane(states), ids.lead, false), states, 'all shown: nothing changes');
  // A column opened further than needed is left as it is; one the family does not reach is never opened.
  const wider = stepCell(stepCell(stepCell({}, id, 'doing', false), id, 'doing', false), id, 'doing', false);
  assert.deepEqual(revealFamily(wider, lane(wider), ids.lead, false)[id].steps, { doing: 3, done: 1 });
  const other = revealFamily({}, lane({}), ids.done, false);
  assert.equal(other[id], undefined, 'a family already in view opens nothing');
  // The attention filter or a search keeps its own steps; a folded lane is left folded.
  const filtered = revealFamily({}, lane({}), ids.lead, true);
  assert.deepEqual([filtered[id].steps, filtered[id].attentionSteps], [undefined, { doing: 2, done: 1 }]);
  const folded = { [id]: { collapsed: true } };
  assert.equal(revealFamily(folded, lane(folded), ids.lead, false), folded);
});

// REQ-94's state-coloured edge was replaced by REQ-95's stage-coloured one: tests/req95-96.test.mjs.
