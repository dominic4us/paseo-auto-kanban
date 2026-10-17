// REQ-103 1단계 (research/157 ④, the owner's choice of 2026-09-27): acceptance criteria written as a checklist (`- [ ]` /
// `- [x]` lines) are measured — ticked over all — and the board carries the count; a done card with unticked lines is
// marked but never counted as needing attention; the progress beside a bar says "Cards N/M" with no percent. The screens
// are exercised in plugin-ui.test.mjs ("REQ-103") and tests/web/run.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { criteriaLines, criteriaProgress, toggleCriterion } from '../dist/shared/criteria.js';
import { toBoardDTO, toOverview } from '../dist/server/read-model.js';
import { applyOperations, needsHuman } from '../dist/shared/core/domain.js';
import { boardMutate, editablePatch } from '../dist/shared/rpc.js';
import { editableKeys, emptyFields, fieldsOf } from '../dist/client/editor-state.js';
import { copy } from '../dist/client/i18n.js';
import { board, add, context, actor } from './helpers.mjs';

test('REQ-103 ① no checklist line, nothing to measure', () => {
  for (const text of ['', 'A reviewable result exists.', 'Plain\nlines\n- a bullet', '-[ ] no space', '* [ ] a star', '- [] empty', '- [y] other'])
    assert.equal(criteriaProgress(text), null, JSON.stringify(text));
});
test('REQ-103 ① ticked over all, some or every line, a capital X, spaces or a tab before the dash', () => {
  assert.deepEqual(criteriaProgress('- [ ] One\n- [ ] Two'), { checked: 0, total: 2 });
  assert.deepEqual(criteriaProgress('- [x] One\n- [x] Two\n- [ ] Three'), { checked: 2, total: 3 });
  assert.deepEqual(criteriaProgress('- [x] One\n- [X] Two\n- [x] Three'), { checked: 3, total: 3 }, 'capital X is ticked');
  assert.deepEqual(criteriaProgress('Intro line\n  - [x] Indented\n\t- [ ] Tabbed\n    - [X] Deeper\nOutro'), { checked: 2, total: 3 });
  assert.deepEqual(criteriaProgress('- [x]'), { checked: 1, total: 1 }, 'a box with no words still counts');
  assert.deepEqual(criteriaProgress('- [x] One\r\n- [ ] Two\r\n'), { checked: 1, total: 2 }, 'Windows line ends');
  assert.deepEqual(criteriaLines('Intro\n  - [X] Done item  \n- [ ] Open item'),
    [{ line: 1, checked: true, text: 'Done item' }, { line: 2, checked: false, text: 'Open item' }]);
});
test('REQ-103 ① a tick changes only its own line and keeps everything else as written', () => {
  const text = 'Intro\n  - [ ] First\n- [X] Second\r\nOutro';
  assert.equal(toggleCriterion(text, 1), 'Intro\n  - [x] First\n- [X] Second\r\nOutro');
  assert.equal(toggleCriterion(text, 2), 'Intro\n  - [ ] First\n- [ ] Second\r\nOutro', 'a capital X unticks too');
  assert.equal(toggleCriterion(toggleCriterion(text, 1), 1), text, 'twice is where it started');
  for (const line of [0, 3, 9, -1]) assert.equal(toggleCriterion(text, line), text, 'not a checklist line: unchanged ' + line);
  assert.deepEqual(criteriaProgress(toggleCriterion(text, 1)), { checked: 2, total: 2 });
});

/** A board with a card per stage and criteria of each kind. */
function sample() {
  let value = board();
  const make = (title, stageId, acceptanceCriteria, extra = {}) => {
    value = applyOperations(value, [{ ...add(title), stageId, acceptanceCriteria, ...extra }], actor, context()).board;
  };
  make('Plain criteria', 'doing', 'A reviewable result exists.');
  make('Two of three', 'doing', '- [x] One\n- [x] Two\n- [ ] Three');
  make('All ticked', 'review', '- [x] One\n- [X] Two');
  make('Done unticked', 'done', '- [x] One\n- [ ] Two');
  make('Done ticked', 'done', '- [x] One');
  return value;
}
test('REQ-103 ① the board carries each card\'s count, and none where the criteria have no checklist', () => {
  const dto = toBoardDTO(sample(), 'en');
  const byTitle = Object.fromEntries(dto.stages.flatMap(s => s.cards).map(c => [c.title, c]));
  assert.equal('criteria' in byTitle['Plain criteria'], false);
  assert.deepEqual(byTitle['Two of three'].criteria, { checked: 2, total: 3 });
  assert.deepEqual(byTitle['All ticked'].criteria, { checked: 2, total: 2 });
  assert.deepEqual(byTitle['Done unticked'].criteria, { checked: 1, total: 2 });
  assert.equal('acceptanceCriteria' in byTitle['Two of three'], false, 'the text itself stays in the card read');
});
test('REQ-103 ② a done card with unticked lines is not a card that needs attention', () => {
  const value = sample(), plain = toOverview([value], 'en', value.updatedAt);
  assert.equal(value.cards.filter(c => needsHuman(c, value.template.stages)).length, 0);
  assert.equal(plain.boards[0].needsHuman, 0); assert.equal(plain.attention.length, 0);
  // The same board with the done card's criteria plain: the count is the same.
  const done = value.cards.find(c => c.title === 'Done unticked');
  const other = applyOperations(value, [{ op: 'update', id: done.id, patch: { acceptanceCriteria: 'No checklist.' } }], actor, context()).board;
  assert.equal(toOverview([other], 'en', other.updatedAt).boards[0].needsHuman, plain.boards[0].needsHuman);
  // And the progress is the cards', as before: done over requested.
  assert.deepEqual([plain.boards[0].progress.done, plain.boards[0].progress.requested], [2, 5]);
});
test('REQ-103 ② the detail saves the criteria as one field of its own; the draft sends none', () => {
  assert.ok(editableKeys.includes('acceptanceCriteria'));
  assert.equal(emptyFields().acceptanceCriteria, '');
  assert.equal(fieldsOf({ ...emptyFields(), acceptanceCriteria: '- [x] One' }).acceptanceCriteria, '- [x] One');
  assert.equal(editablePatch.safeParse({ acceptanceCriteria: '- [x] One\n- [ ] Two' }).success, true);
  assert.equal(editablePatch.safeParse({ acceptanceCriteria: 'x'.repeat(8001) }).success, false, 'the ledger\'s 8000 limit');
  const request = { boardId: 'board_' + 'a'.repeat(64), requestId: '00000000-0000-4000-8000-000000000001',
    ifRevision: '00000000-0000-4000-8000-000000000002:3',
    operations: [{ op: 'update', id: 'card_00000000-0000-4000-8000-000000000003', patch: { acceptanceCriteria: '- [x] One' } }] };
  assert.equal(boardMutate.input.safeParse(request).success, true);
  // The ledger takes it as it takes the CLI's `--criteria`.
  const value = sample(), card = value.cards.find(c => c.title === 'Two of three');
  const next = applyOperations(value, [{ op: 'update', id: card.id, patch: { acceptanceCriteria: toggleCriterion(card.acceptanceCriteria, 2) } }], actor, context()).board;
  assert.deepEqual(criteriaProgress(next.cards.find(c => c.id === card.id).acceptanceCriteria), { checked: 3, total: 3 });
});
test('REQ-103 ③ "Cards N/M" in both languages, with no percent', () => {
  assert.equal(copy('en').cardsProgress(97, 104), 'Cards 97/104');
  assert.equal(copy('ko').cardsProgress(97, 104), '카드 97/104');
  assert.equal(copy('en').criteriaProgress(2, 3), 'Criteria 2/3');
  assert.equal(copy('ko').criteriaProgress(2, 3), '기준 2/3');
  assert.equal(copy('ko').criteriaUnmet, '기준 미확인 완료');
  for (const locale of ['en', 'ko']) assert.doesNotMatch(copy(locale).cardsProgress(0, 5), /%/);
});
