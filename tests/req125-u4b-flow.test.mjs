// REQ-125 U4b (research/309 5판 4.2·4.3, 312 J6, research/324): the flow over a 건's confirmed records. A decision (◇) whose
// record cell is confirmed is on the 건's way and only its answer's `when` branch is bold — never two branches, none for an
// ambiguous, partly read or unrecorded decision. A 건 that reached an end step (a pill no line leaves, with a decision's branch
// into it) carries an end tag only when nothing disagrees, no other cell is read in part and every other event is surely earlier.
// Also: the table keeps "규칙 충돌 N" apart from a long name (stable-fa226af), a refused reply is said in words (317 남은 것).
// Made-up names in temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkflow } from '../dist/server/workflow.js';
import { endTag } from '../dist/server/workflow-log.js';
import { workflowDataSchema, WORKFLOW_FORMAT_2 } from '../dist/shared/workflow.js';
import { chosenBranches, endTagText, flowOverlay, ladderItems, readFailure, tableCell, withProgram } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';

const ko = copy('ko'), en = copy('en');
const words = m => ({ verdict: { pass: m.verdictPass, conditional: m.verdictConditional, fail: m.verdictFail, unknown: m.verdictUnknown },
  stateNoRecord: m.stateNoRecord, stateNoSource: m.stateNoSource, stateUnknown: m.stateUnknown, titleUnread: m.titleUnread,
  statePerson: m.statePerson, firstRound: m.firstRound, countFound: m.countFound, loopNone: m.loopNone, loopTimes: m.loopTimes,
  timesShort: m.timesShort, resultNotOk: m.resultNotOk, resultMissing: m.resultMissing,
  dataThere: m.dataThere, stateCandidate: m.stateCandidate, stateAmbiguous: m.stateAmbiguous, stateIncomplete: m.stateIncomplete, countInstances: m.countInstances,
  versionFirst: m.versionFirst, versionNoEarlier: m.versionNoEarlier, versionNext: m.versionNext, versionsSeen: m.versionsSeen, daysMany: m.daysMany,
  programName: m.programName, conflicts: m.programConflicts, answerYes: m.answerYes, answerNo: m.answerNo, logBasis: m.logBasis });
const W = words(ko);

const ROOT = '사업/05_지원기업 서류';
const log = (stage, w, file = 'STATE.md', section = '건 기록') => ({ stage, read: 'state-log', files: [file], section, words: w });
const SUBMIT = log('submit', ['제출']), SELECTED = log('selected', { yes: ['선정'], no: ['미선정'] }), DROP = log('drop', ['철회']);
const AGREE = { stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] };
const DOCS = { stage: 'docs', read: 'file-versions', files: ['{instance}/{nn}_작성본_v{ver}_{yyyymmdd}.{ext}'], ver: 'major.minor' };
/** 309 2.11's 지원사업 steps: docs → submit → selected? → agree (예) / drop (아니오, an end step). */
const grant = (sources, extra = {}) => ({
  format: WORKFLOW_FORMAT_2, features: ['instance-folder', 'folder', 'file-versions', 'state-log'], name: '지원사업 — 흐름도 시험',
  instanceKey: { from: 'folder', path: ROOT + '/*', label: 'strip-number-prefix' },
  stages: [
    { id: 'docs', label: '신청서 작성', shape: 'box', row: 0, col: 0 }, { id: 'submit', label: '접수·제출', shape: 'box', row: 0, col: 1 },
    { id: 'selected', label: '선정?', shape: 'diamond', row: 0, col: 2 }, { id: 'agree', label: '협약·계약', shape: 'box', row: 0, col: 3 },
    { id: 'drop', label: '미선정·철회', shape: 'pill', row: 1, col: 2 },
  ],
  edges: [{ from: 'docs', to: 'submit' }, { from: 'submit', to: 'selected' }, { from: 'selected', to: 'agree', when: 'yes', label: '선정' },
    { from: 'selected', to: 'drop', when: 'no', label: '미선정' }],
  sources, ...extra,
});
const state = (...lines) => ['# 상태', '', '## 작업 기록', '- 2026-09-30: 메모는 이 구역에.', '', '## 건 기록', ...lines, ''].join('\n');
const A = { [ROOT + '/01_A사/메모.md']: 'x' }, AB = { ...A, [ROOT + '/02_B사/메모.md']: 'x' };
async function workspace(t, def, files) {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'kanban-u4b-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = join(cwd, name);
    if (name.endsWith('/')) { await fs.mkdir(file, { recursive: true }); continue; }
    await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(file, text);
  }
  await fs.mkdir(join(cwd, '.kanban'), { recursive: true }); await fs.writeFile(join(cwd, '.kanban/workflow.json'), JSON.stringify(def));
  return cwd;
}
const NOW = () => new Date('2026-10-07T00:00:00.000Z');  // 2026-10-07 09:00 KST
async function reading(t, def, files, options = {}) {
  const m = await readWorkflow(await workspace(t, def, files), { now: NOW, ...options });
  assert.equal(m.defined, true, JSON.stringify(m.problems));
  workflowDataSchema.parse(m);
  return m;
}
const row = (m, label) => m.releases.find(r => r.label === label);
const cell = (r, stage) => r.cells.find(c => c.stage === stage);
const edgeName = (m, i) => m.definition.edges[i].from + '>' + m.definition.edges[i].to;
const bold = (m, r) => [...flowOverlay(m.definition, withProgram(m, r), W, 'instance').hot].map(i => edgeName(m, i)).sort();

// ---- 4.2 the flow ---------------------------------------------------------------------------------------------------------
test('REQ-125 U4b 4.2: a confirmed answer draws its own branch only, data or not at the step it leads to; the decision is on the way', async t => {
  // 예, 협약 has no data: the 예 line is bold all the same, the 아니오 line is not.
  const yes = await reading(t, grant([SUBMIT, SELECTED, AGREE]), { ...A, 'STATE.md': state('- 2026-09-29: [A사][제출]', '- 2026-10-01 17:00 KST: [A사][선정]') });
  assert.deepEqual(row(yes, 'A사').path.map(p => p.stage), ['submit', 'selected']);
  assert.deepEqual(bold(yes, row(yes, 'A사')), ['selected>agree', 'submit>selected']);
  // 아니오 while 협약 holds data: only the 아니오 branch — the step after the 예 branch never makes it bold.
  const no = await reading(t, grant([SUBMIT, SELECTED, AGREE]), { ...A, [ROOT + '/01_A사/10_선정·계약/통보.pdf']: 'x', 'STATE.md': state('- 2026-09-29: [A사][제출]', '- 2026-10-02: [A사][미선정]') });
  assert.deepEqual(row(no, 'A사').path.map(p => p.stage), ['submit', 'selected', 'agree']);
  assert.deepEqual(bold(no, row(no, 'A사')), ['selected>drop', 'submit>selected']);
  const ladder = ladderItems(no, row(no, 'A사'), W).find(i => i.kind === 'step' && i.stage.id === 'selected');
  assert.deepEqual([ladder.passed, ladder.cut, ladder.ways.filter(v => v.on).map(v => v.text)], [true, true, ['미선정 → 미선정·철회']],
    'the ladder: the decision passed, its line down to 협약 not bold (its answer goes aside)');
  // The step before the decision without data: the decision still on the way, the line into it plain.
  const alone = await reading(t, grant([SUBMIT, SELECTED, AGREE]), { ...A, 'STATE.md': state('- 2026-10-01: [A사][선정]') });
  assert.deepEqual(bold(alone, row(alone, 'A사')), ['selected>agree']);
});

test('REQ-125 U4b 4.2: an ambiguous, partly read or unrecorded decision draws no branch, whatever the steps around it hold', async t => {
  const both = { ...A, [ROOT + '/01_A사/10_선정·계약/통보.pdf']: 'x' };
  const cases = [
    ['ambiguous (two answers, one day)', state('- 2026-09-29: [A사][제출]', '- 2026-10-01: [A사][선정]', '- 2026-10-01: [A사][미선정]'), 'ambiguous'],
    ['ambiguous (a memo in the section)', state('- 2026-09-29: [A사][제출]', '- 2026-10-01: [A사][선정]', '메모 한 줄'), 'ambiguous'],
    ['ambiguous (an unknown act)', state('- 2026-10-01: [A사][선정]', '- 2026-10-03: [A사][선정 보류]'), 'ambiguous'],
    ['no record', state('- 2026-09-29: [A사][제출]'), 'no-record'],
    ['partly read (over 2 MB)', state('- 2026-10-01: [A사][선정]') + ' '.repeat(2 * 1024 * 1024), 'incomplete'],
  ];
  for (const [name, text, want] of cases) {
    const m = await reading(t, grant([SUBMIT, SELECTED, AGREE]), { ...both, 'STATE.md': text });
    const r = row(m, 'A사');
    assert.equal(cell(r, 'selected').state, want, name);
    assert.ok(!r.path.some(p => p.stage === 'selected'), name + ': the decision is off the way');
    assert.deepEqual(bold(m, r).filter(e => e.includes('selected')), [], name + ': no line into or out of the decision');
    const ladder = ladderItems(m, r, W).find(i => i.kind === 'step' && i.stage.id === 'selected');
    assert.deepEqual([ladder.passed, ladder.ways], [false, undefined], name + ': the ladder marks no way');
  }
});

test('REQ-125 U4b 4.2: never two branches — a definition with two lines of one answer draws neither; a line with no `when` is never chosen', async t => {
  const def = grant([SELECTED, AGREE], {});
  def.stages.push({ id: 'extra', label: '추가 심사', shape: 'box', row: 2, col: 3 });
  def.edges.push({ from: 'selected', to: 'extra', when: 'yes', label: '선정 2' });
  const m = await reading(t, def, { ...A, 'STATE.md': state('- 2026-10-01: [A사][선정]') });
  const r = row(m, 'A사');
  assert.ok(r.path.some(p => p.stage === 'selected'));
  assert.deepEqual(bold(m, r), []);
  assert.equal(chosenBranches(m.definition, r).size, 0);
  // No `when` on the lines out: the decision is on the way, no branch is bold.
  const plain = grant([SELECTED, AGREE]);
  plain.edges = plain.edges.map(e => e.from === 'selected' ? { from: e.from, to: e.to, label: e.label } : e);
  const p = await reading(t, plain, { ...A, 'STATE.md': state('- 2026-10-01: [A사][선정]') });
  assert.deepEqual(bold(p, row(p, 'A사')), []);
});

// ---- 4.3 the end tag -------------------------------------------------------------------------------------------------------
test('REQ-125 U4b 4.3 #1: a decision confirmed 아니오 alone reaches drop — the tag is shown (310 J6: its own evidence is not compared)', async t => {
  const m = await reading(t, grant([SUBMIT, SELECTED, AGREE]), { ...AB, 'STATE.md': state('- 2026-09-29: [A사][제출]', '- 2026-10-02 10:00 KST: [A사][미선정]') });
  const r = row(m, 'A사');
  assert.deepEqual(r.endTag, { stage: 'drop', by: ['selected'], time: '2026-10-02 10:00 KST' });
  assert.equal(row(m, 'B사').endTag, undefined, 'B사 founds none');
  assert.deepEqual(endTagText(r, m.definition.stages, ko), { shown: '끝: 미선정·철회 · 10/2 10:00', held: '' });
  assert.deepEqual(endTagText(r, m.definition.stages, en), { shown: 'Ended: 미선정·철회 · 10/2 10:00', held: '' });
  // ⓐ: the end step's own record (철회) confirmed, the decision unrecorded — shown; both, agreeing — shown, the latest of them.
  const own = await reading(t, grant([SUBMIT, SELECTED, DROP]), { ...A, 'STATE.md': state('- 2026-09-22 15:04 KST: [A사][철회]') });
  assert.deepEqual(row(own, 'A사').endTag, { stage: 'drop', by: ['drop'], time: '2026-09-22 15:04 KST' });
  const twice = await reading(t, grant([SUBMIT, SELECTED, DROP]), { ...A, 'STATE.md': state('- 2026-10-02: [A사][미선정]', '- 2026-10-03: [A사][철회]') });
  assert.deepEqual(row(twice, 'A사').endTag, { stage: 'drop', by: ['drop', 'selected'], time: '2026-10-03' });
});

test('REQ-125 U4b 4.3 #2: a dated new version after the withdrawal — no tag, said why; the same day cannot be told either', async t => {
  const later = await reading(t, grant([DOCS, SELECTED]), { ...A, [ROOT + '/01_A사/01_작성본_v1.0_20260920.hwp']: 'x', [ROOT + '/01_A사/01_작성본_v2.0_20261005.hwp']: 'x',
    'STATE.md': state('- 2026-10-02: [A사][미선정]') });
  const r = row(later, 'A사');
  assert.deepEqual([r.endTag.held, r.endTag.stage, r.endTag.time], ['later', 'drop', '2026-10-02']);
  assert.match(r.endTag.at, /01_작성본_v2\.0_20261005\.hwp$/);
  assert.match(endTagText(r, later.definition.stages, ko).held, /^「미선정·철회」 끝 꼬리표 보류 — 이 건에 같은 날이거나 더 늦은 자료가 있음: /);
  const same = await reading(t, grant([DOCS, SELECTED]), { ...A, [ROOT + '/01_A사/01_작성본_v1.0_20261002.hwp']: 'x', 'STATE.md': state('- 2026-10-02 17:00 KST: [A사][미선정]') });
  assert.equal(row(same, 'A사').endTag.held, 'later', 'a day against a minute of that day cannot be told');
  // Earlier versions only: shown.
  const earlier = await reading(t, grant([DOCS, SELECTED]), { ...A, [ROOT + '/01_A사/01_작성본_v1.0_20260920.hwp']: 'x', 'STATE.md': state('- 2026-10-02: [A사][미선정]') });
  assert.equal(row(earlier, 'A사').endTag.held, undefined);
});

test('REQ-125 U4b 4.3 #3: a folder with no date in its name — no tag, and the reason names it; so does writing with no time elsewhere', async t => {
  const m = await reading(t, grant([SUBMIT, SELECTED, AGREE]), { ...A, [ROOT + '/01_A사/10_선정·계약/통보.pdf']: 'x', 'STATE.md': state('- 2026-10-02: [A사][미선정]') });
  const r = row(m, 'A사');
  assert.deepEqual(r.endTag, { stage: 'drop', by: ['selected'], time: '2026-10-02', held: 'undated', at: ROOT + '/01_A사/10_선정·계약' });
  assert.equal(endTagText(r, m.definition.stages, ko).held, '「미선정·철회」 끝 꼬리표 보류 — 이 건에 날짜를 하나로 알 수 없는 자료가 있음: ' + ROOT + '/01_A사/10_선정·계약');
  assert.equal(endTagText(r, m.definition.stages, ko).shown, '', 'a held tag is never shown');
  // A dated folder before it: shown.
  const dated = await reading(t, grant([SUBMIT, SELECTED, { stage: 'agree', read: 'folder', files: ['{instance}/10_선정_20260920'] }]),
    { ...A, [ROOT + '/01_A사/10_선정_20260920/통보.pdf']: 'x', 'STATE.md': state('- 2026-10-02: [A사][미선정]') });
  assert.equal(row(dated, 'A사').endTag.held, undefined);
  // Writing that is no tag line in another file's section (no time, every 건): the submit cell is ambiguous and holds the tag.
  const memo = await reading(t, grant([log('submit', ['제출'], 'OTHER.md'), SELECTED]), { ...A, 'STATE.md': state('- 2026-10-02: [A사][미선정]'),
    'OTHER.md': ['## 건 기록', '- 2026-09-29: [A사][제출]', '메모', ''].join('\n') });
  assert.deepEqual([cell(row(memo, 'A사'), 'submit').state, row(memo, 'A사').endTag.held, row(memo, 'A사').endTag.at], ['ambiguous', 'undated', 'OTHER.md:3']);
  // A version whose files name several days has no single day.
  const days = await reading(t, grant([DOCS, SELECTED]), { ...A, [ROOT + '/01_A사/01_작성본_v1.0_20260920.hwp']: 'x', [ROOT + '/01_A사/01_작성본_v1.0_20260921.pdf']: 'x',
    'STATE.md': state('- 2026-10-02: [A사][미선정]') });
  assert.equal(row(days, 'A사').endTag.held, 'undated');
});

test('REQ-125 U4b 4.3 #4: the decision confirmed 예 while drop\'s own record is confirmed — they disagree, no tag; an unsettled decision holds it too', async t => {
  const m = await reading(t, grant([SELECTED, DROP]), { ...A, 'STATE.md': state('- 2026-10-01: [A사][선정]', '- 2026-10-03: [A사][철회]') });
  const r = row(m, 'A사');
  assert.deepEqual([cell(r, 'selected').answer, cell(r, 'drop').state], ['yes', 'found']);
  assert.deepEqual(r.endTag, { stage: 'drop', by: ['drop'], time: '2026-10-03', held: 'disagree', at: 'selected' });
  assert.equal(endTagText(r, m.definition.stages, ko).held, '「미선정·철회」 끝 꼬리표 보류 — 「선정?」이(가) 모호·일부만 읽음이거나 다른 답으로 확인됨');
  // The decision ambiguous (an unknown act), drop's own record confirmed: held.
  const amb = await reading(t, grant([SELECTED, DROP]), { ...A, 'STATE.md': state('- 2026-10-01: [A사][선정 보류]', '- 2026-10-03: [A사][철회]') });
  assert.deepEqual([row(amb, 'A사').endTag.held, row(amb, 'A사').endTag.at], ['disagree', 'selected']);
  // drop's own cell ambiguous, the decision 아니오: held at drop.
  const own = await reading(t, grant([SELECTED, log('drop', ['철회'], 'DROP.md')]), { ...A, 'STATE.md': state('- 2026-10-02: [A사][미선정]'),
    'DROP.md': ['## 건 기록', '- 2026-10-03: [A사][철회]', '- 2026-10-03: [A사][철회 취소]', ''].join('\n') });
  assert.deepEqual([row(own, 'A사').endTag.held, row(own, 'A사').endTag.at], ['disagree', 'drop']);
});

test('REQ-125 U4b 312 J6: another cell read in part holds the tag even with no event in it — an empty part is no proof nothing came after', async t => {
  const files = { [ROOT + '/01_A사/10_선정·계약/a/']: '', [ROOT + '/01_A사/10_선정·계약/b/']: '', [ROOT + '/01_A사/10_선정·계약/c/']: '', [ROOT + '/01_A사/10_선정·계약/d/']: '', [ROOT + '/01_A사/10_선정·계약/e/']: '',
    'STATE.md': state('- 2026-10-02: [A사][미선정]') };
  const m = await reading(t, grant([SELECTED, AGREE]), files, { limits: { folderEntries: 4 } });
  const r = row(m, 'A사');
  assert.deepEqual([cell(r, 'agree').state, cell(r, 'agree').events.length, cell(r, 'selected').answer], ['incomplete', 0, 'no'], JSON.stringify([m.limits, m.incomplete, cell(r, 'selected')]));
  assert.deepEqual(r.endTag, { stage: 'drop', by: ['selected'], time: '2026-10-02', held: 'incomplete', at: 'agree' });
  assert.equal(endTagText(r, m.definition.stages, ko).held, '「미선정·철회」 끝 꼬리표 보류 — 「협약·계약」을(를) 일부만 읽어 그 뒤 일을 배제할 수 없음');
  // The same folder read whole (no cap) with no data in it: shown.
  const whole = await reading(t, grant([SELECTED, AGREE]), files);
  assert.equal(row(whole, 'A사').endTag.held, undefined);
});

test('REQ-125 U4b 4.3: no record rule, no confirmed record → no end tag key; a pill reached by a line with no `when` is no end step', async t => {
  const plain = grant([AGREE], { features: ['instance-folder', 'folder'] });
  const m = await reading(t, plain, { ...A });
  assert.ok(m.releases.every(r => !('endTag' in r)));
  const none = await reading(t, grant([SUBMIT, SELECTED]), { ...A, 'STATE.md': state('- 2026-09-29: [A사][제출]') });
  assert.ok(!('endTag' in row(none, 'A사')));
  // The pure function: a pill with a line out is no end step; one reached with no `when` neither.
  const stages = [{ id: 'd', shape: 'diamond', col: 0, row: 0 }, { id: 'end', shape: 'pill', col: 1, row: 0 }, { id: 'next', shape: 'box', col: 2, row: 0 }];
  const confirmed = [{ stage: 'd', state: 'found', answer: 'no', log: true, events: [{ strength: 'confirmed', time: '2026-10-02', path: 'STATE.md', line: 3 }] }];
  assert.equal(endTag(stages, [{ from: 'd', to: 'end', when: 'no' }, { from: 'end', to: 'next' }], confirmed), undefined);
  assert.equal(endTag(stages, [{ from: 'd', to: 'end' }], confirmed), undefined);
  assert.deepEqual(endTag(stages, [{ from: 'd', to: 'end', when: 'no' }], confirmed), { stage: 'end', by: ['d'], time: '2026-10-02' });
  // Two end steps: the shown one wins over a held one; with neither shown, the first in the drawing's order.
  const two = [{ id: 'd', shape: 'diamond', col: 0, row: 0 }, { id: 'e1', shape: 'pill', col: 1, row: 0 }, { id: 'e2', shape: 'pill', col: 1, row: 1 }];
  const cells = [{ stage: 'd', state: 'found', answer: 'no', log: true, events: [{ strength: 'confirmed', time: '2026-10-02', path: 'S', line: 1 }] },
    { stage: 'e2', state: 'found', log: true, events: [{ strength: 'confirmed', time: '2026-10-01', path: 'S', line: 2 }] }];
  assert.deepEqual(endTag(two, [{ from: 'd', to: 'e1', when: 'no' }, { from: 'd', to: 'e2', when: 'yes' }], cells),
    { stage: 'e1', by: ['d'], time: '2026-10-02' }, 'e1 (아니오, 10-02) shown: e2\'s 10-01 record is earlier; e2 disagrees with the decision');
});

// ---- the table's conflict tail and the refused reply's words ----------------------------------------------------------------
test('REQ-125 U4b stable-fa226af: a 건 cell with 규칙 충돌 keeps it as its tail, apart from the words a long name may cut short', () => {
  const stage = { id: 'perform', label: '수행', shape: 'box', row: 0, col: 0 };
  const release = { release: 'x', label: 'A사', reqs: [], firstVerdict: null, finalVerdict: null, regates: 0, path: [], warnings: [],
    cells: [{ stage: 'perform', state: 'found', events: [{ stage: 'perform', kind: 'folder', release: 'x', releaseFrom: null, path: 'a/ApplicationEvidenceDocumentsWithoutSpaces', files: 1 }], conflicts: ['a/01_공고문'] }] };
  const v = tableCell(release, stage, W);
  assert.equal(v.text, '자료 있음 · ApplicationEvidenceDocumentsWithoutSpaces · 규칙 충돌 1');
  assert.equal(v.tail, '규칙 충돌 1');
  assert.equal(tableCell({ ...release, cells: [{ ...release.cells[0], conflicts: undefined }] }, stage, W).tail, undefined, 'no conflict, no tail');
});

test('REQ-125 U4b 317 남은 것: a reply the screen refused is said in words with how many problems; the check\'s JSON only under "자세히"', () => {
  const issues = JSON.stringify([{ origin: 'string', code: 'too_big', maximum: 300, path: ['releases', 0, 'cells', 2, 'events', 0, 'excerpt'], message: 'Too big' },
    { code: 'invalid_type', path: ['key'], message: 'Invalid' }], null, 2);
  const f = readFailure(issues);
  assert.deepEqual([f.kind, f.count, f.first, f.detail], ['reply', 2, 'releases.0.cells.2.events.0.excerpt: Too big', issues]);
  assert.equal(ko.workflowFailedReply(2), '워크플로를 읽지 못했습니다 — 받은 응답이 화면의 검사를 통과하지 못했습니다(문제 2곳). 다시 읽어 보고, 계속되면 칸반을 업데이트하세요.');
  assert.equal(en.workflowFailedReply(1), 'Could not read the workflow — the reply did not pass the screen\'s check (1 problem). Read it again; if it keeps failing, update Kanban.');
  assert.doesNotMatch(ko.workflowFailedReply(f.count), /[{}[\]"]/, 'no JSON in the words');
  const host = readFailure('HOST_ERROR: the daemon did not answer in 10 s. Try again.');
  assert.deepEqual([host.kind, host.first], ['other', 'HOST_ERROR: the daemon did not answer in 10 s. Try again.']);
  assert.equal(readFailure('[1, 2]').kind, 'other', 'a JSON list that is not the check\'s problems');
  assert.equal(Array.from(readFailure('x'.repeat(500)).first).length, 160);
  for (const key of ['endTag', 'endHeld', 'workflowFailedReply', 'workflowFailedDetail', 'workflowFailedHide', 'workflowFailedFirst']) assert.ok(ko[key] && en[key], key);
  for (const why of ['disagree', 'incomplete', 'undated', 'later']) assert.ok(ko.endHeld[why]('a', 'b') && en.endHeld[why]('a', 'b'), why);
});

// ---- 325 후속 수정 -------------------------------------------------------------------------------------------------------------
test('REQ-125 U4b 325-F1: a confirmed `when` line with no label is on the phone\'s ladder too, said by its answer — the flow\'s rule', async t => {
  const def = grant([SUBMIT, SELECTED, AGREE]);
  def.edges = def.edges.map(e => e.from === 'selected' && e.when === 'no' ? { from: e.from, to: e.to, when: 'no' } : e);
  const m = await reading(t, def, { ...A, 'STATE.md': state('- 2026-09-29: [A사][제출]', '- 2026-10-02 10:00 KST: [A사][미선정]') });
  const r = row(m, 'A사');
  assert.deepEqual(bold(m, r), ['selected>drop', 'submit>selected'], 'the flow draws the 아니오 line');
  const step = ladderItems(m, r, W).find(i => i.kind === 'step' && i.stage.id === 'selected');
  assert.deepEqual(step.ways, [{ text: '선정 → 협약·계약', on: false }, { text: '아니오 → 미선정·철회', on: true }]);
  assert.equal(ladderItems(m, r, words(en)).find(i => i.kind === 'step' && i.stage.id === 'selected').ways[1].text, 'No → 미선정·철회');
  // Every line the flow may choose is one the ladder lists: for each confirmed decision, its chosen line is the one marked.
  for (const [id, i] of chosenBranches(m.definition, r)) {
    const on = ladderItems(m, r, W).find(v => v.kind === 'step' && v.stage.id === id).ways.filter(v => v.on);
    assert.equal(on.length, 1, id);
    assert.ok(on[0].text.endsWith('→ ' + m.definition.stages.find(s => s.id === m.definition.edges[i].to).label));
  }
  // Not confirmed: the unlabeled line is listed in the decision's ways (\`via\`), none marked.
  const amb = await reading(t, def, { ...A, 'STATE.md': state('- 2026-10-01: [A사][선정]', '- 2026-10-01: [A사][미선정]') });
  const ambStep = ladderItems(amb, row(amb, 'A사'), W).find(i => i.kind === 'step' && i.stage.id === 'selected');
  assert.deepEqual([ambStep.ways, ambStep.via], [undefined, '선정 → 협약·계약 · 아니오 → 미선정·철회']);
});

test('REQ-125 U4b 325-J3: a confirmed answer with two lines (two end steps) draws no branch and holds the tag — whatever the drawing\'s order', async t => {
  for (const swap of [false, true]) {
    const def = grant([SUBMIT, SELECTED]);
    def.stages.push({ id: 'alt', label: '다른 종료', shape: 'pill', row: 2, col: 2 });
    def.edges.push({ from: 'selected', to: 'alt', when: 'no', label: '미선정 2' });
    if (swap) { const a = def.stages.find(s => s.id === 'drop'), b = def.stages.find(s => s.id === 'alt'); [a.row, b.row] = [b.row, a.row]; }
    const m = await reading(t, def, { ...A, 'STATE.md': state('- 2026-09-29: [A사][제출]', '- 2026-10-02 10:00 KST: [A사][미선정]') });
    const r = row(m, 'A사'), first = swap ? 'alt' : 'drop';
    assert.deepEqual(bold(m, r), ['submit>selected'], 'no branch of the split answer');
    assert.deepEqual(r.endTag, { stage: first, by: ['selected'], time: '2026-10-02 10:00 KST', held: 'branches', at: 'selected' }, 'swap ' + swap);
    assert.equal(endTagText(r, m.definition.stages, ko).shown, '');
    assert.equal(endTagText(r, m.definition.stages, ko).held, '끝 꼬리표 보류 — 「선정?」의 같은 답이 여러 가지로 나뉘어 어디서 끝났는지 정할 수 없음', 'the same words whichever end comes first');
  }
  // The end step's own record still founds its tag when the decision is not what founds it (unrecorded).
  const def = grant([SUBMIT, SELECTED, DROP]);
  def.stages.push({ id: 'alt', label: '다른 종료', shape: 'pill', row: 2, col: 2 });
  def.edges.push({ from: 'selected', to: 'alt', when: 'no' });
  const own = await reading(t, def, { ...A, 'STATE.md': state('- 2026-10-03: [A사][철회]') });
  assert.deepEqual(row(own, 'A사').endTag, { stage: 'drop', by: ['drop'], time: '2026-10-03' });
  for (const why of ['branches']) assert.ok(ko.endHeld[why]('a', 'b') && en.endHeld[why]('a', 'b'), why);
});
