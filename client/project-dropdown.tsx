import { projectChoices, projectSelection } from './visual-model.js';
import { Dropdown } from './dropdown.js';
import type { Palette } from './palette.js';
import type { Copy } from './i18n.js';
/**
 * REQ-57 ④: every project starts checked. Unchecking one hides it; the first row checks or clears them
 * all at once. The trigger shows how many of the projects are still on, and the menu stays open while
 * several boxes are ticked (the shared multi-select behaviour).
 */
export function ProjectDropdown({ options, hidden, open, onOpenChange, onChange, colors, m, mobile = false, loading = false }: {
  /** REQ-78: no workspace listing yet, so no project count to give (it would read "1/1"). */
  loading?: boolean;
  mobile?: boolean; options: ReadonlyMap<string, string>; hidden: readonly string[]; open: boolean;
  onOpenChange: (value: boolean) => void; onChange: (hidden: string[]) => void; colors: Palette; m: Copy;
}) {
  const visible = [...options.keys()].filter(id => !hidden.includes(id));
  const selected: (string | null)[] = [...visible, ...(visible.length === options.size ? [null] : [])];
  const label = loading ? m.projectsLoading : m.projectCount(visible.length, options.size);
  return <Dropdown mobile={mobile} testID="project-dropdown" multiple options={projectChoices(options, m.allProjects)}
    selected={selected} open={open} onOpenChange={onOpenChange}
    onSelect={next => onChange(projectSelection(options, selected, next))}
    label={label} accessibilityLabel={m.projects + ': ' + label} closeLabel={m.close} colors={colors} />;
}
