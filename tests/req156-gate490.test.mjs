// REQ-156 gate 490 (research/490): the new-version check's lock and clock. R1 — a lock left by a dead process, taken over by two
// processes at once, must still let only one of them in: a switch saved "off" is never followed by a request, two lookers ask once
// (real processes, the order of their lock inspection and setting read forced as the gate did). R2 — the clock going back never
// makes a second request within a day; going back more than a day restamps the attempt without asking. And a state-machine test
// that mixes switches, looks, dead owners, take-overs and clock moves across simulated processes, checking after every step that no
// request starts after "off" was saved and that requests are at least 24 real hours apart. Every request is a fake `fetch`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fork, spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createUpdateChecker, readUpdateCheck } from '../dist/server/update-check.js';
import { openStore } from '../dist/server/core/index.js';
import { fixture, testTmpdir } from './helpers.mjs';

const SETTING = 'update-check.json', CACHE = 'update-check-cache.json', LOCK = '.update-check.lock';
const DAY = 24 * 3600_000, T0 = Date.parse('2026-10-19T00:00:00.000Z'), iso = ms => new Date(ms).toISOString();
const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/server/update-check.js')).href;
const storeUrl = pathToFileURL(join(process.cwd(), 'dist/server/core/index.js')).href;
const reply = (version = '9.9.9') => ({ ok: true, status: 200, body: null, text: async () => JSON.stringify({ name: 'paseo-auto-kanban', version }) });

async function folder(t) {
  const root = await mkdtemp(join(await testTmpdir(), 'kanban-gate490-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  return { root, dataDir };
}

/**
 * A lock record of a process that really died while holding the board lock (the store's own owner record — pid, start ticks,
 * boot id), copied to the update check's lock and aged two minutes (content and file time), as a lock left behind by a crash.
 */
async function deadLockBytes(t) {
  const f = await fixture(t);
  const child = `const { openStore } = await import(${JSON.stringify(storeUrl)});
    const store = await openStore({ dataDir: ${JSON.stringify(f.store.dataDir)} });
    await store.withBoardLock(${JSON.stringify(f.id)}, async () => { process.exit(0); });`;
  await new Promise((done, fail) => spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: 'ignore' })
    .on('exit', code => code === 0 ? done() : fail(new Error('lock child ' + code))));
  const file = join(f.store.dataDir, 'boards', f.id + '.lock');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.rm(file);
  return JSON.stringify({ ...record, token: randomUUID(), createdAt: iso(Date.now() - 120_000) });
}
async function plantDeadLock(dataDir, bytes) {
  const file = join(dataDir, LOCK);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(file, old, old);
}

/** A child process (a second Paseo server) whose first look at the lock, and second read of the setting, wait for the parent. */
const CHILD = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const [role, dir, moduleUrl, pause] = process.argv.slice(2);
// What the looker's second read waits on: the setting (it has read "on" under the lock) or the cache (it has decided to ask).
const lock = dir + '/.update-check.lock', held = dir + (pause === 'cache' ? '/update-check-cache.json' : '/update-check.json');
const waiters = new Map(), early = new Set();
process.on('message', m => { if (waiters.has(m)) { waiters.get(m)(); waiters.delete(m); } else early.add(m); });
const wait = m => early.delete(m) ? Promise.resolve() : new Promise(r => waiters.set(m, r));
let observed = false, reads = 0;
const observe = async () => { if (observed) return; observed = true; process.send({ event: 'stale-observed', role }); await wait('continue-takeover'); };
const stat = fs.stat, open = fs.open, readFile = fs.readFile;
fs.stat = async function (file, ...rest) { const v = await stat.call(this, file, ...rest); if (String(file) === lock) await observe(); return v; };
fs.open = async function (file, flags, ...rest) {
  const v = await open.call(this, file, flags, ...rest);
  const readOnly = flags === undefined || flags === 'r' || (typeof flags === 'number' && (flags & 3) === 0);
  if (String(file) === lock && readOnly) await observe();
  return v;
};
if (role.startsWith('look')) fs.readFile = async function (file, ...rest) {
  const v = await readFile.call(this, file, ...rest);
  if (String(file) === held && ++reads === 2) { process.send({ event: 'inside-lock-read-on', role }); await wait('continue-read'); }
  return v;
};
syncBuiltinESMExports();
const { createUpdateChecker } = await import(moduleUrl);
const checker = createUpdateChecker({ dataDir: dir, running: '0.2.5', timeoutMs: 1000,
  fetch: async () => { process.send({ event: 'request', role }); return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ name: 'paseo-auto-kanban', version: '9.9.9' }) }; } });
try {
  if (role.startsWith('look')) await checker.wake(); else { await checker.setEnabled(false); process.send({ event: 'off-saved', role }); }
  process.send({ event: 'done', role });
} catch (error) { process.send({ event: 'error', role, error: String(error && error.stack || error) }); }
process.disconnect();
`;
async function race(t, dataDir, roles, script, pause = 'setting') {
  const childFile = join(dataDir, '..', 'child.mjs');
  await fs.writeFile(childFile, CHILD);
  const events = [], waiters = [];
  let order = 0;
  const children = Object.fromEntries(roles.map(role => {
    const p = fork(childFile, [role, dataDir, moduleUrl, pause], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    p.stderr.on('data', b => events.push({ event: 'stderr', role, text: String(b) }));
    p.on('message', m => { events.push({ ...m, order: ++order });
      for (const w of [...waiters]) if (w.role === m.role && w.event === m.event) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
    return [role, p];
  }));
  t.after(() => { for (const p of Object.values(children)) p.kill(); });
  const until = (role, event, ms = 8000) => {
    const seen = events.find(x => x.role === role && x.event === event);
    if (seen) return Promise.resolve(seen);
    return new Promise(resolve => { const timer = setTimeout(() => resolve(null), ms);
      waiters.push({ role, event, resolve: m => { clearTimeout(timer); resolve(m); } }); });
  };
  const send = (role, message) => children[role].send(message);
  await script({ until, send });
  await Promise.all(roles.map(role => until(role, 'done', 15000)));
  return events;
}

test('490 R1: two processes taking over a dead lock at once — "off" saved by one is never followed by the other\'s request', async t => {
  const { dataDir } = await folder(t);
  await fs.writeFile(join(dataDir, SETTING), JSON.stringify({ schemaVersion: 1, enabled: true }));
  await plantDeadLock(dataDir, await deadLockBytes(t));
  const events = await race(t, dataDir, ['look', 'off'], async ({ until, send }) => {
    assert.ok(await until('look', 'stale-observed')); assert.ok(await until('off', 'stale-observed'));
    send('look', 'continue-takeover');
    assert.ok(await until('look', 'inside-lock-read-on'), 'the looker holds the lock and has read "on"');
    send('off', 'continue-takeover');
    // The off may only be saved once the looker let go; give it time to (wrongly) get in.
    await until('off', 'off-saved', 1500);
    send('look', 'continue-read');
  });
  const errors = events.filter(e => e.event === 'error' || e.event === 'stderr');
  assert.deepEqual(errors, [], JSON.stringify(errors));
  const saved = events.find(e => e.event === 'off-saved');
  assert.ok(saved, 'the off is saved in the end');
  const late = events.filter(e => e.event === 'request' && e.order > saved.order);
  assert.deepEqual(late, [], 'requests started after off was saved: ' + JSON.stringify(events));
  assert.equal(JSON.parse(await fs.readFile(join(dataDir, SETTING), 'utf8')).enabled, false);
});

test('490 R1: two lookers taking over a dead lock at once ask once between them', async t => {
  const { dataDir } = await folder(t);
  await fs.writeFile(join(dataDir, SETTING), JSON.stringify({ schemaVersion: 1, enabled: true }));
  await fs.writeFile(join(dataDir, CACHE), JSON.stringify({ schemaVersion: 1 }));
  await plantDeadLock(dataDir, await deadLockBytes(t));
  const events = await race(t, dataDir, ['look', 'look2'], async ({ until, send }) => {
    assert.ok(await until('look', 'stale-observed')); assert.ok(await until('look2', 'stale-observed'));
    send('look', 'continue-takeover');
    assert.ok(await until('look', 'inside-lock-read-on'));
    send('look2', 'continue-takeover');
    // The second looker's own second read of the setting, if it got in, is let through at once.
    const second = await until('look2', 'inside-lock-read-on', 1500);
    if (second) send('look2', 'continue-read');
    await until('look2', 'done', 1500);
    send('look', 'continue-read');
  }, 'cache');
  const errors = events.filter(e => e.event === 'error' || e.event === 'stderr');
  assert.deepEqual(errors, [], JSON.stringify(errors));
  assert.equal(events.filter(e => e.event === 'request').length, 1, JSON.stringify(events));
});

test('490 R1: a lock whose owner is alive is never taken over, however old', async t => {
  const { dataDir } = await folder(t);
  const store = await openStore({ dataDir, lockTimeoutMs: 400 });
  // This process holds the lock (a live owner) for longer than any staleness limit would allow if age alone counted.
  let release;
  const held = store.withDataLock(LOCK, () => new Promise(done => { release = done; }));
  for (let i = 0; i < 200 && !release; i++) await new Promise(done => setTimeout(done, 5));
  const record = JSON.parse(await fs.readFile(join(dataDir, LOCK), 'utf8'));
  await fs.writeFile(join(dataDir, LOCK), JSON.stringify({ ...record, createdAt: iso(Date.now() - 3600_000) }));
  const calls = [];
  const updates = createUpdateChecker({ dataDir, running: '0.2.5', store, fetch: () => { calls.push(1); return Promise.resolve(reply()); } });
  await updates.wake();
  assert.equal(calls.length, 0, 'a live owner keeps the lock: no request');
  await assert.rejects(updates.setEnabled(false), 'the switch cannot be saved past a live owner');
  release(); await held;
  assert.deepEqual(await updates.setEnabled(false), { enabled: false, changed: true });
});

test('490 R2: the clock going back never asks again within the day; more than a day back restamps the attempt without asking', async t => {
  const { dataDir } = await folder(t);
  const calls = [], clock = { now: Date.parse('2026-10-19T09:00:00.000Z') };
  const updates = createUpdateChecker({ dataDir, running: '0.2.5', now: () => clock.now, fetch: () => { calls.push(clock.now); return Promise.resolve(reply()); } });
  await updates.wake(); assert.equal(calls.length, 1);
  // The gate's sequence: back 5 minutes, back 5 minutes and a millisecond, back 6 more minutes — the same day, nothing more.
  for (const at of ['2026-10-19T08:55:00.000Z', '2026-10-19T08:54:59.999Z', '2026-10-19T08:48:59.999Z']) {
    clock.now = Date.parse(at); await updates.wake();
  }
  assert.equal(calls.length, 1, 'clock back: no request');
  // Back again from there to a day after the first attempt's day: the wait is still counted from the attempt's own time.
  clock.now = Date.parse('2026-10-20T08:59:59.999Z'); await updates.wake();
  assert.equal(calls.length, 1, 'not yet 24 hours after the attempt');
  clock.now = Date.parse('2026-10-20T09:00:00.000Z'); await updates.wake();
  assert.equal(calls.length, 2);
  // Back three days: the attempt stamp lies more than a day ahead — restamped to now, nothing asked, then 24 hours from now.
  clock.now = Date.parse('2026-10-17T12:00:00.000Z'); await updates.wake();
  assert.equal(calls.length, 2, 'more than a day back: restamped, not asked');
  assert.equal(JSON.parse(await fs.readFile(join(dataDir, CACHE), 'utf8')).attemptAt, iso(clock.now));
  clock.now = Date.parse('2026-10-18T11:59:59.999Z'); await updates.wake();
  assert.equal(calls.length, 2);
  clock.now = Date.parse('2026-10-18T12:00:00.000Z'); await updates.wake();
  assert.equal(calls.length, 3, '24 hours after the restamp');
  // A good answer from "the future" (before the clock went back) is not shown either.
  assert.equal((await readUpdateCheck(dataDir, '0.2.5', Date.parse('2026-10-15T00:00:00.000Z'))).newer, undefined);
});

test('490 R2: with the machine\'s boot clock, a clock moved forward does not shorten the day either', async t => {
  const { dataDir } = await folder(t);
  const calls = [], clock = { real: T0, offset: 0 };
  const boot = { id: 'boot-a', start: T0 - 3600_000 };
  const make = () => createUpdateChecker({ dataDir, running: '0.2.5', now: () => clock.real + clock.offset,
    uptime: () => ({ boot: boot.id, ms: clock.real - boot.start }), fetch: () => { calls.push(clock.real); return Promise.resolve(reply()); } });
  await make().wake(); assert.equal(calls.length, 1);
  clock.real += 3600_000; clock.offset += 2 * DAY; await make().wake();
  assert.equal(calls.length, 1, 'clock two days ahead, one real hour later: no request (a new process too)');
  clock.real = T0 + DAY; await make().wake();
  assert.equal(calls.length, 2, '24 real hours later');
  // Another boot: the boot clock says nothing about the time between, the wall clock decides.
  boot.id = 'boot-b'; boot.start = clock.real + 60_000; clock.real += 120_000;
  await make().wake(); assert.equal(calls.length, 2, 'new boot, wall clock within the day');
});

/** A tiny seeded generator (mulberry32), so a failing seed can be run again. */
function random(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let r = Math.imul(seed ^ (seed >>> 15), 1 | seed); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const SEEDS = Number(process.env.KANBAN_GATE490_SEEDS ?? 24), STEPS = Number(process.env.KANBAN_GATE490_STEPS ?? 40);

test(`490 state machine: switches, looks, dead owners, take-overs and clock moves across processes — ${SEEDS} seeds × ${STEPS} steps`, { timeout: 600_000 }, async t => {
  const dead = await deadLockBytes(t);
  const started = Date.now(), summary = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rnd = random(seed), pick = list => list[Math.floor(rnd() * list.length)];
    const { dataDir } = await folder(t);
    // Boot clock on for most seeds; without it (other systems) the clock only moves back, the wall clock being all there is.
    const withBoot = seed % 4 !== 0;
    // `saved`: the switch value of the save that completed last (saves pass one lock, so they complete in the order they were made).
    const world = { real: T0, offset: 0, seq: 0, saved: null, onInFlight: 0, requests: [], violations: [] };
    const answer = () => { const r = rnd(); return r < 0.6 ? Promise.resolve(reply(pick(['0.2.4', '0.2.6', '9.9.9'])))
      : r < 0.8 ? Promise.reject(new Error('offline')) : new Promise(done => setTimeout(() => done(reply()), 5 + Math.floor(rnd() * 20))); };
    const fetch = () => {
      const seq = ++world.seq;
      if (world.saved === false && world.onInFlight === 0) world.violations.push(`seed ${seed}: request #${seq} after off was saved`);
      const last = world.requests.at(-1);
      if (last !== undefined && world.real - last < DAY) world.violations.push(`seed ${seed}: requests ${world.real - last} ms apart`);
      world.requests.push(world.real);
      return answer();
    };
    // Each simulated process: its own checker and its own store (the lock is the file; no in-process queue is shared).
    const spawnProcess = async () => createUpdateChecker({ dataDir, running: '0.2.5', fetch, timeoutMs: 40,
      store: await openStore({ dataDir, lockTimeoutMs: 1500 }), now: () => world.real + world.offset,
      ...(withBoot ? { uptime: () => ({ boot: 'boot-1', ms: world.real - T0 + 3600_000 }) } : {}) });
    const processes = [await spawnProcess(), await spawnProcess(), await spawnProcess()];
    const counts = {};
    for (let step = 0; step < STEPS; step++) {
      const ops = [];
      for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
        const which = Math.floor(rnd() * processes.length), action = pick(['wake', 'wake', 'wake', 'on', 'off', 'time', 'clock', 'die', 'restart']);
        counts[action] = (counts[action] ?? 0) + 1;
        if (action === 'wake') ops.push(processes[which].wake());
        else if (action === 'off') ops.push(processes[which].setEnabled(false).then(() => { world.saved = false; }, () => {}));
        else if (action === 'on') { world.onInFlight++;
          ops.push(processes[which].setEnabled(true).then(() => { world.saved = true; }, () => {}).finally(() => { world.onInFlight--; })); }
        else if (action === 'time') world.real += Math.floor(rnd() * 30 * 3600_000);
        else if (action === 'clock') world.offset += withBoot ? Math.floor((rnd() - 0.5) * 6 * DAY) : -Math.floor(rnd() * 3 * DAY);
        // A process dies holding the lock: its record stays behind (only when nobody holds it now).
        else if (action === 'die') ops.push(fs.writeFile(join(dataDir, LOCK), dead, { flag: 'wx', mode: 0o600 }).catch(() => {}));
        else if (action === 'restart') ops.push(spawnProcess().then(p => { processes[which] = p; }));
      }
      await Promise.all(ops);
      assert.deepEqual(world.violations, [], `seed ${seed} step ${step}`);
    }
    summary.push({ seed, withBoot, requests: world.requests.length, counts });
  }
  const ms = Date.now() - started;
  t.diagnostic(`gate490 state machine: ${SEEDS} seeds × ${STEPS} steps in ${ms} ms; requests ${summary.reduce((n, s) => n + s.requests, 0)}`);
  if (process.env.KANBAN_GATE490_REPORT) await fs.writeFile(process.env.KANBAN_GATE490_REPORT, JSON.stringify({ seeds: SEEDS, steps: STEPS, ms, summary }, null, 1));
});
