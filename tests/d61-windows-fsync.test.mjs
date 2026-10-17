import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, exportCommittedBoard } from '../dist/server/core/index.js';
import { createAutoCards } from '../dist/server/auto-cards.js';
import { createEnsureHandler } from '../dist/server/mutations.js';
import { readLocale } from '../dist/server/handlers.js';
import { actor, request, add } from './helpers.mjs';

/**
 * D61: on a Windows server no board was ever made — the automatic board failed with `EPERM: operation not permitted,
 * fsync`. Windows flushes through FlushFileBuffers, which needs a handle with write access: a folder, or a file opened
 * read-only, is refused with EPERM. These tests make this host behave so (the platform says win32, and a flush of a
 * folder or of a read-only handle throws EPERM) and check that a board, its cards and the automatic board are made.
 */
const START = '2026-10-17T00:00:00.000Z';
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM', errno: -4048, syscall: 'fsync' });

/** Every flush, in order, with what the handle was: [kind, path]; `refuse(kind, path)` returns an error to throw instead. */
async function flushes(t, refuse = () => null) {
  const probe = await fs.open(import.meta.filename, 'r');
  const FileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  const opened = new WeakMap(), seen = [];
  const original = { open: fsp.open, sync: FileHandle.sync };
  fsp.open = async (file, flags, mode) => {
    const handle = await original.open(file, flags, mode);
    const access = typeof flags === 'number' ? flags & 3 : flags === undefined || flags === 'r' ? constants.O_RDONLY : -1;
    opened.set(handle, { file: String(file), readOnly: access === constants.O_RDONLY });
    return handle;
  };
  FileHandle.sync = async function sync() {
    const info = opened.get(this) ?? { file: '?', readOnly: false };
    const kind = (await this.stat()).isDirectory() ? 'folder' : info.readOnly ? 'read-only' : 'file';
    const error = refuse(kind, info.file);
    seen.push([kind, info.file, error ? 'refused' : 'flushed']);
    if (error) throw error;
    return original.sync.call(this);
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.open = original.open; FileHandle.sync = original.sync; syncBuiltinESMExports(); });
  return seen;
}
/** Windows' answer: a folder or a read-only handle cannot be flushed. */
const windowsFlush = (kind) => kind === 'file' ? null : eperm();
function platform(t, value) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  t.after(() => Object.defineProperty(process, 'platform', original));
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-d61-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = await openStore({ dataDir: join(root, 'data'), homeDir: join(root, 'home'), environment: {}, afterCommit: exportCommittedBoard, lockTimeoutMs: 5000 });
  const folder = async (name) => { const dir = join(root, name); await fs.mkdir(dir, { recursive: true }); return dir; };
  return { root, store, folder };
}
/** An automatic board as the plugin makes it at a new chat (the D44 path the Windows log names). */
async function autoBoard(s, dir) {
  let clock = START;
  const logs = [];
  const auto = createAutoCards({ store: s.store, locale: readLocale, now: () => clock, log: (message) => logs.push(message) });
  const rows = [{ id: 'wks_win01', projectId: 'prj_d61', projectRootPath: dir, workspaceDirectory: dir, workspaceKind: 'local_checkout', name: 'w', archivingAt: null }];
  const agents = new Map();
  const paseo = {
    agents: {
      list: async () => ({ entries: [...agents.values()].map(agent => ({ agent, project: null })), pageInfo: { nextCursor: null } }),
      ref: id => ({ refresh: async () => { const agent = agents.get(id); return agent ? { agent, project: null } : null; } }),
    },
    workspaces: { list: async () => ({ entries: rows, pageInfo: { nextCursor: null } }) },
  };
  auto.wake(paseo); await auto.idle();
  clock = new Date(Date.parse(START) + 60_000).toISOString();
  const snapshot = { id: randomUUID(), workspaceId: 'wks_win01', cwd: dir, title: '새 채팅', labels: {}, status: 'idle', pendingPermissions: [],
    archivedAt: null, lastUserMessageAt: null, createdAt: clock };
  agents.set(snapshot.id, snapshot);
  const hook = { id: snapshot.id, workspaceId: 'wks_win01', parentAgentId: null, provider: 'claude', cwd: dir, title: snapshot.title };
  return { outcome: await auto.signal(hook, 'created', paseo), logs, agentId: snapshot.id };
}

test('D61 Windows: the automatic board, board.ensure, card add and a replayed request succeed when folders and read-only handles cannot be flushed', async t => {
  platform(t, 'win32');
  const seen = await flushes(t, windowsFlush);
  const s = await setup(t);
  // The automatic board of a new chat: the line `[kanban auto-cards] board for … failed Error: EPERM` no more.
  const dir = await s.folder('kanban-test');
  const made = await autoBoard(s, dir);
  assert.deepEqual(made.logs.filter(line => /fail|EPERM/.test(line)), []);
  assert.equal(made.outcome, 'created');
  const [board, ...more] = await s.store.listBoards();
  assert.equal(more.length, 0);
  assert.equal(board.cards.filter(c => c.agents.some(a => a.agentId === made.agentId)).length, 1);
  // board.ensure (the board's add button) on a second workspace with no board.
  const other = await s.folder('other');
  const ensure = createEnsureHandler(s.store, async (_paseo, id) => ({ id, cwd: other }));
  const tap = await ensure({ workspaceId: 'wks_win02', requestId: randomUUID(), operations: [{ op: 'add', title: 'A first card' }] });
  assert.equal(tap.ok, true, JSON.stringify(tap));
  assert.equal(tap.data.created, true);
  // A card added, then the same request again: the replay confirms the stored file (a read-only flush before D61).
  const again = request([add('Replayed')]);
  const first = await s.store.mutateBoard(board.id, again);
  assert.equal(first.data.changed, true);
  const replay = await s.store.mutateBoard(board.id, again);
  assert.equal(replay.data.replayed, true);
  // No folder was flushed on Windows and no read-only handle either; every file flush that ran is counted, the skipped
  // folder flushes are counted apart.
  assert.deepEqual(seen.filter(([kind]) => kind !== 'file'), []);
  assert.equal(first.meta.io.fsyncCalls, 1, 'the board file flush ran');
  assert.equal(first.meta.io.fsyncSkipped, 2, 'the backup folder and boards folder flushes were skipped');
  assert.equal(replay.meta.io.fsyncCalls, 1);
  assert.equal(replay.meta.io.fsyncSkipped, 1);
  assert.equal((await s.store.readBoard(board.id)).cards.length, 2);
});

test('D61 Windows: a board file another program holds for a moment is still replaced', async t => {
  platform(t, 'win32');
  await flushes(t, windowsFlush);
  const s = await setup(t);
  const dir = await s.folder('held');
  const init = await s.store.initBoard({ cwd: dir, workspaceId: 'wks_held01', actor, requestId: randomUUID() });
  const target = join(s.store.dataDir, 'boards', `${init.data.boardId}.json`);
  // A virus scanner or an indexer holding the board file: MoveFileEx refuses the replace twice, then lets it through.
  const original = fsp.rename;
  let refused = 0;
  fsp.rename = async (from, to) => { if (to === target && refused < 2) { refused++; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' }); } return original(from, to); };
  syncBuiltinESMExports();
  t.after(() => { fsp.rename = original; syncBuiltinESMExports(); });
  const result = await s.store.mutateBoard(init.data.boardId, request([add()]));
  assert.equal(result.data.changed, true);
  assert.equal(refused, 2);
});

test('D61 other hosts: a folder flush that fails still fails the write, whatever its code (research/407 F2)', async t => {
  platform(t, 'linux');
  let refuse = null;
  const seen = await flushes(t, (kind) => refuse && kind === refuse.kind ? Object.assign(new Error(refuse.code + ', fsync'), { code: refuse.code }) : null);
  const s = await setup(t);
  const dir = await s.folder('mounted');
  const init = await s.store.initBoard({ cwd: dir, workspaceId: 'wks_mount01', actor, requestId: randomUUID() });
  // As before D61: no code turns a failed folder flush into a success — the write is E_IO and no card is kept.
  for (const code of ['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EIO']) {
    refuse = { kind: 'folder', code };
    await assert.rejects(s.store.mutateBoard(init.data.boardId, request([add(code)])), error => error.code === 'E_IO', code);
    assert.equal((await s.store.readBoard(init.data.boardId)).cards.length, 0, code);
  }
  // A file whose flush fails is a failed write, as before.
  refuse = { kind: 'file', code: 'EIO' };
  await assert.rejects(s.store.mutateBoard(init.data.boardId, request([add('Not durable')])), error => error.code === 'E_IO');
  refuse = null;
  // On Linux the replayed request still confirms through a read-only handle, as it always did.
  const again = request([add('Again')]);
  const first = await s.store.mutateBoard(init.data.boardId, again);
  assert.equal(first.meta.io.fsyncSkipped, 0);
  seen.length = 0;
  await s.store.mutateBoard(init.data.boardId, again);
  assert.deepEqual(seen.map(([kind, , state]) => [kind, state]), [['read-only', 'flushed'], ['folder', 'flushed']]);
});

test('D61 Windows: a PROCESS.md a person edits while its replace is refused is kept, never retried over (research/407 F1)', async t => {
  platform(t, 'win32');
  await flushes(t, windowsFlush);
  const s = await setup(t);
  const dir = await s.folder('edited');
  const init = await s.store.initBoard({ cwd: dir, workspaceId: 'wks_edit01', actor, requestId: randomUUID() });
  const target = join(dir, 'PROCESS.md');
  assert.ok((await fs.readFile(target, 'utf8')).length > 0, 'the board wrote its PROCESS.md');
  const manual = 'A person\'s notes, written while a scanner held the file.\n';
  const original = fsp.rename;
  let attempts = 0;
  fsp.rename = async (from, to) => {
    if (to === target && ++attempts === 1) { await fs.writeFile(target, manual); throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' }); }
    return original(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.rename = original; syncBuiltinESMExports(); });
  const result = await s.store.mutateBoard(init.data.boardId, request([add()]));
  assert.equal(result.data.changed, true, 'the board itself is saved');
  assert.equal(attempts, 1, 'PROCESS.md is not tried again');
  assert.equal(await fs.readFile(target, 'utf8'), manual, 'the edit is kept');
  assert.deepEqual(result.warnings.map(w => w.code), ['W_EXPORT_FAILED']);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.tmp-')), [], 'no temporary file is left');
});

test('D61 Linux: the flushes of a write are the same ones, in the same order, and none is skipped', async t => {
  platform(t, 'linux');
  const seen = await flushes(t);
  const s = await setup(t);
  const dir = await s.folder('plain');
  const init = await s.store.initBoard({ cwd: dir, workspaceId: 'wks_plain01', actor, requestId: randomUUID() });
  seen.length = 0;
  const result = await s.store.mutateBoard(init.data.boardId, request([add()]));
  assert.equal(result.meta.io.fsyncCalls, 3);
  assert.equal(result.meta.io.fsyncSkipped, 0);
  const at = (file) => file.slice(s.store.dataDir.length).replace(/board_[0-9a-f]{64}/g, 'B').replace(/\.tmp-[0-9a-f-]{36}/g, '.tmp-X');
  // research/406_D61_Windows_fsync/linux-fsync-order-before.txt: the order before D61.
  assert.deepEqual(seen.map(([kind, file, state]) => [kind, at(file), state]),
    [['folder', '/_archive/B', 'flushed'], ['file', '/boards/.tmp-X', 'flushed'], ['folder', '/boards', 'flushed']]);
});
