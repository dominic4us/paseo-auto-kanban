import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAutoCards, readAutoState } from '../dist/server/auto-cards.js';
import { readLocale } from '../dist/server/handlers.js';
import { createMutationHandler } from '../dist/server/mutations.js';
import { fixture } from './helpers.mjs';

// Gate 434 S1: pause the real engine's write after its read; a real UI mutation commits first.
async function setup(t) {
  const f = await fixture(t);
  let intercept = null;
  const writes = [];
  const store = new Proxy(f.store, { get(target, key) {
    if (key === 'mutateBoard') return async (id, input, ...rest) => {
      writes.push(input);
      if (intercept && input.actor.kind === 'agent') {
        const run = intercept; intercept = null; await run(input);
      }
      return target.mutateBoard(id, input, ...rest);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const auto = createAutoCards({ store, locale: readLocale, log: () => {} });
  const agent = { id: randomUUID(), workspaceId: 'wks_example01', cwd: f.cwd,
    parentAgentId: null, provider: 'codex', title: 'Automatic worker' };
  assert.equal(await auto.signal(agent, 'created'), 'created');
  assert.equal(await auto.signal(agent, 'turn_started'), 'updated');
  const card = (await f.store.readBoard(f.id)).cards[0];
  const mutate = createMutationHandler(f.store);
  const user = async operations => {
    const board = await f.store.readBoard(f.id);
    const reply = await mutate({ boardId: f.id, requestId: randomUUID(), ifRevision: board.revision, operations });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return f.store.readBoard(f.id);
  };
  return { ...f, auto, agent, card, user, writes, intercept: fn => { intercept = fn; } };
}

for (const action of ['done', 'archive', 'edit', 'other-card']) {
  test(`D65 stale automatic move preserves a person's ${action}; a later signal reads again`, async t => {
    const s = await setup(t);
    const before = await readAutoState(s.store.dataDir);
    let manual;
    s.intercept(async () => {
      const operations = action === 'done' ? [{ op: 'move', id: s.card.id, to: 'done' }]
        : action === 'archive' ? [{ op: 'archive', id: s.card.id }]
        : action === 'edit' ? [{ op: 'update', id: s.card.id, patch: { title: 'Chosen by a person' } }]
        : [{ op: 'add', title: 'Another card' }];
      manual = await s.user(operations);
    });
    const outcome = await s.auto.signal(s.agent, 'turn_ended');
    assert.deepEqual(await s.store.readBoard(s.id), manual, 'a stale automatic write must leave the human result intact');
    assert.equal(outcome, 'held');
    assert.deepEqual((await readAutoState(s.store.dataDir)).agents[s.agent.id], before.agents[s.agent.id],
      'the rejected bucket and move must not be remembered as applied');
    assert.equal(await s.auto.signal(s.agent, 'turn_ended'), action === 'done' ? 'paused' : action === 'archive' ? 'archived-card' : 'updated');
    const after = await s.store.readBoard(s.id), card = after.cards.find(c => c.id === s.card.id);
    assert.equal(card.stageId, action === 'done' ? 'done' : action === 'archive' ? 'doing' : 'review');
    if (action === 'edit') assert.equal(card.title, 'Chosen by a person');
    if (action === 'archive') assert.ok(card.archivedAt);
    if (action === 'other-card') assert.ok(after.cards.some(c => c.title === 'Another card'));
  });
}

test('D65 without a competing write: creation, moves and permission changes still apply once', async t => {
  const s = await setup(t);
  const revision = (await s.store.readBoard(s.id)).revision;
  assert.equal(await s.auto.signal(s.agent, 'permission_requested'), 'updated');
  assert.equal(s.writes.at(-1).ifRevision, revision);
  assert.equal(await s.auto.signal(s.agent, 'turn_ended'), 'updated');
  assert.equal(await s.auto.signal(s.agent, 'turn_ended'), 'unchanged');
  const board = await s.store.readBoard(s.id);
  assert.equal(board.cards.length, 1);
  assert.equal(board.cards[0].stageId, 'review');
  assert.equal(board.cards[0].awaiting, null);
  assert.deepEqual(board.history.filter(h => h.cardId === s.card.id).map(h => [h.from, h.to]),
    [[null, 'todo'], ['todo', 'doing'], ['doing', 'review']]);
});

test('D65 non-conflict storage failures still fail and do not advance applied state', async t => {
  const s = await setup(t), before = await readAutoState(s.store.dataDir);
  s.intercept(async () => { throw new Error('Synthetic disk failure'); });
  assert.equal(await s.auto.signal(s.agent, 'turn_ended'), 'failed');
  assert.deepEqual((await readAutoState(s.store.dataDir)).agents[s.agent.id], before.agents[s.agent.id]);
  assert.equal(await s.auto.signal(s.agent, 'turn_ended'), 'updated');
});
