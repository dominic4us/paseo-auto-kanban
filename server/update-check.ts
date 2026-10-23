import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameOver } from './core/durable.js';
import { openStore, type Store } from './core/store.js';
import { bootDue, checkDue, isNewer, parseRelease, restampDue, resultShown, UPDATE_CHECK_INTERVAL_MS, type BootClock } from '../shared/update-check.js';
import type { UpdateCheckDTO } from '../shared/rpc.js';

/**
 * REQ-156 (research/478 (A)): the plugin's one network request — the latest version number of this package on the npm registry,
 * at most once a day, so a Kanban screen can say a new version is out.
 *
 * When: no timer. A screen reading the overview or a board, or an open screen polling the revisions (`wake`), starts a look when the
 * last attempt is a day old, or none was made. With Paseo closed, or no screen open, nothing is asked. Gate 490 R2: an attempt
 * stamped later than now (the clock went back) is never due — more than a day later, it is stamped again at now without asking —
 * and on Linux the day is also counted on the boot's own clock (`BootClock`), so moving the date forward does not shorten it.
 * What goes out: one GET of `REGISTRY_URL` — no card, path, name or identifier of this install; the registry sees the address of
 * the machine running Paseo. What is kept from the answer: its `version`, only when it is a release number (`parseRelease`). What a
 * screen shows is our own fixed text with that number; the two update commands are constants (`UPDATE_COMMANDS`).
 * Failing: a timeout (5 s, body included), a refused connection, a non-200, a redirect, an answer over 256 KB or one without a
 * release number are all silent — no notice, no log line; the attempt was stamped before asking, so the next look is the next day.
 * A good answer is shown for seven days (`resultShown`); after that, without a newer good answer, nothing is shown.
 *
 * Gate 486 — the setting and the cache are two things:
 * - the setting (`update-check.json`, on or off) is kept like the other automation rules (server/core/auto-state.ts,
 *   server/workflow-picks.ts): through a same-folder temporary file, and the same bytes in `update-check.backup.json`. A missing
 *   file is read from its backup. Missing both, it is a first install — on — only when no cache was ever written either; a cache
 *   without a setting means the setting was lost, so nothing is asked (fail closed). A setting that cannot be read (not JSON, another
 *   schema, `enabled` not a boolean, over 4 KB, a read error) fails closed too; the settings window says so, and choosing on or off
 *   writes a sound setting again. The first look writes the default "on" down, so a later loss is never taken for a first install.
 * - the cache (`update-check-cache.json`): `attemptAt` (the last attempt), `checkedAt` and `latest` (the last good answer). The
 *   switch never touches it, so turning it off and on the same day does not ask again. A cache that cannot be read only means
 *   nothing is known: the look is due and the cache is written again. `checkedAt` and `latest` count only together — a broken one
 *   drops both (nothing shown, never "up to date").
 * - one lock (`.update-check.lock`) around both the switch's save and the start of a request: under it the look reads the
 *   setting again, checks the attempt stamp again, writes the stamp, and only then starts the request. A switch saved "off" is
 *   therefore never followed by a request, and two servers on one data folder ask once between them. Gate 490 R1: the lock is the
 *   store's own (`Store.withDataLock`, the rules of a board's lock): made and taken over only inside its entry guard, taken over
 *   only from an owner known dead for over a minute, released only by its owner — never a lock of our own making.
 * - the core's `config.json` is not used: it rejects unknown fields.
 */
export const UPDATE_CHECK_FILE = 'update-check.json';
export const UPDATE_CHECK_BACKUP = 'update-check.backup.json';
export const UPDATE_CACHE_FILE = 'update-check-cache.json';
export const UPDATE_LOCK_FILE = '.update-check.lock';
export const REGISTRY_URL = 'https://registry.npmjs.org/paseo-auto-kanban/latest';
export const PACKAGE_NAME = 'paseo-auto-kanban';
export const FETCH_TIMEOUT_MS = 5000;
export const RESPONSE_LIMIT = 256 * 1024;
const FILE_LIMIT = 4096;

export interface UpdateSetting { enabled: boolean; damaged?: true; /** No trace of the check at all: a first install. */ first?: true }
/** `attemptBoot`/`attemptUptime`: the boot and its clock at the last attempt (gate 490 R2), where the machine has one. */
export interface UpdateCache { attemptAt?: string; attemptBoot?: string; attemptUptime?: number; checkedAt?: string; latest?: string }
const stamp = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const DAMAGED: UpdateSetting = { enabled: false, damaged: true };

function parseSetting(raw: string): UpdateSetting {
  try {
    if (raw.length > FILE_LIMIT) return DAMAGED;
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') return DAMAGED;
    return { enabled: value.enabled };
  } catch { return DAMAGED; }
}
export async function readUpdateSetting(dataDir: string): Promise<UpdateSetting> {
  for (const name of [UPDATE_CHECK_FILE, UPDATE_CHECK_BACKUP]) {
    try { return parseSetting(await fs.readFile(path.join(dataDir, name), 'utf8')); }
    catch (error) { if (codeOf(error) !== 'ENOENT') return DAMAGED; }
  }
  // Neither the setting nor its backup: a first install only when the check never wrote its cache either.
  try { await fs.lstat(path.join(dataDir, UPDATE_CACHE_FILE)); return DAMAGED; }
  catch (error) { return codeOf(error) === 'ENOENT' ? { enabled: true, first: true } : DAMAGED; }
}
export async function readUpdateCache(dataDir: string): Promise<UpdateCache> {
  try {
    const raw = await fs.readFile(path.join(dataDir, UPDATE_CACHE_FILE), 'utf8');
    if (raw.length > FILE_LIMIT) return {};
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return {};
    const attemptAt = stamp(value.attemptAt), checkedAt = stamp(value.checkedAt), latest = parseRelease(value.latest) ?? undefined;
    const boot = typeof value.attemptBoot === 'string' && value.attemptBoot && value.attemptBoot.length <= 64 &&
      typeof value.attemptUptime === 'number' && Number.isFinite(value.attemptUptime) && value.attemptUptime >= 0
      ? { attemptBoot: value.attemptBoot, attemptUptime: value.attemptUptime } : {};
    return { ...(attemptAt ? { attemptAt, ...boot } : {}), ...(checkedAt && latest ? { checkedAt, latest } : {}) };
  } catch { return {}; }
}
async function replace(dataDir: string, name: string, bytes: string): Promise<void> {
  const temporary = path.join(dataDir, `.${name}.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await renameOver(temporary, path.join(dataDir, name));
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}
async function writeUpdateSetting(dataDir: string, enabled: boolean, at: number): Promise<void> {
  const bytes = JSON.stringify({ schemaVersion: 1, enabled, changedAt: new Date(at).toISOString() }, null, 2) + '\n';
  // The file first, then the same bytes to its backup (as server/core/auto-state.ts).
  for (const name of [UPDATE_CHECK_FILE, UPDATE_CHECK_BACKUP]) await replace(dataDir, name, bytes);
}
const writeUpdateCache = (dataDir: string, cache: UpdateCache) =>
  replace(dataDir, UPDATE_CACHE_FILE, JSON.stringify({ schemaVersion: 1, ...cache }, null, 2) + '\n');

/** Gate 490: the boot's id and its clock on Linux (`/proc`; the uptime counts a suspended machine too); elsewhere none. */
let bootId: Promise<string | null> | null = null;
export async function machineBootClock(): Promise<BootClock | null> {
  if (process.platform !== 'linux') return null;
  bootId ??= fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(text => text.trim().slice(0, 64) || null, () => null);
  const boot = await bootId;
  return boot ? { boot, ms: os.uptime() * 1000 } : null;
}

/** What the screens get: on or off, the newer release if there is one (only while on), when the registry last answered — a week at most. */
export function updateCheckView(setting: UpdateSetting, cache: UpdateCache, running: string, now: number): UpdateCheckDTO {
  if (setting.damaged) return { enabled: false, damaged: true };
  if (!setting.enabled) return { enabled: false };
  if (!cache.checkedAt || !cache.latest || !resultShown(cache.checkedAt, now)) return { enabled: true };
  return { enabled: true, ...(isNewer(cache.latest, running) ? { newer: cache.latest } : {}), checkedAt: cache.checkedAt };
}
export async function readUpdateCheck(dataDir: string, running: string, now = Date.now()): Promise<UpdateCheckDTO> {
  const setting = await readUpdateSetting(dataDir);
  return updateCheckView(setting, setting.enabled ? await readUpdateCache(dataDir) : {}, running, now);
}

type Fetch = (url: string, init: { signal: AbortSignal; redirect: 'error'; headers: Record<string, string> }) => Promise<{
  ok: boolean; status: number; body?: ReadableStream<Uint8Array> | null; text: () => Promise<string> }>;
/** The registry's latest release, or null for anything else (never throws). `fetchImpl` is called before this returns. */
export async function askRegistry(fetchImpl: Fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
  const ask = async (): Promise<string | null> => {
    const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok || response.status !== 200) return null;
    let text = '';
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      for (let size = 0; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RESPONSE_LIMIT) { void reader.cancel().catch(() => {}); return null; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      if (text.length > RESPONSE_LIMIT) return null;
    }
    const value = JSON.parse(text) as { name?: unknown; version?: unknown } | null;
    if (!value || typeof value !== 'object' || value.name !== PACKAGE_NAME) return null;
    return parseRelease(value.version);
  };
  try { return await Promise.race([ask().catch(() => null), expired]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export interface UpdateChecker {
  /** A screen read: look if a day has passed (in the background; the read never waits). Resolves when any look it started ended. */
  wake(): Promise<void>;
  /** On or off from the settings window. Saved under the same lock a request starts under; the cache is left as it is. */
  setEnabled(enabled: boolean): Promise<{ enabled: boolean; changed: boolean }>;
  state(): Promise<UpdateCheckDTO>;
}
/**
 * `store`: the plugin's store for the data folder's lock (one is opened for `dataDir` when none is given). `now`: the date's clock;
 * `uptime`: the boot's clock — by default the machine's (`machineBootClock`), but none when `now` is given without it, so a caller
 * with a clock of its own (tests) is not held by the real one.
 */
export function createUpdateChecker(options: { dataDir: string; running: string; now?: () => number; fetch?: Fetch; timeoutMs?: number;
  store?: Pick<Store, 'withDataLock'>; uptime?: () => BootClock | null | Promise<BootClock | null> }): UpdateChecker {
  const { dataDir, running, now = () => Date.now(), fetch: fetchImpl = globalThis.fetch as unknown as Fetch, timeoutMs = FETCH_TIMEOUT_MS } = options;
  const uptime = options.uptime ?? (options.now ? () => null : machineBootClock);
  let store: Promise<Pick<Store, 'withDataLock'>> | null = options.store ? Promise.resolve(options.store) : null;
  const locked = async <T>(task: () => Promise<T>): Promise<T> => {
    store ??= openStore({ dataDir, lockTimeoutMs: 5000 });
    return (await store).withDataLock(UPDATE_LOCK_FILE, task);
  };
  const bootNow = async () => { try { return await uptime(); } catch { return null; } };
  // One look at a time in this process, and none within a day of this process's last attempt (switching never resets it).
  let looking: Promise<void> | null = null, lastTry = -Infinity;
  const look = async () => {
    const at = now();
    if (at >= lastTry && at - lastTry < UPDATE_CHECK_INTERVAL_MS) return;
    // A first glance without the lock: most looks end here (off, or asked within the day).
    const glance = await readUpdateSetting(dataDir).catch(() => DAMAGED);
    if (!glance.enabled || glance.damaged) return;
    const seen = await readUpdateCache(dataDir);
    if (!restampDue(seen.attemptAt, at) && (!checkDue(seen.attemptAt, at) || !bootDue(seen, await bootNow()))) return;
    let asking: Promise<string | null> | null = null;
    await locked(async () => {
      // Under the lock, again: a switch saved "off" since the glance wins, and so does another process's attempt.
      const setting = await readUpdateSetting(dataDir);
      if (!setting.enabled || setting.damaged) return;
      const cache = await readUpdateCache(dataDir), time = now(), boot = await bootNow();
      // The clock went back more than a day: the attempt is stamped at now, nothing is asked, the day counts from here.
      if (restampDue(cache.attemptAt, time)) { await writeUpdateCache(dataDir, { ...cache, attemptAt: new Date(time).toISOString() }); return; }
      if (!checkDue(cache.attemptAt, time) || !bootDue(cache, boot)) return;
      // Written down before asking: the default "on" (so its loss is not a first install) and this attempt.
      if (setting.first) await writeUpdateSetting(dataDir, true, time);
      const { attemptBoot: _boot, attemptUptime: _uptime, ...kept } = cache;
      await writeUpdateCache(dataDir, { ...kept, attemptAt: new Date(time).toISOString(), ...(boot ? { attemptBoot: boot.boot, attemptUptime: boot.ms } : {}) });
      lastTry = time;
      if (typeof fetchImpl === 'function') asking = askRegistry(fetchImpl, timeoutMs);
    }).catch(() => {});
    if (!asking) return;
    const latest = await (asking as Promise<string | null>);
    if (!latest) return;
    // The answer is kept only while the switch is still on.
    await locked(async () => {
      const setting = await readUpdateSetting(dataDir);
      if (!setting.enabled || setting.damaged) return;
      const { checkedAt: _at, latest: _latest, ...attempt } = await readUpdateCache(dataDir);
      await writeUpdateCache(dataDir, { ...attempt, checkedAt: new Date(now()).toISOString(), latest });
    }).catch(() => {});
  };
  const wake = () => {
    if (!looking) looking = look().catch(() => {}).finally(() => { looking = null; });
    return looking;
  };
  return {
    wake,
    async setEnabled(enabled: boolean) {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      return locked(async () => {
        const current = await readUpdateSetting(dataDir);
        if (!current.damaged && !current.first && current.enabled === enabled) return { enabled, changed: false };
        await writeUpdateSetting(dataDir, enabled, now());
        return { enabled, changed: !!current.damaged || current.enabled !== enabled };
      });
    },
    state: () => readUpdateCheck(dataDir, running, now()),
  };
}
