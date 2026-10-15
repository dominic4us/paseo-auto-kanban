import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { applyOperations, builtinTemplate, stableStringify, openStore } from '../dist/server/core/index.js';
import { completionTimes, toBoardDTO, toOverview } from '../dist/server/read-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { overviewGet, boardGet, cardGet, revisionsGet, uiStateSet } from '../dist/shared/rpc.js';
import { overviewSelection, workspaceName } from '../dist/client/presentation.js';
import { palette } from '../dist/client/palette.js';
import { board, context, actor, fixture, request, add } from './helpers.mjs';

function changed(b, operations, at = '2026-01-01T01:00:00.000Z') {
  return applyOperations(b, operations, actor, context(at)).board;
}
function example() {
  const b = changed(board(), [add()]);
  return { b, id: b.cards[0].id };
}
function ok(result, contract) {
  assert.equal(result.ok, true, JSON.stringify(result));
  contract.output.parse(result);
  assert.equal(result.committed, false);
  return result.data;
}
async function snapshot(root) {
  const files = {};
  async function walk(dir) {
    for (const name of await fs.readdir(dir)) {
      const path = join(dir, name), info = await fs.lstat(path);
      if (info.isDirectory()) await walk(path);
      else files[path] = { mtime: info.mtimeMs, content: await fs.readFile(path, 'base64') };
    }
  }
  await walk(root); return files;
}
test('plugin DTO derives agent IDs without notes, criteria, receipts or movement history', () => {
  let { b, id } = example();
  const agentId = randomUUID();
  b = changed(b, [{ op: 'link', id, agentId, role: 'worker', label: 'Example worker' },
    { op: 'update', id, patch: { notes: 'Private note', awaiting: 'user' } }]);
  const dto = toBoardDTO(b), card = dto.stages[0].cards[0];
  assert.deepEqual(card.agentIds, [agentId]); assert.equal(card.agents, 1);
  assert.equal(dto.agentLabels[agentId], 'Example worker');
  for (const key of ['notes', 'acceptanceCriteria', 'history', 'receipts']) assert.equal(key in card, false);
  assert.equal(JSON.stringify(dto).includes('Private note'), false);
  assert.equal('history' in dto, false); assert.equal('receipts' in dto, false);
});
test('completion preserves done-to-done date and restarts after reopening', () => {
  let { b, id } = example();
  b.template.stages.push({ stageId: 'released', name: 'Released', countsAsDone: true });
  b = changed(b, [{ op: 'move', id, to: 'done' }], '2026-01-02T00:00:00.000Z');
  b = changed(b, [{ op: 'move', id, to: 'released' }], '2026-01-03T00:00:00.000Z');
  assert.equal(completionTimes(b).get(id), '2026-01-02T00:00:00.000Z');
  b = changed(b, [{ op: 'move', id, to: 'doing' }], '2026-01-04T00:00:00.000Z');
  assert.equal(toBoardDTO(b).stages[1].cards[0].completedAt, null);
  b = changed(b, [{ op: 'move', id, to: 'done' }], '2026-01-05T00:00:00.000Z');
  assert.equal(completionTimes(b).get(id), '2026-01-05T00:00:00.000Z');
});
test('completion starts on creation in a done stage and ignores notes updates', () => {
  let b = changed(board(), [{ ...add(), stageId: 'done' }]);
  const first = b.cards[0];
  b = changed(b, [{ op: 'update', id: first.id, patch: { notes: 'Reviewed' } }], '2026-01-02T00:00:00.000Z');
  assert.equal(completionTimes(b).get(first.id), first.createdAt);
});
test('missing completion entry history remains visible, including done-to-done tail', () => {
  let { b, id } = example(); b = changed(b, [{ op: 'move', id, to: 'done' }]);
  b.history = [{ ...b.history.at(-1), from: 'done' }];
  const dto = toBoardDTO(b, 'en', '7d', Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(dto.stages[3].cards[0].completedAt, null); assert.equal(dto.stages[3].hiddenCount, 0);
  b.history = []; assert.equal(toBoardDTO(b, 'en', '30d').stages[3].cards.length, 1);
});
test('server folding changes only visibility, preserving progress and human attention', () => {
  let { b, id } = example();
  b = changed(b, [{ op: 'move', id, to: 'done' }, { op: 'update', id, patch: { awaiting: 'user' } }]);
  const dto = toBoardDTO(b, 'en', '7d', Date.parse('2026-02-01T00:00:00Z'));
  assert.equal(dto.stages[3].hiddenCount, 1); assert.equal(dto.stages[3].cards.length, 0);
  assert.equal(dto.stages[3].totalCount, 1); assert.equal(dto.summary.progress.percent, 100);
  assert.equal(toOverview([b], 'en', b.updatedAt).attention.length, 0);
  assert.equal(toBoardDTO(b, 'en', 'off').stages[3].cards.length, 1);
});
test('archived cards never appear and builtin display names follow locale', () => {
  let { b, id } = example(); b = changed(b, [{ op: 'archive', id }]);
  assert.equal(toBoardDTO(b, 'ko').stages.flatMap(s => s.cards).length, 0);
  assert.equal(toBoardDTO(b, 'ko').stages[0].name, builtinTemplate('ko').stages[0].name);
  b.template.id = 'example'; b.template.stages[0].name = 'Custom stage';
  assert.equal(toBoardDTO(b, 'ko').stages[0].name, 'Custom stage');
});
test('read RPCs return validated DTOs and only the selected card history', async t => {
  const f = await fixture(t); const added = await f.store.mutateBoard(f.id, request([add('One'), add('Two')]));
  const handlers = createReadHandlers(f.store);
  const overview = ok(await handlers.overview({}), overviewGet);
  assert.equal(overview.boards.length, 1);
  const b = ok(await handlers.board({ workspaceId: 'wks_example01' }), boardGet);
  assert.equal(b.board.stages[0].cards.length, 2);
  const id = added.data.cardIds[0];
  const detail = ok(await handlers.card({ boardId: f.id, cardId: id }), cardGet);
  assert.ok(detail.history.every(h => h.cardId === id)); assert.equal(detail.history.length, 1);
  assert.equal('receipts' in detail, false);
  assert.equal(ok(await handlers.revisions({ boardIds: [f.id] }), revisionsGet).boards[0].revision, b.revision);
});
test('read-only startup with missing dataDir leaves no directories or timers', async t => {
  const f = await fixture(t), missing = join(f.root, 'not-created');
  const store = await openStore({ dataDir: missing }); const h = createReadHandlers(store);
  assert.deepEqual(ok(await h.overview({}), overviewGet).boards, []);
  assert.deepEqual(ok(await h.revisions({}), revisionsGet).boards, []);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  assert.deepEqual(store.diagnostics(), { activeTimers: 0, activeWatchers: 0 });
});
test('repeated read handlers and cached revision probes preserve every file and read zero board bodies', async t => {
  const f = await fixture(t); await f.store.mutateBoard(f.id, request([add()]));
  const h = createReadHandlers(f.store); ok(await h.overview({}), overviewGet);
  const before = await snapshot(f.root), metrics = f.store.readMetrics();
  for (let i = 0; i < 10; i++) {
    ok(await h.revisions({}), revisionsGet); ok(await h.board({ boardId: f.id }), boardGet);
  }
  assert.equal(f.store.readMetrics().boardReads - metrics.boardReads, 0);
  assert.deepEqual(await snapshot(f.root), before);
});
test('revision cache detects atomic CLI/store changes, new boards and deletion', async t => {
  const f = await fixture(t), h = createReadHandlers(f.store);
  const first = ok(await h.revisions({}), revisionsGet).boards[0].revision;
  const writer = await openStore({ dataDir: f.store.dataDir });
  const added = await writer.mutateBoard(f.id, request([add()]));
  assert.notEqual(added.data.revision, first);
  const before = f.store.readMetrics().boardReads;
  assert.equal(ok(await h.revisions({}), revisionsGet).boards[0].revision, added.data.revision);
  assert.equal(f.store.readMetrics().boardReads - before, 1);
  const second = await writer.initBoard({ cwd: f.cwd, workspaceId: 'wks_example02', actor, requestId: randomUUID() });
  assert.equal(ok(await h.overview({}), overviewGet).boards.length, 2);
  await fs.unlink(join(f.store.dataDir, 'boards', `${second.data.boardId}.json`));
  assert.deepEqual(ok(await h.revisions({}), revisionsGet).removedIds, [second.data.boardId]);
});
test('corrupt boards are isolated, diagnosed and preserved', async t => {
  const f = await fixture(t), h = createReadHandlers(f.store);
  const badId = `board_${'f'.repeat(64)}`, file = join(f.store.dataDir, 'boards', `${badId}.json`);
  await fs.writeFile(file, '{broken');
  const data = ok(await h.overview({}), overviewGet);
  assert.equal(data.boards.length, 1); assert.equal(data.errors.length, 1);
  assert.equal(data.errors[0].code, 'E_CORRUPT');
  assert.equal((await h.board({ boardId: badId })).ok, false);
  assert.equal(ok(await h.board({ workspaceId: 'wks_example01' }), boardGet).board.summary.id, f.id);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});
test('read RPC validation rejects ambiguous IDs, traversal and unexpected fields', async t => {
  const f = await fixture(t), h = createReadHandlers(f.store);
  for (const input of [{}, { boardId: f.id, workspaceId: 'wks_example01' }, { boardId: '../outside' }]) {
    const reply = await h.board(input); assert.equal(reply.ok, false); assert.equal(reply.error.code, 'E_VALIDATION');
    boardGet.output.parse(reply);
  }
  assert.equal((await h.overview({ dataDir: '/tmp/example' })).error.code, 'E_VALIDATION');
  assert.equal((await h.board({ workspaceId: 'wks_not_registered' })).error.code, 'E_NOT_FOUND');
  assert.equal((await h.card({ boardId: f.id, cardId: `card_${randomUUID()}` })).error.code, 'E_NOT_FOUND');
});
test('symlink board probes never follow a file outside the ledger', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside.json'); await fs.writeFile(outside, '{}');
  const id = `board_${'e'.repeat(64)}`; await fs.symlink(outside, join(f.store.dataDir, 'boards', `${id}.json`));
  const data = ok(await createReadHandlers(f.store).overview({}), overviewGet);
  assert.equal(data.errors[0].code, 'E_PATH_FORBIDDEN');
});
test('overview filters affect the intended scopes and fall back to directory names', () => {
  const { b } = example(); b.cards[0].awaiting = 'user';
  const other = { ...structuredClone(b), id: `board_${'b'.repeat(64)}`, workspaceId: 'wks_example02' };
  other.cards[0].awaiting = null;
  const data = toOverview([b, other], 'en', b.updatedAt);
  const directory = { [b.workspaceId]: { name: 'Workspace One', projectName: 'Example Project', projectId: 'prj_example01' } };
  assert.equal(overviewSelection(data, directory, [], 'draft').boards.length, 2);
  assert.equal(overviewSelection(data, directory, [], 'draft').attention.length, 0);
  // REQ-57 ④: unchecking a project hides it; the unlinked workspace keeps its own '' key.
  assert.equal(overviewSelection(data, directory, [''], 'all').boards.length, 1);
  assert.equal(overviewSelection(data, directory, ['prj_example01'], 'all').boards.length, 1);
  assert.equal(overviewSelection(data, directory, ['prj_example01', ''], 'all').boards.length, 0);
  assert.equal(workspaceName('wks_unknown', '/tmp/example-workspace', directory), 'example-workspace');
});
test('palette follows host surface and non-hex custom colors fall back to tokens', () => {
  const colors = Object.fromEntries(['surface0','surface1','surface2','border','foreground','foregroundMuted',
    'accent','accentForeground','statusSuccess','statusWarning','statusDanger'].map(k => [k, '#111111']));
  assert.notEqual(palette({ colors }).draft, palette({ colors: { ...colors, surface0: '#ffffff' } }).draft);
  assert.equal(palette({ colors: { ...colors, surface0: 'custom-color' } }).draft, colors.foregroundMuted);
});
test('old installed CLI path remains executable and resolves the current version', () => {
  const env = { ...process.env }; delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID;
  const direct = spawnSync(process.execPath, [resolve('dist/src/cli/main.js'), '--version'], { env, encoding: 'utf8' });
  const legacy = spawnSync(resolve('dist/cli/main.js'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr); assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stdout, direct.stdout);
});
test('surface hook boundary, host modules and explicit commit effect stay visible', async () => {
  for (const name of ['overview.tsx', 'board.tsx', 'detail.tsx', 'data.ts', 'components.tsx']) {
    const s = await fs.readFile(join('client', name), 'utf8');
    assert.doesNotMatch(s, /\buse(?:Agent|Workspace)\s*\(/);
    assert.doesNotMatch(s, /\b(?:setInterval|setTimeout|fetch)\s*\(|\bdocument\./);
  }
  const server = await fs.readFile('index.server.ts', 'utf8');
  assert.doesNotMatch(server, /\.initBoard\(|\.initialize\(/);
  assert.match(server, /afterCommit: exportCommittedBoard/);
  assert.equal(JSON.parse(await fs.readFile('paseo-plugin.json', 'utf8')).build, undefined);
});
test('draft move nextAction supplies the promotion command and all-board human IDs are short', async t => {
  const f = await fixture(t), added = await f.store.mutateBoard(f.id, request([{ op: 'add', title: 'Draft', intent: 'draft' }]));
  await assert.rejects(f.store.mutateBoard(f.id, request([{ op: 'move', id: added.data.cardIds[0], to: 'doing' }])),
    e => e.code === 'E_TRANSITION' && e.nextAction.includes(`kanban card update ${added.data.cardIds[0]} --intent requested`));
  const env = { ...process.env }; delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID;
  const result = spawnSync(process.execPath, [resolve('dist/src/cli/main.js'), 'ls', '--all', '--data-dir', f.store.dataDir],
    { env, cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes(f.id.slice(0, 14)));
  assert.equal(result.stdout.includes(f.id), false);
});

test('thirty boards with one hundred cards use metadata-only steady probes and one changed-body read', async t => {
  const f = await fixture(t);
  const base = changed(board(), Array.from({ length: 100 }, (_, i) => ({ ...add(`Example ${i}`), notes: 'n'.repeat(4000) })));
  for (let i = 0; i < 29; i++) {
    const item = { ...base, id: `board_${i.toString(16).padStart(64, '0')}`, workspaceId: `wks_fixture${i}` };
    await fs.writeFile(join(f.store.dataDir, 'boards', `${item.id}.json`), stableStringify(item));
  }
  const h = createReadHandlers(f.store);
  assert.equal(ok(await h.overview({}), overviewGet).boards.length, 30);
  let before = f.store.readMetrics().boardReads;
  ok(await h.revisions({}), revisionsGet);
  assert.equal(f.store.readMetrics().boardReads - before, 0);
  await f.store.mutateBoard(f.id, request([add('Changed')]));
  before = f.store.readMetrics().boardReads;
  ok(await h.revisions({}), revisionsGet);
  assert.equal(f.store.readMetrics().boardReads - before, 1);
});
test('a duplicate workspace is diagnosed without blocking unrelated workspace reads', async t => {
  const f = await fixture(t), value = await f.store.readBoard(f.id);
  const duplicate = { ...value, id: `board_${'c'.repeat(64)}` };
  await fs.writeFile(join(f.store.dataDir, 'boards', `${duplicate.id}.json`), stableStringify(duplicate));
  const other = { ...value, id: `board_${'d'.repeat(64)}`, workspaceId: 'wks_other' };
  await fs.writeFile(join(f.store.dataDir, 'boards', `${other.id}.json`), stableStringify(other));
  const h = createReadHandlers(f.store);
  assert.equal((await h.board({ workspaceId: value.workspaceId })).error.code, 'E_CORRUPT');
  assert.equal(ok(await h.board({ workspaceId: other.workspaceId }), boardGet).board.summary.id, other.id);
});

/** REQ-57: a fake Paseo workspace directory, in the shape the installed SDK returns. */
function workspaceApi(entries) {
  let calls = 0;
  return { calls: () => calls, paseo: { workspaces: { list: async () => { calls++;
    return { entries, pageInfo: { nextCursor: null } }; } } } };
}
test('REQ-57 the overview lists every active Paseo workspace, synthesizing the ones with no board', async t => {
  const f = await fixture(t); await f.store.mutateBoard(f.id, request([add()]));
  const api = workspaceApi([
    { id: 'wks_example01', name: 'Has board', projectId: 'prj_a', workspaceDirectory: f.cwd, projectRootPath: f.cwd },
    { id: 'wks_empty01', name: 'No board', projectId: 'prj_a', workspaceDirectory: '/tmp/empty-one', projectRootPath: '/tmp/root' },
    { id: 'wks_empty02', name: 'Directory from the project root', projectId: 'prj_b', projectRootPath: '/tmp/root-two' },
    { id: 'wks_gone', name: 'Being archived', projectId: 'prj_b', archivingAt: '2026-09-01T00:00:00.000Z', workspaceDirectory: '/tmp/gone' },
    { id: 'not-a-workspace-id', name: 'Malformed', projectId: 'prj_b', workspaceDirectory: '/tmp/x' },
  ]);
  const handlers = createReadHandlers(f.store, () => '2026-01-01T00:00:00.000Z');
  const data = ok(await handlers.overview({ includeBoards: true }, api.paseo), overviewGet);
  assert.equal(api.calls(), 1, 'one workspace listing per request, shared with the label reader');
  assert.deepEqual(data.boardViews.map(b => b.summary.workspaceId),
    ['wks_example01', 'wks_empty01', 'wks_empty02'], 'archived and malformed entries are left out');
  assert.deepEqual(data.boards.map(b => b.workspaceId), ['wks_example01', 'wks_empty01', 'wks_empty02']);
  const [real, one, two] = data.boardViews;
  assert.equal(real.summary.hasLedger, undefined); assert.equal(one.summary.hasLedger, false);
  assert.equal(one.summary.id, 'empty:wks_empty01'); assert.equal(one.summary.cwd, '/tmp/empty-one');
  assert.equal(two.summary.cwd, '/tmp/root-two', 'the project root is the fallback directory');
  assert.equal(one.stages.length, 4); assert.ok(one.stages.every(s => !s.cards.length && !s.totalCount));
  assert.equal(one.summary.progress.percent, null); assert.deepEqual(one.summary.progress, { done: 0, requested: 0, draft: 0, archived: 0, percent: null });
  assert.equal(data.attention.every(c => c.boardId.startsWith('board_')), true, 'no card can belong to a synthesized board');
  // A partial refresh of named boards must not resynthesize or drop the rest of the list.
  const partial = ok(await handlers.overview({ includeBoards: true, boardIds: [f.id] }, api.paseo), overviewGet);
  assert.deepEqual(partial.boardViews.map(b => b.summary.workspaceId), ['wks_example01']);
  assert.equal(api.calls(), 2, 'the partial refresh asks for labels only');
});
test('REQ-57 board.get serves a board-less workspace as an empty board, by workspace id or view id', async t => {
  const f = await fixture(t);
  const api = workspaceApi([{ id: 'wks_empty01', name: 'No board', projectId: 'prj_a', workspaceDirectory: '/tmp/empty-one' }]);
  const handlers = createReadHandlers(f.store, () => '2026-01-01T00:00:00.000Z');
  for (const selector of [{ workspaceId: 'wks_empty01' }, { boardId: 'empty:wks_empty01' }]) {
    const data = ok(await handlers.board(selector, api.paseo), boardGet);
    assert.equal(data.board.summary.hasLedger, false); assert.equal(data.revision, '');
    assert.equal(data.board.summary.cwd, '/tmp/empty-one'); assert.equal(data.board.stages.length, 4);
  }
  const missing = await handlers.board({ workspaceId: 'wks_nothere' }, api.paseo);
  assert.equal(missing.ok, false); assert.equal(missing.error.code, 'E_NOT_FOUND');
  const noContext = await handlers.board({ workspaceId: 'wks_empty01' });
  assert.equal(noContext.ok, false, 'without Paseo there is nothing to vouch for the workspace');
  const real = ok(await handlers.board({ boardId: f.id }, api.paseo), boardGet);
  assert.equal(real.board.summary.hasLedger, undefined);
});
test('REQ-57 the project filter is remembered per host in the ledger and written only when it changes', async t => {
  // REQ-59 ②: the same record now also carries the arranged order, empty until the user moves something.
  const noOrder = { projects: [], workspaces: [] };
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, () => '2026-01-01T00:00:00.000Z');
  const before = (await fs.readdir(f.store.dataDir)).sort();
  assert.deepEqual(ok(await handlers.overview({ hostId: 'host_a' }), overviewGet).ui, { hiddenProjects: [], order: noOrder });
  assert.equal(ok(await handlers.overview({}), overviewGet).ui, undefined);
  assert.deepEqual((await fs.readdir(f.store.dataDir)).sort(), before, 'reading remembers nothing new');
  const first = ok(await handlers.ui({ hostId: 'host_a', hiddenProjects: ['prj_b', 'prj_a', 'prj_a'] }), uiStateSet);
  assert.deepEqual(first, { hiddenProjects: ['prj_a', 'prj_b'], order: noOrder, changed: true });
  const file = join(f.store.dataDir, 'ui-state.json');
  const stamp = (await fs.stat(file)).mtimeMs;
  const again = ok(await handlers.ui({ hostId: 'host_a', hiddenProjects: ['prj_a', 'prj_b'] }), uiStateSet);
  assert.equal(again.changed, false); assert.equal((await fs.stat(file)).mtimeMs, stamp, 'the same choice is not rewritten');
  assert.deepEqual(ok(await handlers.overview({ hostId: 'host_a' }), overviewGet).ui, { hiddenProjects: ['prj_a', 'prj_b'], order: noOrder });
  assert.deepEqual(ok(await handlers.overview({ hostId: 'host_b' }), overviewGet).ui, { hiddenProjects: [], order: noOrder }, 'one host at a time');
  ok(await handlers.ui({ hostId: 'host_b', hiddenProjects: ['prj_c'] }), uiStateSet);
  assert.deepEqual(ok(await handlers.overview({ hostId: 'host_a' }), overviewGet).ui, { hiddenProjects: ['prj_a', 'prj_b'], order: noOrder });
  // The core never sees this file: config, boards and the CLI are untouched by it.
  assert.deepEqual(await f.store.readConfig(), { schemaVersion: 1, exportEnabled: true, locale: 'en', export: { detail: 'compact' } });
  await fs.writeFile(file, '{ not json');
  assert.deepEqual(ok(await handlers.overview({ hostId: 'host_a' }), overviewGet).ui, { hiddenProjects: [], order: noOrder }, 'a damaged file hides nothing');
  assert.equal(await fs.readFile(file, 'utf8'), '{ not json', 'and is never repaired behind the user');
  assert.deepEqual((await fs.readdir(f.store.dataDir)).filter(n => n.startsWith('.')), [], 'no temporary file is left behind');
});
