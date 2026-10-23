// REQ-156 (research/478 (A), research/485): the new-version notice — the server asks the npm registry for this package's latest
// version number at most once a day, only when a screen reads, silently on any failure, never while switched off; the answer is a
// release number or nothing; the screens get on/off, the newer release and when it was checked. Every network call here is a fake
// `fetch`; nothing reaches the registry. Made-up folders only, each in a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { bootDue, checkDue, isNewer, parseRelease, parseVersion, restampDue, UPDATE_CHECK_INTERVAL_MS, UPDATE_COMMANDS } from '../dist/shared/update-check.js';
import { askRegistry, createUpdateChecker, readUpdateCache, readUpdateCheck, readUpdateSetting, REGISTRY_URL, RESPONSE_LIMIT, UPDATE_CACHE_FILE, UPDATE_CHECK_BACKUP,
  UPDATE_CHECK_FILE, updateCheckView } from '../dist/server/update-check.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { PACKAGE_VERSION } from '../dist/server/version.js';
import { boardGet, overviewGet, updateCheckSet } from '../dist/shared/rpc.js';
import { checkedTime, updateDot, updateLine, updateState } from '../dist/client/update-model.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, testTmpdir } from './helpers.mjs';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const T0 = Date.parse('2026-10-19T00:00:00.000Z');
const DAY = UPDATE_CHECK_INTERVAL_MS;

async function folder(t) {
  const root = await mkdtemp(join(await testTmpdir(), 'kanban-req156-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'data');
}
/** A fake registry: each call recorded with what it was given; `answer` decides the reply. */
function registry(answer = () => json({ name: 'paseo-auto-kanban', version: '9.9.9' })) {
  const calls = [];
  const fetch = (url, init) => { calls.push({ url, init }); return answer(url, init); };
  return { calls, fetch, set answer(next) { answer = next; } };
}
const json = (value, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, body: null, text: async () => JSON.stringify(value) });
function checker(dataDir, fake, clock = { now: T0 }, running = '0.2.5', timeoutMs = 5000) {
  return { clock, updates: createUpdateChecker({ dataDir, running, now: () => clock.now, fetch: fake.fetch, timeoutMs }) };
}
/** Gate 486: the setting (and its backup) and the cache are separate files; `changedAt` is when the switch was last saved. */
const settingOf = async dataDir => { const { changedAt, ...rest } = JSON.parse(await fs.readFile(join(dataDir, UPDATE_CHECK_FILE), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(changedAt))); return rest; };
const cacheOf = async dataDir => JSON.parse(await fs.readFile(join(dataDir, UPDATE_CACHE_FILE), 'utf8'));
/** Nothing printed while `run` runs — the checks are silent. */
async function silent(run) {
  const said = [], keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const key of Object.keys(keep)) console[key] = (...args) => said.push(key + ': ' + args.join(' '));
  try { await run(); } finally { Object.assign(console, keep); }
  return said;
}

test('REQ-156 versions: release numbers only, semver order, pre-releases never offered, odd strings refused', () => {
  assert.deepEqual(parseVersion('0.2.5'), { major: 0, minor: 2, patch: 5, pre: null });
  assert.deepEqual(parseVersion('1.0.0-beta.2'), { major: 1, minor: 0, patch: 0, pre: 'beta.2' });
  for (const bad of ['v0.2.5', '0.2', '0.2.5.256', '00.2.5', '0.02.5', '0.2.05', '0.2.5+build.1', ' 0.2.5', '0.2.5 ', '0.2.5\n', '0.2.x',
    '99999999999999999999.0.0', '0.2.5-', '0.2.5-beta..1', '<script>0.2.5', '', null, undefined, 25, {}, '1.0.0-' + 'a'.repeat(60)])
    assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(parseRelease('0.2.6'), '0.2.6'); assert.equal(parseRelease('0.2.6-rc.1'), null); assert.equal(parseRelease('latest'), null);
  const newer = [['0.2.5', '0.2.4'], ['0.2.10', '0.2.9'], ['0.3.0', '0.2.99'], ['1.0.0', '0.99.99'], ['10.0.0', '9.0.0'], ['0.2.5', '0.2.5-beta.1']];
  for (const [latest, running] of newer) assert.equal(isNewer(latest, running), true, latest + ' > ' + running);
  const notNewer = [['0.2.4', '0.2.4'], ['0.2.4', '0.2.5'], ['0.2.9', '0.2.10'], ['0.2.6-rc.1', '0.2.5'], ['0.2.5-beta.2', '0.2.5-beta.1'],
    ['0.2.5', 'harness'], ['nonsense', '0.2.4'], [undefined, '0.2.4'], ['0.2.5', undefined]];
  for (const [latest, running] of notNewer) assert.equal(isNewer(latest, running), false, latest + ' vs ' + running);
  // The running plugin's own version is readable, so the comparison can say "newer" for this build.
  assert.ok(parseVersion(PACKAGE_VERSION), PACKAGE_VERSION);
});

test('REQ-156 interval: due with no look and a day after the last; the clock gone back is never due, more than a day back restamps (gate 490 R2)', () => {
  const at = new Date(T0).toISOString();
  assert.equal(checkDue(undefined, T0), true); assert.equal(checkDue('not a date', T0), true);
  assert.equal(checkDue(at, T0), false); assert.equal(checkDue(at, T0 + DAY - 1), false); assert.equal(checkDue(at, T0 + DAY), true);
  assert.equal(checkDue(at, T0 - 60_000), false, 'a minute of clock drift is not a reason to ask again');
  assert.equal(checkDue(at, T0 - 6 * 60_000), false, 'a last attempt in the future: the clock went back — wait');
  assert.equal(checkDue(at, T0 - DAY - 1), false); assert.equal(restampDue(at, T0 - DAY), false); assert.equal(restampDue(at, T0 - DAY - 1), true);
  assert.equal(restampDue(undefined, T0), false);
  // The boot's clock: within one boot a day of it as well; another boot or none known says nothing.
  const last = { attemptBoot: 'b1', attemptUptime: 1000 };
  assert.equal(bootDue(last, { boot: 'b1', ms: 1000 + DAY - 1 }), false); assert.equal(bootDue(last, { boot: 'b1', ms: 1000 + DAY }), true);
  assert.equal(bootDue(last, { boot: 'b2', ms: 5 }), true); assert.equal(bootDue(last, null), true); assert.equal(bootDue({}, { boot: 'b1', ms: 5 }), true);
});

test('REQ-156 schedule: the first read asks once, reads within the day ask nothing, the next day asks again; reads at once share one look', async t => {
  const dataDir = await folder(t), fake = registry(), { clock, updates } = checker(dataDir, fake);
  assert.deepEqual(await updates.state(), { enabled: true }, 'never looked: on, nothing known');
  await Promise.all(Array.from({ length: 5 }, () => updates.wake()));
  assert.equal(fake.calls.length, 1, 'five reads at once → one request');
  assert.deepEqual(await cacheOf(dataDir), { schemaVersion: 1, attemptAt: new Date(T0).toISOString(), checkedAt: new Date(T0).toISOString(), latest: '9.9.9' });
  // The first look writes the default "on" down (and its backup), so losing it later is not taken for a first install.
  assert.deepEqual(await settingOf(dataDir), { schemaVersion: 1, enabled: true });
  assert.equal(JSON.parse(await fs.readFile(join(dataDir, UPDATE_CHECK_BACKUP), 'utf8')).enabled, true);
  assert.deepEqual(await updates.state(), { enabled: true, newer: '9.9.9', checkedAt: new Date(T0).toISOString() });
  for (const step of [1, 60_000, 6 * 3600_000, DAY - 1]) { clock.now = T0 + step; await updates.wake(); }
  assert.equal(fake.calls.length, 1, 'within 24 hours nothing more is asked');
  clock.now = T0 + DAY; await updates.wake();
  assert.equal(fake.calls.length, 2, '24 hours later the next read asks again');
  // A new process (Paseo restarted) reads the stamp from the file: no request before the day is over.
  const again = checker(dataDir, fake, { now: T0 + DAY + 3600_000 });
  await again.updates.wake();
  assert.equal(fake.calls.length, 2);
});

test('REQ-156 request: one GET of the registry\'s latest document, nothing of the install in it, redirects refused', async t => {
  const dataDir = await folder(t), fake = registry(), { updates } = checker(dataDir, fake);
  await updates.wake();
  const [call] = fake.calls;
  assert.equal(call.url, REGISTRY_URL); assert.equal(REGISTRY_URL, 'https://registry.npmjs.org/paseo-auto-kanban/latest');
  assert.equal(call.init.method, undefined, 'GET'); assert.equal(call.init.body, undefined);
  assert.deepEqual(call.init.headers, { accept: 'application/json' });
  assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(call.init).sort(), ['headers', 'redirect', 'signal']);
});

test('REQ-156 off: switched off nothing is asked (not even days later) and nothing is shown; on again asks when the day is due', async t => {
  const dataDir = await folder(t), fake = registry(), { clock, updates } = checker(dataDir, fake);
  await updates.wake(); assert.equal(fake.calls.length, 1);
  assert.deepEqual(await updates.setEnabled(false), { enabled: false, changed: true });
  assert.deepEqual(await settingOf(dataDir), { schemaVersion: 1, enabled: false });
  assert.deepEqual(await updates.state(), { enabled: false });
  for (const step of [0, DAY, 2 * DAY, 30 * DAY]) { clock.now = T0 + step; await updates.wake(); }
  // A new process with the switch off asks nothing either.
  await checker(dataDir, fake, { now: T0 + 40 * DAY }).updates.wake();
  assert.equal(fake.calls.length, 1, 'off: zero requests');
  assert.deepEqual(await updates.setEnabled(false), { enabled: false, changed: false });
  assert.deepEqual(await updates.setEnabled(true), { enabled: true, changed: true });
  clock.now = T0 + 40 * DAY + 1; await updates.wake();
  assert.equal(fake.calls.length, 2, 'on again, the day due: the next read asks');
  await assert.rejects(updates.setEnabled('yes'));
});

test('REQ-156 off while asking: the answer that arrives afterwards is dropped and the switch stays off', async t => {
  const dataDir = await folder(t);
  let release;
  const fake = registry(() => new Promise(done => { release = () => done(json({ name: 'paseo-auto-kanban', version: '9.9.9' })); }));
  const { updates } = checker(dataDir, fake);
  const looking = updates.wake();
  // The request has started (under the lock) before the switch is saved.
  for (let i = 0; i < 1000 && !release; i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(fake.calls.length, 1);
  await updates.setEnabled(false);
  release(); await looking;
  assert.deepEqual(await settingOf(dataDir), { schemaVersion: 1, enabled: false });
  assert.deepEqual(await cacheOf(dataDir), { schemaVersion: 1, attemptAt: new Date(T0).toISOString() }, 'the answer is not kept');
  assert.deepEqual(await updates.state(), { enabled: false });
});

test('REQ-156 failures are silent: timeout, refused, non-200, odd answers — stamped for tomorrow, the last good answer kept (its seven days)', async t => {
  const odd = {
    refused: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    thrown: () => { throw new Error('fetch failed'); },
    status404: () => json({ error: 'Not found' }, 404),
    status500: () => json({}, 500),
    status204: () => Promise.resolve({ ok: true, status: 204, body: null, text: async () => '' }),
    notJson: () => Promise.resolve({ ok: true, status: 200, body: null, text: async () => '<html>captive portal</html>' }),
    nullJson: () => Promise.resolve({ ok: true, status: 200, body: null, text: async () => 'null' }),
    otherName: () => json({ name: 'some-other-package', version: '9.9.9' }),
    noName: () => json({ version: '9.9.9' }),
    preRelease: () => json({ name: 'paseo-auto-kanban', version: '9.9.9-rc.1' }),
    markup: () => json({ name: 'paseo-auto-kanban', version: '<b>9.9.9</b>' }),
    words: () => json({ name: 'paseo-auto-kanban', version: 'Update now at http://example.invalid' }),
    numeric: () => json({ name: 'paseo-auto-kanban', version: 999 }),
    tooBig: () => Promise.resolve({ ok: true, status: 200, body: null, text: async () => JSON.stringify({ name: 'paseo-auto-kanban', version: '9.9.9', pad: 'x'.repeat(RESPONSE_LIMIT) }) }),
    tooBigStream: () => Promise.resolve({ ok: true, status: 200, text: async () => { throw new Error('not used'); },
      body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(32)); } }) }),
    hangs: () => new Promise(() => {}),
    slowBody: () => Promise.resolve({ ok: true, status: 200, body: null, text: () => new Promise(() => {}) }),
  };
  for (const [name, answer] of Object.entries(odd)) {
    const dataDir = await folder(t), fake = registry(), { clock, updates } = checker(dataDir, fake, { now: T0 }, '0.2.5', 60);
    // A good answer first, a day later the odd one: the good one is kept, the odd one leaves no trace but the stamp.
    await updates.wake();
    clock.now = T0 + DAY; fake.answer = answer;
    const started = Date.now();
    const said = await silent(() => updates.wake());
    assert.deepEqual(said, [], name + ': nothing printed');
    assert.ok(Date.now() - started < 2000, name + ': bounded by the time limit');
    assert.deepEqual(await cacheOf(dataDir), { schemaVersion: 1, attemptAt: new Date(T0 + DAY).toISOString(),
      checkedAt: new Date(T0).toISOString(), latest: '9.9.9' }, name);
    clock.now = T0 + DAY + 3600_000; await updates.wake();
    assert.equal(fake.calls.length, 2, name + ': not asked again the same day');
  }
  // With nothing kept before, a failure shows no notice at all.
  const dataDir = await folder(t), fake = registry(odd.refused), { updates } = checker(dataDir, fake);
  await updates.wake();
  assert.deepEqual(await updates.state(), { enabled: true });
});

test('REQ-156 time limit: the real timer aborts a request that ignores nothing — 5 s by default, the signal is aborted', async () => {
  let signal;
  const value = await askRegistry((url, init) => { signal = init.signal; return new Promise(() => {}); }, 30);
  assert.equal(value, null); assert.equal(signal.aborted, true);
  // The streamed body is read within the limit and its reader cancelled past 256 KB.
  let cancelled = false;
  const big = await askRegistry(() => Promise.resolve({ ok: true, status: 200, text: async () => '', body: new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(100 * 1024)); }, cancel() { cancelled = true; } }) }), 2000);
  assert.equal(big, null); assert.equal(cancelled, true);
  const good = await askRegistry(() => Promise.resolve({ ok: true, status: 200, text: async () => '',
    body: new Blob([JSON.stringify({ name: 'paseo-auto-kanban', version: '0.2.6', description: 'x'.repeat(3000) })]).stream() }), 2000);
  assert.equal(good, '0.2.6');
});

test('REQ-156 damaged setting: nothing is asked and the screens are told; on or off writes a sound file again; a broken cache only makes the look due', async t => {
  for (const raw of ['{', 'null', '[]', '{"schemaVersion":2,"enabled":true}', '{"schemaVersion":1}', '{"schemaVersion":1,"enabled":"yes"}',
    JSON.stringify({ schemaVersion: 1, enabled: true, pad: 'x'.repeat(5000) })]) {
    const dataDir = await folder(t); await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(join(dataDir, UPDATE_CHECK_FILE), raw);
    const fake = registry(), { updates } = checker(dataDir, fake);
    assert.deepEqual(await updates.state(), { enabled: false, damaged: true }, raw.slice(0, 40));
    await updates.wake(); assert.equal(fake.calls.length, 0, raw.slice(0, 40) + ': fail closed');
    assert.deepEqual(await updates.setEnabled(true), { enabled: true, changed: true });
    assert.deepEqual(await settingOf(dataDir), { schemaVersion: 1, enabled: true });
    await updates.wake(); assert.equal(fake.calls.length, 1);
  }
  // A folder where the file should be cannot be read: damaged too.
  const dir = await folder(t); await fs.mkdir(join(dir, UPDATE_CHECK_FILE), { recursive: true });
  assert.deepEqual(await readUpdateCheck(dir, '0.2.5'), { enabled: false, damaged: true });
  // Cache fields that are not what they should be are left out; the look is then due. A cache that is no JSON is nothing known.
  const loose = await folder(t); await fs.mkdir(loose, { recursive: true });
  await fs.writeFile(join(loose, UPDATE_CHECK_FILE), JSON.stringify({ schemaVersion: 1, enabled: true }));
  await fs.writeFile(join(loose, UPDATE_CACHE_FILE), JSON.stringify({ schemaVersion: 1, attemptAt: 'yesterday', checkedAt: 7, latest: '<b>9</b>' }));
  assert.deepEqual(await readUpdateCache(loose), {});
  await fs.writeFile(join(loose, UPDATE_CACHE_FILE), '{');
  assert.deepEqual(await readUpdateCache(loose), {});
  const fake = registry(), { updates } = checker(loose, fake);
  await updates.wake(); assert.equal(fake.calls.length, 1);
  assert.equal((await cacheOf(loose)).latest, '9.9.9', 'the broken cache is written again');
  // Missing, with no trace of the check: a first install — on, never looked.
  assert.deepEqual(await readUpdateSetting(join(loose, 'nowhere')), { enabled: true, first: true });
});

test('REQ-156 unwritable folder: the attempt cannot be stamped, so nothing is asked — silently', { skip: process.getuid?.() === 0 && 'root ignores folder permissions' }, async t => {
  const dataDir = await folder(t); await fs.mkdir(dataDir, { recursive: true }); await fs.chmod(dataDir, 0o500);
  t.after(() => fs.chmod(dataDir, 0o700).catch(() => {}));
  const fake = registry(), { clock, updates } = checker(dataDir, fake);
  const said = await silent(async () => { await updates.wake(); clock.now = T0 + 3600_000; await updates.wake(); });
  assert.deepEqual(said, []); assert.equal(fake.calls.length, 0);
  clock.now = T0 + DAY; await updates.wake(); assert.equal(fake.calls.length, 0);
});

test('REQ-156 view: newer only while on and only when newer than the running plugin; off shows nothing; a week-old answer neither', () => {
  const at = new Date(T0).toISOString(), on = { enabled: true };
  assert.deepEqual(updateCheckView(on, { checkedAt: at, latest: '0.2.6' }, '0.2.5', T0), { enabled: true, newer: '0.2.6', checkedAt: at });
  assert.deepEqual(updateCheckView(on, { checkedAt: at, latest: '0.2.5' }, '0.2.5', T0), { enabled: true, checkedAt: at });
  assert.deepEqual(updateCheckView(on, { checkedAt: at, latest: '0.2.4' }, '0.2.5', T0), { enabled: true, checkedAt: at });
  assert.deepEqual(updateCheckView({ enabled: false }, { checkedAt: at, latest: '0.2.6' }, '0.2.5', T0), { enabled: false });
  assert.deepEqual(updateCheckView({ enabled: false, damaged: true }, {}, '0.2.5', T0), { enabled: false, damaged: true });
  assert.deepEqual(updateCheckView(on, { checkedAt: at, latest: '0.2.6' }, '0.2.5', T0 + 7 * DAY), { enabled: true });
  assert.deepEqual(updateCheckView(on, { checkedAt: at, latest: '0.2.6' }, '0.2.5', T0 - 3600_000), { enabled: true }, 'an answer from the future');
});

test('REQ-156 reads: the overview and a board carry the reading with a host, never ask the registry themselves', async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.store.dataDir, UPDATE_CHECK_FILE), JSON.stringify({ schemaVersion: 1, enabled: true }));
  await fs.writeFile(join(f.store.dataDir, UPDATE_CACHE_FILE), JSON.stringify({ schemaVersion: 1,
    attemptAt: new Date(T0).toISOString(), checkedAt: new Date(T0).toISOString(), latest: '999.0.0' }));
  const keep = globalThis.fetch; let asked = 0; globalThis.fetch = () => { asked++; throw new Error('no network in reads'); };
  try {
    const handlers = createReadHandlers(f.store, () => new Date(T0).toISOString(), async () => ({ available: false, source: 'none', definitions: [], byWorkspace: {} }),
      async () => ({ active: [], entries: [] }));
    const withHost = await handlers.overview({ hostId: 'host-a' });
    assert.equal(withHost.ok, true);
    assert.deepEqual(withHost.data.updateCheck, { enabled: true, newer: '999.0.0', checkedAt: new Date(T0).toISOString() });
    assert.equal(overviewGet.output.safeParse(withHost).success, true);
    const without = await handlers.overview({});
    assert.equal(without.data.updateCheck, undefined);
    const one = await handlers.board({ boardId: f.id, hostId: 'host-a' });
    assert.equal(one.ok, true); assert.equal(one.data.updateCheck.newer, '999.0.0');
    assert.equal(boardGet.output.safeParse(one).success, true);
    assert.equal(asked, 0);
  } finally { globalThis.fetch = keep; }
});

test('REQ-156 RPC: the switch takes exactly one boolean', () => {
  assert.equal(updateCheckSet.name, 'kanban.v1.update_check.set');
  assert.equal(updateCheckSet.input.safeParse({ enabled: true }).success, true);
  assert.equal(updateCheckSet.input.safeParse({ enabled: false }).success, true);
  for (const bad of [{}, { enabled: 'true' }, { enabled: true, hostId: 'x' }, { enabled: 1 }]) assert.equal(updateCheckSet.input.safeParse(bad).success, false, JSON.stringify(bad));
});

test('REQ-156 server entry: overview and board reads and the revisions poll start the look in the background; the switch is registered', async () => {
  const ts = (await import('typescript')).default;
  const source = await fs.readFile(new URL('../index.server.ts', import.meta.url), 'utf8'), ast = ts.createSourceFile('index.server.ts', source, ts.ScriptTarget.Latest, true);
  const handled = {};
  const visit = n => { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'server.handle') handled[n.arguments[0]?.getText(ast)] = n.arguments[1]?.getText(ast); ts.forEachChild(n, visit); };
  visit(ast);
  for (const key of ['overviewGet', 'boardGet', 'revisionsGet']) assert.match(handled[key], /lookForUpdate\(\);/, key);
  for (const key of ['cardGet', 'boardMutate']) assert.doesNotMatch(handled[key] ?? '', /lookForUpdate/, key + ' does not look');
  assert.match(handled.updateCheckSet, /setEnabled\(value\.enabled\)/);
  // The background look is never awaited by a read.
  assert.match(source, /const lookForUpdate = \(\) => \{ void updates\.then\(checker => checker\.wake\(\)\)\.catch\(\(\) => \{\}\); \};/);
});

test('REQ-156 boundary: the registry request is the only network code; the screens and the CLI have none', async () => {
  const files = [];
  const walk = async dir => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path); else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  } };
  for (const dir of ['client', 'server', 'shared', 'src']) await walk(dir);
  files.push('index.server.ts', 'index.client.tsx');
  // Links in comments (sources of colours and icons) are not requests; a request needs one of these.
  const network = /\bfetch\s*\(|node:(http|https|net|tls|dgram)|\bXMLHttpRequest\b|\bWebSocket\b|registry\.npmjs\.org/;
  const hits = [];
  for (const file of files) if (network.test(await fs.readFile(file, 'utf8'))) hits.push(file);
  assert.deepEqual(hits.sort(), ['server/update-check.ts'], 'network code outside the update check: ' + hits.join(', '));
});

test('REQ-156 screen text: every state in both languages, English without Korean, the commands are README\'s', async () => {
  const at = new Date(T0).toISOString();
  const states = [[undefined, 'none'], [{ enabled: true }, 'unchecked'], [{ enabled: true, checkedAt: at }, 'current'],
    [{ enabled: true, newer: '0.2.6', checkedAt: at }, 'newer'], [{ enabled: false }, 'off'], [{ enabled: false, damaged: true }, 'damaged'],
    [{ enabled: true, checkedAt: 'garbage' }, 'unchecked']];
  for (const [update, state] of states) assert.equal(updateState(update), state, JSON.stringify(update));
  assert.equal(updateDot({ enabled: true, newer: '0.2.6' }), true);
  for (const update of [undefined, { enabled: true }, { enabled: false }, { enabled: false, damaged: true }, { enabled: true, checkedAt: at }]) assert.equal(updateDot(update), false);
  assert.match(checkedTime(T0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  for (const locale of ['en', 'ko']) {
    const m = copy(locale);
    assert.equal(updateLine({ enabled: true, newer: '0.2.6' }, '0.2.5', m), m.updateNewer('0.2.6', '0.2.5'));
    assert.ok(m.updateNewer('0.2.6', '0.2.5').includes('0.2.6') && m.updateNewer('0.2.6', '0.2.5').includes('0.2.5'));
    assert.equal(updateLine(undefined, '0.2.5', m), '');
    const texts = { updateCheck: m.updateCheck, updateCheckHelp: m.updateCheckHelp, updateCheckDamaged: m.updateCheckDamaged, updateRow: m.updateRow,
      updateNewer: m.updateNewer('0.2.6', '0.2.5'), updateCommandsHelp: m.updateCommandsHelp, updateCopy: m.updateCopy, updateCopied: m.updateCopied,
      updateCopyFailed: m.updateCopyFailed, updateCurrent: m.updateCurrent('2026-10-19 09:00'), updateNotChecked: m.updateNotChecked, updateOff: m.updateOff,
      settingsUpdateBadge: m.settingsUpdateBadge, updateAvailableShort: m.updateAvailableShort };
    for (const [key, text] of Object.entries(texts)) {
      assert.ok(text && typeof text === 'string', key);
      if (locale === 'en') assert.ok(!HANGUL.test(text), key + ': ' + text); else assert.ok(HANGUL.test(text), key + ': ' + text);
    }
    // The help says what is sent and where — the npm registry, the version number only.
    assert.ok(/npm/.test(m.updateCheckHelp));
  }
  const readme = await fs.readFile(resolve('README.md'), 'utf8');
  const block = readme.slice(readme.indexOf('**Updating.**'), readme.indexOf('**Requirements:**'));
  for (const line of UPDATE_COMMANDS) assert.ok(block.includes('\n' + line + '\n'), line);
});
