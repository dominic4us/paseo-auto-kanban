import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { toolLook, useHovered } from './components.js';
import { dropdownPosition } from './dropdown-state.js';
import type { Palette } from './palette.js';
import { px } from './ui-scale.js';

/**
 * REQ-111/114: a small menu hanging right under the control that opened it, the way a card's ⋯ (REQ-85 ⑧) and the card
 * order (REQ-79) open theirs on a wide screen — Escape or a press outside closes it, and the focus goes back to the control.
 * `align` says which edge of the control the menu lines up with: the right for a control near the right of the screen.
 */
export type Anchor = { x: number; y: number; width: number; height: number };
type Measurable = { measureInWindow?: (callback: (x: number, y: number, w: number, h: number) => void) => void; focus?: () => void } | null;
export function usePopover(trigger: RefObject<View | null>) {
  const [open, setOpen] = useState(false), [anchor, setAnchor] = useState<Anchor>({ x: 8, y: 0, width: px(30), height: px(30) });
  const restore = useRef(false);
  const show = () => {
    const node = trigger.current as Measurable;
    if (node?.measureInWindow) node.measureInWindow((x, y, width, height) => { setAnchor({ x, y, width, height }); setOpen(true); });
    else setOpen(true);
  };
  const close = () => { restore.current = true; setOpen(false); };
  const returnFocus = () => { if (restore.current) { restore.current = false; (trigger.current as Measurable)?.focus?.(); } };
  return { open, anchor, show, close, returnFocus };
}
export function PopoverMenu({ open, anchor, rows, align = 'right', onClose, onDismiss, label, closeLabel, testID, colors: c, children }: {
  open: boolean; anchor: Anchor; rows: number; align?: 'left' | 'right'; onClose: () => void; onDismiss?: () => void;
  label: string; closeLabel: string; testID: string; colors: Palette; children: ReactNode;
}) {
  const viewport = useWindowDimensions(), below = dropdownPosition(anchor, viewport, rows, px(34));
  const position = align === 'right'
    ? { ...below, left: Math.max(px(8), Math.min(anchor.x + anchor.width - below.width, viewport.width - below.width - px(8))) } : below;
  return <Modal testID={testID + '-modal'} visible={open} transparent animationType="none" onRequestClose={onClose} {...(onDismiss ? { onDismiss } : {})}>
    <View style={{ flex: 1 }} onAccessibilityEscape={onClose}>
      <Pressable testID={testID + '-dismiss'} accessibilityRole="button" accessibilityLabel={closeLabel} onPress={onClose}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <View testID={testID} accessibilityRole="menu" accessibilityLabel={label} style={{ position: 'absolute', ...position,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, borderRadius: px(8), padding: px(4), gap: px(2) }}>
        {children}
      </View>
    </View>
  </Modal>;
}
/** One row of a `PopoverMenu`: grey under the mouse, faded when it cannot be picked; `trailing` sits at its right end. */
export function PopoverRow({ testID, label, onPress, disabled = false, icon, trailing, colors: c, spoken }: {
  testID: string; label: string; onPress: () => void; disabled?: boolean; icon?: string; trailing?: ReactNode; colors: Palette;
  spoken?: string;
}) {
  const hover = useHovered();
  const look = toolLook(c, { hovered: hover.hovered && !disabled, fill: c.surface1, quiet: false, onto: c.surface1, mark: false });
  return <Pressable testID={testID} accessibilityRole="menuitem" role="menuitem" accessibilityLabel={spoken ?? label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: px(32), paddingHorizontal: px(10), borderRadius: px(6), flexDirection: 'row', alignItems: 'center', gap: px(8),
      backgroundColor: look.backgroundColor, opacity: disabled ? .4 : 1 }}>
    {!!icon && <Icon name={icon} size={px(14)} color={c.foregroundMuted} />}
    <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: px(13) }}>{label}</Text>
    {trailing}
  </Pressable>;
}
