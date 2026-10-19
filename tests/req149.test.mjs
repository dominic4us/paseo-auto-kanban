// REQ-149 (research/423): "Check up" — the four rules (every agent archived in progress or review, still for over 7 days, waiting
// in the first stage for over 14 days, a draft older than 14 days), their edges, what is never a candidate, the device's skips,
// the plan a person's choice makes, and that writing it through the ledger changes the ticked cards only — a board changed
// meanwhile keeps its own move. The screens are in tests/web/run.mjs (=req149). Made-up names only; boards live in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { openStore, validateBoard } from '../dist/server/core/index.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { boardMutate } from '../dist/shared/rpc.js';
import { addSkip, CHECKUP_LIMITS, checkupCandidates, checkupGroups, checkupLine, checkupPlan, checkupResult, checkupRule, DAY_MS, homeOperations, olderThan,
  operationsOf, readSkips, selectionCounts, skipHolds, withoutSkipped } from '../dist/client/checkup-model.js';
import { copy } from '../dist/client/i18n.js';
import { testTmpdir } from './helpers.mjs';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const NOW = Date.parse('2026-10-17T03:00:00.000Z');
const ago = (days, ms = 0) => new Date(NOW - days * DAY_MS - ms).toISOString();
const STAGES = [['todo', '대기', false], ['doing', '진행', false], ['review', '검토', false], ['done', '완료', true]];
const card = (id, extra = {}) => ({ id, title: 'Card ' + id, stageId: 'doing', intent: 'requested', blocked: false, awaiting: null, agentIds: [],
  updatedAt: ago(30), createdAt: ago(40), stageEnteredAt: ago(30), ...extra });
const boardOf = (id, cards, summary = {}) => ({ summary: { id, revision: 'r-' + id + ':1', ...summary },
  stages: STAGES.map(([stageId, name, countsAsDone]) => ({ stageId, name, countsAsDone, cards: cards.filter(c => c.stageId === stageId) })) });
/** A signal store: `archived` ids, `activity` by id, `pending` ids; ready unless said. */
const signals = ({ archived = [], activity = {}, pending = [], ready = true } = {}) => ({ archived: id => archived.includes(id),
  activity: id => activity[id], pending: id => pending.includes(id), ready });
const ruleOf = (c, stageId = c.stageId, s = signals(), lead) => checkupRule(c, { countsAsDone: stageId === 'done' }, stageId === 'todo', lead, s, NOW);

test('REQ-149 limits: 7 days still, 14 days waiting and draft; "over" means past the whole days, and an unreadable time never is', () => {
  assert.deepEqual(CHECKUP_LIMITS, { stalledDays: 7, waitingDays: 14, draftDays: 14 });
  assert.equal(olderThan(ago(7), NOW, 7), false);
  assert.equal(olderThan(ago(7, 1), NOW, 7), true);
  assert.equal(olderThan(undefined, NOW, 7), false);
  assert.equal(olderThan('not a time', NOW, 7), false);
});

test('REQ-149 R1: every linked agent archived, in a stage after the first and not done — suggests Done; one agent still live is not', () => {
  const s = signals({ archived: ['a1', 'a2'], activity: { a3: ago(0) } });
  assert.equal(ruleOf(card('x', { agentIds: ['a1'], updatedAt: ago(0), stageEnteredAt: ago(0) }), 'doing', s), 'orphaned', 'no days needed');
  assert.equal(ruleOf(card('x', { stageId: 'review', agentIds: ['a1', 'a2'] }), 'review', s), 'orphaned');
  assert.equal(ruleOf(card('x', { agentIds: ['a1', 'a3'], updatedAt: ago(0) }), 'doing', s), null, 'one of two still live and active');
  assert.equal(ruleOf(card('x', { stageId: 'done', agentIds: ['a1'] }), 'done', s), null, 'done: REQ-52 looks after it');
  assert.equal(ruleOf(card('x', { stageId: 'todo', agentIds: ['a1'], updatedAt: ago(1), stageEnteredAt: ago(1) }), 'todo', s), null,
    'the first stage: put back on purpose (research/423 assumption 3)');
  const [one] = checkupCandidates([boardOf('b1', [card('x', { agentIds: ['a1'] })])], s, NOW);
  assert.equal(one.rule, 'orphaned'); assert.equal(one.suggest, 'done'); assert.equal(one.doneStageId, 'done'); assert.equal(one.agentId, 'a1');
  const [two] = checkupCandidates([boardOf('b1', [card('y', { agentIds: ['a1', 'a2', 'a1'] })])], s, NOW);
  assert.equal(two.agents, 2); assert.equal(two.agentId, undefined, 'two agents: "all 2 archived", no name');
});

test('REQ-149 never a candidate: blocked, waiting for a person, busy, a request on its way, agents still being named, nothing read yet', () => {
  const s = signals({ archived: ['a1'] }), base = { agentIds: ['a1'] };
  assert.equal(ruleOf(card('x', { ...base, blocked: true }), 'doing', s), null);
  assert.equal(ruleOf(card('x', { ...base, awaiting: 'user' }), 'doing', s), null);
  assert.equal(ruleOf(card('x', { ...base, busy: { text: 'Build', since: ago(0), by: 'cli' } }), 'doing', s), null);
  assert.equal(ruleOf(card('x', { ...base, dispatch: { state: 'pending', sentAt: null } }), 'doing', s), null);
  assert.equal(ruleOf(card('x', { ...base, dispatch: { state: 'noLead', sentAt: null } }), 'doing', s), null);
  assert.equal(ruleOf(card('x', { ...base, dispatch: { state: 'sent', sentAt: ago(20) } }), 'doing', s), 'orphaned', 'sent long ago is history');
  assert.equal(ruleOf(card('x', { agentIds: ['a1', 'a9'] }), 'doing', signals({ archived: ['a1'], pending: ['a9'] })), null, 'a9 still being named');
  assert.equal(ruleOf(card('x', base), 'doing', signals({ archived: ['a1'], ready: false })), null, 'the listing not read yet');
  assert.equal(ruleOf(card('x'), 'doing', signals({ ready: false })), 'stalled', 'no agent: nothing to wait for');
});

test('REQ-149 R2: entered, changed and its live agents active all over 7 days ago — the edge, a recent busy end, the lead card', () => {
  const s = signals({ activity: { live: ago(8) } });
  assert.equal(ruleOf(card('x', { stageEnteredAt: ago(7), updatedAt: ago(7) })), null, 'exactly 7 days is not over');
  assert.equal(ruleOf(card('x', { stageEnteredAt: ago(7, 1), updatedAt: ago(7, 1) })), 'stalled');
  assert.equal(ruleOf(card('x', { stageEnteredAt: ago(9), updatedAt: ago(2) })), null, 'changed lately');
  assert.equal(ruleOf(card('x', { stageEnteredAt: ago(2), updatedAt: ago(9) })), null, 'entered lately');
  assert.equal(ruleOf(card('x', { stageId: 'review', agentIds: ['live'] }), 'review', s), 'stalled', 'review counts too');
  assert.equal(ruleOf(card('x', { agentIds: ['live'] }), 'doing', signals({ activity: { live: ago(6) } })), null, 'its agent was active 6 days ago');
  assert.equal(ruleOf(card('x', { agentIds: ['live'] }), 'doing', signals()), null, 'an agent with no known activity is not judged');
  assert.equal(ruleOf(card('x', { agentIds: ['live'] }), 'doing', s, 'live'), null, 'the board\'s lead card lives long on purpose');
  assert.equal(ruleOf(card('x', { busyEndedAt: ago(1) })), null, 'a busy mark turned off yesterday');
  assert.equal(ruleOf(card('x', { stageEnteredAt: undefined, updatedAt: ago(9) })), 'stalled', 'no entry time: its last change (an older server)');
  assert.equal(ruleOf(card('x', { updatedAt: undefined })), null, 'no change time: fail closed');
  const [c] = checkupCandidates([boardOf('b1', [card('x', { agentIds: ['live', 'gone'] })])], signals({ archived: ['gone'], activity: { live: ago(9) } }), NOW);
  assert.equal(c.rule, 'stalled'); assert.equal(c.suggest, null); assert.deepEqual(c.lastActive, { at: ago(9), agentId: 'live', days: 9 });
});

test('REQ-149 R3: a request in the first stage over 14 days, its live agents quiet as long — no suggestion', () => {
  const todo = extra => card('x', { stageId: 'todo', ...extra });
  assert.equal(ruleOf(todo({ stageEnteredAt: ago(14), updatedAt: ago(14) })), null, 'exactly 14 days');
  assert.equal(ruleOf(todo({ stageEnteredAt: ago(14, 1), updatedAt: ago(14, 1) })), 'waiting');
  assert.equal(ruleOf(todo({ stageEnteredAt: ago(20), updatedAt: ago(13) })), null);
  assert.equal(ruleOf(todo({ agentIds: ['live'] }), 'todo', signals({ activity: { live: ago(3) } })), null, 'its agent was busy this week');
  assert.equal(ruleOf(todo({ agentIds: ['gone'] }), 'todo', signals({ archived: ['gone'] })), 'waiting', 'agent gone, sat there 30 days');
  const [c] = checkupCandidates([boardOf('b1', [todo({ stageEnteredAt: ago(27), updatedAt: ago(27) })])], signals(), NOW);
  assert.equal(c.rule, 'waiting'); assert.equal(c.suggest, null); assert.equal(c.days, 27); assert.equal(c.doneStageId, 'done');
});

test('REQ-149 R4: a draft never sent, made and changed over 14 days ago — suggests Archive, never Done', () => {
  const draft = extra => card('d', { stageId: 'todo', intent: 'draft', createdAt: ago(26), updatedAt: ago(26), stageEnteredAt: ago(26), ...extra });
  assert.equal(ruleOf(draft()), 'draft');
  assert.equal(ruleOf(draft({ createdAt: ago(14), updatedAt: ago(14) })), null, 'exactly 14 days');
  assert.equal(ruleOf(draft({ updatedAt: ago(3) })), null, 'edited this week: still being thought about');
  assert.equal(ruleOf(draft({ dispatch: { state: 'pending', sentAt: null } })), null, 'asked to be sent');
  assert.equal(ruleOf(draft({ dispatch: { state: 'sent', sentAt: ago(20) } })), null, 'sent once: not a forgotten draft');
  assert.equal(ruleOf(draft({ agentIds: ['gone'] }), 'todo', signals({ archived: ['gone'] })), 'draft', 'a draft is never R1 or R3');
  const [c] = checkupCandidates([boardOf('b1', [draft()])], signals(), NOW);
  assert.equal(c.suggest, 'archive'); assert.equal(c.doneStageId, undefined); assert.equal(c.days, 26); assert.equal(c.since, ago(26));
});

test('REQ-149 list: one card at most once, by rule then the longest waiting, across boards; a board with no done stage cannot take Done', () => {
  const s = signals({ archived: ['a1', 'a2'] });
  const b1 = boardOf('b1', [card('r2', { stageEnteredAt: ago(9) }), card('r1new', { agentIds: ['a1'], stageEnteredAt: ago(1), updatedAt: ago(1) }),
    card('d1', { stageId: 'todo', intent: 'draft', createdAt: ago(20), updatedAt: ago(20) }), card('ok', { updatedAt: ago(0) }), card('fin', { stageId: 'done' })]);
  const b2 = boardOf('b2', [card('r1old', { stageId: 'review', agentIds: ['a2'], stageEnteredAt: ago(5), updatedAt: ago(5) }),
    card('r3', { stageId: 'todo', stageEnteredAt: ago(30) })]);
  const list = checkupCandidates([b1, b2], s, NOW);
  assert.deepEqual(list.map(c => c.cardId), ['r1old', 'r1new', 'r2', 'r3', 'd1']);
  assert.deepEqual(checkupGroups(list).map(g => [g.rule, g.cards.length]), [['orphaned', 2], ['stalled', 1], ['waiting', 1], ['draft', 1]]);
  const noDone = { summary: { id: 'b3', revision: 'r:1' }, stages: [{ stageId: 'open', name: 'Open', countsAsDone: false, cards: [] },
    { stageId: 'work', name: 'Work', countsAsDone: false, cards: [card('z', { stageId: 'work', agentIds: ['a1'] })] }] };
  const [z] = checkupCandidates([noDone], s, NOW);
  assert.equal(z.rule, 'orphaned'); assert.equal(z.suggest, null); assert.equal(z.doneStageId, undefined);
});

test('REQ-149 skip: holds until the card changes or 7 days pass; the kept list drops what no longer holds and anything malformed', () => {
  const c = { key: 'b\u0000x', updatedAt: ago(20) };
  const skips = addSkip({}, c, NOW);
  assert.equal(skipHolds(skips, c, NOW), true);
  assert.equal(skipHolds(skips, { ...c, updatedAt: ago(1) }, NOW), false, 'the card changed');
  assert.equal(skipHolds(skips, c, NOW + 7 * DAY_MS), true, 'exactly 7 days later');
  assert.equal(skipHolds(skips, c, NOW + 7 * DAY_MS + 1), false);
  const later = addSkip(skips, { key: 'b\u0000y', updatedAt: ago(1) }, NOW + 8 * DAY_MS);
  assert.deepEqual(Object.keys(later), ['b\u0000y'], 'the old skip is dropped');
  assert.deepEqual(withoutSkipped([c, { key: 'other', updatedAt: '' }], skips, NOW).map(v => v.key), ['other']);
  assert.deepEqual(readSkips({ ok: { at: ago(0), updatedAt: ago(1) }, bad: { at: 3 }, worse: null }), { ok: { at: ago(0), updatedAt: ago(1) } });
  assert.deepEqual(readSkips([1, 2]), {}); assert.deepEqual(readSkips('x'), {});
});

test('REQ-149 plan: only the ticked cards, by board; Done leaves drafts out, Archive takes them; operations the RPC accepts', () => {
  const s = signals({ archived: ['a1'] });
  const list = checkupCandidates([boardOf('b1', [card('x', { agentIds: ['a1'] }), card('y', { agentIds: ['a1'] }),
    card('d', { stageId: 'todo', intent: 'draft', createdAt: ago(20), updatedAt: ago(20) })]),
    boardOf('b2', [card('w', { stageId: 'todo', stageEnteredAt: ago(30) })])], s, NOW);
  const key = id => list.find(c => c.cardId === id).key, ticked = new Set([key('x'), key('d'), key('w')]);
  assert.deepEqual(selectionCounts(list, ticked), { total: 3, done: 2, notDone: 1 });
  const done = checkupPlan(list, ticked, 'done');
  assert.equal(done.skipped, 1);
  assert.deepEqual(done.boards.map(b => [b.boardId, b.revision, operationsOf(b.cards)]), [
    ['b1', 'r-b1:1', [{ op: 'move', id: 'x', to: 'done' }]], ['b2', 'r-b2:1', [{ op: 'move', id: 'w', to: 'done' }]]]);
  const archive = checkupPlan(list, ticked, 'archive');
  assert.equal(archive.skipped, 0);
  assert.deepEqual(archive.boards.flatMap(b => operationsOf(b.cards)), [{ op: 'archive', id: 'x' }, { op: 'archive', id: 'd' }, { op: 'archive', id: 'w' }]);
  assert.deepEqual(checkupPlan(list, new Set(), 'done'), { boards: [], skipped: 0 });
  // What the screen sends, through the RPC's own input check.
  for (const b of [...done.boards, ...archive.boards]) {
    const input = { boardId: 'board_' + 'a'.repeat(64), requestId: randomUUID(), ifRevision: randomUUID() + ':3',
      operations: operationsOf(b.cards).map(op => ({ ...op, id: 'card_' + randomUUID() })) };
    assert.equal(boardMutate.input.safeParse(input).success, true);
  }
});

test('REQ-149 plan and Undo: each board carries the revision the list read; Undo sends every card home', () => {
  const list = checkupCandidates([boardOf('b1', [card('x', { agentIds: ['a1'] }), card('y', { stageId: 'review', agentIds: ['a1'] })])], signals({ archived: ['a1'] }), NOW);
  const [one] = checkupPlan(list, new Set(list.map(c => c.key)), 'done').boards;
  assert.equal(one.revision, 'r-b1:1');
  assert.deepEqual(one.cards.map(c => Object.keys(c).sort()), [['cardId', 'from', 'title', 'to'], ['cardId', 'from', 'title', 'to']], 'no time is carried as evidence (gate 433)');
  assert.deepEqual(homeOperations(one.cards), [{ op: 'move', id: 'x', to: 'doing' }, { op: 'move', id: 'y', to: 'review' }]);
});

const [A_AGENT, B_AGENT, E_AGENT] = ['a', 'b', 'e'].map(n => '00000000-0000-4000-8000-00000000000' + n);
/** A real store whose clock the test moves, with the board's cards made 20 days before `NOW`. */
async function ledger(t) {
  const root = await mkdtemp(join(await testTmpdir(), 'kanban-req149-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const clock = { now: NOW - 20 * DAY_MS }, user = { kind: 'user' };
  const store = await openStore({ dataDir: join(root, 'data'), context: { newId: randomUUID, now: () => new Date(clock.now).toISOString() } });
  const id = (await store.initBoard({ cwd, workspaceId: 'wks_example01', actor: user, requestId: randomUUID() })).data.boardId;
  const write = (operations, extra = {}) => store.mutateBoard(id, { actor: user, requestId: randomUUID(), operations, ...extra }, 'board');
  const added = async (title, stageId, intent = 'requested') => (await write([{ op: 'add', title, intent, acceptanceCriteria: 'A reviewable result exists.', stageId }])).data.cardIds[0];
  const ids = { a: await added('Release script', 'doing'), b: await added('Notice for testers', 'review'), c: await added('Licence choice', 'todo'),
    d: await added('Old idea', 'todo', 'draft'), e: await added('Live work', 'doing') };
  await write([{ op: 'link', id: ids.a, agentId: A_AGENT }, { op: 'link', id: ids.b, agentId: B_AGENT }, { op: 'link', id: ids.e, agentId: E_AGENT }]);
  clock.now = NOW;
  const view = async () => { const board = await store.readBoard(id); return { board, dto: toBoardDTO(board, 'ko', 'off', NOW) }; };
  const s = signals({ archived: [A_AGENT, B_AGENT], activity: { [E_AGENT]: ago(0) } });
  return { store, id, ids, write, view, s };
}
/** The board without what a write is expected to change: the revision, its time, the history and the receipts. */
const rest = (board, except) => ({ ...board, revision: '', updatedAt: '', history: [], receipts: [],
  cards: board.cards.filter(c => !except.includes(c.id)) });

test('REQ-149 ledger: Done moves the ticked cards only, as the person\'s move; nothing else on the board changes', async t => {
  const { ids, write, view, s } = await ledger(t);
  const { board: before, dto } = await view();
  const list = checkupCandidates([dto], s, NOW);
  assert.deepEqual(list.map(c => [c.cardId, c.rule]), [[ids.b, 'orphaned'], [ids.a, 'orphaned'], [ids.c, 'waiting'], [ids.d, 'draft']],
    'the live agent\'s card is not one; the same day sorts by title');
  const ticked = new Set(list.filter(c => c.cardId === ids.a || c.cardId === ids.d).map(c => c.key));
  const plan = checkupPlan(list, ticked, 'done');
  assert.equal(plan.skipped, 1, 'the draft is left out of Done');
  const [one] = plan.boards;
  const reply = await write(operationsOf(one.cards), { ifRevision: one.revision });
  assert.equal(reply.data.changed, true);
  const { board: after } = await view();
  assert.equal(after.cards.find(c => c.id === ids.a).stageId, 'done');
  assert.deepEqual(rest(after, [ids.a]), rest(before, [ids.a]), 'every other card exactly as it was');
  assert.equal(after.history.length, before.history.length + 1);
  assert.deepEqual(after.history.at(-1), { ...after.history.at(-1), cardId: ids.a, from: 'doing', to: 'done', actor: { kind: 'user' } });
  validateBoard(after);
});

test('REQ-149 ledger: Archive puts the ticked cards away (drafts too) and a restore brings them back where they were', async t => {
  const { ids, write, view, s } = await ledger(t);
  const { board: before, dto } = await view();
  const list = checkupCandidates([dto], s, NOW), ticked = new Set(list.filter(c => c.cardId === ids.b || c.cardId === ids.d).map(c => c.key));
  const [one] = checkupPlan(list, ticked, 'archive').boards;
  await write(operationsOf(one.cards), { ifRevision: one.revision });
  const { board: after } = await view();
  for (const cardId of [ids.b, ids.d]) assert.notEqual(after.cards.find(c => c.id === cardId).archivedAt, null);
  assert.deepEqual(rest(after, [ids.b, ids.d]), rest(before, [ids.b, ids.d]));
  validateBoard(after);
  await write([{ op: 'restore', id: ids.b }]);
  const { board: back } = await view();
  const b = back.cards.find(c => c.id === ids.b);
  assert.equal(b.archivedAt, null); assert.equal(b.stageId, 'review');
});

test('REQ-149 ledger: a board changed since the list was read refuses the write and nothing is retried; the list read again offers the rest', async t => {
  const { store, id, ids, write, view, s } = await ledger(t);
  const { dto } = await view();
  const list = checkupCandidates([dto], s, NOW), ticked = new Set(list.filter(c => c.cardId === ids.a || c.cardId === ids.b).map(c => c.key));
  const [one] = checkupPlan(list, ticked, 'done').boards;
  await write([{ op: 'move', id: ids.b, to: 'todo' }]);
  await assert.rejects(write(operationsOf(one.cards), { ifRevision: one.revision }), error => error.code === 'E_REVISION_CONFLICT');
  // The screen reads the boards again; the person's moved card is no longer a candidate, the other one is, on the new revision.
  const fresh = await view(), again = checkupCandidates([fresh.dto], s, NOW).filter(c => ticked.has(c.key));
  assert.deepEqual(again.map(c => c.cardId), [ids.a]);
  const [next] = checkupPlan(again, ticked, 'done').boards;
  assert.equal(next.revision, fresh.board.revision);
  const done = await write(operationsOf(next.cards), { ifRevision: next.revision });
  const end = await store.readBoard(id);
  assert.equal(end.cards.find(c => c.id === ids.a).stageId, 'done');
  assert.equal(end.cards.find(c => c.id === ids.b).stageId, 'todo', 'the person\'s move wins');
  // Undo on the revision the write produced puts it home; on any later one the ledger refuses it.
  await write([{ op: 'update', id: ids.e, patch: { nextAction: 'Elsewhere' } }]);
  await assert.rejects(write(homeOperations(next.cards), { ifRevision: done.data.revision }), error => error.code === 'E_REVISION_CONFLICT');
  validateBoard(await store.readBoard(id));
});

test('REQ-149 copy: every line in both languages, English without Korean; the reason line names the agent, the days and the workspace', () => {
  const en = copy('en'), ko = copy('ko');
  const keys = Object.keys(en).filter(k => k.startsWith('checkup'));
  assert.ok(keys.length >= 30);
  for (const key of keys) assert.equal(typeof ko[key], typeof en[key], key);
  const sample = v => typeof v === 'function' ? [v(3, 14), v('orphaned', 7), v('stalled', 7), v('waiting', 14), v('draft', 14)].join(' ') : JSON.stringify(v);
  for (const key of keys) assert.doesNotMatch(sample(en[key]), HANGUL, key);
  assert.equal(ko.checkup, '점검'); assert.equal(en.checkup, 'Check up');
  assert.notEqual(ko.checkup, ko.tidy, 'apart from REQ-52\'s 정리');
  const name = id => ({ a1: '실행_Opus', live: '산출물_Opus' })[id] ?? id;
  const s = signals({ archived: ['a1', 'a2'], activity: { live: ago(9) } });
  const list = checkupCandidates([boardOf('b1', [card('x', { agentIds: ['a1'], stageEnteredAt: ago(3, 1) }), card('y', { stageId: 'review', agentIds: ['a1', 'a2'] }),
    card('z', { agentIds: ['live'], stageEnteredAt: ago(9) }), card('w', { stageId: 'todo', stageEnteredAt: ago(27) }),
    card('d', { stageId: 'todo', intent: 'draft', createdAt: ago(26), updatedAt: ago(26) })])], s, NOW);
  assert.deepEqual(list.map(c => checkupLine(c, 'paseo-kanban', name, ko)), ['paseo-kanban · 검토 30일째 · 담당 2명 모두 보관됨',
    'paseo-kanban · 진행 3일째 · 실행_Opus 보관됨', 'paseo-kanban · 진행 9일째 · 마지막 활동 9일 전 (산출물_Opus)',
    'paseo-kanban · 대기 27일째 · 담당 없음', 'paseo-kanban · 초안 26일째']);
  assert.equal(checkupLine({ ...list[1], stageName: 'In progress' }, 'docs', name, en), 'docs · In progress for 3 days · 실행_Opus archived');
  // Gate 431 F4: a live agent is never said to be archived — quiet for 20 days, some of two archived, activity unknown.
  const live = checkupCandidates([boardOf('b2', [card('r3', { stageId: 'todo', agentIds: ['quiet'], stageEnteredAt: ago(20), updatedAt: ago(20) }),
    card('r2', { agentIds: ['quiet', 'a1'], stageEnteredAt: ago(9), updatedAt: ago(9) })])], signals({ archived: ['a1'], activity: { quiet: ago(20) } }), NOW);
  const quietName = id => id === 'quiet' ? 'Quiet' : id;
  assert.deepEqual(live.map(c => [c.rule, c.agents, c.archivedAgents, c.lastActive?.days]), [['stalled', 2, 1, 20], ['waiting', 1, 0, 20]]);
  assert.deepEqual(live.map(c => checkupLine(c, 'Example', quietName, ko)), ['Example · 진행 9일째 · 마지막 활동 20일 전 (Quiet) · 담당 2명 중 1명 보관됨',
    'Example · 대기 20일째 · 마지막 활동 20일 전 (Quiet)']);
  assert.deepEqual(live.map(c => checkupLine(c, 'Example', quietName, en)), ['Example · 진행 for 9 days · last active 20 days ago (Quiet) · 1 of 2 agents archived',
    'Example · 대기 for 20 days · last active 20 days ago (Quiet)']);
  for (const m of [ko, en]) {
    const line = checkupLine({ ...live[1], lastActive: undefined }, 'Example', quietName, m);
    assert.ok(line.endsWith(m.checkupNoActivity(1)) && !line.includes(m.checkupArchivedAll(1)), line);
  }
  assert.equal(en.checkupDoneLeftOut(3, 1), 'Done · 3 (1 left out)'); assert.equal(ko.checkupDoneLeftOut(3, 1), '완료로 3장 · 1장 제외');
});

test('REQ-149 notice: a lost reply, a refusal, a move meanwhile and success are each said as such, in both languages', () => {
  for (const m of [copy('ko'), copy('en')]) {
    assert.deepEqual(checkupResult({ count: 2, left: 0, refused: 1, unknown: true }, 'done', m), { text: m.checkupUnknown, error: true });
    assert.deepEqual(checkupResult({ count: 0, left: 0, refused: 3, unknown: false }, 'done', m), { text: m.checkupFailed, error: true });
    assert.deepEqual(checkupResult({ count: 1, left: 0, refused: 2, unknown: false }, 'archive', m), { text: m.checkupPartialFailed(1, 2), error: true });
    assert.deepEqual(checkupResult({ count: 2, left: 1, refused: 0, unknown: false }, 'done', m), { text: m.checkupPartial(2, 1), error: true });
    assert.deepEqual(checkupResult({ count: 2, left: 1, refused: 0, unknown: false }, 'undo', m), { text: m.checkupUndoPartial(2, 1), error: true });
    assert.deepEqual(checkupResult({ count: 0, left: 2, refused: 0, unknown: false }, 'undo', m), { text: m.checkupLeftAll(2), error: true });
    assert.deepEqual(checkupResult({ count: 3, left: 0, refused: 0, unknown: false }, 'done', m), { text: m.checkupMoved(3), error: false });
    assert.deepEqual(checkupResult({ count: 1, left: 0, refused: 0, unknown: false }, 'archive', m), { text: m.checkupArchived(1), error: false });
    assert.deepEqual(checkupResult({ count: 3, left: 0, refused: 0, unknown: false }, 'undo', m), { text: m.checkupUndone(3), error: false });
  }
});
