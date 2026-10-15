import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import { dropdownPosition, dropdownTransition, type DropdownEvent, type OptionId } from './dropdown-state.js';
import type { Palette } from './palette.js';
import { px } from './ui-scale.js';

/** Public RN modal supplies Escape and focus trapping; no host DOM or global keyboard listeners. */
export function Dropdown({ options, selected, open, multiple = false, onOpenChange, onSelect,
  label, accessibilityLabel, closeLabel, colors, testID, mobile = false }: {
  mobile?: boolean; options: readonly { id: OptionId; name: string; color?: string }[]; selected: readonly OptionId[]; open: boolean; multiple?: boolean;
  onOpenChange: (value: boolean) => void; onSelect: (value: readonly OptionId[]) => void;
  label: string; accessibilityLabel: string; closeLabel: string; colors: Palette; testID: string;
}) {
  const trigger = useRef<View>(null), restore = useRef(false), alive = useRef(true);
  const [anchor, setAnchor] = useState({ x: 8, y: 0, width: px(220), height: px(30) });
  const viewport = useWindowDimensions(), position = dropdownPosition(anchor, viewport, options.length, mobile ? px(44) : px(32));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const restoreFocus = () => { if (restore.current && !open) { restore.current = false; trigger.current?.focus(); } };
  const send = (event: DropdownEvent) => {
    const next = dropdownTransition({ open, selected, restoreFocus: false }, event, multiple);
    restore.current = next.restoreFocus;
    if (event.type === 'select') onSelect(next.selected);
    onOpenChange(next.open);
  };
  const toggle = () => {
    if (open) { send({ type: 'close', reason: 'toggle' }); return; }
    // Native Modal also remembers this focused opener for its own post-unmount restoration.
    trigger.current?.focus();
    if (trigger.current) trigger.current.measureInWindow((x, y, width, height) => {
      if (!alive.current) return;
      setAnchor({ x, y, width, height }); send({ type: 'open' });
    });
    else send({ type: 'open' });
  };
  return <View testID={testID} style={{ width: px(220) }}>
    <Pressable ref={trigger} testID={testID + '-trigger'} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: open }} onPress={toggle}
      style={{ height: mobile ? px(44) : px(30), paddingHorizontal: px(10), borderRadius: px(6), borderWidth: 1,
        borderColor: colors.border, backgroundColor: colors.surface1, flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: px(13) }}>{label}</Text>
      <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={px(14)} color={colors.foregroundMuted} />
    </Pressable>
    <Modal testID={testID + '-modal'} visible={open} transparent animationType="none"
      onRequestClose={() => send({ type: 'close', reason: 'escape' })} onDismiss={restoreFocus}>
      <View style={{ flex: 1 }} onAccessibilityEscape={() => send({ type: 'close', reason: 'escape' })}>
        <Pressable testID={testID + '-dismiss'} accessibilityRole="button" accessibilityLabel={closeLabel}
          onPress={() => send({ type: 'close', reason: 'outside' })}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
        <View testID={testID + '-menu'} accessibilityRole="menu" style={{ position: 'absolute', ...position,
          borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, borderRadius: px(8), padding: px(4) }}>
          <ScrollView>{options.map(option => <Pressable key={JSON.stringify(option.id)} accessibilityRole="menuitem"
            accessibilityLabel={option.name} accessibilityState={multiple
              ? { checked: selected.includes(option.id) } : { selected: selected.includes(option.id) }}
            onPress={() => send({ type: 'select', id: option.id })}
            style={{ minHeight: mobile ? px(44) : px(32), paddingHorizontal: px(8), borderRadius: px(4), flexDirection: 'row', gap: px(6), alignItems: 'center',
              backgroundColor: selected.includes(option.id) ? colors.surface2 : colors.surface1 }}>
            {option.color && <View testID="label-color-dot" style={{ width: px(10), height: px(10), borderRadius: px(5), backgroundColor: option.color }} />}
            <Text style={{ flex: 1, color: colors.foreground, fontSize: px(13) }}>{option.name}</Text>
            {multiple && selected.includes(option.id) && <Icon name="Check" size={px(14)} color={colors.foreground} />}
          </Pressable>)}</ScrollView>
        </View>
      </View>
    </Modal>
  </View>;
}
