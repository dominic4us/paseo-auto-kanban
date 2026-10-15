import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller, createShownWatch, knownRevisions, revisionsChanged } from '../dist/client/refresh-model.js';

/** A hand-driven clock: `advance` fires due timers in order, and awaits the checks they start. */
function clock() {
  let now = 0, next = 1;
  const due = new Map();
  const timers = { set: (run, ms) => { const id = next++; due.set(id, { at: now + ms, run }); return id; },
    clear: id => { due.delete(id); } };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { now: () => now, timers, pending: () => due.size,
    async advance(ms) {
      await flush(); const end = now + ms;
      for (;;) {
        const first = [...due].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at; due.delete(first[0]); first[1].run(); await flush();
      }
      now = end; await flush();
    } };
}
const config = { intervalMs: 4000, idleMs: 180_000, minGapMs: 1000 };
function poller(options = {}) {
  const c = clock(); let checks = 0, inFlight = 0, maxInFlight = 0;
  const release = [];
  const p = createPoller({ now: c.now, timers: c.timers, config, ...options, check: async () => {
    checks++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    if (options.hold) await new Promise(resolve => release.push(resolve));
    inFlight--;
  } });
  return { p, c, checks: () => checks, maxInFlight: () => maxInFlight,
    release: async () => { release.splice(0).forEach(r => r()); await new Promise(r => setImmediate(r)); } };
}

test('REQ-62 revisions: the same revisions are no change; a changed, new or vanished board is', () => {
  const known = { a: 'r:1', b: 'r:2' };
  const reply = (boards, errors = []) => ({ boards: boards.map(([id, revision]) => ({ id, revision })), errors });
  assert.equal(revisionsChanged(known, reply([['a', 'r:1'], ['b', 'r:2']]), 'all'), false);
  assert.equal(revisionsChanged(known, reply([['a', 'r:1'], ['b', 'r:3']]), 'all'), true, 'a CLI edit');
  assert.equal(revisionsChanged(known, reply([['a', 'r:1'], ['b', 'r:2'], ['c', 'r:1']]), 'all'), true, 'kanban init elsewhere');
  assert.equal(revisionsChanged(known, reply([['a', 'r:1']]), 'all'), true, 'a removed board');
  assert.equal(revisionsChanged(known, reply([['a', 'r:1']], [{ target: 'b' }]), 'all'), false,
    'a board that failed to read is not taken for gone');
  assert.equal(revisionsChanged({ a: 'r:1' }, reply([['a', 'r:1'], ['z', 'r:9']]), 'listed'), false, 'listed ignores others');
  assert.equal(revisionsChanged({ a: 'r:1' }, reply([]), 'listed'), true, 'the one board vanished');
  assert.equal(revisionsChanged({ a: 'r:1' }, reply([['a', 'r:1'], ['n', 'r:1']]), 'appeared'), true);
  assert.equal(revisionsChanged({ a: 'r:1' }, reply([]), 'appeared'), false, 'appeared waits only for a new board');
  assert.deepEqual(knownRevisions([{ id: 'a', revision: 'r:1' }, { id: 'empty:w', revision: '', hasLedger: false }]), { a: 'r:1' });
});

test('REQ-62 poller: first look one interval after mounting, then every interval, never two at once', async () => {
  const { p, c, checks, maxInFlight } = poller();
  p.start();
  assert.equal(checks(), 0, 'the data was just read');
  await c.advance(3999); assert.equal(checks(), 0);
  await c.advance(1); assert.equal(checks(), 1);
  await c.advance(4000 * 5); assert.equal(checks(), 6);
  assert.equal(maxInFlight(), 1);
  assert.equal(c.pending(), 1, 'one timer at a time');
  p.dispose();
});

test('REQ-62 poller: 3 minutes without touch stops every request; a touch looks at once and resumes', async () => {
  const { p, c, checks } = poller();
  p.start();
  await c.advance(179_999);
  const before = checks();
  assert.equal(before, 44, '4-second looks while someone is around');
  await c.advance(10 * 60_000);
  assert.equal(checks(), before, 'zero requests after 3 minutes idle');
  assert.equal(c.pending(), 0, 'no timer left');
  assert.equal(p.state().polling, false);
  p.activity();
  assert.equal(checks(), before + 1, 'a touch looks at once');
  await c.advance(4000); assert.equal(checks(), before + 2, 'and polling resumes');
  // Activity while polling only moves the idle deadline, it never adds a look.
  p.activity(); p.activity(); p.activity();
  assert.equal(checks(), before + 2);
  p.dispose();
});

test('REQ-62 poller: background stops it, foreground and focus look once at once, repeated wakes are throttled', async () => {
  const { p, c, checks } = poller();
  p.start();
  await c.advance(4000); assert.equal(checks(), 1);
  p.visibility(false);
  assert.equal(c.pending(), 0, 'background clears the timer');
  await c.advance(60_000); assert.equal(checks(), 1, 'nothing while hidden');
  p.activity(); assert.equal(checks(), 1, 'a hidden screen ignores activity');
  p.visibility(true); assert.equal(checks(), 2, 'foreground looks at once');
  p.wake(); assert.equal(checks(), 2, 'a focus right after a look does not look again');
  await c.advance(1000); p.wake(); assert.equal(checks(), 3, 'focus looks at once');
  await c.advance(4000); assert.equal(checks(), 4);
  // Background long enough to go idle: coming back is itself the interaction.
  p.visibility(false); await c.advance(10 * 60_000); p.visibility(true);
  assert.equal(checks(), 5); await c.advance(4000); assert.equal(checks(), 6);
  p.dispose();
});

test('REQ-62 poller: dispose leaves no timer and ignores a look still in flight; a slow look delays the next', async () => {
  const slow = poller({ hold: true });
  slow.p.start();
  await slow.c.advance(4000); assert.equal(slow.checks(), 1);
  await slow.c.advance(20_000); assert.equal(slow.checks(), 1, 'the next wait starts after the reply');
  slow.p.wake(); slow.p.activity(); assert.equal(slow.checks(), 1, 'never two looks in flight');
  await slow.release(); assert.equal(slow.c.pending(), 1);
  await slow.c.advance(4000); assert.equal(slow.checks(), 2);
  slow.p.dispose(); await slow.release();
  assert.equal(slow.c.pending(), 0, 'a reply after dispose schedules nothing');
  slow.p.activity(); slow.p.wake(); slow.p.visibility(false); slow.p.visibility(true);
  await slow.c.advance(60_000); assert.equal(slow.checks(), 2);
  // Mounted in the background: nothing until the screen shows.
  const hidden = poller({ visible: false });
  hidden.p.start(); await hidden.c.advance(60_000);
  assert.equal(hidden.checks(), 0); assert.equal(hidden.c.pending(), 0);
  hidden.p.visibility(true); assert.equal(hidden.checks(), 1);
  hidden.p.dispose();
});

// F1: the host hides a plugin screen (display:none ancestor) or takes its DOM out instead of unmounting it.
function element() { return { isConnected: true, rects: 1, getClientRects() { return { length: this.rects }; } }; }
function observerClass() {
  const live = new Set();
  class Observer { constructor(report) { this.report = report; } observe(target) { this.target = target; live.add(this); } disconnect() { live.delete(this); } }
  return { Observer, live, report: shown => { for (const o of [...live]) o.report([{ isIntersecting: shown }]); } };
}
test('F1 shown watch: the root element\'s box and the observer tell whether the host still shows the screen', () => {
  const { Observer, live, report } = observerClass();
  const watch = createShownWatch(Observer), heard = [];
  watch.subscribe(value => heard.push(value));
  assert.equal(watch.shown(), true, 'nothing attached yet (native): shown, as before');
  watch.ref({}); assert.equal(watch.shown(), true, 'a native view has no DOM box: shown');
  assert.equal(live.size, 0, 'and nothing is observed');
  const root = element(); watch.ref(root);
  assert.equal(live.size, 1); assert.equal([...live][0].target, root);
  root.rects = 0; report(false);
  assert.equal(watch.shown(), false); assert.deepEqual(heard, [false]);
  root.rects = 1; report(true);
  assert.equal(watch.shown(), true); assert.deepEqual(heard, [false, true]);
  // Taken out of the page before the observer says so: every look checks the box itself.
  root.isConnected = false; assert.equal(watch.shown(), false);
  root.isConnected = true; root.rects = 0; assert.equal(watch.shown(), false, 'a display:none ancestor');
  root.rects = 1;
  watch.ref(null);
  assert.equal(live.size, 0, 'unmounting disconnects the observer');
  assert.deepEqual(heard, [false, true], 'and reports nothing, so a leaving screen is not woken');
  // A browser without IntersectionObserver still never looks from a hidden screen.
  const plain = createShownWatch(undefined), hidden = element(); plain.ref(hidden);
  hidden.rects = 0; assert.equal(plain.shown(), false); hidden.rects = 1; assert.equal(plain.shown(), true);
});
