// REQ-149 gates 431·433 (research/431, research/433): the check up's writes never override someone else. The product hook
// `useCheckupWrites` (client/checkup.tsx) runs here as written — its body is taken from the source and only its React and host
// bindings are given — against a real ledger (`openStore`), the real read model and the server's own restore
// (`createAutoArchiver`). Another person's writes are slipped in between the check up's: a card moved away and back before the
// write (F1), moved away and back to Done before Undo (F2), restored and archived again before Undo (F3), an edit, a write to
// another card. Gate 433: every case also runs with the ledger's clock set back a second before the other person's writes
// (then moving a millisecond a write) and with the clock standing still — the ledger then stamps several writes with one
// time, so only the board's revision tells them apart. Made-up names only; every board lives in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { openStore, validateBoard } from '../dist/server/core/index.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { createAutoArchiver } from '../dist/server/auto-archive.js';
import * as model from '../dist/client/checkup-model.js';
import { copy } from '../dist/client/i18n.js';
import { testTmpdir } from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname, ts = createRequire(import.meta.url)('typescript');
const source = fs.readFileSync(join(root, 'client/checkup.tsx'), 'utf8');
const body = source.slice(source.indexOf('export function useCheckupWrites()'), source.indexOf('/** A tick box'));
const js = ts.transpileModule(body.replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const NOW = Date.parse('2026-10-17T03:00:00.000Z'), DAY = model.DAY_MS, user = { kind: 'user' };
const signals = { ready: true, archived: () => false, activity: () => undefined };
/** How the ledger's clock behaves while the other person writes: moving on, set back a second (then moving on), standing still. */
const CLOCKS = ['advancing', 'setBack', 'still'];

/** A board with `n` requests in progress made 30 days ago; `other` writes as someone else, the clock as `mode` says. */
async function fixture(t, n = 3, mode = 'advancing') {
  const dir = await mkdtemp(join(await testTmpdir(), 'kanban-req149w-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'workspace'));
  const clock = { t: NOW - 30 * DAY, step: 1 };
  const store = await openStore({ dataDir: join(dir, 'data'), context: { newId: randomUUID, now: () => { const at = clock.t; clock.t += clock.step; return new Date(at).toISOString(); } } });
  const id = (await store.initBoard({ cwd: join(dir, 'workspace'), workspaceId: 'wks_example01', actor: user, requestId: randomUUID() })).data.boardId;
  const write = (operations, extra = {}) => store.mutateBoard(id, { actor: user, requestId: randomUUID(), operations, ...extra }, 'board');
  const ids = (await write(Array.from({ length: n }, (_, i) => ({ op: 'add', title: 'Example ' + i, intent: 'requested',
    acceptanceCriteria: 'A reviewable result exists.', stageId: 'doing' })))).data.cardIds;
  clock.t = NOW;
  const read = () => store.readBoard(id);
  const list = model.checkupCandidates([toBoardDTO(await read(), 'ko', 'off', NOW)], signals, NOW);
  // Everything but the last card is ticked; the last one is the control that nothing touches.
  const ticked = new Set(list.filter(c => c.cardId !== ids.at(-1)).map(c => c.key));
  /** Someone else's writes, the clock set back or standing still first as `mode` says. */
  const other = async (...writes) => {
    if (mode === 'setBack') clock.t -= 1000;
    if (mode === 'still') { clock.step = 0; clock.t -= 1; }
    for (const operations of writes) await write(operations);
    clock.step = 1;
  };
  return { id, ids, store, write, other, read, archiver: createAutoArchiver(store), plan: action => model.checkupPlan(list, ticked, action).boards };
}
/** The hook as the screen runs it, its RPCs answered by the real ledger and server; `events` slips other writes in. */
function hook(f, events = {}) {
  let calls = 0;
  const api = {
    mutate: async input => {
      calls++;
      await events.beforeMutate?.(input, calls);
      let reply;
      try { const r = await f.write(input.operations, { ifRevision: input.ifRevision }); reply = { ok: true, data: r.data, committed: true, warnings: [] }; }
      catch (error) { reply = { ok: false, error: { code: error.code }, committed: false }; }
      await events.afterMutate?.(input, calls);
      return reply;
    },
    restore: async ({ boardId, cardId, ifRevision }) => ({ ok: true, data: await f.archiver.restore(boardId, cardId, ifRevision) }),
  };
  const bindings = { ...model, newRequestId: randomUUID, mutationAllowed: () => true, usePreview: () => false,
    boardMutate: 'mutate', archivedRestore: 'restore', useRpc: name => api[name] };
  return new Function(...Object.keys(bindings), js + '\nreturn useCheckupWrites();')(...Object.values(bindings));
}
const cardOf = async (f, id) => { const board = await f.read(); validateBoard(board); return board.cards.find(c => c.id === id); };
const away = (f, id, there, back) => [[{ op: 'move', id, to: there }], [{ op: 'move', id, to: back }]];

test('REQ-149 writes control: Done moves the ticked cards only and Undo brings them home; the untouched card stays as it was', async t => {
  const f = await fixture(t), h = hook(f), before = await cardOf(f, f.ids[2]);
  const out = await h.run(f.plan('done'), 'done', 0);
  assert.deepEqual([out.count, out.left, out.refused, out.unknown], [2, 0, 0, false]);
  assert.equal(out.changed[0].revision, (await f.read()).revision, 'the outcome keeps the revision its own write produced');
  const tally = await h.undo(out);
  assert.deepEqual(tally, { count: 2, left: 0, refused: 0, unknown: false });
  for (const id of f.ids) assert.equal((await cardOf(f, id)).stageId, 'doing');
  // The ledger fills in a card's own entry time on a write (REQ-108's backfill, the time the read already gave); nothing else moves.
  const { stageEnteredAt: _a, ...after } = await cardOf(f, f.ids[2]), { stageEnteredAt: _b, ...was } = before;
  assert.deepEqual(after, was);
});

test('REQ-149 writes control: Archive and its Undo restore the archived cards one by one on the revisions they produce', async t => {
  const f = await fixture(t), h = hook(f), out = await h.run(f.plan('archive'), 'archive', 0);
  assert.deepEqual([out.count, out.left], [2, 0]);
  assert.deepEqual(await h.undo(out), { count: 2, left: 0, refused: 0, unknown: false });
  for (const id of f.ids) { const c = await cardOf(f, id); assert.deepEqual([c.stageId, c.archivedAt], ['doing', null]); }
});

for (const mode of CLOCKS) for (const action of ['done', 'archive'])
test(`REQ-149 gate 431·433 F1 (${action}, clock ${mode}): a board written to since the list was read is not written; a card moved away and back stays`, async t => {
  const f = await fixture(t, 3, mode);
  const h = hook(f, { beforeMutate: async (_input, n) => { if (n === 1) await f.other(...away(f, f.ids[0], 'todo', 'doing')); } });
  const out = await h.run(f.plan(action), action, 0);
  const moved = await cardOf(f, f.ids[0]), other = await cardOf(f, f.ids[1]);
  assert.deepEqual([moved.stageId, moved.archivedAt], ['doing', null], 'the other person\'s choice stands');
  assert.deepEqual([other.stageId, other.archivedAt], ['doing', null], 'no retry on a newer revision: nothing written to that board');
  assert.deepEqual([out.count, out.left, out.refused], [0, 2, 0]);
  assert.equal(model.checkupResult(out, action, copy('ko')).text, copy('ko').checkupLeftAll(2));
  assert.match(copy('ko').checkupLeftAll(2), /같은 보드에 다른 변경.*점검을 다시 열어 확인/);
  assert.match(copy('en').checkupLeftAll(2), /because their boards changed.*Reopen Check up/);
});

for (const mode of CLOCKS)
test(`REQ-149 gate 431·433 F2 (clock ${mode}): Undo leaves a board someone wrote to — moved away and back to Done, or edited`, async t => {
  for (const change of ['awayAndBack', 'edit', 'otherCard']) {
    const f = await fixture(t, 3, mode), h = hook(f), out = await h.run(f.plan('done'), 'done', 0);
    if (change === 'awayAndBack') await f.other(...away(f, f.ids[0], 'todo', 'done'));
    if (change === 'edit') await f.other([{ op: 'update', id: f.ids[0], patch: { nextAction: 'Checked by hand' } }]);
    if (change === 'otherCard') await f.other([{ op: 'update', id: f.ids[2], patch: { nextAction: 'Elsewhere' } }]);
    const tally = await h.undo(out);
    for (const id of f.ids.slice(0, 2)) assert.equal((await cardOf(f, id)).stageId, 'done', change + ': nothing undone');
    assert.deepEqual(tally, { count: 0, left: 2, refused: 0, unknown: false }, change);
  }
});

for (const mode of CLOCKS)
test(`REQ-149 gate 431·433 F3 (clock ${mode}): Undo leaves a card someone restored and archived again, and the board it is on`, async t => {
  const f = await fixture(t, 3, mode), h = hook(f), out = await h.run(f.plan('archive'), 'archive', 0);
  await f.other([{ op: 'restore', id: f.ids[0] }], [{ op: 'archive', id: f.ids[0] }]);
  const tally = await h.undo(out);
  assert.notEqual((await cardOf(f, f.ids[0])).archivedAt, null, 'the new archive stands');
  assert.notEqual((await cardOf(f, f.ids[1])).archivedAt, null, 'the board was written to: nothing restored there');
  assert.deepEqual(tally, { count: 0, left: 2, refused: 0, unknown: false });
});

test('REQ-149 gate 433: a write between two of Undo\'s restores stops the chain; the rest is left archived', async t => {
  const f = await fixture(t, 4), h = hook(f), out = await h.run(f.plan('archive'), 'archive', 0);
  let first = true;
  const original = f.archiver.restore;
  f.archiver.restore = async (...args) => { const r = await original(...args); if (first) { first = false; await f.other([{ op: 'update', id: f.ids[3], patch: { nextAction: 'Elsewhere' } }]); } return r; };
  const tally = await h.undo(out);
  assert.deepEqual(tally, { count: 1, left: 2, refused: 0, unknown: false });
  assert.deepEqual([(await cardOf(f, f.ids[0])).archivedAt === null, (await cardOf(f, f.ids[1])).archivedAt === null, (await cardOf(f, f.ids[2])).archivedAt === null], [true, false, false]);
});

test('REQ-149 gate 433: the server restores on the given revision only; without it, as before', async t => {
  const f = await fixture(t);
  const archived = await f.write([{ op: 'archive', id: f.ids[0] }]), revision = archived.data.revision;
  await f.write([{ op: 'update', id: f.ids[1], patch: { nextAction: 'Elsewhere' } }]);
  assert.deepEqual(await f.archiver.restore(f.id, f.ids[0], revision), { changed: false, kept: true });
  assert.notEqual((await cardOf(f, f.ids[0])).archivedAt, null);
  const now = (await f.read()).revision, restored = await f.archiver.restore(f.id, f.ids[0], now);
  assert.equal(restored.changed, true); assert.notEqual(restored.revision, now);
  assert.equal((await cardOf(f, f.ids[0])).archivedAt, null);
  await f.write([{ op: 'archive', id: f.ids[1] }]);
  assert.deepEqual(await f.archiver.restore(f.id, f.ids[1]), { changed: true }, 'the archived list\'s restore is unchanged');
});

test('REQ-149 gate 433 F4: a change that alters only a line (an agent archived) changes the list\'s key', () => {
  const board = { summary: { id: 'b', revision: 'r:1' }, stages: [{ stageId: 'todo', name: '대기', countsAsDone: false,
    cards: [{ id: 'c', title: 'C', stageId: 'todo', intent: 'requested', blocked: false, awaiting: null, agentIds: ['x', 'y'],
      updatedAt: new Date(NOW - 20 * DAY).toISOString(), stageEnteredAt: new Date(NOW - 20 * DAY).toISOString() }] }] };
  const activity = () => new Date(NOW - 20 * DAY).toISOString();
  const before = model.checkupCandidates([board], { ready: true, archived: () => false, activity }, NOW);
  const after = model.checkupCandidates([board], { ready: true, archived: id => id === 'y', activity }, NOW);
  assert.deepEqual([before[0].archivedAgents, after[0].archivedAgents], [0, 1]);
  assert.notEqual(model.checkupKey(before), model.checkupKey(after));
  assert.match(model.checkupLine(after[0], 'W', id => id, copy('ko')), /담당 2명 중 1명 보관됨/);
});
