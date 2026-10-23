import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

/**
 * D66 G2b (research/498): the previous public releases, run for real. `fixtures/previous-release/manifest.json` pins each
 * release's unmodified sources (the store, the validator, the engine's memory and the engine itself, with what they import)
 * and their SHA-256; they are transpiled once per test process into a disposable folder and imported from there — no Git
 * history, prebuilt archive or network at test time. Each release's `data/` holds the data folder that release itself
 * wrote (`make-data.mjs`), so an upgrade is tested on the bytes an installed board really has.
 */
const FIXTURE = new URL('./fixtures/previous-release/', import.meta.url);
const NODE_MODULES = fileURLToPath(new URL('../node_modules', import.meta.url));
export const RELEASES = ['0.2.3', '0.2.4'];
const loaded = new Map();
let root = null;

export async function previousRelease(release) {
  if (loaded.has(release)) return loaded.get(release);
  // To cross-check the transpiled sources against that release's own build: KANBAN_PREVIOUS_DIST_0_2_4=<its dist>.
  const dist = process.env['KANBAN_PREVIOUS_DIST_' + release.replace(/\./g, '_')];
  if (dist) {
    const load = path => import(pathToFileURL(join(dist, path)).href);
    const value = { release, commit: null, built: dist, ...await load('shared/core/domain.js'), ...await load('server/core/auto-state.js'),
      ...await load('server/core/store.js'), ...await load('server/auto-cards.js') };
    loaded.set(release, value);
    return value;
  }
  const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', FIXTURE), 'utf8'));
  const pinned = manifest.releases.find(r => r.release === release);
  assert.ok(pinned, 'pinned release ' + release);
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'kanban-previous-'));
    process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  }
  const runtime = join(root, release);
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(join(runtime, 'package.json'), '{"type":"module"}');
  // The engine imports zod and the plugin SDK, resolved from this checkout's own dependencies.
  await fs.symlink(NODE_MODULES, join(runtime, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error; });
  for (const file of pinned.files) {
    const bytes = await fs.readFile(new URL(`${release}/src/${file.path}`, FIXTURE));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `the ${release} source ${file.path} must stay unmodified`);
    const output = join(runtime, file.path.replace(/\.ts$/, '.js'));
    await fs.mkdir(join(output, '..'), { recursive: true });
    await fs.writeFile(output, ts.transpileModule(bytes.toString(), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  }
  const load = path => import(pathToFileURL(join(runtime, path)).href);
  const value = { release, commit: pinned.commit, ...await load('shared/core/domain.js'), ...await load('server/core/auto-state.js'),
    ...await load('server/core/store.js'), ...await load('server/auto-cards.js') };
  loaded.set(release, value);
  return value;
}

/** A copy of the data folder `release` wrote (`fixtures/previous-release/<release>/data`), in `dataDir`. */
export async function previousData(release, dataDir) {
  await fs.cp(fileURLToPath(new URL(`${release}/data/`, FIXTURE)), dataDir, { recursive: true });
  return JSON.parse(await fs.readFile(new URL(`${release}/expected.json`, FIXTURE), 'utf8'));
}

/** Every file of a data folder with its bytes, for "nothing was written" checks. */
export async function folderBytes(dir) {
  const out = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath ?? entry.path, entry.name);
    out[file.slice(dir.length + 1)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  }
  return out;
}
