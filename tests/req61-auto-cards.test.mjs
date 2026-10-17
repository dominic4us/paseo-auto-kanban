import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { builtinTemplate } from '../dist/server/core/index.js';
import { createAutoCards, changeFor, stageFor, readAutoState, readListedAgent, cleanTitle } from '../dist/server/auto-cards.js';
import { createReadHandlers, readLocale } from '../dist/server/handlers.js';
import { overviewGet, autoCardsSet } from '../dist/shared/rpc.js';
import { fixture, request, add } from './helpers.mjs';

// REQ-61: agent lifecycle signals → one card per top-level agent, only where a board already exists.
const WORKSPACE = 'wks_example01';
const agentOf = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, parentAgentId: null,
  provider: 'claude', cwd: '/nowhere', title: '[검증용] 자동 카드', ...overrides });
async function setup(t, options = {}) {
  const f = await fixture(t);
  const logs = [];
  const auto = createAutoCards({ store: options.store ?? f.store, locale: readLocale,
    log: (message, detail) => logs.push({ message, detail }), ...(options.now ? { now: options.now } : {}) });
  const cardsOf = async agentId => (await f.store.readBoard(f.id)).cards.filter(c => c.agents.some(a => a.agentId === agentId));
  const revision = async () => (await f.store.readBoard(f.id)).revision;
  return { ...f, auto, logs, cardsOf, revision };
}
const ok = (reply, contract) => { assert.equal(reply.ok, true, JSON.stringify(reply)); contract.output.parse(reply); return reply.data; };

test('REQ-61 ② mapping: each signal to one bucket, each bucket to a stage by position (builtin and custom templates)', () => {
  assert.deepEqual(changeFor('created'), { create: true });
  assert.deepEqual(changeFor('turn_started'), { bucket: 'working' });
  assert.deepEqual(changeFor('turn_ended'), { bucket: 'review', awaiting: false });
  assert.deepEqual(changeFor('permission_requested'), { awaiting: true });
  assert.deepEqual(changeFor('permission_resolved'), { awaiting: false });
  // REQ-74: archiving an agent leaves its card in review; only a person completes it.
  assert.deepEqual(changeFor('archived'), { bucket: 'review', awaiting: false });
  const stages = builtinTemplate().stages;
  assert.deepEqual(['waiting', 'working', 'review', 'done'].map(b => stageFor(stages, b)), ['todo', 'doing', 'review', 'done']);
  const two = [{ stageId: 'open', countsAsDone: false }, { stageId: 'busy', countsAsDone: false }, { stageId: 'shipped', countsAsDone: true }];
  assert.deepEqual(['waiting', 'working', 'review', 'done'].map(b => stageFor(two, b)), ['open', 'busy', 'busy', 'shipped']);
  assert.equal(cleanTitle('  /orchestrator \n  next '), '/orchestrator next');
  assert.equal([...cleanTitle('가'.repeat(300))].length, 200);
  assert.equal(cleanTitle('   '), null);
});

test('REQ-61 ① a top-level agent gets one card: agent title, automatic criteria in the ledger language, linked, waiting', async t => {
  const s = await setup(t);
  await fs.writeFile(join(s.store.dataDir, 'config.json'), JSON.stringify({ schemaVersion: 1, exportEnabled: true, locale: 'ko', export: { detail: 'compact' } }));
  const agent = agentOf();
  assert.equal(await s.auto.signal(agent, 'created'), 'created');
  const [card, ...more] = await s.cardsOf(agent.id);
  assert.equal(more.length, 0);
  assert.equal(card.title, '[검증용] 자동 카드');
  assert.equal(card.stageId, 'todo');
  assert.equal(card.intent, 'requested');
  assert.equal(card.acceptanceCriteria, '에이전트가 맡은 작업을 마치고, 사람이 결과를 확인한다.', 'a ko ledger gets ko text');
  assert.deepEqual(card.createdBy, { kind: 'agent', agentId: agent.id });
  assert.deepEqual(card.agents.map(a => [a.agentId, a.role]), [[agent.id, 'worker']]);
  // An en ledger (the core default), and an agent with no title yet.
  const en = await setup(t);
  const untitled = agentOf({ title: null });
  await en.auto.signal(untitled, 'created');
  const [plain] = await en.cardsOf(untitled.id);
  assert.equal(plain.title, 'Agent ' + untitled.id.slice(0, 8));
  assert.equal(plain.acceptanceCriteria, 'The agent finishes its work and a person reviews the result.');
  // The same created signal again (a replayed hook) never makes a second card.
  assert.equal(await s.auto.signal(agent, 'created'), 'unchanged');
  assert.equal((await s.cardsOf(agent.id)).length, 1);
});

test('REQ-61 ② ④ signals fired without waiting land in order: create first, then every move; writes only on bucket change', async t => {
  const s = await setup(t);
  const agent = agentOf();
  // The daemon does not wait for hooks: all of these are in flight before the card exists.
  const results = await Promise.all(['created', 'turn_started', 'turn_started', 'permission_requested', 'permission_resolved',
    'turn_ended', 'turn_ended'].map(name => s.auto.signal(agent, name)));
  assert.deepEqual(results, ['created', 'updated', 'unchanged', 'updated', 'updated', 'updated', 'unchanged']);
  const board = await s.store.readBoard(s.id);
  const [card] = board.cards;
  assert.equal(card.stageId, 'review');
  assert.equal(card.awaiting, null, 'the permission flag this feature raised is lowered again');
  assert.deepEqual(board.history.filter(h => h.cardId === card.id).map(h => [h.from, h.to]),
    [[null, 'todo'], ['todo', 'doing'], ['doing', 'review']]);
  // Next turn goes back to work; archive leaves it in review (REQ-74), so it writes nothing.
  const before = await s.revision();
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'updated');
  assert.equal(await s.auto.signal(agent, 'turn_ended'), 'updated');
  assert.equal(await s.auto.signal(agent, 'archived'), 'unchanged');
  const after = await s.store.readBoard(s.id);
  assert.equal(after.cards[0].stageId, 'review');
  assert.equal(Number(after.revision.split(':')[1]) - Number(before.split(':')[1]), 2, 'two bucket changes, two commits');
  // Idle: repeating the last signal and doing nothing at all both write nothing.
  const quiet = await s.revision();
  assert.equal(await s.auto.signal(agent, 'archived'), 'unchanged');
  await s.auto.idle();
  assert.equal(await s.revision(), quiet);
});

test('REQ-61 ② a permission request raises "awaiting", but a person\'s own awaiting flag is never lowered', async t => {
  const s = await setup(t);
  const agent = agentOf();
  await s.auto.signal(agent, 'created'); await s.auto.signal(agent, 'turn_started');
  await s.auto.signal(agent, 'permission_requested');
  let [card] = await s.cardsOf(agent.id);
  assert.equal(card.awaiting, 'user');
  assert.equal(card.stageId, 'doing', 'the stage stays; only the flag shows it needs a person');
  await s.auto.signal(agent, 'permission_resolved');
  [card] = await s.cardsOf(agent.id);
  assert.equal(card.awaiting, null);
  // A person marks it awaiting; the agent's next permission cycle leaves that alone.
  await s.store.mutateBoard(s.id, request([{ op: 'update', id: card.id, patch: { awaiting: 'user' } }]));
  await s.auto.signal(agent, 'permission_requested');
  await s.auto.signal(agent, 'permission_resolved');
  [card] = await s.cardsOf(agent.id);
  assert.equal(card.awaiting, 'user');
});

test('REQ-61 ③ an agent already on a card (orchestrator link) joins that card instead of getting a new one', async t => {
  const s = await setup(t);
  const agent = agentOf();
  const made = await s.store.mutateBoard(s.id, request([add('Orchestrator card')]));
  const cardId = made.data.cardIds[0];
  await s.store.mutateBoard(s.id, request([{ op: 'link', id: cardId, agentId: agent.id, role: 'worker', label: 'orc' }]));
  assert.equal(await s.auto.signal(agent, 'created'), 'unchanged');
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'updated');
  const cards = await s.cardsOf(agent.id);
  assert.deepEqual(cards.map(c => [c.id, c.title, c.stageId]), [[cardId, 'Orchestrator card', 'doing']]);
  await s.auto.signal({ ...agent, title: 'Renamed agent' }, 'turn_ended');
  assert.equal((await s.cardsOf(agent.id))[0].title, 'Orchestrator card', 'a title this feature did not write is never replaced');
  // An archived card that carries the agent is left alone: no new card, no move.
  await s.store.mutateBoard(s.id, request([{ op: 'archive', id: cardId }]));
  assert.equal(await s.auto.signal(agent, 'turn_started'), 'archived-card');
  assert.equal((await s.store.readBoard(s.id)).cards.length, 1);
});

test('REQ-61 decisions: sub-agents are excluded and a workspace without a board gets nothing (no board, no PROCESS.md)', async t => {
  const s = await setup(t);
  const parent = agentOf();
  const child = agentOf({ parentAgentId: parent.id });
  for (const name of ['created', 'turn_started', 'turn_ended', 'archived']) assert.equal(await s.auto.signal(child, name), 'child');
  const outside = await fs.mkdtemp(join(s.root, 'boardless-'));
  const stray = agentOf({ workspaceId: 'wks_noboard01', cwd: outside });
  const before = await s.revision();
  for (const name of ['created', 'turn_started', 'turn_ended']) await s.auto.signal(stray, name);
  assert.equal(await s.revision(), before);
  assert.deepEqual((await s.store.listBoardIdentities()).map(b => b.workspaceId), [WORKSPACE]);
  assert.deepEqual(await fs.readdir(outside), [], 'no PROCESS.md written into a workspace that has no board');
  assert.equal((await s.store.readBoard(s.id)).cards.length, 0);
  // REQ-76 supersedes "nothing written": the sub-agent's parent is remembered for the screen's grouping, and only that.
  const kept = await readAutoState(s.store.dataDir);
  assert.deepEqual(Object.keys(kept.agents), [], 'no card remembered for anyone');
  assert.deepEqual(Object.entries(kept.parents).map(([id, e]) => [id, e.parentAgentId]), [[child.id, parent.id]]);
  // D22: a board at the same directory under an older id still owns the agent's workspace.
  const moved = agentOf({ workspaceId: 'wks_renamed01', cwd: s.cwd + '/' });
  assert.equal(await s.auto.signal(moved, 'created'), 'created');
});

test('REQ-61 ⑤ a failing ledger never escapes a hook: logged, other signals and agents keep working', async t => {
  const f = await fixture(t);
  let broken = true;
  const store = new Proxy(f.store, { get(target, key) {
    if (key === 'mutateBoard') return async (...args) => { if (broken) throw new Error('Synthetic disk failure'); return target.mutateBoard(...args); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const s = await setup(t, { store });
  const agent = agentOf();
  let outcome;
  assert.doesNotThrow(() => { outcome = s.auto.signal(agent, 'created'); });
  assert.equal(await outcome, 'failed');
  assert.match(s.logs[0].message, /created .* failed/);
  assert.match(s.logs[0].detail, /Synthetic disk failure/);
  // Malformed input is caught too. REQ-83: an agent that cannot be read is held (nothing written), not guessed at.
  assert.equal(await s.auto.signal(null, 'created'), 'held');
  assert.equal(await s.auto.signal({ ...agent, parentAgentId: null, cwd: undefined, workspaceId: null }, 'bogus'), 'held');
  broken = false;
  const other = agentOf();
  assert.equal(await s.auto.signal(other, 'created'), 'created', 'the queue survives a failed task');
  assert.equal((await f.store.readBoard(f.id)).cards.length, 1);
});

test('REQ-61 ⑦ a hook\'s own title never renames the card (it is the stale creation title); the reconciliation list does', async t => {
  const s = await setup(t, { now: () => '2026-09-23T05:00:00.000Z' });
  const agent = agentOf({ title: '/orchestrator' });
  await s.auto.signal(agent, 'created');
  await s.auto.signal({ ...agent, title: 'Something else' }, 'turn_started');
  assert.equal((await s.cardsOf(agent.id))[0].title, '/orchestrator');
  // After a restart the agent list carries the current title.
  const restarted = createAutoCards({ store: s.store, locale: readLocale, now: () => '2026-09-23T06:00:00.000Z' });
  const paseo = lister([listed({ id: agent.id, title: '총괄-8_sample-app_Opus', createdAt: '2026-09-23T05:00:00.000Z', status: 'running' })]);
  await restarted.signal(agent, 'turn_started', paseo);
  await restarted.idle();
  assert.equal((await s.cardsOf(agent.id))[0].title, '총괄-8_sample-app_Opus');
  // and a later stale hook title does not put the old name back.
  await restarted.signal(agent, 'turn_ended');
  assert.equal((await s.cardsOf(agent.id))[0].title, '총괄-8_sample-app_Opus');
});

test('REQ-61 ⑦ measured: hook payloads keep the creation title, so a finished turn looks up the renamed title (once, safely)', async t => {
  const s = await setup(t);
  const agent = agentOf({ title: '/orchestrator' });
  let current = '총괄-9_sample-app_Opus', lookups = 0;
  const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => { lookups++; assert.equal(id, agent.id); return { agent: { id, title: current }, project: null }; } }) } };
  await s.auto.signal(agent, 'created', paseo);
  await s.auto.signal(agent, 'turn_started', paseo);
  assert.equal(lookups, 0, 'only a finished turn asks');
  await s.auto.signal(agent, 'turn_ended', paseo);
  assert.equal((await s.cardsOf(agent.id))[0].title, '총괄-9_sample-app_Opus');
  assert.equal(lookups, 1);
  // A failing or silent lookup keeps the title and the move still happens.
  paseo.agents.ref = () => ({ refresh: async () => { throw new Error('Synthetic lookup failure'); } });
  await s.auto.signal(agent, 'turn_started', paseo);
  assert.equal(await s.auto.signal(agent, 'turn_ended', paseo), 'updated');
  const [card] = await s.cardsOf(agent.id);
  assert.deepEqual([card.title, card.stageId], ['총괄-9_sample-app_Opus', 'review']);
  // A person's title is never looked up again.
  await s.store.mutateBoard(s.id, request([{ op: 'update', id: card.id, patch: { title: 'Mine' } }]));
  let asked = 0;
  paseo.agents.ref = () => ({ refresh: async () => { asked++; return { agent: { title: 'Other' } }; } });
  await s.auto.signal(agent, 'turn_started', paseo); await s.auto.signal(agent, 'turn_ended', paseo);
  assert.equal(asked, 0);
  assert.equal((await s.cardsOf(agent.id))[0].title, 'Mine');
});

function lister(agents) {
  const calls = [];
  return { calls, agents: { list: async options => {
    calls.push(options);
    const start = options.page.cursor ? Number(options.page.cursor) : 0;
    const slice = agents.slice(start, start + 2);
    return { entries: slice.map(agent => ({ agent, project: null })),
      pageInfo: { nextCursor: start + 2 < agents.length ? String(start + 2) : null } };
  } } };
}
const listed = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, cwd: '/nowhere', title: 'Listed', labels: {},
  status: 'idle', pendingPermissions: [], archivedAt: null, lastUserMessageAt: '2026-09-23T05:00:00.000Z', ...overrides });

test('REQ-61 ⑥ reconciliation after a restart: only agents created since the feature started, every page, no flood', async t => {
  const s = await setup(t, { now: () => '2026-09-23T05:00:00.000Z' });
  // The feature's start line is written once, the first time it acts.
  const first = agentOf();
  await s.auto.signal(first, 'created');
  assert.equal((await readAutoState(s.store.dataDir)).activatedAt, '2026-09-23T05:00:00.000Z');
  // Restart: a fresh engine; what happened meanwhile is only in the agent list.
  const restarted = createAutoCards({ store: s.store, locale: readLocale, now: () => '2026-09-23T06:00:00.000Z' });
  const old = listed({ title: 'Before the feature', createdAt: '2026-09-01T00:00:00.000Z' });
  const running = listed({ title: 'Made during downtime', createdAt: '2026-09-23T05:10:00.000Z', status: 'running' });
  const archived = listed({ title: 'Archived during downtime', createdAt: '2026-09-23T05:20:00.000Z', archivedAt: '2026-09-23T05:30:00.000Z' });
  const asking = listed({ title: 'Asking', createdAt: '2026-09-23T05:25:00.000Z', status: 'running', pendingPermissions: [{ id: 'p' }] });
  const child = listed({ title: 'Worker', createdAt: '2026-09-23T05:15:00.000Z', labels: { 'paseo.parent-agent-id': first.id } });
  const firstNow = listed({ id: first.id, title: first.title, createdAt: '2026-09-23T05:00:00.000Z', status: 'idle' });
  const paseo = lister([old, running, archived, asking, child, firstNow]);
  const live = agentOf({ title: 'Live' });
  // The first hook after the restart triggers it; its own signal lands after the repairs.
  assert.equal(await restarted.signal(live, 'created', paseo), 'created');
  await restarted.idle();
  const board = await s.store.readBoard(s.id);
  const titles = Object.fromEntries(board.cards.map(c => [c.title, [c.stageId, c.awaiting]]));
  assert.deepEqual(titles, {
    [first.title]: ['review', null],
    'Made during downtime': ['doing', null],
    'Archived during downtime': ['review', null],
    'Asking': ['doing', 'user'],
    'Live': ['todo', null],
  }, 'old agents and workers get nothing; missed agents land in their current bucket');
  assert.equal(paseo.calls.length, 3, 'every page is read');
  assert.equal(paseo.calls[0].filter.includeArchived, true);
  // Once per process: a second hook does not list again.
  await restarted.signal(first, 'turn_started', paseo);
  assert.equal(paseo.calls.length, 3);
  assert.equal(readListedAgent({ agent: child }).parentAgentId, first.id, 'the SDK entry has no parentAgentId; the label decides');
});

test('REQ-61 ⑥ the created signal of a brand-new agent is not mistaken for an old one, and a card nobody asked to track is adopted, not moved', async t => {
  const s = await setup(t, { now: () => '2026-09-23T05:00:00.000Z' });
  const fresh = agentOf();
  const orchestrated = agentOf();
  const made = await s.store.mutateBoard(s.id, request([add('Linked by the orchestrator')]));
  await s.store.mutateBoard(s.id, request([{ op: 'link', id: made.data.cardIds[0], agentId: orchestrated.id }]));
  const paseo = lister([listed({ id: orchestrated.id, createdAt: '2026-09-23T05:00:00.000Z', status: 'running' }),
    listed({ id: fresh.id, title: fresh.title, createdAt: '2026-09-23T05:00:00.000Z', status: 'running' })]);
  await s.auto.signal(fresh, 'created', paseo);
  await s.auto.idle();
  const board = await s.store.readBoard(s.id);
  assert.equal(board.cards.find(c => c.id === made.data.cardIds[0]).stageId, 'todo', 'reconciliation keeps a foreign card where it is');
  assert.equal(board.cards.filter(c => c.agents.some(a => a.agentId === fresh.id)).length, 1);
  // The live signals move the adopted card — including a turn_started whose bucket the listing already saw.
  assert.equal(await s.auto.signal(orchestrated, 'turn_started', paseo), 'updated');
  assert.equal((await s.store.readBoard(s.id)).cards.find(c => c.id === made.data.cardIds[0]).stageId, 'doing');
  await s.auto.signal(orchestrated, 'turn_ended', paseo);
  assert.equal((await s.store.readBoard(s.id)).cards.find(c => c.id === made.data.cardIds[0]).stageId, 'review');
});

test('REQ-61 ⑧ switched off per host: no cards, no listing; switching back on starts a new line; overview reports it', async t => {
  let clock = '2026-09-23T05:00:00.000Z';
  const s = await setup(t, { now: () => clock });
  const read = createReadHandlers(s.store);
  assert.equal(ok(await read.overview({ hostId: 'host_a' }), overviewGet).autoCards, true, 'on by default');
  assert.deepEqual(autoCardsSet.output.parse({ ok: true, data: await s.auto.setEnabled('host_a', true), committed: false, warnings: [] }).data,
    { enabled: true, changed: false });
  await assert.rejects(fs.stat(join(s.store.dataDir, 'auto-cards.json')), 'choosing the default writes nothing');
  assert.deepEqual(await s.auto.setEnabled('host_a', false), { enabled: false, changed: true });
  assert.equal(ok(await read.overview({ hostId: 'host_a' }), overviewGet).autoCards, false);
  const quiet = await s.revision();
  const agent = agentOf();
  const paseo = lister([listed({ id: agent.id, createdAt: clock })]);
  assert.equal(await s.auto.signal(agent, 'created', paseo), 'disabled');
  assert.equal(await s.auto.signal(agent, 'turn_started', paseo), 'disabled');
  assert.equal(paseo.calls.length, 0, 'switched off, Paseo is not even listed');
  assert.equal(await s.revision(), quiet);
  // Back on later: agents made while it was off are not back-filled, new ones are carded.
  clock = '2026-09-23T07:00:00.000Z';
  assert.deepEqual(await s.auto.setEnabled('host_a', true), { enabled: true, changed: true });
  await s.auto.signal(agentOf(), 'turn_started', paseo);
  await s.auto.idle();
  assert.equal((await s.store.readBoard(s.id)).cards.length, 0, 'the agent from the off period gets no card');
  const later = agentOf();
  assert.equal(await s.auto.signal(later, 'created', paseo), 'created');
  const raw = JSON.parse(await fs.readFile(join(s.store.dataDir, 'auto-cards.json'), 'utf8'));
  assert.deepEqual(raw.hosts.host_a, { enabled: true, changedAt: '2026-09-23T07:00:00.000Z' });
  // A damaged file means "on", never a crash.
  await fs.writeFile(join(s.store.dataDir, 'auto-cards.json'), '{nope');
  assert.equal(ok(await read.overview({ hostId: 'host_a' }), overviewGet).autoCards, true);
});
