// REQ-109 (the owner, 2026-09-28): a lead's family line is two presses — "Sub-cards N" highlights the whole family,
// "not done M" the lead and its sub-cards in any stage but done (a done column's "+N" left as it is) — and whatever a
// highlight opened behind "+N" folds back when it ends, a column the user opened themselves kept. The screens are
// exercised in plugin-ui.test.mjs ("REQ-109").
import test from 'node:test';
import assert from 'node:assert/strict';
import { revealFamily, concealFamily, stepCell, foldCell } from '../dist/client/swimlane-model.js';
import { openIds } from '../dist/client/card-groups.js';
import { copy } from '../dist/client/i18n.js';

const card = (id, parent) => ({ id, ...(parent ? { parent: { id: parent, title: parent } } : {}) });
const filler = n => Array.from({ length: n }, (_, i) => card('f' + i));
/** In progress: seven others, then two sub-cards (8th: one "+N" press, 9th: two); done: five others, then one (6th: one). */
const doing = [...filler(7), card('s1', 'lead'), card('s2', 'lead')], done = [...filler(5), card('s3', 'lead')];
const lane = { board: { summary: { id: 'b' } }, collapsed: false, cells: [
  { stageId: 'review', cards: [card('lead')], matching: [card('lead')] },
  { stageId: 'doing', cards: doing.slice(0, 3), matching: doing },
  { stageId: 'done', cards: done.slice(0, 3), matching: done }] };

test('REQ-109 a highlight\'s end folds back what it opened, to exactly the presses each column had', () => {
  const on = revealFamily({}, lane, 'lead', false);
  assert.deepEqual(on.b.steps, { doing: 2, done: 1 });
  assert.deepEqual(on.b.revealed, { attention: false, stages: { doing: [null, 2], done: [null, 1] } });
  const off = concealFamily(on);
  assert.deepEqual(off.b.steps, {}, 'no press kept');
  assert.equal(off.b.revealed, undefined, 'nothing left to take back');
  assert.equal(concealFamily(off), off, 'nothing opened: nothing changes');
  const none = {};
  assert.equal(concealFamily(none), none, 'no lane opened: the same states');
});
test('REQ-109 a column the user opened beforehand keeps its presses; one opened too little goes back to the user\'s', () => {
  const enough = stepCell(stepCell({}, 'b', 'doing', false), 'b', 'doing', false), little = stepCell({}, 'b', 'doing', false);
  const a = revealFamily(enough, lane, 'lead', false);
  assert.deepEqual(a.b.revealed.stages, { done: [null, 1] }, 'in progress already showed the family');
  assert.deepEqual(concealFamily(a).b.steps, { doing: 2 });
  const b = revealFamily(little, lane, 'lead', false);
  assert.deepEqual(b.b.steps, { doing: 2, done: 1 });
  assert.deepEqual(concealFamily(b).b.steps, { doing: 1 }, 'back to the user\'s one press');
});
test('REQ-109 a column the user pressed while the highlight was on is theirs: left as they left it', () => {
  const on = revealFamily({}, lane, 'lead', false);
  const more = concealFamily(stepCell(on, 'b', 'doing', false)), folded = concealFamily(foldCell(on, 'b', 'done', false));
  assert.deepEqual(more.b.steps, { doing: 3 }, '"+N" once more: kept; done folded back');
  assert.deepEqual(folded.b.steps, {}, '"Collapse": kept folded; in progress folded back');
});
test('REQ-109 one highlight after another: the first folds back before the next opens what it needs', () => {
  const whole = revealFamily({}, lane, 'lead', false);
  const next = revealFamily(concealFamily(whole), lane, 'lead', false, ['s1']);
  assert.deepEqual(next.b.steps, { doing: 1 }, 'the done column the family opened is folded again; s1 needs one press');
  assert.deepEqual(concealFamily(next).b.steps, {});
  // Without a fold in between, the earliest "before" is kept.
  const twice = revealFamily(revealFamily(stepCell({}, 'b', 'doing', false), lane, 'lead', false, ['s3']), lane, 'lead', false);
  assert.deepEqual(twice.b.revealed.stages, { done: [null, 1], doing: [1, 2] });
  assert.deepEqual(concealFamily(twice).b.steps, { doing: 1 });
});
test('REQ-109 "not done": the not-done sub-cards alone, so a done column is never opened', () => {
  const stages = [{ stageId: 'todo', countsAsDone: false }, { stageId: 'doing', countsAsDone: false },
    { stageId: 'review', countsAsDone: false }, { stageId: 'done', countsAsDone: true }];
  const lead = { crew: { members: [{ id: 's1', stageId: 'doing' }, { id: 's2', stageId: 'review' }, { id: 's3', stageId: 'done' }], own: [] } };
  assert.deepEqual(openIds(lead, stages), ['s1', 's2']);
  assert.deepEqual(openIds({}, stages), [], 'no crew: nothing');
  const on = revealFamily({}, lane, 'lead', false, openIds(lead, stages));
  assert.deepEqual(on.b.steps, { doing: 2 }, 'in progress opened, done left folded');
});
test('REQ-109 what was opened is kept with the lane\'s folds: a refresh or the session read back still folds it back', () => {
  const on = JSON.parse(JSON.stringify(revealFamily({}, lane, 'lead', false)));
  assert.deepEqual(concealFamily(on).b.steps, {});
  // The attention filter or a search opens and folds back its own steps, the ordinary ones untouched.
  const ordinary = stepCell({}, 'b', 'todo', false);
  const filtered = revealFamily({ b: { ...ordinary.b, attentionSteps: {} } }, lane, 'lead', true);
  assert.deepEqual([filtered.b.steps, filtered.b.attentionSteps], [{ todo: 1 }, { doing: 2, done: 1 }]);
  assert.deepEqual([concealFamily(filtered).b.steps, concealFamily(filtered).b.attentionSteps], [{ todo: 1 }, {}]);
});
test('REQ-109 the labels say what each press highlights, in both languages', () => {
  assert.equal(copy('ko').familyLabel(46, 'L'), '하위 46 — 누르면 하위 카드 강조: L');
  assert.equal(copy('ko').familyOpenLabel(1, 'L'), '미완료 1 — 누르면 미완료 하위만 강조: L');
  assert.equal(copy('en').familyLabel(46, 'L'), 'Sub-cards 46 — press to highlight the sub-cards: L');
  assert.equal(copy('en').familyOpenLabel(1, 'L'), 'Not done 1 — press to highlight only the sub-cards not done: L');
});
