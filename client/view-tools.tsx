import { useRef, useState } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Tip, joinHandlers, toolLook, useHovered, usePointerTip, useTipPlace } from './components.js';
import { dropdownPosition } from './dropdown-state.js';
import { selectedTint, type Palette } from './palette.js';
import { CARD_ORDERS, type CardOrder } from './card-order.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';

/*
 * REQ-81: how the board is laid out — "group by project" and the card order — sits with the view switch on the wide
 * screen's title row (swimlanes | list), apart from the search and the filters, which choose what is shown. On a
 * phone both are the first rows of the filter sheet (the 390px top bar has no room for more glyphs).
 */

/** Space flips a switch, and RN Web presses on Space only for role "button" (REQ-77 ⑤). A held key flips it once. */
export const spaceFlips = (flip: () => void) => ({ onKeyDown: (e: { key?: string; repeat?: boolean; preventDefault?: () => void }) => {
  if (e.key !== ' ' && e.key !== 'Spacebar') return;
  e.preventDefault?.();
  if (!e.repeat) flip();
} }) as object;
/**
 * REQ-75 A2: "group by project". It says how the board is laid out, so it is not a filter: it never counts in
 * "Filters (N)" and "Reset" leaves it alone. REQ-80: off, a thin border; under the mouse, the hover fill. REQ-85 ②: on,
 * the main colour's tint with its glyph in the main colour (`toolLook`). Its label shows below it, centred, on hover or
 * keyboard focus and never after a click (REQ-75 G1, `usePointerTip`).
 */
export function GroupToggle({ value, onChange, colors: c, m, mobile = false }: {
  value: boolean; onChange: (next: boolean) => void; colors: Palette; m: Copy; mobile?: boolean;
}) {
  const tip = usePointerTip(), hover = useHovered(), box = useRef<View>(null);
  const place = useTipPlace(tip.shown && !mobile, box);
  const common = { testID: 'group-toggle', accessibilityRole: 'switch' as const, role: 'switch' as const, accessibilityLabel: m.groupByProject,
    accessibilityState: { checked: value }, 'aria-checked': value, onPress: () => onChange(!value), ...spaceFlips(() => onChange(!value)) };
  // REQ-85 ③ (③B): on, the sheet row is filled with the main colour's tint; its 1px edge gives way to the fill.
  if (mobile) return <Pressable {...common} style={{ minHeight: px(44), flexDirection: 'row', alignItems: 'center', gap: px(10), paddingHorizontal: px(10),
    borderRadius: px(6), borderWidth: 1, borderColor: value ? 'transparent' : c.border,
    backgroundColor: value ? selectedTint(c, c.surface1) : c.surface1 }}>
    <Icon name="FolderTree" size={px(16)} color={value ? c.foreground : c.foregroundMuted} />
    <Text style={{ flex: 1, color: c.foreground, fontSize: px(14) }}>{m.groupByProject}</Text>
    {value && <Icon name="Check" size={px(16)} color={c.foreground} />}
  </Pressable>;
  const look = toolLook(c, { on: value, hovered: hover.hovered, edge: true });
  return <View ref={box} style={{ width: px(30), height: px(30), ...(tip.shown ? { zIndex: 1 } : {}) }}>
    <Pressable {...common} {...joinHandlers(tip.handlers, { onHoverIn: hover.onHoverIn, onHoverOut: hover.onHoverOut })}
      style={{ width: px(30), height: px(30), borderRadius: px(6), borderWidth: look.borderWidth, borderColor: look.borderColor,
        alignItems: 'center', justifyContent: 'center', backgroundColor: look.backgroundColor }}>
      <Icon name="FolderTree" size={px(16)} color={look.icon} />
    </Pressable>
    {tip.shown && <Tip label={m.groupByProject} place={place} offset={px(30)} span={px(30)} colors={c} />}
  </View>;
}

/**
 * REQ-85 ⑦ (⑦A): fold every workspace, beside the card order on the wide screen's title row. Once all are folded the
 * same glyph opens them all. It acts at once, so it is a plain tool glyph (hover fill, tip below), never "on".
 */
export function FoldAllButton({ folded, onChange, colors: c, m, disabled = false }: {
  folded: boolean; onChange: (collapsed: boolean) => void; colors: Palette; m: Copy; disabled?: boolean;
}) {
  const tip = usePointerTip(), hover = useHovered(), box = useRef<View>(null), place = useTipPlace(tip.shown, box);
  const label = folded ? m.openAllLanes : m.foldAllLanes, look = toolLook(c, { hovered: hover.hovered && !disabled, edge: true });
  return <View ref={box} style={{ width: px(30), height: px(30), ...(tip.shown ? { zIndex: 1 } : {}) }}>
    <Pressable testID="fold-all" accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
      onPress={() => onChange(!folded)} {...joinHandlers(tip.handlers, { onHoverIn: hover.onHoverIn, onHoverOut: hover.onHoverOut })}
      style={{ width: px(30), height: px(30), borderRadius: px(6), borderWidth: look.borderWidth, borderColor: look.borderColor,
        alignItems: 'center', justifyContent: 'center', backgroundColor: look.backgroundColor, opacity: disabled ? .4 : 1 }}>
      <Icon name={folded ? 'ListChevronsUpDown' : 'ListChevronsDownUp'} size={px(16)} color={look.icon} />
    </Pressable>
    {tip.shown && <Tip label={label} place={place} offset={px(30)} span={px(30)} colors={c} />}
  </View>;
}
/**
 * REQ-85 ⑦ (⑦A) on a phone: two buttons side by side in the filter sheet, under "group by project" — what each does
 * is read before pressing it. 44px tall.
 */
export function FoldAllChoice({ onChange, colors: c, m }: { onChange: (collapsed: boolean) => void; colors: Palette; m: Copy }) {
  const button = (collapsed: boolean) => <Pressable key={String(collapsed)} testID={collapsed ? 'fold-all' : 'open-all'} accessibilityRole="button"
    accessibilityLabel={collapsed ? m.foldAllLanes : m.openAllLanes} onPress={() => onChange(collapsed)}
    style={{ flex: 1, minHeight: px(44), borderRadius: px(6), borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: px(8), paddingHorizontal: px(8) }}>
    <Icon name={collapsed ? 'ListChevronsDownUp' : 'ListChevronsUpDown'} size={px(16)} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: px(13) }}>{collapsed ? m.foldAllShort : m.openAllShort}</Text>
  </Pressable>;
  return <View testID="fold-all-choice" style={{ flexDirection: 'row', gap: px(6) }}>{[button(true), button(false)]}</View>;
}

export function sortLabel(order: CardOrder, m: Copy, short = false): string {
  return short ? { default: m.sortDefaultShort, updated: m.sortUpdatedShort, created: m.sortCreatedShort }[order]
    : { default: m.sortDefault, updated: m.sortUpdated, created: m.sortCreated }[order];
}
/**
 * REQ-79: the card order, one glyph beside "group by project". Pressing it opens a menu of the three orders under
 * it; choosing one closes the menu and applies it at once (no save button), and focus goes back to the glyph.
 * Escape or a press outside closes it unchanged. REQ-80/85 ②: "on" (tinted) while an order other than the default is
 * in force, so a board that is not in the ledger's order says so; REQ-85 ③: the chosen row is tinted only.
 */
export function SortMenu({ value, onChange, colors: c, m }: {
  value: CardOrder; onChange: (next: CardOrder) => void; colors: Palette; m: Copy;
}) {
  const [open, setOpen] = useState(false), [anchor, setAnchor] = useState({ x: 8, y: 0, width: px(30), height: px(30) });
  const trigger = useRef<View>(null), box = useRef<View>(null), restore = useRef(false);
  const tip = usePointerTip(), hover = useHovered(), place = useTipPlace(tip.shown && !open, box);
  // Under the glyph like the dropdowns, but ending at its right edge: the glyph sits near the right of the screen.
  const viewport = useWindowDimensions(), below = dropdownPosition(anchor, viewport, CARD_ORDERS.length, px(36));
  const position = { ...below, left: Math.max(px(8), Math.min(anchor.x + anchor.width - below.width, viewport.width - below.width - px(8))) };
  const label = m.sortCards + ': ' + sortLabel(value, m);
  const show = () => {
    const node = trigger.current as { measureInWindow?: (callback: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (node?.measureInWindow) node.measureInWindow((x, y, width, height) => { setAnchor({ x, y, width, height }); setOpen(true); });
    else setOpen(true);
  };
  const close = () => { restore.current = true; setOpen(false); };
  const choose = (next: CardOrder) => { close(); onChange(next); };
  // Like the dropdowns: once the menu is gone, focus goes back to the glyph that opened it.
  const returnFocus = () => { if (restore.current && !open) { restore.current = false; trigger.current?.focus(); } };
  const look = toolLook(c, { on: value !== 'default' || open, hovered: hover.hovered, edge: true });
  return <View ref={box} style={{ width: px(30), height: px(30), ...(tip.shown ? { zIndex: 1 } : {}) }}>
    <Pressable ref={trigger} testID="sort-menu" accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ expanded: open }} aria-haspopup="menu" onPress={() => open ? close() : show()}
      {...joinHandlers(tip.handlers, { onHoverIn: hover.onHoverIn, onHoverOut: hover.onHoverOut })}
      style={{ width: px(30), height: px(30), borderRadius: px(6), borderWidth: look.borderWidth, borderColor: look.borderColor,
        alignItems: 'center', justifyContent: 'center', backgroundColor: look.backgroundColor }}>
      <Icon name="ArrowDownWideNarrow" size={px(16)} color={look.icon} />
    </Pressable>
    {tip.shown && !open && <Tip label={label} place={place} offset={px(30)} span={px(30)} colors={c} />}
    <Modal testID="sort-menu-modal" visible={open} transparent animationType="none" onRequestClose={close} onDismiss={returnFocus}>
      <View style={{ flex: 1 }} onAccessibilityEscape={close}>
        <Pressable testID="sort-menu-dismiss" accessibilityRole="button" accessibilityLabel={m.close} onPress={close}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
        <View testID="sort-menu-list" accessibilityRole="menu" accessibilityLabel={m.sortCards} style={{ position: 'absolute', ...position,
          borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, borderRadius: px(8), padding: px(4), gap: px(2) }}>
          {CARD_ORDERS.map(order => <SortRow key={order} order={order} chosen={order === value} label={sortLabel(order, m)}
            onPress={() => choose(order)} colors={c} />)}
        </View>
      </View>
    </Modal>
  </View>;
}
function SortRow({ order, chosen, label, onPress, colors: c }: {
  order: CardOrder; chosen: boolean; label: string; onPress: () => void; colors: Palette;
}) {
  // REQ-85 ③ (③B): the chosen row is tinted only — its bold words and check mark say which one it is.
  const hover = useHovered(), look = toolLook(c, { on: chosen, hovered: hover.hovered, fill: c.surface1, quiet: false, onto: c.surface1, mark: false });
  return <Pressable testID={'sort-option-' + order} accessibilityRole="menuitem" role="menuitem" aria-checked={chosen}
    accessibilityLabel={label} accessibilityState={{ checked: chosen }} onPress={onPress}
    onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: px(32), paddingHorizontal: px(8), borderRadius: px(4), flexDirection: 'row', gap: px(6), alignItems: 'center',
      backgroundColor: look.backgroundColor }}>
    <Text style={{ flex: 1, color: c.foreground, fontSize: px(13), fontWeight: chosen ? '600' : '400' }}>{label}</Text>
    {chosen && <Icon name="Check" size={px(14)} color={c.foreground} />}
  </Pressable>;
}
/**
 * REQ-79/REQ-81 on a phone: the card order as a row of the filter sheet, under "group by project" — three 44px
 * choices side by side, the current one tinted (REQ-85 ③). Short words on screen; the full name is what
 * a screen reader hears.
 */
export function SortChoice({ value, onChange, colors: c, m }: {
  value: CardOrder; onChange: (next: CardOrder) => void; colors: Palette; m: Copy;
}) {
  return <View testID="sort-choice" accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.sortCards}
    style={{ minHeight: px(44), flexDirection: 'row', alignItems: 'center', gap: px(6) }}>
    <Icon name="ArrowDownWideNarrow" size={px(16)} color={c.foregroundMuted} />
    {CARD_ORDERS.map(order => { const chosen = order === value;
      return <Pressable key={order} testID={'sort-choice-' + order} accessibilityRole="radio" role="radio" aria-checked={chosen}
        accessibilityLabel={m.sortCards + ': ' + sortLabel(order, m)} accessibilityState={{ checked: chosen }}
        onPress={() => { if (!chosen) onChange(order); }} {...spaceFlips(() => { if (!chosen) onChange(order); })}
        style={{ flex: 1, minHeight: px(44), borderRadius: px(6), alignItems: 'center', justifyContent: 'center', paddingHorizontal: px(4),
          borderWidth: 1, borderColor: chosen ? 'transparent' : c.border, backgroundColor: chosen ? selectedTint(c, c.surface1) : c.surface1 }}>
        <Text numberOfLines={1} style={{ color: chosen ? c.foreground : c.foregroundMuted, fontSize: px(13), fontWeight: chosen ? '600' : '400' }}>
          {sortLabel(order, m, true)}</Text>
      </Pressable>; })}
  </View>;
}
