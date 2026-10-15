import { CountBadge } from './panel-header.js';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { MOBILE, mobileControls } from './mobile-layout.js';
import { readable, type Palette } from './palette.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';

export function MobileControls({ width, stages, selected, attention, count, onStage, onAttention, colors, m, actions }: {
  actions?: ReactNode;
  width: number; stages: readonly { stageId: string; name: string; count: number; color?: string; tab?: string }[];
  selected: string; attention: boolean; count: number; onStage: (id: string) => void;
  onAttention: () => void; colors: Palette; m: Copy;
}) {
  const layout = mobileControls(width, stages.length, px(m.attentionChipWidth), actions ? MOBILE.touchSize : 0);
  // REQ-71: [stage tabs] │ [attention] — the tabs move between stages, the chip filters, so it sits past a divider
  // at the right end, under the top bar's filter and ⚙, and does not read as a fifth stage.
  return <View testID="mobile-control-row" style={{ height: MOBILE.controlHeight, flexGrow: 0, flexShrink: 0 }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}
      contentContainerStyle={{ width: layout.contentWidth, height: MOBILE.controlHeight,
        flexDirection: 'row', gap: MOBILE.controlGap, alignItems: 'center' }}>
      <View testID="mobile-stage-tabs" style={{ flexDirection: 'row', height: MOBILE.touchSize }}>
        {stages.map(stage => <Pressable key={stage.stageId} testID={`mobile-tab-${stage.stageId}`}
          accessibilityRole="tab" accessibilityLabel={`${stage.name} ${stage.count}`}
          accessibilityState={{ selected: selected === stage.stageId }} onPress={() => onStage(stage.stageId)}
          style={{ height: MOBILE.touchSize, width: layout.tabWidth, justifyContent: 'center' }}>
          <View testID="mobile-tab-face" style={{ height: MOBILE.tabFace, borderRadius: px(5), paddingHorizontal: px(3),
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: px(2),
            backgroundColor: selected === stage.stageId ? colors.surface2 : colors.surface0 }}>
            {/* D28: the selected face is `colors.surface2`, so a stage colour must be nudged to read there, not just against surface0. */}
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: px(11), lineHeight: px(14), color: selected === stage.stageId ? readable(stage.color ?? colors.foreground, colors.surface2) : colors.foreground, includeFontPadding: false }}>{stage.tab ?? stage.name}</Text>
            <CountBadge compact count={stage.count} colors={colors} />
          </View>
        </Pressable>)}
      </View>
      <View testID="mobile-control-divider" style={{ width: MOBILE.dividerWidth, height: MOBILE.tabFace - px(16), backgroundColor: colors.divider }} />
      <Pressable testID="mobile-attention-chip" accessibilityRole="button" accessibilityState={{ selected: attention }}
        accessibilityLabel={`${m.needsHuman} ${count}`} onPress={onAttention}
        style={{ width: px(m.attentionChipWidth), height: MOBILE.touchSize, justifyContent: 'center' }}>
        <View testID="mobile-chip-face" style={{ height: MOBILE.chipFace, paddingHorizontal: px(6),
          borderRadius: px(5), flexDirection: 'row', gap: px(4), alignItems: 'center', justifyContent: 'center',
          backgroundColor: attention ? colors.surface2 : colors.surface1 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: px(11), lineHeight: px(14), color: colors.foreground, includeFontPadding: false }}>{m.needsHuman}</Text>
          <Text style={{ fontSize: px(11), lineHeight: px(14), color: colors.statusWarning, includeFontPadding: false }}>{count}</Text>
        </View>
      </Pressable>
      {actions && <View testID="panel-actions" style={{ width: MOBILE.touchSize }}>{actions}</View>}
    </ScrollView>
  </View>;
}
