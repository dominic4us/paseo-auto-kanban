import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DISPATCH_HELD } from '../dist/shared/dispatch.js';
import { dispatchPreview } from '../dist/shared/rpc.js';
import { COMPLETE_LISTING, admission, createDispatcher, inClosingWorkspace, workspaceAccess } from '../dist/server/dispatch.js';
import { readAutoState, writeAutoState } from '../dist/server/auto-cards.js';
import { dispatchFloorOf, toBoardDTO } from '../dist/server/read-model.js';
import { dispatchLine } from '../dist/client/dispatch-view.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, request } from './helpers.mjs';

/**
 * research/257 (v0.1.46-B re-gate 2) → research/258: one judgement — `admission` — of whether a request may go to a chat now,
 * asked from one workspace listing when candidates are chosen, when the sheet previews, and right before `send`.
 * D1: a listing that fails (first page, a later page, no API) neither sends to a chat whose workspace is unread nor forgets a
 * closing row it did read. D2: a workspace that begins to archive after the candidate was chosen is caught right before `send`.
 */
const ROOT_CHAT = '11111111-1111-4111-8111-111111111111', TREE_CHAT = '22222222-2222-4222-8222-222222222222';
const LEAD = '99999999-9999-4999-8999-999999999999';
const minute = m => `2026-01-01T00:${String(m).padStart(2, '0')}:00.000Z`;
const agent = (id, cwd, created, extra = {}) => ({ id, title: 'Chat ' + id.slice(0, 4), cwd, workspaceId: 'wks_example01',
  createdAt: minute(created), archivedAt: null, labels: {}, status: 'idle', activeTurn: null, pendingPermissions: [], ...extra });
const quiet = { log: () => {}, sleep: async () => {} };
/**
 * A fake SDK whose workspace listing is served page by page by `pages`: an array of row arrays, or a function of the read
 * count (a read starts with a call without a cursor); a page that is an Error is thrown. `workspaces: null` is a host without the listing.
 */
function fakePaseo(agents, pages, { onRefresh = () => {} } = {}) {
  const sent = [], calls = [];
  let reads = 0;
  const paseo = { sent, calls, agents: {
    list: async () => ({ entries: agents.map(a => ({ agent: a })), pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => { onRefresh(id); return { agent: agents.find(a => a.id === id) ?? null }; },
      send: async (text, options) => { sent.push({ id, text, messageId: options?.messageId }); } }),
  } };
  if (pages !== null) paseo.workspaces = { list: async options => {
    calls.push(options);
    if (!options.page.cursor) reads++;
    const list = typeof pages === 'function' ? pages(reads) : pages;
    const index = options.page.cursor ? Number(options.page.cursor) : 0;
    const page = list[index];
    if (page instanceof Error) throw page;
    return { entries: page, pageInfo: { nextCursor: index + 1 < list.length ? String(index + 1) : null } };
  } };
  return paseo;
}
async function floorAt(store, floor) {
  const state = await readAutoState(store.dataDir);
  state.autoBoardFloor = floor;
  await writeAutoState(store.dataDir, state);
}
async function draft(store, id, title = 'Sample request') {
  await store.mutateBoard(id, request([{ op: 'add', title, intent: 'draft', acceptanceCriteria: '' }]));
  return (await store.readBoard(id)).cards.at(-1);
}
const send = (store, id, cardId, targetAgentId) =>
  store.mutateBoard(id, request([{ op: 'dispatch', id: cardId, to: 'doing', ...(targetAgentId ? { targetAgentId } : {}) }]), 'board');
const cardOf = async (store, id, cardId) => (await store.readBoard(id)).cards.find(c => c.id === cardId);
async function boardChip(store, id, cardId, locale = 'ko') {
  const floor = dispatchFloorOf(await readAutoState(store.dataDir));
  const dto = toBoardDTO(await store.readBoard(id), locale, 'off', Date.now(), undefined, undefined, undefined, floor);
  return dispatchLine(dto.stages.flatMap(s => s.cards).find(c => c.id === cardId).dispatch, copy(locale));
}
/** A root board and one worktree of it (no board of its own), with the start line set. */
async function rooted(t) {
  const f = await fixture(t);
  const tree = join(f.root, 'trees', 'one');
  await mkdir(tree, { recursive: true });
  await floorAt(f.store, minute(0));
  const row = (mark = {}) => ({ id: 'wks_example01', title: 'Example board', workspaceKind: 'local_checkout', workspaceDirectory: f.cwd, archivingAt: null, ...mark });
  const treeRow = (mark = {}) => ({ id: 'wks_tree01', title: 'Tree', workspaceKind: 'worktree', workspaceDirectory: tree, projectRootPath: f.cwd, archivingAt: null, ...mark });
  return { ...f, tree, row, treeRow };
}
const MARKS = { open: {}, archiving: { archivingAt: minute(9) }, archived: { archivedAt: minute(9) } };

test('257 the pure judgement: workspace access and admission over listing read × row state × where the chat is', async t => {
  const board = { workspaceId: 'wks_example01', cwd: '/tmp/example-root' };
  const own = { workspaceId: 'wks_example01', cwd: '/tmp/example-root' }, byFolder = { workspaceId: null, cwd: '/tmp/example-root' };
  const tree = { workspaceId: 'wks_tree01', cwd: '/tmp/example-tree' }, other = { workspaceId: 'wks_other01', cwd: '/tmp/elsewhere' };
  const rowOf = (id, cwd, mark) => ({ id, workspaceDirectory: cwd, ...MARKS[mark] });
  const related = a => a.workspaceId === 'wks_tree01';
  for (const read of ['complete', 'partial', 'none']) for (const mark of ['open', 'archiving', 'archived']) {
    const label = read + '/' + mark;
    // The row is in the listing: what it says holds, however much else was read (257-D1: a row read before a failure counts).
    const listed = { rows: read === 'none' ? [] : [rowOf('wks_example01', '/tmp/example-root', mark), rowOf('wks_tree01', '/tmp/example-tree', mark)], read };
    if (read !== 'none') {
      const want = mark === 'open' ? 'open' : 'closing';
      assert.equal(workspaceAccess(own, listed), want, label);
      assert.equal(workspaceAccess(byFolder, listed), want, label + ' by folder');
      assert.equal(admission(own, board, listed, related), want === 'open' ? 'yes' : 'closing', label);
      assert.equal(admission(tree, board, listed, related), want === 'open' ? 'yes' : 'closing', label + ' worktree');
      assert.equal(admission(other, board, listed, related), read === 'complete' ? 'outside' : 'unknown', label + ' another workspace, unlisted');
    }
    // The row is not in the listing: known open only when the listing is whole; unknown when a page is missing or there is no listing.
    const unlisted = { rows: [], read };
    assert.equal(workspaceAccess(own, unlisted), read === 'complete' ? 'open' : 'unknown', label + ' unlisted');
    assert.equal(admission(own, board, unlisted, related), read === 'complete' ? 'yes' : 'unknown', label + ' unlisted own');
    assert.equal(admission(byFolder, board, unlisted, related), read === 'complete' ? 'yes' : 'unknown', label + ' unlisted by folder');
    // A worktree's relation is read from its row: with none, it is known outside only when the listing is whole.
    assert.equal(admission(tree, board, unlisted, () => false), read === 'complete' ? 'outside' : 'unknown', label + ' unlisted worktree');
  }
  // A closing row wins over everything, even for a related worktree, even when the rest is unread.
  assert.equal(admission(tree, board, { rows: [rowOf('wks_tree01', '/tmp/example-tree', 'archiving')], read: 'partial' }, related), 'closing');
  // One folder, an old workspace archived and a new one open: the open row is the folder's (255-D2 kept).
  const reopened = COMPLETE_LISTING([{ id: 'wks_old01', workspaceDirectory: '/tmp/example-root', archivedAt: minute(1) }, { id: 'wks_new01', workspaceDirectory: '/tmp/example-root', archivingAt: null }]);
  assert.equal(workspaceAccess(byFolder, reopened), 'open');
  assert.equal(workspaceAccess({ workspaceId: 'wks_old01', cwd: '/tmp/example-root' }, reopened), 'closing');
  assert.equal(inClosingWorkspace({ workspaceId: 'wks_old01', cwd: '/tmp/example-root' }, reopened.rows), true, 'the 255 helper reads a listing as complete');
  // The reason is part of the shared set, so the sheet's schema and words know it.
  assert.ok(DISPATCH_HELD.includes('listing'));
  const f = await fixture(t), card = await draft(f.store, f.id);
  const parsed = dispatchPreview.output.safeParse({ ok: true, data: { lead: null, held: 'listing', locale: 'ko', boardTitle: 'x', revision: (await f.store.readBoard(f.id)).revision, to: 'doing', card },
    committed: false, warnings: [] });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? null));
  for (const locale of ['ko', 'en']) {
    assert.ok(copy(locale).dispatchHeld('listing').length > 20, locale);
    assert.ok(copy(locale).dispatchHeldChip('listing').length > 5, locale);
    assert.ok(copy(locale).dispatchQueued(null, false, 'listing').includes(copy(locale).dispatchHeldChip('listing').split(' · ')[1]), locale);
  }
});

test('257-D1 listing read × workspace state × (candidate, sheet, right before send): 36 cases, one answer each', async t => {
  const seen = [];
  for (const failure of ['complete', 'first-page', 'second-page', 'no-api']) for (const mark of ['open', 'archiving', 'archived']) for (const stage of ['candidate', 'sheet', 'before-send']) {
    const label = [failure, mark, stage].join('/');
    const { store, id, cwd, row, treeRow } = await rooted(t);
    const agents = [agent(ROOT_CHAT, cwd, 1)];
    const good = [[row(MARKS[mark])], [treeRow()]], open = [[row()], [treeRow()]];
    const pagesOf = failure === 'complete' ? good : failure === 'first-page' ? [new Error('first page failed')]
      : failure === 'second-page' ? [[row(MARKS[mark])], new Error('second page failed')] : null;
    // For "before send": the listing is whole and open while the candidate is chosen, and turns into the case at the read right
    // before sending (a host's listing cannot vanish between two reads: a read that answers nothing stands for "no API" there).
    const pages = stage === 'before-send' ? n => n === 1 ? open : pagesOf ?? [new Error('listing gone')] : pagesOf;
    const paseo = fakePaseo(agents, pages);
    const dispatcher = createDispatcher({ store, ...quiet });
    const card = await draft(store, id);
    // What the one judgement says: a row read says it; a row unread (first page failed, no API) is unknown; a whole listing is known.
    const rowKnown = failure === 'complete' || failure === 'second-page';
    const want = rowKnown ? (mark === 'open' ? 'send' : 'closing') : 'unknown';
    if (stage === 'sheet') {
      const preview = await dispatcher.preview(paseo, id, card.id);
      if (want === 'send') assert.equal(preview.lead?.agentId, ROOT_CHAT, label);
      else assert.deepEqual([preview.lead, preview.held], [null, want === 'unknown' ? 'listing' : 'noAgent'], label);
      assert.equal(preview.boardTitle, rowKnown ? 'Example board' : 'workspace', label + ': the board is named from the same listing');
    } else {
      await send(store, id, card.id, ROOT_CHAT);
      const outcome = await dispatcher.kick(paseo, id);
      const after = await cardOf(store, id, card.id);
      if (want === 'send') {
        assert.equal(outcome, 'sent', label);
        assert.deepEqual(paseo.sent.map(s => s.id), [ROOT_CHAT], label);
        assert.equal(after.dispatch.state, 'sent', label);
      } else {
        assert.equal(paseo.sent.length, 0, label + ': nothing is sent to a closing or unread workspace');
        if (want === 'closing') {
          assert.equal(outcome, 'noLead', label);
          assert.equal(after.dispatch.state, 'noLead', label);
          assert.equal(await boardChip(store, id, card.id), copy('ko').dispatchHeldChip('targetGone'), label);
        } else {
          // Unknown: the card is left as it was — waiting, with its confirmed chat — and tried again at the next signal.
          assert.equal(outcome, 'list-failed', label);
          assert.deepEqual([after.dispatch.state, after.dispatch.targetAgentId], ['pending', ROOT_CHAT], label);
          assert.equal(await boardChip(store, id, card.id), copy('ko').dispatchPending, label);
          assert.equal((await dispatcher.preview(paseo, id, card.id)).held, 'listing', label + ' (sheet of the waiting card)');
        }
      }
      if (stage === 'before-send' && want !== 'send') assert.ok(paseo.calls.length >= 2, label + ': the listing was read again right before sending');
    }
    seen.push(label);
  }
  assert.equal(new Set(seen).size, 36);
});

test('257-D1 a closing row read on the first page holds when the second page fails; the listing read whole again sends', async t => {
  const { store, id, cwd, tree, row, treeRow } = await rooted(t);
  const treeChat = agent(TREE_CHAT, tree, 2, { workspaceId: 'wks_tree01' });
  const agents = [agent(ROOT_CHAT, cwd, 1), treeChat];
  // Page one names the root as archiving and the worktree as open; page two fails. The root chat is closing, the worktree's open.
  const paseo = fakePaseo(agents, [[row(MARKS.archiving), treeRow()], new Error('second page failed')]);
  const dispatcher = createDispatcher({ store, ...quiet });
  const card = await draft(store, id);
  assert.equal((await dispatcher.preview(paseo, id, card.id)).lead?.agentId, TREE_CHAT, 'the open worktree chat, not the closing root chat');
  // Confirmed for the root chat before its row closed: held as gone — the read row is believed even though a later page failed.
  await send(store, id, card.id, ROOT_CHAT);
  assert.equal(await dispatcher.kick(paseo, id), 'noLead');
  assert.equal(paseo.sent.length, 0);
  assert.equal((await dispatcher.preview(paseo, id, card.id)).held, 'targetGone');
  // A lead by name in the closing root workspace is no lead either; one in the open worktree takes the held card.
  agents.push(agent(LEAD, cwd, 3, { title: '총괄-99 시험' }));
  assert.equal(await dispatcher.kick(paseo, id), 'noLead');
  agents.push(agent('88888888-8888-4888-8888-888888888888', tree, 4, { workspaceId: 'wks_tree01', title: '총괄-98 시험' }));
  assert.equal(await dispatcher.kick(paseo, id), 'sent');
  assert.deepEqual(paseo.sent.map(s => s.id), ['88888888-8888-4888-8888-888888888888']);
});

test('257-D1 a transient failure flips nothing: the card keeps its chat and goes out once the listing reads again; the no-API host holds', async t => {
  const { store, id, cwd, row, treeRow } = await rooted(t);
  const agents = [agent(ROOT_CHAT, cwd, 1)];
  let fail = true;
  const paseo = fakePaseo(agents, () => fail ? [new Error('listing down')] : [[row()], [treeRow()]]);
  const dispatcher = createDispatcher({ store, ...quiet });
  const card = await draft(store, id);
  assert.deepEqual((await dispatcher.preview(paseo, id, card.id)).held, 'listing');
  await send(store, id, card.id, ROOT_CHAT);
  for (let i = 0; i < 3; i++) assert.equal(await dispatcher.kick(paseo, id), 'list-failed', 'try ' + i);
  assert.deepEqual([(await cardOf(store, id, card.id)).dispatch.state, paseo.sent.length], ['pending', 0]);
  fail = false;
  assert.equal(await dispatcher.kick(paseo, id), 'sent');
  assert.deepEqual(paseo.sent.map(s => s.id), [ROOT_CHAT]);
  // The host offers no listing at all: the same answer, forever — nothing sent, nothing written off (research/258 §1 decision).
  const bare = fakePaseo([agent(ROOT_CHAT, cwd, 1)], null);
  const second = await draft(store, id, 'Second');
  assert.deepEqual([(await dispatcher.preview(bare, id, second.id)).lead, (await dispatcher.preview(bare, id, second.id)).held], [null, 'listing']);
  await send(store, id, second.id, ROOT_CHAT);
  assert.equal(await dispatcher.kick(bare, id), 'list-failed');
  assert.deepEqual([(await cardOf(store, id, second.id)).dispatch.state, bare.sent.length], ['pending', 0]);
  // A lead by name is held by the listing alone (the start line never bars a lead by name).
  const lead = fakePaseo([agent(LEAD, cwd, 1, { title: '총괄-99 시험' })], null);
  const third = await draft(store, id, 'Third');
  assert.equal((await dispatcher.preview(lead, id, third.id)).held, 'listing');
  // The start line comes first all the same (255-D1): a damaged settings file is what to fix, listing or no listing — said
  // even when a lead by name may be among the unread chats (then the listing is what holds it once the file is repaired).
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(store.dataDir, 'auto-cards.json'), '{');
  assert.equal((await dispatcher.preview(bare, id, second.id)).held, 'settings');
  assert.equal((await dispatcher.preview(lead, id, third.id)).held, 'settings');
});

test('257-D2 a workspace that begins to archive after the candidate was chosen is caught right before send: root and worktree, during refresh and during the title read', async t => {
  for (const location of ['root', 'tree']) for (const phase of ['during-refresh', 'during-title']) {
    const label = location + '/' + phase;
    const { store, id, cwd, tree, row, treeRow } = await rooted(t);
    const target = location === 'root' ? ROOT_CHAT : TREE_CHAT;
    const agents = [location === 'root' ? agent(ROOT_CHAT, cwd, 1) : agent(TREE_CHAT, tree, 1, { workspaceId: 'wks_tree01' })];
    let closing = false, armed = true;
    const rows = () => [[row(location === 'root' && closing ? MARKS.archiving : {}), treeRow(location === 'tree' && closing ? MARKS.archiving : {})]];
    // The mark appears once: during the refresh of the chat, or at the listing right before send (read 3: the sheet's read is
    // 1, the candidates' 2 — in the unfixed build that third read only named the board, 257-D2).
    const paseo = fakePaseo(agents, n => { if (phase === 'during-title' && n === 3 && armed) { closing = true; armed = false; } return rows(); },
      { onRefresh: () => { if (phase === 'during-refresh' && armed) { closing = true; armed = false; } } });
    const dispatcher = createDispatcher({ store, ...quiet });
    const card = await draft(store, id);
    assert.equal((await dispatcher.preview(paseo, id, card.id)).lead?.agentId, target, label + ': open when confirmed');
    paseo.calls.length = 0;
    await send(store, id, card.id, target);
    assert.equal(await dispatcher.kick(paseo, id), 'noLead', label);
    assert.equal(paseo.sent.length, 0, label + ': not sent after its workspace began to archive');
    assert.equal(paseo.calls.length, 2, label + ': one listing for the candidates, one right before send (the title comes from it too)');
    const after = await cardOf(store, id, card.id);
    assert.deepEqual([after.dispatch.state, after.dispatch.targetAgentId], ['noLead', target], label + ': held with its confirmed chat kept');
    assert.equal((await dispatcher.preview(paseo, id, card.id)).held, 'targetGone', label);
    assert.equal(await boardChip(store, id, card.id, 'en'), copy('en').dispatchHeldChip('targetGone'), label);
    // The workspace reopens: the very chat is sent to, once.
    closing = false;
    assert.equal(await dispatcher.kick(paseo, id), 'sent', label + ': reopened');
    assert.deepEqual(paseo.sent.map(s => s.id), [target], label);
  }
});

test('257-D2 right before send the listing may fail, or another chat may take the card: nothing is sent either way', async t => {
  const { store, id, cwd, tree, row, treeRow } = await rooted(t);
  const agents = [agent(ROOT_CHAT, cwd, 1)];
  let mode = 'fine';
  const paseo = fakePaseo(agents, n => n % 2 === 0 && mode === 'fail' ? [new Error('listing down')] : [[row()], [treeRow()]]);
  const dispatcher = createDispatcher({ store, ...quiet });
  const card = await draft(store, id);
  await send(store, id, card.id);
  // The listing fails right before send: the card stays waiting (not written off), tried again at the next signal.
  mode = 'fail';
  assert.equal(await dispatcher.kick(paseo, id), 'list-failed');
  assert.deepEqual([(await cardOf(store, id, card.id)).dispatch.state, paseo.sent.length], ['pending', 0]);
  mode = 'fine';
  // A card with no confirmed chat whose target changes between the two reads — the root workspace begins to archive, so the
  // worktree's chat is next: not sent to the first one in this run; the next run sends to the one the judgement names then.
  agents.push(agent(TREE_CHAT, tree, 2, { workspaceId: 'wks_tree01' }));
  const swapping = fakePaseo(agents, n => n === 2 ? [[row(MARKS.archiving)], [treeRow()]] : [[row()], [treeRow()]]);
  assert.equal(await dispatcher.kick(swapping, id), 'none');
  assert.deepEqual([(await cardOf(store, id, card.id)).dispatch.state, swapping.sent.length], ['pending', 0], 'not sent to the chat chosen first');
  const next = fakePaseo(agents, [[row(MARKS.archiving)], [treeRow()]]);
  assert.equal(await dispatcher.kick(next, id), 'sent');
  assert.deepEqual(next.sent.map(s => s.id), [TREE_CHAT]);
  // The refresh says the chat is gone right before send (archived meanwhile): held, as before (REQ-97).
  const gone = fakePaseo([agent(TREE_CHAT, cwd, 3)], [[row()], [treeRow()]]);
  gone.agents.ref = () => ({ refresh: async () => ({ agent: { id: TREE_CHAT, archivedAt: minute(9) } }), send: async () => { throw new Error('must not send'); } });
  const second = await draft(store, id, 'Second');
  await send(store, id, second.id, TREE_CHAT);
  assert.equal(await dispatcher.kick(gone, id), 'noLead');
});
