import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createDemoData } from '../dist/client/demo.js';
import { filledLanes, filledProjects, swimlaneModel, swimlaneWidth, gridWidth, SWIMLANE } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { boardHeaderWidth } from '../dist/client/layout.js';
import { overviewSelection, projectWorkspaceKeys, workspaceKey } from '../dist/client/presentation.js';
import { canMove, compareByOrder, moveKey, orderActions, pinGroup, resetGroup, emptyLaneOrder } from '../dist/client/order-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { readUiState, writeUiState } from '../dist/server/ui-state.js';
import { overviewGet, uiStateSet } from '../dist/shared/rpc.js';
import { fixture } from './helpers.mjs';

const demo = () => createDemoData('en');
const projectsOf = model => model.groups.map(g => g.projectName);
const lanesOf = (model, name) => model.groups.find(g => g.projectName === name).lanes.map(l => l.workspaceKey);

test('REQ-59 a move only ever shifts one key inside its own group, and the ends cannot move further', () => {
  const keys = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveKey(keys, 'c', 'top'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(moveKey(keys, 'c', 'up'), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveKey(keys, 'b', 'down'), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveKey(keys, 'a', 'up'), keys, 'the first row stays first');
  assert.deepEqual(moveKey(keys, 'd', 'down'), keys, 'the last row stays last');
  assert.deepEqual([canMove(keys, 'a', 'top'), canMove(keys, 'a', 'up'), canMove(keys, 'a', 'down')], [false, false, true]);
  assert.deepEqual([canMove(keys, 'd', 'up'), canMove(keys, 'd', 'down')], [true, false]);
  assert.equal(canMove(keys, 'missing', 'up'), false);
  assert.equal(canMove(['only'], 'only', 'up') || canMove(['only'], 'only', 'down'), false, 'a lone row has nowhere to go');
  // Pinning a group keeps the slots of keys outside it — another project, or one the filter hides.
  assert.deepEqual(pinGroup(['x', 'a', 'y', 'b'], ['b', 'a', 'new']), ['x', 'b', 'y', 'a', 'new']);
  assert.deepEqual(resetGroup(['x', 'a', 'y', 'b'], ['a', 'b']), ['x', 'y']);
  // Listed keys lead; two unlisted keys are left to the automatic sort.
  assert.ok(compareByOrder(['b'], 'b', 'a') < 0); assert.ok(compareByOrder(['b'], 'a', 'b') > 0);
  assert.equal(compareByOrder(['b'], 'a', 'c'), 0);
});

test('REQ-59 ③ the arranged order beats the automatic one, later rows sort automatically behind it, and D22 stays last', () => {
  const data = demo(), auto = swimlaneModel(data.boards, data.directory, [], false);
  const names = projectsOf(auto), ids = auto.groups.map(g => g.projectId);
  assert.ok(ids.length >= 4 && ids.every(Boolean));
  // REQ-64: the demo's last project holds no card, so it is a lower layer of its own; these moves stay in the upper one.
  const filled = filledProjects(auto.groups), upper = ids.filter(id => filled.has(id)), mover = upper.at(-1);
  assert.deepEqual(upper, ids.slice(0, -1));
  // Move the upper layer's last project to the top the way the ⋯ menu does.
  let order = emptyLaneOrder();
  const arrange = orderActions(order, next => { order = next; }, ids, filled);
  arrange.project(mover).onMove('top');
  assert.deepEqual(order.projects, [mover, ...upper.slice(0, -1)], 'one move pins its whole layer as shown');
  const moved = swimlaneModel(data.boards, data.directory, [], false, {}, { order });
  assert.deepEqual(projectsOf(moved), [names.at(-2), ...names.slice(0, -2), names.at(-1)]);
  // The pinned project stays on top even when the attention filter would have ranked it lower.
  const pinnedOnly = { projects: [mover], workspaces: [] };
  const partial = swimlaneModel(data.boards, data.directory, [], false, {}, { order: pinnedOnly });
  assert.deepEqual(projectsOf(partial), [names.at(-2), ...names.slice(0, -2), names.at(-1)], 'unpinned projects keep their automatic order behind it');
  // Workspaces move inside their own project (and layer) only.
  const big = auto.groups.find(g => filledLanes(g.lanes).size >= 3), keys = big.lanes.map(l => l.workspaceKey);
  const full = keys.filter(k => filledLanes(big.lanes).has(k));
  order = emptyLaneOrder();
  orderActions(order, next => { order = next; }, ids, filled).lane(keys, full.at(-1), filledLanes(big.lanes)).onMove('up');
  const lanes = lanesOf(swimlaneModel(data.boards, data.directory, [], false, {}, { order }), big.projectName);
  assert.deepEqual(lanes, [...full.slice(0, -2), full.at(-1), full.at(-2), ...keys.slice(full.length)]);
  assert.deepEqual(projectsOf(swimlaneModel(data.boards, data.directory, [], false, {}, { order })), names,
    'moving a workspace never reorders projects');
  // The same order reaches 390px and the list screen.
  const mobile = mobileSwimlaneModel(data.boards, data.directory, [], false, {}, 'todo', { order: { projects: [mover], workspaces: [] } });
  assert.equal(mobile.groups[0].projectName, names.at(-2));
  const overview = { boards: data.boards.map(b => ({ ...b.summary, needsHuman: 0 })), attention: [] };
  const listed = overviewSelection(overview, data.directory, [], 'all', { projects: [mover], workspaces: [] });
  assert.equal(data.directory[listed.boards[0].workspaceId].projectId, mover);
  const listedLanes = overviewSelection(overview, data.directory, [], 'all', order).boards
    .filter(b => data.directory[b.workspaceId]?.projectId === big.projectId).map(b => workspaceKey(data.directory, b.workspaceId, b.cwd));
  assert.deepEqual(listedLanes.slice(full.length - 2, full.length), [full.at(-1), full.at(-2)], 'the list follows the arranged workspace order too');
  // D22 ④: a board Paseo no longer has sits in the last group even if its project id was pinned.
  const orphan = { ...data.boards[0], summary: { ...data.boards[0].summary, id: 'demo_orphan', workspaceId: 'local_gone', cwd: '/gone' } };
  const withOrphan = swimlaneModel([...data.boards, orphan], data.directory, [], false, {}, { order: { projects: ['', ...ids], workspaces: [] } });
  assert.equal(withOrphan.groups.at(-1).projectId, '');
});

test('REQ-59 ③ a project reset forgets only that project, and the reset-all empties the order', () => {
  const data = demo(), auto = swimlaneModel(data.boards, data.directory, [], false);
  const [first, second] = auto.groups.filter(g => g.lanes.length >= 2);
  const keysOf = group => projectWorkspaceKeys(data.boards, data.directory, group.projectId);
  assert.equal(keysOf(first).length, first.workspaceCount);
  let order = { projects: [second.projectId], workspaces: [...keysOf(first).reverse(), ...keysOf(second)] };
  const arrange = orderActions(order, next => { order = next; }, auto.groups.map(g => g.projectId));
  assert.equal(arrange.canReset(keysOf(first)), true); assert.equal(arrange.arranged, true);
  arrange.reset(keysOf(first));
  assert.deepEqual(order, { projects: [second.projectId], workspaces: keysOf(second) });
  assert.equal(orderActions(order, () => {}, []).canReset(keysOf(first)), false);
  orderActions(order, next => { order = next; }, []).resetAll();
  assert.deepEqual(order, emptyLaneOrder()); assert.equal(orderActions(order, () => {}, []).arranged, false);
});

test('REQ-59 ② the order is remembered per host beside the filter, each field written alone and only when it changes', async t => {
  const f = await fixture(t), handlers = createReadHandlers(f.store, () => '2026-01-01T00:00:00.000Z');
  const file = join(f.store.dataDir, 'ui-state.json');
  const ok = (reply, contract) => { contract.output.parse(reply); assert.equal(reply.ok, true); return reply.data; };
  ok(await handlers.ui({ hostId: 'host_a', hiddenProjects: ['prj_hidden'] }), uiStateSet);
  const order = { projects: ['prj_b', 'prj_a', 'prj_b'], workspaces: ['wks_2', 'wks_1'] };
  const moved = ok(await handlers.ui({ hostId: 'host_a', order }), uiStateSet);
  assert.deepEqual(moved, { hiddenProjects: ['prj_hidden'], order: { projects: ['prj_b', 'prj_a'], workspaces: ['wks_2', 'wks_1'] }, changed: true },
    'the order keeps its sequence (never sorted), drops repeats and leaves the filter alone');
  const stamp = (await fs.stat(file)).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(ok(await handlers.ui({ hostId: 'host_a', order: moved.order }), uiStateSet).changed, false);
  assert.equal((await fs.stat(file)).mtimeMs, stamp, 'the same order is not rewritten');
  ok(await handlers.ui({ hostId: 'host_a', hiddenProjects: [] }), uiStateSet);
  assert.deepEqual(ok(await handlers.overview({ hostId: 'host_a' }), overviewGet).ui,
    { hiddenProjects: [], order: moved.order }, 'changing the filter keeps the order');
  assert.deepEqual(ok(await handlers.overview({ hostId: 'host_b' }), overviewGet).ui.order, { projects: [], workspaces: [] }, 'one host at a time');
  // A damaged order reads as automatic and is never repaired behind the user.
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.hosts.host_a.order = { projects: 'nope', workspaces: [1, '', 'wks_ok', 'wks_ok'] };
  await fs.writeFile(file, JSON.stringify(stored));
  assert.deepEqual((await readUiState(f.store.dataDir, 'host_a')).order, { projects: [], workspaces: ['wks_ok'] });
  // Nothing but these two fields, and at least one of them.
  assert.throws(() => uiStateSet.input.parse({ hostId: 'host_a' }));
  assert.throws(() => uiStateSet.input.parse({ hostId: 'host_a', order: { projects: [], workspaces: [], extra: 1 } }));
  assert.throws(() => uiStateSet.input.parse({ hostId: 'host_a', order: { projects: [''], workspaces: [] } }));
  // The write helper leaves no temporary file behind.
  await writeUiState(f.store.dataDir, 'host_c', { order: { projects: ['prj_x'], workspaces: [] } });
  assert.deepEqual((await fs.readdir(f.store.dataDir)).filter(n => n.startsWith('.')), []);
  assert.deepEqual(await f.store.readConfig(), { schemaVersion: 1, exportEnabled: true, locale: 'en', export: { detail: 'compact' } },
    'the core never sees the order');
});

test('REQ-60 ⑤ the indent is one 8px step deeper, and the shared right edge moves out with it', () => {
  assert.equal(SWIMLANE.laneIndent, 24); assert.ok(SWIMLANE.laneIndent >= 24 && SWIMLANE.laneIndent <= 32);
  assert.equal(SWIMLANE.mobileLaneIndent, 12); assert.ok(SWIMLANE.mobileLaneIndent >= 8 && SWIMLANE.mobileLaneIndent <= 12);
  assert.ok(SWIMLANE.railInset > 0 && SWIMLANE.railInset + 1 < SWIMLANE.laneIndent, 'the rail sits inside the indent');
  assert.ok(SWIMLANE.mobileRailInset > 0 && SWIMLANE.mobileRailInset + 1 < SWIMLANE.mobileLaneIndent);
  assert.equal(swimlaneWidth(), gridWidth() + SWIMLANE.laneIndent);
  // The title/filter row ends where the done column ends: indent + four columns, or the padded window.
  assert.equal(boardHeaderWidth(1400, swimlaneWidth()), SWIMLANE.laneIndent + gridWidth());
  assert.equal(boardHeaderWidth(1100, swimlaneWidth()), 1068);
});
