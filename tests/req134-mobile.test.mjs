// REQ-134 (research/267 WA·MA, the owner's choices): the phone's workflow sheet and message list. The pure parts here — the
// ladder (`ladderItems`: the steps top to bottom, side steps and the loop in place) and the table's marks (`cellMark`) over what
// the real server reader makes of the made-up gated workspace, and the phone's wiring read from its source (the ⋯ entry only
// with a definition, the top-bar glyph only with the lab on and a folder set, the lane badge opening the list filtered). The
// screens are in tests/web/run.mjs (=req134). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cellMark, ladderItems, tableStages } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';
import { readWorkflow } from '../dist/server/workflow.js';
import { gateDefinition, gateFiles, otherDefinition, otherFiles, writeWorkspace } from './fixtures/workflow-fixtures.mjs';

const words = m => ({ verdict: { pass: m.verdictPass, conditional: m.verdictConditional, fail: m.verdictFail, unknown: m.verdictUnknown },
  stateNoRecord: m.stateNoRecord, stateNoSource: m.stateNoSource, stateUnknown: m.stateUnknown, titleUnread: m.titleUnread,
  statePerson: m.statePerson, firstRound: m.firstRound, countFound: m.countFound, loopNone: m.loopNone, loopTimes: m.loopTimes,
  timesShort: m.timesShort, resultNotOk: m.resultNotOk, resultMissing: m.resultMissing });
const W = words(copy('ko'));
async function read(t, definition, files) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'kanban-req134-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const model = await readWorkflow(await writeWorkspace(dir, definition, files), { now: () => new Date('2026-03-03T07:00:00.000Z') });
  assert.equal(model.defined, true);
  return model;
}
const release = (model, v) => model.releases.find(r => r.release === v);
const ids = items => items.map(v => v.kind === 'loop' ? 'loop:' + v.edge.from + '-' + v.edge.to : (v.side ? 'side:' : '') + v.stage.id);

test('REQ-134 WA the ladder: the first row on it in order, other rows beside their column, the loop after its start', async t => {
  const model = await read(t, gateDefinition, gateFiles);
  const items = ladderItems(model, release(model, '0.2.6'), W);
  assert.deepEqual(ids(items), ['req', 'impl', 'gate', 'pass', 'side:fix', 'loop:fix-gate', 'commit', 'stable', 'side:phone', 'tester']);
  const at = id => items.find(v => v.kind === 'step' && v.stage.id === id);
  assert.equal(at('gate').note, '60 불통과 → 조건부', 'the verdicts on the way, as the wide node says them');
  assert.equal(at('pass').via, '예 → 커밋 · 아니오 → 수정', 'a decision says its ways out');
  assert.equal(at('fix').via, '아니오', 'a side step says the edge into it');
  assert.equal(at('phone').note, W.stateNoSource + ' · ' + W.statePerson);
  assert.ok(at('phone').dashed && at('phone').outlined, 'a person\'s step: dashed, nothing to read');
  assert.ok(at('gate').passed && at('commit').passed && !at('tester').passed, '0.2.6 got to the stable, not to a tester');
  assert.match(at('gate').chip, /^1차 6/);
  const loop = items.find(v => v.kind === 'loop');
  assert.equal(loop.to.id, 'gate');
  assert.equal(loop.loops.length, 1);
  assert.match(loop.text, /^재게이트 1회: \d+→\d+$/);
  // 0.2.4 went back twice; 0.2.3 not at all (the loop quiet, its label alone).
  assert.equal(ladderItems(model, release(model, '0.2.4'), W).find(v => v.kind === 'loop').loops.length, 2);
  const quiet = ladderItems(model, release(model, '0.2.3'), W).find(v => v.kind === 'loop');
  assert.deepEqual([quiet.loops.length, quiet.text], [0, '재게이트']);
  // No release read yet: the steps all there, none passed.
  assert.ok(ladderItems(model, undefined, W).every(v => v.kind === 'loop' || !v.passed));
});

test('REQ-134 WA the table\'s marks: ✓ △ × ? – and a figure for rounds, the words kept for the label', async t => {
  const model = await read(t, gateDefinition, gateFiles), stages = tableStages(model);
  assert.equal(stages.length, 7, 'seven steps a row — 44px each fits 390');
  const row = v => stages.map(s => cellMark(release(model, v), s, W).mark);
  assert.deepEqual(row('0.2.6'), ['✓', '✓', '2', '✓', '△', '✓', '–'], 'two gate rounds; the commit title unread; no tester');
  assert.deepEqual(row('0.2.5'), ['✓', '✓', '✓', '–', '✓', '✓', '✓']);
  const gate = stages.find(s => s.id === 'gate');
  assert.deepEqual(['0.2.1', '0.2.2'].map(v => cellMark(release(model, v), gate, W).mark), ['×', '?'], 'failed; unknown format');
  const two = cellMark(release(model, '0.2.6'), gate, W);
  assert.equal(two.tone, 'conditional', 'a figure takes the last verdict\'s colour');
  assert.equal(two.text, '60 불통과 → 62 조건부', 'the wide table\'s words, for the label and the evidence');
  const none = cellMark(release(model, '0.2.6'), stages.find(s => s.id === 'tester'), W);
  assert.deepEqual([none.mark, none.tone, none.state], ['–', 'muted', 'no-record']);
  // Another field with no gate (REQ-125's shape) reads the same way.
  const other = await read(t, otherDefinition, otherFiles);
  for (const r of other.releases) for (const s of tableStages(other)) assert.match(cellMark(r, s, W).mark, /^(✓|△|×|\?|–|\d+)$/);
});

test('REQ-134 the phone\'s wiring: the ⋯ entry with a definition, the glyph with the lab and a folder, the badge filtered', async () => {
  const src = await fs.readFile(new URL('../client/mobile-swimlane.tsx', import.meta.url), 'utf8');
  assert.match(src, /onWorkflow=\{!preview && offersWorkflow\(lane\.board\) \?/, 'only a lane whose workspace holds a definition');
  assert.match(src, /const mailboxOn = !preview && !!source\.settings\.labs\.mail && !!source\.settings\.labs\.mailDir;/, 'the wide rule');
  assert.match(src, /\{mailboxOn && <IconButton testID="mailbox-button"/);
  assert.match(src, /onOpen=\{mailboxOn \? \(\) => openMailbox\(mailAlias\(lane\.board\.summary\.cwd, source\.mailAlias\)/);
  assert.doesNotMatch(src, /lane-view-switch|LaneViewSwitch/, 'no glyph added to the 390 heading');
  const menu = await fs.readFile(new URL('../client/order-menu.tsx', import.meta.url), 'utf8');
  const wide = menu.slice(menu.indexOf('if (!mobile && platform === \'web\')'), menu.indexOf('return <>\n    <IconButton name="Ellipsis" testID={testID} plain colors={colors} mobile={mobile}'));
  assert.doesNotMatch(wide, /onWorkflow/, 'the wide popover has no "Show workflow"');
  for (const locale of ['ko', 'en']) {
    const m = copy(locale);
    for (const key of ['workflowShow', 'workflowMarksTitle', 'workflowMarksLegend', 'mailBack']) assert.ok(m[key], locale + ' ' + key);
    assert.ok(m.workflowSheet('x').endsWith('x') && m.mailShowThreads(3).includes('3') && m.workflowLoopTo('게이트').includes('게이트'));
  }
  assert.equal(copy('ko').workflowLoopTo('게이트'), '게이트로 되돌아감');
});
