// REQ-124 unit 2 (research/215·216·217): a lane's "Workflow" in place of REQ-103 2단계-1's big picture. The pure model
// (client/workflow-model.ts) over what the real server reader makes of two made-up workspaces (tests/fixtures/workflow-fixtures.mjs):
// the lane's button only with a definition, the flow's layout and routes, the chosen release's way and loops, the table's
// states told apart, and another field's procedure with no gate (REQ-125 ahead). The screens are in tests/plugin-ui.test.mjs
// and tests/web/run.mjs ("req124-…"). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chipLines, flowLayout, flowOverlay, FLOW, loopLabel, offersWorkflow, releaseChip, route, rowBottom, shortTime, sourceNotes,
  stageCounts, tableCell, tableStages, tableWidths, toggleLaneView, wrapWords } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';
import { readWorkflow } from '../dist/server/workflow.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { overviewGet } from '../dist/shared/rpc.js';
import { gateDefinition, gateFiles, otherDefinition, otherFiles, writeWorkspace } from './fixtures/workflow-fixtures.mjs';
import { fixture, actor } from './helpers.mjs';

const ko = copy('ko');
const W = { verdict: { pass: ko.verdictPass, conditional: ko.verdictConditional, fail: ko.verdictFail, unknown: ko.verdictUnknown },
  stateNoRecord: ko.stateNoRecord, stateNoSource: ko.stateNoSource, stateUnknown: ko.stateUnknown, titleUnread: ko.titleUnread,
  statePerson: ko.statePerson, firstRound: ko.firstRound, countFound: ko.countFound, loopNone: ko.loopNone, loopTimes: ko.loopTimes,
  timesShort: ko.timesShort, resultNotOk: ko.resultNotOk, resultMissing: ko.resultMissing };
async function read(t, definition, files) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'kanban-req124-ui-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const model = await readWorkflow(await writeWorkspace(dir, definition, files), { now: () => new Date('2026-03-03T07:00:00.000Z') });
  assert.equal(model.defined, true);
  return model;
}
const release = (model, v) => model.releases.find(r => r.release === v);
const stage = (model, id) => model.definition.stages.find(s => s.id === id);

test('REQ-124 ① the lane offers "Workflow" only when its workspace holds a definition; the choice is the session\'s', async t => {
  assert.equal(offersWorkflow({ summary: { workflow: true } }), true);
  assert.equal(offersWorkflow({ summary: {} }), false, 'no definition, no button (and an older server says nothing)');
  const on = toggleLaneView({}, 'board_a', true);
  assert.deepEqual(on, { board_a: 'workflow' });
  assert.deepEqual(toggleLaneView(on, 'board_a', false), {});
  // The server marks the board views whose folder has `.kanban/workflow.json` (one cached stat per folder), only there.
  const { store, cwd, root } = await fixture(t);
  const second = join(root, 'second'); await fs.mkdir(second);
  await store.initBoard({ cwd: second, workspaceId: 'wks_example02', actor, requestId: crypto.randomUUID() });
  await writeWorkspace(cwd, gateDefinition, {});
  const reply = overviewGet.output.parse(await createReadHandlers(store).overview({ includeBoards: true }));
  assert.equal(reply.ok, true);
  const flags = Object.fromEntries(reply.data.boardViews.map(b => [b.summary.workspaceId, b.summary.workflow ?? null]));
  assert.deepEqual(flags, { wks_example01: true, wks_example02: null });
  assert.ok(reply.data.boards.every(b => !('workflow' in b)), 'the list view\'s summaries stay as they were');
  const plain = overviewGet.output.parse(await createReadHandlers(store).overview({}));
  assert.equal(plain.ok && plain.data.boardViews, undefined, 'no board views, no reading');
});

test('REQ-124 the flow\'s layout: rows and columns in the lane\'s width, a note that does not fit takes lines, a narrow column scrolls', () => {
  const L = flowLayout(gateDefinition.stages, 1118);
  assert.equal(L.cols, 7); assert.equal(L.colW, Math.floor((1118 - 40) / 7));
  assert.equal(L.width, 1118, 'seven columns fit the 1,144px lane');
  const gate = L.at.get('gate'), fix = L.at.get('fix'), pass = L.at.get('pass');
  assert.equal(fix.top, pass.bottom + FLOW.gap, 'the second row a gap under the first row\'s tallest step (the decision)');
  assert.equal(gate.cy, pass.cy, 'a row shares one centre line');
  assert.equal(pass.cx, fix.cx, 'the decision above its "no"');
  assert.deepEqual([pass.w, pass.h], [FLOW.diamond, FLOW.diamond]);
  // research/216: at ten columns "60 불통과 → 조건부" was cut; it takes one line per part now, and the node grows.
  const ten = flowLayout(Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, label: '단계 ' + i, shape: 'box', row: 0, col: i })), 1118,
    { s4: ['60 불통과', '→ 조건부'], s6: ['6666666', ko.titleUnread] });
  assert.deepEqual(ten.at.get('s4').note, ['60 불통과', '→ 조건부']);
  assert.ok(ten.at.get('s4').h > FLOW.nodeH, 'the node grows for its second line');
  assert.deepEqual(ten.at.get('s6').note, ['6666666', '커밋 제목 못', '읽음'], 'words laid in lines, not cut');
  assert.equal(ten.at.get('s1').h, FLOW.nodeH, 'a node with no note keeps its height');
  assert.equal(new Set([...ten.at.values()].map(n => n.cy)).size, 1, 'one row, one centre line');
  const wide = flowLayout(gateDefinition.stages, 1118, { gate: ['60 불통과', '→ 조건부'] });
  assert.deepEqual(wide.at.get('gate').note, ['60 불통과 → 조건부'], 'one line where it fits');
  // Past ten columns the column keeps its floor and the flow scrolls sideways.
  const many = flowLayout(Array.from({ length: 16 }, (_, i) => ({ id: 's' + i, label: 'S' + i, shape: 'box', row: 0, col: i })), 1118);
  assert.equal(many.colW, FLOW.minCol); assert.ok(many.width > 1118);
  assert.deepEqual(wrapWords('커밋 제목 못 읽음', 75, 11), ['커밋 제목 못', '읽음']);
  assert.deepEqual(chipLines('1차 6 · 불통과 3 · 조건부 0 · 형식 모름 1', 107), ['1차 6 · 불통과 3', '조건부 0 · 형식 모름 1'], 'two even lines in a narrow column');
  assert.deepEqual(chipLines('6건', 107), ['6건']);
});

test('REQ-124 routes: straight angles; a loop up runs sideways then up; one back along its own row runs under it', () => {
  const L = flowLayout(otherDefinition.stages, 1118), at = id => L.at.get(id);
  const [forward] = route(at('grasp'), at('draft'), false);
  assert.deepEqual(forward, { x1: at('grasp').right, y1: at('grasp').cy, x2: at('draft').left, y2: at('draft').cy });
  const down = route(at('ok'), at('revise'), false);
  assert.equal(down.length, 1); assert.equal(down[0].x1, down[0].x2, 'the decision\'s "no" straight down');
  const up = route(at('revise'), at('review'), true);
  assert.deepEqual(up.map(s => s.y1 === s.y2 ? 'h' : 'v'), ['h', 'v']);
  assert.equal(up[1].y2, at('review').bottom, 'into the step\'s bottom');
  const under = rowBottom(L, 0), along = route(at('reply'), at('grasp'), true, 0, under);
  assert.equal(along.length, 3);
  assert.ok(along[1].y1 > under, 'under the row, through no step');
  assert.equal(along[2].y2, at('grasp').bottom);
});

test('REQ-124 the chosen release over the flow: its way (a decision between two steps passed), its loops, its notes', async t => {
  const model = await read(t, gateDefinition, gateFiles);
  const edge = (from, to) => model.definition.edges.findIndex(e => e.from === from && e.to === to);
  const back = edge('fix', 'gate');
  const r6 = flowOverlay(model.definition, release(model, '0.2.6'), W);
  assert.deepEqual([...r6.passed].sort(), ['commit', 'fix', 'gate', 'impl', 'pass', 'req', 'stable']);
  assert.ok(r6.hot.has(edge('gate', 'pass')) && r6.hot.has(edge('pass', 'fix')) && r6.hot.has(edge('pass', 'commit')));
  assert.ok(!r6.hot.has(edge('stable', 'tester')), 'no tester this release');
  assert.deepEqual(r6.loops.get(back), [{ from: 61, to: 62, verdict: 'conditional' }]);
  assert.equal(loopLabel(model.definition.edges[back], r6.loops.get(back), W), '재게이트 1회: 61→62');
  assert.deepEqual(r6.notes.gate, ['60 불통과', '→ 조건부'], 'where it began, where it ended — the reports\' own words');
  assert.deepEqual(r6.notes.commit, ['6666666', '커밋 제목 못 읽음'], 'the stable hash, said as such');
  assert.deepEqual(r6.notes.tester, ['기록 없음']);
  assert.equal(r6.states.phone, 'no-source');
  const r4 = flowOverlay(model.definition, release(model, '0.2.4'), W);
  assert.deepEqual(r4.loops.get(back), [{ from: 51, to: 52, verdict: 'fail' }, { from: 53, to: 54, verdict: 'pass' }]);
  assert.equal(loopLabel(model.definition.edges[back], r4.loops.get(back), W), '재게이트 2회: 51→52 · 53→54');
  const r5 = flowOverlay(model.definition, release(model, '0.2.5'), W);
  assert.deepEqual(r5.loops.get(back), [], 'passed first time: no loop');
  assert.ok(!r5.passed.has('fix') && !r5.hot.has(edge('pass', 'fix')) && r5.hot.has(edge('stable', 'tester')));
  const r1 = flowOverlay(model.definition, release(model, '0.2.1'), W);
  assert.deepEqual(r1.loops.get(back), [{ from: 36 }], 'fixed, committed without a second gate: an open round');
  assert.equal(loopLabel(model.definition.edges[back], r1.loops.get(back), W), '재게이트 1회: 36→없음');
  const r2 = flowOverlay(model.definition, release(model, '0.2.2'), W);
  assert.deepEqual(r2.notes.gate, ['40 형식 모름']);
  assert.ok(r2.passed.has('pass'), 'its verdict unread, yet it went on to a commit: the decision is drawn passed, its note says the format');
  const none = flowOverlay(model.definition, undefined, W);
  assert.equal(none.passed.size, 0); assert.deepEqual(none.notes, {});
  // The counts over the releases shown; a step with nothing to read has no count — its node says so.
  const counts = stageCounts(model, W);
  assert.equal(counts.gate, '1차 6 · 불통과 3 · 조건부 0 · 형식 모름 1');
  assert.equal(counts.req, '6건'); assert.equal(counts.commit, '5건'); assert.equal(counts.tester, '1건');
  assert.equal(counts.phone, undefined); assert.equal(counts.pass, undefined);
  assert.deepEqual(sourceNotes(model, W), { phone: ['읽을 자료 없음', '사람이 확인'] });
});

test('REQ-124 the table tells "기록 없음", "형식 모름", "커밋 제목 못 읽음" and what was read apart — never a dash', async t => {
  const model = await read(t, gateDefinition, gateFiles);
  assert.deepEqual(tableStages(model).map(s => s.id), ['req', 'impl', 'gate', 'fix', 'commit', 'stable', 'tester'],
    'the steps it reads, in the drawing\'s order — no decision, no step with nothing to read');
  const cell = (v, id) => tableCell(release(model, v), stage(model, id), W);
  assert.deepEqual(cell('0.2.6', 'tester'), { text: '기록 없음', tone: 'muted', state: 'no-record', warned: false });
  assert.deepEqual(cell('0.2.2', 'gate'), { text: '형식 모름 40', tone: 'warning', state: 'unknown-format', warned: false });
  assert.deepEqual(cell('0.2.6', 'commit'), { text: '6666666 · 커밋 제목 못 읽음', tone: 'warning', state: 'title-unread', warned: false });
  assert.deepEqual([cell('0.2.6', 'gate').text, cell('0.2.6', 'gate').tone], ['60 불통과 → 62 조건부', 'conditional']);
  assert.equal(cell('0.2.4', 'gate').text, '50 불통과 → 54 통과 (2회)');
  assert.deepEqual([cell('0.2.1', 'gate').text, cell('0.2.1', 'gate').tone], ['35 불통과', 'fail']);
  assert.equal(cell('0.2.6', 'req').text, 'REQ-36');
  assert.equal(cell('0.2.4', 'fix').text, '51 53');
  assert.match(cell('0.2.5', 'commit').text, /^5555555 03-03 \d\d:\d\d$/);
  assert.equal(cell('0.2.5', 'stable').text, '03-03 12:00');
  assert.equal(cell('0.2.5', 'tester').text, '03-03 13:00');
  for (const r of model.releases) for (const s of tableStages(model)) assert.notEqual(tableCell(r, s, W).text.trim(), '—');
  assert.equal(shortTime('2026-03-03 12:40 KST'), '03-03 12:40'); assert.equal(shortTime(null), '');
  assert.equal(releaseChip('0.2.6', ['0.2.6', '0.2.5']), '2.6'); assert.equal(releaseChip('1.0.0', ['1.0.0', '0.9.9']), '1.0.0');
  const widths = tableWidths([['요구'], ['60 불통과 → 62 조건부'], ['기록 없음']], 1000);
  assert.equal(widths.reduce((a, b) => a + b, 0) <= 1000, true);
  assert.ok(widths[1] > widths[0], 'the longer text gets the wider column');
  assert.deepEqual(tableWidths([['x'.repeat(60)], ['x'.repeat(60)]], 300), [240, 240], 'too wide: each at most 240, the table scrolls');
});

test('REQ-124 ⑤ another field\'s procedure (no gate, no commit) is drawn by the same model; a missing record says "기록 없음"', async t => {
  const model = await read(t, otherDefinition, otherFiles);
  assert.deepEqual(model.releases.map(r => r.release), ['0.1.3', '0.1.2', '0.1.1']);
  assert.equal(model.git.state, 'unused');
  assert.deepEqual(tableStages(model).map(s => s.label), ['초안', '담당자 검토', '수정', '전달']);
  const cell = (v, id) => tableCell(release(model, v), stage(model, id), W);
  // Delivered with no review on record: "기록 없음", which does not say it was not reviewed.
  assert.deepEqual([cell('0.1.3', 'review').text, cell('0.1.3', 'review').state], ['기록 없음', 'no-record']);
  assert.equal(cell('0.1.3', 'deliver').text, '04-05 09:00');
  assert.deepEqual([cell('0.1.2', 'review').text, cell('0.1.2', 'review').tone], ['9 반려', 'fail'], 'the review\'s own word');
  assert.equal(cell('0.1.2', 'revise').text, '기록 없음');
  const back = model.definition.edges.findIndex(e => e.from === 'revise' && e.to === 'review');
  const again = model.definition.edges.findIndex(e => e.from === 'reply' && e.to === 'grasp');
  const r1 = flowOverlay(model.definition, release(model, '0.1.1'), W);
  assert.deepEqual(r1.loops.get(back), [{ from: 5, to: 6, verdict: 'pass' }]);
  assert.equal(loopLabel(model.definition.edges[back], r1.loops.get(back), W), '다시 검토 1회: 5→6');
  assert.deepEqual(r1.loops.get(again), [], 'no new request read');
  assert.equal(loopLabel(model.definition.edges[again], [], W), '새 요청');
  assert.deepEqual(r1.notes.review, ['4 반려', '→ 승인']);
  assert.ok(r1.passed.has('ok') && r1.passed.has('deliver'));
  const r3 = flowOverlay(model.definition, release(model, '0.1.3'), W);
  assert.deepEqual([r3.notes.review, r3.notes.draft], [['기록 없음'], ['기록 없음']]);
  assert.deepEqual([...r3.passed], ['deliver'], 'only what was read is drawn as the way it went');
  assert.deepEqual(sourceNotes(model, W), { grasp: ['읽을 자료 없음'], reply: ['읽을 자료 없음', '사람이 확인'] });
  assert.equal(stageCounts(model, W).review, '1차 2 · 불통과 2 · 조건부 0');
  // The layout holds it: no two steps overlap, the loop along the first row runs under it.
  const L = flowLayout(model.definition.stages, 1118, r1.notes), nodes = [...L.at.values()];
  for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1))
    assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, a.stage.id + ' × ' + b.stage.id);
});
