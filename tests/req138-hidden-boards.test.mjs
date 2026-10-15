// REQ-138: a board of a workspace Paseo no longer lists as live (archived or gone) with no live card is left out of the
// lanes, the phone, the list screen and the settings' workspace list; the ledger keeps it, a new card or the workspace
// back shows it again, and the settings say how many are left out with a switch that shows them for the session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadHandlers } from '../dist/server/handlers.js';
import { confirmGone, emptyGoneBoards } from '../dist/server/read-model.js';
import { overviewGet } from '../dist/shared/rpc.js';
import { shownBoards } from '../dist/client/hidden-boards.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, request, add } from './helpers.mjs';

function ok(result, contract) {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (contract) contract.output.parse(result);
  return result.data;
}
/** Paseo's listing as `workspaces.list` answers it; `archived` rows carry `archivedAt` and are not live. */
function paseoWith(rows) {
  let calls = 0;
  return { calls: () => calls, paseo: { workspaces: { list: async () => { calls++;
    return { entries: rows.map(r => ({ id: r.id, name: r.id, projectId: 'prj_a', workspaceDirectory: r.cwd,
      ...(r.archived ? { archivedAt: '2026-10-01T00:00:00.000Z' } : {}) })), pageInfo: { nextCursor: null } }; } } } };
}
/** A listing that names only some other workspace: this fixture's is gone from it. */
const elsewhere = () => paseoWith([{ id: 'wks_other01', cwd: '/w/other' }]);
const T = () => '2026-10-07T00:00:00.000Z';
const gone = data => data.boards.filter(b => b.emptyGone).map(b => b.id);
const goneViews = data => data.boardViews.filter(b => b.summary.emptyGone).map(b => b.summary.id);

test('REQ-138 core: gone workspace with no live card is marked; one live card, a live workspace or its folder keep it', () => {
  const card = archivedAt => ({ archivedAt });
  const boards = [
    { id: 'b1', workspaceId: 'wks_gone01', cwd: '/w/gone', cards: [] },
    { id: 'b2', workspaceId: 'wks_gone02', cwd: '/w/archived-only', cards: [card('2026-10-01T00:00:00.000Z')] },
    { id: 'b3', workspaceId: 'wks_gone03', cwd: '/w/live-card', cards: [card('2026-10-01T00:00:00.000Z'), card(null)] },
    { id: 'b4', workspaceId: 'wks_live01', cwd: '/w/live', cards: [] },
    { id: 'b5', workspaceId: 'local_' + 'a'.repeat(64), cwd: '/w/by-folder/', cards: [] },
  ];
  const active = [{ id: 'wks_live01', cwd: '/w/live' }, { id: 'wks_later01', cwd: '/w/by-folder' }];
  assert.deepEqual([...emptyGoneBoards(boards, active)].sort(), ['b1', 'b2'],
    'empty and archived-only boards of gone workspaces; a live card, a live id or (D22) a live folder keeps the board');
  assert.deepEqual([...emptyGoneBoards(boards, [])].sort(), ['b1', 'b2', 'b4', 'b5'], 'no live workspace: every empty board (the handler guards an empty listing)');
});

test('REQ-138 overview: archived workspace + 0 live → marked, 1 live → not, active + 0 → not, revived → not', async t => {
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, T);
  // An active workspace with an empty board: shown.
  let api = paseoWith([{ id: 'wks_example01', cwd: f.cwd }]);
  let data = ok(await handlers.overview({ includeBoards: true, hostId: 'host-a' }, api.paseo), overviewGet);
  assert.deepEqual(gone(data), [], 'active + 0 live cards: shown');
  assert.equal(api.calls(), 1, 'the listing already read for the empty-workspace rows decides it; no extra round trip');
  // The workspace archived: the empty board is marked in both the rows and the board views.
  api = paseoWith([{ id: 'wks_example01', cwd: f.cwd, archived: true }]);
  data = ok(await handlers.overview({ includeBoards: true, hostId: 'host-a' }, api.paseo), overviewGet);
  assert.deepEqual(gone(data), [f.id]);
  assert.deepEqual(goneViews(data), [f.id]);
  // Gone from the listing altogether: the same.
  data = ok(await handlers.overview({ includeWorkspaces: true, hostId: 'host-a' }, elsewhere().paseo), overviewGet);
  assert.deepEqual(gone(data), [f.id], 'the list screen (includeWorkspaces) is told too');
  // A live card arrives (the CLI, an agent): shown again at the next read.
  await f.store.mutateBoard(f.id, request([add('Still here')]));
  data = ok(await handlers.overview({ includeBoards: true }, elsewhere().paseo), overviewGet);
  assert.deepEqual(gone(data), [], '1 live card: shown');
  // Archived again: only archived cards left → hidden again (an archived card is not a live one).
  const id = (await f.store.readBoard(f.id)).cards[0].id;
  await f.store.mutateBoard(f.id, request([{ op: 'archive', id }]));
  assert.notEqual((await f.store.readBoard(f.id)).cards[0].archivedAt, null);
  data = ok(await handlers.overview({ includeBoards: true }, elsewhere().paseo), overviewGet);
  assert.deepEqual(gone(data), [f.id], 'archived cards only: still hidden');
  // The workspace back in Paseo: shown, nothing was written to make it so.
  const before = (await f.store.readBoard(f.id)).revision;
  data = ok(await handlers.overview({ includeBoards: true }, paseoWith([{ id: 'wks_example01', cwd: f.cwd }]).paseo), overviewGet);
  assert.deepEqual(gone(data), [], 'revived workspace: shown');
  assert.equal((await f.store.readBoard(f.id)).revision, before, 'the ledger is untouched by every read');
  assert.equal((await f.store.readBoard(f.id)).cards.length, 1, 'the archived card stays in the ledger');
});

test('REQ-138 overview: no listing, a failed listing or a partial read judge nothing gone', async t => {
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, T);
  assert.deepEqual(gone(ok(await handlers.overview({ includeBoards: true }), overviewGet)), [], 'no host listing: nothing hidden');
  const failing = { workspaces: { list: async () => { throw new Error('daemon away'); } } };
  const data = ok(await handlers.overview({ includeWorkspaces: true }, failing), overviewGet);
  assert.deepEqual(gone(data), [], 'a failed listing hides nothing');
  const nothing = ok(await handlers.overview({ includeBoards: true }, paseoWith([]).paseo), overviewGet);
  assert.deepEqual(gone(nothing), [], 'a listing naming no workspace at all (a daemon starting up) hides nothing');
  const partial = ok(await handlers.overview({ boardIds: [f.id], includeBoards: true }, elsewhere().paseo), overviewGet);
  assert.deepEqual(gone(partial), [], 'a refresh of named boards reads no listing and marks nothing');
});

test('REQ-138 screens: marked boards are left out and counted; the switch shows them again', () => {
  const boards = [{ summary: { id: 'a' } }, { summary: { id: 'b', emptyGone: true } }, { summary: { id: 'c' } }];
  const hidden = shownBoards(boards, false, b => b.summary);
  assert.deepEqual(hidden.boards.map(b => b.summary.id), ['a', 'c']);
  assert.equal(hidden.hidden, 1);
  const shown = shownBoards(boards, true, b => b.summary);
  assert.deepEqual(shown.boards.map(b => b.summary.id), ['a', 'b', 'c'], 'shown again in place, for the archived cards in the lane menu');
  assert.equal(shown.hidden, 1, 'still counted while shown, so the switch stays');
  assert.deepEqual(shownBoards([{ id: 'x' }], false, b => b), { boards: [{ id: 'x' }], hidden: 0 }, 'an older server marks nothing');
});

test('REQ-138 words: the settings row in Korean and English', () => {
  const ko = copy('ko'), en = copy('en');
  assert.equal(ko.hiddenBoards, '숨긴 빈 보드');
  assert.equal(ko.hiddenBoardsCount(2), '2개');
  assert.equal(en.hiddenBoardsCount(1), '1 board');
  assert.equal(en.hiddenBoardsCount(3), '3 boards');
  for (const m of [ko, en]) assert.ok(m.hiddenBoardsHelp.length > 40 && m.hiddenBoardsShow);
});

test('REQ-138 wiring: every list the screens draw goes through shownBoards, and the settings row is fed', async () => {
  const read = name => readFile(new URL('../client/' + name, import.meta.url), 'utf8');
  const source = await read('board-source.ts');
  assert.match(source, /shownBoards\(read\.data\?\.boardViews/, 'the wide and phone lanes (and their settings lists) read the kept boards');
  assert.match(source, /preview \? demo\.boards : kept\.boards/);
  const overview = await read('overview.tsx');
  assert.match(overview, /placedBoards\(kept\.boards/, 'the list screen too');
  for (const screen of ['swimlane.tsx', 'mobile-swimlane.tsx']) assert.match(await read(screen), /hiddenBoards=\{source\.hiddenBoards\}/, screen);
  assert.match(overview, /hiddenBoards=\{kept && /);
  assert.match(await read('settings-sheet.tsx'), /testID="setting-hidden-boards"/);
});

// 320 F1: a workspace made again at the same folder under a new id — the folder written another way — keeps its old board.
test('REQ-138 320 F1: the same folder spelled another way is live; only a different folder is gone', () => {
  const empty = (cwd, workspaceId = 'wks_old01') => ({ id: 'b', workspaceId, cwd, cards: [] });
  const hidden = (cwd, activeCwd) => emptyGoneBoards([empty(cwd)], [{ id: 'wks_new01', cwd: activeCwd }]).has('b');
  for (const [name, cwd, activeCwd] of [
    ['Windows folder case', 'C:/Work/Demo', 'c:/work/demo'], ['Windows backslashes and case', 'C:\\Work\\Demo\\', 'c:/work/demo'],
    ['Windows drive letter', 'c:\\Work\\Demo', 'C:/Work/Demo'], ['UNC share case', '//HOST/Share/Demo', '\\\\host\\share\\demo'],
    ['UNC share forward and back slashes', '\\\\Host\\Share\\Demo\\', '//Host/Share/Demo'], ['trailing separator', '/work/demo/', '/work/demo'],
    ['Unicode NFC/NFD', '/work/카드', '/work/카드'.normalize('NFD')],
    // Unsure, so shown: a POSIX folder differing only in case may be the same one (a Mac volume ignores case by default).
    ['POSIX case only (unsure, shown)', '/Work/Demo', '/work/demo'],
  ]) assert.equal(hidden(cwd, activeCwd), false, name);
  for (const [name, cwd, activeCwd] of [['another folder', '/work/one', '/work/two'], ['another Windows folder', 'C:/Work/One', 'c:/work/two'],
    ['a POSIX backslash is part of a name', '/work/foo\\bar', '/work/foo/bar']]) assert.equal(hidden(cwd, activeCwd), true, name);
});

test('REQ-138 320 F1: the overview keeps a Windows board whose workspace came back under a new id and another case', async t => {
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, T);
  const upper = f.cwd.toUpperCase();
  // The real ledger here lives on a POSIX path, so the listing names the same folder in another case (unsure → shown).
  let data = ok(await handlers.overview({ includeBoards: true }, paseoWith([{ id: 'wks_new01', cwd: upper + '/' }]).paseo), overviewGet);
  assert.deepEqual(gone(data), [], 'same folder up to case, new id: not hidden');
  assert.deepEqual(goneViews(data), []);
  data = ok(await handlers.overview({ includeBoards: true }, paseoWith([{ id: 'wks_new01', cwd: f.cwd + '-other' }]).paseo), overviewGet);
  assert.deepEqual(gone(data), [f.id], 'a different folder: hidden as before');
});

test('REQ-138 320 J2: a live workspace Paseo lists without its folder keeps its board by id', async t => {
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, T);
  const paseo = { workspaces: { list: async () => ({ entries: [{ id: 'wks_example01', name: 'x', projectId: 'prj_a' },
    { id: 'wks_other01', name: 'y', projectId: 'prj_a', workspaceDirectory: '/w/other' }], pageInfo: { nextCursor: null } }) } };
  assert.deepEqual(gone(ok(await handlers.overview({ includeBoards: true }, paseo), overviewGet)), [], 'listed live, folder missing: shown');
  const archived = { workspaces: { list: async () => ({ entries: [{ id: 'wks_example01', name: 'x', projectId: 'prj_a', archivedAt: T() },
    { id: 'wks_other01', name: 'y', projectId: 'prj_a', workspaceDirectory: '/w/other' }], pageInfo: { nextCursor: null } }) } };
  assert.deepEqual(gone(ok(await handlers.overview({ includeBoards: true }, archived), overviewGet)), [f.id], 'archived without a folder: still hidden');
});

test('REQ-138 321 J5: a live workspace listed without a folder under another id hides nothing in that answer', async t => {
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, T);
  const paseo = { workspaces: { list: async () => ({ entries: [{ id: 'wks_new01', name: 'x', projectId: 'prj_a' },
    { id: 'wks_other01', name: 'y', projectId: 'prj_a', workspaceDirectory: '/w/other' }], pageInfo: { nextCursor: null } }) } };
  assert.deepEqual(gone(ok(await handlers.overview({ includeBoards: true }, paseo), overviewGet)), [], 'unsure which folder it is: shown');
});

// 321 F2: the same real folder reached through a symbolic link, under a new workspace id, keeps its board.
test('REQ-138 321 F2: a live workspace at a symbolic link to the board\'s folder keeps the board shown', async t => {
  const f = await fixture(t);
  const handlers = createReadHandlers(f.store, T);
  const alias = join(f.root, 'alias');
  await symlink(f.cwd, alias);
  let data = ok(await handlers.overview({ includeBoards: true }, paseoWith([{ id: 'wks_new01', cwd: alias }]).paseo), overviewGet);
  assert.deepEqual(gone(data), [], 'symbolic link + new id: shown');
  assert.deepEqual(goneViews(data), []);
  data = ok(await handlers.overview({ includeBoards: true }, paseoWith([{ id: 'wks_new01', cwd: f.cwd + '/../workspace' }]).paseo), overviewGet);
  assert.deepEqual(gone(data), [], 'a dotted path to the same folder: shown');
  // Another real folder still hides it.
  await mkdir(join(f.root, 'elsewhere'));
  data = ok(await handlers.overview({ includeBoards: true }, paseoWith([{ id: 'wks_new01', cwd: join(f.root, 'elsewhere') }]).paseo), overviewGet);
  assert.deepEqual(gone(data), [f.id], 'a different real folder: hidden as before');
});

test('REQ-138 321 F2: a folder that cannot be checked keeps the board shown; a folder that is gone stays hidden', async () => {
  const boards = [{ id: 'b1', cwd: '/w/board' }], candidates = new Set(['b1']);
  const fail = code => async () => { throw Object.assign(new Error(code), { code }); };
  const mapped = map => async path => { if (path in map) { const v = map[path]; if (typeof v === 'string') return v; throw Object.assign(new Error(v.code), v); }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.deepEqual([...await confirmGone(candidates, boards, [{ cwd: '/w/live' }], fail('ENOENT'))], ['b1'], 'every folder gone: hidden');
  assert.deepEqual([...await confirmGone(candidates, boards, [{ cwd: '/w/live' }], fail('EACCES'))], [], 'cannot read: shown');
  assert.deepEqual([...await confirmGone(candidates, boards, [{ cwd: '/w/live' }],
    mapped({ '/w/board': '/real/board', '/w/live': { code: 'EIO' } }))], [], 'a live folder that cannot be read may be this one: shown');
  assert.deepEqual([...await confirmGone(candidates, boards, [{ cwd: '/w/live' }],
    mapped({ '/w/board': { code: 'ELOOP' }, '/w/live': '/real/live' }))], [], 'the board\'s own folder cannot be read: shown');
  assert.deepEqual([...await confirmGone(candidates, boards, [{ cwd: '/w/live' }],
    mapped({ '/w/board': '/real/Same', '/w/live': '/real/same' }))], [], 'the same real folder up to case: shown');
  assert.deepEqual([...await confirmGone(candidates, boards, [{ cwd: '/w/live' }],
    mapped({ '/w/board': '/real/board', '/w/live': '/real/live' }))], ['b1'], 'two real folders: hidden');
  let calls = 0;
  assert.deepEqual([...await confirmGone(new Set(), boards, [{ cwd: '/w/live' }], async p => { calls++; return p; })], []);
  assert.equal(calls, 0, 'no candidate: the file system is not touched');
});
