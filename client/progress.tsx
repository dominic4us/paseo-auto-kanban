import { progressMetrics } from './visual-model.js';
import { Text, View } from 'react-native';
import type { Palette } from './palette.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';
/** REQ-103 ③: the bar stays; the words beside it are "Cards 97/104" — what is counted, and no percent. */
export function LaneProgress({ progress, colors, m }: {
  progress: { done: number; requested: number }; colors: Palette; m: Copy;
}) {
  const metrics = progressMetrics(progress);
  return <View testID="lane-progress" accessibilityRole="progressbar"
    accessibilityValue={{ min: 0, max: 100, now: metrics.percent ?? 0 }}
    style={{ flexDirection: 'row', alignItems: 'center', gap: px(6) }}>
    <View testID="lane-progress-track" style={{ width: metrics.width, height: px(5), borderRadius: px(3), overflow: 'hidden', backgroundColor: colors.panel }}>
      <View testID="lane-progress-fill" style={{ width: metrics.fillWidth, height: px(5), backgroundColor: colors.stageDone }} />
    </View>
    <Text style={{ color: colors.foregroundMuted, fontSize: px(11) }}>{m.cardsProgress(progress.done, progress.requested)}</Text>
  </View>;
}
