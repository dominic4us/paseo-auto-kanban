import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Dimensions, Modal as NativeModal, Easing, Keyboard, KeyboardAvoidingView, PanResponder, Pressable, StatusBar, Text, View,
  useWindowDimensions } from 'react-native';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { readable, type Palette } from './palette.js';
import { navigationInset, sheetBottomGap, type HostPlatform } from './layout.js';
import { IconButton } from './components.js';
import { px } from './ui-scale.js';

/** REQ-72: past this pull on the grab handle or the title a sheet lets go and closes. */
export const SHEET_DRAG_CLOSE = 80;
/** D29: how long the bottom sheet takes to rise or drop, and the curve it eases out on. */
const SHEET_MOTION_MS = 240;
const SHEET_EASING = Easing.out(Easing.cubic);

/**
 * REQ-72: every Kanban sheet and menu window, drawn here instead of by the host. The host sheet paints its
 * background, grab handle and title bar in the host's colours and SDK 0.9.1 cannot change them (D26), so a
 * Kanban theme other than the host's left the sheets in the host's set. This is a transparent RN `Modal` — the
 * same on Hermes and on the web: it covers the window, gives Android back and Escape (`onRequestClose`) and
 * keeps the screen's React context — with the background, handle, title bar and content all in `colors`.
 *
 * On a phone, and below 760px on the web, it rises from the bottom: rounded top corners, a grab handle that
 * closes it when pulled down and a keyboard that pushes it up instead of covering its fields. REQ-87 ⑦: its background
 * runs down behind the system bar, and its content — the scrolling list and anything under it — ends the bar's height
 * (`navigationInset`) plus 8px above the bottom, so no row rests under the bar; with the keyboard up the keyboard is the edge.
 * REQ-87 ⑥: the only close in it is the round × at the right of its head (a pull down, a press outside and the back
 * button close it too); a list inside it has no "Close" row of its own. Wider web windows get a centred dialog. `scroll={false}` hands the body
 * the whole height (an editor with its own scroll and footer).
 */
export function KanbanSheet({ title, open, onClose, onDismiss, colors: c, platform, closeLabel, testID, closeTestID,
  centered, width = px(560), height, scroll = true, children, canClose, headerExtra, onBack, notice }: {
  title: string; open: boolean; onClose: () => void; onDismiss?: (() => void) | undefined; colors: Palette; platform: HostPlatform;
  closeLabel: string; testID: string; closeTestID?: string; centered?: boolean; width?: number; height?: number;
  scroll?: boolean; children: ReactNode;
  /**
   * REQ-88 ⑤: asked before the sheet lets go (×, a pull, a press outside, back). `false` keeps it up — the detail then
   * saves what is still typed and closes itself once saved.
   */
  canClose?: (() => boolean) | undefined;
  /** REQ-88 ⑤: beside the title — the detail's "Saved 12:08". */
  headerExtra?: ReactNode;
  /**
   * REQ-134 MA: the back button (and Escape) first steps back inside the sheet — the message list's thread to its list —
   * while this answers true; × and a press outside still close it.
   */
  onBack?: (() => boolean) | undefined;
  /** REQ-125 F2: a line fixed under the head, above the scrolling body, so it is seen without scrolling (the pick list's refusal). */
  notice?: ReactNode;
}) {
  const screen = useWindowDimensions(), native = platform !== 'web';
  // REQ-87 ⑦: the system bar under the sheet, or none while the keyboard is up (it pushes the sheet above itself).
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    if (!native) return;
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true)), hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => { shown.remove(); hidden.remove(); };
  }, [native]);
  const inset = keyboard ? 0 : navigationInset(platform, native ? { screen: Dimensions.get('screen').height, window: screen.height,
    statusBar: StatusBar.currentHeight } : undefined);
  const dialog = centered ?? (!native && screen.width >= 760);
  // D29: "reduce motion" skips every animation below — the sheet just appears and disappears.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { if (alive) setReduceMotion(value); });
    return () => { alive = false; subscription.remove(); };
  }, []);
  // D29: `offset` carries both the finger's pull and the rise/drop animation — one value, so a drag that
  // crosses SHEET_DRAG_CLOSE just continues the same motion downward instead of snapping first. `dim` is the
  // backdrop's own fade, on the dialog's centred window this stays fixed — that one keeps the Modal's own
  // fade (or none on the web), unchanged from before D29.
  const travel = screen.height + 40;
  const offset = useRef(new Animated.Value(dialog ? 0 : travel)).current;
  const dim = useRef(new Animated.Value(dialog ? 1 : 0)).current;
  const closing = useRef(false);
  const requestCloseRef = useRef(() => {});
  const canCloseRef = useRef(canClose); canCloseRef.current = canClose;
  requestCloseRef.current = () => {
    if (canCloseRef.current && !canCloseRef.current()) { if (!dialog && !closing.current) offset.setValue(0); return; }
    if (dialog) { onClose(); return; }
    if (closing.current) return;
    closing.current = true;
    if (reduceMotion) { offset.setValue(travel); dim.setValue(0); onClose(); return; }
    Animated.timing(offset, { toValue: travel, duration: SHEET_MOTION_MS, easing: SHEET_EASING, useNativeDriver: native })
      .start(() => onClose());
    Animated.timing(dim, { toValue: 0, duration: SHEET_MOTION_MS, easing: SHEET_EASING, useNativeDriver: native }).start();
  };
  const requestClose = () => requestCloseRef.current();
  useEffect(() => {
    if (dialog || !open) return;
    closing.current = false;
    if (reduceMotion) { offset.setValue(0); dim.setValue(1); return; }
    offset.setValue(travel); dim.setValue(0);
    Animated.timing(offset, { toValue: 0, duration: SHEET_MOTION_MS, easing: SHEET_EASING, useNativeDriver: native }).start();
    Animated.timing(dim, { toValue: 1, duration: SHEET_MOTION_MS, easing: SHEET_EASING, useNativeDriver: native }).start();
    // The rising edge of `open` is the only trigger; `dialog`/`reduceMotion` are read live from the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const drag = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => offset.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => { if (g.dy > SHEET_DRAG_CLOSE || g.vy > 1) requestCloseRef.current(); else offset.setValue(0); },
    onPanResponderTerminate: () => offset.setValue(0),
  }), [offset]);
  const shape = dialog
    ? { width: Math.min(width, screen.width - px(32)), borderRadius: px(12) }
    : { width: Math.min(width, screen.width), borderTopLeftRadius: px(16), borderTopRightRadius: px(16), borderBottomWidth: 0,
      transform: [{ translateY: offset }] };
  return <NativeModal visible={open} transparent animationType={dialog && native ? 'fade' : 'none'} statusBarTranslucent navigationBarTranslucent
    onRequestClose={() => { if (!onBack?.()) requestClose(); }} {...(onDismiss ? { onDismiss } : {})}>
    {/* The keyboard shrinks the space below the sheet; a window the system already resized reports no overlap. */}
    <KeyboardAvoidingView enabled={native} behavior="padding"
      style={{ flex: 1, alignItems: 'center', justifyContent: dialog ? 'center' : 'flex-end' }}>
      <Animated.View pointerEvents="box-none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: dim }}>
        <Pressable testID={testID + '-backdrop'} accessibilityLabel={closeLabel} onPress={requestClose}
          style={{ flex: 1, backgroundColor: c.modalBackdrop }} />
      </Animated.View>
      <Animated.View testID={testID} role="dialog" aria-label={title} accessibilityViewIsModal
        style={{ ...shape, ...(height ? { height } : {}), maxHeight: screen.height * (dialog ? .85 : .9), flexShrink: 1, minHeight: 0,
          overflow: 'hidden', backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border }}>
        <View {...(dialog ? {} : drag.panHandlers)}>
          {/* D28: a drag-to-close cue needs 3:1; the old opacity-.5 muted grey composited under that on the sheet. */}
          {!dialog && <View testID="sheet-handle" style={{ alignItems: 'center', paddingTop: px(8) }}>
            <View style={{ width: px(36), height: px(4), borderRadius: px(2), backgroundColor: readable(c.foregroundMuted, c.surface0, 3) }} />
          </View>}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: px(16), paddingRight: px(8), minHeight: px(48),
            borderBottomWidth: 1, borderColor: c.border }}>
            <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: px(15), fontWeight: '600' }}>{title}</Text>
            {headerExtra}
            <IconButton testID={closeTestID ?? 'sheet-close'} name="X" label={closeLabel} onPress={requestClose}
              colors={c} mobile={!dialog} round iconSize={px(16)} />
          </View>
        </View>
        {/* REQ-87 ⑦: the content box itself stops above the bar; the sheet's own background fills the rest down to the edge. */}
        <View testID="sheet-content" style={{ flexShrink: 1, minHeight: 0, ...(scroll ? {} : { flex: 1 }),
          paddingBottom: dialog ? 0 : inset + sheetBottomGap() }}>
          {notice}
          {scroll
            ? <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: px(16), paddingBottom: dialog ? px(20) : px(8), gap: px(8) }}>{children}</ScrollView>
            : <View style={{ flex: 1, minHeight: 0 }}>{children}</View>}
        </View>
      </Animated.View>
    </KeyboardAvoidingView>
  </NativeModal>;
}
