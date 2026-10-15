import type { BoardDTO } from '../shared/rpc.js';
import type { Directory } from './presentation.js';
import { swimlaneModel, type LaneStates, type ViewFilterOptions } from './swimlane-model.js';

/** Project the desktop model's ordered lanes; never implement a second sort/fold policy. */
export function mobileSwimlaneModel(boards: BoardDTO[], directory: Directory, hidden: readonly string[],
  attentionOnly: boolean, states: LaneStates, stageId: string, options: ViewFilterOptions = {}) {
  const common = swimlaneModel(boards, directory, hidden, attentionOnly, states, options);
  const stageIds = ['todo', 'doing', 'review', 'done'];
  const sum = (id: string, of: (cell: typeof common.groups[number]['lanes'][number]['cells'][number]) => number) =>
    common.groups.reduce((total, group) => total + group.lanes.reduce((n, lane) => {
      const cell = lane.cells.find(c => c.stageId === id); return n + (cell ? of(cell) : 0); }, 0), 0);
  // REQ-93: every card of the stage, sub-cards included, so the four tabs add up to the lanes' totals.
  const stages = stageIds.map(id => ({ stageId: id, count: sum(id, cell => cell.matchingCount) }));
  // REQ-57 ⑥: a card-less workspace is listed under every stage, the same way it is on the wide screen.
  // REQ-75: the grouped board lists lanes project by project, the flat board in its own order.
  const ordered = options.grouped === false ? common.lanes.map(({ group, ...lane }) => ({ group, lane }))
    : common.groups.flatMap(group => group.lanes.map(lane => ({ group, lane })));
  const sections = ordered.flatMap(({ group, lane }) => {
    const cell = lane.cells.find(c => c.stageId === stageId);
    return cell && (cell.matchingCount > 0 || lane.total === 0) ? [{ group, lane, cell }] : [];
  });
  return { ...common, stages, sections };
}
export function attentionStage(stages: readonly { stageId: string; count: number }[]): string {
  return stages.reduce((best, current) => current.count > best.count ? current : best,
    stages[0] ?? { stageId: 'doing', count: 0 }).stageId;
}
