// REQ-143 (research/349): the package can be published to npm — public files only, the CLI built into it before packing —
// while a Git install keeps compiling the sources; and three workflow screen fixes from research/347: the built-in banner
// says it reads no documents (X4), the phone's 건 table heading says it reads the record section when there is one (X9),
// and a loop's label on the wide flow sits clear of every step and of the other labels (X10). The screens are exercised in
// tests/web/run.mjs (=req143).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { copy } from '../dist/client/i18n.js';
import { BUILTIN_WORKFLOWS, builtinDefinition } from '../dist/shared/workflow-templates.js';
import { edgeLabelSpot, flowLayout, flowObstacles, loopLabelSpot, route, rowBottom, spotRect } from '../dist/client/workflow-model.js';
import { testTmpdir } from './helpers.mjs';

const run = promisify(execFile);
const read = async file => fs.readFile(new URL('../' + file, import.meta.url), 'utf8');
const root = new URL('..', import.meta.url).pathname;

test('REQ-143 the package is publishable: public files only, the CLI built before packing, no install scripts', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.scripts.prepack, 'node scripts/clean-dist.mjs && npm run build');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[hook], undefined, hook + ': Paseo installs with --ignore-scripts');
  // What Paseo compiles (the entries and the three source folders), the built CLI and core, and the notices.
  for (const entry of ['index.server.ts', 'index.client.tsx', 'paseo-plugin.json', 'client/', 'server/', 'shared/', 'dist/src/', 'dist/server/', 'dist/shared/', 'NOTICE', 'licenses/'])
    assert.ok(pkg.files.includes(entry), entry);
  for (const target of Object.values(pkg.bin)) assert.ok(pkg.files.some(f => f.endsWith('/') && target.startsWith(f)), target);
  assert.ok(pkg.files.some(f => pkg.exports['./core'].import.slice(2).startsWith(f)));
  assert.ok(!pkg.files.some(f => /^(tests|docs|research|plans|spike|raw_sources|_archive|\.)/.test(f)), JSON.stringify(pkg.files));
});

test('REQ-143 npm would pack only the allowed files (no tests, work notes or dot folders)', async () => {
  // --ignore-scripts: the list alone, nothing built or cleaned here (dist may be a link to a build cache in a work checkout).
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const files = JSON.parse(stdout)[0].files.map(f => f.path);
  const allowed = /^(index\.server\.ts|index\.client\.tsx|paseo-plugin\.json|package\.json|README\.md|README\.ko\.md|LICENSE|NOTICE|CHANGELOG\.md|(client|server|shared|assets|licenses|dist\/(src|server|shared|cli))\/.+)$/;
  assert.deepEqual(files.filter(f => !allowed.test(f)), []);
  for (const must of ['index.server.ts', 'index.client.tsx', 'paseo-plugin.json', 'server/version.ts', 'NOTICE', 'licenses/lucide-LICENSE.txt']) assert.ok(files.includes(must), must);
});

test('REQ-143 clean-dist removes dist only when it is a real folder: a file, a link and a broken link stop it untouched', async t => {
  const at = await fs.mkdtemp(join(await testTmpdir(), 'kanban-pack-'));
  t.after(() => fs.rm(at, { recursive: true, force: true }));
  await fs.mkdir(join(at, 'scripts'));
  await fs.copyFile(new URL('../scripts/clean-dist.mjs', import.meta.url), join(at, 'scripts', 'clean-dist.mjs'));
  const clean = () => run(process.execPath, [join(at, 'scripts', 'clean-dist.mjs')]);
  const dist = join(at, 'dist');
  // Absent: nothing to do.
  await clean();
  // A link to a folder (a build cache): refused, the cache and the link kept.
  await fs.mkdir(join(at, 'cache', 'old'), { recursive: true });
  await fs.writeFile(join(at, 'cache', 'old', 'stale.js'), '');
  await fs.symlink(join(at, 'cache'), dist);
  await assert.rejects(clean(), error => error.code === 1 && /symbolic link/.test(error.stderr));
  assert.ok((await fs.stat(join(at, 'cache', 'old', 'stale.js'))).isFile(), 'the linked cache is left alone');
  assert.ok((await fs.lstat(dist)).isSymbolicLink(), 'the link is left alone');
  // A broken link: refused, kept.
  await fs.rm(dist); await fs.symlink(join(at, 'nowhere'), dist);
  await assert.rejects(clean(), error => error.code === 1 && /symbolic link/.test(error.stderr));
  assert.ok((await fs.lstat(dist)).isSymbolicLink());
  // A plain file under that name (gate 351 F2): refused, its content kept.
  await fs.rm(dist); await fs.writeFile(dist, 'not build output\n');
  await assert.rejects(clean(), error => error.code === 1 && /not a folder/.test(error.stderr));
  assert.equal(await fs.readFile(dist, 'utf8'), 'not build output\n');
  // A real folder: removed, links inside it removed without touching what they point at.
  await fs.rm(dist); await fs.mkdir(join(dist, 'old'), { recursive: true });
  await fs.writeFile(join(dist, 'old', 'stale.js'), '');
  await fs.symlink(join(at, 'cache'), join(dist, 'inner-link'));
  await clean();
  await assert.rejects(fs.lstat(dist));
  assert.ok((await fs.stat(join(at, 'cache', 'old', 'stale.js'))).isFile(), 'a link inside dist does not reach out');
});

test('REQ-143 X4·X9 the words, in both languages', () => {
  const en = copy('en'), ko = copy('ko');
  assert.match(en.workflowBuiltinReadsNothing, /reads no documents/);
  assert.match(en.workflowBuiltinReadsNothing, /\.kanban\/workflow\.json/);
  assert.match(ko.workflowBuiltinReadsNothing, /문서를 읽지 않는/);
  assert.match(ko.workflowBuiltinReadsNothing, /\.kanban\/workflow\.json/);
  assert.match(en.workflowInstanceMarksNoteLog, /record section/);
  assert.match(ko.workflowInstanceMarksNoteLog, /기록 구역/);
  assert.notEqual(en.workflowInstanceMarksNoteLog, en.workflowInstanceMarksNote);
  for (const v of [en.workflowBuiltinReadsNothing, en.workflowInstanceMarksNoteLog]) assert.doesNotMatch(v, /[가-힣]/);
});

// The flow's own order (workflow.tsx FlowView): forward labels first, then loop labels — those under a row first — each placed
// against everything before it. Checked here against all of it again, not only what it was given.
function placeAll(def, width, loopText = e => e.label, rounds = () => 1) {
  const L = flowLayout(def.stages, width), node = id => L.at.get(id), forward = [];
  for (const e of def.edges) if (!e.back && e.label)
    forward.push({ text: e.label, rect: spotRect(edgeLabelSpot(route(node(e.from), node(e.to), false, 0, rowBottom(L, node(e.from).stage.row))[0]), e.label) });
  const loops = def.edges.filter(e => e.back && loopText(e)).map(e => ({ e, text: loopText(e), n: rounds(e), segs: route(node(e.from), node(e.to), true, 0, rowBottom(L, node(e.from).stage.row)) }));
  const placed = [];
  for (const job of [...loops.filter(x => x.segs.length === 3), ...loops.filter(x => x.segs.length !== 3)]) {
    const rect = spotRect(loopLabelSpot(L, job.segs, job.n, job.text, [...forward.map(f => f.rect), ...placed.map(p => p.rect)]), job.text);
    placed.push({ text: job.text, rect });
  }
  return { L, forward, placed };
}
function clashes({ L, forward, placed }) {
  const overlaps = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0;
  const out = [];
  for (const [i, p] of placed.entries()) {
    for (const o of flowObstacles(L)) if (overlaps(p.rect, o)) out.push(p.text + ' on a step or count');
    for (const f of forward) if (overlaps(p.rect, f.rect)) out.push(p.text + ' on "' + f.text + '"');
    for (const q of placed.slice(i + 1)) if (overlaps(p.rect, q.rect)) out.push(p.text + ' on "' + q.text + '"');
    if (!(p.rect.l >= 0 && p.rect.r <= L.width && p.rect.t >= 0 && p.rect.b <= L.height)) out.push(p.text + ' outside');
  }
  return out;
}
test('REQ-143 X10 every built-in\'s loop labels touch no step, no count chip, no forward label and no other loop label, in both languages and widths', () => {
  for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) for (const width of [1118, 760, 520]) {
    const def = builtinDefinition(t, locale);
    assert.deepEqual(clashes(placeAll(def, width)), [], `${t.id} ${locale} ${width}`);
  }
});
test('REQ-143 X10 (gate 351) a loop gone round three times — a long label, three lines — still clear of everything', () => {
  for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) for (const width of [1118, 760]) {
    const def = builtinDefinition(t, locale);
    const text = e => (locale === 'ko' ? e.label + ' 3회: ' : e.label + ' 3 times: ') + '301→302 · 303→304 · 305→306';
    // At the 1920 lane's width nothing may touch; narrower, a label this long can find no free place by a busy row (sales-b2b at
    // 760–900): the least-covering one is taken, never on a step.
    const found = clashes(placeAll(def, width, text, () => 3));
    assert.deepEqual(width === 1118 ? found : found.filter(v => / on a step or count$| outside$/.test(v)), [], `${t.id} ${locale} ${width}`);
  }
});
