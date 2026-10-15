// REQ-125 C안 1단계 (research/282 → 284): "Try a workflow" where a workspace holds no definition file. The eight built-ins
// (shared/workflow-templates.ts) pass the current format in both languages; a pick is kept only in the plugin's own
// `workflow-picks.json` (server/workflow-picks.ts: a damaged file is never written over, a missing one is read from its
// backup); the reading (server/workflow.ts) shows the built-in only with no file — a file wins and the pick rests — and reads
// nothing in the workspace for it; the workspace folder is the same, byte for byte, after a pick, a reading and a stop. The
// screens are in tests/web/run.mjs (=req125). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BUILTIN_WORKFLOWS, builtinDefinition, builtinPreview, builtinWorkflow } from '../dist/shared/workflow-templates.js';
import { WORKFLOW_DEFINITION_PATH, workflowDefinitionSchema, workflowDataSchema } from '../dist/shared/workflow.js';
import { PICKS_BACKUP, PICKS_BYTES, PICKS_FILE, PICKS_LIMIT, parsePicks, pickFor, readPicks, setPick } from '../dist/server/workflow-picks.js';
import { readWorkflow, createWorkflowReader } from '../dist/server/workflow.js';
import { createReadHandlers, readLocale } from '../dist/server/handlers.js';
import { overviewGet, workflowGet, workflowPickSet } from '../dist/shared/rpc.js';
import { laneOffer, settlePicks } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';
import { gateDefinition, writeWorkspace } from './fixtures/workflow-fixtures.mjs';
import { fixture } from './helpers.mjs';

const IDS = ['common', 'dev-gated', 'design', 'research-poc', 'project-kickoff', 'gov-grant', 'sales-b2b', 'marketing-content'];
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
/** Every file under `dir` with its bytes' hash (folders too), sorted — "nothing was written" means this is unchanged. */
async function snapshot(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out.push([p, 'dir']); await walk(p); }
      else out.push([p, createHash('sha256').update(await fs.readFile(p)).digest('hex')]);
    }
  }
  await walk(dir);
  return out.sort((a, b) => a[0] < b[0] ? -1 : 1);
}

test('REQ-125 the eight built-ins: in order, graded, both languages pass the current format, no reading rules, no person\'s name', () => {
  assert.deepEqual(BUILTIN_WORKFLOWS.map(t => t.id), IDS);
  assert.deepEqual(Object.fromEntries(BUILTIN_WORKFLOWS.map(t => [t.id, t.grade])), { common: 'adapted', 'dev-gated': 'verified', design: 'verified',
    'research-poc': 'verified', 'project-kickoff': 'adapted', 'gov-grant': 'adapted', 'sales-b2b': 'reference', 'marketing-content': 'reference' });
  for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) {
    const def = builtinDefinition(t, locale), parsed = workflowDefinitionSchema.safeParse(def);
    assert.ok(parsed.success, t.id + ' ' + locale + ' ' + JSON.stringify(parsed.error?.issues ?? []));
    assert.deepEqual(def.sources, [], 'no reading rules: nothing in a workspace is read for a built-in');
    assert.equal(def.stages.length, t.stages.length);
    if (locale === 'en') assert.ok(!HANGUL.test(JSON.stringify(def)) && !HANGUL.test(t.name.en + t.one.en), t.id + ': the English one has no Hangul');
    else assert.ok(def.stages.every(s => HANGUL.test(s.label)), t.id + ': the Korean one is named in Korean');
    assert.ok(builtinPreview(t, locale).length >= 4, 'a row previews its first steps');
  }
  // research/282 결론 5: the samples' person names were replaced ("내 검토?", "전달(직접)"); none is left in any language.
  const all = JSON.stringify(BUILTIN_WORKFLOWS);
  assert.ok(all.includes('내 검토?') && all.includes('전달(직접)'));
  // No person is named, checked by shape rather than by any one name: a bracket says only how a step is done, and a
  // review belongs to a role (mine or the client's).
  const ROLE_WORDS = new Set(['직접', 'myself', '위임', 'handed off', '병렬', 'UI만', 'UI']), REVIEWERS = new Set(['내', '고객']);
  for (const t of BUILTIN_WORKFLOWS) for (const s of t.stages) {
    for (const label of [s.ko, s.en]) for (const [, inner] of label.matchAll(/\(([^)]*)\)/g)) assert.ok(ROLE_WORDS.has(inner), `${t.id}/${s.id}: a bracket names a way of working, not a person`);
    const reviewer = s.ko.match(/(\S+)\s+검토/)?.[1];
    if (reviewer) assert.ok(REVIEWERS.has(reviewer), `${t.id}/${s.id}: a review is a role's, not a person's`);
  }
  // A made-up name where a role goes would fail the same rule.
  assert.ok(!ROLE_WORDS.has('가나다') && !REVIEWERS.has('가나다'));
  assert.equal(builtinWorkflow('design')?.name.ko, '디자인');
  assert.equal(builtinWorkflow('nothing'), undefined);
  assert.equal(builtinWorkflow(null), undefined);
});

test('REQ-125 the pick is kept in workflow-picks.json (and its backup) by the folder; stop takes the entry out', async t => {
  const { root } = await fixture(t);
  const data = join(root, 'picks-data');
  assert.deepEqual(await readPicks(data), { picks: {} }, 'no file, no backup: the plain start');
  assert.deepEqual(await setPick(data, '/srv/example/shop/', 'design', () => '2026-10-04T01:00:00.000Z'), { template: 'design', changed: true });
  const file = JSON.parse(await fs.readFile(join(data, PICKS_FILE), 'utf8'));
  assert.deepEqual(file, { schemaVersion: 1, picks: { '/srv/example/shop': { template: 'design', at: '2026-10-04T01:00:00.000Z' } } }, 'the id alone, by normalizeCwd');
  assert.equal(await fs.readFile(join(data, PICKS_BACKUP), 'utf8'), await fs.readFile(join(data, PICKS_FILE), 'utf8'));
  assert.equal((await fs.stat(join(data, PICKS_FILE))).mode & 0o777, 0o600);
  assert.equal(pickFor(await readPicks(data), '/srv/example/shop'), 'design');
  assert.equal(pickFor(await readPicks(data), '/srv/example/other'), null);
  assert.deepEqual(await setPick(data, '/srv/example/shop', 'design'), { template: 'design', changed: false });
  assert.deepEqual(await setPick(data, '/srv/example/shop', 'sales-b2b'), { template: 'sales-b2b', changed: true }, 'Change');
  // Two picks at once both land (one write at a time, each reading the file again).
  await Promise.all([setPick(data, '/srv/example/a', 'common'), setPick(data, '/srv/example/b', 'gov-grant')]);
  assert.deepEqual(Object.keys((await readPicks(data)).picks).sort(), ['/srv/example/a', '/srv/example/b', '/srv/example/shop']);
  // Stop using: the entry goes, nothing of it is left.
  assert.deepEqual(await setPick(data, '/srv/example/shop', null), { template: null, changed: true });
  assert.ok(!(await fs.readFile(join(data, PICKS_FILE), 'utf8')).includes('/srv/example/shop'));
  assert.deepEqual(await setPick(data, '/srv/example/shop', null), { template: null, changed: false });
  // A deleted file is read from its backup, so no pick is lost.
  await fs.rm(join(data, PICKS_FILE));
  assert.equal(pickFor(await readPicks(data), '/srv/example/a'), 'common');
  await assert.rejects(setPick(data, '/srv/example/a', 'made-up'), e => e.code === 'E_VALIDATION', 'only a built-in this version has');
  await assert.rejects(setPick(data, '/srv/example/a', '../x'), e => e.code === 'E_VALIDATION');
});

test('REQ-125 a damaged picks file fails closed: no pick shown, never written over; an unknown id is kept but not shown', async t => {
  const { root } = await fixture(t);
  const cases = { 'not json': '{ nope', 'wrong schema': JSON.stringify({ schemaVersion: 2, picks: {} }), array: JSON.stringify([]),
    'picks an array': JSON.stringify({ schemaVersion: 1, picks: [] }), 'bad entry': JSON.stringify({ schemaVersion: 1, picks: { '/a': { template: 'design' } } }),
    'bad id': JSON.stringify({ schemaVersion: 1, picks: { '/a': { template: 'Design!', at: '2026-10-04T01:00:00.000Z' } } }),
    'too many': JSON.stringify({ schemaVersion: 1, picks: Object.fromEntries(Array.from({ length: PICKS_LIMIT + 1 }, (_, i) => ['/w' + i, { template: 'design', at: '2026-10-04T01:00:00.000Z' }])) }) };
  for (const [name, bytes] of Object.entries(cases)) {
    const data = join(root, 'damaged-' + name.replace(/ /g, '-'));
    await fs.mkdir(data); await fs.writeFile(join(data, PICKS_FILE), bytes);
    const state = await readPicks(data);
    assert.equal(state.damaged, true, name);
    assert.equal(pickFor(state, '/a'), null, name + ': nothing is shown from it');
    await assert.rejects(setPick(data, '/a', 'design'), e => e.code === 'E_CORRUPT', name + ': a pick fails and says why');
    await assert.rejects(setPick(data, '/a', null), e => e.code === 'E_CORRUPT', name + ': a stop too');
    assert.equal(await fs.readFile(join(data, PICKS_FILE), 'utf8'), bytes, name + ': the bytes are never written over');
    await assert.rejects(fs.stat(join(data, PICKS_BACKUP)), name + ': no backup made from it');
  }
  // The file gone and its backup unreadable: damaged too (a missing file is the plain start only with no backup).
  const gone = join(root, 'damaged-backup'); await fs.mkdir(gone); await fs.writeFile(join(gone, PICKS_BACKUP), '{');
  assert.equal((await readPicks(gone)).damaged, true);
  // A newer version's built-in: kept through a write, not shown here.
  const later = parsePicks(JSON.stringify({ schemaVersion: 1, picks: { '/later': { template: 'legal-review', at: '2026-10-04T01:00:00.000Z' } } }));
  assert.equal(later.damaged, undefined); assert.equal(pickFor(later, '/later'), null);
  const data = join(root, 'later'); await fs.mkdir(data);
  await fs.writeFile(join(data, PICKS_FILE), JSON.stringify({ schemaVersion: 1, picks: { '/later': { template: 'legal-review', at: '2026-10-04T01:00:00.000Z' } } }));
  await setPick(data, '/other', 'design');
  assert.equal((await readPicks(data)).picks['/later'].template, 'legal-review');
});

test('REQ-125 the reading: a pick shows its built-in only with no file, in the screen\'s language, reading nothing in the workspace', async t => {
  const { root } = await fixture(t);
  const empty = join(root, 'empty'); await fs.mkdir(empty);
  assert.deepEqual(await readWorkflow(empty), { defined: false, reason: 'missing', definitionPath: WORKFLOW_DEFINITION_PATH }, 'no pick: as before');
  const before = await snapshot(empty);
  const ko = await readWorkflow(empty, { pick: { template: 'design', locale: 'ko' } });
  assert.equal(workflowDataSchema.safeParse(ko).success, true);
  assert.equal(ko.defined, true);
  assert.deepEqual(ko.builtin, { id: 'design', version: 1, grade: 'verified' });
  assert.equal(ko.definitionPath, 'builtin:design');
  assert.equal(ko.definition.name, '디자인 — 기본 틀');
  assert.equal(ko.definition.stages.find(s => s.id === 'round').label, '내 라운드?');
  assert.deepEqual([ko.releases, ko.reports, ko.totals, ko.unknownFormat, ko.missing], [[], [], [], [], []], 'the table is empty: nothing to read');
  assert.deepEqual([ko.git.state, ko.cost.files, ko.cost.bytes], ['unused', 0, 0]);
  const en = await readWorkflow(empty, { pick: { template: 'design', locale: 'en' } });
  assert.equal(en.definition.name, 'Design — built-in');
  assert.ok(!HANGUL.test(JSON.stringify(en.definition)));
  assert.deepEqual(await snapshot(empty), before, 'nothing written in the workspace');
  // A file wins — readable (the pick rests, said) or not (its reason, the pick resting too).
  const filed = join(root, 'filed'); await fs.mkdir(filed); await writeWorkspace(filed, gateDefinition, {});
  const wins = await readWorkflow(filed, { pick: { template: 'design', locale: 'ko' } });
  assert.equal(wins.defined, true); assert.equal(wins.builtin, undefined); assert.equal(wins.restingPick, 'design');
  assert.equal(wins.definition.name, gateDefinition.name);
  assert.equal((await readWorkflow(filed)).restingPick, undefined, 'no pick, nothing resting');
  await fs.writeFile(join(filed, WORKFLOW_DEFINITION_PATH), '{ broken');
  const broken = await readWorkflow(filed, { pick: { template: 'design', locale: 'ko' } });
  assert.deepEqual([broken.defined, broken.reason, broken.restingPick], [false, 'unknown-format', 'design'], 'a broken file still wins');
  // An id this version does not have reads as no pick.
  assert.equal((await readWorkflow(empty, { pick: { template: 'legal-review', locale: 'ko' } })).defined, false);
  // The cache keys the pick and its language: a new pick shows at once.
  const reader = createWorkflowReader();
  assert.equal((await reader.read(empty)).defined, false);
  assert.equal((await reader.read(empty, undefined, { template: 'common', locale: 'ko' })).builtin.id, 'common');
  assert.equal((await reader.read(empty, undefined, { template: 'common', locale: 'en' })).definition.name, 'General — built-in');
  assert.equal((await reader.read(empty)).defined, false, 'stopped: back to none');
});

test('REQ-125 through the RPCs: pick, read, stop — only the plugin\'s file changes, the workspace folder\'s bytes are the same', async t => {
  const { store, cwd, root } = await fixture(t);
  await fs.writeFile(join(cwd, 'notes.md'), '# a made-up workspace\n');
  const workspaceBefore = await snapshot(cwd), dataBefore = await snapshot(store.dataDir);
  const handlers = createReadHandlers(store);
  const view = async () => overviewGet.output.parse(await handlers.overview({ includeBoards: true })).data.boardViews[0].summary;
  assert.deepEqual([(await view()).workflow, (await view()).workflowPick], [undefined, undefined], 'no file, no pick: "Try a workflow"');
  const set = workflowPickSet.output.parse(await handlers.workflowPick({ workspaceId: 'wks_example01', template: 'research-poc' }));
  assert.deepEqual(set, { ok: true, data: { template: 'research-poc', changed: true }, committed: false, warnings: [] });
  assert.deepEqual([(await view()).workflow, (await view()).workflowPick], [true, 'research-poc'], 'the lane offers its workflow at once');
  const read = workflowGet.output.parse(await handlers.workflow({ workspaceId: 'wks_example01' }));
  assert.equal(read.ok && read.data.builtin.id, 'research-poc');
  assert.equal(read.data.definition.name, (await readLocale(store)) === 'ko' ? '연구·조사 — 기본 틀' : 'Research — built-in', 'the board\'s language');
  const changed = workflowPickSet.output.parse(await handlers.workflowPick({ workspaceId: 'wks_example01', template: 'sales-b2b' }));
  assert.equal(changed.ok && changed.data.changed, true);
  assert.equal(workflowGet.output.parse(await handlers.workflow({ workspaceId: 'wks_example01' })).data.builtin.id, 'sales-b2b', 'Change shows at once');
  const stop = workflowPickSet.output.parse(await handlers.workflowPick({ workspaceId: 'wks_example01', template: null }));
  assert.equal(stop.ok && stop.data.changed, true);
  assert.equal(workflowGet.output.parse(await handlers.workflow({ workspaceId: 'wks_example01' })).data.defined, false, 'stopped: "Try" again');
  assert.deepEqual([(await view()).workflow, (await view()).workflowPick], [undefined, undefined]);
  assert.deepEqual(await snapshot(cwd), workspaceBefore, 'the workspace folder: no file made, none changed');
  const dataAfter = (await snapshot(store.dataDir)).filter(([p]) => !p.endsWith(PICKS_FILE) && !p.endsWith(PICKS_BACKUP));
  assert.deepEqual(dataAfter, dataBefore, 'the data folder: only workflow-picks.json and its backup are new — the ledger untouched');
  assert.deepEqual(JSON.parse(await fs.readFile(join(store.dataDir, PICKS_FILE), 'utf8')), { schemaVersion: 1, picks: {} }, 'stop leaves no entry');
  // The screen names a workspace, never a folder; an unknown built-in is refused before anything is written.
  assert.throws(() => workflowPickSet.input.parse({ workspaceId: 'wks_example01', template: 'design', cwd: '/elsewhere' }));
  const bad = workflowPickSet.output.parse(await handlers.workflowPick({ workspaceId: 'wks_example01', template: 'made-up' }));
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'E_VALIDATION');
  const nobody = workflowPickSet.output.parse(await handlers.workflowPick({ workspaceId: 'wks_nobody01', template: 'design' }));
  assert.equal(nobody.ok, false); assert.equal(nobody.error.code, 'E_NOT_FOUND');
  // A definition file wins over a pick: the lane shows the file and the pick rests.
  await handlers.workflowPick({ workspaceId: 'wks_example01', template: 'design' });
  await writeWorkspace(cwd, gateDefinition, {});
  const fresh = createReadHandlers(store);
  const summary = overviewGet.output.parse(await fresh.overview({ includeBoards: true })).data.boardViews[0].summary;
  assert.deepEqual([summary.workflow, summary.workflowPick], [true, undefined]);
  const wins = workflowGet.output.parse(await fresh.workflow({ workspaceId: 'wks_example01' }));
  assert.deepEqual([wins.data.definition.name, wins.data.restingPick, wins.data.builtin], [gateDefinition.name, 'design', undefined]);
  // A damaged picks file: the lane offers "Try" as with none, a pick fails with E_CORRUPT and the bytes stay.
  await fs.rm(join(cwd, '.kanban'), { recursive: true });
  await fs.writeFile(join(store.dataDir, PICKS_FILE), '{ damaged');
  const damaged = createReadHandlers(store);
  const s2 = overviewGet.output.parse(await damaged.overview({ includeBoards: true })).data.boardViews[0].summary;
  assert.deepEqual([s2.workflow, s2.workflowPick], [undefined, undefined]);
  assert.equal(workflowGet.output.parse(await damaged.workflow({ workspaceId: 'wks_example01' })).data.defined, false);
  const refused = workflowPickSet.output.parse(await damaged.workflowPick({ workspaceId: 'wks_example01', template: 'design' }));
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'E_CORRUPT');
  assert.equal(await fs.readFile(join(store.dataDir, PICKS_FILE), 'utf8'), '{ damaged');
  assert.ok(root);
});

test('REQ-125 the lane turns at once: a pick saved here overrides the summary until the next reading says the same', () => {
  assert.equal(laneOffer({}, undefined), 'try');
  assert.equal(laneOffer({ workflow: true }, undefined), 'workflow');
  assert.equal(laneOffer({ workflow: true, workflowPick: 'design' }, undefined), 'workflow');
  assert.equal(laneOffer({}, 'design'), 'workflow', 'just picked');
  assert.equal(laneOffer({ workflow: true, workflowPick: 'design' }, null), 'try', 'just stopped');
  assert.equal(laneOffer({ workflow: true }, null), 'workflow', 'a file stays after a resting pick is cleared');
  const overrides = { b1: 'design', b2: null, b3: 'common' };
  const settled = settlePicks(overrides, [{ id: 'b1', workflowPick: 'design' }, { id: 'b2' }, { id: 'b3' }]);
  assert.deepEqual(settled, { b3: 'common' });
  assert.equal(settlePicks(settled, [{ id: 'b3' }]), settled, 'nothing settled: the same object (no render loop)');
});

test('REQ-125 the copy: ko/en for every new word, no Hangul in English, the wiring of the wide heading and the phone\'s ⋯', async () => {
  for (const locale of ['ko', 'en']) {
    const m = copy(locale);
    for (const key of ['workflowTry', 'workflowPickHint', 'workflowPickNow', 'workflowKeptInKanban', 'workflowChange', 'workflowStop', 'workflowBuiltinEmpty',
      'workflowClearPick', 'workflowPickFailed', 'workflowPickDamaged']) assert.ok(m[key], locale + ' ' + key);
    assert.deepEqual(Object.keys(m.workflowGrade).sort(), ['adapted', 'reference', 'verified']);
    assert.ok(m.workflowTrying('X').includes('X') && m.workflowResting('X').includes('X') && m.workflowTryFor('w').endsWith('w'));
  }
  const en = copy('en');
  assert.ok(!HANGUL.test([en.workflowTry, en.workflowPickHint, en.workflowKeptInKanban, en.workflowBuiltinEmpty, en.workflowTrying('Design'), ...Object.values(en.workflowGrade)].join(' ')));
  assert.equal(copy('ko').workflowStop, '그만 쓰기');
  const lane = await fs.readFile(new URL('../client/swimlane.tsx', import.meta.url), 'utf8');
  assert.match(lane, /\{offer === 'try' && <TryWorkflowButton/, 'the wide heading: "Try" where "Board | Workflow" would be');
  const phone = await fs.readFile(new URL('../client/mobile-swimlane.tsx', import.meta.url), 'utf8');
  assert.match(phone, /onTryWorkflow=\{!preview && !offersWorkflow\(lane\.board\) \?/, 'the phone\'s ⋯: "Try" with no workflow');
  const menu = await fs.readFile(new URL('../client/order-menu.tsx', import.meta.url), 'utf8');
  assert.match(menu, /testID="order-workflow-try"/);
  // The reading module still writes nothing; the picks module is the only writer and writes in the data folder only.
  const picks = await fs.readFile(new URL('../dist/server/workflow-picks.js', import.meta.url), 'utf8');
  assert.ok(!/child_process|spawn|execFile/.test(picks));
  assert.match(picks, /path\.join\(dataDir, /);
});

test('REQ-125 285-F1 a save that reading would refuse (over the byte limit, an empty key) is refused and touches neither file', async t => {
  const { root } = await fixture(t);
  const data = join(root, 'limit-data'), at = '2026-10-04T01:00:00.000Z';
  const long = i => '/' + String(i).padStart(5, '0') + 'x'.repeat(4000);
  const picks = {};
  for (let i = 0; JSON.stringify({ schemaVersion: 1, picks: { ...picks, [long(i)]: { template: 'design', at } } }, null, 2).length + 4200 < PICKS_BYTES; i++) picks[long(i)] = { template: 'design', at };
  await fs.mkdir(data);
  const seed = JSON.stringify({ schemaVersion: 1, picks }, null, 2) + '\n';
  await fs.writeFile(join(data, PICKS_FILE), seed); await fs.writeFile(join(data, PICKS_BACKUP), seed);
  const count = Object.keys(picks).length;
  assert.ok(Buffer.byteLength(seed) < PICKS_BYTES && Buffer.byteLength(seed) > PICKS_BYTES - 9000, 'just under the limit');
  assert.equal((await readPicks(data)).damaged, undefined);
  // Entries still fit while the result stays under the limit; the one that would pass it is refused.
  let refused = null;
  for (let i = 0; i < 5 && !refused; i++) await setPick(data, '/' + 'y'.repeat(4000) + i, 'common').catch(e => { refused = e; });
  assert.equal(refused?.code, 'E_LIMIT', 'one more past the limit');
  const state = await readPicks(data);
  assert.equal(state.damaged, undefined, 'the file stays readable');
  assert.ok(Object.keys(state.picks).length >= count, 'the earlier picks are all still shown');
  assert.equal(await fs.readFile(join(data, PICKS_FILE), 'utf8'), await fs.readFile(join(data, PICKS_BACKUP), 'utf8'));
  assert.ok(Buffer.byteLength(await fs.readFile(join(data, PICKS_FILE), 'utf8')) <= PICKS_BYTES);
  assert.ok((await fs.readdir(data)).every(n => !n.includes('.tmp-')), 'no temporary file left');
  const frozen = await snapshot(data);
  await assert.rejects(setPick(data, '/' + 'v'.repeat(4000), 'design'), e => e.code === 'E_LIMIT');
  assert.deepEqual(await snapshot(data), frozen, 'a refused save leaves the file and its backup as they were');
  assert.equal((await readPicks(data)).damaged, undefined, 'still readable after the refusal');
  // An empty key (the folder "/") is refused, the file unchanged, and a stop of a real folder still works.
  const rootData = join(root, 'root-data');
  await setPick(rootData, '/srv/example/shop', 'design', () => at);
  const kept = await snapshot(rootData);
  for (const cwd of ['/', '//']) await assert.rejects(setPick(rootData, cwd, 'design'), e => e.code === 'E_VALIDATION', cwd);
  assert.deepEqual(await snapshot(rootData), kept, 'files unchanged');
  assert.equal(pickFor(await readPicks(rootData), '/srv/example/shop'), 'design');
  assert.deepEqual(await setPick(rootData, '/', null), { template: null, changed: false }, 'a stop of the root is a plain no-op');
  assert.deepEqual(await setPick(rootData, '/srv/example/shop', null), { template: null, changed: true });
  assert.equal(copy('en').workflowPickFull, 'No more choices can be saved.');
  assert.equal(copy('ko').workflowPickFull, '선택을 더 저장할 수 없습니다.');
  assert.equal(copy('ko').workflowPickFolder, '이 폴더는 고를 수 없습니다.');
});
