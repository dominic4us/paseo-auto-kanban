// REQ-110~116 (the owner's screenshots, 2026-09-28): the lane name's tip, the lane ⋯ as a small menu, the detail's warning
// line, a To Do "+", the filter glyph's menu, "Collapse" part way and a lead card as tall as what it holds. The screens are
// exercised in plugin-ui.test.mjs ("REQ-110" … "REQ-116"); these are the pure parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardDimensions, concealFamily, expandLane, foldCell, laneModel, leadTitleOneLine, revealFamily, stepCell, SWIMLANE }
  from '../dist/client/swimlane-model.js';
import { lanePanelHeight } from '../dist/client/panel-style.js';
import { activeFilters, emptyFilters, filterCount } from '../dist/client/filter-model.js';
import { dwellReason } from '../dist/client/stage-time.js';
import { copy } from '../dist/client/i18n.js';

test('REQ-110 the tip\'s words in both languages', () => {
  assert.equal(copy('en').goToBoard, 'Open board');
  assert.equal(copy('ko').goToBoard, '보드로 이동');
  assert.equal(copy('ko').openInBoard, '보드에서 열기', 'the ⋯ item keeps its own words');
});

test('REQ-112 the detail\'s line is the hint\'s reason, and nothing where the time does not warn', () => {
  const m = copy('ko');
  assert.equal(dwellReason({ kind: 'review', warn: true }, m), m.dwellWarnReview);
  assert.equal(dwellReason({ kind: 'progress', warn: true }, m), m.dwellWarnQuiet);
  assert.equal(dwellReason({ kind: 'review', warn: false }, m), '');
  assert.equal(dwellReason(null, m), '');
});

test('REQ-113 the To Do "+" and its sheet say where the draft goes, in both languages', () => {
  assert.equal(copy('en').newDraftIn('Site'), 'New draft in To Do: Site');
  assert.equal(copy('ko').newDraftIn('Site'), '대기에 초안 만들기: Site');
  assert.ok(copy('ko').draftTitleRequired && copy('ko').draftCriteriaFailed);
});

test('REQ-114 the filters in force, one entry each, as many as the count, each clearing itself alone', () => {
  assert.deepEqual(activeFilters(emptyFilters()), []);
  const filters = { hiddenProjects: ['p1', 'p2'], labels: ['bug', 'ui'], attention: true, query: '  card ' };
  const active = activeFilters(filters, key => key.toUpperCase());
  assert.deepEqual(active.map(a => [a.id, a.value]), [['projects', '2'], ['label:bug', 'BUG'], ['label:ui', 'UI'], ['attention', ''], ['query', 'card']]);
  assert.equal(active.length, filterCount(filters));
  assert.deepEqual(active.map(a => a.clear), [{ hiddenProjects: [] }, { labels: ['ui'] }, { labels: ['bug'] }, { attention: false }, { query: '' }]);
  for (const entry of active) assert.equal(filterCount({ ...filters, ...entry.clear }), filterCount(filters) - 1, entry.id + ': one less');
  assert.deepEqual(activeFilters({ ...emptyFilters(), query: '   ' }), [], 'a blank search is no filter');
});

/** A basic board with `todo` cards waiting and `done` done. */
function board(todo, done) {
  const card = (id, stageId) => ({ id, title: id, stageId, nextAction: '', agentIds: [], priority: 'normal', updatedAt: '2026-09-28T00:00:00.000Z',
    createdAt: '2026-09-28T00:00:00.000Z', intent: 'requested', awaiting: null, blocked: false, links: 0 });
  const stage = (stageId, cards) => ({ stageId, name: stageId, countsAsDone: stageId === 'done', cards, hiddenCount: 0, totalCount: cards.length });
  return { summary: { id: 'b', workspaceId: 'w', cwd: '/w', progress: { done: done, requested: todo + done } },
    template: { id: 'basic', version: 1, stages: ['todo', 'doing', 'review', 'done'].map(s => ({ stageId: s, name: s, countsAsDone: s === 'done' })) },
    stages: [stage('todo', Array.from({ length: todo }, (_, i) => card('t' + i, 'todo'))), stage('doing', []), stage('review', []),
      stage('done', Array.from({ length: done }, (_, i) => card('d' + i, 'done')))] };
}
test('REQ-115 "Collapse" as soon as a column shows more than three — part way, beside "+N" and "… in the board", too', () => {
  const dto = board(14, 14);
  const cell = (states, stageId) => laneModel(dto, states.b).cells.find(c => c.stageId === stageId);
  const once = stepCell(stepCell({}, 'b', 'todo', false), 'b', 'done', false);
  assert.deepEqual(['todo', 'done'].map(s => { const c = cell(once, s); return [c.cards.length, c.remaining, c.open, c.openBoard]; }),
    [[8, 6, true, false], [8, 6, true, true]]);
  assert.equal(cell({}, 'todo').open, false, 'three shown: nothing to fold');
  const folded = foldCell(once, 'b', 'todo', false);
  assert.deepEqual([cell(folded, 'todo').cards.length, cell(folded, 'done').cards.length], [SWIMLANE.previewCount, 8], 'its own column, back to three');
  // A column that shows no more than three however far it was opened has nothing to fold.
  assert.equal(cell(stepCell({}, 'b', 'doing', false), 'doing').open, false);
});
test('REQ-115 a person\'s fold wins over a highlight\'s: what REQ-109 wrote down there is dropped, so its end puts nothing back', () => {
  const card = (id, parent) => ({ id, ...(parent ? { parent: { id: parent, title: parent } } : {}) });
  const doing = [...Array.from({ length: 7 }, (_, i) => card('f' + i)), card('s1', 'lead')], done = [...Array.from({ length: 5 }, (_, i) => card('g' + i)), card('s2', 'lead')];
  const lane = { board: { summary: { id: 'b' } }, collapsed: false, cells: [
    { stageId: 'doing', cards: doing.slice(0, 3), matching: doing }, { stageId: 'done', cards: done.slice(0, 3), matching: done }] };
  const on = revealFamily({}, lane, 'lead', false);
  assert.deepEqual(on.b.revealed.stages, { doing: [null, 1], done: [null, 1] });
  // The person folds the done column, then opens it again as far as the highlight had.
  const mine = stepCell(foldCell(on, 'b', 'done', false), 'b', 'done', false);
  assert.deepEqual(mine.b.revealed.stages, { doing: [null, 1] }, 'the done column is no longer the highlight\'s');
  assert.deepEqual(concealFamily(mine).b.steps, { done: 1 }, 'in progress folds back, done stays as the person left it');
  // Folding the whole lane (its glyph) drops every column's record.
  const all = expandLane(on, 'b', false, false);
  assert.equal(all.b.revealed, undefined);
  assert.deepEqual(concealFamily(all).b.steps, {});
  // The attention filter's record is its own: a fold without the filter leaves it.
  const filtered = revealFamily({}, lane, 'lead', true);
  assert.deepEqual(foldCell(filtered, 'b', 'done', false).b.revealed, filtered.b.revealed);
});

test('REQ-116 a lead card keeps no second title line when its short title surely fits one; a plain card is as before', () => {
  assert.equal(leadTitleOneLine('Lead-03_sample-app_Opus'), true, 'the automatic head "Lead-03"');
  assert.equal(leadTitleOneLine('총괄-03'), true);
  assert.equal(leadTitleOneLine('A lead card with a title far too long to fit on one line'), false);
  assert.equal(leadTitleOneLine('한글로 아주 길게 적은 총괄 카드 제목입니다'), false, 'wide letters count wide');
  const lead = cardDimensions(false, 1, false, true), short = cardDimensions(false, 1, false, true, false, 1);
  assert.equal(lead.height - short.height, 18, 'one title line');
  assert.deepEqual([cardDimensions(false).height, cardDimensions(true).height], [84, 104], 'a plain card: no "→" line without a next action');
  assert.equal(cardDimensions(true, 1, false, true, false, 1).height - short.height, 20, 'a lead\'s next action adds its row too');
  const parent = title => ({ id: 'p', title, nextAction: '', family: { total: 2, open: 1 } });
  const height = title => lanePanelHeight([{ cards: [parent(title)], remaining: 0 }]);
  assert.equal(height('Lead-03_x_y') - height('A lead card with a title far too long to fit on one line'), -18, 'the column follows the card');
});
