import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutoCards, readAutoState, writeAutoState } from '../dist/server/auto-cards.js';
import { readLocale } from '../dist/server/handlers.js';
import { openStore } from '../dist/server/core/index.js';
import { d66, catching, noAutomaticStageChange } from './d66-control-helpers.mjs';

// D66 G1 (research/477, design 470 §4 counterexamples 1-9 and 12, G0 review 476 F1-F3).
// A stage a person or an outside writer chose is a decision of the card, kept in the card's control entry
// (`auto-control/<boardId>.json`) by the very transaction that made it; only an explicit resume gives the
// automatic moves back. Times are equal on purpose where the order must not come from a clock.
const FIXED = '2026-10-18T12:00:00.000Z';
const sameTime = { context: { newId: randomUUID, now: () => FIXED }, now: () => FIXED };

async function tracked(s, agent = s.agentOf()) {
  assert.equal(await s.auto.signal(agent, 'created'), 'created');
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'updated');
  const card = await s.cardOf(agent.id);
  assert.equal(card.stageId, 'doing');
  return { agent, card };
}

test('D66 CE1 add → person done → link → stop before memory, a verifier signals first: done stays, the card is paused', async t => {
  const s = await d66(t, sameTime);
  const a = s.agentOf(), verifier = s.agentOf(), orchestrator = randomUUID();
  let stopped = false;
  const engine = s.make(catching(s.store, async input => {
    if (input.operations[0].op !== 'link') return;
    await s.person([{ op: 'move', id: input.operations[0].id, to: 'done' }]);
    return () => { stopped = true; throw new Error('Stopped after the link commit, before the memory'); };
  }));
  assert.equal(await engine.signal(a, 'created'), 'failed');
  assert.equal(stopped, true);
  assert.equal((await readAutoState(s.store.dataDir)).agents[a.id], undefined, 'nothing remembered for the agent');
  const card = await s.cardOf(a.id);
  assert.equal(card.stageId, 'done');
  await s.cli(orchestrator, [{ op: 'link', id: card.id, agentId: verifier.id, role: 'verifier' }]);
  await noAutomaticStageChange(s, [verifier, a], card.id, 'CE1');
  assert.deepEqual([(await s.entry(card.id)).mode, (await s.entry(card.id)).reason], ['paused', 'moved'],
    'the person\'s transaction itself recorded the pause');
});

test('D66 CE2 paused, then the agent memory evicts the original assignee (1,001 entries), B takes over, history and receipts are trimmed', async t => {
  const s = await d66(t);
  const { agent: a, card } = await tracked(s);
  await s.person([{ op: 'move', id: card.id, to: 'done' }]);
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'paused');
  // The real writer keeps the 1,000 newest entries: a is pushed out.
  const state = await readAutoState(s.store.dataDir);
  for (let i = 0; i < 1001; i++) state.agents[randomUUID()] = { boardId: s.id, cardId: 'card_' + randomUUID(), bucket: 'working',
    awaiting: false, title: null, at: new Date(Date.UTC(2099, 0, 1, 0, 0, i % 60, i)).toISOString() };
  await writeAutoState(s.store.dataDir, state);
  assert.equal((await readAutoState(s.store.dataDir)).agents[a.id], undefined, 'a was really evicted');
  const b = s.agentOf(), orchestrator = randomUUID();
  await s.cli(orchestrator, [{ op: 'unlink', id: card.id, agentId: a.id }]);
  await s.cli(orchestrator, [{ op: 'link', id: card.id, agentId: b.id, role: 'worker' }]);
  // The ledger's bounded records run out as well (what 1,000 later commits would leave).
  await s.outsideWrite(raw => { raw.history = raw.history.filter(h => h.cardId !== card.id); raw.receipts = []; }, false);
  await noAutomaticStageChange(s, [b], card.id, 'CE2');
  assert.equal((await s.card(card.id)).stageId, 'done');
  assert.equal((await s.view(card.id)).mode, 'paused');
});

test('D66 CE3 a person completes the card before the engine looked, and the memory and history are gone before it does', async t => {
  const s = await d66(t);
  const { agent: a, card } = await tracked(s);
  await s.person([{ op: 'move', id: card.id, to: 'done' }]);
  await fs.rm(join(s.store.dataDir, 'auto-cards.json'), { force: true });
  await fs.rm(join(s.store.dataDir, 'auto-cards.backup.json'), { force: true });
  await s.outsideWrite(raw => { raw.history = []; raw.receipts = []; }, false);
  await noAutomaticStageChange(s, [a], card.id, 'CE3');
  assert.equal((await s.view(card.id)).mode, 'paused');
});

test('D66 CE4 two processes: A\'s write waits while B resumes; A\'s late memory cannot undo the resume, and an old proposal is refused', async t => {
  const s = await d66(t);
  const { agent: a, card } = await tracked(s);
  await s.person([{ op: 'move', id: card.id, to: 'todo' }]);
  const second = await openStore({ dataDir: s.store.dataDir });
  const b = createAutoCards({ store: second, locale: readLocale, log: () => {} });
  // A, a second daemon on the same data: its permission flag write (allowed while paused) waits until B resumed.
  const first = s.make(catching(await openStore({ dataDir: s.store.dataDir }), async input => {
    if (input.operations.some(o => o.op === 'update')) assert.deepEqual(await b.resume(s.id, card.id), { resumed: 1 });
  }));
  assert.equal(await first.signal(a, 'turn_ended'), 'paused');
  const token = JSON.parse(await fs.readFile(s.controlPath, 'utf8').catch(() => '{"cards":{}}')).cards[card.id] ?? {};
  assert.equal(await first.signal(a, 'permission_requested'), 'updated');
  // Three fresh engines: the resume holds, the agent moves the card again.
  for (const signal of ['turn_ended', 'turn_started', 'turn_ended']) {
    const restarted = s.make();
    assert.equal(await restarted.signal(a, signal), 'updated', signal);
  }
  assert.equal((await s.card(card.id)).stageId, 'review');
  assert.equal(token.mode, 'paused');
  assert.equal((await s.view(card.id)).mode, 'managed', 'the resume committed in the control file');
  assert.ok((await s.view(card.id)).generation > token.generation);
  // A proposal made from the token before the resume is refused, even when the board revision is current.
  const now = await s.view(card.id);
  await assert.rejects(s.store.autoMutate(s.id, { agentId: a.id, requestId: randomUUID(), ifRevision: (await s.board()).revision,
    expect: { controlEpoch: token.controlEpoch ?? (await s.control()).controlEpoch, generation: token.generation },
    operations: [{ op: 'move', id: card.id, to: 'doing' }] }), e => e.code === 'E_AUTO_HELD' && e.committed === false);
  assert.equal((await s.card(card.id)).stageId, 'review');
  assert.equal((await s.view(card.id)).generation, now.generation);
});

test('D66 CE5 resume and a later person move, both orders; a stale token is refused; another card\'s edit does not refuse it (F2)', async t => {
  const s = await d66(t);
  const { agent: a, card } = await tracked(s);
  const other = (await s.person([{ op: 'add', title: 'Another card' }])).data.cardIds[0];
  await s.person([{ op: 'move', id: card.id, to: 'todo' }]);
  // Resume first, then a person's done: the later decision wins.
  await s.auto.resume(s.id, card.id);
  await s.person([{ op: 'move', id: card.id, to: 'done' }]);
  assert.equal((await s.view(card.id)).mode, 'paused');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'paused');
  // A token read before the person's move is refused.
  const seen = await s.view(card.id);
  const epoch = (await s.control()).controlEpoch;
  await s.person([{ op: 'move', id: card.id, to: 'doing' }]);
  await assert.rejects(s.store.resumeAuto(s.id, card.id, { controlEpoch: epoch, generation: seen.generation, decisionId: randomUUID() }),
    e => e.code === 'E_AUTO_STALE' && e.committed === false);
  assert.equal((await s.view(card.id)).mode, 'paused');
  // F2: a fresh token stays good while another card is edited (the board revision moves, the card's generation does not).
  const fresh = await s.view(card.id), before = (await s.board()).revision;
  await s.person([{ op: 'update', id: other, patch: { notes: 'busy board' } }]);
  assert.notEqual((await s.board()).revision, before);
  const resumed = await s.store.resumeAuto(s.id, card.id, { controlEpoch: epoch, generation: fresh.generation, decisionId: randomUUID() });
  assert.equal(resumed.data.mode, 'managed');
  // A resume changes the generation without a board commit; a token from before it is stale.
  await assert.rejects(s.store.resumeAuto(s.id, card.id, { controlEpoch: epoch, generation: fresh.generation, decisionId: randomUUID() }),
    e => e.code === 'E_AUTO_STALE');
});

test('D66 CE6 a resume whose answer was lost is retried with the same decision: replayed once, never over a later person move', async t => {
  const s = await d66(t);
  const { card } = await tracked(s);
  await s.person([{ op: 'move', id: card.id, to: 'done' }]);
  const seen = await s.view(card.id), epoch = (await s.control()).controlEpoch, decisionId = randomUUID();
  const first = await s.store.resumeAuto(s.id, card.id, { controlEpoch: epoch, generation: seen.generation, decisionId });
  const again = await s.store.resumeAuto(s.id, card.id, { controlEpoch: epoch, generation: seen.generation, decisionId });
  assert.deepEqual([again.data.replayed, again.data.generation, again.data.mode], [true, first.data.generation, 'managed']);
  await s.person([{ op: 'move', id: card.id, to: 'done' === (await s.card(card.id)).stageId ? 'review' : 'done' }]);
  await s.person([{ op: 'move', id: card.id, to: 'done' }]);
  await assert.rejects(s.store.resumeAuto(s.id, card.id, { controlEpoch: epoch, generation: seen.generation, decisionId }),
    e => e.code === 'E_AUTO_STALE');
  assert.equal((await s.view(card.id)).mode, 'paused');
});

test('D66 CE7 an outside writer changed one card (same revision, other bytes): only that card needs a check; the other keeps moving (F3)', async t => {
  const s = await d66(t);
  const { agent: a, card: x } = await tracked(s);
  const { agent: b, card: y } = await tracked(s);
  await s.outsideWrite(raw => { raw.cards.find(c => c.id === x.id).stageId = 'done'; }, false);
  assert.equal((await s.view(x.id)).mode, 'unknown');
  assert.equal((await s.view(y.id)).mode, 'managed');
  await noAutomaticStageChange(s, [a], x.id, 'CE7 x');
  assert.equal(await s.auto.signal(b, 'turn_ended'), 'updated', 'the board is not held as a whole');
  assert.equal((await s.card(y.id)).stageId, 'review');
  // Per card, a person can turn it back on after looking at it (F3: unknown too).
  await s.auto.resume(s.id, x.id);
  assert.equal((await s.view(x.id)).mode, 'managed');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'updated');
  assert.equal((await s.card(x.id)).stageId, 'review');
});

test('D66 CE7 no control file at all: done is paused, a linked card needs a check, a card nobody ever tracked is free (F1)', async t => {
  const s = await d66(t);
  const { agent: a, card: tracked1 } = await tracked(s);
  const { agent: b, card: finished } = await tracked(s);
  await s.person([{ op: 'move', id: finished.id, to: 'done' }]);
  const free = (await s.person([{ op: 'add', title: 'Orchestrator card', intent: 'requested', acceptanceCriteria: 'x' }])).data.cardIds[0];
  await s.person([{ op: 'move', id: free, to: 'review' }]);
  await fs.rm(join(s.store.dataDir, 'auto-control'), { recursive: true, force: true });
  await fs.rm(join(s.store.dataDir, 'auto-cards.json'), { force: true });
  await fs.rm(join(s.store.dataDir, 'auto-cards.backup.json'), { force: true });
  await noAutomaticStageChange(s, [a], tracked1.id, 'CE7 missing');
  await noAutomaticStageChange(s, [b], finished.id, 'CE7 missing done');
  assert.deepEqual([(await s.view(tracked1.id)).mode, (await s.view(finished.id)).mode, (await s.view(free)).mode],
    ['unknown', 'paused', 'unowned']);
  // F1: a later link starts tracking a card that was never tracked.
  const c = s.agentOf();
  await s.cli(randomUUID(), [{ op: 'link', id: free, agentId: c.id, role: 'worker' }]);
  assert.equal((await s.view(free)).mode, 'managed');
  assert.equal(await s.auto.signal(c, 'turn_started'), 'updated');
  assert.equal((await s.card(free)).stageId, 'doing');
});

// Gate 489 F1 (research/491) changed this contract: a damaged file is no longer left in place with the board held for good;
// the first look under the board's lock sets it aside (its bytes kept beside) and starts a new epoch in which no card is
// freed — the tracked card needs a check (unknown) and is shown so on its detail, instead of a board-wide hold.
test('D66 CE7 a damaged control file: the engine writes nothing; it is set aside (bytes kept) and the card needs a check; a person\'s move still saves', async t => {
  const s = await d66(t);
  const { agent: a, card } = await tracked(s);
  await fs.writeFile(s.controlPath, '{broken');
  assert.equal((await s.store.readAutoControl(s.id)).status, 'damaged');
  const revision = (await s.board()).revision;
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'held');
  assert.equal((await s.board()).revision, revision, 'no engine write');
  const kept = (await fs.readdir(join(s.store.dataDir, 'auto-control'))).filter(f => f.startsWith(s.id + '.json.damaged-'));
  assert.equal(kept.length, 1);
  assert.equal(await fs.readFile(join(s.store.dataDir, 'auto-control', kept[0]), 'utf8'), '{broken', 'the bytes are kept');
  assert.equal((await s.view(card.id)).mode, 'unknown', 'the hold is visible on the card');
  const moved = await s.person([{ op: 'move', id: card.id, to: 'done' }]);
  assert.equal(moved.committed, true);
  assert.equal((await s.view(card.id)).mode, 'paused');
  await noAutomaticStageChange(s, [a], card.id, 'CE7 damaged');
});

test('D66 CE8 the card\'s own agent moving it by CLI is a choice; a batch that ends where it began, a same-stage move and a replay are not', async t => {
  const s = await d66(t);
  const { agent: a, card } = await tracked(s);
  const start = await s.view(card.id);
  // move → move back in one batch, and a move to where it is: no stage change, no decision.
  await s.person([{ op: 'move', id: card.id, to: 'review' }, { op: 'move', id: card.id, to: 'doing' }]);
  await s.person([{ op: 'move', id: card.id, to: 'doing' }]);
  assert.deepEqual([(await s.view(card.id)).mode, (await s.view(card.id)).generation], ['managed', start.generation]);
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'updated');
  assert.equal((await s.view(card.id)).generation, start.generation, 'the engine\'s own move is no decision');
  // The same agent, by CLI: a choice.
  await s.cli(a.id, [{ op: 'move', id: card.id, to: 'todo' }]);
  assert.equal((await s.view(card.id)).mode, 'paused');
  assert.equal(await s.auto.signal(a, 'turn_started'), 'paused');
  assert.equal((await s.card(card.id)).stageId, 'todo');
  // A person's move sent twice with one request id counts once.
  await s.auto.resume(s.id, card.id);
  const resumed = (await s.view(card.id)).generation;
  const requestId = randomUUID();
  await s.person([{ op: 'move', id: card.id, to: 'done' }], { requestId });
  const replay = await s.person([{ op: 'move', id: card.id, to: 'done' }], { requestId });
  assert.equal(replay.data.replayed, true);
  assert.equal((await s.view(card.id)).generation, resumed + 1);
  // Nothing outside the engine's own entry point can claim an automatic move: an agent actor and a caller are not enough.
  for (const caller of [undefined, 'board', 'dispatcher', 'archiver']) {
    await s.auto.resume(s.id, card.id);
    await s.store.mutateBoard(s.id, { actor: { kind: 'agent', agentId: a.id }, requestId: randomUUID(),
      operations: [{ op: 'move', id: card.id, to: (await s.card(card.id)).stageId === 'review' ? 'doing' : 'review' }] }, caller);
    assert.equal((await s.view(card.id)).mode, 'paused', String(caller));
  }
});

test('D66 CE9 old manual placement with a link and no memory needs a check; a new placement then link is tracked; a done card\'s first link is not', async t => {
  const s = await d66(t);
  const orchestrator = randomUUID();
  // An old board: a card placed and linked by 0.2.4, no control file, nothing remembered (the 31 cards of 476).
  const old = s.agentOf();
  const oldCard = (await s.cli(orchestrator, [{ op: 'add', title: 'Old placement', intent: 'requested', acceptanceCriteria: 'x' }])).data.cardIds[0];
  await s.cli(orchestrator, [{ op: 'move', id: oldCard, to: 'review' }]);
  await s.cli(orchestrator, [{ op: 'link', id: oldCard, agentId: old.id, role: 'worker' }]);
  await fs.rm(join(s.store.dataDir, 'auto-control'), { recursive: true, force: true });
  await noAutomaticStageChange(s, [old], oldCard, 'CE9 old');
  assert.equal((await s.view(oldCard)).mode, 'unknown', 'needs a check (owner decision, 2026-10-18)');
  assert.equal((await s.entry(oldCard)).mode, 'unknown', 'kept in the control file as such');
  await s.auto.resume(s.id, oldCard);
  assert.equal(await s.auto.signal(old, 'turn_started'), 'updated', 'one card turned back on moves again');
  assert.equal((await s.card(oldCard)).stageId, 'doing');
  // New placement before a link: arranging is not a choice (REQ-61 ③).
  const fresh = s.agentOf();
  const placed = (await s.cli(orchestrator, [{ op: 'add', title: 'New placement', intent: 'requested', acceptanceCriteria: 'x' }])).data.cardIds[0];
  await s.cli(orchestrator, [{ op: 'move', id: placed, to: 'review' }]);
  assert.equal((await s.view(placed)).mode, 'unowned');
  await s.cli(orchestrator, [{ op: 'link', id: placed, agentId: fresh.id, role: 'worker' }]);
  assert.equal((await s.view(placed)).mode, 'managed');
  assert.equal(await s.auto.signal(fresh, 'turn_started'), 'updated');
  assert.equal((await s.card(placed)).stageId, 'doing');
  // A card already done when it is first linked stays done.
  const late = s.agentOf();
  const finished = (await s.person([{ op: 'add', title: 'Finished by hand', intent: 'requested', acceptanceCriteria: 'x' }])).data.cardIds[0];
  await s.person([{ op: 'move', id: finished, to: 'done' }]);
  await s.cli(orchestrator, [{ op: 'link', id: finished, agentId: late.id, role: 'verifier' }]);
  assert.equal((await s.view(finished)).mode, 'paused');
  await noAutomaticStageChange(s, [late], finished, 'CE9 done link');
  // Unlink everything and link again: the card keeps its mode (paused stays paused, managed stays managed).
  await s.cli(orchestrator, [{ op: 'unlink', id: finished, agentId: late.id }]);
  await s.cli(orchestrator, [{ op: 'link', id: finished, agentId: late.id }]);
  assert.equal((await s.view(finished)).mode, 'paused');
  await s.cli(orchestrator, [{ op: 'unlink', id: placed, agentId: fresh.id }]);
  await s.cli(orchestrator, [{ op: 'link', id: placed, agentId: fresh.id }]);
  assert.equal((await s.view(placed)).mode, 'managed');
  assert.equal(await s.auto.signal(fresh, 'turn_ended'), 'updated');
  assert.equal((await s.card(placed)).stageId, 'review');
});

test('D66 CE12 control group: creation, work, permission, review, a person\'s move, resume and work again all still happen', async t => {
  const s = await d66(t);
  const a = s.agentOf();
  assert.equal(await s.auto.signal(a, 'created'), 'created');
  const card = await s.cardOf(a.id);
  assert.deepEqual([card.stageId, (await s.entry(card.id)).mode, (await s.entry(card.id)).reason], ['todo', 'managed', 'created']);
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
  assert.equal(await s.auto.signal(a, 'permission_requested'), 'updated');
  assert.equal((await s.card(card.id)).awaiting, 'user');
  assert.equal(await s.auto.signal(a, 'permission_resolved'), 'updated');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'updated');
  assert.equal((await s.card(card.id)).stageId, 'review');
  await s.person([{ op: 'move', id: card.id, to: 'todo' }]);
  assert.equal(await s.auto.signal(a, 'turn_started'), 'paused');
  assert.equal((await s.card(card.id)).stageId, 'todo');
  assert.deepEqual(await s.auto.resume(s.id, card.id), { resumed: 1 });
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
  assert.equal((await s.card(card.id)).stageId, 'doing');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'updated');
  assert.equal((await s.card(card.id)).stageId, 'review');
  // Settled: 50 more wakes and signals write neither the ledger nor the control file.
  const revision = (await s.board()).revision, bytes = await fs.readFile(s.controlPath, 'utf8');
  for (let i = 0; i < 50; i++) {
    assert.equal(await s.auto.signal(a, 'turn_ended'), 'unchanged');
    if (i % 10 === 0) { const restarted = s.make(); restarted.wake(s.listing(a)); await restarted.idle(); }
  }
  assert.equal((await s.board()).revision, revision);
  assert.equal(await fs.readFile(s.controlPath, 'utf8'), bytes);
});

// Ported from wip/d66 (4a1fc07) tests/d65-auto-cards-cas.test.mjs: a link that failed after the add, then a person's done.
test('D66 CE1b the link after the engine\'s add fails, a person completes the card, a restarted engine links it: done stays', async t => {
  const s = await d66(t, sameTime);
  const a = s.agentOf();
  const failing = s.make(catching(s.store, async input => {
    if (input.operations[0].op === 'link') throw new Error('Link interrupted after add');
  }));
  assert.equal(await failing.signal(a, 'created'), 'failed');
  const id = (await s.board()).cards[0].id;
  assert.equal((await s.card(id)).agents.length, 0);
  await s.person([{ op: 'move', id, to: 'done' }]);
  const restarted = s.make();
  assert.equal(await restarted.signal(a, 'created'), 'created', 'the add replays from its receipt and the link lands');
  assert.equal(await restarted.signal(a, 'turn_ended'), 'paused');
  assert.equal((await s.card(id)).stageId, 'done');
  assert.equal((await s.board()).cards.length, 1);
  await noAutomaticStageChange(s, [a], id, 'CE1b');
  assert.equal((await s.view(id)).mode, 'paused');
});

// Gates 481/483 J1: the late memory write of an older judgement kept the bucket it had ("working"), so after the resume the
// same bucket's signal was taken as applied and the card stayed put. The bucket is now tied to the decision's generation.
test('D66 J1 after a resume, a late write of an older judgement does not swallow the next signal of the same bucket', async t => {
  const s = await d66(t);
  const { agent: a, card } = await tracked(s);
  await s.person([{ op: 'move', id: card.id, to: 'todo' }]);
  const b = createAutoCards({ store: await openStore({ dataDir: s.store.dataDir }), locale: readLocale, log: () => {} });
  const first = s.make(catching(await openStore({ dataDir: s.store.dataDir }), async input => {
    if (input.operations.some(o => o.op === 'update')) assert.deepEqual(await b.resume(s.id, card.id), { resumed: 1 });
  }));
  assert.equal(await first.signal(a, 'permission_requested'), 'updated');
  assert.equal((await readAutoState(s.store.dataDir)).agents[a.id].bucket, 'working', 'the late write kept the old bucket');
  assert.equal(await s.make().signal(a, 'turn_started'), 'updated', 'the same bucket places the card again');
  assert.equal((await s.card(card.id)).stageId, 'doing');
});
