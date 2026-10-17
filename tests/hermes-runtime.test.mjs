/**
 * REQ-146 (research/378): the plugin's pure client/shared computations run in a real Hermes VM and must give what they
 * give in node. D54 (research/364) compiled cleanly (`test:hermes`) and passed every node and web test, yet drew every
 * phone's sizes wrong, because Hermes gives `let`/`const` in a loop no block scope.
 * The three VM checks are `scripts/hermes-runtime.mjs`'s `checkPure`·`checkCanary`·`checkNative`, the same ones
 * `npm run test:hermes-run` runs (gate 380 F2), each with its guards: no thrown computation (F1), enough values, every module.
 * The canary keeps the VM honest: on D54's own code (31a6ec3's ui-scale.ts) it must still see the phone's wrong sizes.
 * The counterexamples of gate 380 (research/380) and gate 381 (research/381: values the old snapshot made alike) must stay red.
 * No VM (another developer, a CI without `npm run hermes:fetch-vm`): skipped with the reason, unless required
 * (KANBAN_REQUIRE_HERMES_VM=1, or CI set and that variable unset).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { checkCanary, checkNative, checkPure, differences, errorMarkers, expectedModules, nativeProblems, pureProblems }
  from '../scripts/hermes-runtime.mjs';

const required = process.env.KANBAN_REQUIRE_HERMES_VM === undefined
  ? Boolean(process.env.CI && process.env.CI !== 'false') : process.env.KANBAN_REQUIRE_HERMES_VM === '1';
const plugin = resolve('.');
const passed = report => assert.equal(report.status, 'passed', JSON.stringify(report.problems ?? report.reason, null, 1));
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-hermes-run-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
/** A copy of a plugin source with `text` put first in one function's body. */
function broken(t, path, head, text) {
  const source = readFileSync(join(plugin, path), 'utf8');
  assert.ok(source.includes(head), path + ' no longer has ' + head);
  const file = join(temporary(t), path.split('/').at(-1));
  writeFileSync(file, source.replace(head, head + '\n  ' + text));
  return file;
}

test('REQ-146 client/shared pure computations give in the Hermes VM what they give in node', async t => {
  const report = await checkPure(plugin, { required });
  if (report.status === 'skipped') { t.skip(report.reason); return; }
  t.diagnostic(JSON.stringify({ vm: report.vmVersion, bytecode: report.bytecode, compared: report.compared, timings: report.timings,
    modes: report.modes.map(m => [m.name, m.status, m.ms]) }));
  passed(report);
  assert.deepEqual(report.modes.map(m => m.name), ['hermes-bytecode', 'hermes-source']);
  assert.equal(report.node.scales['150'].values['client/mobile-layout'].MOBILE.appbarHeight, 66);
});

test('REQ-146 the VM still shows D54 on 31a6ec3\'s ui-scale.ts: every phone size the loop\'s last value', async t => {
  const report = await checkCanary(plugin, { required });
  if (report.status === 'skipped') { t.skip(report.reason); return; }
  passed(report);
  for (const mode of report.modes) assert.ok(mode.count > 1000, mode.name + ': ' + mode.count);
});

test('REQ-146 every client/shared module loads in the Hermes VM as in node, React Native standing in: screen tables, joinHandlers', async t => {
  const report = await checkNative(plugin, { required });
  if (report.status === 'skipped') { t.skip(report.reason); return; }
  t.diagnostic(JSON.stringify({ compared: report.compared, modules: report.node.modules.length, timings: report.timings }));
  passed(report);
  assert.deepEqual([...report.node.modules].sort(), expectedModules(plugin));
});

test('gate 380 F1: a computation thrown alike in node and Hermes fails the pure check', async t => {
  const overlays = {
    'client/layout.ts': broken(t, 'client/layout.ts', 'export function boardLayout(width: number, mobile: boolean) {',
      "if (width >= 0) throw new Error('gate380 broken boardLayout');"),
    'client/order-model.ts': broken(t, 'client/order-model.ts',
      'export function pinGroup(stored: readonly string[], group: readonly string[]): string[] {',
      "if (stored.length >= 0) throw new Error('gate380 broken pinGroup');"),
  };
  const report = await checkPure(plugin, { required, overlays });
  if (report.status === 'skipped') { t.skip(report.reason); return; }
  assert.equal(report.status, 'failed');
  // Both engines threw the same: no difference, so only the thrown-value guard can fail it.
  assert.deepEqual(report.modes.map(m => m.status), ['passed', 'passed']);
  assert.ok(report.compared > 10000, 'still above the value floor: ' + report.compared);
  const named = report.problems.join('\n');
  for (const path of ['/scales/80/computed/boardLayout', '/scales/100/computed/boardLayout', '/scales/150/computed/boardLayout', '/unsized/orders'])
    assert.ok(named.includes(path + ': '), path + ' not named in ' + named);
});

test('gate 380 F2 B: an entry that computes nothing fails the pure check', async t => {
  const entry = join(temporary(t), 'empty.ts');
  writeFileSync(entry, 'export default function compute() { return {}; }\n');
  const report = await checkPure(plugin, { required, entry });
  if (report.status === 'skipped') { t.skip(report.reason); return; }
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.modes.map(m => m.status), ['passed', 'passed']);
  assert.ok(report.problems.some(p => p.startsWith('values compared: ')), report.problems.join('\n'));
});

test('gate 380 F2 A: a new module with a D54 getter fails the native check', async t => {
  const file = join(temporary(t), 'gate380-extra.ts');
  writeFileSync(file, 'export const EXTRA: Record<string, number> = {};\n'
    + 'for (const [key, value] of Object.entries({ header: 44, last: 12 })) Object.defineProperty(EXTRA, key, { get: () => value, enumerable: true });\n');
  const additions = { 'client/gate380-extra.ts': file };
  const report = await checkNative(plugin, { required, additions, limit: Infinity });
  if (report.status === 'skipped') { t.skip(report.reason); return; }
  assert.equal(report.status, 'failed');
  assert.ok(report.node.modules.includes('client/gate380-extra'));
  for (const mode of report.modes) for (const scale of ['80', '100', '150'])
    assert.deepEqual(mode.differences.find(d => d.path === `/scales/${scale}/client/gate380-extra/EXTRA/header`),
      { path: `/scales/${scale}/client/gate380-extra/EXTRA/header`, node: 44, hermes: 12 }, mode.name);
});

/** The fixtures' encoder and negative controls, compiled for node (they are TypeScript the plugin bundle compiles). */
async function fixtures(t) {
  const directory = temporary(t), out = {};
  for (const name of ['snapshot', 'value-kinds']) {
    const source = readFileSync(resolve('tests/fixtures/hermes-runtime', name + '.ts'), 'utf8');
    writeFileSync(join(directory, name + '.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext } }).outputText);
    out[name] = await import(pathToFileURL(join(directory, name + '.mjs')).href);
  }
  return out;
}

test('gate 381 F1: the encoder keeps every kind apart — each negative-control pair encodes differently, limits are diagnostics', async t => {
  const { snapshot, 'value-kinds': kinds } = await fixtures(t);
  const same = Object.entries(kinds.PAIRS).filter(([, pair]) => JSON.stringify(snapshot.encode(pair.a)) === JSON.stringify(snapshot.encode(pair.b)));
  assert.deepEqual(same.map(([name]) => name), [], 'pairs the encoder makes alike');
  assert.ok(Object.keys(kinds.PAIRS).length >= 24);
  const tags = value => JSON.stringify(snapshot.attempt(() => value));
  assert.match(tags(kinds.DEEP), /"\$t":"depth"/);
  for (const kind of ['Promise', 'WeakMap', 'Uint8Array']) assert.match(tags(kinds.UNSUPPORTED), new RegExp('"kind":"' + kind + '"'));
  assert.match(tags(kinds.THROWING_GETTER), /"\$t":"thrown","name":"Error","message":"gate381 getter"/);
  assert.match(tags(kinds.RETURNED_ERROR), /"\$t":"error","name":"Error","message":"gate381 returned error"/);
  assert.equal(tags({ $t: 'x', a: 1 }), '{"$$t":"x","a":1}', 'a data key starting with $ is escaped');
  assert.equal(tags(Array.from({ length: snapshot.NODES + 1 }, () => 0)).includes('"$t":"size"'), true, 'past the value budget');
  assert.deepEqual(snapshot.attempt(() => { throw new RangeError('r'); }), { $t: 'thrown', name: 'RangeError', message: 'r' });
});

test('gate 381 F1: values the old snapshot made alike show as differences in the Hermes VM, limits fail the run', async t => {
  const additions = { 'client/__gate381_kinds.ts': resolve('tests/fixtures/hermes-runtime/value-kinds.ts') };
  const report = await checkNative(plugin, { required, additions, limit: Infinity });
  if (report.status === 'skipped') { t.skip(report.reason); return; }
  assert.equal(report.status, 'failed');
  const module = '/scales/100/client/__gate381_kinds/', pairs = Object.keys(report.node.scales['100']['client/__gate381_kinds'].PAIRS);
  for (const mode of report.modes) {
    assert.equal(mode.status, 'failed', mode.name);
    assert.deepEqual(pairs.filter(name => !mode.differences.some(d => d.path.startsWith(module + 'PAIRS/' + name + '/a'))), [],
      mode.name + ': pairs with no difference at a');
    assert.deepEqual(mode.differences.filter(d => !d.path.includes('/client/__gate381_kinds/')), [], mode.name + ': differences elsewhere');
    // research/381 §2 A: node parses "2026/10/16" and "10/16/2026", Hermes gives an invalid Date.
    for (const i of [0, 1]) assert.ok(mode.differences.some(d => d.path === module + `PARSED_DATES/${i}/v` && d.hermes === 'Invalid'), mode.name + ' date ' + i);
  }
  const problems = report.problems.join('\n');
  for (const path of ['RETURNED_ERROR/error: computation returned an Error', 'UNSUPPORTED/promise: value kind not supported',
    'UNSUPPORTED/weak: value kind not supported', 'UNSUPPORTED/bytes: value kind not supported', 'THROWING_GETTER/value: computation threw'])
    assert.ok(problems.includes(module + path), path + ' not in ' + problems.slice(0, 2000));
  assert.match(problems, /__gate381_kinds\/DEEP(\/inner)+: value nested deeper than 24/);
});

test('REQ-146 the guards: thrown values, value floors, dropped modules, without a VM', () => {
  const run = node => ({ node, compared: 20000, modes: [{ name: 'hermes-bytecode', status: 'passed' }] });
  const pure = { scales: Object.fromEntries(['80', '100', '150'].map(s => [s, { values: { 'client/mobile-layout': { MOBILE: { appbarHeight: 44 } } },
    computed: { 'flowLayout common 900': 1 } }])), unsized: { orders: [] } };
  assert.deepEqual(pureProblems(run(pure)), []);
  assert.deepEqual(errorMarkers({ a: [{ $t: 'thrown', name: 'Error', message: 'x' }], b: { c: 1, $$t: 'thrown' } }),
    [{ path: '/a/0', kind: 'thrown', error: 'computation threw (a thrown value is never a match): Error: x' }]);
  const thrown = structuredClone(pure); thrown.unsized.orders = { $t: 'thrown', name: 'Error', message: 'broken' };
  assert.match(pureProblems(run(thrown)).join(), /\/unsized\/orders: computation threw .*Error: broken/);
  assert.deepEqual(pureProblems(run(thrown), ['/unsized/orders']), [], 'an error listed as expected passes');
  for (const [kind, field] of [['unsupported', { kind: 'Promise' }], ['depth', { limit: 24 }], ['size', { limit: 1 }]]) {
    const limited = structuredClone(pure); limited.unsized.orders = { $t: kind, ...field };
    assert.match(pureProblems(run(limited), ['/unsized/orders']).join(), /\/unsized\/orders: .*not compared/, kind + ' is never allowed');
  }
  assert.match(pureProblems({ ...run(pure), compared: 0 }).join(), /values compared: 0/);
  assert.match(pureProblems(run({ ...pure, scales: {} })).join(), /scales read/);
  assert.match(pureProblems({ ...run(pure), modes: [{ name: 'hermes-source', status: 'failed', error: 'crashed' }] }).join(), /hermes-source: crashed/);
  const native = { modules: ['client/a', 'client/status-icon'], joinHandlers: { calls: ['tip in', 'hover in', 'tip out', 'hover out', 'press', 'press 2'] },
    scales: Object.fromEntries(['80', '100', '150'].map(s => [s, { 'client/a': {}, 'client/status-icon': { RING: { size: 14 } } }])) };
  assert.deepEqual(nativeProblems({ ...run(native), compared: 5000 }, ['client/a', 'client/status-icon']), []);
  assert.match(nativeProblems({ ...run(native), compared: 5000 }, ['client/a', 'client/b', 'client/status-icon']).join(), /missing \["client\/b"\]/);
  assert.match(nativeProblems({ ...run(native), compared: 10 }, ['client/a', 'client/status-icon']).join(), /values compared: 10/);
});

test('REQ-146 differences names each path where the two results part', () => {
  assert.deepEqual(differences({ a: 1, b: [1, 2], c: { d: 'x' } }, { a: 1, b: [1, 3], c: { d: 'x' } }), [{ path: '/b/1', node: 2, hermes: 3 }]);
  assert.deepEqual(differences({ a: 1 }, { b: 1 }), [{ path: '/a', node: 1, hermes: '[missing]' }, { path: '/b', node: '[missing]', hermes: 1 }]);
  assert.deepEqual(differences([1], { 0: 1 }), [{ path: '/', node: [1], hermes: { 0: 1 } }]);
  assert.equal(differences(Array.from({ length: 9 }, (_, i) => i), [], 3).length, 3);
});
