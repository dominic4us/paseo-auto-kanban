import { useSessionValue } from './session.js';
import type { HiddenProjects } from './hidden-projects.js';
import { beginAttentionFilter, collapseProject, foldAllLanes, type LaneStates, type ProjectGroup, type ProjectStates } from './swimlane-model.js';
import { filterCount, keepGoneHidden, presentHidden, type BoardFilters } from './filter-model.js';
/** D42: `present` is the projects there now (null while not known); the hidden ones beyond it are kept, never shown or counted. */
export function useBoardFilters(scope: string, labelsAvailable = true,
  hidden: HiddenProjects = [[], () => {}], present: ReadonlySet<string> | null = null) {
  const [labels, setLabels] = useSessionValue<string[]>(scope, 'labels', []);
  const [query, setQuery] = useSessionValue(scope, 'query', '');
  const [attention, setAttention] = useSessionValue(scope, 'attention', false);
  const [lanes, setLanes] = useSessionValue<LaneStates>(scope, 'lanes', {});
  const [projects, setProjects] = useSessionValue<ProjectStates>(scope, 'projectFolds', {});
  const filters = { hiddenProjects: presentHidden(hidden[0], present), labels: labelsAvailable ? labels : [], query, attention };
  const update = (patch: Partial<BoardFilters>) => {
    if (patch.hiddenProjects !== undefined) hidden[1](keepGoneHidden(patch.hiddenProjects, hidden[0], present));
    if (patch.labels !== undefined) setLabels(patch.labels);
    if (patch.query !== undefined) setQuery(patch.query);
    if (patch.attention !== undefined) setAttention(patch.attention);
    setProjects({}); setLanes(beginAttentionFilter);
  };
  return { filters, lanes, setLanes, projects, count: filterCount(filters), update,
    reset: () => update({ hiddenProjects: [], labels: [], query: '', attention: false }),
    foldProject: (group: ProjectGroup, collapsed: boolean) => {
      const next = collapseProject(projects, lanes, group, collapsed); setProjects(next.projects); setLanes(next.lanes);
    },
    /** REQ-85 ⑦: fold every workspace shown, or open every one (and their projects). */
    foldAll: (groups: readonly ProjectGroup[], collapsed: boolean) => {
      const next = foldAllLanes(lanes, projects, groups, collapsed); setProjects(next.projects); setLanes(next.lanes);
    } };
}
