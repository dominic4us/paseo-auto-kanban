import { normalizeCwd } from '../shared/rpc.js';
import { normalizeSearch } from './filter-model.js';
import { compareByOrder, emptyLaneOrder, type LaneOrder } from './order-model.js';
import type { OverviewDTO } from '../shared/rpc.js';
export { normalizeCwd };
export interface WorkspaceName { id: string; name: string; projectId: string; projectName: string; projectViewKey?: string; labels?: string[]; cwd?: string;
  /** D25: not a Paseo workspace but the project's own root folder, where a board was kept (see addProjectRoots). */
  projectRoot?: boolean;
  /** REQ-65 ⑥: the branch Paseo reports for the workspace, from the listing the directory already reads. */
  branch?: string;
  /** REQ-65 ⑦: a root row's "original path", in the screen's language (see nameProjectRoots). */
  place?: string }
export type Directory = Record<string, WorkspaceName>;
/**
 * D22: a board minted before Paseo had a workspace at this directory keeps a `local_<hash(cwd)>` id
 * forever, so its id is absent from `workspaces.list`. The directory therefore carries a second key per
 * workspace — its canonical directory — and every lookup falls back to it. Paths are compared with the
 * trailing separators removed and in Unicode NFC, which is the only difference two spellings of the same
 * directory can have here. No extra request: the cwd comes from the listing the directory already reads.
 */
export const CWD_KEY = 'cwd:';
export function cwdKey(cwd: string): string { return CWD_KEY + normalizeCwd(cwd); }
/**
 * D25: a project whose Paseo workspaces are all worktrees elsewhere can still have a board at its own
 * root folder — an agent ran the CLI from the repository's original path. No workspace carries that
 * directory, yet it plainly belongs to the project, so the root folder gets a directory row of its own
 * and the board is filed under the project like any other workspace. A root that already is a workspace
 * keeps that workspace, and a root two projects claim is left alone. Keyed by directory only: its id,
 * `root:<projectId>`, is what a placed position is remembered by and never reaches Paseo.
 */
export const ROOT_ID = 'root:';
export function addProjectRoots(directory: Directory, projects: readonly { projectId: string; rootPath: string;
  projectName: string; projectViewKey: string }[]): Directory {
  const claims = new Map<string, number>();
  for (const p of projects) if (p.rootPath) claims.set(cwdKey(p.rootPath), (claims.get(cwdKey(p.rootPath)) ?? 0) + 1);
  for (const p of projects) {
    const key = p.rootPath ? cwdKey(p.rootPath) : '';
    if (!key || directory[key] || claims.get(key) !== 1) continue;
    directory[key] = { id: ROOT_ID + p.projectId, name: p.projectName, projectId: p.projectId, projectName: p.projectName,
      projectViewKey: p.projectViewKey, labels: [], cwd: p.rootPath, projectRoot: true };
  }
  return directory;
}
/**
 * D25/REQ-65 ⑦: a root row is named after its project, like the worktrees beside it, and says where it is
 * in the quiet detail instead — "original path" in the screen's language; the directory is read without one.
 */
export function nameProjectRoots(directory: Directory, place: string): Directory {
  let named: Directory | null = null;
  for (const [key, entry] of Object.entries(directory)) if (entry.projectRoot) {
    named ??= { ...directory };
    named[key] = { ...entry, place };
  }
  return named ?? directory;
}
/** REQ-65 ⑤: two names are the same name when only case or spacing differ (Acme_Logotype / acme_logotype). */
export function sameName(a: string, b: string): boolean { return normalizeSearch(a) === normalizeSearch(b); }
const folderOf = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '';
/**
 * REQ-65 ⑥⑦: the quiet part after a workspace's name, the way Paseo's sidebar tells worktrees apart —
 * `branch · folder`, or `original path · folder` on a project's root row. A part that only repeats the name,
 * or the part before it, is left out, so a workspace named after its branch or folder does not say it twice.
 */
export function workspaceDetail(directory: Directory, workspaceId: string, cwd: string): string {
  const entry = workspaceEntry(directory, workspaceId, cwd), name = workspaceName(workspaceId, cwd, directory);
  const parts: string[] = [];
  for (const part of [entry?.projectRoot ? entry.place : entry?.branch, folderOf(entry?.cwd || cwd)])
    if (part && !sameName(part, name) && !parts.some(p => sameName(p, part))) parts.push(part);
  return parts.join(' · ');
}
/** REQ-65: a workspace in one plain string — a picker entry or a menu title — with its detail when it has one. */
export function workspaceLabel(workspaceId: string, cwd: string, directory: Directory): string {
  const detail = workspaceDetail(directory, workspaceId, cwd);
  return workspaceName(workspaceId, cwd, directory) + (detail ? ' · ' + detail : '');
}
/** The workspace a board belongs to: its own id when Paseo still knows it, otherwise its directory. */
export function workspaceEntry(directory: Directory, workspaceId: string, cwd: string): WorkspaceName | undefined {
  const direct = directory[workspaceId];
  if (direct) return direct;
  return cwd ? directory[cwdKey(cwd)] : undefined;
}
/**
 * REQ-78: the boards a screen may place. Until this screen's own listing has answered (`settled`), a board the
 * known listing does not name is held back rather than filed under "not found in Paseo": it may be a workspace
 * made since, of a project the user hides. Without any listing yet nothing can be placed, so nothing is.
 */
export function placedBoards<T>(boards: readonly T[], directory: Directory, state: { ready: boolean; settled: boolean },
  where: (board: T) => { workspaceId: string; cwd: string }): T[] {
  if (state.settled) return [...boards];
  if (!state.ready) return [];
  return boards.filter(board => { const at = where(board); return !!workspaceEntry(directory, at.workspaceId, at.cwd); });
}
export function workspaceName(workspaceId: string, cwd: string, directory: Directory): string {
  return workspaceEntry(directory, workspaceId, cwd)?.name || folderOf(cwd) || workspaceId.slice(0, 14);
}
export function workspaceProjectId(directory: Directory, workspaceId: string, cwd: string): string {
  return workspaceEntry(directory, workspaceId, cwd)?.projectId ?? '';
}
/**
 * REQ-59 ②: what a remembered position is filed under. It is the Paseo workspace id whenever Paseo
 * still has one — so a D22 board whose ledger id is `local_…` keeps its place under the real id — and
 * the board's own workspace id otherwise, which is what the label filter already keys on.
 */
export function workspaceKey(directory: Directory, workspaceId: string, cwd: string): string {
  return workspaceEntry(directory, workspaceId, cwd)?.id ?? workspaceId;
}
/** REQ-59 ③: every workspace key of one project, including rows a filter or a fold is not showing. */
export function projectWorkspaceKeys(boards: readonly { summary: { workspaceId: string; cwd: string } }[],
  directory: Directory, projectId: string): string[] {
  return boards.filter(b => workspaceProjectId(directory, b.summary.workspaceId, b.summary.cwd) === projectId)
    .map(b => workspaceKey(directory, b.summary.workspaceId, b.summary.cwd));
}
/**
 * The project filter's choices. The boards Paseo no longer knows keep the empty key, and that key is
 * always listed last so a real project never sinks below it.
 */
export function projectOptions(boards: readonly { workspaceId: string; cwd: string }[],
  directory: Directory, missingLabel: string): Map<string, string> {
  const options = new Map<string, string>();
  for (const board of boards) {
    const entry = workspaceEntry(directory, board.workspaceId, board.cwd);
    options.set(entry?.projectId ?? '', entry?.projectName ?? missingLabel);
  }
  if (options.has('') && options.size > 1) { const label = options.get('')!; options.delete(''); options.set('', label); }
  return options;
}
export function overviewSelection(data: OverviewDTO, directory: Directory, hidden: readonly string[],
  reason: 'all' | 'awaitingUser' | 'blocked' | 'draft', order: LaneOrder = emptyLaneOrder()) {
  const belongs = (b: { workspaceId: string; cwd: string }) => !hidden.includes(workspaceProjectId(directory, b.workspaceId, b.cwd));
  // REQ-64 ③: the same two layers as the board — a board, or a project, with a live card sits above the
  // card-less ones. A live card is a requested or a draft one, which is what the board's lanes count.
  const cards = (b: { progress: { requested: number; draft: number } }) => b.progress.requested + b.progress.draft;
  const filled = new Set(data.boards.filter(b => belongs(b) && cards(b) > 0).map(b => workspaceProjectId(directory, b.workspaceId, b.cwd)));
  const cardsOf = new Map(data.boards.map(b => [b.workspaceId + '\u0000' + b.cwd, cards(b)]));
  const compare = (a: { workspaceId: string; cwd: string }, b: { workspaceId: string; cwd: string }) => {
    const left = workspaceEntry(directory, a.workspaceId, a.cwd), right = workspaceEntry(directory, b.workspaceId, b.cwd);
    const leftProject = left?.projectId ?? '', rightProject = right?.projectId ?? '';
    const laneCards = (v: { workspaceId: string; cwd: string }) => Number((cardsOf.get(v.workspaceId + '\u0000' + v.cwd) ?? 0) > 0);
    // D22 ④: boards Paseo no longer has are listed after every real project, not under a blank name.
    // REQ-59 ④: below that, the list screen follows the same arranged order as the board, layer by layer.
    return Number(!left) - Number(!right) ||
      Number(filled.has(rightProject)) - Number(filled.has(leftProject)) ||
      compareByOrder(order.projects, leftProject, rightProject) ||
      (left?.projectName ?? '').localeCompare(right?.projectName ?? '') || leftProject.localeCompare(rightProject) ||
      laneCards(b) - laneCards(a) ||
      compareByOrder(order.workspaces, workspaceKey(directory, a.workspaceId, a.cwd), workspaceKey(directory, b.workspaceId, b.cwd)) ||
      workspaceName(a.workspaceId, a.cwd, directory).localeCompare(workspaceName(b.workspaceId, b.cwd, directory));
  };
  const rank = (reasons: string[]) => reasons.includes('awaitingUser') ? 0 : reasons.includes('blocked') ? 1 : 2;
  return {
    boards: data.boards.filter(belongs).sort((a, b) => compare(a, b) || a.id.localeCompare(b.id)),
    attention: data.attention.filter(c => belongs(c) && (reason === 'all' || c.reasons.includes(reason)))
      .sort((a, b) => rank(a.reasons) - rank(b.reasons) || compare(a, b) || a.id.localeCompare(b.id)),
  };
}
