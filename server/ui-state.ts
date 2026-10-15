import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MAIL_DIR_LIMIT, type LabsDTO, type UiOrderDTO, type UiSettingsDTO, type UiStateDTO } from '../shared/rpc.js';

/**
 * REQ-57 ④: the project filter has to survive an app restart, and the plugin's own ledger directory is
 * the only place it may write. `config.json` cannot hold it — the core validator rejects unknown fields
 * and `kanban` would stop reading its own configuration — so this sits beside it in its own file, keyed
 * by host. REQ-59 ② keeps the arranged order here too, in the same file and the same way. Nothing in
 * the core reads it, a missing or malformed file simply means "nothing hidden, automatic order", and it
 * is only ever written when the user actually changes something (no idle writes).
 * REQ-66 adds the settings window's rows under `settings`; an absent field is its default.
 * REQ-75 adds `order.flatWorkspaces` (the flat board's lane order) and `settings.groupByProject`; both are
 * left out of the file and of replies until they hold something, so an older file reads unchanged.
 * REQ-79 adds `settings.cardOrder` the same way: absent while the order is the default.
 * REQ-90 adds `settings.labs` the same way: absent until a lab field differs from its default (all off, no folder).
 * REQ-139 adds `settings.uiScale` the same way: absent while the screens draw at 100%.
 */
const FILE = 'ui-state.json';
export const emptyOrder = (): UiOrderDTO => ({ projects: [], workspaces: [] });
export const emptyUiState = (): UiStateDTO => ({ hiddenProjects: [], order: emptyOrder() });
type StoredHost = { hiddenProjects?: unknown; order?: { projects?: unknown; workspaces?: unknown; flatWorkspaces?: unknown } | undefined;
  settings?: unknown };
type Stored = Record<string, StoredHost | undefined>;

async function readAll(dataDir: string, read = (file: string) => fs.readFile(file, 'utf8')): Promise<Stored> {
  try {
    const raw = await read(path.join(dataDir, FILE));
    if (raw.length > 262144) return {};
    const value = JSON.parse(raw) as { schemaVersion?: unknown; hosts?: unknown };
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return {};
    return value.hosts && typeof value.hosts === 'object' && !Array.isArray(value.hosts) ? value.hosts as Stored : {};
  } catch { return {}; }
}
function clean(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v && v.length <= 256))].sort().slice(0, 500)
    : [];
}
/**
 * REQ-59 ②: the arranged order is a sequence, so unlike the hidden set it is never sorted — only
 * de-duplicated (first mention wins) and capped, so a damaged file cannot grow the screen's work.
 */
function cleanSequence(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry.length > 256 || seen.has(entry)) continue;
    seen.add(entry);
    if (seen.size >= limit) break;
  }
  return [...seen];
}
/** REQ-75 A4: an empty flat order is left out, so a host that never arranged the flat board keeps the old shape. */
const withFlat = (flat: string[]) => flat.length ? { flatWorkspaces: flat } : {};
function cleanOrder(value: StoredHost['order']): UiOrderDTO {
  return { projects: cleanSequence(value?.projects, 500), workspaces: cleanSequence(value?.workspaces, 2000),
    ...withFlat(cleanSequence(value?.flatWorkspaces, 2000)) };
}
/** REQ-90: the lab keeps only what differs from its default — the badge on, a folder, the 'folder' short-name rule. */
function cleanLabs(value: unknown): LabsDTO {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const dir = typeof raw.mailDir === 'string' ? raw.mailDir.trim() : '';
  return { ...(raw.mail === true ? { mail: true } : {}), ...(dir && dir.length <= MAIL_DIR_LIMIT ? { mailDir: dir } : {}),
    ...(raw.mailAlias === 'folder' ? { mailAlias: 'folder' as const } : {}) };
}
const withLabs = (labs: LabsDTO) => Object.keys(labs).length ? { labs } : {};
/** REQ-66: only known values survive; anything else reads as the default. */
function cleanSettings(value: unknown): UiSettingsDTO {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { ...(raw.boardAlign === 'left' || raw.boardAlign === 'center' || raw.boardAlign === 'right' ? { boardAlign: raw.boardAlign } : {}),
    ...(typeof raw.autoRefresh === 'boolean' ? { autoRefresh: raw.autoRefresh } : {}),
    ...(raw.theme === 'paseo' || raw.theme === 'system' || raw.theme === 'light' || raw.theme === 'dark' ? { theme: raw.theme } : {}),
    ...(typeof raw.groupByProject === 'boolean' ? { groupByProject: raw.groupByProject } : {}),
    // REQ-79: kept only while it is not the default, so choosing the default again takes the field out of the file.
    ...(raw.cardOrder === 'updated' || raw.cardOrder === 'created' ? { cardOrder: raw.cardOrder } : {}),
    ...withLabs(cleanLabs(raw.labs)),
    // REQ-139: a step between 80 and 150 other than 100; anything else (100, out of range, not a step) reads as 100.
    ...(typeof raw.uiScale === 'number' && Number.isInteger(raw.uiScale) && raw.uiScale >= 80 && raw.uiScale <= 150 && raw.uiScale % 10 === 0
      && raw.uiScale !== 100 ? { uiScale: raw.uiScale } : {}) };
}
/** A host that never changed a setting keeps the pre-REQ-66 shape, in the file and in replies. */
const withSettings = (settings: UiSettingsDTO) => Object.keys(settings).length ? { settings } : {};
const sameSettings = (a: UiSettingsDTO, b: UiSettingsDTO) => a.boardAlign === b.boardAlign && a.autoRefresh === b.autoRefresh &&
  a.theme === b.theme && a.groupByProject === b.groupByProject && a.cardOrder === b.cardOrder && a.uiScale === b.uiScale &&
  a.labs?.mail === b.labs?.mail && a.labs?.mailDir === b.labs?.mailDir && a.labs?.mailAlias === b.labs?.mailAlias;
export async function readUiState(dataDir: string, hostId: string,
  read?: (file: string) => Promise<string>): Promise<UiStateDTO> {
  const host = (await readAll(dataDir, read))[hostId];
  return { hiddenProjects: clean(host?.hiddenProjects), order: cleanOrder(host?.order), ...withSettings(cleanSettings(host?.settings)) };
}
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const result = (value: UiStateDTO & { settings: UiSettingsDTO }): UiStateDTO =>
  ({ hiddenProjects: value.hiddenProjects, order: value.order, ...withSettings(value.settings) });
/**
 * research/330 F1: one write at a time per file. Each write reads the file, merges its own fields into it and replaces it, so
 * two writes running side by side each read the same old file and the later rename dropped the other's change — both replies
 * said saved. Within this process the writes to one file now queue: each starts once the one before it has finished, whether
 * that one succeeded or failed, so a failed write never stops the ones after it.
 */
const queues = new Map<string, Promise<unknown>>();
export function writeUiState(...args: Parameters<typeof writeUiStateNow>): ReturnType<typeof writeUiStateNow> {
  const key = path.resolve(args[0], FILE);
  // What is queued has already had its failure caught (`settled`), so the next write always starts.
  const run = (queues.get(key) ?? Promise.resolve()).then(() => writeUiStateNow(...args));
  const settled = run.catch(() => {});
  queues.set(key, settled);
  // The last one out takes the file's queue away, so a process that saves now and then keeps no entry for it.
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return run;
}
/** Writes through a temporary file in the same directory, and only when the stored value differs. */
async function writeUiStateNow(dataDir: string, hostId: string,
  patch: { hiddenProjects?: readonly string[] | undefined;
    order?: { projects: readonly string[]; workspaces: readonly string[]; flatWorkspaces?: readonly string[] | undefined } | undefined;
    settings?: UiSettingsDTO | undefined },
  io: { read?: (file: string) => Promise<string>; write?: (file: string, bytes: string) => Promise<void>;
    rename?: (from: string, to: string) => Promise<void>; remove?: (file: string) => Promise<void> } = {},
): Promise<UiStateDTO & { changed: boolean }> {
  const hosts = await readAll(dataDir, io.read);
  const current = { hiddenProjects: clean(hosts[hostId]?.hiddenProjects), order: cleanOrder(hosts[hostId]?.order),
    settings: cleanSettings(hosts[hostId]?.settings) };
  const next: UiStateDTO & { settings: UiSettingsDTO } = {
    hiddenProjects: patch.hiddenProjects === undefined ? current.hiddenProjects : clean([...patch.hiddenProjects]),
    order: patch.order === undefined ? current.order
      : { projects: cleanSequence([...patch.order.projects], 500), workspaces: cleanSequence([...patch.order.workspaces], 2000),
        // REQ-75 A4: an order without the flat list (an older client) leaves the stored flat order alone.
        ...withFlat(patch.order.flatWorkspaces === undefined ? current.order.flatWorkspaces ?? [] : cleanSequence([...patch.order.flatWorkspaces], 2000)) },
    // One row at a time: the fields not sent keep what the file holds, so no row overwrites another.
    // REQ-90: and the lab field by field, so turning the badge on keeps the folder and the other way round.
    settings: patch.settings === undefined ? current.settings : cleanSettings({ ...current.settings, ...patch.settings,
      ...(patch.settings.labs ? { labs: { ...current.settings.labs, ...patch.settings.labs } } : {}) }),
  };
  if (sameList(current.hiddenProjects, next.hiddenProjects) && sameList(current.order.projects, next.order.projects) &&
    sameList(current.order.workspaces, next.order.workspaces) && sameList(current.order.flatWorkspaces ?? [], next.order.flatWorkspaces ?? []) &&
    sameSettings(current.settings, next.settings)) return { ...result(next), changed: false };
  // Every field is written back, so saving the filter never drops the order or the settings.
  const merged: Stored = { ...hosts, [hostId]: result(next) };
  const file = path.join(dataDir, FILE);
  const temporary = path.join(dataDir, `.${FILE}.tmp-${randomUUID()}`);
  const write = io.write ?? ((target, bytes) => fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }));
  const rename = io.rename ?? fs.rename;
  const remove = io.remove ?? ((target: string) => fs.rm(target, { force: true }));
  try {
    await write(temporary, JSON.stringify({ schemaVersion: 1, hosts: merged }, null, 2) + '\n');
    await rename(temporary, file);
  } catch (error) { await remove(temporary).catch(() => {}); throw error; }
  return { ...result(next), changed: true };
}
