import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

test('build layout supports optional external cache links', async () => {
  const root = await fs.realpath('.');
  for (const name of ['node_modules', 'dist']) {
    const info = await fs.lstat(name);
    if (!info.isSymbolicLink()) { assert.notEqual(process.env.KANBAN_REQUIRE_BUILD_CACHE, '1'); assert.equal(info.isDirectory(), true); continue; }
    const target = await fs.realpath(name); const rel = relative(root, target);
    assert.ok(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  }
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.equal(pkg.private, true); assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.ok(pkg.devDependencies.typescript);
  assert.ok(pkg.devDependencies['@getpaseo/plugin']);
  assert.equal(pkg.exports['./core'].import, './dist/server/core/index.js');
});
test('core source has no network clients, package aliases, dynamic require or module-relative file reads', async () => {
  for (const directory of ['shared/core', 'server/core']) for (const name of await fs.readdir(directory)) {
    const source = await fs.readFile(resolve(directory, name), 'utf8');
    assert.doesNotMatch(source, /https?:|\bfetch\s*\(|node:(http|https|net|tls)|import\.meta\.url|\brequire\s*\(/);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('./') || match[1].startsWith('../../shared/core/') || match[1].startsWith('node:'));
  }
});
