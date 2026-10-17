// REQ-79 (card order), REQ-80 (tool glyph hover / on line / tips below), REQ-81 (where the layout tools sit):
// the pure parts. The screens are exercised in plugin-ui.test.mjs ("REQ-79", "REQ-80", "REQ-81").
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sortCards, placeCard, compareCards, isCardOrder, CARD_ORDERS } from '../dist/client/card-order.js';
import { swimlaneModel, laneModel, SWIMLANE } from '../dist/client/swimlane-model.js';
import { applyPendingMoves, moveCard } from '../dist/client/move-model.js';
import { hoverFill, contrast, PASEO_THEMES, palette, selectedLine, SELECTED_LINE_WIDTH, HOVER_CONTRAST } from '../dist/client/palette.js';
import { readUiState, writeUiState } from '../dist/server/ui-state.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { uiStateSet, uiStateSchema } from '../dist/shared/rpc.js';
import { applyOperations } from '../dist/shared/core/domain.js';
import { board, context, actor, add } from './helpers.mjs';

const card = (id, priority, createdAt, updatedAt, stageId = 'todo') =>
  ({ id, title: id, stageId, priority, intent: 'requested', blocked: false, nextAction: '', agents: 0, awaiting: null,
    agentIds: [], completedAt: null, createdAt, updatedAt });
const T = day => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
// a: high, oldest, touched last · b: normal, newest · c: normal, middle · d: low, made second, touched second
const cards = [card('a', 'high', T(1), T(20)), card('b', 'normal', T(9), T(9)), card('c', 'normal', T(5), T(6)), card('d', 'low', T(2), T(15))];
const ids = list => list.map(c => c.id);

test('REQ-79 the three orders: the ledger\'s (priority, then oldest), latest change first, newest first', () => {
  assert.deepEqual(CARD_ORDERS, ['default', 'updated', 'created']);
  assert.deepEqual(ids(sortCards(cards, 'default')), ['a', 'c', 'b', 'd'], 'priority, then the oldest card — shared/core sortedCards');
  assert.deepEqual(ids(sortCards(cards, 'updated')), ['a', 'd', 'b', 'c'], 'the most recent updatedAt leads');
  assert.deepEqual(ids(sortCards(cards, 'created')), ['b', 'c', 'd', 'a'], 'the most recent createdAt leads');
  // A column already in order comes back as the same array (memoised views keep it).
  const sorted = sortCards(cards, 'updated');
  assert.equal(sortCards(sorted, 'updated'), sorted);
  // Ties fall back to the ledger's order; a time an older server did not send sorts as the oldest.
  const tie = [card('y', 'low', T(3), T(8)), card('x', 'high', T(4), T(8)), card('z', 'high', undefined, undefined)];
  assert.deepEqual(ids(sortCards(tie, 'updated')), ['x', 'y', 'z']);
  assert.deepEqual(ids(sortCards(tie, 'created')), ['x', 'y', 'z']);
  assert.ok(isCardOrder('created') && !isCardOrder('oldest') && !isCardOrder(undefined));
  assert.equal(compareCards('default')(cards[0], cards[0]), 0);
});

test('REQ-79 the server sends when each card was made, and its own order is the default order', () => {
  let value = board();
  // The ledger never lets time run backwards on a board, so the cards are made in order.
  for (const [title, day] of [['Older', 1], ['Middle', 2], ['Newer', 3]])
    value = applyOperations(value, [add(title)], actor, context(T(day))).board;
  const dto = toBoardDTO(value), todo = dto.stages.find(s => s.stageId === 'todo').cards;
  assert.deepEqual(todo.map(c => c.createdAt), [T(1), T(2), T(3)], 'createdAt rides along with every card');
  assert.equal(sortCards(todo, 'default'), todo, 'the ledger order needs no re-sort');
  assert.deepEqual(sortCards(todo, 'created').map(c => c.title), ['Newer', 'Middle', 'Older']);
});

test('REQ-79 every cell is sorted before the preview (3) and each "+N" (five more, REQ-92) are cut', () => {
  const view = board();
  let value = view;
  for (let i = 0; i < 6; i++) value = applyOperations(value, [add('Todo ' + i)], actor, context(T(1 + i))).board;
  for (let i = 0; i < 12; i++) value = applyOperations(value, [{ ...add('Done ' + i), stageId: 'done' }], actor, context(T(1 + i))).board;
  // Touch the two oldest todo cards last, so "latest change first" differs from both other orders.
  for (const [i, day] of [[0, 25], [1, 24]]) value = applyOperations(value,
    [{ op: 'update', id: value.cards.find(c => c.title === 'Todo ' + i).id, patch: { notes: 'touched' } }], actor, context(T(day))).board;
  const dto = toBoardDTO(value);
  const cell = (order, state = {}, stageId = 'todo') => laneModel(dto, state, false, '', new Set(), order).cells.find(c => c.stageId === stageId);
  assert.deepEqual(cell('default').cards.map(c => c.title), ['Todo 0', 'Todo 1', 'Todo 2']);
  assert.deepEqual(cell('updated').cards.map(c => c.title), ['Todo 0', 'Todo 1', 'Todo 5'], 'the three latest changes');
  assert.deepEqual(cell('created').cards.map(c => c.title), ['Todo 5', 'Todo 4', 'Todo 3'], 'the three newest');
  assert.equal(cell('created').remaining, 3);
  const done = cell('created', { steps: { done: 1 } }, 'done');
  assert.equal(done.cards.length, SWIMLANE.previewCount + SWIMLANE.moreStep);
  assert.deepEqual(done.cards.slice(0, 2).map(c => c.title), ['Done 11', 'Done 10'], 'the opened done column cuts the newest eight');
  assert.equal(done.openBoard, true);
  // Through the board model, as the screens call it.
  const directory = { wks_example01: { id: 'wks_example01', name: 'Example Workspace', projectId: 'prj_example01', projectName: 'Example Project' } };
  const model = swimlaneModel([dto], directory, [], false, {}, { cardOrder: 'updated' });
  assert.deepEqual(model.lanes[0].cells[0].cards.map(c => c.title), ['Todo 0', 'Todo 1', 'Todo 5']);
  assert.deepEqual(swimlaneModel([dto], directory, [], false, {}).lanes[0].cells[0].cards.map(c => c.title), ['Todo 0', 'Todo 1', 'Todo 2'],
    'absent means the default');
});

test('REQ-79 × REQ-82 a quick move lands where the next read will put it in the chosen order', () => {
  const dto = { summary: { id: 'board_x', revision: 'e:1' }, template: { stages: [] },
    stages: [{ stageId: 'todo', countsAsDone: false, totalCount: 1, cards: [card('m', 'normal', T(3), T(3))] },
      { stageId: 'doing', countsAsDone: false, totalCount: 3,
        cards: [card('h', 'high', T(1), T(10), 'doing'), card('n1', 'normal', T(2), T(11), 'doing'), card('n2', 'normal', T(4), T(12), 'doing')] }] };
  const move = { boardId: 'board_x', cardId: 'm', to: 'doing', base: 'e:1', at: T(20) };
  // The column a move lands in is already in the screen's order (as the model sorts it).
  const inOrder = order => ({ ...dto, stages: dto.stages.map(s => ({ ...s, cards: sortCards(s.cards, order) })) });
  const column = (order, value = move) => ids(moveCard(inOrder(order), value, order).stages[1].cards);
  assert.deepEqual(column('default'), ['h', 'n1', 'm', 'n2'], 'the ledger order: its own place among the normal cards (made on the 3rd)');
  assert.deepEqual(column('created'), ['n2', 'm', 'n1', 'h'], 'newest first: its own place by creation');
  assert.deepEqual(column('updated'), ['m', 'n2', 'n1', 'h'], 'latest change first: the move is the latest change, so it leads');
  assert.equal(moveCard(dto, move).stages[1].cards.find(c => c.id === 'm').updatedAt, T(20), 'the move stamps the card changed');
  assert.equal(moveCard(dto, { ...move, at: undefined }).stages[1].cards.find(c => c.id === 'm').updatedAt, T(3), 'no time, no stamp');
  assert.deepEqual(ids(applyPendingMoves([dto], [move], 'updated')[0].stages[1].cards), ['m', 'h', 'n1', 'n2']);
  assert.deepEqual(ids(applyPendingMoves([dto], [move])[0].stages[1].cards), ['h', 'n1', 'm', 'n2'], 'the default order by default');
  // The screens sort every column again, which leaves this placement unchanged.
  for (const order of CARD_ORDERS) {
    const placed = moveCard(inOrder(order), move, order).stages[1].cards;
    assert.equal(sortCards(placed, order), placed, order + ': already in order');
  }
  assert.deepEqual(ids(placeCard([], card('q', 'low'), 'default')), ['q']);
});

test('REQ-79 ui-state keeps the card order only while it is not the default; an older file reads unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-order-')), host = 'host_example';
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ui-state.json');
  const old = { schemaVersion: 1, hosts: { [host]: { hiddenProjects: [], order: { projects: [], workspaces: [] }, settings: { boardAlign: 'left' } } } };
  await writeFile(file, JSON.stringify(old));
  assert.deepEqual((await readUiState(dir, host)).settings, { boardAlign: 'left' }, 'an older file: the order is the default, nothing added');
  let result = await writeUiState(dir, host, { settings: { cardOrder: 'updated' } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings, { boardAlign: 'left', cardOrder: 'updated' });
  assert.equal((await writeUiState(dir, host, { settings: { cardOrder: 'updated' } })).changed, false, 'the same value writes nothing');
  result = await writeUiState(dir, host, { settings: { cardOrder: 'default' } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings, { boardAlign: 'left' }, 'the default takes the field out again');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), old, 'the file is back to the older shape byte for byte in meaning');
  // Only the known values survive a damaged file.
  await writeFile(file, JSON.stringify({ schemaVersion: 1, hosts: { [host]: { settings: { cardOrder: 'oldest' } } } }));
  assert.equal((await readUiState(dir, host)).settings, undefined);
  // The write RPC takes one of the three; replies may carry it.
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { cardOrder: 'created' } }).success, true);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { cardOrder: 'default' } }).success, true);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { cardOrder: 'oldest' } }).success, false);
  assert.equal(uiStateSchema.safeParse({ hiddenProjects: [], order: { projects: [], workspaces: [] }, settings: { cardOrder: 'updated' } }).success, true);
});

test('REQ-80 the hover fill and the on line read in every Paseo theme, from host tokens only', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]);
    for (const base of [c.surface0, c.surface1, c.surface2]) {
      const fill = hoverFill(c, base);
      assert.match(fill, /^#[0-9a-f]{6}$/);
      // research/121 H2: 1.33 on a light page was too faint; the change under the mouse is now at least 1.6:1.
      assert.equal(HOVER_CONTRAST, 1.6);
      assert.ok(contrast(fill, base) >= HOVER_CONTRAST, `${mode} ${base}: the hover fill stands apart (${contrast(fill, base).toFixed(2)})`);
      assert.ok(contrast(fill, c.surface0) >= HOVER_CONTRAST, `${mode} ${base}: and from the page (${contrast(fill, c.surface0).toFixed(2)})`);
      assert.ok(contrast(fill, base) < 2.2, `${mode} ${base}: a hover, not a second on state (${contrast(fill, base).toFixed(2)})`);
      assert.notEqual(fill.toLowerCase(), selectedLine(c, c.surface0).toLowerCase(), 'never the on line colour');
      assert.ok(contrast(c.foreground, fill) >= 4.5, `${mode}: text and glyphs stay readable on it`);
    }
    // The toggle's on line is REQ-82's selected line: 2px, 3.5:1 against the page.
    assert.equal(SELECTED_LINE_WIDTH, 2);
    assert.ok(contrast(selectedLine(c, c.surface0), c.surface0) >= 3.5);
  }
  assert.equal(hoverFill({ foreground: 'rgb(0,0,0)' }, '#ffffff'), '#ffffff', 'a colour it cannot read is left alone');
});
