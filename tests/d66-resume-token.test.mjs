import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadHandlers, createResumeHandler } from '../dist/server/handlers.js';
import { autoCardsResume, cardGet } from '../dist/shared/rpc.js';
import { d66 } from './d66-control-helpers.mjs';

// D66 G2 (research/491): `kanban.v1.auto_cards.resume` by the token the detail showed — controlEpoch + generation (476 F2:
// not the board's revision) and the resume's own decisionId. A request without it is an older screen's: refused. A token
// is shown only after what the decision file does not hold yet was saved under the board's lock (gate 481).

async function setup(t) {
  const s = await d66(t);
  const read = createReadHandlers(s.store), resume = createResumeHandler(s.auto);
  const detail = async cardId => { const reply = await read.card({ boardId: s.id, cardId });
    assert.equal(reply.ok, true, JSON.stringify(reply)); return cardGet.output.parse(reply).data; };
  /** The RPC as the client sends it, its answer checked against the RPC's own output schema. */
  const rpc = async input => autoCardsResume.output.parse(await resume(input));
  const a = s.agentOf({ title: 'Token worker' });
  assert.equal(await s.auto.signal(a, 'created'), 'created');
  const cardId = (await s.cardOf(a.id)).id;
  await s.person([{ op: 'move', id: cardId, to: 'done' }]);
  return { ...s, a, cardId, detail, rpc };
}
const byToken = (s, token, decisionId = randomUUID()) => ({ boardId: s.id, cardId: s.cardId, ...token, decisionId });

test('D66 G2 a resume without the token (an older screen) is refused and changes nothing; with it, it commits', async t => {
  const s = await setup(t);
  const control = await fs.readFile(s.controlPath);
  const old = await s.rpc({ boardId: s.id, cardId: s.cardId });
  assert.deepEqual([old.ok, old.error?.code, old.committed], [false, 'E_AUTO_STALE', false]);
  assert.match(old.error.nextAction, /reload the card/i);
  for (const partial of [{ controlEpoch: 'x' }, { controlEpoch: 'x', generation: 1 }, { generation: 1, decisionId: 'y' }])
    assert.equal((await s.rpc({ boardId: s.id, cardId: s.cardId, ...partial })).error?.code, 'E_AUTO_STALE', JSON.stringify(partial));
  assert.ok((await fs.readFile(s.controlPath)).equals(control), 'nothing written');
  assert.equal((await s.view(s.cardId)).mode, 'paused');
  const { trackingToken } = await s.detail(s.cardId);
  assert.ok(trackingToken, 'a paused card shows its token');
  const done = await s.rpc(byToken(s, { controlEpoch: trackingToken.controlEpoch, generation: trackingToken.generation, card: trackingToken.card }));
  assert.equal(done.ok, true);
  assert.deepEqual([done.data.committed, done.data.replayed, done.data.mode], [true, false, 'managed']);
  assert.equal(done.data.token.generation, trackingToken.generation + 1);
  assert.equal((await s.detail(s.cardId)).trackingToken, undefined, 'on again: nothing to resume');
});

test('D66 G2 a token of another epoch or an older generation is refused; another card\'s edit does not refuse it (476 F2)', async t => {
  const s = await setup(t);
  const { trackingToken: token } = await s.detail(s.cardId);
  const other = (await s.person([{ op: 'add', title: 'Busy neighbour' }])).data.cardIds[0];
  assert.equal((await s.rpc(byToken(s, { controlEpoch: randomUUID(), generation: token.generation, card: token.card }))).error?.code, 'E_AUTO_STALE');
  assert.equal((await s.rpc(byToken(s, { controlEpoch: token.controlEpoch, generation: token.generation - 1, card: token.card }))).error?.code, 'E_AUTO_STALE');
  await s.person([{ op: 'update', id: other, patch: { notes: 'the board revision moves' } }]);
  const fine = await s.rpc(byToken(s, { controlEpoch: token.controlEpoch, generation: token.generation, card: token.card }));
  assert.equal(fine.data?.committed, true);
});

test('D66 G2 the same decisionId again is a replay (committed once); after a later person move the same request is stale', async t => {
  const s = await setup(t);
  const { trackingToken: token } = await s.detail(s.cardId);
  const request = byToken(s, { controlEpoch: token.controlEpoch, generation: token.generation, card: token.card });
  const first = await s.rpc(request), again = await s.rpc(request);
  assert.deepEqual([first.data.committed, first.data.replayed], [true, false]);
  assert.deepEqual([again.data.committed, again.data.replayed, again.data.token.generation], [false, true, first.data.token.generation]);
  // The person moves the card again: the old press, sent once more, must not undo that.
  await s.person([{ op: 'move', id: s.cardId, to: 'review' }]);
  assert.equal((await s.rpc(request)).error?.code, 'E_AUTO_STALE');
  assert.equal((await s.view(s.cardId)).mode, 'paused');
  assert.equal(await s.auto.signal(s.a, 'turn_started'), 'paused');
  assert.equal((await s.card(s.cardId)).stageId, 'review');
});

test('D66 G2 a board from before the decision file: the detail settles it under the lock BEFORE it shows a token, so that token works', async t => {
  const s = await setup(t);
  // The file gone (a board from before it): the unlocked read judges it in a temporary epoch, which a resume would refuse.
  await fs.rm(s.controlPath);
  const unsettled = await s.store.readAutoControl(s.id);
  assert.equal(unsettled.settled, false);
  await assert.rejects(s.store.resumeAuto(s.id, s.cardId, { controlEpoch: unsettled.controlEpoch, generation: unsettled.cards[s.cardId].generation, decisionId: randomUUID() }),
    e => e.code === 'E_AUTO_STALE', 'a token from before the settle is stale');
  const shown = await s.detail(s.cardId);
  assert.deepEqual([shown.tracking.state, shown.tracking.held], ['paused', undefined], 'a completed card: paused (legacy-done), not "needs a check"');
  assert.equal((await s.store.readAutoControl(s.id)).settled, true, 'the detail saved the judgement first');
  assert.equal((await s.control()).controlEpoch, shown.trackingToken.controlEpoch);
  const done = await s.rpc(byToken(s, { controlEpoch: shown.trackingToken.controlEpoch, generation: shown.trackingToken.generation, card: shown.trackingToken.card }));
  assert.equal(done.data?.committed, true);
});

test('D66 G2 an old linked card nobody remembers reads "needs a check" with its token, and resumes card by card', async t => {
  const s = await setup(t);
  const b = s.agentOf({ title: 'Old worker' });
  const old = (await s.person([{ op: 'add', title: 'Old linked card', intent: 'requested', acceptanceCriteria: 'x' }])).data.cardIds[0];
  await s.person([{ op: 'move', id: old, to: 'doing' }]);
  // An old writer linked it without the decision file knowing (a board from 0.2.4): it needs a check.
  await s.outsideWrite(raw => { raw.cards.find(c => c.id === old).agents.push({ agentId: b.id, role: 'worker', label: '', linkedAt: raw.updatedAt }); });
  const shown = await s.detail(old);
  assert.deepEqual([shown.tracking.state, shown.tracking.held], ['paused', 'check']);
  assert.ok(shown.trackingToken);
  // The other card is untouched by this card's resume.
  const before = await s.view(s.cardId);
  const done = await s.rpc({ boardId: s.id, cardId: old, controlEpoch: shown.trackingToken.controlEpoch, generation: shown.trackingToken.generation, card: shown.trackingToken.card, decisionId: randomUUID() });
  assert.equal(done.data?.mode, 'managed');
  assert.deepEqual(await s.view(s.cardId), before, 'one card at a time');
  assert.equal(await s.auto.signal(b, 'turn_ended'), 'updated');
  assert.equal((await s.card(old)).stageId, 'review');
});

test('D66 G2 the decision file unreadable: the detail says so with no token; the resume is refused for the storage', async t => {
  const s = await setup(t);
  const { trackingToken: token } = await s.detail(s.cardId);
  const read = s.store.fileBytes;
  s.store.fileBytes = async (file, ...rest) => {
    if (file === s.controlPath) { const e = new Error('Injected control EACCES'); e.code = 'EACCES'; throw e; }
    return read.call(s.store, file, ...rest);
  };
  const shown = await s.detail(s.cardId);
  assert.deepEqual([shown.tracking.state, shown.tracking.held, shown.trackingToken], ['paused', 'unreadable', undefined]);
  const refused = await s.rpc(byToken(s, { controlEpoch: token.controlEpoch, generation: token.generation, card: token.card }));
  assert.deepEqual([refused.ok, refused.error?.code], [false, 'E_AUTO_CONTROL']);
  assert.match(refused.error.nextAction, /free space and permissions/);
  s.store.fileBytes = read;
  assert.equal((await s.rpc(byToken(s, { controlEpoch: token.controlEpoch, generation: token.generation, card: token.card }))).data?.committed, true);
});
