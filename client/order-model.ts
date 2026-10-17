import type { UiOrderDTO } from '../shared/rpc.js';

/**
 * REQ-59: the order the user arranged, and the only place that decides what a move means.
 *
 * A list holds the keys the user has placed; everything else is still ordered automatically and comes
 * after them (③). Moving one row therefore pins the whole group as it is on screen at that moment —
 * otherwise the rows around the moved one would keep sliding under it on the next refresh — while rows
 * that arrive later stay unpinned and sort automatically behind the pinned ones.
 */
export type LaneOrder = UiOrderDTO;
/**
 * REQ-75 A4: the flat board (one lane per workspace) keeps its own lane order in `flatWorkspaces`; the grouped
 * board keeps using `projects` and `workspaces`, so the order arranged before REQ-75 is the grouped one.
 */
export const flatOrder = (order: LaneOrder): readonly string[] => order.flatWorkspaces ?? [];
export type MoveDirection = 'top' | 'up' | 'down';
export const emptyLaneOrder = (): LaneOrder => ({ projects: [], workspaces: [] });
export const sameOrder = (a: LaneOrder, b: LaneOrder) =>
  sameKeys(a.projects, b.projects) && sameKeys(a.workspaces, b.workspaces) && sameKeys(flatOrder(a), flatOrder(b));
export const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
/** Listed keys lead in their listed order; two unlisted keys are left to the automatic sort keys. */
export function compareByOrder(list: readonly string[], a: string, b: string): number {
  const left = list.indexOf(a), right = list.indexOf(b);
  if (left < 0 && right < 0) return 0;
  if (left < 0) return 1;
  if (right < 0) return -1;
  return left - right;
}
export function canMove(keys: readonly string[], key: string, direction: MoveDirection): boolean {
  const at = keys.indexOf(key);
  if (at < 0) return false;
  return direction === 'down' ? at < keys.length - 1 : at > 0;
}
/**
 * REQ-64 ④: the rows a move can reach. Rows holding cards and card-less rows are two layers that never
 * mix (see swimlaneModel), so a row moves among the rows of its own layer, and "first"/"last" mean first
 * and last in that layer. Without `filled` the whole group is one layer.
 */
export function layerOf(keys: readonly string[], filled: ReadonlySet<string> | undefined, key: string): string[] {
  if (!filled) return [...keys];
  const upper = filled.has(key);
  return keys.filter(value => filled.has(value) === upper);
}
/** The group's keys after the move, in screen order. */
export function moveKey(keys: readonly string[], key: string, direction: MoveDirection): string[] {
  const at = keys.indexOf(key);
  if (at < 0 || !canMove(keys, key, direction)) return [...keys];
  const rest = keys.filter(value => value !== key);
  const to = direction === 'top' ? 0 : direction === 'up' ? at - 1 : at + 1;
  return [...rest.slice(0, to), key, ...rest.slice(to)];
}
/**
 * Write a group's screen order back into the stored list. Keys the group does not contain — another
 * project's workspaces, or a project the filter currently hides — keep the slots they already had, so
 * arranging what is visible never quietly reshuffles what is not.
 */
export function pinGroup(stored: readonly string[], group: readonly string[]): string[] {
  const inGroup = new Set(group);
  const queue = [...group], out: string[] = [];
  for (const key of stored) {
    if (!inGroup.has(key)) { out.push(key); continue; }
    const next = queue.shift();
    if (next !== undefined) out.push(next);
  }
  return [...out, ...queue];
}
/** REQ-59 ③: forget this group's placements, so its rows fall back to the automatic order. */
export function resetGroup(stored: readonly string[], group: readonly string[]): string[] {
  const inGroup = new Set(group);
  return stored.filter(key => !inGroup.has(key));
}
export function moveWorkspace(order: LaneOrder, group: readonly string[], key: string, direction: MoveDirection): LaneOrder {
  return { ...order, workspaces: pinGroup(order.workspaces, moveKey(group, key, direction)) };
}
export function moveProject(order: LaneOrder, group: readonly string[], key: string, direction: MoveDirection): LaneOrder {
  return { ...order, projects: pinGroup(order.projects, moveKey(group, key, direction)) };
}
export function moveFlatLane(order: LaneOrder, group: readonly string[], key: string, direction: MoveDirection): LaneOrder {
  return { ...order, flatWorkspaces: pinGroup(flatOrder(order), moveKey(group, key, direction)) };
}
export function resetWorkspaces(order: LaneOrder, group: readonly string[]): LaneOrder {
  return { ...order, workspaces: resetGroup(order.workspaces, group) };
}
/** What one ⋯ menu needs: whether each move is possible, and what it does. */
export interface OrderControl { canUp: boolean; canDown: boolean; onMove: (direction: MoveDirection) => void }
/**
 * The screens' single entry point. `projects` is the movable project order as shown (the group of
 * workspaces Paseo no longer has is never in it — D22 keeps it last); a lane moves among `lanes`, the
 * keys of the rows its project shows; a project's reset forgets `workspaces`, all of its workspaces,
 * shown or not. REQ-64 ④: `filledProjects` and a lane's `filled` name the rows holding cards; a move stays
 * in its layer and pins that layer only, so the stored list keeps its format and the other layer keeps
 * sorting automatically. A row that later changes layer keeps its place relative to the rows it was placed
 * with, because the stored list is still one sequence.
 */
export function orderActions(order: LaneOrder, setOrder: (next: LaneOrder) => void, projects: readonly string[],
  filledProjects?: ReadonlySet<string>) {
  const control = (keys: readonly string[], key: string, apply: (direction: MoveDirection) => LaneOrder): OrderControl => ({
    canUp: canMove(keys, key, 'up'), canDown: canMove(keys, key, 'down'), onMove: direction => setOrder(apply(direction)) });
  return {
    project: (projectId: string) => { const keys = layerOf(projects, filledProjects, projectId);
      return control(keys, projectId, direction => moveProject(order, keys, projectId, direction)); },
    lane: (lanes: readonly string[], key: string, filled?: ReadonlySet<string>) => { const keys = layerOf(lanes, filled, key);
      return control(keys, key, direction => moveWorkspace(order, keys, key, direction)); },
    /** REQ-75 A4: a lane of the flat board moves among the flat board's lanes and pins `flatWorkspaces` only. */
    flatLane: (lanes: readonly string[], key: string, filled?: ReadonlySet<string>) => { const keys = layerOf(lanes, filled, key);
      return control(keys, key, direction => moveFlatLane(order, keys, key, direction)); },
    canReset: (workspaces: readonly string[]) => workspaces.some(key => order.workspaces.includes(key)),
    reset: (workspaces: readonly string[]) => setOrder(resetWorkspaces(order, workspaces)),
    arranged: order.projects.length + order.workspaces.length + flatOrder(order).length > 0,
    resetAll: () => setOrder(emptyLaneOrder()),
  };
}
