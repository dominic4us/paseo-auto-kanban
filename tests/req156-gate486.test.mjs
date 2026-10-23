// REQ-156 gate 486 (research/486): the new-version check's promises under loss, races and failures — a switch turned off stays off
// when its file goes (F1), no request starts after "off" was saved (F2), at most one request a day across toggles and processes
// (F3), an open screen hears of a finished check or another device's off without a board change (F4), a good answer is shown for
// seven days only (F5), a broken version number shows nothing (J2). Every request is a fake `fetch`; nothing reaches the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as server from '../dist/server/update-check.js';
import * as shared from '../dist/shared/update-check.js';
import * as refresh from '../dist/client/refresh-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { revisionsGet } from '../dist/shared/rpc.js';
import { updateState } from '../dist/client/update-model.js';
import { fixture, testTmpdir } from './helpers.mjs';

const { createUpdateChecker, readUpdateCheck } = server;
const SETTING = 'update-check.json', BACKUP = 'update-check.backup.json', CACHE = 'update-check-cache.json';
const T0 = Date.parse('2026-10-19T00:00:00.000Z'), DAY = 24 * 3600_000, iso = ms => new Date(ms).toISOString();

async function folder(t) {
  const root = await mkdtemp(join(await testTmpdir(), 'kanban-gate486-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  return dataDir;
}
const reply = (version = '9.9.9') => ({ ok: true, status: 200, body: null, text: async () => JSON.stringify({ name: 'paseo-auto-kanban', version }) });
function registry(answer = () => Promise.resolve(reply())) {
  const calls = [];
  return { calls, fetch: (url, init) => { calls.push({ url, init }); return answer(); }, set answer(next) { answer = next; } };
}
const make = (dataDir, fake, clock = { now: T0 }, running = '0.2.5') =>
  createUpdateChecker({ dataDir, running, now: () => clock.now, fetch: fake.fetch, timeoutMs: 200 });
const exists = file => fs.access(file).then(() => true, () => false);
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(done => setImmediate(done)); };
/** Waits (5 s at most) until `ready()` — a request starts only after the store's lock file is taken, which takes real time under load. */
const until = async ready => { for (const end = Date.now() + 5000; !ready() && Date.now() < end;) await new Promise(done => setTimeout(done, 5)); };
/** `fs.readFile` of `file` held at its `nth` read (1-based) until `release()`; the module under test sees the patched export. */
function holdRead(file, nth = 1) {
  const original = fs.readFile;
  let count = 0, seen, release;
  const reached = new Promise(done => { seen = done; }), held = new Promise(done => { release = done; });
  fs.readFile = async function (target, ...rest) {
    const bytes = await original.call(this, target, ...rest);
    if (String(target) === file && ++count === nth) { seen(); await held; }
    return bytes;
  };
  syncBuiltinESMExports();
  return { reached, release: () => release(), restore: () => { fs.readFile = original; syncBuiltinESMExports(); } };
}

test('486 F1: a switch turned off stays off when its file is lost — kept by its backup; with every trace gone but the cache, fail closed', async t => {
  // Off, then the setting's file disappears: the backup still says off — the same server and a restarted one ask nothing.
  const a = await folder(t), fake = registry(), clock = { now: T0 }, updates = make(a, fake, clock);
  await updates.setEnabled(false);
  await fs.rename(join(a, SETTING), join(a, SETTING + '.moved'));
  await updates.wake(); await make(a, fake, clock).wake();
  clock.now += 3 * DAY; await updates.wake();
  assert.equal(fake.calls.length, 0, 'lost file after off: zero requests');
  assert.equal((await updates.state()).enabled, false);

  // A check was made (a cache exists), then off, then both the file and its backup are lost: not a first install — nothing is asked.
  const b = await folder(t), fb = registry(), cb = { now: T0 }, ub = make(b, fb, cb);
  await ub.wake(); assert.equal(fb.calls.length, 1);
  await ub.setEnabled(false);
  await fs.rm(join(b, SETTING)); await fs.rm(join(b, BACKUP));
  cb.now += 2 * DAY; await ub.wake(); await make(b, fb, cb).wake();
  assert.equal(fb.calls.length, 1, 'setting and backup lost after a check: zero more requests');
  assert.deepEqual(await ub.state(), { enabled: false, damaged: true });
  // Choosing on or off from the settings window writes a sound setting again.
  assert.equal((await ub.setEnabled(false)).enabled, false);
  assert.deepEqual(await ub.state(), { enabled: false });

  // The default (never touched) user: the first check writes the setting down too, so its loss is not taken for a first install.
  const c = await folder(t), fc = registry(), cc = { now: T0 }, uc = make(c, fc, cc);
  await uc.wake(); assert.equal(fc.calls.length, 1);
  assert.equal(JSON.parse(await fs.readFile(join(c, SETTING), 'utf8')).enabled, true);
  assert.equal(JSON.parse(await fs.readFile(join(c, BACKUP), 'utf8')).enabled, true);
  await fs.rm(join(c, SETTING)); cc.now += DAY; await uc.wake();
  assert.equal(fc.calls.length, 2, 'the backup says on: the next day asks');

  // A setting that cannot be read (a folder in its place) fails closed.
  const d = await folder(t), fd = registry(); await fs.mkdir(join(d, SETTING));
  await make(d, fd).wake();
  assert.equal(fd.calls.length, 0);
  assert.deepEqual(await readUpdateCheck(d, '0.2.5', T0), { enabled: false, damaged: true });

  // Only a folder that never held any of the check's files starts on (other automation files do not count).
  const e = await folder(t), fe = registry();
  await fs.writeFile(join(e, 'auto-archive.json'), JSON.stringify({ schemaVersion: 1, days: 7, changedAt: iso(T0) }));
  assert.deepEqual(await readUpdateCheck(e, '0.2.5', T0), { enabled: true });
  await make(e, fe).wake();
  assert.equal(fe.calls.length, 1, 'first install: on');
});

test('486 F2: once "off" is saved, no request starts — a read in flight re-checks under the same lock before asking', async t => {
  // The gate's case: the look read "on", another screen saves "off", then the look goes on.
  const a = await folder(t), fake = registry();
  await fs.writeFile(join(a, SETTING), JSON.stringify({ schemaVersion: 1, enabled: true }));
  const hold = holdRead(join(a, SETTING), 1);
  try {
    const looking = make(a, fake).wake();
    await hold.reached;
    await make(a, fake).setEnabled(false);
    hold.release(); await looking;
  } finally { hold.restore(); }
  assert.equal(fake.calls.length, 0, 'off saved before the look asked: nothing asked');

  // Every interleaving of a look and an "off" from another checker: a request may only start before the off was saved.
  for (let nth = 1; nth <= 6; nth++) {
    const dataDir = await folder(t);
    let offSaved = false;
    const late = [];
    const fake2 = registry(() => Promise.resolve(reply()));
    const fetch = (url, init) => { if (offSaved) late.push(nth); return fake2.fetch(url, init); };
    const looker = createUpdateChecker({ dataDir, running: '0.2.5', now: () => T0, fetch, timeoutMs: 200 });
    const other = createUpdateChecker({ dataDir, running: '0.2.5', now: () => T0, fetch, timeoutMs: 200 });
    const hold2 = holdRead(join(dataDir, SETTING), nth);
    try {
      const looking = looker.wake();
      await Promise.race([hold2.reached, looking]);
      const saving = other.setEnabled(false).then(value => { offSaved = true; return value; });
      await ticks(); hold2.release();
      await Promise.all([looking, saving]);
    } finally { hold2.restore(); }
    assert.deepEqual(late, [], 'held at read ' + nth + ': a request started after off was saved');
    assert.equal((await looker.state()).enabled, false);
    // And whatever was asked before, the answer is not kept while off.
    assert.equal((await looker.state()).newer, undefined);
  }
});

test('486 F3: at most one request a day — turning off and on keeps the last attempt; two checkers on one folder ask once', async t => {
  const a = await folder(t), fake = registry(), clock = { now: T0 }, updates = make(a, fake, clock);
  await updates.wake(); await updates.setEnabled(false); await updates.setEnabled(true); await updates.wake();
  assert.equal(fake.calls.length, 1, 'same day off → on: still one');
  for (let i = 0; i < 5; i++) { clock.now += 3600_000; await updates.setEnabled(i % 2 === 0 ? false : true); await updates.setEnabled(true); await updates.wake(); }
  assert.equal(fake.calls.length, 1, 'toggling all day: still one');
  assert.equal(JSON.parse(await fs.readFile(join(a, CACHE), 'utf8')).attemptAt, iso(T0), 'the last attempt survives the toggles');
  clock.now = T0 + DAY; await updates.wake();
  assert.equal(fake.calls.length, 2, 'a day after the first: the next one');

  // Two checkers on one folder (two servers), both reading at once, the first answer slow.
  const b = await folder(t);
  const releases = [], calls = [];
  const slow = () => new Promise(done => releases.push(() => done(reply())));
  const mk = () => createUpdateChecker({ dataDir: b, running: '0.2.5', now: () => T0, fetch: (url, init) => { calls.push(url); return slow(); }, timeoutMs: 2000 });
  const one = mk(), two = mk();
  const both = Promise.all([one.wake(), two.wake(), one.wake(), two.wake()]);
  await until(() => calls.length >= 1);
  await new Promise(done => setTimeout(done, 300));
  releases.forEach(done => done()); await both;
  assert.equal(calls.length, 1, 'two checkers at once: one request');
  // A third checker made later the same day asks nothing either.
  await mk().wake(); assert.equal(calls.length, 1);
});

test('486 F3: separate processes on one data folder ask once between them', async t => {
  const dataDir = await folder(t), log = join(dataDir, '..', 'calls.log'), go = join(dataDir, '..', 'go');
  const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/server/update-check.js')).href;
  const child = `
    import { appendFileSync, existsSync } from 'node:fs';
    const { createUpdateChecker } = await import(${JSON.stringify(moduleUrl)});
    const fetch = async () => { appendFileSync(${JSON.stringify(log)}, process.pid + '\\n');
      await new Promise(done => setTimeout(done, 150));
      return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ name: 'paseo-auto-kanban', version: '9.9.9' }) }; };
    const updates = createUpdateChecker({ dataDir: ${JSON.stringify(dataDir)}, running: '0.2.5', now: () => ${T0}, fetch, timeoutMs: 2000 });
    while (!existsSync(${JSON.stringify(go)})) await new Promise(done => setTimeout(done, 2));
    await Promise.all([updates.wake(), updates.wake()]);`;
  const children = Array.from({ length: 4 }, () => new Promise((done, fail) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('exit', code => code === 0 ? done() : fail(new Error('child failed: ' + err)));
  }));
  await new Promise(done => setTimeout(done, 300));
  await fs.writeFile(go, '');
  await Promise.all(children);
  const lines = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'four processes at once: ' + lines.length + ' requests');
  assert.equal(await exists(join(dataDir, '.update-check.lock')), false, 'the lock is released');
});

test('486 F4: the revisions an open screen polls carry the check\'s fingerprint — a finished check and another device\'s off change it', async t => {
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, () => iso(T0), async () => ({ available: false, source: 'none', definitions: [], byWorkspace: {} }),
    async () => ({ active: [], entries: [] }));
  let release;
  const updates = createUpdateChecker({ dataDir: f.store.dataDir, running: '0.2.5', now: () => T0,
    fetch: () => new Promise(done => { release = () => done(reply()); }), timeoutMs: 2000 });
  const looking = updates.wake();
  await until(() => !!release);
  const first = await handlers.overview({ hostId: 'host-a', includeBoards: true });
  const shownKey = shared.updateCheckKey(first.data.updateCheck);
  const before = await handlers.revisions({});
  assert.equal(revisionsGet.output.safeParse(before).success, true);
  assert.equal(before.data.updates, shownKey, 'nothing changed yet: the same fingerprint');
  assert.equal(refresh.updatesChanged(shownKey, before.data.updates), false);
  release(); await looking;
  const after = await handlers.revisions({});
  assert.notEqual(after.data.updates, shownKey, 'the check finished: the fingerprint moved');
  assert.equal(refresh.updatesChanged(shownKey, after.data.updates), true, 'the screen reads again');
  const later = await handlers.overview({ hostId: 'host-a', includeBoards: true });
  assert.equal(later.data.updateCheck.newer, '9.9.9');
  assert.equal(shared.updateCheckKey(later.data.updateCheck), after.data.updates, 'after the re-read the screen is current');
  // Another device turns it off: the fingerprint moves again, and the screen's re-read drops the dot.
  await createUpdateChecker({ dataDir: f.store.dataDir, running: '0.2.5', now: () => T0, fetch: () => { throw new Error('no'); } }).setEnabled(false);
  const off = await handlers.revisions({});
  assert.equal(refresh.updatesChanged(after.data.updates, off.data.updates), true);
  assert.deepEqual((await handlers.overview({ hostId: 'host-a' })).data.updateCheck, { enabled: false });
  // An older server says no fingerprint: nothing is read again for it.
  assert.equal(refresh.updatesChanged(shownKey, undefined), false);
  assert.equal(refresh.updatesChanged(undefined, off.data.updates), false);
});

test('486 F4: a long-open screen polling revisions wakes the next day\'s check (no board change needed)', async () => {
  const ts = (await import('typescript')).default;
  const source = await fs.readFile(new URL('../index.server.ts', import.meta.url), 'utf8'), ast = ts.createSourceFile('index.server.ts', source, ts.ScriptTarget.Latest, true);
  const handled = {};
  const visit = n => { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'server.handle') handled[n.arguments[0]?.getText(ast)] = n.arguments[1]?.getText(ast); ts.forEachChild(n, visit); };
  visit(ast);
  assert.match(handled.revisionsGet, /lookForUpdate\(\);/);
});

test('486 F5: the last good answer is shown for seven days only — failing meanwhile stays silent, after that nothing is shown', async t => {
  const a = await folder(t), fake = registry(), clock = { now: T0 }, updates = make(a, fake, clock);
  await updates.wake();
  assert.equal((await updates.state()).newer, '9.9.9');
  fake.answer = () => Promise.reject(new Error('offline'));
  for (let day = 1; day <= 6; day++) { clock.now = T0 + day * DAY; await updates.wake(); }
  assert.equal(fake.calls.length, 7);
  clock.now = T0 + 7 * DAY - 1;
  assert.deepEqual(await readUpdateCheck(a, '0.2.5', clock.now), { enabled: true, newer: '9.9.9', checkedAt: iso(T0) }, 'within seven days: shown');
  clock.now = T0 + 7 * DAY; await updates.wake();
  const stale = await readUpdateCheck(a, '0.2.5', clock.now);
  assert.deepEqual(stale, { enabled: true }, 'seven days without an answer: nothing shown');
  assert.equal(updateState(stale), 'unchecked');
  // Paseo closed for a week (no look at all): the reading alone drops it as well.
  const b = await folder(t), fb = registry(), ub = make(b, fb);
  await ub.wake();
  assert.deepEqual(await readUpdateCheck(b, '0.2.5', T0 + 8 * DAY), { enabled: true });
  // A good answer again shows again.
  fake.answer = () => Promise.resolve(reply('9.9.10'));
  clock.now = T0 + 8 * DAY; await updates.wake();
  assert.equal((await readUpdateCheck(a, '0.2.5', clock.now)).newer, '9.9.10');
});

test('486 J2: a broken version or answer time in the cache shows no result — never "up to date" — and is not asked again that day', async t => {
  for (const cache of [{ attemptAt: iso(T0), checkedAt: iso(T0), latest: '<invalid>' }, { attemptAt: iso(T0), checkedAt: 'garbage', latest: '9.9.9' },
    { attemptAt: iso(T0), checkedAt: iso(T0) }]) {
    const dataDir = await folder(t), fake = registry();
    await fs.writeFile(join(dataDir, SETTING), JSON.stringify({ schemaVersion: 1, enabled: true }));
    await fs.writeFile(join(dataDir, CACHE), JSON.stringify({ schemaVersion: 1, ...cache }));
    const updates = make(dataDir, fake, { now: T0 + 3600_000 });
    await updates.wake();
    const view = await readUpdateCheck(dataDir, '0.2.5', T0 + 3600_000);
    assert.deepEqual(view, { enabled: true }, JSON.stringify(cache));
    assert.equal(updateState(view), 'unchecked');
    assert.equal(fake.calls.length, 0, 'the attempt stamp still holds the day');
  }
});
