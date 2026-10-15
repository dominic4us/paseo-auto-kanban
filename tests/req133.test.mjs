// REQ-133 (research/264 J7·J1): the lead's own wait says what it wants — "Awaiting answer" (a question or a permission),
// "Awaiting review" (a finished turn not looked at yet) or "Error" — and each state is timed from the host's own start
// where it gives one (`hostSince`). The screens are exercised in tests/plugin-ui.test.mjs ("REQ-133 …") and
// tests/web/run.mjs ("REQ-133").
import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitingShown, LEAD_WAITS, leadSelf, leadStatus, selfWaits } from '../dist/client/lead-status.js';
import { HOST_TIME_AHEAD_MS, hostSince, signalBucket } from '../dist/client/signal-model.js';
import { copy } from '../dist/client/i18n.js';

const NOW = Date.parse('2026-10-03T03:00:00.000Z');
const M = 60_000;
const at = minutesAgo => new Date(NOW - minutesAgo * M).toISOString();
const read = map => id => map[id] ?? 'unknown';
const stages = [{ stageId: 'todo', countsAsDone: false }, { stageId: 'doing', countsAsDone: false }, { stageId: 'done', countsAsDone: true }];

test('REQ-133 each wait has its own kind, the most urgent first: an error, then a question, then a turn to look at', () => {
  assert.deepEqual(LEAD_WAITS, ['error', 'asking', 'unseen']);
  const base = { leadAgentIds: ['a', 'b'], activeAt: at(30) };
  assert.deepEqual(leadSelf({ ...base, read: read({ a: 'attention', b: 'permission' }) }), { kind: 'asking', since: at(30), agent: 'b' });
  assert.deepEqual(leadSelf({ ...base, read: read({ a: 'permission', b: 'error' }) }), { kind: 'error', since: at(30), agent: 'b' });
  assert.deepEqual(leadSelf({ ...base, read: read({ a: 'working', b: 'attention' }) }).kind, 'unseen');
  assert.deepEqual(leadSelf({ ...base, read: read({ a: 'working', b: 'idle' }) }).agent, 'a');
  for (const [kind, waits] of [['working', false], ['asking', true], ['unseen', true], ['error', true], ['rest', false]])
    assert.equal(selfWaits({ kind, since: '', agent: '' }), waits, kind);
  assert.equal(selfWaits(null), false);
});

test('REQ-133 "Awaiting you" leaves out the lead\'s own wait only while its mark says "Awaiting answer"', () => {
  const input = { members: [], own: [], stages, lead: { id: 'lead-card' }, leadAgentIds: ['a', 'b'], now: NOW };
  // One agent asks, another stopped on an error: the mark says "Error", so the question is still counted.
  const both = leadStatus({ ...input, read: read({ a: 'permission', b: 'error' }) });
  assert.deepEqual([both.me.kind, both.self, both.awaiting, awaitingShown(both)], ['error', true, ['lead-card'], 1]);
  const asking = leadStatus({ ...input, read: read({ a: 'permission', b: 'attention' }) });
  assert.deepEqual([asking.me.kind, awaitingShown(asking)], ['asking', 0]);
  for (const kind of ['unseen', 'error', 'working', 'rest'])
    assert.equal(awaitingShown({ ...asking, me: { kind, since: '', agent: 'a' } }), 1, kind);
});

test('REQ-133 hostSince: a running turn\'s start, an attention\'s time of the same reason — none else, none far ahead or unreadable', () => {
  const run = { status: 'running', activeTurn: { turnId: 't', startedAt: at(12) }, attentionReason: 'finished', attentionTimestamp: at(40) };
  assert.equal(hostSince(run, signalBucket(run), NOW), at(12), 'at work: the turn, not an older attention');
  const look = { status: 'idle', requiresAttention: true, attentionReason: 'finished', attentionTimestamp: at(7), activeTurn: { startedAt: at(20) } };
  assert.equal(hostSince(look, signalBucket(look), NOW), at(7));
  const ask = { status: 'running', pendingPermissions: [{}], attentionReason: 'permission', attentionTimestamp: at(3), activeTurn: { startedAt: at(9) } };
  assert.equal(hostSince(ask, signalBucket(ask), NOW), at(3), 'asking: the question\'s time, not the turn\'s');
  const fail = { status: 'error', attentionReason: 'error', attentionTimestamp: at(4) };
  assert.equal(hostSince(fail, signalBucket(fail), NOW), at(4));
  // Another reason's time, or none.
  assert.equal(hostSince({ ...ask, attentionReason: 'finished' }, 'permission', NOW), undefined);
  assert.equal(hostSince({ status: 'error', attentionReason: null, attentionTimestamp: at(4) }, 'error', NOW), undefined);
  assert.equal(hostSince({ status: 'running' }, 'working', NOW), undefined, 'an older host: no field');
  assert.equal(hostSince({ status: 'running', activeTurn: null }, 'working', NOW), undefined);
  assert.equal(hostSince({ status: 'running', activeTurn: { startedAt: null } }, 'working', NOW), undefined);
  for (const bucket of ['idle', 'unknown', 'orphaned']) assert.equal(hostSince({ ...run, ...look }, bucket, NOW), undefined, bucket);
  assert.equal(hostSince(null, 'working', NOW), undefined);
  // Not believed: unreadable, empty, a number, before 2020, over a minute ahead; a little ahead is kept as it is.
  for (const startedAt of ['yesterday', '', 1759460000000, '1970-01-01T00:00:00.000Z', '2019-12-31T23:59:59.000Z',
    new Date(NOW + HOST_TIME_AHEAD_MS + 1000).toISOString()])
    assert.equal(hostSince({ status: 'running', activeTurn: { startedAt } }, 'working', NOW), undefined, JSON.stringify(startedAt));
  const soon = new Date(NOW + 30_000).toISOString();
  assert.equal(hostSince({ status: 'running', activeTurn: { startedAt: soon } }, 'working', NOW), soon);
  assert.equal(hostSince({ status: 'running', activeTurn: { startedAt: '2026-10-03T11:48:00+09:00' } }, 'working', NOW), at(12), 'read in any zone, said in UTC');
});

test('REQ-133 words: ko/en for each wait and its press', () => {
  const en = copy('en'), ko = copy('ko');
  assert.equal(en.leadSelfAsking(en.busyAge({ unit: 'minute', count: 5 })), 'Needs your answer · 5m');
  assert.equal(en.leadSelfUnseen(en.busyAge({ unit: 'now' })), 'Ready to check · <1m');
  assert.equal(en.leadSelfError(''), 'Error');
  assert.equal(ko.leadSelfAsking(ko.busyAge({ unit: 'minute', count: 5 })), '답변 대기 · 5분');
  assert.equal(ko.leadSelfUnseen(ko.busyAge({ unit: 'minute', count: 12 })), '확인 대기 · 12분');
  assert.equal(ko.leadSelfError(ko.busyAge({ unit: 'hour', count: 2 })), '오류 · 2시간');
  assert.equal(en.leadSelfOpen('Error · 4m', 'Lead card'), 'Error · 4m: open the chat of Lead card');
  assert.equal(ko.leadSelfOpen('확인 대기 · 7분', '총괄 카드'), '확인 대기 · 7분 — 채팅 열기: 총괄 카드');
  assert.equal('leadSelfTurn' in en || 'leadSelfTurn' in ko, false, 'no "Your turn" left');
});
