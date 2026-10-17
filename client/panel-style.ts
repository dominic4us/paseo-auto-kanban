import type { Palette } from './palette.js';
import type { LinkedCard } from './card-groups.js';
import { cardDimensions, leadRows, leadTitleOneLine, SWIMLANE } from './swimlane-model.js';
import { px } from './ui-scale.js';

// Host tokens supply the contrast; shadows are decorative, never the only boundary.
export function panelTokens(colors: Palette) {
  return { panel: colors.panel, card: colors.card };
}
export function cardDecoration(colors: Palette) {
  return { backgroundColor: panelTokens(colors).card, borderRadius: px(8),
    shadowColor: colors.cardShadow, shadowOffset: { width: 0, height: px(1) },
    shadowOpacity: .14, shadowRadius: 2, elevation: 2 };
}
/** Minimum shared height; flex stretch also accommodates larger accessibility text. */
export function lanePanelHeight(cells: readonly { cards: readonly LinkedCard[]; remaining: number; open?: boolean }[]) {
  // REQ-93: a sub-card is a row taller; REQ-99/104: a parent two, its summary and status rows inside it. REQ-84: a busy card
  // one, its busy row. REQ-92: "+N" or "Collapse". REQ-116: a lead whose short title fits one line, one title line less.
  // REQ-119: a lead with no sub-card yet, its status row alone.
  return Math.max(SWIMLANE.columnHeaderHeight + px(16), ...cells.map(cell =>
    SWIMLANE.columnHeaderHeight + px(16) +
    cell.cards.reduce((height, c) => height + cardDimensions(!!c.nextAction.trim(), 1, !!(c.parent || c.subParent), leadRows(c.family, !!c.subLead), !!c.busy,
      c.family && leadTitleOneLine(c.title, !!c.subLead) ? 1 : 2).minHeight, 0) +
    Math.max(0, cell.cards.length - 1) * px(8) + (cell.remaining > 0 || cell.open ? px(38) : 0)));
}
