// REQ-108 (the owner's choice, 2026-09-28): a card says when it entered its stage (`stageEnteredAt`), written by the write
// that moved it, so REQ-86's time in a stage survives the ledger trimming its movement history to 1000 records. A ledger
// written before it reads as it did (history, else the last change marked estimated); a later write fills the field in
// from history where that is certain, never a read. Also ④: an archived card's busy end (`cleared`) goes at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyOperations, validateBoard } from '../dist/shared/core/domain.js';
import { stageEntries, stageEntry, toBoardDTO } from '../dist/server/read-model.js';
import { createAutoCards } from '../dist/server/auto-cards.js';
import { createMutationHandler } from '../dist/server/mutations.js';
import { createReadHandlers, readLocale } from '../dist/server/handlers.js';
import { BUSY_FILE, CLEARED_KEEP_MS, pruneAfterWrite, pruneBusy, readBusyFile, setBusy } from '../dist/server/busy.js';
import { boardGet, cardGet } from '../dist/shared/rpc.js';
import { board, add, context, actor, fixture, request } from './helpers.mjs';

const T = minute => new Date(Date.parse('2026-09-27T00:00:00.000Z') + minute * 60000).toISOString();
const apply = (b, ops, minute, caller) => applyOperations(b, ops, actor, context(T(minute)), caller);
const cardOf = (b, id) => b.cards.find(c => c.id === id);
const dtoCard = (dto, id) => dto.stages.flatMap(s => s.cards).find(c => c.id === id);
/** A ledger as a writer before REQ-108 left it: no card says its entry. */
const legacy = b => ({ ...b, cards: b.cards.map(({ stageEnteredAt: _, ...c }) => c) });

test('REQ-108 ledger: every stage change stamps the card; creation, a same-stage move and other edits leave it', () => {
  let b = apply(board(), [add('Sample card')], 0).board;
  const id = b.cards[0].id;
  assert.equal('stageEnteredAt' in cardOf(b, id), false, 'a new card leaves it to the read (its creation)');
  b = apply(b, [{ op: 'move', id, to: 'doing' }], 10).board;
  assert.equal(cardOf(b, id).stageEnteredAt, T(10));
  const same = apply(b, [{ op: 'move', id, to: 'doing' }], 20);
  assert.equal(same.changed, false, 'a move to the same stage writes nothing');
  assert.equal(cardOf(same.board, id).stageEnteredAt, T(10));
  for (const [minute, op] of [[30, { op: 'update', id, patch: { notes: 'Edited' } }],
    [31, { op: 'link', id, agentId: randomUUID() }], [32, { op: 'archive', id }], [33, { op: 'restore', id }]]) {
    b = apply(b, [op], minute).board;
    assert.equal(cardOf(b, id).stageEnteredAt, T(10), op.op + ' keeps the entry');
    assert.equal(cardOf(b, id).updatedAt, T(minute));
  }
  b = apply(b, [{ op: 'move', id, to: 'review' }], 40).board;
  assert.equal(cardOf(b, id).stageEnteredAt, T(40));
  // Away and back in one batch is no stage change (as the history says): the entry stays.
  const round = apply(b, [{ op: 'move', id, to: 'doing' }, { op: 'update', id, patch: { notes: 'Round trip' } }, { op: 'move', id, to: 'review' }], 50).board;
  assert.equal(cardOf(round, id).stageEnteredAt, T(40));
  assert.equal(round.history.at(-1).at, T(40));
  // A card added straight into a later stage: no field, its record says it.
  const direct = apply(b, [{ ...add('Direct card'), stageId: 'review' }], 60).board;
  const other = direct.cards.find(c => c.title === 'Direct card');
  assert.equal('stageEnteredAt' in other, false);
  assert.equal(dtoCard(toBoardDTO(direct, 'en'), other.id).stageEnteredAt, T(60));
  // Not something a writer may set.
  assert.throws(() => apply(b, [{ op: 'update', id, patch: { stageEnteredAt: T(0) } }], 70), /Unknown field/);
  assert.throws(() => apply(b, [{ ...add('Forged'), stageEnteredAt: T(0) }], 70), /Unknown field/);
});

test('REQ-108 ledger: a draft sent to the lead (dispatch) and moved back stamps the card; the dispatcher\'s record does not', () => {
  let b = apply(board(), [{ op: 'add', title: 'Sample request', intent: 'draft', acceptanceCriteria: '' }], 0).board;
  const id = b.cards[0].id;
  b = apply(b, [{ op: 'dispatch', id, to: 'doing' }], 5, 'board').board;
  assert.equal(cardOf(b, id).stageEnteredAt, T(5));
  b = apply(b, [{ op: 'dispatched', id, state: 'noLead', targetAgentId: null }], 8, 'dispatcher').board;
  assert.equal(cardOf(b, id).stageEnteredAt, T(5), 'the send record is no move');
  b = apply(b, [{ op: 'move', id, to: 'todo' }], 12).board;
  assert.deepEqual([cardOf(b, id).stageEnteredAt, cardOf(b, id).dispatch.state, cardOf(b, id).intent], [T(12), 'cancelled', 'draft']);
});

test('REQ-108 migration: a ledger with no field validates and reads from history as before; a damaged field is refused', () => {
  let b = apply(board(), [add('Old card')], 0).board;
  const id = b.cards[0].id;
  b = legacy(apply(b, [{ op: 'move', id, to: 'review' }], 10).board);
  validateBoard(b);
  assert.equal(dtoCard(toBoardDTO(b, 'en'), id).stageEnteredAt, T(10));
  assert.equal('stageEnteredEstimated' in dtoCard(toBoardDTO(b, 'en'), id), false);
  const bad = { ...b, cards: [{ ...b.cards[0], stageEnteredAt: 'yesterday' }] };
  assert.throws(() => validateBoard(bad));
});

test('REQ-108 read model: the card\'s own entry, else its history, else its last change marked estimated', () => {
  const entries = new Map([['card_a', 'review\u0000' + T(5)]]);
  assert.deepEqual(stageEntry(entries, { id: 'card_a', stageId: 'review', updatedAt: T(9), stageEnteredAt: T(2) }), { at: T(2), estimated: false }, 'field first');
  assert.deepEqual(stageEntry(entries, { id: 'card_a', stageId: 'review', updatedAt: T(9) }), { at: T(5), estimated: false }, 'then history');
  assert.deepEqual(stageEntry(entries, { id: 'card_a', stageId: 'doing', updatedAt: T(9) }), { at: T(9), estimated: true }, 'then an estimate');
  assert.deepEqual(stageEntry(new Map(), { id: 'card_b', stageId: 'doing', updatedAt: T(9), stageEnteredAt: T(1) }), { at: T(1), estimated: false },
    'the field needs no record at all');
});

test('REQ-108 J1: once 1000 later moves push a card\'s record out, an edit no longer restarts its time in the stage', () => {
  let b = apply(board(), [add('Waiting card'), add('Moving card')], 0).board;
  const [waiting, moving] = b.cards.map(c => c.id);
  b = apply(b, [{ op: 'move', id: waiting, to: 'review' }], 1).board;
  for (let i = 0; i < 1000; i++) b = apply(b, [{ op: 'move', id: moving, to: i % 2 ? 'todo' : 'doing' }], 2 + i).board;
  assert.equal(b.history.some(h => h.cardId === waiting), false, 'its record is gone');
  b = apply(b, [{ op: 'update', id: waiting, patch: { notes: 'Looked at it' } }], 1100).board;
  const c = dtoCard(toBoardDTO(b, 'en'), waiting);
  assert.deepEqual([c.stageEnteredAt, 'stageEnteredEstimated' in c, c.updatedAt], [T(1), false, T(1100)]);
  // The card's detail says the same.
  assert.equal(stageEntry(stageEntries(b), cardOf(b, waiting)).at, T(1));
  // The same on a ledger with no field: estimated, and the edit is where it starts (REQ-86 as it was).
  const old = legacy(b);
  assert.deepEqual([dtoCard(toBoardDTO(old, 'en'), waiting).stageEnteredAt, dtoCard(toBoardDTO(old, 'en'), waiting).stageEnteredEstimated], [T(1100), true]);
});

test('REQ-108 backfill: the next write fills in what history makes certain, in the same write; a read and a no-op write never do', () => {
  let b = apply(board(), [add('First card'), add('Second card'), add('Third card')], 0).board;
  const [first, second, third] = b.cards.map(c => c.id);
  b = apply(b, [{ op: 'move', id: first, to: 'review' }], 5).board;
  b = apply(b, [{ op: 'move', id: second, to: 'doing' }], 6).board;
  b = legacy(b);
  // Third has only its creation record; history is cut so that second has none left.
  b = { ...b, history: b.history.filter(h => h.cardId !== second) };
  validateBoard(b);
  const before = JSON.stringify(b);
  toBoardDTO(b, 'en');
  assert.equal(JSON.stringify(b), before, 'a read writes nothing');
  assert.equal(apply(b, [{ op: 'move', id: first, to: 'review' }], 7).changed, false, 'a write that changes nothing fills nothing');
  const next = apply(b, [add('Fourth card'), { op: 'update', id: third, patch: { notes: 'Edited' } }], 8);
  assert.equal(next.changed, true);
  assert.equal(cardOf(next.board, first).stageEnteredAt, T(5), 'from its last record');
  assert.equal(cardOf(next.board, third).stageEnteredAt, T(0), 'its creation record');
  assert.equal('stageEnteredAt' in cardOf(next.board, second), false, 'no record left: not guessed');
  const fourth = next.board.cards.find(c => c.title === 'Fourth card');
  assert.equal('stageEnteredAt' in fourth, false, 'created by this write: filled in by the next');
  assert.equal(cardOf(next.board, first).updatedAt, cardOf(b, first).updatedAt, 'filling in is no change of the card');
  assert.deepEqual(next.cardIds, [fourth.id, third], 'nor a card the write reports');
  const later = apply(next.board, [{ op: 'update', id: third, patch: { notes: 'Again' } }], 9).board;
  assert.equal(later.cards.find(c => c.id === fourth.id).stageEnteredAt, T(8));
  // What the screens see does not move.
  for (const id of [first, third]) assert.equal(dtoCard(toBoardDTO(next.board, 'en'), id).stageEnteredAt, dtoCard(toBoardDTO(b, 'en'), id).stageEnteredAt);
});

test('REQ-108 store and screens: the board screen\'s and an auto card\'s moves stamp the card; card.get and board.get say it', async t => {
  const f = await fixture(t);
  await f.store.mutateBoard(f.id, request([add('Screen card')]));
  let board = await f.store.readBoard(f.id);
  const id = board.cards[0].id;
  const mutate = createMutationHandler(f.store);
  const moved = await mutate({ boardId: f.id, requestId: randomUUID(), ifRevision: board.revision, operations: [{ op: 'move', id, to: 'review' }] });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  board = await f.store.readBoard(f.id);
  const record = board.history.at(-1);
  assert.deepEqual([record.cardId, record.to], [id, 'review']);
  assert.equal(cardOf(board, id).stageEnteredAt, record.at);
  const h = createReadHandlers(f.store);
  const detail = await h.card({ boardId: f.id, cardId: id });
  assert.equal(detail.ok, true); cardGet.output.parse(detail);
  assert.deepEqual([detail.data.card.stageEnteredAt, detail.data.stageEnteredAt, 'stageEnteredEstimated' in detail.data], [record.at, record.at, false]);
  const read = await h.board({ boardId: f.id }); boardGet.output.parse(read);
  assert.equal(dtoCard(read.data.board, id).stageEnteredAt, record.at);
  // An agent's auto card follows its agent: every bucket change is a move that stamps it.
  const auto = createAutoCards({ store: f.store, locale: readLocale, log: () => {} });
  const agent = { id: randomUUID(), workspaceId: 'wks_example01', parentAgentId: null, provider: 'claude', cwd: '/nowhere', title: '[검증용] 자동 카드' };
  await auto.signal(agent, 'created');
  await auto.signal(agent, 'turn_started');
  board = await f.store.readBoard(f.id);
  const card = board.cards.find(c => c.agents.some(a => a.agentId === agent.id));
  const last = board.history.filter(h => h.cardId === card.id).at(-1);
  assert.equal(card.stageId, 'doing');
  assert.equal(card.stageEnteredAt, last.at);
});

// ---- ④ busy ends of archived cards ----------------------------------------------------------------------------------
const entry = resolve('dist/src/cli/main.js');
async function cli(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'kanban-req108-')), cwd = join(root, 'work'), data = join(root, 'data');
  await fs.mkdir(cwd);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = args => new Promise((done, reject) => {
    const env = { ...process.env }; delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID; delete env.KANBAN_DATA_DIR;
    const child = spawn(process.execPath, [entry, ...args, '--data-dir', data, '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.once('error', reject);
    child.once('close', code => { try { done({ code, stderr, value: stdout ? JSON.parse(stdout) : null }); } catch (error) { reject(error); } });
  });
  const ok = async args => { const r = await run(args); assert.equal(r.code, 0, r.stderr); assert.equal(r.value.ok, true); return r.value; };
  await ok(['init']);
  return { data, ok };
}

test('REQ-108 CLI: card move stamps the card; archiving drops the card\'s busy end at once, with no mark left on the board', async t => {
  const c = await cli(t);
  const id = (await c.ok(['card', 'add', '--title', 'Example check', '--criteria', 'Result recorded', '--intent', 'requested'])).data.cardIds[0];
  const other = (await c.ok(['card', 'add', '--title', 'Other card', '--criteria', 'Result recorded', '--intent', 'requested'])).data.cardIds[0];
  await c.ok(['card', 'move', id, '--to', 'doing']);
  const shown = (await c.ok(['card', 'show', id])).data;
  const card = shown.card ?? shown;
  assert.ok(card.stageEnteredAt && !Number.isNaN(Date.parse(card.stageEnteredAt)), JSON.stringify(shown));
  for (const target of [id, other]) { await c.ok(['card', 'busy', target, 'Testing']); await c.ok(['card', 'busy', target, '--off']); }
  const boardId = Object.keys((await readBusyFile(c.data)).cleared)[0];
  assert.deepEqual(Object.keys((await readBusyFile(c.data)).cleared[boardId]).sort(), [id, other].sort());
  assert.deepEqual((await readBusyFile(c.data)).marks, {}, 'no mark on anywhere');
  await c.ok(['card', 'update', id, '--archive']);
  assert.deepEqual(Object.keys((await readBusyFile(c.data)).cleared[boardId]), [other], 'the archived card\'s end is gone, the other stays');
});

test('REQ-108 ④ an archive through the store drops the end too (pruneAfterWrite); a prune clears ends past their time with no mark on', async t => {
  const f = await fixture(t);
  await f.store.mutateBoard(f.id, request([add('Kept card'), add('Archived card')]));
  let board = await f.store.readBoard(f.id);
  const [kept, gone] = board.cards.map(c => c.id);
  const active = new Set([kept, gone]);
  for (const id of [kept, gone]) { await setBusy(f.store.dataDir, f.id, id, { text: 'Testing', since: new Date().toISOString(), by: 'cli' }, { active }); await setBusy(f.store.dataDir, f.id, id, null, { active }); }
  await f.store.mutateBoard(f.id, request([{ op: 'archive', id: gone }]));
  await pruneAfterWrite(f.store.dataDir, f.id, async () => (await f.store.readBoard(f.id)).cards);
  assert.deepEqual(Object.keys((await readBusyFile(f.store.dataDir)).cleared[f.id]), [kept]);
  // An end past CLEARED_KEEP_MS on a board with no mark on — and another board's — goes on the next prune.
  const otherBoard = 'board_' + 'b'.repeat(64), old = new Date(Date.now() - CLEARED_KEEP_MS - 60000).toISOString();
  const recent = (await readBusyFile(f.store.dataDir)).cleared[f.id][kept];
  await fs.writeFile(join(f.store.dataDir, BUSY_FILE), JSON.stringify({ schemaVersion: 1, boards: {},
    cleared: { [f.id]: { [kept]: recent, [gone]: old }, [otherBoard]: { [kept]: old } } }));
  assert.equal(await pruneBusy(f.store.dataDir, f.id, new Set([kept])), 1);
  assert.deepEqual((await readBusyFile(f.store.dataDir)).cleared, { [f.id]: { [kept]: recent } });
  // Nothing to drop: no lock, no write.
  const stamp = (await fs.stat(join(f.store.dataDir, BUSY_FILE))).mtimeMs;
  assert.equal(await pruneBusy(f.store.dataDir, f.id, new Set([kept])), 0);
  assert.equal((await fs.stat(join(f.store.dataDir, BUSY_FILE))).mtimeMs, stamp);
  assert.deepEqual(await fs.readdir(f.store.dataDir).then(n => n.filter(x => x.startsWith('.busy'))), []);
  board = await f.store.readBoard(f.id);
  assert.equal(cardOf(board, gone).archivedAt !== null, true);
});
