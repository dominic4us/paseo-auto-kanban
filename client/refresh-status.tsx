import { Text } from 'react-native';
import type { AutoRefreshStatus } from './auto-refresh.js';
import type { Copy } from './i18n.js';
import type { Palette } from './palette.js';
import { px } from './ui-scale.js';

/** HH:MM on this device's clock, the way a person reads "last checked". */
export function clockTime(at: number): string {
  const time = new Date(at), pad = (n: number) => String(n).padStart(2, '0');
  return pad(time.getHours()) + ':' + pad(time.getMinutes());
}
export function refreshStatusText(status: AutoRefreshStatus, m: Copy): string {
  return status.kind === 'off' ? m.refreshOff : status.kind === 'live' ? m.refreshLive : m.refreshPaused(clockTime(status.lastLook));
}
/**
 * REQ-66 ④: a quiet line beside the progress. It changes only when polling starts or pauses (never per
 * second or per look), and any touch, click or key that resumes the polling also turns it back to live.
 */
export function RefreshStatus({ status, colors, m, compact = false }: { status: AutoRefreshStatus; colors: Palette; m: Copy; compact?: boolean }) {
  return <Text testID="refresh-status" numberOfLines={1} accessibilityLiveRegion="polite"
    style={{ color: colors.foregroundMuted, fontSize: compact ? px(10) : px(11), flexShrink: 1 }}>{refreshStatusText(status, m)}</Text>;
}
