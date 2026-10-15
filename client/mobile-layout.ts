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
 * chip (`chipWidth`) apart at the right end, then the panel's actions (`trailingWidth`) if any.
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
