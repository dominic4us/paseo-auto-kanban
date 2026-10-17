// REQ-125 U2 (research/290 2판 2.2·5절 F2, research/305): `file-versions` — the versions of a document left in a 건's folder
// now, "관측한 판의 순서", never how many times work was redone. A document (chain) is its 건, its folder inside the 건 and its
// name without the tokens: the format (`{ext}`) is never part of it (DOCX + PDF of one version are one version), a sorting
// number only where the pattern writes `{nn}`. Versions compare as numbers (v01.0 = v1.0). A file whose written letters fit but
// whose tokens do not (a day not on the calendar) is "형식 모름", never a version. U1 (tests/req125-u1-instances) is unchanged.
// Made-up names in temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkflow, versionReader, calendarDay, versionKey, compareVersionKeys, WORKFLOW_LIMITS } from '../dist/server/workflow.js';
import { workflowDefinition2Schema, workflowDataSchema, versionParts, WORKFLOW_FORMAT_2, WORKFLOW_FEATURES } from '../dist/shared/workflow.js';
import { cellMark, flowOverlay, ladderItems, stageCounts, tableCell, tableStages, versionText, shortDay } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';

const ko = copy('ko'), en = copy('en');
const words = m => ({ verdict: { pass: m.verdictPass, conditional: m.verdictConditional, fail: m.verdictFail, unknown: m.verdictUnknown },
  stateNoRecord: m.stateNoRecord, stateNoSource: m.stateNoSource, stateUnknown: m.stateUnknown, titleUnread: m.titleUnread,
  statePerson: m.statePerson, firstRound: m.firstRound, countFound: m.countFound, loopNone: m.loopNone, loopTimes: m.loopTimes,
  timesShort: m.timesShort, resultNotOk: m.resultNotOk, resultMissing: m.resultMissing,
  dataThere: m.dataThere, stateCandidate: m.stateCandidate, stateAmbiguous: m.stateAmbiguous, stateIncomplete: m.stateIncomplete, countInstances: m.countInstances,
  versionFirst: m.versionFirst, versionNoEarlier: m.versionNoEarlier, versionNext: m.versionNext, versionsSeen: m.versionsSeen, daysMany: m.daysMany });
const W = words(ko);

const ROOT = '사업/05_지원기업 서류';
const PAPER = '{instance}/{nn}_붙임2_4번_작성본_v{ver}_{yyyymmdd}.{ext}';
/** research/290 2.11: the built-in "지원사업" steps with the U2 rules — `docs` the lowest version, `redo` the ones above it. */
const grant = (extra = {}) => ({
  format: WORKFLOW_FORMAT_2, features: ['instance-folder', 'folder', 'file-versions'], name: '지원사업 — 판 사슬 시험',
  instanceKey: { from: 'folder', path: ROOT + '/*', label: 'strip-number-prefix' },
  stages: [
    { id: 'notice', label: '공고·자격 파악', shape: 'pill', row: 0, col: 0 }, { id: 'go', label: '참여?', shape: 'diamond', row: 0, col: 1 },
    { id: 'docs', label: '신청서·계획서 작성', shape: 'box', row: 0, col: 2 }, { id: 'check', label: '최종 확인?', shape: 'diamond', row: 0, col: 3 },
    { id: 'submit', label: '접수·제출', shape: 'box', row: 0, col: 4 }, { id: 'agree', label: '협약·계약', shape: 'box', row: 0, col: 5 },
    { id: 'skip', label: '불참', shape: 'pill', row: 1, col: 1 }, { id: 'redo', label: '서류 수정', shape: 'box', row: 1, col: 3 },
  ],
  edges: [
    { from: 'notice', to: 'go' }, { from: 'go', to: 'docs', when: 'yes' }, { from: 'go', to: 'skip', when: 'no' }, { from: 'docs', to: 'check' },
    { from: 'check', to: 'submit', when: 'yes' }, { from: 'check', to: 'redo', when: 'no' }, { from: 'redo', to: 'check', back: true },
    { from: 'submit', to: 'agree' },
  ],
  sources: [
    { stage: 'docs', read: 'file-versions', files: [PAPER], ver: 'major.minor', observed: 'lowest' },
    { stage: 'redo', read: 'file-versions', files: [PAPER], ver: 'major.minor', observed: 'later' },
    { stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] },
  ],
  ...extra,
});
/** One rule over every file in a 건 folder named `*_v{ver}_{yyyymmdd}.{ext}` (291's pattern), its steps `a` (lowest), `b` (later), `c` (all). */
const plain = (patterns = ['{instance}/*_v{ver}_{yyyymmdd}.{ext}'], extra = {}) => ({
  format: WORKFLOW_FORMAT_2, features: ['instance-folder', 'file-versions'], name: '판 사슬', instanceKey: { from: 'folder', path: '건/*' },
  stages: [{ id: 'a', label: '첫 판', shape: 'box', row: 0, col: 0 }, { id: 'b', label: '다음 판', shape: 'box', row: 0, col: 1 }, { id: 'c', label: '모든 판', shape: 'box', row: 0, col: 2 }],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  sources: [
    { stage: 'a', read: 'file-versions', files: patterns, ver: 'major.minor', observed: 'lowest' },
    { stage: 'b', read: 'file-versions', files: patterns, ver: 'major.minor', observed: 'later' },
    { stage: 'c', read: 'file-versions', files: patterns, ver: 'major.minor' },
  ],
  ...extra,
});
async function workspace(t, def, files = {}) {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'kanban-u2-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = join(cwd, name);
    if (name.endsWith('/')) await fs.mkdir(file, { recursive: true });
    else { await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(file, text); }
  }
  if (def !== null) { await fs.mkdir(join(cwd, '.kanban'), { recursive: true }); await fs.writeFile(join(cwd, '.kanban/workflow.json'), JSON.stringify(def)); }
  return cwd;
}
const NOW = () => new Date('2026-10-05T00:00:00.000Z');
const read = (cwd, options = {}) => readWorkflow(cwd, { now: NOW, ...options });
const row = (m, label) => m.releases.find(r => r.label === label);
const cell = (r, stage) => r.cells.find(c => c.stage === stage);
const stageOf = (m, id) => m.definition.stages.find(s => s.id === id);
const text = (m, label, stage) => tableCell(row(m, label), stageOf(m, stage), W).text;
const vers = c => c.events.map(e => e.ver ?? '?');
/** research/289's two made-up 건: A사 has v1.0 and v2.0 of its 붙임2 (both 9/17), B사 a first draft (9/22). */
const grantFiles = {
  [ROOT + '/01_A사/README.md']: '# A사\n',
  [ROOT + '/01_A사/02_붙임2_4번_작성본_v1.0_20260917.md']: 'v1\n',
  [ROOT + '/01_A사/02_붙임2_4번_작성본_v2.0_20260917.md']: 'v2\n',
  [ROOT + '/01_A사/10_선정·계약/01_체크리스트_v1.0_20261001.md']: '-\n',
  [ROOT + '/02_B사/README.md']: '# B사\n',
  [ROOT + '/02_B사/03_붙임2_4번_작성본_v1.0_20260922.md']: 'v1\n',
};

test('REQ-125 U2 file-versions: the feature is read now, and a grant definition (research/290 2.11) shows the versions seen per 건', async t => {
  assert.ok(WORKFLOW_FEATURES.includes('file-versions'));
  const cwd = await workspace(t, grant(), grantFiles);
  const m = await read(cwd);
  assert.equal(m.defined, true, JSON.stringify(m.problems));
  assert.doesNotThrow(() => workflowDataSchema.parse(m), 'the RPC output schema takes it');
  assert.deepEqual(m.releases.map(r => r.label), ['B사', 'A사'], 'the latest day read first: B사 9/22, A사 9/17 (its contract folder names no day)');
  const a = row(m, 'A사'), b = row(m, 'B사');
  assert.deepEqual([cell(a, 'docs').state, vers(cell(a, 'docs')), cell(a, 'docs').events[0].observed], ['found', ['1.0'], 'lowest']);
  assert.deepEqual([cell(a, 'redo').state, vers(cell(a, 'redo')), cell(a, 'redo').events[0].observed], ['found', ['2.0'], 'later']);
  assert.deepEqual([cell(b, 'docs').state, vers(cell(b, 'docs')), cell(b, 'redo').state], ['found', ['1.0'], 'no-record']);
  const e = cell(a, 'docs').events[0];
  assert.deepEqual([e.kind, e.release, e.chain, e.seen, e.time, e.paths, e.path], ['version', a.release, '{nn}_붙임2_4번_작성본_v{ver}_{yyyymmdd}.{ext}', 2, '2026-09-17',
    [ROOT + '/01_A사/02_붙임2_4번_작성본_v1.0_20260917.md'], ROOT + '/01_A사/02_붙임2_4번_작성본_v1.0_20260917.md']);
  // research/290 3.1's table, word for word — the order seen, never "재작업 N회" or "최초 작성".
  assert.equal(text(m, 'A사', 'docs'), 'v1.0 9/17 (관측된 첫 판)');
  assert.equal(text(m, 'A사', 'redo'), 'v2.0 9/17 (다음 판 1개 관측)');
  assert.equal(text(m, 'B사', 'docs'), 'v1.0 9/22 (관측된 첫 판)');
  assert.equal(text(m, 'B사', 'redo'), '기록 없음');
  for (const s of ['docs', 'redo', 'agree']) for (const r of m.releases) assert.doesNotMatch(tableCell(r, stageOf(m, s), W).text, /재작업|최초|회$/);
  assert.equal(tableCell(a, stageOf(m, 'redo'), words(en)).text, 'v2.0 9/17 (1 later version seen)');
  assert.deepEqual(m.unknownFormat, []);
  assert.deepEqual(tableStages(m).map(s => s.id), ['docs', 'redo', 'agree']);
  assert.deepEqual(stageCounts(m, W), { docs: '자료 있는 건 2', redo: '자료 있는 건 1', agree: '자료 있는 건 1' });
  assert.deepEqual([cellMark(a, stageOf(m, 'redo'), W, 'instance').mark, cellMark(b, stageOf(m, 'redo'), W, 'instance').mark], ['●', '–']);
  // A사's way: its steps with versions or data — decisions are never taken as passed (no answer is read), no loop drawn.
  const overlay = flowOverlay(m.definition, a, W, 'instance');
  assert.deepEqual([...overlay.passed].sort(), ['agree', 'docs', 'redo']);
  assert.equal(overlay.loops.size, 0);
  assert.deepEqual(overlay.notes.redo, ['v2.0 9/17 (다음 판 1개 관측)']);
  assert.equal(ladderItems(m, a, W).find(i => i.kind === 'step' && i.stage.id === 'docs').note, 'v1.0 9/17 (관측된 첫 판)');
});

test('REQ-125 U2 F2 the same version as DOCX and PDF is one version — no later one; its files are all in the evidence', async t => {
  const cwd = await workspace(t, plain(), { '건/A/제안서_v1.0_20261001.docx': '', '건/A/제안서_v1.0_20261001.pdf': '', '건/A/제안서_v1.0_20261001.PDF': '' });
  const m = await read(cwd), a = row(m, 'A');
  assert.deepEqual([vers(cell(a, 'a')), cell(a, 'b').state, vers(cell(a, 'c'))], [['1.0'], 'no-record', ['1.0']]);
  assert.deepEqual(cell(a, 'a').events[0].paths, ['건/A/제안서_v1.0_20261001.PDF', '건/A/제안서_v1.0_20261001.docx', '건/A/제안서_v1.0_20261001.pdf']);
  assert.equal(cell(a, 'a').events[0].seen, 1);
  assert.equal(text(m, 'A', 'b'), '기록 없음');
  assert.equal(text(m, 'A', 'c'), 'v1.0 10/1 (관측된 첫 판)');
  // A real v1 → v2 is one later version seen.
  await fs.writeFile(join(cwd, '건/A/제안서_v2.0_20261002.pdf'), '');
  const n = await read(cwd), b = row(n, 'A');
  assert.deepEqual([vers(cell(b, 'a')), vers(cell(b, 'b')), vers(cell(b, 'c'))], [['1.0'], ['2.0'], ['1.0', '2.0']]);
  assert.equal(text(n, 'A', 'b'), 'v2.0 10/2 (다음 판 1개 관측)');
  assert.equal(text(n, 'A', 'c'), 'v1.0 → v2.0 10/2 (관측된 판 2개)');
});

test('REQ-125 U2 F2 only v2.0 left (v1.0 moved away) is the first version seen — said with "no earlier version in this folder", never "first written"', async t => {
  const cwd = await workspace(t, plain(), { '건/A/제안서_v2.0_20261001.docx': '', '건/B/제안서_v1.0_20261001.md': '', '건/C/제안서_v0.3_20261001.md': '',
    '건/D/제안서_v1.1_20261001.md': '', '건/E/제안서_v10.0_20261001.md': '' });
  const m = await read(cwd);
  assert.deepEqual([cell(row(m, 'A'), 'a').events[0].observed, cell(row(m, 'A'), 'b').state], ['lowest', 'no-record']);
  assert.equal(text(m, 'A', 'a'), 'v2.0 10/1 (관측된 첫 판 — 이전 판은 이 폴더에 없음)');
  assert.equal(text(m, 'B', 'a'), 'v1.0 10/1 (관측된 첫 판)', '1.0: no tail');
  assert.equal(text(m, 'C', 'a'), 'v0.3 10/1 (관측된 첫 판)', '0.x: no tail');
  assert.equal(text(m, 'D', 'a'), 'v1.1 10/1 (관측된 첫 판 — 이전 판은 이 폴더에 없음)');
  assert.equal(text(m, 'E', 'a'), 'v10.0 10/1 (관측된 첫 판 — 이전 판은 이 폴더에 없음)', '10 is not 1');
  assert.equal(tableCell(row(m, 'A'), stageOf(m, 'a'), words(en)).text, 'v2.0 10/1 (first version seen — no earlier version in this folder)');
  // integer and major.minor.patch shapes: 1 and 1.0.0 are first versions, 2 and 1.0.1 not.
  const shapes = [['integer', '{instance}/안_v{ver}.{ext}', { '건/A/안_v1.md': '', '건/B/안_v2.md': '', '건/C/안_v0.md': '' }, { A: '', B: ' — 이전 판은 이 폴더에 없음', C: '' }],
    ['major.minor.patch', '{instance}/안_v{ver}.{ext}', { '건/A/안_v1.0.0.md': '', '건/B/안_v1.0.1.md': '' }, { A: '', B: ' — 이전 판은 이 폴더에 없음' }]];
  for (const [ver, pattern, files, want] of shapes) {
    const s = await read(await workspace(t, plain([pattern], { sources: [{ stage: 'a', read: 'file-versions', files: [pattern], ver, observed: 'lowest' }] }), files));
    for (const [label, tail] of Object.entries(want)) assert.match(text(s, label, 'a'), new RegExp('\\(관측된 첫 판' + tail + '\\)$'), ver + ' ' + label);
  }
});

test('REQ-125 U2 F2 the same name in two folders of a 건 is two documents; v01.0 and v1.0 are one version; one version on two days says so', async t => {
  const cwd = await workspace(t, plain(['{instance}/*/*_v{ver}_{yyyymmdd}.{ext}']), {
    '건/A/x/보고서_v1.0_20261001.md': '', '건/A/y/보고서_v1.0_20261003.md': '', '건/A/y/보고서_v2.0_20261004.md': '',
    '건/B/x/보고서_v01.0_20261001.md': '', '건/B/x/보고서_v1.0_20261005.md': '', '건/B/x/보고서_v1.00_20261002.hwp': '' });
  const m = await read(cwd), a = row(m, 'A'), b = row(m, 'B');
  assert.deepEqual(cell(a, 'a').events.map(e => [e.chain, e.ver]), [['x/보고서_v{ver}_{yyyymmdd}.{ext}', '1.0'], ['y/보고서_v{ver}_{yyyymmdd}.{ext}', '1.0']]);
  assert.deepEqual(cell(a, 'b').events.map(e => [e.chain, e.ver]), [['y/보고서_v{ver}_{yyyymmdd}.{ext}', '2.0']], 'x keeps its own lowest: nothing later in x');
  assert.equal(text(m, 'A', 'a'), 'v1.0 10/1 (관측된 첫 판) +1', 'the other document is "+1"');
  // v01.0, v1.0 and v1.00 are one version (numbers); its day is the earliest, and the several days are said.
  const e = cell(b, 'a').events;
  assert.deepEqual([e.length, e[0].ver, e[0].time, e[0].days, e[0].paths.length, cell(b, 'b').state], [1, '1.0', '2026-10-01', 3, 3, 'no-record']);
  assert.equal(text(m, 'B', 'a'), 'v1.0 10/1 (관측된 첫 판 · 날짜 여러 개)');
  assert.deepEqual([versionKey('01.0'), versionKey('1.00'), versionKey('007'), compareVersionKeys('1.10', '1.9') > 0, compareVersionKeys('2.0', '10.0') < 0, compareVersionKeys('1.0', '01.00')],
    ['1.0', '1.0', '7', true, true, 0]);
});

test('REQ-125 U2 F2 a day not on the calendar is "형식 모름" — never a version; a name that does not fit the written letters is not read at all', async t => {
  const cwd = await workspace(t, plain(), {
    '건/A/제안서_v1.0_20261001.md': '', '건/A/제안서_v2.0_20260231.md': '',
    '건/B/제안서_v1.0_20260231.md': '', '건/B/제안서_v최종_20261001.md': '', '건/B/제안서_v1.0_20261001_검토.md': '',
    '건/C/제안서_최종.md': '', '건/C/메모.md': '' });
  const m = await read(cwd), a = row(m, 'A'), b = row(m, 'B'), c = row(m, 'C');
  assert.deepEqual([cell(a, 'a').state, vers(cell(a, 'a')), cell(a, 'b').state, vers(cell(a, 'b'))], ['found', ['1.0', '?'], 'unknown-format', ['?']],
    '20260231 is no later version: the 다음 판 cell says 형식 모름, not v2.0');
  assert.equal(text(m, 'A', 'a'), 'v1.0 10/1 (관측된 첫 판) · 형식 모름 1');
  assert.equal(text(m, 'A', 'b'), '형식 모름 · 제안서_v2.0_20260231.md');
  assert.deepEqual([cell(b, 'a').state, cell(b, 'a').events.length], ['unknown-format', 3]);
  assert.equal(text(m, 'B', 'a'), '형식 모름 · 제안서_v1.0_20260231.md +2');
  assert.deepEqual([cellMark(b, stageOf(m, 'a'), W, 'instance').mark, cellMark(b, stageOf(m, 'a'), W, 'instance').tone], ['?', 'unknown']);
  // research/290 2.2 contract: the written letters must fit — "제안서_최종.md" has no "_v…_" and is no file of this document.
  assert.deepEqual([cell(c, 'a').state, cell(c, 'c').state], ['no-record', 'no-record']);
  assert.deepEqual(m.unknownFormat.map(u => u.stage), ['a', 'a', 'a', 'a'], 'each file once, under the first step that read it');
  assert.deepEqual(m.unknownFormat.map(u => u.path),
    ['건/A/제안서_v2.0_20260231.md', '건/B/제안서_v1.0_20260231.md', '건/B/제안서_v1.0_20261001_검토.md', '건/B/제안서_v최종_20261001.md']);
  // A 건 with only unreadable files is not on the way, nor counted as a 건 with data.
  assert.equal(flowOverlay(m.definition, b, W, 'instance').passed.size, 0);
  assert.deepEqual(stageCounts(m, W), { a: '자료 있는 건 1', b: '자료 있는 건 0', c: '자료 있는 건 1' });
  assert.deepEqual([calendarDay('20260231'), calendarDay('20240229'), calendarDay('20230229'), calendarDay('2026101')], [null, '2024-02-29', null, null]);
});

test('REQ-125 U2 `{nn}` is the writer\'s choice: written, the sorting number is left out (one document); not written, 02_ and 03_ are two documents', async t => {
  const files = { '건/A/02_계획서_v1.0_20261001.md': '', '건/A/03_계획서_v2.0_20261002.md': '' };
  const withNn = await read(await workspace(t, plain(['{instance}/{nn}_계획서_v{ver}_{yyyymmdd}.{ext}']), files));
  assert.deepEqual([vers(cell(row(withNn, 'A'), 'a')), vers(cell(row(withNn, 'A'), 'b'))], [['1.0'], ['2.0']]);
  assert.equal(cell(row(withNn, 'A'), 'a').events[0].chain, '{nn}_계획서_v{ver}_{yyyymmdd}.{ext}');
  const without = await read(await workspace(t, plain(['{instance}/*_v{ver}_{yyyymmdd}.{ext}']), files));
  assert.deepEqual(cell(row(without, 'A'), 'a').events.map(e => [e.chain, e.ver]), [['02_계획서_v{ver}_{yyyymmdd}.{ext}', '1.0'], ['03_계획서_v{ver}_{yyyymmdd}.{ext}', '2.0']]);
  assert.equal(cell(row(without, 'A'), 'b').state, 'no-record');
  // `{nn}` reads one to three digits: "A_계획서…" or "1234_계획서…" fit the letters but not the token → 형식 모름.
  const odd = await read(await workspace(t, plain(['{instance}/{nn}_계획서_v{ver}_{yyyymmdd}.{ext}']), { '건/A/A_계획서_v1.0_20261001.md': '', '건/A/1234_계획서_v1.0_20261001.md': '' }));
  assert.deepEqual([cell(row(odd, 'A'), 'a').state, cell(row(odd, 'A'), 'a').events.length], ['unknown-format', 2]);
});

test('REQ-125 U2 patterns: one rule\'s patterns that reach one file count it once; the folders between are walked like a folder rule\'s', async t => {
  const cwd = await workspace(t, plain(['{instance}/*_v{ver}_{yyyymmdd}.{ext}', '{instance}/제안서_v{ver}_{yyyymmdd}.{ext}', '{instance}/작성*/*_v{ver}.{ext}']), {
    '건/A/제안서_v1.0_20261001.md': '', '건/A/작성본/메모_v3.0.md': '', '건/A/작성본/메모_v1.0.md': '', '건/A/기타/메모_v9.0.md': '' });
  const m = await read(cwd), a = row(m, 'A');
  assert.deepEqual(cell(a, 'c').events.map(e => [e.chain, e.ver, e.paths.length]), [['작성본/메모_v{ver}.{ext}', '1.0', 1], ['작성본/메모_v{ver}.{ext}', '3.0', 1], ['제안서_v{ver}_{yyyymmdd}.{ext}', '1.0', 1]]);
  // A file a later pattern reads that an earlier one only fits is read (the first pattern that reads it).
  const two = await read(await workspace(t, plain(['{instance}/*_v{ver}_{yyyymmdd}.{ext}', '{instance}/*_v{ver}_{yyyymmdd}_최종.{ext}']),
    { '건/A/안_v1.0_20261001_최종.md': '', '건/A/안_v2.0_x.md': '' }));
  assert.deepEqual(cell(row(two, 'A'), 'c').events.map(e => [e.chain ?? e.path, e.ver ?? '?']),
    [['안_v{ver}_{yyyymmdd}_최종.{ext}', '1.0'], ['건/A/안_v2.0_x.md', '?']], 'fit by the first, read by the second: a version; fit by none that reads it: 형식 모름');
});

test('REQ-125 U2 the file segment\'s grammar: {ver} once, {nn} only first, .{ext} only last, no two tokens side by side, tokens only in the file segment', async t => {
  const good = ['{instance}/{nn}_붙임2_4번_작성본_v{ver}_{yyyymmdd}.{ext}', '{instance}/*_v{ver}_{yyyymmdd}.{ext}', '{instance}/안_v{ver}', '{instance}/x/y*/안_v{ver}.md',
    '{instance}/@사업_v{ver}.{ext}', '{instance}/v{ver}'];
  const bad = ['{instance}', '{instance}/', '{instance}/안.md', '{instance}/안_v{ver}_v{ver}.md', '{instance}/안_{nn}_v{ver}.md', '{instance}/{nn}{ver}.md',
    '{instance}/안_v{ver}{yyyymmdd}.md', '{instance}/안_v{ver}*.md', '{instance}/*{ver}.md', '{instance}/안_v{ver}.{ext}.bak', '{instance}/안_v{ver}_{ext}',
    '{instance}/안_v{ver}_{date}.md', '{instance}/안_v{VER}.md', '{instance}/{ver}/안.md', '{instance}/{nn}_폴더/안_v{ver}.md', '{instance}/안_v{ver}/', '{instance}//안_v{ver}',
    '{instance}/../안_v{ver}', '{instance}/**/안_v{ver}', '{instance}/.안_v{ver}', '{instance}/a*b*_v{ver}', '사업/안_v{ver}', 'x/{instance}/안_v{ver}', '{instance}/안_v{ver}}', '{instance}/안_v{{ver}'];
  const parse = files => workflowDefinition2Schema.safeParse(plain(files)).success;
  for (const p of good) assert.equal(parse([p]), true, p);
  for (const p of bad) assert.equal(parse([p]), false, p);
  assert.deepEqual(versionParts('{nn}_안_v{ver}.{ext}'), [{ token: 'nn' }, { text: '_안_v' }, { token: 'ver' }, { text: '.' }, { token: 'ext' }]);
  // The rule's own keys: `ver` required, its three shapes; `observed` lowest/later only; 1판's `nth`/first/again are gone.
  const rule = extra => workflowDefinition2Schema.safeParse(plain(undefined, { sources: [{ stage: 'a', read: 'file-versions', files: ['{instance}/안_v{ver}'], ver: 'major.minor', ...extra }] })).success;
  assert.equal(rule({}), true);
  for (const extra of [{ ver: undefined }, { ver: 'semver' }, { observed: 'first' }, { observed: 'again' }, { observed: 'all' }, { nth: 'first' }, { scope: 'program' }, { match: 'name' }])
    assert.equal(rule(extra), false, JSON.stringify(extra));
  // Every feature used is named; a decision takes no rule.
  const m1 = await read(await workspace(t, plain(undefined, { features: ['instance-folder'] })));
  assert.deepEqual([m1.defined, m1.reason], [false, 'unknown-format']);
  assert.match(m1.problems.join(' '), /"file-versions" rule needs the feature "file-versions"/);
  const diamond = plain(); diamond.stages[1].shape = 'diamond';
  const m2 = await read(await workspace(t, diamond));
  assert.deepEqual([m2.defined, m2.reason], [false, 'unknown-format']);
  assert.match(m2.problems.join(' '), /decision b cannot take a reading rule: "file-versions" only says which versions are there/);
  // A folder rule still takes no token (U1 unchanged).
  assert.equal(workflowDefinition2Schema.safeParse(grant({ sources: [{ stage: 'docs', read: 'folder', files: ['{instance}/안_v{ver}'] }] })).success, false);
});

test('REQ-125 U2 names: hidden, @ and # are passed over unless written; links and two names one in NFC are left out and said; NFD names are read in NFC', async t => {
  const cwd = await workspace(t, plain(['{instance}/*_v{ver}.{ext}', '{instance}/{nn}_안_v{ver}.{ext}', '{instance}/@견적_v{ver}.{ext}']), {
    '건/A/._제안서_v1.0.md': '', '건/A/.제안서_v1.0.md': '', '건/A/@eaDir_v1.0.md': '', '건/A/#tmp_v1.0.md': '', '건/A/@견적_v2.0.pdf': '',
    '건/A/제안서_v1.0.md': '', '건/A/01_안_v1.0.md': '', '건/A/._01_안_v2.0.md': '' });
  await fs.symlink(join(cwd, '건/A/제안서_v1.0.md'), join(cwd, '건/A/제안서_v3.0.md'));
  await fs.symlink('/etc/hostname', join(cwd, '건/A/바깥_v1.0.md'));
  const nfd = '계획서'.normalize('NFD');
  await fs.writeFile(join(cwd, '건/A/' + nfd + '_v1.0.md'), '');
  const m = await read(cwd), a = row(m, 'A');
  assert.deepEqual(cell(a, 'c').events.map(e => [e.chain, e.ver]), [
    // "01_안_v1.0.md" is read by the first pattern that reads it (`*`), so its number stays in its name.
    ['01_안_v{ver}.{ext}', '1.0'], ['@견적_v{ver}.{ext}', '2.0'], ['계획서_v{ver}.{ext}', '1.0'], ['제안서_v{ver}.{ext}', '1.0']]);
  assert.ok(cell(a, 'c').events.every(e => e.path.normalize('NFC') === e.path));
  assert.deepEqual(m.excluded, [{ path: '건/A/바깥_v1.0.md', why: 'link' }, { path: '건/A/제안서_v3.0.md', why: 'link' }]);
  assert.equal(JSON.stringify(m).includes('hostname'), false);
  assert.deepEqual(m.unknownFormat, []);
  // Two file names one in NFC: both left out, never one picked.
  const two = await workspace(t, plain(['{instance}/*_v{ver}.{ext}']), { ['건/A/' + '계획서'.normalize('NFC') + '_v1.0.md']: '' });
  await fs.writeFile(join(two, '건/A/' + nfd + '_v1.0.md'), '');
  const n = await read(two);
  assert.deepEqual([cell(row(n, 'A'), 'a').state, n.excluded], ['no-record', [{ path: '건/A/계획서_v1.0.md', why: 'nfc-collision' }]]);
});

test('REQ-125 U2 "일부만 읽음" comes first: a folder cut at a cap or a rule past its events keeps what it read and never says "기록 없음"', async t => {
  const files = { '건/A/제안서_v1.0_20261001.md': '', '건/B/제안서_v1.0_20261001.md': '' };
  for (let i = 0; i < 6; i++) files[`건/A/z${i}.md`] = '';
  const cwd = await workspace(t, plain(), files);
  const cut = await read(cwd, { limits: { ...WORKFLOW_LIMITS, folderEntries: 4 } });
  const a = row(cut, 'A');
  assert.deepEqual([cell(a, 'a').state, cell(a, 'b').state, cell(row(cut, 'B'), 'b').state], ['incomplete', 'incomplete', 'no-record']);
  assert.ok(cut.incomplete.includes('건/A'));
  assert.match(text(cut, 'A', 'b'), /^▨ 일부만 읽음/);
  // The rule's events past `eventsPerRule`: cut, said in limits, the cell 일부만 읽음 with what it took.
  const many = {};
  for (let i = 1; i <= 7; i++) many[`건/A/안_v${i}.0_20261001.md`] = '';
  const m = await read(await workspace(t, plain(), many), { limits: { ...WORKFLOW_LIMITS, eventsPerRule: 5 } });
  const c = cell(row(m, 'A'), 'c');
  assert.deepEqual([c.state, c.events.length, m.limits.includes('events-per-rule:c'), cell(row(m, 'A'), 'a').state], ['incomplete', 5, true, 'found']);
  assert.equal(tableCell(row(m, 'A'), stageOf(m, 'c'), W).text, '▨ 일부만 읽음 · v1.0 → v5.0 10/1 (관측된 판 5개)');
  assert.deepEqual([cellMark(row(m, 'A'), stageOf(m, 'c'), W, 'instance').mark], ['▨']);
});

test('REQ-125 U2 names are matched in time their length bounds — the written letters are looked for in order, one open repeat at most', () => {
  const r = versionReader('{nn}_가_v{ver}_{yyyymmdd}_나.{ext}', 'major.minor.patch');
  const long = '1_가_v' + '_가_v1.0_20261001'.repeat(14) + 'x';
  const started = performance.now();
  for (let i = 0; i < 200; i++) { r.fits(long); r.read(long); }
  assert.ok(performance.now() - started < 500, 'no runaway matching');
  assert.deepEqual(r.read('01_가_v1.02.3_20261001_나.md'), { ver: '1.2.3', day: '2026-10-01', chain: '{nn}_가_v{ver}_{yyyymmdd}_나.{ext}' });
  assert.equal(r.read('01_가_v1.2_20261001_나.md'), null, 'major.minor.patch needs three numbers');
  assert.equal(r.fits('01_가_v1.2_20261001_나.md'), true, '… but the letters fit: 형식 모름');
  assert.equal(r.fits('.01_가_v1.0.0_20261001_나.md'), false, 'a hidden name is passed over where no letters are written first');
  const s = versionReader('*_v{ver}.{ext}', 'major.minor');
  assert.deepEqual(s.read('a_v1_v2.0.md'), { ver: '2.0', day: null, chain: 'a_v1_v{ver}.{ext}' }, '* takes the longest, the version the last');
  assert.equal(s.fits('_v1.0.md'), true);
  assert.deepEqual(s.read('_v1.0.md'), { ver: '1.0', day: null, chain: '_v{ver}.{ext}' });
  assert.equal(shortDay('2026-09-07'), '9/7');
});

test('REQ-125 U2 reading writes nothing, and a lane with only U1 rules reads as before', async t => {
  const cwd = await workspace(t, grant(), grantFiles);
  const snap = async () => {
    const out = [];
    const walk = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name), s = await fs.lstat(p);
      out.push([relative(cwd, p), s.size, s.mtimeMs].join('|'));
      if (e.isDirectory()) await walk(p);
    } };
    await walk(cwd);
    return createHash('sha256').update(out.sort().join('\n')).digest('hex');
  };
  const before = await snap();
  await read(cwd); await read(cwd);
  assert.equal(await snap(), before);
  // A /2 file with folder rules only: no version key anywhere, unknownFormat stays empty.
  const u1 = await read(await workspace(t, grant({ features: ['instance-folder', 'folder'], sources: [{ stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] }] }), grantFiles));
  assert.deepEqual([u1.unknownFormat, JSON.stringify(u1).includes('"ver"'), cell(row(u1, 'A사'), 'agree').state], [[], false, 'found']);
});

test('REQ-125 U2 versionText: other documents "+N", unreadable "· 형식 모름 N", and the evidence words keep the meaning (order seen, not rework)', () => {
  const e = (chain, ver, observed, extra = {}) => ({ stage: 's', kind: 'version', release: 'x', releaseFrom: null, path: chain + ver, chain, ver, observed, ...extra });
  assert.equal(versionText([e('a', '1.0', 'lowest', { time: '2026-09-17' }), e('b', '1.0', 'lowest')], W), 'v1.0 9/17 (관측된 첫 판) +1');
  assert.equal(versionText([e('a', '2.0', 'later', { time: '2026-09-17' }), e('a', '3.0', 'later', { time: '2026-09-20', days: 2 })], W), 'v3.0 9/20 (다음 판 2개 관측 · 날짜 여러 개)');
  assert.equal(versionText([e('a', '1.0', 'lowest'), { stage: 's', kind: 'version', release: 'x', releaseFrom: null, path: 'a/z.md' }], W), 'v1.0 (관측된 첫 판) · 형식 모름 1');
  assert.match(ko.evidenceVersions, /남은 판의 순서/);
  assert.doesNotMatch(ko.evidenceVersions + ko.versionFirst + ko.versionNext(2) + ko.versionsSeen(2), /재작업|최초 작성/);
  assert.equal(ko.evidenceVersion('2.0', ko.versionLater, '안_v{ver}.{ext}'), 'v2.0 · 다음 판 · 문서 안_v{ver}.{ext}');
});

test('REQ-125 U2 a step that reads both a folder and versions says both, each in its words', async t => {
  const def = grant({ sources: [{ stage: 'docs', read: 'file-versions', files: [PAPER], ver: 'major.minor', observed: 'lowest' },
    { stage: 'docs', read: 'folder', files: ['{instance}/10_선정·계약'] }] });
  const m = await read(await workspace(t, def, grantFiles));
  assert.equal(text(m, 'A사', 'docs'), 'v1.0 9/17 (관측된 첫 판) · 자료 있음 · 10_선정·계약');
  assert.equal(text(m, 'B사', 'docs'), 'v1.0 9/22 (관측된 첫 판)');
});

test('REQ-125 U2 306-F1 the format is never part of a document, however the pattern names it: .docx, .pdf, .* and .{ext} read one chain', async t => {
  const chainOf = m => cell(row(m, 'A'), 'c').events.map(e => [e.chain, e.ver, e.observed, (e.paths ?? []).length]);
  // Two written extensions: DOCX v1.0 then PDF v2.0 is one document, its next version seen.
  const two = await read(await workspace(t, plain(['{instance}/보고서_v{ver}_{yyyymmdd}.docx', '{instance}/보고서_v{ver}_{yyyymmdd}.pdf']),
    { '건/A/보고서_v1.0_20261001.docx': '', '건/A/보고서_v2.0_20261002.pdf': '' }));
  assert.deepEqual(chainOf(two), [['보고서_v{ver}_{yyyymmdd}.{ext}', '1.0', 'lowest', 1], ['보고서_v{ver}_{yyyymmdd}.{ext}', '2.0', 'later', 1]]);
  assert.equal(text(two, 'A', 'b'), 'v2.0 10/2 (다음 판 1개 관측)');
  // A written .docx and .{ext}, in either order: one version, its two files.
  for (const patterns of [['{instance}/보고서_v{ver}_{yyyymmdd}.docx', '{instance}/보고서_v{ver}_{yyyymmdd}.{ext}'], ['{instance}/보고서_v{ver}_{yyyymmdd}.{ext}', '{instance}/보고서_v{ver}_{yyyymmdd}.docx']]) {
    const m = await read(await workspace(t, plain(patterns), { '건/A/보고서_v1.0_20261001.docx': '', '건/A/보고서_v1.0_20261001.pdf': '' }));
    assert.deepEqual(chainOf(m), [['보고서_v{ver}_{yyyymmdd}.{ext}', '1.0', 'lowest', 2]], JSON.stringify(patterns));
  }
  // `.*` at the end is the extension place too.
  const star = await read(await workspace(t, plain(['{instance}/보고서_v{ver}_{yyyymmdd}.*']), { '건/A/보고서_v1.0_20261001.docx': '', '건/A/보고서_v2.0_20261002.pdf': '' }));
  assert.deepEqual(chainOf(star).map(c => c.slice(0, 3)), [['보고서_v{ver}_{yyyymmdd}.{ext}', '1.0', 'lowest'], ['보고서_v{ver}_{yyyymmdd}.{ext}', '2.0', 'later']]);
  // No extension place: the version's own "." is never cut — v1.0 and v2.0 stay two versions of one document.
  const bare = await read(await workspace(t, plain(['{instance}/안_v{ver}']), { '건/A/안_v1.0': '', '건/A/안_v2.0': '' }));
  assert.deepEqual(chainOf(bare).map(c => c.slice(0, 2)), [['안_v{ver}', '1.0'], ['안_v{ver}', '2.0']]);
  // "_*" at the end is no extension place: what `*` read stays in the name.
  const tail = await read(await workspace(t, plain(['{instance}/안_v{ver}_*']), { '건/A/안_v1.0_가.docx': '', '건/A/안_v2.0_나.docx': '' }));
  assert.deepEqual(chainOf(tail).map(c => c[0]), ['안_v{ver}_가.docx', '안_v{ver}_나.docx']);
  const r = versionReader('보고서_v{ver}.tar.gz', 'major.minor');
  assert.deepEqual(r.read('보고서_v1.0.tar.gz'), { ver: '1.0', day: null, chain: '보고서_v{ver}.tar.{ext}' }, 'the last "." of the written letters');
});

test('REQ-125 U2 306-J9 an Office lock file (~$…) is no version where the pattern does not write its start; written "~$" reads it', async t => {
  const m = await read(await workspace(t, plain(['{instance}/*_v{ver}_{yyyymmdd}.{ext}', '{instance}/{nn}_붙임_v{ver}.{ext}']), {
    '건/A/제안서_v1.0_20261001.docx': '', '건/A/~$안서_v1.0_20261001.docx': '', '건/A/01_붙임_v1.0.docx': '', '건/A/~$_붙임_v1.0.docx': '' }));
  assert.deepEqual(cell(row(m, 'A'), 'c').events.map(e => e.chain), ['{nn}_붙임_v{ver}.{ext}', '제안서_v{ver}_{yyyymmdd}.{ext}']);
  assert.deepEqual(m.unknownFormat, [], 'not 형식 모름 either');
  const written = await read(await workspace(t, plain(['{instance}/~$안서_v{ver}_{yyyymmdd}.{ext}']), { '건/A/~$안서_v1.0_20261001.docx': '' }));
  assert.deepEqual(cell(row(written, 'A'), 'c').events.map(e => e.ver), ['1.0']);
  assert.equal(versionReader('*_v{ver}.{ext}', 'major.minor').fits('~$x_v1.0.md'), false);
});
