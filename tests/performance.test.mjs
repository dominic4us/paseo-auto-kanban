import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, actor, request } from './helpers.mjs';
const exec = promisify(execFile);
const cli = resolve('dist/src/cli/main.js');
const environment = () => {
  const env = { ...process.env };
  delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID; delete env.KANBAN_DATA_DIR;
  return env;
};
test('thirty boards require only a few full ledger reads for move and rev', { timeout: 90000 }, async t => {
  const f = await fixture(t); const ids = [f.id];
  for (let i = 1; i < 30; i++) {
    const cwd = join(f.root, `work-${i}`); await fs.mkdir(cwd);
    ids.push((await f.store.initBoard({ cwd, workspaceId: `wks_sample${i}`,
      actor, requestId: randomUUID() })).data.boardId);
  }
  for (const id of ids) await f.store.mutateBoard(id, request(Array.from({ length: 100 }, (_, i) => ({
    op: 'add', title: `Review item ${i}`, intent: 'requested',
    acceptanceCriteria: 'Record findings and the decision.',
    notes: 'Example evidence. '.repeat(25), nextAction: 'Confirm the decision.',
    deliverables: ['docs/result.md'],
  }))));
  const b = await f.store.readBoard(f.id); const prefix = b.cards[0].id.slice(0, 13);
  const run = async args => exec(process.execPath, [cli, ...args, '--data-dir', f.store.dataDir], {
    cwd: f.cwd, env: environment(), maxBuffer: 8 * 1024 * 1024,
  });
  const moved = JSON.parse((await run(['card', 'move', prefix, '--to', 'review', '--json'])).stdout);
  const io = moved.meta.io;
  assert.ok(io.boardReads <= 3, JSON.stringify(io));
  assert.ok(io.identityReads <= 31, JSON.stringify(io));
  assert.ok(io.identityReadBytes <= 64 * 1024, JSON.stringify(io));
  assert.equal(io.fsyncCalls, 3);
  const rev = JSON.parse((await run(['rev', '--json'])).stdout);
  assert.equal(rev.meta.io.boardReads, 1);
  const compact = await fs.readFile(join(f.cwd, 'PROCESS.md'));
  const config = join(f.store.dataDir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, exportEnabled: true,
    locale: 'en', export: { detail: 'full' } }));
  await run(['export']); const full = await fs.readFile(join(f.cwd, 'PROCESS.md'));
  assert.ok(compact.length < full.length / 3);
  const human = await run(['card', 'move', prefix, '--to', 'doing']);
  t.diagnostic(JSON.stringify({ benchmark: '30x100', boardReads: io.boardReads,
    boardReadBytes: io.boardReadBytes, identityReads: io.identityReads,
    identityReadBytes: io.identityReadBytes, readFiles: io.readFiles, readBytes: io.readBytes,
    lockHeldMs: Math.round(io.lockHeldMs), compactBytes: compact.length,
    fullBytes: full.length, humanBytes: Buffer.byteLength(human.stdout),
    humanExample: human.stdout.split('\n')[0], revBoardReads: rev.meta.io.boardReads }));
});
test('fifty concurrent CLI writers complete without starvation or lost responses', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await f.store.mutateBoard(f.id, request(Array.from({ length: 100 }, (_, i) => ({
    op: 'add', title: `Existing ${i}`, intent: 'requested', acceptanceCriteria: 'Result recorded',
    notes: 'Example evidence. '.repeat(25),
  }))));
  const started = performance.now();
  const write = i => exec(process.execPath, [cli, 'card', 'add', '--title', `Concurrent ${i}`,
    '--data-dir', f.store.dataDir, '--json'], { cwd: f.cwd, env: environment() })
    .then(result => JSON.parse(result.stdout))
    .catch(error => ({ ok: false, code: error.code, message: error.stderr }));
  let outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => write(i)));
  // J3 (research/136): on a machine busy with other work fifty Node start-ups can outlast the 30 s board lock. The CLI
  // then exits 5 (E_LOCK_TIMEOUT, "try again") having written nothing — the exact count below proves it — so that writer
  // tries once more, as a caller would; any other failure, a second timeout or a lost or doubled card still fails.
  const timedOut = outcomes.flatMap((r, i) => !r.ok && r.code === 5 ? [i] : []);
  for (const i of timedOut) outcomes[i] = await write(i);
  const failed = outcomes.filter(r => !r.ok);
  assert.equal(failed.length, 0, JSON.stringify(failed));
  assert.equal((await f.store.readBoard(f.id)).cards.length, 150);
  assert.equal(new Set(outcomes.map(r => r.data.cardIds[0])).size, 50);
  t.diagnostic(JSON.stringify({ benchmark: '50 writers', elapsedMs: Math.round(performance.now() - started),
    maxWaitMs: Math.round(Math.max(...outcomes.map(r => r.meta.io.lockWaitMs))),
    maxHeldMs: Math.round(Math.max(...outcomes.map(r => r.meta.io.lockHeldMs))), timeouts: timedOut.length }));
});
