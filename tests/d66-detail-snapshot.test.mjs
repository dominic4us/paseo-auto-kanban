import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadHandlers, createResumeHandler } from '../dist/server/handlers.js';
import { openStore } from '../dist/server/core/index.js';
import { autoCardsResume, cardGet } from '../dist/shared/rpc.js';
import { d66, noAutomaticStageChange } from './d66-control-helpers.mjs';

// D66 gate 495 F1 (research/491 「게이트 495 후속」): the detail returned the card it read first with the token of a decision
// read later — a completion made in between by another screen or a CLI was never shown, yet the "Resume" pressed on the
// older card freed it, and the next signal moved done → review. Now the card, its history and the token come from one read
// (the board the decision was judged with), and the token names the card as it was shown (its stage, entry time and last
// stage record): a resume of a card that is not like that any more is refused (E_AUTO_STALE).

const worker = fileURLToPath(new URL('./d66-detail-move-worker.mjs', import.meta.url));
/** A person's card at doing, paused by them (the start of research/495 detail-token-*). */
async function pausedAtDoing(t) {
  const s = await d66(t);
  const a = s.agentOf({ title: 'Detail snapshot worker' });
  assert.equal(await s.auto.signal(a, 'created'), 'created');
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
  const cardId = (await s.cardOf(a.id)).id;
  await s.person([{ op: 'move', id: cardId, to: 'review' }]);
  await s.person([{ op: 'move', id: cardId, to: 'doing' }]);
  const read = createReadHandlers(s.store), resume = createResumeHandler(s.auto);
  const detail = async () => { const reply = await read.card({ boardId: s.id, cardId }); assert.equal(reply.ok, true, JSON.stringify(reply)); return cardGet.output.parse(reply).data; };
  const press = async shown => autoCardsResume.output.parse(await resume({ boardId: s.id, cardId, ...shown.trackingToken, decisionId: randomUUID() }));
  return { s, a, cardId, detail, press };
}
/** Runs `during` once, the first time the detail asks for the card's decision (after it selected the board). */
function between(store, during) {
  const original = store.readAutoControl;
  let done = false;
  store.readAutoControl = async (...args) => { if (!done) { done = true; await during(); } return original.apply(store, args); };
  return () => { store.readAutoControl = original; };
}
const realProcess = (s, cardId, to = 'done') => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [worker, s.store.dataDir, s.id, cardId, to], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  child.on('close', code => code ? reject(new Error(err)) : resolve(JSON.parse(out))); child.on('error', reject);
});
/** The invariant: a resume pressed on a detail never frees a completion that detail did not show. */
async function holds(s, a, cardId, shown, answer) {
  if (shown.card.stageId !== 'done') assert.equal(answer.error?.code, 'E_AUTO_STALE', 'a resume from a card that never showed done is refused');
  await noAutomaticStageChange(s, [a], cardId, 'after the resume');
  assert.equal((await s.card(cardId)).stageId, 'done', 'the completion stands');
}

for (const [name, complete] of [
  ['the same process (another Store)', async (s, cardId) => (await (await openStore({ dataDir: s.store.dataDir })).mutateBoard(s.id,
    { actor: { kind: 'user' }, requestId: randomUUID(), operations: [{ op: 'move', id: cardId, to: 'done' }] })).committed],
  ['a real second process', async (s, cardId) => (await realProcess(s, cardId)).committed],
]) {
  test(`D66 495-F1 ${name} completes the card while the detail is being read: the detail and its token agree, the completion stands`, async t => {
    const { s, a, cardId, detail, press } = await pausedAtDoing(t);
    let committed;
    const restore = between(s.store, async () => { committed = await complete(s, cardId); });
    const shown = await detail();
    restore();
    assert.equal(committed, true, 'the completion was committed');
    // One read: the card shown is the card the token was judged with.
    const now = await s.store.readAutoControl(s.id);
    assert.equal(shown.card.stageId, now.board.cards.find(c => c.id === cardId).stageId, 'the detail shows the card its token belongs to');
    assert.equal(shown.revision, now.board.revision);
    assert.ok(shown.history.some(h => h.to === 'done'), 'with the completion in its history');
    assert.equal(shown.trackingToken.generation, now.cards[cardId].generation);
    const answer = await press(shown);
    // The person saw done and decided again: resuming that is theirs to make (done stays until a signal moves it — fine).
    if (answer.ok) { assert.equal(shown.card.stageId, 'done'); return; }
    await holds(s, a, cardId, shown, answer);
  });
}

test('D66 495-F1 control group: the detail answered, then a person completes, then the old screen resumes — refused, done stands', async t => {
  const { s, a, cardId, detail, press } = await pausedAtDoing(t);
  const shown = await detail();
  assert.equal(shown.card.stageId, 'doing');
  assert.equal((await realProcess(s, cardId)).committed, true);
  await holds(s, a, cardId, shown, await press(shown));
});

test('D66 495-F1 the token names the card as shown: same generation, another stage or entry time is refused (the card, not the board)', async t => {
  const { s, a, cardId, detail } = await pausedAtDoing(t);
  const shown = await detail();
  assert.equal(typeof shown.trackingToken.card, 'string');
  const expect = { controlEpoch: shown.trackingToken.controlEpoch, generation: shown.trackingToken.generation };
  // As if the decision file and the card were read at different moments: the right generation, an older card.
  const now = await s.store.readAutoControl(s.id);
  await assert.rejects(s.store.resumeAuto(s.id, cardId, { ...expect, card: shown.trackingToken.card.replace(/^doing/, 'todo'), decisionId: randomUUID() }),
    e => e.code === 'E_AUTO_STALE' && e.committed === false);
  assert.deepEqual(await s.store.readAutoControl(s.id).then(v => v.cards[cardId]), now.cards[cardId], 'nothing written');
  // Another card's edit changes the board's revision, not this card: the token stays good (476 F2).
  const other = (await s.person([{ op: 'add', title: 'Neighbour' }])).data.cardIds[0];
  await s.person([{ op: 'update', id: other, patch: { notes: 'busy' } }]);
  const ok = await s.store.resumeAuto(s.id, cardId, { ...expect, card: shown.trackingToken.card, decisionId: randomUUID() });
  assert.equal(ok.data.mode, 'managed');
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'updated');
});
