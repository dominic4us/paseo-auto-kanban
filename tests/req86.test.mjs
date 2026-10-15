// REQ-86 (the owner's choice, research/128 ④C·⑤W2): a card in the progress or review column says how long it has sat
// there — a clock and "14h" on line two's right, from an hour on — and past the limit an orange ⚠ with the whole time
// ("15시간째"): review 12h, progress 2h with no linked agent at work (a permission wait excepted). When it entered comes
// from the ledger's movement records (the server's read), its last change where those were cut off. Never counted as
// needing attention. The screens are exercised in plugin-ui.test.mjs ("REQ-86") and tests/web/run.mjs (real input).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DWELL, dwellKind, quietSince, stageDwell } from '../dist/client/stage-time.js';
import { copy } from '../dist/client/i18n.js';
import { enteredOf, stageEntries, stageEntry, toBoardDTO, toOverview } from '../dist/server/read-model.js';
import { applyOperations, builtinTemplate } from '../dist/shared/core/domain.js';
import { board, add, context, actor } from './helpers.mjs';

const stages = builtinTemplate('ko').stages;
const NOW = Date.parse('2026-09-28T04:00:00.000Z'), H = 3600_000;
const ago = hours => new Date(NOW - hours * H).toISOString();
const card = (stageId, hours, extra = {}) => ({ stageId, agentIds: [], stageEnteredAt: ago(hours), updatedAt: ago(0.1), ...extra });
const signals = (map = {}, active = {}, ready = true) => ({ read: id => map[id] ?? 'unknown', activity: id => active[id], ready });

test('REQ-86 columns: the progress and review ones only — never waiting or done', () => {
  assert.deepEqual(stages.map(s => dwellKind(s.stageId, stages)), [null, 'progress', 'review', null]);
  assert.equal(dwellKind('gone', stages), null, 'a stage the template no longer has');
  // A template of its own: the second column follows the progress rule, any later one before done the review rule.
  const custom = ['a', 'b', 'c', 'd', 'e'].map((stageId, i) => ({ stageId, countsAsDone: i === 4 }));
  assert.deepEqual(custom.map(s => dwellKind(s.stageId, custom)), [null, 'progress', 'review', 'review', null]);
  for (const stageId of ['todo', 'done']) assert.equal(stageDwell(card(stageId, 30), stages, signals(), NOW), null, stageId);
});
test('REQ-86 shown from an hour on; the words in the card\'s units, "째" once past the limit (ko), "14h" (en)', () => {
  assert.equal(stageDwell(card('review', 0.9), stages, signals(), NOW).shown, false, 'under an hour: the age stays');
  const d = stageDwell(card('review', 1), stages, signals(), NOW);
  assert.deepEqual([d.kind, d.shown, d.warn, d.ms, d.age], ['review', true, false, H, { unit: 'hour', count: 1 }]);
  const m = copy('en'), k = copy('ko');
  assert.equal(m.dwell({ unit: 'hour', count: 14 }, false), '14h');
  assert.equal(m.dwell({ unit: 'hour', count: 15 }, true), '15h');
  assert.equal(m.dwell({ unit: 'day', count: 2 }, false), '2d');
  assert.equal(k.dwell({ unit: 'hour', count: 14 }, false), '14시간');
  assert.equal(k.dwell({ unit: 'hour', count: 15 }, true), '15시간째', 'W2 (14:1x): the whole time, "째"');
  assert.equal(k.dwell({ unit: 'day', count: 2 }, true), '2일째');
  assert.equal(m.dwellEntered('09-28 04:10', false), 'Entered this stage 09-28 04:10');
  assert.equal(k.dwellEntered('09-28 04:10', true), '이 칸에 들어온 시각 09-28 04:10 (추정)');
  // A clock ahead of this device never reads as a negative time.
  assert.equal(stageDwell(card('review', -1), stages, signals(), NOW).ms, 0);
});
test('REQ-86 review: a warning from 12 hours in the column, whatever its agents do', () => {
  assert.equal(stageDwell(card('review', 11.9), stages, signals(), NOW).warn, false);
  assert.equal(stageDwell(card('review', 12), stages, signals(), NOW).warn, true);
  assert.equal(stageDwell(card('review', 14, { agentIds: ['w'] }), stages, signals({ w: 'working' }), NOW).warn, true);
  assert.equal(DWELL.review, 12 * H);
});
test('REQ-86 progress: 2 hours with no linked agent at work — finished, unknown or none; a permission wait is not counted', () => {
  const warn = (extra, map, active, ready) => stageDwell(card('doing', 5, extra), stages, signals(map, active, ready), NOW).warn;
  assert.equal(warn({}), true, 'no agent at all');
  assert.equal(warn({ agentIds: ['w'] }, { w: 'idle' }), true, 'finished');
  assert.equal(warn({ agentIds: ['w'] }, { w: 'unknown' }), true, 'status unavailable');
  assert.equal(warn({ agentIds: ['w'] }, { w: 'error' }), true);
  assert.equal(warn({ agentIds: ['w'] }, { w: 'attention' }), true, 'finished, not yet seen');
  assert.equal(warn({ agentIds: ['w', 'x'] }, { w: 'idle', x: 'working' }), false, 'one at work is enough');
  assert.equal(warn({ agentIds: ['w'] }, { w: 'permission' }), false, 'asking: already orange ("Response needed")');
  assert.equal(warn({ agentIds: ['w'] }, { w: 'idle' }, {}, false), false, 'nothing is said before the agents are read');
  assert.equal(warn({}, {}, {}, false), true, 'no agent: nothing to wait for');
  // From the later of entering and the agents' last activity.
  assert.equal(warn({ agentIds: ['w'] }, { w: 'idle' }, { w: ago(1.9) }), false, 'last active 1.9h ago');
  assert.equal(warn({ agentIds: ['w', 'x'] }, {}, { w: ago(3), x: ago(2.5) }), true, 'both quiet for over 2h');
  assert.equal(warn({ agentIds: ['w'] }, { w: 'idle' }, { w: ago(9) }), true, 'active before it entered: entering counts');
  assert.equal(stageDwell(card('doing', 1.5), stages, signals(), NOW).warn, false, 'in the column 1.5h: not yet');
  assert.equal(quietSince({ agentIds: ['w'] }, NOW - 5 * H, signals({ w: 'idle' }, { w: 'not a time' })), NOW - 5 * H);
  assert.equal(quietSince({ agentIds: ['w'] }, NOW - 5 * H, signals({ w: 'working' })), null);
  // A long run is no warning: the words stay muted while the agent works.
  const long = stageDwell(card('doing', 30, { agentIds: ['w'] }), stages, signals({ w: 'working' }), NOW);
  assert.deepEqual([long.shown, long.warn, long.age], [true, false, { unit: 'day', count: 1 }]);
});
test('REQ-86 estimated: the server says so where the record was cut off; an older server\'s card reads its last change', () => {
  assert.equal(stageDwell(card('review', 3), stages, signals(), NOW).estimated, false);
  assert.equal(stageDwell(card('review', 3, { stageEnteredEstimated: true }), stages, signals(), NOW).estimated, true);
  const old = stageDwell({ stageId: 'review', agentIds: [], updatedAt: ago(13) }, stages, signals(), NOW);
  assert.deepEqual([old.enteredAt, old.estimated, old.warn], [ago(13), true, true]);
  assert.equal(stageDwell({ stageId: 'review', agentIds: [] }, stages, signals(), NOW), null, 'no time at all: nothing');
});

// ---- the server: stageEnteredAt from the movement records ----
const T = minute => new Date(Date.parse('2026-09-27T00:00:00.000Z') + minute * 60000).toISOString();
function moved() {
  let value = board();
  value = applyOperations(value, [{ ...add('Moved card'), stageId: 'todo' }], actor, context(T(0))).board;
  const id = value.cards[0].id;
  value = applyOperations(value, [{ op: 'move', id, to: 'doing' }], actor, context(T(10))).board;
  value = applyOperations(value, [{ op: 'update', id, patch: { notes: 'Edited later' } }], actor, context(T(30))).board;
  value = applyOperations(value, [{ op: 'move', id, to: 'review' }], actor, context(T(60))).board;
  value = applyOperations(value, [{ op: 'update', id, patch: { nextAction: 'Look at it' } }], actor, context(T(90))).board;
  return { value, id };
}
const dtoCard = (dto, id) => dto.stages.flatMap(s => s.cards).find(c => c.id === id);
test('REQ-86 read model: the latest record that took the card to its stage, not its last change; nothing new in the ledger', () => {
  const { value, id } = moved();
  const before = JSON.stringify(value);
  const c = dtoCard(toBoardDTO(value, 'en'), id);
  assert.equal(c.stageEnteredAt, T(60), 'entered review at its move, though changed after');
  assert.equal(c.updatedAt, T(90));
  assert.equal('stageEnteredEstimated' in c, false);
  // Back and forth: the last entry counts.
  let again = applyOperations(value, [{ op: 'move', id, to: 'doing' }], actor, context(T(100))).board;
  again = applyOperations(again, [{ op: 'move', id, to: 'review' }], actor, context(T(120))).board;
  assert.equal(dtoCard(toBoardDTO(again, 'en'), id).stageEnteredAt, T(120));
  assert.equal(JSON.stringify(value), before, 'the ledger is only read');
  assert.deepEqual(Object.keys(value.history[0]).sort(), ['actor', 'at', 'cardId', 'from', 'revision', 'to'], 'the record\'s shape is the ledger\'s');
  // The attention list carries the same field, and its count is the ledger's rule alone.
  const overview = toOverview([again], 'en', T(200));
  assert.equal(overview.boards[0].needsHuman, 0, 'a card long in review is not "needs attention"');
});
test('REQ-86 read model: a record cut off by the 1000 limit — the card\'s last change, marked estimated', () => {
  let value = board();
  value = applyOperations(value, [{ ...add('Old card'), stageId: 'review' }], actor, context(T(0))).board;
  const old = value.cards[0].id;
  value = applyOperations(value, [{ op: 'update', id: old, patch: { notes: 'Touched' } }], actor, context(T(5))).board;
  // 1000 later moves of another card push the old card's record out (the ledger keeps the last 1000).
  value = applyOperations(value, [add('Busy card')], actor, context(T(6))).board;
  const busy = value.cards[1].id;
  for (let i = 0; i < 1000; i++) value = applyOperations(value, [{ op: 'move', id: busy, to: i % 2 ? 'todo' : 'doing' }], actor, context(T(7 + i))).board;
  assert.equal(value.history.length, 1000);
  assert.equal(value.history.some(h => h.cardId === old), false, 'its record is gone');
  // REQ-108: the card now says its own entry (tests/req108.test.mjs); a ledger written before it says nothing.
  value = { ...value, cards: value.cards.map(({ stageEnteredAt: _, ...card }) => card) };
  const c = dtoCard(toBoardDTO(value, 'en'), old);
  assert.deepEqual([c.stageEnteredAt, c.stageEnteredEstimated], [T(5), true], 'its last change, estimated');
  assert.deepEqual(stageEntry(new Map(), { id: 'x', stageId: 'review', updatedAt: T(1) }), { at: T(1), estimated: true });
  assert.deepEqual(enteredOf({ at: T(1), estimated: false }), { stageEnteredAt: T(1) });
});
test('REQ-86 read model: the fold is kept per board and revision, and redone after a change', () => {
  const { value, id } = moved();
  const first = stageEntries(value);
  assert.equal(stageEntries(value), first, 'the same read: not walked again');
  assert.equal(stageEntries({ ...value }), first, 'the same object\'s history at the same revision');
  const next = applyOperations(value, [{ op: 'move', id, to: 'doing' }], actor, context(T(150))).board;
  const second = stageEntries(next);
  assert.notEqual(second, first);
  assert.equal(stageEntry(second, next.cards[0]).at, T(150));
  // The same id and revision with another history (a board rebuilt in memory) is walked again, never read stale.
  assert.notEqual(stageEntries({ ...value, history: [...value.history] }), first);
});
