import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { openStore } from '../dist/server/core/index.js';
import { fixture as baseFixture, request, add, testTmpdir } from './helpers.mjs';

/**
 * D63: on a Windows or macOS server there is no /proc, so a lock left by a Paseo that died while writing was never
 * reclaimed and every later write waited, then failed. These tests make this host say win32 or darwin and answer
 * `process.kill(pid, 0)` for the lock's pid the way such a host would: ESRCH when no process has that pid, success
 * when one does (the owner, or another process that reused the pid), EPERM when one does but belongs to someone else.
 */
const lock = (f) => join(f.store.dataDir, 'boards', `${f.id}.lock`);
const GONE = 4_000_037;
/** A machine is its own home: the machine id lives there (gate 416 F1), never in the shared data folder. */
async function home(t) {
  const dir = await mkdtemp(join(await testTmpdir(), 'kanban-d63-home-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function fixture(t, options = {}) { return baseFixture(t, { homeDir: await home(t), environment: {}, ...options }); }
const idFile = (homeDir, value) => value === 'win32'
  ? join(homeDir, 'AppData', 'Local', 'paseo-auto-kanban', 'machine-id')
  : join(homeDir, 'Library', 'Application Support', 'paseo-auto-kanban', 'machine-id');
/** This store's machine id, as a lock it takes records it. */
async function machineOf(store) {
  let seen;
  await store.withBoardLock(store.__id, async () => { seen = JSON.parse(await fs.readFile(join(store.dataDir, 'boards', `${store.__id}.lock`), 'utf8')); });
  return seen.machineId;
}
function platform(t, value) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  t.after(() => Object.defineProperty(process, 'platform', original));
}
/** `answer(pid)` returns an errno code to throw, or null for a process that exists. Other pids keep the real kill. */
function kill(t, answer) {
  const original = process.kill;
  const asked = [];
  process.kill = (pid, signal) => {
    if (signal !== 0) return original.call(process, pid, signal);
    asked.push(pid);
    const code = answer(pid);
    if (code === undefined) return original.call(process, pid, signal);
    if (code) throw Object.assign(new Error(`kill ${code}`), { code, errno: code === 'ESRCH' ? -3 : -1, syscall: 'kill' });
    return true;
  };
  t.after(() => { process.kill = original; });
  return asked;
}
const bootTime = () => Date.now() - os.uptime() * 1000;
/** A lock as a non-Linux owner writes it, aged past the 60-second recovery wait unless told otherwise. */
async function leftLock(f, value, changes = {}) {
  f.store.__id = f.id;
  const machineId = 'machineId' in changes ? changes.machineId : await machineOf(f.store);
  const owner = { machineId, token: randomUUID(), pid: GONE, procStartTicks: null, bootId: null, pidNamespace: null,
    hostname: os.hostname(), createdAt: new Date(Date.now() - 61_000).toISOString(), platform: value, bootTime: bootTime(), ...changes };
  for (const key of Object.keys(owner)) if (owner[key] === undefined) delete owner[key];
  await fs.writeFile(lock(f), JSON.stringify(owner));
  return owner;
}
const present = async (f) => fs.stat(lock(f)).then(() => true, () => false);

for (const value of ['win32', 'darwin']) {
  test(`D63 ${value}: a lock the writer takes names its platform and boot time`, async t => {
    const homeDir = await home(t);
    const f = await fixture(t, { homeDir }); platform(t, value); f.store.__home = homeDir;
    let seen;
    await f.store.withBoardLock(f.id, async () => { seen = JSON.parse(await fs.readFile(lock(f), 'utf8')); });
    assert.equal(seen.platform, value);
    assert.equal(seen.hostname, os.hostname());
    assert.equal(seen.pid, process.pid);
    assert.ok(Math.abs(seen.bootTime - bootTime()) < 5_000, 'boot time is this host\'s');
    const file = idFile(f.store.__home, value);
    assert.equal(seen.machineId, (await fs.readFile(file, 'utf8')).trim(), 'the machine id is the one kept in the home, made once');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    let again;
    await f.store.withBoardLock(f.id, async () => { again = JSON.parse(await fs.readFile(lock(f), 'utf8')); });
    assert.equal(again.machineId, seen.machineId);
  });

  test(`D63 ${value} (gate 416 F1): another machine with the same host name, platform and boot cannot reclaim a lock`, async t => {
    // Two stores on one data folder, each with its own home: two machines. The owner's pid is absent here (ESRCH),
    // as it is from another machine's process table, but the lock is not this machine's.
    const a = await fixture(t, { lockTimeoutMs: 100 }); platform(t, value);
    const b = await openStore({ dataDir: a.store.dataDir, homeDir: await home(t), environment: {}, lockTimeoutMs: 100 });
    kill(t, pid => pid === GONE ? 'ESRCH' : undefined);
    a.store.__id = b.__id = a.id;
    const other = await machineOf(b);
    const owner = await leftLock(a, value);
    assert.ok(other && owner.machineId && other !== owner.machineId, 'each machine has its own id');
    await assert.rejects(b.mutateBoard(a.id, request([add('other machine')])), error => {
      assert.equal(error.code, 'E_LOCK_TIMEOUT'); assert.equal(error.details.ownerState, 'unknown'); return true;
    });
    await assert.rejects(b.unlock(a.id), { code: 'E_LOCK_ACTIVE' });
    assert.equal(await present(a), true);
    // The machine that took it still reclaims it.
    const outcome = await a.store.mutateBoard(a.id, request([add('same machine')]));
    assert.ok(outcome.warnings.some(w => w.code === 'W_STALE_LOCK'));
    assert.equal(await present(a), false);
  });

  for (const [name, prepare] of [
    ['is not a readable id', async (homeDir) => { const file = idFile(homeDir, value); await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(file, 'not-an-id'); }],
    ['cannot be read (a folder is in its place)', async (homeDir) => { await fs.mkdir(idFile(homeDir, value), { recursive: true }); }],
  ]) {
    test(`D63 ${value} (gate 416 F1): when the machine id ${name}, nothing is reclaimed`, async t => {
      const homeDir = await home(t);
      const f = await fixture(t, { homeDir, lockTimeoutMs: 100 }); platform(t, value);
      kill(t, pid => pid === GONE ? 'ESRCH' : undefined);
      await prepare(homeDir);
      f.store.__id = f.id;
      assert.equal(await machineOf(f.store), undefined, 'a lock without a machine id');
      await leftLock(f, value, { machineId: randomUUID() });
      await assert.rejects(f.store.mutateBoard(f.id, request([add()])), { code: 'E_LOCK_TIMEOUT' });
      await leftLock(f, value, { machineId: undefined });
      await assert.rejects(f.store.unlock(f.id), { code: 'E_LOCK_ACTIVE' });
      assert.equal(await present(f), true);
    });
  }

  test(`D63 ${value} (gate 416 F1): a machine id that would sit inside the data folder is not used`, async t => {
    const f = await fixture(t, { lockTimeoutMs: 100 }); platform(t, value);
    const inside = await openStore({ dataDir: f.store.dataDir, homeDir: f.store.dataDir, environment: { LOCALAPPDATA: f.store.dataDir }, lockTimeoutMs: 100 });
    inside.__id = f.id;
    assert.equal(await machineOf(inside), undefined);
    await assert.rejects(fs.stat(join(f.store.dataDir, 'paseo-auto-kanban')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(join(f.store.dataDir, 'AppData')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(join(f.store.dataDir, 'Library')), { code: 'ENOENT' });
  });

  /** The id's own folder, a folder above it, or the id file itself, linked into the data folder (gate 417 F2). */
  const links = {
    'its folder': async (homeDir, target) => { const folder = join(idFile(homeDir, value), '..'); await fs.mkdir(join(folder, '..'), { recursive: true }); await fs.symlink(target, folder, 'dir'); },
    'a folder above it': async (homeDir, target) => { const above = join(idFile(homeDir, value), '..', '..'); await fs.mkdir(join(above, '..'), { recursive: true }); await fs.symlink(target, above, 'dir'); },
    'the file itself': async (homeDir, target) => { const file = idFile(homeDir, value); await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(join(target, 'machine-id'), `${randomUUID()}\n`); await fs.symlink(join(target, 'machine-id'), file); },
  };
  for (const [name, link] of Object.entries(links)) {
    test(`D63 ${value} (gate 417 F2): an id reached through a link from ${name} into the data folder is not used`, async t => {
      // Two machines whose application data both lead into the shared data folder would share one id.
      const a = await fixture(t, { lockTimeoutMs: 100 }); platform(t, value);
      const shared = join(a.store.dataDir, 'shared-profile'); await fs.mkdir(shared);
      const homes = [await home(t), await home(t)];
      for (const homeDir of homes) await link(homeDir, shared).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stores = await Promise.all(homes.map(homeDir => openStore({ dataDir: a.store.dataDir, homeDir, environment: {}, lockTimeoutMs: 100 })));
      for (const store of stores) { store.__id = a.id; assert.equal(await machineOf(store), undefined, 'no id from inside the data folder'); }
      kill(t, pid => pid === GONE ? 'ESRCH' : undefined);
      const before = await fs.readdir(shared);
      await leftLock(a, value, { machineId: before.length ? (await fs.readFile(join(shared, 'machine-id'), 'utf8')).trim() : randomUUID() });
      await assert.rejects(stores[1].mutateBoard(a.id, request([add('other machine')])), error => {
        assert.equal(error.code, 'E_LOCK_TIMEOUT'); assert.equal(error.details.ownerState, 'unknown'); return true;
      });
      assert.equal(await present(a), true);
      assert.deepEqual(await fs.readdir(shared), before, 'nothing is written into the data folder');
    });
  }

  test(`D63 ${value} (gate 417 F2): a cached id stops counting once its folder is linked into the data folder`, async t => {
    const homeDir = await home(t);
    const f = await fixture(t, { homeDir, lockTimeoutMs: 100 }); platform(t, value);
    kill(t, pid => pid === GONE ? 'ESRCH' : undefined);
    const owner = await leftLock(f, value);
    assert.ok(owner.machineId);
    await fs.unlink(lock(f));
    const folder = join(idFile(homeDir, value), '..'), shared = join(f.store.dataDir, 'shared-profile');
    await fs.rename(folder, shared); await fs.symlink(shared, folder, 'dir');
    await leftLock(f, value, { machineId: owner.machineId });
    await assert.rejects(f.store.mutateBoard(f.id, request([add()])), { code: 'E_LOCK_TIMEOUT' });
    assert.equal(await present(f), true);
  });

  test(`D63 ${value} (gate 417 F2): a dangling link in place of the id folder means no id`, async t => {
    const homeDir = await home(t);
    const f = await fixture(t, { homeDir, lockTimeoutMs: 100 }); platform(t, value);
    const folder = join(idFile(homeDir, value), '..'); await fs.mkdir(join(folder, '..'), { recursive: true });
    await fs.symlink(join(homeDir, 'missing'), folder, 'dir');
    f.store.__id = f.id;
    assert.equal(await machineOf(f.store), undefined);
  });

  test(`D63 ${value}: a lock whose process is gone is reclaimed by the next write and by unlock`, async t => {
    const f = await fixture(t, { lockTimeoutMs: 2_000 }); platform(t, value);
    const asked = kill(t, pid => pid === GONE ? 'ESRCH' : undefined);
    await leftLock(f, value);
    const outcome = await f.store.mutateBoard(f.id, request([add('After the crash')]));
    assert.ok(outcome.warnings.some(w => w.code === 'W_STALE_LOCK'), 'the write reclaims the abandoned lock');
    assert.ok(asked.includes(GONE), 'the owner was asked for, not guessed');
    assert.equal(await present(f), false);
    await leftLock(f, value);
    assert.equal((await f.store.unlock(f.id)).data.unlocked, true, 'kanban unlock (no --force) removes it');
    assert.equal(await present(f), false);
  });

  test(`D63 ${value}: a dead owner younger than 60 seconds is reported dead and kept until then`, async t => {
    const f = await fixture(t, { lockTimeoutMs: 100 }); platform(t, value);
    kill(t, pid => pid === GONE ? 'ESRCH' : undefined);
    await leftLock(f, value, { createdAt: new Date().toISOString() });
    await assert.rejects(f.store.mutateBoard(f.id, request([add()])), error => {
      assert.equal(error.code, 'E_LOCK_TIMEOUT'); assert.equal(error.details.ownerState, 'dead');
      assert.match(error.nextAction, /Retry after \d+ seconds/); return true;
    });
    assert.equal(await present(f), true);
  });

  for (const [name, answer] of [['a live owner', null], ['a process of another user', 'EPERM']]) {
    test(`D63 ${value}: ${name} on the lock's pid keeps the lock`, async t => {
      const f = await fixture(t, { lockTimeoutMs: 100 }); platform(t, value);
      kill(t, pid => pid === GONE ? answer : undefined);
      await leftLock(f, value, { createdAt: new Date(Date.now() - 600_000).toISOString() });
      await assert.rejects(f.store.mutateBoard(f.id, request([add()])), { code: 'E_LOCK_TIMEOUT' });
      await assert.rejects(f.store.unlock(f.id), { code: 'E_LOCK_ACTIVE' });
      assert.equal(await present(f), true);
      // Forced offline recovery stays available: an unverifiable owner is never reported as confirmed live.
      assert.equal((await f.store.unlock(f.id, { force: true, offline: true })).data.unlocked, true);
    });
  }

  test(`D63 ${value}: a pid reused by another running process keeps the lock`, async t => {
    // No stub: the lock names this test's own pid, which is running — as a reused pid would be.
    const f = await fixture(t, { lockTimeoutMs: 100 }); platform(t, value);
    await leftLock(f, value, { pid: process.pid, createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    await assert.rejects(f.store.mutateBoard(f.id, request([add()])), error => {
      assert.equal(error.code, 'E_LOCK_TIMEOUT'); assert.equal(error.details.ownerState, 'unknown'); return true;
    });
    await assert.rejects(f.store.unlock(f.id), { code: 'E_LOCK_ACTIVE' });
    assert.equal(await present(f), true);
  });

  for (const [name, changes] of [
    ['another host (a shared folder)', { hostname: `${os.hostname()}-other` }],
    ['another boot of this host or another machine', { bootTime: bootTime() - 86_400_000 }],
    ['the other non-Linux platform', { platform: value === 'win32' ? 'darwin' : 'win32' }],
    ['a 0.2.2 lock without platform or boot time', { platform: undefined, bootTime: undefined }],
    ['a lock without a machine id (first D63 build)', { machineId: undefined }],
    ['another machine with the same host name and boot (gate 416 F1)', { machineId: randomUUID() }],
    ['a Linux lock on a shared folder', { platform: undefined, bootTime: undefined, procStartTicks: '12345', bootId: randomUUID(), pidNamespace: 'pid:[4026531836]' }],
  ]) {
    test(`D63 ${value}: a gone pid from ${name} is not reclaimed`, async t => {
      const f = await fixture(t, { lockTimeoutMs: 100 }); platform(t, value);
      kill(t, pid => pid === GONE ? 'ESRCH' : undefined);
      await leftLock(f, value, changes);
      await assert.rejects(f.store.mutateBoard(f.id, request([add()])), error => {
        assert.equal(error.code, 'E_LOCK_TIMEOUT'); assert.equal(error.details.ownerState, 'unknown'); return true;
      });
      await assert.rejects(f.store.unlock(f.id), { code: 'E_LOCK_ACTIVE' });
      assert.equal(await present(f), true);
    });
  }
}

test('D63 linux: the /proc check is unchanged and never asks process.kill', async t => {
  const f = await fixture(t, { lockTimeoutMs: 100 }); platform(t, 'linux');
  const asked = kill(t, () => 'ESRCH');
  let seen;
  await f.store.withBoardLock(f.id, async () => { seen = JSON.parse(await fs.readFile(lock(f), 'utf8')); });
  assert.deepEqual(Object.keys(seen), ['token', 'pid', 'procStartTicks', 'bootId', 'pidNamespace', 'hostname', 'createdAt']);
  // A Windows lock on a Linux host stays unknown, as before.
  await leftLock(f, 'win32');
  await assert.rejects(f.store.mutateBoard(f.id, request([add()])), error => {
    assert.equal(error.details.ownerState, 'unknown'); return true;
  });
  assert.deepEqual(asked, []);
});
