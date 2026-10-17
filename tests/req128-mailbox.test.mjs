// REQ-128: the lab's message list. The server reads the whole message folder (server/mail-list.ts: boundary, caps, 60 s
// cache, nothing written); the protocol's verdicts are pure (shared/mail-list.ts: turn, closed, a person's decision, left
// waiting by age or due date, two newest files); the list's filters and groups are pure too (client/mail-list-model.ts). The
// screen is exercised in plugin-ui.test.mjs ("REQ-128") and tests/web/run.mjs. Every name here is made up: workspaces "wsA",
// "wsB", "ws_c" (a short name holding "_"), and a person "검토자".
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMailListReader, readMailList, readMailThread, realMailListIo, MAIL_LIST_LIMITS } from '../dist/server/mail-list.js';
import { dueDay, isPersonTurn, kstDay, mailAttention, mailFileHead, mailFileName, mailPeople, mailRecord, mailStatus, mailSubject } from '../dist/shared/mail-list.js';
import { EMPTY_MAIL_FILTER, MAIL_PERSON, mailGroups, mailMatch, mailOptions, mailRows, pickerLabel, searchOptions, toggleChoice } from '../dist/client/mail-list-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { createMailReader, mailExcluded, readMailbox } from '../dist/server/mailbox.js';
import { laneMail } from '../dist/shared/mailbox.js';
import { writeUiState } from '../dist/server/ui-state.js';
import { mailListGet, mailThreadGet } from '../dist/shared/rpc.js';
import { copy } from '../dist/client/i18n.js';
import { fixture } from './helpers.mjs';

async function temp(t, prefix) {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const PERSON = '검토자';
/** A message file as the protocol writes it: the 5 head lines, then the body. */
const msg = ({ title = '제목', from = 'wsA', kind = '요청', to = 'wsB', due = '없음', body = ['본문 1', '본문 2'] } = {}) =>
  [`# ${title}`, `스레드: x · 보낸 곳: ${from} (총괄-01) · 종류: ${kind} · 2026-09-28 10:00 KST`, ...(to === null ? [] : [`받는 곳: ${to}`]),
    `기한: ${due}`, '승인: 해당없음', '', ...body].join('\n');
async function mailbox(t, threads) {
  const dir = await temp(t, 'kanban-req128-');
  for (const [thread, files] of Object.entries(threads)) {
    await fs.mkdir(join(dir, thread));
    for (const [name, text] of Object.entries(files)) await fs.writeFile(join(dir, thread, name), text);
  }
  return dir;
}
/** Every name, size, mtime and content under a folder (links as their target text): a reading must leave it the same. */
async function snapshot(dir) {
  const out = [];
  async function walk(at) {
    for (const e of (await fs.readdir(at, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = join(at, e.name), st = await fs.lstat(p);
      if (e.isSymbolicLink()) out.push([p, 'link', await fs.readlink(p)]);
      else if (e.isDirectory()) { out.push([p, 'dir', st.mtimeMs]); await walk(p); }
      else out.push([p, 'file', st.mtimeMs, st.size, await fs.readFile(p, 'utf8')]);
    }
  }
  await walk(dir);
  return out;
}
// 2026-10-05 09:00 KST
const NOW = Date.parse('2026-10-05T00:00:00Z');
const file = (name, head = {}) => ({ name, ...mailFileName(name), title: head.title ?? null, to: head.to === undefined ? 'wsB' : head.to, due: head.due ?? null });
const thread = (id, latest, extra = {}) => ({ id, subject: extra.subject ?? id, files: extra.files ?? latest.length, latest });

// ---- ① reading a name and a head -------------------------------------------------------------------------------------
test('REQ-128 ① a file name gives its time, sender and kind (a short name may hold "_"), the head its title, turn and due', () => {
  assert.deepEqual(mailFileName('20260930-0910_wsA_재질의.md'), { at: '2026-09-30 09:10', from: 'wsA', kind: '재질의' });
  assert.deepEqual(mailFileName('20260930-0910_ws_c_회신.md'), { at: '2026-09-30 09:10', from: 'ws_c', kind: '회신' });
  assert.deepEqual(mailFileName('메모.md'), { at: null, from: null, kind: null });
  assert.deepEqual(mailFileHead(msg({ title: '요청 — 정리 단계', to: `${PERSON} (기록: wsA)`, due: '2026-10-05' })),
    { title: '요청 — 정리 단계', to: `${PERSON} (기록: wsA)`, due: '2026-10-05' });
  assert.deepEqual(mailFileHead(msg({ to: null })).to, null, 'no line: unknown');
  assert.equal(mailSubject('요청 — 정리 단계', 'id'), '정리 단계', 'the kind dropped');
  assert.equal(mailSubject('정리: 남은 것', 'id'), '정리: 남은 것', 'not a kind: kept');
  assert.equal(mailSubject(null, 'the-id'), 'the-id');
  assert.deepEqual(mailRecord(`${PERSON} (기록: wsA)`), { person: PERSON, keeper: 'wsA' });
  assert.equal(mailRecord('wsA'), null);
  assert.equal(dueDay('2026-10-05'), 20261005); assert.equal(dueDay('2026.10.5'), 20261005); assert.equal(dueDay('없음'), null); assert.equal(dueDay('10-05'), null);
  assert.equal(kstDay(Date.parse('2026-10-04T15:00:00Z')), 20261005, 'KST midnight');
});

// ---- ② the protocol's verdicts ---------------------------------------------------------------------------------------
test('REQ-128 ② whose turn, closed, a person\'s decision (record line or a learned bare name), left waiting by age or due', () => {
  const open = thread('t1', [file('20261004-1000_wsA_요청.md', { to: 'wsB' })]);
  assert.deepEqual(mailStatus(open, NOW, []), { state: 'open', stale: null, from: ['wsA'], to: ['wsB'], unknown: false, kind: '요청',
    at: '2026-10-04 10:00', due: null, dueToday: false, tie: false });
  const closed = thread('t2', [file('20260901-1000_wsA_종결.md', { to: '없음' })]);
  assert.equal(mailStatus(closed, NOW, []).state, 'closed');
  assert.equal(mailStatus(closed, NOW, []).stale, null, 'a closed thread is never left waiting');
  assert.deepEqual(mailStatus(closed, NOW, []).to, [], '"없음" is no one');
  const person = thread('t3', [file('20261004-1000_wsA_재질의.md', { to: `${PERSON} (기록: wsA)` })]);
  assert.equal(mailStatus(person, NOW, []).state, 'decision');
  const bare = thread('t4', [file('20261004-1000_wsA_질문.md', { to: PERSON })]);
  assert.equal(mailStatus(bare, NOW, []).state, 'open', 'a bare name nobody recorded is a workspace for all we know');
  assert.deepEqual(mailPeople([person, bare]), [PERSON]);
  assert.equal(mailStatus(bare, NOW, mailPeople([person, bare])).state, 'decision', 'once the records name the person');
  assert.equal(isPersonTurn('검토자들의방', [PERSON]), false, 'a longer name is not the person');
  // 7 days, as the protocol's check counts it: the file's day before the day 7 days ago (KST). NOW is 10-05: 09-28 is not yet, 09-27 is.
  assert.equal(mailStatus(thread('a', [file('20260928-0000_wsA_요청.md')]), NOW, []).stale, null);
  assert.equal(mailStatus(thread('a', [file('20260927-2359_wsA_요청.md')]), NOW, []).stale, 'age');
  assert.equal(mailStatus(thread('a', [file('20260927-2359_wsA_요청.md')]), NOW, []).state, 'stale');
  // Due: past (yesterday) is left waiting; today is not, and says so.
  const dueToday = mailStatus(thread('d', [file('20261004-1000_wsA_요청.md', { due: '2026-10-05' })]), NOW, []);
  assert.deepEqual([dueToday.state, dueToday.stale, dueToday.dueToday, dueToday.due], ['open', null, true, 20261005]);
  const duePast = mailStatus(thread('d', [file('20261004-1000_wsA_요청.md', { due: '2026-10-04' })]), NOW, []);
  assert.deepEqual([duePast.state, duePast.stale], ['stale', 'due']);
  // Both reasons: the passed due date is said.
  assert.equal(mailStatus(thread('d', [file('20260901-1000_wsA_요청.md', { due: '2026-09-02' })]), NOW, []).stale, 'due');
  // A person's decision left waiting stays a decision, marked.
  const late = mailStatus(thread('p', [file('20260920-1000_wsA_재질의.md', { to: `${PERSON} (기록: wsA)` })]), NOW, []);
  assert.deepEqual([late.state, late.stale], ['decision', 'age']);
  // No recipient line: open, unknown.
  assert.deepEqual((({ state, unknown, to }) => ({ state, unknown, to }))(mailStatus(thread('u', [file('20261004-1000_wsA_요청.md', { to: null })]), NOW, [])),
    { state: 'open', unknown: true, to: [] });
});
test('REQ-128 ② two files at the newest time: both read — both recipients, the earliest due, a close among them closes', () => {
  const tie = thread('t', [file('20261004-1000_wsB_회신.md', { to: 'wsA', due: '2026-10-09' }), file('20261004-1000_wsA_질문.md', { to: 'ws_c', due: '2026-10-07' })]);
  const s = mailStatus(tie, NOW, []);
  assert.deepEqual([s.tie, s.from, s.to, s.due, s.kind], [true, ['wsB', 'wsA'], ['wsA', 'ws_c'], 20261007, '회신']);
  const withPerson = thread('t', [file('20261004-1000_wsB_회신.md', { to: 'wsA' }), file('20261004-1000_wsA_재질의.md', { to: `${PERSON} (기록: wsA)` })]);
  assert.equal(mailStatus(withPerson, NOW, []).state, 'decision', 'either one waiting for a person');
  const withClose = thread('t', [file('20261004-1000_wsB_회신.md', { to: 'wsA' }), file('20261004-1000_wsA_종결.md', { to: '없음' })]);
  assert.equal(mailStatus(withClose, NOW, []).state, 'closed');
});
test('REQ-128 ③ the glyph\'s count: a person\'s decisions and the threads left waiting, each thread once', () => {
  const threads = [
    thread('dec', [file('20261004-1000_wsA_재질의.md', { to: `${PERSON} (기록: wsA)` })]),
    thread('dec-late', [file('20260901-1000_wsA_재질의.md', { to: `${PERSON} (기록: wsA)` })]),
    thread('stale', [file('20260901-1000_wsA_요청.md')]),
    thread('due', [file('20261004-1000_wsA_요청.md', { due: '2026-10-01' })]),
    thread('open', [file('20261004-1000_wsA_요청.md')]),
    thread('closed-old', [file('20260801-1000_wsA_종결.md', { to: '없음' })]),
  ];
  assert.equal(mailAttention(threads, NOW), 4);
  assert.equal(mailAttention([], NOW), 0);
});

// ---- ④ filters and groups --------------------------------------------------------------------------------------------
const LIST = [
  thread('1-dec', [file('20261004-0910_wsA_재질의.md', { to: `${PERSON} (기록: wsB)` })], { subject: '시험 폴더 정리' }),
  thread('2-dec', [file('20261001-1745_wsA_회신.md', { to: `${PERSON} (기록: wsA)` })], { subject: '실험실 표시' }),
  thread('3-stale', [file('20260927-0252_wsA_요청.md', { to: 'wsB', due: '2026-10-04' })], { subject: '스킬 이름 규칙' }),
  thread('4-stale', [file('20260926-2255_wsA_회신.md', { to: 'wsB' })], { subject: '작업 단위' }),
  thread('5-open', [file('20261004-0253_wsB_요청.md', { to: 'ws_c' })], { subject: '설정 채우기 검토' }),
  thread('6-closed', [file('20261003-1745_wsA_종결.md', { to: '없음' })], { subject: '누락 방지' }),
  thread('7-closed', [file('20261002-0700_ws_c_종결.md', { to: '없음' })], { subject: '이름 변경' }),
  thread('8-closed', [file('20261001-0700_wsB_종결.md', { to: '없음' })], { subject: '오래된 것' }),
  thread('9-closed', [file('20260930-0700_wsB_종결.md', { to: '없음' })], { subject: '더 오래된 것' }),
];
const ids = view => view.groups.flatMap(g => g.rows.map(r => r.thread.id));
test('REQ-128 ④ groups: a person\'s decision → left waiting → open → closed, newest first; closed shows its newest two until opened', () => {
  const rows = mailRows(LIST, NOW), view = mailGroups(rows, EMPTY_MAIL_FILTER, false);
  assert.deepEqual(view.groups.map(g => [g.state, g.rows.length, g.hidden]), [['decision', 2, 0], ['stale', 2, 0], ['open', 1, 0], ['closed', 2, 2]]);
  assert.deepEqual(ids(view), ['1-dec', '2-dec', '3-stale', '4-stale', '5-open', '6-closed', '7-closed']);
  assert.equal(view.shown, 9, 'the folded ones still count as shown by the filter');
  assert.deepEqual(ids(mailGroups(rows, EMPTY_MAIL_FILTER, true)).slice(-4), ['6-closed', '7-closed', '8-closed', '9-closed']);
});
test('REQ-128 ④ filters: one dropdown\'s choices are or, the dropdowns and, the pill makes them or; a person\'s decision; state; title', () => {
  const rows = mailRows(LIST, NOW), f = patch => ({ ...EMPTY_MAIL_FILTER, ...patch });
  const pick = filter => rows.filter(r => mailMatch(r, filter)).map(r => r.thread.id).sort();
  assert.deepEqual(pick(f({ from: ['wsA'] })), ['1-dec', '2-dec', '3-stale', '4-stale', '6-closed']);
  assert.deepEqual(pick(f({ from: ['wsA', 'ws_c'] })), ['1-dec', '2-dec', '3-stale', '4-stale', '6-closed', '7-closed'], 'or inside one');
  assert.deepEqual(pick(f({ to: ['wsB'] })), ['3-stale', '4-stale'], 'a record keeper is not the recipient');
  assert.deepEqual(pick(f({ to: [MAIL_PERSON] })), ['1-dec', '2-dec']);
  // research/232 v2's example: from wsA and to (the person or wsB) = 4 of 9.
  assert.deepEqual(pick(f({ from: ['wsA'], to: [MAIL_PERSON, 'wsB'] })), ['1-dec', '2-dec', '3-stale', '4-stale']);
  assert.deepEqual(pick(f({ from: ['wsB'], to: ['wsB'] })), [], 'and');
  assert.deepEqual(pick(f({ from: ['wsB'], to: ['wsB'], join: 'or' })), ['3-stale', '4-stale', '5-open', '8-closed', '9-closed'], 'or: any thread wsB is part of');
  assert.deepEqual(pick(f({ to: ['wsB'], join: 'or' })), ['3-stale', '4-stale'], 'the pill matters only with both');
  assert.deepEqual(pick(f({ states: ['stale'] })), ['3-stale', '4-stale']);
  assert.deepEqual(pick(f({ states: ['open'] })), ['1-dec', '2-dec', '5-open'], 'a person\'s decision is open for the state dropdown');
  assert.deepEqual(pick(f({ states: ['stale', 'closed'] })), ['3-stale', '4-stale', '6-closed', '7-closed', '8-closed', '9-closed']);
  assert.deepEqual(pick(f({ query: '오래된' })), ['8-closed', '9-closed'], 'title');
  assert.deepEqual(pick(f({ query: '3-STALE' })), ['3-stale'], 'thread id, any case');
  assert.deepEqual(pick(f({ from: ['wsA'], states: ['stale'], query: '작업' })), ['4-stale'], 'all together');
  const hits = mailMatch(rows.find(r => r.thread.id === '1-dec'), f({ from: ['wsA'], to: [MAIL_PERSON, 'wsB'] }));
  assert.deepEqual([[...hits.from], [...hits.to], hits.person], [['wsA'], [], true], 'the names caught, to underline');
});
test('REQ-128 ④ choices: every workspace\'s short name with its threads on that side, most first, none kept (faded); no person or "없음"', () => {
  const rows = mailRows(LIST, NOW);
  const workspaces = [{ cwd: '/w/wsA', name: 'Workspace A' }, { cwd: '/w/ws B', name: 'Second' }, { cwd: '/w/quiet', name: 'quiet' }];
  const to = mailOptions(rows, 'to', workspaces, 'compact');
  assert.deepEqual(to.map(o => [o.id, o.count]), [['wsB', 2], ['ws_c', 1], ['quiet', 0], ['wsA', 0]]);
  assert.equal(to.find(o => o.id === 'wsB').note, 'Second', 'the workspace\'s name beside its short name');
  assert.ok(!to.some(o => o.id.includes('기록') || o.id === '없음'));
  assert.deepEqual(mailOptions(rows, 'from', workspaces, 'compact').map(o => [o.id, o.count]).slice(0, 3), [['wsA', 5], ['wsB', 3], ['ws_c', 1]]);
  assert.deepEqual(searchOptions(to, 'sec').map(o => o.id), ['wsB'], 'finds by the name too');
  assert.deepEqual(toggleChoice(['a'], 'b'), ['a', 'b']); assert.deepEqual(toggleChoice(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(pickerLabel('받는 곳', ['wsB'], x => x), { text: '받는 곳 wsB', count: 0 });
  assert.deepEqual(pickerLabel('받는 곳', ['wsB', MAIL_PERSON], x => x), { text: '받는 곳', count: 2 });
  assert.equal(copy('ko').mailPersonOf(PERSON), PERSON + ' 결정');
  assert.equal(copy('ko').mailPersonOf(''), '사람 결정', 'no record yet: a neutral word');
});

// ---- ⑤ the server's reading ------------------------------------------------------------------------------------------
test('REQ-128 ⑤ the list: every thread, its newest file(s) and subject; hidden, links and non-messages skipped; nothing written', async t => {
  const outside = await mailbox(t, { secret: { '20261001-0000_x_요청.md': msg({ title: '바깥' }) } });
  const dir = await mailbox(t, {
    '20261001-0900_wsA_one': { '20261001-0900_wsA_요청.md': msg({ title: '요청 — 첫 스레드' }), '20261002-1000_wsB_회신.md': msg({ from: 'wsB', kind: '회신', to: 'wsA', due: '2026-10-09' }),
      'notes.txt': 'x', '.hidden.md': msg() },
    '20261001-0901_wsB_two': { '20261001-0901_wsB_요청.md': msg({ title: '둘' }), '20261003-1200_wsA_접수.md': msg({ to: 'wsA', kind: '접수' }),
      '20261003-1200_ws_c_질문.md': msg({ from: 'ws_c', kind: '질문', to: `${PERSON} (기록: wsB)` }) },
    '20261001-0902_wsA_closed': { '20261001-0902_wsA_요청.md': msg(), '20261002-0902_wsA_종결.md': msg({ to: '없음', kind: '종결' }) },
    '20261001-0903_wsA_empty': {},
    '@eaDir': { 'x.md': msg() }, '.trash': { 'x.md': msg() }, '#recycle': { 'x.md': msg() },
  });
  await fs.symlink(join(outside, 'secret'), join(dir, '20261001-0904_link_out'));
  await fs.symlink(join(outside, 'secret', '20261001-0000_x_요청.md'), join(dir, '20261001-0900_wsA_one', '20261009-0000_wsA_요청.md'));
  await fs.writeFile(join(dir, 'loose.md'), msg());
  const before = await snapshot(dir), outsideBefore = await snapshot(outside);
  const list = await readMailList(dir, realMailListIo, MAIL_LIST_LIMITS, () => new Date(NOW));
  assert.equal(list.state, 'ready'); assert.deepEqual(list.limits, []); assert.equal(list.root, dir);
  assert.deepEqual(list.threads.map(th => th.id), ['20261001-0900_wsA_one', '20261001-0901_wsB_two', '20261001-0902_wsA_closed', '20261001-0903_wsA_empty'],
    'thread order; hidden, @ and # folders and the linked folder left out');
  const [one, two, closed, empty] = list.threads;
  assert.deepEqual([one.subject, one.files, one.latest.map(f => f.name)], ['첫 스레드', 2, ['20261002-1000_wsB_회신.md']],
    'the linked file (sorting newest) and the non-messages are not counted or read');
  assert.deepEqual(one.latest[0], { name: '20261002-1000_wsB_회신.md', at: '2026-10-02 10:00', from: 'wsB', kind: '회신', title: '제목', to: 'wsA', due: '2026-10-09' });
  assert.deepEqual(two.latest.map(f => [f.name, f.to]), [['20261003-1200_ws_c_질문.md', `${PERSON} (기록: wsB)`], ['20261003-1200_wsA_접수.md', 'wsA']], 'both newest, last by name first');
  assert.equal(two.subject, '둘');
  assert.equal(mailStatus(closed, NOW, []).state, 'closed');
  assert.deepEqual([empty.files, empty.latest], [0, []]);
  assert.deepEqual(await snapshot(dir), before, 'the folder is exactly as it was'); assert.deepEqual(await snapshot(outside), outsideBefore);
  assert.equal(JSON.stringify(list).includes('바깥'), false, 'nothing from outside the folder');
  // A folder that is not there, or a relative path: unreadable, nothing thrown.
  assert.equal((await readMailList(join(dir, 'nope'))).state, 'unreadable');
  assert.equal((await readMailList('relative/path')).state, 'unreadable');
  // The folder set may itself be a link (the setting names it); its threads are read from its real path.
  const linkRoot = join(await temp(t, 'kanban-req128-root-'), 'mail');
  await fs.symlink(dir, linkRoot);
  assert.equal((await readMailList(linkRoot)).threads.length, 4);
});
test('REQ-128 ⑤ caps: threads, files per thread and reads are bounded, and a reached cap is said', async t => {
  const threads = {};
  for (let i = 0; i < 6; i++) threads[`2026100${i}-0000_wsA_t${i}`] = Object.fromEntries(Array.from({ length: 5 }, (_, k) => [`2026100${i}-00${k}0_wsA_요청.md`, msg({ title: 'T' + i + k })]));
  const dir = await mailbox(t, threads);
  const capped = await readMailList(dir, realMailListIo, { ...MAIL_LIST_LIMITS, threads: 4, filesPerThread: 3, reads: 5 });
  assert.deepEqual(capped.limits.sort(), ['files', 'reads', 'threads']);
  assert.deepEqual(capped.threads.map(th => th.id.slice(-2)), ['t2', 't3', 't4', 't5'], 'the newest threads kept');
  assert.deepEqual(capped.threads.map(th => th.files), [5, 5, 5, 5], 'the count is the whole thread');
  assert.equal(capped.threads.at(-1).latest[0].title, 'T54', 'the newest read first');
  assert.equal(capped.threads[0].latest[0].title, null, 'past the read cap: named but not read');
  const io = { ...realMailListIo, head: async (...args) => { io.n = (io.n ?? 0) + 1; return realMailListIo.head(...args); } };
  await readMailList(dir, io); assert.equal(io.n, 12, 'two reads a thread: the newest and the first');
  // The head read is capped in bytes.
  const big = await mailbox(t, { '20261001-0000_wsA_big': { '20261001-0000_wsA_요청.md': msg({ to: null }) + '\n' + 'x'.repeat(100000) + '\n받는 곳: late' } });
  assert.equal((await readMailList(big)).threads[0].latest[0].to, null, 'only the first bytes are read');
});
test('REQ-128 ⑤ one thread: its files newest first, the newest ones\' head and excerpt; a name outside the folder is missing', async t => {
  const outside = await mailbox(t, { secret: { '20261001-0000_x_요청.md': msg({ title: '바깥' }) } });
  const body = Array.from({ length: 10 }, (_, i) => '줄 ' + (i + 1));
  const dir = await mailbox(t, { '20261001-0900_wsA_one': {
    '20261001-0900_wsA_요청.md': msg({ title: '요청 — 첫' }), '20261002-1000_wsB_접수.md': msg({ from: 'wsB', kind: '접수', to: 'wsB', title: '접수 — 착수' }),
    '20261003-1100_wsB_회신.md': msg({ from: 'wsB', kind: '회신', to: 'wsA', title: '회신 — 끝', body }),
    '20261003-1100_wsA_질문.md': msg({ kind: '질문', to: 'wsB', title: '질문 — 하나 더' }) } });
  await fs.symlink(join(outside, 'secret'), join(dir, 'linked'));
  const before = await snapshot(dir);
  const one = await readMailThread(dir, '20261001-0900_wsA_one');
  assert.equal(one.state, 'ready'); assert.equal(one.path, join(dir, '20261001-0900_wsA_one')); assert.equal(one.latest, 2); assert.equal(one.more, 0);
  assert.deepEqual(one.files.map(f => f.name), ['20261003-1100_wsB_회신.md', '20261003-1100_wsA_질문.md', '20261002-1000_wsB_접수.md', '20261001-0900_wsA_요청.md']);
  assert.deepEqual(one.files[0].head, ['# 회신 — 끝', '스레드: x · 보낸 곳: wsB (총괄-01) · 종류: 회신 · 2026-09-28 10:00 KST', '받는 곳: wsA', '기한: 없음', '승인: 해당없음']);
  assert.deepEqual(one.files[0].excerpt, body.slice(0, 6));
  assert.ok(one.files[1].head && !one.files[2].head, 'only the newest carry their head');
  assert.deepEqual([one.files[2].title, one.files[2].from, one.files[2].to], ['접수 — 착수', 'wsB', 'wsB']);
  for (const id of ['..', '.', '../' + 'secret', 'a/b', 'linked', '.hidden', '@eaDir', 'nope', '20261001-0900_wsA_one/..'])
    assert.equal((await readMailThread(dir, id)).state, 'missing', id);
  const few = await readMailThread(dir, '20261001-0900_wsA_one', realMailListIo, { ...MAIL_LIST_LIMITS, detailFiles: 3 });
  assert.deepEqual([few.files.length, few.more], [3, 1]);
  assert.deepEqual(await snapshot(dir), before, 'nothing written');
});
test('REQ-128 ⑤ the cache: one folder reading a minute under one fingerprint; another fingerprint reads again at once (research/236 D1)', async () => {
  let time = 0, lists = 0, reads = [];
  const reader = createMailListReader({ now: () => time, list: async dir => { lists++; return { state: 'ready', root: dir, key: 'k' + lists, threads: [], limits: [], readAt: '' }; },
    thread: async (dir, id) => { reads.push(id); return { state: 'ready', id, files: [], latest: 0, more: 0 }; } });
  await reader.list('/m', 'f1'); await reader.list('/m', 'f1'); time = 59_999; assert.equal((await reader.list('/m', 'f1')).source, 'f1');
  assert.equal(lists, 1);
  time = 60_000; await reader.list('/m', 'f1'); assert.equal(lists, 2);
  time = 61_000; const moved = await reader.list('/m', 'f2');
  assert.deepEqual([lists, moved.key, moved.source], [3, 'k3', 'f2'], 'another fingerprint: read at once, not a minute later');
  await reader.list('/other', 'f2'); assert.equal(lists, 4, 'another folder: read');
  await reader.thread('/m', 'a', 'f1'); await reader.thread('/m', 'a', 'f1'); assert.deepEqual(reads, ['a']);
  await reader.thread('/m', 'a', 'f2'); assert.deepEqual(reads, ['a', 'a'], 'another fingerprint reads the thread again');
  const failing = createMailListReader({ list: async () => { throw new Error('x'); } });
  assert.deepEqual([(await failing.list('/m', 'f9')).state, (await failing.list('/m', 'f9')).source], ['unreadable', 'f9']);
});
test('REQ-128 ⑥ the RPCs: the folder is the host\'s lab\'s, never the screen\'s; off reads nothing', async t => {
  const f = await fixture(t);
  const dir = await mailbox(t, { '20261001-0900_wsA_one': { '20261001-0900_wsA_요청.md': msg({ title: '요청 — 하나' }) } });
  let lists = 0, threads = 0;
  const reader = createMailListReader({ list: async d => { lists++; return readMailList(d); }, thread: async (d, id) => { threads++; return readMailThread(d, id); } });
  const h = createReadHandlers(f.store, undefined, undefined, undefined, undefined, undefined, undefined, reader);
  const off = await h.mailList({ hostId: 'host_a' });
  assert.deepEqual([off.ok, off.data.state, off.data.threads], [true, 'off', []]);
  assert.equal((await h.mailThread({ hostId: 'host_a', thread: '20261001-0900_wsA_one' })).data.state, 'off');
  await writeUiState(f.store.dataDir, 'host_a', { settings: { labs: { mailDir: dir } } });
  assert.equal((await h.mailList({ hostId: 'host_a' })).data.state, 'off', 'a folder without the switch: off');
  assert.equal(lists + threads, 0, 'nothing read while off');
  await writeUiState(f.store.dataDir, 'host_a', { settings: { labs: { mail: true } } });
  const on = await h.mailList({ hostId: 'host_a' });
  assert.deepEqual([on.data.state, on.data.threads.map(th => th.subject)], ['ready', ['하나']]);
  const one = await h.mailThread({ hostId: 'host_a', thread: '20261001-0900_wsA_one' });
  assert.deepEqual([one.data.state, one.data.files.length], ['ready', 1]);
  // research/236 J3: the thread is asked by its id alone — no file name rides along any more.
  assert.equal(mailThreadGet.input.safeParse({ hostId: 'host_a', thread: 'x', newest: '/etc/passwd' }).success, false);
  assert.equal((await h.mailThread({ hostId: 'host_a', thread: '..' })).data.state, 'missing');
  assert.equal((await h.mailList({ hostId: 'host_b' })).data.state, 'off', 'another host: its own lab');
  // The screen cannot name a folder.
  assert.throws(() => mailListGet.input.parse({ hostId: 'host_a', dir: '/etc' }));
  assert.throws(() => mailThreadGet.input.parse({ hostId: 'host_a', thread: 'x', dir: '/etc' }));
  assert.equal((await h.mailList({ hostId: 'host_a', dir: '/etc' })).ok, false);
});

// ---- research/236: the gate's defects, each as it was found ---------------------------------------------------------------
test('research/236 D1: the list follows the lanes\' fingerprint — a new recipient read at 60 s is the list\'s at once, not a minute later', async t => {
  const f = await fixture(t);
  const dir = await mailbox(t, { t: { '20261001-1000_aa_요청.md': msg({ from: 'aa', to: 'bb' }) } });
  await writeUiState(f.store.dataDir, 'host_a', { settings: { labs: { mail: true, mailDir: dir } } });
  let ms = 0;
  const badge = createMailReader({ now: () => ms }), list = createMailListReader({ now: () => ms });
  const h = createReadHandlers(f.store, undefined, undefined, undefined, undefined, badge, undefined, list);
  // The board's read takes the fingerprint at 0 ms; the list is read at 4 s.
  const f0 = (await badge.read(dir)).key; ms = 4000;
  const l0 = (await h.mailList({ hostId: 'host_a' })).data;
  assert.deepEqual([l0.threads[0].latest[0].to, l0.source], ['bb', f0]);
  await fs.writeFile(join(dir, 't', '20261001-1010_aa_요청.md'), msg({ from: 'aa', to: 'cc' }));
  ms = 30_000; assert.equal((await h.mailList({ hostId: 'host_a' })).data.threads[0].latest[0].to, 'bb', 'the same fingerprint: the minute\'s reading');
  // At 60 s the board's read moves the fingerprint; the screen asks again and the list's own minute (until 64 s) does not hold it back.
  ms = 60_000; const f1 = (await badge.read(dir)).key;
  assert.notEqual(f1, f0);
  const l1 = (await h.mailList({ hostId: 'host_a' })).data;
  assert.deepEqual([l1.threads[0].latest[0].to, l1.source], ['cc', f1]);
  const one = (await h.mailThread({ hostId: 'host_a', thread: 't' })).data;
  assert.equal(one.files[0].name, '20261001-1010_aa_요청.md', 'the thread too');
});
test('research/236 D2: a file added at the newest time moves the fingerprint, and the lanes read the same newest files as the list', async t => {
  const dir = await mailbox(t, { t: { '20261001-1010_zz_요청.md': msg({ from: 'zz', to: 'bb' }) } });
  const before = await readMailbox(dir);
  assert.deepEqual(before.threads.map(v => v.to), ['bb']);
  // Sorts before the newest by name: the last file is the same, the thread is not.
  await fs.writeFile(join(dir, 't', '20261001-1010_aa_재질의.md'), msg({ from: 'aa', kind: '재질의', to: `${PERSON} (기록: aa)` }));
  const after = await readMailbox(dir), list = await readMailList(dir);
  assert.notEqual(after.key, before.key, 'the fingerprint moved');
  assert.deepEqual(after.threads.map(v => [v.to, v.file.split('/').at(-1)]), [['bb', '20261001-1010_zz_요청.md'], [`${PERSON} (기록: aa)`, '20261001-1010_aa_재질의.md']],
    'each recipient of the newest files, with the file naming it');
  assert.deepEqual(laneMail(after, 'bb').map(v => v.thread), ['t'], 'bb still waits');
  assert.deepEqual(mailStatus(list.threads[0], NOW, mailPeople(list.threads)).to, after.threads.map(v => v.to), 'the same verdict as the list\'s');
  // A close among the newest closes the thread for the lanes too, as for the list.
  await fs.writeFile(join(dir, 't', '20261001-1010_bb_종결.md'), msg({ from: 'bb', kind: '종결', to: '없음' }));
  const closed = await readMailbox(dir);
  assert.deepEqual([closed.threads, closed.unknown], [[], []]);
  assert.notEqual(closed.key, after.key, 'a closed thread is in the fingerprint too');
  // A rewritten file (same name, another size) moves it as well.
  const same = await readMailbox(dir);
  assert.equal(same.key, closed.key, 'nothing changed: the same fingerprint');
  await fs.writeFile(join(dir, 't', '20261001-1010_bb_종결.md'), msg({ from: 'bb', kind: '종결', to: '없음', body: ['더 긴 본문'] }));
  assert.notEqual((await readMailbox(dir)).key, closed.key);
});
test('research/236 D3: a thread folder swapped for a link after the check is never read through, nor listed', async t => {
  const dir = await mailbox(t, { t: { '20261001-1010_aa_요청.md': msg({ to: 'bb' }) } });
  const outside = await mailbox(t, { x: { '20261001-1010_aa_요청.md': msg({ to: 'OUTSIDE' }), '20261002-0000_aa_요청.md': msg({ to: 'OUTSIDE' }) } });
  const real = await fs.realpath(dir), thread = join(real, 't');
  let swapped = 0;
  const swap = async () => { if (!swapped++) { await fs.rename(thread, thread + '-kept'); await fs.symlink(join(outside, 'x'), thread); } };
  const restore = async () => { await fs.unlink(thread); await fs.rename(thread + '-kept', thread); swapped = 0; };
  // Swapped just before the head is opened: the file opened is not the one this path named when checked.
  const beforeHead = { ...realMailListIo, head: async (file, bytes) => { if (file.startsWith(thread + '/')) await swap(); return realMailListIo.head(file, bytes); } };
  const read = await readMailList(dir, beforeHead);
  assert.equal(swapped, 1);
  assert.equal(JSON.stringify(read).includes('OUTSIDE'), false, 'nothing from outside');
  assert.deepEqual(read.threads, [], 'the thread is left out, not read (research/240 D1)');
  await restore();
  // Swapped just before the folder is listed: its names are not listed either.
  const beforeList = { ...realMailListIo, list: async folder => { if (folder === thread) await swap(); return realMailListIo.list(folder); } };
  const listed = await readMailList(dir, beforeList);
  assert.deepEqual(listed.threads, [], 'the thread is left out');
  assert.equal(JSON.stringify(listed).includes('20261002'), false);
  assert.equal((await readMailThread(dir, 't', beforeList)).state, 'missing');
  await restore();
  // Left alone, the same folder reads as before.
  assert.equal((await readMailList(dir)).threads[0].latest[0].to, 'bb');
});
test('research/240 D1: the lanes\' badge reads through the same guarded way — a swapped thread is left out, never read', async t => {
  const dir = await mailbox(t, { t: { '20261001-1010_aa_요청.md': msg({ to: 'bb' }) }, u: { '20261001-1000_aa_요청.md': msg({ to: 'cc' }) } });
  const outside = await mailbox(t, { x: { '20261001-1010_aa_요청.md': msg({ to: 'OUTSIDE' }) } });
  const real = await fs.realpath(dir), thread = join(real, 't'), file = join(thread, '20261001-1010_aa_요청.md');
  const alone = (await readMailbox(dir)).key;
  let opened = 0;
  const counted = { ...realMailListIo, head: async (f, bytes) => { opened++; return realMailListIo.head(f, bytes); } };
  const check = (read, why) => {
    assert.equal(JSON.stringify(read).includes('OUTSIDE'), false, why + ': nothing from outside');
    assert.deepEqual(read.threads.map(v => [v.thread, v.to]), [['u', 'cc']], why + ': only the untouched thread');
    assert.deepEqual(read.unknown, [], why + ': not "unknown" either');
  };
  // The parent folder swapped for a link just before a head is opened.
  let swapped = 0;
  const kept = join(real, '.t-kept'); // hidden, so never read as a thread itself
  const swap = async () => { if (!swapped++) { await fs.rename(thread, kept); await fs.symlink(join(outside, 'x'), thread); } };
  const restore = async () => { await fs.unlink(thread); await fs.rename(kept, thread); swapped = 0; };
  const beforeHead = { ...counted, head: async (f, bytes) => { if (f.startsWith(thread + '/')) await swap(); return counted.head(f, bytes); } };
  const parent = await readMailbox(dir, beforeHead);
  check(parent, 'parent swapped');
  assert.notEqual(parent.key, alone, 'the fingerprint moves');
  await restore();
  // Only the last file swapped for a link to a file outside, after the thread was listed.
  const beforeFile = { ...counted, head: async (f, bytes) => {
    if (f === file && !swapped++) { await fs.rename(file, file + '-kept'); await fs.symlink(join(outside, 'x', '20261001-1010_aa_요청.md'), file); }
    return counted.head(f, bytes); } };
  check(await readMailbox(dir, beforeFile), 'file link');
  await fs.unlink(file); await fs.rename(file + '-kept', file); swapped = 0;
  // The thread folder swapped after the root was listed: not listed, not read.
  const beforeList = { ...counted, list: async folder => { if (folder === thread) await swap(); return counted.list(folder); } };
  opened = 0;
  const listed = await readMailbox(dir, beforeList);
  check(listed, 'folder swapped');
  assert.notEqual(listed.key, alone, 'the fingerprint moves');
  assert.equal(opened, 1, 'only the untouched thread\'s head is opened');
  await restore();
  // A link put as a thread folder or a message file from the start is never followed either.
  await fs.symlink(join(outside, 'x'), join(real, 'v'));
  await fs.symlink(join(outside, 'x', '20261001-1010_aa_요청.md'), join(real, 'u', '20261001-1100_aa_회신.md'));
  const links = await readMailbox(dir);
  assert.equal(JSON.stringify(links).includes('OUTSIDE'), false);
  assert.deepEqual(links.threads.map(v => [v.thread, v.to]).sort(), [['t', 'bb'], ['u', 'cc']]);
  // The real handler path: the list RPC reads the badge's fingerprint first — through the same guarded way.
  const { store } = await fixture(t);
  const host = 'host_mail240';
  await writeUiState(store.dataDir, host, { settings: { labs: { mail: true, mailDir: dir } } });
  const h = createReadHandlers(store, undefined, undefined, undefined, undefined, createMailReader({ read: d => readMailbox(d, beforeHead) }), undefined,
    createMailListReader({ list: d => readMailList(d, beforeHead), thread: (d, id) => readMailThread(d, id, beforeHead) }));
  const viaHandler = (await h.mailList({ hostId: host })).data;
  assert.equal(JSON.stringify(viaHandler).includes('OUTSIDE'), false);
  assert.deepEqual(viaHandler.threads.map(v => v.id), ['u']);
  assert.equal((await h.mailThread({ hostId: host, thread: 't' })).data.state, 'missing');
  await restore();
  // Left alone, it reads as before.
  assert.deepEqual((await readMailbox(dir)).threads.map(v => [v.thread, v.to]).sort(), [['t', 'bb'], ['u', 'cc']]);
});
test('research/242 D1: a thread the badge leaves out at the boundary is out of the list and the thread in the same request too', async t => {
  // t's newest file is swapped for a link to a file outside right before the badge opens it, and stays so; an older,
  // ordinary file names "wsOld". Before 243 the list then read the link as a mere non-file and gave t (and wsOld) back.
  const newest = '20261001-1010_aa_요청.md';
  const dir = await mailbox(t, { t: { '20261001-1000_aa_요청.md': msg({ to: 'wsOld' }), [newest]: msg({ to: 'wsNew' }) },
    u: { '20261001-0900_aa_요청.md': msg({ to: 'wsB' }) } });
  const outside = await mailbox(t, { x: { [newest]: msg({ to: 'OUTSIDE' }) } });
  const real = await fs.realpath(dir), at = join(real, 't', newest);
  const intact = await readMailbox(dir);
  await fs.rename(join(real, 't'), join(real, '.t-held'));
  const without = (await readMailbox(dir)).key;
  await fs.rename(join(real, '.t-held'), join(real, 't'));
  assert.notEqual(intact.key, without);
  const host = 'host_mail242';
  const swapping = () => {
    let swapped = 0;
    return { ...realMailListIo, head: async (f, bytes) => {
      if (f === at && !swapped++) { await fs.rename(at, join(real, '.kept')); await fs.symlink(join(outside, 'x', newest), at); }
      return realMailListIo.head(f, bytes); } };
  };
  const restore = async () => { await fs.unlink(at); await fs.rename(join(real, '.kept'), at); };
  for (const route of ['mailList', 'mailThread']) {
    const { store } = await fixture(t);
    await writeUiState(store.dataDir, host, { settings: { labs: { mail: true, mailDir: dir } } });
    const io = swapping(), badge = createMailReader({ read: d => readMailbox(d, io) });
    const h = createReadHandlers(store, undefined, undefined, undefined, undefined, badge, undefined, createMailListReader());
    const value = route === 'mailList' ? (await h.mailList({ hostId: host })).data : (await h.mailThread({ hostId: host, thread: 't' })).data;
    const read = await badge.read(dir);
    assert.deepEqual(read.threads.map(v => v.thread), ['u'], route + ': the badge leaves t out');
    assert.equal(read.key, without, route + ': so does the fingerprint');
    assert.equal(laneMail(read, 'wsOld').length, 0);
    assert.equal(JSON.stringify(value).includes('wsOld'), false, route + ': the older recipient does not come back');
    assert.equal(JSON.stringify(value).includes('OUTSIDE'), false, route + ': nothing from outside');
    if (route === 'mailList') {
      assert.deepEqual(value.threads.map(v => v.id), ['u'], 'the list leaves t out');
      assert.equal(value.source, read.key, 'the list answers that fingerprint');
    } else assert.equal(value.state, 'missing', 'the thread is missing');
    // The overview of the same reading says the same.
    assert.equal((await h.overview({ hostId: host, includeBoards: true })).data.mail.key, without);
    await restore();
  }
  // The other way: the list finds t swapped first — the badge's kept reading leaves t out too, and the list answers it.
  {
    const { store } = await fixture(t);
    await writeUiState(store.dataDir, host, { settings: { labs: { mail: true, mailDir: dir } } });
    const io = swapping(), badge = createMailReader();
    const h = createReadHandlers(store, undefined, undefined, undefined, undefined, badge, undefined,
      createMailListReader({ list: (d, boundary) => readMailList(d, io, MAIL_LIST_LIMITS, undefined, boundary) }));
    const value = (await h.mailList({ hostId: host })).data, read = await badge.read(dir);
    assert.deepEqual(value.threads.map(v => v.id), ['u']);
    assert.deepEqual(read.threads.map(v => v.thread), ['u'], 'the badge leaves t out too');
    assert.equal(read.key, without);
    assert.equal(value.source, read.key, 'the list answers the fingerprint so moved');
    assert.equal(badge.reads(), 1, 'without reading the folder again for the badge');
    await restore();
  }
  // Left alone, the same folder reads t again everywhere.
  assert.deepEqual((await readMailList(dir)).threads.map(v => v.id), ['t', 'u']);
  assert.equal((await readMailbox(dir)).key, intact.key);
});
test('research/242 D1: an empty thread and a link there from the start are not the boundary — nothing is left out for them', async t => {
  const dir = await mailbox(t, { e: {}, s: { '20261001-1000_aa_요청.md': msg({ to: 'wsOld' }) }, u: { '20261001-0900_aa_요청.md': msg({ to: 'wsB' }) } });
  const outside = await mailbox(t, { x: { 'z.md': msg({ to: 'OUTSIDE' }) } });
  const real = await fs.realpath(dir);
  // A link as s's newest file, there when s is listed: merely not a message — s reads by its ordinary file.
  await fs.symlink(join(outside, 'x', 'z.md'), join(real, 's', '20261001-1100_aa_회신.md'));
  const read = await readMailbox(dir);
  assert.deepEqual([...mailExcluded(read)], [], 'nothing left out at the boundary');
  assert.deepEqual(read.threads.map(v => [v.thread, v.to]), [['s', 'wsOld'], ['u', 'wsB']]);
  const { store } = await fixture(t);
  const host = 'host_mail242b';
  await writeUiState(store.dataDir, host, { settings: { labs: { mail: true, mailDir: dir } } });
  const h = createReadHandlers(store, undefined, undefined, undefined, undefined, createMailReader(), undefined, createMailListReader());
  const list = (await h.mailList({ hostId: host })).data;
  assert.deepEqual(list.threads.map(v => [v.id, v.files]), [['e', 0], ['s', 1], ['u', 1]], 'the empty thread and s are listed');
  assert.equal(JSON.stringify(list).includes('OUTSIDE'), false);
  assert.equal((await h.mailThread({ hostId: host, thread: 'e' })).data.state, 'ready');
  const s = (await h.mailThread({ hostId: host, thread: 's' })).data;
  assert.equal(s.state, 'ready');
  assert.deepEqual(s.files.map(f => f.to), ['wsOld']);
});
