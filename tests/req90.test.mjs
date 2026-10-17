// REQ-90: the settings window's lab (settings.labs in ui-state.json, shown only behind the developer key) and its first
// feature, the "messages waiting" badge: the server reads the message folder (server/mailbox.ts, 60 s cache, only while the
// badge is on), each thread's newest file's "받는 곳:" line against a lane's short name (shared/mailbox.ts). REQ-107: a card
// awaiting a person's answer is left out of REQ-86's 2h no-agent warning. The screens are exercised in plugin-ui.test.mjs
// ("REQ-90") and tests/web/run.mjs. Short names here are made up ("wsA", "wsB").
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readUiState, writeUiState } from '../dist/server/ui-state.js';
import { createMailReader, readMailbox, MAIL_CACHE_MS } from '../dist/server/mailbox.js';
import { laneMail, mailAlias, mailRecipient, isMailClose } from '../dist/shared/mailbox.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { overviewGet, revisionsGet, uiStateSet } from '../dist/shared/rpc.js';
import { mailChanged } from '../dist/client/refresh-model.js';
import { mailTipHeight, mailTipText, wrappedLines } from '../dist/client/mail-tip.js';
import { copy } from '../dist/client/i18n.js';
import { quietSince, stageDwell } from '../dist/client/stage-time.js';
import { builtinTemplate } from '../dist/server/core/index.js';
import { fixture } from './helpers.mjs';

async function temp(t, prefix) {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const head = (to, kind = '회신') => ['# 제목', `스레드: x · 보낸 곳: wsB (총괄-01) · 종류: ${kind} · 2026-09-28 10:00 KST`,
  ...(to === null ? [] : ['받는 곳: ' + to]), '기한: 없음', '승인: 해당없음', '', '본문'].join('\n');
/** A message folder: one sub-folder per thread, files named so the newest sorts last. */
async function mailbox(t, threads) {
  const dir = await temp(t, 'kanban-req90-mail-');
  for (const [thread, files] of Object.entries(threads)) {
    await fs.mkdir(join(dir, thread));
    for (const [name, text] of Object.entries(files)) await fs.writeFile(join(dir, thread, name), text);
  }
  return dir;
}

// ---- ① settings.labs in ui-state.json -----------------------------------------------------------------------------
test('REQ-90 ① settings.labs is written only when a lab field differs from its default, and an older file reads unchanged', async t => {
  const dir = await temp(t, 'kanban-req90-ui-'), file = join(dir, 'ui-state.json');
  // An older file (before REQ-90): no labs anywhere, and reading it writes nothing.
  const old = { schemaVersion: 1, hosts: { host_a: { hiddenProjects: [], order: { projects: [], workspaces: [] }, settings: { boardAlign: 'left' } } } };
  await fs.writeFile(file, JSON.stringify(old));
  assert.deepEqual(await readUiState(dir, 'host_a'), { hiddenProjects: [], order: { projects: [], workspaces: [] }, settings: { boardAlign: 'left' } });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), old, 'reading never writes');
  // The defaults sent (off, no folder, the compact rule) change nothing and write nothing.
  const same = await writeUiState(dir, 'host_a', { settings: { labs: { mail: false, mailDir: '  ', mailAlias: 'compact' } } });
  assert.equal(same.changed, false);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).hosts.host_a.settings.labs, undefined);
  // Turning the badge on keeps only that.
  const on = await writeUiState(dir, 'host_a', { settings: { labs: { mail: true } } });
  assert.equal(on.changed, true);
  assert.deepEqual(on.settings, { boardAlign: 'left', labs: { mail: true } });
  // Field by field: the folder joins the switch, and the rule the folder; the path is trimmed.
  await writeUiState(dir, 'host_a', { settings: { labs: { mailDir: ' /data/mail ' } } });
  const rule = await writeUiState(dir, 'host_a', { settings: { labs: { mailAlias: 'folder' } } });
  assert.deepEqual(rule.settings.labs, { mail: true, mailDir: '/data/mail', mailAlias: 'folder' });
  // Saving another row keeps the lab.
  const align = await writeUiState(dir, 'host_a', { settings: { boardAlign: 'right' } });
  assert.deepEqual(align.settings, { boardAlign: 'right', labs: { mail: true, mailDir: '/data/mail', mailAlias: 'folder' } });
  // Back to every default: the key leaves the file again.
  const off = await writeUiState(dir, 'host_a', { settings: { labs: { mail: false, mailDir: '', mailAlias: 'compact' } } });
  assert.deepEqual(off.settings, { boardAlign: 'right' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).hosts.host_a.settings.labs, undefined);
  // Unknown or damaged values read as the default.
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, hosts: { host_a: { settings: { labs: { mail: 'yes', mailDir: 3, mailAlias: 'x', other: 1 } } } } }));
  assert.equal((await readUiState(dir, 'host_a')).settings, undefined);
  // The RPC takes the lab's fields, strictly.
  assert.ok(uiStateSet.input.safeParse({ hostId: 'h', settings: { labs: { mail: true, mailDir: '/x', mailAlias: 'folder' } } }).success);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { labs: { other: 1 } } }).success, false);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { labs: { mailAlias: 'nope' } } }).success, false);
});

// ---- ② the message folder ----------------------------------------------------------------------------------------
test('REQ-90 ② the "받는 곳:" line: its value, trimmed; none or empty is a format we do not know', () => {
  assert.equal(mailRecipient(head('wsA')), 'wsA');
  assert.equal(mailRecipient(head('  wsB  ')), 'wsB');
  assert.equal(mailRecipient(head('사람 (기록: wsA)')), '사람 (기록: wsA)');
  assert.equal(mailRecipient(head(null)), null);
  assert.equal(mailRecipient('# 제목\r\n받는 곳:\r\n'), null);
  assert.equal(mailRecipient('# 제목\r\n받는 곳: wsA\r\n'), 'wsA', 'CRLF files too');
  // A decomposed (NFD) line, as a NAS may keep it, still reads.
  assert.equal(mailRecipient('받는 곳: wsA'.normalize('NFD')), 'wsA');
  assert.equal(isMailClose('20260928-1000_wsA_종결.md'.normalize('NFD')), true);
});
test('REQ-90 ② the folder: each thread\'s newest file; a close, hidden folders and other files are left out', async t => {
  const dir = await mailbox(t, {
    '20260928-0900_wsB_open': { '20260928-0900_wsB_요청.md': head('wsB', '요청'), '20260928-0910_wsB_회신.md': head('wsA') },
    '20260928-0901_wsA_turned': { '20260928-0901_wsA_요청.md': head('wsB', '요청') },
    '20260928-0902_wsA_closed': { '20260928-0902_wsA_요청.md': head('wsA', '요청'), '20260928-0950_wsA_종결.md': head('없음', '종결') },
    '20260928-0903_wsB_person': { '20260928-0903_wsB_요청.md': head('사람 (기록: wsA)', '요청') },
    '20260928-0904_wsB_odd': { '20260928-0904_wsB_요청.md': head(null, '요청') },
    // A later non-.md file does not count as the newest; hidden and NAS folders are skipped.
    '20260928-0905_wsB_attached': { '20260928-0905_wsB_요청.md': head('wsA', '요청'), 'zz_note.txt': 'x' },
    '@eaDir': { 'x.md': head('wsA') }, '.hidden': { 'x.md': head('wsA') },
  });
  await fs.writeFile(join(dir, 'README.md'), 'not a thread');
  const read = await readMailbox(dir);
  assert.deepEqual(read.threads.map(v => [v.thread, v.to]), [['20260928-0900_wsB_open', 'wsA'], ['20260928-0901_wsA_turned', 'wsB'],
    ['20260928-0903_wsB_person', '사람 (기록: wsA)'], ['20260928-0905_wsB_attached', 'wsA']]);
  assert.equal(read.threads[0].file, join(dir, '20260928-0900_wsB_open', '20260928-0910_wsB_회신.md'), 'the newest file, by name');
  assert.deepEqual(read.unknown, [{ thread: '20260928-0904_wsB_odd', file: join(dir, '20260928-0904_wsB_odd', '20260928-0904_wsB_요청.md') }]);
  assert.equal(read.error, undefined);
  assert.match(read.key, /^[0-9a-f]{16}$/);
  // A lane counts exactly its short name: the person's turn is not wsA's; the close and the unknown count nowhere.
  assert.deepEqual(laneMail(read, 'wsA').map(v => v.thread), ['20260928-0900_wsB_open', '20260928-0905_wsB_attached']);
  assert.deepEqual(laneMail(read, 'wsB').map(v => v.thread), ['20260928-0901_wsA_turned']);
  assert.deepEqual(laneMail(read, ''), [], 'an empty short name matches nothing');
  assert.deepEqual(laneMail(undefined, 'wsA'), []);
  // The same folder reads the same key; a new reply moves it.
  assert.equal((await readMailbox(dir)).key, read.key);
  await fs.writeFile(join(dir, '20260928-0901_wsA_turned', '20260928-1000_wsB_회신.md'), head('wsA'));
  const later = await readMailbox(dir);
  assert.notEqual(later.key, read.key);
  assert.equal(laneMail(later, 'wsA').length, 3);
  // Missing, relative or empty folders read as nothing, with the error said.
  for (const bad of [join(dir, 'missing'), 'relative/path', '']) {
    const none = await readMailbox(bad);
    assert.deepEqual([none.threads, none.unknown, none.error], [[], [], 'unreadable'], bad);
  }
  // Only reads: the folder's files are as they were.
  assert.equal(await fs.readFile(join(dir, '20260928-0904_wsB_odd', '20260928-0904_wsB_요청.md'), 'utf8'), head(null, '요청'));
});
test('REQ-90 ② the short name: the last folder without spaces (the default) or as it is', () => {
  assert.equal(mailAlias('/work/Example Space/wsA'), 'wsA');
  assert.equal(mailAlias('/work/My Work Space/'), 'MyWorkSpace');
  assert.equal(mailAlias('/work/My Work Space', 'folder'), 'My Work Space');
  assert.equal(mailAlias('C:\\work\\ws A'), 'wsA');
  assert.equal(mailAlias('/work/ws A'.normalize('NFD')), 'wsA');
  assert.equal(mailAlias(''), '');
});

// ---- ③ the 60 s cache and the handlers ---------------------------------------------------------------------------
test('REQ-90 ③ the reader keeps one reading for 60 s per folder; two asks at once share it', async () => {
  let time = 0, reads = 0;
  const reader = createMailReader({ now: () => time, read: async dir => { reads++; return { key: dir + reads, threads: [], unknown: [] }; } });
  assert.equal(MAIL_CACHE_MS, 60_000);
  const [a, b] = await Promise.all([reader.read('/m'), reader.read('/m')]);
  assert.equal(reads, 1); assert.equal(a, b);
  time = 59_999; await reader.read('/m'); assert.equal(reads, 1, 'within a minute: no reading');
  time = 60_000; assert.equal((await reader.read('/m')).key, '/m2', 'a minute on: read again');
  await reader.read('/other'); assert.equal(reads, 3, 'another folder is read at once');
  assert.equal(reader.reads(), 3);
  // A reading that throws reads as nothing, not as an error of the screen.
  const failing = createMailReader({ read: async () => { throw new Error('boom'); } });
  assert.equal((await failing.read('/m')).error, 'unreadable');
});
test('REQ-90 ③ the handlers: off — the folder is never read; on — the overview carries it and revisions its fingerprint', async t => {
  const { store } = await fixture(t);
  const dir = await mailbox(t, { '20260928-0900_wsB_x': { '20260928-0900_wsB_요청.md': head('wsA', '요청') } });
  let reads = 0;
  const reader = createMailReader({ read: async folder => { reads++; return readMailbox(folder); } });
  const handlers = createReadHandlers(store, undefined, undefined, undefined, undefined, reader);
  const ok = reply => { assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.data; };
  // Off (nothing saved): overview and revisions, with the host or not, never touch the folder.
  const offView = ok(await handlers.overview({ includeBoards: true, hostId: 'host_a' }));
  const offLook = ok(await handlers.revisions({ groups: true, hostId: 'host_a' }));
  assert.equal(offView.mail, undefined); assert.equal(offLook.mail, undefined); assert.equal(reads, 0);
  // On without a folder: still nothing read.
  ok(await handlers.ui({ hostId: 'host_a', settings: { labs: { mail: true } } }));
  assert.equal(ok(await handlers.overview({ includeBoards: true, hostId: 'host_a' })).mail, undefined);
  assert.equal(reads, 0, 'no folder set: no reading');
  // On with a folder: the swimlane's read carries the threads, the looks the same fingerprint, one reading between them.
  ok(await handlers.ui({ hostId: 'host_a', settings: { labs: { mailDir: dir } } }));
  const view = ok(await handlers.overview({ includeBoards: true, hostId: 'host_a' }));
  assert.equal(overviewGet.output.safeParse({ ok: true, data: view, committed: false, warnings: [] }).success, true, 'the reply fits the schema');
  assert.deepEqual(view.mail.threads.map(v => v.to), ['wsA']);
  const look = ok(await handlers.revisions({ groups: true, hostId: 'host_a' }));
  assert.equal(revisionsGet.output.safeParse({ ok: true, data: look, committed: false, warnings: [] }).success, true);
  assert.equal(look.mail, view.mail.key);
  for (let i = 0; i < 10; i++) await handlers.revisions({ hostId: 'host_a' });
  assert.equal(reads, 1, 'looks every 4 s: the folder once a minute');
  // A look without the host (a screen with the badge off), the list view's read and another host: no mail, no reading.
  assert.equal(ok(await handlers.revisions({ groups: true })).mail, undefined);
  assert.equal(ok(await handlers.overview({ includeWorkspaces: true, hostId: 'host_a' })).mail, undefined, 'the list view draws no badge');
  assert.equal(ok(await handlers.overview({ includeBoards: true, hostId: 'host_b' })).mail, undefined);
  assert.equal(reads, 1);
  // Turned off again: nothing read, nothing said.
  ok(await handlers.ui({ hostId: 'host_a', settings: { labs: { mail: false } } }));
  assert.equal(ok(await handlers.revisions({ hostId: 'host_a' })).mail, undefined);
  assert.equal(reads, 1);
  assert.equal(revisionsGet.input.safeParse({ hostId: '' }).success, false);
});
test('REQ-90 ③ a screen hears a new fingerprint as a change, and nothing while the badge is off', () => {
  assert.equal(mailChanged(undefined, 'abc'), false, 'the badge off: never a change');
  assert.equal(mailChanged({ hostId: 'h', key: 'abc' }, 'abc'), false);
  assert.equal(mailChanged({ hostId: 'h', key: 'abc' }, 'def'), true);
  assert.equal(mailChanged({ hostId: 'h', key: undefined }, 'abc'), true, 'turned on: the first fingerprint reads the threads');
  assert.equal(mailChanged({ hostId: 'h', key: undefined }, undefined), false, 'on without a folder: nothing to read');
  assert.equal(mailChanged({ hostId: 'h', key: 'abc' }, undefined), true, 'the folder cleared: read again, the badge goes');
});

// ---- REQ-107 -----------------------------------------------------------------------------------------------------
test('REQ-107 a card awaiting a person\'s answer is not warned for 2h without an agent at work; awaiting an agent still is', () => {
  const H = 3600_000, now = Date.parse('2026-09-28T12:00:00.000Z'), stages = builtinTemplate().stages;
  const signals = { read: () => 'finished', ready: true };
  const card = { stageId: 'doing', agentIds: ['a1'], stageEnteredAt: new Date(now - 3 * H).toISOString(), updatedAt: new Date(now - 3 * H).toISOString() };
  assert.equal(stageDwell(card, stages, signals, now).warn, true, 'as before: 3h, the agent finished');
  assert.equal(quietSince({ ...card, awaiting: 'user' }, now - 3 * H, signals), null);
  const waiting = stageDwell({ ...card, awaiting: 'user' }, stages, signals, now);
  assert.deepEqual([waiting.warn, waiting.shown, waiting.kind], [false, true, 'progress'], 'the clock stays, the ⚠ goes');
  assert.equal(stageDwell({ ...card, awaiting: 'agent' }, stages, signals, now).warn, true);
  assert.equal(stageDwell({ ...card, awaiting: null }, stages, signals, now).warn, true);
  // The review column's 12h rule is not the no-agent rule: a card awaiting a person there still warns after 12h.
  assert.equal(stageDwell({ ...card, stageId: 'review', awaiting: 'user', stageEnteredAt: new Date(now - 13 * H).toISOString() }, stages, signals, now).warn, true);
});

// ---- research/179 D1: the phone tip's height, guessed before it is drawn ------------------------------------------------
test('research/179 D1 the tip\'s height counts the lines a long thread name or path wraps onto', () => {
  const dir = '/data/example-mail', thread = (name, file) => ({ thread: name, file: dir + '/' + name + '/' + file }), ko = copy('ko');
  const two = [thread('20260928-0900_wsB_one', '20260928-0910_wsB_회신.md'), thread('20260928-0901_wsB_two', '20260928-0901_wsB_요청.md')];
  const long = n => thread(`20260928-1${n}00_wsB_long_example_thread_about_a_review_${n}`, `20260928-1${n}10_wsB_회신_long_example_file_name_${n}.md`);
  // Measured in Chromium at 390px (tests/web/run.mjs "research/180"): 8 lines = 127px, and 20 lines = 307px for three long threads.
  assert.equal(mailTipHeight(mailTipText(two, 1, 'wks_example01', ko), 300), 127);
  assert.equal(mailTipHeight(mailTipText([1, 2, 3].map(long), 1, 'wks_example01', ko), 300), 307);
  assert.ok(307 > 22 + 30 * 3 + 100, 'the old guess (22 + 30 a thread) was 112 for these');
  // A path breaks after "/" and "-"; a name joined with "_" moves whole to the next line, then breaks where it must.
  assert.equal(wrappedLines('  /data/example-mail/20260928-0900_wsB_one/20260928-0910_wsB_회신.md', 282), 2);
  assert.equal(wrappedLines('· 20260928-1100_wsB_long_example_thread_about_a_review_1', 282), 2);
  assert.equal(wrappedLines('short', 282), 1);
  assert.equal(mailTipHeight('', 300), 22, 'never under one line\'s box');
  // The wide board's 420px tip wraps less.
  assert.ok(mailTipHeight(mailTipText([1, 2, 3].map(long), 1, 'wks_example01', ko), 420) < 307);
});
