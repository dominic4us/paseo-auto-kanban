import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAutoCards, readListedAgent, readHookAgent, KNOWN_STATUSES, RECONCILE_RETRY_MS, RECOVERY_RETRY_MS, quote } from '../dist/server/auto-cards.js';
import { createReadHandlers, readLocale } from '../dist/server/handlers.js';
import { overviewGet, boardGet, revisionsGet } from '../dist/shared/rpc.js';
import { fixture } from './helpers.mjs';

// REQ-83 (research/124 §5·§7): what the server's automatic tracking does with host input it cannot read — it holds the
// move, never guesses "review", never reads a partial or failed listing as agents gone, and says so to the screens.
const WORKSPACE = 'wks_example01';
const agentOf = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, parentAgentId: null, provider: 'claude',
  cwd: '/nowhere', title: 'Example agent', ...overrides });
const listed = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, cwd: '/nowhere', title: 'Listed', labels: {},
  status: 'idle', pendingPermissions: [], archivedAt: null, lastUserMessageAt: '2026-09-23T05:00:00.000Z', createdAt: '2026-09-23T05:00:00.000Z', ...overrides });
const pages = (...list) => ({ calls: 0, agents: { async list(options) {
  this.calls = (this.calls ?? 0) + 1;
  const index = options.page.cursor ? Number(options.page.cursor) : 0, page = list[index];
  if (page instanceof Error) throw page;
  if (typeof page === 'function') return page();
  return { entries: page.map(agent => ({ agent })), pageInfo: { nextCursor: index + 1 < list.length ? String(index + 1) : null } };
} } });
async function setup(t, now = () => '2026-09-23T05:00:00.000Z') {
  const f = await fixture(t), logs = [];
  const make = (clock = now) => createAutoCards({ store: f.store, locale: readLocale, now: clock, log: (message, detail) => logs.push({ message, detail }) });
  const stageOf = async agentId => (await f.store.readBoard(f.id)).cards.find(c => c.agents.some(a => a.agentId === agentId))?.stageId;
  const revision = async () => (await f.store.readBoard(f.id)).revision;
  return { ...f, make, logs, stageOf, revision };
}
/** A card the feature made and moved to "doing": the agent was created, then started a turn. */
async function working(s, auto) {
  const agent = agentOf();
  assert.equal(await auto.signal(agent, 'created'), 'created');
  assert.equal(await auto.signal(agent, 'turn_started'), 'updated');
  assert.equal(await s.stageOf(agent.id), 'doing');
  return agent;
}

test('REQ-83 ① an agent listing entry whose state cannot be read is held, not guessed as review', () => {
  assert.deepEqual([...KNOWN_STATUSES], ['initializing', 'idle', 'running', 'error', 'closed'], 'the 0.8–0.9 protocol statuses');
  for (const [patch, hold] of [
    [{ status: 'future-running' }, { issue: 'unknown-status', detail: 'future-running' }],
    [{ status: undefined }, { issue: 'missing-field', detail: 'status' }],
    [{ status: 7 }, { issue: 'missing-field', detail: 'status' }],
    [{ pendingPermissions: undefined }, { issue: 'missing-field', detail: 'pendingPermissions' }],
    [{ lastUserMessageAt: undefined }, { issue: 'missing-field', detail: 'lastUserMessageAt' }],
    [{ archivedAt: 12 }, { issue: 'missing-field', detail: 'archivedAt' }],
  ]) assert.deepEqual(readListedAgent({ agent: listed(patch) }).hold, hold, JSON.stringify(patch));
  // What 0.9.1 sends reads as before; an archived agent is read from `archivedAt` whatever its status says.
  for (const [patch, bucket] of [[{ status: 'running' }, 'working'], [{ status: 'idle' }, 'review'], [{ status: 'idle', lastUserMessageAt: null }, 'waiting'],
    [{ status: 'initializing' }, 'waiting'], [{ status: 'closed' }, 'review'], [{ status: 'error' }, 'review'],
    [{ status: 'future-running', archivedAt: '2026-09-23T06:00:00.000Z' }, 'review']]) {
    const agent = readListedAgent({ agent: listed(patch) });
    assert.equal(agent.hold, undefined, JSON.stringify(patch));
    assert.equal(agent.bucket, bucket, JSON.stringify(patch));
  }
  assert.equal(readListedAgent({ agent: listed({ status: 'x'.repeat(90) }) }).hold.detail.length, 40, 'a quoted value is kept short');
});

test('REQ-83 ① a hook whose agent cannot be read is held: nothing written, said in health, cleared by the next readable hook', async t => {
  const s = await setup(t), auto = s.make();
  assert.deepEqual(readHookAgent(agentOf()).hold, null);
  assert.deepEqual(readHookAgent({ ...agentOf(), title: undefined }).agent.title, null, 'a title may be missing: it only names the card');
  for (const [input, detail] of [[null, 'agent'], [{ ...agentOf(), id: '' }, 'id'], [{ ...agentOf(), parentAgentId: undefined }, 'parentAgentId'],
    [{ ...agentOf(), workspaceId: undefined }, 'workspaceId'], [{ ...agentOf(), cwd: 3 }, 'cwd'], [{ ...agentOf(), title: 5 }, 'title']])
    assert.deepEqual(readHookAgent(input).hold, { issue: 'bad-hook', detail }, detail);
  const before = await s.revision();
  const odd = { ...agentOf(), parentAgentId: undefined };
  assert.equal(await auto.signal(odd, 'created'), 'held');
  assert.equal(await s.revision(), before, 'the ledger is untouched');
  // H1: the count of hook inputs among the holds, so the screens call them inputs, not agents' states.
  assert.deepEqual(auto.health(), { state: 'held', held: 1, issue: 'bad-hook', detail: 'parentAgentId', at: '2026-09-23T05:00:00.000Z', inputs: 1 });
  assert.match(s.logs.at(-1).message, /created held: bad-hook parentAgentId/);
  // The same agent, readable again: its hold goes.
  assert.equal(await auto.signal({ ...odd, parentAgentId: null }, 'created'), 'created');
  assert.deepEqual(auto.health(), { state: 'ok', held: 0, issue: null, detail: null, at: null });
});

test('REQ-83 ① a listed agent with an unknown status keeps its card where it is; the control with a known status moves', async t => {
  for (const [status, expected] of [['future-running', 'doing'], ['idle', 'review']]) {
    const s = await setup(t), auto = s.make();
    const agent = await working(s, auto);
    // Restart: the repair lists the agent. An unknown status is held, a known one repairs the card.
    const restarted = s.make(() => '2026-09-23T06:00:00.000Z');
    restarted.wake(pages([listed({ id: agent.id, status })]));
    await restarted.idle();
    assert.equal(await s.stageOf(agent.id), expected, status);
    const health = restarted.health();
    if (status === 'idle') assert.equal(health.state, 'ok');
    else assert.deepEqual(health, { state: 'held', held: 1, issue: 'unknown-status', detail: 'future-running', at: '2026-09-23T06:00:00.000Z' });
  }
});

test('REQ-83 ① a failed, odd-shaped or partial agent listing moves nothing and says the tracking may have stopped', async t => {
  for (const [name, lister, issue] of [
    ['rejects', () => pages(new Error('Synthetic listing failure')), 'list-failed'],
    ['no entries array', () => pages(() => ({ entries: 'nope', pageInfo: {} })), 'list-shape'],
    ['no agents.list', () => ({ agents: {} }), 'list-shape'],
    // Page one would move the card to review; page two fails, so nothing of page one is applied either.
    ['page two fails', agentId => pages([listed({ id: agentId, status: 'idle' })], new Error('Synthetic page failure')), 'list-failed'],
  ]) {
    const s = await setup(t), auto = s.make();
    const agent = await working(s, auto), before = await s.revision();
    const restarted = s.make(() => '2026-09-23T06:00:00.000Z');
    restarted.wake(lister(agent.id));
    await restarted.idle();
    assert.equal(await s.revision(), before, name + ': the ledger is untouched');
    assert.equal(await s.stageOf(agent.id), 'doing', name + ': an agent missing from a failed listing is not taken as finished');
    const health = restarted.health();
    assert.equal(health.state, 'failed', name);
    assert.equal(health.issue, issue, name);
    assert.ok(health.detail.length > 0 && health.detail.length <= 40, name + ': ' + health.detail);
  }
});

test('REQ-83 ① after three failed listings the repair is tried again after a pause, and a success clears the failure', async t => {
  const s = await setup(t);
  let clock = Date.parse('2026-09-23T06:00:00.000Z');
  const auto = s.make(() => new Date(clock).toISOString());
  let fail = true;
  const paseo = { calls: 0, agents: { async list() { paseo.calls++; if (fail) throw new Error('down'); return { entries: [], pageInfo: {} }; } } };
  for (let i = 0; i < 4; i++) { auto.wake(paseo); await auto.idle(); }
  assert.equal(paseo.calls, 3, 'three tries, as before');
  assert.equal(auto.health().state, 'failed');
  clock += RECONCILE_RETRY_MS - 1; auto.wake(paseo); await auto.idle();
  assert.equal(paseo.calls, 3, 'not before the pause');
  fail = false; clock += 1; auto.wake(paseo); await auto.idle();
  assert.equal(paseo.calls, 4, 'once the pause is over');
  assert.equal(auto.health().state, 'ok', 'a listing that reads clears it');
});

test('REQ-83 ② every read tells the screens how automatic tracking is doing (overview, board, revisions)', async t => {
  const s = await setup(t);
  const health = { state: 'held', held: 2, issue: 'unknown-status', detail: 'future-running', at: '2026-09-23T06:00:00.000Z' };
  const read = createReadHandlers(s.store, () => '2026-09-23T06:00:00.000Z', undefined, undefined, () => health);
  for (const [reply, contract] of [[await read.overview({ includeBoards: true, hostId: 'host_example' }), overviewGet],
    [await read.board({ boardId: s.id, hostId: 'host_example' }), boardGet], [await read.revisions({ groups: true }), revisionsGet]]) {
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(contract.output.parse(reply).data.autoHealth, health, contract.name);
  }
  // Without the engine (tests, older wiring) the field is simply absent, and a throwing reporter never fails a read.
  assert.equal((await createReadHandlers(s.store).overview({})).data.autoHealth, undefined);
  const broken = createReadHandlers(s.store, undefined, undefined, undefined, () => { throw new Error('boom'); });
  assert.equal((await broken.revisions({})).ok, true);
});

test('REQ-83 ③ the manifest allows every 0.x from 0.8.0 and stops before 1.0, as Paseo itself evaluates it', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../paseo-plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.requirements.paseo, '>=0.8.0 <1.0.0');
  // The installed host's own judge (research/124 §2), not a copy of its rule.
  return import(new URL('../node_modules/@getpaseo/protocol/dist/plugin-requirements.js', import.meta.url).href).then(({ assertPluginCompatibility }) => {
    const allowed = version => { try { assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, version, runtime: 'app' }); return true; }
      catch { return false; } };
    for (const version of ['0.8.0', '0.8.0-beta.1', '0.9.1', '0.9.2', '0.10.0', '0.99.0']) assert.equal(allowed(version), true, version);
    for (const version of ['0.7.9', '1.0.0-beta.1', '1.0.0', '2.0.0']) assert.equal(allowed(version), false, version);
  });
});

test('H2 a diagnosis cut at 40 characters ends in "…", so it never reads as a typo; a short one is left whole', async t => {
  assert.equal(quote('Error: gate: injected agents.list failure here'), 'Error: gate: injected agents.list failu…');
  assert.equal([...quote('x'.repeat(40))].length, 40); assert.equal(quote('x'.repeat(40)).endsWith('…'), false, 'exactly 40 is whole');
  assert.equal(quote('two\n  lines'), 'two lines');
  const s = await setup(t), auto = s.make();
  auto.wake(pages(new Error('Synthetic listing failure with a long explanation after it'))); await auto.idle();
  const detail = auto.health().detail;
  assert.equal([...detail].length, 40); assert.ok(detail.endsWith('…'), detail);
  assert.equal(readListedAgent(listed({ status: 'a-status-name-that-runs-well-past-forty-characters' })).hold.detail.endsWith('…'), true);
});

test('H5 after three failed listings, a readable hook or a Paseo read that answered retries at once (30s on), not five minutes later', async t => {
  const s = await setup(t);
  let clock = Date.parse('2026-09-23T06:00:00.000Z');
  const make = () => s.make(() => new Date(clock).toISOString());
  const lister = () => { const paseo = { calls: 0, fail: true, shape: false, agents: { async list() {
    paseo.calls++; if (paseo.fail) throw new Error('down'); return paseo.shape ? { entries: 'nope' } : { entries: [], pageInfo: {} }; } } }; return paseo; };
  const failThrice = async (auto, paseo) => { for (let i = 0; i < 3; i++) { auto.wake(paseo); await auto.idle(); }
    assert.equal(paseo.calls, 3); assert.equal(auto.health().state, 'failed'); };
  // A hook: the connection is back and the hooks flow again.
  let auto = make(), paseo = lister();
  await failThrice(auto, paseo);
  paseo.fail = false;
  clock += RECOVERY_RETRY_MS - 1; await auto.signal(agentOf(), 'created', paseo); await auto.idle();
  assert.equal(paseo.calls, 3, 'not twice within 30 seconds of a failure');
  clock += 1; await auto.signal(agentOf(), 'created', paseo); await auto.idle();
  assert.equal(paseo.calls, 4, 'a readable hook lists again at once');
  assert.equal(auto.health().state, 'ok', 'and the screens\' line goes at their next look, not up to five minutes later');
  // Another read of Paseo that answered (the workspace listing of a board read).
  auto = make(); paseo = lister();
  await failThrice(auto, paseo);
  paseo.fail = false; clock += RECOVERY_RETRY_MS;
  auto.wake(paseo); await auto.idle();
  assert.equal(paseo.calls, 3, 'a plain board read still waits for the pause (REQ-83)');
  auto.answered(paseo); await auto.idle();
  assert.equal(paseo.calls, 4); assert.equal(auto.health().state, 'ok');
  auto.answered(paseo); await auto.idle();
  assert.equal(paseo.calls, 4, 'nothing to retry once it reads');
  // A listing of another shape is not the connection: it waits the five minutes whoever answers.
  auto = make(); paseo = lister(); paseo.fail = false; paseo.shape = true;
  for (let i = 0; i < 3; i++) { auto.wake(paseo); await auto.idle(); }
  assert.equal(auto.health().issue, 'list-shape');
  clock += RECOVERY_RETRY_MS; await auto.signal(agentOf(), 'created', paseo); auto.answered(paseo); await auto.idle();
  assert.equal(paseo.calls, 3);
  clock += RECONCILE_RETRY_MS; auto.answered(paseo); await auto.idle();
  assert.equal(paseo.calls, 4, 'after five minutes, as before');
  // A hook that cannot be read is not Paseo answering.
  auto = make(); paseo = lister();
  await failThrice(auto, paseo);
  paseo.fail = false; clock += RECOVERY_RETRY_MS;
  assert.equal(await auto.signal({ ...agentOf(), cwd: 3 }, 'created', paseo), 'held'); await auto.idle();
  assert.equal(paseo.calls, 3);
});
