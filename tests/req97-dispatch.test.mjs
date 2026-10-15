import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applyOperations as applyAs, dispatchMessageId, dispatchStage, validateBoard, builtinTemplate } from '../dist/shared/core/domain.js';
import { dispatchMessage, dispatchCriteria, leadShortName } from '../dist/shared/dispatch.js';
import { boardMutate } from '../dist/shared/rpc.js';
import { createDispatcher, isLeadAgent, pickLead, readLeadEntry, leadReadiness, waitingCards, alreadyDelivered } from '../dist/server/dispatch.js';
import { createMutationHandler } from '../dist/server/mutations.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { stageAllowed, sendsToLead, dispatchStageId } from '../dist/client/move-model.js';
import { dispatchLine, dispatchLook, dispatchAlreadyNotice } from '../dist/client/dispatch-view.js';
import { copy } from '../dist/client/i18n.js';
import { actor, board, context, fixture, request } from './helpers.mjs';

/**
 * REQ-97: a draft moved to the working stage (after the confirmation sheet) goes to the workspace's lead as a prompt,
 * only while the lead is idle, once. The screens are tested in plugin-ui.test.mjs.
 */
const LEAD = '99999999-9999-4999-8999-999999999999', OLDER = '88888888-8888-4888-8888-888888888888';
const CHILD = '77777777-7777-4777-8777-777777777777', OTHER = '66666666-6666-4666-8666-666666666666';
// D37: `dispatch` is the board screen's, `dispatched` the dispatcher's; the ledger tests below write as the one that may.
const applyOperations = (b, ops, a, c) => applyAs(b, ops, a, c, ops.some(o => o.op === 'dispatched') ? 'dispatcher' : 'board');
const draft = (title = 'Sample request', extra = {}) => ({ op: 'add', title, intent: 'draft', acceptanceCriteria: '', ...extra });
const at = minute => `2026-01-01T01:${String(minute).padStart(2, '0')}:00.000Z`;
const listed = (id, extra = {}) => ({ id, title: '총괄-99 시험', cwd: '/tmp/example-workspace', workspaceId: 'wks_example01',
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null, labels: {}, status: 'idle', ...extra });

test('REQ-97 the lead: top-level, unarchived, titled "총괄-" or given a "총괄_" profile, in the board\'s workspace, newest first', () => {
  const b = { workspaceId: 'wks_example01', cwd: '/tmp/example-workspace' };
  const read = list => list.map(readLeadEntry);
  assert.equal(pickLead(read([listed(LEAD)]), b)?.id, LEAD);
  assert.equal(pickLead(read([{ agent: listed(LEAD, { title: 'Worker', labels: { profile: '총괄_Sample-1' } }) }]), b)?.id, LEAD, 'by its profile label');
  assert.equal(pickLead(read([listed(LEAD, { title: 'Worker', labels: { profile: '실행_Sample' } })]), b), null, 'neither title nor profile');
  assert.equal(pickLead(read([listed(CHILD, { labels: { 'paseo.parent-agent-id': LEAD } })]), b), null, 'a sub-agent is never the lead');
  assert.equal(pickLead(read([listed(LEAD, { archivedAt: '2026-01-01T00:30:00.000Z' })]), b), null, 'an archived lead is not asked');
  assert.equal(pickLead(read([listed(LEAD, { workspaceId: 'wks_other01', cwd: '/tmp/other' })]), b), null, 'another workspace\'s lead');
  assert.equal(pickLead(read([listed(LEAD, { workspaceId: 'wks_other01', cwd: '/tmp/example-workspace/' })]), b)?.id, LEAD, 'the same directory');
  assert.equal(pickLead(read([listed(OLDER, { createdAt: '2025-12-01T00:00:00.000Z' }), listed(LEAD)]), b)?.id, LEAD, 'the newest');
  assert.equal(isLeadAgent({ title: '  총괄-01', profile: '', parent: null, archived: false }), true);
  // REQ-137: "Lead-01" is now a lead by its English alias; a prefix still counts only at the start.
  assert.equal(isLeadAgent({ title: 'Worker 총괄-01 Lead-01', profile: '', parent: null, archived: false }), false, 'a prefix, not anywhere');
  assert.equal(leadShortName('총괄-07_Sample-App_Fable'), '총괄-07');
  assert.equal(leadShortName('총괄-99 시험'), '총괄-99 시험');
});

test('REQ-97 the prompt, its message id and the criteria it goes out with', () => {
  const text = dispatchMessage({ title: 'Sample request', cardId: 'card_' + LEAD, boardTitle: 'Example board',
    notes: 'First line\r\nSecond line', criteria: 'A reviewable result exists.' });
  assert.equal(text, ['[칸반 요청] Sample request', `카드: card_${LEAD} · 보드: Example board`, 'First line\nSecond line',
    '완료 기준: A reviewable result exists.', '할 일: 위 요청을 처리해 주세요. 완료 기준을 채우면 무엇을 했는지 짧게 알려 주세요.'].join('\n'), 'v0.1.46-B: no agent named, no kanban command line');
  assert.doesNotMatch(dispatchMessage({ title: 'T', cardId: 'card_x', boardTitle: 'B', notes: '  ', criteria: 'C' }), /\n\n/, 'no empty notes line');
  assert.equal(dispatchMessageId('card_' + LEAD, at(1)), dispatchMessageId('card_' + LEAD, at(1)), 'the same request, the same id');
  assert.notEqual(dispatchMessageId('card_' + LEAD, at(1)), dispatchMessageId('card_' + LEAD, at(2)), 'a new request, a new id');
  assert.match(dispatchMessageId('card_' + LEAD, at(1)), /^kanban-dispatch-99999999-/);
  assert.equal(dispatchCriteria({ title: 'T', acceptanceCriteria: 'Own' }, 'Typed'), 'Own');
  assert.equal(dispatchCriteria({ title: 'T', acceptanceCriteria: ' ' }, 'Typed'), 'Typed');
  assert.equal(dispatchCriteria({ title: 'T', acceptanceCriteria: '' }, '  '), 'T');
  assert.equal(dispatchStage(builtinTemplate().stages).stageId, 'doing');
});

test('REQ-97 ledger: a draft is sent only by moving it to the working stage; review and done stay closed to it', () => {
  let b = applyOperations(board(), [draft()], actor, context(at(0))).board;
  const id = b.cards[0].id;
  assert.throws(() => applyOperations(b, [{ op: 'move', id, to: 'doing' }], actor, context(at(1))), /A draft must stay in the first stage/);
  assert.throws(() => applyOperations(b, [{ op: 'dispatch', id, to: 'review' }], actor, context(at(1))), /working stage/);
  assert.throws(() => applyOperations(b, [{ op: 'dispatch', id, to: 'done' }], actor, context(at(1))), /working stage/);
  b = applyOperations(b, [{ op: 'dispatch', id, to: 'doing' }], actor, context(at(1))).board;
  const card = b.cards[0];
  assert.equal(card.stageId, 'doing'); assert.equal(card.intent, 'requested');
  assert.equal(card.acceptanceCriteria, 'Sample request', 'empty criteria become the title');
  assert.deepEqual(card.dispatch, { state: 'pending', targetAgentId: null, requestedAt: at(1), sentAt: null, messageId: dispatchMessageId(id, at(1)) });
  assert.deepEqual(b.history.at(-1).to, 'doing', 'the move is in the history');
  assert.throws(() => applyOperations(b, [{ op: 'dispatch', id, to: 'doing' }], actor, context(at(2))), /Only a draft/);
});

test('REQ-97 ledger: typed criteria are used only when the card has none; the state moves pending → sent once', () => {
  let b = applyOperations(board(), [draft('A'), draft('B', { acceptanceCriteria: 'Own criteria' })], actor, context(at(0))).board;
  const [a, own] = b.cards.map(c => c.id);
  b = applyOperations(b, [{ op: 'dispatch', id: a, to: 'doing', acceptanceCriteria: '  Typed criteria  ' },
    { op: 'dispatch', id: own, to: 'doing', acceptanceCriteria: 'Ignored' }], actor, context(at(1))).board;
  assert.equal(b.cards[0].acceptanceCriteria, 'Typed criteria');
  assert.equal(b.cards[1].acceptanceCriteria, 'Own criteria');
  assert.throws(() => applyOperations(b, [{ op: 'dispatched', id: a, state: 'pending', targetAgentId: LEAD }], actor, context(at(2))),
    /no longer waiting/, 'pending → pending is not a transition');
  assert.throws(() => applyOperations(b, [{ op: 'dispatched', id: a, state: 'sent', targetAgentId: null }], actor, context(at(2))), /agent id/);
  b = applyOperations(b, [{ op: 'dispatched', id: a, state: 'sent', targetAgentId: LEAD }], actor, context(at(2))).board;
  assert.deepEqual({ ...b.cards[0].dispatch, messageId: '' }, { state: 'sent', targetAgentId: LEAD, requestedAt: at(1), sentAt: at(2), messageId: '' });
  assert.throws(() => applyOperations(b, [{ op: 'dispatched', id: a, state: 'sent', targetAgentId: LEAD }], actor, context(at(3))),
    /no longer waiting/, 'a second "sent" is refused — the compare-and-set the server relies on');
  // Sent, then moved back: still sent, still requested, never sent again.
  b = applyOperations(b, [{ op: 'move', id: a, to: 'todo' }], actor, context(at(4))).board;
  assert.equal(b.cards[0].dispatch.state, 'sent'); assert.equal(b.cards[0].intent, 'requested');
  assert.throws(() => applyOperations(b, [{ op: 'dispatch', id: a, to: 'doing' }], actor, context(at(5))), /Only a draft/);
  // noLead → pending (a lead appeared) → noLead again, and back to the first stage cancels.
  b = applyOperations(b, [{ op: 'dispatched', id: own, state: 'noLead', targetAgentId: null }], actor, context(at(6))).board;
  b = applyOperations(b, [{ op: 'dispatched', id: own, state: 'pending', targetAgentId: LEAD }], actor, context(at(7))).board;
  assert.equal(b.cards[1].dispatch.state, 'pending'); assert.equal(b.cards[1].dispatch.targetAgentId, LEAD);
});

test('REQ-97 ledger: moved back to the first stage before it was sent — cancelled, a draft again, and sendable anew', () => {
  let b = applyOperations(board(), [draft()], actor, context(at(0))).board;
  const id = b.cards[0].id;
  b = applyOperations(b, [{ op: 'dispatch', id, to: 'doing' }], actor, context(at(1))).board;
  b = applyOperations(b, [{ op: 'move', id, to: 'todo' }], actor, context(at(2))).board;
  assert.equal(b.cards[0].dispatch.state, 'cancelled'); assert.equal(b.cards[0].intent, 'draft'); assert.equal(b.cards[0].stageId, 'todo');
  assert.throws(() => applyOperations(b, [{ op: 'dispatched', id, state: 'sent', targetAgentId: LEAD }], actor, context(at(3))), /no longer waiting/);
  b = applyOperations(b, [{ op: 'dispatch', id, to: 'doing' }], actor, context(at(4))).board;
  assert.equal(b.cards[0].dispatch.state, 'pending');
  assert.equal(b.cards[0].dispatch.messageId, dispatchMessageId(id, at(4)), 'a new request, a new message id');
  // Moved elsewhere (not back) while waiting: it still waits.
  b = applyOperations(b, [{ op: 'move', id, to: 'review' }], actor, context(at(5))).board;
  assert.equal(b.cards[0].dispatch.state, 'pending');
});

test('REQ-97 migration: a ledger written before REQ-97 reads as it was; a damaged dispatch is refused', async t => {
  const old = applyOperations(board(), [{ op: 'add', title: 'Old card', intent: 'requested', acceptanceCriteria: 'Done.' }], actor, context(at(0))).board;
  assert.equal(Object.hasOwn(old.cards[0], 'dispatch'), false, 'no field is added to cards never sent');
  assert.doesNotThrow(() => validateBoard(structuredClone(old)));
  // The store reads an old ledger file and writes it back without the field.
  const { store, id } = await fixture(t);
  await store.mutateBoard(id, request([{ op: 'add', title: 'Old card', intent: 'requested', acceptanceCriteria: 'Done.' }]));
  const read = await store.readBoard(id);
  assert.equal(Object.hasOwn(read.cards[0], 'dispatch'), false);
  const b = applyOperations(board(), [draft()], actor, context(at(0))).board;
  const sent = applyOperations(b, [{ op: 'dispatch', id: b.cards[0].id, to: 'doing' }], actor, context(at(1))).board;
  assert.doesNotThrow(() => validateBoard(structuredClone(sent)));
  for (const damage of [{ state: 'lost' }, { messageId: 'kanban-dispatch-other' }, { sentAt: at(2) }, { extra: 1 }]) {
    const bad = structuredClone(sent); Object.assign(bad.cards[0].dispatch, damage);
    assert.throws(() => validateBoard(bad), /Unexpected value|Invalid|Unknown field/, JSON.stringify(damage));
  }
});

test('REQ-97 the screen may send "dispatch" but never "dispatched"; the server keeps the add rules', async t => {
  const { store, id } = await fixture(t);
  const handler = createMutationHandler(store);
  const revision = async () => (await store.readBoard(id)).revision;
  const added = await handler({ boardId: id, requestId: randomUUID(), ifRevision: await revision(), operations: [{ op: 'add', title: 'Screen draft' }] });
  assert.equal(added.ok, true);
  const cardId = added.data.cardIds[0];
  const forged = await handler({ boardId: id, requestId: randomUUID(), ifRevision: await revision(),
    operations: [{ op: 'dispatched', id: cardId, state: 'sent', targetAgentId: LEAD }] });
  assert.equal(forged.ok, false); assert.equal(forged.error.code, 'E_VALIDATION');
  assert.equal(boardMutate.input.safeParse({ boardId: id, requestId: randomUUID(), ifRevision: await revision(),
    operations: [{ op: 'dispatch', id: cardId, to: 'doing', acceptanceCriteria: 'Typed' }] }).success, true);
  const sent = await handler({ boardId: id, requestId: randomUUID(), ifRevision: await revision(),
    operations: [{ op: 'dispatch', id: cardId, to: 'doing', acceptanceCriteria: 'Typed' }] });
  assert.equal(sent.ok, true);
  const card = (await store.readBoard(id)).cards[0];
  assert.equal(card.dispatch.state, 'pending'); assert.equal(card.acceptanceCriteria, 'Typed'); assert.equal(card.stageId, 'doing');
});

// ---- the server's dispatch, against a store and a simulated Paseo ----
function paseoFor(cwd, { agents = [listed(LEAD)], state = {} } = {}) {
  const sent = [], seen = new Set(), refreshed = [];
  const snapshot = id => state[id] === 'gone' ? null : { agent: { id, status: 'idle', activeTurn: null, archivedAt: null, pendingPermissions: [],
    ...(typeof state[id] === 'object' ? state[id] : {}) }, project: null };
  const api = {
    sent, refreshed, agents: {
      list: async () => ({ entries: agents.map(agent => ({ agent: { ...agent, cwd: agent.cwd === '/tmp/example-workspace' ? cwd : agent.cwd } })),
        pageInfo: { nextCursor: null } }),
      ref: id => ({ refresh: async () => { refreshed.push(id); return snapshot(id); },
        send: async (text, options) => {
          if (seen.has(options?.messageId)) throw Object.assign(new Error('agent_request_key_conflict'), { code: 'agent_request_key_conflict' });
          seen.add(options?.messageId); sent.push({ id, text, messageId: options?.messageId });
        } }),
    },
    workspaces: { list: async () => ({ entries: [{ id: 'wks_example01', title: 'Example board', workspaceDirectory: cwd }], pageInfo: { nextCursor: null } }) },
  };
  return api;
}
async function waitingBoard(t, titles = ['Sample request']) {
  const f = await fixture(t);
  await f.store.mutateBoard(f.id, request(titles.map(title => draft(title, { notes: 'Some notes' }))));
  for (const card of (await f.store.readBoard(f.id)).cards)
    await f.store.mutateBoard(f.id, request([{ op: 'dispatch', id: card.id, to: 'doing' }]), 'board');
  return f;
}
const hook = (id, cwd, extra = {}) => ({ id, workspaceId: 'wks_example01', parentAgentId: null, cwd, title: '총괄-99 시험', ...extra });

test('REQ-97 server: nothing is sent while the lead works; once it is idle the card goes out once, then says sent', async t => {
  const { store, id, cwd } = await waitingBoard(t);
  const paseo = paseoFor(cwd, { state: { [LEAD]: { status: 'running', activeTurn: { id: 'turn-1' } } } });
  const logs = [], slept = [];
  const dispatcher = createDispatcher({ store, log: (m, d) => logs.push([m, d]), sleep: async ms => { slept.push(ms); }, graceMs: 2500 });
  assert.equal(await dispatcher.kick(paseo, id), 'busy');
  assert.equal(paseo.sent.length, 0, 'never in the middle of a turn');
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'pending');
  // turn_ended but a new turn already started (research/152 ③): refresh says running → still nothing.
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'turn_ended', paseo), ['busy']);
  assert.deepEqual(slept, [2500], 'a turn that ended waits the grace first');
  assert.equal(paseo.sent.length, 0);
  // Idle now.
  const idle = paseoFor(cwd);
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'turn_ended', idle), ['sent']);
  assert.equal(idle.sent.length, 1);
  const card = (await store.readBoard(id)).cards[0];
  assert.deepEqual(idle.sent[0], { id: LEAD, messageId: card.dispatch.messageId, text: ['[칸반 요청] Sample request',
    `카드: ${card.id} · 보드: Example board`, 'Some notes', '완료 기준: Sample request', '할 일: 위 요청을 처리해 주세요. 완료 기준을 채우면 무엇을 했는지 짧게 알려 주세요.',
    `(kanban CLI가 있으면 이 카드를 담당 카드로 이어 쓰세요: kanban card link ${card.id} --agent ${LEAD} — CLI가 없으면 이 줄은 건너뛰세요)`].join('\n') });
  assert.equal(card.dispatch.state, 'sent'); assert.equal(card.dispatch.targetAgentId, LEAD); assert.ok(card.dispatch.sentAt);
  // Later signals send nothing more.
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'turn_ended', idle), ['none']);
  assert.equal(await dispatcher.kick(idle, id), 'none');
  assert.equal(idle.sent.length, 1);
});

test('REQ-97 server: an archived lead is never written to — the card says "no lead" and goes to the next lead that appears', async t => {
  const { store, id, cwd } = await waitingBoard(t);
  const dispatcher = createDispatcher({ store, log: () => {}, sleep: async () => {} });
  // Listed as live, archived by the time it is refreshed.
  const racing = paseoFor(cwd, { state: { [LEAD]: { archivedAt: '2026-01-01T02:00:00.000Z' } } });
  assert.equal(await dispatcher.kick(racing, id), 'noLead');
  assert.equal(racing.sent.length, 0);
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'noLead');
  // No lead at all: stays noLead, nothing is asked of anyone.
  const none = paseoFor(cwd, { agents: [listed(OTHER, { title: 'Worker' }), listed(CHILD, { labels: { 'paseo.parent-agent-id': OTHER } })] });
  assert.equal(await dispatcher.kick(none, id), 'noLead');
  assert.deepEqual(none.refreshed, [], 'no agent was even looked at');
  // A lead is made: its created signal finds it busy (its first turn) and puts the card back to waiting; its turn's end sends.
  const made = paseoFor(cwd, { agents: [listed(LEAD, { createdAt: '2026-01-02T00:00:00.000Z' })], state: { [LEAD]: { status: 'running' } } });
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'created', made), ['busy']);
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'pending');
  const idle = paseoFor(cwd, { agents: [listed(LEAD, { createdAt: '2026-01-02T00:00:00.000Z' })] });
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'turn_ended', idle), ['sent']);
  assert.equal(idle.sent.length, 1);
  // A lead gone missing (refresh names no agent) counts as no lead too.
  const second = await waitingBoard(t);
  const gone = paseoFor(second.cwd, { state: { [LEAD]: 'gone' } });
  assert.equal(await createDispatcher({ store: second.store, log: () => {} }).kick(gone, second.id), 'noLead');
});

test('REQ-97 server: one card per idle moment, the oldest first; the same request twice is sent once', async t => {
  const { store, id, cwd } = await waitingBoard(t, ['First request', 'Second request']);
  const dispatcher = createDispatcher({ store, log: () => {}, sleep: async () => {} });
  const paseo = paseoFor(cwd);
  // Two looks at once (the confirmation and a turn's end): the board's queue lets one send, the other finds the next card.
  const outcomes = await Promise.all([dispatcher.kick(paseo, id), dispatcher.kick(paseo, id)]);
  assert.deepEqual(outcomes, ['sent', 'sent']);
  assert.deepEqual(paseo.sent.map(s => s.text.split('\n')[0]), ['[칸반 요청] First request', '[칸반 요청] Second request'], 'oldest first, each once');
  assert.equal(new Set(paseo.sent.map(s => s.messageId)).size, 2);
  // A second daemon (or a lost record) sending the same request again is refused by the daemon's message id; the card is still recorded sent.
  const again = await waitingBoard(t);
  const shared = paseoFor(again.cwd);
  const card = (await again.store.readBoard(again.id)).cards[0];
  await shared.agents.ref(LEAD).send('earlier copy', { messageId: card.dispatch.messageId });
  assert.equal(await createDispatcher({ store: again.store, log: () => {} }).kick(shared, again.id), 'sent');
  assert.equal(shared.sent.length, 1, 'the daemon kept the one it had');
  assert.equal((await again.store.readBoard(again.id)).cards[0].dispatch.state, 'sent');
  assert.equal(alreadyDelivered(new Error('agent_request_key_conflict: messageId reused')), true);
  assert.equal(alreadyDelivered(new Error('socket closed')), false);
});

test('REQ-97 server: a send that fails leaves the card waiting; a card moved back meanwhile is never sent; sub-agents are ignored', async t => {
  const { store, id, cwd } = await waitingBoard(t);
  const logs = [];
  let block = null;
  const dispatcher = createDispatcher({ store, log: m => logs.push(m), sleep: async () => { if (block) await block(); } });
  const failing = paseoFor(cwd);
  failing.agents.ref = idArg => ({ refresh: async () => ({ agent: { id: idArg, status: 'idle', activeTurn: null, archivedAt: null, pendingPermissions: [] } }),
    send: async () => { throw new Error('socket closed'); } });
  assert.equal(await dispatcher.kick(failing, id), 'failed');
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'pending');
  assert.ok(logs.some(m => /send failed/.test(m)));
  // A permission asked for is not idle.
  const asking = paseoFor(cwd, { state: { [LEAD]: { pendingPermissions: [{ id: 'p1' }] } } });
  assert.equal(await dispatcher.kick(asking, id), 'busy');
  // During the grace a person moves the card back: nothing is sent.
  const cardId = (await store.readBoard(id)).cards[0].id;
  block = async () => { block = null; await store.mutateBoard(id, request([{ op: 'move', id: cardId, to: 'todo' }])); };
  const idle = paseoFor(cwd);
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'turn_ended', idle), ['none']);
  assert.equal(idle.sent.length, 0);
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'cancelled');
  // A sub-agent's signal, and signals that do not free the lead, look at nothing.
  assert.deepEqual(await dispatcher.signal(hook(CHILD, cwd, { parentAgentId: LEAD }), 'turn_ended', idle), []);
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'turn_started', idle), []);
  assert.deepEqual(await dispatcher.signal(hook(LEAD, cwd), 'turn_ended', {}), [], 'no SDK, nothing');
});

test('REQ-97 server: a board read sweeps waiting cards at most once per interval; the preview names the lead without sending', async t => {
  const { store, id, cwd } = await waitingBoard(t);
  const dispatcher = createDispatcher({ store, log: () => {}, sweepMs: 30000 });
  const busy = paseoFor(cwd, { state: { [LEAD]: { status: 'running' } } });
  assert.deepEqual(await dispatcher.wake(busy, 1000), ['busy']);
  const idle = paseoFor(cwd);
  assert.deepEqual(await dispatcher.wake(idle, 20000), [], 'too soon');
  assert.deepEqual(await dispatcher.wake(idle, 40000), ['sent']);
  const next = await waitingBoard(t);
  const fresh = paseoFor(next.cwd);
  const card = (await next.store.readBoard(next.id)).cards[0];
  const preview = await createDispatcher({ store: next.store, log: () => {} }).preview(fresh, next.id, card.id);
  assert.deepEqual(preview.lead, { agentId: LEAD, title: '총괄-99 시험', fallback: false });
  assert.equal(preview.locale, 'ko', 'no locale reader: Korean');
  assert.equal(preview.boardTitle, 'Example board'); assert.equal(preview.to, 'doing'); assert.equal(preview.card.id, card.id);
  assert.equal(fresh.sent.length, 0, 'a preview sends nothing'); assert.deepEqual(fresh.refreshed, []);
  const lonely = await createDispatcher({ store: next.store, log: () => {} }).preview(paseoFor(next.cwd, { agents: [] }), next.id, card.id);
  assert.equal(lonely.lead, null);
  assert.equal(leadReadiness(undefined), 'busy', 'an unanswered refresh waits'); assert.equal(leadReadiness(null), 'gone');
  assert.equal(waitingCards({ cards: [] }).length, 0);
});

test('REQ-97 read model and screen model: the chip\'s state, the draft\'s stages, the words', () => {
  let b = applyOperations(board(), [draft('A'), draft('B'), draft('C')], actor, context(at(0))).board;
  const [a, bb, c] = b.cards.map(card => card.id);
  b = applyOperations(b, [{ op: 'dispatch', id: a, to: 'doing' }, { op: 'dispatch', id: bb, to: 'doing' }, { op: 'dispatch', id: c, to: 'doing' }], actor, context(at(1))).board;
  b = applyOperations(b, [{ op: 'dispatched', id: bb, state: 'sent', targetAgentId: LEAD }, { op: 'move', id: c, to: 'todo' }], actor, context(at(2))).board;
  const cards = toBoardDTO(b).stages.flatMap(s => s.cards);
  assert.deepEqual(cards.find(x => x.id === a).dispatch, { state: 'pending', sentAt: null, targetAgentId: null });
  assert.deepEqual(cards.find(x => x.id === bb).dispatch, { state: 'sent', sentAt: at(2), targetAgentId: LEAD });
  assert.equal(Object.hasOwn(cards.find(x => x.id === c), 'dispatch'), false, 'a cancelled request says nothing');
  const stages = builtinTemplate().stages;
  assert.deepEqual(stages.map(s => stageAllowed(stages, 'draft', s.stageId)), [true, true, false, false]);
  assert.equal(sendsToLead(stages, 'draft', 'doing'), true); assert.equal(sendsToLead(stages, 'requested', 'doing'), false);
  assert.equal(dispatchStageId(stages), 'doing');
  const ko = copy('ko'), en = copy('en');
  assert.equal(dispatchLine({ state: 'pending', sentAt: null }, ko), '전송 대기 ⏳');
  assert.match(dispatchLine({ state: 'sent', sentAt: at(2) }, ko), /^전송됨 \d\d:\d\d$/);
  assert.equal(dispatchLine({ state: 'noLead', sentAt: null }, ko), '받을 에이전트 없음');
  assert.equal(dispatchLook({ state: 'cancelled' }), null);
  assert.equal(ko.dispatchTitle('총괄-07'), '총괄-07에게 보낼까요?'); assert.equal(en.dispatchTitle('총괄-07'), 'Send to 총괄-07?');
});

// ---- D37: only the board screen sends a draft to the lead; only the dispatcher records what became of it ----
const CLI = resolve('dist/src/cli/main.js');
function cli(t, root, cwd) {
  return (args, { input = '', agent } = {}) => new Promise((done, reject) => {
    const env = { ...process.env }; delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID; delete env.KANBAN_DATA_DIR;
    if (agent) env.PASEO_AGENT_ID = agent;
    const child = spawn(process.execPath, [CLI, ...args, '--data-dir', join(root, 'data'), '--json'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', b => out += b); child.stdin.end(input);
    child.once('error', reject); child.once('close', code => done({ code, value: JSON.parse(out) }));
  });
}
test('D37 the CLI — as the user or as an agent — may neither send a draft to the lead nor mark it sent; the ledger stays as it was', async t => {
  const { root, cwd, store, id } = await fixture(t);
  const run = cli(t, root, cwd);
  const added = await run(['apply', '-'], { input: JSON.stringify({ operations: [draft()] }) });
  assert.equal(added.code, 0, JSON.stringify(added.value));
  const cardId = added.value.data.cardIds[0];
  const before = await readFile(join(root, 'data', 'boards', id + '.json'));
  for (const agent of [undefined, OTHER]) {
    const sent = await run(['apply', '-'], { agent, input: JSON.stringify({ operations: [{ op: 'dispatch', id: cardId, to: 'doing' }] }) });
    assert.notEqual(sent.code, 0); assert.equal(sent.value.error.code, 'E_VALIDATION');
    assert.equal(sent.value.error.message, 'dispatch is only available from the board UI.');
  }
  assert.deepEqual(await readFile(join(root, 'data', 'boards', id + '.json')), before, 'nothing was written');
  // A waiting request made the proper way still cannot be marked sent from the CLI.
  await store.mutateBoard(id, request([{ op: 'dispatch', id: cardId, to: 'doing' }]), 'board');
  const waiting = await readFile(join(root, 'data', 'boards', id + '.json'));
  assert.notDeepEqual(waiting, before);
  for (const agent of [undefined, OTHER]) {
    const forged = await run(['apply', '-'], { agent, input: JSON.stringify({ operations: [{ op: 'dispatched', id: cardId, state: 'sent', targetAgentId: LEAD }] }) });
    assert.notEqual(forged.code, 0); assert.equal(forged.value.error.code, 'E_VALIDATION');
    assert.equal(forged.value.error.message, 'dispatched is recorded only by the server dispatcher.');
  }
  assert.deepEqual(await readFile(join(root, 'data', 'boards', id + '.json')), waiting, 'nothing was written');
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'pending');
});

test('D37 the board screen may send a draft; the store refuses it from anyone else, and from an agent even as the board', async t => {
  const { store, id } = await fixture(t);
  await store.mutateBoard(id, request([draft('A'), draft('B')]));
  const [a, b] = (await store.readBoard(id)).cards.map(c => c.id);
  await assert.rejects(store.mutateBoard(id, request([{ op: 'dispatch', id: a, to: 'doing' }])), /only available from the board UI/);
  await assert.rejects(store.mutateBoard(id, request([{ op: 'dispatch', id: a, to: 'doing' }]), 'dispatcher'), /only available from the board UI/);
  await assert.rejects(store.mutateBoard(id, { ...request([{ op: 'dispatch', id: a, to: 'doing' }]), actor: { kind: 'agent', agentId: OTHER } }, 'board'),
    /only available from the board UI/);
  assert.throws(() => applyAs(board(), [{ op: 'dispatch', id: a, to: 'doing' }], actor, context(at(1))), /only available from the board UI/);
  const handler = createMutationHandler(store);
  const sent = await handler({ boardId: id, requestId: randomUUID(), ifRevision: (await store.readBoard(id)).revision,
    operations: [{ op: 'dispatch', id: b, to: 'doing' }] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const cards = (await store.readBoard(id)).cards;
  assert.equal(cards.find(c => c.id === a).dispatch, undefined, 'the refused card is still a draft');
  assert.equal(cards.find(c => c.id === b).dispatch.state, 'pending');
});

test('D37 only the dispatcher records what became of a request — and it still does', async t => {
  const { store, id, cwd } = await waitingBoard(t);
  const cardId = (await store.readBoard(id)).cards[0].id;
  const mark = [{ op: 'dispatched', id: cardId, state: 'sent', targetAgentId: LEAD }];
  await assert.rejects(store.mutateBoard(id, request(mark)), /only by the server dispatcher/);
  await assert.rejects(store.mutateBoard(id, request(mark), 'board'), /only by the server dispatcher/);
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'pending');
  const paseo = paseoFor(cwd);
  await createDispatcher({ store, log: () => {} }).kick(paseo, id);
  assert.equal(paseo.sent.length, 1);
  const card = (await store.readBoard(id)).cards[0];
  assert.equal(card.dispatch.state, 'sent'); assert.equal(card.dispatch.targetAgentId, LEAD);
});

test('J2 two screens send the same card: the one that loses reads it again and says it is already sent or queued, not "could not send"', () => {
  const ko = copy('ko'), en = copy('en');
  assert.equal(dispatchAlreadyNotice({ state: 'sent' }, ko), '이미 보냈습니다');
  assert.equal(dispatchAlreadyNotice({ state: 'pending' }, ko), '이미 전송 대기 중입니다');
  assert.equal(dispatchAlreadyNotice({ state: 'noLead' }, ko), '이미 전송 대기 중입니다', 'waiting for a lead is still queued');
  assert.equal(dispatchAlreadyNotice({ state: 'sent' }, en), 'Already sent');
  assert.equal(dispatchAlreadyNotice({ state: 'pending' }, en), 'Already queued');
  assert.equal(dispatchAlreadyNotice({ state: 'cancelled' }, ko), null, 'moved back to a draft: a real failure');
  assert.equal(dispatchAlreadyNotice(undefined, ko), null);
});
