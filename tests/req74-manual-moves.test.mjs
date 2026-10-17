import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutoCards, readAutoState, foreignMove, cardTracking, cardPause, cardEntries } from '../dist/server/auto-cards.js';
import { moveReasonText, trackingText } from '../dist/client/move-reason.js';
import { copy } from '../dist/client/i18n.js';
import { createReadHandlers, readLocale } from '../dist/server/handlers.js';
import { cardGet, autoCardsResume } from '../dist/shared/rpc.js';
import { fixture, request, add } from './helpers.mjs';

// REQ-74: a stage somebody chose is never overruled by the automatic cards; archiving an agent never completes its card.
const WORKSPACE = 'wks_example01';
const agentOf = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, parentAgentId: null,
  cwd: '/nowhere', title: '[검증용] 자동 카드', ...overrides });
async function setup(t, options = {}) {
  const f = await fixture(t);
  const auto = createAutoCards({ store: f.store, locale: readLocale, log: () => {}, ...(options.now ? { now: options.now } : {}) });
  const cardOf = async agentId => (await f.store.readBoard(f.id)).cards.find(c => c.agents.some(a => a.agentId === agentId));
  const read = createReadHandlers(f.store);
  const detail = async cardId => { const reply = await read.card({ boardId: f.id, cardId });
    assert.equal(reply.ok, true, JSON.stringify(reply)); return cardGet.output.parse(reply).data; };
  return { ...f, auto, cardOf, detail };
}
/** A move as the board or the detail view makes it (`kanban.v1.board.mutate` always acts as the user). */
const moveByPerson = (s, id, to) => s.store.mutateBoard(s.id, request([{ op: 'move', id, to }]));
/** A move as `kanban card move` makes it inside an agent session (PASEO_AGENT_ID → an agent actor). */
const moveByAgent = (s, id, to, agentId) => s.store.mutateBoard(s.id,
  { actor: { kind: 'agent', agentId }, requestId: randomUUID(), operations: [{ op: 'move', id, to }] });

test('REQ-74 ① a person\'s move pauses the automatic moves: the next "work finished" leaves the card where the person put it', async t => {
  const s = await setup(t);
  const agent = agentOf();
  await s.auto.signal(agent, 'created');
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'updated');
  let card = await s.cardOf(agent.id);
  assert.equal(card.stageId, 'doing');
  await moveByPerson(s, card.id, 'todo');
  assert.equal(await s.auto.signal(agent, 'turn_ended'), 'paused', 'the move is held, nothing written');
  assert.equal((await s.cardOf(agent.id)).stageId, 'todo');
  // Back to work: the bucket it last applied, so nothing to hold — the card still stays.
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'unchanged');
  assert.equal((await s.cardOf(agent.id)).stageId, 'todo');
  assert.equal(await s.auto.signal(agent, 'turn_ended'), 'paused');
  assert.equal((await s.cardOf(agent.id)).stageId, 'todo');
  // The pause is kept in the plugin's own file, so it outlives the ledger's bounded history.
  const remembered = (await readAutoState(s.store.dataDir)).agents[agent.id];
  assert.ok(remembered.pausedAt, 'pausedAt recorded');
  // The permission flag still follows the agent while the stage is paused.
  await s.auto.signal(agent, 'permission_requested');
  card = await s.cardOf(agent.id);
  assert.equal(card.awaiting, 'user');
  assert.equal(card.stageId, 'todo');
  await s.auto.signal(agent, 'permission_resolved');
  assert.equal((await s.cardOf(agent.id)).awaiting, null);
});

test('REQ-74 ① an orchestrator\'s `kanban card move` pauses it too, and the card\'s own agent moving it by CLI counts as a choice', async t => {
  const s = await setup(t);
  const agent = agentOf(), orchestrator = randomUUID();
  await s.auto.signal(agent, 'created');
  await s.auto.signal(agent, 'turn_started');
  const card = await s.cardOf(agent.id);
  await moveByAgent(s, card.id, 'todo', orchestrator);
  assert.equal(await s.auto.signal(agent, 'turn_ended'), 'paused');
  assert.equal((await s.cardOf(agent.id)).stageId, 'todo');
  // A second agent, which moves its own auto card by CLI.
  const solo = agentOf();
  await s.auto.signal(solo, 'created');
  await s.auto.signal(solo, 'turn_started');
  const own = await s.cardOf(solo.id);
  await moveByAgent(s, own.id, 'todo', solo.id);
  assert.equal(await s.auto.signal(solo, 'turn_ended'), 'paused', 'a move this feature did not write is a choice, whoever made it');
  assert.equal((await s.cardOf(solo.id)).stageId, 'todo');
});

test('REQ-74 ① "resume automatic tracking": the card stays put, then the next signal moves it again', async t => {
  let clock = '2026-09-25T02:00:00.000Z';
  const s = await setup(t, { now: () => clock });
  const agent = agentOf();
  await s.auto.signal(agent, 'created');
  await s.auto.signal(agent, 'turn_started');
  const card = await s.cardOf(agent.id);
  await moveByPerson(s, card.id, 'todo');
  assert.equal(await s.auto.signal(agent, 'turn_ended'), 'paused');
  clock = '2099-01-01T00:00:00.000Z'; // after the ledger's own clock, whatever it read
  const before = (await s.store.readBoard(s.id)).revision;
  assert.deepEqual(await s.auto.resume(s.id, card.id), { resumed: 1 });
  assert.equal((await s.store.readBoard(s.id)).revision, before, 'resuming writes no ledger commit');
  assert.equal((await s.cardOf(agent.id)).stageId, 'todo', 'and does not move the card by itself');
  const state = (await readAutoState(s.store.dataDir)).agents[agent.id];
  assert.equal(state.pausedAt, null);
  assert.equal(state.resumedAt, clock);
  // The same "work finished" that was held before now moves it.
  assert.equal(await s.auto.signal(agent, 'turn_ended'), 'updated');
  assert.equal((await s.cardOf(agent.id)).stageId, 'review');
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'updated');
  assert.equal((await s.cardOf(agent.id)).stageId, 'doing');
  // A card nobody tracks resumes nothing.
  assert.deepEqual(await s.auto.resume(s.id, 'card_' + randomUUID()), { resumed: 0 });
});

test('REQ-74 ② archiving an agent leaves its card in review (or where it is), never in done', async t => {
  const s = await setup(t);
  const working = agentOf();
  await s.auto.signal(working, 'created');
  await s.auto.signal(working, 'turn_started');
  assert.equal(await s.auto.signal(working, 'archived'), 'updated');
  assert.equal((await s.cardOf(working.id)).stageId, 'review', 'working → review');
  const reviewed = agentOf();
  await s.auto.signal(reviewed, 'created');
  await s.auto.signal(reviewed, 'turn_ended');
  assert.equal(await s.auto.signal(reviewed, 'archived'), 'unchanged', 'already in review: nothing written');
  assert.equal((await s.cardOf(reviewed.id)).stageId, 'review');
  // A person completes it; the archived agent never moves it back.
  const card = await s.cardOf(reviewed.id);
  await moveByPerson(s, card.id, 'done');
  assert.equal(await s.auto.signal(reviewed, 'archived'), 'unchanged', 'same bucket as last applied: nothing to hold or write');
  assert.ok((await readAutoState(s.store.dataDir)).agents[reviewed.id].pausedAt, 'but the person\'s move is noticed and kept');
  assert.equal((await s.cardOf(reviewed.id)).stageId, 'done');
  // Reconciliation after a restart agrees: an archived agent's card lands in review.
  const listed = { id: randomUUID(), workspaceId: WORKSPACE, cwd: '/nowhere', title: 'Archived meanwhile', labels: {},
    status: 'idle', pendingPermissions: [], archivedAt: '2099-01-01T00:00:00.000Z', lastUserMessageAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2099-01-01T00:00:00.000Z' };
  const paseo = { agents: { list: async () => ({ entries: [{ agent: listed }], pageInfo: { nextCursor: null } }) } };
  const restarted = createAutoCards({ store: s.store, locale: readLocale, log: () => {} });
  await restarted.signal(agentOf(), 'turn_started', paseo);
  await restarted.idle();
  assert.equal((await s.cardOf(listed.id)).stageId, 'review');
});

test('REQ-74 ③ the detail says why the card is where it is, and whether tracking is on or paused', async t => {
  const s = await setup(t);
  const agent = agentOf();
  await s.auto.signal(agent, 'created');
  const card = await s.cardOf(agent.id);
  let view = await s.detail(card.id);
  assert.deepEqual([view.reason.by, view.reason.cause, view.reason.created], ['auto', 'created', true]);
  assert.deepEqual(view.tracking, { state: 'on', since: null });
  await s.auto.signal(agent, 'turn_started');
  view = await s.detail(card.id);
  assert.deepEqual([view.reason.by, view.reason.cause, view.reason.created, view.reason.agentId], ['auto', 'turn_started', false, agent.id]);
  await s.auto.signal(agent, 'turn_ended');
  assert.equal((await s.detail(card.id)).reason.cause, 'turn_ended');
  // A person's move shows at once, before any signal arrives.
  await moveByPerson(s, card.id, 'todo');
  view = await s.detail(card.id);
  const moved = (await s.store.readBoard(s.id)).history.at(-1);
  assert.deepEqual(view.reason, { by: 'user', cause: null, agentId: null, at: moved.at, created: false });
  assert.deepEqual(view.tracking, { state: 'paused', since: moved.at });
  await s.auto.resume(s.id, card.id);
  assert.equal((await s.detail(card.id)).tracking.state, 'on');
  // Another agent's move names that agent; a card with no auto agent has a reason but no tracking line.
  const orchestrator = randomUUID();
  await moveByAgent(s, card.id, 'review', orchestrator);
  view = await s.detail(card.id);
  assert.deepEqual([view.reason.by, view.reason.agentId, view.tracking.state], ['agent', orchestrator, 'paused']);
  const plain = (await s.store.mutateBoard(s.id, request([add('Hand-made card')]))).data.cardIds[0];
  view = await s.detail(plain);
  assert.deepEqual([view.reason.by, view.reason.created, view.tracking], ['user', true, null]);
  // Switched off in settings: the tracking line says so.
  await s.auto.setEnabled('host_a', false);
  assert.equal((await s.detail(card.id)).tracking.state, 'off');
  // The resume contract as the RPC carries it.
  assert.deepEqual(autoCardsResume.input.parse({ boardId: s.id, cardId: card.id }), { boardId: s.id, cardId: card.id });
});

test('REQ-74 ① moves made before the agent joined a card (an orchestrator arranging it) do not pause it; a damaged state is harmless', async t => {
  const s = await setup(t);
  const agent = agentOf();
  const cardId = (await s.store.mutateBoard(s.id, request([add('Orchestrator card')]))).data.cardIds[0];
  await moveByPerson(s, cardId, 'review');
  await moveByPerson(s, cardId, 'todo');
  await s.store.mutateBoard(s.id, request([{ op: 'link', id: cardId, agentId: agent.id, role: 'worker', label: 'orc' }]));
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'updated');
  assert.equal((await s.cardOf(agent.id)).stageId, 'doing');
  const board = await s.store.readBoard(s.id);
  const card = board.cards.find(c => c.id === cardId);
  const entry = (await readAutoState(s.store.dataDir)).agents[agent.id];
  assert.equal(foreignMove(board.history, card, [[agent.id, entry]]), null, 'its own move is recognised by revision');
  assert.equal(cardTracking(board, card, await readAutoState(s.store.dataDir)).tracking.state, 'on');
  // A damaged file reads as empty: the reason still comes from the ledger, the tracking line goes away.
  await fs.writeFile(join(s.store.dataDir, 'auto-cards.json'), '{nope');
  const view = await s.detail(cardId);
  assert.equal(view.tracking, null);
  assert.equal(view.reason.by, 'agent');
});

// ---- REQ-74 gate findings (research/102): F1 the pause is the card's, F2 resume vs. a signal in flight, F3 wording, F4 narrow screens ----

/** An orchestrator linking another top-level agent to a card (the executor → verifier flow). */
const linkByOrchestrator = (s, id, agentId, orchestrator) => s.store.mutateBoard(s.id,
  { actor: { kind: 'agent', agentId: orchestrator }, requestId: randomUUID(), operations: [{ op: 'link', id, agentId, role: 'worker' }] });
/** The engine and the detail view judge the pause with the same function. */
async function pauseAgrees(s, cardId) {
  const board = await s.store.readBoard(s.id), card = board.cards.find(c => c.id === cardId);
  const state = await readAutoState(s.store.dataDir);
  const paused = cardPause(board.history, card, cardEntries(state, board.id, card.id));
  const view = await s.detail(cardId);
  assert.equal(view.tracking.state === 'paused', !!paused, 'detail and engine agree');
  return view.tracking.state;
}

test('REQ-74 F1 the pause belongs to the card: an agent linked after a person\'s move obeys it, and resume releases every agent', async t => {
  const s = await setup(t);
  const a = agentOf(), b = agentOf(), orchestrator = randomUUID();
  await s.auto.signal(a, 'created');
  await s.auto.signal(a, 'turn_started');
  const card = await s.cardOf(a.id);
  await moveByPerson(s, card.id, 'todo');
  await linkByOrchestrator(s, card.id, b.id, orchestrator);
  assert.equal(await pauseAgrees(s, card.id), 'paused');
  assert.equal(await s.auto.signal(b, 'turn_started'), 'paused', 'the later agent does not overrule the person');
  assert.equal(await s.auto.signal(b, 'turn_ended'), 'paused');
  assert.equal((await s.cardOf(b.id)).stageId, 'todo');
  assert.equal(await pauseAgrees(s, card.id), 'paused');
  assert.ok((await readAutoState(s.store.dataDir)).agents[b.id].pausedAt, 'kept for the later agent too');
  // Resume turns every agent of the card back on; then the agents move it in turn without pausing each other.
  assert.deepEqual(await s.auto.resume(s.id, card.id), { resumed: 2 });
  assert.equal(await pauseAgrees(s, card.id), 'on');
  assert.equal(await s.auto.signal(b, 'turn_started'), 'updated');
  assert.equal((await s.cardOf(b.id)).stageId, 'doing');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'updated', 'another agent\'s automatic move is not a choice');
  assert.equal((await s.cardOf(a.id)).stageId, 'review');
  assert.equal(await pauseAgrees(s, card.id), 'on');
});

test('REQ-74 F1 a card a person completed stays done when a verifier is linked later; arranging before tracking began still does not count', async t => {
  const s = await setup(t);
  const orchestrator = randomUUID(), a = agentOf(), b = agentOf();
  const cardId = (await s.store.mutateBoard(s.id, { actor: { kind: 'agent', agentId: orchestrator }, requestId: randomUUID(),
    operations: [{ op: 'add', title: 'Orchestrated card', intent: 'requested', acceptanceCriteria: 'x', stageId: 'todo' }] })).data.cardIds[0];
  // REQ-61 ③: the orchestrator places the card before any tracked agent joined — not a choice.
  await moveByAgent(s, cardId, 'doing', orchestrator);
  await linkByOrchestrator(s, cardId, a.id, orchestrator);
  assert.equal(await s.auto.signal(a, 'turn_started'), 'unchanged');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'updated');
  assert.equal(await pauseAgrees(s, cardId), 'on');
  await moveByPerson(s, cardId, 'done');
  await linkByOrchestrator(s, cardId, b.id, orchestrator);
  assert.equal(await s.auto.signal(b, 'turn_started'), 'paused');
  assert.equal((await s.store.readBoard(s.id)).cards.find(c => c.id === cardId).stageId, 'done', 'a completed card never goes back to work');
  assert.equal(await pauseAgrees(s, cardId), 'paused');
  // A card whose only agent joined after all the moves: tracking began with it, so nothing pauses.
  const c = agentOf();
  const fresh = (await s.store.mutateBoard(s.id, request([add('Arranged card')]))).data.cardIds[0];
  await moveByPerson(s, fresh, 'review');
  await linkByOrchestrator(s, fresh, c.id, orchestrator);
  assert.equal(await s.auto.signal(c, 'turn_started'), 'updated');
  assert.equal(await pauseAgrees(s, fresh), 'on');
});

test('REQ-74 F2 a resume that comes in while a signal for the card is being written is not lost', async t => {
  const s = await setup(t);
  const a = agentOf();
  await s.auto.signal(a, 'created');
  await s.auto.signal(a, 'turn_started');
  const card = await s.cardOf(a.id);
  await moveByPerson(s, card.id, 'todo');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'paused');
  // Hold the ledger write of the next signal (a permission flag, written even while paused).
  const original = s.store.mutateBoard;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  s.store.mutateBoard = async (...args) => { await held; return original.apply(s.store, args); };
  t.after(() => { s.store.mutateBoard = original; });
  const signal = s.auto.signal(a, 'permission_requested');
  await new Promise(resolve => setTimeout(resolve, 50));
  const resume = s.auto.resume(s.id, card.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  assert.equal(await signal, 'updated');
  assert.deepEqual(await resume, { resumed: 1 });
  s.store.mutateBoard = original;
  const entry = (await readAutoState(s.store.dataDir)).agents[a.id];
  assert.deepEqual([entry.pausedAt, !!entry.resumedAt, entry.bucket], [null, true, null]);
  assert.equal((await s.detail(card.id)).tracking.state, 'on');
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated', 'and the next signal moves the card');
});

test('REQ-74 F3 wording: the card\'s own agent is "this card\'s agent", and a pause does not claim a person moved it', async t => {
  const s = await setup(t);
  const a = agentOf();
  await s.auto.signal(a, 'created');
  await s.auto.signal(a, 'turn_started');
  const card = await s.cardOf(a.id);
  await moveByAgent(s, card.id, 'review', a.id);
  const view = await s.detail(card.id);
  assert.deepEqual([view.reason.by, view.reason.agentId, view.tracking.state], ['agent', a.id, 'paused'], 'still a pause (confirmed design)');
  const agents = view.card.agents.map(x => x.agentId), now = Date.now();
  const ko = copy('ko'), en = copy('en');
  assert.match(moveReasonText(view.reason, ko, now, agents), new RegExp('^이 카드의 에이전트가 옮김\\(' + a.id.slice(0, 8) + '\\)'));
  assert.match(moveReasonText(view.reason, en, now, agents), /^Moved by this card's agent \(/);
  assert.match(moveReasonText(view.reason, ko, now, []), /^다른 에이전트가 옮김\(/, 'an agent not on the card is another agent');
  assert.match(moveReasonText(view.reason, en, now), /^Moved by another agent \(/);
  for (const text of [trackingText(view.tracking, ko, now), trackingText(view.tracking, en, now)]) {
    assert.doesNotMatch(text, /사람이|by hand|person/);
  }
  assert.match(trackingText(view.tracking, ko, now), /^멈춤 — 자동 추적 밖에서 옮겨져/);
  assert.match(trackingText(view.tracking, en, now), /^Paused — moved outside automatic tracking/);
});

test('REQ-74 F4 the elapsed "(16시간 전)" part never breaks inside itself on a narrow screen', () => {
  const now = Date.parse('2026-09-25T06:00:00.000Z');
  const reason = { by: 'agent', cause: null, agentId: randomUUID(), at: '2026-09-24T14:00:00.000Z', created: false };
  for (const [m, inside] of [[copy('ko'), '16시간\u00a0전'], [copy('en'), '16h\u00a0ago']]) {
    const text = moveReasonText(reason, m, now).replace(/\u2060/g, '');
    assert.ok(text.endsWith(' (' + inside + ')'), 'a normal space before the part, none inside it: ' + JSON.stringify(text));
  }
});

// ---- REQ-74 regate findings (research/104): G1 unlinking an agent, G2 Korean syllables on a narrow screen ----

test('REQ-74 G1 unlinking an agent is not a move: its earlier automatic move stays automatic and the card does not pause', async t => {
  const s = await setup(t);
  const a = agentOf(), b = agentOf(), orchestrator = randomUUID();
  await s.auto.signal(a, 'created');
  await s.auto.signal(a, 'turn_started');
  const card = await s.cardOf(a.id);
  await linkByOrchestrator(s, card.id, b.id, orchestrator);
  assert.equal(await s.auto.signal(b, 'turn_ended'), 'updated', 'B moves the card to review automatically');
  assert.equal((await s.cardOf(a.id)).stageId, 'review');
  await s.store.mutateBoard(s.id, { actor: { kind: 'agent', agentId: orchestrator }, requestId: randomUUID(),
    operations: [{ op: 'unlink', id: card.id, agentId: b.id }] });
  // The detail still reads B's move as automatic, and tracking stays on.
  const view = await s.detail(card.id);
  assert.deepEqual([view.reason.by, view.reason.agentId, view.reason.cause], ['auto', b.id, 'turn_ended']);
  assert.equal(await pauseAgrees(s, card.id), 'on');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'unchanged', 'already in review');
  assert.equal(await pauseAgrees(s, card.id), 'on');
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated', 'A keeps moving its card');
  assert.equal((await s.cardOf(a.id)).stageId, 'doing');
  // A move outside automatic tracking still pauses the card, unlinked agents or not.
  await moveByPerson(s, card.id, 'todo');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'paused');
  assert.equal(await pauseAgrees(s, card.id), 'paused');
  // The unlinked agent's CLI move is not automatic either: only revisions this feature wrote are.
  assert.deepEqual(await s.auto.resume(s.id, card.id), { resumed: 2 });
  await new Promise(resolve => setTimeout(resolve, 5));
  await moveByAgent(s, card.id, 'review', b.id);
  assert.equal(await pauseAgrees(s, card.id), 'paused');
  assert.equal((await s.detail(card.id)).reason.by, 'agent');
});

test('REQ-74 G2 the elapsed "(17시간 전)" part has no break opportunity between its syllables', () => {
  const now = Date.parse('2026-09-25T07:00:00.000Z');
  const reason = { by: 'agent', cause: null, agentId: randomUUID(), at: '2026-09-24T14:00:00.000Z', created: false };
  for (const m of [copy('ko'), copy('en')]) {
    const text = moveReasonText(reason, m, now);
    const part = text.slice(text.lastIndexOf(' ') + 1);
    assert.ok(part.startsWith('('), JSON.stringify(text));
    // Every two visible characters of the part are joined by a word joiner (U+2060), spaces are no-break.
    const visible = Array.from(part.replace(/\u2060/g, ''));
    assert.equal(part, visible.join('\u2060'), 'joined throughout: ' + JSON.stringify(part));
    assert.doesNotMatch(part, / /);
  }
  assert.ok(moveReasonText(reason, copy('ko'), now).replace(/\u2060/g, '').endsWith(' (17시간\u00a0전)'));
});
