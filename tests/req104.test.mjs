// REQ-104 (the owner's choice, 2026-09-27): a lead card's second summary row says what the lead is waiting for — its
// sub-cards at work, its check under way (with when it started, KST), its sub-cards waiting for you — or, with none,
// that it is idle and when its agent was last active. Each part highlights its cards. The screens are exercised in
// plugin-ui.test.mjs ("REQ-104") and tests/web/run.mjs (real input).
// REQ-136 H3: the row's times are the device's own; this file reads them on a device in Korea (its expectations are KST),
// whatever zone the machine running it is in, and once in New York to see the zone followed.
process.env.TZ = 'Asia/Seoul';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStart, inProgressStage, isCheckCard, deviceClock, leadStatus, statusIds, awaitsUser, needsReply, askingAgent } from '../dist/client/lead-status.js';
import { linkStages, inFocus } from '../dist/client/card-groups.js';
import { revealFamily, cardDimensions, focusTab } from '../dist/client/swimlane-model.js';
import { copy } from '../dist/client/i18n.js';
import { builtinTemplate } from '../dist/shared/core/domain.js';

const stages = builtinTemplate('ko').stages;
/** 2026-09-27 21:50 KST. */
const NOW = Date.parse('2026-09-27T12:50:00.000Z');
const card = (id, extra = {}) => ({ id, title: 'Card ' + id, stageId: 'todo', nextAction: '', awaiting: null, agentIds: [], blocked: false,
  intent: 'requested', updatedAt: '2026-09-27T12:00:00.000Z', ...extra });
const read = map => id => map[id] ?? 'unknown';

test('REQ-104 times are KST: today "HH:MM", before today "MM-DD HH:MM", nothing for no time', () => {
  assert.equal(deviceClock('2026-09-27T12:40:00.000Z', NOW), '21:40');
  assert.equal(deviceClock('2026-09-26T12:40:00.000Z', NOW), '09-26 21:40');
  // 00:10 KST on the 28th is today at 01:00 KST on the 28th, though both are still the 27th in UTC.
  assert.equal(deviceClock('2026-09-27T15:10:00.000Z', Date.parse('2026-09-27T16:00:00.000Z')), '00:10');
  assert.equal(deviceClock('2026-09-27T14:50:00.000Z', Date.parse('2026-09-27T16:00:00.000Z')), '09-27 23:50', 'yesterday in KST');
  assert.equal(deviceClock(undefined, NOW), '');
  assert.equal(deviceClock('not a time', NOW), '');
});
test('REQ-136 H3 the row\'s times follow the device\'s zone: a device in New York reads its own clock, not Korea\'s', () => {
  process.env.TZ = 'America/New_York';
  try {
    // 21:40 KST on the 27th is 08:40 EDT the same day; 00:10 KST on the 28th is still the 27th (11:10) in New York.
    assert.equal(deviceClock('2026-09-27T12:40:00.000Z', NOW), '08:40');
    assert.equal(deviceClock('2026-09-27T15:10:00.000Z', Date.parse('2026-09-27T16:00:00.000Z')), '11:10');
    assert.equal(deviceClock('2026-09-26T12:40:00.000Z', NOW), '09-26 08:40');
  } finally { process.env.TZ = 'Asia/Seoul'; }
  assert.equal(deviceClock('2026-09-27T12:40:00.000Z', NOW), '21:40', 'back in Korea');
});
test('REQ-136 F1 a check card\'s "시작 HH:MM" is written in Korea\'s time: the same card is one instant on every device, only its display follows the zone', () => {
  const card = { nextAction: '테스트 중 · 시작 21:40 · 예상 22:00', updatedAt: '2026-10-03T12:50:00.000Z' }; // changed 21:50 KST
  const START = Date.parse('2026-10-03T12:40:00.000Z'), NOW3 = Date.parse('2026-10-03T13:00:00.000Z');
  try {
    for (const [zone, shown] of [['UTC', '12:40'], ['America/New_York', '08:40'], ['Asia/Seoul', '21:40']]) {
      process.env.TZ = zone;
      assert.equal(checkStart(card, NOW3), START, zone);
      assert.equal(deviceClock(checkStart(card, NOW3), NOW3), shown, zone);
    }
    // Midnight: started 23:50 KST on the 3rd, last changed 00:05 KST on the 4th — the day before the change in Korea, not the device's.
    const night = { nextAction: '시작 23:50', updatedAt: '2026-10-03T15:05:00.000Z' }, NIGHT = Date.parse('2026-10-03T14:50:00.000Z');
    for (const zone of ['UTC', 'America/New_York', 'Asia/Seoul', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(checkStart(night, NOW3), NIGHT, zone);
    }
  } finally { process.env.TZ = 'Asia/Seoul'; }
});
test('REQ-136 H3 a check card is still told by its Korean words only — English "testing" marks no card', () => {
  assert.equal(isCheckCard({ title: 'Lead check — tests', nextAction: 'testing the release' }), false);
  assert.equal(isCheckCard({ title: 'Docs', nextAction: '총괄 테스트 중 · 시작 21:40' }), true);
});
test('REQ-104 a check card: "총괄 확인…" or "테스트 중" in the next action, in the progress column only', () => {
  assert.equal(isCheckCard({ title: '총괄 확인 — 시험 3종', nextAction: '' }), true);
  assert.equal(isCheckCard({ title: 'Build', nextAction: '총괄 테스트 중 · 시작 21:40 · 예상 22:10' }), true);
  assert.equal(isCheckCard({ title: 'Build', nextAction: 'Run the tests' }), false);
  assert.deepEqual(stages.map(s => inProgressStage(s.stageId, stages)), [false, true, false, false], '진행 alone');
  // "시작 HH:MM" of the next action, on the KST day of the card's last change; else the change itself.
  assert.equal(checkStart({ nextAction: '총괄 테스트 중 · 시작 21:40', updatedAt: '2026-09-27T12:45:00.000Z' }, NOW), Date.parse('2026-09-27T12:40:00.000Z'));
  assert.equal(checkStart({ nextAction: '시작 23:50', updatedAt: '2026-09-27T15:05:00.000Z' }, NOW), Date.parse('2026-09-27T14:50:00.000Z'),
    'started before midnight, changed after it');
  assert.equal(checkStart({ nextAction: '테스트 중', updatedAt: '2026-09-27T12:30:00.000Z' }, NOW), Date.parse('2026-09-27T12:30:00.000Z'));
  assert.equal(checkStart({ nextAction: '시작 25:99', updatedAt: '2026-09-27T12:30:00.000Z' }, NOW), Date.parse('2026-09-27T12:30:00.000Z'), 'no such time');
  assert.ok(Number.isNaN(checkStart({ nextAction: '테스트 중' }, NOW)));
});
test('REQ-104 the parts: running sub-cards, the earliest check, sub-cards awaiting you; each left out at zero', () => {
  const members = [
    card('a', { stageId: 'doing', agentIds: ['w1'] }), card('b', { stageId: 'todo', agentIds: ['w2', 'w3'] }),
    card('c', { stageId: 'review', agentIds: ['w4'], awaiting: 'user' }), card('d', { stageId: 'done', agentIds: ['w5'], awaiting: 'user' }),
    card('e', { stageId: 'doing', agentIds: ['w6'], nextAction: '총괄 테스트 중 · 시작 21:40 · 예상 22:10' }),
    card('f', { stageId: 'review', agentIds: ['w7'], title: '총괄 확인 — not in progress' }),
  ];
  const own = [card('g', { stageId: 'doing', title: '총괄 확인 — 시험', agentIds: ['lead'], updatedAt: '2026-09-27T12:20:00.000Z' })];
  const status = leadStatus({ members, own, stages, read: read({ w1: 'working', w3: 'working', w4: 'permission', w5: 'working' }), now: NOW });
  assert.deepEqual(status.running, ['a', 'b', 'd'], 'any agent at work; a permission wait is not');
  assert.deepEqual(status.testing, { at: '21:20', ids: ['e', 'g'] }, 'the lead\'s own check card counts; the earliest start is shown');
  assert.deepEqual(status.awaiting, ['c'], 'a done card waits for nobody (needsHuman)');
  assert.equal(status.idle, null);
  assert.deepEqual(['running', 'testing', 'awaiting'].map(kind => statusIds(status, kind)), [['a', 'b', 'd'], ['e', 'g'], ['c']]);
  // Blocked or a draft, a card awaiting you still does; the ledger's rule, not a new one.
  assert.equal(awaitsUser(card('x', { awaiting: 'user', blocked: true }), stages), true);
  assert.equal(awaitsUser(card('y', { awaiting: 'agent' }), stages), false);
  const m = copy('en'), k = copy('ko');
  assert.equal([m.statusRunning(3), m.statusTesting('21:20'), m.statusAwaiting(1)].join(' · '), 'Running 3 · Testing 21:20~ · Needs you 1');
  assert.equal([k.statusRunning(3), k.statusTesting('21:20'), k.statusAwaiting(1)].join(' · '), '실행 중 3 · 테스트 중 21:20~ · 결정 대기 1');
  assert.equal(k.statusTesting(''), '테스트 중', 'a check with no time');
});
test('REQ-104 idle: none of the three — when the lead\'s agent was last active', () => {
  const quiet = leadStatus({ members: [card('a', { stageId: 'done', agentIds: ['w1'] })], own: [], stages, read: read({ w1: 'idle' }),
    activeAt: '2026-09-27T12:05:00.000Z', now: NOW });
  assert.deepEqual(quiet, { running: [], testing: null, awaiting: [], self: false, idle: '21:05', working: false, me: null }, 'REQ-130: no agent of its own, no state of its own');
  assert.equal(leadStatus({ members: [], own: [], stages, read: read({}), activeAt: '2026-09-25T23:00:00.000Z', now: NOW }).idle, '09-26 08:00');
  assert.equal(leadStatus({ members: [], own: [], stages, read: read({}), now: NOW }).idle, '');
  assert.equal(copy('en').statusIdle('21:05'), 'Idle · last activity 21:05');
  assert.equal(copy('ko').statusIdle('21:05'), '쉼 · 마지막 활동 21:05');
  assert.equal(copy('ko').statusIdle(''), '쉼');
});
test('REQ-104 a parent carries what its row reads; a part highlights the parent and its cards alone; a lead is two rows taller', () => {
  const lead = { ...card('lead-card', { stageId: 'review', agentIds: ['lead'] }) };
  const sub = card('sub', { stageId: 'doing', agentIds: ['w1'], parentCardId: 'lead-card' });
  const other = card('other', { stageId: 'doing', agentIds: ['w2'], parentCardId: 'lead-card' });
  const check = card('check', { stageId: 'doing', agentIds: ['lead'], title: '총괄 확인' });
  const plain = card('plain', { stageId: 'todo' });
  const linked = linkStages(stages.map(s => ({ ...s, cards: [lead, sub, other, check, plain].filter(c => c.stageId === s.stageId) })));
  const all = linked.flatMap(s => s.cards), head = all.find(c => c.id === 'lead-card');
  assert.deepEqual(head.family, { total: 2, open: 2 }, 'the counts are as they were');
  assert.deepEqual(head.crew.members.map(c => c.id), ['sub', 'other']);
  assert.deepEqual(head.crew.own.map(c => c.id), ['check'], 'the lead agent\'s other card');
  assert.equal(all.find(c => c.id === 'plain').crew, undefined);
  assert.deepEqual(all.filter(c => inFocus(c, 'lead-card', ['sub'])).map(c => c.id).sort(), ['lead-card', 'sub']);
  assert.deepEqual(all.filter(c => inFocus(c, 'lead-card')).map(c => c.id).sort(), ['lead-card', 'other', 'sub'], 'no part: the family');
  assert.deepEqual(all.filter(c => inFocus(c, 'lead-card', ['check'])).map(c => c.id).sort(), ['check', 'lead-card'], 'a check card that is no sub-card');
  // A part's cards cut off behind "+N" open that column, as a family's do.
  const cells = [{ stageId: 'doing', cards: [plain], matching: [plain, plain, plain, check] }];
  const next = revealFamily({}, { board: { summary: { id: 'b' } }, cells, collapsed: false }, 'lead-card', false, ['check']);
  assert.deepEqual(next.b.steps, { doing: 1 });
  assert.equal(cardDimensions(false, 1, false, true).minHeight - cardDimensions(false).minHeight, 44, 'the family line and the status row');
});
// ---- research/166: the v0.1.32 gate's findings ----
test('research/166 D1 awaiting you is the card\'s own "Response needed": an agent asking for a permission counts, whatever the ledger says', () => {
  const asking = card('p', { stageId: 'doing', agentIds: ['w1', 'w2'] }), plain = card('q', { stageId: 'doing', agentIds: ['w3'] });
  const signals = read({ w2: 'permission', w3: 'working' });
  assert.equal(askingAgent(asking.agentIds, signals), 'w2');
  assert.equal(needsReply(asking, stages, signals), true, 'no awaiting in the ledger, yet a permission waits');
  assert.equal(needsReply(plain, stages, signals), false);
  assert.equal(needsReply(card('u', { awaiting: 'user' }), stages, read({})), true, 'the ledger\'s awaited user still counts');
  assert.equal(needsReply(card('d', { stageId: 'done', awaiting: 'user' }), stages, read({})), false, 'a done card waits for nobody');
  const status = leadStatus({ members: [asking, plain], own: [], stages, read: signals, now: NOW });
  assert.deepEqual(status.awaiting, ['p'], 'awaiting you 1');
  assert.deepEqual(status.running, ['q'], 'a permission wait is no running part');
  assert.deepEqual(statusIds(status, 'awaiting'), ['p'], 'and its press rings that card');
});
test('research/166 J3 the lead\'s own agent at work, nothing else to say: working, with its last activity', () => {
  const input = { members: [card('a', { agentIds: ['w1'] })], own: [], stages, activeAt: '2026-09-27T12:48:00.000Z', now: NOW };
  const busy = leadStatus({ ...input, read: read({ lead: 'working' }), leadAgentIds: ['lead'] });
  assert.deepEqual([busy.idle, busy.working], ['21:48', true]);
  assert.deepEqual([leadStatus({ ...input, read: read({ lead: 'idle' }), leadAgentIds: ['lead'] }).working], [false]);
  const parts = leadStatus({ ...input, read: read({ lead: 'working', w1: 'working' }), leadAgentIds: ['lead'] });
  assert.deepEqual([parts.running, parts.idle, parts.working], [['a'], null, false], 'a part wins; no idle line at all');
  assert.equal(copy('en').statusWorking('21:48'), 'Working · last activity 21:48');
  assert.equal(copy('ko').statusWorking('21:48'), '작업 중 · 마지막 활동 21:48');
});
test('research/166 J2 a phone\'s tab after a part\'s press: kept while it lists one of the cards, else the first one\'s', () => {
  const cells = [{ stageId: 'todo', matching: [{ id: 'x' }] }, { stageId: 'doing', matching: [{ id: 'y' }, { id: 'z' }] },
    { stageId: 'review', matching: [{ id: 'lead' }, { id: 'w' }] }, { stageId: 'done', matching: [] }];
  assert.equal(focusTab(cells, 'review', ['z', 'x']), 'doing', 'none here: the first card\'s tab');
  assert.equal(focusTab(cells, 'review', ['x', 'w']), null, 'one of them here: kept');
  assert.equal(focusTab(cells, 'review', ['gone']), null, 'none listed anywhere (filtered out): kept');
});
