import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { exportBoard, exportCommittedBoard, openStore } from '../dist/server/core/index.js';
import { fixture, add, request } from './helpers.mjs';

test('comparison failure never writes, including ENOENT from a previously observed file', async t => {
  const f = await fixture(t); await exportBoard(f.store, f.id); const target = join(f.cwd, 'PROCESS.md'); const original = await fs.readFile(target); const before = await fs.stat(target);
  for (const code of ['EACCES', 'EIO', 'ENOENT']) {
    const result = await exportBoard(f.store, f.id, { readExisting: async () => { throw Object.assign(new Error('Synthetic comparison failure'), { code }); } });
    assert.equal(result.data.status, 'failed'); assert.equal(result.meta.io.exportWrites, 0); assert.equal((await fs.stat(target)).mtimeMs, before.mtimeMs); assert.deepEqual(await fs.readFile(target), original);
  }
});
test('automatic output runs inside the commit lock and preserves ledger success on effect failure', async t => {
  const f = await fixture(t); const store = await openStore({ dataDir: f.store.dataDir, afterCommit: async (board, lockedStore) => {
    assert.equal((await fs.lstat(join(f.store.dataDir, 'boards', `${board.id}.lock`))).isFile(), true);
    return exportCommittedBoard(board, lockedStore);
  } });
  const result = await store.mutateBoard(f.id, request([add()])); assert.equal(result.data.export, 'written'); assert.equal(result.meta.io.fsyncCalls, 3); assert.equal(result.meta.io.exportWrites, 1);
  const broken = await openStore({ dataDir: f.store.dataDir, afterCommit: async () => { throw new Error('Synthetic effect failure'); } });
  const saved = await broken.mutateBoard(f.id, request([add('Saved despite output failure')])); assert.equal(saved.committed, true); assert.equal(saved.data.export, 'failed'); assert.equal((await broken.readBoard(f.id)).cards.length, 2);
});
test('parallel explicit export and mutation cannot replace a newer revision with an older view', async t => {
  const f = await fixture(t); const store = await openStore({ dataDir: f.store.dataDir, afterCommit: exportCommittedBoard });
  const results = await Promise.all([store.mutateBoard(f.id, request([add()])), exportBoard(store, f.id)]);
  assert.equal(results[0].committed, true); const b = await store.readBoard(f.id); assert.ok((await fs.readFile(join(f.cwd, 'PROCESS.md'), 'utf8')).includes(b.revision));
});
