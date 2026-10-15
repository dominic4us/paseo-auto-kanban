import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dispatchCriteria, dispatchHeld, dispatchMessage } from '../dist/shared/dispatch.js';
import { boardMutate, dispatchPreview } from '../dist/shared/rpc.js';
import { boardOfAgent, createDispatcher, pickLead, readLeadEntry } from '../dist/server/dispatch.js';
import { readAutoState, writeAutoState } from '../dist/server/auto-cards.js';
import { dispatchFloorOf, heldOf, toBoardDTO } from '../dist/server/read-model.js';
import { dispatchLine } from '../dist/client/dispatch-view.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, request } from './helpers.mjs';

/**
 * research/253 (v0.1.46-B gate): D1 a worktree's chat takes the requests of the root board its cards land on (D25);
 * D2 the agent confirmed in the sheet is the one the request goes to — a newer chat never takes it unasked;
 * D3 a card held for another reason than "no agent there" says which.
 */
const ROOT_CHAT = '11111111-1111-4111-8111-111111111111', TREE_CHAT = '22222222-2222-4222-8222-222222222222';
const OWN_TREE_CHAT = '33333333-3333-4333-8333-333333333333', OTHER_TREE_CHAT = '44444444-4444-4444-8444-444444444444';
const NEWER = '55555555-5555-4555-8555-555555555555', LEAD = '99999999-9999-4999-8999-999999999999';
const minute = m => `2026-01-01T00:${String(m).padStart(2, '0')}:00.000Z`;
const agent = (id, cwd, created, extra = {}) => ({ id, title: 'Chat ' + id.slice(0, 4), cwd, workspaceId: 'wks_example01',
  createdAt: minute(created), archivedAt: null, labels: {}, status: 'idle', ...extra });
function fakePaseo(agents, rows = [{ id: 'wks_example01', title: 'Example board' }], { busy = () => false } = {}) {
  const sent = [];
  return { sent, agents: {
    list: async () => ({ entries: agents.map(a => ({ agent: a })), pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => ({ agent: { id, status: busy(id) ? 'running' : 'idle', activeTurn: null, archivedAt: null, pendingPermissions: [] } }),
      send: async (text, options) => { sent.push({ id, text, messageId: options?.messageId }); } }),
  }, workspaces: { list: async () => ({ entries: rows, pageInfo: { nextCursor: null } }) } };
}
const quiet = { log: () => {}, sleep: async () => {} };
async function floorAt(store, floor) {
  const state = await readAutoState(store.dataDir);
  state.autoBoardFloor = floor;
  await writeAutoState(store.dataDir, state);
}
async function draft(store, id, title = 'Sample request') {
  await store.mutateBoard(id, request([{ op: 'add', title, intent: 'draft', acceptanceCriteria: '' }]));
  return (await store.readBoard(id)).cards.at(-1);
}
const send = (store, id, cardId, targetAgentId) =>
  store.mutateBoard(id, request([{ op: 'dispatch', id: cardId, to: 'doing', ...(targetAgentId ? { targetAgentId } : {}) }]), 'board');
const cardOf = async (store, id, cardId) => (await store.readBoard(id)).cards.find(c => c.id === cardId);
const chipOf = async (store, id, floor, m = copy('ko')) =>
  dispatchLine(toBoardDTO(await store.readBoard(id), 'ko', 'off', Date.now(), undefined, undefined, undefined, floor).stages.flatMap(s => s.cards)[0].dispatch, m);

/** A project root board (the fixture's) and, beside it, worktree folders of the same project and of another one. */
async function worktrees(t) {
  const f = await fixture(t);
  const tree = join(f.root, 'trees', 'feature'), own = join(f.root, 'trees', 'own'), other = join(f.root, 'other-trees', 'x');
  for (const dir of [tree, own, other]) await mkdir(dir, { recursive: true });
  const rows = [
    { id: 'wks_tree01', title: 'Feature', workspaceKind: 'worktree', workspaceDirectory: tree, projectRootPath: f.cwd },
    { id: 'wks_tree02', title: 'Own', workspaceKind: 'worktree', workspaceDirectory: own, projectRootPath: f.cwd },
    { id: 'wks_tree03', title: 'Other', workspaceKind: 'worktree', workspaceDirectory: other, projectRootPath: join(f.root, 'elsewhere') },
  ];
  await f.store.initBoard({ cwd: own, workspaceId: 'wks_tree02', actor: { kind: 'user' }, requestId: randomUUID() });
  return { ...f, tree, own, other, rows };
}

test('253-D1 a worktree chat takes the requests of its project root board; its own board and other projects stay apart', async t => {
  const { store, id, cwd, tree, own, other, rows } = await worktrees(t);
  await floorAt(store, minute(0));
  const treeChat = agent(TREE_CHAT, tree, 3, { workspaceId: 'wks_tree01' });
  const ownChat = agent(OWN_TREE_CHAT, own, 8, { workspaceId: 'wks_tree02' });
  const otherChat = agent(OTHER_TREE_CHAT, other, 9, { workspaceId: 'wks_tree03' });
  const boards = await store.listBoardIdentities();
  assert.equal(boardOfAgent(readLeadEntry(treeChat), boards, rows), id, 'the root board, as automatic cards choose it');
  assert.notEqual(boardOfAgent(readLeadEntry(ownChat), boards, rows), id, 'a worktree with its own board keeps it');
  assert.equal(boardOfAgent(readLeadEntry(otherChat), boards, rows), null, 'another project has no board here');

  // Only the worktree chat (and the two that do not belong): the preview and the send name it, the link says it.
  const card = await draft(store, id);
  const paseo = fakePaseo([treeChat, ownChat, otherChat], rows);
  const dispatcher = createDispatcher({ store, ...quiet });
  const preview = await dispatcher.preview(paseo, id, card.id);
  assert.equal(preview.lead?.agentId, TREE_CHAT);
  await send(store, id, card.id, preview.lead.agentId);
  assert.equal(await dispatcher.kick(paseo, id), 'sent');
  assert.deepEqual(paseo.sent.map(s => s.id), [TREE_CHAT]);
  assert.deepEqual((await cardOf(store, id, card.id)).agents.map(a => a.agentId), [TREE_CHAT]);

  // A chat in the root folder itself comes first, even when the worktree's is newer.
  const rootChat = agent(ROOT_CHAT, cwd, 1);
  const read = [rootChat, treeChat].map(readLeadEntry);
  assert.equal(pickLead(read, { workspaceId: 'wks_example01', cwd }, {}, a => a.id === TREE_CHAT)?.id, ROOT_CHAT);
  // No listing of workspaces (an older daemon): the worktree's relation to the board cannot be read — nothing is sent.
  // 257 (research/258): nor is "no agent" said — the card is left waiting ('list-failed'), not written off as noLead.
  const second = await draft(store, id, 'Second');
  await send(store, id, second.id);
  const unlisted = fakePaseo([treeChat]); unlisted.workspaces = undefined;
  assert.equal(await createDispatcher({ store, ...quiet }).kick(unlisted, id), 'list-failed');
  assert.equal(unlisted.sent.length, 0);
  assert.equal((await cardOf(store, id, second.id)).dispatch.state, 'pending');
});

test('253-D1 a worktree chat that ends its turn wakes the root board it waits on', async t => {
  const { store, id, tree, rows } = await worktrees(t);
  await floorAt(store, minute(0));
  const treeChat = agent(TREE_CHAT, tree, 3, { workspaceId: 'wks_tree01' });
  let running = true;
  const paseo = fakePaseo([treeChat], rows, { busy: () => running });
  const dispatcher = createDispatcher({ store, ...quiet });
  const card = await draft(store, id);
  await send(store, id, card.id, TREE_CHAT);
  assert.equal(await dispatcher.kick(paseo, id), 'busy');
  running = false;
  const hook = { id: TREE_CHAT, workspaceId: 'wks_tree01', cwd: tree, parentAgentId: null, title: treeChat.title };
  assert.deepEqual(await dispatcher.signal(hook, 'turn_ended', paseo), ['sent']);
  assert.deepEqual(paseo.sent.map(s => s.id), [TREE_CHAT]);
});

test('253-D2 the confirmed agent gets the request even when a newer chat opens; the words and the link name it', async t => {
  for (const locale of ['ko', 'en']) {
    const { store, id, cwd } = await fixture(t);
    await floorAt(store, minute(0));
    const agents = [agent(ROOT_CHAT, cwd, 1)];
    let running = false;
    const paseo = fakePaseo(agents, undefined, { busy: () => running });
    const dispatcher = createDispatcher({ store, ...quiet, locale: async () => locale });
    const card = await draft(store, id);
    const preview = await dispatcher.preview(paseo, id, card.id);
    assert.equal(preview.lead.agentId, ROOT_CHAT);
    const shown = dispatchMessage({ title: card.title, cardId: card.id, boardTitle: preview.boardTitle, notes: card.notes,
      criteria: dispatchCriteria(card), locale: preview.locale, agentId: preview.lead.agentId });
    // A newer chat opens between the sheet and [Send], and again while the confirmed one is busy.
    agents.push(agent(NEWER, cwd, 2));
    running = true;
    await send(store, id, card.id, preview.lead.agentId);
    assert.equal((await cardOf(store, id, card.id)).dispatch.targetAgentId, ROOT_CHAT, 'kept from the start');
    assert.equal(await dispatcher.kick(paseo, id), 'busy', 'waits for the confirmed one, not the idle newer chat');
    assert.equal(paseo.sent.length, 0);
    running = false;
    assert.equal(await dispatcher.kick(paseo, id), 'sent');
    assert.deepEqual(paseo.sent.map(s => [s.id, s.text]), [[ROOT_CHAT, shown]], 'preview = what is sent, ' + locale);
    const after = await cardOf(store, id, card.id);
    assert.equal(after.dispatch.targetAgentId, ROOT_CHAT);
    assert.deepEqual(after.agents.map(a => a.agentId), [ROOT_CHAT]);
  }
});

test('253-D2 the confirmed agent gone: no other plain chat takes it (held, said why); a lead by name does', async t => {
  const { store, id, cwd } = await fixture(t);
  await floorAt(store, minute(0));
  const agents = [agent(NEWER, cwd, 2)];
  const paseo = fakePaseo(agents);
  const dispatcher = createDispatcher({ store, ...quiet });
  const card = await draft(store, id);
  await send(store, id, card.id, ROOT_CHAT);
  assert.equal(await dispatcher.kick(paseo, id), 'noLead');
  assert.equal(paseo.sent.length, 0);
  assert.equal((await dispatcher.preview(paseo, id, card.id)).held, 'targetGone');
  assert.equal(await chipOf(store, id, minute(0)), '보류 · 받을 채팅 닫힘');
  assert.equal(await chipOf(store, id, minute(0), copy('en')), 'Held · chat closed');
  agents.push(agent(LEAD, cwd, 0, { title: '총괄-99 시험' }));
  assert.equal(await dispatcher.kick(paseo, id), 'sent');
  assert.deepEqual(paseo.sent.map(s => s.id), [LEAD]);
  // An agent id that is not one is refused by the ledger and by the screen's request shape.
  const other = await draft(store, id, 'Other');
  await assert.rejects(store.mutateBoard(id, request([{ op: 'dispatch', id: other.id, to: 'doing', targetAgentId: 'not-an-id' }]), 'board'),
    e => e.code === 'E_VALIDATION');
  assert.equal(boardMutate.input.safeParse({ boardId: id, requestId: randomUUID(), ifRevision: randomUUID() + ':1',
    operations: [{ op: 'dispatch', id: other.id, to: 'doing', targetAgentId: ROOT_CHAT }] }).success, true);
});

test('253-D3 held cards say why: before the start line, settings unreadable, confirmed chat gone — "no agent" only with none', async t => {
  const { store, id, cwd } = await fixture(t);
  const card = await draft(store, id);
  await send(store, id, card.id);
  const later = new Date(Date.now() + 60_000).toISOString();
  const dispatcher = createDispatcher({ store, ...quiet, fallbackFloor: async () => later });
  const paseo = fakePaseo([agent(ROOT_CHAT, cwd, 1)]);
  assert.equal(await dispatcher.kick(paseo, id), 'noLead');
  assert.equal(paseo.sent.length, 0, 'the start line still holds it');
  const preview = await dispatcher.preview(paseo, id, card.id);
  assert.equal(preview.lead, null); assert.equal(preview.held, 'beforeFloor');
  assert.equal(dispatchPreview.output.safeParse({ ok: true, committed: false, warnings: [], data: preview }).success, true);
  assert.equal(await chipOf(store, id, later), '보류 · 업그레이드 전 요청');
  assert.equal(await chipOf(store, id, later, copy('en')), 'Held · before upgrade');
  // The pure rule, each reason.
  const at = minute(5);
  assert.equal(dispatchHeld({ targetAgentId: null, requestedAt: at }, minute(9)), 'beforeFloor');
  assert.equal(dispatchHeld({ targetAgentId: null, requestedAt: at }, minute(1)), 'noAgent');
  assert.equal(dispatchHeld({ targetAgentId: null, requestedAt: at }, null), 'settings');
  assert.equal(dispatchHeld({ targetAgentId: null, requestedAt: at }, 'not a time'), 'settings');
  assert.equal(dispatchHeld({ targetAgentId: ROOT_CHAT, requestedAt: at }, minute(1)), 'targetGone');
  assert.deepEqual(heldOf({ state: 'pending', targetAgentId: null, requestedAt: at }, null), {}, 'only a card with nobody to go to');
  assert.deepEqual(heldOf({ state: 'noLead', targetAgentId: null, requestedAt: at }, undefined), {}, 'not asked: nothing said');
  assert.equal(dispatchFloorOf(null), null); assert.equal(dispatchFloorOf({ damaged: true, autoBoardFloor: at }), null);
  assert.equal(dispatchFloorOf({ autoBoardFloor: at }), at);
  // The words: each reason its own, none tells to open a new chat; ko and en.
  for (const m of [copy('ko'), copy('en')]) {
    const words = ['beforeFloor', 'settings', 'targetGone'].map(h => m.dispatchHeld(h));
    assert.equal(new Set(words).size, 3);
    for (const w of words) assert.ok(!w.includes(m.dispatchNoLead) && !/새 채팅을 먼저|open a new chat first/.test(w), w);
    assert.notEqual(m.dispatchQueued(null, false, 'settings'), m.dispatchQueued(null));
  }
});

test('253-D3 a damaged settings file says settings; no agent at all still says no agent', async t => {
  const damaged = await fixture(t);
  await floorAt(damaged.store, minute(0));
  const card = await draft(damaged.store, damaged.id);
  await send(damaged.store, damaged.id, card.id);
  await writeFile(join(damaged.store.dataDir, 'auto-cards.json'), '{');
  const paseo = fakePaseo([agent(ROOT_CHAT, damaged.cwd, 1)]);
  const dispatcher = createDispatcher({ store: damaged.store, ...quiet });
  assert.equal(await dispatcher.kick(paseo, damaged.id), 'noLead');
  assert.equal(paseo.sent.length, 0);
  assert.equal((await dispatcher.preview(paseo, damaged.id, card.id)).held, 'settings');
  assert.equal(await chipOf(damaged.store, damaged.id, dispatchFloorOf(await readAutoState(damaged.store.dataDir))), '보류 · 설정 확인');

  const none = await fixture(t);
  await floorAt(none.store, minute(0));
  const lonely = await draft(none.store, none.id);
  await send(none.store, none.id, lonely.id);
  const nobody = createDispatcher({ store: none.store, ...quiet });
  assert.equal(await nobody.kick(fakePaseo([]), none.id), 'noLead');
  assert.equal((await nobody.preview(fakePaseo([]), none.id, lonely.id)).held, 'noAgent');
  const floor = dispatchFloorOf(await readAutoState(none.store.dataDir));
  assert.equal(await chipOf(none.store, none.id, floor), '받을 에이전트 없음');
  const dto = toBoardDTO(await none.store.readBoard(none.id), 'ko', 'off', Date.now(), undefined, undefined, undefined, floor);
  assert.equal('held' in dto.stages.flatMap(s => s.cards)[0].dispatch, false, 'no field for the plain case');
});
