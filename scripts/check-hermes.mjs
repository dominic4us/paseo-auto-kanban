#!/usr/bin/env node
// Based on the project's spike checker. Compile in temporary storage; never load/reload a plugin.
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, delimiter, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
function packageRoot(name, roots) {
  for (const root of roots) {
    const require = createRequire(join(root, '__hermes_check__.cjs'));
    for (const request of [name + '/package.json', name]) {
      try {
        let directory = dirname(require.resolve(request));
        for (;;) {
          const file = join(directory, 'package.json');
          if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return directory;
          const parent = dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      } catch { /* Try the next package resolution root. */ }
    }
  }
  return null;
}
function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Source symlinks are unsupported: ' + file);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  }).sort();
}
function sourceFiles(directory) {
  return filesUnder(directory).filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file));
}
function unavailable(reason, required) {
  if (required) throw new Error(reason);
  return { status: 'skipped', reason };
}
export function findTools(plugin, options = {}) {
  const roots = [resolve(plugin), scriptDirectory, process.cwd()];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try { roots.push(dirname(realpathSync(join(directory, process.platform === 'win32' ? 'paseo.cmd' : 'paseo')))); }
    catch { /* An unrelated PATH entry is not an error. */ }
  }
  const server = packageRoot('@getpaseo/server', roots);
  const explicitCompiler = options.compiler ?? process.env.PASEO_PLUGIN_COMPILER;
  const compiler = explicitCompiler ? resolve(explicitCompiler)
    : server ? join(server, 'dist/server/server/plugins/compiler.js') : null;
  if (!options.bundle && (!compiler || !existsSync(compiler))) {
    if (explicitCompiler) throw new Error('Configured Paseo compiler does not exist: ' + explicitCompiler);
    return unavailable('Paseo compiler unavailable; expose Paseo 0.8.x on PATH or set PASEO_PLUGIN_COMPILER.', options.required);
  }
  const rn = packageRoot('react-native', roots);
  const platform = process.platform === 'linux' && process.arch === 'x64' ? 'linux64-bin'
    : process.platform === 'darwin' ? 'osx-bin'
    : process.platform === 'win32' && process.arch === 'x64' ? 'win64-bin' : null;
  const explicitHermesc = options.hermesc ?? process.env.HERMESC;
  const hermesc = explicitHermesc ? resolve(explicitHermesc) : rn && platform
    ? join(rn, 'sdks/hermesc', platform, process.platform === 'win32' ? 'hermesc.exe' : 'hermesc') : null;
  if (!hermesc || !existsSync(hermesc)) {
    if (explicitHermesc) throw new Error('Configured Hermes compiler does not exist: ' + explicitHermesc);
    return unavailable('App-matched hermesc unavailable for this platform; install development dependencies or set HERMESC.', options.required);
  }
  try { accessSync(hermesc, constants.X_OK); }
  catch (error) { throw new Error('Hermes compiler is not executable.', { cause: error }); }
  const version = spawnSync(hermesc, ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (version.error?.code === 'ENOEXEC' || version.error?.code === 'ENOENT')
    return unavailable('Packaged hermesc cannot execute on this platform: ' + version.error.code, options.required);
  if (version.error || version.status !== 0)
    throw new Error('Hermes compiler failed to start: ' + (version.error?.message ?? version.stderr));
  return { status: 'ready', compiler, hermesc, engineVersion: version.stdout.trim() };
}

/** Source policy also catches dormant, unexported syntax which any bundler could eliminate. */
export function inspectSourceSyntax(files) {
  const errors = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node, functionDepth = 0) {
      let reason;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) reason = 'Untransformed classes are forbidden.';
      else if (ts.isFunctionLike(node) && node.asteriskToken &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) reason = 'Async generators are forbidden.';
      else if (ts.isRegularExpressionLiteral(node) && /v/.test(node.text.slice(node.text.lastIndexOf('/') + 1)))
        reason = 'RegExp v flags are forbidden.';
      else if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using)) reason = 'Using declarations are forbidden.';
      else if (functionDepth === 0 && (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier))
        reason = 'Top-level await is forbidden.';
      if (reason) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        errors.push({ file, line: position.line + 1, column: position.character + 1, message: reason });
      }
      const depth = functionDepth + (ts.isFunctionLike(node) ? 1 : 0);
      ts.forEachChild(node, child => visit(child, depth));
    }
    visit(source);
  }
  return errors;
}
export function compileBytecode(bundle, hermesc, directory, name = 'client') {
  const filename = join(directory, name + '.js');
  writeFileSync(filename, bundle);
  const result = spawnSync(hermesc, ['-emit-binary', '-eager', '-ferror-limit=0',
    '-out', join(directory, name + '.hbc'), filename],
  { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status === null)
    throw new Error('Hermes invocation failed: ' + (result.error?.message ?? result.signal));
  return { name, status: result.status === 0 ? 'passed' : 'failed',
    bundleBytes: Buffer.byteLength(bundle), bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    diagnostic: (result.stderr ?? '').split(filename).join('<' + name + '-bundle>') };
}
function copySources(plugin, destination) {
  const files = ['paseo-plugin.json', 'package.json', 'tsconfig.json', 'index.client.tsx', 'index.client.ts']
    .map(name => join(plugin, name)).filter(existsSync);
  for (const name of ['client', 'shared']) files.push(...filesUnder(join(plugin, name)));
  for (const file of files) {
    const target = join(destination, relative(plugin, file));
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target);
  }
}
export async function checkPlugin(plugin, options = {}) {
  plugin = resolve(plugin);
  if (!existsSync(join(plugin, 'paseo-plugin.json'))) throw new Error('Missing paseo-plugin.json.');
  const syntax = options.bundle ? [] : inspectSourceSyntax([
    ...sourceFiles(join(plugin, 'client')), ...sourceFiles(join(plugin, 'shared')),
    ...['index.client.ts', 'index.client.tsx'].map(f => join(plugin, f)).filter(existsSync),
  ]);
  if (syntax.length) return { status: 'failed', syntax, checks: [] };
  const tools = findTools(plugin, options);
  if (tools.status === 'skipped') return { ...tools, syntax, checks: [] };
  const temporary = mkdtempSync(join(tmpdir(), 'kanban-hermes-'));
  try {
    if (options.bundle) {
      const check = compileBytecode(readFileSync(resolve(options.bundle), 'utf8'), tools.hermesc, temporary);
      return { status: check.status, engineVersion: tools.engineVersion, syntax, checks: [check] };
    }
    const copy = join(temporary, 'plugin');
    copySources(plugin, copy);
    const { compilePlugin } = await import(pathToFileURL(tools.compiler).href);
    const entry = ['index.client.tsx', 'index.client.ts'].map(f => join(copy, f)).find(existsSync);
    if (!entry) throw new Error('No client entry found.');
    const { clientBundle } = await compilePlugin({ client: entry });
    if (typeof clientBundle !== 'string') throw new Error('Compiler returned no client bundle.');
    const checks = [compileBytecode(clientBundle, tools.hermesc, temporary, 'client')];
    // Escape each module namespace through the exported value so tree shaking cannot hide exports.
    // The AST policy above separately checks unexported/dead declarations in every source file.
    const shared = sourceFiles(join(copy, 'shared'));
    const forced = shared.map((file, i) =>
      `import * as shared${i} from ${JSON.stringify('./' + relative(copy, file).split('\\').join('/'))};`).join('\n') +
      `\nexport default [${shared.map((_, i) => `shared${i}`).join(',')}];\n`;
    rmSync(entry);
    const forcedEntry = join(copy, 'index.client.ts'); writeFileSync(forcedEntry, forced);
    const { clientBundle: sharedBundle } = await compilePlugin({ client: forcedEntry });
    if (typeof sharedBundle !== 'string') throw new Error('Compiler returned no forced shared bundle.');
    checks.push(compileBytecode(sharedBundle, tools.hermesc, temporary, 'shared-all'));
    return { status: checks.every(c => c.status === 'passed') ? 'passed' : 'failed',
      engineVersion: tools.engineVersion, sharedFiles: shared.map(f => relative(copy, f)), syntax, checks };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
async function main() {
  const usage = 'Usage: node scripts/check-hermes.mjs [plugin-directory] [--compiler file] [--hermesc binary] [--bundle file] [--required] [--json]';
  const args = process.argv.slice(2), options = {}; let plugin;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { console.log(usage); return; }
    if (arg === '--json' || arg === '--required') { options[arg.slice(2)] = true; continue; }
    if (['--compiler', '--hermesc', '--bundle'].includes(arg) && args[i + 1]) { options[arg.slice(2)] = args[++i]; continue; }
    if (!arg.startsWith('-') && !plugin) { plugin = arg; continue; }
    throw new Error(usage);
  }
  options.required ||= process.env.KANBAN_REQUIRE_HERMES === '1';
  const report = await checkPlugin(plugin ?? process.cwd(), options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.status.toUpperCase() + (report.reason ? ': ' + report.reason : ''));
    for (const check of report.checks) console.log(`${check.name}: ${check.status} (${check.bundleBytes} bytes)\n${check.diagnostic}`);
    for (const error of report.syntax) console.error(`${error.file}:${error.line}:${error.column}: ${error.message}`);
  }
  process.exitCode = report.status === 'failed' ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Hermes check tool error: ' + String(error)); process.exitCode = 2; });
}
