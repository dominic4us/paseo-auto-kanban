import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutoCards, readAutoState } from '../dist/server/auto-cards.js';
import { readLocale } from '../dist/server/handlers.js';
import { fixture, request, actor } from './helpers.mjs';

// D33: an orchestrator made before its workspace had a board (it runs `kanban init` a minute later) gets its card at
// its next live signal. Before the fix only the `created` signal made cards, so it never got one until a restart.
const LATER = 'wks_later01';
const START = '2026-09-26T13:00:00.000Z';
async function setup(t) {
  const f = await fixture(t);
  let clock = START;
  const auto = createAutoCards({ store: f.store, locale: readLocale, now: () => clock, log: () => {} });
  const cwd = join(f.root, 'later'); await fs.mkdir(cwd);
  // What Paseo answers: the agent list (read once, when the board did not exist yet) and each agent's current snapshot.
  const agents = new Map();
  let refreshes = 0;
  const paseo = { agents: {
    list: async () => ({ entries: [...agents.values()].map(agent => ({ agent, project: null })), pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => { refreshes++; const agent = agents.get(id); return agent ? { agent, project: null } : null; } }),
  } };
  const make = (overrides = {}) => {
    const snapshot = { id: randomUUID(), workspaceId: LATER, cwd, title: '총괄-01_example_Opus', labels: {}, status: 'running',
      pendingPermissions: [], archivedAt: null, lastUserMessageAt: clock, createdAt: clock, ...overrides };
    agents.set(snapshot.id, snapshot);
    // The hook keeps the creation title.
    return { snapshot, hook: { id: snapshot.id, workspaceId: snapshot.workspaceId, parentAgentId: null, provider: 'claude', cwd, title: '/orchestrator' } };
  };
  const init = async () => (await f.store.initBoard({ cwd, workspaceId: LATER, actor, requestId: randomUUID() })).data.boardId;
  const cardsOf = async (boardId, agentId) => (await f.store.readBoard(boardId)).cards.filter(c => c.agents.some(a => a.agentId === agentId));
  return { ...f, auto, paseo, agents, make, init, cardsOf, cwd, refreshes: () => refreshes, tick: at => { clock = at; } };
}

test('D33 an agent created before its board gets its card at the next live signal, in that signal\'s stage, once', async t => {
  const s = await setup(t);
  s.tick('2026-09-26T13:27:07.000Z');
  const { hook, snapshot } = s.make();
  assert.equal(await s.auto.signal(hook, 'created', s.paseo), 'no-board');
  // Still no board: nothing is asked of Paseo and nothing is written.
  assert.equal(await s.auto.signal(hook, 'turn_started', s.paseo), 'no-card');
  assert.equal(s.refreshes(), 0);
  s.tick('2026-09-26T13:28:04.000Z');
  const boardId = await s.init();
  // Two signals fired without waiting: one card, made once.
  const results = await Promise.all([s.auto.signal(hook, 'turn_started', s.paseo), s.auto.signal(hook, 'turn_started', s.paseo)]);
  assert.deepEqual(results, ['created', 'unchanged']);
  let [card, ...more] = await s.cardsOf(boardId, hook.id);
  assert.equal(more.length, 0);
  assert.deepEqual([card.title, card.stageId, card.awaiting], [snapshot.title, 'doing', null], 'the current title, not the hook\'s');
  const entry = (await readAutoState(s.store.dataDir)).agents[hook.id];
  assert.deepEqual([entry.boardId, entry.cardId, entry.bucket, entry.moved.cause], [boardId, card.id, 'working', 'turn_started']);
  // From here the card follows the agent as any other.
  assert.equal(await s.auto.signal(hook, 'turn_ended', s.paseo), 'updated');
  assert.equal((await s.cardsOf(boardId, hook.id))[0].stageId, 'review');
  assert.equal((await s.store.readBoard(boardId)).cards.length, 1);
});

test('D33 each live signal makes the card in its own stage; a permission is asked mid-turn', async t => {
  const s = await setup(t);
  const asking = s.make(), ended = s.make();
  for (const a of [asking, ended]) assert.equal(await s.auto.signal(a.hook, 'created', s.paseo), 'no-board');
  const boardId = await s.init();
  assert.equal(await s.auto.signal(asking.hook, 'permission_requested', s.paseo), 'created');
  assert.equal(await s.auto.signal(ended.hook, 'turn_ended', s.paseo), 'created');
  const [a] = await s.cardsOf(boardId, asking.hook.id), [e] = await s.cardsOf(boardId, ended.hook.id);
  assert.deepEqual([a.stageId, a.awaiting], ['doing', 'user']);
  assert.deepEqual([e.stageId, e.awaiting], ['review', null]);
  assert.equal(await s.auto.signal(asking.hook, 'permission_resolved', s.paseo), 'updated');
  assert.equal((await s.cardsOf(boardId, asking.hook.id))[0].awaiting, null);
});

test('D33 exclusions stay: unlinked, archived card, switched off, sub-agent, archived or old agent, no board, no answer', async t => {
  const s = await setup(t);
  const unlinked = s.make(), archivedCard = s.make(), child = s.make(), remembered = s.make();
  const archivedAgent = s.make({ archivedAt: '2026-09-26T13:10:00.000Z' });
  const old = s.make({ createdAt: '2026-09-20T00:00:00.000Z' });
  const silent = s.make(); s.agents.delete(silent.snapshot.id);
  // The first hook lists the agents while there is no board yet; the one sub-agent's parent is remembered then.
  s.agents.get(remembered.snapshot.id).labels = { 'paseo.parent-agent-id': unlinked.hook.id };
  assert.equal(await s.auto.signal(unlinked.hook, 'created', s.paseo), 'no-board');
  await s.auto.idle();
  const boardId = await s.init();
  // Paseo labels this one a sub-agent only after the listing, so nothing remembers it as one.
  const labelled = s.make({ labels: { 'paseo.parent-agent-id': unlinked.hook.id } });
  // A sub-agent by its hook, or by the parent remembered for it after Paseo dropped the label.
  assert.equal(await s.auto.signal({ ...child.hook, parentAgentId: unlinked.hook.id }, 'turn_started', s.paseo), 'child');
  assert.equal(await s.auto.signal(remembered.hook, 'turn_started', s.paseo), 'child');
  // Archived, older than the start line, labelled a sub-agent, or no answer from Paseo: no card. The settled ones are asked once.
  for (const a of [archivedAgent, old, labelled, silent]) assert.equal(await s.auto.signal(a.hook, 'turn_started', s.paseo), 'no-card');
  const asked = s.refreshes();
  for (const a of [archivedAgent, old, labelled, silent]) assert.equal(await s.auto.signal(a.hook, 'turn_ended', s.paseo), 'no-card');
  assert.equal(s.refreshes(), asked + 1, 'only the unanswered one is asked again');
  // An archived agent's own signal never makes a card.
  assert.equal(await s.auto.signal(archivedCard.hook, 'archived', s.paseo), 'no-card');
  // A card made late and then unlinked by a person, or archived, is respected like any other.
  assert.equal(await s.auto.signal(unlinked.hook, 'turn_started', s.paseo), 'created');
  const [u] = await s.cardsOf(boardId, unlinked.hook.id);
  await s.store.mutateBoard(boardId, request([{ op: 'unlink', id: u.id, agentId: unlinked.hook.id }]));
  assert.equal(await s.auto.signal(unlinked.hook, 'turn_started', s.paseo), 'no-card');
  assert.equal(await s.auto.signal(archivedCard.hook, 'turn_started', s.paseo), 'created');
  const [c] = await s.cardsOf(boardId, archivedCard.hook.id);
  await s.store.mutateBoard(boardId, request([{ op: 'archive', id: c.id }]));
  assert.equal(await s.auto.signal(archivedCard.hook, 'turn_started', s.paseo), 'archived-card');
  const cards = (await s.store.readBoard(boardId)).cards;
  assert.equal(cards.length, 2, 'only the two cards made above');
  // The same "made before" with nothing remembered (the entry gone): the late card is not linked again.
  const state = JSON.parse(await fs.readFile(join(s.store.dataDir, 'auto-cards.json'), 'utf8'));
  delete state.agents[unlinked.hook.id];
  await fs.writeFile(join(s.store.dataDir, 'auto-cards.json'), JSON.stringify(state));
  assert.equal(await s.auto.signal(unlinked.hook, 'turn_started', s.paseo), 'unlinked');
  assert.equal((await s.cardsOf(boardId, unlinked.hook.id)).length, 0);
  // Switched off: nothing, and Paseo is not asked.
  const off = s.make();
  await s.auto.setEnabled('host_a', false);
  const before = s.refreshes();
  assert.equal(await s.auto.signal(off.hook, 'turn_started', s.paseo), 'disabled');
  assert.equal(s.refreshes(), before);
  // Without a way to ask Paseo (no `ref`), the start line cannot be checked: no card.
  await s.auto.setEnabled('host_a', true);
  const unasked = s.make();
  assert.equal(await s.auto.signal(unasked.hook, 'turn_started', { agents: { list: s.paseo.agents.list } }), 'no-card');
  assert.equal((await s.store.readBoard(boardId)).cards.length, 2);
});

test('D33 a workspace that never gets a board stays untouched and Paseo is not asked', async t => {
  const s = await setup(t);
  const stray = s.make();
  const before = (await s.store.readBoard(s.id)).revision;
  for (const name of ['created', 'turn_started', 'turn_ended', 'permission_requested']) await s.auto.signal(stray.hook, name, s.paseo);
  assert.equal(s.refreshes(), 0, 'no board: Paseo is not asked');
  assert.deepEqual(await fs.readdir(s.cwd), []);
  assert.equal((await s.store.readBoard(s.id)).revision, before);
  assert.deepEqual((await s.store.listBoardIdentities()).map(b => b.workspaceId), ['wks_example01']);
});

// D33-b: an orchestrator made before the start line but still at work after it (a lead started days earlier) gets its card — at its
// next live signal, and in the repair after a restart. Old finished or archived ones stay out.
test('D33-b an agent made before the start line gets a card only when it is not archived and active after it', async t => {
  const s = await setup(t);
  const boardId = await s.init();
  s.tick('2026-09-26T14:00:00.000Z');
  const OLD = '2026-09-22T01:36:31.000Z';
  const busy = s.make({ createdAt: OLD, lastUserMessageAt: '2026-09-26T13:30:00.000Z', updatedAt: OLD });
  const touched = s.make({ createdAt: OLD, lastUserMessageAt: OLD, updatedAt: '2026-09-26T13:40:00.000Z' });
  const finished = s.make({ createdAt: OLD, lastUserMessageAt: OLD, updatedAt: OLD });
  const atLine = s.make({ createdAt: OLD, lastUserMessageAt: START, updatedAt: START });
  const archived = s.make({ createdAt: OLD, lastUserMessageAt: '2026-09-26T13:30:00.000Z', archivedAt: '2026-09-26T13:50:00.000Z' });
  // The first hook lists the agents once (the repair): the two active ones get their cards there, once.
  assert.equal(await s.auto.signal(busy.hook, 'turn_started', s.paseo), 'unchanged');
  await s.auto.idle();
  for (const a of [busy, touched]) assert.equal((await s.cardsOf(boardId, a.hook.id)).length, 1, 'active after the start line: a card');
  for (const a of [finished, atLine, archived]) {
    assert.equal(await s.auto.signal(a.hook, 'turn_ended', s.paseo), 'no-card');
    assert.equal((await s.cardsOf(boardId, a.hook.id)).length, 0);
  }
  // A live signal of one that became active after the repair: its card now, and only once.
  const late = s.make({ createdAt: OLD, lastUserMessageAt: '2026-09-26T14:06:00.000Z' });
  assert.deepEqual(await Promise.all([s.auto.signal(late.hook, 'turn_started', s.paseo), s.auto.signal(late.hook, 'turn_started', s.paseo)]),
    ['created', 'unchanged']);
  assert.equal((await s.cardsOf(boardId, late.hook.id)).length, 1);
  assert.equal((await s.store.readBoard(boardId)).cards.length, 3);
});
