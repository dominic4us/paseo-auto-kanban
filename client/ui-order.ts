import { useRpc } from '@getpaseo/plugin/client';
import { uiStateSet } from '../shared/rpc.js';
import { useSessionValue } from './session.js';
import { emptyLaneOrder, flatOrder, sameOrder, type LaneOrder } from './order-model.js';

export type LaneOrderState = readonly [LaneOrder, (next: LaneOrder) => void];

/**
 * REQ-59 ②: the arranged order, remembered per host in the same ledger file as the project filter. The
 * screen shows what the server remembered until the user moves something, then the in-memory value wins
 * and exactly one write goes out — the same shape as `useHiddenProjects`, and for the same reasons: a
 * screen that merely sits there writes nothing, and the demo keeps its own scope and never saves.
 */
export function useLaneOrder(scope: string, hostId: string, remote: LaneOrder | undefined,
  persist: boolean): LaneOrderState {
  const save = useRpc(uiStateSet);
  const [local, setLocal] = useSessionValue<LaneOrder | null>(scope, 'laneOrder', null);
  const value = local ?? remote ?? emptyLaneOrder();
  const update = (next: LaneOrder) => {
    if (sameOrder(next, value)) return;
    setLocal(next);
    if (persist) void save({ hostId, order: { projects: next.projects, workspaces: next.workspaces, flatWorkspaces: [...flatOrder(next)] } }).catch(() => {});
  };
  return [value, update];
}
