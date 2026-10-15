// REQ-125 U3 (research/290 2판 1.2·2.4·3·5절 F5, research/308): `scope: "program"` — a step common to every 건 of the file,
// read once from the workspace folder and shown once in the "공통" band, never per 건. What such a rule finds inside a 건 folder
// (path parts compared whole: `A` is not `AB`) is "규칙 충돌" — neither common nor that 건's. `scope` with `{instance}` or
// `match`, and a step holding both kinds of rule, are refused. U1/U2 (tests/req125-u1-instances, -u2-versions) are unchanged.
// Made-up names in temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkflow, WORKFLOW_LIMITS } from '../dist/server/workflow.js';
import { workflowDefinition2Schema, workflowDataSchema, unreadFeatures, WORKFLOW_FORMAT_2, WORKFLOW_FEATURES } from '../dist/shared/workflow.js';
import { flowLayout, wrapNote } from '../dist/client/workflow-model.js';
import { textWidth } from '../dist/client/layout.js';
import { cellMark, flowOverlay, ladderItems, programConflicts, programRow, programStages, shownExcluded, sourceNotes, stageCounts, tableCell, tableStages, withProgram, PROGRAM_ROW }
  from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';

const ko = copy('ko'), en = copy('en');
const words = m => ({ verdict: { pass: m.verdictPass, conditional: m.verdictConditional, fail: m.verdictFail, unknown: m.verdictUnknown },
  stateNoRecord: m.stateNoRecord, stateNoSource: m.stateNoSource, stateUnknown: m.stateUnknown, titleUnread: m.titleUnread,
  statePerson: m.statePerson, firstRound: m.firstRound, countFound: m.countFound, loopNone: m.loopNone, loopTimes: m.loopTimes,
  timesShort: m.timesShort, resultNotOk: m.resultNotOk, resultMissing: m.resultMissing,
  dataThere: m.dataThere, stateCandidate: m.stateCandidate, stateAmbiguous: m.stateAmbiguous, stateIncomplete: m.stateIncomplete, countInstances: m.countInstances,
  versionFirst: m.versionFirst, versionNoEarlier: m.versionNoEarlier, versionNext: m.versionNext, versionsSeen: m.versionsSeen, daysMany: m.daysMany,
  programName: m.programName, conflicts: m.programConflicts });
const W = words(ko);

const BIZ = '사업', ROOT = BIZ + '/05_지원기업 서류';
const PAPER = '{instance}/{nn}_붙임2_4번_작성본_v{ver}_{yyyymmdd}.{ext}';
const NOTICE = { stage: 'notice', read: 'folder', scope: 'program', files: [BIZ + '/01_공고문'] };
/** research/290 2.11 word for word: the built-in "지원사업" steps, `notice` common to every 건, the 건's papers by version. */
const grant = (extra = {}) => ({
  format: WORKFLOW_FORMAT_2, features: ['instance-folder', 'folder', 'file-versions', 'program'], name: '지원사업 — 공통 띠 시험',
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
    NOTICE,
    { stage: 'docs', read: 'file-versions', files: [PAPER], ver: 'major.minor', observed: 'lowest' },
    { stage: 'redo', read: 'file-versions', files: [PAPER], ver: 'major.minor', observed: 'later' },
  ],
  ...extra,
});
const grantFiles = {
  [BIZ + '/01_공고문/모집공고.pdf']: 'x', [BIZ + '/01_공고문/README.md']: 'x',
  [ROOT + '/01_A사/02_붙임2_4번_작성본_v1.0_20260917.md']: 'x', [ROOT + '/01_A사/02_붙임2_4번_작성본_v2.0_20260917.md']: 'x',
  [ROOT + '/02_B사/03_붙임2_4번_작성본_v1.0_20260922.md']: 'x',
};
async function workspace(t, def, files = {}) {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'kanban-u3-'));
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
const pcell = (m, stage) => m.program.cells.find(c => c.stage === stage);
const stageOf = (m, id) => m.definition.stages.find(s => s.id === id);
const ptext = (m, stage, w = W) => tableCell(programRow(m, '공통'), stageOf(m, stage), w).text;
const refused = async (t, def, files = {}) => { const m = await read(await workspace(t, def, files)); assert.deepEqual([m.defined, m.reason], [false, 'unknown-format'], JSON.stringify(def.sources)); return m; };

test('REQ-125 U3 지원사업 (research/290 2.11): the notice is common — one band cell, in no row and no column, on every 건\'s way', async t => {
  // U4a (research/316) added "state-log" after "program".
  assert.deepEqual([...WORKFLOW_FEATURES], ['instance-folder', 'folder', 'file-versions', 'program', 'state-log']);
  const m = await read(await workspace(t, grant(), grantFiles));
  assert.equal(m.defined, true, JSON.stringify(m.problems));
  workflowDataSchema.parse(m);
  assert.deepEqual(m.releases.map(r => r.label), ['B사', 'A사']);
  // The band: one cell, "자료 있음 · 01_공고문" (README is no data), no conflict.
  assert.deepEqual(m.program.cells.map(c => [c.stage, c.state, c.events.map(e => [e.kind, e.path, e.files, e.release])]),
    [['notice', 'found', [['folder', BIZ + '/01_공고문', 1, null]]]]);
  assert.deepEqual(m.program.conflicts, []);
  assert.equal(ptext(m, 'notice'), '자료 있음 · 01_공고문');
  assert.equal(ptext(m, 'notice', words(en)), 'Data there · 01_공고문');
  // Not a 건's: no row holds the notice, the table leaves it out, the figures count 건 rules only.
  for (const r of m.releases) assert.equal(cell(r, 'notice'), undefined);
  assert.deepEqual(tableStages(m).map(s => s.id), ['docs', 'redo']);
  assert.deepEqual(m.totals.map(x => x.stage), ['docs', 'redo']);
  assert.deepEqual([...programStages(m)], ['notice']);
  // Its chip on the flow says "공통"; it is read, so never "읽을 자료 없음".
  assert.deepEqual(stageCounts(m, W), { docs: '자료 있는 건 2', redo: '자료 있는 건 1', notice: '공통' });
  assert.deepEqual(Object.keys(sourceNotes(m, W)).sort(), ['agree', 'skip', 'submit']);
  // On every 건's way (it is every 건's step), and its words in its node whichever 건 is chosen.
  assert.deepEqual(m.releases.map(r => r.path.map(p => p.stage)), [['notice', 'docs'], ['notice', 'docs', 'redo']]);
  for (const r of m.releases) {
    const o = flowOverlay(m.definition, withProgram(m, r), W, m.unit);
    assert.deepEqual(o.notes.notice, ['자료 있음 · 01_공고문']);
    assert.equal(o.passed.has('go'), false, 'a decision is never passed — no answer is read');
    const ladder = ladderItems(m, r, W).find(v => v.kind === 'step' && v.stage.id === 'notice');
    assert.deepEqual([ladder.note, ladder.chip, ladder.outlined], ['자료 있음 · 01_공고문', '공통', false]);
  }
  // The band's own row: '' (a 건's id is a path, never empty), its mark as a 건's cell.
  const band = programRow(m, '공통');
  assert.deepEqual([band.release, band.label, PROGRAM_ROW], ['', '공통', '']);
  assert.deepEqual(cellMark(band, stageOf(m, 'notice'), W, 'instance').mark, '●');
});

test('REQ-125 U3 F5 a common original and its copy inside a 건: the copy is 규칙 충돌 — neither common nor the 건\'s, said once', async t => {
  const def = grant({ sources: [{ ...NOTICE, files: [BIZ + '/01_공고문', ROOT + '/*/01_공고문'] }, ...grant().sources.slice(1)] });
  const files = { ...grantFiles, [ROOT + '/01_A사/01_공고문/모집공고.pdf']: 'copy', [ROOT + '/02_B사/01_공고문/']: '' };
  const m = await read(await workspace(t, def, files));
  // The original is common; A사's copy is a conflict; B사's empty folder catches nothing, so it is none.
  assert.deepEqual(pcell(m, 'notice').events.map(e => e.path), [BIZ + '/01_공고문']);
  assert.deepEqual(m.program.conflicts, [{ stage: 'notice', path: ROOT + '/01_A사/01_공고문' }]);
  assert.deepEqual(m.excluded, [{ path: ROOT + '/01_A사/01_공고문', why: 'rule-conflict' }]);
  assert.deepEqual(shownExcluded(m).map(x => x.why), ['rule-conflict'], 'the screen counts it in "제외 N"');
  assert.equal(ko.workflowExcludedWhy['rule-conflict'], '규칙 충돌 — 공통 규칙이 건 폴더 안에서 찾음');
  assert.deepEqual(programConflicts(m, 'notice'), [ROOT + '/01_A사/01_공고문']);
  // Never the 건's: A사 has no notice cell, and its way gets the notice from the band, not from the copy.
  assert.equal(cell(row(m, 'A사'), 'notice'), undefined);
  assert.ok(m.releases.every(r => r.cells.every(c => c.events.every(e => !e.path.includes('01_공고문')))));
  // Only the copy: the band says 기록 없음 (with the conflict), never "자료 있음".
  const only = await read(await workspace(t, def, { [ROOT + '/01_A사/01_공고문/모집공고.pdf']: 'copy', [ROOT + '/01_A사/02_붙임2_4번_작성본_v1.0_20260917.md']: 'x' }));
  assert.deepEqual([pcell(only, 'notice').state, ptext(only, 'notice'), only.program.conflicts.length], ['no-record', '기록 없음', 1]);
  assert.deepEqual(only.releases[0].path.map(p => p.stage), ['docs'], 'no common data → the notice is on no way');
  // file-versions as a common rule: the original's versions are one chain at the workspace level, the copies conflicts.
  const ver = grant({ sources: [{ stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor',
    files: [BIZ + '/공고_v{ver}.{ext}', ROOT + '/*/공고_v{ver}.{ext}'] }] });
  const mv = await read(await workspace(t, ver, { [BIZ + '/공고_v1.0.pdf']: 'x', [BIZ + '/공고_v1.1.hwpx']: 'x', [ROOT + '/01_A사/공고_v1.1.pdf']: 'copy', [ROOT + '/01_A사/메모.md']: 'x' }));
  assert.deepEqual(pcell(mv, 'notice').events.map(e => [e.ver, e.observed, e.chain, e.release, e.path]),
    [['1.0', 'lowest', BIZ + '/공고_v{ver}.{ext}', null, BIZ + '/공고_v1.0.pdf'], ['1.1', 'later', BIZ + '/공고_v{ver}.{ext}', null, BIZ + '/공고_v1.1.hwpx']]);
  assert.deepEqual(mv.program.conflicts, [{ stage: 'notice', path: ROOT + '/01_A사/공고_v1.1.pdf' }]);
  assert.equal(ptext(mv, 'notice'), 'v1.0 → v1.1 (관측된 판 2개)');
});

test('REQ-125 U3 F5 the kinds never mix: scope+{instance}, scope+match, tokens in a folder rule, a mixed step and a missing feature are refused', async t => {
  const bad = [
    { stage: 'notice', read: 'folder', scope: 'program', files: ['{instance}/공통서류'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: ['사업/{instance}/공통'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: [BIZ + '/01_공고문', '{instance}/x'] },
    { stage: 'notice', read: 'folder', scope: 'program', match: 'name', files: [BIZ + '/01_공고문'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: [BIZ + '/공고_v{ver}'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: ['/abs'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: [BIZ + '/../x'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: ['**'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: [BIZ + '/'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: [] },
    { stage: 'notice', read: 'folder', scope: 'all', files: [BIZ + '/01_공고문'] },
    { stage: 'notice', read: 'folder', scope: true, files: [BIZ + '/01_공고문'] },
    { stage: 'notice', read: 'folder', scope: 'program', files: [BIZ + '/01_공고문'], observed: 'lowest' },
    { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: ['{instance}/안_v{ver}'] },
    { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: [BIZ + '/안.md'] },
    { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: [BIZ + '/{nn}_폴더/안_v{ver}.md'] },
    { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', match: 'name', files: [BIZ + '/안_v{ver}'] },
    { stage: 'notice', read: 'file-versions', scope: 'program', files: [BIZ + '/안_v{ver}'] },
    { stage: 'notice', read: 'names', scope: 'program', files: [BIZ + '/01_공고문'] },
    { stage: 'notice', read: 'state-log', scope: 'program', files: ['STATE.md'] },
  ];
  for (const source of bad) await refused(t, grant({ sources: [source] }));
  // The schema says the same as the reading.
  for (const source of bad) assert.equal(workflowDefinition2Schema.safeParse(grant({ sources: [source] })).success, false, JSON.stringify(source));
  // Good common patterns: a folder anywhere from the workspace folder, `*` in one segment, a version file at the top.
  for (const source of [{ ...NOTICE, files: ['01_공고문'] }, { ...NOTICE, files: [BIZ + '/0*_공고문', BIZ + '/04_설명회'] },
    { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'integer', observed: 'later', files: ['공고_v{ver}', BIZ + '/x*/{nn}_공고_v{ver}_{yyyymmdd}.{ext}'] }])
    assert.equal(workflowDefinition2Schema.safeParse(grant({ sources: [source] })).success, true, JSON.stringify(source));
  // A step is common or per 건, never both — in either order, with either reading.
  for (const sources of [[NOTICE, { stage: 'notice', read: 'folder', files: ['{instance}/01_공고문'] }],
    [{ stage: 'docs', read: 'file-versions', files: [PAPER], ver: 'major.minor' }, { stage: 'docs', read: 'folder', scope: 'program', files: [BIZ + '/02_서식'] }]]) {
    const m = await refused(t, grant({ sources }));
    assert.match(m.problems.join(' '), /mixes a "program" rule with a 건 rule/);
  }
  // Two common rules on one step are fine.
  assert.equal(workflowDefinition2Schema.safeParse(grant({ sources: [NOTICE, { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: [BIZ + '/공고_v{ver}.{ext}'] }] })).success, true);
  // The feature must be named; a decision takes no common rule either.
  const nofeature = await refused(t, grant({ features: ['instance-folder', 'file-versions'], sources: [NOTICE] }));
  assert.match(nofeature.problems.join(' '), /"scope": "program" rule needs the feature "program"/);
  const diamond = await refused(t, grant({ sources: [{ ...NOTICE, stage: 'go' }] }));
  assert.match(diamond.problems.join(' '), /decision go cannot take a reading rule/);
  // `program` is read now: only later features ask for an update; naming it without a common rule is fine.
  assert.deepEqual(unreadFeatures({ format: WORKFLOW_FORMAT_2, features: ['instance-folder', 'program', 'state-log', 'mark'] }), ['mark']);
  const named = await read(await workspace(t, grant({ sources: grant().sources.slice(1) }), grantFiles));
  assert.deepEqual([named.defined, 'program' in named], [true, false], 'no common rule → no band, as before U3');
});

test('REQ-125 U3 F5 inside a 건 folder is by path parts: A is not AB, the parent folder itself and an excluded or hidden folder are no 건', async t => {
  const def = grant({ instanceKey: { from: 'folder', path: '사업/A/*', exclude: ['_보관'] }, features: ['instance-folder', 'folder', 'program'], sources: [
    { stage: 'notice', read: 'folder', scope: 'program', files: ['사업/AB/공고', '사업/A', '사업/A/_보관', '사업/A/@공통', '사업/A/*/공고'] },
    { stage: 'agree', read: 'folder', files: ['{instance}'] }] });
  const m = await read(await workspace(t, def, {
    '사업/AB/공고/a.pdf': 'x', '사업/A/안내.pdf': 'x', '사업/A/_보관/b.pdf': 'x', '사업/A/@공통/c.pdf': 'x',
    '사업/A/x1/공고/d.pdf': 'x', '사업/A/x1/e.md': 'x', '사업/A/x12/f.md': 'x' }));
  assert.deepEqual(m.releases.map(r => r.label), ['x1', 'x12']);
  // AB (beside A, not under it), A itself (the 건 folder's parent), `_보관` (excluded by name) and `@공통` (hidden — no 건) are common.
  assert.deepEqual(pcell(m, 'notice').events.map(e => e.path), ['사업/A', '사업/A/@공통', '사업/A/_보관', '사업/AB/공고']);
  assert.deepEqual(m.program.conflicts.map(c => c.path), ['사업/A/x1/공고']);
  // A 건 past the `instances` cap is still a 건: its copy is a conflict, though it has no row.
  const capped = await read(await workspace(t, def, { '사업/A/x1/e.md': 'x', '사업/A/x2/공고/d.pdf': 'x' }), { limits: { ...WORKFLOW_LIMITS, instances: 1 } });
  assert.deepEqual([capped.releases.map(r => r.label), capped.program.conflicts.map(c => c.path)], [['x1'], ['사업/A/x2/공고']]);
  // The workspace folder as the 건 folder (`*`): a top folder is a 건, a file right at the top is no 건's.
  const top = grant({ instanceKey: { from: 'folder', path: '*' }, sources: [
    { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: ['공고_v{ver}.pdf', '*/공고_v{ver}.pdf'] },
    { stage: 'agree', read: 'folder', scope: 'program', files: ['공통'] }] });
  const mt = await read(await workspace(t, top, { '공고_v1.0.pdf': 'x', 'A사/공고_v1.0.pdf': 'copy', '공통/z.pdf': 'x' }));
  assert.deepEqual(pcell(mt, 'notice').events.map(e => e.path), ['공고_v1.0.pdf']);
  assert.deepEqual(mt.program.conflicts.map(c => c.path), ['A사/공고_v1.0.pdf', '공통']);
  assert.deepEqual(mt.releases.map(r => r.label), ['A사', '공통']);
});

test('REQ-125 U3 read in part, 형식 모름 and the band with no 건: never "기록 없음" for what was not read', async t => {
  // A common folder cut at the entries cap with no data found: 일부만 읽음, ▨ on the phone.
  const files = { ...grantFiles };
  for (let i = 0; i < 6; i++) files[BIZ + `/01_공고문/.h${i}`] = 'x';
  delete files[BIZ + '/01_공고문/모집공고.pdf'];
  const cut = await read(await workspace(t, grant(), files), { limits: { ...WORKFLOW_LIMITS, folderEntries: 4 } });
  assert.deepEqual([pcell(cut, 'notice').state, ptext(cut, 'notice')], ['incomplete', '▨ 일부만 읽음']);
  assert.equal(cellMark(programRow(cut, '공통'), stageOf(cut, 'notice'), W, 'instance').mark, '▨');
  assert.ok(cut.incomplete.includes(BIZ + '/01_공고문'));
  // A copy inside a 건 read only in part does not make the common cell partial: it could never count for the program.
  const def = grant({ sources: [{ ...NOTICE, files: [BIZ + '/01_공고문', ROOT + '/*/01_공고문'] }] });
  const big = { [BIZ + '/01_공고문/모집공고.pdf']: 'x', [ROOT + '/01_A사/x.md']: 'x' };
  for (let i = 0; i < 6; i++) big[ROOT + `/01_A사/01_공고문/사본${i}.pdf`] = 'x';
  const inside = await read(await workspace(t, def, big), { limits: { ...WORKFLOW_LIMITS, folderEntries: 4 } });
  assert.deepEqual([pcell(inside, 'notice').state, inside.program.conflicts.map(c => c.path)], ['found', [ROOT + '/01_A사/01_공고문']]);
  // 형식 모름: a common file whose day is not on the calendar — in the band and in the heading's list.
  const odd = grant({ sources: [{ stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: [BIZ + '/공고_v{ver}_{yyyymmdd}.pdf'] }] });
  const mo = await read(await workspace(t, odd, { [BIZ + '/공고_v1.0_20260231.pdf']: 'x' }));
  assert.deepEqual([pcell(mo, 'notice').state, ptext(mo, 'notice'), mo.unknownFormat], ['unknown-format', '형식 모름 · 공고_v1.0_20260231.pdf',
    [{ stage: 'notice', path: BIZ + '/공고_v1.0_20260231.pdf' }]]);
  assert.equal(cellMark(programRow(mo, '공통'), stageOf(mo, 'notice'), W, 'instance').mark, '?');
  // No 건 folder at all: the band is read all the same.
  const none = await read(await workspace(t, grant(), { [BIZ + '/01_공고문/모집공고.pdf']: 'x' }));
  assert.deepEqual([none.releases.length, none.instanceFolder.found, pcell(none, 'notice').state], [0, false, 'found']);
  // A common folder's day does not order the 건 (dated by what is theirs only).
  const dated = await read(await workspace(t, grant({ sources: [{ ...NOTICE, files: [BIZ + '/01_공고문_20261231'] }, ...grant().sources.slice(1)] }),
    { ...grantFiles, [BIZ + '/01_공고문_20261231/a.pdf']: 'x' }));
  assert.deepEqual([dated.releases.map(r => r.label), pcell(dated, 'notice').events[0].time], [['B사', 'A사'], '2026-12-31']);
});

test('REQ-125 U3 reading writes nothing, the band\'s words in both languages, and a file without a common rule reads as before', async t => {
  const def = grant({ sources: [{ ...NOTICE, files: [BIZ + '/01_공고문', ROOT + '/*/01_공고문'] }, ...grant().sources.slice(1)] });
  const cwd = await workspace(t, def, { ...grantFiles, [ROOT + '/01_A사/01_공고문/모집공고.pdf']: 'copy' });
  const snapshot = async () => {
    const out = [];
    const walk = async dir => { for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, d.name), s = await fs.lstat(p); out.push([relative(cwd, p), s.size, s.mtimeMs].join('|'));
      if (d.isDirectory()) await walk(p); } };
    await walk(cwd); return createHash('sha256').update(out.sort().join('\n')).digest('hex');
  };
  const before = await snapshot(); await read(cwd); await read(cwd);
  assert.equal(await snapshot(), before);
  for (const m of [ko, en]) for (const key of ['programBand', 'programName', 'evidenceProgram', 'evidenceConflict', 'evidenceNoRecordProgram'])
    assert.equal(typeof m[key], 'string', key);
  assert.deepEqual([ko.programBand, ko.programConflicts(2), en.programConflicts(1), en.programConflicts(2)], ['공통 · 모든 건', '규칙 충돌 2', '1 rule conflict', '2 rule conflicts']);
  assert.ok(!/재작업|최초/.test(JSON.stringify([ko.programBand, ko.evidenceProgram, ko.evidenceConflict, ko.evidenceNoRecordProgram])));
  // The same file with its common rule taken out reads exactly as U2 did: no `program`, no `rule-conflict`, the notice outlined.
  const plain = await read(await workspace(t, grant({ sources: grant().sources.slice(1) }), grantFiles));
  assert.deepEqual(['program' in plain, plain.excluded, plain.releases.map(r => cell(r, 'notice').state)], [false, [], ['no-source', 'no-source']]);
  assert.deepEqual(sourceNotes(plain, W).notice, ['읽을 자료 없음']);
});

// ---- research/311 (v0.1.60 gate) F1 · F2 -----------------------------------------------------------------------------
const pair = (kind, extra = {}) => ({
  format: WORKFLOW_FORMAT_2, features: ['instance-folder', 'folder', 'file-versions', 'program'], name: '사본 귀속', instanceKey: { from: 'folder', path: '건/*' },
  stages: [{ id: 'notice', label: '공통 공고', shape: 'box', row: 0, col: 0 }, { id: 'docs', label: '건 자체 근거', shape: 'box', row: 0, col: 1 }],
  edges: [{ from: 'notice', to: 'docs' }],
  sources: kind === 'folder'
    ? [{ stage: 'notice', read: 'folder', scope: 'program', files: ['공통', '건/*/공통'] }, { stage: 'docs', read: 'folder', files: ['{instance}/공통'] }]
    : [{ stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: ['공통/공고_v{ver}.{ext}', '건/*/공통/공고_v{ver}.{ext}'] },
      { stage: 'docs', read: 'file-versions', ver: 'major.minor', files: ['{instance}/공통/공고_v{ver}.{ext}'] }],
  ...extra,
});

test('REQ-125 U3 311-F2 a copy taken as 규칙 충돌 is no 건\'s data in any other step either — held out, and the cell says why', async t => {
  for (const kind of ['folder', 'file-versions']) {
    const m = await read(await workspace(t, pair(kind), { '공통/공고_v1.0.pdf': 'x', '건/A/공통/공고_v1.0.pdf': 'copy' }));
    const a = m.releases[0], docs = cell(a, 'docs');
    assert.deepEqual(m.program.conflicts.map(c => c.path), [kind === 'folder' ? '건/A/공통' : '건/A/공통/공고_v1.0.pdf'], kind);
    assert.deepEqual([docs.state, docs.events, docs.conflicts], ['no-record', [], ['건/A/공통/공고_v1.0.pdf']], kind);
    assert.ok(!a.path.some(p => p.stage === 'docs'), kind + ': not on the 건\'s way');
    assert.equal(tableCell(a, stageOf(m, 'docs'), W).text, '기록 없음 · 규칙 충돌 1');
    assert.equal(tableCell(a, stageOf(m, 'docs'), words(en)).text, 'No record · 1 rule conflict');
    assert.equal(cellMark(a, stageOf(m, 'docs'), W, 'instance').mark, '–');
    // 313-F3: the flow and the phone's ladder say what the table says — the reason is never only in the table.
    assert.deepEqual(flowOverlay(m.definition, withProgram(m, a), W, m.unit).notes.docs, ['기록 없음 · 규칙 충돌 1'], kind);
    assert.equal(ladderItems(m, a, words(en)).find(v => v.kind === 'step' && v.stage.id === 'docs').note, 'No record · 1 rule conflict', kind);
    // A 건 step with nothing and no conflict still says only "기록 없음" (U1·U2 words unchanged).
    const plainNo = { ...a, cells: a.cells.map(c => c.stage === 'docs' ? { stage: 'docs', state: 'no-record', events: [] } : c) };
    assert.deepEqual(flowOverlay(m.definition, plainNo, W, m.unit).notes.docs, ['기록 없음']);
    // 313-F3: on a narrow node the words break at " · " — "규칙 충돌 1" whole on its line — and come as one block.
    const notes = flowOverlay(m.definition, withProgram(m, a), words(en), m.unit).notes;
    const node = flowLayout(m.definition.stages, 1000, notes, {}, 220, true).at.get('docs');
    assert.deepEqual([node.noteBlocks, node.note], [[['No record ·', '1 rule conflict']], ['No record ·', '1 rule conflict']], kind);
    assert.equal(flowLayout(m.definition.stages, 1000, notes, {}, 220).at.get('docs').noteBlocks, undefined, 'releases (/1) keep a text a line');
    assert.equal(m.totals.find(x => x.stage === 'docs').window.count, 0);
    workflowDataSchema.parse(m);
  }
  // Narrow, never a prefix (302's lesson): a folder taken holds only its own files — a subfolder under it is still the 건's.
  const narrow = { ...pair('folder'), sources: [pair('folder').sources[0], { stage: 'docs', read: 'folder', files: ['{instance}/공통/독자자료'] }] };
  const mn = await read(await workspace(t, narrow, { '공통/공고.pdf': 'x', '건/A/공통/공고.pdf': 'copy', '건/A/공통/독자자료/신청서.pdf': 'x' }));
  assert.deepEqual([cell(mn.releases[0], 'docs').state, cell(mn.releases[0], 'docs').events.map(e => e.path), cell(mn.releases[0], 'docs').conflicts], ['found', ['건/A/공통/독자자료'], undefined]);
  // A common version rule takes that file only: the other files of the same 건 folder still count, for a folder rule and a version rule.
  const files = { '공고_v1.0.pdf': 'x', '건/A/공고_v1.0.pdf': 'copy', '건/A/신청서_v1.0.pdf': 'x' };
  const only = { ...pair('file-versions'), stages: [...pair('file-versions').stages, { id: 'paper', label: '신청서', shape: 'box', row: 0, col: 2 }], sources: [
    { stage: 'notice', read: 'file-versions', scope: 'program', ver: 'major.minor', files: ['공고_v{ver}.pdf', '건/*/공고_v{ver}.pdf'] },
    { stage: 'docs', read: 'folder', files: ['{instance}'] }, { stage: 'paper', read: 'file-versions', ver: 'major.minor', files: ['{instance}/*_v{ver}.pdf'] }] };
  const mo = await read(await workspace(t, only, files)), ao = mo.releases[0];
  assert.deepEqual([cell(ao, 'docs').state, cell(ao, 'docs').events[0].files, cell(ao, 'docs').conflicts], ['found', 1, ['건/A/공고_v1.0.pdf']]);
  assert.deepEqual([cell(ao, 'paper').events.map(e => e.path), cell(ao, 'paper').conflicts], [['건/A/신청서_v1.0.pdf'], ['건/A/공고_v1.0.pdf']]);
  assert.equal(tableCell(ao, stageOf(mo, 'docs'), W).text, '자료 있음 · A · 규칙 충돌 1');
  // No common rule, or nothing taken: no `conflicts` key at all (U1/U2 cells as before).
  const none = await read(await workspace(t, pair('folder'), { '공통/공고.pdf': 'x', '건/A/공통/메모.pdf': 'x' }));
  assert.equal('conflicts' in cell(none.releases[0], 'docs'), true, 'the copy rule still takes 건/A/공통');
  const quiet = await read(await workspace(t, grant(), grantFiles));
  assert.ok(quiet.releases.every(r => r.cells.every(c => !('conflicts' in c))));
});

test('REQ-125 U3 313-F3 wrapNote breaks a 건 cell\'s words at " · " first, and by words only a piece too long for a line', () => {
  assert.deepEqual(wrapNote('기록 없음 · 규칙 충돌 1', textWidth('기록 없음 · 규칙 충돌 1', 11), 11), ['기록 없음 · 규칙 충돌 1']);
  assert.deepEqual(wrapNote('기록 없음 · 규칙 충돌 1', textWidth('규칙 충돌 1', 11) + 1, 11), ['기록 없음 ·', '규칙 충돌 1']);
  assert.deepEqual(wrapNote('a · b · c', textWidth('a · b', 11), 11), ['a · b ·', 'c']);
  assert.deepEqual(wrapNote('기록 없음', 1, 11), ['기록', '없음'], 'one piece too long: by its words');
});

test('REQ-125 U3 311-F1 a common folder rule stops at eventsPerRule: read in part, and a copy past the cap is still 규칙 충돌', async t => {
  const def = { ...pair('folder'), sources: [{ stage: 'notice', read: 'folder', scope: 'program', files: ['a*', '건/*/공통'] }, { stage: 'docs', read: 'folder', files: ['{instance}/공통'] }] };
  const files = { 'a1/x.pdf': 'x', 'a2/x.pdf': 'x', 'a3/x.pdf': 'x', '건/A/공통/공고.pdf': 'copy' };
  const m = await read(await workspace(t, def, files), { limits: { ...WORKFLOW_LIMITS, eventsPerRule: 2 } });
  assert.deepEqual([pcell(m, 'notice').state, pcell(m, 'notice').events.map(e => e.path), m.limits], ['incomplete', ['a1', 'a2'], ['events-per-rule:notice']]);
  assert.equal(ptext(m, 'notice'), '▨ 일부만 읽음 · 자료 있음 · a1 +1');
  assert.deepEqual([m.program.conflicts.map(c => c.path), cell(m.releases[0], 'docs').state], [['건/A/공통'], 'no-record']);
  // Under the cap: whole, as before.
  const whole = await read(await workspace(t, def, files));
  assert.deepEqual([pcell(whole, 'notice').state, pcell(whole, 'notice').events.length, whole.limits], ['found', 3, []]);
  // The default cap (500): 501 common folders → 500 events and read in part.
  const many = {};
  for (let i = 0; i < 501; i++) many[`a${String(i).padStart(3, '0')}/x.pdf`] = 'x';
  const big = await read(await workspace(t, def, many));
  assert.deepEqual([pcell(big, 'notice').state, pcell(big, 'notice').events.length, big.limits], ['incomplete', 500, ['events-per-rule:notice']]);
});

test('REQ-125 U3 314-F4 a long folder name without spaces never hides the reason: on the wide flow "규칙 충돌 N" keeps a text of its own', async t => {
  for (const name of ['사업참여신청서_제출서류_최종정리', 'ApplicationEvidenceDocumentsWithoutSpaces']) {
    const def = { ...pair('folder'), sources: [pair('folder').sources[0], { stage: 'docs', read: 'folder', files: ['{instance}/*'] }] };
    const m = await read(await workspace(t, def, { '공통/공고.pdf': 'x', '건/A/공통/공고.pdf': 'copy', [`건/A/${name}/x.pdf`]: 'x' }));
    const a = m.releases[0], docs = cell(a, 'docs');
    assert.deepEqual([docs.state, docs.events.map(e => e.path), docs.conflicts], ['found', [`건/A/${name}`], ['건/A/공통/공고.pdf']]);
    // The table and the phone: the cell's words, the reason after the name.
    assert.equal(tableCell(a, stageOf(m, 'docs'), W).text, `자료 있음 · ${name} · 규칙 충돌 1`);
    assert.equal(ladderItems(m, a, W).find(v => v.kind === 'step' && v.stage.id === 'docs').note, `자료 있음 · ${name} · 규칙 충돌 1`);
    // The wide flow, in the table's order: the line holding the name (wider than the node) closes its text, which the screen cuts
    // short with an ellipsis; "규칙 충돌 1" is a text of its own after it, so it is always seen.
    const notes = flowOverlay(m.definition, withProgram(m, a), W, m.unit).notes;
    assert.deepEqual(notes.docs, [`자료 있음 · ${name} · 규칙 충돌 1`]);
    const node = flowLayout(m.definition.stages, 1000, notes, {}, 220, true).at.get('docs');
    assert.deepEqual(node.noteBlocks, [['자료 있음 ·', name + ' ·'], ['규칙 충돌 1']]);
    assert.equal(node.noteBlocks.flat().join(' '), `자료 있음 · ${name} · 규칙 충돌 1`, 'the words in the table\'s order');
    // The name's line takes the screen lines it fills (Korean 17 → 2, English 41 → 3), and the node is as tall as all of them.
    assert.deepEqual(node.noteBlockLines, [1 + (name.length > 20 ? 3 : 2), 1]);
    assert.ok(node.h >= 12 + 16 + (node.noteBlockLines[0] + 1) * 14);
  }
  // No conflict: one part, as before.
  const m = await read(await workspace(t, pair('folder'), { '공통/공고.pdf': 'x', '건/A/공통/메모/x.pdf': 'x' }));
  assert.deepEqual(flowOverlay(m.definition, withProgram(m, m.releases[0]), W, m.unit).notes.docs, ['기록 없음']);
});
