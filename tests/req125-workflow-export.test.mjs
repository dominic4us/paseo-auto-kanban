// REQ-125 2단계 (research/288): "Export to the project folder" writes the built-in a workspace is trying as its
// `.kanban/workflow.json` — on the owner's press only (server/workflow.ts `exportDefinition`, server/handlers.ts
// `workflowExport`). Never over anything there, never outside the folder (the reading's `confine`), a temporary file
// linked into place and never left behind; the file then wins at once (the 60 s cache is dropped) and the pick is taken
// out. The screens are in tests/web/run.mjs (=req125, `export` scenes). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { BUILTIN_WORKFLOWS, builtinDefinition, builtinWorkflow } from '../dist/shared/workflow-templates.js';
import { WORKFLOW_DEFINITION_PATH, workflowDefinitionSchema } from '../dist/shared/workflow.js';
import { PICKS_BACKUP, PICKS_FILE, readPicks } from '../dist/server/workflow-picks.js';
import { readWorkflow, createWorkflowReader } from '../dist/server/workflow.js';
import { exportDefinition } from '../dist/server/workflow-export.js';
import { createReadHandlers, exportedDefinition, readLocale } from '../dist/server/handlers.js';
import { overviewGet, workflowExport, workflowGet, workflowPickSet } from '../dist/shared/rpc.js';
import { EXPORTED_PICK, laneOffer, settlePicks } from '../dist/client/workflow-model.js';
import { copy } from '../dist/client/i18n.js';
import { gateDefinition, writeWorkspace } from './fixtures/workflow-fixtures.mjs';
import { fixture } from './helpers.mjs';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
async function snapshot(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) out.push([p, 'link:' + await fs.readlink(p)]);
      else if (e.isDirectory()) { out.push([p, 'dir']); await walk(p); }
      else out.push([p, createHash('sha256').update(await fs.readFile(p)).digest('hex')]);
    }
  }
  await walk(dir);
  return out.sort((a, b) => a[0] < b[0] ? -1 : 1);
}
const leftovers = async dir => (await fs.readdir(dir).catch(() => [])).filter(n => n.includes('.tmp-'));
const refusal = async (promise, code) => {
  await assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
};

test('REQ-125 export: writes the built-in as .kanban/workflow.json (folder made when missing), ko and en, no temporary file left', async t => {
  const { cwd, root } = await fixture(t);
  for (const [i, t8] of BUILTIN_WORKFLOWS.entries()) for (const locale of ['ko', 'en']) {
    const folder = join(root, `ws-${t8.id}-${locale}`);
    await fs.mkdir(folder);
    if (i % 2) { await fs.mkdir(join(folder, '.kanban')); await fs.writeFile(join(folder, '.kanban', 'notes.md'), 'kept\n'); }
    const def = builtinDefinition(t8, locale);
    assert.deepEqual(await exportDefinition(folder, def), { path: WORKFLOW_DEFINITION_PATH });
    const text = await fs.readFile(join(folder, WORKFLOW_DEFINITION_PATH), 'utf8');
    assert.equal(text, JSON.stringify(def, null, 2) + '\n', 'the bytes are the definition, pretty and ending in a newline');
    assert.ok(workflowDefinitionSchema.safeParse(JSON.parse(text)).success);
    if (locale === 'en') assert.ok(!HANGUL.test(text), t8.id + ': no Hangul in the English file');
    assert.ok((await fs.stat(join(folder, WORKFLOW_DEFINITION_PATH))).isFile());
    assert.deepEqual(await leftovers(join(folder, '.kanban')), [], 'no temporary file left');
    if (i % 2) assert.equal(await fs.readFile(join(folder, '.kanban', 'notes.md'), 'utf8'), 'kept\n', 'a .kanban folder already there is kept');
    // The reading now takes the file, with no pick: its name, no built-in mark.
    const read = await readWorkflow(folder, { pick: { template: t8.id, locale } });
    assert.equal(read.defined, true);
    assert.deepEqual([read.definition.name, read.builtin, read.restingPick], [def.name, undefined, t8.id]);
  }
  // Only the folder named: the workspace beside it is untouched.
  assert.deepEqual(await snapshot(cwd), []);
});

test('REQ-125 export: never over anything there — a file, a folder, a link — and the bytes stay', async t => {
  const { root } = await fixture(t);
  const def = builtinDefinition(builtinWorkflow('design'), 'ko');
  const cases = {
    file: async f => { await fs.mkdir(join(f, '.kanban')); await fs.writeFile(join(f, WORKFLOW_DEFINITION_PATH), '{"mine":true}'); },
    broken: async f => { await fs.mkdir(join(f, '.kanban')); await fs.writeFile(join(f, WORKFLOW_DEFINITION_PATH), 'not json'); },
    folder: async f => { await fs.mkdir(join(f, WORKFLOW_DEFINITION_PATH), { recursive: true }); },
    dangling: async f => { await fs.mkdir(join(f, '.kanban')); await fs.symlink(join(f, 'nowhere.json'), join(f, WORKFLOW_DEFINITION_PATH)); },
    link: async f => { await fs.mkdir(join(f, '.kanban')); await fs.writeFile(join(f, 'other.json'), 'x'); await fs.symlink(join(f, 'other.json'), join(f, WORKFLOW_DEFINITION_PATH)); },
  };
  for (const [name, make] of Object.entries(cases)) {
    const folder = join(root, 'ws-' + name);
    await fs.mkdir(folder); await make(folder);
    const before = await snapshot(folder);
    await refusal(exportDefinition(folder, def), 'E_EXISTS');
    assert.deepEqual(await snapshot(folder), before, name + ': nothing changed, no temporary file');
  }
});

test('REQ-125 export: the reading\'s boundary — .kanban leading outside, a dangling .kanban, a .kanban file, no folder — refused, nothing written', async t => {
  const { root } = await fixture(t);
  const def = builtinDefinition(builtinWorkflow('common'), 'en');
  const outside = join(root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(join(outside, 'keep.txt'), 'outside\n');
  const outsideBefore = await snapshot(outside);
  const cases = {
    'link out': [async f => fs.symlink(outside, join(f, '.kanban')), 'E_OUTSIDE'],
    'link up': [async f => fs.symlink('..', join(f, '.kanban')), 'E_OUTSIDE'],
    dangling: [async f => fs.symlink(join(root, 'gone'), join(f, '.kanban')), 'E_OUTSIDE'],
    'a file': [async f => fs.writeFile(join(f, '.kanban'), 'x'), 'E_IO'],
  };
  for (const [name, [make, code]] of Object.entries(cases)) {
    const folder = join(root, 'ws-' + name.replace(' ', '-'));
    await fs.mkdir(folder); await make(folder);
    const before = await snapshot(folder);
    await refusal(exportDefinition(folder, def), code);
    assert.deepEqual(await snapshot(folder), before, name + ': the folder is as it was');
  }
  assert.deepEqual(await snapshot(outside), outsideBefore, 'nothing written outside the workspace');
  await assert.rejects(fs.stat(join(root, 'gone')), 'a dangling .kanban is not made real');
  // A folder that is not there, or not absolute, is not a place to write.
  await refusal(exportDefinition(join(root, 'missing'), def), 'E_NOT_FOUND');
  await refusal(exportDefinition('relative/ws', def), 'E_NOT_FOUND');
  await refusal(exportDefinition('', def), 'E_NOT_FOUND');
  await assert.rejects(fs.stat(join(root, 'missing')));
  // A workspace folder reached through a link is written in its real place, inside.
  const real = join(root, 'real-ws');
  await fs.mkdir(real); await fs.symlink(real, join(root, 'alias-ws'));
  await exportDefinition(join(root, 'alias-ws'), def);
  assert.ok((await fs.lstat(join(real, WORKFLOW_DEFINITION_PATH))).isFile());
  // A definition that would not pass the format is refused before anything is made.
  const bare = join(root, 'ws-bad');
  await fs.mkdir(bare);
  await refusal(exportDefinition(bare, { ...def, stages: [] }), 'E_VALIDATION');
  assert.deepEqual(await snapshot(bare), []);
});

test('REQ-125 export through the RPC: the pick is written, wins at once over the cache, the pick is taken out; refusals keep both', async t => {
  const { store, cwd } = await fixture(t);
  await fs.writeFile(join(cwd, 'notes.md'), '# a made-up workspace\n');
  const ledgerBefore = (await snapshot(store.dataDir)).filter(([p]) => !p.includes('workflow-picks'));
  const handlers = createReadHandlers(store);
  const id = 'wks_example01';
  const summary = async () => overviewGet.output.parse(await handlers.overview({ includeBoards: true })).data.boardViews[0].summary;
  const read = async () => workflowGet.output.parse(await handlers.workflow({ workspaceId: id })).data;
  const exp = async template => workflowExport.output.parse(await handlers.workflowExport({ workspaceId: id, template }));
  // With no pick there is nothing to export.
  const none = await exp('design');
  assert.equal(none.ok, false); assert.equal(none.error.code, 'E_CONFLICT');
  assert.deepEqual(await snapshot(cwd), [[join(cwd, 'notes.md'), createHash('sha256').update('# a made-up workspace\n').digest('hex')]]);
  await handlers.workflowPick({ workspaceId: id, template: 'design' });
  // Warm both caches (the lane's check, the reading) so the export must drop them.
  assert.deepEqual([(await summary()).workflow, (await summary()).workflowPick], [true, 'design']);
  assert.equal((await read()).builtin.id, 'design');
  // Another built-in than the pick (a stale screen): refused, nothing written.
  const stale = await exp('common');
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'E_CONFLICT');
  await assert.rejects(fs.stat(join(cwd, '.kanban')));
  const done = await exp('design');
  assert.deepEqual(done, { ok: true, data: { path: WORKFLOW_DEFINITION_PATH, template: 'design', pickCleared: true }, committed: false, warnings: [] });
  const written = JSON.parse(await fs.readFile(join(cwd, WORKFLOW_DEFINITION_PATH), 'utf8'));
  const first = await readLocale(store), other = first === 'ko' ? 'en' : 'ko';
  assert.deepEqual(written, exportedDefinition(builtinWorkflow('design'), first), 'in the board\'s language');
  // 293-J2: the project's own file now — named without the "built-in" tail, the steps and lines the built-in's.
  assert.equal(written.name, builtinWorkflow('design').name[first]);
  assert.deepEqual([written.stages, written.edges], [builtinDefinition(builtinWorkflow('design'), first).stages, builtinDefinition(builtinWorkflow('design'), first).edges]);
  // At once (not after 60 s): the lane says "a file, no pick", the reading is the file's, no resting pick.
  assert.deepEqual([(await summary()).workflow, (await summary()).workflowPick], [true, undefined]);
  const after = await read();
  assert.deepEqual([after.defined, after.builtin, after.restingPick, after.definitionPath], [true, undefined, undefined, WORKFLOW_DEFINITION_PATH]);
  assert.deepEqual((await readPicks(store.dataDir)).picks, {}, 'the pick is taken out');
  assert.deepEqual(await leftovers(join(cwd, '.kanban')), []);
  // Exporting again: no pick now → refused, the file as it was.
  const bytes = await fs.readFile(join(cwd, WORKFLOW_DEFINITION_PATH), 'utf8');
  const again = await exp('design');
  assert.equal(again.ok, false); assert.equal(again.error.code, 'E_CONFLICT');
  // A pick resting under a file someone made meanwhile: export is refused (E_EXISTS), the file and the pick both stay.
  await fs.writeFile(join(cwd, WORKFLOW_DEFINITION_PATH), JSON.stringify(gateDefinition));
  await handlers.workflowPick({ workspaceId: id, template: 'common' });
  const exists = await exp('common');
  assert.equal(exists.ok, false); assert.equal(exists.error.code, 'E_EXISTS');
  assert.deepEqual(JSON.parse(await fs.readFile(join(cwd, WORKFLOW_DEFINITION_PATH), 'utf8')), gateDefinition, 'never written over');
  assert.equal((await readPicks(store.dataDir)).picks[cwd]?.template ?? Object.values((await readPicks(store.dataDir)).picks)[0]?.template, 'common', 'the pick stays');
  assert.equal((await read()).definition.name, gateDefinition.name, 'the file there is read at once');
  assert.ok(bytes.length > 0);
  // The board in the other language: the file is written in it.
  await fs.rm(join(cwd, '.kanban'), { recursive: true });
  await fs.writeFile(join(store.dataDir, 'config.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(join(store.dataDir, 'config.json'), 'utf8').catch(() => '{}')), locale: other }));
  const en = await exp('common');
  assert.equal(en.ok, true, JSON.stringify(en));
  const enText = await fs.readFile(join(cwd, WORKFLOW_DEFINITION_PATH), 'utf8');
  assert.equal(await readLocale(store), other);
  assert.deepEqual(JSON.parse(enText), exportedDefinition(builtinWorkflow('common'), other));
  assert.equal(HANGUL.test(enText), other === 'ko');
  // The screen names a workspace and a built-in, never a folder; an unknown workspace is not found.
  assert.throws(() => workflowExport.input.parse({ workspaceId: id, template: 'design', cwd: '/elsewhere' }));
  assert.throws(() => workflowExport.input.parse({ workspaceId: id, template: '../x' }));
  const nobody = workflowExport.output.parse(await handlers.workflowExport({ workspaceId: 'wks_nobody01', template: 'design' }));
  assert.equal(nobody.ok, false); assert.equal(nobody.error.code, 'E_NOT_FOUND');
  // The ledger and the rest of the data folder: untouched (config.json changed by this test only).
  const ledgerAfter = (await snapshot(store.dataDir)).filter(([p]) => !p.includes('workflow-picks') && !p.endsWith('config.json'));
  assert.deepEqual(ledgerAfter, ledgerBefore.filter(([p]) => !p.endsWith('config.json')));
  assert.ok([PICKS_FILE, PICKS_BACKUP].every(n => n.startsWith('workflow-picks')));
});

test('REQ-125 export: a pick that cannot be taken out leaves the file written (pickCleared: false); a damaged picks file exports nothing', async t => {
  const { store, cwd } = await fixture(t);
  const handlers = createReadHandlers(store);
  await handlers.workflowPick({ workspaceId: 'wks_example01', template: 'gov-grant' });
  // The picks file damaged after the screen showed the pick: no pick can be read → refused, nothing written.
  const good = await fs.readFile(join(store.dataDir, PICKS_FILE), 'utf8');
  await fs.writeFile(join(store.dataDir, PICKS_FILE), '{ damaged');
  const refused = workflowExport.output.parse(await handlers.workflowExport({ workspaceId: 'wks_example01', template: 'gov-grant' }));
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'E_CONFLICT');
  await assert.rejects(fs.stat(join(cwd, '.kanban')));
  assert.equal(await fs.readFile(join(store.dataDir, PICKS_FILE), 'utf8'), '{ damaged');
  await fs.writeFile(join(store.dataDir, PICKS_FILE), good);
  // The data folder read-only for the take-out: the file is still written and the reply says the pick stayed.
  if (process.getuid?.() === 0) return; // root writes through a read-only mode
  await fs.chmod(store.dataDir, 0o500);
  t.after(() => fs.chmod(store.dataDir, 0o700).catch(() => undefined));
  const kept = workflowExport.output.parse(await handlers.workflowExport({ workspaceId: 'wks_example01', template: 'gov-grant' }));
  await fs.chmod(store.dataDir, 0o700);
  assert.deepEqual(kept.ok && kept.data, { path: WORKFLOW_DEFINITION_PATH, template: 'gov-grant', pickCleared: false });
  assert.ok((await fs.stat(join(cwd, WORKFLOW_DEFINITION_PATH))).isFile());
  const view = workflowGet.output.parse(await handlers.workflow({ workspaceId: 'wks_example01' })).data;
  assert.deepEqual([view.builtin, view.restingPick], [undefined, 'gov-grant'], 'the file wins; the pick rests with "Clear the pick"');
});

test('REQ-125 export: the reader forgets one folder only; the lane keeps its workflow while the summary catches up', async () => {
  let reads = 0;
  const reader = createWorkflowReader({ now: () => 0, read: async cwd => { reads++; return { defined: false, reason: 'missing', definitionPath: cwd }; } });
  await reader.read('/a'); await reader.read('/a', 5); await reader.read('/b');
  assert.equal(reads, 3);
  await reader.read('/a'); await reader.read('/b');
  assert.equal(reads, 3, 'cached');
  reader.forget('/a');
  await reader.read('/a'); await reader.read('/a', 5); await reader.read('/b'); await reader.read('/ab');
  assert.equal(reads, 6, '/a read again (both windows), /b still cached, /ab a folder of its own');
  // The lane: an export keeps it on its workflow, settled once the summary says "a file, no pick".
  assert.equal(EXPORTED_PICK, '');
  assert.equal(laneOffer({ workflow: true, workflowPick: 'design' }, EXPORTED_PICK), 'workflow');
  assert.equal(laneOffer({}, EXPORTED_PICK), 'workflow');
  const o = { b1: EXPORTED_PICK, b2: EXPORTED_PICK, b3: 'design' };
  assert.deepEqual(settlePicks(o, [{ id: 'b1', workflow: true, workflowPick: 'design' }, { id: 'b2', workflow: true }, { id: 'b3', workflow: true, workflowPick: 'design' }]),
    { b1: EXPORTED_PICK });
});

test('REQ-125 export copy: ko/en for every new word, no Hangul in English, the banner\'s wiring', async () => {
  const keys = ['workflowExport', 'workflowExportGo', 'workflowExportConfirm', 'workflowExported', 'workflowExportExists', 'workflowExportOutside',
    'workflowExportConflict', 'workflowExportFailed', 'workflowExportUnsupported', 'workflowExportedPickKept'];
  const ko = copy('ko'), en = copy('en');
  for (const key of keys) {
    assert.ok(typeof ko[key] === 'string' && ko[key] && HANGUL.test(ko[key]), 'ko ' + key);
    assert.ok(typeof en[key] === 'string' && en[key] && !HANGUL.test(en[key]), 'en ' + key);
  }
  assert.equal(ko.workflowExport, '프로젝트 폴더로 내보내기');
  assert.equal(en.workflowExport, 'Export to the project folder');
  for (const m of [ko, en]) {
    assert.ok(m.workflowExportConfirm.includes('.kanban/workflow.json') && /git/i.test(m.workflowExportConfirm), 'the confirming line names the file and git');
    assert.ok(m.workflowExportExists.includes('.kanban/workflow.json'));
  }
  // The v0.1.52 words: "lead", never "orchestrator"; American spelling.
  assert.ok(!/orchestrator|colour|grey/i.test(keys.map(k => en[k]).join(' ')));
  const banner = await fs.readFile(new URL('../client/workflow-pick.tsx', import.meta.url), 'utf8');
  for (const id of ['workflow-export', 'workflow-export-confirm', 'workflow-export-go', 'workflow-export-cancel', 'workflow-export-error'])
    assert.ok(banner.includes(id), id);
  assert.match(banner, /code === 'E_EXISTS' \? m\.workflowExportExists/);
  assert.match(banner, /code === 'E_UNSUPPORTED' \? m\.workflowExportUnsupported/);
  for (const file of ['../client/workflow.tsx', '../client/mobile-workflow.tsx']) {
    const text = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /onExported=/, file); assert.match(text, /testID="workflow-exported"/, file);
  }
});

// ---- 293 후속 (research/293 F1·F2·J2·J3): the publish step under a race, a file system with no hard links, other hosts ----
/** Runs `body` with `node:fs/promises` functions replaced for the writer (the ESM view kept in step), then puts them back. */
async function withFs(hooks, body) {
  const fsp = createRequire(import.meta.url)('node:fs/promises'), saved = {};
  for (const [name, make] of Object.entries(hooks)) { saved[name] = fsp[name]; fsp[name] = make(saved[name]); }
  syncBuiltinESMExports();
  try { return await body(); } finally { Object.assign(fsp, saved); syncBuiltinESMExports(); }
}
const def293 = builtinDefinition(builtinWorkflow('design'), 'ko');

test('REQ-125 293-F1 the folder moved out of the workspace after the last check, right before the link: refused, nothing left outside', async t => {
  const { root } = await fixture(t);
  const cases = {
    // The gate's case: .kanban moved to a sibling outside, a link to it left in its place.
    'moved, link left': async (folder, out) => { await fs.rename(join(folder, '.kanban'), out); await fs.symlink(out, join(folder, '.kanban')); },
    // Moved out and a plain new folder made in its place.
    'moved, new folder': async (folder, out) => { await fs.rename(join(folder, '.kanban'), out); await fs.mkdir(join(folder, '.kanban')); },
  };
  for (const [name, swap] of Object.entries(cases)) for (const at of ['link', 'writeFile']) {
    const folder = join(root, 'ws-' + name.replace(/\W+/g, '-') + '-' + at), out = join(root, 'out-' + name.replace(/\W+/g, '-') + '-' + at);
    await fs.mkdir(join(folder, '.kanban'), { recursive: true });
    let swapped = 0;
    await withFs({ [at]: original => async (...args) => {
      if (at === 'writeFile') { const r = await original(...args); if (String(args[0]).includes('.tmp-') && !swapped++) await swap(folder, out); return r; }
      if (!swapped++) await swap(folder, out);
      return original(...args);
    } }, () => refusal(exportDefinition(folder, def293), 'E_OUTSIDE'));
    assert.equal(swapped, 1, name + ' ' + at + ': the swap happened');
    assert.deepEqual(await fs.readdir(out), [], name + ' ' + at + ': nothing written outside, no temporary file');
    assert.ok(!(await fs.readdir(folder)).includes('workflow.json'));
    if (name === 'moved, new folder') assert.deepEqual(await fs.readdir(join(folder, '.kanban')), [], 'the new folder is untouched');
  }
  // A file someone else put in the moved folder is never taken out: only our own link (the same inode) is.
  const folder = join(root, 'ws-theirs'), out = join(root, 'out-theirs');
  await fs.mkdir(join(folder, '.kanban'), { recursive: true });
  await withFs({ link: original => async (a, b) => {
    await fs.rename(join(folder, '.kanban'), out); await fs.writeFile(join(out, 'workflow.json'), 'theirs'); return original(a, b);
  } }, () => refusal(exportDefinition(folder, def293), 'E_EXISTS'));
  assert.equal(await fs.readFile(join(out, 'workflow.json'), 'utf8'), 'theirs');
  assert.deepEqual(await fs.readdir(out), ['workflow.json'], 'no temporary file');
});

test('REQ-125 293-F2 a file system that refuses hard links: refused (E_UNSUPPORTED), never renamed over a file that arrived', async t => {
  const { root } = await fixture(t);
  let renames = 0;
  for (const code of ['ENOTSUP', 'EPERM', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']) for (const arrives of [true, false]) {
    const folder = join(root, 'ws-' + code + '-' + arrives);
    await fs.mkdir(join(folder, '.kanban'), { recursive: true });
    await withFs({
      link: () => async (a, b) => {
        if (arrives) await fs.writeFile(b, 'valuable existing content', { flag: 'wx' });
        throw Object.assign(new Error('synthetic: no hard links'), { code });
      },
      rename: original => async (...args) => { renames++; return original(...args); },
    }, () => refusal(exportDefinition(folder, def293), 'E_UNSUPPORTED'));
    assert.deepEqual(await fs.readdir(join(folder, '.kanban')), arrives ? ['workflow.json'] : [], code + ': no temporary file, no file of ours');
    if (arrives) assert.equal(await fs.readFile(join(folder, WORKFLOW_DEFINITION_PATH), 'utf8'), 'valuable existing content', code + ': never written over');
  }
  assert.equal(renames, 0, 'no rename at all');
  const source = await fs.readFile(new URL('../dist/server/workflow-export.js', import.meta.url), 'utf8');
  // 295: the one rename moves what is at workflow.json aside to an unguessable name (taking back), never a publish.
  assert.ok(!/copyFile/.test(source) && [...source.matchAll(/\.rename\(([^)]*)\)/g)].every(m => m[1] === 'published, asidePath'), 'the writer has no replacing publish');
});

test('REQ-125 293 a host that is not Linux (no folder handle to write through): refused before anything is made', async t => {
  const { root } = await fixture(t);
  const folder = join(root, 'ws-darwin');
  await fs.mkdir(folder);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  try { await refusal(exportDefinition(folder, def293), 'E_UNSUPPORTED'); }
  finally { Object.defineProperty(process, 'platform', platform); }
  assert.deepEqual(await fs.readdir(folder), [], 'not even .kanban');
  // Back on Linux the same folder exports.
  await exportDefinition(folder, def293);
  assert.ok((await fs.lstat(join(folder, WORKFLOW_DEFINITION_PATH))).isFile());
});

test('REQ-125 293-J2 the exported file: no "built-in" tail in any of the eight, ko and en; the note says where it came from', () => {
  for (const t8 of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) {
    const def = exportedDefinition(t8, locale), base = builtinDefinition(t8, locale);
    assert.ok(workflowDefinitionSchema.safeParse(def).success);
    assert.equal(def.name, t8.name[locale]);
    assert.ok(!/기본 틀$|built-in$/.test(def.name));
    assert.ok(def.note.includes(t8.id + ' v' + t8.version) && def.note.includes(t8.name[locale]));
    assert.deepEqual({ ...def, name: base.name, note: base.note }, base, 'everything else as the built-in');
    if (locale === 'en') assert.ok(!HANGUL.test(JSON.stringify(def)));
  }
});

// ---- 295 후속 (research/295 F3·F4): taking back never removes another's file by the public name; what stays is said ----
/** A folder whose `.kanban` is moved to `out` (outside) by the first hard link, right before it is made. */
async function movedOnLink(root, name) {
  const folder = join(root, 'ws-' + name), out = join(root, 'out-' + name);
  await fs.mkdir(join(folder, '.kanban'), { recursive: true });
  let done = false;
  const link = original => async (a, b) => { if (!done) { done = true; await fs.rename(join(folder, '.kanban'), out); } return original(a, b); };
  return { folder, out, link };
}
const unlinkedNames = [];
const spyUnlink = original => async p => { unlinkedNames.push(String(p).split('/').pop()); return original(p); };
const leftOf = async promise => { try { await promise; return { code: 'SUCCESS' }; } catch (e) { return { code: e.code, message: e.message, left: e.details?.left }; } };

test('REQ-125 295-F3 another file put at workflow.json at the last moment is kept — at its name, or aside and said; never removed', async t => {
  const { root } = await fixture(t);
  unlinkedNames.length = 0;
  // ① Right before the take-back's first step (the moment 295 raced the old unlink): restored to workflow.json.
  {
    const { folder, out, link } = await movedOnLink(root, 'race-rename');
    await fs.writeFile(join(folder, '.kanban', 'valuable.txt'), 'valuable existing content');
    let raced = 0;
    const r = await withFs({ link, unlink: spyUnlink, rename: original => async (a, b) => {
      if (String(a).endsWith('/workflow.json') && !raced++) await original(join(out, 'valuable.txt'), join(out, 'workflow.json'));
      return original(a, b);
    } }, () => leftOf(exportDefinition(folder, def293)));
    assert.equal(raced, 1);
    assert.deepEqual([r.code, r.left], ['E_OUTSIDE', []], JSON.stringify(r));
    assert.equal(await fs.readFile(join(out, 'workflow.json'), 'utf8'), 'valuable existing content', 'their bytes, at their name');
    assert.deepEqual((await fs.readdir(out)).sort(), ['workflow.json'], 'no aside name, no temporary file, ours gone');
  }
  // ② Their file there before the take-back (295 foreign-before-lstat, its link hook made one-shot): restored too.
  {
    const { folder, out, link } = await movedOnLink(root, 'before');
    const r = await withFs({ link: original => { const first = link(original); let n = 0;
      return async (a, b) => { if (n++) return original(a, b); await first(a, b); await fs.unlink(join(out, 'workflow.json')); await fs.writeFile(join(out, 'workflow.json'), 'foreign content', { flag: 'wx' }); }; } },
    () => leftOf(exportDefinition(folder, def293)));
    assert.deepEqual([r.code, r.left], ['E_OUTSIDE', []], JSON.stringify(r));
    assert.equal(await fs.readFile(join(out, 'workflow.json'), 'utf8'), 'foreign content');
    assert.deepEqual(await fs.readdir(out), ['workflow.json']);
  }
  // ③ It cannot go back (a third file took the name meanwhile): kept aside, said by full path, nothing lost.
  {
    const { folder, out, link } = await movedOnLink(root, 'no-way-back');
    await fs.writeFile(join(folder, '.kanban', 'valuable.txt'), 'valuable existing content');
    let n = 0;
    const r = await withFs({ unlink: spyUnlink, rename: original => async (a, b) => {
      if (String(a).endsWith('/workflow.json')) await original(join(out, 'valuable.txt'), join(out, 'workflow.json'));
      return original(a, b);
    }, link: original => { const first = link(original); return async (a, b) => {
      if (!n++) return first(a, b);
      await fs.writeFile(join(out, 'workflow.json'), 'a third file', { flag: 'wx' }); return original(a, b);
    }; } }, () => leftOf(exportDefinition(folder, def293)));
    const names = (await fs.readdir(out)).sort(), aside = names.find(x => x.startsWith('.workflow.json.out-'));
    assert.equal(r.code, 'E_OUTSIDE');
    assert.deepEqual(r.left, [join(out, aside)], 'the aside name, said in full');
    assert.ok(r.message.includes(join(out, aside)) && !r.message.includes('nothing'), r.message);
    assert.equal(await fs.readFile(join(out, aside), 'utf8'), 'valuable existing content', 'their bytes kept aside');
    assert.equal(await fs.readFile(join(out, 'workflow.json'), 'utf8'), 'a third file');
    assert.deepEqual(names, [aside, 'workflow.json'], 'no temporary file');
  }
  assert.ok(!unlinkedNames.includes('workflow.json'), 'nothing is ever removed by the name workflow.json: ' + unlinkedNames.join());
});

test('REQ-125 295-F4 what cannot be removed is said by full path — a folder made read-only, removals refused, a success\'s temporary file', async t => {
  const { root, store } = await fixture(t);
  // ① The moved folder made read-only right after the link (295 F4-real-permission): both names said, both there.
  {
    const { folder, out, link } = await movedOnLink(root, 'readonly');
    t.after(() => fs.chmod(out, 0o755).catch(() => undefined));
    const r = await withFs({ link: original => { const first = link(original); return async (a, b) => { await first(a, b); await fs.chmod(out, 0o555); }; } },
      () => leftOf(exportDefinition(folder, def293)));
    await fs.chmod(out, 0o755);
    const names = (await fs.readdir(out)).sort();
    assert.equal(r.code, 'E_OUTSIDE');
    assert.deepEqual([...r.left].sort(), names.map(n => join(out, n)).sort(), 'exactly what stayed: ' + names.join());
    assert.equal(names.length, 2);
    assert.ok(r.left.every(p => r.message.includes(p)) && !/nothing was (written|left)/.test(r.message), r.message);
  }
  // ② Removals refused by the host: the aside name and the temporary file said; no file of anyone else touched.
  {
    const { folder, out, link } = await movedOnLink(root, 'unlink-denied');
    const r = await withFs({ link, unlink: () => async () => { throw Object.assign(new Error('synthetic'), { code: 'EACCES' }); } },
      () => leftOf(exportDefinition(folder, def293)));
    const names = (await fs.readdir(out)).sort();
    assert.equal(r.code, 'E_OUTSIDE');
    assert.deepEqual([...r.left].sort(), names.map(n => join(out, n)).sort());
    assert.ok(names.some(n => n.startsWith('.workflow.json.out-')) && names.some(n => n.startsWith('.workflow.json.tmp-')) && !names.includes('workflow.json'));
  }
  // ③ Nothing moved, the temporary file could not be removed: a success that says it (and the RPC carries it).
  {
    const folder = join(root, 'ws-tmp-stays');
    await fs.mkdir(folder);
    const r = await withFs({ unlink: original => async p => { if (String(p).includes('.tmp-')) throw Object.assign(new Error('synthetic'), { code: 'EIO' }); return original(p); } },
      () => exportDefinition(folder, def293));
    const names = await fs.readdir(join(folder, '.kanban'));
    assert.equal(r.path, WORKFLOW_DEFINITION_PATH);
    assert.deepEqual(r.left, names.filter(n => n.includes('.tmp-')).map(n => join(folder, '.kanban', n)));
    assert.ok(names.includes('workflow.json'));
    assert.ok(workflowExport.output.parse({ ok: true, data: { path: r.path, template: 'design', pickCleared: true, left: r.left }, committed: false, warnings: [] }).ok);
  }
  // ④ Through the RPC: a folder moved while writing → E_OUTSIDE with details.left (empty when all was taken back).
  {
    const handlers = createReadHandlers(store), cwd = join(root, 'workspace');
    await handlers.workflowPick({ workspaceId: 'wks_example01', template: 'design' });
    let done = false;
    const reply = await withFs({ link: original => async (a, b) => { if (!done) { done = true; await fs.rename(join(cwd, '.kanban'), join(root, 'out-rpc')); } return original(a, b); } },
      async () => workflowExport.output.parse(await handlers.workflowExport({ workspaceId: 'wks_example01', template: 'design' })));
    assert.equal(reply.ok, false);
    assert.deepEqual([reply.error.code, reply.error.details], ['E_OUTSIDE', { left: [] }]);
    assert.deepEqual(await fs.readdir(join(root, 'out-rpc')), []);
  }
  // The screen's words for both (ko/en): the moved folder, then the files left in full; a success's line too.
  for (const locale of ['ko', 'en']) {
    const m = copy(locale), paths = ['/x/.kanban/a', '/x/.kanban/b'];
    assert.ok(m.workflowExportMoved && m.workflowExportLeft(paths).includes('/x/.kanban/a, /x/.kanban/b'));
    assert.equal(HANGUL.test(m.workflowExportMoved + m.workflowExportLeft(paths)), locale === 'ko');
  }
  const { exportedLine } = await import('../dist/client/workflow-pick.js').catch(() => ({}));
  if (exportedLine) assert.equal(exportedLine(copy('en'), { pickCleared: true, left: ['/p/t'] }), copy('en').workflowExported + ' ' + copy('en').workflowExportLeft(['/p/t']));
  const banner = await fs.readFile(new URL('../client/workflow-pick.tsx', import.meta.url), 'utf8');
  assert.match(banner, /moved \? m\.workflowExportMoved : m\.workflowExportOutside/);
  assert.match(banner, /m\.workflowExportLeft\(left\)/);
});
