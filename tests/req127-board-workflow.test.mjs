// REQ-127: the board screen a lane's name opens offers the lane's "Board | Workflow" (REQ-124) too. The server's `board.get` marks a
// board whose workspace folder holds `.kanban/workflow.json` (the same cached probe as the overview's lanes), for a workspace with no
// board yet as well; the flow's layout takes a column cap on the board screen's wide canvas and centres itself, while the lane's
// layout (no cap) is unchanged. The screens are in tests/plugin-ui.test.mjs and tests/web/run.mjs ("req127-…"). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { flowLayout, FLOW } from '../dist/client/workflow-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { boardGet } from '../dist/shared/rpc.js';
import { gateDefinition, otherDefinition, writeWorkspace } from './fixtures/workflow-fixtures.mjs';
import { fixture, actor } from './helpers.mjs';

test('REQ-127 board.get says whether the workspace holds a workflow definition — a board, and a workspace with no board yet', async t => {
  const { store, cwd, root } = await fixture(t);
  const second = join(root, 'second'); await fs.mkdir(second);
  await store.initBoard({ cwd: second, workspaceId: 'wks_example02', actor, requestId: crypto.randomUUID() });
  const empty = join(root, 'empty'); await fs.mkdir(empty);
  await writeWorkspace(cwd, gateDefinition, {});
  await writeWorkspace(empty, otherDefinition, {});
  const paseo = { workspaces: { list: async () => ({ entries: [{ id: 'wks_empty01', workspaceDirectory: empty }], pageInfo: { nextCursor: null } }) } };
  const handlers = createReadHandlers(store);
  const read = async (input, context) => { const reply = boardGet.output.parse(await handlers.board(input, context)); assert.equal(reply.ok, true); return reply.data.board.summary; };
  assert.equal((await read({ workspaceId: 'wks_example01' })).workflow, true);
  assert.equal('workflow' in await read({ workspaceId: 'wks_example02' }), false, 'no definition, nothing said');
  const pending = await read({ workspaceId: 'wks_empty01' }, paseo);
  assert.equal(pending.hasLedger, false); assert.equal(pending.workflow, true, 'a workspace with no board yet, as its lane');
  // The overview's lane and the board agree.
  const overview = await handlers.overview({ includeBoards: true });
  assert.equal(overview.data.boardViews.find(b => b.summary.workspaceId === 'wks_example01').summary.workflow, true);
  // A definition that goes away: the probe is cached a minute (server/workflow.ts), then the board says nothing either.
  await fs.rm(join(cwd, '.kanban'), { recursive: true, force: true });
  const fresh = createReadHandlers(store);
  const gone = boardGet.output.parse(await fresh.board({ workspaceId: 'wks_example01' }));
  assert.equal('workflow' in gone.data.board.summary, false);
});

test('REQ-127 the flow on the board screen: columns capped at FLOW.wideCol and centred; the lane (no cap) as it was', () => {
  const lane = flowLayout(gateDefinition.stages, 1118);
  assert.equal(lane.colW, Math.floor((1118 - 40) / 7), 'the lane\'s layout unchanged');
  assert.equal(lane.at.get('req').cx, FLOW.pad + lane.colW / 2, 'starting at the pad');
  assert.deepEqual(flowLayout(gateDefinition.stages, 1118, {}, {}, FLOW.wideCol), lane, 'a cap wider than the lane\'s columns changes nothing');
  // 1400: the board's flow (1350) under the cap — wider columns than the lane's, from the pad.
  const mid = flowLayout(gateDefinition.stages, 1350, {}, {}, FLOW.wideCol);
  assert.equal(mid.colW, Math.floor((1350 - 40) / 7)); assert.ok(mid.colW > lane.colW && mid.colW <= FLOW.wideCol);
  // 1920: capped, centred — as much room on either side, the canvas still the box's width (no sideways scroll).
  const wide = flowLayout(gateDefinition.stages, 1870, {}, {}, FLOW.wideCol);
  assert.equal(wide.colW, FLOW.wideCol); assert.equal(wide.width, 1870);
  const nodes = [...wide.at.values()], left = Math.min(...nodes.map(n => n.left)), right = wide.width - Math.max(...nodes.map(n => n.right));
  assert.ok(Math.abs(left - right) <= 1, JSON.stringify({ left, right }));
  assert.equal(wide.nodeW, FLOW.maxNodeW, 'the steps no wider than on the lane');
  assert.equal(wide.height, flowLayout(gateDefinition.stages, 1870).height, 'the rows as tall as ever');
  // A narrow box still scrolls (the minimum column wins over the cap).
  assert.equal(flowLayout(gateDefinition.stages, 500, {}, {}, FLOW.wideCol).colW, FLOW.minCol);
});
