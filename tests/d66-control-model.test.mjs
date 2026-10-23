import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { add } from './helpers.mjs';
import { d66 } from './d66-control-helpers.mjs';
import { createReadHandlers, createResumeHandler } from '../dist/server/handlers.js';
import { previousRelease } from './previous-release.mjs';

// D66 G1 (research/477 §2): a small reference model of one card — mode / generation / stage / links / archive — run
// against the real Store and engine with fixed seeds. The model is written from the transition table, not from the
// product's code: it knows nothing of history records, receipts or the engine's memory file except the documented
// "an agent writes only when its bucket changes" contract (REQ-61). Every step compares the card's stage and archive,
// and the Store's judgement of the card (mode, generation) with the model.
const STAGES = ['todo', 'doing', 'review', 'done'];
const DONE = new Set(['done']);
const stageFor = bucket => ({ waiting: 'todo', working: 'doing', review: 'review' })[bucket];
const SIGNALS = { turn_started: 'working', turn_ended: 'review', archived: 'review' };

function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class Model {
  constructor(start) { Object.assign(this, { stage: 'todo', archived: false, links: new Set(), mode: 'unowned', gen: 0, confirmed: 'todo',
    remembered: new Map(), ...start }); }
  /** What the Store finds on its next look: a stage it did not confirm needs a check, unless the card was never tracked. */
  settle() {
    if (this.stage === this.confirmed) return;
    // A card nobody tracked stays free; a paused one stays paused (held already); any other needs a check.
    if (this.mode !== 'unowned') { if (this.mode !== 'paused') this.mode = 'unknown'; this.gen++; }
    this.confirmed = this.stage;
  }
  projected() { const m = new Model(this); m.links = new Set(this.links); m.remembered = new Map(this.remembered); m.settle(); return m; }
  outsideMove(to) { this.stage = to; }
  move(to) {
    this.settle();
    if (to === this.stage) return;
    this.stage = this.confirmed = to;
    if (this.mode !== 'unowned') { this.mode = 'paused'; this.gen++; }
  }
  edit() { this.settle(); }
  link(agent) {
    this.settle();
    this.links.add(agent);
    if (this.mode === 'unowned') { this.mode = DONE.has(this.stage) ? 'paused' : 'managed'; this.gen++; }
  }
  unlink(agent) { this.settle(); this.links.delete(agent); }
  archive(on) { this.settle(); this.archived = on; }
  resume() { this.settle(); this.mode = 'managed'; this.gen++; this.confirmed = this.stage; for (const key of this.remembered.keys()) this.remembered.set(key, null); }
  signal(agent, bucket) {
    if (!this.links.has(agent) || this.archived) return;
    this.settle();
    if (this.mode === 'unknown' || this.mode === 'unowned') return;
    if (!this.remembered.has(agent)) this.remembered.set(agent, null);
    if (this.mode === 'paused' || this.remembered.get(agent) === bucket) return;
    this.remembered.set(agent, bucket);
    this.stage = this.confirmed = stageFor(bucket);
  }
}

async function run(t, seed, steps) {
  const random = prng(seed), pick = list => list[Math.floor(random() * list.length)];
  const s = await d66(t);
  const a = s.agentOf({ title: 'Model worker' }), b = s.agentOf({ title: 'Model verifier' }), orchestrator = randomUUID();
  const agents = { A: a, B: b };
  let cardId, model, auto = s.auto;
  if (seed % 3 === 0) {
    // A person's card, arranged before anybody is linked (REQ-61 ③).
    cardId = (await s.person([add('Model card')])).data.cardIds[0];
    model = new Model({});
  } else {
    assert.equal(await auto.signal(a, 'created'), 'created');
    cardId = (await s.cardOf(a.id)).id;
    model = new Model({ mode: 'managed', gen: 1, links: new Set(['A']), remembered: new Map([['A', 'waiting']]) });
  }
  const log = [];
  let lastOutside = false;
  for (let step = 0; step < steps; step++) {
    const options = [];
    if (!model.archived) options.push('move', 'cli', 'edit', 'archive', 'link', 'unlink');
    else options.push('restore');
    options.push('signal', 'signal', 'signal', 'resume', 'restart');
    if (!model.archived && !lastOutside) options.push('outside');
    const kind = pick(options);
    lastOutside = kind === 'outside';
    const to = pick(STAGES), who = pick(['A', 'B']), signal = pick(Object.keys(SIGNALS));
    log.push([kind, kind === 'signal' ? who + ':' + signal : ['link', 'unlink'].includes(kind) ? who : ['move', 'cli', 'outside'].includes(kind) ? to : '']);
    switch (kind) {
      case 'move': await s.person([{ op: 'move', id: cardId, to }]); model.move(to); break;
      case 'cli': await s.cli(a.id, [{ op: 'move', id: cardId, to }]); model.move(to); break;
      case 'edit': await s.person([{ op: 'update', id: cardId, patch: { title: 'Edited ' + step } }]); model.edit(); break;
      case 'archive': await s.person([{ op: 'archive', id: cardId }]); model.archive(true); break;
      case 'restore': await s.person([{ op: 'restore', id: cardId }]); model.archive(false); break;
      case 'link':
        if (model.links.has(who)) { log.at(-1).push('skip'); break; }
        await s.cli(orchestrator, [{ op: 'link', id: cardId, agentId: agents[who].id, role: who === 'A' ? 'worker' : 'verifier' }]);
        model.link(who); break;
      case 'unlink':
        if (!model.links.has(who)) { log.at(-1).push('skip'); break; }
        await s.cli(orchestrator, [{ op: 'unlink', id: cardId, agentId: agents[who].id }]); model.unlink(who); break;
      case 'signal': await auto.signal(agents[who], signal); model.signal(who, SIGNALS[signal]); break;
      case 'resume': await auto.resume(s.id, cardId); model.resume(); break;
      case 'restart': auto = s.make(); break;
      case 'outside': await s.outsideWrite(raw => { raw.cards.find(c => c.id === cardId).stageId = to; }); model.outsideMove(to); break;
    }
    const where = `seed ${seed} step ${step}: ${JSON.stringify(log)}`;
    const card = await s.card(cardId), judged = await s.view(cardId), expected = model.projected();
    assert.equal(card.stageId, expected.stage, 'stage — ' + where);
    assert.equal(card.archivedAt !== null, expected.archived, 'archive — ' + where);
    assert.equal(judged.mode, expected.mode, 'mode — ' + where);
    assert.equal(judged.generation, expected.gen, 'generation — ' + where);
  }
}

for (let seed = 1; seed <= 24; seed++) {
  test(`D66 reference model, seed ${seed}: stage, archive, mode and generation follow the transition table`, async t => run(t, seed, 30));
}

// D66 gate 481 F1: the same events with the control file's saves failing at random spells. The model does not predict
// modes here; it holds the invariant instead — a card whose stage changed in a commit whose decision could not be saved is
// never moved by the engine again until a resume succeeds — and, once the saves work again, a resume frees it.
async function runFaults(t, seed, steps) {
  const random = prng(seed * 7919), pick = list => list[Math.floor(random() * list.length)];
  const s = await d66(t);
  const a = s.agentOf({ title: 'Fault model worker' }), orchestrator = randomUUID();
  assert.equal(await s.auto.signal(a, 'created'), 'created');
  const cardId = (await s.cardOf(a.id)).id;
  const control = join(s.store.dataDir, 'auto-control'), write = s.store.atomicWrite;
  let failing = false, tainted = false, archived = false, linked = true, auto = s.auto;
  s.store.atomicWrite = async (target, ...rest) => {
    if (failing && target.startsWith(control)) { const e = new Error('Injected control EACCES'); e.code = 'EACCES'; throw e; }
    return write.call(s.store, target, ...rest);
  };
  const log = [];
  const stageNow = async () => (await s.card(cardId)).stageId;
  for (let step = 0; step < steps; step++) {
    const kind = pick(['fault', 'move', 'move', 'cli', 'edit', 'signal', 'signal', 'signal', 'resume', 'restart', 'archive', 'link']);
    const to = pick(STAGES), signal = pick(Object.keys(SIGNALS));
    log.push([kind, kind === 'signal' ? signal : to, failing]);
    const before = await stageNow();
    switch (kind) {
      case 'fault': failing = !failing; break;
      // Gate 483: a move whose decision cannot be saved is refused (E_AUTO_CONTROL) and commits nothing.
      case 'move': if (!archived) await s.person([{ op: 'move', id: cardId, to }]).catch(e => assert.equal(e.code, 'E_AUTO_CONTROL')); break;
      case 'cli': if (!archived) await s.cli(a.id, [{ op: 'move', id: cardId, to }]).catch(e => assert.equal(e.code, 'E_AUTO_CONTROL')); break;
      case 'edit': if (!archived) await s.person([{ op: 'update', id: cardId, patch: { notes: 'edit ' + step } }]); break;
      case 'archive': await s.person([{ op: archived ? 'restore' : 'archive', id: cardId }]); archived = !archived; break;
      case 'link':
        if (archived) break;
        await s.cli(orchestrator, [{ op: linked ? 'unlink' : 'link', id: cardId, agentId: a.id }]); linked = !linked; break;
      case 'signal': await auto.signal(a, signal); break;
      case 'resume':
        try { await auto.resume(s.id, cardId); if (!failing) tainted = false; } catch { /* a resume that cannot be saved is no resume */ }
        break;
      case 'restart': auto = s.make(); break;
    }
    const after = await stageNow();
    const where = `fault seed ${seed} step ${step}: ${JSON.stringify(log)}`;
    if (kind === 'signal' && tainted) assert.equal(after, before, 'the engine moved a card whose decision was lost — ' + where);
    if (failing && after !== before) tainted = true;
    if (tainted) assert.notEqual((await s.view(cardId)).mode, 'managed', 'held — ' + where);
  }
  // Repaired: one resume, and the card follows its agent again.
  failing = false;
  if (archived) await s.person([{ op: 'restore', id: cardId }]);
  if (!linked) await s.cli(orchestrator, [{ op: 'link', id: cardId, agentId: a.id }]);
  await auto.resume(s.id, cardId);
  await auto.signal(a, 'turn_started');
  assert.equal(await stageNow(), 'doing', `fault seed ${seed}: resumed and repaired, the card moves again`);
  await auto.signal(a, 'turn_ended');
  assert.equal(await stageNow(), 'review', `fault seed ${seed}: and again`);
}

for (let seed = 1; seed <= 12; seed++) {
  test(`D66 fault model, seed ${seed}: a card whose decision could not be saved is not moved by the engine until a resume`, async t => runFaults(t, seed, 30));
}

// D66 gate 483 (00c §2: the same family a second time → an automatic check). Save failures, a clock that goes back or
// stands still, the ledger's bounded history running out and old cards without an entry time — and (gate 489 F1) a
// decision file that cannot be read for a while or is damaged for good — mixed at random. The one
// invariant, checked after every step: the stage a person last committed is not changed by the engine until a resume
// succeeds — and a move the Store refused committed nothing at all.
async function runMixed(t, seed, steps, script = null, older = false) {
  const random = prng(seed * 104729), pick = list => list[Math.floor(random() * list.length)];
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  const s = await d66(t, { context: { newId: randomUUID, now: () => new Date(clock).toISOString() } });
  const a = s.agentOf({ title: 'Mixed model worker' });
  assert.equal(await s.auto.signal(a, 'created'), 'created');
  const cardId = (await s.cardOf(a.id)).id;
  const control = join(s.store.dataDir, 'auto-control'), write = s.store.atomicWrite;
  let failing = false, unreadable = false, frozen = false, chosen = null, auto = s.auto;
  s.store.atomicWrite = async (target, ...rest) => {
    if (failing && target.startsWith(control)) { const e = new Error('Injected control EACCES'); e.code = 'EACCES'; throw e; }
    return write.call(s.store, target, ...rest);
  };
  // Gate 489 F1: the decision file that cannot be read for a while (permissions, I/O), and one damaged for good.
  const read = s.store.fileBytes;
  s.store.fileBytes = async (file, ...rest) => {
    if (unreadable && file === s.controlPath) { const e = new Error('Injected control read EACCES'); e.code = 'EACCES'; throw e; }
    return read.call(s.store, file, ...rest);
  };
  const log = [];
  const stageNow = async () => (await s.card(cardId)).stageId;
  // G2b (research/498): the supported way back — 0.2.4 itself, its automatic cards off, a person moving the card there
  // (its Store knows nothing of the decision file) and rewriting the engine's memory in its own shape.
  const old = older || script?.some(e => e.startsWith('old')) ? await previousRelease('0.2.4') : null;
  const legacy = old && await old.openStore({ dataDir: s.store.dataDir, context: { newId: randomUUID, now: () => new Date(clock).toISOString() } });
  for (let step = 0; step < (script ? script.length : steps); step++) {
    if (!frozen) clock += 1000;
    // Weighted towards what the gates combined: round trips between two stages during a failure, then the records gone.
    const [scripted, scriptedArg] = script ? script[step].split(':') : [];
    const kind = scripted ?? pick(['fault', 'fault', 'move', 'move', 'move', 'move', 'cli', 'signal', 'signal', 'signal', 'resume', 'restart',
      'rollback', 'freeze', 'trim', 'trim', 'legacy', 'legacy', 'unreadable', 'unreadable', 'roundtrip', 'roundtrip', 'detail', 'detail', 'corrupt',
      ...older ? ['old', 'old', 'old', 'oldtrip', 'oldtrip', 'oldcache'] : []]);
    const to = scriptedArg ?? pick(['done', 'doing', 'done', 'doing', 'review', 'todo']), signal = scriptedArg ?? pick(Object.keys(SIGNALS));
    log.push([kind, kind === 'signal' ? signal : to, failing, unreadable]);
    const before = await stageNow();
    switch (kind) {
      case 'fault': failing = !failing; break;
      case 'unreadable': unreadable = !unreadable; break;
      case 'corrupt': await fs.writeFile(s.controlPath, '{broken'); break;
      case 'move': case 'cli': {
        const run = kind === 'move' ? s.person([{ op: 'move', id: cardId, to }]) : s.cli(a.id, [{ op: 'move', id: cardId, to }]);
        const result = await run.catch(error => error);
        if (result instanceof Error) {
          assert.equal(result.code, 'E_AUTO_CONTROL', 'only a refused decision may fail — ' + JSON.stringify(log));
          assert.equal(await stageNow(), before, 'a refused move committed nothing — ' + JSON.stringify(log));
        } else if (to !== before) chosen = to;
        break;
      }
      // Gate 489 F1's shape: away and back in two commits, so the card ends in the stage it started from.
      case 'roundtrip':
        for (const step of [before === 'review' ? 'todo' : 'review', before]) {
          const was = await stageNow();
          const result = await s.person([{ op: 'move', id: cardId, to: step }]).catch(error => error);
          if (result instanceof Error) {
            assert.equal(result.code, 'E_AUTO_CONTROL', 'only a refused decision may fail — ' + JSON.stringify(log));
            assert.equal(await stageNow(), was, 'a refused move committed nothing — ' + JSON.stringify(log));
          } else if (step !== was) chosen = step;
        }
        break;
      // Gate 495 F1: the card's detail read, a person's move (another screen) landing in the middle of that read, then
      // "Resume automatic tracking" pressed on what the detail showed. A resume that commits must have been pressed on the
      // card as it is — never free a stage the detail did not show.
      case 'detail': {
        const original = s.store.readAutoControl;
        let once = false;
        s.store.readAutoControl = async (...args) => {
          if (!once) {
            once = true;
            const was = await stageNow();
            const result = await s.person([{ op: 'move', id: cardId, to }]).catch(error => error);
            if (result instanceof Error) assert.equal(result.code, 'E_AUTO_CONTROL', 'only a refused decision may fail — ' + JSON.stringify(log));
            else if (to !== was) chosen = to;
          }
          return original.apply(s.store, args);
        };
        const reply = await createReadHandlers(s.store).card({ boardId: s.id, cardId }).finally(() => { s.store.readAutoControl = original; });
        const shown = reply.ok ? reply.data : null;
        if (shown?.trackingToken) {
          const answer = await createResumeHandler(auto)({ boardId: s.id, cardId, ...shown.trackingToken, decisionId: randomUUID() });
          if (answer.ok && answer.data.committed) {
            assert.equal(shown.card.stageId, await stageNow(), 'a resume was pressed on a card the detail did not show — ' + JSON.stringify(log));
            chosen = null;
          }
        }
        break;
      }
      // The older release's Store commits whatever the decision file says (it does not read it): a person's choice all the same.
      case 'old': case 'oldtrip':
        for (const step of kind === 'old' ? [to] : [before === 'review' ? 'todo' : 'review', before]) {
          const was = await stageNow();
          await legacy.mutateBoard(s.id, { actor: { kind: 'user' }, requestId: randomUUID(), operations: [{ op: 'move', id: cardId, to: step }] });
          if (step !== was) chosen = step;
        }
        break;
      case 'oldcache': await old.writeAutoState(s.store.dataDir, await old.readAutoState(s.store.dataDir)); break;
      case 'signal': await auto.signal(a, signal); break;
      case 'resume': try { await auto.resume(s.id, cardId); chosen = null; } catch { /* not saved: no resume */ } break;
      case 'restart': auto = s.make(); break;
      case 'rollback': clock -= 3_600_000; break;
      case 'freeze': frozen = !frozen; break;
      // What the ledger's 1,000-record bound leaves once enough other cards moved: none of this card's records.
      case 'trim': await s.outsideWrite(raw => { raw.history = raw.history.filter(h => h.cardId !== cardId); raw.receipts = []; }, false); break;
      // An old card: no entry time either (0.2.3 and 0.2.4 both accept such a card).
      case 'legacy': await s.outsideWrite(raw => { delete raw.cards.find(c => c.id === cardId).stageEnteredAt; raw.history = raw.history.filter(h => h.cardId !== cardId); }, false); break;
    }
    const after = await stageNow();
    const where = `mixed seed ${seed} step ${step}: ${JSON.stringify(log)}`;
    if (kind === 'signal' && chosen !== null) assert.equal(after, before, 'the engine changed the stage a person chose — ' + where);
    if (chosen !== null) assert.equal(after, chosen, 'the person\'s stage stands — ' + where);
  }
  failing = false; unreadable = false;
  await auto.resume(s.id, cardId);
  await auto.signal(a, 'turn_started');
  assert.equal(await stageNow(), 'doing', `mixed seed ${seed}: resumed, the card moves again`);
}

for (let seed = 1; seed <= 24; seed++) {
  test(`D66 mixed fault/clock/history model, seed ${seed}: the engine never changes the stage a person last committed without a resume`, async t => runMixed(t, seed, 60));
}
// Gate 489 F1 as fixed event sequences of the same model (random seeds rarely line up all of it): the card resumed in done
// with no entry time, or a clock gone back an hour; the decision file unreadable through a round trip; the card's records
// gone; the file read again; the engine's signals. Then the same with a damaged file in place of the unreadable one.
const SCRIPTS = {
  'read failure, legacy card': ['move:done', 'legacy', 'resume', 'unreadable', 'roundtrip', 'trim', 'unreadable', 'signal:turn_ended', 'restart', 'signal:turn_started'],
  'read failure, clock back': ['move:done', 'resume', 'rollback', 'unreadable', 'roundtrip', 'trim', 'unreadable', 'signal:turn_ended', 'restart', 'signal:turn_started'],
  'read failure, frozen clock': ['move:done', 'resume', 'freeze', 'unreadable', 'roundtrip', 'trim', 'unreadable', 'signal:turn_ended', 'restart', 'signal:turn_started'],
  'detail read raced by a completion': ['move:doing', 'detail:done', 'signal:turn_ended', 'restart', 'signal:turn_started'],
  'detail read raced by a completion, then a round trip': ['move:review', 'detail:done', 'roundtrip', 'detail:doing', 'signal:turn_ended', 'restart', 'signal:turn_ended'],
  'damaged file, legacy card': ['move:done', 'legacy', 'resume', 'corrupt', 'roundtrip', 'trim', 'signal:turn_ended', 'restart', 'signal:turn_started'],
  // G2b: the older release (automatic cards off) moves the card away and back to the stage this version last confirmed.
  'older release round trip after a resume': ['move:done', 'resume', 'oldtrip', 'oldcache', 'signal:turn_ended', 'restart', 'signal:turn_started'],
  'older release completion, its memory rewritten': ['signal:turn_started', 'old:done', 'oldcache', 'signal:turn_ended', 'restart', 'signal:turn_started'],
};
// G2b: the same mixed model with the older release's writer (automatic cards off) among the events.
for (let seed = 1; seed <= 12; seed++) {
  test(`D66 mixed model with the 0.2.4 writer, seed ${seed}: the engine never changes the stage a person last committed without a resume`, async t => runMixed(t, 100 + seed, 60, null, true));
}
for (const [name, script] of Object.entries(SCRIPTS)) {
  test(`D66 mixed model, gate sequence (${name}): the stage a person last committed stands`, async t => runMixed(t, 1, 0, script));
}
