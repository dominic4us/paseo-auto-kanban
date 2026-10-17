import { px, scaled } from './ui-scale.js';
// The host's 64 DIP header is the reference observed in the previous mobile gate.
// The plugin controls only the rows below it; real screen coordinates need host verification.
// REQ-71: the attention chip is as wide as its words ("확인 필요 9", about 76px) and as tall as a stage tab.
// REQ-139: the host's header heights are the host's and the divider is a line, so they keep their size.
export const MOBILE = scaled({ referenceHostHeader: 64, referencePanelHeader: 101, appbarHeight: 44, controlHeight: 44,
  chipWidth: 76, controlGap: 4, dividerWidth: 1, chipFace: 36, tabFace: 36, touchSize: 44,
  contextHeight: 16, boardCardGap: 4, horizontalPadding: 8, projectGap: 12 } as const,
  ['referenceHostHeader', 'referencePanelHeader', 'dividerWidth']);
export function firstCardY(kind: 'surface' | 'board' | 'panel', hostTop: number = kind === 'panel' ? MOBILE.referencePanelHeader : MOBILE.referenceHostHeader) {
  return hostTop + (kind === 'panel' ? 0 : MOBILE.appbarHeight) + MOBILE.controlHeight +
    (kind === 'surface' ? MOBILE.contextHeight : MOBILE.boardCardGap);
}
/**
 * REQ-71: the stage tabs lead and share what is left evenly; a divider with a gap each side sets the attention
 * chip (`chipWidth`) apart at the right end, then the panel's actions (`trailingWidth`) if any. REQ-148: the row draws each
 * tab as wide as its name and grows them evenly from there, so `contentWidth` is the least the row takes and `tabWidth` the
 * even share of it. D64: the row itself no longer reads this — it wraps the chip under the tabs by their own widths
 * (client/mobile-controls.tsx); this stays the arithmetic of one line with finger-wide tabs.
 */
export function mobileControls(width: number, stages = 4, chipWidth: number = MOBILE.chipWidth, trailingWidth = 0) {
  const available = Math.max(0, width - MOBILE.horizontalPadding * 2);
  const fixed = MOBILE.controlGap * 2 + MOBILE.dividerWidth + chipWidth + (trailingWidth ? trailingWidth + MOBILE.controlGap : 0);
  const contentWidth = Math.max(available, fixed + stages * MOBILE.touchSize);
  return { contentWidth, tabWidth: (contentWidth - fixed) / Math.max(1, stages) };
}
export function surfaceLayout(width: number, platform: 'web' | 'ios' | 'android'): 'mobile' | 'wide' | 'legacy' {
  return width < 760 ? 'mobile' : platform === 'web' ? 'wide' : 'legacy';
}
export function sectionGap(projectId: string, previousProjectId?: string): number {
  return previousProjectId !== undefined && projectId !== previousProjectId ? MOBILE.projectGap : 0;
}
/**
 * REQ-139: whether a phone's title row is too full for its title — its `glyphs` touch boxes (and the gaps after them) leave
 * the title less than 72px at the current size. Never at 100% (five glyphs leave 134px of 390); from about 120% with five,
 * when the title then takes a line of its own above the glyphs instead of being drawn under them.
 */
export function crowdedTitleRow(width: number, glyphs: number, gap: number, padding: number = MOBILE.horizontalPadding): boolean {
  return width - padding * 2 - glyphs * (MOBILE.touchSize + gap) < px(72);
}
/**
 * D60: the glyphs' own line under a crowded title — `gap` between them, or less when only less lets them share the line at
 * a finger's size (360px at 150%: five 66px glyphs leave 1.5px each); the last `lifted` go up beside the title when even
 * no gap is not enough (six at 150%, 396px of glyphs on a 336–366px line), so no glyph is left on a line of its own.
 */
export function glyphLine(width: number, glyphs: number, gap: number, padding: number = MOBILE.horizontalPadding) {
  const room = width - padding * 2;
  let lifted = 0;
  while (glyphs - lifted > 1 && (glyphs - lifted) * MOBILE.touchSize > room) lifted += 1;
  const shown = glyphs - lifted, spare = shown > 1 ? Math.floor((room - shown * MOBILE.touchSize) / (shown - 1) * 100) / 100 : gap;
  return { lifted, gap: Math.max(0, Math.min(gap, spare)) };
}
