import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { checkPlugin, compileBytecode, findTools, inspectSourceSyntax } from '../scripts/check-hermes.mjs';
import { createKanbanError, isKanbanError } from '../dist/shared/core/domain.js';

const required = process.env.KANBAN_REQUIRE_HERMES === undefined
  ? Boolean(process.env.CI && process.env.CI !== 'false') : process.env.KANBAN_REQUIRE_HERMES === '1';
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kanban-hermes-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('exact client and every shared module eagerly compile with the app-generation Hermes compiler', async t => {
  const result = await checkPlugin(resolve('.'), { required });
  if (result.status === 'skipped') { t.skip(result.reason); return; }
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.syntax, []);
  assert.ok(result.sharedFiles.includes('shared/core/domain.ts'));
  assert.ok(result.sharedFiles.includes('shared/rpc.ts'));
  assert.deepEqual(result.checks.map(c => c.name), ['client', 'shared-all']);
  for (const check of result.checks) {
    assert.equal(check.status, 'passed', check.diagnostic);
    assert.ok(check.bundleBytes > 0);
  }
  t.diagnostic(JSON.stringify({ engine: result.engineVersion.match(/Hermes release version: .*/)?.[0],
    checks: result.checks.map(c => ({ name: c.name, bytes: c.bundleBytes, sha256: c.bundleSha256 })) }));
});
test('actual hermesc rejects a deliberate class in a temporary JS file', t => {
  const tools = findTools(resolve('.'), { bundle: true, required });
  if (tools.status === 'skipped') { t.skip(tools.reason); return; }
  const directory = temporary(t);
  // Bypass the source policy: prove the bytecode compiler itself catches the observed failure.
  const outcome = compileBytecode('class DeliberateProbe { read() { return 1; } }\nnew DeliberateProbe().read();\n',
    tools.hermesc, directory, 'deliberate-class');
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.diagnostic, /error:.*invalid (?:expression|statement)/i);
});
test('source policy catches dormant classes, async generators, v, using and top-level await', t => {
  const directory = temporary(t);
  for (const [name, source] of Object.entries({
    declaration: 'class Hidden {}', expression: 'const hidden = class { static { } #value; };',
    generator: 'async function* hidden() { yield 1; }',
    method: 'const hidden = { async *read() { yield 1; } };',
    regexp: 'const hidden = /[a-z]/v;', using: 'using hidden = acquire();',
    awaitUsing: 'await using hidden = acquire();', await: 'await Promise.resolve();',
    awaitLoop: 'for await (const x of stream) { consume(x); }',
  })) {
    const file = join(directory, name + '.ts'); writeFileSync(file, source);
    assert.ok(inspectSourceSyntax([file]).length > 0, name);
  }
  const safe = join(directory, 'safe.ts');
  writeFileSync(safe, 'interface Safe extends Error {}\nasync function read() { await request(); }\nconst pattern = /(?<word>a)/d;\n');
  assert.deepEqual(inspectSourceSyntax([safe]), []);
});
test('missing explicitly configured tools fail instead of silently skipping', async t => {
  const absent = join(temporary(t), 'missing-compiler.js');
  await assert.rejects(checkPlugin(resolve('.'), { compiler: absent }), /Configured Paseo compiler/);
});
test('error factory preserves enumerable payload, defaults and native Error identity across realms', () => {
  const error = createKanbanError('E_VALIDATION', 'Invalid input.');
  assert.ok(error instanceof Error); assert.ok(isKanbanError(error));
  assert.deepEqual(Object.keys(error), ['code', 'target', 'nextAction', 'details', 'committed', 'name']);
  assert.equal(JSON.stringify(error), '{"code":"E_VALIDATION","target":"","nextAction":"Review the input and retry.","details":null,"committed":false,"name":"KanbanError"}');
  const foreign = vm.runInNewContext(`Object.assign(new Error('Invalid input.'), ${JSON.stringify(error)})`);
  assert.equal(foreign instanceof Error, false); assert.ok(isKanbanError(foreign));
  for (const invalid of [null, undefined, {}, new Error('Other'), { ...error },
    Object.assign(new Error('Other'), { ...error, committed: true })]) assert.equal(isKanbanError(invalid), false);
});
test('CLI error stderr, JSON bytes and exit codes remain unchanged for every error family', () => {
  const environment = { ...process.env };
  delete environment.PASEO_AGENT_CWD; delete environment.PASEO_AGENT_ID; delete environment.KANBAN_DATA_DIR;
  for (const [code, status] of [['E_USAGE', 2], ['E_NOT_FOUND', 3], ['E_REVISION_CONFLICT', 4],
    ['E_LOCK_TIMEOUT', 5], ['E_IO', 6], ['E_CORRUPT', 7]]) {
    for (const json of [false, true]) {
      const script = `import {createKanbanError} from './dist/shared/core/domain.js';
        import {printError} from './dist/src/cli/format.js';
        printError(createKanbanError('${code}', 'Example failure.', 'example', 'Try again.',
          {revision:'example'}, 'unknown'), ${json});`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: resolve('.'), env: environment, encoding: 'utf8',
      });
      assert.equal(result.status, status);
      assert.equal(result.stderr, `${code}: Example failure. [example] Next: Try again.\n`);
      assert.equal(result.stdout, json ? `{"ok":false,"error":{"code":"${code}","message":"Example failure.","target":"example","nextAction":"Try again.","details":{"revision":"example"}},"committed":"unknown"}\n` : '');
    }
  }
});
