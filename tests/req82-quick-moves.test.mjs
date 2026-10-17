import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPendingMoves, doneStage, laterRevision, offersDone, stageAllowed, undoTarget } from '../dist/client/move-model.js';
import { isOrphanedCard, isUnassignedCard } from '../dist/client/signal-model.js';
import { copy, withRo } from '../dist/client/i18n.js';
import { editorReducer, emptyEditor, editorOperations, isDirty } from '../dist/client/editor-state.js';
import { PASEO_THEMES, SELECTED_LINE_CONTRAST, SELECTED_LINE_WIDTH, palette, selectedLine, contrast } from '../dist/client/palette.js';

/**
 * REQ-82: an archived card says it waits to be confirmed done, and a person moves any card at once — the card's
 * "Done", its ⋯ (a long press on a phone), the detail's stage bar. The screens are tested in plugin-ui.test.mjs.
 */
const STAGES = [['todo', 'To Do'], ['doing', 'In progress'], ['review', 'Review'], ['done', 'Done']]
  .map(([stageId, name], index) => ({ stageId, name, countsAsDone: index === 3 }));
const EPOCH = '0f0e0d0c-0b0a-4908-8706-050403020100';
function board(id, revision, cards) {
  const stages = STAGES.map(stage => ({ ...stage, hiddenCount: 0, cards: cards.filter(c => c.stageId === stage.stageId),
    totalCount: cards.filter(c => c.stageId === stage.stageId).length }));
  return { summary: { id, workspaceId: 'wks_' + id, cwd: '/w/' + id, workspaceStatus: 'active', revision, updatedAt: '2026-09-01T00:00:00.000Z',
    progress: { done: 0, requested: cards.length, draft: 0, archived: 0, percent: 0 } }, agentLabels: {}, stages,
    template: { schemaVersion: 1, id: 'basic', version: 1, name: 'Basic', stages: STAGES } };
}
const card = (id, stageId, extra = {}) => ({ id, title: 'Card ' + id, stageId, priority: 'normal', intent: 'requested', blocked: false,
  nextAction: '', agents: 0, awaiting: null, agentIds: [], completedAt: null, ...extra });

test('REQ-82 ① archived waits for confirmation; "No assignee" is only a not-done, non-draft card with no agent at all', () => {
  const archived = id => id === 'a1';
  assert.equal(isOrphanedCard(['a1'], false, archived), true);
  assert.equal(isUnassignedCard(['a1'], false, 'requested'), false, 'an archived agent is still an agent');
  assert.equal(isUnassignedCard([], false, 'requested'), true);
  assert.equal(isUnassignedCard([''], false, 'requested'), true, 'an empty id links nobody');
  assert.equal(isUnassignedCard([], true, 'requested'), false, 'a done card is not flagged');
  assert.equal(isUnassignedCard([], false, 'draft'), false, 'a draft already says it is a draft');
  const en = copy('en'), ko = copy('ko');
  assert.equal(en.archivedReview, 'Archived · confirm done'); assert.equal(ko.archivedReview, '보관됨 · 완료 확인');
  assert.equal(ko.signalOrphanedCount(3), '완료 확인 3');
  assert.doesNotMatch(ko.signalOrphaned, /담당 없음/, 'the archived card never says "No assignee"');
});

test('REQ-82 ② "Done" is the first completion stage, offered to an archived non-draft card on a template that has one', () => {
  assert.equal(doneStage(STAGES).stageId, 'done');
  assert.equal(doneStage(STAGES.map(s => ({ ...s, countsAsDone: false }))), undefined);
  assert.equal(offersDone(true, 'requested', STAGES), true);
  assert.equal(offersDone(false, 'requested', STAGES), false);
  assert.equal(offersDone(true, 'draft', STAGES), false, 'a draft cannot leave the first stage');
  assert.equal(offersDone(true, 'requested', STAGES.map(s => ({ ...s, countsAsDone: false }))), false);
});

test('REQ-82 ③④ a draft is offered the first stage and (REQ-97) the working stage, which sends it to the lead; anything else any stage', () => {
  assert.deepEqual(STAGES.map(s => stageAllowed(STAGES, 'draft', s.stageId)), [true, true, false, false]);
  assert.deepEqual(STAGES.map(s => stageAllowed(STAGES, 'requested', s.stageId)), [true, true, true, true]);
});

test('REQ-82 the Korean "to" particle follows the stage name\'s last sound', () => {
  assert.deepEqual(['완료', '진행', '검토', '대기', '출발', 'Review'].map(withRo),
    ['완료로', '진행으로', '검토로', '대기로', '출발로', 'Review(으)로']);
  const ko = copy('ko');
  assert.equal(ko.movedTo('진행'), '진행으로 옮김'); assert.equal(ko.toStage('완료'), '완료로');
  assert.equal(ko.confirmDone('완료'), '완료로 확인'); assert.equal(ko.movedBack('대기'), '대기로 되돌림');
  assert.equal(copy('en').movedTo('Done'), 'Moved to Done');
});

test('REQ-82 ③ a pending move is drawn over the board read before it, and nowhere else', () => {
  const r1 = EPOCH + ':1', r2 = EPOCH + ':2';
  const boards = [board('b1', r1, [card('c1', 'todo'), card('c2', 'todo')]), board('b2', r1, [card('c3', 'todo')])];
  assert.equal(applyPendingMoves(boards, []), boards, 'nothing pending: the same boards');
  const moved = applyPendingMoves(boards, [{ boardId: 'b1', cardId: 'c1', to: 'done', base: r1 }]);
  assert.deepEqual(moved[0].stages.map(s => s.cards.map(c => c.id)), [['c2'], [], [], ['c1']]);
  assert.deepEqual(moved[0].stages.map(s => s.totalCount), [1, 0, 0, 1]);
  assert.equal(moved[0].stages[3].cards[0].stageId, 'done');
  assert.equal(moved[1], boards[1], 'another board is untouched');
  assert.equal(applyPendingMoves(boards, [{ boardId: 'b1', cardId: 'c1', to: 'done', base: r2 }]), boards,
    'a move made against another revision is not drawn');
  assert.equal(applyPendingMoves(boards, [{ boardId: 'b1', cardId: 'c1', to: 'nowhere', base: r1 }]), boards, 'an unknown stage is ignored');
  assert.equal(applyPendingMoves(boards, [{ boardId: 'b1', cardId: 'c1', to: 'todo', base: r1 }]), boards, 'already there');
  // A move leads its new column so the eye finds it.
  const again = applyPendingMoves([board('b1', r1, [card('c1', 'todo'), card('c2', 'done')])], [{ boardId: 'b1', cardId: 'c1', to: 'done', base: r1 }]);
  assert.deepEqual(again[0].stages[3].cards.map(c => c.id), ['c1', 'c2']);
});

test('REQ-82 ③ a pending move is retired only by a later read (an undo waits for the revision its first move made)', () => {
  assert.equal(laterRevision(EPOCH + ':3', EPOCH + ':2'), true);
  assert.equal(laterRevision(EPOCH + ':2', EPOCH + ':2'), false);
  assert.equal(laterRevision(EPOCH + ':1', EPOCH + ':2'), false, 'an older read keeps the undo');
  assert.equal(laterRevision('ffffffff-0b0a-4908-8706-050403020100:1', EPOCH + ':9'), true, 'a new epoch');
  assert.equal(laterRevision(undefined, EPOCH + ':2'), false, 'a board not on screen');
});

test('REQ-82 ④ the stage bar\'s move rebases the editor without losing what was typed', () => {
  const snapshot = (stageId, notes, revision) => ({ boardId: 'b1', revision, locale: 'en', observedAt: '', history: [],
    template: { schemaVersion: 1, id: 'basic', version: 1, name: 'Basic', stages: STAGES },
    card: { id: 'c1', title: 'Card', stageId, notes, nextAction: 'Next', priority: 'normal', blockedReason: null, awaiting: 'user',
      acceptanceCriteria: '', intent: 'requested', deliverables: [], agents: [], createdBy: { kind: 'user' },
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null } });
  let state = editorReducer(emptyEditor(), { type: 'load', snapshot: snapshot('todo', '', EPOCH + ':1') });
  state = editorReducer(state, { type: 'edit', patch: { notes: 'Typed' } });
  state = editorReducer(state, { type: 'rebase', snapshot: snapshot('doing', '', EPOCH + ':2') });
  assert.equal(state.base.revision, EPOCH + ':2'); assert.equal(state.stageId, 'doing');
  assert.equal(state.draft.notes, 'Typed', 'the unsaved edit stays');
  assert.equal(isDirty(state), true);
  assert.deepEqual(editorOperations(state), [{ op: 'update', id: 'c1', patch: { notes: 'Typed' } }], 'save sends the fields alone');
  // A field nobody touched takes what the new read says.
  const other = editorReducer(state, { type: 'rebase', snapshot: { ...snapshot('review', '', EPOCH + ':3'),
    card: { ...snapshot('review', '', EPOCH + ':3').card, nextAction: 'Changed elsewhere' } } });
  assert.equal(other.draft.nextAction, 'Changed elsewhere'); assert.equal(other.draft.notes, 'Typed');
});

test('REQ-82 ④ the current stage line: the main colour, 2px, held to 3.5:1 with the theme\'s own colours (G3)', () => {
  assert.equal(SELECTED_LINE_WIDTH, 2); assert.equal(SELECTED_LINE_CONTRAST, 3.5);
  assert.equal(selectedLine({ accent: '#20744A' }, '#ffffff'), '#20744A', 'a readable accent is kept as it is');
  for (const [accent, background] of [['#20744A', '#181B1A'], ['#dfe8e3', '#ffffff'], ['#101010', '#000000']])
    assert.ok(contrast(selectedLine({ accent }, background), background) >= 3.5, accent + ' on ' + background);
  // research/117 G3: the dark theme's accent on the detail measured 3.02. The line is then the theme's own colour
  // nearest the accent in hue (a Kanban window is drawn from the chosen set only, REQ-72 ①).
  const dark = palette(PASEO_THEMES.dark), light = palette(PASEO_THEMES.light), line = selectedLine(dark, dark.surface0);
  assert.ok(contrast(line, dark.surface0) >= 3.5);
  assert.ok(Object.values(dark).includes(line), line + ' is one of the dark theme\'s colours');
  assert.equal(line, dark.statusDotSuccess, 'the green nearest the green accent');
  assert.ok(contrast(line, dark.surface1) >= 3, 'still a line next to the other stages');
  assert.equal(selectedLine(light, light.surface0), light.accent, 'the light accent is kept as it is');
});

test('REQ-82 G1 undo goes where the ledger had the card right before the move, and not at all once it moved again', () => {
  const R = n => EPOCH + ':' + n;
  const moved = [{ from: null, to: 'todo', revision: R(1) }, { from: 'todo', to: 'doing', revision: R(4) }, { from: 'doing', to: 'review', revision: R(8) }];
  assert.equal(undoTarget(moved, 'review', 'review', R(8)), 'doing', 'the stage before the move, from the ledger');
  // The screen still showed "todo" (an agent had moved it to doing at R(4)): undo goes to doing, not todo.
  assert.equal(undoTarget(moved, 'review', 'review', R(9)), 'doing', 'a later unrelated change does not matter');
  const again = [...moved, { from: 'review', to: 'doing', revision: R(10) }];
  assert.equal(undoTarget(again, 'doing', 'review', R(8)), null, 'moved again meanwhile');
  const back = [...again, { from: 'doing', to: 'review', revision: R(11) }];
  assert.equal(undoTarget(back, 'review', 'review', R(8)), null, 'moved away and back is still another move');
  assert.equal(undoTarget(moved, 'review', 'review', 'ffffffff-0000-4000-8000-000000000000:8'), null, 'another epoch is not this move');
  assert.equal(undoTarget([], 'review', 'review', R(8)), null, 'no history (trimmed) means nothing to undo safely');
  assert.equal(undoTarget([{ from: null, to: 'review', revision: R(8) }], 'review', 'review', R(8)), null, 'a created card has no stage before');
});
