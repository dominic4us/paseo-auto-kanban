import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyOperations, stableStringify } from '../dist/server/core/index.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { overviewGet } from '../dist/shared/rpc.js';
import { laneModel, swimlaneModel, gridWidth, cardDimensions, SWIMLANE } from '../dist/client/swimlane-model.js';
import { projectColorIndex, projectInitial, projectViewKeys } from '../dist/client/project-icon.js';
import { projectColors } from '../dist/client/palette.js';
import { sessionFor } from '../dist/client/session-store.js';
import { board, context, actor, add, fixture, request } from './helpers.mjs';

function example(key = 'one', counts = { todo: 5, doing: 4, review: 4, done: 12 }) {
  const base = board();
  base.workspaceId = 'wks_' + key;
  base.id = 'board_' + createHash('sha256').update(key).digest('hex');
  const operations = Object.entries(counts).flatMap(([stageId, count]) => Array.from({ length: count }, (_, i) => ({
    ...add(`${key} ${stageId} ${i}`), stageId, nextAction: i % 2 ? 'Inspect the result' : '', notes: 'Example evidence. '.repeat(20),
  })));
  const value = operations.length ? applyOperations(base, operations, actor, context()).board : base;
  return { value, dto: toBoardDTO(value) };
}
function name(dto, projectId, projectName = projectId) {
  return { [dto.summary.workspaceId]: { id: dto.summary.workspaceId, name: dto.summary.workspaceId,
    projectId, projectName, projectViewKey: JSON.stringify(['host_example', projectId]) } };
}
test('lane previews show three cards; opening a lane shows five more per column (REQ-92), done too', () => {
  const { dto } = example();
  const preview = laneModel(dto);
  assert.deepEqual(preview.cells.map(c => c.cards.length), [3, 3, 3, 3]);
  assert.equal(preview.expanded, false);
  const expanded = laneModel(dto, { steps: { todo: 1, doing: 1, review: 1, done: 1 } });
  assert.equal(expanded.expanded, true);
  assert.deepEqual(expanded.cells.map(c => c.cards.length), [5, 4, 4, 8]);
  assert.equal(expanded.cells[3].remaining, 4); assert.equal(expanded.cells[3].openBoard, true);
  // REQ-115: "Collapse" wherever a column shows more than three — the done column's eight of twelve too.
  assert.deepEqual(expanded.cells.map(c => c.open), [true, true, true, true], '"Collapse" where more than three show');
  assert.deepEqual(laneModel(dto, { steps: {} }).cells.map(c => c.cards.length), [3, 3, 3, 3]);
  assert.deepEqual(expanded.cells[0].cards.map(c => c.id), dto.stages[0].cards.map(c => c.id));
});
test('empty and done-only lanes start folded, while an explicit user choice wins', () => {
  assert.equal(laneModel(example('empty', {}).dto).collapsed, true);
  const { dto } = example('done', { done: 12 });
  dto.stages[3].cards[0].awaiting = 'user';
  assert.equal(laneModel(dto).collapsed, true); // Unit definition ⑥ takes precedence over the older wireframe exception.
  assert.equal(laneModel(dto, { collapsed: false }).collapsed, false);
  assert.equal(laneModel(example('active', { doing: 1 }).dto).collapsed, false);
});
test('attention filter deduplicates reasons, preserves summary totals and does not mutate saved fold choices', () => {
  const { dto } = example();
  dto.stages[0].cards[0].awaiting = 'user'; dto.stages[0].cards[0].blocked = true;
  dto.stages[0].cards[1].intent = 'draft';
  const preference = { collapsed: true, expanded: false };
  const result = laneModel(dto, preference, true);
  assert.equal(result.attention, 2); assert.equal(result.collapsed, false);
  assert.deepEqual(result.cells.map(c => c.cards.length), [2, 0, 0, 0]);
  assert.equal(result.board.summary.progress.requested, 25);
  assert.deepEqual(preference, { collapsed: true, expanded: false });
  assert.equal(laneModel(dto, preference, false).collapsed, true);
  assert.equal(laneModel(example('noattention').dto, {}, true).visible, false);
});
test('REQ-18 excludes done cards from attention without clearing stored awaiting', () => {
  const { dto } = example('done', { done: 12 }); dto.stages[3].cards.forEach(c => { c.awaiting = 'user'; });
  const result = laneModel(dto, { steps: { done: 2 } }, true);
  assert.equal(result.cells[3].cards.length, 0); assert.equal(result.cells[3].remaining, 0);
  assert.equal(result.cells[3].openBoard, false); assert.equal(result.attention, 0);
  assert.ok(dto.stages[3].cards.every(c => c.awaiting === 'user'));
});
test('REQ-24 attention projects come first, each project appears once and its attention lanes lead', () => {
  const a = example('a', { todo: 1 }).dto, b = example('b', { todo: 1 }).dto, c = example('c', { todo: 1 }).dto;
  a.stages[0].cards[0].awaiting = 'user'; b.stages[0].cards[0].blocked = true;
  a.summary.updatedAt = '2026-01-02T00:00:00.000Z'; b.summary.updatedAt = '2026-01-03T00:00:00.000Z';
  c.summary.updatedAt = '2026-01-04T00:00:00.000Z';
  const directory = { ...name(a, 'prj_alpha'), ...name(b, 'prj_beta'), ...name(c, 'prj_alpha') };
  const view = swimlaneModel([c, a, b], directory, [], false);
  assert.deepEqual(view.groups.map(g => [g.projectId, g.attentionSection]),
    [['prj_alpha', true], ['prj_beta', true]]);
  assert.equal(view.attention, 2);
  const selected = swimlaneModel([c, a, b], directory, ['prj_beta'], true);
  assert.equal(selected.groups.length, 1); assert.equal(selected.attention, 1);
  assert.equal(selected.requested, 2); assert.equal(selected.groups[0].lanes.length, 1);
});
test('workspace order within a project is updatedAt descending with stable name/id ties', () => {
  const a = example('a', { todo: 1 }).dto, b = example('b', { todo: 1 }).dto;
  const directory = { ...name(a, 'prj_example'), ...name(b, 'prj_example') };
  b.summary.updatedAt = '2026-02-01T00:00:00.000Z';
  assert.deepEqual(swimlaneModel([a, b], directory, [], false).groups[0].lanes.map(l => l.board.summary.id), [b.summary.id, a.summary.id]);
  b.summary.updatedAt = a.summary.updatedAt;
  assert.deepEqual(swimlaneModel([b, a], directory, [], false).groups[0].lanes.map(l => l.board.summary.id), [a.summary.id, b.summary.id]);
});
test('non-basic templates have a separate simple bottom list rather than being forced into basic columns', () => {
  const a = example('a').dto, other = example('other').dto; other.template.id = 'editorial';
  const view = swimlaneModel([other, a], {}, [], false);
  assert.equal(view.groups.length, 1); assert.deepEqual(view.other.map(l => l.board.summary.id), [other.summary.id]);
});
test('column/card widths stay fixed in wide windows; normal card budgets fit 84/104 and large type can grow', () => {
  assert.equal(gridWidth(), 1144); assert.equal(SWIMLANE.columnWidth, 280); assert.equal(SWIMLANE.cardWidth, 264);
  assert.equal(SWIMLANE.projectGap, 14); assert.equal(SWIMLANE.laneGap, 8);
  for (const next of [false, true]) {
    const metrics = cardDimensions(next);
    const required = 2 * metrics.paddingVertical + 2 + 2 * metrics.titleLineHeight + metrics.metaLineHeight +
      (next ? metrics.nextLineHeight : 0) + (next ? 2 : 1) * metrics.gap;
    assert.equal(metrics.height, next ? 104 : 84); assert.ok(required <= metrics.height);
    assert.equal(cardDimensions(next, 1.5).height, undefined);
  }
});
test('project colors match fixed vectors taken from the installed Paseo identity-color module', () => {
  for (const [key, color] of [['', '#7a6aa8'], ['prj_example01', '#7a6aa8'],
    ['["host_example","prj_example01"]', '#5179b0'], ['remote:example.org/team/repo', '#3d7ea6'], ['😀project', '#8f7838']]) {
    assert.equal(projectColors[projectColorIndex(key)], color);
  }
  for (const [name, initial] of [[' team/example ', 'E'], ['team///', 'T'], ['', ''], ['한글', '한'], ['ßeta', 'SS']])
    assert.equal(projectInitial(name), initial);
});
test('project view keys follow equivalence, duplicate-key placement and allocated-key collision rules', () => {
  const host = 'host_example', reserved = JSON.stringify([host, 'prj_first']);
  const keys = projectViewKeys(host, [
    { projectId: 'prj_first' }, { projectId: 'prj_second', projectKey: reserved },
    { projectId: 'prj_third', projectKey: 'same' }, { projectId: 'prj_fourth', projectKey: 'same' },
  ]);
  assert.equal(keys.get('prj_second'), reserved);
  assert.equal(keys.get('prj_first'), JSON.stringify(['placement', host, 'prj_first', 0]));
  assert.equal(keys.get('prj_third'), JSON.stringify([host, 'prj_third']));
  assert.equal(keys.get('prj_fourth'), JSON.stringify([host, 'prj_fourth']));
});
test('view selection memory survives component remounts, isolates hosts, and contains no persistence', () => {
  sessionFor('test-host-a:surface').set('board', 'example-board');
  assert.equal(sessionFor('test-host-a:surface').get('board'), 'example-board');
  assert.equal(sessionFor('test-host-b:surface').has('board'), false);
});
test('batch projection deduplicates IDs, isolates corrupt files and preserves the list-only RPC contract', async t => {
  const f = await fixture(t), h = createReadHandlers(f.store);
  await f.store.mutateBoard(f.id, request([add()]));
  const badId = 'board_' + 'f'.repeat(64);
  await fs.writeFile(join(f.store.dataDir, 'boards', badId + '.json'), '{broken');
  const result = await h.overview({ includeBoards: true, boardIds: [f.id, f.id, badId] });
  overviewGet.output.parse(result); assert.equal(result.ok, true);
  assert.equal(result.data.boardViews.length, 1); assert.equal(result.data.errors.length, 1);
  assert.equal(result.data.boardViews[0].stages[0].cards.length, 1);
  assert.equal('history' in result.data.boardViews[0], false);
  assert.equal((await h.overview({})).data.boardViews, undefined);
  assert.equal((await h.overview({ includeBoards: true, boardIds: ['../invalid'] })).error.code, 'E_VALIDATION');
});
test('20-board batch reads only changed bodies, measures response bytes and leaves business files untouched', async t => {
  const f = await fixture(t), ids = [f.id];
  const initial = example('initial', { todo: 5, doing: 5, review: 5, done: 5 }).value;
  Object.assign(initial, { id: f.id, workspaceId: 'wks_example01', cwd: f.cwd });
  await fs.writeFile(join(f.store.dataDir, 'boards', f.id + '.json'), stableStringify(initial));
  for (let i = 1; i < 20; i++) {
    const b = example('batch' + i, { todo: 5, doing: 5, review: 5, done: 5 }).value;
    b.cwd = f.cwd; ids.push(b.id);
    await fs.writeFile(join(f.store.dataDir, 'boards', b.id + '.json'), stableStringify(b));
  }
  const files = [join(f.store.dataDir, 'config.json'), ...ids.map(id => join(f.store.dataDir, 'boards', id + '.json'))];
  const beforeFiles = await Promise.all(files.map(async p => ({ content: await fs.readFile(p, 'utf8'), mtime: (await fs.stat(p)).mtimeMs })));
  const h = createReadHandlers(f.store);
  const before = f.store.readMetrics(); const cold = await h.overview({ includeBoards: true });
  const middle = f.store.readMetrics(); const warm = await h.overview({ includeBoards: true }); const after = f.store.readMetrics();
  assert.equal(cold.data.boardViews.length, 20); assert.equal(middle.boardReads - before.boardReads, 20);
  assert.equal(after.boardReads - middle.boardReads, 0);
  assert.deepEqual(await Promise.all(files.map(async p => ({ content: await fs.readFile(p, 'utf8'), mtime: (await fs.stat(p)).mtimeMs }))), beforeFiles);
  assert.deepEqual(f.store.diagnostics(), { activeTimers: 0, activeWatchers: 0 });
  t.diagnostic(JSON.stringify({ benchmark: 'swimlane-20x20', cold: { reads: middle.readFiles - before.readFiles,
    boardReads: middle.boardReads - before.boardReads, bytes: middle.readBytes - before.readBytes,
    responseBytes: Buffer.byteLength(JSON.stringify(cold)) }, warm: { reads: after.readFiles - middle.readFiles,
    boardReads: after.boardReads - middle.boardReads, bytes: after.readBytes - middle.readBytes,
    responseBytes: Buffer.byteLength(JSON.stringify(warm)) } }));
  await f.store.mutateBoard(f.id, request([{ op: 'update', id: initial.cards[0].id, patch: { title: 'Changed card' } }]));
  const baseline = f.store.readMetrics(); const partial = await h.overview({ includeBoards: true, boardIds: [f.id] });
  assert.equal(partial.data.boardViews.length, 1); assert.equal(f.store.readMetrics().boardReads - baseline.boardReads, 1);
  await fs.unlink(join(f.store.dataDir, 'boards', f.id + '.json'));
  assert.deepEqual((await h.overview({ includeBoards: true, boardIds: [f.id] })).data.removedIds, [f.id]);
});
