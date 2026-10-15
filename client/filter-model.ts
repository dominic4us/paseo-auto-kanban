import type { BoardCardDTO, WorkspaceLabelsDTO } from '../shared/rpc.js';
/**
 * REQ-57 ④: every project is shown until the user unchecks it, so the filter stores what is hidden
 * rather than what is chosen. A project that appears later is therefore visible by default.
 */
export interface BoardFilters { hiddenProjects: string[]; labels: string[]; attention: boolean; query: string }
export const emptyFilters = (): BoardFilters => ({ hiddenProjects: [], labels: [], attention: false, query: '' });
export function hidesProject(hidden: readonly string[], projectId: string): boolean { return hidden.includes(projectId); }
/** The projects still shown, in the order the options were given. */
export function visibleProjects(options: ReadonlyMap<string, string>, hidden: readonly string[]): string[] {
  return [...options.keys()].filter(id => !hidden.includes(id));
}
/**
 * D42: the stored list can name projects Paseo no longer has (their workspaces went away). They are not counted, shown
 * or offered — `present` is the projects there now, `null` while that is not known yet (the list as stored until then).
 */
export function presentHidden(hidden: readonly string[], present: ReadonlySet<string> | null): string[] {
  return present ? hidden.filter(id => present.has(id)) : [...hidden];
}
/**
 * D42: … yet they stay in the stored list, so a project that comes back is still hidden. A choice made among the projects
 * there now (`next`) keeps every stored one that is not.
 */
export function keepGoneHidden(next: readonly string[], stored: readonly string[], present: ReadonlySet<string> | null): string[] {
  return present ? [...next, ...stored.filter(id => !present.has(id) && !next.includes(id))] : [...next];
}
export function normalizeSearch(value: string): string {
  return (typeof value.normalize === 'function' ? value.normalize('NFKC') : value).toLowerCase().replace(/\s+/g, ' ').trim();
}
export const labelKey = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
export function matchesSearch(card: Pick<BoardCardDTO, 'title' | 'nextAction'>, query: string): boolean {
  const text = normalizeSearch(card.title + ' ' + card.nextAction);
  return normalizeSearch(query).split(' ').filter(Boolean).every(term => text.includes(term));
}
export function matchesLabels(workspaceId: string, selected: string[], data?: WorkspaceLabelsDTO): boolean {
  if (!selected.length || !data?.available) return true;
  const names = new Set((data.byWorkspace[workspaceId] ?? []).map(labelKey));
  return selected.some(name => names.has(labelKey(name)));
}
export function filterCount(filters: BoardFilters): number {
  return Number(filters.hiddenProjects.length > 0) + filters.labels.length + Number(filters.attention) + Number(!!normalizeSearch(filters.query));
}
/**
 * REQ-114: the filters in force, one entry each, in the order the filter row shows them — the projects hidden (one entry
 * for all of them), each label, "needs a person", the search — with what clears that one alone. Always as many as
 * `filterCount`. `labelName` gives a label's own spelling for its stored key.
 */
export type ActiveFilter = { id: string; kind: 'projects' | 'label' | 'attention' | 'query'; value: string; clear: Partial<BoardFilters> };
export function activeFilters(filters: BoardFilters, labelName: (key: string) => string = key => key): ActiveFilter[] {
  return [
    ...(filters.hiddenProjects.length ? [{ id: 'projects', kind: 'projects' as const, value: String(filters.hiddenProjects.length),
      clear: { hiddenProjects: [] } }] : []),
    ...filters.labels.map(key => ({ id: 'label:' + key, kind: 'label' as const, value: labelName(key),
      clear: { labels: filters.labels.filter(other => other !== key) } })),
    ...(filters.attention ? [{ id: 'attention', kind: 'attention' as const, value: '', clear: { attention: false } }] : []),
    ...(normalizeSearch(filters.query) ? [{ id: 'query', kind: 'query' as const, value: filters.query.trim(), clear: { query: '' } }] : []),
  ];
}
