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
import { px, setUiScale } from '../dist/client/ui-scale.js';
import { textWidth } from '../dist/client/layout.js';
import { copy } from '../dist/client/i18n.js';
import { BUILTIN_WORKFLOWS, builtinDefinition } from '../dist/shared/workflow-templates.js';
import { FLOW, flowLayout, flowLabelLayout, flowObstacles, flowOverlay, loopLabel, stageCounts, spotRect } from '../dist/client/workflow-model.js';
import { d53History, d53Reading } from './fixtures/d53.mjs';
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
  const allowed = /^(index\.server\.ts|index\.client\.tsx|paseo-plugin\.json|package\.json|README\.md|README\.ko\.md|README\.ja\.md|README\.zh-CN\.md|README\.es\.md|LICENSE|NOTICE|CHANGELOG\.md|(client|server|shared|assets|licenses|dist\/(src|server|shared|cli))\/.+)$/;
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
function placeAll(def, width, loopText = e => e.label, rounds = () => 1, notes = {}, counts = {}) {
  const labels = new Map(def.edges.flatMap((e, i) => e.back ? [[i, { text: loopText(e), n: rounds(e) }]] : []));
  const { layout: L, forward: f, loops: p } = flowLabelLayout(flowLayout(def.stages, width, notes, counts), def.edges, labels);
  const forward = [...f].map(([i, spot]) => ({ text: def.edges[i].label, rect: spotRect(spot, def.edges[i].label) }));
  const placed = [...p].map(([i, spot]) => ({ text: labels.get(i).text, rect: spotRect(spot, labels.get(i).text) }));
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
    // Narrow flows must also allocate enough space for the complete labels.
    const found = clashes(placeAll(def, width, text, () => 3));
    assert.deepEqual(found, [], `${t.id} ${locale} ${width}`);
  }
});

const words53 = locale => { const m = copy(locale); return { ...m, verdict: { pass: m.verdictPass, fail: m.verdictFail, conditional: m.verdictConditional, unknown: m.verdictUnknown } }; };
function placeModel53(model, locale, width) {
  const w = words53(locale), overlay = flowOverlay(model.definition, model.releases[0], w);
  return placeAll(model.definition, width, e => loopLabel(e, overlay.loops.get(model.definition.edges.indexOf(e)) ?? [], w),
    e => Math.max(1, overlay.loops.get(model.definition.edges.indexOf(e))?.length ?? 0), overlay.notes, stageCounts(model, w));
}
for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) for (const width of [1118, 760, 520]) {
  test(`D53 zero overlap with history + count chips + notes: ${t.id} ${locale} ${width}`, () => {
    const model = d53History({ definition: builtinDefinition(t, locale), key: t.id, totals: [] });
    assert.deepEqual(clashes(placeModel53(model, locale, width)), []);
  });
}
for (const id of ['gov-grant', 'sales-b2b']) for (const locale of ['ko', 'en']) for (const single of [false, true]) {
  test(`D53 real reader, ${single ? 'one' : 'every'} loop three times: ${id} ${locale}`, async t => {
    const dir = await fs.mkdtemp(join(await testTmpdir(), 'd53-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const model = await d53Reading(dir, id, locale, single);
    assert.equal(model.defined, true);
    assert.equal(model.releases.length, 1);
    const overlay = flowOverlay(model.definition, model.releases[0], words53(locale));
    for (const [i, e] of model.definition.edges.entries()) if (e.back && (!single || e === model.definition.edges.find(e => e.back)))
      assert.equal(overlay.loops.get(i).length, 3);
    assert.ok(Object.keys(stageCounts(model, words53(locale))).length > 0);
    for (const width of [1118, 900, 760, 520]) assert.deepEqual(clashes(placeModel53(model, locale, width)), [], String(width));
  });
}

test('D53 a crowded custom row gets extra canvas space, never a least-overlapping label', () => {
  const template = builtinDefinition(BUILTIN_WORKFLOWS.find(t => t.id === 'sales-b2b'), 'en');
  const e = template.edges.find(e => e.back);
  const def = { ...template, edges: [...template.edges.filter(e => !e.back), ...Array.from({ length: 24 }, (_, i) => ({ ...e, label: `Review ${i}: 301→302 · 303→304 · 305→306` }))] };
  const base = flowLayout(def.stages, 760), before = structuredClone(base);
  const labels = new Map(def.edges.flatMap((e, i) => e.back ? [[i, { text: e.label, n: 3 }]] : []));
  const result = flowLabelLayout(base, def.edges, labels);
  assert.deepEqual(base, before, 'a relayout must not move the input nodes');
  assert.equal(result.loops.size, 24);
  assert.ok(result.layout.height > base.height);
  assert.deepEqual(clashes(placeAll(def, 760, e => e.label, () => 3)), []);
});

for (const scale of [80, 150]) test(`D53 growing rows uses the UI scale (${scale}%)`, () => {
  setUiScale(scale);
  try {
    for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) for (const width of [1118, 760, 520]) {
      const model = d53History({ definition: builtinDefinition(t, locale), key: t.id, totals: [] });
      assert.deepEqual(clashes(placeModel53(model, locale, width)), [], `${t.id} ${locale} ${width}`);
    }
  } finally { setUiScale(100); }
});

for (const locale of ['ko', 'en']) test(`D53 the 760px B2B loop with neither counts nor node notes: ${locale}`, () => {
  const model = d53History({ definition: builtinDefinition(BUILTIN_WORKFLOWS.find(t => t.id === 'sales-b2b'), locale), key: 'bare', totals: [] }, false);
  const w = words53(locale), overlay = flowOverlay(model.definition, model.releases[0], w);
  assert.deepEqual(overlay.notes, {});
  assert.deepEqual(stageCounts(model, w), {});
  assert.ok([...overlay.loops.values()].every(loops => loops.length === 3));
  assert.deepEqual(clashes(placeModel53(model, locale, 760)), []);
});


// D56: forward labels must obey the same zero-overlap contract as loop labels.
for (const template of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) for (const width of [1118, 760, 520]) for (const history of [false, true]) {
  test('D56 all label borders clear of boxes and each other: ' + [template.id, locale, width, history].join(' '), () => {
    const definition = builtinDefinition(template, locale);
    const placement = history ? placeModel53(d53History({ definition, key: template.id, totals: [] }), locale, width) : placeAll(definition, width);
    assert.deepEqual(clashes({ ...placement, forward: [], placed: [...placement.forward, ...placement.placed] }), []);
  });
}

test('D56 crowded forward captions allocate space and keep node text geometry unchanged', () => {
  const template = builtinDefinition(BUILTIN_WORKFLOWS.find(t => t.id === 'sales-b2b'), 'en');
  const edge = template.edges.find(e => !e.back && e.label);
  const def = { ...template, edges: Array.from({ length: 24 }, (_, i) => ({ ...edge, label: `Forward ${i}: a longer answer` })) };
  const base = flowLayout(def.stages, 760), saved = structuredClone(base), result = flowLabelLayout(base, def.edges, new Map());
  assert.equal(result.forward.size, 24);
  assert.deepEqual(base, saved);
  assert.ok(result.layout.height > base.height);
  for (const [id,n] of result.layout.at) {
    const b = base.at.get(id);
    assert.deepEqual([n.w,n.h,n.labelLines,n.note,n.chip], [b.w,b.h,b.labelLines,b.note,b.chip]);
  }
  const placement = placeAll(def, 760);
  assert.deepEqual(clashes({ ...placement, forward: [], placed: [...placement.forward, ...placement.placed] }), []);
});

// D57 (research/418): a step's name is never cut on the flow. The gate's Chromium laid these over three lines where the
// flow gave two (391 J2, and a chosen step's bold name in a 2px border), in the narrowest column (`FLOW.minCol`).
const D57_CUT = {
  box: { 'Not selected · withdrawn': [80, 100, 150], 'Research · benchmarks': [80, 100, 150], 'Final report · settle': [80, 100, 150],
    'Client review · talks': [80, 100, 150], 'Report · carry forward': [80, 100, 150], 'Do (handed off)': [100], 'Final polish · guide': [100] },
  diamond: { 'My review?': [80, 100, 150], 'Fit · needs?': [80, 100, 150], 'Review · edit?': [80, 100, 150], 'My round?': [80, 150], 'Final check?': [80] },
};
for (const scale of [80, 100, 150]) test(`D57 the long English step names get the room they take (${scale}%)`, () => {
  setUiScale(scale);
  try {
    const seen = new Set();
    for (const t of BUILTIN_WORKFLOWS) {
      const stages = builtinDefinition(t, 'en').stages, cols = Math.max(...stages.map(s => s.col)) + 1;
      const L = flowLayout(stages, Math.round((40 + cols * 104) * scale / 100));
      assert.equal(L.colW, FLOW.minCol);
      for (const n of L.at.values()) {
        const label = n.stage.label;
        if (D57_CUT.box[label]?.includes(scale)) {
          seen.add(label);
          assert.ok(n.labelLines >= 3, `${label}: ${n.labelLines} lines`);
          assert.ok(n.h >= FLOW.nodePad + n.labelLines * FLOW.labelLine, `${label}: ${n.h} high`);
        }
        if (D57_CUT.diamond[label]?.includes(scale)) { seen.add(label); assert.ok(n.w > FLOW.diamond && n.h === n.w, `${label}: ${n.w}`); }
      }
    }
    assert.equal(seen.size, Object.values(D57_CUT).flatMap(Object.values).filter(s => s.includes(scale)).length);
  } finally { setUiScale(100); }
});

for (const scale of [80, 100, 150]) test(`D57 Korean steps keep their size, English ones never get fewer lines (${scale}%)`, () => {
  setUiScale(scale);
  try {
    for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) for (const width of [1600, 1118, 760, 520]) {
      const L = flowLayout(builtinDefinition(t, locale).stages, width);
      for (const n of L.at.values()) {
        const before = textWidth(n.stage.label, FLOW.label) > L.nodeW - px(10) ? 2 : 1, where = `${t.id} ${locale} ${width} ${n.stage.label}`;
        if (n.stage.shape === 'diamond') { if (locale === 'ko') assert.equal(n.w, FLOW.diamond, where); }
        else if (locale === 'ko') assert.equal(n.labelLines, before, where);
        else assert.ok(n.labelLines >= before, where);
      }
    }
  } finally { setUiScale(100); }
});
