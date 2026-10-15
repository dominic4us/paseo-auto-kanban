// REQ-117 (another workspace's lead, passed on by the owner, 2026-09-29): three levels — the workspace's lead → topic leads
// (labels.role "주제총괄", started under the lead) → the topic leads' own sub-agents. A topic lead is told apart (a grey
// crown), has a lead's family line and status row for its own sub-cards, keeps its "↳ lead" mark and its whole title, and
// is pinned after the lead. The screens are exercised in tests/web/run.mjs ("req117-…"). Made-up topics only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkStages, leadAgentIds, inFamily, inFocus, openIds, isTopicLead, TOPIC_LEAD_ROLE } from '../dist/client/card-groups.js';
import { sortCards } from '../dist/client/card-order.js';
import { leadTitleOneLine } from '../dist/client/swimlane-model.js';
import { PASEO_THEMES, palette, crownColor, contrast } from '../dist/client/palette.js';
import { isLeadAgent, pickLead, readLeadEntry } from '../dist/server/dispatch.js';
import { copy } from '../dist/client/i18n.js';
import { isTopicRole, TOPIC_LEAD_ROLE as SHARED_TOPIC_LEAD_ROLE } from '../dist/shared/dispatch.js';

const W = 'agent-lead', T = 'agent-topic', S1 = 'agent-sub-1', S2 = 'agent-sub-2', X = 'agent-direct';
const at = n => `2026-09-29T00:0${n}:00.000Z`;
const card = (id, title, stageId, agentId, n, parentCardId) => ({ id, title, stageId, priority: 'normal', intent: 'requested', blocked: false,
  nextAction: '', agents: agentId ? 1 : 0, awaiting: null, agentIds: agentId ? [agentId] : [], completedAt: null, createdAt: at(n), updatedAt: at(n),
  ...(parentCardId ? { parentCardId } : {}) });
/** 총괄-01 → T01_샘플주제_1 → T01_수집_대상A / T01_수집_대상B (one done), as the server sends it: every card under the lead's. */
const threeLevels = () => [
  { stageId: 'todo', countsAsDone: false, cards: [card('c-plain', 'Plain card', 'todo', null, 1)] },
  { stageId: 'doing', countsAsDone: false, cards: [card('c-s1', 'T01_수집_대상A', 'doing', S1, 4, 'c-lead'), card('c-topic', 'T01_샘플주제_1', 'doing', T, 3, 'c-lead')] },
  { stageId: 'review', countsAsDone: false, cards: [card('c-lead', '총괄-01_sample-app_Opus', 'review', W, 2)] },
  { stageId: 'done', countsAsDone: true, cards: [card('c-s2', 'T01_수집_대상B', 'done', S2, 5, 'c-lead')] },
];
const labelled = { [W]: {}, [T]: { role: TOPIC_LEAD_ROLE, parentAgentId: W }, [S1]: { parentAgentId: T }, [S2]: { parentAgentId: T } };
const links = map => id => map[id];
const byId = stages => Object.fromEntries(stages.flatMap(s => s.cards).map(c => [c.id, c]));

test('REQ-117 by the role label: the topic lead has its own family, keeps its "↳ lead" mark; its sub-cards name it', () => {
  const cards = byId(linkStages(threeLevels(), links(labelled)));
  const topic = cards['c-topic'], lead = cards['c-lead'];
  assert.equal(topic.subLead, true);
  assert.deepEqual(topic.parent, { id: 'c-lead', title: '총괄-01_sample-app_Opus' }, 'still a sub-card of the lead');
  assert.deepEqual(topic.family, { total: 2, open: 1 }, 'its two sub-cards, one done');
  assert.deepEqual(topic.crew.members.map(c => c.id).sort(), ['c-s1', 'c-s2']);
  assert.deepEqual(openIds(topic, threeLevels()), ['c-s1']);
  for (const id of ['c-s1', 'c-s2']) {
    assert.deepEqual(cards[id].subParent, { id: 'c-topic', title: 'T01_샘플주제_1' });
    assert.equal(cards[id].parent.id, 'c-lead', 'the lead\'s family keeps it');
    assert.ok(inFamily(cards[id], 'c-topic') && inFamily(cards[id], 'c-lead'));
    assert.equal(cards[id].family, undefined);
  }
  assert.equal(inFamily(lead, 'c-topic'), false, 'the lead is not in the topic lead\'s family');
  assert.equal(inFocus(cards['c-plain'], 'c-topic'), false);
  // 6: the lead's count is the rule as it was — every card under it, the topic lead and its sub-cards alike (3, 2 not done).
  assert.equal(lead.subLead, undefined);
  assert.deepEqual(lead.family, { total: 3, open: 2 });
  assert.deepEqual(lead.crew.members.map(c => c.id).sort(), ['c-s1', 'c-s2', 'c-topic']);
  assert.deepEqual(leadAgentIds([{ stages: threeLevels() }], links(labelled)).sort(), [T, W].sort(), 'the topic lead\'s agent is looked up first too');
});
test('REQ-117 by its shape, with no label: started under an agent and with sub-cards of its own', () => {
  const plain = { ...labelled, [T]: { parentAgentId: W } };
  assert.equal(byId(linkStages(threeLevels(), links(plain)))['c-topic'].subLead, true, 'parent label and sub-cards');
  // The server's "↳ lead" alone stands for "has a parent" when the label is gone (a detach, the lead archived).
  const lost = { ...labelled, [T]: {} };
  assert.equal(byId(linkStages(threeLevels(), links(lost)))['c-topic'].subLead, true, 'the server\'s parent and sub-cards');
  // No sub-cards: an ordinary sub-card. Labelled with no sub-cards yet: a topic lead with "0".
  const alone = { [W]: {}, [T]: { parentAgentId: W }, [S1]: {}, [S2]: {} };
  const none = byId(linkStages(threeLevels(), links(alone)));
  assert.equal(none['c-topic'].subLead, undefined);
  assert.equal(none['c-topic'].family, undefined);
  assert.equal(none['c-s1'].subParent, undefined);
  const early = byId(linkStages(threeLevels(), links({ [T]: { role: '주제총괄', parentAgentId: W } })));
  assert.equal(early['c-topic'].subLead, true);
  assert.deepEqual(early['c-topic'].family, { total: 0, open: 0 });
  // The workspace's lead never is one: top-level, whatever sub-cards it has.
  assert.equal(isTopicLead({}, false, true), false);
  assert.equal(isTopicLead(undefined, false, true), false);
  assert.equal(isTopicLead({ role: ' 주제총괄 ' }, false, false), true);
  assert.equal(isTopicLead({ parentAgentId: W }, false, true), true);
  // A sub-agent started straight under the lead is no topic lead's.
  const direct = [...threeLevels()];
  direct[0] = { ...direct[0], cards: [...direct[0].cards, card('c-x', 'Direct helper', 'todo', X, 6, 'c-lead')] };
  const d = byId(linkStages(direct, links({ ...labelled, [X]: { parentAgentId: W } })));
  assert.equal(d['c-x'].subParent, undefined);
  assert.equal(d['c-x'].parent.id, 'c-lead');
  assert.deepEqual(d['c-lead'].family, { total: 4, open: 3 });
});
test('REQ-117 without the agents\' labels nothing changes (the two-level board as before)', () => {
  const cards = byId(linkStages(threeLevels()));
  assert.equal(cards['c-topic'].subLead, undefined);
  assert.equal(cards['c-topic'].family, undefined);
  assert.equal(cards['c-s1'].subParent, undefined);
  assert.deepEqual(cards['c-lead'].family, { total: 3, open: 2 });
});
test('REQ-117 the topic lead\'s card is its agent\'s oldest card; a later card of that agent is its own work', () => {
  const stages = threeLevels();
  stages[0] = { ...stages[0], cards: [...stages[0].cards, card('c-topic-check', 'T01 check', 'todo', T, 7, 'c-lead')] };
  const cards = byId(linkStages(stages, links(labelled)));
  assert.equal(cards['c-topic'].subLead, true);
  assert.equal(cards['c-topic-check'].subLead, undefined);
  assert.deepEqual(cards['c-topic'].crew.own.map(c => c.id), ['c-topic-check'], 'read by its status row (REQ-104)');
});
test('REQ-117 pinned: the lead, then the topic leads, then the rest; archived in a completion column, unpinned', () => {
  const lead = { id: 'lead', priority: 'normal', createdAt: at(3), family: { total: 3, open: 1 }, agentIds: [W] };
  const topic = { id: 'topic', priority: 'normal', createdAt: at(2), family: { total: 2, open: 1 }, subLead: true, agentIds: [T] };
  const other = { id: 'other', priority: 'high', createdAt: at(1), agentIds: [] };
  for (const order of ['default', 'updated', 'created'])
    assert.deepEqual(sortCards([other, topic, lead], order).map(c => c.id), ['lead', 'topic', 'other'], order);
  const topicB = { ...topic, id: 'topic-b', createdAt: at(4) };
  assert.deepEqual(sortCards([topicB, other, topic], 'default').map(c => c.id), ['topic', 'topic-b', 'other'], 'topic leads keep the chosen order');
  const archived = id => id === T;
  assert.deepEqual(sortCards([other, topic, lead], 'default', true, archived).map(c => c.id), ['lead', 'other', 'topic'], 'REQ-102');
  assert.deepEqual(sortCards([other, topic], 'default', false, archived).map(c => c.id), ['topic', 'other'], 'outside done still pinned');
});
// REQ-120 (replacing REQ-117's grey crown): the topic lead's mark is a two-tone medal (REQ-123 antique gold); `crownColor`'s `topic` is its base
// (tests/req120.test.mjs has the face and the tinted cards).
test('REQ-117/120/123 the topic lead\'s medal: light and dark, 3:1 on the card, apart from the gold; archived sinks toward the card', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), face = c.card;
    const medal = crownColor(c, face, false, true), gold = crownColor(c, face), old = crownColor(c, face, true, true);
    assert.equal(medal.toLowerCase(), c.crownSub.toLowerCase(), mode + ': the token as it is');
    assert.equal(c.crownSub, { light: '#987a59', dark: '#bba07f' }[mode], mode + ': the medal\'s antique gold base');
    assert.ok(contrast(medal, face) >= 3, mode + ' ' + contrast(medal, face).toFixed(2));
    assert.notEqual(medal, gold);
    assert.equal(old, c.crownSubArchived);
    assert.equal(old, { light: '#b5a99b', dark: '#71675b' }[mode]);
    assert.notEqual(old.toLowerCase(), medal.toLowerCase());
    // Archived: closer to the card than the active medal (quieter, as the archived gold), under 3:1.
    assert.ok(contrast(old, face) < contrast(medal, face) && contrast(old, face) < 3, mode + ': archived sinks ' + contrast(old, face).toFixed(2));
  }
  assert.equal(copy('ko').topicLeadCard, '주제 총괄 카드 (총괄 아래)');
});
test('REQ-117 the title stays whole: one line only when the whole title fits', () => {
  assert.equal(leadTitleOneLine('T01_샘플주제_1', true), true);
  assert.equal(leadTitleOneLine('T01_아주 긴 샘플 주제 이름이 한 줄을 넘는 경우_1', true), false);
  assert.equal(leadTitleOneLine('T01_아주 긴 샘플 주제 이름이 한 줄을 넘는 경우_1'), true, 'a lead\'s head alone ("T01") would fit');
});
test('REQ-117 REQ-97 pickLead never takes a topic lead, though its profile is "총괄_"', () => {
  const b = { workspaceId: 'wks_example01', cwd: '/tmp/example-workspace' };
  const agent = (id, title, labels, createdAt) => ({ agent: { id, title, cwd: '/tmp/example-workspace', workspaceId: 'wks_example01',
    createdAt, archivedAt: null, labels, status: 'idle' } });
  const lead = agent(W, '총괄-01_sample-app_Opus', { profile: '총괄_Opus-5.5' }, at(1));
  const topic = agent(T, 'T01_샘플주제_1', { profile: '총괄_Opus-5.5', role: '주제총괄', 'paseo.parent-agent-id': W }, at(2));
  const listed = [lead, topic].map(readLeadEntry);
  assert.equal(isLeadAgent(listed[1]), false, 'a parent: not a lead');
  assert.equal(pickLead(listed, b)?.id, W, 'the newer topic lead is passed over');
  assert.equal(pickLead([listed[1]], b), null, 'alone, still no lead');
});
test('research/191 D1: a topic lead by its role alone, no parent mark, is never the workspace\'s lead', () => {
  const b = { workspaceId: 'wks_example01', cwd: '/tmp/example-workspace' };
  const agent = (id, title, labels, createdAt) => ({ agent: { id, title, cwd: '/tmp/example-workspace', workspaceId: 'wks_example01',
    createdAt, archivedAt: null, labels, status: 'idle' } });
  const lead = readLeadEntry(agent(W, '총괄-01_sample-app_Opus', { profile: '총괄_Opus-5.5' }, at(1)));
  const detached = readLeadEntry(agent(T, 'T01_샘플주제_1', { profile: '총괄_Opus-5.5', role: ' 주제총괄 ' }, at(3)));
  assert.equal(detached.parent, null);
  assert.equal(isTopicRole(detached.role), true, 'the role label is read');
  assert.equal(isLeadAgent(detached), false, 'no parent, still a topic lead');
  assert.equal(pickLead([lead, detached], b)?.id, W, 'the newer topic lead is passed over');
  assert.equal(pickLead([detached], b), null, 'alone, still no lead');
  // Another role, or none, keeps the rule as it was.
  const other = readLeadEntry(agent(T, 'T01_샘플주제_1', { profile: '총괄_Opus-5.5', role: '검증' }, at(3)));
  assert.equal(pickLead([lead, other], b)?.id, T);
  assert.equal(isLeadAgent({ title: '총괄-01', profile: '', parent: null, archived: false }), true, 'no role field at all');
  // The board: one shared rule — a topic lead (grey crown, own place), not raised to the workspace's lead.
  const stages = [{ stageId: 'todo', countsAsDone: false, cards: [card('c-w', '총괄-01_sample-app_Opus', 'todo', W, 1), card('c-t', 'T01_샘플주제_1', 'todo', T, 3)] }];
  const c = Object.fromEntries(linkStages(stages, id => ({ [W]: { title: '총괄-01_sample-app_Opus', profile: '총괄_Opus-5.5' },
    [T]: { title: 'T01_샘플주제_1', profile: '총괄_Opus-5.5', role: TOPIC_LEAD_ROLE } })[id]).flatMap(s => s.cards).map(v => [v.id, v]));
  assert.equal(c['c-t'].subLead, true);
  assert.equal(c['c-w'].subLead, undefined);
  assert.deepEqual(c['c-w'].family, { total: 0, open: 0 }, 'the workspace\'s lead is still a lead (REQ-119)');
  assert.equal(TOPIC_LEAD_ROLE, SHARED_TOPIC_LEAD_ROLE, 'client and server read one role');
});
test('research/191 J1: the crown\'s label says a lead card, sub-cards or none', () => {
  assert.equal(copy('ko').leadCard, '총괄 카드');
  assert.equal(copy('en').leadCard, 'Lead card');
  assert.equal(copy('en').topicLeadCard, 'Topic lead card (under the lead)', 'the topic lead\'s label stays apart');
});
