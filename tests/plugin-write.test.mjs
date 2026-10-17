import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEnsureHandler, createMutationHandler } from '../dist/server/mutations.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { boardEnsure, boardMutate } from '../dist/shared/rpc.js';
import { createKanbanError, exportCommittedBoard, renderProcess, applyOperations, isUUID } from '../dist/server/core/index.js';
import { fixture, request, add, board, actor, context } from './helpers.mjs';
import { boardLayout, bottomClearance, editorLayout } from '../dist/client/layout.js';
import { editorReducer, emptyEditor, editorOperations, compareEdits, isDirty, newRequestId, reclaimSeconds } from '../dist/client/editor-state.js';
import { emptyMutation, mutationReducer } from '../dist/client/mutation-state.js';

const ui = (id, revision, operations, requestId = randomUUID()) => ({ boardId: id, ifRevision: revision, operations, requestId });
async function current(f) { return (await f.store.readBoard(f.id)).revision; }
function ok(reply) { boardMutate.output.parse(reply); assert.equal(reply.ok, true, JSON.stringify(reply)); return reply; }
function example() {
  const b = applyOperations(board(), [add()], actor, context()).board;
  const snapshot = { boardId: b.id, card: b.cards[0], template: b.template, history: b.history,
    revision: b.revision, observedAt: b.updatedAt, locale: 'en' };
  return { b, snapshot, editor: editorReducer(emptyEditor(), { type: 'load', snapshot }) };
}
test('mobile tabs consume exactly 44px rather than half the remaining height', () => {
  for (const width of [320, 390, 759, 1200]) {
    const layout = boardLayout(width, true);
    assert.equal(layout.tabs, true); assert.equal(layout.tabRow.height, 44);
    assert.equal(layout.tabRow.flexGrow, 0); assert.equal(layout.tabRow.flexShrink, 0);
    assert.equal(layout.tabRow.flex, undefined); assert.equal(layout.lane.height, undefined);
    assert.equal(layout.list.flex, 1);
  }
  assert.equal(boardLayout(760, false).tabs, false); assert.equal(boardLayout(759, false).tabs, true);
});
test('platform clearance and a bounded editor leave room for system buttons and keyboards', () => {
  assert.equal(bottomClearance('android'), 56); assert.equal(bottomClearance('ios'), 44);
  assert.equal(bottomClearance('web'), 16);
  for (const platform of ['android', 'ios']) for (const height of [844, 500]) {
    const layout = editorLayout(platform, true, height);
    assert.equal(layout.buttonHeight, 48); assert.equal(layout.inputHeight, 44);
    assert.ok(layout.sheetHeight < height); assert.ok(layout.bottom >= 44);
  }
  assert.equal(editorLayout('web', false, 900).buttonHeight, 30);
});
test('mutation records user even when the process inherits an agent identity; draft is forced into first stage', async t => {
  const previous = process.env.PASEO_AGENT_ID; process.env.PASEO_AGENT_ID = randomUUID();
  t.after(() => { if (previous === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previous; });
  const f = await fixture(t, { afterCommit: exportCommittedBoard }), mutate = createMutationHandler(f.store);
  const result = ok(await mutate(ui(f.id, await current(f), [{ op: 'add', title: 'Example draft' }])));
  const b = await f.store.readBoard(f.id), c = b.cards[0];
  assert.equal(result.committed, true); assert.deepEqual(c.createdBy, { kind: 'user' });
  assert.equal(c.intent, 'draft'); assert.equal(c.stageId, b.template.stages[0].stageId);
  assert.equal(c.acceptanceCriteria, ''); assert.equal(c.awaiting, null); assert.deepEqual(c.agents, []);
  assert.deepEqual(b.history.at(-1).actor, { kind: 'user' });
  assert.equal(await fs.readFile(join(f.cwd, 'PROCESS.md'), 'utf8'), renderProcess(b));
});
test('stale CAS is rejected without writes and same request replays before CAS', async t => {
  const f = await fixture(t), mutate = createMutationHandler(f.store), revision = await current(f);
  const payload = ui(f.id, revision, [{ op: 'add', title: 'Example draft' }]);
  const first = ok(await mutate(payload));
  const file = join(f.store.dataDir, 'boards', f.id + '.json'), before = await fs.readFile(file), stat = await fs.stat(file);
  const replay = ok(await mutate(payload));
  assert.equal(replay.data.replayed, true); assert.deepEqual(replay.data.cardIds, first.data.cardIds);
  assert.equal(replay.committed, false);
  const conflict = await mutate({ ...payload, requestId: randomUUID() });
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'E_REVISION_CONFLICT'); assert.equal(conflict.committed, false);
  assert.deepEqual(await fs.readFile(file), before); assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.equal((await f.store.readBoard(f.id)).cards.length, 1);
  const reused = await mutate({ ...payload, operations: [{ op: 'add', title: 'Different' }] });
  assert.equal(reused.error.code, 'E_REQUEST_REUSED');
});
test('no-op preserves ledger and PROCESS timestamps without new receipts', async t => {
  const f = await fixture(t, { afterCommit: exportCommittedBoard });
  const added = await f.store.mutateBoard(f.id, request([add()]));
  const mutate = createMutationHandler(f.store), before = await f.store.readBoard(f.id);
  const paths = [join(f.store.dataDir, 'boards', f.id + '.json'), join(f.cwd, 'PROCESS.md')];
  const times = await Promise.all(paths.map(async p => (await fs.stat(p)).mtimeMs));
  const result = ok(await mutate(ui(f.id, before.revision, [{ op: 'update', id: added.data.cardIds[0], patch: { notes: '' } }])));
  assert.equal(result.data.changed, false); assert.equal(result.committed, false);
  assert.deepEqual(await Promise.all(paths.map(async p => (await fs.stat(p)).mtimeMs)), times);
  assert.equal((await f.store.readBoard(f.id)).receipts.length, before.receipts.length);
});
test('six fields and stage move are atomic; drafts and completion prerequisites remain enforced', async t => {
  const f = await fixture(t), mutate = createMutationHandler(f.store);
  const draft = ok(await mutate(ui(f.id, await current(f), [{ op: 'add', title: 'Draft' }]))).data.cardIds[0];
  const denied = await mutate(ui(f.id, await current(f), [{ op: 'move', id: draft, to: 'doing' }]));
  assert.equal(denied.error.code, 'E_TRANSITION');
  assert.equal((await f.store.readBoard(f.id)).cards[0].stageId, 'todo');
  const ready = (await f.store.mutateBoard(f.id, request([add()]))).data.cardIds[0];
  ok(await mutate(ui(f.id, await current(f), [{ op: 'update', id: ready,
    patch: { title: 'Edited', notes: 'Evidence', nextAction: 'Review', priority: 'high', blockedReason: 'Access', awaiting: 'user' } }])));
  const before = await f.store.readBoard(f.id);
  const failed = await mutate(ui(f.id, before.revision, [{ op: 'update', id: ready, patch: { title: 'Must roll back' } },
    { op: 'move', id: ready, to: 'done' }]));
  assert.equal(failed.error.code, 'E_TRANSITION'); assert.deepEqual(await f.store.readBoard(f.id), before);
  ok(await mutate(ui(f.id, before.revision, [{ op: 'update', id: ready, patch: { blockedReason: null } },
    { op: 'move', id: ready, to: 'done' }])));
  assert.equal((await f.store.readBoard(f.id)).cards.find(c => c.id === ready).awaiting, 'user');
});
// REQ-103 ②: the criteria became a detail field (a tick on a checklist line); the rest stays the CLI's.
test('RPC rejects actor, intent, archive and linked-agent capabilities; it takes criteria (REQ-103)', async t => {
  const f = await fixture(t), mutate = createMutationHandler(f.store), revision = await current(f);
  const id = `card_${randomUUID()}`;
  for (const operations of [[{ op: 'add', title: 'Draft', intent: 'requested' }],
    // REQ-52: the detail may archive a card (a person's act); the automatic archive's reason and a restore stay off the RPC.
    [{ op: 'add', title: 'Draft', stageId: 'doing' }], [{ op: 'archive', id, reason: 'auto' }], [{ op: 'restore', id }],
    [{ op: 'link', id, agentId: randomUUID() }], [{ op: 'add', title: 'Draft', acceptanceCriteria: '- [ ] Set' }],
    [{ op: 'update', id, patch: { intent: 'requested' } }], [{ op: 'add', title: ' ' }]]) {
    const result = await mutate(ui(f.id, revision, operations));
    assert.equal(result.error.code, 'E_VALIDATION'); assert.equal(result.committed, false);
  }
  assert.equal((await mutate({ ...ui(f.id, revision, [{ op: 'add', title: 'Draft' }]), actor: { kind: 'agent', agentId: randomUUID() } })).error.code, 'E_VALIDATION');
  assert.equal((await f.store.readBoard(f.id)).cards.length, 0);
  ok(await mutate(ui(f.id, revision, [{ op: 'add', title: '😀'.repeat(200) }])));
  const board = await f.store.readBoard(f.id), card = board.cards[0].id;
  ok(await mutate(ui(f.id, board.revision, [{ op: 'update', id: card, patch: { acceptanceCriteria: '- [x] Changed' } }])));
  assert.equal((await f.store.readBoard(f.id)).cards[0].acceptanceCriteria, '- [x] Changed');
});
test('export uses core locale/detail/enable settings and failure does not undo a saved card', async t => {
  const f = await fixture(t, { afterCommit: exportCommittedBoard }), mutate = createMutationHandler(f.store);
  const config = join(f.store.dataDir, 'config.json'), output = join(f.cwd, 'PROCESS.md');
  await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, exportEnabled: true, locale: 'ko', export: { detail: 'full' } }));
  ok(await mutate(ui(f.id, await current(f), [{ op: 'add', title: 'Example draft', notes: 'Example evidence' }])));
  assert.equal(await fs.readFile(output, 'utf8'), renderProcess(await f.store.readBoard(f.id), 'ko', 'full'));
  const content = await fs.readFile(output, 'utf8');
  await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, exportEnabled: false, locale: 'ko', export: { detail: 'full' } }));
  ok(await mutate(ui(f.id, await current(f), [{ op: 'add', title: 'Another draft' }])));
  assert.equal(await fs.readFile(output, 'utf8'), content);
  const failed = await fixture(t, { afterCommit: async () => { throw new Error('Synthetic export failure'); } });
  const reply = ok(await createMutationHandler(failed.store)(ui(failed.id, await current(failed), [{ op: 'add', title: 'Saved anyway' }])));
  assert.equal(reply.data.export, 'failed'); assert.ok(reply.warnings.length); assert.equal((await failed.store.readBoard(failed.id)).cards.length, 1);
});
test('lost commit response stays unknown; board requery and identical retry recover without a duplicate', async t => {
  const f = await fixture(t); let lose = true;
  const mutate = createMutationHandler({ mutateBoard: async (...args) => {
    const result = await f.store.mutateBoard(...args);
    if (lose) { lose = false; throw createKanbanError('E_IO', 'Synthetic lost response', '', 'Read first.', null, 'unknown'); }
    return result;
  } });
  const payload = ui(f.id, await current(f), [{ op: 'add', title: 'Only once' }]);
  const reply = await mutate(payload); assert.equal(reply.committed, 'unknown');
  const read = await createReadHandlers(f.store).board({ boardId: f.id });
  assert.equal(read.data.board.stages[0].cards.length, 1);
  assert.equal(ok(await mutate(payload)).data.replayed, true);
  assert.equal((await f.store.readBoard(f.id)).cards.length, 1);
});
test('lock errors expose the reclaim time for a localized retry delay', async () => {
  const at = Date.now() + 59000;
  const mutate = createMutationHandler({ mutateBoard: async () => {
    throw createKanbanError('E_LOCK_TIMEOUT', 'Lock is active.', '', 'Retry later.', { ownerState: 'dead', reclaimableAtMs: at });
  } });
  const b = board(); const result = await mutate(ui(b.id, b.revision, [{ op: 'add', title: 'Draft' }]));
  assert.equal(result.error.details.reclaimableAtMs, at); assert.equal(result.committed, false);
  assert.equal(reclaimSeconds(result.error.details, at - 59000), 59); assert.equal(reclaimSeconds({}, at), null);
});
test('conflict preserves draft and compares latest, then rebases only locally edited fields', () => {
  const { snapshot, editor } = example();
  let state = editorReducer(editor, { type: 'edit', patch: { notes: 'My notes' } });
  const latest = { ...snapshot, revision: `${randomUUID()}:3`, card: { ...snapshot.card, title: 'Remote title', nextAction: 'Remote action' } };
  state = editorReducer(state, { type: 'load', snapshot: latest });
  assert.equal(state.base.revision, snapshot.revision); assert.equal(state.draft.notes, 'My notes');
  state = editorReducer(state, { type: 'conflict', latest });
  assert.equal(state.draft.notes, 'My notes'); assert.ok(compareEdits(state).some(r => r.key === 'notes'));
  const kept = editorReducer(state, { type: 'keep-mine' });
  assert.equal(kept.base.revision, latest.revision); assert.equal(kept.draft.title, 'Remote title'); assert.equal(kept.draft.notes, 'My notes');
  assert.deepEqual(editorOperations(kept), [{ op: 'update', id: snapshot.card.id, patch: { notes: 'My notes' } }]);
  const adopted = editorReducer(state, { type: 'use-latest' }); assert.equal(isDirty(adopted), false);
});
test('stage move and edited fields have an order compatible with completion rules', () => {
  const { snapshot, editor } = example();
  let state = editorReducer(editor, { type: 'stage', stageId: 'done' });
  state = editorReducer(state, { type: 'edit', patch: { blockedReason: null, notes: 'Checked' } });
  assert.deepEqual(editorOperations(state).map(op => op.op), ['update', 'move']);
  state = editorReducer(emptyEditor(), { type: 'load', snapshot: { ...snapshot, card: { ...snapshot.card, stageId: 'done' } } });
  state = editorReducer(state, { type: 'stage', stageId: 'doing' });
  state = editorReducer(state, { type: 'edit', patch: { blockedReason: 'Reopened' } });
  assert.deepEqual(editorOperations(state).map(op => op.op), ['move', 'update']);
});
test('unknown state retains the exact request across checks and cannot be reset into a new write', () => {
  const { snapshot } = example(), pending = ui(snapshot.boardId, snapshot.revision, [{ op: 'add', title: 'Draft' }]);
  let state = mutationReducer(emptyMutation(), { type: 'send', request: pending });
  state = mutationReducer(state, { type: 'reply', reply: { ok: false, committed: 'unknown', error: { code: 'E_IO' } } });
  state = mutationReducer(state, { type: 'checked', board: { revision: 'newer' } });
  assert.equal(state.phase, 'unknown'); assert.equal(state.pending, pending);
  assert.equal(mutationReducer(state, { type: 'reset' }), state);
  assert.equal(mutationReducer(state, { type: 'send', request: state.pending }).pending, pending);
});
test('portable request IDs satisfy the core UUID contract without native crypto', () => {
  const ids = Array.from({ length: 100 }, () => newRequestId());
  assert.ok(ids.every(isUUID)); assert.equal(new Set(ids).size, 100);
});

/**
 * REQ-57 ③: the first card of a workspace that has no board yet. The handler is given the same
 * workspace lookup the read handlers use, so the directory always comes from Paseo.
 */
function ensureHandler(f, workspaces, newId = randomUUID) {
  const resolve = async (_paseo, workspaceId) => {
    const found = workspaces.find(w => w.id === workspaceId);
    if (!found) throw createKanbanError('E_NOT_FOUND', 'No active Paseo workspace has this id.', workspaceId, 'Open it in Paseo.');
    return found;
  };
  return createEnsureHandler(f.store, resolve, newId);
}
const draft = title => ({ op: 'add', title });
test('REQ-57 the first card of a board-less workspace initializes the board exactly like kanban init', async t => {
  const f = await fixture(t, { afterCommit: exportCommittedBoard });
  const cwd = join(f.root, 'second'); await fs.mkdir(cwd);
  const ensure = ensureHandler(f, [{ id: 'wks_second01', cwd }]);
  const requestId = randomUUID();
  const reply = ok(await ensure({ workspaceId: 'wks_second01', requestId, operations: [draft('First idea')] }), boardEnsure);
  assert.equal(reply.data.created, true); assert.equal(reply.data.changed, true);
  assert.equal(reply.data.cardIds.length, 1); assert.match(reply.data.boardId, /^board_[0-9a-f]{64}$/);
  const made = await f.store.readBoard(reply.data.boardId);
  assert.equal(made.workspaceId, 'wks_second01'); assert.equal(made.cwd, cwd);
  assert.equal(made.cards[0].title, 'First idea'); assert.equal(made.cards[0].intent, 'draft');
  assert.equal(made.cards[0].createdBy.kind, 'user'); assert.equal(made.cards[0].stageId, made.template.stages[0].stageId);
  // Same result as the CLI: a ledger board plus the PROCESS.md of that workspace directory, and `ls` sees it.
  assert.match(await fs.readFile(join(cwd, 'PROCESS.md'), 'utf8'), /First idea/);
  const listed = await f.store.listBoards();
  assert.deepEqual(listed.map(b => b.workspaceId).sort(), ['wks_example01', 'wks_second01']);
  assert.equal((await f.store.resolveWorkspace('wks_second01')).id, reply.data.boardId);
  const cli = await f.store.initBoard({ cwd, workspaceId: 'wks_second01', actor, requestId: randomUUID() });
  assert.equal(cli.data.boardId, reply.data.boardId, 'kanban init on the same workspace finds the same board');
  assert.equal(cli.data.changed, false);
  // Repeating the request replays instead of adding a second card.
  const replay = ok(await ensure({ workspaceId: 'wks_second01', requestId, operations: [draft('First idea')] }), boardEnsure);
  assert.equal(replay.data.replayed, true); assert.equal(replay.data.created, false);
  assert.deepEqual(replay.data.cardIds, reply.data.cardIds);
  assert.equal((await f.store.readBoard(reply.data.boardId)).cards.length, 1);
  // A second card in the now-existing workspace goes through the same entry point without re-initializing.
  const more = ok(await ensure({ workspaceId: 'wks_second01', requestId: randomUUID(), operations: [draft('Second idea')] }), boardEnsure);
  assert.equal(more.data.created, false); assert.equal((await f.store.readBoard(reply.data.boardId)).cards.length, 2);
});
test('REQ-57 nothing is created when the request, the workspace or its directory is not usable', async t => {
  const f = await fixture(t);
  const before = (await fs.readdir(join(f.store.dataDir, 'boards'))).sort();
  const missingDir = join(f.root, 'not-there');
  const ensure = ensureHandler(f, [{ id: 'wks_gone01', cwd: missingDir }]);
  const cases = [
    [{ workspaceId: 'wks_unknown1', requestId: randomUUID(), operations: [draft('Idea')] }, 'E_NOT_FOUND'],
    [{ workspaceId: 'wks_gone01', requestId: randomUUID(), operations: [draft('Idea')] }, 'E_CWD_MISSING'],
    [{ workspaceId: 'wks_gone01', requestId: 'not-a-uuid', operations: [draft('Idea')] }, 'E_VALIDATION'],
    [{ workspaceId: 'wks_gone01', requestId: randomUUID(), operations: [draft('   ')] }, 'E_VALIDATION'],
    [{ workspaceId: 'wks_gone01', requestId: randomUUID(), operations: [draft('x'.repeat(201))] }, 'E_VALIDATION'],
    [{ workspaceId: 'wks_gone01', requestId: randomUUID(), operations: [] }, 'E_VALIDATION'],
    [{ workspaceId: 'not-a-workspace', requestId: randomUUID(), operations: [draft('Idea')] }, 'E_VALIDATION'],
    [{ workspaceId: 'wks_gone01', requestId: randomUUID(), operations: [{ op: 'move', id: 'card_' + '0'.repeat(36), to: 'done' }] }, 'E_VALIDATION'],
  ];
  for (const [input, code] of cases) {
    const reply = await ensure(input);
    boardEnsure.output.parse(reply);
    assert.equal(reply.ok, false, JSON.stringify(input)); assert.equal(reply.error.code, code, JSON.stringify(input));
    assert.equal(reply.committed, false, 'a refused request never claims an unknown outcome');
  }
  assert.deepEqual((await fs.readdir(join(f.store.dataDir, 'boards'))).sort(), before, 'no board file appeared');
  await assert.rejects(fs.stat(missingDir), { code: 'ENOENT' }, 'and no workspace directory was invented');
});
test('REQ-57 a card that cannot be written leaves the board exactly as kanban init would have left it', async t => {
  const f = await fixture(t, { afterCommit: exportCommittedBoard });
  const cwd = join(f.root, 'third'); await fs.mkdir(cwd);
  const id = randomUUID();
  // The same requestId is consumed by a different request first, so the card write is refused after init.
  const ensure = ensureHandler(f, [{ id: 'wks_third01', cwd }]);
  const first = ok(await ensure({ workspaceId: 'wks_third01', requestId: id, operations: [draft('Kept')] }), boardEnsure);
  const conflict = await ensure({ workspaceId: 'wks_third01', requestId: id, operations: [draft('Different text')] });
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'E_REQUEST_REUSED');
  const board = await f.store.readBoard(first.data.boardId);
  assert.equal(board.cards.length, 1); assert.equal(board.cards[0].title, 'Kept');
  assert.equal(JSON.parse(JSON.stringify(board)).schemaVersion, 1);
  assert.match(await fs.readFile(join(cwd, 'PROCESS.md'), 'utf8'), /Kept/);
});
