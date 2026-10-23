import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { d66, noAutomaticStageChange } from './d66-control-helpers.mjs';

// D66 gates 481 F1 and 483 F1/F2: a person's decision is never left to be inferred from the bounded history or the ledger's
// clock. Fail closed (research/477 설계보완 §8): a commit that changes a tracked card's decision saves the decision file
// FIRST; when that save fails, the ledger is not written and the move is refused (E_AUTO_CONTROL, nothing changed, the
// same request can be sent again). So "a person moved the card while the decision could not be saved" never exists.
// Two ways to fail the save: the real file system (the folder made read-only, EACCES) and the Store's own write refusing.

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));

/** The gates' start: an automatic card a person completed and then explicitly turned back on (managed, in done). */
async function resumedAtDone(t, options = {}) {
  const s = await d66(t, options);
  const a = s.agentOf({ title: 'Fault worker' });
  assert.equal(await s.auto.signal(a, 'created'), 'created');
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
  const cardId = (await s.cardOf(a.id)).id;
  await s.person([{ op: 'move', id: cardId, to: 'done' }]);
  await s.auto.resume(s.id, cardId);
  assert.equal((await s.view(cardId)).mode, 'managed');
  return { s, a, cardId };
}
const folder = s => join(s.store.dataDir, 'auto-control');
const boardFile = s => join(s.store.dataDir, 'boards', s.id + '.json');
const faults = {
  /** The real file system: the control folder read-only for this (non-root) process. */
  async real(t, s) {
    if (process.getuid?.() === 0) t.skip('root ignores folder permissions');
    await fs.chmod(folder(s), 0o555);
    t.after(() => fs.chmod(folder(s), 0o755).catch(() => {}));
    return () => fs.chmod(folder(s), 0o755);
  },
  /** The Store's own write of the control file refusing (any cause: EACCES, ENOSPC, a held file). */
  async injected(t, s) {
    const write = s.store.atomicWrite;
    s.store.atomicWrite = async (target, ...rest) => {
      if (target.startsWith(folder(s))) { const e = new Error('Injected control EACCES'); e.code = 'EACCES'; throw e; }
      return write.call(s.store, target, ...rest);
    };
    return () => { s.store.atomicWrite = write; };
  },
};
/**
 * A person's move while the decision cannot be saved: refused with nothing written (the ledger's and the decision file's
 * bytes stay the same). A move to where the card already is (it stayed there: the moves before were refused) is no change.
 */
async function refused(s, cardId, to, extra = {}) {
  const board = await fs.readFile(boardFile(s)), control = await fs.readFile(join(folder(s), s.id + '.json'));
  if ((await s.card(cardId)).stageId === to) assert.equal((await s.person([{ op: 'move', id: cardId, to }], extra)).data.changed, false);
  else await assert.rejects(s.person([{ op: 'move', id: cardId, to }], extra), e => e.code === 'E_AUTO_CONTROL' && e.committed === false && /again/i.test(e.nextAction));
  assert.deepEqual(await fs.readFile(boardFile(s)), board, 'the ledger is not written');
  assert.deepEqual(await fs.readFile(join(folder(s), s.id + '.json')), control, 'nor the decision file');
}
const ROUNDS = {
  'done→doing→done': ['doing', 'done'],
  'done→review→done': ['review', 'done'],
  'three round trips': ['doing', 'done', 'review', 'done', 'todo', 'done'],
};

for (const [kind, fault] of Object.entries(faults)) {
  for (const [name, moves] of Object.entries(ROUNDS)) {
    test(`D66 481/483 ${kind} save failure: ${name} is refused move by move, nothing changes; after the repair the same moves keep done`, async t => {
      const { s, a, cardId } = await resumedAtDone(t);
      const repair = await fault(t, s);
      for (const to of moves) await refused(s, cardId, to);
      assert.equal((await s.card(cardId)).stageId, 'done');
      await noAutomaticStageChange(s, [a], cardId, kind + ' during');
      await repair();
      // The same moves sent again once the file can be saved: they commit, and the card is paused by them.
      for (const to of moves) assert.equal((await s.person([{ op: 'move', id: cardId, to }])).committed, true);
      assert.equal((await s.entry(cardId)).mode, 'paused');
      await noAutomaticStageChange(s, [a], cardId, kind + ' after repair');
      await s.auto.resume(s.id, cardId);
      assert.equal(await s.auto.signal(a, 'turn_started'), 'updated', 'an explicit resume gives the moves back');
      assert.equal((await s.card(cardId)).stageId, 'doing');
    });
  }
}

test('D66 483 a refused move is the same request again after the repair: one commit, one pause', async t => {
  const { s, cardId } = await resumedAtDone(t);
  const repair = await faults.injected(t, s);
  const requestId = randomUUID();
  await refused(s, cardId, 'review', { requestId });
  await repair();
  const first = await s.person([{ op: 'move', id: cardId, to: 'review' }], { requestId });
  assert.deepEqual([first.committed, first.data.replayed], [true, false]);
  const again = await s.person([{ op: 'move', id: cardId, to: 'review' }], { requestId });
  assert.equal(again.data.replayed, true);
  assert.equal((await s.entry(cardId)).mode, 'paused');
});

test('D66 483 the decision saved but the ledger write failed: the card is paused where it was, nothing completed is lost', async t => {
  const { s, a, cardId } = await resumedAtDone(t);
  const write = s.store.atomicWrite, target = boardFile(s);
  s.store.atomicWrite = async (file, ...rest) => {
    if (file === target) { const e = new Error('Injected ledger ENOSPC'); e.code = 'ENOSPC'; throw e; }
    return write.call(s.store, file, ...rest);
  };
  await assert.rejects(s.person([{ op: 'move', id: cardId, to: 'doing' }]), e => e.code === 'E_IO');
  s.store.atomicWrite = write;
  assert.equal((await s.card(cardId)).stageId, 'done', 'the ledger kept done');
  assert.equal((await s.view(cardId)).mode, 'paused', 'held — the cost: tracking stops though the move did not land');
  await noAutomaticStageChange(s, [a], cardId, 'ledger failure');
  await s.auto.resume(s.id, cardId);
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
});

// research/483 extended-probe: an old card without `stageEnteredAt`, a clock that goes back, a clock that stands still —
// each with the card's own stage records pushed out of the ledger's last 1,000 by real moves of 100 other cards.
const SCENARIOS = {
  'legacy-null-history-cap': { legacy: true },
  'clock-rollback-history-cap': { rollback: true },
  'equal-clock-history-cap': { sameClock: true },
};
for (const [name, options] of Object.entries(SCENARIOS)) {
  test(`D66 483 ${name}: the round trip during the failure is refused, so 1,000 later records leave nothing to misread`, async t => {
    let clock = Date.parse('2026-10-19T00:00:00.000Z');
    const advance = () => { if (!options.sameClock) clock += 1000; };
    const now = () => new Date(clock).toISOString();
    const { s, a, cardId } = await resumedAtDone(t, { context: { newId: randomUUID, now } });
    if (options.legacy) {
      // An old card: no entry time and no records of its own (both readers 0.2.3 and 0.2.4 accept such a ledger); resumed.
      await s.outsideWrite(raw => { delete raw.cards.find(c => c.id === cardId).stageEnteredAt; raw.history = []; }, false);
      await s.auto.resume(s.id, cardId);
      assert.equal((await s.view(cardId)).entered, null);
    }
    const siblings = (await s.person(Array.from({ length: 100 }, (_, i) => ({ op: 'add', title: 'sibling ' + i, intent: 'requested', acceptanceCriteria: 'x' })))).data.cardIds;
    if (options.rollback) clock -= 3_600_000;
    const repair = await faults.real(t, s);
    const pushOut = async () => {
      for (let n = 0; n < 10; n++) { advance(); await s.person(siblings.map(id => ({ op: 'move', id, to: n % 2 ? 'todo' : 'doing' }))); }
      assert.equal((await s.board()).history.filter(h => h.cardId === cardId).length, 0, 'the card\'s own records are gone');
    };
    advance(); await refused(s, cardId, 'doing');
    advance(); await refused(s, cardId, 'done');
    await pushOut();
    await repair();
    // The refused moves left nothing: the card is as the person last decided — resumed, in done.
    assert.deepEqual([(await s.card(cardId)).stageId, (await s.view(cardId)).mode], ['done', 'managed']);
    // The same round trip once the file can be saved: committed, recorded, and no later records or clock can undo it.
    advance(); await s.person([{ op: 'move', id: cardId, to: 'doing' }]);
    advance(); await s.person([{ op: 'move', id: cardId, to: 'done' }]);
    await pushOut();
    assert.equal((await s.entry(cardId)).mode, 'paused');
    await noAutomaticStageChange(s, [a], cardId, name);
  });
}

test('D66 483 a real `kanban card move` in the agent\'s session is refused too while the decision cannot be saved', async t => {
  const { s, a, cardId } = await resumedAtDone(t);
  const repair = await faults.real(t, s);
  const run = to => exec(process.execPath, [cli, 'card', 'move', cardId, '--to', to, '--workspace', s.cwd, '--data-dir', s.store.dataDir, '--json'],
    { cwd: s.cwd, env: { ...process.env, PASEO_AGENT_ID: a.id, PASEO_AGENT_CWD: s.cwd } });
  const before = await fs.readFile(boardFile(s));
  const failed = await run('doing').then(() => null, error => error);
  assert.ok(failed, 'the CLI exits with an error');
  assert.match(failed.stdout + failed.stderr, /E_AUTO_CONTROL/);
  assert.deepEqual(await fs.readFile(boardFile(s)), before);
  await repair();
  assert.equal(JSON.parse((await run('doing')).stdout).committed, true, 'and succeeds once the file can be saved');
  assert.equal((await s.entry(cardId)).mode, 'paused');
});

test('D66 483 a save that worked, then one that failed: the first move paused the card, the second is refused', async t => {
  const { s, a, cardId } = await resumedAtDone(t);
  await s.person([{ op: 'move', id: cardId, to: 'doing' }]);
  const repair = await faults.real(t, s);
  await refused(s, cardId, 'done');
  await repair();
  assert.equal((await s.view(cardId)).mode, 'paused');
  await noAutomaticStageChange(s, [a], cardId, 'success then failure');
});

test('D66 481-F1 an engine move whose decision cannot be saved is not committed; the card keeps moving after the repair', async t => {
  const s = await d66(t);
  const a = s.agentOf();
  await s.auto.signal(a, 'created');
  const cardId = (await s.cardOf(a.id)).id;
  const repair = await faults.injected(t, s);
  assert.equal(await s.auto.signal(a, 'turn_started'), 'failed');
  assert.equal((await s.card(cardId)).stageId, 'todo', 'no automatic move without its record');
  await repair();
  assert.equal(await s.auto.signal(a, 'turn_started'), 'updated');
  assert.equal((await s.card(cardId)).stageId, 'doing');
  assert.equal((await s.view(cardId)).mode, 'managed');
});

test('D66 481/483 control group: with saves working, a card nobody moved keeps following its agent through many commits', async t => {
  const s = await d66(t);
  const a = s.agentOf(), b = s.agentOf();
  await s.auto.signal(a, 'created'); await s.auto.signal(b, 'created');
  const mine = (await s.cardOf(a.id)).id, other = (await s.cardOf(b.id)).id;
  for (let round = 0; round < 6; round++) {
    // A person keeps moving the other card and editing this one; this card is never moved by a person.
    await s.person([{ op: 'move', id: other, to: round % 2 ? 'todo' : 'review' }]);
    await s.person([{ op: 'update', id: mine, patch: { notes: 'note ' + round } }]);
    assert.equal(await s.auto.signal(a, round % 2 ? 'turn_ended' : 'turn_started'), 'updated', 'round ' + round);
    assert.equal((await s.card(mine)).stageId, round % 2 ? 'review' : 'doing');
    assert.equal((await s.view(mine)).mode, 'managed');
  }
});

test('D66 483 an untracked card still moves while the decision file cannot be saved (nothing to decide)', async t => {
  const s = await d66(t);
  const free = (await s.person([{ op: 'add', title: 'Arranged', intent: 'requested', acceptanceCriteria: 'x' }])).data.cardIds[0];
  await faults.injected(t, s);
  assert.equal((await s.person([{ op: 'move', id: free, to: 'review' }])).committed, true);
  assert.equal((await s.card(free)).stageId, 'review');
});
