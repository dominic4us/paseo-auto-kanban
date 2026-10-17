// REQ-135: a lead card's sub-cards' parts (running, waiting for you, the check) move from the status row to the family line,
// "Sub-cards N · Running N · not done N · Awaiting you N · Testing HH:MM~"; the row keeps the lead's own state and the memo.
// A narrow card says them shorter, then the check as its clock and time, then its clock alone, then leaves it out — no count
// is ever cut (`familyFit`). The screens are exercised in tests/plugin-ui.test.mjs ("REQ-135 …", "D51 …") and
// tests/web/run.mjs (KANBAN_WEB_ONLY=req135).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_FITS, familyFit, leadStatus, statusParts } from '../dist/client/lead-status.js';
import { copy } from '../dist/client/i18n.js';

const NOW = Date.parse('2026-10-03T03:00:00.000Z');
const stages = [{ stageId: 'todo', countsAsDone: false }, { stageId: 'doing', countsAsDone: false }, { stageId: 'done', countsAsDone: true }];
const card = (id, extra = {}) => ({ id, title: id, stageId: 'todo', nextAction: '', awaiting: null, agentIds: [id + '-agent'], blocked: false, intent: 'requested', ...extra });

test('REQ-135 the sub-cards\' parts in the family line\'s order: running, awaiting, the check — each left out at zero', () => {
  const read = id => ({ 'run-agent': 'working', 'lead-agent': 'idle' })[id] ?? 'idle';
  const members = [card('run'), card('wait', { awaiting: 'user' }), card('check', { busy: { text: 'Tests', since: new Date(NOW - 600000).toISOString(), by: 'cli' } })];
  const full = leadStatus({ members, own: [], stages, read, lead: { id: 'lead' }, leadAgentIds: ['lead-agent'], now: NOW });
  assert.deepEqual(statusParts(full), ['running', 'awaiting', 'testing']);
  assert.deepEqual(statusParts(leadStatus({ members: [card('wait', { awaiting: 'user' })], own: [], stages, read, lead: { id: 'lead' }, leadAgentIds: ['lead-agent'], now: NOW })), ['awaiting']);
  assert.deepEqual(statusParts(leadStatus({ members: [card('idle')], own: [], stages, read, lead: { id: 'lead' }, leadAgentIds: ['lead-agent'], now: NOW })), []);
  // The lead asking you itself: its wait is its own mark (REQ-130), not an "awaiting" part on the family line.
  const asking = leadStatus({ members: [card('idle')], own: [], stages, read: id => id === 'lead-agent' ? 'permission' : 'idle', lead: { id: 'lead' }, leadAgentIds: ['lead-agent'], now: NOW });
  assert.equal(asking.me.kind, 'asking');
  assert.deepEqual(statusParts(asking), []);
});

test('REQ-135 the narrow rule: the first fit that fits — full, short, the check\'s clock and time, its clock alone, then left out', () => {
  // research/275 F1: past 'drop', "Sub-cards" by its tree alone, then every word a letter — the counts whole at each.
  assert.deepEqual(FAMILY_FITS, ['full', 'short', 'clock', 'icon', 'drop', 'tight', 'bare']);
  const widths = { full: 320, short: 260, clock: 236, icon: 220, drop: 200, tight: 160, bare: 130 };
  assert.equal(familyFit(fit => widths[fit], 400), 'full');
  assert.equal(familyFit(fit => widths[fit], 260), 'short');
  assert.equal(familyFit(fit => widths[fit], 240), 'clock');
  assert.equal(familyFit(fit => widths[fit], 225), 'icon');
  assert.equal(familyFit(fit => widths[fit], 210), 'drop');
  assert.equal(familyFit(fit => widths[fit], 199), 'tight', 'research/275 F1: no longer the last fit');
  assert.equal(familyFit(fit => widths[fit], 140), 'bare');
  assert.equal(familyFit(fit => widths[fit], 100), 'bare', 'nothing fits: the fewest words, never a cut count');
});

test('REQ-135 the shorter words keep every count and the time whole, in Korean and English', () => {
  const en = copy('en'), ko = copy('ko');
  assert.deepEqual([en.statusRunningShort(12), en.openCountShort(3), en.statusAwaitingShort(2), en.statusTestingShort('21:40'), en.statusTestingClock('21:40')],
    ['Run 12', 'open 3', 'Needs 2', 'Test 21:40~', '21:40~']);
  assert.deepEqual([ko.statusRunningShort(12), ko.openCountShort(3), ko.statusAwaitingShort(2), ko.statusTestingShort('21:40'), ko.statusTestingClock('21:40')],
    ['실행 12', '미완 3', '대기 2', '테스트 21:40~', '21:40~']);
  assert.equal(ko.statusTestingClock(''), '테스트', 'no time known: the word, not an empty glyph');
  assert.equal(en.statusTestingShort(''), 'Test');
});
