// REQ-125 U1 (research/290 2판 5절 U1, research/301): the `/2` definition and its rows of "건". A `/2` file names the features it
// uses; one this build does not read is refused as "update Kanban — needs 〈feature〉" before anything else. Its rows are the
// real folders right under the 건 folder (`instanceKey`), its id the workspace-relative path in NFC — a link, two names that are
// one in NFC, a hidden name are left out and said. U1 reads one rule, `folder`: "자료 있음" when a folder holds a data file
// (not README.*, not hidden); it never answers a decision (◇). A folder read only in part says "일부만 읽음", never "기록 없음".
// The `/1` reading is unchanged (tests/req124-*, research/301 raw/compare-v1-*). Made-up names in temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkflow, folderDate, instanceLabel, WORKFLOW_LIMITS } from '../dist/server/workflow.js';
import { workflowDefinitionSchema, workflowDefinition2Schema, unreadFeatures, workflowDataSchema, WORKFLOW_FORMAT_2 } from '../dist/shared/workflow.js';
import { workflowGet } from '../dist/shared/rpc.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { byInstance, cellMark, flowOverlay, instanceChip, ladderItems, shownExcluded, stageCounts, systemHelper, tableCell, tableStages } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';
import { fixture } from './helpers.mjs';

const ko = copy('ko');
const W = { verdict: { pass: ko.verdictPass, conditional: ko.verdictConditional, fail: ko.verdictFail, unknown: ko.verdictUnknown },
  stateNoRecord: ko.stateNoRecord, stateNoSource: ko.stateNoSource, stateUnknown: ko.stateUnknown, titleUnread: ko.titleUnread,
  statePerson: ko.statePerson, firstRound: ko.firstRound, countFound: ko.countFound, loopNone: ko.loopNone, loopTimes: ko.loopTimes,
  timesShort: ko.timesShort, resultNotOk: ko.resultNotOk, resultMissing: ko.resultMissing,
  dataThere: ko.dataThere, stateCandidate: ko.stateCandidate, stateAmbiguous: ko.stateAmbiguous, stateIncomplete: ko.stateIncomplete, countInstances: ko.countInstances };

/** The built-in "지원사업" steps (shared/workflow-templates.ts gov-grant), with `/2` rules a U1 build reads. */
const ROOT = '사업/05_지원기업 서류';
const grant = (extra = {}) => ({
  format: WORKFLOW_FORMAT_2, features: ['instance-folder', 'folder'], name: '지원사업 — 시험',
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
    { stage: 'docs', read: 'folder', files: ['{instance}/03_삽입도식'] },
    { stage: 'submit', read: 'folder', files: ['{instance}/00_제출서류_*'] },
    { stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] },
  ],
  ...extra,
});
async function workspace(t, def, files = {}) {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'kanban-u1-'));
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
/** The two made-up 건 of research/289's shape: A사 (papers v1, a 제출서류 folder, a 선정·계약 folder), B사 (a draft, no submission). */
const grantFiles = {
  [ROOT + '/README.md']: '# 건 폴더\n',
  [ROOT + '/01_A사/README.md']: '# A사\n',
  [ROOT + '/01_A사/02_붙임2_4번_작성본_v1.0_20260917.md']: 'v1\n',
  [ROOT + '/01_A사/03_삽입도식/README.md']: '# 도식\n',
  [ROOT + '/01_A사/03_삽입도식/A_도식_v1.0.svg']: '<svg/>',
  [ROOT + '/01_A사/00_제출서류_20260918/지원기업1.pdf']: '',
  [ROOT + '/01_A사/10_선정·계약/01_체크리스트_v1.0_20261001.md']: '-\n',
  [ROOT + '/02_B사/README.md']: '# B사\n',
  [ROOT + '/02_B사/03_붙임2_4번_작성본_v1.0_20260922.md']: 'v1\n',
  [ROOT + '/02_B사/03_삽입도식/README.md']: '# 준비만\n',
};
const row = (m, label) => m.releases.find(r => r.label === label);
const cell = (r, stage) => r.cells.find(c => c.stage === stage);

test('REQ-125 U1 a /2 grant definition: one row per 건 folder (A사, B사), its cells "자료 있음" or "기록 없음", decisions out of the table', async t => {
  const cwd = await workspace(t, grant(), grantFiles);
  const m = await read(cwd);
  assert.equal(m.defined, true, JSON.stringify(m));
  assert.equal(m.unit, 'instance');
  assert.deepEqual(m.instanceFolder, { path: ROOT, found: true });
  assert.deepEqual(m.releases.map(r => [r.release, r.label]), [[ROOT + '/01_A사', 'A사'], [ROOT + '/02_B사', 'B사']],
    'A사 first: its latest date read (10-01) — B사 has no dated folder');
  const a = row(m, 'A사'), b = row(m, 'B사');
  assert.deepEqual(a.cells.map(c => [c.stage, c.state]), [['notice', 'no-source'], ['go', 'decision'], ['docs', 'found'], ['check', 'decision'],
    ['submit', 'found'], ['agree', 'found'], ['skip', 'no-source'], ['redo', 'no-source']]);
  assert.deepEqual(cell(a, 'submit').events, [{ stage: 'submit', kind: 'folder', release: ROOT + '/01_A사', releaseFrom: null,
    path: ROOT + '/01_A사/00_제출서류_20260918', files: 1, time: '2026-09-18' }]);
  assert.equal(cell(a, 'docs').events[0].files, 1, 'README.md is the folder\'s guide, not its data');
  assert.equal(cell(b, 'docs').state, 'no-record', 'F4: a folder holding only its README is not "자료 있음"');
  assert.equal(cell(b, 'submit').state, 'no-record');
  assert.deepEqual(a.path, [{ stage: 'docs' }, { stage: 'submit' }, { stage: 'agree' }], 'the way: steps with data only, never a decision');
  assert.deepEqual(m.totals.map(x => [x.stage, x.window.count]), [['docs', 1], ['submit', 1], ['agree', 1]], 'a step\'s figure = 건 with data');
  assert.deepEqual([m.excluded, m.incomplete, m.limits], [[], [], []]);
  assert.deepEqual(tableStages(m).map(s => s.id), ['docs', 'submit', 'agree'], 'decisions and steps with no rule stay out of the table');
  // The RPC answers the same reading, and its schema takes every new field.
  const { store, cwd: boardCwd } = await fixture(t);
  for (const [name, text] of Object.entries(grantFiles)) { await fs.mkdir(join(boardCwd, name, '..'), { recursive: true }); await fs.writeFile(join(boardCwd, name), text); }
  await fs.mkdir(join(boardCwd, '.kanban')); await fs.writeFile(join(boardCwd, '.kanban/workflow.json'), JSON.stringify(grant()));
  const reply = workflowGet.output.parse(await createReadHandlers(store).workflow({ workspaceId: 'wks_example01' }));
  assert.equal(reply.ok, true);
  assert.equal(reply.data.unit, 'instance');
  assert.deepEqual(reply.data.releases.map(r => r.label), ['A사', 'B사']);
  assert.equal(workflowDataSchema.safeParse(m).success, true);
});

test('REQ-125 U1 F1 the 건\'s identity: two jobs of one company as two flat folders are two rows; renaming a folder makes another 건; nested 건 are refused', async t => {
  const cwd = await workspace(t, grant({ instanceKey: { from: 'folder', path: ROOT + '/*' } }), {
    [ROOT + '/A사_과제1/10_선정·계약/계약서.pdf']: '', [ROOT + '/A사_과제2/00_제출서류_20260920/신청서.pdf']: '',
  });
  const m = await read(cwd);
  assert.deepEqual(m.releases.map(r => r.label), ['A사_과제2', 'A사_과제1'], 'as-is names; the dated one first');
  assert.equal(cell(row(m, 'A사_과제1'), 'agree').state, 'found');
  assert.equal(cell(row(m, 'A사_과제1'), 'submit').state, 'no-record', 'one job\'s submission is not the other\'s');
  assert.equal(cell(row(m, 'A사_과제2'), 'agree').state, 'no-record');
  // Renaming: the id is the path, so 01_→02_ is another row (its shown name the same with strip-number-prefix).
  const renamed = await workspace(t, grant(), { [ROOT + '/01_A사/10_선정·계약/x.md']: '' });
  const before = await read(renamed);
  await fs.rename(join(renamed, ROOT, '01_A사'), join(renamed, ROOT, '02_A사'));
  const after = await read(renamed);
  assert.deepEqual([before.releases.map(r => r.release), after.releases.map(r => r.release)], [[ROOT + '/01_A사'], [ROOT + '/02_A사']]);
  assert.deepEqual([before.releases[0].label, after.releases[0].label], ['A사', 'A사']);
  assert.notEqual(before.key, after.key);
  // Nested 건 (a customer, then a folder per job) are refused as a whole: "형식 모름".
  for (const path of ['사업/*/*', '사업/고객*/*', '사업/05_*', '{instance}/*', '/abs/*', '사업/../*']) {
    const nested = await read(await workspace(t, grant({ instanceKey: { from: 'folder', path } })));
    assert.deepEqual([nested.defined, nested.reason], [false, 'unknown-format'], path);
  }
});

test('REQ-125 U1 F1 left out and said: two names one in NFC (both), links (two to one folder, one outside), hidden names; `exclude` quietly', async t => {
  const outside = await fs.mkdtemp(join(tmpdir(), 'kanban-u1-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(join(outside, '10_선정·계약'), { recursive: true }); await fs.writeFile(join(outside, '10_선정·계약/secret.pdf'), '');
  const nfd = '03_다이', nfcName = '03_다이'; // "03_다이" written two ways
  const cwd = await workspace(t, grant({ instanceKey: { from: 'folder', path: ROOT + '/*', label: 'strip-number-prefix', exclude: ['99_보관'] } }), {
    [ROOT + '/01_A사/10_선정·계약/x.md']: '', [ROOT + '/' + nfd + '/10_선정·계약/x.md']: '', [ROOT + '/' + nfcName + '/10_선정·계약/y.md']: '',
    [ROOT + '/.숨김/10_선정·계약/x.md']: '', [ROOT + '/@eaDir/']: '', [ROOT + '/#임시/']: '', [ROOT + '/99_보관/10_선정·계약/x.md']: '',
    [ROOT + '/파일.md']: 'not a 건',
  });
  await fs.symlink(join(cwd, ROOT, '01_A사'), join(cwd, ROOT, '04_링크1'));
  await fs.symlink(join(cwd, ROOT, '01_A사'), join(cwd, ROOT, '05_링크2'));
  await fs.symlink(outside, join(cwd, ROOT, '06_바깥'));
  const m = await read(cwd);
  assert.deepEqual(m.releases.map(r => r.label), ['A사'], 'one row: the real folder; never a link to it, never both of a collision');
  assert.deepEqual(m.excluded, [
    { path: ROOT + '/#임시', why: 'hidden' }, { path: ROOT + '/.숨김', why: 'hidden' }, { path: ROOT + '/03_다이', why: 'nfc-collision' },
    { path: ROOT + '/04_링크1', why: 'link' }, { path: ROOT + '/05_링크2', why: 'link' }, { path: ROOT + '/06_바깥', why: 'link' },
    { path: ROOT + '/@eaDir', why: 'hidden' },
  ]);
  assert.ok(!JSON.stringify(m).includes('secret'), 'nothing behind the outside link is read');
  assert.ok(!JSON.stringify(m).includes('99_보관'), '`exclude` leaves its folders out quietly');
  // A link on the way to a 건's evidence is not followed either; the evidence folder is said left out.
  await fs.rename(join(cwd, ROOT, '01_A사/10_선정·계약'), join(cwd, ROOT, '01_A사/real'));
  await fs.symlink(join(cwd, ROOT, '01_A사/real'), join(cwd, ROOT, '01_A사/10_선정·계약'));
  const linked = await read(cwd);
  assert.equal(cell(row(linked, 'A사'), 'agree').state, 'no-record');
  assert.ok(linked.excluded.some(x => x.path === ROOT + '/01_A사/10_선정·계약' && x.why === 'link'), JSON.stringify(linked.excluded));
  // The 건 folder itself behind a link (inside the workspace): not listed — its place is not its path.
  const viaLink = await workspace(t, grant({ instanceKey: { from: 'folder', path: '바로가기/*' } }), { [ROOT + '/01_A사/10_선정·계약/x.md']: '' });
  await fs.symlink(join(viaLink, ROOT), join(viaLink, '바로가기'));
  const v = await read(viaLink);
  assert.deepEqual([v.releases.length, v.excluded], [0, [{ path: '바로가기', why: 'link' }]]);
});

test('REQ-125 U1 names in another normal form are found by their NFC name; ids and paths are NFC; labels that would be one keep their folder names', async t => {
  const nfdRoot = ROOT.normalize('NFD');
  const cwd = await workspace(t, grant(), { [nfdRoot + '/01_A사'.normalize('NFD') + '/10_선정·계약'.normalize('NFD') + '/x.md']: '', [nfdRoot + '/02_A사/README.md']: '' });
  const m = await read(cwd);
  assert.deepEqual(m.releases.map(r => [r.release, r.label]), [[ROOT + '/01_A사', '01_A사'], [ROOT + '/02_A사', '02_A사']]);
  assert.equal(cell(m.releases[0], 'agree').events[0].path, ROOT + '/01_A사/10_선정·계약');
  // The same folder name on the way written both ways: neither is taken (no 건 folder), both said.
  await fs.mkdir(join(cwd, ROOT, '01_A사'), { recursive: true });
  const both = await read(cwd);
  assert.deepEqual([both.releases.length, both.instanceFolder, both.excluded], [0, { path: ROOT, found: false }, [{ path: '사업', why: 'nfc-collision' }]]);
  assert.equal(instanceLabel('01_A사', 'strip-number-prefix'), 'A사');
  assert.equal(instanceLabel('2026_사업', 'strip-number-prefix'), '2026_사업', 'four digits are a name, not a number prefix');
  assert.equal(instanceLabel('01_', 'strip-number-prefix'), '01_', 'nothing left: the name as it is');
  assert.equal(instanceLabel('01_A사'), '01_A사');
});

test('REQ-125 U1 F4 `folder` = "자료 있음" only: README only, empty, sub-folders only, hidden files only say nothing; a decision with a rule is 형식 모름', async t => {
  const cwd = await workspace(t, grant({ sources: [{ stage: 'agree', read: 'folder', files: ['{instance}/*'] }] }), {
    [ROOT + '/01_A사/a_readme/README.md']: '', [ROOT + '/01_A사/b_readme_txt/readme.txt']: '', [ROOT + '/01_A사/c_empty/']: '',
    [ROOT + '/01_A사/d_sub/inner/x.md']: '', [ROOT + '/01_A사/e_hidden/.DS_Store']: '',
    [ROOT + '/02_B사/g_data/README.md']: '', [ROOT + '/02_B사/g_data/계약서_20261001.pdf']: '',
    [ROOT + '/03_C사/h_date_20260231/x.md']: '', [ROOT + '/03_C사/i_date_20261003/x.md']: '',
  });
  const m = await read(cwd);
  assert.equal(cell(row(m, 'A사'), 'agree').state, 'no-record');
  assert.deepEqual(cell(row(m, 'B사'), 'agree').events.map(e => [e.path.split('/').at(-1), e.files, e.time]), [['g_data', 1, undefined]]);
  assert.deepEqual(cell(row(m, 'C사'), 'agree').events.map(e => [e.path.split('/').at(-1), e.time]), [['h_date_20260231', undefined], ['i_date_20261003', '2026-10-03']],
    'a date not on the calendar is no date');
  assert.deepEqual(m.releases.map(r => r.label), ['C사', 'A사', 'B사'], 'dated first, then by name');
  assert.equal(folderDate('x_20240229'), '2024-02-29'); assert.equal(folderDate('x_20230229'), null); assert.equal(folderDate('x20240229'), null);
  // A decision cannot take a rule in this format: the whole file is 형식 모름, with the reason.
  const diamond = await read(await workspace(t, grant({ sources: [{ stage: 'check', read: 'folder', files: ['{instance}/00_제출서류_*'] }] })));
  assert.deepEqual([diamond.defined, diamond.reason], [false, 'unknown-format']);
  assert.ok(diamond.problems.some(p => p.includes('decision check')), JSON.stringify(diamond.problems));
});

test('REQ-125 U1 F5 a rule belongs to a 건 only by `{instance}`: no-`{instance}`, mixed patterns, `scope`, `match` and later tokens are refused; A and AB stay apart', async t => {
  const bad = [
    { stage: 'agree', read: 'folder', files: ['사업/공통'] },
    { stage: 'agree', read: 'folder', files: ['{instance}/x', '사업/공통'] },
    { stage: 'agree', read: 'folder', scope: 'program', files: ['{instance}/공통서류'] },
    { stage: 'agree', read: 'folder', match: 'name', files: ['{instance}/x'] },
    { stage: 'agree', read: 'folder', files: ['x/{instance}'] },
    { stage: 'agree', read: 'folder', files: ['{instance}/{nn}_작성본_v{ver}.md'] },
    { stage: 'agree', read: 'folder', files: ['{instance}/../x'] },
    { stage: 'agree', read: 'folder', files: ['{instance}/**'] },
    { stage: 'agree', read: 'names', files: ['{instance}/x'] },
  ];
  for (const source of bad) {
    const m = await read(await workspace(t, grant({ sources: [source] })));
    assert.deepEqual([m.defined, m.reason], [false, 'unknown-format'], JSON.stringify(source));
  }
  // U3 (research/308): `program` is read now — `scope` with `{instance}` is still refused, with the feature named too.
  const program = await read(await workspace(t, grant({ features: ['instance-folder', 'folder', 'program'], sources: [bad[2]] })));
  assert.deepEqual([program.defined, program.reason], [false, 'unknown-format']);
  // Path parts are compared whole: the 건 A never takes AB's folder, nor AB A's.
  const cwd = await workspace(t, grant({ instanceKey: { from: 'folder', path: ROOT + '/*' }, sources: [{ stage: 'agree', read: 'folder', files: ['{instance}'] }] }),
    { [ROOT + '/A/x.md']: '', [ROOT + '/AB/']: '' });
  const m = await read(cwd);
  assert.deepEqual(m.releases.map(r => [r.label, cell(r, 'agree').state]), [['A', 'found'], ['AB', 'no-record']]);
});

test('REQ-125 U1 J4 features: an unread one is "update Kanban — needs …" before anything else; a missing or malformed list is 형식 모름', async t => {
  // U2 (research/305): "file-versions" is read now; U3 (research/308): "program" too; U4a (research/316): "state-log" too — a name
  // no build reads yet ("mark") stands for a newer one.
  for (const [features, want] of [[['instance-folder', 'folder', 'mark'], ['mark']], [['instance-folder', 'file-versions', 'mark'], ['mark']],
    [['instance-folder', 'folder', 'program', 'state-log', 'mark'], ['mark']]]) {
    // Even with keys this build does not know: the features are looked at first.
    const m = await read(await workspace(t, grant({ features, sources: [{ stage: 'docs', read: 'mark', files: ['STATE.md'] }] })));
    assert.deepEqual([m.defined, m.reason, m.problems], [false, 'needs-update', want], JSON.stringify(features));
  }
  assert.deepEqual(unreadFeatures({ format: 'paseo-kanban.workflow/1', features: ['state-log'] }), [], 'a /1 file has no features');
  assert.deepEqual(unreadFeatures({ format: WORKFLOW_FORMAT_2, features: ['Not a name!'] }), [], 'not a feature name: left to the schema');
  for (const features of [undefined, [], ['folder'], ['instance-folder'], ['instance-folder', 'folder', 'folder'], ['Not a name!'], 'folder']) {
    const def = grant(features === undefined ? {} : { features }); if (features === undefined) delete def.features;
    const m = await read(await workspace(t, def));
    assert.deepEqual([m.defined, m.reason], [false, 'unknown-format'], JSON.stringify(features));
  }
  // An instanceKey-only file with no rule is fine with "instance-folder" alone.
  const plain = await read(await workspace(t, grant({ features: ['instance-folder'], sources: [] }), { [ROOT + '/01_A사/']: '' }));
  assert.deepEqual([plain.defined, plain.releases.map(r => r.label)], [true, ['A사']]);
  // /1 and /2 keep apart: the /1 schema (an older plugin's) refuses a /2 file as 형식 모름; /1 keys are not /2's.
  assert.equal(workflowDefinitionSchema.safeParse(grant()).success, false);
  assert.equal(workflowDefinition2Schema.safeParse({ ...grant(), releaseKey: 'semver' }).success, false);
  assert.equal(workflowDefinition2Schema.safeParse({ ...grant(), releaseWindow: 10 }).success, false);
});

test('REQ-125 U1 "일부만 읽음" is never "기록 없음": a folder cut at a cap, a host that cannot list safely, past 200 건', async t => {
  const files = { [ROOT + '/01_A사/10_선정·계약/README.md']: '', [ROOT + '/02_B사/10_선정·계약/계약서.pdf']: '' };
  for (let i = 0; i < 6; i++) files[ROOT + `/01_A사/10_선정·계약/sub${i}/`] = '';
  const cwd = await workspace(t, grant(), files);
  const cut = await read(cwd, { limits: { ...WORKFLOW_LIMITS, folderEntries: 4 } });
  assert.equal(cell(row(cut, 'A사'), 'agree').state, 'incomplete', 'cut before any data was seen: 일부만 읽음');
  assert.equal(cell(row(cut, 'B사'), 'agree').state, 'found');
  assert.deepEqual(cut.incomplete, [ROOT + '/01_A사/10_선정·계약']);
  assert.ok(cut.limits.includes('folder-entries:' + ROOT + '/01_A사/10_선정·계약'), JSON.stringify(cut.limits));
  // Past the 건 cap: the first ones by name, said — never "the latest".
  const many = await read(cwd, { limits: { ...WORKFLOW_LIMITS, instances: 1 } });
  assert.deepEqual([many.releases.map(r => r.label), many.limits, many.incomplete], [['A사'], ['instances'], [ROOT]]);
  // A host that cannot list through a held folder lists nothing — the 건 folder is unknown, not missing.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  let mac;
  try { mac = await read(cwd); } finally { Object.defineProperty(process, 'platform', platform); }
  assert.deepEqual([mac.releases.length, mac.instanceFolder, mac.limits, mac.incomplete], [0, { path: ROOT, found: true }, ['listing-unsupported'], ['']]);
  // The 건 folder truly missing: said as missing, no row, nothing in part.
  const none = await read(await workspace(t, grant(), {}));
  assert.deepEqual([none.releases.length, none.instanceFolder, none.incomplete], [0, { path: ROOT, found: false }, []]);
  const empty = await read(await workspace(t, grant(), { [ROOT + '/README.md']: '' }));
  assert.deepEqual([empty.releases.length, empty.instanceFolder], [0, { path: ROOT, found: true }]);
});

test('REQ-125 U1 reading a /2 file writes nothing; a picked built-in rests under it', async t => {
  const cwd = await workspace(t, grant(), grantFiles);
  const snapshot = async () => {
    const out = [];
    const walk = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name), s = await fs.lstat(p); out.push([relative(cwd, p), s.size, s.mtimeMs, e.isDirectory()]);
      if (e.isDirectory()) await walk(p); } };
    await walk(cwd);
    return createHash('sha256').update(JSON.stringify(out.sort())).digest('hex');
  };
  const before = await snapshot();
  const m = await read(cwd, { pick: { template: 'gov-grant', locale: 'ko' } });
  assert.equal(await snapshot(), before);
  assert.deepEqual([m.unit, m.restingPick, m.builtin], ['instance', 'gov-grant', undefined]);
});

test('REQ-125 U1 the screen\'s model: "자료 있음 · 폴더", the three grades told apart, a 건\'s way never passes a decision, its figure = 건 with data', async t => {
  const m = await read(await workspace(t, grant(), grantFiles));
  const a = row(m, 'A사'), b = row(m, 'B사'), stage = id => m.definition.stages.find(s => s.id === id);
  assert.equal(byInstance(m), true);
  assert.deepEqual(tableCell(a, stage('submit'), W), { text: '자료 있음 · 00_제출서류_20260918', tone: 'plain', state: 'found', warned: false });
  assert.deepEqual(tableCell(b, stage('submit'), W).text, '기록 없음');
  // The grades U4 will produce are drawn now (research/290 3.1): hand-made cells.
  const graded = state => ({ ...a, cells: a.cells.map(c => c.stage === 'agree' ? { ...c, state, events: state === 'incomplete' ? [] : c.events.concat(c.events) } : c) });
  assert.deepEqual(['candidate', 'ambiguous', 'incomplete'].map(s => tableCell(graded(s), stage('agree'), W)).map(v => [v.text, v.tone]), [
    ['후보 · 자료 있음 · 10_선정·계약 +1', 'muted'], ['⚠ 모호 — 근거 2', 'warning'], ['▨ 일부만 읽음', 'warning']]);
  assert.deepEqual(['found', 'candidate', 'ambiguous', 'incomplete', 'no-record'].map(s => cellMark(graded(s), stage('agree'), W, 'instance').mark),
    ['●', '◌', '⚠', '▨', '–'], 'the phone\'s marks tell the grades apart by shape alone');
  assert.equal(cellMark(a, stage('agree'), W).mark, '✓', 'without the unit, the release marks as before');
  // Steps with data on both sides of a decision: the 건's way does not pass it, and no loop is drawn round.
  const all = { ...a, path: [{ stage: 'docs' }, { stage: 'redo' }, { stage: 'submit' }] };
  const overlay = flowOverlay(m.definition, all, W, 'instance');
  assert.deepEqual([overlay.passed.has('check'), [...overlay.loops.values()].flat().length], [false, 0]);
  assert.ok(![...overlay.hot].some(i => [m.definition.edges[i].from, m.definition.edges[i].to].includes('check')), 'no line into or out of the decision');
  assert.equal(flowOverlay(m.definition, all, W).passed.has('check'), true, 'a release (/1) still passes a decision between two passed steps');
  assert.deepEqual(overlay.notes.agree, ['자료 있음 · 10_선정·계약']);
  assert.deepEqual(overlay.notes.redo, undefined, 'a step with no rule says so through sourceNotes, as before');
  assert.deepEqual(stageCounts(m, W), { docs: '자료 있는 건 1', submit: '자료 있는 건 1', agree: '자료 있는 건 1' });
  assert.ok(ladderItems(m, a, W).every(v => v.kind !== 'loop' || v.loops.length === 0));
  assert.equal(instanceChip('가'.repeat(40), 12), '가'.repeat(12) + '…');
  assert.equal(instanceChip('A사', 12), 'A사');
  assert.equal(instanceChip('😀'.repeat(13), 12), '😀'.repeat(12) + '…', 'whole characters, never half a pair');
});

test('REQ-125 U1 302 follow-ups: @/# files are data and written segments are taken as written (F1), a cap wins over found (F2), "{instance}/" is refused (F3), shown names stay apart (F4), system-hidden names are not counted as left out (J1)', async t => {
  const def = (extra = {}) => grant({ instanceKey: { from: 'folder', path: '건/*', label: 'strip-number-prefix' }, sources: [{ stage: 'agree', read: 'folder', files: ['{instance}/자료*'] }], ...extra });
  // F1: a regular file whose name starts with @ or # is data; only a real hidden name (.) and README.* are not.
  const atHash = await read(await workspace(t, def(), { '건/A/자료/@견적.pdf': '', '건/B/자료/#계약.pdf': '', '건/C/자료/.DS_Store': '', '건/C/자료/README': '' }));
  assert.deepEqual(atHash.releases.map(r => [r.label, cell(r, 'agree').state, cell(r, 'agree').events[0]?.files]), [['A', 'found', 1], ['B', 'found', 1], ['C', 'no-record', undefined]]);
  // F1: segments written in full are taken as written — an @ parent of the 건 folder, a # evidence folder; `*` still passes over them.
  const atParent = await read(await workspace(t, def({ instanceKey: { from: 'folder', path: '@사업/*' } }), { '@사업/A/자료_v0101/자료.pdf': '' }));
  assert.deepEqual([atParent.instanceFolder, atParent.releases.map(r => [r.label, cell(r, 'agree').state])], [{ path: '@사업', found: true }, [['A', 'found']]]);
  const hashEvidence = await read(await workspace(t, def({ sources: [{ stage: 'agree', read: 'folder', files: ['{instance}/#계약_v0101'] }] }), { '건/A/#계약_v0101/자료.pdf': '' }));
  assert.equal(cell(hashEvidence.releases[0], 'agree').state, 'found');
  const wildcard = await read(await workspace(t, def({ sources: [{ stage: 'agree', read: 'folder', files: ['{instance}/*'] }] }), { '건/A/@eaDir/thumb.jpg': '', '건/A/#tmp/x': '' }));
  assert.equal(cell(wildcard.releases[0], 'agree').state, 'no-record', 'a wildcard never takes @eaDir or # folders as evidence');
  // F2: data found, but the folder was cut at a cap — 일부만 읽음 first, the folder found kept as its evidence.
  const files = {}; for (let i = 0; i < 8; i++) files['건/A/자료/' + i + '.pdf'] = '';
  const cut = await read(await workspace(t, def(), files), { limits: { ...WORKFLOW_LIMITS, folderEntries: 4 } });
  const c = cell(cut.releases[0], 'agree'), agree = cut.definition.stages.find(s => s.id === 'agree');
  assert.deepEqual([c.state, c.events.map(e => e.files), cut.incomplete], ['incomplete', [4], ['건/A/자료']]);
  assert.deepEqual(tableCell(cut.releases[0], agree, W).text, '▨ 일부만 읽음 · 자료 있음 · 자료');
  assert.equal(cellMark(cut.releases[0], agree, W, 'instance').mark, '▨');
  assert.deepEqual([cut.releases[0].path, stageCounts(cut, W).agree], [[{ stage: 'agree' }], '자료 있는 건 1'], 'data was found: its way and figure still count it');
  // F3: a trailing "/" is an empty segment — 형식 모름, not "기록 없음"; "{instance}" alone stays the 건 folder.
  for (const pattern of ['{instance}/', '{instance}/자료/', '{instance}//자료']) {
    const m = await read(await workspace(t, def({ sources: [{ stage: 'agree', read: 'folder', files: [pattern] }] }), { '건/A/x.pdf': '' }));
    assert.deepEqual([m.defined, m.reason], [false, 'unknown-format'], pattern);
  }
  const alone = await read(await workspace(t, def({ sources: [{ stage: 'agree', read: 'folder', files: ['{instance}'] }] }), { '건/A/x.pdf': '' }));
  assert.equal(cell(alone.releases[0], 'agree').state, 'found');
  // F4: a name put back must not meet another's stripped name — checked until none is shared.
  const labels = await read(await workspace(t, def(), { '건/01_A/': '', '건/02_A/': '', '건/01_01_A/': '', '건/03_B/': '' }));
  assert.deepEqual(labels.releases.map(r => r.label), ['01_01_A', '01_A', '02_A', 'B']);
  // J1: system-hidden names stay in the reading with their reason, but the screen's "제외 N" counts links and collisions only.
  const noisy = await workspace(t, def(), { '건/A/자료/x.pdf': '', '건/@eaDir/': '', '건/.git/': '' });
  await fs.symlink(join(noisy, '건/A'), join(noisy, '건/B'));
  const m = await read(noisy);
  assert.deepEqual(m.excluded.map(x => [x.path, x.why]), [['건/.git', 'hidden'], ['건/@eaDir', 'hidden'], ['건/B', 'link']]);
  assert.deepEqual(shownExcluded(m), [{ path: '건/.git', why: 'hidden' }, { path: '건/B', why: 'link' }], 'only a system helper (@eaDir) is quiet; .git is said');
  assert.deepEqual(shownExcluded({}), []);
});

test('REQ-125 U1 303-F5 a 건 folder someone named @… or #… is left out of the rows (the /2 rule) but still said in "제외 N" with its reason; only system helpers are quiet', async t => {
  const def = grant({ instanceKey: { from: 'folder', path: '건/*' }, sources: [{ stage: 'agree', read: 'folder', files: ['{instance}/자료'] }] });
  const helpers = ['@eaDir', '#recycle', '#snapshot', '@Recycle', '.Spotlight-V100', '.Trashes', '.fseventsd', '.Trash-1000'];
  const files = { '건/A/자료/x.pdf': '', '건/@고객과제/자료/계약.pdf': '', '건/#긴급건/자료/견적.pdf': '', '건/.비공개/자료/y.pdf': '' };
  for (const h of helpers) files['건/' + h + '/'] = '';
  const cwd = await workspace(t, def, files);
  const m = await read(cwd);
  assert.deepEqual(m.releases.map(r => r.label), ['A'], 'the /2 rule is unchanged: hidden, @ and # names are no 건');
  assert.equal(m.excluded.length, 3 + helpers.length, 'the reading keeps every one with its reason');
  assert.ok(m.excluded.every(x => x.why === 'hidden'));
  assert.deepEqual(shownExcluded(m).map(x => x.path), ['건/#긴급건', '건/.비공개', '건/@고객과제'], 'what someone made is said; helpers are quiet');
  // Only someone's @/# folders: 건 0, but "제외 2" — never 건 0 · 제외 0 with no way to see why.
  await fs.rm(join(cwd, '건/A'), { recursive: true });
  const only = await read(cwd);
  assert.deepEqual([only.releases.length, shownExcluded(only).length], [0, 3]);
  // The list: exact names, and Linux's per-user Trash; near names are not helpers.
  for (const name of helpers) assert.equal(systemHelper(name), true, name);
  for (const name of ['@eadir', '@eaDir2', '#recycle_old', '.Trash', '.Trash-', '@고객과제', '.git', '$RECYCLE.BIN']) assert.equal(systemHelper(name), false, name);
});
