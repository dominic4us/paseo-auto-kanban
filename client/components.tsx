import { stageColor } from './stage-color.js';
import type { Stage } from '../shared/core/domain.js';
import { cardDecoration } from './panel-style.js';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';
import { Image, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/react-native';
import type { Palette } from './palette.js';
import { COUNT_BADGE, countBadge, crownColors, hoverFill, medalColors, leaderOutline, markLine, readable, replyChip, replyColor, selectedLine, selectedTint, viewedTint } from './palette.js';
import type { Copy } from './i18n.js';
import { cardDimensions, LEAD_ROWS, leadRows, leadTitleOneLine, MARK_ROW, MARK_TOUCH, SWIMLANE } from './swimlane-model.js';
import { leadArchivedAgent, useBusyBy, useSignalSummary } from './agent-signals.js';
import { useSignalSource } from './signal-context.js';
import { ProviderMark, RING, SIGNAL_ICON, SidebarStateMark, signalText } from './status-icon.js';
import { isArchivedLead, isOrphanedCard, isUnassignedCard, type SignalBucket } from './signal-model.js';
import { useQuickMove, useRevealOnHover } from './quick-move.js';
import { doneStage, offersDone } from './move-model.js';
import { useMinuteClock } from './minute-clock.js';
import { RETURNED_HOVER_MS, afterThisTask, focusFromKeyboard, watchFocusKeys } from './focus-origin.js';
import { claimPressTip, dismissPressTip, outsidePress } from './press-tip.js';
import { assigneeName, elapsed, modelDisplayName, providerName, sidebarMark } from './card-meta.js';
import type { BoardCardDTO } from '../shared/rpc.js';
import { leadTitle, parentMark as shortParent } from './card-groups.js';
import { CROWN_BEADS_PNG, CROWN_FILLED_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG, MEDAL_RIBBON_PNG } from './leader-icons.js';
import { askingAgent, awaitingShown, familyFit, deviceClock, statusParts, type FamilyFit, type LeadSelf, type LeadStatus, type LeadStatusKind } from './lead-status.js';
import { dispatchFallback, dispatchLine, dispatchLook } from './dispatch-view.js';
import { dwellReason, stageDwell } from './stage-time.js';
import { busyView, SCREEN_BY } from './busy-view.js';
import { localStamp } from './move-reason.js';
import { px, scaled } from './ui-scale.js';

/**
 * REQ-75 G1 / REQ-77 ⑥: when a glyph's label shows beside it. A pointer press hides it, and the focus the click
 * leaves on the glyph is the pointer's, not the keyboard's, so the label stays away until the mouse comes back
 * or focus leaves. Keyboard focus still shows it (a key press is not a click) and the browser's focus ring is
 * untouched. RN Web hands a key press the keyboard event itself, so only a non-key press counts as a click.
 * REQ-77 F1: nor does focus handed back by a window that closed (⚙ after the settings window) — only focus that
 * Tab moved here shows it (`focusFromKeyboard`). And a hover reported just before or after that focus came back is
 * the mouse still resting where it clicked (the window was closed by Escape), so it counts as the click's until the
 * mouse leaves.
 */
export function usePointerTip() {
  const [tip, setTip] = useState({ hover: false, focus: false, clicked: false, pointerFocus: false, keyboard: false });
  const returned = useRef(-Infinity);
  useEffect(() => { watchFocusKeys(); }, []);
  const shown = tip.hover && !tip.clicked || tip.focus && tip.keyboard && !tip.pointerFocus;
  const handlers = {
    onHoverIn: () => { const resting = Date.now() - returned.current < RETURNED_HOVER_MS;
      setTip(v => ({ ...v, hover: true, clicked: v.clicked || resting })); },
    onHoverOut: () => { returned.current = -Infinity;
      setTip(v => ({ ...v, hover: false, clicked: false, pointerFocus: v.pointerFocus && v.focus })); },
    onPressIn: (e?: { nativeEvent?: unknown }) => {
      if (!/^key/.test(String((e?.nativeEvent as { type?: string } | undefined)?.type ?? '')))
        setTip(v => ({ ...v, clicked: true, pointerFocus: true }));
    },
    onFocus: () => { const keyboard = focusFromKeyboard(); if (!keyboard) returned.current = Date.now();
      setTip(v => ({ ...v, focus: true, keyboard, clicked: v.clicked || !keyboard && v.hover })); },
    onBlur: () => setTip(v => ({ ...v, focus: false, pointerFocus: false })),
  };
  return { shown, handlers };
}
/**
 * REQ-75 F1: RN Web gives every View `position: relative; z-index: 0`, so each one is its own stacking context and a
 * tip's own zIndex only counts among its siblings. While a tip shows, every `TipLayer` (group-header.tsx) between it
 * and the board lifts itself one step above its siblings. The raise travels up through this context.
 */
export const RaiseTip = createContext<(shown: boolean) => void>(() => {});
/**
 * REQ-80: a tip hangs below or above what it names, never beside it — a tool row's tips below the row (the row sits at
 * the top), and above when the control is too close to the bottom of the window for the tip to fit. It is anchored to
 * the control's left edge on the left half of the window and to its right edge on the right half, so it never runs off
 * the side. Measured when it shows; where nothing can be measured (native, tests) it hangs below at `align`.
 * research/121 F1: a tip inside a scroll view is cut at the scroll view's edge, not the window's, so a lane glyph near
 * the bottom of the board had room below in the window and none in the board. Whatever clips its tips publishes
 * itself through `TipArea`, and the tip then has to fit inside both.
 */
export type TipPlace = { side: 'below' | 'above'; align: 'left' | 'right';
  /**
   * REQ-85 ①: where the anchor sits in the window once measured, so a centred tip can be kept inside it. D51: `window` is
   * the right edge a tip can be seen up to and `start` the left one (`visibleSpan`) — the window's, or nearer where a box
   * around the anchor cuts what overflows it (the board's sideways scroll, the plugin's pane beside the host's panels).
   */
  anchor?: { x: number; width: number; window: number; start?: number } };
/** D51: `maxWidth` — a tip longer than this (or than the room it can be seen in) wraps onto more lines. */
export const TIP = scaled({ height: 22, gap: 4, margin: 8, maxWidth: 320 } as const);
/**
 * D51: the stretch across the window a tip under `node` can be seen in — the window, cut by every box around it that
 * clips what overflows it sideways (a scroll view, the plugin's pane when the host shows a panel beside it). Read on the
 * web only; elsewhere (native, tests) the window's whole width.
 */
export function visibleSpan(node: unknown, width: number): { start: number; end: number } {
  let start = 0, end = width;
  if (Platform.OS !== 'web' || typeof getComputedStyle !== 'function') return { start, end };
  for (let el = (node as { parentElement?: Element | null } | null)?.parentElement ?? null; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowX === 'visible') continue;
    const box = el.getBoundingClientRect();
    start = Math.max(start, box.left); end = Math.min(end, box.right);
  }
  return end - start > 2 * TIP.margin ? { start, end } : { start: 0, end: width };
}
type Measurable = { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void };
type Box = { x: number; y: number; width: number; height: number };
export const TipArea = createContext<RefObject<unknown> | null>(null);
export function tipPlace(anchor: Box, window: { width: number; height: number }, tipHeight: number = TIP.height, area?: Box | null): TipPlace {
  const top = Math.max(0, area?.y ?? 0), bottom = Math.min(window.height, area && area.height > 0 ? area.y + area.height : window.height);
  const below = anchor.y + anchor.height + TIP.gap + tipHeight + TIP.margin <= bottom;
  const above = anchor.y - TIP.gap - tipHeight - TIP.margin >= top;
  return { side: below || !above ? 'below' : 'above', align: anchor.x + anchor.width / 2 > window.width / 2 ? 'right' : 'left' };
}
export function useTipPlace(shown: boolean, anchor: RefObject<unknown>, align: TipPlace['align'] = 'right', tipHeight?: number): TipPlace {
  const [place, setPlace] = useState<TipPlace>({ side: 'below', align });
  const window = useWindowDimensions(), raise = useContext(RaiseTip), clip = useContext(TipArea);
  useEffect(() => {
    if (!shown) return;
    raise(true);
    const measure = (node: unknown, done: (box: Box | null) => void) => {
      const target = node as Measurable | null;
      if (typeof target?.measureInWindow === 'function') target.measureInWindow((x, y, width, height) => done({ x, y, width, height }));
      else done(null);
    };
    measure(clip?.current, area => (anchor.current as Measurable | null)?.measureInWindow?.((x, y, width, height) => {
      const span = visibleSpan(anchor.current, window.width);
      setPlace({ ...tipPlace({ x, y, width, height }, window, tipHeight, area), anchor: { x, width, window: span.end, start: span.start } });
    }));
    return () => raise(false);
  }, [shown, anchor, clip, window.width, window.height, raise, tipHeight]);
  return place;
}
/**
 * REQ-85 ①: a glyph's tip is centred under (or over) it — its middle on the glyph's middle — and pushed back inside
 * the window only where it would run past an edge (`TIP.margin` from it). `span` is the glyph's width, `own` the tip's.
 * Relative to the glyph's left edge.
 */
export function centeredTip(span: number, own: number, anchor?: TipPlace['anchor']): number {
  let left = (span - own) / 2;
  if (!anchor) return left;
  // D51: inside what can be seen of the window (`visibleSpan`), not the window alone.
  const low = (anchor.start ?? 0) + TIP.margin, start = anchor.x + left, end = start + own, limit = anchor.window - TIP.margin;
  if (start < low) left += low - start;
  else if (end > limit) left -= Math.min(end - limit, start - low);
  return left;
}
/** D51: how wide a tip may be — `TIP.maxWidth`, or less where less of the window can be seen; a longer one wraps. */
export function tipMaxWidth(anchor: TipPlace['anchor'] | undefined, window: number, width = TIP.maxWidth as number): number {
  const room = (anchor ? anchor.window - (anchor.start ?? 0) : window) - 2 * TIP.margin;
  return Math.max(px(80), Math.min(width, room));
}
/**
 * REQ-80: the tip's box, placed by `useTipPlace`. `offset` is the height of what it names. REQ-85 ①: `span` (the glyph's
 * width) centres it; until its own width is known (a first frame on the web, never where nothing lays out) it hangs
 * from the side `align` names, as before, and on the web it waits unseen for that one frame.
 */
export function Tip({ label, place, offset, colors, testID = 'icon-tooltip', width, lineHeight = px(14), span, onHeight }: {
  label: string; place: TipPlace; offset: number; colors: Palette; testID?: string; width?: number; lineHeight?: number; span?: number;
  /** research/180 D1: the height it was drawn at, for a tip whose height was only guessed when it was placed. */
  onHeight?: (height: number) => void;
}) {
  const [own, setOwn] = useState(0), window = useWindowDimensions().width;
  const centred = span !== undefined && own > 0;
  /*
   * D51: never wider than what can be seen of the window. A tip of its own width is as wide as its words (`max-content`, the
   * web) up to `TIP.maxWidth` and wraps past it; a given width (the lane's mail) is cut to the room the same way.
   */
  const most = tipMaxWidth(place.anchor, window, width), web = Platform.OS === 'web';
  const sized = width ? { width: most } : web ? { width: 'max-content', maxWidth: most } as unknown as { width: number } : {};
  return <View testID={testID} pointerEvents="none" onLayout={span === undefined && !onHeight ? undefined : event => {
    const next = Math.round(event.nativeEvent.layout.width); if (span !== undefined) setOwn(value => value === next ? value : next);
    onHeight?.(Math.round(event.nativeEvent.layout.height)); }}
    style={{ position: 'absolute', zIndex: 10,
    ...(place.side === 'below' ? { top: offset + TIP.gap } : { bottom: offset + TIP.gap }),
    ...(centred ? { left: centeredTip(span, own, place.anchor) } : place.align === 'right' ? { right: 0 } : { left: 0 }),
    ...(span !== undefined && !centred && Platform.OS === 'web' ? { opacity: 0 } : {}), ...sized,
    minHeight: TIP.height, paddingHorizontal: px(8), paddingVertical: (TIP.height - 2 - lineHeight) / 2, borderRadius: px(5), justifyContent: 'center',
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }}>
    <Text numberOfLines={width || web ? undefined : 1} style={{ color: colors.foreground, fontSize: px(11), lineHeight }}>{label}</Text>
  </View>;
}
/**
 * REQ-80: how a tool row glyph looks. Under the mouse its fill moves toward the text colour (`hoverFill`) and a quiet
 * glyph turns to the text colour. `edge` is the thin border a switch keeps while it is off.
 * REQ-85 ② (research/128 ②C): switched on or chosen, it is filled with the main colour's light tint (`selectedTint`,
 * mixed into `on` — what the control sits on) and its glyph is drawn in the main colour; no line. Under the mouse the
 * tint deepens rather than turning grey, so "on" and "hovered" never look alike. `mark` is the glyph's colour when on:
 * a chosen menu row (③B) keeps its words in the text colour and only its fill changes.
 */
export function toolLook(c: Palette, { on = false, hovered = false, fill = 'transparent', edge = false, quiet = true, onto = c.surface0, mark = true }: {
  on?: boolean; hovered?: boolean; fill?: string; edge?: boolean; quiet?: boolean; onto?: string; mark?: boolean;
}) {
  const base = fill === 'transparent' ? c.surface0 : fill;
  if (on) {
    const tint = selectedTint(c, onto, hovered);
    return { backgroundColor: tint, borderWidth: edge ? 1 : 0, borderColor: 'transparent',
      icon: mark ? selectedLine(c, tint) : c.foreground };
  }
  return { backgroundColor: hovered ? hoverFill(c, base) : fill,
    borderWidth: edge ? 1 : 0, borderColor: edge ? c.border : 'transparent',
    icon: hovered || !quiet ? c.foreground : c.foregroundMuted };
}
/** REQ-80: the mouse over a control, for `toolLook`. A phone has no hover, so it never turns on there. */
export function useHovered() {
  const [hovered, setHovered] = useState(false);
  return { hovered, onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) };
}
/** Calls every handler given for one event, in order (a tip's and the hover look's, say). */
type Handlers = { [event: string]: ((event?: never) => void) | undefined };
export function joinHandlers(...sets: Handlers[]): Handlers {
  const out: Handlers = {};
  for (const set of sets) for (const [key, handler] of Object.entries(set)) {
    const before = out[key];
    if (handler) out[key] = before ? (event?: never) => { before(event); handler(event); } : handler;
  }
  return out;
}
/**
 * REQ-45: `plain` is the quiet variant — same touch target, no filled square, smaller glyph — so a lane
 * disclosure never looks like the project disclosure sitting above it.
 */
export function IconButton({ name, label, onPress, mobile, colors, disabled = false, buttonRef,
  plain = false, iconSize = plain ? px(14) : px(17), testID, tooltip = false, on, tipAlign = 'right', round = false, badge }: {
  name: string; label: string; onPress: () => void; mobile: boolean; colors: Palette; disabled?: boolean;
  buttonRef?: Ref<View>; plain?: boolean; iconSize?: number; testID?: string;
  /** REQ-87 ⑥: a sheet's close — a 32px round fill (the touch box stays 44px on a phone). */
  round?: boolean;
  /** REQ-91: a small count at the glyph's top right (the filters applied); 0 or none shows nothing. */
  badge?: number | undefined;
  /**
   * REQ-67 ①: show `label` while the glyph is hovered or has the keyboard's focus. REQ-80: below it (above near the
   * bottom of the window), anchored at `tipAlign` until it can be measured.
   */
  tooltip?: boolean; tipAlign?: TipPlace['align'];
  /** REQ-80: a glyph that switches something on; on, it is tinted with the main colour (REQ-85 ②). */
  on?: boolean;
}) {
  // REQ-77 ⑥: a click (⚙ opening its window, say) leaves no label behind, as on "group by project" (REQ-75 G1).
  const tip = usePointerTip(), size = mobile ? px(44) : round ? px(32) : px(30), hover = useHovered(), box = useRef<View>(null);
  const place = useTipPlace(tooltip && tip.shown, box, tipAlign);
  // REQ-80: the fill a wide screen's glyph takes under the mouse. A phone has no hover and keeps its look.
  const look = toolLook(colors, { on: !!on, hovered: hover.hovered && !disabled && !mobile, fill: plain ? 'transparent' : colors.surface2, quiet: plain && !round });
  const face = round ? px(32) : mobile ? px(32) : px(30), count = badge && badge > 0 ? badge : 0, countLook = countBadge(colors, colors.surface0);
  return <View ref={box} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center',
    ...(tooltip && tip.shown ? { zIndex: 1 } : {}) }}>
    <Pressable ref={buttonRef} testID={testID} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled, ...(on === undefined ? {} : { selected: on }) }}
      onPress={onPress} disabled={disabled} hitSlop={mobile ? Math.max(0, (size - face) / 2) : 0}
      {...joinHandlers(tooltip ? tip.handlers : {}, { onHoverIn: hover.onHoverIn, onHoverOut: hover.onHoverOut })}
      style={{ width: face, height: face, borderRadius: round ? face / 2 : px(6), borderWidth: look.borderWidth, borderColor: look.borderColor,
        backgroundColor: round && !on && !(hover.hovered && !disabled && !mobile) ? colors.surface2 : look.backgroundColor,
        alignItems: 'center', justifyContent: 'center', opacity: disabled ? .4 : 1 }}>
      <Icon name={name} size={iconSize} color={look.icon} />
    </Pressable>
    {/* REQ-91: the count sits on the glyph's corner. REQ-118: small and quiet — the glyph's tint, a thin line, a main-colour figure. */}
    {count > 0 && <View testID={testID ? testID + '-badge' : undefined} pointerEvents="none" accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', top: (size - face) / 2 - COUNT_BADGE.overhang,
        right: (size - face) / 2 - COUNT_BADGE.overhang, minWidth: COUNT_BADGE.size, height: COUNT_BADGE.size, paddingHorizontal: px(3),
        borderRadius: COUNT_BADGE.size / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: countLook.fill, borderWidth: 1, borderColor: countLook.line }}>
      <Text style={{ color: countLook.text, fontSize: COUNT_BADGE.fontSize, lineHeight: COUNT_BADGE.lineHeight,
        fontWeight: COUNT_BADGE.fontWeight }}>{count > 9 ? '9+' : count}</Text>
    </View>}
    {tooltip && tip.shown && <Tip label={label} place={place} offset={size} span={size} colors={colors} />}
  </View>;
}
/**
 * REQ-68: how the Kanban screen is shown, as two joined glyphs — swimlanes | list. It is as tall as an IconButton,
 * so the title row keeps its height. REQ-85 ②: the current one is tinted with the main colour, one under the mouse
 * takes the hover fill, and each says what it is below it by the same rule as every glyph's tip (`usePointerTip`:
 * gone after a click, shown for the keyboard's focus).
 */
export type KanbanView = 'swimlane' | 'list';
export function ViewSwitch({ value, onChange, colors: c, m, disabled = [] }: {
  value: KanbanView; onChange: (next: KanbanView) => void; colors: Palette; m: Copy; disabled?: readonly KanbanView[];
}) {
  const views: { id: KanbanView; icon: string; label: string }[] = [
    { id: 'swimlane', icon: 'SquareKanban', label: m.swimlaneView }, { id: 'list', icon: 'List', label: m.listView }];
  return <View testID="view-switch" accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.viewSwitch}
    style={{ flexDirection: 'row', height: px(30), borderRadius: px(6), borderWidth: 1, borderColor: c.border }}>
    {views.map((view, index) => <ViewSwitchItem key={view.id} {...view} first={index === 0} selected={view.id === value}
      off={disabled.includes(view.id)} onPress={() => { if (view.id !== value) onChange(view.id); }} colors={c} />)}
  </View>;
}
function ViewSwitchItem({ id, icon, label, first, selected, off, onPress, colors: c }: {
  id: KanbanView; icon: string; label: string; first: boolean; selected: boolean; off: boolean; onPress: () => void; colors: Palette;
}) {
  const tip = usePointerTip(), hover = useHovered(), box = useRef<View>(null);
  const place = useTipPlace(tip.shown, box);
  const look = toolLook(c, { on: selected, hovered: hover.hovered && !off });
  return <View ref={box} style={{ width: px(30), height: px(28), ...(tip.shown ? { zIndex: 1 } : {}) }}>
    <Pressable testID={'view-' + id} accessibilityRole="radio" accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled: off }} role="radio" aria-checked={selected} aria-disabled={off}
      disabled={off} onPress={onPress} {...joinHandlers(tip.handlers, { onHoverIn: hover.onHoverIn, onHoverOut: hover.onHoverOut })}
      style={{ width: px(30), height: px(28), alignItems: 'center', justifyContent: 'center', opacity: off ? .4 : 1,
        backgroundColor: look.backgroundColor, borderWidth: look.borderWidth, borderColor: look.borderColor,
        ...(first ? { borderTopLeftRadius: px(5), borderBottomLeftRadius: px(5) } : { borderTopRightRadius: px(5), borderBottomRightRadius: px(5) }) }}>
      <Icon name={icon} size={px(16)} color={look.icon} />
    </Pressable>
    {tip.shown && <Tip label={label} place={place} offset={px(29)} span={px(30)} colors={c} />}
  </View>;
}
/** REQ-43: `minWidth` keeps a toggle the same size in both states, so what follows it never shifts. */
export function Button({ label, onPress, colors, mobile = false, selected = false, disabled = false, minWidth, testID }: {
  label: string; onPress: () => void; colors: Palette; mobile?: boolean; selected?: boolean; disabled?: boolean;
  minWidth?: number; testID?: string;
}) {
  return <Pressable testID={testID} accessibilityRole="button" onPress={onPress} disabled={disabled} accessibilityState={{ disabled, selected }}
    style={{ minHeight: mobile ? px(44) : px(30), justifyContent: 'center', ...(minWidth === undefined ? {} : { minWidth }) }}>
    <View style={{ minHeight: mobile ? px(32) : px(30), paddingHorizontal: px(10), justifyContent: 'center',
      borderRadius: px(6), backgroundColor: selected ? colors.surface2 : colors.surface0,
      ...(minWidth === undefined ? {} : { minWidth, alignItems: 'center' as const }) }}>
      <Text style={{ color: colors.foreground, fontSize: px(13) }}>{label}</Text>
    </View>
  </Pressable>;
}
/**
 * REQ-67 ②⑤: faint text that acts — the "+3" under a column and the "Board ›" on the done heading. The
 * label is what it says on screen; `description` is what a screen reader hears. Hover or focus brightens it.
 */
export function QuietLink({ label, description, onPress, colors, disabled = false, mobile = false, testID }: {
  label: string; description: string; onPress: () => void; colors: Palette; disabled?: boolean; mobile?: boolean; testID?: string;
}) {
  const [lit, setLit] = useState(false);
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={description} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} hitSlop={mobile ? px(8) : px(4)}
    onHoverIn={() => setLit(true)} onHoverOut={() => setLit(false)} onFocus={() => setLit(true)} onBlur={() => setLit(false)}
    style={{ minHeight: mobile ? px(32) : px(22), justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: px(4), borderRadius: px(4),
      opacity: disabled ? .4 : 1 }}>
    {/* D27: the resting colour is read against the panel it always sits on, so it clears 4.5:1 there. */}
    <Text style={{ color: lit ? colors.foreground : readable(colors.foregroundMuted, colors.panel), fontSize: px(12), lineHeight: px(16) }}>{label}</Text>
  </Pressable>;
}
export function Field({ label, children, colors }: { label: string; children: ReactNode; colors: Palette }) {
  return <View style={{ gap: px(4) }}><Text style={{ color: colors.foregroundMuted, fontSize: px(12) }}>{label}</Text>
    {typeof children === 'string' ? <Text selectable style={{ color: colors.foreground, fontSize: px(14) }}>{children}</Text> : children}
  </View>;
}
export function Notice({ text, colors, error = false, testID }: { text: string; colors: Palette; error?: boolean; testID?: string }) {
  return <Text testID={testID} accessibilityRole={error ? 'alert' : 'text'}
    style={{ color: error ? colors.statusDanger : colors.foregroundMuted, fontSize: px(12) }}>{text}</Text>;
}
/**
 * REQ-73 card face (research/88 plan B, research/93 structure):
 *   (state mark, as Paseo's sidebar draws it) title
 *   provider mark + name (· +N)          [Response needed] [Blocked] [Draft] [High|Low]  age
 *   → next action
 * The name is the agent's profile label, else its model, else its title, else its id (`assigneeName`).
 * Link labels stay in the detail view. The height stays 84/104 (`cardDimensions`).
 */
/**
 * REQ-85 ⑨: the card a person just looked at in the detail, tinted after the detail closes so the eye finds its way back —
 * REQ-95 ④: a grey step (`viewedTint`), no longer the main colour's, no line. A screen keeps it until another card is opened or the screen is left.
 */
export const ViewedCardContext = createContext<string | null>(null);
/** REQ-85 ⑨: from the card a screen's detail shows (`open`), the one to tint: the last one closed, none while one is open. */
export function useViewedCard(open: string | null): string | null {
  const [last, setLast] = useState<string | null>(null), previous = useRef(open);
  useEffect(() => {
    if (previous.current === open) return;
    setLast(open === null ? previous.current : null); previous.current = open;
  }, [open]);
  return open === null ? last : null;
}
/** REQ-85 ⑥: one card element's short explanation, below it, in the tool tips' look. Never takes a press. */
function CardHint({ testID, label, place, colors }: { testID: string; label: string; place: object; colors: Palette }) {
  return <View testID={testID} pointerEvents="none" accessibilityRole="text" style={{ position: 'absolute', zIndex: 10,
    paddingHorizontal: px(8), paddingVertical: px(3), borderRadius: px(5), backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, ...place }}>
    <Text style={{ color: colors.foreground, fontSize: px(11), lineHeight: px(14), includeFontPadding: false }}>{label}</Text>
  </View>;
}
/** Whether a web text box shows fewer lines than it has (RN Web clamps with overflow); nothing to tell where there is no DOM. */
function clipped(node: unknown): boolean {
  const box = node as { scrollHeight?: number; clientHeight?: number } | null;
  return typeof box?.scrollHeight === 'number' && typeof box.clientHeight === 'number' && box.scrollHeight > box.clientHeight + 1;
}
/**
 * REQ-104: a lead's status row, the card's last — lined up with the family line over it (a clock where that has its tree),
 * 11px and muted. Each part ("Running 2") is its own press (`press`, the card's `inner`: no detail opens) and is tinted
 * while it is on; idle (or "working", the lead's agent at work itself) says when the lead was last active and presses
 * nothing — not the card either (research/166 J1): the row is a press of its own that does nothing. On a touch screen a
 * press reaches half the gap over it and the card's padding under it (29px), and a part is 32px wide at least.
 *
 * REQ-130 (research/260 C): the lead's own state (`LeadSelfMark`) leads the row in place of the clock — always, the parts
 * after it — and with no part it is all the row says (still a press that does nothing). REQ-133: "Awaiting review" and
 * "Error" open the lead's chat (`open`, where a look clears the first and the second is read) wherever the host can.
 *
 * REQ-135: on a card with its family line the sub-cards' parts are said there (`moved`, `FamilyLine`), so this row is the
 * lead's own state alone; a lead with no family line (no sub-card yet) or no agent of its own keeps them here, as before.
 */
function LeadStatusRow({ testID, value, title, colors, m, face, lineHeight, gap, padding, reach, press, hover, now, open, moved = false }: {
  testID: string; value: NonNullable<Parameters<typeof CardTile>[0]['leadStatus']>; title: string; colors: Palette; m: Copy; face: string; lineHeight: number;
  gap: number; padding: number; reach: boolean; press: (action: () => void) => (event?: { stopPropagation?: () => void }) => void; hover: Handlers;
  now: number;
  /** REQ-133: opens the lead's own chat — given for "Awaiting review" and "Error" where the host can open it. */
  open?: (() => void) | undefined;
  /** REQ-135: the sub-cards' parts are on the family line, not here. */
  moved?: boolean;
}) {
  const { status } = value, mute = readable(colors.foregroundMuted, colors.card);
  const text = { fontSize: px(11), lineHeight, includeFontPadding: false } as const;
  const parts: { kind: LeadStatusKind; label: string }[] = moved ? [] : [
    ...(status.running.length ? [{ kind: 'running' as const, label: m.statusRunning(status.running.length) }] : []),
    ...(status.testing ? [{ kind: 'testing' as const, label: m.statusTesting(status.testing.at) }] : []),
    ...(awaitingShown(status) ? [{ kind: 'awaiting' as const, label: m.statusAwaiting(awaitingShown(status)) }] : []),
  ];
  const quiet = reach ? { marginTop: -gap / 2, paddingTop: gap / 2, marginBottom: -padding, paddingBottom: padding } : {};
  // REQ-130: the lead asking you itself shows no "Awaiting you" part (its wait is the mark), so the mark takes that press.
  // REQ-133: only "Awaiting answer" is that wait; "Awaiting review" and "Error" open the lead's chat instead.
  const markReach = reach ? { top: gap / 2, bottom: padding } : null, meKind = status.me?.kind;
  const markPress = status.self && meKind === 'asking' && !awaitingShown(status)
    ? { on: value.on === 'awaiting', title, face, onPress: press(() => value.onPress('awaiting')), hover, reach: markReach }
    : open && (meKind === 'unseen' || meKind === 'error')
      ? { on: false, title, face, onPress: press(open), hover, reach: markReach, opens: true } : undefined;
  const me = status.me ? <LeadSelfMark self={status.me} colors={colors} m={m} text={text} now={now} press={markPress} /> : null;
  if (me && markPress && !parts.length) return <View testID={testID} accessibilityLabel={m.leadStatus} style={{ height: lineHeight, maxWidth: '100%', flexDirection: 'row', alignItems: 'center' }}>{me}</View>;
  if (me && !parts.length) return <View testID={testID} accessibilityLabel={m.leadStatus} style={{ height: lineHeight, maxWidth: '100%', flexDirection: 'row', alignItems: 'center' }}>
    <Pressable testID="lead-status-quiet" accessible={false} focusable={false} onPress={press(() => {})} {...hover}
      style={{ flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', ...quiet }}>{me}</Pressable>
  </View>;
  if (!parts.length) return <View testID={testID} accessibilityLabel={m.leadStatus} style={{ height: lineHeight, maxWidth: '100%', flexDirection: 'row', alignItems: 'center' }}>
    <Pressable testID="lead-status-quiet" accessible={false} focusable={false} onPress={press(() => {})} {...hover}
      style={{ flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', ...quiet }}>
      <Icon name="Clock" size={px(11)} color={mute} />
      <Text testID={status.working ? 'lead-status-working' : 'lead-status-idle'} numberOfLines={1} style={{ ...text, flexShrink: 1, marginLeft: px(3), color: mute }}>
        {(status.working ? m.statusWorking : m.statusIdle)(status.idle ?? '')}</Text>
    </Pressable>
  </View>;
  return <View testID={testID} accessibilityLabel={m.leadStatus} style={{ height: lineHeight, maxWidth: '100%', flexDirection: 'row', alignItems: 'center' }}>
    {me ?? <Icon name="Clock" size={px(11)} color={mute} />}
    {/* A narrow column (a 264px card, English): only the check's part (and REQ-130 the lead's own state) gives way — the counts are never cut. */}
    {parts.map((part, index) => <View key={part.kind} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: part.kind === 'testing' ? 1 : 0, minWidth: 0,
      ...(index === 0 && !me ? { marginLeft: px(1) } : {}) }}>
      {(index > 0 || !!me) && <Text style={{ ...text, color: mute, ...(me && index === 0 ? { marginLeft: px(2) } : {}) }}>·</Text>}
      <StatusPart kind={part.kind} label={part.label} on={value.on === part.kind} title={title} colors={colors} m={m} face={face} text={text}
        onPress={press(() => value.onPress(part.kind))} hover={hover}
        reach={reach ? { top: gap / 2, bottom: padding } : null} />
    </View>)}
  </View>;
}
/**
 * REQ-130 (research/260 C ①): the lead's own state at the head of its status row — a turning blue ring and "Lead working ·
 * 12m" (in blue), a wait (in orange) or a grey circle and "Idle · since 17:42" (muted). The time is how long the state has
 * lasted (left out when neither the host nor the screen tells when it began) or, resting, the last activity (KST).
 * REQ-133 (research/264 J7): the wait says what it wants — an orange dot and "Awaiting answer · 5m", an orange ring and
 * "Awaiting review · 5m" (a finished turn not looked at yet), a red dot and "Error · 5m" (in red).
 */
function LeadSelfMark({ self, colors, m, text, now, press }: {
  self: LeadSelf; colors: Palette; m: Copy; text: { fontSize: number; lineHeight: number; includeFontPadding: false }; now: number;
  /**
   * REQ-130: the lead asking you itself, with no "Awaiting you" part to press — its "Awaiting answer" mark is that press (D43).
   * REQ-133: `opens` — "Awaiting review" or "Error", whose press opens the lead's chat.
   */
  press?: undefined | { on: boolean; title: string; face: string; onPress: (event?: { stopPropagation?: () => void }) => void; hover: Handlers;
    reach: { top: number; bottom: number } | null; opens?: boolean };
}) {
  const age = self.kind === 'rest' ? '' : self.since ? m.busyAge(elapsed(self.since, now) ?? { unit: 'now' }) : '';
  const label = self.kind === 'working' ? m.leadSelfWorking(age) : self.kind === 'asking' ? m.leadSelfAsking(age) : self.kind === 'unseen' ? m.leadSelfUnseen(age)
    : self.kind === 'error' ? m.leadSelfError(age) : m.leadSelfRest(deviceClock(self.since, now));
  const tone = self.kind === 'working' ? colors.running : self.kind === 'error' ? colors.statusDanger : self.kind === 'rest' ? colors.foregroundMuted : colors.statusWarning;
  const color = readable(tone, colors.card), line = readable(tone, colors.card, 3);
  const glyph = self.kind === 'asking' ? 'dot' : self.kind === 'unseen' ? 'hollow' : self.kind === 'error' ? 'danger' : 'circle';
  const mark = <View testID={'lead-status-me-' + self.kind} accessibilityRole={press ? undefined : 'text'} accessibilityLabel={press ? undefined : label}
    style={{ flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: px(3) }}>
    {self.kind === 'working' ? <SidebarStateMark mark="ring" colors={colors} label="" size={px(11)} testID="lead-status-me-ring" />
      : <View testID={'lead-status-me-' + glyph} style={{ width: px(11), height: px(11), alignItems: 'center', justifyContent: 'center' }}>
        <View style={glyph === 'dot' || glyph === 'danger' ? { width: px(7), height: px(7), borderRadius: px(4), backgroundColor: line }
          : glyph === 'hollow' ? { width: px(8), height: px(8), borderRadius: px(4), borderWidth: 2, borderColor: line }
          : { width: px(9), height: px(9), borderRadius: px(5), borderWidth: 1.2, borderColor: line }} />
      </View>}
    <Text testID="lead-status-me-text" numberOfLines={1} style={{ ...text, flexShrink: 1, color, fontWeight: self.kind === 'rest' ? 'normal' : '600' }}>{label}</Text>
  </View>;
  if (!press) return mark;
  const { reach } = press;
  return <Pressable testID={press.opens ? 'lead-status-me-open' : 'lead-status-awaiting'} accessibilityRole="button"
    accessibilityLabel={press.opens ? m.leadSelfOpen(label, press.title) : m.statusLabel(label, press.title)}
    {...(press.opens ? {} : { accessibilityState: { selected: press.on }, 'aria-pressed': press.on })} onPress={press.onPress}
    {...press.hover}
    {...(reach ? {} : { hitSlop: 2 })}
    style={{ flexShrink: 1, minWidth: 0, ...(reach ? { minWidth: px(MARK_TOUCH), marginTop: -reach.top, paddingTop: reach.top,
      marginBottom: -reach.bottom, paddingBottom: reach.bottom, zIndex: 1 } : {}) }}>
    <View style={{ height: text.lineHeight, paddingHorizontal: px(2), borderRadius: px(4), justifyContent: 'center', flexDirection: 'row', alignItems: 'center',
      backgroundColor: press.on ? selectedTint(colors, press.face) : 'transparent' }}>{mark}</View>
  </Pressable>;
}
function StatusPart({ kind, label, spoken = label, icon, on, title, colors, m, face, text, onPress, hover, reach, hold }: {
  kind: LeadStatusKind; label: string; on: boolean; title: string; colors: Palette; m: Copy; face: string;
  /** REQ-135: the part's whole words, for a screen reader, where the family line says it shorter (`familyFit`). */
  spoken?: string;
  /** REQ-135: a glyph before the words (the check said as a clock and its time). */
  icon?: string | undefined;
  text: { fontSize: number; lineHeight: number; includeFontPadding: false }; onPress: (event?: { stopPropagation?: () => void }) => void;
  hover: Handlers; reach: { top: number; bottom: number } | null;
  /** research/275 J3: on the family line of a phone's card, a long press is the card's (its menu), not this part's press. */
  hold?: FamilyHold | null;
}) {
  const hovered = useHovered(), [focused, setFocused] = useState(false);
  const fill = on ? selectedTint(colors, face) : 'transparent';
  const color = on ? colors.foreground : hovered.hovered || focused ? colors.foreground : readable(colors.foregroundMuted, colors.card);
  return <Pressable testID={'lead-status-' + kind} accessibilityRole="button" accessibilityLabel={m.statusLabel(spoken, title)}
    accessibilityState={{ selected: on }} aria-pressed={on} onPress={onPress} {...(hold ?? {})}
    {...joinHandlers(hover, { onHoverIn: hovered.onHoverIn, onHoverOut: hovered.onHoverOut, onFocus: () => setFocused(true), onBlur: () => setFocused(false) })}
    {...(reach ? {} : { hitSlop: 2 })}
    style={{ flexShrink: 1, minWidth: 0, ...(reach ? { minWidth: px(MARK_TOUCH), marginTop: -reach.top, paddingTop: reach.top,
      marginBottom: -reach.bottom, paddingBottom: reach.bottom, zIndex: 1 } : {}) }}>
    <View testID={'lead-status-face-' + kind} style={{ height: text.lineHeight, paddingHorizontal: px(2), borderRadius: px(4), justifyContent: 'center',
      backgroundColor: fill, ...(icon ? { flexDirection: 'row' as const, alignItems: 'center' as const, gap: px(3) } : {}) }}>
      {!!icon && <Icon name={icon} size={px(11)} color={color} />}
      {!!label && <Text numberOfLines={1} style={{ ...text, color }}>{label}</Text>}
    </View>
  </Pressable>;
}
/**
 * REQ-109: a part of a lead's family line — "Sub-cards 5" with its tree (`icon`), or "not done 2". Its own press, not the
 * card's; tinted while on. The two sit 3px each side of "·" (each face's 2px and 1px round the dot) — one step apart, still close enough that the line is
 * about as wide as the one press it was — a long press on the card's middle stays the card's, not snapped to a part by a phone browser. `spoken` null ("not done 0"): plain text that presses nothing. `area`: a touch screen's reach.
 */
/** research/275 J3: a long press on a part of a phone card's family line, handed to the card (its menu, as the card's own long press). */
type FamilyHold = { delayLongPress: number; onLongPress: (event?: { stopPropagation?: () => void }) => void };
function FamilyPart({ testID, faceID, icon = false, label, spoken, on, onPress, hover, area, colors, face, mute, lineHeight, hold }: {
  testID: string; faceID: string; icon?: boolean; label: string; spoken: string | null; on: boolean; onPress: (event?: { stopPropagation?: () => void }) => void;
  hover: Handlers; area: Record<string, number> | null; colors: Palette; face: string; mute: string; lineHeight: number; hold?: FamilyHold | null;
}) {
  const hovered = useHovered(), [focused, setFocused] = useState(false);
  const fill = on ? selectedTint(colors, face) : 'transparent';
  const color = on ? selectedLine(colors, fill) : spoken && (hovered.hovered || focused) ? colors.foreground : mute;
  const inside = <View testID={faceID} style={{ height: lineHeight, flexDirection: 'row', alignItems: 'center', gap: px(3),
    ...(icon ? { paddingLeft: px(4), paddingRight: px(2) } : { paddingHorizontal: px(2) }), borderRadius: px(4), backgroundColor: fill }}>
    {icon && <Icon name="FolderTree" size={px(11)} color={color} />}
    <Text numberOfLines={1} style={{ fontSize: px(11), lineHeight, includeFontPadding: false, flexShrink: 1, color: on ? colors.foreground : color }}>{label}</Text>
  </View>;
  if (spoken === null) return <View testID={testID + '-quiet'} style={{ flexShrink: 1, minWidth: 0 }}>{inside}</View>;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={spoken}
    accessibilityState={{ selected: on }} aria-pressed={on} onPress={onPress} {...(hold ?? {})}
    {...joinHandlers(hover, { onHoverIn: hovered.onHoverIn, onHoverOut: hovered.onHoverOut, onFocus: () => setFocused(true), onBlur: () => setFocused(false) })}
    {...(area ? {} : { hitSlop: 2 })} style={{ flexShrink: icon ? 0 : 1, minWidth: 0, ...(area ?? {}) }}>{inside}</Pressable>;
}
/**
 * REQ-135: a part of a lead's family line at a fit (`familyFit`) — "Sub-cards N" first, then in the line's order its
 * sub-cards running, not done, waiting for you and its check. `spoken`: a status part's whole words.
 */
export type FamilyItem = { kind: 'all' | 'open' | LeadStatusKind; label: string; spoken: string; icon?: string };
export function familyItems(fit: FamilyFit, family: { total: number; open: number }, status: LeadStatus | null, moved: readonly LeadStatusKind[], m: Copy): FamilyItem[] {
  const full = fit === 'full' || !moved.length, at = status?.testing?.at ?? '';
  // research/275 F1: past 'drop' the words give way, never a count — "Sub-cards" to its tree, then the rest to a letter.
  const words = (whole: (n: number) => string, short: (n: number) => string, mark: (n: number) => string) => full ? whole : fit === 'bare' ? mark : short;
  const tree = !full && (fit === 'tight' || fit === 'bare'), items: FamilyItem[] = [{ kind: 'all', label: tree ? String(family.total) : m.subCount(family.total), spoken: '' }];
  if (status && moved.includes('running')) items.push({ kind: 'running', label: words(m.statusRunning, m.statusRunningShort, m.statusRunningMark)(status.running.length),
    spoken: m.statusRunning(status.running.length) });
  items.push({ kind: 'open', label: words(m.openCount, m.openCountShort, m.openCountMark)(family.open), spoken: '' });
  if (status && moved.includes('awaiting')) items.push({ kind: 'awaiting', label: words(m.statusAwaiting, m.statusAwaitingShort, m.statusAwaitingMark)(awaitingShown(status)),
    spoken: m.statusAwaiting(awaitingShown(status)) });
  if (status && moved.includes('testing') && (fit === 'full' || fit === 'short' || fit === 'clock' || fit === 'icon')) items.push({ kind: 'testing', spoken: m.statusTesting(at),
    label: full ? m.statusTesting(at) : fit === 'short' ? m.statusTestingShort(at) : fit === 'clock' ? m.statusTestingClock(at) : '',
    ...(fit === 'clock' || fit === 'icon' ? { icon: 'Clock' } : {}) });
  return items;
}
/**
 * REQ-135: how wide 11px words are, a little on the safe side of the system fonts (SF, Segoe UI, Roboto): a wide letter
 * (Hangul, CJK) 11px, a capital 7.2, a figure 6.2, a small letter 5.6, a space or a narrow mark 3–3.5.
 */
export function lineTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? 11 : /[A-Z~]/.test(ch) ? 7.2 : /[0-9]/.test(ch) ? 6.2
    : /[ .,:;·'|-]/.test(ch) ? 3.5 : 5.6;
  return Math.ceil(px(width));
}
/**
 * REQ-135: how wide the family line is (`lineTextWidth`): each part's words and its padding (the tree's 20px, a glyph and
 * its gap 18px or 15px alone, else 4px; on a touch screen 32px at least) and a 6px dot between two.
 */
export function familyWidth(items: readonly FamilyItem[], touch: boolean): number {
  return items.reduce((sum, item, index) => sum + (index ? px(6) : 0) + Math.max(touch ? px(MARK_TOUCH) : 0,
    item.kind === 'all' ? lineTextWidth(item.label) + px(20) : item.icon ? (item.label ? lineTextWidth(item.label) + px(18) : px(15)) : lineTextWidth(item.label) + px(4)), 0);
}
/**
 * REQ-73: the provider mark, its gap and the start of the name, kept however crowded line two gets. REQ-126: 56 → 72, so a
 * crowded card still shows its label's head — the role and the model's family ("실행_Sol…"), what tells the agents apart —
 * where 56 left "실행_…"; the version and thinking level after it are what give way.
 */
export const NAME_MIN_WIDTH = 72;
/**
 * REQ-95 ②: the lead card's crown, before its title. REQ-122: 13 → 16, so its beads read at their real size and the title starts
 * where a topic lead's does (the title line stays 18px high).
 */
export const LEADER_ICON = 16;
/** REQ-120: a topic lead's two-tone medal, in the crown's place — a little larger so its face reads; the title moves over 3px. */
export const TOPIC_LEADER_ICON = 16;
/** REQ-82 ②: the height of the card's "Done" button, which line two keeps whether it shows or not. */
export const DONE_BUTTON_HEIGHT = 18;
export function CardTile({ card, colors, m, onPress, countsAsDone = false, stages, boardId, parentMark, familyHead = false, topicLead = false, designated = false, familySummary, leadStatus }: {
  stages: readonly Stage[];
  countsAsDone?: boolean; card: BoardCardDTO; labels: Record<string, string>; colors: Palette; m: Copy; onPress: () => void;
  /** REQ-82: the card's board; with a screen's quick moves (`QuickMoveContext`) it offers "Done" and the stage menu. */
  boardId?: string;
  /**
   * REQ-93: a sub-card's parent, said over its title ("↳ Lead-02"); pressing it highlights the family (`on` while it is).
   */
  parentMark?: { title: string; on: boolean; onPress: () => void } | undefined;
  /**
   * REQ-95 (replacing REQ-94): a card with sub-cards — a lead's. A crown leads its title, and an automatic card's title
   * shows only its head ("Lead-03" of "Lead-03_sample-app_Opus"). REQ-105: its 1px edge is a plain grey (`leaderOutline`),
   * not its stage's colour — the crown alone calls for a look.
   */
  familyHead?: boolean;
  /** REQ-137: the chat a person marked as the workspace's lead — its crown is spoken "set by you". */
  designated?: boolean;
  /**
   * REQ-117: a topic lead — a lead under the workspace's lead. REQ-120: a medal for the crown (`medalColors`; REQ-123 antique gold) and its title
   * shows whole ("T01_topic_1"), two lines when long; the rest is a lead's (the family line, the status row, the edge).
   */
  topicLead?: boolean;
  /**
   * REQ-99 (moving REQ-93 C′'s line from under the card into it): a lead's "Sub-cards 5 · not done 2", the card's last
   * row; pressing it highlights the family (`on` while it is). `mobile` gives it a phone's reach where no quick moves say so.
   * REQ-109: two presses — "Sub-cards 5" the whole family (`onPress`, `on` 'all'), "not done 2" the not-done sub-cards
   * alone (`onPressOpen`, `on` 'open'); "not done 0" presses nothing.
   */
  familySummary?: { total: number; open: number; on: 'all' | 'open' | null; onPress: () => void; onPressOpen: () => void;
    mobile?: boolean } | undefined;
  /**
   * REQ-104: a lead's status row under the family line — "Running 2 · Testing 21:40~ · Awaiting you 1", or "Idle · last
   * activity 21:05". Each part is its own press, highlighting its cards (`on`: the part that is).
   */
  leadStatus?: { status: LeadStatus; on: LeadStatusKind | null; onPress: (kind: LeadStatusKind) => void; mobile?: boolean } | undefined;
}) {
  const decoration = cardDecoration(colors);
  // REQ-85 ⑨ / REQ-95 ④: the card just looked at is tinted grey, the face and its box alike.
  const viewed = useContext(ViewedCardContext) === card.id;
  const face = viewed ? viewedTint(colors, decoration.backgroundColor) : decoration.backgroundColor;
  const source = useSignalSource();
  // REQ-22: the most urgent linked agent leads, the rest collapse into "+N".
  const signal = useSignalSummary(source, card.agentIds);
  // REQ-51: every linked agent archived, on a card that is not yet done, means nobody is left to act on it.
  // REQ-82 ①: it waits for a person to confirm it done — "Archived · confirm done", no longer "No assignee".
  const orphaned = isOrphanedCard(card.agentIds, countsAsDone, id => source.archived?.(id) === true);
  const unassigned = isUnassignedCard(card.agentIds, countsAsDone, card.intent);
  // REQ-82 ②③: a screen's quick moves. None in the demo or where a card is only shown.
  const quick = useQuickMove(), movable = !!quick && !!boardId;
  const busy = movable && quick.busy(card.id), done = doneStage(stages);
  const doneOffered = movable && offersDone(orphaned, card.intent, stages);
  const reveal = useRevealOnHover(), replyHover = useHovered();
  // A phone always shows "Done"; a wide screen while the card is hovered or has the keyboard's focus.
  const shown = !!quick?.touch || reveal.shown;
  /*
   * REQ-95 ③: an answer is awaited — an agent asks for a permission (whatever the stage), or the card waits for a person
   * and is not done. The stripe, and a lead's edge, turn orange; "Response needed" is written. REQ-96: pressing it opens
   * the agent that waits (the one asking, else the first), and "Go to agent ↗" opens the card's first agent.
   */
  const asking = askingAgent(card.agentIds, source.read);
  const needsReply = !!asking || !countsAsDone && card.awaiting === 'user';
  const replyJump = needsReply && !!quick && !!boardId ? quick.jump?.(boardId, asking ?? card.agentIds[0]) ?? null : null;
  const jump = movable ? quick.jump?.(boardId!, card.agentIds[0]) ?? null : null;
  // D43: a lead's "Awaiting you" that is the lead alone asking has no sub-card to ring — its press goes where the chip does.
  const selfAwaits = !!leadStatus?.status.self && leadStatus.status.awaiting.length === 1;
  // REQ-133: a lead's own "Awaiting review" or "Error" opens that agent's chat — a look clears the one, the other is read there.
  const meSelf = leadStatus?.status.me, selfOpen = movable && !!meSelf?.agent && (meSelf.kind === 'unseen' || meSelf.kind === 'error')
    ? quick.jump?.(boardId!, meSelf.agent) ?? null : null;
  const lead: SignalBucket = signal?.bucket ?? 'unknown';
  const bucket: SignalBucket = orphaned ? 'orphaned' : lead;
  const agent = signal?.agentId ?? card.agentIds[0];
  const info = agent ? source.model?.(agent) : undefined;
  const mark = agent ? sidebarMark(lead) : null;
  // REQ-78 ④: an agent still being looked up has no provider mark and a neutral "…" for a name, not its id.
  const waiting = !!agent && !orphaned && source.pending?.(agent) === true;
  const name = agent ? assigneeName(agent, info, waiting) : '';
  const others = signal?.others ?? card.agents - 1;
  // A finished or unknown lead reads quieter; a finished-but-unseen one (attention) still wants a look.
  const quiet = lead === 'idle' || lead === 'unknown';
  const now = useMinuteClock(), age = elapsed(card.updatedAt, now);
  /*
   * REQ-86 (research/128 ④C·⑤W2): in the progress and review columns, from an hour on, how long the card has sat there — a
   * clock and "14h" where "3m ago" was (that moves to the hint and the detail); past the limit (review 12h, progress 2h with
   * no agent at work) an orange ⚠ and the same words ("15시간째"). Never counted as needing attention. Read on the minute
   * clock and each signal re-render, so a refresh (every 4 s) leaves the words as they are until a minute has passed.
   */
  const dwell = stageDwell(card, stages, { read: source.read, activity: id => source.activity?.(id), ready: source.ready() }, now);
  const dwellShown = !!dwell?.shown;
  const ageText = age ? m.ago(age) : '';
  const dwellText = dwell ? m.dwell(dwell.age, dwell.warn) : '';
  // REQ-86: under the mouse — when it came in, why it warns, and the last change the time took the place of.
  const dwellHint = dwell ? [m.dwellEntered(localStamp(dwell.enteredAt, now), dwell.estimated),
    dwellReason(dwell, m), ageText ? m.updatedAgo(ageText) : ''].filter(Boolean).join('\n') : '';
  /*
   * REQ-84: work that is not an agent's turn (`kanban card busy` — a lead's test run, a build) — a row of its own under line
   * two: a dashed ring (an agent's ring is solid and turns), the words and how long it has been on ("Testing · 12m"), and the
   * card's edge dashed in the same colour. Past two hours the ring, the edge and the words turn orange and "Busy over 2h"
   * follows — counted with the cards needing a person. The mouse on it says since when and who marked it.
   */
  const marked = busyView(card.busy, now);
  const busyLine = marked ? m.busyLine(marked.text, m.busyAge(marked.age)) : '';
  const busyName = useBusyBy(source, marked?.by), busyBy = busyName === SCREEN_BY ? m.busyByScreen : busyName;
  const busyHint = marked ? m.busyHint(localStamp(marked.since, now), busyBy, marked.overdue) : '';
  /*
   * REQ-130 (research/260 C ②): on a lead with its status row the mark is the lead's memo — a pencil and its words under that
   * row, the card's own edge kept until it is overdue (then orange and dashed, still counted with the cards needing a person).
   */
  const memo = !!marked && !!leadStatus;
  const next = card.nextAction.trim();
  // REQ-116: a lead whose short title fits one line keeps no room for a second (its title is then cut at one line).
  const titleLines = familySummary && leadTitleOneLine(card.title, topicLead) ? 1 : 2;
  // REQ-119: a lead with no sub-card yet has no family line (nothing to press); a topic lead keeps its "0" (REQ-117).
  const familyLine = !!familySummary && leadRows(familySummary, topicLead) === LEAD_ROWS;
  // REQ-135: the card's inner width, read once laid out (a 264px card's until then), for how much the family line says.
  const [room, setRoom] = useState(0);
  const size = cardDimensions(!!next, useWindowDimensions().fontScale, !!parentMark, familySummary ? leadRows(familySummary, topicLead) : 0, !!marked, titleLines);
  // D27: the card face is `colors.card`, not the panel behind it, so contrast is read against that.
  const mute = readable(colors.foregroundMuted, colors.card), warn = readable(colors.statusWarning, colors.card);
  const meta = { fontSize: px(11), lineHeight: size.metaLineHeight, includeFontPadding: false } as const;
  const flag = { flexShrink: 1, minWidth: 0 } as const;
  const criteria = card.criteria && card.criteria.total > 0 ? card.criteria : null;
  const sentLook = dispatchLook(card.dispatch);
  const sentText = sentLook ? dispatchLine(card.dispatch, m, dispatchFallback(card.dispatch, id => source.model?.(id))) : '';
  const criteriaMet = !!criteria && criteria.checked >= criteria.total, criteriaUnmet = !!criteria && countsAsDone && !criteriaMet;
  // REQ-103 ②: the warning orange in plain (not bold) words, its mark at the 3:1 of a glyph — quieter than "Response needed".
  const quietMark = readable(colors.statusWarning, colors.card, 3);
  /*
   * REQ-44: pressing or holding the state mark tells you what it means, with no hover anywhere. The
   * nested press is the card's own press as far as the browser is concerned, so `swallow` drops the one
   * that bubbles up (the responder system usually stops it first) and the flag is cleared again as soon
   * as the tooltip state settles. While the tooltip is up, pressing anywhere on the card dismisses it.
   */
  const [tip, setTip] = useState(false);
  useEffect(() => { if (!mark) setTip(false); }, [mark]);
  // H4: one tooltip at a time, and a press on anything else — another card, a menu — closes it (`press-tip.ts`).
  const shadow = useRef<View>(null);
  useEffect(() => {
    if (!tip) return undefined;
    const close = () => setTip(false), release = claimPressTip(close), unwatch = outsidePress(shadow.current, close);
    return () => { release(); unwatch(); };
  }, [tip]);
  const swallow = useRef(false);
  useEffect(() => { swallow.current = false; }, [tip]);
  const showTip = (value: boolean) => (event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.(); swallow.current = true; setTip(value);
  };
  // REQ-82: the same for "Done" and ⋯, whose press changes no tooltip, so the flag is dropped once this press is over.
  const inner = (action: () => void) => (event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.(); swallow.current = true; afterThisTask(() => { swallow.current = false; }); action();
  };
  const tipText = [waiting ? '' : name, providerName(info?.provider), signalText(bucket, m)].filter(Boolean).join(' · ');
  /*
   * REQ-85 ⑥ (⑥A): on a wide screen each element says what it is under the mouse — the state mark its state ("Working"),
   * the provider mark and name the model and provider ("Opus 5.5 · Claude"), a title cut short the whole title. Like the
   * tool tips: below what it names, gone after a click, and the state mark's shown for the keyboard's focus too. A phone
   * keeps the press on the state mark (the line above) and has no hover.
   */
  const stateTip = usePointerTip(), [hint, setHint] = useState<'model' | 'title' | 'dwell' | 'busy' | null>(null);
  const layout = useRef({ one: { y: size.paddingVertical, height: size.titleLineHeight },
    two: { y: size.paddingVertical + size.titleLineHeight + size.gap, height: size.metaLineHeight }, agent: 0,
    busy: { y: size.paddingVertical + size.titleLineHeight + size.metaLineHeight + size.gap * 2, height: size.nextLineHeight } });
  const titleRef = useRef<Text>(null), raise = useContext(RaiseTip);
  const modelText = orphaned || waiting ? [orphaned ? name : '', providerName(info?.provider)].filter(Boolean).join(' · ')
    : [modelDisplayName(info) ?? name, providerName(info?.provider)].filter(Boolean).join(' · ');
  const shownHint = tip ? null : stateTip.shown && !!mark ? 'state' as const : hint;
  useEffect(() => { if (!shownHint) return undefined; raise(true); return () => raise(false); }, [shownHint, raise]);
  // REQ-95 ⑥: a lead's title shows its head only; the whole title is its hint, whether or not the head is cut.
  // REQ-117: a topic lead's title stays whole.
  const title = familyHead && !topicLead ? leadTitle(card.title) : card.title, shortened = title !== card.title;
  const hintIn = (which: 'model' | 'title' | 'dwell' | 'busy') => () => { if (which === 'title' && !shortened && !clipped(titleRef.current)) return; setHint(which); };
  const hintOut = () => setHint(null);
  const card3 = size.paddingHorizontal, below = TIP.gap;
  const hintLabel = shownHint === 'state' ? signalText(lead, m) : shownHint === 'model' ? modelText : shownHint === 'title' ? card.title
    : shownHint === 'dwell' ? dwellHint : shownHint === 'busy' ? busyHint : '';
  const hintPlace = shownHint === 'state' ? { top: layout.current.one.y + size.titleLineHeight + below, left: card3 - px(4) }
    : shownHint === 'model' ? { top: layout.current.two.y + layout.current.two.height + below, left: card3 + layout.current.agent - px(4) }
    : shownHint === 'dwell' ? { top: layout.current.two.y + layout.current.two.height + below, right: card3 - px(4) }
    : shownHint === 'busy' ? { top: layout.current.busy.y + layout.current.busy.height + below, left: card3 - px(4) }
    : { top: layout.current.one.y + layout.current.one.height + below, left: card3 + (agent ? RING.size + px(5) : 0) + (familyHead ? (topicLead ? px(TOPIC_LEADER_ICON) : px(LEADER_ICON)) + px(5) : 0) - px(4), right: card3 - px(4) };
  // REQ-85 ⑧: the ⋯ opens its menu right under itself; closing it hands the focus back to the card.
  const menuButton = useRef<View>(null), cardRef = useRef<View>(null);
  const openMenu = () => {
    const node = menuButton.current as { measureInWindow?: (done: (x: number, y: number, width: number, height: number) => void) => void } | null;
    const trigger = { focus: () => (cardRef.current as { focus?: () => void } | null)?.focus?.() };
    if (typeof node?.measureInWindow === 'function') node.measureInWindow((x, y, width, height) =>
      quick!.openMenu(boardId!, card.id, { anchor: { x, y, width, height }, trigger }));
    else quick!.openMenu(boardId!, card.id, { trigger });
  };
  // REQ-95 ③: the stripe (the left band) keeps its stage's colour, orange while an answer is awaited; ≥3:1 on its
  // face and on the column (`markLine`).
  const stripe = needsReply ? markLine(replyColor(colors), colors, face) : stageColor(card.stageId, stages, colors);
  // D35: held as archived once the listing did not name the agent and its lookup is still out (`leadArchivedAgent`).
  const leadArchived = familyHead && isArchivedLead(card.agentIds, leadArchivedAgent(source));
  const medal = topicLead ? medalColors(colors, face, leadArchived) : null, crown = crownColors(colors, face, leadArchived);
  /*
   * REQ-105 (replacing REQ-95 ①'s stage-coloured edge and REQ-98's archived grey): a lead's 1px edge is plain grey, not
   * its stage's colour — with the gold crown, a second colour on the same card was one too many. "Response needed"
   * still wins (REQ-95 ③): the edge turns orange with the stripe. A non-lead keeps its plain border.
   */
  // REQ-84: a busy card's edge is dashed, blue as an agent at work (orange once it is overdue); "Response needed" still wins.
  const busyColor = marked ? markLine(marked.overdue ? colors.statusWarning : colors.running, colors, face) : '';
  const dashed = !!marked && (!memo || marked.overdue);
  const outline = familyHead && needsReply ? stripe : dashed ? busyColor : !familyHead ? colors.border : leaderOutline(colors, face, leadArchived);
  const touch = !!quick?.touch;
  const replyLit = replyHover.hovered && !touch, reply = replyChip(colors, face, replyLit);
  // REQ-99: the family line reads like "→ next action" (11px, muted); hover or the keyboard's focus brightens a part, on it is tinted.
  const summaryReach = touch || !!familySummary?.mobile;
  // REQ-104: with the status row under it, the family line's press reaches half the gap down; the row takes the rest.
  const summaryBelow = leadStatus ? size.gap / 2 : px(MARK_TOUCH) - size.nextLineHeight - size.gap;
  const summaryArea = summaryReach ? { minWidth: px(MARK_TOUCH), marginTop: -size.gap, paddingTop: size.gap, marginBottom: -summaryBelow,
    paddingBottom: summaryBelow, zIndex: 1 } : null;
  // D43: a lead's "Awaiting you" that is the lead alone asking presses where its "Response needed" chip does.
  const statusValue = leadStatus && selfAwaits && replyJump
    ? { ...leadStatus, onPress: (kind: LeadStatusKind) => kind === 'awaiting' ? replyJump.go() : leadStatus.onPress(kind) } : leadStatus;
  /*
   * REQ-135: the sub-cards' parts (running, waiting for you, the check) are said on the family line, "Sub-cards N · Running N ·
   * not done N · Awaiting you N · Testing 21:40~", and the status row under it is the lead's own state alone. Only where both
   * lines show and the lead has an agent of its own (else the row would say nothing): the rest keep them on the row.
   * A narrow card says them shorter, then the check as its time, then leaves the check out (`familyFit`); no count is cut.
   */
  const moved = familyLine && !!leadStatus?.status.me ? statusParts(leadStatus.status) : [];
  const roomInside = (room || SWIMLANE.cardWidth) - 2 * size.paddingHorizontal - 2 + px(4);
  const fit: FamilyFit = moved.length && familySummary
    ? familyFit(at => familyWidth(familyItems(at, familySummary, leadStatus!.status, moved, m), summaryReach), roomInside) : 'full';
  const lineItems = familyLine && familySummary ? familyItems(fit, familySummary, leadStatus?.status ?? null, moved, m) : [];
  // research/275 J3: the family line's parts fill a phone card's middle, so a long press there is the card's (its menu); a tap still rings.
  const hold: FamilyHold | null = movable && quick.touch ? { delayLongPress: 450, onLongPress: inner(() => { if (!busy) quick.openMenu(boardId!, card.id); }) } : null;
  // REQ-82 F1·F2: the pointer and the keyboard's focus are followed on the box around the card, so moving onto
  // "Done", ⋯ or the state mark inside it never counts as leaving the card (`useRevealOnHover`).
  return <View ref={shadow} testID="card-shadow" {...(movable && !quick.touch ? reveal.area : {})} style={{ ...decoration, backgroundColor: face,
    ...(tip || shownHint ? { zIndex: 2 } : {}) }}>
    <Pressable ref={cardRef} accessibilityRole="button" accessibilityLabel={card.title} testID={`kanban-card-${card.id}`}
      onPress={() => { if (swallow.current) { swallow.current = false; return; } setHint(null); dismissPressTip(); onPress(); }}
      {...(movable ? { ...reveal.card, ...(quick.touch ? { accessibilityHint: m.moveHint, delayLongPress: 450,
        onLongPress: () => { if (!busy) quick.openMenu(boardId!, card.id); } } : {}),
        // A screen reader reaches the same two moves from the card itself (the controls inside it may be grouped away).
        accessibilityActions: [{ name: 'move', label: m.moveCard }, ...(doneOffered ? [{ name: 'done', label: m.moveToStage(done!.name) }] : []),
          ...(jump ? [{ name: 'jump', label: jump.kind === 'agent' ? m.goToAgent : m.goToWorkspace }] : [])],
        onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
          if (event.nativeEvent.actionName === 'jump') { jump?.go(); return; }
          if (busy) return;
          if (event.nativeEvent.actionName === 'done' && doneOffered) quick.move(boardId!, card.id, done!.stageId);
          else if (event.nativeEvent.actionName === 'move') quick.openMenu(boardId!, card.id); } } : {})}
      style={{ minHeight: size.minHeight, height: size.height, borderRadius: px(8), overflow: 'hidden',
        backgroundColor: face }}>
    <View testID="card-content" onLayout={familyLine ? event => { const next = Math.round(event.nativeEvent.layout.width); setRoom(value => value === next ? value : next); } : undefined}
      style={{ paddingVertical: size.paddingVertical, paddingHorizontal: size.paddingHorizontal,
      gap: size.gap, borderWidth: 1, borderColor: outline, borderRadius: px(8), flex: size.height ? 1 : undefined,
      ...(dashed ? { borderStyle: 'dashed' as const } : {}) }}>
    {/* REQ-93: the parent a sub-card belongs to, small over its title. Its own press, not the card's (`inner`). On a
        touch screen the press reaches 8px over and under the 16px mark (32px, the web too, where hitSlop does nothing);
        the negative margin keeps the card's rows where they were. */}
    {!!parentMark && <Pressable testID="family-mark" accessibilityRole="button" accessibilityLabel={m.parentMarkLabel(parentMark.title)}
      accessibilityState={{ selected: parentMark.on }} aria-pressed={parentMark.on}
      onPress={inner(parentMark.onPress)} {...(movable ? reveal.inner : {})} {...(touch ? {} : { hitSlop: 2 })}
      style={{ alignSelf: 'flex-start', maxWidth: '100%', justifyContent: 'center',
        ...(touch ? { minWidth: px(MARK_TOUCH), minHeight: px(MARK_TOUCH), marginVertical: -(px(MARK_TOUCH) - px(MARK_ROW)) / 2, zIndex: 1 } : {}) }}>
      <View testID="family-mark-face" style={{ height: px(MARK_ROW), alignSelf: 'flex-start', maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: px(2),
        paddingHorizontal: px(4), borderRadius: px(4), borderWidth: 1,
        borderColor: parentMark.on ? selectedLine(colors, face) : readable(colors.border, face, 1.2),
        backgroundColor: parentMark.on ? selectedTint(colors, face) : 'transparent' }}>
        <Icon name="CornerDownRight" size={px(11)} color={parentMark.on ? selectedLine(colors, selectedTint(colors, face)) : mute} />
        <Text numberOfLines={1} style={{ ...meta, lineHeight: px(MARK_ROW - 2), flexShrink: 1, color: parentMark.on ? colors.foreground : mute }}>
          {shortParent(parentMark.title)}</Text>
      </View>
    </Pressable>}
    <View onLayout={event => { const { y, height } = event.nativeEvent.layout; layout.current.one = { y, height }; }}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: px(5) }}>
      {!!agent && (mark
        ? <Pressable testID="card-signal-press" accessibilityRole="button" accessibilityLabel={m.agentStatus}
          accessibilityState={{ expanded: tip }} hitSlop={px(8)} onPress={showTip(!tip)} onLongPress={showTip(true)}
          {...joinHandlers(stateTip.handlers, movable ? reveal.inner : {})}
          style={{ height: size.titleLineHeight, justifyContent: 'center' }}>
          <SidebarStateMark mark={mark} colors={colors} label={signalText(lead, m)} testID="card-signal-icon" />
        </Pressable>
        : <View testID="card-state-empty" style={{ width: RING.size, height: size.titleLineHeight }} />)}
      {/* REQ-95 ②: a lead's crown — a leader, not a branch (the sub-cards' "↳" and the summary's tree stay theirs). REQ-100:
          in a fixed gold, "Response needed" too; an archived lead's is toned down. REQ-106: filled, not lined — the host's
          Icon takes no fill, so a tinted PNG of the crown, as the provider marks are drawn, at the line crown's old size.
          REQ-120: a topic lead's is a medal in two tones (REQ-123 antique gold and champagne) — its base PNG and its face PNG in the same box, each tinted.
          REQ-121: its ribbon tails a third PNG under the two, in petrol. REQ-122: the crown two-toned too — beads over the gold. */}
      {familyHead && <View testID="card-leader" accessibilityLabel={topicLead ? m.topicLeadCard : designated ? m.leadCard + ' · ' + m.leadSetByYou : m.leadCard} style={{ height: size.titleLineHeight, justifyContent: 'center' }}>
        {medal ? <View testID="card-leader-medal" style={{ width: px(TOPIC_LEADER_ICON), height: px(TOPIC_LEADER_ICON) }}>
            <Image testID="card-leader-ribbon" source={{ uri: MEDAL_RIBBON_PNG, width: px(48), height: px(48) }} resizeMode="contain"
              style={{ width: px(TOPIC_LEADER_ICON), height: px(TOPIC_LEADER_ICON), tintColor: medal.ribbon }} />
            <Image testID="card-leader-filled" source={{ uri: MEDAL_BASE_PNG, width: px(48), height: px(48) }} resizeMode="contain"
              style={{ position: 'absolute', left: 0, top: 0, width: px(TOPIC_LEADER_ICON), height: px(TOPIC_LEADER_ICON), tintColor: medal.base }} />
            <Image testID="card-leader-light" source={{ uri: MEDAL_LIGHT_PNG, width: px(48), height: px(48) }} resizeMode="contain"
              style={{ position: 'absolute', left: 0, top: 0, width: px(TOPIC_LEADER_ICON), height: px(TOPIC_LEADER_ICON), tintColor: medal.light }} />
          </View>
          : <View testID="card-leader-crown" style={{ width: px(LEADER_ICON), height: px(LEADER_ICON) }}>
            <Image testID="card-leader-filled" source={{ uri: CROWN_FILLED_PNG, width: px(48), height: px(48) }} resizeMode="contain"
              style={{ width: px(LEADER_ICON), height: px(LEADER_ICON), tintColor: crown.base }} />
            <Image testID="card-leader-beads" source={{ uri: CROWN_BEADS_PNG, width: px(48), height: px(48) }} resizeMode="contain"
              style={{ position: 'absolute', left: 0, top: 0, width: px(LEADER_ICON), height: px(LEADER_ICON), tintColor: crown.beads }} />
          </View>}
      </View>}
      <Text ref={titleRef} testID="card-title" numberOfLines={titleLines} {...{ onPointerEnter: hintIn('title'), onPointerLeave: hintOut }}
        {...(shortened ? { accessibilityLabel: card.title } : {})}
        style={{ flex: 1, color: colors.foreground, fontSize: px(14), lineHeight: size.titleLineHeight, includeFontPadding: false,
        fontWeight: '600' }}>{title}</Text>
    </View>
    <View onLayout={event => { const { y, height } = event.nativeEvent.layout; layout.current.two = { y, height }; }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: px(6), ...(doneOffered || replyJump ? { minHeight: px(DONE_BUTTON_HEIGHT) } : {}) }}>
      {/* The name keeps room for its mark and a few letters however many flags follow; the flags give way first,
          then the name, and the age never does. */}
      <View testID="card-agent" onLayout={event => { layout.current.agent = event.nativeEvent.layout.x; }}
        {...(agent && modelText ? { onPointerEnter: hintIn('model'), onPointerLeave: hintOut } : {})}
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: agent || unassigned ? px(NAME_MIN_WIDTH) : 0,
        flexDirection: 'row', alignItems: 'center', gap: px(4) }}>
        {/* REQ-51: the orphaned warning takes the provider mark's place, so line one keeps the sidebar's mark. */}
        {!!agent && (orphaned
          ? <View testID="card-orphaned-mark" accessibilityLabel={m.signalOrphaned}><Icon name={SIGNAL_ICON.orphaned} size={px(12)}
            color={readable(colors.statusDotWarning, colors.card, 3)} /></View>
          : waiting ? <View testID="card-provider-pending" style={{ width: px(12), height: px(12) }} />
          : <ProviderMark provider={info?.provider} color={quiet ? readable(colors.foregroundMuted, colors.card, 3) : mute} />)}
        {/* REQ-77 ③: an orphaned card says one thing. The archived agent's name stays in the state mark's tooltip and
            the detail, not beside the words, where it read as the assignee. REQ-82 ①: the words are what the card waits
            for — "Archived · confirm done"; "No assignee" is said, quietly, only where no agent was ever linked. */}
        {unassigned && <Text testID="card-agent-name" numberOfLines={1} style={{ ...meta, flexShrink: 1, color: mute }}>{m.noAssignee}</Text>}
        {!!agent && (orphaned
          ? <Text testID="card-agent-name" numberOfLines={1} style={{ ...meta, flexShrink: 1, color: readable(colors.statusDotWarning, colors.card),
            fontWeight: '600' }}>{m.archivedReview}</Text>
          /* REQ-126: a name too long for the line loses its end — the thinking level, then the version — never the label
             it starts with; "· +2" after it keeps its place. */
          : <Text testID="card-agent-name" numberOfLines={1} {...(waiting ? { accessibilityLabel: m.loading } : {})}
            style={{ ...meta, flexShrink: 1, color: quiet ? mute : colors.foreground }}>
            {name}
          </Text>)}
        {!!agent && !orphaned && others > 0 && <Text testID="card-agent-others" numberOfLines={1}
          style={{ ...meta, flexShrink: 0, color: quiet ? mute : colors.foreground }}>{'· ' + m.otherAgents(others)}</Text>}
      </View>
      {/* REQ-96: pressing "Response needed" opens the agent that waits for it. J5 (research/149): a chip, the only part that
          does — the rest of the card opens the detail. On a touch screen the press reaches the gap over it and 8px under it
          (32px, the web too), never the title; the negative margins keep the rows where they were. */}
      {needsReply && (replyJump
        ? <Pressable testID="card-reply" accessibilityRole="button" accessibilityLabel={m.replyAt(card.title)} onPress={inner(replyJump.go)}
          {...joinHandlers(reveal.inner, { onHoverIn: replyHover.onHoverIn, onHoverOut: replyHover.onHoverOut })}
          style={{ ...flag, ...(touch ? { minWidth: px(MARK_TOUCH), marginTop: -size.gap, paddingTop: size.gap,
            marginBottom: -(px(MARK_TOUCH) - px(DONE_BUTTON_HEIGHT) - size.gap), paddingBottom: px(MARK_TOUCH) - px(DONE_BUTTON_HEIGHT) - size.gap, zIndex: 1 } : {}) }}>
          <View testID="card-reply-chip" style={{ height: px(DONE_BUTTON_HEIGHT), maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: px(1),
            paddingHorizontal: px(5), borderRadius: px(DONE_BUTTON_HEIGHT) / 2, borderWidth: 1, borderColor: reply.borderColor, backgroundColor: reply.backgroundColor }}>
            <Text numberOfLines={1} style={{ ...meta, flexShrink: 1, color: reply.color, fontWeight: '600',
              textDecorationLine: replyLit ? 'underline' : 'none' }}>{m.awaitingUser}</Text>
            <Icon name="ArrowUpRight" size={px(11)} color={reply.color} />
          </View>
        </Pressable>
        : <Text testID="card-reply-text" numberOfLines={1} style={{ ...meta, ...flag, color: warn, fontWeight: '600' }}>{m.awaitingUser}</Text>)}
      {!countsAsDone && card.blocked && <Text numberOfLines={1} style={{ ...meta, ...flag, color: colors.blocked, fontWeight: '600' }}>{m.blocked}</Text>}
      {card.intent === 'draft' && <Text numberOfLines={1} style={{ ...meta, ...flag, color: colors.draft }}>{m.draft}</Text>}
      {/* REQ-97: where the card's request to the lead stands — waiting (plain), sent at HH:MM (muted), no lead (a quiet
          orange, plain words). Gone once the card is done. */}
      {!countsAsDone && !!sentLook && <Text testID={'card-dispatch-' + sentLook} numberOfLines={1} accessibilityLabel={m.dispatchRequest + ' · ' + sentText}
        style={{ ...meta, ...flag, color: sentLook === 'pending' ? colors.foreground : sentLook === 'noLead' ? warn : mute }}>{sentText}</Text>}
      {/* research/88: "Normal" is on nearly every card and says nothing, so only high and low are written. */}
      {card.priority !== 'normal' && <Text testID="card-priority" numberOfLines={1}
        style={{ ...meta, ...flag, color: card.priority === 'high' ? warn : mute }}>{m[card.priority]}</Text>}
      {/* REQ-82 ②: one press moves the archived card to done. It keeps its room (line two is as tall with it hidden),
          so showing it on hover never moves the card; the flags give way first, as for the name. */}
      {doneOffered && shown && <Pressable testID="card-done" accessibilityRole="button" accessibilityLabel={m.moveToStage(done!.name)}
        accessibilityState={{ disabled: busy }} disabled={busy} onPress={inner(() => quick!.move(boardId!, card.id, done!.stageId))}
        {...reveal.inner} hitSlop={quick!.touch ? { top: px(13), bottom: px(13), left: px(6), right: px(6) } : px(4)}
        style={{ flexShrink: 0, height: px(DONE_BUTTON_HEIGHT), paddingHorizontal: px(7), borderRadius: px(4), justifyContent: 'center',
          backgroundColor: colors.accent, opacity: busy ? .5 : 1 }}>
        <Text numberOfLines={1} style={{ fontSize: px(11), lineHeight: px(14), includeFontPadding: false, fontWeight: '600',
          color: readable(colors.accentForeground, colors.accent) }}>{m.toStage(done!.name)}</Text>
      </Pressable>}
      {/* REQ-103 ②: how many of the card's checklist criteria are ticked — muted words, a check once all are. A done card
          with some left says "Criteria unchecked" in a quiet orange: plain words, never a chip like "Response needed",
          and never counted as needing attention. */}
      {!!criteria && (criteriaUnmet
        ? <View testID="card-criteria-unmet" accessibilityLabel={m.criteriaUnmetLabel(criteria.checked, criteria.total)}
          style={{ ...flag, flexDirection: 'row', alignItems: 'center', gap: px(3) }}>
          <Icon name="CircleAlert" size={px(11)} color={quietMark} />
          <Text numberOfLines={1} style={{ ...meta, flexShrink: 1, color: warn }}>{m.criteriaUnmet + ' ' + criteria.checked + '/' + criteria.total}</Text>
        </View>
        : <View testID="card-criteria" accessibilityLabel={criteriaMet ? m.criteriaMetLabel(criteria.total) : m.criteriaProgress(criteria.checked, criteria.total)}
          style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: px(2) }}>
          {criteriaMet && <Icon name="Check" size={px(11)} color={readable(colors.statusSuccess, colors.card)} />}
          <Text numberOfLines={1} style={{ ...meta, color: mute }}>{m.criteriaProgress(criteria.checked, criteria.total)}</Text>
        </View>)}
      {/* REQ-86: the time in the column takes the age's place (it never gives way either); under an hour the age stays. */}
      {dwellShown ? <View testID={dwell!.warn ? 'card-dwell-warn' : 'card-dwell'} accessibilityRole="text"
        accessibilityLabel={m.dwellLabel(dwellText) + ' · ' + dwellHint.replace(/\n/g, ' · ')}
        {...{ onPointerEnter: hintIn('dwell'), onPointerLeave: hintOut }}
        style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: px(2) }}>
        <Icon name={dwell!.warn ? 'TriangleAlert' : 'Clock'} size={px(11)} color={dwell!.warn ? warn : mute} />
        <Text testID="card-dwell-text" numberOfLines={1} style={{ ...meta, color: dwell!.warn ? warn : mute,
          fontWeight: dwell!.warn ? '600' : 'normal' }}>{dwellText}</Text>
      </View>
      : !!ageText && <Text testID="card-age" numberOfLines={1} accessibilityLabel={m.updatedAgo(ageText)}
        style={{ ...meta, flexShrink: 0, color: mute }}>{ageText}</Text>}
    </View>
    {!!marked && !memo && <View testID={marked.overdue ? 'card-busy-overdue' : 'card-busy'} accessibilityRole="text"
      accessibilityLabel={m.busyLabel(busyLine, marked.overdue)} {...{ onPointerEnter: hintIn('busy'), onPointerLeave: hintOut }}
      onLayout={event => { const { y, height } = event.nativeEvent.layout; layout.current.busy = { y, height }; }}
      style={{ height: size.nextLineHeight, flexDirection: 'row', alignItems: 'center', gap: px(4), minWidth: 0 }}>
      <View testID="card-busy-ring" style={{ width: px(11), height: px(11), borderRadius: px(6), borderWidth: 1.5, borderStyle: 'dashed', borderColor: busyColor }} />
      <Text testID="card-busy-text" numberOfLines={1} style={{ fontSize: px(11), lineHeight: size.nextLineHeight, includeFontPadding: false, flexShrink: 1,
        color: marked.overdue ? warn : colors.foreground, fontWeight: marked.overdue ? '600' : 'normal' }}>{busyLine}</Text>
      {marked.overdue && <Text testID="card-busy-overdue-text" numberOfLines={1} style={{ fontSize: px(11), lineHeight: size.nextLineHeight,
        includeFontPadding: false, flexShrink: 0, color: warn, fontWeight: '600' }}>{'· ' + m.busyOverdue}</Text>}
    </View>}
    {!!next && <Text numberOfLines={1} style={{ fontSize: px(11), lineHeight: size.nextLineHeight, includeFontPadding: false,
      color: needsReply ? colors.foreground : mute }}>{'→ ' + next}</Text>}
    {/* REQ-99: the lead's family line, last in the card and lined up with "→ next action" (the tint's 4px sit left of it).
        Its own press, not the card's (`inner`): it highlights the family and opens no detail. On a touch screen the press
        reaches the gap over it and the card's padding under it (32px, the web too); the margins keep the rows in place. */}
    {/* REQ-109: two presses on the one line — "Sub-cards N" with its tree (the family) and "not done M" (those alone). */}
    {familyLine && familySummary && <View testID="family-summary" style={{ alignSelf: 'flex-start', maxWidth: '100%', marginLeft: px(-4), height: size.nextLineHeight,
      flexDirection: 'row', alignItems: 'center' }}>
      {lineItems.map((item, index) => <View key={item.kind} style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0,
        flexShrink: item.kind === 'open' && !moved.length ? 1 : 0 }}>
        {index > 0 && <Text testID={item.kind === 'open' ? 'family-summary-dot' : 'family-summary-dot-' + item.kind}
          style={{ fontSize: px(11), lineHeight: size.nextLineHeight, includeFontPadding: false, color: mute, marginHorizontal: px(1) }}>·</Text>}
        {item.kind === 'all' ? <FamilyPart testID="family-summary-all" faceID="family-summary-face" icon label={item.label} spoken={m.familyLabel(familySummary.total, card.title)}
          on={familySummary.on === 'all'} onPress={inner(familySummary.onPress)} hover={movable ? reveal.inner : {}} area={summaryArea}
          colors={colors} face={face} mute={mute} lineHeight={size.nextLineHeight} hold={hold} />
        : item.kind === 'open' ? <FamilyPart testID="family-summary-open" faceID="family-summary-open-face" label={item.label}
          spoken={familySummary.open ? m.familyOpenLabel(familySummary.open, card.title) : null}
          on={familySummary.on === 'open'} onPress={inner(familySummary.onPressOpen)} hover={movable ? reveal.inner : {}} area={summaryArea}
          colors={colors} face={face} mute={mute} lineHeight={size.nextLineHeight} hold={hold} />
        : statusValue && <StatusPart kind={item.kind} label={item.label} spoken={item.spoken} icon={item.icon} on={statusValue.on === item.kind} title={card.title}
          colors={colors} m={m} face={face} text={{ fontSize: px(11), lineHeight: size.nextLineHeight, includeFontPadding: false }}
          onPress={inner(() => statusValue.onPress(item.kind as LeadStatusKind))} hover={movable ? reveal.inner : {}}
          reach={summaryReach ? { top: size.gap, bottom: summaryBelow } : null} hold={hold} />}
      </View>)}
    </View>}
    {!!statusValue && <LeadStatusRow testID="lead-status" value={statusValue} title={card.title} colors={colors} m={m} face={face} lineHeight={size.nextLineHeight}
      gap={size.gap} padding={size.paddingVertical} reach={touch || !!statusValue.mobile} press={inner} hover={movable ? reveal.inner : {}}
      now={now} open={selfOpen?.kind === 'agent' ? selfOpen.go : undefined} moved={moved.length > 0} />}
    {memo && marked && <View testID={marked.overdue ? 'lead-memo-overdue' : 'lead-memo'} accessibilityRole="text"
      accessibilityLabel={m.memoLabel(busyLine, marked.overdue)} {...{ onPointerEnter: hintIn('busy'), onPointerLeave: hintOut }}
      onLayout={event => { const { y, height } = event.nativeEvent.layout; layout.current.busy = { y, height }; }}
      style={{ height: size.nextLineHeight, flexDirection: 'row', alignItems: 'center', gap: px(3), minWidth: 0 }}>
      <Icon name="Pencil" size={px(11)} color={marked.overdue ? warn : mute} />
      <Text testID="lead-memo-text" numberOfLines={1} style={{ fontSize: px(11), lineHeight: size.nextLineHeight, includeFontPadding: false, flexShrink: 1,
        color: marked.overdue ? warn : colors.foreground, fontWeight: marked.overdue ? '600' : 'normal' }}>{busyLine}</Text>
      {marked.overdue && <Text testID="lead-memo-overdue-text" numberOfLines={1} style={{ fontSize: px(11), lineHeight: size.nextLineHeight,
        includeFontPadding: false, flexShrink: 0, color: warn, fontWeight: '600' }}>{'· ' + m.busyOverdue}</Text>}
    </View>}
    </View>
    <View testID="card-stage-stripe" pointerEvents="none" style={{ position: 'absolute', left: 0,
      top: 0, bottom: 0, width: px(3), backgroundColor: stripe }} />
    {/* REQ-96: "Go to agent ↗" beside the ⋯ (never over "Done", which is on line two), the same way it shows, and before it
        for the keyboard. A phone has it atop the long-press sheet instead. */}
    {movable && !quick.touch && shown && !!jump && <Pressable testID="card-jump" accessibilityRole="button"
      accessibilityLabel={(jump.kind === 'agent' ? m.goToAgentOf : m.goToWorkspaceOf)(card.title)} {...reveal.inner}
      onPress={inner(jump.go)} style={{ position: 'absolute', top: px(4), right: px(32), width: px(24), height: px(24), borderRadius: px(6), alignItems: 'center',
        justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
      <Icon name="SquareArrowOutUpRight" size={px(13)} color={colors.foreground} />
    </Pressable>}
    {/* REQ-82 ③: the stage menu, over the card's top right corner while it is hovered or focused on a wide screen
        (a phone long-presses the card instead). Drawn over the card, so the card never changes size. */}
    {movable && !quick.touch && shown && <Pressable ref={menuButton} testID="card-move-menu" accessibilityRole="button"
      accessibilityLabel={m.moveCard + ': ' + card.title} disabled={busy} {...reveal.inner} aria-haspopup="menu"
      onPress={inner(openMenu)}
      style={{ position: 'absolute', top: px(4), right: px(4), width: px(24), height: px(24), borderRadius: px(6), alignItems: 'center',
        justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: busy ? .5 : 1 }}>
      <Icon name="Ellipsis" size={px(14)} color={colors.foreground} />
    </Pressable>}
  </Pressable>
    {!!shownHint && !!hintLabel && <CardHint testID={'card-hint-' + shownHint} label={hintLabel} place={hintPlace} colors={colors} />}
    {tip && !!mark && <Pressable testID="card-signal-dismiss" accessibilityRole="button" accessibilityLabel={m.close}
      onPress={showTip(false)} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />}
    {tip && !!mark && <View testID="card-signal-tooltip" pointerEvents="none" accessibilityRole="text"
      style={{ position: 'absolute', left: size.paddingHorizontal, right: size.paddingHorizontal, top: px(6),
        paddingVertical: px(3), paddingHorizontal: px(6), borderRadius: px(6), borderWidth: 1,
        borderColor: colors.border, backgroundColor: colors.surface2 }}>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: px(11), lineHeight: px(14), includeFontPadding: false }}>
        {tipText}
      </Text>
    </View>}
  </View>;
}
