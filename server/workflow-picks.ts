import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createKanbanError, normalizeCwd } from '../shared/core/domain.js';
import { BUILTIN_ID, builtinWorkflow } from '../shared/workflow-templates.js';

/**
 * REQ-125 C안 1단계: `workflow-picks.json`, the plugin's own file beside `auto-cards.json` and `ui-state.json` (never in a
 * board, never in a workspace folder): which built-in workflow (shared/workflow-templates.ts) each workspace is trying, by
 * the folder's spelling (`normalizeCwd`) — the id alone, the steps stay in the product. A lane with a definition file
 * ignores its pick (the file wins); "stop using" takes the entry out, so nothing is left behind.
 *
 * A file of its own rather than a field of `auto-cards.json`: a pick that cannot be read must never stop the agent auto
 * cards (that file's damage stops everything it rules). It follows the same rules (server/core/auto-state.ts):
 * - the wrong shape, an entry that cannot be read or too many entries make the file `damaged`: no pick is shown (the lanes
 *   offer "try" as with none) and the bytes are never written over — a pick then fails and says why (fail closed);
 * - every write keeps the same bytes in `workflow-picks.backup.json`; a missing file is read from the backup, and is the
 *   plain start (no picks) only when the backup is missing too;
 * - an entry naming a built-in this version does not have (a newer version's) is kept as it is and shown as no pick.
 */
export const PICKS_FILE = 'workflow-picks.json';
export const PICKS_BACKUP = 'workflow-picks.backup.json';
export const PICKS_BYTES = 1024 * 1024;
export const PICKS_LIMIT = 1000;
export interface WorkflowPick { template: string; at: string }
export interface PicksState { picks: Record<string, WorkflowPick>; damaged?: true }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

export async function readPicks(dataDir: string): Promise<PicksState> {
  let raw: string;
  try { raw = await fs.readFile(path.join(dataDir, PICKS_FILE), 'utf8'); }
  catch (error) {
    if (codeOf(error) !== 'ENOENT') return { picks: {}, damaged: true };
    try { raw = await fs.readFile(path.join(dataDir, PICKS_BACKUP), 'utf8'); }
    catch (second) { return codeOf(second) === 'ENOENT' ? { picks: {} } : { picks: {}, damaged: true }; }
  }
  return parsePicks(raw);
}
export function parsePicks(raw: string): PicksState {
  try {
    if (Buffer.byteLength(raw, 'utf8') > PICKS_BYTES) return { picks: {}, damaged: true };
    const value = JSON.parse(raw) as unknown;
    if (!isMap(value) || value.schemaVersion !== 1) return { picks: {}, damaged: true };
    if (value.picks === undefined) return { picks: {} };
    if (!isMap(value.picks)) return { picks: {}, damaged: true };
    const entries = Object.entries(value.picks), picks: Record<string, WorkflowPick> = {};
    if (entries.length > PICKS_LIMIT) return { picks: {}, damaged: true };
    for (const [key, entry] of entries) {
      if (!key || key.length > 4096 || !isMap(entry) || typeof entry.template !== 'string' || !BUILTIN_ID.test(entry.template) || !isTime(entry.at))
        return { picks: {}, damaged: true };
      picks[key] = { template: entry.template, at: entry.at };
    }
    return { picks };
  } catch { return { picks: {}, damaged: true }; }
}
/** The built-in this folder is trying, when this version has it; null for none, for an unknown id and for a damaged file. */
export function pickFor(state: PicksState | null | undefined, cwd: string | null | undefined): string | null {
  if (!state || state.damaged || !cwd) return null;
  const id = state.picks[normalizeCwd(cwd)]?.template;
  return builtinWorkflow(id) ? id! : null;
}

async function writePicks(dataDir: string, state: PicksState): Promise<void> {
  if (state.damaged) throw createKanbanError('E_CORRUPT', PICKS_FILE + ' could not be read; it is not written over.', PICKS_FILE,
    'Repair the file or copy ' + PICKS_BACKUP + ' over it; never delete it to start again.');
  const picks = Object.entries(state.picks).sort((a, b) => b[1].at.localeCompare(a[1].at));
  const bytes = JSON.stringify({ schemaVersion: 1, picks: Object.fromEntries(picks) }, null, 2) + '\n';
  // The result must pass the same reading rules (size, shape, keys) or nothing is touched: a file written here that reading
  // refuses would hide every other folder's pick and fail every later write.
  if (picks.some(([key]) => !key)) throw createKanbanError('E_VALIDATION', 'This folder cannot be picked.', PICKS_FILE, 'Pick it from a named folder.');
  if (parsePicks(bytes).damaged) throw createKanbanError('E_LIMIT', 'No more picks can be saved.', PICKS_FILE, 'Stop using a built-in workflow first.');
  await fs.mkdir(dataDir, { recursive: true });
  for (const name of [PICKS_FILE, PICKS_BACKUP]) {
    const temporary = path.join(dataDir, `.${name}.tmp-${randomUUID()}`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path.join(dataDir, name));
    } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
}
/** One write at a time per data folder: each change reads the file again, so two picks at once both land. */
const queues = new Map<string, Promise<unknown>>();
/**
 * Picks a built-in workflow for the folder, or (`template: null`) takes its pick out. `changed`: false when it already was so.
 * An unknown id is refused before anything is read; a damaged file is never written over (E_CORRUPT).
 */
export function setPick(dataDir: string, cwd: string, template: string | null, now = () => new Date().toISOString()):
  Promise<{ template: string | null; changed: boolean }> {
  if (template !== null && !builtinWorkflow(template)) return Promise.reject(createKanbanError('E_VALIDATION', 'Unknown built-in workflow.', template));
  const key = normalizeCwd(cwd);
  if (template !== null && !key) return Promise.reject(createKanbanError('E_VALIDATION', 'This folder cannot be picked.', PICKS_FILE, 'Pick it from a named folder.'));
  const run = async () => {
    const state = await readPicks(dataDir);
    if (state.damaged) return writePicks(dataDir, state).then(() => ({ template, changed: false }));
    const before = state.picks[key]?.template ?? null;
    if (before === template) return { template, changed: false };
    if (template === null) delete state.picks[key];
    else {
      if (!state.picks[key] && Object.keys(state.picks).length >= PICKS_LIMIT)
        throw createKanbanError('E_LIMIT', 'Too many workspaces are trying a built-in workflow.', key, 'Stop using one first.');
      state.picks[key] = { template, at: now() };
    }
    await writePicks(dataDir, state);
    return { template, changed: true };
  };
  const previous = queues.get(dataDir) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(dataDir, next.catch(() => undefined));
  return next;
}
