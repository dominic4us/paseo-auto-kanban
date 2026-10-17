import { useRpc } from '@getpaseo/plugin/client';
import { uiStateSet } from '../shared/rpc.js';
import { useSessionValue } from './session.js';

export type HiddenProjects = readonly [readonly string[], (next: readonly string[]) => void];
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const normalize = (value: readonly string[]) => [...new Set(value)].sort();

/**
 * REQ-57 ④: the unchecked projects. The screen shows what the server remembered for this host until the
 * user changes something, then the in-memory choice wins and one write goes out. Choosing the same set
 * again writes nothing, and nothing is written while the screen merely sits there. The demo keeps its
 * own scope and never saves.
 */
export function useHiddenProjects(scope: string, hostId: string, remote: readonly string[] | undefined,
  persist: boolean): HiddenProjects {
  const save = useRpc(uiStateSet);
  const [local, setLocal] = useSessionValue<string[] | null>(scope, 'hiddenProjects', null);
  const value = local ?? normalize(remote ?? []);
  const update = (next: readonly string[]) => {
    const wanted = normalize(next);
    if (same(wanted, value)) return;
    setLocal(wanted);
    if (persist) void save({ hostId, hiddenProjects: wanted }).catch(() => {});
  };
  return [value, update];
}
