import { detailLayout } from './visual-model.js';
import { useRef, useState, type ReactNode } from 'react';
import { Modal as NativeModal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView, TextInput } from '@getpaseo/plugin/client/react-native';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import type { Fields } from './editor-state.js';
import { reclaimSeconds } from './editor-state.js';
import type { MutationState } from './mutation-state.js';
import { editorLayout } from './layout.js';
import { Button, Field, IconButton, Notice, useHovered } from './components.js';
import { fieldLine, FIELD_LINE_WIDTH, hoverFill, readable, selectedLine, selectedTint, type Palette } from './palette.js';
import type { Copy } from './i18n.js';
import { KanbanSheet } from './kanban-sheet.js';
import type { FieldStatus as FieldStatusValue } from './field-save.js';
import { px } from './ui-scale.js';

// RN Web accepts outlineStyle 'none'; the RN types omit it. The field's own edge carries the focus (REQ-88 ②).
const noOutline = { outlineStyle: 'none', outlineWidth: 0 } as object;
/**
 * The detail's and the draft's window. On a wide screen the detail is its own centred window (REQ-28; REQ-88 ① 880px);
 * everything else — the phone, the 390 web detail and the draft — is a Kanban sheet (REQ-72). REQ-88 ⑤: the detail saves
 * field by field, so it has no footer; the draft keeps its one "Save draft" button (`action`). `canClose` is asked
 * before any close (×, Escape, back, a press outside, a pull) and may keep the window open.
 */
export function EditorSheet({ title, props, colors, children, action, actionLabel = '', disabled = false, onClose, canClose,
  headerExtra, wide = false, closeLabel = 'Close' }: {
  title: string; props: PluginSurfaceProps; colors: Palette; children: ReactNode; wide?: boolean; closeLabel?: string;
  action?: () => void; actionLabel?: string; disabled?: boolean; onClose: () => void;
  canClose?: () => boolean; headerExtra?: ReactNode;
}) {
  const mobile = props.layout.platform !== 'web' || props.layout.compact;
  const dimensions = useWindowDimensions();
  const size = editorLayout(props.layout.platform, mobile, dimensions.height);
  const detail = detailLayout(dimensions.width, mobile), padding = wide ? detail.padding : px(16);
  const request = () => { if (!canClose || canClose()) onClose(); };
  // REQ-72: the sheet keeps its fields above the keyboard (KanbanSheet), so the body only fills it.
  const body = <View style={{ flex: 1, minHeight: 0 }}>
    <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding, paddingBottom: px(20), gap: px(16) }}>{children}</ScrollView>
    {action && <View testID="editor-footer" style={{ paddingHorizontal: padding, paddingTop: px(8), paddingBottom: px(8),
      borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} disabled={disabled} onPress={action}
        style={{ minHeight: size.buttonHeight, borderRadius: px(6), backgroundColor: colors.accent,
          alignItems: 'center', justifyContent: 'center', opacity: disabled ? .4 : 1 }}>
        <Text style={{ color: colors.accentForeground, fontSize: px(14), fontWeight: '600' }}>{actionLabel}</Text>
      </Pressable>
    </View>}
  </View>;
  // The public host Modal fixes desktop maxWidth at 520 and exposes bodyStyle only.
  // A public RN Modal owns desktop detail sizing.
  if (wide && !mobile) return <NativeModal testID="desktop-detail-modal" visible transparent animationType="fade" onRequestClose={request}>
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Pressable testID="detail-backdrop" accessibilityLabel={closeLabel} onPress={request}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.modalBackdrop }} />
      <View testID="desktop-detail-dialog" accessibilityViewIsModal accessibilityLabel={title}
        style={{ width: detail.width, height: size.sheetHeight, maxHeight: '85%', borderRadius: px(12),
          overflow: 'hidden', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0 }}>
        <View style={{ height: px(48), flexDirection: 'row', alignItems: 'center', gap: px(8), paddingLeft: padding, paddingRight: px(12),
          borderBottomWidth: 1, borderColor: colors.border }}>
          <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: px(13) }}>{title}</Text>
          {headerExtra}
          <IconButton testID="sheet-close" name="X" label={closeLabel} mobile={false} colors={colors} onPress={request} round iconSize={px(16)} />
        </View>
        {body}
      </View>
    </View>
  </NativeModal>;
  // REQ-72: everything else — the phone, the 390 web detail and the draft — is a Kanban sheet in the chosen theme:
  // from the bottom on a phone, a centred window of the same height on a wide screen.
  return <KanbanSheet testID="editor-sheet" title={title} open onClose={onClose} canClose={canClose} headerExtra={headerExtra} colors={colors}
    platform={props.layout.platform} closeLabel={closeLabel} centered={!mobile} width={px(520)} height={size.sheetHeight} scroll={false}>{body}</KanbanSheet>;
}
/** The look of a text field at rest, under the mouse and while typed in (REQ-88 ②): a faint 1px edge, then the main colour. */
export function fieldEdge(colors: Palette, fill: string, active: boolean): string {
  return active ? selectedLine(colors, fill) : fieldLine(colors, fill);
}
/**
 * REQ-88 ②⑤: one text field of the detail or the draft. Its edge is faint at rest and the main colour at the same 1px
 * under the mouse or while typed in (`fieldEdge`). `onCommit` is leaving it (blur), Enter on a one-line field, or
 * Ctrl/⌘+Enter on a longer one; Escape hands back `onRevert` (the web — a phone has no Escape). `below` is what the
 * field says under itself: its save state (REQ-88 ⑤) or an error.
 */
export function TextField({ label, value, onChangeText, onCommit, onRevert, multiline = false, colors, mobile, disabled = false,
  testID, below, minHeight, hint, placeholder, onEscape }: {
  label: string; value: string; onChangeText: (text: string) => void; onCommit?: (() => void) | undefined; onRevert?: (() => void) | undefined;
  multiline?: boolean; colors: Palette; mobile: boolean; disabled?: boolean; testID?: string | undefined; below?: ReactNode;
  minHeight?: number | undefined; hint?: string | undefined; placeholder?: string | undefined;
  /** Escape was used by the field, so the window around it must not close on the same key (its keyup). */
  onEscape?: (() => void) | undefined;
}) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const fill = colors.surface1, edge = fieldEdge(colors, fill, !disabled && (focused || hovered && !mobile));
  return <Field label={label} colors={colors}>
    <View testID={testID ? testID + '-box' : undefined} {...(mobile ? {} : { onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false) })}>
      <TextInput testID={testID} accessibilityLabel={label} editable={!disabled} value={value} onChangeText={onChangeText}
        placeholder={placeholder} placeholderTextColor={readable(colors.foregroundMuted, fill, 3)}
        onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onCommit?.(); }}
        {...(multiline ? {} : { onSubmitEditing: () => onCommit?.() })}
        onKeyPress={event => {
          const key = event.nativeEvent as { key?: string; ctrlKey?: boolean; metaKey?: boolean };
          if (key.key === 'Escape' && onRevert) { onRevert(); onEscape?.(); }
          else if (multiline && key.key === 'Enter' && (key.ctrlKey || key.metaKey)) onCommit?.();
        }}
        multiline={multiline} style={{ minHeight: minHeight ?? (multiline ? (mobile ? px(88) : px(100)) : mobile ? px(44) : px(32)),
          color: colors.foreground, backgroundColor: fill, borderColor: edge, borderWidth: FIELD_LINE_WIDTH, borderRadius: px(6),
          padding: px(8), textAlignVertical: 'top', fontSize: px(14), lineHeight: px(20), ...noOutline }} />
    </View>
    {focused && !mobile && !!hint && <Text testID={testID ? testID + '-hint' : undefined}
      style={{ alignSelf: 'flex-end', color: readable(colors.foregroundMuted, colors.surface0), fontSize: px(11) }}>{hint}</Text>}
    {below}
  </Field>;
}
/**
 * REQ-88 ③ (research/129 ③A): the card's title at the top of the detail is the one place it is edited. Pressed, it turns
 * into a field where it stands (the mouse over it shows a faint fill and a pencil first); Enter or leaving it saves, Escape
 * puts the old title back. A phone has no Enter to trust nor Escape, so a × and a ✓ sit right under the field.
 */
export function InlineTitle({ value, onChangeText, onCommit, onRevert, onEscape, colors: c, m, mobile, disabled, below }: {
  value: string; onChangeText: (text: string) => void; onCommit: (typed?: string) => void; onRevert: () => void; onEscape: () => void;
  colors: Palette; m: Copy; mobile: boolean; disabled: boolean; below?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const hover = useHovered(), cancelling = useRef(false);
  const commit = (typed?: string) => { setEditing(false); onCommit(typed); };
  const cancel = () => { cancelling.current = false; setEditing(false); onRevert(); };
  const size = mobile ? px(18) : px(20), line = mobile ? px(24) : px(28);
  if (!editing) return <View style={{ gap: px(4) }}>
    <Pressable testID="detail-title" accessibilityRole="button" accessibilityLabel={m.editTitle + ': ' + value} disabled={disabled}
      onPress={() => setEditing(true)} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: px(6), marginHorizontal: px(-6), paddingHorizontal: px(6), paddingVertical: px(2),
        borderRadius: px(6), backgroundColor: hover.hovered && !mobile && !disabled ? hoverFill(c, c.surface0) : 'transparent' }}>
      <Text accessibilityRole="header" style={{ flex: 1, color: c.foreground, fontSize: size, lineHeight: line, fontWeight: '600' }}>{value}</Text>
      {hover.hovered && !mobile && !disabled && <View testID="detail-title-pencil" style={{ height: line, justifyContent: 'center' }}>
        <Icon name="Pencil" size={px(15)} color={c.foregroundMuted} /></View>}
    </Pressable>
    {below}
  </View>;
  return <View style={{ gap: px(6) }}>
    <TextInput testID="detail-title-input" accessibilityLabel={m.title} autoFocus multiline submitBehavior="blurAndSubmit" value={value}
      // A title is one line: the Enter a web text area would put in it saves instead (a phone's return key submits).
      onChangeText={text => { if (/\n/.test(text)) { const typed = text.replace(/\n/g, ''); onChangeText(typed); commit(typed); } else onChangeText(text); }}
      onSubmitEditing={() => { if (!cancelling.current) commit(); }}
      onBlur={() => { if (cancelling.current) cancel(); else if (editing) commit(); }}
      onKeyPress={event => { if ((event.nativeEvent as { key?: string }).key === 'Escape') { cancel(); onEscape(); } }}
      style={{ color: c.foreground, fontSize: size, lineHeight: line, fontWeight: '600', backgroundColor: c.surface1,
        borderWidth: FIELD_LINE_WIDTH, borderColor: selectedLine(c, c.surface1), borderRadius: px(6), paddingHorizontal: px(8), paddingVertical: px(4),
        minHeight: mobile ? px(44) : px(36), ...noOutline }} />
    {mobile ? <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: px(8) }}>
      <Pressable testID="detail-title-cancel" accessibilityRole="button" accessibilityLabel={m.cancelEdit}
        onPressIn={() => { cancelling.current = true; }} onPress={cancel}
        style={{ width: px(44), height: px(44), alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: px(32), height: px(32), borderRadius: px(6), alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface2 }}>
          <Icon name="X" size={px(16)} color={c.foreground} /></View>
      </Pressable>
      <Pressable testID="detail-title-save" accessibilityRole="button" accessibilityLabel={m.saveTitle} onPress={() => commit()}
        style={{ width: px(44), height: px(44), alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: px(32), height: px(32), borderRadius: px(6), alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent }}>
          <Icon name="Check" size={px(16)} color={readable(c.accentForeground, c.accent)} /></View>
      </Pressable>
    </View> : <Text style={{ alignSelf: 'flex-end', color: readable(c.foregroundMuted, c.surface0), fontSize: px(11) }}>{m.fieldHintLine}</Text>}
    {below}
  </View>;
}
/**
 * REQ-88 ⑤: what one field says under itself about its own save — saving, saved (a moment), not saved with its reason and
 * "Try again" (the typed value stays), unknown (the same request again), or changed elsewhere meanwhile with "Show latest" and
 * "Keep mine". Nothing when there is nothing to say.
 */
export function FieldStatus({ id, status, m, colors: c, mobile, onRetry, onLatest, onMine }: {
  id: string; status: FieldStatusValue | undefined; m: Copy; colors: Palette; mobile: boolean;
  onRetry: () => void; onLatest: () => void; onMine: () => void;
}) {
  if (!status) return null;
  const muted = readable(c.foregroundMuted, c.surface0), danger = readable(c.statusDanger, c.surface0);
  const link = (label: string, onPress: () => void, testID: string) => <Pressable key={testID} testID={testID} accessibilityRole="button"
    accessibilityLabel={label} onPress={onPress} hitSlop={mobile ? px(8) : px(4)} style={{ minHeight: mobile ? px(32) : px(20), justifyContent: 'center' }}>
    <Text style={{ color: readable(c.accent, c.surface0), fontSize: px(12), fontWeight: '600' }}>{label}</Text>
  </Pressable>;
  const wait = status.state === 'failed' && status.wait !== null && status.wait !== undefined ? ' ' + m.retryAfter(status.wait) : '';
  return <View testID={'field-status-' + id} accessibilityLiveRegion="polite"
    style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: px(10), rowGap: px(2) }}>
    {status.state === 'saving' && <Text style={{ color: muted, fontSize: px(12) }}>{m.fieldSaving}</Text>}
    {status.state === 'saved' && <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(4) }}>
      <Icon name="Check" size={px(12)} color={readable(c.statusSuccess, c.surface0)} />
      <Text style={{ color: readable(c.statusSuccess, c.surface0), fontSize: px(12) }}>{m.fieldSaved}</Text></View>}
    {status.state === 'invalid' && <Text accessibilityRole="alert" style={{ color: danger, fontSize: px(12) }}>{status.message ?? m.fieldInvalid}</Text>}
    {status.state === 'failed' && <>
      <Text accessibilityRole="alert" style={{ color: danger, fontSize: px(12), flexShrink: 1 }}>{m.fieldFailed + (status.message ? ' — ' + status.message : '') + wait}</Text>
      {link(m.fieldRetry, onRetry, 'field-retry-' + id)}</>}
    {status.state === 'unknown' && <>
      <Text accessibilityRole="alert" style={{ color: danger, fontSize: px(12) }}>{m.fieldUnknown}</Text>
      {link(m.fieldRetry, onRetry, 'field-retry-' + id)}</>}
    {status.state === 'conflict' && <>
      <Text accessibilityRole="alert" style={{ color: danger, fontSize: px(12) }}>{m.fieldConflict}</Text>
      {link(m.fieldLatest, onLatest, 'field-latest-' + id)}{link(m.fieldMine, onMine, 'field-mine-' + id)}</>}
  </View>;
}
/** The draft's fields (CreateDraft): one column of text fields and the priority, saved together by "Save draft". */
export function EditFields({ value, onChange, m, colors, mobile, disabled, errors = {} }: {
  value: Fields; onChange: (patch: Partial<Fields>) => void; m: Copy; colors: Palette;
  mobile: boolean; disabled: boolean; draft?: boolean; errors?: Record<string, string>;
}) {
  const input = (key: 'title' | 'notes' | 'nextAction', multiline = false) => <TextField key={key} label={m[key]} value={value[key] ?? ''}
    onChangeText={text => onChange({ [key]: text })} multiline={multiline} colors={colors} mobile={mobile} disabled={disabled}
    minHeight={multiline ? (mobile ? px(88) : px(60)) : undefined}
    below={errors[key] ? <Notice text={errors[key]!} colors={colors} error /> : undefined} />;
  return <View testID="edit-fields" style={{ gap: px(16) }}>
    {input('title')}{input('nextAction')}{input('notes', true)}
    <PriorityChoice value={value.priority} onChange={priority => onChange({ priority })} m={m} colors={colors} mobile={mobile} disabled={disabled} />
  </View>;
}
/** REQ-88 ⑤: a row of choices (priority, who is awaited); the chosen one is tinted (REQ-85 ③B). Pressing one is its save. */
export function ChoiceRow<T extends string | null>({ label, options, value, onChange, colors, mobile, disabled, testID, below }: {
  label: string; options: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void; colors: Palette;
  mobile: boolean; disabled: boolean; testID: string; below?: ReactNode;
}) {
  return <Field label={label} colors={colors}><View testID={testID} accessibilityRole="radiogroup" accessibilityLabel={label}
    style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(4) }}>
    {options.map(option => <Choice key={option.id ?? 'none'} testID={testID + '-' + (option.id ?? 'none')} label={option.label}
      colors={colors} mobile={mobile} chosen={option.id === value} disabled={disabled}
      onPress={() => { if (option.id !== value) onChange(option.id); }} />)}
  </View>{below}</Field>;
}
/** One choice of a `ChoiceRow`: a faint edge like a field's; chosen, the main colour's tint and bold words, no edge. */
function Choice({ label, chosen, disabled, onPress, colors: c, mobile, testID }: {
  label: string; chosen: boolean; disabled: boolean; onPress: () => void; colors: Palette; mobile: boolean; testID: string;
}) {
  const hover = useHovered(), lit = hover.hovered && !mobile && !disabled;
  return <Pressable testID={testID} accessibilityRole="radio" role="radio" aria-checked={chosen} accessibilityLabel={label}
    accessibilityState={{ checked: chosen, disabled }} disabled={disabled} onPress={onPress} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: mobile ? px(44) : px(30), justifyContent: 'center' }}>
    <View style={{ height: mobile ? px(32) : px(28), paddingHorizontal: px(10), borderRadius: px(6), justifyContent: 'center', borderWidth: FIELD_LINE_WIDTH,
      borderColor: chosen ? 'transparent' : fieldLine(c, c.surface0), opacity: disabled ? .5 : 1,
      backgroundColor: chosen ? selectedTint(c, c.surface0, lit) : lit ? hoverFill(c, c.surface0) : 'transparent' }}>
      <Text style={{ color: c.foreground, fontSize: px(13), fontWeight: chosen ? '600' : '400' }}>{label}</Text>
    </View>
  </Pressable>;
}
export function PriorityChoice({ value, onChange, m, colors, mobile, disabled, below }: {
  value: Fields['priority']; onChange: (value: Fields['priority']) => void; m: Copy; colors: Palette; mobile: boolean; disabled: boolean;
  below?: ReactNode;
}) {
  return <ChoiceRow testID="priority-choice" label={m.priority} value={value} onChange={onChange} colors={colors} mobile={mobile}
    disabled={disabled} below={below} options={(['high', 'normal', 'low'] as const).map(id => ({ id, label: m[id] }))} />;
}
export function MutationNotice({ state, m, colors, onCheck, onRetry }: {
  state: MutationState; m: Copy; colors: Palette; onCheck: () => void; onRetry: () => void;
}) {
  const error = state.reply && !state.reply.ok ? state.reply.error : null;
  const wait = error ? reclaimSeconds(error.details, Date.now()) : null;
  return <View style={{ gap: px(8) }}>
    {state.phase === 'sending' && <Notice text={m.saving} colors={colors} />}
    {state.phase === 'saved' && <Notice text={m.saved} colors={colors} />}
    {state.reply?.ok && (state.reply.data.export === 'failed' || state.reply.warnings.some(w => w.code.startsWith('W_EXPORT'))) &&
      <Notice text={m.exportWarning} colors={colors} error />}
    {state.reply?.ok && state.reply.warnings.map((w, i) => <Notice key={i} text={`${w.code}: ${w.message} ${w.nextAction}`} colors={colors} />)}
    {error && state.phase !== 'conflict' && <Notice text={state.phase === 'unknown' ? m.unknownWrite
      : `${m.saveFailed} ${error.code}: ${error.message} ${error.nextAction}`} colors={colors} error />}
    {wait !== null && <Notice text={m.retryAfter(wait)} colors={colors} />}
    {state.phase === 'unknown' && <>
      <Button label={m.checkCurrent} colors={colors} mobile onPress={onCheck} />
      {state.checked && <Notice text={`${m.currentBoard}: ${state.checked.revision} · ${state.checked.observedAt}`} colors={colors} />}
      {!!state.checkError && <Notice text={state.checkError} colors={colors} error />}
      <Button label={m.retryOriginal} colors={colors} mobile onPress={onRetry} />
    </>}
  </View>;
}
