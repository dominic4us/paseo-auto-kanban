import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createAutoCards } from '../dist/server/auto-cards.js';
import { openStore } from '../dist/server/core/index.js';
import { createReadHandlers, createResumeHandler, readLocale } from '../dist/server/handlers.js';
import { cardGet } from '../dist/shared/rpc.js';
import { testTmpdir } from './helpers.mjs';
import { RELEASES, folderBytes, previousData, previousRelease } from './previous-release.mjs';

// D66 G2b (research/470 B5, research/498): an upgrade from 0.2.3 or 0.2.4 is tested on the data folder that release itself
// wrote (tests/fixtures/previous-release/<release>/data), and a way back is tested with that release's own code.
// - The first look at a board from before the decision file is the migration: each card's decision is made once, from the
//   evidence the old files hold, and written down in a migration report beside the decisions.
// - 0.2.3 and 0.2.4 read whatever this version wrote, unchanged and without refusing it.
// - The supported way back and forth (the automatic cards switched off in the older release, people moving cards there)
//   keeps every completion and every resume this version committed; a card the older release changed is held, visibly.
// - The older release with its engine on is outside that promise: the test only holds that what it changed is held.

async function upgraded(t, release) {
  const root = await mkdtemp(join(await testTmpdir(), 'kanban-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const expected = await previousData(release, dataDir);
  await fs.mkdir(expected.cwd, { recursive: true });
  const store = await openStore({ dataDir });
  const auto = createAutoCards({ store, locale: readLocale, log: () => {} });
  const agents = Object.keys(expected.agents).map(id => ({ id, workspaceId: 'wks_example01', cwd: expected.cwd, parentAgentId: null, title: 'Upgraded worker' }));
  const agentOf = cardId => agents.find(a => expected.agents[a.id] === cardId);
  const caseOf = name => expected.cases.find(c => c.name === name).cardId;
  const card = async id => (await store.readBoard(expected.boardId)).cards.find(c => c.id === id);
  const person = (store, operations) => store.mutateBoard(expected.boardId, { actor: { kind: 'user' }, requestId: randomUUID(), operations });
  const detail = async cardId => {
    const reply = await createReadHandlers(store).card({ boardId: expected.boardId, cardId });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return cardGet.output.parse(reply).data;
  };
  const resume = async cardId => {
    const shown = await detail(cardId);
    assert.ok(shown.trackingToken, 'the detail offers a resume');
    const answer = await createResumeHandler(auto)({ boardId: expected.boardId, cardId, ...shown.trackingToken, decisionId: randomUUID() });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    return answer;
  };
  const reports = async () => (await fs.readdir(join(dataDir, 'auto-control')).catch(() => []))
    .filter(name => name.startsWith(expected.boardId + '.rebase-')).sort();
  const report = async () => JSON.parse(await fs.readFile(join(dataDir, 'auto-control', (await reports()).at(-1)), 'utf8'));
  return { root, dataDir, expected, store, auto, agents, agentOf, caseOf, card, person, detail, resume, reports, report };
}
const signalAll = async (auto, agents) => { for (const kind of ['turn_started', 'permission_requested', 'permission_resolved', 'turn_ended'])
  for (const a of agents) await auto.signal(a, kind); };

for (const release of RELEASES) {
  test(`D66 G2b ${release} migration: each card of the data ${release} wrote gets the decision its evidence proves, written down once`, async t => {
    const u = await upgraded(t, release);
    const before = await folderBytes(u.dataDir);
    const view = await u.store.readAutoControl(u.expected.boardId);
    for (const c of u.expected.cases) assert.equal(view.cards[c.cardId]?.mode, c.mode, `${release} ${c.name}: ${c.why}`);
    assert.equal(view.settled, false, 'nothing is written by a look without the lock');
    assert.deepEqual(await folderBytes(u.dataDir), before, 'reading writes nothing');
    // The first look under the lock is the migration: saved with its report, never again.
    assert.equal((await u.store.settleAutoControl(u.expected.boardId)).data.saved, true);
    assert.equal((await u.reports()).length, 1, 'one migration report');
    const report = await u.report();
    assert.equal(report.kind, 'migrated');
    assert.equal(report.boardId, u.expected.boardId);
    const counts = { managed: 0, paused: 0, unknown: 0, unowned: 0 };
    for (const c of u.expected.cases) counts[c.mode]++;
    assert.deepEqual(report.counts, counts, 'the report counts the cards by decision');
    assert.equal(report.cards.length, u.expected.cases.length);
    for (const c of u.expected.cases) assert.equal(report.cards.find(r => r.cardId === c.cardId).mode, c.mode, c.name);
    const saved = JSON.parse(await fs.readFile(join(u.dataDir, 'auto-control', u.expected.boardId + '.json'), 'utf8'));
    assert.equal(saved.controlEpoch, report.controlEpoch);
    for (const c of u.expected.cases) assert.equal(saved.cards[c.cardId]?.mode ?? 'unowned', c.mode, c.name);
    // The old files are kept as they were: only the decisions and the report are new.
    const after = await folderBytes(u.dataDir);
    for (const [file, hash] of Object.entries(before)) assert.equal(after[file], hash, file + ' is kept');
    assert.deepEqual(Object.keys(after).filter(f => !before[f]).map(f => f.split('/')[0]), ['auto-control', 'auto-control']);
    assert.equal((await u.store.settleAutoControl(u.expected.boardId)).data.saved, false, 'settled: nothing more to write');
    assert.equal((await u.reports()).length, 1);
  });

  test(`D66 G2b ${release} after the migration the adopted cards follow their agents, the rest stays where people put it`, async t => {
    const u = await upgraded(t, release);
    const stages = Object.fromEntries(await Promise.all(u.expected.cases.map(async c => [c.cardId, (await u.card(c.cardId)).stageId])));
    await signalAll(u.auto, u.agents);
    for (const c of u.expected.cases) {
      const now = (await u.card(c.cardId)).stageId;
      if (c.mode === 'managed') assert.equal(now, 'review', `${release} ${c.name}: adopted, it follows its agent`);
      else assert.equal(now, stages[c.cardId], `${release} ${c.name}: held, it stays`);
    }
    // A card that needs a check says so on its detail and is resumed alone (owner decision 2026-10-18: card by card).
    const check = u.caseOf('linked, nothing remembered');
    assert.equal((await u.detail(check)).tracking.held, 'check');
    await u.resume(check);
    await u.auto.signal({ id: (await u.card(check)).agents[0].agentId, workspaceId: 'wks_example01', cwd: u.expected.cwd, parentAgentId: null, title: 'Linked worker' }, 'turn_started');
    assert.equal((await u.card(check)).stageId, 'doing', 'resumed, it follows its agent');
    assert.equal((await u.detail(u.caseOf('its own agent moved it with the CLI'))).tracking.held, 'check', 'and the others still need theirs');
  });

  test(`D66 G2b ${release} reads everything this version wrote, unchanged and without refusing it`, async t => {
    const u = await upgraded(t, release), old = await previousRelease(release);
    // This version's own work on the upgraded board: the engine, a person, a resume, a new engine card.
    await signalAll(u.auto, u.agents);
    await u.person(u.store, [{ op: 'move', id: u.caseOf('engine moved it last (doing)'), to: 'done' }]);
    await u.resume(u.caseOf('a person moved it and the engine paused'));
    const fresh = { id: randomUUID(), workspaceId: 'wks_example01', cwd: u.expected.cwd, parentAgentId: null, title: 'New worker' };
    assert.equal(await u.auto.signal(fresh, 'created'), 'created');
    await u.auto.signal(fresh, 'turn_started');
    const board = await u.store.readBoard(u.expected.boardId);
    const before = await folderBytes(u.dataDir);
    old.validateBoard(board);
    const legacy = await old.openStore({ dataDir: u.dataDir });
    assert.deepEqual(await legacy.readBoard(u.expected.boardId), board, `${release} reads the board as this version wrote it`);
    const boards = await legacy.listBoards();
    assert.equal(boards.length, 1);
    assert.equal(boards[0].cards.length, board.cards.length);
    const state = await old.readAutoState(u.dataDir);
    assert.equal(state.damaged ?? false, false, `${release} reads the engine's memory`);
    assert.ok(state.agents[fresh.id], 'with this version\'s entries');
    // Its read handlers' path: the card detail of that release reads the memory beside the board.
    old.cardTracking(board, board.cards[0], state);
    assert.deepEqual(await folderBytes(u.dataDir), before, 'reading in the older release writes nothing');
  });

  test(`D66 G2b ${release} the supported way back: automatic cards off there, people move cards, back here — completions and resumes stand`, async t => {
    const u = await upgraded(t, release), old = await previousRelease(release);
    const X = u.caseOf('engine moved it last (doing)'), Y = u.caseOf('a person completed it'), Z = u.caseOf('a person moved it and the engine paused');
    const W = u.caseOf('engine moved it last (review)'), V = u.caseOf('a person\'s card completed, never linked');
    const U = u.caseOf('resumed in that release and moved by the engine since');
    await u.store.settleAutoControl(u.expected.boardId);
    await u.resume(Z); // a resume this version committed
    assert.equal((await u.store.readAutoControl(u.expected.boardId)).cards[Z].mode, 'managed');
    // In the older release: every writer stopped, the automatic cards switched off and checked, then people move cards.
    const legacy = await old.openStore({ dataDir: u.dataDir });
    const oldAuto = old.createAutoCards({ store: legacy, locale: () => 'en', log: () => {} });
    await oldAuto.setEnabled('host-a', false);
    assert.equal(await oldAuto.signal(u.agentOf(X), 'turn_ended'), 'disabled', `${release} with its automatic cards off moves nothing`);
    await u.person(legacy, [{ op: 'move', id: W, to: 'done' }]);
    await u.person(legacy, [{ op: 'move', id: V, to: 'doing' }]); await u.person(legacy, [{ op: 'move', id: V, to: 'done' }]);
    await u.person(legacy, [{ op: 'move', id: U, to: 'todo' }]); await u.person(legacy, [{ op: 'move', id: U, to: 'doing' }]);
    const moved = (await legacy.readBoard(u.expected.boardId)).cards.map(c => [c.id, c.stageId]);
    // Back here: checked, then switched on again.
    await u.auto.setEnabled('host-a', true);
    for (let round = 0; round < 2; round++) {
      await signalAll(u.auto, u.agents);
      const fresh = createAutoCards({ store: await openStore({ dataDir: u.dataDir }), locale: readLocale, log: () => {} });
      for (const a of u.agents) await fresh.signal(a, 'turn_ended');
    }
    const stage = async id => (await u.card(id)).stageId;
    assert.equal(await stage(Y), 'done', 'a completion from before the way back stands');
    assert.equal(await stage(W), 'done', 'a completion made in the older release stands');
    assert.equal(await stage(V), 'done', 'a completion moved away and back there stands');
    assert.equal(await stage(U), 'doing', 'a card a person moved away and back there stays');
    for (const id of [W, U]) assert.equal((await u.detail(id)).tracking.held, 'check', 'a tracked card the older release moved is held, and says so');
    assert.notEqual((await u.store.readAutoControl(u.expected.boardId)).cards[V].mode, 'managed');
    // What this version committed before the trip still holds: the resumed card and the adopted one follow their agents.
    assert.equal((await u.store.readAutoControl(u.expected.boardId)).cards[Z].mode, 'managed', 'the resume stands');
    assert.equal(await stage(Z), 'review', 'and the resumed card moves');
    assert.equal(await stage(X), 'review', 'the adopted card moves');
    for (const [id, was] of moved) if (![X, Z].includes(id) && was !== 'review') assert.equal(await stage(id), was, 'nothing else moved: ' + id);
  });

  // Gate 499 F1: a card already paused by a person's decision and moved there and back by the older release (automatic
  // cards off) stays paused here — the plain "Paused" line, not "needs a check" — and nothing moves it.
  test(`D66 G2b ${release} the way back: a paused card the older release moved doing → done stays Paused here, no check, and done`, async t => {
    const u = await upgraded(t, release), old = await previousRelease(release);
    const Y = u.caseOf('a person completed it');
    await u.store.settleAutoControl(u.expected.boardId);
    assert.equal((await u.store.readAutoControl(u.expected.boardId)).cards[Y].mode, 'paused');
    const legacy = await old.openStore({ dataDir: u.dataDir });
    const oldAuto = old.createAutoCards({ store: legacy, locale: () => 'en', log: () => {} });
    await oldAuto.setEnabled('host-a', false);
    await u.person(legacy, [{ op: 'move', id: Y, to: 'doing' }]); await u.person(legacy, [{ op: 'move', id: Y, to: 'done' }]);
    await u.auto.setEnabled('host-a', true);
    const shown = await u.detail(Y);
    assert.equal(shown.tracking.state, 'paused', 'its detail shows it paused');
    assert.equal(shown.tracking.held, undefined, 'as a person\'s pause, not "needs a check"');
    assert.equal((await u.store.readAutoControl(u.expected.boardId)).cards[Y].mode, 'paused');
    await signalAll(u.auto, u.agents);
    const fresh = createAutoCards({ store: await openStore({ dataDir: u.dataDir }), locale: readLocale, log: () => {} });
    for (const a of u.agents) await fresh.signal(a, 'turn_ended');
    assert.equal((await u.card(Y)).stageId, 'done', 'and the completion stands');
  });

  test(`D66 G2b ${release} outside the promise: with its engine on, whatever the older release changed is held here, visibly`, async t => {
    const u = await upgraded(t, release), old = await previousRelease(release);
    await u.store.settleAutoControl(u.expected.boardId);
    await u.person(u.store, [{ op: 'move', id: u.caseOf('engine moved it last (doing)'), to: 'done' }]);
    const before = (await u.store.readBoard(u.expected.boardId)).cards.map(c => [c.id, c.stageId]);
    const legacy = await old.openStore({ dataDir: u.dataDir });
    const oldAuto = old.createAutoCards({ store: legacy, locale: () => 'en', log: () => {} });
    await signalAll(oldAuto, u.agents);
    const changed = (await legacy.readBoard(u.expected.boardId)).cards.filter(c => before.find(([id]) => id === c.id)[1] !== c.stageId);
    assert.ok(changed.length > 0, `${release}'s engine moved some cards`);
    const view = await u.store.readAutoControl(u.expected.boardId);
    for (const c of changed) {
      assert.notEqual(view.cards[c.id].mode, 'managed', 'a card the older engine moved is not tracked on here');
      if (c.agents.length) assert.equal((await u.detail(c.id)).tracking.state, 'paused', 'and its detail shows it held');
    }
    const after = Object.fromEntries((await legacy.readBoard(u.expected.boardId)).cards.map(c => [c.id, c.stageId]));
    await signalAll(u.auto, u.agents);
    for (const c of changed) assert.equal((await u.card(c.id)).stageId, after[c.id], 'this engine leaves it where it is');
  });
}

test('D66 G2b a decision file lost or set aside after the migration starts again strictly: nothing is adopted twice', async t => {
  for (const how of ['lost', 'restored']) {
    const u = await upgraded(t, '0.2.4');
    await u.store.settleAutoControl(u.expected.boardId);
    const file = join(u.dataDir, 'auto-control', u.expected.boardId + '.json');
    if (how === 'lost') await fs.rm(file);
    else await fs.rename(file, file + '.restored-2026-10-19');
    const view = await u.store.readAutoControl(u.expected.boardId);
    // Strict: a completion stays protected, every other card needs a check — no memory is trusted twice.
    for (const c of u.expected.cases)
      assert.equal(view.cards[c.cardId].mode, c.why.includes('completion') ? 'paused' : 'unknown', `${how} ${c.name}`);
    await u.store.settleAutoControl(u.expected.boardId);
    assert.equal((await u.reports()).length, 2, how + ': a second report');
    assert.equal((await u.report()).kind, how);
  }
});
