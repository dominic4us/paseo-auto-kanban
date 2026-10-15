// research/187 J2·J3 (v0.1.38 gate, 2026-09-28): a phone lane's heading loses To Do's "+" to its ⋯ sheet ("New draft"),
// and a draft just made opens its column as far as it needs to show it — written down as a highlight's opening is
// (REQ-109 `revealed`), so the person's "Collapse" or lane fold wins. The screens are exercised in plugin-ui.test.mjs
// ("research/187").
import test from 'node:test';
import assert from 'node:assert/strict';
import { revealCard, concealFamily, foldCell, expandLane, stepCell } from '../dist/client/swimlane-model.js';
import { copy } from '../dist/client/i18n.js';

const card = id => ({ id });
/** To Do: nine others, then the new draft (10th: two "+N" presses); in progress three. */
const todo = [...Array.from({ length: 9 }, (_, i) => card('f' + i)), card('new')];
const lane = (collapsed = false) => ({ board: { summary: { id: 'b' } }, collapsed, cells: [
  { stageId: 'todo', cards: collapsed ? [] : todo.slice(0, 3), matching: todo },
  { stageId: 'doing', cards: [card('d')], matching: [card('d')] }] });

test('research/187 J3 a new draft behind "+N" opens its column five at a time until it shows, written down as opened', () => {
  const on = revealCard({}, lane(), 'new', false);
  assert.deepEqual(on.b.steps, { todo: 2 });
  assert.deepEqual(on.b.revealed, { attention: false, stages: { todo: [null, 2] } });
  const shown = revealCard({}, { ...lane(), cells: [{ stageId: 'todo', cards: [card('new')], matching: [card('new')] }] }, 'new', false);
  assert.deepEqual(shown, {}, 'in sight already: nothing changes');
  const already = stepCell(stepCell({}, 'b', 'todo', false), 'b', 'todo', false);
  assert.equal(revealCard(already, lane(), 'new', false), already, 'the person opened it far enough: not written down');
  assert.deepEqual(revealCard({}, lane(), 'new', true).b, { attentionSteps: { todo: 2 }, attentionCollapsed: false,
    revealed: { attention: true, stages: { todo: [null, 2] } } }, 'a filter\'s own steps');
});
test('research/187 J3 the person\'s fold wins over what a new draft opened; a highlight\'s end takes it back with its own', () => {
  const on = revealCard({}, lane(), 'new', false);
  const folded = foldCell(on, 'b', 'todo', false);
  assert.deepEqual([folded.b.steps, folded.b.revealed], [{}, undefined], '"Collapse": three, nothing left to put back');
  assert.deepEqual(concealFamily(folded).b.steps, {}, 'stays folded');
  const lanes = expandLane(on, 'b', false, false);
  assert.equal(lanes.b.revealed, undefined, 'the lane glyph\'s fold is the person\'s too');
  const more = stepCell(on, 'b', 'todo', false);
  assert.deepEqual(concealFamily(more).b.steps, { todo: 3 }, '"+N" pressed after: the person\'s');
  assert.deepEqual(concealFamily(on).b.steps, {}, 'untouched: a highlight\'s end folds it back as its own');
});
test('research/187 J3 a folded lane opens for the draft asked for in it', () => {
  const on = revealCard({ b: { collapsed: true } }, lane(true), 'new', false);
  assert.equal(on.b.collapsed, false);
  assert.deepEqual(on.b.steps, { todo: 2 });
});
test('research/187 J2 the phone sheet\'s item says "New draft" / "초안 만들기"', () => {
  assert.equal(copy('en').draftHere, 'New draft');
  assert.equal(copy('ko').draftHere, '초안 만들기');
});
