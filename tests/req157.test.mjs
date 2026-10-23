// REQ-157: the check up's list shows a lead's sub-cards under it, as the board does (`linkStages`, client/card-groups.ts) — inside
// each rule's group, a sub-card under its lead's row, or under the lead's name (a heading, not a candidate) when the lead is not one
// there; a card whose parent is not read stays flat. Selecting stays as it was: "Select all" and a group's tick take the group's
// cards whatever their place, and the list's order (the plan's, the footer's counts) does not change. The screens are in
// tests/web/run.mjs (=req157). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkupCandidates, checkupGroups, checkupPlan, checkupTree, DAY_MS, selectionCounts } from '../dist/client/checkup-model.js';

const NOW = Date.parse('2026-10-19T03:00:00.000Z');
const ago = days => new Date(NOW - days * DAY_MS).toISOString();
const STAGES = [['todo', 'To Do', false], ['doing', 'In progress', false], ['review', 'Review', false], ['done', 'Done', true]];
/** A request in progress, still for `days` days with no agent (R2, stalled) unless said. */
const card = (id, extra = {}, days = 20) => ({ id, title: 'Card ' + id, stageId: 'doing', intent: 'requested', blocked: false, awaiting: null, agentIds: [],
  updatedAt: ago(days), createdAt: ago(days + 1), stageEnteredAt: ago(days), ...extra });
const boardOf = (id, cards) => ({ summary: { id, revision: 'r-' + id },
  stages: STAGES.map(([stageId, name, countsAsDone]) => ({ stageId, name, countsAsDone, cards: cards.filter(c => c.stageId === stageId) })) });
const signals = (archived = []) => ({ archived: a => archived.includes(a), activity: () => undefined, pending: () => false, ready: true });
/** The tree as short lines: a card "  title" (two spaces a level), a lead's heading "# title [keys' titles]". */
const shape = (items, list) => items.map(item => item.kind === 'lead'
  ? '# ' + item.title + ' [' + item.keys.map(key => list.find(c => c.key === key).title).join(', ') + ']'
  : '  '.repeat(item.depth) + item.card.title);
const treeOf = (boards, s = signals(), agents) => {
  const list = checkupCandidates(boards, s, NOW, undefined, agents);
  return { list, groups: checkupGroups(list).map(g => ({ rule: g.rule, lines: shape(checkupTree(g.cards), list), items: checkupTree(g.cards) })) };
};

test('REQ-157 a lead and its sub-card both candidates: the sub-card under the lead\'s row, even when it waited longer', () => {
  const { list, groups } = treeOf([boardOf('b1', [card('lead', { title: 'Lead-02_sample_Opus' }, 10), card('sub', { parentCardId: 'lead' }, 30),
    card('solo', {}, 20)])]);
  assert.equal(list.find(c => c.cardId === 'sub').parent?.cardId, 'lead', 'the candidate names the card the board puts it under');
  assert.equal(list.find(c => c.cardId === 'lead').parent, undefined);
  assert.deepEqual(groups.map(g => g.rule), ['stalled']);
  assert.deepEqual(groups[0].lines, ['Lead-02_sample_Opus', '  Card sub', 'Card solo'], 'the family where its first member waits, then the rest');
});

test('REQ-157 only the sub-cards are candidates: the lead\'s name heads them, a heading with its own sub-cards to tick', () => {
  const lead = card('lead', { title: 'Lead-03_sample-app_Opus', updatedAt: ago(0), stageEnteredAt: ago(0) });
  const { list, groups } = treeOf([boardOf('b1', [lead, card('s1', { parentCardId: 'lead' }, 12), card('s2', { parentCardId: 'lead' }, 25), card('solo', {}, 15)])]);
  assert.deepEqual(groups[0].lines, ['# Lead-03_sample-app_Opus [Card s2, Card s1]', '  Card s2', '  Card s1', 'Card solo']);
  const head = groups[0].items[0];
  assert.equal(head.kind, 'lead'); assert.equal(head.boardId, 'b1'); assert.equal(head.cardId, 'lead');
  assert.equal(list.length, 3, 'the heading is no candidate');
});

test('REQ-157 a lead that is a candidate under another rule heads its sub-cards in this one', () => {
  const s = signals(['a-lead']);
  const { groups } = treeOf([boardOf('b1', [card('lead', { title: 'Lead-04', agentIds: ['a-lead'] }, 1), card('sub', { parentCardId: 'lead' }, 9)])], s);
  assert.deepEqual(groups.map(g => [g.rule, g.lines]), [['orphaned', ['Lead-04']], ['stalled', ['# Lead-04 [Card sub]', '  Card sub']]]);
});

test('REQ-157 a parent not among the cards read (another board, archived, or none): flat, as before', () => {
  const { list, groups } = treeOf([boardOf('b1', [card('sub', { parentCardId: 'gone' }, 12), card('solo', {}, 15)])]);
  assert.equal(list.find(c => c.cardId === 'sub').parent, undefined);
  assert.deepEqual(groups[0].lines, ['Card solo', 'Card sub']);
  assert.ok(groups[0].items.every(item => item.kind === 'card' && item.depth === 0));
});

test('REQ-157 two leads: each heads its own sub-cards, in the order their first member waits', () => {
  const quiet = { updatedAt: ago(0), stageEnteredAt: ago(0) };
  const { groups } = treeOf([boardOf('b1', [card('la', { title: 'Lead-A', ...quiet }), card('lb', { title: 'Lead-B', ...quiet }),
    card('a1', { parentCardId: 'la' }, 10), card('b1', { parentCardId: 'lb' }, 30), card('a2', { parentCardId: 'la' }, 20)])]);
  assert.deepEqual(groups[0].lines, ['# Lead-B [Card b1]', '  Card b1', '# Lead-A [Card a2, Card a1]', '  Card a2', '  Card a1']);
});

test('REQ-157 boards stay apart: the same card ids on two workspaces never share a lead', () => {
  const quiet = { updatedAt: ago(0), stageEnteredAt: ago(0) };
  const one = boardOf('w1', [card('lead', { title: 'Lead-W1', ...quiet }), card('sub', { parentCardId: 'lead', title: 'W1 sub' }, 10)]);
  const two = boardOf('w2', [card('lead', { title: 'Lead-W2', ...quiet }), card('sub', { parentCardId: 'lead', title: 'W2 sub' }, 20),
    card('far', { parentCardId: 'x', title: 'W2 stray' }, 15)]);
  const { groups } = treeOf([one, two]);
  assert.deepEqual(groups[0].lines, ['# Lead-W2 [W2 sub]', '  W2 sub', 'W2 stray', '# Lead-W1 [W1 sub]', '  W1 sub']);
  assert.deepEqual(groups[0].items.filter(i => i.kind === 'lead').map(i => i.key), ['w2\u0000lead', 'w1\u0000lead']);
});

test('REQ-157 a topic lead (REQ-117): its own sub-cards under it, it under the workspace lead — the board\'s three levels', () => {
  // The server keeps one level (every card under the top-level agent's card); the agents' labels find the topic lead.
  const links = { 'a-lead': { title: '총괄-01' }, 'a-topic': { role: '주제총괄', parentAgentId: 'a-lead' }, 'a-kid': { parentAgentId: 'a-topic' } };
  const agents = id => links[id];
  const activity = () => ago(30), s = { ...signals(), activity };
  const quiet = { updatedAt: ago(0), stageEnteredAt: ago(0) };
  const { list, groups } = treeOf([boardOf('b1', [card('lead', { title: '총괄-01', agentIds: ['a-lead'], ...quiet }),
    card('topic', { title: 'T01', agentIds: ['a-topic'], parentCardId: 'lead' }, 25), card('kid', { agentIds: ['a-kid'], parentCardId: 'lead' }, 30)])], s, agents);
  assert.equal(list.find(c => c.cardId === 'kid').parent?.cardId, 'topic', 'the board face names the topic lead ("↳ T01")');
  assert.deepEqual(groups[0].lines, ['# 총괄-01 [T01, Card kid]', '  T01', '    Card kid']);
  const { groups: flat } = treeOf([boardOf('b1', [card('lead', { title: '총괄-01', agentIds: ['a-lead'], ...quiet }),
    card('topic', { title: 'T01', agentIds: ['a-topic'], parentCardId: 'lead' }, 25), card('kid', { agentIds: ['a-kid'], parentCardId: 'lead' }, 30)])], s);
  assert.deepEqual(flat[0].lines, ['# 총괄-01 [Card kid, T01]', '  Card kid', '  T01'], 'without the agents\' labels: the server\'s one level');
});

test('REQ-157 selecting: "Select all" and a group\'s tick as before, a heading\'s tick takes its sub-cards only, the plan in the list\'s order', () => {
  const quiet = { updatedAt: ago(0), stageEnteredAt: ago(0) };
  const boards = [boardOf('b1', [card('lead', { title: 'Lead-05', ...quiet }), card('s1', { parentCardId: 'lead' }, 12), card('s2', { parentCardId: 'lead' }, 25),
    card('solo', {}, 15), card('draft', { stageId: 'todo', intent: 'draft' }, 20)])];
  const hierarchy = checkupCandidates(boards, signals(), NOW);
  const plain = checkupCandidates(boards.map(b => ({ ...b, stages: b.stages.map(s => ({ ...s, cards: s.cards.map(({ parentCardId, ...c }) => c) })) })), signals(), NOW);
  assert.deepEqual(hierarchy.map(c => c.key), plain.map(c => c.key), 'the list\'s own order does not change');
  const all = new Set(hierarchy.map(c => c.key));
  assert.deepEqual(selectionCounts(hierarchy, all), { total: 4, done: 3, notDone: 1 }, '"Select all": every card, headings none');
  const stalled = checkupGroups(hierarchy).find(g => g.rule === 'stalled');
  assert.deepEqual(selectionCounts(hierarchy, new Set(stalled.cards.map(c => c.key))).total, 3, 'a group\'s tick: its three cards');
  const head = checkupTree(stalled.cards).find(item => item.kind === 'lead');
  assert.equal(selectionCounts(hierarchy, new Set(head.keys)).total, 2, 'the heading\'s tick: its two sub-cards');
  assert.deepEqual(checkupPlan(hierarchy, all, 'done').boards[0].cards.map(c => c.cardId), plain.map(c => c.cardId).filter(id => id !== 'draft'));
});

test('REQ-157 every candidate once in the tree, whatever the families', () => {
  const quiet = { updatedAt: ago(0), stageEnteredAt: ago(0) };
  const cards = [card('lead', { title: 'Lead', ...quiet })];
  for (let i = 0; i < 12; i++) cards.push(card('c' + i, i % 3 ? { parentCardId: i % 2 ? 'lead' : 'c0' } : {}, 8 + i));
  const { list, groups } = treeOf([boardOf('b1', cards)]);
  const seen = groups.flatMap(g => g.items.filter(i => i.kind === 'card').map(i => i.card.key));
  assert.deepEqual([...seen].sort(), list.map(c => c.key).sort());
  assert.equal(new Set(seen).size, seen.length);
});
