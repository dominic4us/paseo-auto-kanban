import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openStore, parseJson, stableStringify, builtinTemplate } from '../dist/server/core/index.js';
import { fixture, request, add, actor } from './helpers.mjs';
const file = (f) => join(f.store.dataDir, 'boards', `${f.id}.json`);
const archive = (f) => join(f.store.dataDir, '_archive', f.id);
const lock = (f) => join(f.store.dataDir, 'boards', `${f.id}.lock`);
const digest = data => createHash('sha256').update(data).digest('hex');
async function snapshot(root) {
  const result = {};
  const visit = async dir => { for (const name of await fs.readdir(dir)) { const p = join(dir,
       name);
       const stat = await fs.lstat(p);
       if (stat.isDirectory()) await visit(p);
       else result[p] = { mtime: stat.mtimeMs,
       hash: digest(await fs.readFile(p)) };
       } };
  await visit(root); return result;
}
async function launch(t, options) {
  const environment = { ...process.env }; delete environment.PASEO_AGENT_CWD; delete environment.PASEO_AGENT_ID;
  const child = fork(resolve('tests/fixtures/store-worker.mjs'), [JSON.stringify(options)], { env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.stdout.resume();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); } });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Worker exited early: ${code} ${stderr}`))); });
  return child;
}
async function concurrent(t, options) {
  const children = await Promise.all(options.map(o => launch(t, o)));
  const started = performance.now();
  const output = await Promise.all(children.map(child => new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`Worker exit ${code}`)); }); child.send({ start: true });
  })));
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit') : undefined));
  t.diagnostic(`Concurrent processes: ${children.length}; elapsed: ${Math.round(performance.now() - started)} ms`);
  for (const item of output) assert.deepEqual(item.diagnostics, { activeTimers: 0, activeWatchers: 0 });
  return output;
}
async function seed(store, id, count = 100) { return store.mutateBoard(id, request(Array.from({ length: count }, (_, i) => add(`Task ${i}`)))); }
async function deadLock(t, f) {
  const child = await launch(t, { dataDir: f.store.dataDir, id: f.id, hold: true });
  const held = once(child, 'message'); child.send({ start: true }); await held;
  child.kill('SIGKILL'); await once(child, 'exit');
  const owner = JSON.parse(await fs.readFile(lock(f), 'utf8')); owner.createdAt = new Date(Date.now() - 61000).toISOString();
  await fs.writeFile(lock(f), JSON.stringify(owner)); return owner;
}

test('configuration defaults, locale, template snapshot and non-writing open', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.readConfig(), { schemaVersion: 1, exportEnabled: true, locale: 'en', export: { detail: 'compact' } });
  const config = join(f.store.dataDir, 'config.json'); await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, exportEnabled: true, locale: 'ko' }));
  const result = await f.store.initBoard({ cwd: f.cwd, workspaceId: 'wks_example02', actor, requestId: randomUUID() });
  assert.equal((await f.store.readBoard(result.data.boardId)).template.stages[0].name, '대기');
  assert.equal((await f.store.readBoard(f.id)).template.stages[0].name, 'Waiting');
  const empty = join(f.root, 'absent'); const store = await openStore({ dataDir: empty });
  assert.deepEqual(await store.listBoards(), []); assert.equal((await store.readConfig()).locale, 'en'); await assert.rejects(fs.stat(empty), { code: 'ENOENT' });
});
test('optional CAS uses latest state and only replaces specified fields', async t => {
  const f = await fixture(t); const created = await f.store.mutateBoard(f.id, request([add('A'), add('B')])); const [a, b] = created.data.cardIds;
  await f.store.mutateBoard(f.id, request([{ op: 'update', id: a, patch: { notes: 'First' } }]));
  await f.store.mutateBoard(f.id, request([{ op: 'update', id: b, patch: { nextAction: 'Second' } }]));
  await f.store.mutateBoard(f.id, request([{ op: 'update', id: a, patch: { notes: 'Last' } }]));
  const board = await f.store.readBoard(f.id); assert.equal(board.cards[0].notes, 'Last'); assert.equal(board.cards[1].nextAction, 'Second');
  await assert.rejects(f.store.mutateBoard(f.id, request([{ op: 'update', id: a, patch: { notes: 'Old' } }], { ifRevision: created.data.revision })), { code: 'E_REVISION_CONFLICT' });
});
test('receipts replay before CAS and transitions, and reject reused keys', async t => {
  const f = await fixture(t); const input = request([add()], { ifRevision: await f.store.getRevision(f.id) });
  const first = await f.store.mutateBoard(f.id, input); const id = first.data.cardIds[0];
  await f.store.mutateBoard(f.id, request([{ op: 'archive', id }]));
  const replay = await f.store.mutateBoard(f.id,
       input);
       assert.equal(replay.data.replayed,
       true);
       assert.equal(replay.data.revision,
       first.data.revision);
       assert.deepEqual(replay.data.cardIds,
       [id]);
       assert.equal(replay.meta.io.boardWrites,
       0);
  await assert.rejects(f.store.mutateBoard(f.id, { ...input, operations: [add('Different')] }), { code: 'E_REQUEST_REUSED' });
});
test('receipt eviction, no-op receipts and CAS boundaries are explicit', async t => {
  const f = await fixture(t);
       const input = request([add()],
       { ifRevision: await f.store.getRevision(f.id) });
       const created = await f.store.mutateBoard(f.id,
       input);
       const id = created.data.cardIds[0];
  const b = await f.store.readBoard(f.id); const original = b.receipts.find(r => r.requestId === input.requestId);
  b.receipts = [original,
       ...Array.from({ length: 999 },
       () => ({ requestId: randomUUID(),
       digest: 'a'.repeat(64),
       revision: b.revision,
       cardIds: [] }))];
       await fs.writeFile(file(f),
       stableStringify(b));
  await f.store.mutateBoard(f.id, request([{ op: 'move', id, to: 'doing' }]));
  assert.equal((await f.store.readBoard(f.id)).receipts.length, 1000);
  await assert.rejects(f.store.mutateBoard(f.id, input), { code: 'E_REVISION_CONFLICT' });
  const unguarded = { ...input }; delete unguarded.ifRevision;
  const repeated = await f.store.mutateBoard(f.id, unguarded); assert.equal(repeated.data.changed, true); assert.equal((await f.store.readBoard(f.id)).cards.length, 2);
  const same = request([{ op: 'move', id, to: 'doing' }]); const rev = await f.store.getRevision(f.id);
  assert.equal((await f.store.mutateBoard(f.id, same)).data.changed, false); assert.ok(!(await f.store.readBoard(f.id)).receipts.some(r => r.requestId === same.requestId));
  await f.store.mutateBoard(f.id, request([{ op: 'move', id, to: 'review' }]));
  await assert.rejects(f.store.mutateBoard(f.id, { ...same, ifRevision: rev }), { code: 'E_REVISION_CONFLICT' });
  assert.equal((await f.store.mutateBoard(f.id, same)).data.changed, true);
});
test('no-op, reads and doctor preserve every business file and mtime', async t => {
  const f = await fixture(t); const made = await f.store.mutateBoard(f.id, request([add()])); const id = made.data.cardIds[0];
  const before = await snapshot(f.store.dataDir);
  const plain = await f.store.mutateBoard(f.id, request([{ op: 'move', id, to: 'todo' }]));
  assert.equal(plain.data.changed, false); assert.equal(plain.meta.io.boardWrites, 0); assert.equal(plain.meta.io.backupWrites, 0); assert.equal(plain.meta.io.fsyncCalls, 0);
  const guarded = await f.store.mutateBoard(f.id, request([{ op: 'update', id, patch: { title: 'Example task' } }], { ifRevision: made.data.revision }));
  assert.equal(guarded.meta.io.lockAcquisitions, 0);
  await f.store.getRevision(f.id); await f.store.readBoard(f.id); await f.store.listBoards(); await f.store.doctor(f.id);
  assert.deepEqual(await snapshot(f.store.dataDir), before); assert.deepEqual(f.store.diagnostics(), { activeTimers: 0, activeWatchers: 0 });
});
test('hardlink backups preserve the old inode and normal commit syncs exactly three times', async t => {
  const f = await fixture(t); const old = await fs.readFile(file(f)); const inode = (await fs.stat(file(f))).ino;
  const result = await f.store.mutateBoard(f.id, request([add()]));
  assert.equal(result.meta.io.fsyncCalls, 3); assert.equal(result.meta.io.backupLinks, 1); assert.equal(result.meta.io.backupWrites, 0);
  assert.equal(result.meta.io.bytesWritten, (await fs.stat(file(f))).size);
  const backups = await fs.readdir(archive(f)); const backup = join(archive(f), backups[0]);
  assert.equal((await fs.stat(backup)).ino, inode); assert.notEqual((await fs.stat(file(f))).ino, inode); assert.deepEqual(await fs.readFile(backup), old);
  assert.equal((await fs.stat(file(f))).mode & 0o777, 0o600);
});
for (const code of ['EXDEV', 'EPERM']) test(`copy fallback for ${code} is explicit and syncs four times`, async t => {
  const f = await fixture(t, { fileSystem: { link: async () => { throw Object.assign(new Error('Synthetic link failure'), { code }); } } });
  const oldSize = (await fs.stat(file(f))).size; const result = await f.store.mutateBoard(f.id, request([add()]));
  assert.equal(result.meta.io.fsyncCalls,
       4);
       assert.equal(result.meta.io.backupWrites,
       1);
       assert.equal(result.meta.io.backupLinks,
       0);
       assert.ok(result.warnings.some(w => w.code === 'W_BACKUP_COPY'));
  assert.equal(result.meta.io.bytesWritten, oldSize + (await fs.stat(file(f))).size);
});
test('backups and movement history have count-based retention, including copy pruning', async t => {
  const f = await fixture(t, { fileSystem: { link: async () => { throw Object.assign(new Error('Synthetic'), { code: 'EXDEV' }); } } });
  const made = await f.store.mutateBoard(f.id, request([add()])); const id = made.data.cardIds[0];
  for (let i = 0; i < 22; i++) { const result = await f.store.mutateBoard(f.id, request([{ op: 'update', id, patch: { notes: String(i) } }])); assert.equal(result.meta.io.fsyncCalls, 4); }
  assert.equal((await fs.readdir(archive(f))).length, 20);
});
test('failed batches and input limits leave the ledger untouched', async t => {
  const f = await fixture(t); const before = await fs.readFile(file(f));
  await assert.rejects(f.store.mutateBoard(f.id, request([add(), { op: 'move', id: `card_${randomUUID()}`, to: 'doing' }])), { code: 'E_NOT_FOUND' });
  await assert.rejects(f.store.mutateBoard(f.id, request(Array.from({ length: 101 }, () => add()))));
  await assert.rejects(f.store.mutateBoard(f.id, request([{ ...add(), notes: 'x'.repeat(1048577) }])), { code: 'E_LIMIT' });
  assert.deepEqual(await fs.readFile(file(f)), before);
  const batch = await seed(f.store, f.id); assert.equal(batch.meta.io.boardWrites, 1); assert.equal(batch.meta.io.backupLinks, 1); assert.equal((await f.store.readBoard(f.id)).cards.length, 100);
});
test('corrupt input and unknown schemas preserve original bytes; doctor reports them', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from('{'), Buffer.from('{"schemaVersion":1,"schemaVersion":1}'), Buffer.from([0xff, 0xfe])]) {
    await fs.writeFile(file(f), bytes); await assert.rejects(f.store.readBoard(f.id), { code: 'E_CORRUPT' });
    await assert.rejects(f.store.mutateBoard(f.id, request([add()])), { code: 'E_CORRUPT' });
    const report = await f.store.doctor(f.id); assert.ok(report.data.checks.some(c => c.status === 'error'));
    assert.deepEqual(await fs.readFile(file(f)), bytes);
  }
});
test('future schema versions fail without overwriting the file', async t => {
  const f = await fixture(t); const b = await f.store.readBoard(f.id); b.schemaVersion = 99; const bytes = JSON.stringify(b); await fs.writeFile(file(f), bytes);
  await assert.rejects(f.store.readBoard(f.id), { code: 'E_SCHEMA_VERSION' }); assert.equal(await fs.readFile(file(f), 'utf8'), bytes);
});
test('forbidden roots, symlinks and missing workspace paths are handled safely', async t => {
  const f = await fixture(t); const forbidden = join(f.root, 'protected'); await fs.mkdir(forbidden);
  await assert.rejects(openStore({ dataDir: join(forbidden, 'data'), forbiddenRoots: [forbidden] }), { code: 'E_PATH_FORBIDDEN' });
  const store = await openStore({ dataDir: f.store.dataDir, forbiddenRoots: [forbidden] });
  await assert.rejects(store.initBoard({ cwd: forbidden, actor, requestId: randomUUID() }), { code: 'E_PATH_FORBIDDEN' });
  const alias = join(f.root, 'alias'); await fs.symlink(forbidden, alias);
  await assert.rejects(store.assertAllowedPath(join(alias, 'PROCESS.md')), { code: 'E_PATH_FORBIDDEN' });
  await assert.rejects(store.initBoard({ cwd: join(f.root, 'missing'), actor, requestId: randomUUID() }), { code: 'E_CWD_MISSING' });
  await fs.rmdir(f.cwd); assert.equal((await store.resolveWorkspace(f.cwd)).id, f.id); assert.equal((await store.mutateBoard(f.id, request([add()]))).data.changed, true);
  const external = join(f.root, 'outside.json'); await fs.writeFile(external, '{}'); await fs.unlink(file(f)); await fs.symlink(external, file(f));
  await assert.rejects(store.mutateBoard(f.id, request([add()]))); assert.equal(await fs.readFile(external, 'utf8'), '{}');
});
test('workspace identity permits shared cwd, prefers activity, and keeps local ids stable', async t => {
  const f = await fixture(t); const second = await f.store.initBoard({ cwd: f.cwd, workspaceId: 'wks_example02', actor, requestId: randomUUID() });
  assert.notEqual(second.data.boardId, f.id); assert.ok(second.warnings.some(w => w.code === 'W_SHARED_CWD'));
  await assert.rejects(f.store.resolveWorkspace(f.cwd), { code: 'E_WORKSPACE_AMBIGUOUS' });
  const b = await f.store.readBoard(f.id); b.workspaceStatus = 'inactive'; await fs.writeFile(file(f), stableStringify(b));
  assert.equal((await f.store.resolveWorkspace(f.cwd)).id, second.data.boardId);
  const nested = join(f.cwd, 'child'); await fs.mkdir(nested); const local = await f.store.initBoard({ cwd: nested, actor, requestId: randomUUID() });
  assert.equal((await f.store.resolveCurrentWorkspace(undefined, { PASEO_AGENT_CWD: nested }, f.root)).id, local.data.boardId);
  assert.equal((await f.store.initBoard({ cwd: nested, actor, requestId: randomUUID() })).data.changed, false);
  await assert.rejects(f.store.resolveCurrentWorkspace(undefined, { PASEO_AGENT_CWD: 'relative' }, f.cwd), { code: 'E_VALIDATION' });
});
test('a manually rebound board id is retained and its old candidate can be reused safely', async t => {
  const f = await fixture(t); const b = await f.store.readBoard(f.id); b.workspaceId = 'wks_rebound01'; await fs.writeFile(file(f), stableStringify(b));
  assert.equal((await f.store.initBoard({ cwd: f.cwd, workspaceId: 'wks_rebound01', actor, requestId: randomUUID() })).data.boardId, f.id);
  const fresh = await f.store.initBoard({ cwd: f.cwd, workspaceId: 'wks_example01', actor, requestId: randomUUID() }); assert.notEqual(fresh.data.boardId, f.id);
});
test('duplicate workspace ids are corruption but shared paths are allowed', async t => {
  const f = await fixture(t); const b = await f.store.readBoard(f.id); b.id = `board_${'b'.repeat(64)}`; await fs.writeFile(join(f.store.dataDir, 'boards', `${b.id}.json`), stableStringify(b));
  await assert.rejects(f.store.listBoards(), { code: 'E_CORRUPT' }); assert.ok((await f.store.doctor(f.id)).data.checks.some(c => c.code === 'E_CORRUPT'));
});
test('workspace map and card prefix readers do not mutate data', async t => {
  const f = await fixture(t); const map = join(f.root, 'map.json'); await fs.writeFile(map, JSON.stringify([{ workspaceId: 'wks_example01', cwd: f.cwd, project: 'Example Project' }]));
  assert.deepEqual(await f.store.readWorkspaceMap(map, f.cwd), { workspaceId: 'wks_example01', workspaceStatus: 'active' });
  const made = await f.store.mutateBoard(f.id, request([add()])); const id = made.data.cardIds[0]; assert.equal(await f.store.resolveCardPrefix(f.id, id.slice(0, 13)), id);
  await assert.rejects(f.store.resolveCardPrefix(f.id, 'card_a'), { code: 'E_VALIDATION' });
  const b = await f.store.readBoard(f.id);
       const extra = structuredClone(b.cards[0]);
       extra.id = `${id.slice(0,
       14)}ffff-4fff-8fff-ffffffffffff`;
       b.cards.push(extra);
       await fs.writeFile(file(f),
       stableStringify(b));
  await assert.rejects(f.store.resolveCardPrefix(f.id, id.slice(0, 13)), { code: 'E_CARD_AMBIGUOUS' });
});
test('scale thresholds warn without rejecting storage', async t => {
  const f = await fixture(t); for (let i = 0; i < 3; i++) await seed(f.store, f.id);
  const result = await f.store.mutateBoard(f.id, request([add()])); assert.ok(result.warnings.some(w => w.code === 'W_SCALE')); assert.equal((await f.store.readBoard(f.id)).cards.length, 301);
  const b = await f.store.readBoard(f.id); for (const card of b.cards) card.notes = 'x'.repeat(7500); await fs.writeFile(file(f), stableStringify(b));
  const large = await f.store.mutateBoard(f.id,
       request([{ op: 'update',
       id: b.cards[0].id,
       patch: { nextAction: 'Review' } }]));
       assert.ok(large.warnings.some(w => w.code === 'W_SCALE'));
       assert.ok((await fs.stat(file(f))).size > 2097152);
});
test('stale locks are reclaimed only after death and age checks', async t => {
  const f = await fixture(t); const owner = await deadLock(t, f);
  const outcome = await f.store.mutateBoard(f.id, request([add()])); assert.ok(outcome.warnings.some(w => w.code === 'W_STALE_LOCK'));
  assert.ok(owner.procStartTicks); await assert.rejects(fs.stat(lock(f)), { code: 'ENOENT' });
  await deadLock(t, f); const unlocked = await f.store.unlock(f.id); assert.equal(unlocked.data.unlocked, true);
  assert.equal((await f.store.unlock(f.id)).data.unlocked, false);
});
test('live locks, partial guards and namespace mismatches cannot be stolen', async t => {
  const f = await fixture(t, { lockTimeoutMs: 100 }); const child = await launch(t, { dataDir: f.store.dataDir, id: f.id, hold: true });
  const held = once(child, 'message'); child.send({ start: true }); await held;
  const record = JSON.parse(await fs.readFile(lock(f), 'utf8')); record.createdAt = new Date(Date.now() - 120000).toISOString(); await fs.writeFile(lock(f), JSON.stringify(record));
  await assert.rejects(f.store.mutateBoard(f.id, request([add()])), { code: 'E_LOCK_TIMEOUT' });
  await assert.rejects(f.store.unlock(f.id, { force: true, offline: true }), { code: 'E_LOCK_ACTIVE' });
  child.send({ release: true }); await once(child, 'exit');
  await fs.writeFile(`${lock(f)}.claim`, '{'); const before = await fs.readFile(file(f));
  await assert.rejects(f.store.mutateBoard(f.id, request([add()])), { code: 'E_LOCK_TIMEOUT' });
  await assert.rejects(f.store.unlock(f.id, { force: true }), { code: 'E_VALIDATION' });
  await f.store.unlock(f.id, { force: true, offline: true }); assert.deepEqual(await fs.readFile(file(f)), before);
  record.pidNamespace = 'unknown-namespace'; await fs.writeFile(lock(f), JSON.stringify(record));
  await assert.rejects(f.store.unlock(f.id), { code: 'E_LOCK_ACTIVE' }); await f.store.unlock(f.id, { force: true, offline: true });
  assert.deepEqual(f.store.diagnostics(), { activeTimers: 0, activeWatchers: 0 });
});
test('process start mismatch permits recovery without killing the reused pid', async t => {
  const f = await fixture(t); const child = await launch(t, { dataDir: f.store.dataDir, id: f.id, hold: true });
  const held = once(child, 'message'); child.send({ start: true }); await held; const record = JSON.parse(await fs.readFile(lock(f), 'utf8'));
  child.send({ release: true }); await once(child, 'exit');
  record.pid = process.pid; record.procStartTicks = '0'; record.createdAt = new Date(Date.now() - 61000).toISOString(); await fs.writeFile(lock(f), JSON.stringify(record));
  const outcome = await f.store.unlock(f.id); assert.equal(outcome.data.unlocked, true);
});
test('normal operations leave no timers or watchers registered', async t => {
  const f = await fixture(t); const before = process.getActiveResourcesInfo().filter(x => /Timeout|FSWatcher|FSEvent|StatWatcher/.test(x));
  await f.store.mutateBoard(f.id, request([add()])); await f.store.readBoard(f.id); await f.store.doctor(f.id);
  assert.deepEqual(f.store.diagnostics(),
       { activeTimers: 0,
       activeWatchers: 0 });
       assert.deepEqual(process.getActiveResourcesInfo().filter(x => /Timeout|FSWatcher|FSEvent|StatWatcher/.test(x)),
       before);
  const source = await fs.readFile('server/core/store.ts', 'utf8'); assert.doesNotMatch(source, /\bsetInterval\s*\(|\bwatch(?:File)?\s*\(/);
});
test('different boards: twenty separate processes commit without a global writer lock', { timeout: 90000 }, async t => {
  const f = await fixture(t); const ids = [f.id];
  for (let i = 1; i < 20; i++) ids.push((await f.store.initBoard({ cwd: f.cwd, workspaceId: `wks_parallel${i}`, actor, requestId: randomUUID() })).data.boardId);
  for (const id of ids) await seed(f.store, id);
  const outcomes = await concurrent(t, ids.map((id, i) => ({ dataDir: f.store.dataDir, id, operations: [add(`Concurrent ${i}`)] })));
  assert.equal(outcomes.filter(x => x.ok).length, 20);
  for (const id of ids) assert.equal((await f.store.readBoard(id)).cards.length, 101);
});
test('same board: twenty unguarded additions all survive', { timeout: 90000 }, async t => {
  const f = await fixture(t); await seed(f.store, f.id);
  const outcomes = await concurrent(t, Array.from({ length: 20 }, (_, i) => ({ dataDir: f.store.dataDir, id: f.id, operations: [add(`Concurrent ${i}`)] })));
  assert.equal(outcomes.filter(x => x.ok).length, 20); const b = await f.store.readBoard(f.id);
  assert.equal(b.cards.length, 120); assert.equal(new Set(b.cards.map(c => c.id)).size, 120);
  assert.equal(new Set(outcomes.map(x => x.result.data.requestId)).size, 20);
});
test('explicit CAS: one success and nineteen conflicts across separate processes', { timeout: 90000 }, async t => {
  const f = await fixture(t); await seed(f.store, f.id); const revision = await f.store.getRevision(f.id);
  const outcomes = await concurrent(t, Array.from({ length: 20 }, (_, i) => ({ dataDir: f.store.dataDir, id: f.id, ifRevision: revision, operations: [add(`Guarded ${i}`)] })));
  assert.equal(outcomes.filter(x => x.ok).length, 1); assert.equal(outcomes.filter(x => x.code === 'E_REVISION_CONFLICT').length, 19); assert.equal((await f.store.readBoard(f.id)).cards.length, 101);
});
for (const guarded of [false, true]) test(`explicit request id: one change and nineteen replays (CAS ${guarded})`, { timeout: 90000 }, async t => {
  const f = await fixture(t); await seed(f.store, f.id); const requestId = randomUUID(); const revision = await f.store.getRevision(f.id);
  const options = { dataDir: f.store.dataDir, id: f.id, requestId, operations: [add('Same request')], ...(guarded ? { ifRevision: revision } : {}) };
  const outcomes = await concurrent(t, Array.from({ length: 20 }, () => options));
  assert.equal(outcomes.filter(x => x.ok && x.result.data.changed).length,
       1);
       assert.equal(outcomes.filter(x => x.ok && x.result.data.replayed).length,
       19);
       assert.equal((await f.store.readBoard(f.id)).cards.length,
       101);
});
test('twenty stale-lock contenders cannot steal a replacement lock', { timeout: 90000 }, async t => {
  const f = await fixture(t); await seed(f.store, f.id); await deadLock(t, f);
  const outcomes = await concurrent(t, Array.from({ length: 20 }, (_, i) => ({ dataDir: f.store.dataDir, id: f.id, operations: [add(`Reclaimed ${i}`)] })));
  assert.equal(outcomes.filter(x => x.ok).length,
       20);
       assert.equal(outcomes.flatMap(x => x.result.warnings).filter(w => w.code === 'W_STALE_LOCK').length,
       1);
       assert.equal((await f.store.readBoard(f.id)).cards.length,
       120);
});

test('more than thirty boards warn without blocking a known board', async t => {
  const f = await fixture(t); const base = await f.store.readBoard(f.id);
  for (let i = 0;
       i < 30;
       i++) { const b = structuredClone(base);
       b.workspaceId = `wks_fixture${i}`;
       b.id = `board_${digest(b.workspaceId)}`;
       await fs.writeFile(join(f.store.dataDir,
       'boards',
       `${b.id}.json`),
       stableStringify(b));
       }
  const changed = await f.store.mutateBoard(f.id, request([add()])); assert.ok(changed.warnings.some(w => w.code === 'W_SCALE'));
  assert.ok((await f.store.boardWarnings(f.id)).some(w => w.code === 'W_SCALE'));
  assert.equal((await f.store.listBoards()).length, 31);
});
test('non-fallback backup errors and conflicting backups preserve the original board', async t => {
  const f = await fixture(t, { fileSystem: { link: async () => { throw Object.assign(new Error('Synthetic'), { code: 'ENOSPC' }); } } });
  const before = await fs.readFile(file(f)); await assert.rejects(f.store.mutateBoard(f.id, request([add()])), { code: 'E_IO' }); assert.deepEqual(await fs.readFile(file(f)), before);
  const normal = await openStore({ dataDir: f.store.dataDir }); const revision = await normal.getRevision(f.id);
  await fs.writeFile(join(archive(f), `${revision.replace(':', '-')}.json`), '{}');
  await assert.rejects(normal.mutateBoard(f.id, request([add()])), { code: 'E_CORRUPT' }); assert.deepEqual(await fs.readFile(file(f)), before);
});
test('user templates remain snapshots when registry versions change or disappear', async t => {
  const f = await fixture(t); const custom = { ...builtinTemplate(), id: 'custom', name: 'Custom workflow' }; const directory = join(f.store.dataDir, 'templates');
  await fs.writeFile(join(directory, 'custom@1.json'), stableStringify(custom));
  const initialized = await f.store.initBoard({ cwd: f.cwd, workspaceId: 'wks_custom01', template: 'custom', actor, requestId: randomUUID() });
  const saved = await f.store.readBoard(initialized.data.boardId); const second = { ...custom, version: 2, name: 'New workflow' };
  await fs.writeFile(join(directory, 'custom@2.json'), stableStringify(second)); assert.equal((await f.store.readTemplate('custom')).version, 2);
  await fs.unlink(join(directory, 'custom@1.json')); assert.deepEqual(await f.store.readBoard(saved.id), saved);
  await assert.rejects(f.store.mutateBoard(f.id, { ...request([add()]), unknown: true }), { code: 'E_VALIDATION' });
});
test('simultaneous initialization of the same workspace creates only one board', { timeout: 90000 }, async t => {
  const f = await fixture(t); const options = { dataDir: f.store.dataDir, init: { cwd: f.cwd, workspaceId: 'wks_initialize01' } };
  const outcomes = await concurrent(t, Array.from({ length: 20 }, () => options));
  assert.equal(outcomes.filter(x => x.ok).length,
       20);
       assert.equal(outcomes.filter(x => x.result.data.changed).length,
       1);
       assert.equal(new Set(outcomes.map(x => x.result.data.boardId)).size,
       1);
       assert.equal((await f.store.listBoards()).length,
       2);
});

test('path-only initialization reuses an existing external workspace and reports ambiguity', async t => {
  const f = await fixture(t);
  const reused = await f.store.initBoard({ cwd: f.cwd, actor, requestId: randomUUID() });
  assert.equal(reused.data.boardId, f.id); assert.equal(reused.data.changed, false);
  await f.store.initBoard({ cwd: f.cwd, workspaceId: 'wks_second01', actor, requestId: randomUUID() });
  await assert.rejects(f.store.initBoard({ cwd: f.cwd, actor, requestId: randomUUID() }), { code: 'E_WORKSPACE_AMBIGUOUS' });
  await fs.rmdir(f.cwd); assert.ok((await f.store.doctor(f.id)).warnings.some(w => w.code === 'W_CWD_MISSING'));
});

test('corrupted old backups are unmanaged, preserved, and do not block future writes', async t => {
  const f = await fixture(t);
  const made = await f.store.mutateBoard(f.id, request([add()]));
  const id = made.data.cardIds[0];
  const old = join(archive(f), f.initial.data.revision.replace(':', '-') + '.json');
  await fs.writeFile(old, 'corrupted old backup');
  for (let i = 0; i < 21; i++) {
    const changed = await f.store.mutateBoard(f.id, request([{ op: 'update', id, patch: { notes: `Result ${i}` } }]));
    assert.equal(changed.committed, true);
    assert.ok(changed.warnings.some(w => w.code === 'W_BACKUP_UNMANAGED'));
  }
  assert.equal(await fs.readFile(old, 'utf8'), 'corrupted old backup');
  assert.equal((await fs.readdir(archive(f))).length, 21);
  assert.ok((await f.store.doctor(f.id)).data.checks.some(c => c.target === old && c.status === 'error'));
});
test('a freshly dead owner reports the precise reclaim time instead of a force loop', async t => {
  const f = await fixture(t, { lockTimeoutMs: 100 });
  const owner = await deadLock(t, f);
  owner.createdAt = new Date().toISOString(); await fs.writeFile(lock(f), JSON.stringify(owner));
  for (const action of [() => f.store.unlock(f.id), () => f.store.mutateBoard(f.id, request([add()]))]) {
    await assert.rejects(action(), error => {
      assert.equal(error.details.ownerState, 'dead');
      assert.equal(error.details.reclaimableAtMs, Date.parse(owner.createdAt) + 60000);
      assert.ok(error.details.waitedMs >= 0); assert.ok(error.details.observedOwners >= 1);
      assert.match(error.nextAction, /Retry after \d+ seconds; the owner is confirmed dead/);
      assert.doesNotMatch(error.nextAction, /force/); return true;
    });
  }
  const report = await f.store.doctor(f.id);
  assert.ok(report.data.checks.some(c => c.code === 'W_LOCK_PRESENT' && /owner is confirmed dead/.test(c.nextAction)));
});
test('a release failure cannot hide a successful durable commit', async t => {
  const f = await fixture(t); const original = f.store.removeOwned.bind(f.store);
  f.store.removeOwned = async (file, expected) => {
    await original(file, expected);
    if (file.endsWith('.lock')) throw new Error('Synthetic release failure');
  };
  const result = await f.store.mutateBoard(f.id, request([add()]));
  assert.equal(result.committed, true); assert.equal(result.data.changed, true);
  assert.ok(result.warnings.some(w => w.code === 'W_LOCK_RELEASE'));
  assert.equal((await f.store.readBoard(f.id)).cards.length, 1);
});
test('doctor reports workspace export leftovers without removing them', async t => {
  const f = await fixture(t); const target = join(f.cwd, '.PROCESS.md.tmp-example');
  await fs.writeFile(target, 'Synthetic incomplete output');
  const report = await f.store.doctor(f.id);
  assert.ok(report.data.checks.some(c => c.code === 'W_RESIDUAL_FILE' && c.target === target));
  assert.equal(await fs.readFile(target, 'utf8'), 'Synthetic incomplete output');
});
