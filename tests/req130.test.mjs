// REQ-130 (research/260 C): what a lead does itself shows on its card — the lead's own state first on its status row
// (at work / waiting on you — REQ-133: to answer, to check, an error — / resting, read from the agent signals, nothing saved) and a one-line memo under it, which is the
// REQ-84 busy mark (`busy.json`) turned on from the detail as well as by `kanban card busy`. The screens are exercised in
// tests/plugin-ui.test.mjs ("REQ-130 …") and tests/web/run.mjs ("REQ-130").
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../dist/server/core/index.js';
import { BUSY_BY_SCREEN, BUSY_FILE, readBusy, busyOf } from '../dist/server/busy.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { busyClear, busySet, cardGet, revisionsGet } from '../dist/shared/rpc.js';
import { awaitingShown, leadSelf, leadStatus, deviceClock } from '../dist/client/lead-status.js';
import { memoText, SCREEN_BY, busyView } from '../dist/client/busy-view.js';
import { cardNeedsAttention } from '../dist/client/swimlane-model.js';
import { copy } from '../dist/client/i18n.js';

const NOW = Date.parse('2026-10-02T09:30:00.000Z'); // 18:30 KST
const M = 60_000;
const read = map => id => map[id] ?? 'unknown';
const at = minutesAgo => new Date(NOW - minutesAgo * M).toISOString();
const stages = [{ stageId: 'todo', countsAsDone: false }, { stageId: 'doing', countsAsDone: false }, { stageId: 'review', countsAsDone: false },
  { stageId: 'done', countsAsDone: true }];
const card = (id, extra = {}) => ({ id, title: id, stageId: 'doing', nextAction: '', awaiting: 'none', agentIds: [], blocked: false,
  intent: 'requested', ...extra });

test('REQ-130 the lead\'s own state: at work, waiting on you (REQ-133: to check, to answer, an error) or resting — a wait first', () => {
  const base = { leadAgentIds: ['lead'], activeAt: at(48), since: id => ({ lead: at(12) })[id], activity: id => ({ lead: at(5) })[id] };
  assert.deepEqual(leadSelf({ ...base, read: read({ lead: 'working' }) }), { kind: 'working', since: at(12), agent: 'lead' }, 'timed from when it was seen to start');
  for (const [bucket, kind] of [['attention', 'unseen'], ['permission', 'asking'], ['error', 'error']]) {
    assert.deepEqual(leadSelf({ ...base, read: read({ lead: bucket }) }), { kind, since: at(12), agent: 'lead' }, bucket);
  }
  // Not seen to change (it was so when the screen opened): at work has no time; a wait reads the agent's last activity.
  const unseen = { ...base, since: () => undefined };
  assert.deepEqual(leadSelf({ ...unseen, read: read({ lead: 'working' }) }), { kind: 'working', since: '', agent: 'lead' });
  assert.deepEqual(leadSelf({ ...unseen, read: read({ lead: 'attention' }) }), { kind: 'unseen', since: at(5), agent: 'lead' });
  assert.deepEqual(leadSelf({ ...unseen, activity: undefined, read: read({ lead: 'attention' }) }), { kind: 'unseen', since: at(48), agent: 'lead' });
  for (const bucket of ['idle', 'unknown', 'orphaned']) {
    assert.deepEqual(leadSelf({ ...base, read: read({ lead: bucket }) }), { kind: 'rest', since: at(48), agent: '' }, bucket + ': resting since the last activity');
  }
  assert.deepEqual(leadSelf({ ...base, activeAt: undefined, read: read({}) }), { kind: 'rest', since: '', agent: '' });
  // Two agents: one waiting for you wins over one at work.
  assert.equal(leadSelf({ ...base, leadAgentIds: ['lead', 'lead2'], read: read({ lead: 'working', lead2: 'attention' }) }).kind, 'unseen');
  assert.equal(leadSelf({ ...base, leadAgentIds: ['', 'lead2'], read: read({ lead2: 'working' }) }).kind, 'working');
  assert.equal(leadSelf({ ...base, leadAgentIds: [], read: read({}) }), null, 'no agent of its own: nothing to say');
  assert.equal(leadSelf({ ...base, leadAgentIds: [''], read: read({}) }), null);
});

test('REQ-130 the row keeps every REQ-104 part after the lead\'s own state, with or without sub-cards at work', () => {
  const members = [card('a', { agentIds: ['w1'] }), card('b', { agentIds: ['w2'], awaiting: 'user', stageId: 'review' })];
  const input = { own: [], stages, lead: { id: 'lead-card' }, leadAgentIds: ['lead'], activeAt: at(30), now: NOW,
    since: () => at(12), activity: () => at(30) };
  const busy = leadStatus({ ...input, members, read: read({ lead: 'working', w1: 'working' }) });
  assert.deepEqual([busy.running, busy.awaiting, busy.me], [['a'], ['b'], { kind: 'working', since: at(12), agent: 'lead' }], 'the sub-cards\' parts stay');
  assert.equal(busy.idle, null);
  const alone = leadStatus({ ...input, members: [], read: read({ lead: 'attention' }) });
  assert.deepEqual([alone.running, alone.awaiting, alone.me.kind, alone.idle], [[], [], 'unseen', deviceClock(at(30), NOW)]);
  // D43 as it was: the lead asking you itself is still counted with the cards awaiting you.
  const asking = leadStatus({ ...input, members: [], read: read({ lead: 'permission' }) });
  assert.deepEqual([asking.awaiting, asking.self, asking.me.kind], [['lead-card'], true, 'asking']);
  // Awaiting answer with only its own wait: no "awaiting" part; with a waiting sub-card too, that one alone is counted. Other states count all.
  assert.equal(awaitingShown(asking), 0);
  const both = leadStatus({ ...input, members, read: read({ lead: 'permission' }) });
  assert.deepEqual([both.awaiting, both.self, both.me.kind, awaitingShown(both)], [['lead-card', 'b'], true, 'asking', 1]);
  assert.equal(awaitingShown({ ...both, me: { kind: 'working', since: at(12), agent: 'lead' } }), 2);
});

test('REQ-130 words: ko/en, the time as the busy mark\'s age, resting as the KST clock', () => {
  const en = copy('en'), ko = copy('ko');
  assert.equal(en.leadSelfWorking(en.busyAge({ unit: 'minute', count: 12 })), 'Lead working · 12m');
  assert.equal(ko.leadSelfWorking(ko.busyAge({ unit: 'minute', count: 12 })), '총괄 작업 중 · 12분');
  assert.equal(ko.leadSelfWorking(''), '총괄 작업 중');
  assert.equal(en.leadSelfAsking(en.busyAge({ unit: 'now' })), 'Needs your answer · <1m');
  assert.equal(ko.leadSelfAsking(ko.busyAge({ unit: 'minute', count: 5 })), '답변 대기 · 5분');
  assert.equal(en.leadSelfRest(deviceClock(at(48), NOW)), 'Idle · since 17:42');
  assert.equal(ko.leadSelfRest(deviceClock(at(48), NOW)), '쉼 · 17:42부터');
  assert.equal(ko.leadSelfRest(''), '쉼');
  assert.equal(ko.memoLabel('출시 전 시험 · 12분', true), '메모: 출시 전 시험 · 12분 — 2시간 넘음, 확인 필요');
  assert.equal(en.busyByScreen, 'the board screen');
  assert.equal(ko.busyByScreen, '보드 화면');
});

test('REQ-130 memo words: one line, 1-200 characters, as `kanban card busy` keeps them', () => {
  assert.equal(memoText('  출시 전\n 시험 '), '출시 전 시험');
  assert.equal(memoText('   '), null);
  assert.equal(memoText('가'.repeat(200)), '가'.repeat(200));
  assert.equal(memoText('가'.repeat(201)), null);
  assert.equal(SCREEN_BY, BUSY_BY_SCREEN, 'the screen and the server name the screen alike');
  // The REQ-84 two-hour rule is the memo's: past it the card needs a person.
  const memo = { text: '출시 전 시험', since: new Date(NOW - 2 * 3600_000 - M).toISOString(), by: SCREEN_BY };
  assert.equal(busyView(memo, NOW).overdue, true);
  assert.equal(busyView({ ...memo, since: at(119) }, NOW).overdue, false);
  assert.equal(cardNeedsAttention({ stageId: 'doing', awaiting: 'none', blocked: false, intent: 'requested', busy: memo }, stages, NOW), true);
});

// ---- the server: the detail's memo and the CLI's busy mark are one -------------------------------------------------------
const entry = resolve('dist/src/cli/main.js');
async function cli(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'kanban-req130-')), cwd = join(root, 'work'), data = join(root, 'data');
  await fs.mkdir(cwd);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = args => new Promise((done, reject) => {
    const base = { ...process.env }; delete base.PASEO_AGENT_CWD; delete base.PASEO_AGENT_ID; delete base.KANBAN_DATA_DIR;
    const child = spawn(process.execPath, [entry, ...args, '--data-dir', data, '--json'], { cwd, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.once('error', reject);
    child.once('close', code => { try { done({ code, stderr, value: stdout ? JSON.parse(stdout) : null }); } catch (error) { reject(error); } });
  });
  const ok = async args => { const r = await run(args); assert.equal(r.code, 0, r.stderr); assert.equal(r.value.ok, true); return r.value; };
  await ok(['init']);
  const add = async title => (await ok(['card', 'add', '--title', title, '--criteria', 'Result recorded', '--intent', 'requested', '--stage', 'doing'])).data.cardIds[0];
  return { data, ok, add };
}

test('REQ-130 the detail\'s memo is the busy mark: set from the screen, read and ended by the CLI, and the other way round', async t => {
  const c = await cli(t), id = await c.add('Lead card'), other = await c.add('Other card');
  const h = createReadHandlers(await openStore({ dataDir: c.data }));
  const boardId = (await c.ok(['rev'])).data.boardId, revision = (await c.ok(['rev'])).data.revision;
  const look = async () => revisionsGet.output.parse(await h.revisions({ groups: true })).data.boards[0];
  // On from the screen: one line kept, by "screen", now; only busy.json changes.
  const on = busySet.output.parse(await h.setBusy({ boardId, cardId: id, text: '  출시 전\n시험 ' }));
  assert.equal(on.ok, true);
  assert.deepEqual([on.data.changed, on.data.busy.text, on.data.busy.by], [true, '출시 전 시험', 'screen']);
  assert.ok(Math.abs(Date.now() - Date.parse(on.data.busy.since)) < 60_000);
  assert.deepEqual(busyOf(await readBusy(c.data), boardId)?.get(id), on.data.busy, 'the same file the CLI writes');
  assert.equal((await look()).revision, revision, 'the ledger\'s revision stays');
  assert.match((await look()).busy, /^[0-9a-f]{16}$/, 'the screens see it change');
  assert.equal(cardGet.output.parse(await h.card({ boardId, cardId: id })).data.busy.text, '출시 전 시험');
  // The CLI replaces it (its words, its "by") and ends it; the screen reads that.
  const cliOn = await c.ok(['card', 'busy', id, '배포 확인']);
  assert.deepEqual([cliOn.data.busy.text, cliOn.data.busy.by], ['배포 확인', 'cli']);
  assert.equal(cardGet.output.parse(await h.card({ boardId, cardId: id })).data.busy.by, 'cli');
  await c.ok(['card', 'busy', id, '--off']);
  assert.equal(cardGet.output.parse(await h.card({ boardId, cardId: id })).data.busy, null);
  // On from the screen, off from the CLI; on from the CLI, off from the screen.
  busySet.output.parse(await h.setBusy({ boardId, cardId: id, text: '출시 전 시험' }));
  const off = await c.ok(['card', 'busy', id, '--off']);
  assert.equal(off.data.changed, true);
  await c.ok(['card', 'busy', id, '시험']);
  assert.deepEqual(busyClear.output.parse(await h.clearBusy({ boardId, cardId: id })).data, { changed: true });
  assert.equal(busyOf(await readBusy(c.data), boardId), undefined);
  // Another card's mark is left as it is.
  await c.ok(['card', 'busy', other, '빌드']);
  busySet.output.parse(await h.setBusy({ boardId, cardId: id, text: '메모' }));
  assert.equal(busyOf(await readBusy(c.data), boardId)?.get(other)?.text, '빌드');
  // Refused: no words, too long, an unknown card or board, an archived card — nothing written.
  const before = await fs.readFile(join(c.data, BUSY_FILE), 'utf8');
  for (const input of [{ boardId, cardId: id, text: '   ' }, { boardId, cardId: id, text: 'x'.repeat(201) },
    { boardId, cardId: 'card_00000000-0000-4000-8000-000000000000', text: '메모' }, { boardId: 'board_' + 'f'.repeat(64), cardId: id, text: '메모' }]) {
    const reply = busySet.output.parse(await h.setBusy(input));
    assert.equal(reply.ok, false, JSON.stringify(input));
  }
  await c.ok(['card', 'update', other, '--archive']);
  const archived = busySet.output.parse(await h.setBusy({ boardId, cardId: other, text: '메모' }));
  assert.deepEqual([archived.ok, archived.ok ? null : archived.error.code], [false, 'E_VALIDATION']);
  assert.equal(JSON.parse(await fs.readFile(join(c.data, BUSY_FILE), 'utf8')).boards[boardId][id].text, JSON.parse(before).boards[boardId][id].text);
  assert.equal((await c.ok(['rev'])).data.revision === revision, false, 'the archive alone moved the ledger');
});
