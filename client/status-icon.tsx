import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Image, Platform, Pressable, Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { useOrphanedCount, useSignalCounts, useSignalSummary } from './agent-signals.js';
import { useSignalSource } from './signal-context.js';
import { boardAgentIds, type SignalBucket } from './signal-model.js';
import { readable, type Palette } from './palette.js';
import { agentIdSuffix, assigneeName, providerKey, providerName, sidebarMark, type SidebarMark } from './card-meta.js';
import { RaiseTip } from './components.js';
import { PROVIDER_ICON_PNG } from './provider-icons.js';
import type { Copy } from './i18n.js';
import { px, scaled } from './ui-scale.js';

/**
 * Lucide names verified against the installed app bundle's icon module (plans/04 vocabulary). REQ-82 ①: an
 * orphaned card is filed away and waits to be confirmed done, so it is marked `Archive`, not a missing person.
 */
export const SIGNAL_ICON: Record<SignalBucket, string> = { error: 'CircleX', orphaned: 'Archive', permission: 'CircleAlert',
  working: 'CircleDot', attention: 'CircleCheck', idle: 'CircleCheck', unknown: 'CircleDashed' };
/** Geometry of the Paseo status ring at 14px: 6px centre, 12px ring, 1.5px stroke, .3 track, .9 head, 900ms. */
export const RING = scaled({ size: 14, centre: 6, ring: 12, stroke: 1.5, trackOpacity: .3, headOpacity: .9, durationMs: 900 } as const,
  ['stroke', 'trackOpacity', 'headOpacity', 'durationMs']);

export function signalColor(bucket: SignalBucket, colors: Palette): string {
  return bucket === 'error' ? colors.statusDotDanger : bucket === 'orphaned' || bucket === 'permission' ? colors.statusDotWarning
    : bucket === 'working' ? colors.running : colors.foregroundMuted;
}
export function signalText(bucket: SignalBucket, m: Copy): string {
  return bucket === 'error' ? m.signalError : bucket === 'orphaned' ? m.signalOrphaned
    : bucket === 'permission' ? m.signalPermission
    : bucket === 'working' ? m.signalWorking : bucket === 'attention' ? m.signalAttention
      : bucket === 'idle' ? m.signalIdle : m.signalUnknown;
}

/*
 * One clock for every ring on the screen. It lives outside React: the loop drives an Animated value
 * (native driver off web, transform on web), so a rotating icon never re-renders anything. It runs
 * only while a ring is mounted, the app is active and reduce-motion is off.
 */
const clock = new Animated.Value(0);
let rings = 0, running = false, active = true, reduced = false;
let animation: { start: () => void; stop: () => void } | null = null;
let listeners: { remove: () => void }[] = [];
function sync() {
  const shouldRun = rings > 0 && active && !reduced;
  if (shouldRun === running) return;
  running = shouldRun;
  if (!shouldRun) { animation?.stop(); animation = null; clock.setValue(0); return; }
  animation = Animated.loop(Animated.timing(clock, { toValue: 1, duration: RING.durationMs,
    easing: Easing.linear, useNativeDriver: Platform.OS !== 'web', isInteraction: false }));
  animation.start();
}
export function useRingClock(): Animated.Value {
  useEffect(() => {
    rings++;
    if (rings === 1) {
      active = AppState.currentState == null || AppState.currentState === 'active';
      listeners = [AppState.addEventListener('change', state => { active = state === 'active'; sync(); }),
        AccessibilityInfo.addEventListener('reduceMotionChanged', value => { reduced = value; sync(); })];
      void AccessibilityInfo.isReduceMotionEnabled().then(value => { reduced = value; sync(); }).catch(() => {});
    }
    sync();
    return () => {
      rings = Math.max(0, rings - 1);
      if (!rings) { for (const listener of listeners) listener.remove(); listeners = []; }
      sync();
    };
  }, []);
  return clock;
}
/** Paseo's StatusRingFrame: the head's other three sides are transparent, so the .3 track shows beneath them. */
function Ring({ color, size }: { color: string; size: number }) {
  const spin = useRingClock();
  const scale = size / RING.size, ring = RING.ring * scale, centre = RING.centre * scale;
  return <View testID="signal-ring" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ width: centre, height: centre, borderRadius: centre / 2, backgroundColor: color }} />
    <View style={{ position: 'absolute', width: ring, height: ring, borderRadius: ring / 2,
      borderWidth: RING.stroke, borderColor: color, opacity: RING.trackOpacity }} />
    <Animated.View testID="signal-ring-arc" style={{ position: 'absolute', width: ring, height: ring, borderRadius: ring / 2,
      borderWidth: RING.stroke, borderColor: 'transparent', borderTopColor: color, opacity: RING.headOpacity,
      transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }} />
  </View>;
}
/**
 * The agent signal shown next to a name. Only `working` moves; `attention` keeps the muted check of
 * `idle` and adds a small success dot, so a finished agent never reads as a finished card.
 */
export function SignalIcon({ bucket, colors, m, size = RING.size, testID = 'signal-icon' }: {
  bucket: SignalBucket; colors: Palette; m: Copy; size?: number; testID?: string;
}) {
  const label = signalText(bucket, m);
  if (bucket === 'working') return <View testID={testID} accessibilityLabel={label} style={{ width: size, height: size }}>
    <Ring color={colors.running} size={size} />
  </View>;
  const dot = Math.max(3, Math.round(size * 4 / RING.size));
  return <View testID={testID} accessibilityLabel={label} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Icon name={SIGNAL_ICON[bucket]} size={size} color={signalColor(bucket, colors)} />
    {bucket === 'attention' && <View testID="signal-attention-dot" style={{ position: 'absolute', right: px(-1), top: px(-1),
      width: dot, height: dot, borderRadius: dot / 2, backgroundColor: colors.statusDotSuccess }} />}
  </View>;
}
/**
 * REQ-44: a lane header no longer repeats the representative icon its own cards already show. While the
 * lane is folded the cards are hidden, so the header keeps the urgent counts only ("Error 1 · Waiting 2")
 * — every agent linked anywhere on that board, so folding or filtering never changes the tally.
 */
export function LaneUrgentBadge({ stages, colors, m, compact = false }: {
  stages: readonly { countsAsDone: boolean; cards: readonly { agentIds: readonly string[] }[] }[]; colors: Palette; m: Copy; compact?: boolean;
}) {
  const source = useSignalSource();
  const ids = useMemo(() => boardAgentIds(stages), [stages]);
  const counts = useSignalCounts(source, ids);
  // REQ-51: a folded lane still says how many of its cards lost every agent, alongside its error/waiting tally.
  const orphaned = useOrphanedCount(source, stages);
  if (!counts.error && !orphaned && !counts.permission) return null;
  const parts = [];
  if (counts.error) parts.push(m.signalErrorCount(counts.error));
  if (orphaned) parts.push(m.signalOrphanedCount(orphaned));
  if (counts.permission) parts.push(m.signalWaitingCount(counts.permission));
  const text = parts.join(' · ');
  return <Text testID="lane-urgent-badge" accessibilityLabel={text} numberOfLines={1}
    style={{ color: counts.error ? colors.statusDotDanger : colors.statusDotWarning,
      fontSize: compact ? px(10) : px(11), lineHeight: compact ? px(14) : px(16), includeFontPadding: false }}>{text}</Text>;
}
/**
 * REQ-74 ④: a detail assignee row in the card face's words — the sidebar's state mark, the provider mark
 * and the name `assigneeName` picks (profile, else the model's short name, else title, else id) — then
 * the link label when it says something else, and the state in words. Unknown draws no mark, as on the card.
 *
 * REQ-77 ①: one agent, one row. The id's first 8 characters close the same line in smaller type, only when the
 * name is not already the id; with `onOpen` the whole row opens the agent (it used to be a second row, the id
 * again as a button). The words wrap under themselves on a narrow sheet; the marks stay on the first line.
 *
 * D45: `oneLine` (the wide detail's side panel, 280px) keeps the row on one line — the name (and link label) loses its
 * end as on the card face (REQ-126: the thinking level, then the version, never the label it starts with); the state and
 * the id after it never shrink. D47: they used to shrink beside the name in proportion, so "끝남" read "…" by a long name.
 * Only a state longer than `ONE_LINE_LONG_STATE` columns (research/236 D5: "Waiting for input or permission"), which no
 * 280px line holds beside a name, gives way: the name keeps up to `ONE_LINE_NAME` of the line, and the state loses its
 * end only where the rest is too short — the mark before the name still says it, and it is the mark's label. The id is
 * never cut. Without `oneLine` the words wrap as above.
 */
/** D47: past this many columns (`textColumns`) a state may lose its end on the one-line row; every Korean state and the
 * short English ones ("Status unavailable", 18) stay whole. */
export const ONE_LINE_LONG_STATE = 20;
/** D47 (research/236 D5): beside such a long state, the most of the one-line row the name keeps (about 75px of 198). */
export const ONE_LINE_NAME = '38%';
/** D47: the columns a text takes on a line — a Hangul, CJK or full-width character two, anything else one. */
export function textColumns(text: string): number {
  let columns = 0;
  for (const char of text) columns += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  return columns;
}
/**
 * REQ-131: the whole of a one-line row (D45), for what its line cut. Under a mouse a tip below the row says it all in one
 * block (`full`: the name, the state, the whole id); on a touch screen a press on the words opens the row to its full text
 * (`open`) and the next press folds it. `press` returns true when it was a touch press and took it for the fold, so a mouse
 * press falls through to what the row did before. The pointer is read per event, so a hybrid device follows its last use.
 */
export function useFullRow(full: string, colors: Palette) {
  const [hover, setHover] = useState(false), [open, setOpen] = useState(false), touch = useRef(false), raise = useContext(RaiseTip);
  // RN Web boxes are stacking contexts: while the tip shows, the row and every `TipLayer` around it lift over what follows.
  const shown = hover && !open;
  useEffect(() => { if (!shown) return undefined; raise(true); return () => raise(false); }, [shown, raise]);
  const kind = (event: unknown) => { const e = event as { pointerType?: string; nativeEvent?: { pointerType?: string } } | undefined;
    return e?.pointerType ?? e?.nativeEvent?.pointerType; };
  const handlers = {
    onPointerDown: (event: unknown) => { touch.current = kind(event) === 'touch' || kind(event) === 'pen'; },
    onPointerEnter: (event: unknown) => { if (kind(event) === 'mouse') setHover(true); },
    onPointerLeave: () => setHover(false),
  };
  const press = () => { if (!touch.current) return false; setOpen(value => !value); return true; };
  const tip = shown ? <View testID="agent-full-tip" pointerEvents="none" accessibilityRole="text" style={{ position: 'absolute', zIndex: 10,
    top: '100%', left: 0, right: 0, marginTop: px(2), paddingHorizontal: px(8), paddingVertical: px(3), borderRadius: px(5), backgroundColor: colors.surface2,
    borderWidth: 1, borderColor: colors.border }}>
    <Text style={{ color: colors.foreground, fontSize: px(11), lineHeight: px(14), includeFontPadding: false }}>{full}</Text>
  </View> : null;
  return { handlers, press, open, tip, lift: shown ? { zIndex: 10 } : {} };
}
export function AssigneeRow({ agentId, label, colors, m, onOpen, disabled = false, mobile = false, oneLine = false }: {
  agentId: string; label?: string | undefined; colors: Palette; m: Copy;
  onOpen?: (() => void) | undefined; disabled?: boolean; mobile?: boolean; oneLine?: boolean;
}) {
  const source = useSignalSource();
  const bucket = useSignalSummary(source, [agentId])?.bucket ?? 'unknown';
  const info = source.model?.(agentId);
  // REQ-78 ④: as on the card — "…" and no provider mark while the agent is still being looked up.
  const waiting = source.pending?.(agentId) === true;
  const mark = sidebarMark(bucket), name = assigneeName(agentId, info, waiting), state = signalText(bucket, m);
  const text = [name, ...(label && label !== name ? [label] : []), state].join(' · ');
  const id = agentIdSuffix(agentId, name), muted = readable(colors.foregroundMuted, colors.surface0), line = 16;
  const slot = { height: line, justifyContent: 'center' as const };
  const named = [name, ...(label && label !== name ? [label] : [])].join(' · ');
  const idText = <Text key="id" testID="agent-id" style={{ fontSize: px(10), color: muted }}>{' · ' + id}</Text>;
  const long = oneLine && textColumns(state) > ONE_LINE_LONG_STATE;
  // REQ-131: the one-line row's whole text — a tip under the mouse, two lines once pressed on a touch screen.
  const full = useFullRow([named, state, agentId].join(' · '), colors);
  const words = oneLine && full.open
    ? <View testID="agent-signal-text" style={{ flex: 1, minWidth: 0 }}>
      <Text testID="agent-name" style={{ color: muted, fontSize: px(12), lineHeight: line }}>{named}</Text>
      <Text testID="agent-signal-rest" style={{ color: muted, fontSize: px(12), lineHeight: line }}>{[state, agentId].join(' · ')}</Text>
    </View>
    : oneLine
    ? <View testID="agent-signal-text" style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline' }}>
      <Text testID="agent-name" numberOfLines={1} style={{ ...(long ? { flexShrink: 0, maxWidth: ONE_LINE_NAME } : { flexShrink: 1, minWidth: 0 }),
        color: muted, fontSize: px(12), lineHeight: line }}>{named}</Text>
      <View testID="agent-signal-tail" style={{ ...(long ? { flexShrink: 1, minWidth: 0 } : { flexShrink: 0 }), flexDirection: 'row', alignItems: 'baseline' }}>
        <Text testID="agent-signal-rest" numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: muted, fontSize: px(12), lineHeight: line }}>
          {' · ' + state}</Text>
        {!!id && <Text testID="agent-id" numberOfLines={1} style={{ flexShrink: 0, fontSize: px(10), color: muted, lineHeight: line }}>{' · ' + id}</Text>}
      </View>
    </View>
    : <Text testID="agent-signal-text" style={{ flexShrink: 1, color: muted, fontSize: px(12), lineHeight: line }}>{id
      ? [text, idText] : text}</Text>;
  const row = <View testID="agent-signal" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: px(4), flexShrink: 1,
    ...(oneLine ? { flex: 1, minWidth: 0, ...full.lift } : {}) }}>
    <View style={slot}>{mark ? <SidebarStateMark mark={mark} colors={colors} background={colors.surface0} label={state} testID="agent-signal-icon" />
      : <View testID="agent-signal-empty" style={{ width: RING.size, height: RING.size }} />}</View>
    <View style={slot}>{waiting ? <View testID="agent-provider-pending" style={{ width: px(12), height: px(12) }} />
      : <ProviderMark provider={info?.provider} color={readable(colors.foregroundMuted, colors.surface0, 3)} testID="agent-provider-mark" />}</View>
    {oneLine ? <Pressable testID="agent-words" accessibilityState={{ expanded: full.open }} {...full.handlers}
      onPress={() => { if (!full.press() && !disabled) onOpen?.(); }} style={{ flex: 1, minWidth: 0, ...full.lift }}>{words}{full.tip}</Pressable> : words}
  </View>;
  if (!onOpen) return row;
  return <Pressable testID="agent-open" accessibilityRole="button" accessibilityLabel={m.openAgent(name + (id ? ' ' + id : ''))}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onOpen}
    style={{ minHeight: mobile ? px(44) : px(24), flexDirection: 'row', alignItems: 'center', gap: px(4), borderRadius: px(6), ...full.lift }}>
    {row}
    <Icon name="ChevronRight" size={px(14)} color={readable(colors.foregroundMuted, colors.surface0, 3)} />
  </Pressable>;
}
/**
 * REQ-73: the agent's state as Paseo's sidebar draws it, in a 14px slot: the spinning ring, a CircleAlert
 * filled with the warning colour (the glyph's own lines in the card colour, as the sidebar strokes it in its
 * background), or a 6px dot. Colours only darken or lighten where a host theme would drop a mark below 3:1
 * on the card; the finished dot stays the sidebar's faint grey on purpose.
 */
export function SidebarStateMark({ mark, colors, label, size = RING.size, testID = 'card-state-mark', background = colors.card }: {
  mark: SidebarMark; colors: Palette; label: string; size?: number; testID?: string;
  /** What the mark sits on: the card face, or the detail sheet (REQ-74 ④). */
  background?: string;
}) {
  const on = (color: string) => readable(color, background, 3);
  const box = { width: size, height: size, alignItems: 'center' as const, justifyContent: 'center' as const };
  if (mark === 'ring') return <View testID={testID} accessibilityLabel={label} style={box}>
    <Ring color={on(colors.running)} size={size} />
  </View>;
  if (mark === 'alert') {
    const glyph = Math.round(size * 12 / RING.size), disc = Math.round(glyph * 20 / 24);
    // Fill, then glyph, both absolutely placed: native paints later siblings on top, and the web paints positioned
    // boxes in DOM order above static ones — a static glyph would sit under the positioned fill and vanish.
    const layer = { ...box, position: 'absolute' as const, top: 0, left: 0 };
    return <View testID={testID} accessibilityLabel={label} style={box}>
      <View testID="card-state-alert-back" style={layer}>
        <View testID="card-state-alert-fill" style={{ width: disc, height: disc, borderRadius: disc / 2,
          backgroundColor: on(colors.statusDotWarning) }} />
      </View>
      <View testID="card-state-alert-glyph" style={layer}>
        <Icon name="CircleAlert" size={glyph} color={background} />
      </View>
    </View>;
  }
  const dot = Math.round(size * 6 / RING.size);
  const color = mark === 'dot-danger' ? on(colors.statusDotDanger) : mark === 'dot-success' ? on(colors.statusDotSuccess) : colors.statusDotIdle;
  return <View testID={testID} accessibilityLabel={label} style={box}>
    <View testID={'card-state-' + mark} style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color,
      opacity: mark === 'dot-idle' ? .3 : 1 }} />
  </View>;
}
/**
 * REQ-73: the provider's mark, Paseo's own icon in one colour (research/94: unchanged shape, no rotation;
 * NOTICE). A provider Paseo has no mark for gets Paseo's fallback, lucide `Bot`. The provider's name is
 * the accessibility label, so the mark is never the only way to tell.
 */
export function ProviderMark({ provider, color, size = px(12), testID = 'card-provider-mark' }: {
  provider: string | null | undefined; color: string; size?: number; testID?: string;
}) {
  const key = providerKey(provider), name = providerName(provider) ?? '';
  return <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={name}
    style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    {key ? <Image testID={'provider-' + key} source={{ uri: PROVIDER_ICON_PNG[key], width: px(48), height: px(48) }}
      style={{ width: size, height: size, tintColor: color }} resizeMode="contain" />
      : <Icon name="Bot" size={size} color={color} />}
  </View>;
}
/** Test seam: reports whether the shared ring loop is running. */
export function ringClockRunning(): boolean { return running; }
