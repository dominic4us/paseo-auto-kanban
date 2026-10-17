import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon, TextInput } from '@getpaseo/plugin/client/react-native';
import { ProjectDropdown } from './project-dropdown.js';
import { Dropdown } from './dropdown.js';
import { Button, IconButton } from './components.js';
import { FoldAllChoice, GroupToggle, SortChoice } from './view-tools.js';
import type { CardOrder } from './card-order.js';
import { activeFilters, filterCount, labelKey, type ActiveFilter, type BoardFilters } from './filter-model.js';
import { PopoverMenu, PopoverRow, usePopover } from './popover-menu.js';
import { workspaceLabelColor, type Palette } from './palette.js';
import type { WorkspaceLabelsDTO } from '../shared/rpc.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';
// RN Web accepts outlineStyle 'none'; the RN types omit it. The border color carries the focus state instead (an outline would be clipped by the scroll viewport).
const noOutline = { outlineStyle: 'none', outlineWidth: 0 } as object;
export function FilterBar({ filters, onChange, onReset, projects, labels, attentionCount, colors, m, mobile = false, grouped, sort, folds, projectsLoading = false }: {
  filters: BoardFilters; onChange: (patch: Partial<BoardFilters>) => void; onReset: () => void;
  projects: ReadonlyMap<string, string>; labels: WorkspaceLabelsDTO | undefined; attentionCount: number;
  colors: Palette; m: Copy; mobile?: boolean;
  /**
   * REQ-75 A2 / REQ-81: on a phone, the grouping switch and (REQ-79) the card order head the filter sheet. The wide
   * screen has both on its title row, beside the view switch, so it passes neither.
   */
  grouped?: { value: boolean; onChange: (next: boolean) => void };
  sort?: { value: CardOrder; onChange: (next: CardOrder) => void };
  /** REQ-85 ⑦: on a phone, fold or open every workspace, right under "group by project". */
  folds?: { onChange: (collapsed: boolean) => void };
  /** REQ-78: the workspace listing is not known yet, so the project dropdown has no count to show. */
  projectsLoading?: boolean;
}) {
  const [projectOpen, setProjectOpen] = useState(false), [labelsOpen, setLabelsOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const count = filterCount(filters);
  /*
   * REQ-39: the filter controls stay left and the search field sits at the right end of the row. The
   * control group grows into the leftover space, which is what pushes the search across; when the row
   * is too narrow the search wraps to a second line and starts at the left, because a wrapped line
   * simply begins at flex-start (an auto left margin would keep it pinned right and look misaligned).
   */
  return <View testID="swimlane-filters" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8), paddingBottom: px(8) }}>
    {mobile && grouped && <View testID="group-toggle-row" style={{ width: '100%' }}><GroupToggle mobile {...grouped} colors={colors} m={m} /></View>}
    {mobile && folds && <View testID="fold-all-row" style={{ width: '100%' }}><FoldAllChoice {...folds} colors={colors} m={m} /></View>}
    {mobile && sort && <View testID="sort-choice-row" style={{ width: '100%' }}><SortChoice {...sort} colors={colors} m={m} /></View>}
    <View testID="filter-controls" style={{ flexGrow: 1, flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap',
      alignItems: 'center', gap: px(8) }}>
      <ProjectDropdown mobile={mobile} loading={projectsLoading} options={projects} hidden={filters.hiddenProjects} open={projectOpen} onOpenChange={setProjectOpen}
        onChange={hiddenProjects => onChange({ hiddenProjects })} colors={colors} m={m} />
      {labels?.available && <Dropdown mobile={mobile} testID="label-dropdown" multiple open={labelsOpen} onOpenChange={setLabelsOpen}
        selected={filters.labels} onSelect={values => onChange({ labels: values.filter((v): v is string => v !== null) })}
        options={labels.definitions.map(label => ({ id: labelKey(label.name), name: label.name, color: workspaceLabelColor(label.color) }))}
        label={m.labels + ' (' + filters.labels.length + ')'} accessibilityLabel={m.labels + ' ' + filters.labels.length}
        closeLabel={m.close} colors={colors} />}
      {!mobile && <Pressable testID="attention-chip" accessibilityRole="button" accessibilityState={{ selected: filters.attention }}
        accessibilityLabel={m.needsHuman + ' ' + attentionCount} onPress={() => onChange({ attention: !filters.attention })}
        style={{ height: px(30), paddingHorizontal: px(10), flexDirection: 'row', alignItems: 'center', gap: px(6), borderRadius: px(6),
          backgroundColor: filters.attention ? colors.surface2 : colors.surface1 }}>
        <Text style={{ color: colors.foreground, fontSize: px(13) }}>{m.needsHuman}</Text>
        <Text testID="attention-count" style={{ color: colors.statusWarning, fontSize: px(12) }}>{attentionCount}</Text>
      </Pressable>}
      {!mobile && <FilterMenu filters={filters} onChange={onChange} onReset={onReset} colors={colors} m={m}
        labelName={key => labels?.definitions.find(label => labelKey(label.name) === key)?.name ?? key} />}
      {mobile && count > 0 && <><Text testID="active-filter-count" style={{ color: colors.foregroundMuted, fontSize: px(12) }}>{m.filterCount(count)}</Text>
        <Button label={m.resetFilters} onPress={onReset} colors={colors} mobile={mobile} /></>}
    </View>
    <View testID="board-tools" style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), maxWidth: '100%', ...(mobile ? { width: '100%' } : {}) }}>
    <View testID="board-search-field" style={{ flexDirection: 'row', alignItems: 'center', width: mobile ? '100%' : px(260), maxWidth: '100%', flexShrink: 1 }}>
      <View style={{ flex: 1 }}>
        <TextInput testID="board-search" accessibilityLabel={m.search} placeholder={m.search} placeholderTextColor={colors.foregroundMuted} value={filters.query}
          onChangeText={query => onChange({ query })} autoCorrect={false}
          onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
          style={{ height: mobile ? px(44) : px(30), borderRadius: px(6), borderWidth: 1, borderColor: searchFocused ? colors.accent : colors.border,
            ...noOutline, backgroundColor: colors.surface1, color: colors.foreground, paddingLeft: px(30), paddingRight: px(8), fontSize: px(13) }} />
        <View testID="board-search-icon" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          aria-hidden style={{ position: 'absolute', left: px(8), top: px(((mobile ? 44 : 30) - 16) / 2), width: px(16), height: px(16),
            alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="Search" size={px(14)} color={colors.foregroundMuted} />
        </View>
      </View>
      {!!filters.query && <IconButton name="X" label={m.clearSearch} onPress={() => onChange({ query: '' })} colors={colors} mobile={mobile} />}
    </View>
    </View>
  </View>;
}
/**
 * REQ-114: on a wide screen, the filters in force are one glyph — the phone's filter glyph (REQ-91), tinted and carrying
 * how many while any apply — beside "needs a person". It opens a small menu under it, as a card's ⋯ does: each filter in
 * force with an ✕ that clears it alone, a line, then "Clear all". With none, no count, "No filters applied" and "Clear all"
 * faded. The row's own controls (projects, labels, "needs a person", the search) stay where they are to set filters.
 */
export function FilterMenu({ filters, onChange, onReset, labelName, colors: c, m }: {
  filters: BoardFilters; onChange: (patch: Partial<BoardFilters>) => void; onReset: () => void; labelName: (key: string) => string;
  colors: Palette; m: Copy;
}) {
  const trigger = useRef<View>(null), popover = usePopover(trigger);
  const active = activeFilters(filters, labelName), count = filterCount(filters);
  const name = (entry: ActiveFilter) => entry.kind === 'projects' ? m.hiddenProjectsFilter(Number(entry.value))
    : entry.kind === 'label' ? m.labelFilter(entry.value) : entry.kind === 'attention' ? m.needsHuman : m.searchFilter(entry.value);
  // Clearing one leaves the menu open on the rest; the last one gone, it closes (nothing is left to clear).
  const clear = (entry: ActiveFilter) => { onChange(entry.clear); if (active.length <= 1) popover.close(); };
  return <>
    <IconButton testID="filter-menu" name="ListFilter" label={m.filtersApplied(count)} colors={c} mobile={false} tooltip tipAlign="left"
      on={count > 0} badge={count} buttonRef={trigger} onPress={() => popover.open ? popover.close() : popover.show()} />
    <PopoverMenu testID="filter-menu-list" open={popover.open} anchor={popover.anchor} rows={Math.max(1, active.length) + 2}
      align="left" onClose={popover.close} onDismiss={popover.returnFocus} label={m.filtersApplied(count)} closeLabel={m.close} colors={c}>
      {active.map(entry => <PopoverRow key={entry.id} testID={'filter-clear-' + entry.id} label={name(entry)}
        spoken={m.clearFilter(name(entry))} colors={c} onPress={() => clear(entry)}
        trailing={<Icon name="X" size={px(14)} color={c.foregroundMuted} />} />)}
      {!active.length && <Text testID="filter-menu-empty" style={{ color: c.foregroundMuted, fontSize: px(12), paddingHorizontal: px(10), paddingVertical: px(8) }}>
        {m.noActiveFilters}</Text>}
      <View style={{ height: px(1), marginVertical: px(4), backgroundColor: c.border }} />
      <PopoverRow testID="filter-clear-all" label={m.resetFilters} colors={c} disabled={!count}
        onPress={() => { popover.close(); onReset(); }} />
    </PopoverMenu>
  </>;
}
