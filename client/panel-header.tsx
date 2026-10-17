import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Palette } from './palette.js';
import { SWIMLANE } from './swimlane-model.js';
import { px } from './ui-scale.js';

export function CountBadge({ count, colors, compact = false }: { count: number; colors: Palette; compact?: boolean }) {
  return <View testID="stage-count-badge" style={{ minWidth: compact ? px(16) : px(22), height: compact ? px(18) : px(20), paddingHorizontal: compact ? px(3) : px(5),
    borderRadius: px(5), backgroundColor: colors.badge, justifyContent: 'center', alignItems: 'center' }}>
    <Text style={{ color: colors.foreground, fontSize: compact ? px(10) : px(11), lineHeight: px(14), includeFontPadding: false }}>{count}</Text>
  </View>;
}
/** Independent header boundary for future sticky positioning; no scroll listener here. */
export function PanelHeader({ title, count, color, colors, trailing }: {
  title: string; count: number; color: string; colors: Palette;
  /** REQ-67 ⑤: pushed to the right end of the heading (the done column's board link). */
  trailing?: ReactNode;
}) {
  return <View testID="cell-panel-heading" style={{ height: SWIMLANE.columnHeaderHeight,
    flexDirection: 'row', alignItems: 'center', gap: px(7), marginHorizontal: px(-8), paddingHorizontal: px(8),
    borderTopLeftRadius: px(8), borderTopRightRadius: px(8), borderBottomWidth: 1,
    borderBottomColor: colors.divider, backgroundColor: colors.panelHeader }}>
    <View testID="stage-color-dot" style={{ width: px(6), height: px(6), borderRadius: px(3), backgroundColor: color }} />
    <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: px(13), fontWeight: '600' }}>{title}</Text>
    <CountBadge count={count} colors={colors} />
    {trailing !== undefined && <><View style={{ flex: 1 }} />{trailing}</>}
  </View>;
}
