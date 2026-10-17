import { CountBadge } from './panel-header.js';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { MOBILE } from './mobile-layout.js';
import { readable, type Palette } from './palette.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';

export function MobileControls({ stages, selected, attention, count, onStage, onAttention, colors, m, actions }: {
  actions?: ReactNode;
  stages: readonly { stageId: string; name: string; count: number; color?: string }[];
  selected: string; attention: boolean; count: number; onStage: (id: string) => void;
  onAttention: () => void; colors: Palette; m: Copy;
}) {
  // REQ-71: [stage tabs] │ [attention] — the tabs move between stages, the chip filters, so it sits past a divider
  // at the right end, under the top bar's filter and ⚙, and does not read as a fifth stage.
  // REQ-148: each tab says its stage's whole name ("In progress", no shorter one on a phone) with its count under it, and is as
  // wide as that name (a finger's width at least); what is left is shared out evenly. Beside its count, an English name did
  // not fit at 360px or from 140% ("In pro…", then "Doing"); under it, the four fit at 360 and 390px up to 150%.
  // D64: the chip, with the divider before it and a panel's ⋯ after it, is one group that sits beside the tabs while they
  // fit together and otherwise drops to a line of its own under them, at the right end — English from 140%, Korean at 140%
  // on 360px and at 150%, a panel's ⋯ on 360px — instead of being pushed past the screen (it needed a sideways swipe).
  // The row wraps by the tabs' own widths, in Yoga as in a browser, so nothing is measured and the first frame is the
  // final one; the tabs alone still scroll if a board has more than fit. The chip is as wide as its words and count (at
  // least REQ-71's width), so "Needs attention 13" is never cut. At 100% the phone row is the one line it was.
  return <View testID="mobile-control-row" style={{ minHeight: MOBILE.controlHeight, flexGrow: 0, flexShrink: 0,
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 1, flexShrink: 1, height: MOBILE.controlHeight }}
      contentContainerStyle={{ flexGrow: 1, height: MOBILE.controlHeight, flexDirection: 'row', alignItems: 'center' }}>
      <View testID="mobile-stage-tabs" style={{ flexGrow: 1, flexDirection: 'row', height: MOBILE.touchSize }}>
        {stages.map(stage => <Pressable key={stage.stageId} testID={`mobile-tab-${stage.stageId}`}
          accessibilityRole="tab" accessibilityLabel={`${stage.name} ${stage.count}`}
          accessibilityState={{ selected: selected === stage.stageId }} onPress={() => onStage(stage.stageId)}
          style={{ height: MOBILE.touchSize, flexGrow: 1, minWidth: MOBILE.touchSize, justifyContent: 'center' }}>
          <View testID="mobile-tab-face" style={{ height: MOBILE.tabFace, borderRadius: px(5), paddingHorizontal: px(3),
            alignItems: 'center', justifyContent: 'center', gap: px(1),
            backgroundColor: selected === stage.stageId ? colors.surface2 : colors.surface0 }}>
            {/* D28: the selected face is `colors.surface2`, so a stage colour must be nudged to read there, not just against surface0. */}
            <Text numberOfLines={1} style={{ fontSize: px(11), lineHeight: px(14), color: selected === stage.stageId ? readable(stage.color ?? colors.foreground, colors.surface2) : colors.foreground, includeFontPadding: false }}>{stage.name}</Text>
            <CountBadge compact count={stage.count} colors={colors} />
          </View>
        </Pressable>)}
      </View>
    </ScrollView>
    <View testID="mobile-chip-group" style={{ marginLeft: 'auto', height: MOBILE.controlHeight, paddingLeft: MOBILE.controlGap,
      flexDirection: 'row', gap: MOBILE.controlGap, alignItems: 'center' }}>
      <View testID="mobile-control-divider" style={{ width: MOBILE.dividerWidth, height: MOBILE.tabFace - px(16), backgroundColor: colors.divider }} />
      <Pressable testID="mobile-attention-chip" accessibilityRole="button" accessibilityState={{ selected: attention }}
        accessibilityLabel={`${m.needsHuman} ${count}`} onPress={onAttention}
        style={{ minWidth: px(m.attentionChipWidth), height: MOBILE.touchSize, justifyContent: 'center' }}>
        <View testID="mobile-chip-face" style={{ height: MOBILE.chipFace, paddingHorizontal: px(6),
          borderRadius: px(5), flexDirection: 'row', gap: px(4), alignItems: 'center', justifyContent: 'center',
          backgroundColor: attention ? colors.surface2 : colors.surface1 }}>
          <Text numberOfLines={1} style={{ fontSize: px(11), lineHeight: px(14), color: colors.foreground, includeFontPadding: false }}>{m.needsHuman}</Text>
          <Text style={{ fontSize: px(11), lineHeight: px(14), color: colors.statusWarning, includeFontPadding: false }}>{count}</Text>
        </View>
      </Pressable>
      {actions && <View testID="panel-actions" style={{ width: MOBILE.touchSize }}>{actions}</View>}
    </View>
  </View>;
}
