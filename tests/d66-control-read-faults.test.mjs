import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { d66, noAutomaticStageChange } from './d66-control-helpers.mjs';

// D66 gate 489 F1 (research/491): the decision file that cannot be READ. Fail closed as for a write (research/477 설계보완
// §9): while the file cannot be read for a passing reason (permissions, I/O — the file may well be fine), a change that
// could decide anything (any card's stage, a first link) is refused (E_AUTO_CONTROL, nothing written, the same request may
// be sent again) and the engine holds; a change that decides nothing (a note, a new card) still saves. Nothing is accepted
// that the file would have to learn later, so a read that works again needs no repair. A file whose bytes are damaged for
// good (not JSON, another board's, a wrong shape) is set aside — kept — and the board starts a new decision epoch from its
// cards (completed → paused, linked → needs a check), the first time anything takes the board's lock.

/** The gates' start: an automatic card a person completed and then explicitly turned back on (managed, in done). */
async function resumedAtDone(t, options = {}) {
  const s = await d66(t, options);
  const a = s.agentOf({ title: 'Read fault worker' });
  assert.equal(await s.auto.signal(a, 'created'), 'created');
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
  const cardId = (await s.cardOf(a.id)).id;
  await s.person([{ op: 'move', id: cardId, to: 'done' }]);
  await s.auto.resume(s.id, cardId);
  assert.equal((await s.view(cardId)).mode, 'managed');
  return { s, a, cardId };
}
const boardFile = s => join(s.store.dataDir, 'boards', s.id + '.json');
const readFaults = {
  /** research/489 independent-probe: the real file system — the decision file alone made unreadable (chmod 000). */
  async real(t, s) {
    if (process.getuid?.() === 0) t.skip('root reads any file');
    await fs.chmod(s.controlPath, 0o000);
    t.after(() => fs.chmod(s.controlPath, 0o600).catch(() => {}));
    return () => fs.chmod(s.controlPath, 0o600);
  },
  /** The Store's own read of the decision file failing (an I/O error of a network share, say). */
  async injected(t, s) {
    const read = s.store.fileBytes;
    s.store.fileBytes = async (file, ...rest) => {
      if (file === s.controlPath) { const e = new Error('Injected control EIO'); e.code = 'EIO'; throw e; }
      return read.call(s.store, file, ...rest);
    };
    return () => { s.store.fileBytes = read; };
  },
};
/** A change sent while the file cannot be read: what came back, and whether either file changed. */
async function attempt(s, operations) {
  const board = await fs.readFile(boardFile(s));
  const result = await s.person(operations).catch(error => error);
  return { result, ledgerSame: (await fs.readFile(boardFile(s))).equals(board) };
}
const isRefusal = r => r instanceof Error && r.code === 'E_AUTO_CONTROL' && r.committed === false && /again/i.test(r.nextAction);

// research/489 F1's two variants: an old card without an entry time, and a host clock that went back an hour — each with
// the card's own stage records pushed out of the ledger's last 1,000 by real moves of 100 other cards.
const VARIANTS = {
  'legacy-null-history-cap': { legacy: true },
  'clock-rollback-history-cap': { rollback: true },
};
for (const [kind, fault] of Object.entries(readFaults)) {
  for (const [name, options] of Object.entries(VARIANTS)) {
    test(`D66 489-F1 ${kind} read failure, ${name}: the stage a person last committed is never changed by the engine after the read works again`, async t => {
      let clock = Date.parse('2026-10-19T00:00:00.000Z');
      const advance = () => { clock += 1000; };
      const { s, a, cardId } = await resumedAtDone(t, { context: { newId: randomUUID, now: () => new Date(clock).toISOString() } });
      if (options.legacy) {
        await s.outsideWrite(raw => { delete raw.cards.find(c => c.id === cardId).stageEnteredAt; raw.history = []; }, false);
        await s.auto.resume(s.id, cardId);
        assert.equal((await s.view(cardId)).entered, null);
      }
      const siblings = (await s.person(Array.from({ length: 100 }, (_, i) => ({ op: 'add', title: 'sibling ' + i, intent: 'requested', acceptanceCriteria: 'x' })))).data.cardIds;
      if (options.rollback) clock -= 3_600_000;
      const controlBefore = await fs.readFile(s.controlPath);
      const repair = await fault(t, s);
      // The person's round trip while the file cannot be read: done → doing → done in separate commits.
      let chosen = null;
      const tries = [];
      for (const to of ['doing', 'done']) {
        advance();
        const sent = await attempt(s, [{ op: 'move', id: cardId, to }]);
        tries.push(sent);
        if (!(sent.result instanceof Error) && sent.result.data.changed) chosen = to;
      }
      assert.equal(await s.auto.signal(a, 'turn_ended'), 'held', 'the engine holds while the file cannot be read');
      // The cost: which cards are untracked is what the file would tell, so other cards' moves wait for it too.
      const sibling = await attempt(s, siblings.map(id => ({ op: 'move', id, to: 'doing' })));
      assert.ok(isRefusal(sibling.result) && sibling.ledgerSame, 'any stage change waits while the file cannot be read');
      await repair();
      // Buffers compared with equals(): a failing deepEqual of two files prints a diff too big to be useful.
      assert.ok((await fs.readFile(s.controlPath)).equals(controlBefore), 'the decision file was not written while unreadable');
      // Read again: the other cards move until this card's own records are gone from the ledger's last 1,000.
      for (let n = 0; n < 10; n++) { advance(); await s.person(siblings.map(id => ({ op: 'move', id, to: n % 2 ? 'todo' : 'doing' }))); }
      assert.equal((await s.board()).history.filter(h => h.cardId === cardId).length, 0, 'the card\'s own records are gone');
      // The invariant (research/470 §3): whatever the person last committed stands until an explicit resume.
      const engine = s.make();
      for (const signal of ['turn_started', 'turn_ended', 'turn_ended']) await engine.signal(a, signal);
      if (chosen !== null) assert.equal((await s.card(cardId)).stageId, chosen, 'the engine changed the stage a person chose while the file could not be read');
      // The contract: the round trip was refused move by move, with nothing written, and the file is as it was.
      assert.ok(isRefusal(tries[0].result), 'a move of a tracked card is refused while its decision cannot be read');
      assert.ok(tries.every(x => x.ledgerSame), 'the ledger was not written by a refused move');
      assert.equal(chosen, null);
      // The same round trip once the file reads again: committed, and paused by it for good.
      const stage = (await s.card(cardId)).stageId;
      for (const to of stage === 'done' ? ['doing', 'done'] : ['done']) { advance(); assert.equal((await s.person([{ op: 'move', id: cardId, to }])).committed, true); }
      for (let n = 0; n < 10; n++) { advance(); await s.person(siblings.map(id => ({ op: 'move', id, to: n % 2 ? 'todo' : 'doing' }))); }
      assert.equal((await s.entry(cardId)).mode, 'paused');
      await noAutomaticStageChange(s, [a], cardId, name);
    });
  }
}

test('D66 489-F1 while the file cannot be read: a first link is refused, a note and a new card still save, a resume is refused', async t => {
  const { s, cardId } = await resumedAtDone(t);
  const free = (await s.person([{ op: 'add', title: 'Free card', intent: 'requested', acceptanceCriteria: 'x' }])).data.cardIds[0];
  const repair = await readFaults.injected(t, s);
  const linked = await attempt(s, [{ op: 'link', id: free, agentId: randomUUID(), role: 'worker' }]);
  assert.ok(isRefusal(linked.result) && linked.ledgerSame, 'a first link decides: refused');
  const note = await s.person([{ op: 'update', id: cardId, patch: { notes: 'still writable' } }]);
  assert.equal(note.committed, true);
  assert.ok(note.warnings.some(w => w.code === 'W_AUTO_CONTROL'), 'the save says the decisions could not be read');
  assert.equal((await s.person([{ op: 'add', title: 'Another', intent: 'requested', acceptanceCriteria: 'x' }])).committed, true);
  await assert.rejects(s.auto.resume(s.id, cardId), e => e.code === 'E_AUTO_CONTROL' && /again/i.test(e.nextAction));
  const view = await s.store.readAutoControl(s.id);
  assert.equal(view.status, 'unreadable');
  await repair();
  assert.equal((await s.view(cardId)).mode, 'managed', 'nothing was decided meanwhile: the card follows its agent as before');
  assert.equal((await s.view(free)).mode, 'unowned');
});

test('D66 489-F1 control group: a read that fails and works again with only notes in between costs nothing — the card keeps following', async t => {
  const { s, a, cardId } = await resumedAtDone(t);
  const repair = await readFaults.injected(t, s);
  await s.person([{ op: 'update', id: cardId, patch: { notes: 'during' } }]);
  await repair();
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
  assert.equal((await s.card(cardId)).stageId, 'doing');
});

test('D66 489-F1 a newer schema is not ours to set aside: held and refused like a read failure, its bytes stay in place', async t => {
  const { s, a, cardId } = await resumedAtDone(t);
  const newer = JSON.stringify({ ...(await s.control()), schemaVersion: 2 }, null, 2) + '\n';
  await fs.writeFile(s.controlPath, newer);
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'held');
  assert.ok(isRefusal((await attempt(s, [{ op: 'move', id: cardId, to: 'doing' }])).result));
  assert.equal(await fs.readFile(s.controlPath, 'utf8'), newer);
  assert.equal((await s.store.readAutoControl(s.id)).status, 'unreadable');
});

const DAMAGES = {
  'not JSON': () => '{broken',
  'another board': control => JSON.stringify({ ...control, boardId: 'board_' + '0'.repeat(64) }),
  'a wrong shape': control => JSON.stringify({ ...control, cards: [] }),
};
for (const [name, damage] of Object.entries(DAMAGES)) {
  test(`D66 489-F1 damaged for good (${name}): set aside and kept, a new epoch from the cards, nothing freed — a person's move decides as usual`, async t => {
    const { s, a, cardId } = await resumedAtDone(t);
    const b = s.agentOf({ title: 'Second worker' });
    assert.equal(await s.auto.signal(b, 'created'), 'created');
    const other = (await s.cardOf(b.id)).id;
    const before = await s.control();
    const bytes = damage(before);
    await fs.writeFile(s.controlPath, bytes);
    assert.equal((await s.store.readAutoControl(s.id)).status, 'damaged');
    const moved = await s.person([{ op: 'move', id: cardId, to: 'doing' }]);
    assert.equal(moved.committed, true);
    assert.ok(moved.warnings.some(w => w.code === 'W_AUTO_CONTROL' && /set aside/i.test(w.message)), 'the save says the file was set aside');
    const kept = (await fs.readdir(join(s.store.dataDir, 'auto-control'))).filter(f => f.startsWith(s.id + '.json.damaged-'));
    assert.equal(kept.length, 1, 'the damaged bytes are kept beside');
    assert.equal(await fs.readFile(join(s.store.dataDir, 'auto-control', kept[0]), 'utf8'), bytes);
    const now = await s.control();
    assert.notEqual(now.controlEpoch, before.controlEpoch, 'a new decision epoch');
    assert.equal(now.cards[cardId].mode, 'paused', 'the person\'s move decides as on any board');
    assert.equal(now.cards[other].mode, 'unknown', 'a card that was tracked needs a check: the old file\'s "managed" is not trusted');
    await noAutomaticStageChange(s, [a, b], cardId, 'rebased');
    assert.equal(await s.auto.signal(b, 'turn_ended'), 'held');
    // A token from before the new epoch cannot resume; a card resumed now follows its agent again.
    await assert.rejects(s.store.resumeAuto(s.id, other, { controlEpoch: before.controlEpoch, generation: before.cards[other].generation, decisionId: randomUUID() }),
      e => e.code === 'E_AUTO_STALE');
    await s.auto.resume(s.id, other);
    assert.equal(await s.auto.signal(b, 'turn_started'), 'updated');
  });
}

test('D66 489-F1 a damaged file is set aside on the engine\'s first look too (it settles under the lock), and never reached again', async t => {
  const { s, a, cardId } = await resumedAtDone(t);
  await fs.writeFile(s.controlPath, '{broken');
  assert.notEqual(await s.auto.signal(a, 'turn_ended'), 'updated');
  assert.equal((await s.store.readAutoControl(s.id)).status, 'ok', 'the board has a decision file of its own again');
  assert.equal((await s.view(cardId)).mode, 'paused', 'a completed card stays protected');
  assert.equal((await s.card(cardId)).stageId, 'done');
  await noAutomaticStageChange(s, [a], cardId, 'rebased by the engine');
});

test('D66 489-F1 a damaged file that cannot be set aside is held like an unreadable one: decisions refused, the bytes stay', async t => {
  const { s, a, cardId } = await resumedAtDone(t);
  await fs.writeFile(s.controlPath, '{broken');
  const store = s.store, setAside = store.setAsideControl;
  store.setAsideControl = async () => { const e = new Error('Injected rename EBUSY'); e.code = 'EBUSY'; throw e; };
  t.after(() => { store.setAsideControl = setAside; });
  assert.equal(await s.auto.signal(a, 'turn_ended'), 'held');
  assert.ok(isRefusal((await attempt(s, [{ op: 'move', id: cardId, to: 'doing' }])).result));
  assert.equal(await fs.readFile(s.controlPath, 'utf8'), '{broken');
  store.setAsideControl = setAside;
  assert.equal((await s.person([{ op: 'move', id: cardId, to: 'doing' }])).committed, true);
  assert.equal((await s.view(cardId)).mode, 'paused');
});
