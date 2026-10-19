// REQ-52 (research/294): tidying finished cards — the automatic archive after N days in a completion stage (server only,
// the plugin's own `auto-archive.json`, default 7, 0 = off), the done column's "Tidy", the archived list and its restore,
// the progress counting finished cards archived (never a cancelled one), and W_SCALE counting live cards only.
// The screens are in tests/web/run.mjs (=req52). Made-up names only; every board lives in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { openStore, applyOperations, validateBoard, summarizeBoard, renderProcess } from '../dist/server/core/index.js';
import { archivedDone } from '../dist/shared/core/domain.js';
import { archiveClock, archiveDue, cleanArchiveDays, ARCHIVE_DAY_CHOICES, DAY_MS, DEFAULT_ARCHIVE_DAYS } from '../dist/shared/archive.js';
import { ARCHIVE_SETTINGS_FILE, createAutoArchiver, dueCards, readArchiveSettings, writeArchiveSettings } from '../dist/server/auto-archive.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { archiveSettingsSet, archivedList, archivedRestore, archiveTidy, boardMutate, overviewGet } from '../dist/shared/rpc.js';
import { archivedLine } from '../dist/client/archive-model.js';
import { copy } from '../dist/client/i18n.js';
import { board as emptyBoard, context, testTmpdir } from './helpers.mjs';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const user = { kind: 'user' };
const criteria = 'A reviewable result exists.';

/** A store whose clock is `clock.now` (ms), moved forward by the test. */
async function timed(t) {
  const root = await mkdtemp(join(await testTmpdir(), 'kanban-req52-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const clock = { now: T0 };
  const store = await openStore({ dataDir: join(root, 'data'), context: { newId: randomUUID, now: () => iso(clock.now) } });
  const init = await store.initBoard({ cwd, workspaceId: 'wks_example01', actor: user, requestId: randomUUID() });
  const id = init.data.boardId;
  const write = async (operations, caller) => store.mutateBoard(id, { actor: user, requestId: randomUUID(), operations }, caller);
  const addCard = async (title, stageId = 'todo') => (await write([{ op: 'add', title, intent: 'requested', acceptanceCriteria: criteria, stageId }])).data.cardIds[0];
  const card = async cardId => (await store.readBoard(id)).cards.find(c => c.id === cardId);
  return { root, store, id, clock, write, addCard, card, archiver: createAutoArchiver(store, () => clock.now) };
}

test('REQ-52 core: an automatic archive is the plugin\'s alone, only of a finished card, and a restore takes its mark off', () => {
  let b = emptyBoard();
  const ctx = context('2026-01-01T01:00:00.000Z');
  b = applyOperations(b, [{ op: 'add', title: 'Finished', intent: 'requested', acceptanceCriteria: criteria, stageId: 'done' },
    { op: 'add', title: 'Open', intent: 'requested', acceptanceCriteria: criteria }], user, ctx).board;
  const [done, open] = b.cards;
  // Without the archiver's caller, the board screen and the CLI cannot claim "auto".
  for (const caller of [undefined, 'board', 'dispatcher'])
    assert.throws(() => applyOperations(b, [{ op: 'archive', id: done.id, reason: 'auto' }], user, ctx, caller), { code: 'E_VALIDATION' });
  assert.throws(() => applyOperations(b, [{ op: 'archive', id: open.id, reason: 'auto' }], user, ctx, 'archiver'), { code: 'E_TRANSITION' });
  assert.throws(() => applyOperations(b, [{ op: 'archive', id: done.id, reason: 'later' }], user, ctx, 'archiver'), { code: 'E_VALIDATION' });
  const auto = applyOperations(b, [{ op: 'archive', id: done.id, reason: 'auto' }], user, context('2026-01-02T00:00:00.000Z'), 'archiver').board;
  const archived = auto.cards.find(c => c.id === done.id);
  assert.equal(archived.archiveReason, 'auto'); assert.equal(archived.archivedAt, '2026-01-02T00:00:00.000Z');
  // A person's archive keeps no reason; archiving again changes nothing (not even the reason).
  const byHand = applyOperations(b, [{ op: 'archive', id: open.id }], user, ctx).board;
  assert.equal(byHand.cards.find(c => c.id === open.id).archiveReason, undefined);
  assert.equal(applyOperations(auto, [{ op: 'archive', id: done.id }], user, ctx).changed, false);
  const back = applyOperations(auto, [{ op: 'restore', id: done.id }], user, context('2026-01-03T00:00:00.000Z')).board.cards.find(c => c.id === done.id);
  assert.equal(back.archivedAt, null); assert.equal(back.archiveReason, undefined); assert.equal(back.restoredAt, '2026-01-03T00:00:00.000Z');
  // Restoring a card that is not archived writes nothing (no restoredAt either).
  assert.equal(applyOperations(b, [{ op: 'restore', id: open.id }], user, ctx).changed, false);
  // The stored mark rides only on an archived card.
  const bad = structuredClone(auto); bad.cards.find(c => c.id === done.id).archivedAt = null;
  assert.throws(() => validateBoard(bad), { code: 'E_VALIDATION' });
  const odd = structuredClone(auto); odd.cards.find(c => c.id === done.id).restoredAt = 'yesterday';
  assert.throws(() => validateBoard(odd));
});

test('REQ-52 progress: finished cards archived stay done; a cancelled or duplicate card archived before Done counts nowhere', () => {
  let b = emptyBoard();
  const ctx = context('2026-01-01T01:00:00.000Z');
  const ops = [];
  for (let i = 0; i < 5; i++) ops.push({ op: 'add', title: 'Done ' + i, intent: 'requested', acceptanceCriteria: criteria, stageId: 'done' });
  ops.push({ op: 'add', title: 'Doing', intent: 'requested', acceptanceCriteria: criteria, stageId: 'doing' });
  ops.push({ op: 'add', title: 'Cancelled', intent: 'requested', acceptanceCriteria: criteria, stageId: 'review' });
  ops.push({ op: 'add', title: 'Duplicate draft' });
  b = applyOperations(b, ops, user, ctx).board;
  const id = title => b.cards.find(c => c.title === title).id;
  b = applyOperations(b, [{ op: 'archive', id: id('Done 0') }, { op: 'archive', id: id('Done 1') }, { op: 'archive', id: id('Done 2') },
    { op: 'archive', id: id('Cancelled') }, { op: 'archive', id: id('Duplicate draft') }], user, ctx).board;
  const p = summarizeBoard(b).progress;
  assert.deepEqual(p, { done: 5, requested: 6, draft: 0, archived: 5, archivedDone: 3, percent: 83 });
  assert.equal(b.cards.filter(c => archivedDone(c, b.template.stages)).length, 3);
  // The board's read says the same (the done column's "Archived 3", the lane's "Cards 5/6").
  const dto = toBoardDTO(b, 'en');
  assert.equal(dto.summary.progress.archivedDone, 3);
  assert.equal(dto.stages.find(s => s.stageId === 'done').totalCount, 2);
  assert.ok(renderProcess(b).includes('5/6 (83%)'));
});

test('REQ-52 days: exactly N days after entering Done is due, a moment before is not; 0 is off; a restore starts again', () => {
  assert.equal(DEFAULT_ARCHIVE_DAYS, 7); assert.deepEqual([...ARCHIVE_DAY_CHOICES], [0, 3, 7, 14, 30]);
  const since = T0;
  assert.equal(archiveDue(since, since + 7 * DAY_MS - 1, 7), false);
  assert.equal(archiveDue(since, since + 7 * DAY_MS, 7), true);
  assert.equal(archiveDue(since, since + 400 * DAY_MS, 0), false);
  assert.equal(archiveDue(NaN, since + 400 * DAY_MS, 7), false);
  assert.equal(archiveClock(iso(T0), iso(T0 + DAY_MS)), T0 + DAY_MS);
  assert.equal(archiveClock(iso(T0 + 2 * DAY_MS), iso(T0 + DAY_MS)), T0 + 2 * DAY_MS);
  assert.equal(archiveClock(iso(T0)), T0);
  for (const [value, want] of [[0, 0], [3, 3], [365, 365], [366, 7], [-1, 7], [1.5, 7], ['7', 7], [null, 7]]) assert.equal(cleanArchiveDays(value), want);
});

test('REQ-52 sweep: due cards in Done only, by the default 7 days, marked auto; a restored card gets its full days again', async t => {
  const f = await timed(t);
  const done = await f.addCard('Finished early');
  const later = await f.addCard('Finished later');
  const review = await f.addCard('Still in review');
  await f.write([{ op: 'move', id: done, to: 'done' }]);
  f.clock.now = T0 + DAY_MS;
  await f.write([{ op: 'move', id: later, to: 'done' }, { op: 'move', id: review, to: 'review' }]);
  assert.deepEqual(await readArchiveSettings(f.store.dataDir), { days: 7 }, 'no file: the default');
  // A moment before seven days: nothing.
  f.clock.now = T0 + 7 * DAY_MS - 1;
  assert.equal(await f.archiver.sweep(), 0);
  assert.deepEqual(dueCards(await f.store.readBoard(f.id), f.clock.now, 7), []);
  // Exactly seven days after it entered Done: the first card only.
  f.clock.now = T0 + 7 * DAY_MS;
  assert.equal(await f.archiver.sweep(), 1);
  const first = await f.card(done);
  assert.equal(first.archivedAt, iso(T0 + 7 * DAY_MS)); assert.equal(first.archiveReason, 'auto');
  assert.equal((await f.card(later)).archivedAt, null);
  // Long after: the later one too, never the card in Review.
  f.clock.now = T0 + 60 * DAY_MS;
  assert.equal(await f.archiver.sweep(), 1);
  assert.equal((await f.card(review)).archivedAt, null);
  // The list: latest first, both automatic and finished.
  const list = await f.archiver.list(f.id);
  assert.deepEqual(list.cards.map(c => [c.title, c.auto, c.done]), [['Finished later', true, true], ['Finished early', true, true]]);
  assert.equal(list.archivedDone, 2); assert.equal(list.total, 2);
  // Restored: back in Done, mark off, and seven days counted from the restore — not swept again at once.
  assert.deepEqual(await f.archiver.restore(f.id, done), { changed: true });
  assert.deepEqual(await f.archiver.restore(f.id, done), { changed: false });
  const back = await f.card(done);
  assert.equal(back.archivedAt, null); assert.equal(back.archiveReason, undefined); assert.equal(back.restoredAt, iso(T0 + 60 * DAY_MS)); assert.equal(back.stageId, 'done');
  assert.equal(await f.archiver.sweep(), 0);
  f.clock.now = T0 + 67 * DAY_MS - 1;
  assert.equal(await f.archiver.sweep(), 0);
  f.clock.now = T0 + 67 * DAY_MS;
  assert.equal(await f.archiver.sweep(), 1);
  assert.equal((await f.card(done)).archiveReason, 'auto');
  await assert.rejects(f.archiver.restore(f.id, 'card_' + randomUUID()), { code: 'E_NOT_FOUND' });
});

test('REQ-52 settings: Off archives nothing, another value takes effect at once, a damaged file never archives', async t => {
  const f = await timed(t);
  const done = await f.addCard('Finished', 'done');
  f.clock.now = T0 + 5 * DAY_MS;
  assert.deepEqual(await writeArchiveSettings(f.store.dataDir, 0), { days: 0, changed: true });
  assert.deepEqual(await writeArchiveSettings(f.store.dataDir, 0), { days: 0, changed: false });
  f.clock.now = T0 + 90 * DAY_MS;
  assert.equal(await f.archiver.sweep(), 0, 'off');
  assert.equal((await f.card(done)).archivedAt, null);
  await fs.writeFile(join(f.store.dataDir, ARCHIVE_SETTINGS_FILE), '{"schemaVersion":1,"days":"seven"}');
  assert.deepEqual(await readArchiveSettings(f.store.dataDir), { days: 0, damaged: true });
  assert.equal(await f.archiver.sweep(), 0, 'damaged: fail closed');
  await fs.writeFile(join(f.store.dataDir, ARCHIVE_SETTINGS_FILE), 'not json');
  assert.deepEqual(await readArchiveSettings(f.store.dataDir), { days: 0, damaged: true });
  await assert.rejects(writeArchiveSettings(f.store.dataDir, 366), { code: 'E_VALIDATION' });
  await assert.rejects(writeArchiveSettings(f.store.dataDir, 2.5), { code: 'E_VALIDATION' });
  // Saving over a damaged file writes a sound one; setDays sweeps at once.
  const result = await f.archiver.setDays(3);
  assert.deepEqual(result, { days: 3, changed: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.archiver.sweep();
  assert.equal((await f.card(done)).archiveReason, 'auto');
  const stored = JSON.parse(await fs.readFile(join(f.store.dataDir, ARCHIVE_SETTINGS_FILE), 'utf8'));
  assert.equal(stored.schemaVersion, 1); assert.equal(stored.days, 3);
  assert.equal(((await fs.stat(join(f.store.dataDir, ARCHIVE_SETTINGS_FILE))).mode & 0o777), 0o600);
  assert.deepEqual((await fs.readdir(f.store.dataDir)).filter(n => n.includes('.tmp-')), []);
});

test('REQ-52 wake: a screen read sweeps in the background at most every ten minutes', async t => {
  const f = await timed(t);
  await f.addCard('One', 'done');
  f.clock.now = T0 + 8 * DAY_MS;
  let sweeps = 0;
  const real = f.store.listBoardIdentities.bind(f.store);
  f.store.listBoardIdentities = async () => { sweeps++; return real(); };
  f.archiver.wake();
  await f.archiver.settled();
  assert.equal((await f.archiver.list(f.id)).total, 1);
  f.archiver.wake(); f.archiver.wake(); await f.archiver.settled();
  assert.equal(sweeps, 1, 'within ten minutes: no second sweep');
  f.clock.now += 10 * 60 * 1000 - 1;
  f.archiver.wake(); await f.archiver.settled();
  assert.equal(sweeps, 1, 'a moment before ten minutes: still none');
  f.clock.now += 1;
  f.archiver.wake(); await f.archiver.settled();
  assert.equal(sweeps, 2);
});

test('REQ-52 tidy: every card now in Done, as the person\'s act, in batches past a hundred; cancelled cards are listed apart', async t => {
  const f = await timed(t);
  const ops = [];
  for (let i = 0; i < 130; i++) ops.push({ op: 'add', title: 'Done ' + i, intent: 'requested', acceptanceCriteria: criteria, stageId: 'done' });
  await f.write(ops.slice(0, 100)); await f.write(ops.slice(100));
  const open = await f.addCard('Cancelled');
  f.clock.now += 1000;
  await f.write([{ op: 'archive', id: open }]);
  f.clock.now += 1000;
  assert.deepEqual(await f.archiver.tidy(f.id), { archived: 130 });
  const b = await f.store.readBoard(f.id);
  assert.equal(b.cards.filter(c => c.archivedAt === null).length, 0);
  assert.equal(b.cards.filter(c => c.archiveReason).length, 0, 'a person\'s act keeps no reason');
  assert.deepEqual(summarizeBoard(b).progress, { done: 130, requested: 130, draft: 0, archived: 131, archivedDone: 130, percent: 100 });
  const list = await f.archiver.list(f.id);
  assert.equal(list.total, 131); assert.equal(list.archivedDone, 130); assert.equal(list.cards.length, 131);
  const cancelled = list.cards.find(c => c.title === 'Cancelled');
  assert.equal(cancelled.done, false); assert.equal(cancelled.auto, undefined);
  assert.deepEqual(await f.archiver.tidy(f.id), { archived: 0 });
});

test('REQ-52 W_SCALE: the 300-card mark counts the cards still on the board, not the archived ones', async t => {
  const f = await timed(t);
  const ops = i => Array.from({ length: 100 }, (_, n) => ({ op: 'add', title: 'Card ' + i + '-' + n, intent: 'requested', acceptanceCriteria: criteria, stageId: 'done' }));
  for (let i = 0; i < 3; i++) await f.write(ops(i));
  await f.archiver.tidy(f.id);
  const quiet = await f.write([{ op: 'add', title: 'Live one' }]);
  assert.ok(!quiet.warnings.some(w => w.code === 'W_SCALE'), JSON.stringify(quiet.warnings));
  assert.ok(!(await f.store.boardWarnings(f.id)).some(w => w.code === 'W_SCALE'));
  assert.equal((await f.store.readBoard(f.id)).cards.length, 301);
});

test('REQ-52 RPC: the screens\' shapes — the detail\'s archive, the days, tidy, list and restore; no reason from a screen', () => {
  const boardId = 'board_' + 'a'.repeat(64), cardId = 'card_' + randomUUID();
  const base = { boardId, requestId: randomUUID(), ifRevision: randomUUID() + ':2' };
  assert.ok(boardMutate.input.safeParse({ ...base, operations: [{ op: 'archive', id: cardId }] }).success);
  assert.ok(!boardMutate.input.safeParse({ ...base, operations: [{ op: 'archive', id: cardId, reason: 'auto' }] }).success);
  assert.ok(!boardMutate.input.safeParse({ ...base, operations: [{ op: 'restore', id: cardId }] }).success);
  for (const days of [0, 7, 365]) assert.ok(archiveSettingsSet.input.safeParse({ days }).success);
  for (const days of [-1, 366, 1.5, '7']) assert.ok(!archiveSettingsSet.input.safeParse({ days }).success);
  assert.ok(archiveTidy.input.safeParse({ boardId }).success && !archiveTidy.input.safeParse({ boardId, cardIds: [] }).success);
  assert.ok(archivedList.input.safeParse({ boardId }).success);
  assert.ok(archivedRestore.input.safeParse({ boardId, cardId }).success && !archivedRestore.input.safeParse({ boardId }).success);
});

test('REQ-52 reads: the overview says the days and every board its finished cards archived', async t => {
  const f = await timed(t);
  const card = await f.addCard('Finished', 'done');
  await f.write([{ op: 'archive', id: card }]);
  const handlers = createReadHandlers(f.store, () => iso(f.clock.now), async () => ({ available: false, source: 'none', definitions: [], byWorkspace: {} }),
    async () => ({ active: [], entries: [] }));
  const reply = await handlers.overview({ hostId: 'host_example', includeBoards: true });
  assert.ok(reply.ok, JSON.stringify(reply));
  assert.ok(overviewGet.output.safeParse(reply).success);
  assert.deepEqual(reply.data.autoArchive, { days: 7 });
  assert.equal(reply.data.boardViews[0].summary.progress.archivedDone, 1);
  assert.equal(reply.data.boards[0].progress.archivedDone, 1);
  await writeArchiveSettings(f.store.dataDir, 14);
  assert.deepEqual((await handlers.overview({ hostId: 'host_example' })).data.autoArchive, { days: 14 });
  assert.equal((await handlers.overview({})).data.autoArchive, undefined, 'only with a host');
  const board = await handlers.board({ boardId: f.id, hostId: 'host_example' });
  assert.deepEqual(board.data.autoArchive, { days: 14 });
});

test('REQ-52 copy: every new line in both languages, English without Korean, the list line says how and when', () => {
  const keys = ['archivedCount', 'archivedCountLabel', 'tidy', 'tidyLabel', 'tidyConfirm', 'tidyGo', 'tidyDone', 'tidyFailed', 'archivedShow',
    'archivedTitle', 'archivedEmpty', 'archivedLoading', 'archivedFailed', 'archivedAuto', 'archivedByHand', 'archivedNotDone', 'archivedMore',
    'restore', 'restoreLabel', 'restored', 'restoreFailed', 'autoArchive', 'autoArchiveHelp', 'autoArchiveOff', 'autoArchiveDays',
    'autoArchiveDamaged', 'archiveCard', 'archiveCardHelp', 'archiveFailed'];
  const sample = v => typeof v === 'function' ? v(...Array.from({ length: v.length }, (_, i) => i ? 'Example' : 12)) : v;
  for (const locale of ['en', 'ko']) {
    const m = copy(locale);
    for (const key of keys) {
      assert.ok(m[key] !== undefined, locale + ' ' + key);
      const text = String(sample(m[key]));
      assert.ok(text.length > 0, locale + ' ' + key);
      if (locale === 'en') assert.ok(!HANGUL.test(text), key + ': ' + text);
      else assert.ok(HANGUL.test(text), key + ': ' + text);
    }
  }
  const en = copy('en'), ko = copy('ko');
  assert.equal(en.archivedCount(48), 'Archived 48'); assert.equal(ko.archivedCount(48), '보관 48');
  assert.equal(en.autoArchiveDays(1), '1 day'); assert.equal(ko.autoArchiveDays(7), '7일');
  assert.ok(en.tidyConfirm(12).includes('12') && ko.tidyConfirm(12).includes('12'));
  const now = Date.parse('2026-10-04T00:00:00Z');
  const auto = { id: 'card_' + randomUUID(), title: 'A', stageId: 'done', archivedAt: '2026-10-03T05:00:00.000Z', auto: true, done: true };
  assert.match(archivedLine(auto, 'Done', en, now), /^Done · Archived automatically 10-03 \d\d:00$/);
  assert.match(archivedLine({ ...auto, auto: undefined, done: false, stageId: 'todo' }, '대기', ko, now), /^대기 · 10-03 \d\d:00 보관 · 완료 전 보관 · 진행률 제외$/);
});

test('298-F1: an open screen\'s revisions look wakes the automatic archive (ten minutes apart), and the next look sees it', async t => {
  // The callbacks index.server.ts registers, taken from its syntax tree and run as they are (research/298's method).
  const ts = (await import('typescript')).default, vm = await import('node:vm');
  const source = await fs.readFile(new URL('../index.server.ts', import.meta.url), 'utf8'), ast = ts.createSourceFile('index.server.ts', source, ts.ScriptTarget.Latest, true);
  const callbacks = {};
  const visit = n => { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'server.handle' && ['boardGet', 'revisionsGet'].includes(n.arguments[0]?.getText(ast)))
    callbacks[n.arguments[0].getText(ast)] = n.arguments[1].getText(ast); ts.forEachChild(n, visit); };
  visit(ast);
  const f = await timed(t);
  const card = await f.addCard('Finished', 'done');
  const handlers = createReadHandlers(f.store, () => iso(f.clock.now), async () => ({ available: false, source: 'none', definitions: [], byWorkspace: {} }),
    async () => ({ active: [], entries: [] }));
  const context = vm.createContext({ archiver: Promise.resolve(f.archiver), handlers: Promise.resolve(handlers), auto: { wake() {} }, dispatch: { wake() {} }, Promise });
  const run = key => vm.runInContext(ts.transpileModule('(' + callbacks[key] + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const boardGet = run('boardGet'), revisionsGet = run('revisionsGet');
  f.clock.now = T0 + 7 * DAY_MS - 1;
  await boardGet({ boardId: f.id }, { paseo: {} }); await f.archiver.settled();
  const before = (await revisionsGet({ boardIds: [f.id] })).data.boards[0].revision; await f.archiver.settled();
  f.clock.now = T0 + 7 * DAY_MS + 1;
  await revisionsGet({ boardIds: [f.id] }); await f.archiver.settled();
  assert.equal((await f.card(card)).archivedAt, null, 'still within ten minutes of the last sweep');
  f.clock.now = T0 + 7 * DAY_MS + 10 * 60 * 1000 - 1;
  await revisionsGet({ boardIds: [f.id] }); await f.archiver.settled();
  assert.equal((await f.card(card)).archiveReason, 'auto', 'ten minutes after the last sweep, the look sweeps');
  const after = (await revisionsGet({ boardIds: [f.id] })).data.boards[0].revision;
  assert.notEqual(after, before, 'the board\'s revision moved, so the open screen reads it again');
});

test('298-F2: the screen\'s own choice lasts only until the server\'s next reading; a damaged file read later is said', async () => {
  const { shownArchive } = await import('../dist/client/archive-model.js');
  const first = { days: 7 };
  assert.deepEqual(shownArchive(undefined, null), { days: 7, damaged: false });
  assert.deepEqual(shownArchive(first, { days: 14, base: first, saving: true }), { days: 7, damaged: false }, 'an unconfirmed choice cannot override the server');
  assert.deepEqual(shownArchive(first, { days: 14, base: first }), { days: 14, damaged: false }, 'saved, the same reading');
  assert.deepEqual(shownArchive({ days: 0 }, { days: 14, base: first }), { days: 0, damaged: false }, 'another screen\'s later value wins');
  assert.deepEqual(shownArchive({ days: 0, damaged: true }, { days: 14, base: first }), { days: 0, damaged: true }, 'the notice is not hidden');
  const damaged = { days: 0, damaged: true };
  assert.deepEqual(shownArchive(damaged, { days: 3, base: damaged }), { days: 3, damaged: false }, 'just saved over the damaged file');
  assert.deepEqual(shownArchive({ days: 0, damaged: true }, { days: 3, base: damaged, saving: true }), { days: 0, damaged: true });
});
