import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dispatchHeld } from '../dist/shared/dispatch.js';
import { boardOfAgent, createDispatcher, inClosingWorkspace, readLeadEntry } from '../dist/server/dispatch.js';
import { readAutoState, writeAutoState } from '../dist/server/auto-cards.js';
import { dispatchFloorOf, toBoardDTO } from '../dist/server/read-model.js';
import { dispatchLine } from '../dist/client/dispatch-view.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, request } from './helpers.mjs';

/**
 * research/255 (v0.1.46-B re-gate): D1 a card held by the start line says so even when its confirmed chat is alive —
 * "chat closed" only when the start line lets it through; D2 a chat whose workspace Paseo is archiving takes no request.
 */
const ROOT_CHAT = '11111111-1111-4111-8111-111111111111', TREE_CHAT = '22222222-2222-4222-8222-222222222222';
const OLD_TREE_CHAT = '33333333-3333-4333-8333-333333333333', LEAD = '99999999-9999-4999-8999-999999999999';
const minute = m => `2026-01-01T00:${String(m).padStart(2, '0')}:00.000Z`;
const agent = (id, cwd, created, extra = {}) => ({ id, title: 'Chat ' + id.slice(0, 4), cwd, workspaceId: 'wks_example01',
  createdAt: minute(created), archivedAt: null, labels: {}, status: 'idle', ...extra });
function fakePaseo(agents, rows = [{ id: 'wks_example01', title: 'Example board' }]) {
  const sent = [];
  return { sent, agents: {
    list: async () => ({ entries: agents.map(a => ({ agent: a })), pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => ({ agent: agents.find(a => a.id === id) ?? null }),
      send: async (text, options) => { sent.push({ id, text, messageId: options?.messageId }); } }),
  }, workspaces: { list: async () => ({ entries: rows, pageInfo: { nextCursor: null } }) } };
}
const quiet = { log: () => {}, sleep: async () => {} };
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
/** The board's chip, from the ledger and the start line only — as the board and the card detail read it. */
async function boardHeld(store, id, cardId) {
  const floor = dispatchFloorOf(await readAutoState(store.dataDir));
  const dto = toBoardDTO(await store.readBoard(id), 'ko', 'off', Date.now(), undefined, undefined, undefined, floor);
  return dto.stages.flatMap(s => s.cards).find(c => c.id === cardId).dispatch;
}
/** The start line each policy leaves: valid, none kept, a damaged file, not a time, after the request. */
async function policyAt(store, policy) {
  await floorAt(store, minute(0));
  if (policy === 'damaged') await writeFile(join(store.dataDir, 'auto-cards.json'), '{');
  else if (policy === 'invalid') {
    const state = await readAutoState(store.dataDir);
    await writeFile(join(store.dataDir, 'auto-cards.json'), JSON.stringify({ ...state, autoBoardFloor: 'not a time' }));
  } else if (policy === 'missing') await floorAt(store, null);
  else if (policy === 'before') await floorAt(store, new Date(Date.now() + 60_000).toISOString());
}
const expected = (pinned, policy, presence) => ['missing', 'damaged', 'invalid'].includes(policy) ? 'settings'
  : policy === 'before' ? 'beforeFloor' : presence === 'live' ? 'sent' : pinned ? 'targetGone' : 'noAgent';

test('255-D1 held reasons over confirmed id × 5 start-line states × chat live/absent/archived: 30 cases, the board says what the sheet says', async t => {
  const seen = [];
  for (const pinned of [false, true]) for (const policy of ['valid', 'missing', 'damaged', 'invalid', 'before']) for (const presence of ['live', 'absent', 'archived']) {
    const { store, id, cwd } = await fixture(t);
    await floorAt(store, minute(0));
    const card = await draft(store, id);
    await send(store, id, card.id, pinned ? ROOT_CHAT : undefined);
    await policyAt(store, policy);
    const agents = presence === 'absent' ? [] : [agent(ROOT_CHAT, cwd, 1, presence === 'archived' ? { archivedAt: minute(9) } : {})];
    const paseo = fakePaseo(agents);
    const dispatcher = createDispatcher({ store, ...quiet });
    const label = [pinned ? 'pinned' : 'unbound', policy, presence].join('-'), want = expected(pinned, policy, presence);
    const outcome = await dispatcher.kick(paseo, id);
    if (want === 'sent') {
      assert.equal(outcome, 'sent', label);
      assert.deepEqual(paseo.sent.map(s => s.id), [ROOT_CHAT], label);
    } else {
      assert.equal(outcome, 'noLead', label);
      assert.equal(paseo.sent.length, 0, label);
      assert.equal((await dispatcher.preview(paseo, id, card.id)).held, want, label + ' (sheet)');
      const chip = await boardHeld(store, id, card.id);
      assert.equal(chip.held, want === 'noAgent' ? undefined : want, label + ' (board)');
      if (want !== 'noAgent') {
        assert.equal(dispatchLine(chip, copy('ko')), copy('ko').dispatchHeldChip(want), label);
        assert.equal(dispatchLine(chip, copy('en')), copy('en').dispatchHeldChip(want), label);
      }
    }
    seen.push(label);
  }
  assert.equal(new Set(seen).size, 30);
  // The pure rule: the start line first, "chat closed" only for a card it lets through.
  const at = minute(5);
  for (const pinned of [null, ROOT_CHAT]) {
    assert.equal(dispatchHeld({ targetAgentId: pinned, requestedAt: at }, null), 'settings');
    assert.equal(dispatchHeld({ targetAgentId: pinned, requestedAt: at }, 'not a time'), 'settings');
    assert.equal(dispatchHeld({ targetAgentId: pinned, requestedAt: at }, minute(9)), 'beforeFloor');
  }
  assert.equal(dispatchHeld({ targetAgentId: ROOT_CHAT, requestedAt: at }, minute(1)), 'targetGone');
  assert.equal(dispatchHeld({ targetAgentId: null, requestedAt: at }, minute(1)), 'noAgent');
});

test('255-D1 a lead by name still takes a held card whatever the start line; a confirmed lead is sent to with the file damaged', async t => {
  const { store, id, cwd } = await fixture(t);
  await floorAt(store, minute(0));
  const card = await draft(store, id);
  await send(store, id, card.id, LEAD);
  await writeFile(join(store.dataDir, 'auto-cards.json'), '{');
  const paseo = fakePaseo([agent(LEAD, cwd, 1, { title: '총괄-99 시험' }), agent(ROOT_CHAT, cwd, 2)]);
  assert.equal(await createDispatcher({ store, ...quiet }).kick(paseo, id), 'sent');
  assert.deepEqual(paseo.sent.map(s => s.id), [LEAD]);
});

/** A project root board (the fixture's) and two worktrees of it without boards of their own. */
async function worktrees(t) {
  const f = await fixture(t);
  const older = join(f.root, 'trees', 'older'), newer = join(f.root, 'trees', 'newer');
  for (const dir of [older, newer]) await mkdir(dir, { recursive: true });
  const rows = [
    { id: 'wks_example01', title: 'Example board', workspaceKind: 'local_checkout', workspaceDirectory: f.cwd, archivingAt: null },
    { id: 'wks_tree01', title: 'Older', workspaceKind: 'worktree', workspaceDirectory: older, projectRootPath: f.cwd, archivingAt: null },
    { id: 'wks_tree02', title: 'Newer', workspaceKind: 'worktree', workspaceDirectory: newer, projectRootPath: f.cwd, archivingAt: null },
  ];
  await floorAt(f.store, minute(0));
  return { ...f, older, newer, rows };
}

test('255-D2 a worktree being archived (or archived) gives no chat to send to; the open worktree does', async t => {
  for (const mark of ['archivingAt', 'archivedAt']) {
    const { store, id, older, newer, rows } = await worktrees(t);
    rows[2][mark] = minute(9);
    const agents = [agent(OLD_TREE_CHAT, older, 1, { workspaceId: 'wks_tree01' }), agent(TREE_CHAT, newer, 2, { workspaceId: 'wks_tree02' })];
    const paseo = fakePaseo(agents, rows), dispatcher = createDispatcher({ store, ...quiet });
    const card = await draft(store, id);
    const preview = await dispatcher.preview(paseo, id, card.id);
    assert.equal(preview.lead?.agentId, OLD_TREE_CHAT, mark + ': the newest chat is in a closing worktree');
    await send(store, id, card.id, preview.lead.agentId);
    assert.equal(await dispatcher.kick(paseo, id), 'sent');
    assert.deepEqual(paseo.sent.map(s => s.id), [OLD_TREE_CHAT], mark);
    // A lead by name there is no lead either.
    agents.push(agent(LEAD, newer, 3, { workspaceId: 'wks_tree02', title: '총괄-99 시험' }));
    const second = await draft(store, id, 'Second');
    assert.equal((await dispatcher.preview(paseo, id, second.id)).lead?.agentId, OLD_TREE_CHAT, mark);
  }
});

test('255-D2 a chat confirmed before its worktree began to archive is held as gone, not sent; the board says so', async t => {
  const { store, id, newer, rows } = await worktrees(t);
  const agents = [agent(TREE_CHAT, newer, 2, { workspaceId: 'wks_tree02' })];
  const paseo = fakePaseo(agents, rows), dispatcher = createDispatcher({ store, ...quiet });
  const card = await draft(store, id);
  assert.equal((await dispatcher.preview(paseo, id, card.id)).lead?.agentId, TREE_CHAT);
  rows[2].archivingAt = minute(9);
  await send(store, id, card.id, TREE_CHAT);
  assert.equal(await dispatcher.kick(paseo, id), 'noLead');
  assert.equal(paseo.sent.length, 0);
  assert.equal((await dispatcher.preview(paseo, id, card.id)).held, 'targetGone');
  assert.equal((await boardHeld(store, id, card.id)).held, 'targetGone');
  // The worktree's archive signal still reaches the root board (where its cards land): the card stays held, nothing sent.
  const hook = { id: TREE_CHAT, workspaceId: 'wks_tree02', cwd: newer, parentAgentId: null, title: agents[0].title };
  assert.equal(boardOfAgent(readLeadEntry(agents[0]), await store.listBoardIdentities(), rows), id, 'the board its cards land on, unchanged');
  assert.deepEqual(await dispatcher.signal(hook, 'archived', paseo), ['noLead']);
  assert.equal((await cardOf(store, id, card.id)).dispatch.state, 'noLead');
  assert.equal(paseo.sent.length, 0);
});

test('255-D2 the board\'s own workspace being archived: its chats take nothing; listing unreadable: nothing is sent, nothing written off (257)', async t => {
  const { store, id, cwd, older, rows } = await worktrees(t);
  rows[0].archivingAt = minute(9);
  const rootChat = agent(ROOT_CHAT, cwd, 3), treeChat = agent(OLD_TREE_CHAT, older, 1, { workspaceId: 'wks_tree01' });
  const dispatcher = createDispatcher({ store, ...quiet });
  const card = await draft(store, id);
  assert.equal((await dispatcher.preview(fakePaseo([rootChat, treeChat], rows), id, card.id)).lead?.agentId, OLD_TREE_CHAT);
  assert.equal((await dispatcher.preview(fakePaseo([rootChat], rows), id, card.id)).lead, null);
  // The listing fails: whether any chat's workspace is closing is unknown — 257-D1 (research/258): the root folder's chat is
  // no longer sent to on a guess; the sheet says the listing is unread, and so does a worktree-only board.
  rows[0].archivingAt = null;
  const failing = fakePaseo([rootChat, treeChat], rows);
  failing.workspaces.list = async () => { throw new Error('listing failed'); };
  assert.deepEqual([(await dispatcher.preview(failing, id, card.id)).lead, (await dispatcher.preview(failing, id, card.id)).held], [null, 'listing']);
  assert.equal((await dispatcher.preview(Object.assign(fakePaseo([treeChat], rows), { workspaces: { list: async () => { throw new Error('x'); } } }), id, card.id)).held, 'listing');
  // Read again: the same chats, the same judgement, now answered.
  assert.equal((await dispatcher.preview(fakePaseo([rootChat, treeChat], rows), id, card.id)).lead?.agentId, ROOT_CHAT);
  // One folder, an old workspace archived and a new one open: an agent without a workspace id there is not closing.
  const reopened = [{ id: 'wks_old01', workspaceDirectory: cwd, archivedAt: minute(1) }, { id: 'wks_new01', workspaceDirectory: cwd, archivingAt: null }];
  assert.equal(inClosingWorkspace({ workspaceId: null, cwd }, reopened), false);
  assert.equal(inClosingWorkspace({ workspaceId: 'wks_old01', cwd }, reopened), true);
  assert.equal(inClosingWorkspace({ workspaceId: 'wks_unlisted', cwd: join(cwd, 'nowhere') }, reopened), false, 'not listed: nothing known');
});
