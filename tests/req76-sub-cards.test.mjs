// REQ-76: the server remembers each sub-agent's first parent (auto-cards.json) and says which card belongs under which
// (parentCardId). REQ-93 (research/141 C) replaced how the screens show it: every card stays in its own stage's column,
// marked with its parent or its sub-cards' counts (client/card-groups.ts). The screens themselves are exercised in
// plugin-ui.test.mjs ("REQ-93") and tests/web/run.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutoCards, readAutoState } from '../dist/server/auto-cards.js';
import { cardParents, topAgent } from '../dist/server/card-parents.js';
import { createReadHandlers, readLocale } from '../dist/server/handlers.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { boardGet, overviewGet, revisionsGet } from '../dist/shared/rpc.js';
import { knownRevisions, revisionsChanged } from '../dist/client/refresh-model.js';
import { applyOperations } from '../dist/shared/core/domain.js';
import { linkStages, parentMark, inFamily } from '../dist/client/card-groups.js';
import { laneModel, swimlaneModel } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { applyPendingMoves } from '../dist/client/move-model.js';
import { fixture, request, add, board, context, actor } from './helpers.mjs';

const WORKSPACE = 'wks_example01';
const agentOf = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, parentAgentId: null, provider: 'claude',
  cwd: '/nowhere', title: 'Example agent', ...overrides });
const lister = entries => ({ calls: [], agents: { async list(options) { this.calls?.push(options); return { entries: entries.map(agent => ({ agent })), pageInfo: { nextCursor: null } }; } } });
const listed = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, cwd: '/nowhere', title: 'Listed agent', status: 'idle',
  createdAt: '2026-09-01T00:00:00.000Z', lastUserMessageAt: '2026-09-01T00:00:00.000Z', labels: {}, ...overrides });
const T = minute => `2026-09-25T00:${String(minute).padStart(2, '0')}:00.000Z`;
async function setup(t, now = () => T(0)) {
  const f = await fixture(t);
  const auto = createAutoCards({ store: f.store, locale: readLocale, now, log: () => {} });
  return { ...f, auto };
}

test('REQ-76 ①⑤ a sub-agent gets no card, but its first parent is remembered: from the hook, and from the listing\'s label', async t => {
  const s = await setup(t);
  const top = agentOf(), child = agentOf({ parentAgentId: top.id });
  assert.equal(await s.auto.signal(top, 'created'), 'created');
  for (const name of ['created', 'turn_started', 'turn_ended']) assert.equal(await s.auto.signal(child, name), 'child');
  let state = await readAutoState(s.store.dataDir);
  assert.deepEqual(state.parents[child.id], { parentAgentId: top.id, at: T(0) });
  assert.equal(state.agents[child.id], undefined, 'no card is remembered for it');
  assert.equal((await s.store.readBoard(s.id)).cards.length, 1, 'only the top-level agent\'s card');
  // The first parent stays: a later, different parent does not replace it.
  await s.auto.signal({ ...child, parentAgentId: randomUUID() }, 'turn_started');
  assert.equal((await readAutoState(s.store.dataDir)).parents[child.id].parentAgentId, top.id);
  // ⑤ Detached (Paseo dropped the label): still a sub-agent — no card of its own, no move of any card.
  const card = (await s.store.mutateBoard(s.id, request([add('Delegated work')]))).data.cardIds[0];
  await s.store.mutateBoard(s.id, request([{ op: 'link', id: card, agentId: child.id }]));
  const before = (await s.store.readBoard(s.id)).revision;
  for (const name of ['created', 'turn_started', 'turn_ended', 'archived']) assert.equal(await s.auto.signal({ ...child, parentAgentId: null }, name), 'child');
  assert.equal((await s.store.readBoard(s.id)).revision, before, 'the delegated card was neither made nor moved');
  // ① The listing after a restart: the SDK entry has no parentAgentId, the label says it; older sub-agents too.
  const restarted = createAutoCards({ store: s.store, locale: readLocale, now: () => T(5), log: () => {} });
  const worker = listed({ labels: { 'paseo.parent-agent-id': top.id } });
  const grand = listed({ labels: { 'paseo.parent-agent-id': worker.id } });
  const detached = listed({ id: child.id, labels: {} });
  await restarted.signal(agentOf(), 'turn_started', lister([worker, grand, detached, listed({ id: top.id })]));
  await restarted.idle();
  state = await readAutoState(s.store.dataDir);
  assert.equal(state.parents[worker.id].parentAgentId, top.id);
  assert.equal(state.parents[grand.id].parentAgentId, worker.id, 'the direct parent is kept; the top is found by following');
  assert.equal(state.parents[child.id].at, T(0), 'the one seen first is untouched');
  assert.equal(topAgent(state.parents, grand.id), top.id, '② one level: the sub-agent\'s sub-agent belongs to the top-level agent');
  assert.equal(topAgent(state.parents, top.id), null);
  assert.equal((await s.store.readBoard(s.id)).cards.filter(c => c.agents.some(a => a.agentId === child.id)).length, 1,
    'the detached sub-agent listed without a label got no automatic card');
});

test('REQ-76 ⑤ auto-cards.json: an older file (no parents) still reads; parents are kept, checked and bounded', async t => {
  const s = await setup(t);
  const file = join(s.store.dataDir, 'auto-cards.json');
  await fs.mkdir(s.store.dataDir, { recursive: true });
  const old = { schemaVersion: 1, activatedAt: T(0), hosts: {}, agents: { [randomUUID()]: { boardId: s.id, cardId: 'card_' + randomUUID(),
    bucket: 'working', awaiting: false, title: null, at: T(1) } } };
  await fs.writeFile(file, JSON.stringify(old));
  const read = await readAutoState(s.store.dataDir);
  assert.deepEqual(read.parents, {}, 'a file from before REQ-76 has none');
  assert.equal(Object.keys(read.agents).length, 1);
  const good = randomUUID(), parent = randomUUID();
  await fs.writeFile(file, JSON.stringify({ ...old, parents: { [good]: { parentAgentId: parent, at: T(2) },
    self: { parentAgentId: 'self', at: T(2) }, broken: { parentAgentId: '', at: T(2) }, late: { parentAgentId: parent, at: 'soon' } } }));
  assert.deepEqual((await readAutoState(s.store.dataDir)).parents, { [good]: { parentAgentId: parent, at: T(2) } });
  // A write keeps the agents entries and the parents; the schema version is unchanged.
  const child = agentOf({ parentAgentId: randomUUID() });
  await s.auto.signal(child, 'created');
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(written.schemaVersion, 1);
  assert.equal(Object.keys(written.agents).length, 1);
  assert.deepEqual(Object.keys(written.parents).sort(), [good, child.id].sort());
  // Bounded like the agents: the 1000 seen most recently.
  const many = Object.fromEntries(Array.from({ length: 1003 }, (_, i) => [`agent-${String(i).padStart(4, '0')}`,
    { parentAgentId: parent, at: new Date(Date.parse(T(0)) + i * 1000).toISOString() }]));
  await fs.writeFile(file, JSON.stringify({ ...old, parents: many }));
  assert.equal(Object.keys((await readAutoState(s.store.dataDir)).parents).length, 1000);
  await s.auto.signal(agentOf({ parentAgentId: parent }), 'created');
  const bounded = JSON.parse(await fs.readFile(file, 'utf8')).parents;
  assert.equal(Object.keys(bounded).length, 1000);
});

// ---- which card sits under which ----
// Agent ids are UUIDs in the ledger; the last digit tells them apart.
const id = n => '00000000-0000-4000-8000-00000000000' + n;
const TOP = id(1), OTHER_TOP = id(2), W1 = id(3), W2 = id(4), W3 = id(5), STRAY = id(6), ELSEWHERE = id(7);
function sample() {
  let value = board(), minute = 1;
  const make = (title, stageId, agents = []) => {
    value = applyOperations(value, [{ ...add(title), stageId }], actor, context(T(minute++))).board;
    const id = value.cards.at(-1).id;
    for (const agentId of agents) value = applyOperations(value, [{ op: 'link', id, agentId }], actor, context(T(minute++))).board;
    return id;
  };
  const ids = {
    lead: make('Lead card', 'review', [TOP]),
    w1: make('Worker one', 'doing', [W1]),
    w2: make('Worker two', 'todo', [W2]),
    w3done: make('Worker three', 'done', [W3]),
    // ⑥ the first linked agent decides: a top-level agent linked second changes nothing.
    mixed: make('Mixed card', 'doing', [W1, OTHER_TOP]),
    ownFirst: make('Other lead', 'todo', [OTHER_TOP, W1]),
    stray: make('Stray worker', 'doing', [STRAY]),
    loose: make('Loose card', 'todo'),
  };
  const state = { agents: {}, parents: { [W1]: { parentAgentId: TOP, at: T(0) }, [W2]: { parentAgentId: W1, at: T(0) },
    [W3]: { parentAgentId: TOP, at: T(0) }, [STRAY]: { parentAgentId: ELSEWHERE, at: T(0) } } };
  return { board: value, ids, state };
}

test('REQ-76 ②⑥⑦⑨ the card of the first agent\'s top-level agent, on the same board only', () => {
  const { board: value, ids, state } = sample();
  const parents = cardParents(value, state);
  assert.equal(parents.get(ids.w1), ids.lead);
  assert.equal(parents.get(ids.w2), ids.lead, '② a sub-agent\'s sub-agent sits flat under the top-level card');
  assert.equal(parents.get(ids.w3done), ids.lead);
  assert.equal(parents.get(ids.mixed), ids.lead, '⑥ the first linked agent (a worker) decides');
  assert.equal(parents.has(ids.ownFirst), false, '⑥ a top-level agent linked first keeps the card on its own');
  assert.equal(parents.has(ids.stray), false, '⑨ no card of its top-level agent here: it stays where it is');
  assert.equal(parents.has(ids.loose), false);
  assert.equal(parents.has(ids.lead), false);
  // The automatic card the plugin remembered for the top-level agent wins over an older card it was linked to.
  let two = applyOperations(value, [{ ...add('Older lead'), stageId: 'todo' }], actor, context(T(40))).board;
  const older = two.cards.at(-1).id;
  two = applyOperations(two, [{ op: 'link', id: older, agentId: TOP }], actor, context(T(41))).board;
  assert.equal(cardParents(two, state).get(ids.w1), ids.lead, 'without a remembered card: the oldest card it leads');
  assert.equal(cardParents(two, { ...state, agents: { [TOP]: { boardId: two.id, cardId: older } } }).get(ids.w1), older);
  // ⑦ another board: the top-level agent's card is not here, so nothing is grouped.
  const elsewhere = { ...value, id: 'board_' + 'b'.repeat(64), cards: value.cards.filter(c => c.id !== ids.lead) };
  assert.equal(cardParents(elsewhere, { ...state, agents: { [TOP]: { boardId: value.id, cardId: ids.lead } } }).size, 0);
  // An archived parent card is no parent.
  const archived = applyOperations(value, [{ op: 'archive', id: ids.lead }], actor, context(T(50))).board;
  assert.equal(cardParents(archived, state).size, 0);
  // No remembered parents: nothing to read.
  assert.equal(cardParents(value, { agents: {}, parents: {} }).size, 0);
  // A loop in the remembered parents never hangs.
  assert.equal(topAgent({ a: { parentAgentId: 'b' }, b: { parentAgentId: 'a' } }, 'a'), 'b');
});

test('REQ-76 ⑤ the board and overview reads carry parentCardId; an older reply without it still parses', async t => {
  const s = await setup(t);
  const top = agentOf(), child = agentOf({ parentAgentId: top.id });
  await s.auto.signal(top, 'created');
  await s.auto.signal(child, 'created');
  const made = (await s.store.mutateBoard(s.id, request([add('Delegated work')]))).data.cardIds[0];
  await s.store.mutateBoard(s.id, request([{ op: 'link', id: made, agentId: child.id }]));
  const lead = (await s.store.readBoard(s.id)).cards.find(c => c.agents[0]?.agentId === top.id).id;
  const read = createReadHandlers(s.store);
  const cards = dto => dto.stages.flatMap(stage => stage.cards);
  const boardReply = boardGet.output.parse(await read.board({ boardId: s.id }));
  assert.equal(cards(boardReply.data.board).find(c => c.id === made).parentCardId, lead);
  assert.equal(cards(boardReply.data.board).find(c => c.id === lead).parentCardId, undefined);
  const overview = overviewGet.output.parse(await read.overview({ includeBoards: true }));
  assert.equal(cards(overview.data.boardViews[0]).find(c => c.id === made).parentCardId, lead);
  // ⑤ the label goes away (detach): the grouping stays, because the first parent is remembered.
  await s.auto.signal({ ...child, parentAgentId: null }, 'turn_started');
  assert.equal(cards(boardGet.output.parse(await read.board({ boardId: s.id })).data.board).find(c => c.id === made).parentCardId, lead);
  // A damaged plugin file reads as "no groups", never as a failed read.
  await fs.writeFile(join(s.store.dataDir, 'auto-cards.json'), '{ broken');
  const plain = boardGet.output.parse(await read.board({ boardId: s.id }));
  assert.equal(plain.ok, true);
  assert.equal(cards(plain.data.board).find(c => c.id === made).parentCardId, undefined);
  // The ledger itself never learns about the grouping.
  assert.equal((await s.store.readBoard(s.id)).cards.every(c => !('parentCardId' in c)), true);
});

test('REQ-76 F1 a parent remembered after a read changes the board\'s groups, not its revision, and the poll sees it', async t => {
  const s = await setup(t);
  const top = agentOf(), child = agentOf({ parentAgentId: top.id });
  await s.auto.signal(top, 'created');
  const made = (await s.store.mutateBoard(s.id, request([add('Delegated work')]))).data.cardIds[0];
  await s.store.mutateBoard(s.id, request([{ op: 'link', id: made, agentId: child.id }]));
  const read = createReadHandlers(s.store);
  const poll = async (groups = true) => revisionsGet.output.parse(await read.revisions({ ...(groups ? { groups: true } : {}) })).data;
  // The first read: the sub-agent's parent is not remembered yet (the file came from before this version).
  const first = boardGet.output.parse(await read.board({ boardId: s.id })).data;
  const shown = overviewGet.output.parse(await read.overview({ includeBoards: true })).data;
  assert.equal(first.board.summary.groups, undefined, 'no card sits under another yet');
  const known = knownRevisions([{ ...first.board.summary, revision: first.revision }]), knownAll = knownRevisions(shown.boardViews.map(b => b.summary));
  assert.equal(revisionsChanged(known, await poll(), 'listed'), false, 'nothing changed');
  // The listing (or a hook) remembers the parent: the plugin's file changes, the ledger does not.
  await s.auto.signal(child, 'created');
  assert.equal((await s.store.readBoard(s.id)).revision, first.revision, 'the same ledger revision');
  const after = await poll();
  assert.match(after.boards[0].groups ?? '', /^[0-9a-f]{16}$/);
  assert.equal(revisionsChanged(known, after, 'listed'), true, 'the board screen reads again');
  assert.equal(revisionsChanged(knownAll, after, 'all'), true, 'and so does the swimlane');
  // The re-read carries the same fingerprint, so the next look rests.
  const again = boardGet.output.parse(await read.board({ boardId: s.id })).data;
  assert.equal(again.board.summary.groups, after.boards[0].groups);
  assert.equal(revisionsChanged(knownRevisions([{ ...again.board.summary, revision: again.revision }]), await poll(), 'listed'), false);
  const view = overviewGet.output.parse(await read.overview({ includeBoards: true })).data.boardViews[0].summary;
  assert.equal(revisionsChanged(knownRevisions([view]), await poll(), 'all'), false);
  // A screen that does not draw groups (the list) is not asked to: its poll has no groups and never loops.
  assert.equal((await poll(false)).boards[0].groups, undefined);
  const list = overviewGet.output.parse(await read.overview({})).data.boards;
  assert.equal(revisionsChanged(knownRevisions(list), await poll(false), 'all'), false);
  // An older reply without groups still parses, and a damaged file reads as no groups.
  await fs.writeFile(join(s.store.dataDir, 'auto-cards.json'), '{ broken');
  assert.equal((await poll()).boards[0].groups, undefined);
});

// ---- how the screens gather them ----
function sampleDTO() {
  const { board: value, ids, state } = sample();
  return { dto: toBoardDTO(value, 'en', 'off', Date.now(), cardParents(value, state)), ids };
}
const titles = cards => cards.map(c => c.title);

// REQ-93 replaced the gathering (REQ-76 ③④⑧⑩⑪): every card stays in its own stage's column; a sub-card carries its
// parent, a parent how many sub-cards it has. Which card belongs under which (above) is unchanged.
const byStage = (stages, id) => stages.find(s => s.stageId === id);
const titled = (stages, title) => stages.flatMap(s => s.cards).find(c => c.title === title);

test('REQ-93 (was REQ-76 ③④) every sub-card stays in its own column, marked with its parent; the parent carries its counts', () => {
  const { dto, ids } = sampleDTO();
  const linked = linkStages(dto.stages);
  assert.deepEqual(linked.map(s => s.cards.length), dto.stages.map(s => s.cards.length), 'no card leaves its column');
  assert.deepEqual(linked.map(s => s.totalCount), [3, 3, 1, 1], 'the columns count every card');
  assert.deepEqual(titles(byStage(linked, 'review').cards), ['Lead card']);
  assert.deepEqual(titled(linked, 'Lead card').family, { total: 4, open: 3 }, 'four sub-cards, three not done');
  for (const title of ['Worker one', 'Worker two', 'Mixed card', 'Worker three'])
    assert.deepEqual(titled(linked, title).parent, { id: ids.lead, title: 'Lead card' }, title + ' names its parent');
  assert.equal(byStage(linked, 'done').cards[0].title, 'Worker three', 'the done sub-card is in done');
  for (const title of ['Stray worker', 'Loose card', 'Other lead']) {
    assert.equal(titled(linked, title).parent, undefined, title);
    assert.equal(titled(linked, title).family, undefined, title);
  }
  assert.equal(titled(linked, 'Lead card').parent, undefined, 'a parent has no mark of its own');
  // Without parentCardId (an older server) there is nothing to mark.
  const flat = linkStages(dto.stages.map(s => ({ ...s, cards: s.cards.map(({ parentCardId, ...c }) => c) })));
  assert.ok(flat.flatMap(s => s.cards).every(c => !c.parent && !c.family));
  // A parent that is not among the cards read (another board, or hidden by age): no mark.
  const orphan = linkStages(dto.stages.map(s => ({ ...s, cards: s.cards.filter(c => c.id !== ids.lead) })));
  assert.ok(orphan.flatMap(s => s.cards).every(c => !c.parent && !c.family));
  assert.equal(parentMark('Lead-02_sample-app_Opus'), 'Lead-02', 'the mark is the part before the first "_"');
  assert.equal(parentMark('A very long parent card title'), 'A very long p…', 'cut at 14 characters');
  assert.equal(inFamily(titled(linked, 'Worker two'), ids.lead), true);
  assert.equal(inFamily(titled(linked, 'Lead card'), ids.lead), true);
  assert.equal(inFamily(titled(linked, 'Stray worker'), ids.lead), false);
});

test('REQ-93 (was REQ-76 ⑧) moving the parent never moves a sub-card; a sub-card moved on its own is drawn in its new column', () => {
  const { dto, ids } = sampleDTO();
  const moved = linkStages(applyPendingMoves([dto], [{ boardId: dto.summary.id, cardId: ids.lead, to: 'done', base: dto.summary.revision }])[0].stages);
  assert.deepEqual(titles(byStage(moved, 'done').cards).sort(), ['Lead card', 'Worker three']);
  assert.deepEqual(['Worker one', 'Worker two', 'Mixed card'].map(t => titled(moved, t).stageId), ['doing', 'todo', 'doing'], 'their stages are their own');
  const child = linkStages(applyPendingMoves([dto], [{ boardId: dto.summary.id, cardId: ids.w1, to: 'done', base: dto.summary.revision }])[0].stages);
  assert.ok(titles(byStage(child, 'done').cards).includes('Worker one'), 'drawn in done');
  assert.equal(titled(child, 'Worker one').parent.id, ids.lead, 'still marked with its parent');
  assert.deepEqual(titled(child, 'Lead card').family, { total: 4, open: 2 }, 'and the parent counts one fewer not done');
});

test('REQ-93 (was REQ-76 ⑩) a sub-card counts as any card for the preview, "+N", the counts, the search and the attention filter', () => {
  let value = board(), minute = 1;
  const make = (title, stageId, agentId) => {
    value = applyOperations(value, [{ ...add(title), stageId }], actor, context(T(minute++))).board;
    if (agentId) value = applyOperations(value, [{ op: 'link', id: value.cards.at(-1).id, agentId }], actor, context(T(minute++))).board;
    return value.cards.at(-1).id;
  };
  make('Lead card', 'doing', TOP);
  for (let i = 0; i < 5; i++) make('Helper ' + i, 'doing', W1);
  make('Needs you', 'todo', W2);
  make('Plain one', 'doing'); make('Plain two', 'doing'); make('Plain three', 'doing');
  value = applyOperations(value, [{ op: 'update', id: value.cards.find(c => c.title === 'Needs you').id, patch: { awaiting: 'user' } }], actor, context(T(59))).board;
  const state = { agents: {}, parents: { [W1]: { parentAgentId: TOP, at: T(0) }, [W2]: { parentAgentId: TOP, at: T(0) } } };
  const dto = toBoardDTO(value, 'en', 'off', Date.now(), cardParents(value, state));
  const doing = (lane) => lane.cells.find(c => c.stageId === 'doing');
  const lane = laneModel(dto);
  assert.deepEqual(titles(doing(lane).cards), ['Lead card', 'Helper 0', 'Helper 1'], 'the preview is the column\'s first three');
  assert.equal(doing(lane).remaining, 6, '+6: every card left out, sub-cards too');
  assert.equal(doing(lane).matchingCount, 9);
  assert.equal(lane.cells.reduce((n, c) => n + c.matchingCount, 0), lane.total, 'the columns add up to the workspace');
  assert.equal(lane.attention, 1);
  assert.deepEqual(titles(lane.cells.find(c => c.stageId === 'todo').cards), ['Needs you'], 'the waiting sub-card waits in its own column');
  const searched = doing(laneModel(dto, {}, false, 'helper 3'));
  assert.deepEqual(titles(searched.cards), ['Helper 3'], 'a search finds the sub-card where it is');
  assert.equal(searched.cards[0].parent.title, 'Lead card');
  assert.deepEqual(titles(doing(laneModel(dto, {}, false, 'lead')).cards), ['Lead card']);
  assert.deepEqual(titles(laneModel(dto, {}, true).cells.find(c => c.stageId === 'todo').cards), ['Needs you']);
  assert.equal(doing(laneModel(dto, {}, true)).matchingCount, 0);
  // REQ-92: the done column opens five at a time like the others, sub-cards among them.
  for (let i = 0; i < 11; i++) make('Done ' + i, 'done');
  make('Done lead', 'done', OTHER_TOP);
  for (let i = 0; i < 3; i++) make('Done helper ' + i, 'done', W3);
  const doneState = { agents: {}, parents: { ...state.parents, [W3]: { parentAgentId: OTHER_TOP, at: T(0) } } };
  const withDone = toBoardDTO(value, 'en', 'off', Date.now(), cardParents(value, doneState));
  const done = step => laneModel(withDone, { steps: { done: step } }).cells.find(c => c.stageId === 'done');
  assert.deepEqual([0, 1, 2, 3].map(step => [done(step).cards.length, done(step).remaining]), [[3, 12], [8, 7], [13, 2], [15, 0]]);
  assert.equal(done(1).openBoard, true, 'an opened done column still offers the board while it leaves cards out');
  assert.equal(done(3).open, true, 'every card shown: "Collapse"');
});

test('REQ-93 (was REQ-76 ⑪) the swimlane and the 390px models place them the same way; the tabs add up to the lane', () => {
  const { dto, ids } = sampleDTO();
  const directory = { [WORKSPACE]: { id: WORKSPACE, name: 'Example Workspace', projectId: 'prj_example01', projectName: 'Example Project' } };
  const wide = swimlaneModel([dto], directory, [], false, {}, {});
  const review = wide.lanes[0].cells.find(c => c.stageId === 'review');
  assert.deepEqual(review.cards[0].family, { total: 4, open: 3 });
  const phone = mobileSwimlaneModel([dto], directory, [], false, {}, 'doing', {});
  assert.deepEqual(phone.sections[0].cell.cards.filter(c => c.parent).map(c => c.id), [ids.w1, ids.mixed]);
  assert.deepEqual(phone.stages.map(s => s.count), [3, 3, 1, 1], 'the stage tabs count every card');
  assert.equal(phone.stages.reduce((n, s) => n + s.count, 0), wide.lanes[0].total);
  assert.equal(wide.attention, swimlaneModel([{ ...dto, stages: dto.stages.map(s => ({ ...s, cards: s.cards.map(({ parentCardId, ...c }) => c) })) }],
    directory, [], false, {}, {}).attention);
});
