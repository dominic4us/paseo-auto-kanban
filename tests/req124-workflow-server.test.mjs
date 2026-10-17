// REQ-124 unit 1: the server side of a lane's "workflow" view. server/workflow.ts reads a workspace's definition file
// (`.kanban/workflow.json`, shared/workflow.ts) and, by its fixed-vocabulary rules, the workspace's own documents — report
// verdict lines, result heads, the REQ table, the branch's reflog — joined by release version. It only reads and never runs
// git. Everything here is a made-up workspace in a temporary folder (made-up REQ numbers, versions, hashes and names).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readWorkflow, readVerdict, createWorkflowReader, idsOf, nameVersion, WORKFLOW_LIMITS } from '../dist/server/workflow.js';
import { workflowDefinitionSchema, WORKFLOW_DEFINITION_PATH } from '../dist/shared/workflow.js';
import { workflowGet } from '../dist/shared/rpc.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { fixture } from './helpers.mjs';

const words = { pass: ['통과'], conditional: ['조건부'], fail: ['불통과', '실패'] };
const markers = ['종합 판정', '최종 판정', '최종 집계'];
const definition = (extra = {}) => ({
  format: 'paseo-kanban.workflow/1', name: '합성 절차', releaseKey: 'semver', releaseWindow: 10,
  stages: [
    { id: 'req', label: '요구', shape: 'pill', row: 0, col: 0 },
    { id: 'impl', label: '구현', shape: 'box', row: 0, col: 1 },
    { id: 'gate', label: '게이트', shape: 'box', row: 0, col: 2 },
    { id: 'pass', label: '통과?', shape: 'diamond', row: 0, col: 3 },
    { id: 'commit', label: '커밋', shape: 'box', row: 0, col: 4 },
    { id: 'stable', label: '안정판', shape: 'box', row: 0, col: 5 },
    { id: 'tester', label: '테스터', shape: 'pill', row: 0, col: 6 },
    { id: 'fix', label: '수정', shape: 'box', row: 1, col: 3 },
    { id: 'phone', label: '사람 확인', shape: 'box', row: 1, col: 5, person: true },
  ],
  edges: [
    { from: 'req', to: 'impl' }, { from: 'impl', to: 'gate' }, { from: 'gate', to: 'pass' },
    { from: 'pass', to: 'commit', when: 'yes' }, { from: 'pass', to: 'fix', when: 'no' },
    { from: 'fix', to: 'gate', back: true }, { from: 'commit', to: 'stable' }, { from: 'stable', to: 'tester' },
    { from: 'stable', to: 'phone', optional: true },
  ],
  sources: [
    { stage: 'req', read: 'headings', files: ['notes/reqs.md'], heading: '###', id: 'req-or-defect', verb: '접수', release: 'text-version', time: 'kst' },
    { stage: 'impl', read: 'names', files: ['docs/*_결과.md'], id: 'req-or-defect', releaseVia: 'req' },
    { stage: 'gate', read: 'verdict', round: 'first', files: ['docs/*_게이트검증.md'], markers, words,
      release: ['name-version', 'after:대상: v'], releaseFallback: 'req', time: 'kst', headBytes: 4096 },
    { stage: 'gate', read: 'verdict', round: 'again', files: ['docs/*_재게이트.md'], markers, words,
      release: ['name-version', 'after:대상: v'], releaseFallback: 'req', time: 'kst', headBytes: 4096 },
    { stage: 'fix', read: 'names', files: ['docs/*_게이트후수정'], release: 'name-version', releaseFallback: 'req' },
    { stage: 'commit', read: 'git-reflog', branch: 'main', release: 'bump-to' },
    { stage: 'stable', read: 'result-head', files: ['logs/stable-*/RESULT.md'], release: 'after:release.json', time: 'kst',
      failWords: ['실패', '롤백'], sha: 'dir-suffix' },
    { stage: 'tester', read: 'result-head', files: ['logs/tester-*/RESULT.md'], release: 'after:태그', time: 'kst', failWords: ['보류'] },
  ],
  ...extra,
});
const sha = c => c.repeat(40);
const reflogLine = (from, to, epoch, message) => `${from} ${to} Someone Example <someone@example.com> ${epoch} +0900\t${message}`;
/** The four verdict-line formats, one per report, plus a report the rules cannot read. */
const files = {
  'notes/reqs.md': [
    '# 요구 표', '',
    '### REQ-3 접수 — 합성 기능 (2026-01-01 10:00 KST) · **완료, v0.1.5**', '- 본문',
    '### REQ-4 접수 — 다른 기능 (2026-01-02 11:00 KST) · 완료, v0.1.6', '',
    '### REQ-9 접수 — 세 번째 (2026-01-03 09:xx KST) · 완료, v0.1.7', '',
    '### REQ-12 접수 — 아직 (2026-01-04 09:00 KST)', '',
  ].join('\n'),
  'docs/9_REQ3_1단계_결과.md': '# 결과\n',
  'docs/19_REQ4_결과.md': '# 결과\n',
  'docs/25_REQ3_2단계_결과.md': '# 결과\n',
  // ① the old same-line marker, bold
  'docs/11_v0105_게이트검증.md': '# 11 · v0.1.5 게이트 — REQ-3\n\n- 착수: **2026-01-01 12:00 KST**\n\n## 종합 판정: **통과 — 결함 0, 판단 1**\n',
  // ② a list item "최종 판정:", after prose that only mentions another marker
  'docs/20_v0106_게이트검증.md': '# 20 · v0.1.6 게이트 — REQ-4\n\n- 착수: 2026-01-02 13:00 KST\n'
    + '- 최종 집계는 통과 건수만 셌다(설명 문장)\n- 최종 판정: **불통과 — 결함 2건**\n\n| 항목 | 판정 |\n|---|---|\n| 종합 판정 | 통과 |\n',
  'docs/21_v0106_게이트후수정/notes.md': '수정 기록\n',
  // ③ a heading marker with the verdict on the next line
  'docs/22_v0106_재게이트.md': '# 22 · v0.1.6 재게이트 — 20-D1\n\n- 착수: 2026-01-02 15:00 KST\n\n## 최종 집계\n\n**조건부 통과 — 결함 0 · 판단 2**\n',
  // ④ the standard line (plans/00c): "## 종합 판정: …" then "- 대상: vX.Y.Z" — the file name has no version
  'docs/30_REQ9_게이트검증.md': '# 30 · 게이트 — REQ-9 · REQ-3 2단계\n\n## 종합 판정: 조건부 통과 — 결함 0 · 판단 1\n- 대상: v0.1.7\n- 착수: 2026-01-03 10:00 KST\n',
  // no marker at all: "형식 모름"
  'docs/40_REQ12_게이트검증.md': '# 40 · REQ-12 게이트\n\n| 항목 | 판정 |\n|---|---|\n| A | 통과 |\n',
  'logs/stable-aaaaaaa/RESULT.md': '# 안정판 aaaaaaa 갱신 결과\n- 완료: 2026-01-01 14:00 KST. release.json 0.1.5 / aaaaaaa\n',
  'logs/stable-ccccccc/RESULT.md': '# 안정판 ccccccc 갱신 결과\n- 완료: 2026-01-02 16:00 KST. release.json 0.1.6 / ccccccc\n',
  'logs/stable-ddddddd/RESULT.md': '# 안정판 ddddddd 갱신 결과\n- 완료: 2026-01-03 12:00 KST. release.json 0.1.7 / ddddddd\n',
  'logs/stable-eeeeeee/other.txt': '결과 파일 없는 폴더\n',
  'logs/tester-1/RESULT.md': '# 테스터 1호 릴리스 결과\n- 2026-01-01 15:00 KST: 태그 v0.1.5 push 완료\n',
  '.git/logs/refs/heads/main': [
    reflogLine(sha('0'), sha('a'), 1767243600, 'commit (initial): First, bump to 0.1.5'),
    reflogLine(sha('a'), sha('b'), 1767330000, 'commit: Something without a version'),
    reflogLine(sha('b'), sha('c'), 1767333600, 'commit: Second, bump to 0.1.6'),
    reflogLine(sha('c'), sha('d'), 1767420000, 'commit: Third, bump to 0.1.7'),
  ].join('\n') + '\n',
};
async function workspace(t, { def = definition(), extra = {}, without = [] } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'kanban-req124-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'ws');
  for (const [name, text] of Object.entries({ ...files, ...extra })) {
    if (without.includes(name) || text === null) continue;
    await fs.mkdir(join(cwd, name, '..'), { recursive: true });
    await fs.writeFile(join(cwd, name), text);
  }
  if (def !== null) {
    await fs.mkdir(join(cwd, '.kanban'), { recursive: true });
    await fs.writeFile(join(cwd, WORKFLOW_DEFINITION_PATH), typeof def === 'string' ? def : JSON.stringify(def));
  }
  return { root, cwd };
}
const release = (model, v) => model.releases.find(r => r.release === v);
const cell = (r, stage) => r.cells.find(c => c.stage === stage);

test('REQ-124 the four verdict-line formats are read, each with its line and excerpt; a report without a marker is 형식 모름', async t => {
  const { cwd } = await workspace(t);
  const m = await readWorkflow(cwd);
  assert.equal(m.defined, true);
  const byDoc = Object.fromEntries(m.reports.map(e => [e.doc, e]));
  assert.deepEqual([byDoc[11].verdict, byDoc[11].marker, byDoc[11].line], ['pass', '종합 판정', 5]);
  assert.match(byDoc[11].excerpt, /^## 종합 판정: 통과 — 결함 0/);
  // prose that only mentions "최종 집계" and a table row saying 통과 do not win over the list item's 불통과
  assert.deepEqual([byDoc[20].verdict, byDoc[20].marker, byDoc[20].word, byDoc[20].line], ['fail', '최종 판정', '불통과', 5]);
  assert.deepEqual([byDoc[22].verdict, byDoc[22].marker, byDoc[22].line, byDoc[22].round], ['conditional', '최종 집계', 7, 'again']);
  assert.equal(byDoc[22].excerpt, '조건부 통과 — 결함 0 · 판단 2');
  // the standard line: verdict on the heading, release after "대상: v"
  assert.deepEqual([byDoc[30].verdict, byDoc[30].release, byDoc[30].releaseFrom], ['conditional', '0.1.7', 'text']);
  assert.equal(byDoc[40].verdict, 'unknown');
  assert.deepEqual(m.unknownFormat, [{ stage: 'gate', path: 'docs/40_REQ12_게이트검증.md' }]);
  // times are the report's first KST line, as written
  assert.equal(byDoc[11].time, '2026-01-01 12:00');
  // the building blocks
  assert.equal(readVerdict('## 종합 판정: **불통과** — 결함 1', markers, words).verdict, 'fail');
  assert.equal(readVerdict('- 종합 판정: 조건부 통과', markers, words).verdict, 'conditional');
  assert.equal(readVerdict('판정 없음', markers, words), null);
  assert.equal(readVerdict('종합 판정표는 통과 뒤에 적는다', markers, words), null, 'a marker inside a longer word is not one');
  assert.equal(nameVersion('208_v0142_게이트검증.md'), '0.1.42');
  assert.deepEqual(idsOf('REQ-117~120·D42'), ['REQ-117', 'REQ-118', 'REQ-119', 'REQ-120', 'D42']);
  assert.deepEqual(idsOf('REQ62_63'), ['REQ-62', 'REQ-63']);
});

test('REQ-124 releases join by version: report name, commit title, stable result and tester result; a hash that differs is a warning', async t => {
  const { cwd } = await workspace(t, { extra: { 'logs/stable-9999999/RESULT.md': '# 안정판 9999999 갱신 결과\n- release.json 0.1.7 / 9999999\n' } });
  const m = await readWorkflow(cwd);
  assert.deepEqual(m.releases.map(r => r.release), ['0.1.7', '0.1.6', '0.1.5'], 'newest first, only versions read directly');
  const r5 = release(m, '0.1.5');
  assert.deepEqual(r5.cells.map(c => [c.stage, c.state]), [['req', 'found'], ['impl', 'found'], ['gate', 'found'], ['pass', 'decision'],
    ['commit', 'found'], ['stable', 'found'], ['tester', 'found'], ['fix', 'no-record'], ['phone', 'no-source']]);
  const commit = cell(r5, 'commit').events[0];
  assert.deepEqual([commit.sha, commit.releaseFrom, commit.subject, commit.path], ['aaaaaaa', 'bump', 'First, bump to 0.1.5', '.git/logs/refs/heads/main']);
  assert.equal(commit.time, '2026-01-01 14:00 KST');
  assert.ok(!JSON.stringify(m).includes('someone@example.com') && !JSON.stringify(m).includes('Someone Example'), 'names on reflog lines are never kept');
  assert.deepEqual(cell(r5, 'stable').events.map(e => [e.sha, e.release, e.time, e.ok]), [['aaaaaaa', '0.1.5', '2026-01-01 14:00', true]]);
  assert.deepEqual(cell(r5, 'tester').events.map(e => e.release), ['0.1.5']);
  assert.deepEqual(r5.warnings, []);
  // 0.1.7's commit is ddddddd, a second stable result says 9999999
  assert.deepEqual(release(m, '0.1.7').warnings, [{ kind: 'sha-mismatch', stage: 'commit', sha: 'ddddddd', resultStage: 'stable',
    resultSha: '9999999', path: 'logs/stable-9999999/RESULT.md' }]);
  // a folder without its result file is 자료 없음, not 형식 모름
  assert.deepEqual(m.missing, [{ stage: 'stable', path: 'logs/stable-eeeeeee' }]);
  assert.equal(m.git.state, 'read'); assert.equal(m.git.commits, 4);
  // totals: over the releases shown and over everything read
  const gate = m.totals.find(x => x.stage === 'gate' && x.round === 'first');
  assert.deepEqual(gate.all, { count: 4, pass: 1, conditional: 1, fail: 1, unknown: 1 });
  assert.deepEqual(gate.window, { count: 3, pass: 1, conditional: 1, fail: 1, unknown: 0 });
  assert.deepEqual(m.definition.stages.map(s => s.id), definition().stages.map(s => s.id));
});

test('REQ-124 a regate loop: first gate fails, a fix, a regate — in document order on the path', async t => {
  const { cwd } = await workspace(t);
  const r6 = release(await readWorkflow(cwd), '0.1.6');
  assert.deepEqual([r6.firstVerdict, r6.finalVerdict, r6.regates], ['fail', 'conditional', 1]);
  assert.deepEqual(r6.path, [{ stage: 'req' }, { stage: 'impl' }, { stage: 'gate', doc: 20, round: 'first', verdict: 'fail' },
    { stage: 'fix', doc: 21 }, { stage: 'gate', doc: 22, round: 'again', verdict: 'conditional' }, { stage: 'commit' }, { stage: 'stable' }]);
  assert.deepEqual(cell(r6, 'fix').events.map(e => [e.path, e.release, e.releaseFrom]), [['docs/21_v0106_게이트후수정', '0.1.6', 'name']]);
  assert.equal(cell(r6, 'tester').state, 'no-record', 'no tester result: 기록 없음, never "not done"');
});

test('REQ-124 a REQ over two releases (REQ-103 rule): the later release gets it from its report title, and each document goes to the release that follows it', async t => {
  const { cwd } = await workspace(t);
  const m = await readWorkflow(cwd);
  const r5 = release(m, '0.1.5'), r7 = release(m, '0.1.7');
  assert.deepEqual(r5.reqs.find(q => q.id === 'REQ-3'), { id: 'REQ-3', via: 'heading', path: 'notes/reqs.md', line: 3 });
  assert.deepEqual(r7.reqs.map(q => [q.id, q.via]), [['REQ-9', 'heading'], ['REQ-3', 'report']]);
  assert.deepEqual(cell(r5, 'impl').events.map(e => [e.path, e.releaseFrom]), [['docs/9_REQ3_1단계_결과.md', 'req']]);
  assert.deepEqual(cell(r7, 'impl').events.map(e => [e.path, e.releaseFrom]), [['docs/25_REQ3_2단계_결과.md', 'order']]);
  assert.deepEqual(cell(release(m, '0.1.6'), 'impl').events.map(e => e.path), ['docs/19_REQ4_결과.md']);
});

test('REQ-124 a commit title that cannot be read: the commit cell takes the stable result\'s hash and says 커밋 제목 못 읽음', async t => {
  for (const [label, log, state] of [
    ['no .git', null, 'no-repo'],
    ['a fresh clone', reflogLine(sha('0'), sha('d'), 1767420000, 'clone: from https://example.invalid/repo.git') + '\n', 'no-commits'],
    ['pulled commits', reflogLine(sha('0'), sha('d'), 1767420000, 'pull: Fast-forward') + '\n', 'no-commits'],
  ]) {
    const { cwd } = await workspace(t, { extra: { '.git/logs/refs/heads/main': log } });
    const m = await readWorkflow(cwd);
    assert.equal(m.git.state, state, label);
    const c = cell(release(m, '0.1.6'), 'commit');
    assert.equal(c.state, 'title-unread', label);
    assert.deepEqual(c.events.map(e => [e.sha, e.releaseFrom, e.path, e.kind]), [['ccccccc', 'stable-sha', 'logs/stable-ccccccc/RESULT.md', 'commit']], label);
    assert.ok(release(m, '0.1.6').path.some(p => p.stage === 'commit'), label);
  }
  // A worktree: `.git` is a file pointing at the main repository's `.git/worktrees/<name>`; the branch log is in the common folder.
  const { root, cwd } = await workspace(t, { without: ['.git/logs/refs/heads/main'] });
  const main = join(root, 'main-repo', '.git');
  await fs.mkdir(join(main, 'worktrees', 'ws'), { recursive: true });
  await fs.mkdir(join(main, 'logs', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(join(main, 'logs', 'refs', 'heads', 'main'), files['.git/logs/refs/heads/main']);
  await fs.writeFile(join(main, 'worktrees', 'ws', 'commondir'), '../..\n');
  await fs.rm(join(cwd, '.git'), { recursive: true, force: true });
  await fs.writeFile(join(cwd, '.git'), `gitdir: ${join(main, 'worktrees', 'ws')}\n`);
  const m = await readWorkflow(cwd);
  assert.equal(m.git.state, 'read');
  assert.equal(cell(release(m, '0.1.6'), 'commit').state, 'found');
});

test('REQ-124 no definition: { defined: false } with the reason, through the RPC too', async t => {
  const { cwd } = await workspace(t, { def: null });
  assert.deepEqual(await readWorkflow(cwd), { defined: false, reason: 'missing', definitionPath: '.kanban/workflow.json' });
  const bad = await workspace(t, { def: '{ not json' });
  assert.equal((await readWorkflow(bad.cwd)).reason, 'unknown-format');
  const unknownKey = await workspace(t, { def: definition({ colour: 'red' }) });
  const u = await readWorkflow(unknownKey.cwd);
  assert.equal(u.reason, 'unknown-format'); assert.ok(u.problems.length > 0);
  const regex = await workspace(t, { def: definition({ sources: [{ stage: 'gate', read: 'verdict', round: 'first', files: ['docs/*.md'], markers, words, pattern: '.*' }] }) });
  assert.equal((await readWorkflow(regex.cwd)).reason, 'unknown-format', 'no free regular expressions');
  const orphan = await workspace(t, { def: definition({ edges: [{ from: 'req', to: 'nowhere' }] }) });
  assert.equal((await readWorkflow(orphan.cwd)).reason, 'unknown-format');
  // The RPC: the workspace folder comes from the board (no Paseo here), the reply parses.
  const { store, cwd: boardCwd } = await fixture(t);
  const handlers = createReadHandlers(store);
  const none = workflowGet.output.parse(await handlers.workflow({ workspaceId: 'wks_example01' }));
  assert.deepEqual(none, { ok: true, data: { defined: false, reason: 'missing', definitionPath: '.kanban/workflow.json' }, committed: false, warnings: [] });
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(join(boardCwd, name, '..'), { recursive: true }); await fs.writeFile(join(boardCwd, name), text); }
  await fs.mkdir(join(boardCwd, '.kanban')); await fs.writeFile(join(boardCwd, WORKFLOW_DEFINITION_PATH), JSON.stringify(definition()));
  const fresh = createReadHandlers(store);
  const some = workflowGet.output.parse(await fresh.workflow({ workspaceId: 'wks_example01', window: 2 }));
  assert.equal(some.ok, true); assert.deepEqual(some.data.releases.map(r => r.release), ['0.1.7', '0.1.6']);
  // Paseo's listing is asked first; a workspace nobody knows is an error, never a guess.
  const paseo = { workspaces: { list: async () => ({ entries: [{ id: 'wks_other01', workspaceDirectory: boardCwd }], pageInfo: { nextCursor: null } }) } };
  const listed = workflowGet.output.parse(await fresh.workflow({ workspaceId: 'wks_other01' }, paseo));
  assert.equal(listed.ok && listed.data.defined, true);
  const unknown = workflowGet.output.parse(await fresh.workflow({ workspaceId: 'wks_nobody01' }, paseo));
  assert.equal(unknown.ok, false); assert.equal(unknown.error.code, 'E_NOT_FOUND');
  assert.throws(() => workflowGet.input.parse({ workspaceId: 'wks_example01', cwd: '/elsewhere' }), 'the screen cannot name a folder');
});

test('REQ-124 paths never leave the workspace: `..`, absolute, `**`, hidden segments refused; symbolic links outside are not followed', async t => {
  for (const pattern of ['../outside/*.md', '/etc/*', 'docs/**/x.md', '.git/config', 'docs/../../x.md', 'docs/a*b*c.md', 'docs\\x.md']) {
    const def = definition({ sources: [{ stage: 'impl', read: 'names', files: [pattern] }] });
    assert.equal(workflowDefinitionSchema.safeParse(def).success, false, pattern);
  }
  const { root, cwd } = await workspace(t);
  const outside = join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, '90_v0199_게이트검증.md'), '# 90\n## 종합 판정: 통과\n');
  await fs.writeFile(join(outside, 'secret.md'), '# not for the plugin\n');
  await fs.symlink(join(outside, '90_v0199_게이트검증.md'), join(cwd, 'docs', '91_v0198_게이트검증.md'));
  await fs.symlink(outside, join(cwd, 'logs', 'stable-fffffff'));
  const m = await readWorkflow(cwd);
  assert.ok(!m.reports.some(e => e.doc === 91 || e.doc === 90), 'a link to a file outside is not read');
  assert.ok(!m.releases.some(r => r.release === '0.1.98' || r.release === '0.1.99'));
  assert.ok(!JSON.stringify(m).includes('stable-fffffff'), 'a linked folder outside is neither read nor listed');
  // A definition file that is a link to a file outside the workspace.
  const other = await workspace(t, { def: null });
  await fs.writeFile(join(outside, 'workflow.json'), JSON.stringify(definition()));
  await fs.mkdir(join(other.cwd, '.kanban'));
  await fs.symlink(join(outside, 'workflow.json'), join(other.cwd, WORKFLOW_DEFINITION_PATH));
  assert.equal((await readWorkflow(other.cwd)).reason, 'outside');
  // A `.git` file pointing anywhere but a `.git` folder is not followed.
  const third = await workspace(t, { without: ['.git/logs/refs/heads/main'] });
  await fs.rm(join(third.cwd, '.git'), { recursive: true, force: true });
  await fs.mkdir(join(outside, 'logs', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(join(outside, 'logs', 'refs', 'heads', 'main'), files['.git/logs/refs/heads/main']);
  await fs.writeFile(join(third.cwd, '.git'), `gitdir: ${outside}\n`);
  assert.equal((await readWorkflow(third.cwd)).git.state, 'no-repo');
});

test('222-F1 a linked folder, file or definition outside is never listed, stat\'ed or read; links inside and a worktree\'s `.git` still work', async t => {
  const { root, cwd } = await workspace(t);
  const outside = join(root, 'outside');
  await fs.mkdir(join(outside, 'deeper'), { recursive: true });
  await fs.writeFile(join(outside, '93_v0197_게이트검증.md'), '# 93\n## 종합 판정: 통과\n');
  await fs.writeFile(join(outside, 'deeper', '94_v0196_게이트검증.md'), '# 94\n## 종합 판정: 통과\n');
  await fs.symlink(outside, join(cwd, 'linked'));
  await fs.symlink(join(outside, '93_v0197_게이트검증.md'), join(cwd, 'docs', '95_v0195_게이트검증.md'));
  // A link inside the workspace to a folder and a file inside it is followed as usual.
  await fs.mkdir(join(cwd, 'kept'));
  await fs.writeFile(join(cwd, 'kept', '96_v0194_게이트검증.md'), '# 96\n## 종합 판정: 통과\n');
  await fs.symlink(join(cwd, 'kept'), join(cwd, 'alias'));
  await fs.symlink(join(cwd, 'kept', '96_v0194_게이트검증.md'), join(cwd, 'docs', '97_v0193_게이트검증.md'));
  const gate = definition().sources[2];
  const def = definition({ sources: [...definition().sources,
    { ...gate, files: ['linked/*_게이트검증.md', 'linked/*/*_게이트검증.md', 'alias/*_게이트검증.md'] }] });
  await fs.writeFile(join(cwd, WORKFLOW_DEFINITION_PATH), JSON.stringify(def));
  const listed = [], opened = [];
  // Watch what the module asks of the file system (node:fs/promises is shared, so the calls are seen here).
  const promises = createRequire(import.meta.url)('node:fs/promises');
  const original = { readdir: promises.readdir, open: promises.open, stat: promises.stat, readFile: promises.readFile };
  promises.readdir = async (p, ...rest) => { listed.push(String(p)); return original.readdir(p, ...rest); };
  promises.open = async (p, ...rest) => { opened.push(String(p)); return original.open(p, ...rest); };
  promises.stat = async (p, ...rest) => { opened.push(String(p)); return original.stat(p, ...rest); };
  promises.readFile = async (p, ...rest) => { opened.push(String(p)); return original.readFile(p, ...rest); };
  syncBuiltinESMExports();
  let m, offered;
  try {
    m = await readWorkflow(cwd);
    const other = await workspace(t, { def: null });
    await fs.mkdir(join(other.cwd, '.kanban'));
    await fs.writeFile(join(outside, 'workflow.json'), JSON.stringify(definition()));
    await fs.symlink(join(outside, 'workflow.json'), join(other.cwd, WORKFLOW_DEFINITION_PATH));
    offered = { outside: await createWorkflowReader().defined(other.cwd), inside: await createWorkflowReader().defined(cwd) };
    // A `.kanban` folder that is itself a link outside.
    const third = await workspace(t, { def: null });
    await fs.symlink(outside, join(third.cwd, '.kanban'));
    offered.folder = await createWorkflowReader().defined(third.cwd);
    offered.folderReason = (await readWorkflow(third.cwd)).reason;
  } finally { Object.assign(promises, original); syncBuiltinESMExports(); }
  const out = p => p === outside || p.startsWith(outside + '/') || p === join(cwd, 'linked') || p.startsWith(join(cwd, 'linked') + '/');
  assert.deepEqual(listed.filter(out), [], 'no folder outside is listed, through a link or not');
  assert.deepEqual(opened.filter(p => out(p) || p.endsWith('95_v0195_게이트검증.md')), [], 'no file outside is stat\'ed or read');
  assert.ok(!m.reports.some(e => [93, 94, 95].includes(e.doc)), 'nothing outside is reported');
  assert.ok(!JSON.stringify(m).includes('linked/'), 'no name under the linked folder reaches the reply');
  assert.ok(m.reports.some(e => e.doc === 96 && e.path === 'alias/96_v0194_게이트검증.md'), 'a linked folder inside is listed');
  assert.ok(m.reports.some(e => e.doc === 97 && e.verdict === 'pass'), 'a linked file inside is read');
  assert.deepEqual(offered, { outside: false, inside: true, folder: false, folderReason: 'outside' }, 'no button for a definition outside');
  // `.git` a link to a `.git` folder outside is not followed; a worktree's `gitdir:` must be `.git/worktrees/<name>`.
  const linkedGit = await workspace(t);
  await fs.rename(join(linkedGit.cwd, '.git'), join(linkedGit.root, '.git'));
  await fs.symlink(join(linkedGit.root, '.git'), join(linkedGit.cwd, '.git'));
  assert.equal((await readWorkflow(linkedGit.cwd)).git.state, 'no-repo');
  const bare = await workspace(t);
  await fs.rename(join(bare.cwd, '.git'), join(bare.root, '.git'));
  await fs.writeFile(join(bare.cwd, '.git'), `gitdir: ${join(bare.root, '.git')}\n`);
  assert.equal((await readWorkflow(bare.cwd)).git.state, 'no-repo', 'gitdir: straight at a `.git` outside is not a worktree');
  // A worktree whose `commondir` names another repository's `.git` reads only its own HEAD log, not the other branch log.
  const stray = await workspace(t, { without: ['.git/logs/refs/heads/main'] });
  const main = join(stray.root, 'main-repo', '.git'), elsewhere = join(stray.root, 'elsewhere', '.git');
  await fs.mkdir(join(main, 'worktrees', 'ws'), { recursive: true });
  await fs.mkdir(join(elsewhere, 'logs', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(join(elsewhere, 'logs', 'refs', 'heads', 'main'), files['.git/logs/refs/heads/main']);
  await fs.writeFile(join(main, 'worktrees', 'ws', 'commondir'), `${elsewhere}\n`);
  await fs.rm(join(stray.cwd, '.git'), { recursive: true, force: true });
  await fs.writeFile(join(stray.cwd, '.git'), `gitdir: ${join(main, 'worktrees', 'ws')}\n`);
  assert.equal((await readWorkflow(stray.cwd)).git.state, 'no-log');
});

test('REQ-124 size caps: a large definition, a file too large to read whole, too many files, a verdict past the head bytes', async t => {
  const big = await workspace(t, { def: JSON.stringify(definition({ note: 'x'.repeat(10) })) + ' '.repeat(WORKFLOW_LIMITS.definitionBytes) });
  assert.equal((await readWorkflow(big.cwd)).reason, 'too-large');
  const { cwd } = await workspace(t, { extra: { 'docs/50_v0109_게이트검증.md': '# 50\n' + '채움 줄\n'.repeat(1000) + '## 종합 판정: 통과\n' } });
  const late = (await readWorkflow(cwd)).reports.find(e => e.doc === 50);
  assert.equal(late.verdict, 'unknown', 'only the head (4096 bytes) is read');
  const small = await readWorkflow(cwd, { limits: { ...WORKFLOW_LIMITS, wholeFileBytes: 200 } });
  assert.ok(small.limits.includes('file-too-large:notes/reqs.md'));
  assert.ok(small.releases.find(r => r.release === '0.1.5').reqs.some(q => q.id === 'REQ-3'), 'the head of the table is still read');
  assert.ok(!small.releases.find(r => r.release === '0.1.7').reqs.some(q => q.via === 'heading'), 'what lies past the cap is not');
  const few = await readWorkflow(cwd, { limits: { ...WORKFLOW_LIMITS, files: 3 } });
  assert.ok(few.limits.includes('files')); assert.ok(few.cost.files <= 3);
  const narrow = await readWorkflow(cwd, { limits: { ...WORKFLOW_LIMITS, filesPerPattern: 2 } });
  assert.ok(narrow.limits.includes('files-per-pattern:docs/*_게이트검증.md'));
  const schema = definition({ sources: [{ ...definition().sources[2], headBytes: 10_000_000 }] });
  assert.equal(workflowDefinitionSchema.safeParse(schema).success, false, 'head bytes are capped in the definition');
});

async function snapshot(dir) {
  const out = [];
  async function walk(at) {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const file = join(at, entry.name), stat = await fs.lstat(file);
      const body = entry.isFile() ? createHash('sha256').update(await fs.readFile(file)).digest('hex') : entry.isSymbolicLink() ? await fs.readlink(file) : '';
      out.push([relative(dir, file), stat.size, stat.mtimeMs, body]);
      if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(dir);
  return out.sort((a, b) => a[0] < b[0] ? -1 : 1);
}
test('REQ-124 reading writes nothing — the workspace and the board\'s data folder are unchanged; the module has no write or process call', async t => {
  const { store, cwd, root } = await fixture(t);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(join(cwd, name, '..'), { recursive: true }); await fs.writeFile(join(cwd, name), text); }
  await fs.mkdir(join(cwd, '.kanban')); await fs.writeFile(join(cwd, WORKFLOW_DEFINITION_PATH), JSON.stringify(definition()));
  const before = await snapshot(root);
  await readWorkflow(cwd);
  await createReadHandlers(store).workflow({ workspaceId: 'wks_example01' });
  assert.deepEqual(await snapshot(root), before);
  const source = await fs.readFile(new URL('../dist/server/workflow.js', import.meta.url), 'utf8');
  for (const call of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm(', 'copyFile', 'symlink', 'child_process', 'execFile', 'spawn', "'w'", '"w"'])
    assert.ok(!source.includes(call), call);
});

test('REQ-124 one reading per folder a minute; the definition probe is cheap and cached alike', async t => {
  const { cwd } = await workspace(t);
  let clock = 0, calls = 0;
  const reader = createWorkflowReader({ now: () => clock, read: async (dir, options) => { calls++; return readWorkflow(dir, options); } });
  const [a, b] = await Promise.all([reader.read(cwd), reader.read(cwd)]);
  assert.equal(calls, 1); assert.equal(a, b);
  clock = 59_000; await reader.read(cwd); assert.equal(calls, 1);
  await reader.read(cwd, 2); assert.equal(calls, 2, 'another window is another reading');
  clock = 61_000; await reader.read(cwd); assert.equal(calls, 3);
  assert.equal(reader.reads(), 3);
  assert.equal(await reader.defined(cwd), true);
  const none = await workspace(t, { def: null });
  assert.equal(await reader.defined(none.cwd), false);
  const failing = createWorkflowReader({ read: async () => { throw new Error('boom'); } });
  assert.deepEqual(await failing.read(cwd), { defined: false, reason: 'unreadable', definitionPath: '.kanban/workflow.json' });
});

test('REQ-124 this repository\'s own definition file parses', { skip: !existsSync(new URL('../.kanban/workflow.json', import.meta.url)) && 'no .kanban/workflow.json in this tree' }, async () => {
  const text = await fs.readFile(new URL('../.kanban/workflow.json', import.meta.url), 'utf8');
  const parsed = workflowDefinitionSchema.safeParse(JSON.parse(text));
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});
