// REQ-125 U0 (research/290 2.9·2.10, 291 F6·F7, 292 J2~J4): every folder the workflow reading lists goes through one
// function that holds the folder (opened part by part, never through a link) and lists through that hold only, counting
// entries, listings and listings at once against caps. Here the file system calls are watched (node:fs/promises, the ESM
// view kept in step) and the folder is swapped at the moment between the boundary check and the listing: nothing outside
// the workspace is listed or opened. Everything is a made-up workspace in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readWorkflow, WORKFLOW_LIMITS, LISTING_BUFFER } from '../dist/server/workflow.js';
import { WORKFLOW_DEFINITION_PATH } from '../dist/shared/workflow.js';

const words = { pass: ['통과'], conditional: ['조건부'], fail: ['불통과'] };
const definition = (sources) => ({
  format: 'paseo-kanban.workflow/1', name: '합성 절차', releaseKey: 'semver',
  stages: [{ id: 'impl', label: '구현', shape: 'box', row: 0, col: 0 }, { id: 'gate', label: '게이트', shape: 'box', row: 0, col: 1 }],
  edges: [{ from: 'impl', to: 'gate' }], sources,
});
const gate = files => ({ stage: 'gate', read: 'verdict', round: 'first', files, markers: ['종합 판정'], words, release: 'name-version' });
const names = files => ({ stage: 'impl', read: 'names', files });
const report = n => `# ${n}\n## 종합 판정: 통과\n`;

async function place(t) {
  const top = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'kanban-u0-')));
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  const cwd = join(top, 'workspace'), outside = join(top, 'outside');
  await fs.mkdir(join(cwd, '.kanban'), { recursive: true });
  await fs.mkdir(outside);
  return { top, cwd, outside };
}
const define = (cwd, sources) => fs.writeFile(join(cwd, WORKFLOW_DEFINITION_PATH), JSON.stringify(definition(sources)));

/**
 * Where a path the module names really points at the moment of the call: `/proc/self/fd/<n>/rest` read through the open
 * handle, then links followed — all of them for a call that follows links, all but the last part for one that does not
 * (`lstat`, an open with O_NOFOLLOW).
 */
function target(p, follow = true) {
  const m = String(p).match(/^\/proc\/self\/fd\/(\d+)(\/.*)?$/);
  let named = String(p);
  if (m) try { named = readlinkSync(`/proc/self/fd/${m[1]}`) + (m[2] ?? ''); } catch { /* closed */ }
  try { return follow ? realpathSync(named) : join(realpathSync(dirname(named)), basename(named)); } catch { return named; }
}
/**
 * Runs `body` with node:fs/promises watched: every listing (`readdir`, `opendir`) and every open, stat and read, by where
 * it points at the moment of the call; entries handed out by each listing, the buffer each asked for, the most listings
 * open at once. `swap(name, path)` may change the disk right after a call (`realpath` hooks the boundary check).
 */
async function watched(body, { swap = async () => {}, readlink } = {}) {
  const fsp = createRequire(import.meta.url)('node:fs/promises'), saved = {};
  const seen = { listed: [], opened: [], buffers: [], entries: 0, perFolder: new Map(), open: 0, most: 0 };
  const hook = (name, make) => { saved[name] = fsp[name]; fsp[name] = make(saved[name]); };
  hook('realpath', real => async (p, ...rest) => { const out = await real(p, ...rest); await swap('realpath', String(p)); return out; });
  hook('readdir', readdir => async (p, ...rest) => {
    const where = target(p);
    seen.listed.push(where);
    const names = await readdir(p, ...rest);
    seen.entries += names.length; seen.perFolder.set(where, (seen.perFolder.get(where) ?? 0) + names.length);
    return names;
  });
  hook('opendir', opendir => async (p, options) => {
    const where = target(p);
    seen.listed.push(where); seen.buffers.push(options?.bufferSize);
    const dir = await opendir(p, options);
    seen.open++; seen.most = Math.max(seen.most, seen.open);
    const read = dir.read.bind(dir), close = dir.close.bind(dir);
    dir.read = async () => { const entry = await read(); if (entry) { seen.entries++; seen.perFolder.set(where, (seen.perFolder.get(where) ?? 0) + 1); } return entry; };
    dir.close = async () => { seen.open--; await swap('close', where); return close(); };
    await swap('opendir', where);
    return dir;
  });
  const follows = (name, flags) => name === 'stat' || name === 'readFile' || (name === 'open' && !(typeof flags === 'number' && flags & constants.O_NOFOLLOW));
  for (const name of ['open', 'stat', 'lstat', 'readFile'])
    hook(name, original => async (p, ...rest) => { seen.opened.push(target(p, follows(name, rest[0]))); return original(p, ...rest); });
  if (readlink) hook('readlink', readlink);
  syncBuiltinESMExports();
  try { return { value: await body(), seen }; } finally { Object.assign(fsp, saved); syncBuiltinESMExports(); }
}
const under = (base, p) => p === base || p.startsWith(base + '/');

test('U0 F6 the folder swapped for a link outside right after its boundary check: nothing outside is listed or opened', async t => {
  const { top, cwd, outside } = await place(t);
  await fs.mkdir(join(cwd, 'docs'));
  await fs.writeFile(join(cwd, 'docs', '10_v0110_게이트검증.md'), report(10));
  await fs.writeFile(join(outside, '90_v0190_게이트검증.md'), report(90));
  await define(cwd, [gate(['docs/*_게이트검증.md'])]);
  let swapped = 0;
  const { value: m, seen } = await watched(() => readWorkflow(cwd), { swap: async (call, p) => {
    if (call !== 'realpath' || p !== join(cwd, 'docs') || swapped++) return;
    await fs.rename(join(cwd, 'docs'), join(top, 'stash'));
    await fs.symlink(outside, join(cwd, 'docs'));
  } });
  assert.equal(swapped, 1, 'the swap happened between the check and the listing');
  assert.deepEqual(seen.listed.filter(p => under(outside, p)), [], 'no folder outside is listed');
  assert.deepEqual(seen.opened.filter(p => under(outside, p)), [], 'nothing outside is opened, stat\'ed or read');
  assert.ok(!m.reports.some(e => e.doc === 90 || e.doc === 10), 'neither the outside report nor the moved one is reported');
  assert.ok(!JSON.stringify(m).includes('90_v0190'), 'no name outside reaches the reply');
});

test('U0 F6 a folder above swapped for a link outside: the hold stops at that part, nothing outside is opened', async t => {
  const { top, cwd, outside } = await place(t);
  await fs.mkdir(join(cwd, 'a', 'b'), { recursive: true });
  await fs.writeFile(join(cwd, 'a', 'b', '11_v0111_게이트검증.md'), report(11));
  await fs.mkdir(join(outside, 'b'));
  await fs.writeFile(join(outside, 'b', '91_v0191_게이트검증.md'), report(91));
  await define(cwd, [gate(['a/b/*_게이트검증.md'])]);
  let swapped = 0;
  const { value: m, seen } = await watched(() => readWorkflow(cwd), { swap: async (call, p) => {
    if (call !== 'realpath' || p !== join(cwd, 'a', 'b') || swapped++) return;
    await fs.rename(join(cwd, 'a'), join(top, 'stash-a'));
    await fs.symlink(outside, join(cwd, 'a'));
  } });
  assert.equal(swapped, 1);
  assert.deepEqual(seen.listed.filter(p => under(outside, p)), [], 'no folder outside is listed');
  assert.deepEqual(seen.opened.filter(p => under(outside, p)), [], 'no folder outside is opened — not even held and let go');
  assert.ok(seen.opened.includes(join(cwd, 'a')), 'the hold tried the swapped part itself (a link, not followed)');
  assert.ok(!m.reports.some(e => e.doc === 91 || e.doc === 11));
});

test('U0 F6 dangling links: one there from the start and one swapped in after the check are neither listed nor an error', async t => {
  const { top, cwd } = await place(t);
  await fs.mkdir(join(cwd, 'docs'));
  await fs.writeFile(join(cwd, 'docs', '12_v0112_게이트검증.md'), report(12));
  await fs.symlink(join(top, 'nowhere'), join(cwd, 'dangling'));
  await fs.mkdir(join(cwd, 'kept'));
  await fs.writeFile(join(cwd, 'kept', '13_v0113_게이트검증.md'), report(13));
  await define(cwd, [gate(['dangling/*_게이트검증.md', 'kept/*_게이트검증.md', 'docs/*_게이트검증.md'])]);
  let swapped = 0;
  const { value: m, seen } = await watched(() => readWorkflow(cwd), { swap: async (call, p) => {
    if (call !== 'realpath' || p !== join(cwd, 'kept') || swapped++) return;
    await fs.rename(join(cwd, 'kept'), join(top, 'stash-kept'));
    await fs.symlink(join(top, 'nowhere-either'), join(cwd, 'kept'));
  } });
  assert.equal(m.defined, true);
  assert.deepEqual(m.reports.map(e => e.doc), [12], 'the plain folder is still read');
  assert.deepEqual(m.limits, [], 'a link that leads nowhere is not a cap');
  assert.ok(!seen.listed.some(p => p.includes('nowhere')));
});

test('U0 F6 the held folder moved out of the workspace while listed: its entries go unused', async t => {
  const { top, cwd } = await place(t);
  await fs.mkdir(join(cwd, 'docs'));
  await fs.writeFile(join(cwd, 'docs', '14_v0114_게이트검증.md'), report(14));
  await define(cwd, [gate(['docs/*_게이트검증.md'])]);
  let moved = 0;
  const { value: m, seen } = await watched(() => readWorkflow(cwd), { swap: async (call, p) => {
    if (call !== 'opendir' || p !== join(cwd, 'docs') || moved++) return;
    await fs.rename(join(cwd, 'docs'), join(top, 'moved-out'));
  } });
  assert.equal(moved, 1);
  assert.deepEqual(m.reports, [], 'what was listed is not used once the folder is no longer where it was checked');
  assert.deepEqual(seen.opened.filter(p => under(join(top, 'moved-out'), p)), [], 'no file of it is opened');
});

test('U0 F7 a folder of 10,000 entries: at most the per-folder cap is read, through a small buffer, and the cut is said', async t => {
  const { cwd } = await place(t);
  await fs.mkdir(join(cwd, 'big'));
  await Promise.all(Array.from({ length: 10_000 }, (_, i) => fs.writeFile(join(cwd, 'big', `n${String(i).padStart(5, '0')}.md`), '')));
  await define(cwd, [names(['big/*.md'])]);
  const { value: m, seen } = await watched(() => readWorkflow(cwd));
  const big = seen.perFolder.get(join(cwd, 'big'));
  assert.ok(big <= WORKFLOW_LIMITS.folderEntries, `entries read from the folder: ${big}`);
  assert.equal(big, 5000);
  assert.ok(seen.buffers.every(b => b === LISTING_BUFFER) && LISTING_BUFFER <= 32, 'every listing asks for a small buffer');
  assert.ok(m.limits.includes('folder-entries:big'), 'the cut folder is said');
  assert.ok(m.limits.includes('files-per-pattern:big/*.md'), 'the old cap on matches still applies after it');
  assert.equal(m.totals.find(x => x.stage === 'impl').all.count, WORKFLOW_LIMITS.filesPerPattern);
  // Entries over the whole reading: a smaller cap stops in the middle of the folder.
  const small = await watched(() => readWorkflow(cwd, { limits: { ...WORKFLOW_LIMITS, visits: 1234 } }));
  assert.equal(small.seen.entries, 1234, 'one listing, stopped at the cap');
  assert.ok(small.value.limits.includes('visits'));
});

test('U0 F7 a wide pattern over several parts: listings and entries stop at their caps, at most four listings at once', async t => {
  const { cwd } = await place(t);
  for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) {
    const dir = join(cwd, 'w', `d${i}`, `e${j}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `x_${i}_${j}.md`), '');
  }
  const wide = ['w/*/*/*.md', 'w/*/*/x_*.md', 'w/d*/*/*.md', 'w/*/e*/*.md', 'w/*/*/*_1.md', 'w/*/*/*_2.md', 'w/d*/e*/*.md', 'w/*/*/x*'];
  await define(cwd, [names(wide)]);
  const full = await watched(() => readWorkflow(cwd));
  // 1 + 15 + 225 listings per pattern, eight patterns read at once.
  assert.equal(full.seen.listed.length, 8 * 241);
  assert.deepEqual(full.value.limits, [], 'under the default caps everything is read');
  assert.equal(full.value.totals.find(x => x.stage === 'impl').all.count, 225, 'each file once, though eight patterns match it');
  assert.ok(full.seen.most <= WORKFLOW_LIMITS.concurrentListings && full.seen.most >= 2, `listings at once: ${full.seen.most}`);
  const capped = await watched(() => readWorkflow(cwd, { limits: { ...WORKFLOW_LIMITS, listings: 100 } }));
  assert.equal(capped.seen.listed.length, 100, 'no listing starts past the cap');
  assert.ok(capped.value.limits.includes('listings'));
  const visits = await watched(() => readWorkflow(cwd, { limits: { ...WORKFLOW_LIMITS, visits: 700 } }));
  assert.ok(visits.seen.entries <= 700, `entries read: ${visits.seen.entries}`);
  assert.ok(visits.value.limits.includes('visits'));
  const one = await watched(() => readWorkflow(cwd, { limits: { ...WORKFLOW_LIMITS, concurrentListings: 1 } }));
  assert.equal(one.seen.most, 1);
  assert.equal(one.value.key, full.value.key, 'waiting for a turn changes nothing read');
});

test('U0 F6 a host that cannot list through a held folder lists nothing and says so — never by name instead', async t => {
  const { cwd } = await place(t);
  await fs.mkdir(join(cwd, 'docs'));
  await fs.writeFile(join(cwd, 'docs', '15_v0115_게이트검증.md'), report(15));
  await define(cwd, [gate(['docs/*_게이트검증.md'])]);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let mac;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  try { mac = await watched(() => readWorkflow(cwd)); } finally { Object.defineProperty(process, 'platform', platform); }
  assert.deepEqual(mac.seen.listed, [], 'not Linux: no folder is listed');
  assert.deepEqual(mac.value.reports, []);
  assert.deepEqual(mac.value.limits, ['listing-unsupported']);
  // Linux with no /proc/self/fd (a container without /proc): the same.
  const noProc = await watched(() => readWorkflow(cwd), { readlink: readlink => async (p, ...rest) => {
    if (String(p).startsWith('/proc/self/fd/')) throw Object.assign(new Error('no /proc'), { code: 'ENOENT' });
    return readlink(p, ...rest);
  } });
  assert.deepEqual(noProc.seen.listed, []);
  assert.deepEqual(noProc.value.reports, []);
  assert.deepEqual(noProc.value.limits, ['listing-unsupported']);
  const linux = await readWorkflow(cwd);
  assert.deepEqual(linux.reports.map(e => e.doc), [15]);
});

test('U0 the reading module lists folders in one place only, through the held folder', async () => {
  const source = await fs.readFile(new URL('../server/workflow.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/fs\.readdir\(/g) ?? []).length, 0, 'no listing by name');
  assert.equal((source.match(/fs\.opendir\(/g) ?? []).length, 1, 'one listing, in listFolder');
  assert.match(source, /fs\.opendir\(at\(folderHeld\)/);
});
