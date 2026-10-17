// REQ-84: work that is not an agent's turn — a lead's own test run, a person's build, a script — marked on a card with
// `kanban card busy CARD "TEXT"` and ended with `--off`. Kept in the data folder's busy.json (never the ledger), read into
// the board's cards by the server, shown as a dashed ring and edge with the words and the elapsed time; past two hours it
// asks a person to look (never switched off by time). The screens are exercised in tests/web/run.mjs ("REQ-84").
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openStore, builtinTemplate, applyOperations } from '../dist/server/core/index.js';
import { BUSY_FILE, busyKey, busyOf, busyText, pruneBusy, readBusy, readBusyFile, setBusy } from '../dist/server/busy.js';
import { busyOverdue as serverOverdue, toBoardDTO, toOverview } from '../dist/server/read-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { boardGet, busyClear, cardGet, overviewGet, revisionsGet } from '../dist/shared/rpc.js';
import { busyView, busyOverdue, busyByName, isAgentId } from '../dist/client/busy-view.js';
import { cardDimensions, cardNeedsAttention, overdueKey } from '../dist/client/swimlane-model.js';
import { quietSince, stageDwell } from '../dist/client/stage-time.js';
import { leadStatus, deviceClock } from '../dist/client/lead-status.js';
import { knownRevisions, revisionsChanged, shownRevision } from '../dist/client/refresh-model.js';
import { copy } from '../dist/client/i18n.js';
import { board, context, actor } from './helpers.mjs';

const entry = resolve('dist/src/cli/main.js');
const H = 3600_000;
async function cli(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'kanban-req84-')), cwd = join(root, 'work'), data = join(root, 'data');
  await fs.mkdir(cwd);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (args, env = {}) => new Promise((done, reject) => {
    const base = { ...process.env }; delete base.PASEO_AGENT_CWD; delete base.PASEO_AGENT_ID; delete base.KANBAN_DATA_DIR;
    const child = spawn(process.execPath, [entry, ...args, '--data-dir', data, '--json'], { cwd, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.once('error', reject);
    child.once('close', code => { try { done({ code, stderr, value: stdout ? JSON.parse(stdout) : null }); } catch (error) { reject(error); } });
  });
  const ok = async (args, env) => { const r = await run(args, env); assert.equal(r.code, 0, r.stderr); assert.equal(r.value.ok, true); return r.value; };
  await ok(['init']);
  const add = async title => (await ok(['card', 'add', '--title', title, '--criteria', 'Result recorded', '--intent', 'requested', '--stage', 'doing'])).data.cardIds[0];
  return { root, cwd, data, run, ok, add };
}
const file = async data => JSON.parse(await fs.readFile(join(data, BUSY_FILE), 'utf8'));

test('REQ-84 CLI: on, replaced, off — with who and since when, and the ledger untouched', async t => {
  const c = await cli(t), id = await c.add('Example check'), other = await c.add('Other card');
  const before = (await c.ok(['rev'])).data.revision;
  const on = await c.ok(['card', 'busy', id, '테스트 중']);
  assert.equal(on.data.changed, true);
  assert.equal(on.data.busy.text, '테스트 중');
  assert.equal(on.data.busy.by, 'cli', 'no --by and no PASEO_AGENT_ID: "cli"');
  assert.ok(Date.now() - Date.parse(on.data.busy.since) < 60_000);
  assert.equal(on.data.cardId, id);
  const boardId = on.data.boardId, stored = await file(c.data);
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(stored.boards[boardId][id], on.data.busy, 'board id → card id → { text, since, by }');
  assert.equal((await c.ok(['rev'])).data.revision, before, 'the ledger\'s revision does not move');
  // Marking again replaces the words and restarts the time; the agent's id is the default "by".
  await new Promise(r => setTimeout(r, 15));
  const agent = randomUUID();
  const again = await c.ok(['card', 'busy', id, '빌드 중'], { PASEO_AGENT_ID: agent });
  assert.equal(again.data.busy.text, '빌드 중');
  assert.equal(again.data.busy.by, agent);
  assert.ok(again.data.busy.since > on.data.busy.since, 'the time restarts');
  const named = await c.ok(['card', 'busy', other, 'Build', '--by', 'reviewer'], { PASEO_AGENT_ID: agent });
  assert.equal(named.data.busy.by, 'reviewer', '--by wins over PASEO_AGENT_ID');
  assert.equal(Object.keys((await file(c.data)).boards[boardId]).length, 2);
  const off = await c.ok(['card', 'busy', id, '--off']);
  assert.deepEqual([off.data.changed, off.data.busy], [true, null]);
  assert.deepEqual(Object.keys((await file(c.data)).boards[boardId]), [other]);
  const twice = await c.ok(['card', 'busy', id, '--off']);
  assert.equal(twice.data.changed, false, 'off again: nothing to do, no error');
  assert.equal((await c.ok(['rev'])).data.revision, before);
  // The human output names the card and what it does.
  const env = { ...process.env }; delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID; delete env.KANBAN_DATA_DIR;
  const plain = await new Promise(done => { const child = spawn(process.execPath, [entry, 'card', 'busy', id, 'Testing', '--data-dir', c.data], { cwd: c.cwd, env });
    let out = ''; child.stdout.on('data', b => out += b); child.once('close', () => done(out)); });
  assert.match(plain, /^busy card_[0-9a-f]{8} "Testing" since \S+ by cli @ /);
});

test('REQ-84 CLI: the text is required, --off takes none; a missing or archived card is refused', async t => {
  const c = await cli(t), id = await c.add('Example check');
  const noText = await c.run(['card', 'busy', id]);
  assert.equal(noText.code, 2); assert.equal(noText.value.error.code, 'E_USAGE'); assert.match(noText.value.error.message, /Testing/);
  const blank = await c.run(['card', 'busy', id, '   ']);
  assert.equal(blank.code, 2); assert.equal(blank.value.error.code, 'E_VALIDATION');
  const long = await c.run(['card', 'busy', id, 'x'.repeat(201)]);
  assert.equal(long.value.error.code, 'E_VALIDATION');
  assert.equal((await c.run(['card', 'busy', id, 'Testing', '--off'])).value.error.code, 'E_USAGE');
  assert.equal((await c.run(['card', 'busy', id, '--off', '--by', 'x'])).value.error.code, 'E_USAGE');
  assert.equal((await c.run(['card', 'busy', id, 'Testing', '--to', 'doing'])).value.error.code, 'E_USAGE', 'only --off and --by');
  const missing = await c.run(['card', 'busy', 'card_' + randomUUID(), 'Testing']);
  assert.equal(missing.code, 3); assert.equal(missing.value.error.code, 'E_NOT_FOUND');
  await c.ok(['card', 'update', id, '--archive']);
  const archived = await c.run(['card', 'busy', id, 'Testing']);
  assert.equal(archived.value.error.code, 'E_VALIDATION'); assert.match(archived.value.error.message, /Archived/);
  await assert.rejects(fs.stat(join(c.data, BUSY_FILE)), 'nothing was written');
  const help = await c.ok(['card', 'busy', '--help']);
  assert.match(help.data.help, /kanban card busy CARD "TEXT"/); assert.match(help.data.help, /--off/);
});

test('REQ-84 storage: archiving a card drops its mark; writers in parallel lose nothing; no temporary file is left', async t => {
  const c = await cli(t), ids = [];
  for (let i = 0; i < 6; i++) ids.push(await c.add('Card ' + i));
  // Six processes at once, each marking its own card: the lock keeps every mark.
  const runs = await Promise.all(ids.map((id, i) => c.run(['card', 'busy', id, 'Step ' + i])));
  for (const r of runs) assert.equal(r.code, 0, r.stderr);
  const boardId = runs[0].value.data.boardId;
  assert.deepEqual(Object.keys((await file(c.data)).boards[boardId]).sort(), [...ids].sort());
  const names = await fs.readdir(c.data);
  assert.deepEqual(names.filter(n => n.startsWith('.busy.json')), [], 'no lock or temporary file left behind');
  // `card update --archive` and a batch archive prune the mark after the change.
  await c.ok(['card', 'update', ids[0], '--archive']);
  assert.equal((await file(c.data)).boards[boardId][ids[0]], undefined);
  const batch = join(c.root, 'batch.json');
  await fs.writeFile(batch, JSON.stringify({ operations: [{ op: 'archive', id: ids[1] }] }));
  await c.ok(['apply', batch]);
  assert.deepEqual(Object.keys((await file(c.data)).boards[boardId]).sort(), ids.slice(2).sort());
  // A restored card does not get its old mark back.
  await c.ok(['card', 'update', ids[0], '--restore']);
  assert.equal((await file(c.data)).boards[boardId][ids[0]], undefined);
});

test('REQ-84 storage: a lock left by a stopped writer is taken over; a damaged file reads as nothing marked', async t => {
  const data = await fs.mkdtemp(join(tmpdir(), 'kanban-req84-lock-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const boardId = 'board_' + 'b'.repeat(64), cardId = 'card_' + randomUUID(), mark = { text: 'Testing', since: new Date().toISOString(), by: 'cli' };
  // A live lock: the writer waits and then gives up.
  await fs.writeFile(join(data, '.busy.json.lock'), '{}');
  await assert.rejects(setBusy(data, boardId, cardId, mark, { timeoutMs: 200 }), e => e.code === 'E_LOCK_TIMEOUT');
  // Stale (older than 10 s): taken over.
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(join(data, '.busy.json.lock'), old, old);
  assert.deepEqual(await setBusy(data, boardId, cardId, mark, { timeoutMs: 200 }), { busy: mark, changed: true });
  assert.deepEqual(await fs.readdir(data), [BUSY_FILE]);
  assert.deepEqual(await setBusy(data, boardId, cardId, mark), { busy: mark, changed: false }, 'the same mark writes nothing');
  // Damaged: none, never an error.
  for (const bytes of ['{', '[]', JSON.stringify({ schemaVersion: 2, boards: {} }),
    JSON.stringify({ schemaVersion: 1, boards: { [boardId]: { [cardId]: { text: '', since: 'x', by: 'cli' } } } })]) {
    await fs.writeFile(join(data, BUSY_FILE), bytes);
    assert.deepEqual(await readBusy(data), {}, bytes);
  }
  assert.equal(busyText('  Testing \n now '), 'Testing now');
  assert.equal(busyText(' '), null);
  // pruneBusy with nothing to drop takes no lock and writes nothing.
  await setBusy(data, boardId, cardId, mark);
  const stamp = (await fs.stat(join(data, BUSY_FILE))).mtimeMs;
  assert.equal(await pruneBusy(data, boardId, new Set([cardId])), 0);
  assert.equal((await fs.stat(join(data, BUSY_FILE))).mtimeMs, stamp);
  assert.equal(await pruneBusy(data, boardId, new Set()), 1);
  assert.deepEqual(await readBusy(data), {});
  // Different boards at once (no board lock in common): the file's own lock still keeps every mark.
  const boards = Array.from({ length: 12 }, (_, i) => 'board_' + String(i % 10).repeat(63) + (i < 10 ? 'a' : 'b'));
  await Promise.all(boards.map(id => setBusy(data, id, cardId, mark)));
  assert.deepEqual(Object.keys(await readBusy(data)).sort(), [...boards].sort());
  assert.deepEqual(await fs.readdir(data), [BUSY_FILE]);
});

// ---- the server's read ----------------------------------------------------------------------------------------------
const NOW = Date.parse('2026-09-28T04:00:00.000Z');
const ago = hours => new Date(NOW - hours * H).toISOString();
function sample() {
  let b = board();
  for (const title of ['Check run', 'Old run', 'Quiet card', 'Gone card'])
    b = applyOperations(b, [{ op: 'add', title, intent: 'requested', acceptanceCriteria: 'Done.', stageId: 'doing' }], actor, context(ago(5))).board;
  const id = title => b.cards.find(c => c.title === title).id;
  b = applyOperations(b, [{ op: 'archive', id: id('Gone card') }], actor, context(ago(4))).board;
  const marks = new Map([[id('Check run'), { text: '테스트 중', since: ago(0.2), by: 'cli' }],
    [id('Old run'), { text: 'Build', since: ago(2.5), by: 'reviewer' }], [id('Gone card'), { text: 'Stale', since: ago(3), by: 'cli' }]]);
  return { b, id, marks };
}
test('REQ-84 read model: the marks ride on the board\'s cards (not an archived one), with a fingerprint; overdue needs a person', () => {
  const { b, id, marks } = sample();
  const dto = toBoardDTO(b, 'ko', 'off', NOW, undefined, marks);
  const cards = dto.stages.flatMap(s => s.cards);
  assert.deepEqual(cards.find(c => c.id === id('Check run')).busy, marks.get(id('Check run')));
  assert.equal(cards.find(c => c.id === id('Quiet card')).busy, undefined);
  assert.equal(cards.some(c => c.id === id('Gone card')), false);
  assert.match(dto.summary.busy, /^[0-9a-f]{16}$/);
  assert.equal(dto.summary.busy, busyKey(marks, new Set(b.cards.filter(c => !c.archivedAt).map(c => c.id))), 'the archived card\'s mark is not in it');
  assert.equal(toBoardDTO(b, 'ko', 'off', NOW).summary.busy, undefined, 'no marks: no fingerprint');
  boardGet.output.parse({ ok: true, data: { board: dto, revision: b.revision, locale: 'ko', observedAt: ago(0) }, committed: false, warnings: [] });
  // Two hours is the line: 2.5h needs a person; the archived card's does not count.
  assert.equal(serverOverdue({ since: ago(2) }, NOW), false);
  assert.equal(serverOverdue({ since: ago(2.01) }, NOW), true);
  const overview = toOverview([b], 'ko', ago(0), boardId => boardId === b.id ? marks : undefined);
  assert.equal(overview.boards[0].needsHuman, 1);
  assert.deepEqual(overview.attention.map(a => [a.title, a.reasons]), [['Old run', ['busyOverdue']]]);
  overviewGet.output.parse({ ok: true, data: overview, committed: false, warnings: [] });
  assert.equal(toOverview([b], 'ko', ago(0)).boards[0].needsHuman, 0, 'without marks, as before');
});

test('REQ-84 handlers: board, card and overview carry the marks; revisions change with them; the detail turns one off', async t => {
  const c = await cli(t), id = await c.add('Example check');
  const store = await openStore({ dataDir: c.data });
  const h = createReadHandlers(store);
  const boardId = (await c.ok(['rev'])).data.boardId;
  const look = async () => revisionsGet.output.parse(await h.revisions({ groups: true })).data.boards[0];
  const quiet = await look();
  assert.equal(quiet.busy, undefined);
  await c.ok(['card', 'busy', id, '테스트 중']);
  const marked = await look();
  assert.equal(marked.revision, quiet.revision, 'the ledger\'s revision stays');
  assert.match(marked.busy, /^[0-9a-f]{16}$/);
  // The screen compares revision and fingerprint: a mark set after its read is a change; its own read then agrees.
  const read = boardGet.output.parse(await h.board({ boardId })).data.board;
  assert.equal(read.summary.busy, marked.busy);
  assert.equal(read.stages.flatMap(s => s.cards).find(x => x.id === id).busy.text, '테스트 중');
  assert.equal(revisionsChanged(knownRevisions([{ id: boardId, revision: quiet.revision }]), { boards: [marked], errors: [] }, 'all'), true);
  assert.equal(revisionsChanged(knownRevisions([read.summary]), { boards: [marked], errors: [] }, 'all'), false);
  const overview = overviewGet.output.parse(await h.overview({ includeBoards: true })).data;
  assert.equal(overview.boardViews[0].stages.flatMap(s => s.cards).find(x => x.id === id).busy.by, 'cli');
  const card = cardGet.output.parse(await h.card({ boardId, cardId: id })).data;
  assert.equal(card.busy.text, '테스트 중');
  // "Turn off" in the detail: only busy.json changes.
  assert.deepEqual(busyClear.output.parse(await h.clearBusy({ boardId, cardId: id })).data, { changed: true });
  assert.deepEqual(busyClear.output.parse(await h.clearBusy({ boardId, cardId: id })).data, { changed: false });
  assert.equal(cardGet.output.parse(await h.card({ boardId, cardId: id })).data.busy, null);
  const after = await look();
  assert.deepEqual([after.revision, after.busy], [quiet.revision, undefined]);
  assert.equal(busyClear.output.parse(await h.clearBusy({ boardId: 'board_' + 'f'.repeat(64), cardId: id })).ok, false);
  assert.deepEqual(busyOf(await readBusy(c.data), boardId), undefined);
});

// ---- the screen's pure parts ----------------------------------------------------------------------------------------
test('REQ-84 card face: the words and the elapsed time, orange "over 2h" past two hours, a row taller, needs a person then', () => {
  const k = copy('ko'), e = copy('en');
  const fresh = busyView({ text: '테스트 중', since: ago(0.2), by: 'cli' }, NOW);
  assert.equal(k.busyLine(fresh.text, k.busyAge(fresh.age)), '테스트 중 · 12분');
  assert.equal(e.busyLine('Testing', e.busyAge({ unit: 'hour', count: 2 })), 'Testing · 2h');
  assert.equal(k.busyAge({ unit: 'now' }), '1분 미만');
  assert.equal(fresh.overdue, false);
  assert.equal(busyView({ text: 'x', since: ago(2), by: 'cli' }, NOW).overdue, false, 'exactly two hours: not yet');
  assert.equal(busyOverdue({ text: 'x', since: ago(2.1), by: 'cli' }, NOW), true);
  assert.equal(busyView(undefined, NOW), null);
  assert.equal(busyView({ text: 'x', since: 'never', by: 'cli' }, NOW), null);
  assert.equal(k.busyOverdue, '진행 표시 2시간 초과');
  assert.equal(k.busyHint('09-28 12:48', 'cli', true), '시작 09-28 12:48 · 켠 주체 cli\n2시간 넘게 켜져 있음 — 아직 진행 중인지 확인하고 끄세요');
  assert.equal(cardDimensions(false, 1, false, false, true).height - cardDimensions(false).height, 22, 'one row (16) and its gap (6)');
  const stages = builtinTemplate('ko').stages;
  const card = busy => ({ id: 'card_' + randomUUID(), title: 'x', stageId: 'doing', priority: 'normal', intent: 'requested', blocked: false,
    nextAction: '', agents: 0, awaiting: null, agentIds: [], completedAt: null, ...(busy ? { busy } : {}) });
  assert.equal(cardNeedsAttention(card({ text: 'x', since: ago(3), by: 'cli' }), stages, NOW), true);
  assert.equal(cardNeedsAttention(card({ text: 'x', since: ago(1), by: 'cli' }), stages, NOW), false);
  assert.equal(cardNeedsAttention(card(), stages, NOW), false);
});

test('REQ-84 with REQ-86: while a mark is on, the progress column counts the card as at work (no 2h warning)', () => {
  const stages = builtinTemplate('ko').stages, signals = { read: () => 'unknown', ready: true };
  const card = { stageId: 'doing', agentIds: [], stageEnteredAt: ago(5), updatedAt: ago(5) };
  assert.equal(stageDwell(card, stages, signals, NOW).warn, true, 'no agent at all, 5h: the warning');
  const marked = { ...card, busy: { text: '테스트 중', since: ago(3), by: 'cli' } };
  assert.equal(quietSince(marked, Date.parse(card.stageEnteredAt), signals), null);
  const dwell = stageDwell(marked, stages, signals, NOW);
  assert.deepEqual([dwell.shown, dwell.warn], [true, false], 'the time still shows; no warning');
  // Review keeps its own rule: 12h in the column, whatever is marked.
  assert.equal(stageDwell({ ...marked, stageId: 'review', stageEnteredAt: ago(13) }, stages, signals, NOW).warn, true);
});

test('REQ-84 with REQ-104: a lead\'s "Testing HH:MM~" reads the busy marks first, the check-card rule only without them', () => {
  const stages = builtinTemplate('ko').stages, read = () => 'idle';
  const now = Date.parse('2026-09-28T05:00:00.000Z');
  const base = { title: 'Sub', stageId: 'todo', nextAction: '', awaiting: null, agentIds: [], blocked: false, intent: 'requested' };
  const check = { ...base, id: 'card_check', title: '총괄 확인 — tests', stageId: 'doing', nextAction: '총괄 테스트 중 · 시작 13:30', updatedAt: '2026-09-28T04:31:00.000Z' };
  const busySub = { ...base, id: 'card_busy', busy: { text: '빌드 중', since: '2026-09-28T04:40:00.000Z', by: 'cli' } };
  // Without a mark: the check card, as before.
  assert.deepEqual(leadStatus({ members: [], own: [check], stages, read, now }).testing, { at: '13:30', ids: ['card_check'] });
  // A marked sub-card wins — its mark's time, and the check card is left out.
  assert.deepEqual(leadStatus({ members: [busySub], own: [check], stages, read, now }).testing, { at: deviceClock('2026-09-28T04:40:00.000Z', now), ids: ['card_busy'] });
  // REQ-130: the lead's own card marked is its memo line, no longer a check of its row — the sub-card's mark alone.
  const lead = { id: 'card_lead', busy: { text: '테스트 중', since: '2026-09-28T04:20:00.000Z', by: 'cli' } };
  assert.deepEqual(leadStatus({ members: [busySub], own: [], stages, read, lead, now }).testing, { at: deviceClock('2026-09-28T04:40:00.000Z', now), ids: ['card_busy'] });
  assert.equal(leadStatus({ members: [], own: [], stages, read, lead, now }).testing, null, 'its own mark alone: no "Testing" part');
  assert.equal(leadStatus({ members: [], own: [], stages, read, lead: { id: 'card_lead' }, now }).testing, null);
});

test('REQ-84 auto refresh: the shown revision carries the busy fingerprint, and an older server\'s reply still reads', () => {
  assert.equal(shownRevision({ revision: 'r:1' }), 'r:1');
  assert.equal(shownRevision({ revision: 'r:1', groups: 'g' }), 'r:1 g');
  assert.equal(shownRevision({ revision: 'r:1', busy: 'b' }), 'r:1 busy:b');
  assert.equal(shownRevision({ revision: 'r:1', groups: 'g', busy: 'b' }), 'r:1 g busy:b');
  const known = knownRevisions([{ id: 'board_1', revision: 'r:1', busy: 'b' }]);
  assert.equal(revisionsChanged(known, { boards: [{ id: 'board_1', revision: 'r:1' }], errors: [] }, 'all'), true, 'the mark went off');
  assert.equal(revisionsChanged(known, { boards: [{ id: 'board_1', revision: 'r:1', busy: 'b' }], errors: [] }, 'all'), false);
});

// ---- research/174 gate fixes (v0.1.35) ------------------------------------------------------------------------------
test('174 D1: the overview\'s boards carry the busy fingerprint, so the list view sees no change where there is none', async t => {
  const { b, id, marks } = sample();
  const overview = toOverview([b], 'ko', ago(0), boardId => boardId === b.id ? marks : undefined);
  const active = new Set(b.cards.filter(c => !c.archivedAt).map(c => c.id));
  assert.equal(overview.boards[0].busy, busyKey(marks, active), 'as revisions.get says it, the archived card\'s mark left out');
  assert.equal(overview.boards[0].busy, toBoardDTO(b, 'ko', 'off', NOW, undefined, marks).summary.busy);
  overviewGet.output.parse({ ok: true, data: overview, committed: false, warnings: [] });
  assert.equal(toOverview([b], 'ko', ago(0)).boards[0].busy, undefined, 'no marks: no fingerprint');
  // Through the handlers: a board with a mark on, nothing changing — every look agrees with the list's read.
  const c = await cli(t), card = await c.add('Example check');
  await c.ok(['card', 'busy', card, '테스트 중']);
  const h = createReadHandlers(await openStore({ dataDir: c.data }));
  const list = overviewGet.output.parse(await h.overview({})).data;
  const known = knownRevisions(list.boards);
  for (let look = 0; look < 6; look++) {
    const reply = revisionsGet.output.parse(await h.revisions({})).data;
    assert.equal(revisionsChanged(known, reply, 'all'), false, 'look ' + look + ': no re-read of overview.get');
  }
  await c.ok(['card', 'busy', card, '--off']);
  assert.equal(revisionsChanged(known, revisionsGet.output.parse(await h.revisions({})).data, 'all'), true, 'turned off: one re-read');
  void id;
});

test('174 D2: a mark crossing two hours by the clock alone changes the screens\' overdue key', () => {
  const card = (id, since) => ({ id, title: 'x', stageId: 'doing', priority: 'normal', intent: 'requested', blocked: false, nextAction: '',
    agents: 0, awaiting: null, agentIds: [], completedAt: null, ...(since ? { busy: { text: 'x', since, by: 'cli' } } : {}) });
  const boards = [{ stages: [{ cards: [card('card_b', ago(1.99)), card('card_a', ago(3)), card('card_c')] }] }];
  assert.equal(overdueKey(boards, NOW), 'card_a');
  assert.equal(overdueKey(boards, NOW + 60_000), 'card_a card_b', 'a minute later the second one is over');
  assert.equal(overdueKey([], NOW), '');
  // The screens' hook (useMinuteKey) is exercised in tests/plugin-ui.test.mjs ("174 D2").
});

test('174 J2: turning a mark off keeps when it ended; REQ-86 counts two hours from then, not from before the run', async t => {
  const c = await cli(t), id = await c.add('Example check'), other = await c.add('Other card');
  await c.ok(['card', 'busy', id, '테스트 중']); await c.ok(['card', 'busy', other, 'Build']);
  const before = (await c.ok(['rev'])).data.revision;
  const off = await c.ok(['card', 'busy', id, '--off']), boardId = off.data.boardId;
  const ended = (await file(c.data)).cleared[boardId][id];
  assert.ok(Date.now() - Date.parse(ended) < 60_000, 'cleared: board → card → when');
  assert.deepEqual(Object.keys((await readBusyFile(c.data)).cleared[boardId]), [id], 'only the card turned off');
  assert.deepEqual(await readBusy(c.data), { [boardId]: { [other]: (await readBusy(c.data))[boardId][other] } }, 'the marks read as before');
  assert.equal((await c.ok(['rev'])).data.revision, before, 'the ledger stays');
  // The board read says it on that card only, and only while no mark is on.
  const h = createReadHandlers(await openStore({ dataDir: c.data }));
  const cards = boardGet.output.parse(await h.board({ boardId })).data.board.stages.flatMap(s => s.cards);
  assert.equal(cards.find(x => x.id === id).busyEndedAt, ended);
  assert.equal(cards.find(x => x.id === other).busyEndedAt, undefined);
  const listed = overviewGet.output.parse(await h.overview({ includeBoards: true })).data.boardViews[0].stages.flatMap(s => s.cards);
  assert.equal(listed.find(x => x.id === id).busyEndedAt, ended);
  // Marked again: the end is forgotten. Archived: gone with it.
  await c.ok(['card', 'busy', id, 'Again']);
  assert.equal((await file(c.data)).cleared, undefined, 'no end left: the key is left out');
  await c.ok(['card', 'busy', id, '--off']);
  await c.ok(['card', 'update', id, '--archive']); await c.ok(['card', 'busy', other, '--off']);
  assert.deepEqual(Object.keys((await file(c.data)).cleared[boardId]), [other], 'the archived card\'s end is dropped');
  // Ends older than three hours are not written again.
  const data = await fs.mkdtemp(join(tmpdir(), 'kanban-req84-ends-')); t.after(() => fs.rm(data, { recursive: true, force: true }));
  const board1 = 'board_' + 'a'.repeat(64), card1 = 'card_' + randomUUID(), card2 = 'card_' + randomUUID();
  await fs.writeFile(join(data, BUSY_FILE), JSON.stringify({ schemaVersion: 1, boards: {}, cleared: { [board1]: { [card1]: new Date(Date.now() - 4 * H).toISOString() } } }));
  await setBusy(data, board1, card2, { text: 'x', since: new Date().toISOString(), by: 'cli' });
  assert.equal((await file(data)).cleared, undefined);
  // T3: half an hour before the run, inside `CLEARED_KEEP_MS` (a fixed time fell out of it three hours later).
  const endedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  await setBusy(data, board1, card2, null, { at: endedAt });
  assert.equal((await readBusyFile(data)).cleared[board1][card2], endedAt, '`at` names the end');
  // REQ-86: in progress 5h, a run that ended 10 minutes ago — no warning; two hours after it ended, the warning.
  const stages = builtinTemplate('ko').stages, signals = { read: () => 'unknown', ready: true };
  const quiet = { stageId: 'doing', agentIds: [], stageEnteredAt: ago(5), updatedAt: ago(5), busyEndedAt: ago(1 / 6) };
  assert.equal(quietSince(quiet, Date.parse(ago(5)), signals), Date.parse(ago(1 / 6)));
  assert.equal(stageDwell(quiet, stages, signals, NOW).warn, false);
  assert.equal(stageDwell({ ...quiet, busyEndedAt: ago(2.1) }, stages, signals, NOW).warn, true);
  assert.equal(quietSince({ ...quiet, busyEndedAt: 'never' }, Date.parse(ago(5)), signals), Date.parse(ago(5)), 'an unreadable time is left out');
});

test('174 J3: who turned the mark on reads by the agent\'s title, else its id\'s first 8; "cli" and names as they are', () => {
  const agent = randomUUID();
  assert.equal(isAgentId(agent), true); assert.equal(isAgentId('cli'), false); assert.equal(isAgentId('reviewer'), false);
  assert.equal(busyByName(agent, 'Lead-07'), 'Lead-07');
  assert.equal(busyByName(agent, '  '), agent.slice(0, 8));
  assert.equal(busyByName(agent), agent.slice(0, 8));
  assert.equal(busyByName('cli', 'ignored'), 'cli');
  assert.equal(busyByName('reviewer'), 'reviewer');
  assert.equal(copy('ko').busyHint('09-28 12:48', busyByName(agent, 'Lead-07'), false), '시작 09-28 12:48 · 켠 주체 Lead-07');
});
