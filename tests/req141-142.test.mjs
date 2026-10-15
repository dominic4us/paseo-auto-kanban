// REQ-141 (research/337, public release): the plugin id and package name are paseo-auto-kanban, the names that hold
// data or files stay as they were (D2), the license is Apache-2.0, and a new install starts in English while an
// existing one keeps Korean (W1, D3). REQ-142 (research/336): "Go to agent" asks first off the workspace being looked at
// — the screens are exercised in plugin-ui.test.mjs ("REQ-142") and tests/web/run.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from '../dist/server/core/store.js';
import { createReadHandlers, FALLBACK_LOCALE, readLocale } from '../dist/server/handlers.js';
import { WORKFLOW_FORMAT, WORKFLOW_FORMAT_2 } from '../dist/shared/workflow.js';
import { jumpFor, leavesWorkspace } from '../dist/client/agent-jump.js';
import { DEV_DEMO_KEY } from '../dist/client/demo.js';
import { testTmpdir } from './helpers.mjs';

const read = async file => fs.readFile(new URL('../' + file, import.meta.url), 'utf8');

test('REQ-141 W2 the plugin id and package name are paseo-auto-kanban; the data, file and command names stay (D2)', async () => {
  const manifest = JSON.parse(await read('paseo-plugin.json')), pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(manifest.id, 'paseo-auto-kanban');
  assert.match(manifest.id, /^[a-z][a-z0-9-]*$/, 'as Paseo validates a plugin id');
  assert.deepEqual([pkg.name, lock.name, lock.packages[''].name], ['paseo-auto-kanban', 'paseo-auto-kanban', 'paseo-auto-kanban']);
  // Kept: the CLI and its old alias, the formats and markers in files people keep, the data folder, the browser keys.
  assert.deepEqual(pkg.bin, { kanban: 'dist/src/cli/main.js', 'paseo-kanban': 'dist/src/cli/main.js' });
  assert.deepEqual([WORKFLOW_FORMAT, WORKFLOW_FORMAT_2], ['paseo-kanban.workflow/1', 'paseo-kanban.workflow/2']);
  assert.match(await read('server/core/store.ts'), /environment\.KANBAN_DATA_DIR \?\? path\.join\(home, 'paseo-kanban-data'\)/);
  assert.match(await read('server/core/export.ts'), /<!-- paseo-kanban:generated:v1 board=/);
  assert.equal(DEV_DEMO_KEY, 'paseo-kanban:dev-demo');
});

test('REQ-141 W5·W7 Apache-2.0: the full license text with its copyright line, and the package metadata', async () => {
  const license = await read('LICENSE'), pkg = JSON.parse(await read('package.json'));
  assert.match(license, /^\s+Apache License\n\s+Version 2\.0, January 2004\n/);
  assert.match(license, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match(license, /\n   Copyright 2026 panto-dominic\n/);
  assert.doesNotMatch(license, /\[yyyy\]|\[name of copyright owner\]/, 'the placeholder is filled in');
  assert.equal(license.split('\n').length, 203, 'the whole text, 202 lines');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.author, 'panto-dominic');
  assert.ok(pkg.description.length > 20);
  const home = 'https://github.com/panto-dominic/paseo-auto-kanban';
  assert.deepEqual([pkg.homepage, pkg.repository, pkg.bugs], [home + '#readme', { type: 'git', url: 'git+' + home + '.git' }, { url: home + '/issues' }]);
  assert.ok(pkg.keywords.includes('paseo') && pkg.keywords.includes('kanban'));
  assert.equal(pkg.private, true, 'still not published to npm — it installs from git');
  assert.ok((await read('NOTICE')).startsWith('paseo-auto-kanban\n'));
  // The Lucide-derived crown and medal ship with Lucide's full licence text (ISC and the Feather MIT it carries), linked from NOTICE.
  const notice = await read('NOTICE'), lucide = await read('licenses/lucide-LICENSE.txt');
  assert.ok(notice.includes('licenses/lucide-LICENSE.txt') && /"crown"/.test(notice) && /"award"/.test(notice));
  assert.ok(lucide.startsWith('ISC License\n') && lucide.includes('The MIT License (MIT)') && lucide.includes('Permission to use, copy, modify'));
  assert.match(notice, /Copyright \(c\) 2025-present Mohamed Boudra/);
});

async function emptyData(t) {
  const root = await fs.mkdtemp(join(await testTmpdir(), 'kanban-locale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  return { dataDir, store: await openStore({ dataDir }), config: join(dataDir, 'config.json') };
}
test('REQ-141 W1 a new install (no config.json) reads English; a config.json without locale keeps Korean; a set locale wins', async t => {
  const { dataDir, store, config } = await emptyData(t);
  assert.equal(await readLocale(store), 'en', 'nothing written yet: a new install');
  await assert.rejects(fs.stat(dataDir), 'reading the language writes nothing');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, exportEnabled: true, export: { detail: 'compact' } }));
  assert.equal(await readLocale(store), 'ko', 'an earlier build\'s config without locale stays Korean');
  for (const locale of ['en', 'ko']) {
    await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, exportEnabled: true, locale, export: { detail: 'compact' } }));
    assert.equal(await readLocale(store), locale);
  }
});
test('REQ-141 W1 the screens read English on a new install, and fall back to English when the setting cannot be read', async t => {
  assert.equal(FALLBACK_LOCALE, 'en');
  const { dataDir, store, config } = await emptyData(t);
  const handlers = createReadHandlers(store, () => '2026-10-15T00:00:00.000Z');
  const fresh = await handlers.overview({});
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal(fresh.data.locale, 'en');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(config, '{ not json');
  const broken = await handlers.overview({});
  assert.equal(broken.ok, true);
  assert.equal(broken.data.locale, 'en', 'the fallback');
  assert.ok(broken.data.errors.length >= 1, 'and the error is said');
});

test('REQ-142 "Go to agent" asks unless the screen\'s workspace and the agent\'s own are both known and the same', () => {
  assert.equal(leavesWorkspace('wks_a', 'wks_a'), false);
  assert.equal(leavesWorkspace('wks_a', 'wks_b'), true);
  assert.equal(leavesWorkspace(undefined, 'wks_a'), true, 'the overview is in no workspace');
  assert.equal(leavesWorkspace('wks_a', undefined), true, 'a board not known');
  assert.equal(leavesWorkspace(undefined, undefined), true);
  const calls = [], navigation = { openAgent: input => calls.push(['agent', input]), openWorkspace: input => calls.push(['workspace', input]) };
  const asked = [], open = agentId => asked.push(agentId);
  jumpFor(navigation, 'agent-1', { workspaceId: 'wks_b', hasLedger: true }, open).go();
  jumpFor(navigation, undefined, { workspaceId: 'wks_b', hasLedger: true }, open).go();
  assert.deepEqual(asked, ['agent-1'], 'an agent goes through the guard, which reads the agent\'s own workspace (gate 340 F1)');
  assert.deepEqual(calls, [['workspace', { workspaceId: 'wks_b' }]], 'a workspace opens at once');
});
