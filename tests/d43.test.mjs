/**
 * D43 (research/198, research/200): the lead asking you itself — a question (AskUserQuestion, a permission of kind
 * "question") or any permission of its own agent — reads "Awaiting you" on its status row, never idle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadStatus, statusIds } from '../dist/client/lead-status.js';
import { builtinTemplate } from '../dist/shared/core/domain.js';

const stages = builtinTemplate('ko').stages;
const NOW = Date.parse('2026-09-27T12:50:00.000Z');
const card = (id, extra = {}) => ({ id, title: 'Card ' + id, stageId: 'todo', nextAction: '', awaiting: null, agentIds: [], blocked: false,
  intent: 'requested', updatedAt: '2026-09-27T12:00:00.000Z', ...extra });
const read = map => id => map[id] ?? 'unknown';
const base = { own: [], stages, lead: { id: 'lead-card' }, leadAgentIds: ['lead'], activeAt: '2026-09-27T12:48:00.000Z', now: NOW };

test('D43 the lead\'s own agent asking, its sub-cards quiet: awaiting you 1 (the lead\'s card), neither idle nor working', () => {
  const status = leadStatus({ ...base, members: [card('a', { agentIds: ['w1'] })], read: read({ lead: 'permission', w1: 'idle' }) });
  assert.deepEqual([status.awaiting, status.self], [['lead-card'], true]);
  assert.deepEqual([status.idle, status.working, status.running, status.testing], [null, false, [], null]);
  assert.deepEqual(statusIds(status, 'awaiting'), ['lead-card'], 'its press has the lead\'s card alone');
});
test('D43 with sub-cards awaiting too: counted together, the lead once and first', () => {
  const members = [card('a', { agentIds: ['w1'] }), card('b', { awaiting: 'user' }), card('c', { agentIds: ['w3'] })];
  const status = leadStatus({ ...base, members, read: read({ lead: 'permission', w1: 'permission', w3: 'working' }) });
  assert.deepEqual(status.awaiting, ['lead-card', 'a', 'b'], 'awaiting you 3');
  assert.deepEqual(status.running, ['c'], 'the parts stand side by side, as before');
  assert.deepEqual(statusIds(status, 'awaiting'), ['a', 'b'], 'its press rings the sub-cards (the lead\'s card rings anyway)');
  // A lead with two agents, one at work and one asking: it asks — one agent is in one bucket, never both.
  const two = leadStatus({ ...base, members: [], leadAgentIds: ['lead', 'lead2'], read: read({ lead: 'working', lead2: 'permission' }) });
  assert.deepEqual([two.awaiting, two.idle, two.working], [['lead-card'], null, false]);
});
test('D43 regressions: working and idle as they were; no lead card given, nothing counted for it', () => {
  const members = [card('a', { agentIds: ['w1'] })];
  const busy = leadStatus({ ...base, members, read: read({ lead: 'working' }) });
  assert.deepEqual([busy.awaiting, busy.idle, busy.working], [[], '21:48', true]);
  const idle = leadStatus({ ...base, members, read: read({ lead: 'idle' }) });
  assert.deepEqual([idle.awaiting, idle.idle, idle.working], [[], '21:48', false]);
  const unknown = leadStatus({ ...base, members, read: read({}) });
  assert.deepEqual([unknown.awaiting, unknown.idle], [[], '21:48'], 'an agent not read yet asks nothing');
  const { lead: _lead, ...bare } = base;
  assert.deepEqual(leadStatus({ ...bare, members, read: read({ lead: 'permission' }) }).awaiting, [], 'the row always has its card; without one, as before');
  // A sub-card awaiting you, the lead quiet: only it (research/166 D1).
  assert.deepEqual(leadStatus({ ...base, members, read: read({ w1: 'permission', lead: 'idle' }) }).awaiting, ['a']);
});
