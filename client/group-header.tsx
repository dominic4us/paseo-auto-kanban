import { useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { Button, IconButton, RaiseTip, TIP, usePointerTip, useTipPlace } from './components.js';
import { LaneProgress } from './progress.js';
import { sameName } from './presentation.js';
import { projectColorIndex, projectInitial } from './project-icon.js';
import { projectColors, projectIconForeground, type Palette } from './palette.js';
import type { ProjectGroup } from './swimlane-model.js';
import type { Copy } from './i18n.js';
import { textWidth } from './layout.js';
import { px } from './ui-scale.js';
export function ProjectIcon({ group, m }: { group: ProjectGroup; m: Copy }) {
  return <View testID="project-icon" accessibilityLabel={group.projectName || m.unlinked}
    style={{ width: px(16), height: px(16), borderRadius: px(4), alignItems: 'center', justifyContent: 'center',
      backgroundColor: projectColors[projectColorIndex(group.projectViewKey)] }}>
    <Text style={{ color: projectIconForeground, fontSize: px(9), lineHeight: px(12), includeFontPadding: false }}>{projectInitial(group.projectName || m.unlinked)}</Text>
  </View>;
}
/**
 * REQ-75 F1: RN Web gives every View `position: relative; z-index: 0`, so each one is its own stacking context
 * and a tip's own zIndex only counts among its siblings. The lane name's tip hangs below the heading row, over
 * the stage headings of its lane and, near the end of a section, over the next lane or project — all later in
 * the page, so all painted above it. While a tip shows, every TipLayer between it and the board lifts itself
 * one step above its siblings; nothing else moves. The raise travels up through context, and a layer passes
 * its children through untouched, so a hover re-renders the layers only, never the cards. REQ-80: every glyph's tip
 * raises through the same context (`useTipPlace`), so a lane glyph's tip, now below it, is drawn over the columns too.
 */
export function TipLayer({ testID, style, children }: { testID?: string; style?: ViewStyle; children: ReactNode }) {
  const [raised, setRaised] = useState(false), parent = useContext(RaiseTip);
  const raise = useCallback((shown: boolean) => { setRaised(shown); parent(shown); }, [parent]);
  return <RaiseTip.Provider value={raise}>
    <View testID={testID} style={{ ...style, ...(raised ? { zIndex: 1 } : {}) }}>{children}</View>
  </RaiseTip.Provider>;
}
/**
 * REQ-42: a pinned lane header carries the lane's own name; pinned and unpinned look the same, because the
 * text never depends on scrolling. One line, cut with … (REQ-65 ⑧).
 *
 * REQ-75 A1: on the flat board a lane is a workspace on its own — the workspace in bold, then "· project" in
 * small muted text, left out when the two are called the same (REQ-65's case-insensitive rule). Under a
 * project heading (the grouped board) the project is already pinned above, so the lane keeps REQ-65 ⑥:
 * the workspace in regular weight and its `branch · folder` detail muted, so worktrees of one project tell apart.
 *
 * REQ-75 B1: the workspace name is the way into its board — a tap or a click opens it, and hovering or
 * focusing underlines it on the web. It no longer unfolds a cut name on a tap: the web shows the whole name
 * on hover or focus (RN Web passes no `title`, so the tip is drawn here, like IconButton's), and a phone shows
 * it on a long press, which wraps the name onto more lines until the next long press.
 * REQ-110: the tip says only what a press does — "Open board" — and the name itself stays on the row (a long press wraps it).
 * REQ-80: the tip follows every glyph's rule (`usePointerTip`) — a click leaves none behind, the keyboard's focus
 * shows it — and hangs below the name, or above it near the bottom of the window.
 */
export function LaneName({ project, workspace, detail = '', count, flat, expanded, onOpen, onToggleFull, colors, m,
  compact = false, disabled = false }: {
  project: string; workspace: string; detail?: string; count: number; flat: boolean; expanded: boolean;
  onOpen: () => void; onToggleFull: () => void; colors: Palette; m: Copy; compact?: boolean; disabled?: boolean;
}) {
  const [lit, setLit] = useState({ hover: false, focus: false }), pointer = usePointerTip(), box = useRef<View>(null);
  const quiet = flat ? sameName(project, workspace) ? '' : project : detail;
  // REQ-110: a screen reader hears the tip's words, then the whole name (folder and branch too) to tell lanes apart.
  const full = [workspace, quiet, flat ? detail : ''].filter(Boolean).join(' · ');
  const lines = expanded ? undefined : 1, size = compact ? px(11) : px(13), line = compact ? px(16) : px(20);
  const tip = !compact && pointer.shown, place = useTipPlace(tip, box, 'left', line + px(8));
  // research/210 (208-D1): on a phone the heading's figures and controls give way before the name does — the name keeps
  // room for its first characters (or all of a short one) and its count; the detail after it goes first.
  const floor = compact ? nameFloor(workspace, size) + textWidth(' (' + m.cardCount(count) + ')', size) : 0;
  return <View ref={box} testID="lane-name" style={{ flex: 1, minWidth: floor, flexDirection: 'row', alignItems: 'center', ...(tip ? { zIndex: 1 } : {}) }}>
    <Pressable testID="workspace-name-link" accessibilityRole="link" accessibilityLabel={m.goToBoard + ': ' + full}
      accessibilityHint={m.fullNameHint} accessibilityState={{ disabled, expanded }} onPress={() => { if (!disabled) onOpen(); }}
      onLongPress={onToggleFull} onPressIn={pointer.handlers.onPressIn}
      onHoverIn={() => { pointer.handlers.onHoverIn(); setLit(v => ({ ...v, hover: true })); }}
      onHoverOut={() => { pointer.handlers.onHoverOut(); setLit(v => ({ ...v, hover: false })); }}
      onFocus={() => { pointer.handlers.onFocus(); setLit(v => ({ ...v, focus: true })); }}
      onBlur={() => { pointer.handlers.onBlur(); setLit(v => ({ ...v, focus: false })); }}
      style={{ flexShrink: 1, minWidth: 0 }}>
      <Text testID="workspace-name-primary" numberOfLines={lines} style={{ color: colors.foreground, fontSize: size, lineHeight: line,
        fontWeight: flat ? '600' : '400', includeFontPadding: false,
        textDecorationLine: !disabled && (lit.hover || lit.focus) ? 'underline' : 'none' }}>{workspace}</Text>
    </Pressable>
    {!!quiet && <Text testID="workspace-name-detail" numberOfLines={lines} style={{ flexShrink: compact ? 100 : 1, minWidth: 0, color: colors.foregroundMuted,
      fontSize: compact ? px(10) : px(11), lineHeight: line, includeFontPadding: false }}> · {quiet}</Text>}
    <Text style={{ flexShrink: 0, color: colors.foreground, fontSize: size, lineHeight: line, includeFontPadding: false }}> ({m.cardCount(count)})</Text>
    {tip && <View testID="lane-name-tooltip" pointerEvents="none" style={{ position: 'absolute', left: 0,
      ...(place.side === 'below' ? { top: line + TIP.gap } : { bottom: line + TIP.gap }),
      maxWidth: px(560), paddingHorizontal: px(8), paddingVertical: px(3), borderRadius: px(5), zIndex: 20,
      backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }}>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: px(11), lineHeight: px(16) }}>{m.goToBoard}</Text>
    </View>}
  </View>;
}
/**
 * research/210 (208-D1): the room a 390px lane name keeps however much else its heading holds — its first
 * `NAME_FLOOR.chars` characters (an ellipsis takes the last one or two), or the whole name when it is shorter.
 */
export const NAME_FLOOR = { chars: 10 } as const;
export function nameFloor(name: string, size: number): number {
  return textWidth(Array.from(name).slice(0, NAME_FLOOR.chars).join(''), size);
}
export { textWidth };
/**
 * Kept independent so a later unit can place it directly in stickyHeaderIndices. `trailing` is where
 * REQ-59 ① hangs the order menu, after the figures, on both the wide and the 390px heading.
 */
export function ProjectHeader({ group, onToggle, colors, m, mobile = false, trailing }: {
  group: ProjectGroup; onToggle: () => void; colors: Palette; m: Copy; mobile?: boolean; trailing?: ReactNode;
}) {
  return <View testID="project-group-header" style={{ minHeight: px(44), flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
    <IconButton name={group.collapsed ? 'ChevronRight' : 'ChevronDown'} label={(group.collapsed ? m.expandProject : m.foldProject) + ': ' + group.projectName}
      onPress={onToggle} colors={colors} mobile={mobile} />
    <ProjectIcon group={group} m={m} />
    <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: px(13), fontWeight: '600' }}>{group.projectName || m.unlinked}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: px(11) }}>{m.workspaceCount(group.workspaceCount)}</Text>
    {!mobile && <LaneProgress progress={group.progress} colors={colors} m={m} />}
    {mobile && <Text style={{ color: colors.foregroundMuted, fontSize: px(10) }}>{m.cardsProgress(group.progress.done, group.progress.requested)}</Text>}
    <Text style={{ color: colors.foregroundMuted, fontSize: px(11) }}>{m.needsHuman} {group.attention}</Text>
    {trailing}
  </View>;
}
/**
 * REQ-60 ⑤: the thin line down the left of an indented block, in the host border colour. It is drawn
 * twice per lane — once in the lane section and once inside its opaque pinned header — so the header's
 * background never cuts the line, pinned or not. It never takes a touch.
 */
export function LaneRail({ left, top = 0, bottom = 0, colors }: { left: number; top?: number; bottom?: number; colors: Palette }) {
  return <View testID="lane-rail" pointerEvents="none"
    style={{ position: 'absolute', left, top, bottom, width: px(1), backgroundColor: colors.border }} />;
}
export function DemoBanner({ onExit, colors, m, mobile = false }: { onExit: () => void; colors: Palette; m: Copy; mobile?: boolean }) {
  return <View testID="demo-banner" style={{ minHeight: mobile ? px(44) : px(32), flexDirection: 'row', alignItems: 'center', gap: px(8),
    paddingHorizontal: px(8), backgroundColor: colors.surface2 }}>
    <Text style={{ flex: 1, color: colors.foreground, fontWeight: '600' }}>{m.demo}</Text>
    <Button label={m.exitDemo} onPress={onExit} colors={colors} mobile={mobile} />
  </View>;
}
