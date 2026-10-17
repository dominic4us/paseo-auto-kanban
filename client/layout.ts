import type { BoardAlign } from '../shared/rpc.js';
import { px, scaled } from './ui-scale.js';
export type HostPlatform = 'web' | 'android' | 'ios';
/** Public host props expose no inset; use conservative clearance until one is available. */
export function bottomClearance(platform: HostPlatform): number {
  return platform === 'android' ? 56 : platform === 'ios' ? 44 : 16;
}
/**
 * REQ-87 ⑦: how tall the system bar under a bottom sheet is. Neither the plugin SDK (0.9.1: `layout` is only
 * `{ compact, platform }`, "safe-area clearance stays host-owned") nor React Native's core gives a safe-area inset, and a
 * plugin cannot bring react-native-safe-area-context. So: on Android, the screen minus the window minus the status bar
 * is the navigation bar when the app is not drawn edge to edge (a 3-button bar 48, a gesture bar 24); when that reads
 * nothing believable (edge to edge, or a split screen) the 3-button bar's 48 is assumed, the larger of the two, so the
 * last row is never under it. iOS has no such reading: the home indicator's 34 (a phone with a home button has none and
 * only gets 34px more room). The web page's own bottom is the window's: 0.
 */
export const NAV_BAR = { android: 48, gesture: 24, ios: 34 } as const;
export function navigationInset(platform: HostPlatform, measured?: { screen: number; window: number; statusBar?: number | undefined }): number {
  if (platform === 'web') return 0;
  if (platform === 'ios') return NAV_BAR.ios;
  if (measured) {
    const bar = Math.round(measured.screen - measured.window - (measured.statusBar ?? 0));
    if (bar >= 16 && bar <= 80) return bar;
  }
  return NAV_BAR.android;
}
/** REQ-87 ⑦: a sheet's scrolling area ends this far above the system bar. */
export const sheetBottomGap = () => px(8);
export function boardLayout(width: number, mobile: boolean) {
  const tabs = width < 760 || mobile;
  return { tabs, tabRow: { flexDirection: 'row' as const, height: px(44), flexGrow: 0, flexShrink: 0 },
    list: { flex: 1, minHeight: 0 },
    lane: tabs ? { flex: 1, minHeight: 0 } : { width: Math.max(px(245), (width - px(32)) / 4 - px(8)),
      minHeight: 0, height: '100%' as const },
  };
}
export function editorLayout(platform: HostPlatform, mobile: boolean, windowHeight: number) {
  return { bottom: bottomClearance(platform), buttonHeight: mobile ? px(48) : px(30),
    inputHeight: mobile ? px(44) : px(30), sheetHeight: Math.max(px(180), Math.min(px(720), Math.floor(windowHeight * .76))) };
}

/**
 * REQ-26/REQ-42 sticky headers. Each header pins to the top of its own section, so the next section's
 * header pushes it out instead of stacking on top of it. Project sections nest lane sections: the
 * project header pins at 0, the lane header at the project header's height, and when the project's
 * last lane scrolls past, both leave together and the next project header takes the top.
 * RN Web maps `position: 'sticky'` straight to CSS; the RN types omit the value, so it is cast like
 * `noOutline` in filter-bar. Native keeps the opaque background only — the wide swimlane never renders
 * outside web (`surfaceLayout` returns 'legacy' for ios/android), and the mobile screen pins its stage
 * tabs outside the scroll view instead.
 * The 1px bottom edge is what makes the boundary visible in dark (D17); `stickyEdge` is transparent in
 * light, where the shadow already shows it, so light keeps exactly the same picture.
 */
export const STICKY = scaled({ zIndex: 10, projectZIndex: 11, offsetY: 2, opacity: .12, radius: 3, elevation: 3,
  edgeWidth: 1, headerHeight: 44 } as const, ['zIndex', 'projectZIndex', 'opacity', 'elevation', 'edgeWidth']);
/** Where a lane header pins inside a project section: under the project header and its edge. */
export const projectHeaderHeight = () => STICKY.headerHeight + STICKY.edgeWidth;
export function stickyHeaderStyle(colors: { surface0: string; cardShadow: string; stickyEdge: string },
  web: boolean, top = 0, zIndex: number = STICKY.zIndex) {
  return { backgroundColor: colors.surface0, zIndex, shadowColor: colors.cardShadow,
    shadowOffset: { width: 0, height: STICKY.offsetY }, shadowOpacity: STICKY.opacity,
    shadowRadius: STICKY.radius, elevation: STICKY.elevation,
    borderBottomWidth: STICKY.edgeWidth, borderBottomColor: colors.stickyEdge,
    ...(web ? { position: 'sticky', top } as object : {}) };
}

/** REQ-54: all wide rows share the board edge, after 16px screen padding on each side. */
export function boardHeaderWidth(screenWidth: number, contentWidth: number): number {
  return Math.min(Math.max(0, screenWidth - px(32)), Math.max(0, contentWidth));
}
/**
 * REQ-66: where the board block — title row, filter row, demo banner and board, one right edge (REQ-54) —
 * starts inside the plugin area. The spare width beside the board goes left, both sides or right; when
 * the area is narrower than the board there is none, so it starts at the left and scrolls sideways
 * whatever the setting says (the setting itself is kept).
 */
export function boardOffset(screenWidth: number, contentWidth: number, align: BoardAlign): number {
  const spare = Math.max(0, screenWidth - px(32) - Math.max(0, contentWidth));
  return align === 'left' ? 0 : align === 'right' ? Math.floor(spare) : Math.floor(spare / 2);
}
/** REQ-66: the settings window — never wider than 720 or taller than 560, always 48px inside the plugin area on each side. */
export const SETTINGS_WINDOW = scaled({ maxWidth: 720, maxHeight: 560, margin: 96, narrow: 760, nav: 180, navNarrow: 150 } as const, ['narrow']);
export function settingsWindowSize(area: { width: number; height: number }) {
  return { width: Math.max(0, Math.min(SETTINGS_WINDOW.maxWidth, area.width - SETTINGS_WINDOW.margin)),
    height: Math.max(px(240), Math.min(SETTINGS_WINDOW.maxHeight, area.height - SETTINGS_WINDOW.margin)) };
}
/**
 * A generous width of `text` at font `size`: a Hangul or CJK character as wide as the size, any other 0.6 of it.
 * research/210's name floor (client/group-header.tsx); REQ-124 sizes the workflow's nodes with it, so it lives in this pure module.
 */
export function textWidth(text: string, size: number): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? size : size * .6;
  return Math.ceil(width);
}
