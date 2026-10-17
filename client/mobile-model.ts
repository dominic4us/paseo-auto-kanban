import type { BoardDTO } from '../shared/rpc.js';
import type { Directory } from './presentation.js';
import { swimlaneModel, type LaneStates, type ViewFilterOptions } from './swimlane-model.js';

/**
 * Project the desktop model's ordered lanes; never implement a second sort/fold policy. REQ-148: `stageId` '' (no tab chosen
 * yet) shows the tab `openingStage` picks; the result's `stageId` is the tab shown.
 */
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
  const shown = stageId || openingStage(stages, 'doing');
  const sections = ordered.flatMap(({ group, lane }) => {
    const cell = lane.cells.find(c => c.stageId === shown);
    return cell && (cell.matchingCount > 0 || lane.total === 0) ? [{ group, lane, cell }] : [];
  });
  return { ...common, stages, sections, stageId: shown };
}
/**
 * REQ-148: the tab a phone opens on before a person picks one — `usual` (In progress on the Kanban screen, the first stage on a
 * board) while it has cards, else the first stage with cards in the stages' order, else `usual` (no cards anywhere). It no
 * longer opens on an empty In progress with "No cards yet" while the cards wait in To Do (research/350).
 */
export function openingStage(stages: readonly { stageId: string; count: number }[], usual: string): string {
  if (stages.some(s => s.stageId === usual && s.count > 0)) return usual;
  return stages.find(s => s.count > 0)?.stageId ?? usual;
}
export function attentionStage(stages: readonly { stageId: string; count: number }[]): string {
  return stages.reduce((best, current) => current.count > best.count ? current : best,
    stages[0] ?? { stageId: 'doing', count: 0 }).stageId;
}
