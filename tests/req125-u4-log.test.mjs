// REQ-125 U4a (research/309 5판, research/316): `state-log` — a 건's events from the **pure tag lines** of one section of a record
// file (`## 건 기록`), and a decision's (◇) answer from them. Only `- YYYY-MM-DD[ HH:MM KST]: [건][행위]` with nothing after or under
// it confirms; any other writing in the section stops every answer read from it; a name no row shows stops every 건; line order
// is never time. 309 3.3 (#1~25), 8.5 (R1~R3), 6절 and 8.3 are here, each over a later step with folder data so that no ◇ branch is
// drawn and no ambiguous record cell is on a 건's way (4.1, J5). Made-up names in temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkflow, readWhole, replyable, createWorkflowReader, WORKFLOW_LIMITS } from '../dist/server/workflow.js';
import { clipText, decide, logLines, sectionRanges, surelyEarlier, tagLine, logTime, kstNow, EXCERPT_UNITS } from '../dist/server/workflow-log.js';
import { workflowGet } from '../dist/shared/rpc.js';
import { workflowDefinition2Schema, workflowDataSchema, unreadFeatures, WORKFLOW_FORMAT_2, WORKFLOW_FEATURES } from '../dist/shared/workflow.js';
import { cellMark, flowOverlay, ladderItems, logText, sharedEvidence, stageCounts, tableCell, tableStages, withProgram } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';

const ko = copy('ko'), en = copy('en');
const words = m => ({ verdict: { pass: m.verdictPass, conditional: m.verdictConditional, fail: m.verdictFail, unknown: m.verdictUnknown },
  stateNoRecord: m.stateNoRecord, stateNoSource: m.stateNoSource, stateUnknown: m.stateUnknown, titleUnread: m.titleUnread,
  statePerson: m.statePerson, firstRound: m.firstRound, countFound: m.countFound, loopNone: m.loopNone, loopTimes: m.loopTimes,
  timesShort: m.timesShort, resultNotOk: m.resultNotOk, resultMissing: m.resultMissing,
  dataThere: m.dataThere, stateCandidate: m.stateCandidate, stateAmbiguous: m.stateAmbiguous, stateIncomplete: m.stateIncomplete, countInstances: m.countInstances,
  versionFirst: m.versionFirst, versionNoEarlier: m.versionNoEarlier, versionNext: m.versionNext, versionsSeen: m.versionsSeen, daysMany: m.daysMany,
  programName: m.programName, conflicts: m.programConflicts, answerYes: m.answerYes, answerNo: m.answerNo, logBasis: m.logBasis });
const W = words(ko), WE = words(en);

const ROOT = '사업/05_지원기업 서류', FEATURES = ['instance-folder', 'folder', 'state-log'];
const SUBMIT = { stage: 'submit', read: 'state-log', files: ['STATE.md'], section: '건 기록', words: ['제출'] };
const SELECTED = { stage: 'selected', read: 'state-log', files: ['STATE.md'], section: '건 기록', words: { yes: ['선정'], no: ['미선정'] } };
/** The step after the decision holds folder data for every 건: its way must still never pass the decision (309 4.1). */
const AGREE = { stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] };
/** research/290 2.11's 지원사업 steps (gov-grant), read per 건 from `## 건 기록`. */
const grant = (extra = {}) => ({
  format: WORKFLOW_FORMAT_2, features: FEATURES, name: '지원사업 — 기록 읽기 시험',
  instanceKey: { from: 'folder', path: ROOT + '/*', label: 'strip-number-prefix' },
  stages: [
    { id: 'docs', label: '신청서 작성', shape: 'box', row: 0, col: 0 }, { id: 'submit', label: '접수·제출', shape: 'box', row: 0, col: 1 },
    { id: 'selected', label: '선정?', shape: 'diamond', row: 0, col: 2 }, { id: 'agree', label: '협약·계약', shape: 'box', row: 0, col: 3 },
    { id: 'drop', label: '미선정·철회', shape: 'pill', row: 1, col: 2 },
  ],
  edges: [{ from: 'docs', to: 'submit' }, { from: 'submit', to: 'selected' }, { from: 'selected', to: 'agree', when: 'yes', label: '선정' },
    { from: 'selected', to: 'drop', when: 'no', label: '미선정' }],
  sources: [SUBMIT, SELECTED, AGREE],
  ...extra,
});
const TWO = { [ROOT + '/01_A사/10_선정·계약/통보.pdf']: 'x', [ROOT + '/02_B사/10_선정·계약/통보.pdf']: 'x' };
/** A STATE.md: other sections first (never read), then `## 건 기록` and its lines. */
const state = (...lines) => ['# 상태', '', '## 작업 기록', '- 2026-09-30: A사 서류 정리. [A사][미선정] 같은 글도 이 구역에서는 읽지 않음.', '', '## 건 기록', ...lines, ''].join('\n');
async function workspace(t, def, files = {}) {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'kanban-u4-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = join(cwd, name);
    if (name.endsWith('/')) await fs.mkdir(file, { recursive: true });
    else if (typeof text === 'object' && text.link) { await fs.mkdir(join(file, '..'), { recursive: true }); await fs.symlink(text.link, file); }
    else { await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(file, text); }
  }
  if (def !== null) { await fs.mkdir(join(cwd, '.kanban'), { recursive: true }); await fs.writeFile(join(cwd, '.kanban/workflow.json'), JSON.stringify(def)); }
  return cwd;
}
const NOW = () => new Date('2026-10-05T00:00:00.000Z');  // 2026-10-05 09:00 KST
const read = (cwd, options = {}) => readWorkflow(cwd, { now: NOW, ...options });
const row = (m, label) => m.releases.find(r => r.label === label);
const cell = (r, stage) => r.cells.find(c => c.stage === stage);
/** A record cell in one word: `yes`/`no` (a confirmed answer), `found`, or its state. */
const said = c => c.state === 'found' && c.answer ? c.answer : c.state;
const stageOf = (m, id) => m.definition.stages.find(s => s.id === id);
/**
 * 309 4.1 (J5) and 4.2 (U4b) over any reading: a 건's way holds a decision or a record step only where its cell is confirmed; of
 * the lines out of a decision only its confirmed answer's `when` branch is bold — never two, none for an ambiguous, partly read
 * or unrecorded one, and none read from the steps around it; a record step's figure counts its confirmed cells only.
 */
function guarded(m) {
  const diamonds = new Set(m.definition.stages.filter(s => s.shape === 'diamond').map(s => s.id));
  const logStages = new Set(m.releases.flatMap(r => r.cells.filter(c => c.shared !== undefined).map(c => c.stage)));
  for (const r of m.releases) {
    for (const p of r.path) {
      if (diamonds.has(p.stage)) assert.ok(cell(r, p.stage).state === 'found' && cell(r, p.stage).answer, `a decision on the way of ${r.label} with no confirmed answer`);
      if (logStages.has(p.stage)) assert.equal(cell(r, p.stage).state, 'found', `a record step on the way of ${r.label} that is not confirmed`);
    }
    for (const c of r.cells) if (diamonds.has(c.stage) && c.state === 'found') assert.ok(r.path.some(p => p.stage === c.stage), 'a confirmed decision off the way of ' + r.label);
    const overlay = flowOverlay(m.definition, withProgram(m, r), W, 'instance');
    for (const d of diamonds) {
      const out = [...overlay.hot].map(i => m.definition.edges[i]).filter(e => e.from === d), c = cell(r, d);
      assert.ok(out.length <= 1, `two branches of ${d} drawn for ${r.label}`);
      if (!(c?.state === 'found' && c.answer)) { assert.equal(out.length, 0, `a branch of an unconfirmed ${d} drawn for ${r.label}`); assert.ok(!overlay.passed.has(d), 'an unconfirmed decision passed'); }
      else assert.ok(out.every(e => e.when === c.answer), `a branch other than the answer of ${d} drawn for ${r.label}`);
      for (const e of m.definition.edges) if (e.to === d && overlay.hot.has(m.definition.edges.indexOf(e))) assert.ok(overlay.passed.has(d), 'a line into a decision off the way');
    }
  }
  for (const t of m.totals) if (logStages.has(t.stage))
    assert.equal(t.window.count, m.releases.filter(r => cell(r, t.stage).state === 'found').length, 'a record step figure counts only confirmed cells: ' + t.stage);
}
/** Reads `files` (+ STATE.md text) and checks every expected cell (`{ label: { stage: said } }`), then the J5 guard. */
async function expectCells(t, { text, def = grant(), files = TWO, now = NOW, limits }, want) {
  const all = { ...files, ...(text === undefined ? {} : { 'STATE.md': text }) };
  const m = await readWorkflow(await workspace(t, def, all), { now, ...(limits ? { limits } : {}) });
  assert.equal(m.defined, true, JSON.stringify(m.problems));
  workflowDataSchema.parse(m);
  for (const [label, stages] of Object.entries(want)) {
    const r = row(m, label);
    assert.ok(r, 'no row ' + label + ' in ' + m.releases.map(v => v.label));
    for (const [stage, value] of Object.entries(stages)) assert.equal(said(cell(r, stage)), value, `${label} × ${stage}`);
  }
  guarded(m);
  return m;
}

test('REQ-125 U4a features: state-log is read now; 0.1.60 asked for an update, this build reads it (the rest of the list is unchanged)', async t => {
  assert.deepEqual([...WORKFLOW_FEATURES], ['instance-folder', 'folder', 'file-versions', 'program', 'state-log']);
  assert.deepEqual(unreadFeatures({ format: WORKFLOW_FORMAT_2, features: [...FEATURES, 'program', 'file-versions'] }), []);
  assert.deepEqual(unreadFeatures({ format: WORKFLOW_FORMAT_2, features: [...FEATURES, 'mark'] }), ['mark'], 'a later feature still asks for an update first');
  const m = await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [A사][선정]') }, { A사: { selected: 'yes', submit: 'no-record', agree: 'found' }, B사: { selected: 'no-record' } });
  assert.deepEqual(m.logNotes, []);
  assert.deepEqual(m.logShared, []);
});

// ---- 309 3.3 — every case (#13 is a definition: below; #22 is a file size: below) --------------------------------------------
test('REQ-125 U4a 309 3.3 #1~#12: two pairs, headings, sub-lines, a paragraph, descriptions, a memo, UTC, the future, a suffixed section, an act typo', async t => {
  // #1 (310 F1): a line with two pairs is no tag line — every 건 is ambiguous, B사's earlier 예 too.
  await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [B사][선정]', '- 2026-10-03 10:00 KST: [A사][선정] / [B사][미선정]') },
    { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // #2 (310 F2): a decision log heading outside the section is never read — with no section, 기록 없음 and a note.
  const two = await expectCells(t, { text: ['# 상태', '## 결정 로그', '### [A사][선정] 통보 (2026-10-01 17:00 KST)', '※ 10-03 취소', ''].join('\n') },
    { A사: { selected: 'no-record', submit: 'no-record' } });
  assert.deepEqual(two.logNotes, [{ kind: 'no-section', path: 'STATE.md', section: '건 기록' }]);
  // #3: the same heading and text inside the section — every 건 ambiguous.
  await expectCells(t, { text: state('### [A사][선정] 통보 (2026-10-01 17:00 KST)', '※ 10-03 취소') }, { A사: { selected: 'ambiguous', submit: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // #4·#5·#6 (310 F3): a sub-line, or an empty line then an indented paragraph, belongs to the item — no time, every 건.
  const sub = await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '  - 2026-10-03: 취소 통보.') }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // The note and the evidence point at the line to fix — the sub-line under the pure head.
  assert.deepEqual(sub.logNotes, [{ kind: 'not-a-tag-line', path: 'STATE.md', section: '건 기록', count: 1, lines: [8] }]);
  assert.deepEqual(sub.logShared.map(e => [e.line, e.excerpt]), [[8, '- 2026-10-03: 취소 통보.'], [8, '- 2026-10-03: 취소 통보.']]);
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '', '  취소 통보.') }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '  - 2026-10-03: 취소 통보.', '- 2026-10-02: [A사][선정]') }, { A사: { selected: 'ambiguous' } });
  // #7 (310 F4): a description after the tags — whatever its words mean — is no tag line.
  for (const line of ['- 2026-10-03: [A사][제출] 제출 실패.', '- 2026-10-03: [A사][선정] 선정 철회 통보', '- 2026-10-03: [A사][선정] 선정 사실 없음'])
    await expectCells(t, { text: state('- 2026-09-29: [A사][제출]', '- 2026-10-01 17:00 KST: [A사][선정]', line) },
      { A사: { selected: 'ambiguous', submit: 'ambiguous' }, B사: { selected: 'ambiguous', submit: 'ambiguous' } });
  // #8 (310 J1): a lower heading and its memo inside the section.
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '### 메모', '사업계획서 제출 완료') }, { A사: { selected: 'ambiguous' }, B사: { submit: 'ambiguous' } });
  // #9 (310 F5): a time zone other than KST is no tag line — the later KST 아니오 is not confirmed.
  await expectCells(t, { text: state('- 2026-10-01 23:30 UTC: [A사][선정]', '- 2026-10-02 01:00 KST: [A사][미선정]') }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // #10: read at 00:57 KST, a line at 23:59 KST today is later than the reading (C) — that 건 only; 00:56 is not.
  const early = () => new Date('2026-10-04T15:57:00.000Z');
  await expectCells(t, { text: state('- 2026-10-05 23:59 KST: [A사][선정]'), now: early }, { A사: { selected: 'ambiguous' }, B사: { selected: 'no-record' } });
  await expectCells(t, { text: state('- 2026-10-05 00:57 KST: [A사][선정]', '- 2026-10-05: [B사][선정]'), now: early }, { A사: { selected: 'yes' }, B사: { selected: 'yes' } });
  await expectCells(t, { text: state('- 2026-10-05 00:58 KST: [A사][선정]', '- 2026-10-06: [B사][선정]'), now: early }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // #11 (310 F6): the section's name is matched whole — "작업 기록 규칙" is not "작업 기록".
  const work = { ...SELECTED, section: '작업 기록' };
  await expectCells(t, { def: grant({ sources: [work, AGREE] }),
    text: ['# 상태', '## 작업 기록', '- 2026-10-01: [A사][미선정]', '## 작업 기록 규칙', '- 2026-10-03: [A사][선정]', ''].join('\n') }, { A사: { selected: 'no' } });
  // #12 (310 F7): an act no rule has (a typo) after a confirmed one — that 건 ambiguous; another 건 untouched.
  await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [A사][선정]', '- 2026-10-03 10:00 KST: [A사][미선졍]', '- 2026-10-01: [B사][선정]') },
    { A사: { selected: 'ambiguous' }, B사: { selected: 'yes' } });
});

test('REQ-125 U4a 309 3.3 #14~#21: later answers win only when surely later, line order is never time, unknown names stop every 건', async t => {
  await expectCells(t, { text: state('- 2026-09-30: [A사][선정]', '- 2026-10-02: [A사][미선정]') }, { A사: { selected: 'no' } });                    // #14
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '- 2026-10-01 17:00 KST: [A사][미선정]') }, { A사: { selected: 'ambiguous' } });     // #15
  for (const lines of [['- 2026-10-01: [A사][선정]', '- 2026-10-01: [A사][미선정]'], ['- 2026-10-01: [A사][미선정]', '- 2026-10-01: [A사][선정]']])   // #16
    await expectCells(t, { text: state(...lines) }, { A사: { selected: 'ambiguous' } });
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '- 2026-10-03: [A 사][미선정]') }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } }); // #17
  // #18: an unknown name with an earlier day is an earlier piece in A사 (its answer stands) — B사 has no confirmed piece: ambiguous.
  const m18 = await expectCells(t, { text: state('- 2026-09-20: [A 사][미선정]', '- 2026-10-01: [A사][선정]') }, { A사: { selected: 'yes' }, B사: { selected: 'ambiguous' } });
  // The unknown name stands in every step reading the line (submit and selected): the shared list holds one of each, submit first.
  assert.deepEqual(m18.logShared.map(e => e.stage), ['submit', 'selected']);
  assert.deepEqual(cell(row(m18, 'A사'), 'selected').earlierShared, [1]);
  assert.deepEqual(sharedEvidence(m18, row(m18, 'A사'), 'selected').map(e => [e.why, e.scope, e.earlier, e.time]), [['unknown-instance', 'all', true, '2026-09-20']]);
  assert.deepEqual(sharedEvidence(m18, row(m18, 'B사'), 'selected').map(e => e.earlier), [undefined]);
  // #19 (292 N1): a pure head with a 330-character description and "예정", or a second pair after it — never judged by its first 300.
  const long = '설명'.repeat(165);
  for (const tail of [' 예정', ' [B사][보완 제출]'])
    await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [A사][선정] ' + long + tail) }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [A사][선정]') }, { A사: { selected: 'yes' }, B사: { selected: 'no-record' } });        // #20
  // #21: a fence inside the section belongs to the item before it (E) and does not end the section with the heading in it.
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '```', '## 다른 제목', '```', '- 2026-10-03: [A사][미선정]') },
    { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
});

// ---- 309 8.5 R1~R3 (312), each with a confirmed answer already there ------------------------------------------------------
test('REQ-125 U4a 309 8.5 R1-1~R1-7 (312 R1): a heading inside a comment or a fence is no section; a comment inside the section stops it', async t => {
  // R1-1 = 3.3 #23: the commented "section" with a later 선정 is no section — the real one's 미선정 stands; noted.
  const r1 = await expectCells(t, { text: ['# 상태', '<!--', '## 건 기록', '- 2026-10-03 10:00 KST: [A사][선정]', '## 보관 견본', '-->', '', '## 건 기록', '- 2026-10-01 17:00 KST: [A사][미선정]', ''].join('\n') },
    { A사: { selected: 'no' }, B사: { selected: 'no-record' } });
  assert.deepEqual(r1.logNotes, [{ kind: 'section-in-comment', path: 'STATE.md', section: '건 기록', lines: [3] }]);
  // R1-2: only a commented heading — no section.
  const r2 = await expectCells(t, { text: ['# 상태', '<!--', '## 건 기록', '- 2026-10-03 10:00 KST: [A사][선정]', '-->', ''].join('\n') }, { A사: { selected: 'no-record' } });
  assert.deepEqual(r2.logNotes.map(n => n.kind), ['section-in-comment', 'no-section']);
  // R1-3·R1-4: a comment opened inside the section (a higher heading in it, closed or not) is E and does not end the section.
  await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [A사][선정]', '<!--', '# 다른 장', '-->', '- 2026-10-03 10:00 KST: [A사][미선정]') },
    { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [A사][선정]', '<!--', '# 다른 장', '- 2026-10-03 10:00 KST: [A사][미선정]') },
    { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // R1-5: an unclosed comment before the heading — no section, nothing confirmed.
  const r5 = await expectCells(t, { text: ['# 상태', '<!-- 보관', '## 건 기록', '- 2026-10-01 17:00 KST: [A사][선정]', ''].join('\n') }, { A사: { selected: 'no-record' }, B사: { selected: 'no-record' } });
  assert.ok(r5.logNotes.some(n => n.kind === 'no-section'));
  // R1-6: "<!--" inside a fence is code; R1-7: a fence inside a comment does not open. The real section is read after either.
  await expectCells(t, { text: ['# 상태', '```', '<!--', '```', '## 건 기록', '- 2026-10-01 17:00 KST: [A사][선정]', ''].join('\n') }, { A사: { selected: 'yes' } });
  await expectCells(t, { text: ['# 상태', '<!--', '```', '-->', '## 건 기록', '- 2026-10-01 17:00 KST: [A사][선정]', ''].join('\n') }, { A사: { selected: 'yes' } });
});

test('REQ-125 U4a 309 8.5 R2-1~R2-4 (312 R2): a word of another section\'s rule is unknown here — never dropped, never another rule\'s answer', async t => {
  const other = { stage: 'selected', read: 'state-log', files: ['STATE.md'], section: '별도 기록', words: { yes: ['재선정'], no: ['선정 취소'] } };
  const lines = ['- 2026-10-01 17:00 KST: [A사][선정]', '- 2026-10-03 10:00 KST: [A사][선정 취소]'];
  // R2-1 = 3.3 #24, R2-2 the rules swapped: A사 ambiguous; "별도 기록" has no section (said).
  for (const sources of [[SELECTED, other, AGREE], [other, SELECTED, AGREE]]) {
    const m = await expectCells(t, { def: grant({ sources }), text: state(...lines) }, { A사: { selected: 'ambiguous' } });
    assert.deepEqual(m.logNotes, [{ kind: 'no-section', path: 'STATE.md', section: '별도 기록' }]);
    assert.deepEqual(cell(row(m, 'A사'), 'selected').events.map(e => [e.line, e.strength, e.why]), [[7, 'confirmed', undefined], [8, 'ambiguous', 'unknown-word']]);
  }
  // R2-3: a real "별도 기록" section — the 10-03 line in "건 기록" stays unknown (B). 309 3.2 decides with times: a "선정 취소" confirmed
  // the next day is later than every other piece, so 아니오 (research/316 「설계와 다르게」: the 8.5 table says 모호 here); the same
  // day without a minute cannot be told from 10:00 — 모호.
  await expectCells(t, { def: grant({ sources: [SELECTED, other, AGREE] }), text: state(...lines, '## 별도 기록', '- 2026-10-04: [A사][선정 취소]') }, { A사: { selected: 'no' } });
  await expectCells(t, { def: grant({ sources: [SELECTED, other, AGREE] }), text: state(...lines, '## 별도 기록', '- 2026-10-03: [A사][선정 취소]') }, { A사: { selected: 'ambiguous' } });
  // R2-4: another section's yes word inside "건 기록" never confirms 예.
  await expectCells(t, { def: grant({ sources: [SELECTED, other, AGREE] }), text: state('- 2026-10-01 17:00 KST: [A사][미선정]', '- 2026-10-03 10:00 KST: [A사][재선정]') },
    { A사: { selected: 'ambiguous' } });
});

test('REQ-125 U4a 309 8.5 R3-1~R3-8 (312 R3): a number-stripped name is never an alias; a folder no row shows takes a tag only by its exact name', async t => {
  const asIs = (extra = {}) => grant({ instanceKey: { from: 'folder', path: ROOT + '/*', label: 'as-is', ...extra } });
  const r31 = state('- 2026-10-01 17:00 KST: [01_A사][선정]', '- 2026-10-03 10:00 KST: [A사][미선정]');
  const one = { [ROOT + '/01_A사/10_선정·계약/통보.pdf']: 'x' };
  // R3-1 = 3.3 #25 (02_A사 a link) and R3-2 (no link): 01_A사 ambiguous (D″, a stripped name).
  const m1 = await expectCells(t, { def: asIs(), text: r31, files: { ...one, [ROOT + '/02_A사']: { link: '01_A사' } } }, { '01_A사': { selected: 'ambiguous' } });
  assert.deepEqual(m1.logShared.map(e => [e.stage, e.why, e.scope, e.line]), [['submit', 'stripped-name', 'all', 8], ['selected', 'stripped-name', 'all', 8]]);
  assert.ok(m1.excluded.some(x => x.path === ROOT + '/02_A사' && x.why === 'link'));
  await expectCells(t, { def: asIs(), text: r31, files: one }, { '01_A사': { selected: 'ambiguous' } });
  // R3-3: strip-number-prefix, 01_A사 shown as A사 and 02_A사 a link — its stripped name is A사 too: whose record is not sure (D).
  const m3 = await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [A사][선정]', '- 2026-10-03 10:00 KST: [A사][미선정]'), files: { ...one, [ROOT + '/02_A사']: { link: '01_A사' } } },
    { A사: { selected: 'ambiguous' } });
  assert.deepEqual(cell(row(m3, 'A사'), 'selected').events.map(e => e.why), ['hidden-overlap', 'hidden-overlap']);
  // R3-4: excluded by name — the same as R3-1.
  await expectCells(t, { def: asIs({ exclude: ['02_A사'] }), text: r31, files: { ...one, [ROOT + '/02_A사/x.md']: 'x' } }, { '01_A사': { selected: 'ambiguous' } });
  // R3-5: 201 건, the 201st (99_A사) past the 200 — still no alias for A사.
  const many = { ...one, [ROOT + '/99_A사/']: '' };
  for (let i = 1; i <= 199; i++) many[`${ROOT}/50_건${String(i).padStart(3, '0')}/`] = '';
  const m5 = await expectCells(t, { def: asIs(), text: r31, files: many }, { '01_A사': { selected: 'ambiguous' } });
  assert.ok(m5.limits.includes('instances') && !row(m5, '99_A사'));
  // …and the 201st's exact name is left to it (D′): a note, no piece anywhere.
  const m5b = await expectCells(t, { def: asIs(), text: state('- 2026-10-01 17:00 KST: [01_A사][선정]', '- 2026-10-03 10:00 KST: [99_A사][미선정]'), files: many }, { '01_A사': { selected: 'yes' } });
  assert.deepEqual(m5b.logNotes, [{ kind: 'other-item', path: 'STATE.md', name: '99_A사', lines: [8] }]);
  // R3-6: 01_A and 02_A keep their folder names (their stripped names meet) — [A] is no alias of either: every 건 ambiguous.
  await expectCells(t, { text: state('- 2026-10-01 17:00 KST: [01_A][선정]', '- 2026-10-01 17:00 KST: [02_A][선정]', '- 2026-10-03 10:00 KST: [A][미선정]'),
    files: { [ROOT + '/01_A/x.md']: 'x', [ROOT + '/02_A/x.md']: 'x' } }, { '01_A': { selected: 'ambiguous' }, '02_A': { selected: 'ambiguous' } });
  // R3-7: a link B사, tag by its exact name — no piece, a note, the other 건 untouched.
  const m7 = await expectCells(t, { def: asIs(), text: state('- 2026-10-01 17:00 KST: [01_A사][선정]', '- 2026-10-03 10:00 KST: [B사][선정]'), files: { ...one, [ROOT + '/B사']: { link: '01_A사' } } },
    { '01_A사': { selected: 'yes' } });
  assert.deepEqual([m7.logShared, m7.logNotes], [[], [{ kind: 'other-item', path: 'STATE.md', name: 'B사', lines: [8] }]]);
  // R3-8: the 건 folder listed only in part (its entry cap) — every record cell 일부만 읽음, before any name is matched.
  // The cap is 3 and the 건 folder has 4 — the folders above ROOT (the workspace's 3 entries, 사업's 1) fit whole, so ROOT is cut whatever the disk order; which 3 of the 4 are read is that order (opendir, no sort), so no name is relied on: every row shown says it.
  const m8 = await expectCells(t, { def: asIs(), text: r31, files: { ...one, [ROOT + '/02_B사/x.md']: 'x', [ROOT + '/03_C사/x.md']: 'x', [ROOT + '/04_D사/x.md']: 'x' }, limits: { ...WORKFLOW_LIMITS, folderEntries: 3 } }, {});
  assert.ok(m8.limits.includes('folder-entries:' + ROOT) && m8.releases.length >= 1, JSON.stringify([m8.releases.map(v => v.label), m8.limits, m8.incomplete]));
  for (const r of m8.releases) {
    for (const stage of ['selected', 'submit']) assert.equal(said(cell(r, stage)), 'incomplete', `${r.label} × ${stage}`);
    assert.equal(tableCell(r, stageOf(m8, 'selected'), W).text, '▨ 일부만 읽음', r.label);
  }
});

// ---- 309 6절: the definition ------------------------------------------------------------------------------------------------
test('REQ-125 U4a 309 6절: a state-log rule is refused as 형식 모름 when it breaks its narrow shape; #13 a word read twice from one file', async t => {
  const refused = async (sources, features = FEATURES) => {
    const def = grant({ sources, features });
    assert.equal(workflowDefinition2Schema.safeParse(def).success, false, JSON.stringify(sources));
    const m = await read(await workspace(t, def));
    assert.deepEqual([m.defined, m.reason], [false, 'unknown-format'], JSON.stringify(sources));
    return m.problems.join(' ');
  };
  assert.match(await refused([SELECTED], ['instance-folder', 'folder']), /"state-log" rule needs the feature "state-log"/);
  assert.match(await refused([{ ...SELECTED, words: ['선정'] }]), /decision selected reads answers/);
  assert.match(await refused([{ ...SUBMIT, words: { yes: ['제출'], no: ['미제출'] } }]), /step submit is no decision/);
  for (const bad of [[''], ['[선정]'], [' 선정'], ['선정 '], ['선\n정'], ['가'.repeat(21)], []]) await refused([{ ...SUBMIT, words: bad }]);
  await refused([{ ...SUBMIT, words: Array.from({ length: 9 }, (_, i) => '낱말' + i) }]);
  // #13 (310 F8) and 2.6: one word in two lists of one rule, two rules of one step, or two steps — over one file.
  assert.match(await refused([{ ...SELECTED, words: { yes: ['선정'], no: ['선정'] } }]), /"선정" is read twice/);
  assert.match(await refused([SELECTED, { ...SELECTED, words: { yes: ['재선정'], no: ['선정'] } }]), /"선정" is read twice/);
  await refused([{ ...SUBMIT, words: ['제출', '제출'] }]);
  await refused([SELECTED, { ...SUBMIT, words: ['선정'] }]);
  await refused([SELECTED, { ...SUBMIT, section: '다른 기록', words: ['미선정'] }]);
  await refused([SELECTED, { ...SUBMIT, files: ['./STATE.md'.slice(2)], words: ['선정'] }]);
  // NFC: one word written in two normal forms is one word.
  await refused([SELECTED, { ...SUBMIT, words: ['선정'.normalize('NFD')] }]);
  for (const files of [['*.md'], ['{instance}/STATE.md'], ['../STATE.md'], ['/STATE.md'], ['기록/'], ['기록//STATE.md'], ['.STATE.md'], [],
    ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], ['STATE.md', 'STATE.md']]) await refused([{ ...SUBMIT, files }]);
  for (const key of [{ scope: 'program' }, { match: 'name' }, { aliases: {} }, { tags: [] }, { lines: 'tag' }, { time: 'kst' }]) await refused([{ ...SUBMIT, ...key }]);
  for (const section of ['', ' 건 기록', '건 기록 ', '[건]', '## 건 기록', '건\n기록', '가'.repeat(41)]) await refused([{ ...SUBMIT, section }]);
  // A step reads a record or its folders, never both — in either order.
  for (const sources of [[SUBMIT, { stage: 'submit', read: 'folder', files: ['{instance}/00_제출'] }], [{ stage: 'submit', read: 'folder', files: ['{instance}/00_제출'] }, SUBMIT]])
    assert.match(await refused(sources), /mixes a "state-log" rule/);
  // A decision still takes no folder or version rule (U1~U3's words).
  assert.match(await refused([{ stage: 'selected', read: 'folder', files: ['{instance}/10_선정·계약'] }]), /decision selected cannot take a reading rule: "folder"/);
  // Fine: up to four fixed files, a 40-character section, eight 20-character words, two files read by different rules with one word each.
  for (const sources of [[{ ...SUBMIT, files: ['STATE.md', '기록/B.md', 'c.md', 'd.md'], section: '가'.repeat(40), words: Array.from({ length: 8 }, (_, i) => String(i).repeat(20)) }],
    [SELECTED, { ...SUBMIT, files: ['다른.md'], words: ['선정'] }]])
    assert.equal(workflowDefinition2Schema.safeParse(grant({ sources })).success, true, JSON.stringify(sources));
});

// ---- 309 8.3: the section, the pure line's edges, names, the 2 MB rule and reading whole ------------------------------------
test('REQ-125 U4a 309 2.3 the section: an emoji before its name, two sections, a suffix, a fence, an unclosed fence, CRLF·BOM·NFD', async t => {
  await expectCells(t, { text: ['# 상태', '## 🔴 건 기록', '- 2026-10-01: [A사][선정]', ''].join('\n') }, { A사: { selected: 'yes' } });
  await expectCells(t, { text: ['# 상태', '## ★★ 건 기록  ', '- 2026-10-01: [A사][선정]', ''].join('\n') }, { A사: { selected: 'yes' } });
  const suffix = await expectCells(t, { text: ['# 상태', '## 건 기록 (예시)', '- 2026-10-01: [A사][선정]', '## 건 기록:', '- 2026-10-01: [B사][선정]', ''].join('\n') },
    { A사: { selected: 'no-record' }, B사: { selected: 'no-record' } });
  assert.equal(suffix.logNotes[0].kind, 'no-section');
  // Two sections of the name: both read (one 건 in each).
  await expectCells(t, { text: ['## 건 기록', '- 2026-10-01: [A사][선정]', '## 다른 것', '메모', '## 건 기록', '- 2026-10-02: [B사][미선정]', ''].join('\n') },
    { A사: { selected: 'yes' }, B사: { selected: 'no' } });
  // A heading inside a fence (indented up to three, or with tildes) is no section; an indented heading is no heading either.
  for (const fence of [['```', '```'], ['  ~~~~', '  ~~~~'], ['````md', '````']])
    await expectCells(t, { text: ['# 상태', fence[0], '## 건 기록', '- 2026-10-01: [A사][선정]', fence[1], ''].join('\n') }, { A사: { selected: 'no-record' } });
  await expectCells(t, { text: ['# 상태', '  ## 건 기록', '- 2026-10-01: [A사][선정]', ''].join('\n') }, { A사: { selected: 'no-record' } });
  // An unclosed fence in the section runs to the end: E, and the section never ends.
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '```', '## 다음', '- 2026-10-02: [B사][선정]') }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // A fence closed by a shorter or other fence is still open.
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '````', '```', '~~~~', '- 2026-10-02: [B사][선정]') }, { B사: { selected: 'ambiguous' } });
  // CRLF and a BOM; a 건 folder written in NFD, its tag in NFC (and the reverse).
  const nfd = { [ROOT + '/01_A사'.normalize('NFD') + '/10_선정·계약/x.pdf']: 'x', [ROOT + '/02_B사/10_선정·계약/x.pdf']: 'x' };
  await expectCells(t, { files: nfd, text: '﻿' + state('- 2026-10-01: [A사][선정]', '- 2026-10-02: [B사'.normalize('NFD') + '][미선정]').replace(/\n/g, '\r\n') },
    { A사: { selected: 'yes' }, B사: { selected: 'no' } });
  // Headings: "#건 기록" (no space) and "####### 건 기록" are no headings.
  await expectCells(t, { text: ['#건 기록', '- 2026-10-01: [A사][선정]', '####### 건 기록', '- 2026-10-01: [B사][선정]', ''].join('\n') }, { A사: { selected: 'no-record' }, B사: { selected: 'no-record' } });
});

test('REQ-125 U4a 309 2.2 the pure line\'s edges: trailing spaces and empty lines are pure; any other shape is E (no time, every 건)', async t => {
  for (const lines of [['- 2026-10-01: [A사][선정]   '], ['- 2026-10-01: [A사][선정]\t', '', '   ', ''], ['- 2026-10-01 00:00 KST: [A사][선정]'], ['- 2024-02-29: [A사][선정]']])
    await expectCells(t, { text: state(...lines) }, { A사: { selected: 'yes' }, B사: { selected: 'no-record' } });
  for (const line of ['- 2026-02-31: [A사][선정]', '- 2025-02-29: [A사][선정]', '- 2026-10-01 24:00 KST: [A사][선정]', '- 2026-10-01 12:60 KST: [A사][선정]',
    '- 2026-10-01 16:3x KST: [A사][선정]', '- 2026-10-01 16:30: [A사][선정]', '- 2026-10-01T16:30+09:00: [A사][선정]', '- 2026-10-01 16:30 +09:00: [A사][선정]',
    '- 2026-10-01 (총괄): [A사][선정]', '- 2026-10-01: (총괄) [A사][선정]', '* 2026-10-01: [A사][선정]', '-  2026-10-01: [A사][선정]', '- 2026-10-01:[A사][선정]',
    '- 2026-10-01: ［A사］［선정］', '- 2026-10-01: [A사] [선정]', '- 2026-10-01: [A사][]', '- 2026-10-01: [][선정]', '- 26-10-01: [A사][선정]',
    '- 2026-10-01: [' + '가'.repeat(41) + '][선정]', '- 2026-10-01: [A사][' + '가'.repeat(21) + ']', '-2026-10-01: [A사][선정]', '- 2026-10-01: [A사][선정] <!-- -->'])
    await expectCells(t, { text: state('- 2026-09-01: [B사][선정]', line) }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // An item indented by one space belongs to the item before it; text before the first item is writing of its own.
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', ' - 2026-10-02: [B사][선정]') }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  const head = await expectCells(t, { text: state('이 구역에는 태그만', '- 2026-10-01: [A사][선정]') }, { A사: { selected: 'ambiguous' } });
  assert.deepEqual(head.logNotes, [{ kind: 'not-a-tag-line', path: 'STATE.md', section: '건 기록', count: 1, lines: [7] }]);
  assert.equal(head.logShared.length, 2, 'one piece per step reading the section');
  // A name with a bracket cannot be written as a tag: said.
  const bracket = await expectCells(t, { text: state('- 2026-10-01: [A사][선정]'), files: { ...TWO, [ROOT + '/03_[C]사/x.md']: 'x' } }, { A사: { selected: 'yes' }, '[C]사': { selected: 'no-record' } });
  assert.deepEqual(bracket.logNotes, [{ kind: 'untaggable', path: ROOT + '/03_[C]사', name: '[C]사' }]);
});

test('REQ-125 U4a 309 2.4 names: a shown name a hidden folder shares (D), an excluded or hidden folder\'s exact name (D′), a renamed folder (D″)', async t => {
  // 01_A and 02_A take their folder names back (their stripped names meet): an exact tag of each confirms its own row.
  await expectCells(t, { text: state('- 2026-10-01: [01_A][선정]', '- 2026-10-02: [02_A][미선정]'), files: { [ROOT + '/01_A/x.md']: 'x', [ROOT + '/02_A/x.md']: 'x' } },
    { '01_A': { selected: 'yes' }, '02_A': { selected: 'no' } });
  // A hidden (@) folder's exact name is left to it; a NFC pair (both out) likewise.
  const hidden = await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '- 2026-10-02: [@보류][미선정]'), files: { ...TWO, [ROOT + '/@보류/x.md']: 'x' } }, { A사: { selected: 'yes' } });
  assert.deepEqual(hidden.logNotes.map(n => [n.kind, n.name]), [['other-item', '@보류']]);
  // A renamed folder's old name (292 J1): every 건 ambiguous.
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]', '- 2026-10-01: [B사][선정]', '- 2026-10-02: [옛A사][미선정]') }, { A사: { selected: 'ambiguous' }, B사: { selected: 'ambiguous' } });
  // An unknown name earlier than a 건's confirmed answer does not stop it; B사's earlier answer stays (both earlier than its own).
  await expectCells(t, { text: state('- 2026-09-01: [옛A사][미선정]', '- 2026-10-01: [A사][선정]', '- 2026-09-02: [B사][선정]') }, { A사: { selected: 'yes' }, B사: { selected: 'yes' } });
});

test('REQ-125 U4a 309 3.2 · 312 J2: the latest confirmed pieces are a set — a day and a minute of one day, ties, yes→no→yes, two files', async t => {
  const p = (strength, answer, time) => ({ strength, answer, time: logTime(time) });
  // A day and a minute of the same day, both 예: an unknown piece at 12:00 that day is not surely earlier than the day — 모호.
  assert.equal(decide([p('confirmed', 'yes', '2026-10-01'), p('confirmed', 'yes', '2026-10-01 17:00 KST'), p('ambiguous', undefined, '2026-10-01 12:00 KST')]).state, 'ambiguous');
  assert.deepEqual(decide([p('confirmed', 'yes', '2026-10-01 17:00 KST'), p('ambiguous', undefined, '2026-10-01 12:00 KST')]), { state: 'found', answer: 'yes', earlier: [1] });
  // The same minute twice with two answers; yes→no→yes on one day by minutes (the last is 예); a day-only 예 then that day's 아니오 by minute.
  assert.equal(decide([p('confirmed', 'yes', '2026-10-01 17:00 KST'), p('confirmed', 'no', '2026-10-01 17:00 KST')]).state, 'ambiguous');
  assert.deepEqual(decide([p('confirmed', 'yes', '2026-10-01 09:00 KST'), p('confirmed', 'no', '2026-10-01 12:00 KST'), p('confirmed', 'yes', '2026-10-01 15:00 KST')]),
    { state: 'found', answer: 'yes', earlier: [1] });
  assert.equal(decide([p('confirmed', 'yes', '2026-10-01'), p('confirmed', 'no', '2026-10-01 12:00 KST'), p('confirmed', 'yes', '2026-10-01 15:00 KST')]).state, 'ambiguous');
  // No time (E) is never earlier.
  assert.equal(decide([p('confirmed', 'yes', '2026-10-02'), p('ambiguous', undefined, null)]).state, 'ambiguous');
  assert.deepEqual(decide([]), { state: 'no-record', earlier: [] });
  assert.deepEqual(decide([p('ambiguous', undefined, '2026-10-01')]), { state: 'ambiguous', earlier: [] });
  // Every order of the same pieces decides the same.
  const pieces = [p('confirmed', 'yes', '2026-10-01'), p('confirmed', 'no', '2026-10-02 10:00 KST'), p('ambiguous', undefined, '2026-09-30'), p('confirmed', 'no', '2026-10-02')];
  const perms = a => a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(rest => [x, ...rest]));
  assert.deepEqual(new Set(perms(pieces).map(list => JSON.stringify([decide(list).state, decide(list).answer]))), new Set([JSON.stringify(['found', 'no'])]));
  // Split over two files: one rule reading both — 아니오 the next day in the second file wins; the same day by day only does not.
  const both = { ...SELECTED, files: ['STATE.md', '기록/B.md'] };
  await expectCells(t, { def: grant({ sources: [both, AGREE] }), text: state('- 2026-10-01 17:00 KST: [A사][선정]'), files: { ...TWO, '기록/B.md': '## 건 기록\n- 2026-10-02: [A사][미선정]\n' } }, { A사: { selected: 'no' } });
  await expectCells(t, { def: grant({ sources: [both, AGREE] }), text: state('- 2026-10-01 17:00 KST: [A사][선정]'), files: { ...TWO, '기록/B.md': '## 건 기록\n- 2026-10-01: [A사][미선정]\n' } }, { A사: { selected: 'ambiguous' } });
  // A file named by a rule and not there: its section is not there either (said), the other file still reads.
  const gone = await expectCells(t, { def: grant({ sources: [both, AGREE] }), text: state('- 2026-10-01 17:00 KST: [A사][선정]') }, { A사: { selected: 'yes' } });
  assert.deepEqual(gone.logNotes, [{ kind: 'no-section', path: '기록/B.md', section: '건 기록', missing: true }]);
});

test('REQ-125 U4a 309 2.5 times: calendar days, KST minutes, the reading\'s KST day turning at 15:00 UTC', () => {
  assert.equal(tagLine('- 2028-02-29: [A][B]')?.time.day, '2028-02-29');
  for (const bad of ['- 2026-02-29: [A][B]', '- 2026-13-01: [A][B]', '- 2026-00-10: [A][B]', '- 2026-04-31: [A][B]', '- 2026-10-01 24:00 KST: [A][B]', '- 2026-10-01 23:60 KST: [A][B]',
    '- 2026-10-01 7:05 KST: [A][B]', '- 2026-10-01 17:00 kst: [A][B]', '- 2026-10-01 17:00 KST : [A][B]'])
    assert.equal(tagLine(bad), null, bad);
  assert.deepEqual(tagLine('- 2026-10-01 23:59 KST: [A사][선정]'), { time: { day: '2026-10-01', minute: 1439, text: '2026-10-01 23:59 KST' }, name: 'A사', word: '선정' });
  assert.deepEqual(kstNow(new Date('2026-10-04T14:59:00Z')), { day: '2026-10-04', minute: 1439, text: '2026-10-04' });
  assert.deepEqual(kstNow(new Date('2026-10-04T15:00:00Z')), { day: '2026-10-05', minute: 0, text: '2026-10-05' });
  assert.equal(surelyEarlier(logTime('2026-10-01'), logTime('2026-10-01 00:01 KST')), false);
  assert.equal(surelyEarlier(logTime('2026-09-30 23:59 KST'), logTime('2026-10-01')), true);
  assert.equal(surelyEarlier(logTime('2026-10-01'), logTime('2026-10-01')), false);
  assert.equal(surelyEarlier(null, logTime('2026-10-01')), false);
});

test('REQ-125 U4a 309 5절 2 MB and reading whole: exactly 2 MB reads, one byte more is not read at all; short, grown, failed, budget, link, 501 pieces', async t => {
  const pad = (body, size) => { const text = state(...body); return text + 'x'.repeat(size - Buffer.byteLength(text)); };
  const limit = WORKFLOW_LIMITS.wholeFileBytes;
  // The pad is the last line of the section (writing): read whole, it stops the answers (E) — so exactly 2 MB was read.
  const exact = await expectCells(t, { text: pad(['- 2026-10-01: [A사][선정]', ''], limit) }, { A사: { selected: 'ambiguous' } });
  assert.ok(!exact.limits.some(l => l.startsWith('file-too-large')));
  // 309 #22: one byte past it, with the latest correction at its end — not read, not even its start: 일부만 읽음, no answer.
  const over = await expectCells(t, { text: pad(['- 2026-10-01: [A사][선정]'], limit) + '\n- 2026-10-03: [A사][미선정]\n' }, { A사: { selected: 'incomplete', submit: 'incomplete' }, B사: { selected: 'incomplete' } });
  assert.ok(over.limits.includes('file-too-large:STATE.md') && over.incomplete.includes('STATE.md'));
  assert.equal(over.cost.bytes, 0, 'no byte of it read');
  // Reading whole (J4) with stand-in handles: cut short, grown, and an error.
  const handle = chunks => ({ async read(buffer, offset) { const next = chunks.shift(); if (next instanceof Error) throw next; if (!next) return { bytesRead: 0 }; next.copy(buffer, offset); return { bytesRead: next.length }; } });
  assert.equal((await readWhole(handle([Buffer.from('abc'), Buffer.from('de')]), 5)).toString(), 'abcde');
  assert.equal(await readWhole(handle([Buffer.from('abc')]), 5), null, 'cut short');
  assert.equal(await readWhole(handle([Buffer.from('abcde'), Buffer.from('f')]), 5), null, 'grown while read');
  await assert.rejects(readWhole(handle([Buffer.from('ab'), new Error('EIO')]), 5));
  // The byte budget left smaller than the file: 일부만 읽음.
  await expectCells(t, { text: state('- 2026-10-01: [A사][선정]'), limits: { ...WORKFLOW_LIMITS, bytes: 10 } }, { A사: { selected: 'incomplete' } });
  // The record file a link (inside the workspace) or in a linked folder: not followed — left out and 일부만 읽음.
  const link = await expectCells(t, { def: grant({ sources: [{ ...SELECTED, files: ['기록/STATE.md'] }, AGREE] }),
    files: { ...TWO, '진짜/STATE.md': state('- 2026-10-01: [A사][선정]'), '기록': { link: '진짜' } } }, { A사: { selected: 'incomplete' } });
  assert.ok(link.excluded.some(x => x.path === '기록' && x.why === 'link'));
  const fileLink = await expectCells(t, { files: { ...TWO, '진짜.md': state('- 2026-10-01: [A사][선정]'), 'STATE.md': { link: '진짜.md' } } }, { A사: { selected: 'incomplete' } });
  assert.ok(fileLink.excluded.some(x => x.path === 'STATE.md' && x.why === 'link'));
  // 501 pieces in one cell (own and shared together): 일부만 읽음 and said; 500 still decide.
  const lines = n => Array.from({ length: n }, (_, i) => `- 2026-0${1 + Math.floor(i / 28) % 9}-${String(1 + i % 28).padStart(2, '0')} ${String(Math.floor(i / 252) + 10)}:00 KST: [A사][선정]`);
  await expectCells(t, { text: state(...lines(500)) }, { A사: { selected: 'yes' } });
  const cap = await expectCells(t, { text: state(...lines(500), '- 2026-10-01: [옛A사][미선정]') }, { A사: { selected: 'incomplete' }, B사: { selected: 'ambiguous' } });
  assert.ok(cap.limits.includes('events-per-rule:selected'));
  assert.equal(cell(row(cap, 'A사'), 'selected').events.length + cell(row(cap, 'A사'), 'selected').shared, 500);
});

test('REQ-125 U4a one reading, one text: a file several rules read is opened once; a record row orders by its confirmed day', async t => {
  const m = await expectCells(t, { def: grant({ sources: [SUBMIT, SELECTED, AGREE] }), text: state('- 2026-09-29: [A사][제출]', '- 2026-10-03: [B사][제출]', '- 2026-10-01 17:00 KST: [A사][선정]'),
    files: { [ROOT + '/01_A사/x.md']: 'x', [ROOT + '/02_B사/x.md']: 'x' } }, { A사: { submit: 'found', selected: 'yes' }, B사: { submit: 'found', selected: 'no-record' } });
  assert.equal(m.cost.files, 1, 'STATE.md read once for both rules');
  assert.deepEqual(m.releases.map(r => r.label), ['B사', 'A사'], 'B사 (10-03) before A사 (10-01 17:00)');
  // The way: a confirmed record box, and (U4b, 309 4.2) a decision with a confirmed answer; the figure counts confirmed cells.
  assert.deepEqual(row(m, 'A사').path, [{ stage: 'submit' }, { stage: 'selected' }]);
  assert.deepEqual(m.totals.map(t => [t.stage, t.window.count]), [['submit', 2], ['selected', 1], ['agree', 0]]);
  // An ambiguous record box is neither on the way nor counted.
  const amb = await expectCells(t, { text: state('- 2026-09-29: [A사][제출]', '- 2026-09-29: [A사][제츨]') }, { A사: { submit: 'ambiguous' } });
  assert.deepEqual(row(amb, 'A사').path, [{ stage: 'agree' }]);
});

// ---- the screen's model (309 8.1 화면) ----------------------------------------------------------------------------------------
test('REQ-125 U4a the screen\'s model: a ◇ column, its words and marks, the ladder\'s ◇ line, evidence standing in every 건', async t => {
  const m = await expectCells(t, { text: state('- 2026-09-29: [A사][제출]', '- 2026-10-01 17:00 KST: [A사][선정]', '- 2026-10-02: [B사][선정]', '- 2026-10-03: [B사][미선졍]', '- 2026-09-01: [C사][선정]') },
    { A사: { selected: 'yes', submit: 'found' }, B사: { selected: 'ambiguous' } });
  assert.deepEqual(tableStages(m).map(s => s.id), ['submit', 'selected', 'agree'], 'the decision a record rule reads has its column');
  const a = row(m, 'A사'), b = row(m, 'B사'), sel = stageOf(m, 'selected'), sub = stageOf(m, 'submit');
  assert.equal(tableCell(a, sel, W).text, '예 · 10/1 17:00 · 「건 기록」 기준');
  assert.equal(tableCell(a, sel, WE).text, 'Yes · 10/1 17:00 · per “건 기록”');
  assert.equal(tableCell(a, sub, W).text, '제출 · 9/29 · 「건 기록」 기준');
  // B사: its own two pieces and C사's unknown name (every 건) — "근거 3".
  assert.equal(tableCell(b, sel, W).text, '⚠ 모호 — 근거 3');
  assert.equal(sharedEvidence(m, b, 'selected').length, 1);
  assert.deepEqual([cellMark(a, sel, W, 'instance').mark, cellMark(b, sel, W, 'instance').mark, cellMark(a, sub, W, 'instance').mark], ['✓', '⚠', '●']);
  const no = await expectCells(t, { text: state('- 2026-10-02: [A사][미선정]') }, { A사: { selected: 'no' } });
  assert.deepEqual([cellMark(row(no, 'A사'), sel, W, 'instance').mark, tableCell(row(no, 'A사'), sel, W).text], ['✕', '아니오 · 10/2 · 「건 기록」 기준']);
  // The ladder: the decision says its cell in words; U4b: confirmed, it is passed and its answer's way is marked; no figure chip for it.
  const ladder = ladderItems(m, a, W).filter(i => i.kind === 'step');
  const diamond = ladder.find(i => i.stage.id === 'selected');
  assert.deepEqual([diamond.note, diamond.passed, diamond.chip], ['예 · 10/1 17:00 · 「건 기록」 기준', true, '']);
  assert.deepEqual(diamond.ways, [{ text: '선정 → 협약·계약', on: true }, { text: '미선정 → 미선정·철회', on: false }]);
  assert.equal(diamond.cut, false, 'the answer goes on down the ladder');
  assert.equal(ladderItems(m, b, W).find(i => i.kind === 'step' && i.stage.id === 'selected').ways, undefined, 'an ambiguous decision marks no way');
  assert.equal(stageCounts(m, W).selected, undefined);
  assert.equal(logText(cell(a, 'selected'), W), '예 · 10/1 17:00 · 「건 기록」 기준');
  // The flow: a 건's record box says its table words; U4b: the line into the confirmed decision and its 예 branch only are bold.
  const overlay = flowOverlay(m.definition, a, W, 'instance'), edge = i => m.definition.edges[i].from + '>' + m.definition.edges[i].to;
  assert.deepEqual(overlay.notes.submit, ['제출 · 9/29 · 「건 기록」 기준']);
  assert.deepEqual([...overlay.hot].map(edge).sort(), ['selected>agree', 'submit>selected']);
  assert.deepEqual([...flowOverlay(m.definition, b, W, 'instance').hot].map(edge), [], 'B사 (ambiguous): no line to or from the decision');
  // Copy: both languages hold every new word.
  for (const key of ['answerYes', 'answerNo', 'logNoSection', 'logNotTagLines', 'logSectionInComment', 'logOtherItem', 'logUntaggable', 'evidenceLogBasis', 'evidenceLogAmbiguous',
    'evidenceLogIncomplete', 'evidenceLogNoRecord', 'logWhy', 'workflowInstanceLegendLog', 'workflowInstanceLadderLegendLog', 'workflowInstanceMarksLegendLog'])
    assert.ok(ko[key] && en[key], key);
  assert.equal(ko.logNotTagLines('건 기록', 2, '12, 15'), '건 기록 구역에 해석 못 한 글 2개(줄 12, 15) — 이 구역을 읽는 판단 칸은 모두 모호입니다. 태그 줄만 남기고 메모는 다른 곳에 적으세요.');
  assert.equal(ko.logNoSection('STATE.md', '건 기록'), '기록 확인 필요 — STATE.md에 「건 기록」 제목이 없음');
  assert.deepEqual([en.stateAmbiguous(1), en.stateAmbiguous(2), ko.stateAmbiguous(1)], ['Ambiguous — 1 piece of evidence', 'Ambiguous — 2 pieces of evidence', '모호 — 근거 1']);
  for (const why of ['not-a-tag-line', 'unknown-word', 'future', 'hidden-overlap', 'unknown-instance', 'stripped-name']) assert.ok(ko.logWhy[why] && en.logWhy[why], why);
});

test('REQ-125 U4a no record rule → no record keys: a U1~U3 reading has no logShared, logNotes, answer or shared, and no ◇ column', async t => {
  const def = grant({ features: ['instance-folder', 'folder', 'state-log'], sources: [AGREE] });
  const m = await read(await workspace(t, def, { ...TWO, 'STATE.md': state('- 2026-10-01: [A사][선정]') }));
  assert.equal(m.defined, true);
  assert.ok(!('logShared' in m) && !('logNotes' in m));
  assert.ok(m.releases.every(r => r.cells.every(c => !('answer' in c) && !('shared' in c))));
  assert.deepEqual(tableStages(m).map(s => s.id), ['agree']);
  assert.equal(m.cost.files, 0, 'STATE.md not read');
});

test('REQ-125 U4a the lines: fences and comments are tracked from the top of the file; ranges end at the same or a higher heading', () => {
  const lines = logLines(['# a', '<!-- x', '## 건 기록', '-->', '## 건 기록', '- 1', '### 메모', '```', '## 가짜', '```', '## 끝', ''].join('\n'));
  assert.deepEqual(lines.map(l => [l.n, l.heading?.level ?? 0, l.code, l.comment]).slice(0, 11),
    [[1, 1, false, false], [2, 0, false, true], [3, 0, false, true], [4, 0, false, true], [5, 2, false, false], [6, 0, false, false], [7, 3, false, false],
      [8, 0, true, false], [9, 0, true, false], [10, 0, true, false], [11, 2, false, false]]);
  assert.equal(lines[2].commentHeading, '건 기록');
  assert.deepEqual(sectionRanges(lines, '건 기록'), [[5, 10]]);
  // "<!-- a --> <!-- b" leaves a comment open; "<!-- a -->" closes on its line.
  assert.deepEqual(logLines('<!-- a --> <!-- b\n## x\n-->\n## y').map(l => [l.comment, l.heading?.text ?? null]), [[true, null], [true, null], [true, null], [false, 'y']]);
  // A 2 MB line of spaces is scanned in linear time (no pattern backtracks over it).
  const started = Date.now();
  logLines('# ' + ' '.repeat(2_000_000) + 'x');
  assert.ok(Date.now() - started < 2000);
});

// ---- 317-F1: lengths in the reply's unit — an emoji in a long memo never leaves the old answer up ----------------------------------
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const replyOk = m => workflowGet.output.safeParse({ ok: true, data: m, committed: false, warnings: [] }).success;
test('REQ-125 U4a 317-F1: a long memo with emoji, ZWJ, flags or combining marks — the excerpt fits the reply, the reply passes, the cell is ambiguous', async t => {
  const tail = '기록 설명 '.repeat(80);
  const memos = { 'one emoji': '취소 정정 🔴 ' + tail, 'astral only': '🔴'.repeat(330), 'combining marks': '취소 ' + 'e\u0301'.repeat(160), 'ZWJ family': '취소 ' + '👨‍👩‍👧‍👦'.repeat(40),
    flags: '취소 ' + '🇰🇷'.repeat(80), 'skin tone': '취소 ' + '👍🏽'.repeat(80), 'one grapheme of 400 marks': '취소 a' + '\u0301'.repeat(400) + ' ' + tail,
    // the emoji right at the cut (299 units of text before it)
    'emoji at the cut': '가'.repeat(298) + '🔴' + tail, 'Korean in NFD': '취소 정정 '.normalize('NFD').repeat(60) };
  for (const [name, memo] of Object.entries(memos)) {
    // A confirmed 예 first; then the memo is added (a reading of the same folder with the memo).
    const cwd = await workspace(t, grant(), { ...TWO, 'STATE.md': state('- 2026-10-01 17:00 KST: [A사][선정]') });
    const first = await read(cwd);
    assert.equal(said(cell(row(first, 'A사'), 'selected')), 'yes', name);
    await fs.writeFile(join(cwd, 'STATE.md'), state('- 2026-10-01 17:00 KST: [A사][선정]', memo));
    const m = await read(cwd);
    assert.equal(m.defined, true, name);
    assert.equal(said(cell(row(m, 'A사'), 'selected')), 'ambiguous', name);
    const excerpts = [...m.logShared, ...m.releases.flatMap(r => r.cells.flatMap(c => c.events))].map(e => e.excerpt ?? '');
    for (const x of excerpts) assert.ok(x.length <= EXCERPT_UNITS && !LONE.test(x), name + ': ' + x.length);
    assert.ok(replyOk(m), name + ': the reply passes the RPC output schema');
    assert.deepEqual(replyable(m), m, name + ': the server guard lets it through as it is');
  }
});

test('REQ-125 U4a 317-F1: clipText counts UTF-16 units and cuts between graphemes; the /1 excerpt does too', () => {
  assert.equal(clipText('abc', 3), 'abc');
  assert.equal(clipText('abcd', 3), 'ab…');
  assert.equal(clipText('a🔴b', 3), 'a…', 'a surrogate pair is never split');
  assert.equal(clipText('ab🔴', 3), 'ab…', 'the pair would pass the limit with the ellipsis: cut before it');
  assert.equal(clipText('e\u0301e\u0301e\u0301', 4), 'e\u0301…', 'a letter keeps its combining mark');
  assert.equal(clipText('👨‍👩‍👧‍👦x', 5), '…', 'a ZWJ family is one grapheme — kept whole or not at all');
  assert.equal(clipText('🇰🇷🇰🇷', 5), '🇰🇷…');
  for (const n of [160, 200, 300]) for (const text of ['🔴'.repeat(400), 'x' + '🔴'.repeat(400), '가'.repeat(n - 2) + '👍🏽' + '가'.repeat(10)]) {
    const out = clipText(text, n);
    assert.ok(out.length <= n && !LONE.test(out) && out.endsWith('…'), n + ' ' + out.length);
  }
  // A 2 MB line costs only the excerpt.
  const started = Date.now();
  assert.equal(clipText('🔴'.repeat(1_000_000), 300).length, 299);
  assert.ok(Date.now() - started < 1000);
});

test('REQ-125 U4a 317-F1: a reading that does not fit the reply never goes out — "could not be read" replaces it, in the cache too', async () => {
  const m = { defined: true, definitionPath: '.kanban/workflow.json', key: 'k', readAt: '2026-10-06T00:00:00.000Z', definition: { name: 'x', releaseWindow: 1, stages: [], edges: [] },
    releases: [], totals: [], reports: [], unknownFormat: [], missing: [], git: { state: 'unused', commits: 0 }, cost: { files: 0, bytes: 0, ms: 0 }, limits: [],
    unit: 'instance', logShared: [{ stage: 's', kind: 'log', release: null, releaseFrom: null, path: 'STATE.md', excerpt: 'x'.repeat(299) + '🔴' }], logNotes: [] };
  assert.equal(replyOk(m), false, 'the forged reading (301 units) is refused by the reply schema');
  const guarded = replyable(m);
  assert.deepEqual([guarded.defined, guarded.reason], [false, 'unreadable']);
  assert.match(guarded.problems[0], /^reply: logShared\.0\.excerpt/);
  assert.ok(replyOk(guarded), 'what goes out instead passes');
  const reader = createWorkflowReader({ read: async () => m });
  const out = await reader.read('/x');
  assert.deepEqual([out.defined, out.reason], [false, 'unreadable']);
});
