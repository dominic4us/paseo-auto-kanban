#!/usr/bin/env node
// REQ-146 (research/378): run the plugin's pure client/shared computations in the Hermes VM and in node, and compare.
// `test:hermes` (check-hermes.mjs) only compiles; D54 compiled fine and drew wrong sizes on every phone, because Hermes
// gives `let`/`const` in a loop no block scope. This runs the same bundle the app evaluates, in a Hermes VM.
import { copyFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { findTools } from './check-hermes.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(scriptDirectory, '..', 'tests', 'fixtures', 'hermes-runtime');
/** The pure computations (no stand-ins), and every module's loaded values with React Native standing in. */
export const ENTRY = join(FIXTURES, 'entry.ts'), NATIVE_ENTRY = join(FIXTURES, 'entry-native.ts');
const NATIVE_HOST = join(FIXTURES, 'native-host.mjs'), SNAPSHOT = join(FIXTURES, 'snapshot.ts');
/** The Linux VM `fetch-hermes-vm.mjs` installs: Hermes' own release whose bytecode (96) is the app's (RN 0.81.5). */
export const VM_RELEASE = 'v0.13.0';
export function vmCachePath(env = process.env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'paseo-auto-kanban', 'hermes-vm', VM_RELEASE, process.platform === 'win32' ? 'hermes.exe' : 'hermes');
}
function unavailable(reason, required) {
  if (required) throw new Error(reason);
  return { status: 'skipped', reason };
}
const bytecodeVersion = text => Number(/HBC bytecode version: (\d+)/.exec(text)?.[1] ?? NaN);

/**
 * The app-matched compiler (`hermesc` from react-native, as check-hermes finds it) and a Hermes VM that runs its bytecode:
 * `--vm`/HERMES_VM, else the cache `fetch-hermes-vm.mjs` fills, else on macOS react-native's own `osx-bin/hermes`.
 */
export function findRuntime(plugin, options = {}) {
  const tools = findTools(plugin, { required: options.required });
  if (tools.status === 'skipped') return tools;
  const explicit = options.vm ?? process.env.HERMES_VM;
  const candidates = explicit ? [resolve(explicit)] : [vmCachePath(),
    ...(process.platform === 'darwin' ? [join(dirname(tools.hermesc), 'hermes')] : [])];
  const vm = candidates.find(file => existsSync(file));
  if (!vm) {
    if (explicit) throw new Error('Configured Hermes VM does not exist: ' + explicit);
    return unavailable('Hermes VM unavailable: run `npm run hermes:fetch-vm` (Linux x64) or set HERMES_VM (looked in '
      + candidates.join(', ') + ').', options.required);
  }
  try { accessSync(vm, constants.X_OK); } catch (error) { throw new Error('Hermes VM is not executable: ' + vm, { cause: error }); }
  const version = spawnSync(vm, ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (version.error?.code === 'ENOEXEC' || version.error?.code === 'ENOENT')
    return unavailable('Hermes VM cannot execute on this platform: ' + version.error.code, options.required);
  if (version.error || version.status !== 0) throw new Error('Hermes VM failed to start: ' + (version.error?.message ?? version.stderr));
  const vmBytecode = bytecodeVersion(version.stdout), appBytecode = bytecodeVersion(tools.engineVersion);
  if (vmBytecode !== appBytecode)
    return unavailable(`Hermes VM bytecode ${vmBytecode} is not the app compiler's ${appBytecode}: ` + vm, options.required);
  return { ...tools, vm, bytecode: vmBytecode, vmVersion: version.stdout.trim() };
}

const walk = directory => !existsSync(directory) ? [] : readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []).sort();
const sourceFiles = root => ['client', 'shared'].flatMap(name => walk(join(root, name)))
  .filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file));
function copyPlugin(plugin, destination, overlays, additions = {}) {
  const files = ['paseo-plugin.json', 'package.json', 'tsconfig.json'];
  const sources = [...files.map(name => join(plugin, name)).filter(existsSync), ...walk(join(plugin, 'client')), ...walk(join(plugin, 'shared'))];
  for (const file of sources) {
    const target = join(destination, relative(plugin, file));
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target);
  }
  for (const [path, file] of Object.entries(overlays)) {
    const target = join(destination, path);
    if (!existsSync(target)) throw new Error('Overlay replaces no plugin file: ' + path);
    copyFileSync(resolve(file), target);
  }
  // A new module (a check's own counterexample, say): only under client/ or shared/, never over a file the plugin has.
  for (const [path, file] of Object.entries(additions)) {
    const target = join(destination, path);
    if (!/^(client|shared)\//.test(path) || path.includes('..')) throw new Error('An added module belongs in client/ or shared/: ' + path);
    if (existsSync(target)) throw new Error('Added module would replace a plugin file (use an overlay): ' + path);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(resolve(file), target);
  }
}
/** `client/__all_modules.ts` in the copy (Paseo bundles no other root module): every client/shared module by its path. */
function writeModuleList(copy) {
  const files = sourceFiles(copy).map(file => relative(copy, file).split('\\').join('/'));
  writeFileSync(join(copy, 'client', '__all_modules.ts'), files.map((file, i) =>
    `import * as m${i} from ${JSON.stringify('../' + file.replace(/\.[cm]?[jt]sx?$/, '.js'))};`).join('\n')
    + `\nexport const MODULES: Record<string, Record<string, unknown>> = {\n`
    + files.map((file, i) => `  ${JSON.stringify(file.replace(/\.[cm]?[jt]sx?$/, ''))}: m${i},`).join('\n') + '\n};\n');
}
/** The host modules the app gives that only stand in here (`native-host.mjs`), and the names the sources import from each. */
export const STUBBED_HOST = ['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/react-native',
  '@tanstack/react-query'];
export function importedHostNames(plugin) {
  const names = Object.fromEntries(STUBBED_HOST.map(spec => [spec, new Set()]));
  for (const name of ['jsx', 'jsxs', 'Fragment']) names['react/jsx-runtime'].add(name);
  for (const file of sourceFiles(plugin)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const set = names[statement.moduleSpecifier.text], clause = statement.importClause;
      if (!set || !clause || clause.isTypeOnly) continue;
      if (clause.name) set.add('default');
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) set.add((element.propertyName ?? element.name).text);
    }
  }
  return Object.fromEntries(Object.entries(names).map(([spec, set]) => [spec, [...set].sort()]));
}
/**
 * The host modules a plugin client bundle imports: zod and the plugin SDK as they are, React, React Native and the SDK's
 * client parts as stand-ins (`native-host.mjs`, every other imported name a throwing stub) — enough to load a screen
 * module, not to draw it. The app gives them through Metro, which lowers their classes; this Hermes generation has none,
 * so the host's code is lowered to ES5 here the same way. The plugin's bundle reaches Hermes exactly as Paseo compiles it.
 */
const hostBundles = new Map();
function hostBundle(plugin, compiler, directory) {
  const key = plugin + '\0' + compiler;
  if (!hostBundles.has(key)) hostBundles.set(key, buildHost(plugin, compiler, directory));
  return hostBundles.get(key);
}
async function buildHost(plugin, compiler, directory) {
  const esbuild = createRequire(compiler)('esbuild');
  const entry = join(directory, 'host-modules.mjs');
  writeFileSync(entry, "import * as zod from 'zod';\nimport * as plugin from '@getpaseo/plugin';\n"
    + `import native from ${JSON.stringify(NATIVE_HOST)};\n`
    + `const names = ${JSON.stringify(importedHostNames(plugin))};\n`
    + 'const stub = name => function () { throw new Error("host API called outside the app: " + name); };\n'
    + 'const host = { zod, "@getpaseo/plugin": plugin };\n'
    + 'for (const spec of Object.keys(names)) {\n'
    + '  const module = Object.assign({}, native[spec] || {});\n'
    + '  for (const name of names[spec]) if (!(name in module)) module[name] = stub(spec + " " + name);\n'
    + '  if (!("default" in module)) module.default = module;\n'
    + '  host[spec] = module;\n}\nexport default host;\n');
  const result = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'neutral', target: 'es2020',
    mainFields: ['module', 'main'], nodePaths: [join(plugin, 'node_modules')], write: false, logLevel: 'silent' });
  return ts.transpileModule(result.outputFiles[0].text, { compilerOptions: { target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.None, downlevelIteration: true, allowJs: true } }).outputText;
}
/** One script for both engines: the host modules, the plugin bundle given them as `require`, the entry's result printed. */
export async function buildProgram(plugin, runtime, options = {}) {
  plugin = resolve(plugin);
  const temporary = mkdtempSync(join(tmpdir(), 'kanban-hermes-run-'));
  try {
    const copy = join(temporary, 'plugin');
    copyPlugin(plugin, copy, options.overlays ?? {}, options.additions ?? {});
    const entry = join(copy, 'index.client.ts');
    copyFileSync(options.entry ?? ENTRY, entry);
    writeModuleList(copy);
    // After the module list, so the encoder both entries share is not itself one of the compared modules.
    copyFileSync(SNAPSHOT, join(copy, 'client', '__snapshot.ts'));
    const { compilePlugin } = await import(pathToFileURL(runtime.compiler).href);
    const { clientBundle } = await compilePlugin({ client: entry });
    if (typeof clientBundle !== 'string') throw new Error('Compiler returned no client bundle.');
    const host = await hostBundle(plugin, runtime.compiler, temporary);
    const program = [
      'var __host = (function () { var module = { exports: {} }; var exports = module.exports;', host, 'return module.exports; })()["default"];',
      'var __plugin = (' + clientBundle + ')(function (id) {',
      '  if (Object.prototype.hasOwnProperty.call(__host, id)) return __host[id];',
      '  throw new Error("host module not provided to the Hermes run: " + id); });',
      'var __out; try { __out = JSON.stringify({ result: __plugin["default"]() }); }',
      'catch (error) { __out = JSON.stringify({ error: String(error && error.stack || error) }); }',
      'print(__out);', ''].join('\n');
    return { program, bundleBytes: Buffer.byteLength(clientBundle),
      bundleSha256: createHash('sha256').update(clientBundle).digest('hex') };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

// Both engines read the device's clock zone (lead-status prints local times): pin it, so a difference is the engine's.
const ENV = { ...process.env, TZ: 'UTC' };
function parseOutput(name, result) {
  if (result.error || result.status !== 0)
    return { name, error: `${name} exited ${result.status ?? result.signal}: ` + (result.error?.message ?? (result.stderr || result.stdout).slice(0, 2000)) };
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  try {
    const parsed = JSON.parse(line);
    return parsed.error ? { name, error: name + ' threw: ' + parsed.error } : { name, value: parsed.result };
  } catch { return { name, error: name + ' printed no result: ' + result.stdout.slice(0, 2000) + result.stderr.slice(0, 2000) }; }
}
const NODE_HOST = "globalThis.print = text => process.stdout.write(text + '\\n');"
  + "require('node:vm').runInThisContext(require('node:fs').readFileSync(process.argv[1], 'utf8'), { filename: 'hermes-run.js' });";
const RUN = { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024, env: ENV };
/**
 * node, then the Hermes VM twice: the bytecode of the app's compiler (the semantics a phone gets) and the VM's own compile
 * of the source (a second compiler generation, so a check that leans on one compiler's quirk shows).
 */
export function runEngines(program, runtime) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-hermes-run-'));
  try {
    const file = join(directory, 'hermes-run.js'), bytecode = join(directory, 'hermes-run.hbc');
    writeFileSync(file, program);
    const timed = (name, run) => { const start = Date.now(); const out = run(); return { ...out, ms: Date.now() - start }; };
    const node = timed('node', () => parseOutput('node', spawnSync(process.execPath, ['-e', NODE_HOST, file], RUN)));
    const compiled = spawnSync(runtime.hermesc, ['-emit-binary', '-out', bytecode, file], RUN);
    const app = compiled.status !== 0 ? { name: 'hermes-bytecode', error: 'hermesc failed: ' + compiled.stderr.slice(0, 2000), ms: 0 }
      : timed('hermes-bytecode', () => parseOutput('hermes-bytecode', spawnSync(runtime.vm, ['-b', bytecode], RUN)));
    const source = timed('hermes-source', () => parseOutput('hermes-source', spawnSync(runtime.vm, [file], RUN)));
    return { node, engines: [app, source] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Where two results part: JSON paths with each side's value, the first `limit` of them. */
export function differences(a, b, limit = 50, path = '', out = []) {
  if (out.length >= limit) return out;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      if (!(key in a) || !(key in b)) out.push({ path: path + '/' + key, node: key in a ? a[key] : '[missing]', hermes: key in b ? b[key] : '[missing]' });
      else differences(a[key], b[key], limit, path + '/' + key, out);
      if (out.length >= limit) break;
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: path || '/', node: a, hermes: b });
  return out;
}
const countLeaves = value => value !== null && typeof value === 'object'
  ? Object.values(value).reduce((n, item) => n + countLeaves(item), 0) : 1;

export async function checkRuntime(plugin = '.', options = {}) {
  const runtime = findRuntime(plugin, options);
  if (runtime.status === 'skipped') return runtime;
  const start = Date.now();
  const built = await buildProgram(plugin, runtime, options);
  const buildMs = Date.now() - start;
  const { node, engines } = runEngines(built.program, runtime);
  if (node.error) throw new Error(node.error);
  const modes = engines.map(engine => engine.error ? { name: engine.name, status: 'failed', error: engine.error, ms: engine.ms }
    : (d => ({ name: engine.name, status: d.length ? 'failed' : 'passed', count: d.length, differences: d.slice(0, options.limit ?? 50),
      ms: engine.ms }))(differences(node.value, engine.value, Infinity)));
  return { status: modes.every(mode => mode.status === 'passed') ? 'passed' : 'failed', vm: runtime.vm, bytecode: runtime.bytecode,
    vmVersion: runtime.vmVersion.match(/Hermes release version: .*/)?.[0], compared: countLeaves(node.value), node: node.value,
    bundleBytes: built.bundleBytes, bundleSha256: built.bundleSha256, timings: { buildMs, nodeMs: node.ms, totalMs: Date.now() - start }, modes };
}

/**
 * The diagnostics a result holds (`tests/fixtures/hermes-runtime/snapshot.ts`): `thrown` (a computation or getter threw —
 * thrown the same in both engines is no match, gate 380 F1), `error` (an Error value returned), `unsupported` (a kind the
 * encoder does not know) and `depth` (nested past its limit). The last two are never compared as equal (gate 381 F1).
 */
export const DIAGNOSTICS = {
  thrown: tagged => `computation threw (a thrown value is never a match): ${tagged.name}: ${tagged.message}`,
  error: tagged => `computation returned an Error: ${tagged.name}: ${tagged.message}`,
  unsupported: tagged => `value kind not supported by the encoder, so not compared: ${tagged.kind}`,
  depth: tagged => `value nested deeper than ${tagged.limit}, so not compared`,
  size: tagged => `value over ${tagged.limit} parts, so not compared`,
};
const ALLOWABLE = new Set(['thrown', 'error']);
export function errorMarkers(value, path = '', out = []) {
  if (value !== null && typeof value === 'object') {
    if (!Array.isArray(value) && typeof value.$t === 'string' && value.$t in DIAGNOSTICS)
      out.push({ path: path || '/', kind: value.$t, error: DIAGNOSTICS[value.$t](value) });
    for (const key of Object.keys(value)) errorMarkers(value[key], path + '/' + key, out);
  }
  return out;
}
/**
 * The errors a computation may throw on purpose, by result path (a path with `*` for the scale). None today: an entry that
 * means an error lists its path here, so every other thrown or returned error fails the run. `unsupported` and `depth`
 * are never allowed.
 */
export const EXPECTED_ERRORS = { pure: [], native: [] };
const expected = (list, path) => list.some(pattern => new RegExp('^' + pattern.split('*').map(part =>
  part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$').test(path));
/** At least this many values, or the run compared next to nothing (gate 380 F2: an empty entry passed with 0). */
export const MIN_COMPARED = { pure: 10000, native: 3000 };
function modeProblems(report) {
  return report.modes.flatMap(mode => mode.status === 'passed' ? [] : [mode.name + ': ' + (mode.error
    ?? `${mode.count} differences, first ${JSON.stringify(mode.differences.slice(0, 5))}`)]);
}
function thrown(report, allowed) {
  return errorMarkers(report.node).filter(marker => !(ALLOWABLE.has(marker.kind) && expected(allowed, marker.path)))
    .map(marker => `${marker.path}: ${marker.error}`);
}
/** What the pure run must show besides two equal results: no thrown computation, enough values, every scale, the flows. */
export function pureProblems(report, allowed = EXPECTED_ERRORS.pure) {
  const node = report.node ?? {}, problems = [...thrown(report, allowed)];
  if (!(report.compared >= MIN_COMPARED.pure)) problems.push(`values compared: ${report.compared} (at least ${MIN_COMPARED.pure})`);
  if (JSON.stringify(Object.keys(node.scales ?? {})) !== '["80","100","150"]') problems.push('scales read: ' + JSON.stringify(Object.keys(node.scales ?? {})));
  else {
    if (node.scales['100'].values?.['client/mobile-layout']?.MOBILE?.appbarHeight !== 44) problems.push('MOBILE.appbarHeight at 100% is not 44 in node');
    if (!Object.keys(node.scales['100'].computed ?? {}).some(name => name.startsWith('flowLayout '))) problems.push('no flowLayout computed');
  }
  if (!node.unsized || !Object.keys(node.unsized).length) problems.push('no unsized computation');
  return [...problems, ...modeProblems(report)];
}
/** The native run: every client/shared source loaded (none dropped), no thrown value, RING read, handlers joined in order. */
export function nativeProblems(report, modules, allowed = EXPECTED_ERRORS.native) {
  const node = report.node ?? {}, problems = [...thrown(report, allowed)];
  if (!(report.compared >= MIN_COMPARED.native)) problems.push(`values compared: ${report.compared} (at least ${MIN_COMPARED.native})`);
  const loaded = node.modules ?? [], missing = modules.filter(name => !loaded.includes(name)), extra = loaded.filter(name => !modules.includes(name));
  if (missing.length || extra.length) problems.push('modules loaded differ from the sources: missing ' + JSON.stringify(missing) + ', unexpected ' + JSON.stringify(extra));
  for (const scale of ['80', '100', '150']) {
    const values = node.scales?.[scale] ?? {}, absent = modules.filter(name => !(name in values));
    if (absent.length) problems.push(`modules without values at ${scale}%: ` + JSON.stringify(absent));
  }
  if (node.scales?.['100']?.['client/status-icon']?.RING?.size !== 14) problems.push('status-icon RING.size at 100% is not 14 in node');
  if (JSON.stringify(node.joinHandlers?.calls) !== JSON.stringify(['tip in', 'hover in', 'tip out', 'hover out', 'press', 'press 2']))
    problems.push('joinHandlers calls in node: ' + JSON.stringify(node.joinHandlers));
  return [...problems, ...modeProblems(report)];
}
/** research/364 §2: on D54's ui-scale.ts the header (44) and the tabs (36) read MOBILE's last field, 12. */
export const D54_UI_SCALE = join(FIXTURES, 'ui-scale.d54.ts');
export const D54_EXPECTED = [
  { path: '/scales/100/values/client/mobile-layout/MOBILE/appbarHeight', node: 44, hermes: 12 },
  { path: '/scales/100/values/client/mobile-layout/MOBILE/tabFace', node: 36, hermes: 12 },
];
/** The VM still runs the phone's semantics: on D54's code each mode must differ, where the phones did, by over 1,000 values. */
export function canaryProblems(report) {
  if (!report.modes) return ['no run'];
  return report.modes.flatMap(mode => {
    if (mode.error) return [mode.name + ': ' + mode.error];
    if (mode.status === 'passed') return [mode.name + ' saw no difference on D54\'s code: the VM no longer runs the phone\'s semantics'];
    const missing = D54_EXPECTED.filter(want => !mode.differences.some(d => JSON.stringify(d) === JSON.stringify(want)));
    return [...missing.map(want => mode.name + ' lacks D54\'s difference ' + JSON.stringify(want)),
      ...(mode.count > 1000 ? [] : [mode.name + ': only ' + mode.count + ' differences on D54\'s code'])];
  });
}
const finish = (report, problems) => report.status === 'skipped' ? report : { ...report, status: problems.length ? 'failed' : 'passed', problems };
/** The client/shared module names a native run must load: the sources and `additions`, without their extensions. */
export function expectedModules(plugin, additions = {}) {
  return [...new Set([...sourceFiles(resolve(plugin)).map(file => relative(resolve(plugin), file).split('\\').join('/')), ...Object.keys(additions)])]
    .map(file => file.replace(/\.[cm]?[jt]sx?$/, '')).sort();
}
export async function checkPure(plugin = '.', options = {}) {
  const report = await checkRuntime(plugin, { ...options, entry: options.entry ?? ENTRY });
  return report.status === 'skipped' ? report : finish(report, pureProblems(report, options.expectedErrors));
}
export async function checkCanary(plugin = '.', options = {}) {
  const report = await checkRuntime(plugin, { ...options, entry: options.entry ?? ENTRY, limit: Infinity,
    overlays: { ...options.overlays, 'client/ui-scale.ts': D54_UI_SCALE } });
  return report.status === 'skipped' ? report : finish(report, canaryProblems(report));
}
export async function checkNative(plugin = '.', options = {}) {
  const report = await checkRuntime(plugin, { ...options, entry: options.nativeEntry ?? NATIVE_ENTRY });
  return report.status === 'skipped' ? report : finish(report, nativeProblems(report, expectedModules(plugin, options.additions)));
}
export const CHECKS = { pure: checkPure, canary: checkCanary, native: checkNative };
/** Every check, in turn — the test file and `npm run test:hermes-run` run these same three, so neither skips a guard. */
export async function checkAll(plugin = '.', options = {}) {
  const checks = {};
  for (const [name, check] of Object.entries(CHECKS)) {
    checks[name] = await check(plugin, options);
    if (checks[name].status === 'skipped') return { status: 'skipped', reason: checks[name].reason, checks };
  }
  return { status: Object.values(checks).every(c => c.status === 'passed') ? 'passed' : 'failed', checks };
}

async function main() {
  const usage = 'Usage: node scripts/hermes-runtime.mjs [plugin-directory] [--overlay path=file]... [--add path=file]... [--entry file]'
    + ' [--native-entry file] [--only pure|canary|native] [--vm binary] [--required] [--json]';
  const args = process.argv.slice(2), options = { overlays: {}, additions: {} }; let plugin, only;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { console.log(usage); return; }
    if (arg === '--json' || arg === '--required') { options[arg.slice(2)] = true; continue; }
    if (arg === '--vm' && args[i + 1]) { options.vm = args[++i]; continue; }
    if (arg === '--entry' && args[i + 1]) { options.entry = resolve(args[++i]); continue; }
    if (arg === '--native-entry' && args[i + 1]) { options.nativeEntry = resolve(args[++i]); continue; }
    if (arg === '--only' && args[i + 1] in CHECKS) { only = args[++i]; continue; }
    if ((arg === '--overlay' || arg === '--add') && args[i + 1]?.includes('=')) {
      const [path, file] = args[++i].split('='); options[arg === '--add' ? 'additions' : 'overlays'][path] = file; continue;
    }
    if (!arg.startsWith('-') && !plugin) { plugin = arg; continue; }
    throw new Error(usage);
  }
  options.required ||= process.env.KANBAN_REQUIRE_HERMES_VM === '1';
  const report = only ? (r => ({ status: r.status, reason: r.reason, checks: { [only]: r } }))(await CHECKS[only](plugin ?? process.cwd(), options))
    : await checkAll(plugin ?? process.cwd(), options);
  if (options.json) console.log(JSON.stringify(report, (key, value) => key === 'node' ? undefined : value, 2));
  else {
    console.log(report.status.toUpperCase() + (report.reason ? ': ' + report.reason : ''));
    for (const [name, check] of Object.entries(report.checks ?? {})) {
      if (!check.modes) continue;
      console.log(`[${name}] ${check.status.toUpperCase()}${name === 'canary' ? ' (on D54\'s ui-scale.ts each mode must differ)' : ''} — ${check.vmVersion} (HBC ${check.bytecode}); ${check.compared} values compared; ${JSON.stringify(check.timings)}`);
      for (const mode of check.modes) console.log(`  ${mode.name}: ${mode.status} (${mode.ms} ms)` + (mode.count ? `, ${mode.count} differences` : ''));
      for (const problem of name === 'canary' && check.status === 'passed' ? [] : check.problems ?? []) console.log('  problem: ' + problem);
    }
  }
  process.exitCode = report.status === 'failed' ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Hermes run tool error: ' + String(error)); process.exitCode = 2; });
}
