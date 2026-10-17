// REQ-148 (research/350:41 → 409): one name for the second stage on every screen — the phone's tabs say "In progress" as the
// wide board does (REQ-136 H6's shorter "Doing" is gone) — and a phone opens on a tab with cards: its usual one (In progress on
// the Kanban screen, the first stage on a board) while that has cards, else the first with cards, else the usual one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copy } from '../dist/client/i18n.js';
import { openingStage } from '../dist/client/mobile-model.js';

const four = counts => ['todo', 'doing', 'review', 'done'].map((stageId, i) => ({ stageId, count: counts[i] }));

test('REQ-148 one name for the second stage: the tab says the stage name, in both languages', () => {
  const en = copy('en'), ko = copy('ko');
  assert.equal(en.doingStage, 'In progress'); assert.equal(ko.doingStage, '진행');
  assert.equal(en.doingStageTab, undefined); assert.equal(ko.doingStageTab, undefined);
  assert.deepEqual([en.waitingStage, en.reviewStage, en.doneStage], ['To Do', 'Review', 'Done']);
});
test('REQ-148 the opening tab: the usual one while it has cards, else the first with cards, else the usual one', () => {
  assert.equal(openingStage(four([3, 8, 2, 1]), 'doing'), 'doing', 'In progress has cards: as before');
  assert.equal(openingStage(four([2, 0, 0, 0]), 'doing'), 'todo', 'research/350: the cards wait in To Do');
  assert.equal(openingStage(four([0, 0, 1, 1]), 'doing'), 'review');
  assert.equal(openingStage(four([0, 0, 0, 4]), 'doing'), 'done');
  assert.equal(openingStage(four([0, 0, 0, 0]), 'doing'), 'doing', 'no cards anywhere: the usual tab');
  // A board: its first stage, whatever its stages are called.
  assert.equal(openingStage([{ stageId: 'inbox', count: 0 }, { stageId: 'build', count: 0 }, { stageId: 'ship', count: 2 }], 'inbox'), 'ship');
  assert.equal(openingStage([{ stageId: 'inbox', count: 1 }, { stageId: 'build', count: 5 }], 'inbox'), 'inbox');
  assert.equal(openingStage([], 'todo'), 'todo');
});
