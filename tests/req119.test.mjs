// REQ-119 (the owner's screenshot, 2026-09-29): a lead that has not started any sub-agent yet showed as a plain card. A
// lead by name — top-level, titled "총괄-…" or given a "총괄_…" profile, the server's `isLeadAgent` — is a lead's card from
// the start: a family of none (crown, outline, pinned, short title, status row), and no "Sub-cards 0" line. The screens
// are exercised in tests/plugin-ui.test.mjs and tests/web/run.mjs ("req119-…"). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkStages, leadAgentIds, TOPIC_LEAD_ROLE } from '../dist/client/card-groups.js';
import { sortCards } from '../dist/client/card-order.js';
import { leadRows, LEAD_ROWS, cardDimensions } from '../dist/client/swimlane-model.js';
import { lanePanelHeight } from '../dist/client/panel-style.js';
import { isLeadName, LEAD_TITLE, LEAD_PROFILE } from '../dist/shared/dispatch.js';
import { isLeadAgent } from '../dist/server/dispatch.js';

const L = 'agent-lead', P = 'agent-plain', S = 'agent-sub', H = 'agent-helper';
const at = n => `2026-09-29T00:0${n}:00.000Z`;
const card = (id, title, stageId, agentId, n, parentCardId) => ({ id, title, stageId, priority: 'normal', intent: 'requested', blocked: false,
  nextAction: '', agents: agentId ? 1 : 0, awaiting: null, agentIds: agentId ? [agentId] : [], completedAt: null, createdAt: at(n), updatedAt: at(n),
  ...(parentCardId ? { parentCardId } : {}) });
/** A review column with two older plain cards and the new lead's card last, as in the screenshot. */
const board = (extra = []) => [
  { stageId: 'todo', countsAsDone: false, cards: [] },
  { stageId: 'review', countsAsDone: false, cards: [card('c-old', 'Older card', 'review', P, 1), card('c-lead', '총괄-08_Sample-App_Opus', 'review', L, 3), ...extra] },
  { stageId: 'done', countsAsDone: true, cards: [] },
];
const links = map => id => map[id];
const byId = stages => Object.fromEntries(stages.flatMap(s => s.cards).map(c => [c.id, c]));
const lead = { [L]: { title: '총괄-08_Sample-App_Opus', profile: '총괄_Opus-5.5' }, [P]: { title: 'Build it', profile: 'build_Opus' } };

test('REQ-119 one rule with the server: "총괄-" title or "총괄_" profile', () => {
  assert.equal(LEAD_TITLE, '총괄-'); assert.equal(LEAD_PROFILE, '총괄_');
  assert.equal(isLeadName(' 총괄-08_x_Opus', null), true);
  assert.equal(isLeadName('Anything', '총괄_Opus-5.5'), true);
  assert.equal(isLeadName('총괄 확인', 'build_Opus'), false);
  assert.equal(isLeadName(undefined, undefined), false);
  assert.equal(isLeadAgent({ title: 'x', profile: '총괄_Opus', parent: null, archived: false }), true);
  assert.equal(isLeadAgent({ title: '총괄-01', profile: '', parent: 'agent-up', archived: false }), false);
});
test('REQ-119 a lead by name with no sub-card: a lead\'s card from the start, pinned, its agent looked up first', () => {
  for (const info of [lead[L], { title: '총괄-08_Sample-App_Opus' }, { title: 'Renamed', profile: '총괄_Opus-5.5' }]) {
    const stages = linkStages(board(), links({ ...lead, [L]: info })), c = byId(stages)['c-lead'];
    assert.deepEqual(c.family, { total: 0, open: 0 }, JSON.stringify(info));
    assert.deepEqual(c.crew, { members: [], own: [] }, 'a status row with nothing under it yet');
    assert.equal(c.subLead, undefined, 'not a topic lead');
    assert.equal(c.parent, undefined);
    assert.deepEqual(sortCards(stages[1].cards, 'default').map(v => v.id), ['c-lead', 'c-old'], 'first in its column');
  }
  assert.deepEqual(leadAgentIds([{ stages: board() }], links(lead)), [L]);
  // Its card's rows: the status row alone, no "Sub-cards 0" line (a topic lead keeps its "0", REQ-117).
  assert.equal(leadRows({ total: 0 }), 1);
  assert.equal(leadRows({ total: 0 }, true), LEAD_ROWS);
  assert.equal(leadRows({ total: 2 }), LEAD_ROWS);
  assert.equal(leadRows(undefined), 0);
  assert.equal(cardDimensions(false, 1, false, 1).height, 84 + 22);
  assert.equal(cardDimensions(false, 1, false, true).height, cardDimensions(false, 1, false, LEAD_ROWS).height, 'true is both rows, as before');
  const c = byId(linkStages(board(), links(lead)))['c-lead'];
  assert.equal(lanePanelHeight([{ cards: [c], remaining: 0 }]) - lanePanelHeight([{ cards: [{ ...c, family: { total: 1, open: 1 } }], remaining: 0 }]), -22,
    'the lane keeps room for one row less');
});
test('REQ-119 neither title nor profile a lead\'s: a plain card; nothing read of the agent: a plain card', () => {
  const plain = byId(linkStages(board(), links({ ...lead, [L]: { title: 'Build-08_Sample-App_Opus', profile: 'build_Opus' } })));
  assert.equal(plain['c-lead'].family, undefined);
  assert.equal(plain['c-old'].family, undefined);
  assert.equal(byId(linkStages(board(), links({})))['c-lead'].family, undefined, 'an agent not listed yet');
  assert.equal(byId(linkStages(board()))['c-lead'].family, undefined, 'no agents given: as before');
  assert.deepEqual(sortCards(linkStages(board(), links({}))[1].cards, 'default').map(v => v.id), ['c-old', 'c-lead']);
});
test('REQ-119 a sub-agent named like a lead is no lead: started under an agent, or under a card', () => {
  const named = { title: '총괄-09_Sample-App_Opus', profile: '총괄_Opus-5.5' };
  const up = byId(linkStages(board(), links({ ...lead, [L]: { ...named, parentAgentId: P } })));
  assert.equal(up['c-lead'].family, undefined, 'its parent agent label');
  // The server's "↳ parent" alone (the label gone) keeps it a sub-card too.
  const marked = board().map(s => ({ ...s, cards: s.cards.map(c => c.id === 'c-lead' ? { ...c, parentCardId: 'c-old' } : c) }));
  const m = byId(linkStages(marked, links({ [L]: named })));
  assert.equal(m['c-lead'].family, undefined);
  assert.deepEqual(m['c-old'].family, { total: 1, open: 1 }, 'the card it sits under is the parent, as before');
  // A topic lead labelled with a lead's profile stays a topic lead (REQ-117 ③).
  const topic = byId(linkStages(board(), links({ [L]: { ...named, role: TOPIC_LEAD_ROLE, parentAgentId: P }, [P]: {} })));
  assert.equal(topic['c-lead'].subLead, true);
});
test('REQ-119 once it has sub-cards: the family as before, on the card they sit under, one lead card only', () => {
  const stages = board([card('c-sub', 'Worker', 'review', S, 4, 'c-lead')]);
  stages[0].cards.push(card('c-check', '총괄 확인 — tests', 'todo', L, 5));
  const c = byId(linkStages(stages, links({ ...lead, [S]: { parentAgentId: L } })));
  assert.deepEqual(c['c-lead'].family, { total: 1, open: 1 });
  assert.deepEqual(c['c-lead'].crew.own.map(v => v.id), ['c-check'], 'the lead\'s check card on its status row');
  assert.equal(c['c-check'].family, undefined, 'its other card is no lead');
  // The server's parent card may be another of the lead's cards: that one has the family, the oldest none.
  const moved = board([card('c-sub', 'Worker', 'review', S, 4, 'c-later')]);
  moved[0].cards.push(card('c-later', 'Lead\'s later card', 'todo', L, 5));
  const d = byId(linkStages(moved, links({ ...lead, [S]: { parentAgentId: L } })));
  assert.deepEqual(d['c-later'].family, { total: 1, open: 1 });
  assert.equal(d['c-lead'].family, undefined);
  // Its oldest card is the lead's; a newer one of its own is not.
  const two = board(); two[0].cards.push(card('c-new', '총괄-08 notes', 'todo', L, 6));
  const e = byId(linkStages(two, links(lead)));
  assert.deepEqual([e['c-lead'].family, e['c-new'].family], [{ total: 0, open: 0 }, undefined]);
  assert.deepEqual(e['c-lead'].crew.own.map(v => v.id), ['c-new']);
  // A helper the lead started with no card of the lead's read: the helper is no lead.
  const f = byId(linkStages([{ stageId: 'todo', countsAsDone: false, cards: [card('c-h', 'Helper', 'todo', H, 1)] }], links({ [H]: { parentAgentId: L } })));
  assert.equal(f['c-h'].family, undefined);
});
