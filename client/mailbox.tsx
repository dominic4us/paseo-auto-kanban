import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView, TextInput } from '@getpaseo/plugin/client/react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { mailListGet, mailThreadGet, type MailAliasRule } from '../shared/rpc.js';
import { kstDay, mailAttention, mailPeople, mailRecord, type MailListDTO, type MailListThreadDTO, type MailStatus,
  type MailThreadDTO } from '../shared/mail-list.js';
import { EMPTY_MAIL_FILTER, MAIL_PERSON, MAIL_STATE_CHOICES, mailFilterCount, mailGroups, mailOptions, mailRows, pickerLabel,
  searchOptions, toggleChoice, type MailFilter, type MailHits, type MailOption, type MailRow, type MailStateChoice } from './mail-list-model.js';
import { useRead } from './data.js';
import { useSessionValue } from './session.js';
import { IconButton, QuietLink, toolLook, useHovered } from './components.js';
import { useMinuteClock } from './minute-clock.js';
import { localStamp } from './move-reason.js';
import { countBadge, mixColors, readable, selectedTint, type Palette } from './palette.js';
import type { Copy } from './i18n.js';
import { px, scaled } from './ui-scale.js';

/*
 * REQ-128 (research/232, v2 filter row 1 — the owner's choice): the lab's message list. A glyph on the wide board's title
 * row, counting the threads waiting for a person's decision or left waiting, opens a panel over the board: every thread of
 * the message folder as a mail list (state · from → to · title · kind · newest file · due), grouped a person's decision →
 * left waiting → open → closed, with a filter row (From ⌄ [and/or] To ⌄ State ⌄ · title search). A thread pressed shows its
 * newest file's head and excerpt and its earlier files beside the list. Read only: nothing here writes a file or a setting;
 * the filters live in this screen's memory. REQ-134 MA: the 390px board shows the same list in a sheet of its own (mobile-mailbox.tsx),
 * from these parts.
 */
// RN Web accepts outlineStyle 'none'; the RN types omit it (as filter-bar.tsx).
const noOutline = { outlineStyle: 'none', outlineWidth: 0 } as object;

/**
 * The server's reading of the message folder while the glyph shows. It says the folder's fingerprint it answers (`source`);
 * while the board's (REQ-90's `key`) is another, it is read again — research/236 D1: compared with what the reading answers,
 * not with the fingerprint seen before, so a reading that came back older is asked again rather than kept.
 */
export function useMailList(hostId: string, enabled: boolean, fingerprint: string | undefined) {
  const get = useRpc(mailListGet);
  const read = useRead<MailListDTO>(hostId + ':mail-list', () => get({ hostId }), enabled);
  const source = read.data?.source;
  useEffect(() => {
    if (enabled && fingerprint !== undefined && source !== undefined && source !== fingerprint) void read.revalidate();
  }, [enabled, fingerprint, source]);
  return read;
}

/** The glyph: tinted while the panel is open, its count the threads that want a look. */
export function MailboxButton({ count, open, onPress, colors: c, m }: { count: number; open: boolean; onPress: () => void; colors: Palette; m: Copy }) {
  return <IconButton testID="mailbox-button" name="Mail" label={m.mailboxOpen(count)} colors={c} mobile={false} tooltip on={open}
    badge={count} onPress={onPress} />;
}
/** The workspaces a mail dropdown offers: Paseo's listing, one per folder, project roots left out (the wide and the phone list). */
export function mailWorkspaceList(directory: Record<string, { cwd?: string | null | undefined; name: string; projectRoot?: unknown }>): { cwd: string; name: string }[] {
  return [...new Map(Object.values(directory).filter(w => w.cwd && !w.projectRoot).map(w => [w.cwd!, { cwd: w.cwd!, name: w.name }])).values()];
}
export const mailboxCount = (data: MailListDTO | null | undefined, now: number) => data?.state === 'ready' ? mailAttention(data.threads, now) : 0;

const short = (at: string | null, now: number) => !at ? '' : at.slice(0, 4) === String(kstDay(now)).slice(0, 4) ? at.slice(5) : at;
const dayText = (day: number) => String(day).slice(4, 6) + '-' + String(day).slice(6, 8);
function stateColor(c: Palette, status: MailStatus): string {
  return status.state === 'decision' ? c.statusDotWarning : status.state === 'stale' ? c.statusDotDanger : status.state === 'open' ? c.running : c.foregroundMuted;
}
function stateWords(status: MailStatus, person: string, m: Copy): string {
  if (status.state === 'decision') return m.mailPersonOf(person) + (status.stale ? ' · ' + m.mailStaleWhy[status.stale] : '');
  if (status.state === 'stale') return m.mailStateName.stale + ' · ' + m.mailStaleWhy[status.stale ?? 'age'];
  return m.mailStateName[status.state];
}
function StatePill({ status, person, colors: c, m, onto }: { status: MailStatus; person: string; colors: Palette; m: Copy; onto: string }) {
  const base = stateColor(c, status), fill = mixColors(onto, base, .16);
  return <View testID="mailbox-state" style={{ height: px(20), paddingHorizontal: px(8), borderRadius: px(10), backgroundColor: fill, justifyContent: 'center', alignSelf: 'flex-start' }}>
    <Text numberOfLines={1} style={{ color: readable(base, fill), fontSize: px(11), fontWeight: '600' }}>{stateWords(status, person, m)}</Text>
  </View>;
}
function KindChip({ kind, colors: c, onto }: { kind: string | null; colors: Palette; onto: string }) {
  if (!kind) return null;
  return <View testID="mailbox-kind" style={{ height: px(18), paddingHorizontal: px(5), borderRadius: px(4), borderWidth: 1, borderColor: c.border, justifyContent: 'center' }}>
    <Text numberOfLines={1} style={{ color: readable(c.foregroundMuted, onto), fontSize: px(11) }}>{kind}</Text>
  </View>;
}
/** "from → to": a person's record shows the person (in the decision colour); names the filter caught are underlined. */
function Who({ status, hits, colors: c, m, onto, size = px(12) }: { status: MailStatus; hits: MailHits | undefined; colors: Palette; m: Copy; onto: string; size?: number }) {
  const hit = readable(c.statusSuccess, onto), plain = c.foreground, muted = readable(c.foregroundMuted, onto);
  const name = (text: string, caught: boolean, color = plain) => <Text key={text} style={{ color: caught ? hit : color,
    ...(caught ? { textDecorationLine: 'underline' as const } : {}), fontWeight: caught ? '600' : '400' }}>{text}</Text>;
  const join = (items: ReactNode[]) => items.flatMap((item, i) => i ? [<Text key={'s' + i} style={{ color: muted }}>{' · '}</Text>, item] : [item]);
  const from = status.from.length ? join(status.from.map(f => name(f, !!hits?.from.has(f)))) : [<Text key="nf" style={{ color: muted }}>?</Text>];
  const to = status.to.length ? join(status.to.map(t => { const record = mailRecord(t);
    return record ? name(record.person, !!hits?.person, readable(c.statusWarning, onto)) : name(t, !!hits?.to.has(t)); }))
    : [<Text key="nt" style={{ color: muted }}>{status.unknown ? m.mailUnknownTo : m.mailNoOne}</Text>];
  return <Text testID="mailbox-who" numberOfLines={1} style={{ fontSize: size, color: plain }}>{from}<Text style={{ color: muted }}>{' → '}</Text>{to}</Text>;
}
function DueText({ status, now, colors: c, m, onto }: { status: MailStatus; now: number; colors: Palette; m: Copy; onto: string }) {
  const past = status.due !== null && status.due < kstDay(now);
  return <Text testID="mailbox-due" numberOfLines={1} style={{ color: past && status.state !== 'closed' ? readable(c.statusDanger, onto) : readable(c.foregroundMuted, onto),
    fontSize: px(12), fontWeight: past ? '600' : '400', textAlign: 'right' }}>{m.mailDue(status.due === null ? null : dayText(status.due), status.dueToday, past)}</Text>;
}

// ---- the dropdowns ------------------------------------------------------------------------------------------------------
interface Pinned { id: string; label: string; note: string; count: number }
function Check({ on, colors: c }: { on: boolean; colors: Palette }) {
  return <View style={{ width: px(16), height: px(16), borderRadius: px(4), borderWidth: 1, borderColor: on ? c.accent : c.border,
    backgroundColor: on ? c.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
    {on && <Icon name="Check" size={px(12)} color={readable(c.surface0, c.accent)} />}
  </View>;
}
export function OptionRow({ testID, label, note, count, chosen, onPress, colors: c, strong = false, tall = false }: {
  testID: string; label: string; note?: string | undefined; count: number; chosen: boolean; onPress: () => void; colors: Palette; strong?: boolean;
  /** REQ-134 MA: a phone's 44px row. */
  tall?: boolean;
}) {
  const hover = useHovered(), fill = chosen ? selectedTint(c, c.surface1, hover.hovered) : hover.hovered ? mixColors(c.surface1, c.foreground, .06) : c.surface1;
  return <Pressable testID={testID} accessibilityRole="checkbox" role="checkbox" aria-checked={chosen} accessibilityState={{ checked: chosen }}
    accessibilityLabel={label + ' ' + count} onPress={onPress} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: tall ? px(44) : px(30), paddingHorizontal: px(8), paddingVertical: px(4), borderRadius: px(4), flexDirection: 'row', alignItems: 'center', gap: px(8),
      backgroundColor: fill, opacity: count || chosen || strong ? 1 : .5 }}>
    <Check on={chosen} colors={c} />
    <View style={{ flex: 1, minWidth: 0, flexDirection: strong ? 'column' : 'row', alignItems: strong ? 'flex-start' : 'baseline', gap: strong ? 0 : px(6) }}>
      <Text numberOfLines={1} style={{ color: strong ? readable(c.statusWarning, fill) : c.foreground, fontSize: px(13), fontWeight: strong ? '700' : '400' }}>{label}</Text>
      {!!note && <Text numberOfLines={1} style={{ flexShrink: 1, color: readable(c.foregroundMuted, fill), fontSize: px(11) }}>{note}</Text>}
    </View>
    <Text testID={testID + '-count'} style={{ color: readable(c.foregroundMuted, fill), fontSize: px(12) }}>{count}</Text>
  </Pressable>;
}
/**
 * A filter dropdown in the board's dropdown shape (client/dropdown.tsx): a trigger saying its name (with one choice, the
 * choice; with more, a count) and an ✕ while any is chosen; its menu has a find field, the pinned row, the choices with their
 * counts (none faded) and "Clear all". Several may be ticked; the menu stays open until Escape or a press outside.
 * research/236 D4: the trigger is at most `MAIL_PICKER_WIDTH` and gives way first on a narrow row — a long choice loses its
 * end (the full names are its accessible label and the rule line under the row), so the row stays one line.
 */
export const MAIL_PICKER_WIDTH = 200;
function MailPicker({ testID, name, options, chosen, onChange, pinned, caption, countCaption, find, colors: c, m, nameOf }: {
  testID: string; name: string; options: readonly MailOption[]; chosen: readonly string[]; onChange: (next: string[]) => void;
  pinned?: Pinned | undefined; caption: string; countCaption: string; find: string | null; colors: Palette; m: Copy; nameOf: (id: string) => string;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [anchor, setAnchor] = useState({ x: 8, y: 0, width: px(120), height: px(30) });
  const trigger = useRef<View>(null), hover = useHovered(), viewport = useWindowDimensions();
  const shown = searchOptions(options, query), label = pickerLabel(name, chosen, nameOf), active = chosen.length > 0;
  const look = toolLook(c, { on: active || open, hovered: hover.hovered, edge: true });
  const width = px(320), height = Math.min(px(460), viewport.height - px(16));
  const top = anchor.y + anchor.height + px(4) + height > viewport.height - px(8) ? Math.max(px(8), viewport.height - px(8) - height) : anchor.y + anchor.height + px(4);
  const left = Math.max(px(8), Math.min(anchor.x, viewport.width - width - px(8)));
  const show = () => {
    const node = trigger.current as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (node?.measureInWindow) node.measureInWindow((x, y, w, h) => { setAnchor({ x, y, width: w, height: h }); setOpen(true); });
    else setOpen(true);
  };
  const close = () => { setOpen(false); setQuery(''); };
  const flip = (id: string) => onChange(toggleChoice(chosen, id));
  const countLook = countBadge(c, look.backgroundColor === 'transparent' ? c.surface0 : look.backgroundColor);
  return <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: px(72), height: px(30), borderRadius: px(6), borderWidth: 1,
    borderColor: active || open ? 'transparent' : c.border, backgroundColor: look.backgroundColor }}>
    <Pressable ref={trigger} testID={testID + '-trigger'} accessibilityRole="button" accessibilityLabel={name + (chosen.length ? ': ' + chosen.map(nameOf).join(', ') : '')}
      accessibilityState={{ expanded: open }} aria-haspopup="menu" onPress={() => open ? close() : show()} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
      style={{ height: px(28), paddingLeft: px(10), paddingRight: active ? px(4) : px(8), flexDirection: 'row', alignItems: 'center', gap: px(6), flexShrink: 1, minWidth: 0, maxWidth: px(MAIL_PICKER_WIDTH) }}>
      <Text testID={testID + '-label'} numberOfLines={1} style={{ flexShrink: 1, color: active ? look.icon : c.foreground, fontSize: px(13), fontWeight: active ? '600' : '400' }}>{label.text}</Text>
      {label.count > 1 && <View testID={testID + '-count'} style={{ minWidth: px(16), height: px(16), paddingHorizontal: px(4), borderRadius: px(8), borderWidth: 1,
        borderColor: countLook.line, backgroundColor: countLook.fill, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: countLook.text, fontSize: px(10), fontWeight: '700' }}>{label.count}</Text></View>}
      {!active && <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={px(14)} color={c.foregroundMuted} />}
    </Pressable>
    {active && <Pressable testID={testID + '-clear'} accessibilityRole="button" accessibilityLabel={m.mailClearPicker(name)} onPress={() => onChange([])}
      style={{ width: px(24), height: px(28), alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="X" size={px(13)} color={look.icon} /></Pressable>}
    <Modal testID={testID + '-modal'} visible={open} transparent animationType="none" onRequestClose={close}>
      <View style={{ flex: 1 }} onAccessibilityEscape={close}>
        <Pressable testID={testID + '-dismiss'} accessibilityRole="button" accessibilityLabel={m.close} onPress={close}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
        <View testID={testID + '-menu'} accessibilityRole="menu" accessibilityLabel={name} style={{ position: 'absolute', left, top, width, maxHeight: height,
          borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, borderRadius: px(8), padding: px(6), gap: px(4) }}>
          {find !== null && <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TextInput testID={testID + '-search'} autoFocus accessibilityLabel={find} placeholder={find} placeholderTextColor={c.foregroundMuted}
              value={query} onChangeText={setQuery} autoCorrect={false}
              style={{ flex: 1, height: px(30), borderRadius: px(6), borderWidth: 1, borderColor: c.accent, ...noOutline, backgroundColor: c.surface0,
                color: c.foreground, paddingLeft: px(28), paddingRight: px(8), fontSize: px(13) }} />
            <View pointerEvents="none" style={{ position: 'absolute', left: px(8), top: px(8) }}><Icon name="Search" size={px(14)} color={c.foregroundMuted} /></View>
          </View>}
          {pinned && <OptionRow testID={testID + '-option-' + pinned.id} label={pinned.label} note={pinned.note} count={pinned.count} strong
            chosen={chosen.includes(pinned.id)} onPress={() => flip(pinned.id)} colors={c} />}
          <View style={{ flexDirection: 'row', paddingHorizontal: px(8), paddingTop: px(4) }}>
            <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: px(11) }}>{caption}</Text>
            <Text style={{ color: c.foregroundMuted, fontSize: px(11) }}>{countCaption}</Text>
          </View>
          <ScrollView testID={testID + '-options'} style={{ flexShrink: 1 }}>
            {shown.map(o => <OptionRow key={o.id} testID={testID + '-option-' + o.id} label={o.name} note={o.note} count={o.count}
              chosen={chosen.includes(o.id)} onPress={() => flip(o.id)} colors={c} />)}
          </ScrollView>
          <View style={{ height: px(1), backgroundColor: c.border }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: px(6), paddingVertical: px(2) }}>
            <QuietLink testID={testID + '-none'} label={m.mailClearAll} description={m.mailClearPicker(name)} colors={c} disabled={!chosen.length} onPress={() => onChange([])} />
            <Text style={{ flex: 1, textAlign: 'right', color: c.foregroundMuted, fontSize: px(11) }}>{m.mailPickerHint}</Text>
          </View>
        </View>
      </View>
    </Modal>
  </View>;
}
export function JoinPill({ join, onChange, colors: c, m }: { join: MailFilter['join']; onChange: (next: MailFilter['join']) => void; colors: Palette; m: Copy }) {
  const hover = useHovered(), and = join === 'and', look = toolLook(c, { on: !and, hovered: hover.hovered });
  return <Pressable testID="mailbox-join" accessibilityRole="button" accessibilityLabel={m.mailJoinLabel(and)} onPress={() => onChange(and ? 'or' : 'and')}
    onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ height: px(24), flexShrink: 0, paddingHorizontal: px(8), borderRadius: px(12), borderWidth: 1, borderStyle: 'dashed', borderColor: and ? c.border : c.accent,
      backgroundColor: look.backgroundColor, flexDirection: 'row', alignItems: 'center', gap: px(4) }}>
    <Icon name="ArrowLeftRight" size={px(11)} color={and ? c.foregroundMuted : look.icon} />
    <Text testID="mailbox-join-text" style={{ color: and ? c.foregroundMuted : look.icon, fontSize: px(12), fontWeight: '600' }}>{and ? m.mailAnd : m.mailOr}</Text>
  </Pressable>;
}

/** The rule in force, in words: "From A or B and To (X or Y) · State … · Title …", the joining words in the hit colour. */
export function RuleLine({ filter, nameOf, colors: c, m }: { filter: MailFilter; nameOf: (id: string) => string; colors: Palette; m: Copy }) {
  const onto = c.panelHeader, word = (text: string, key: string) => <Text key={key} style={{ color: readable(c.statusSuccess, onto), fontWeight: '700' }}>{' ' + text + ' '}</Text>;
  const names = (ids: readonly string[], prefix: string) => {
    const parts: ReactNode[] = [];
    ids.forEach((id, i) => { if (i) parts.push(word(m.mailOr, prefix + 'or' + i)); parts.push(<Text key={prefix + id} style={{ fontWeight: '700' }}>{nameOf(id)}</Text>); });
    return ids.length > 1 ? [<Text key={prefix + '('}>(</Text>, ...parts, <Text key={prefix + ')'}>)</Text>] : parts;
  };
  const pieces: ReactNode[] = [];
  const add = (key: string, label: string, ids: readonly string[]) => {
    if (!ids.length) return;
    if (pieces.length) pieces.push(word(key === 'to' && filter.from.length ? (filter.join === 'and' ? m.mailAnd : m.mailOr) : m.mailAnd, 'j' + key));
    pieces.push(<Text key={'l' + key}>{label + ' '}</Text>, ...names(ids, key));
  };
  add('from', m.mailFrom, filter.from);
  add('to', m.mailTo, filter.to);
  add('state', m.mailRuleState, filter.states);
  if (filter.query.trim()) { if (pieces.length) pieces.push(word(m.mailAnd, 'jq')); pieces.push(<Text key="q">{m.mailRuleTitle + ' "'}<Text style={{ fontWeight: '700' }}>{filter.query.trim()}</Text>{'"'}</Text>); }
  return <View testID="mailbox-rule" style={{ flexDirection: 'row', alignItems: 'center', gap: px(6), paddingHorizontal: px(14), paddingVertical: px(6), backgroundColor: onto,
    borderBottomWidth: 1, borderColor: c.border }}>
    <Icon name="ListFilter" size={px(13)} color={c.foregroundMuted} />
    <Text testID="mailbox-rule-text" style={{ flex: 1, color: c.foreground, fontSize: px(12) }}>{pieces}
      <Text style={{ color: readable(c.foregroundMuted, onto) }}>{' ' + (filter.from.length && filter.to.length ? m.mailRuleNote(filter.join === 'and') : m.mailRuleNote(true).split('.')[0])}</Text></Text>
  </View>;
}

// ---- the list ----------------------------------------------------------------------------------------------------------
const COLUMNS = scaled({ state: 150, who: 270, kind: 64, at: 92, due: 128 });
export function GroupHeading({ state, count, hidden, closedOpen, onToggle, person, colors: c, m }: {
  state: MailRow['status']['state']; count: number; hidden: number; closedOpen: boolean; onToggle: () => void; person: string; colors: Palette; m: Copy;
}) {
  const dot = state === 'decision' ? c.statusDotWarning : state === 'stale' ? c.statusDotDanger : state === 'open' ? c.running : c.foregroundMuted;
  const name = state === 'decision' ? m.mailPersonOf(person) : m.mailStateName[state];
  return <View testID={'mailbox-group-' + state} style={{ flexDirection: 'row', alignItems: 'center', gap: px(6), paddingHorizontal: px(6), paddingTop: px(10), paddingBottom: px(6),
    borderBottomWidth: 1, borderColor: c.border }}>
    <View style={{ width: px(7), height: px(7), borderRadius: px(4), backgroundColor: dot }} />
    <Text testID={'mailbox-group-' + state + '-title'} style={{ color: c.foreground, fontSize: px(12), fontWeight: '700' }}>{name + ' ' + count}</Text>
    {state === 'closed' && (hidden > 0 || closedOpen) && <>
      {!closedOpen && <Text style={{ color: c.foregroundMuted, fontSize: px(12) }}>{'— ' + m.mailClosedNote}</Text>}
      <QuietLink testID="mailbox-closed-toggle" label={closedOpen ? m.mailClosedFold : m.mailClosedMore(hidden)}
        description={closedOpen ? m.mailClosedFold : m.mailClosedMore(hidden)} colors={c} onPress={onToggle} /></>}
  </View>;
}
export function ListRow({ row, hits, wide, selected, onPress, person, now, colors: c, m }: {
  row: MailRow; hits: MailHits | undefined; wide: boolean; selected: boolean; onPress: () => void; person: string; now: number; colors: Palette; m: Copy;
}) {
  const hover = useHovered(), s = row.status, fill = selected ? selectedTint(c, c.surface0, hover.hovered) : hover.hovered ? mixColors(c.surface0, c.foreground, .04) : c.surface0;
  const title = <Text testID="mailbox-title" numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: px(13), fontWeight: '600' }}>{row.thread.subject}</Text>;
  const at = <Text testID="mailbox-at" numberOfLines={1} style={{ width: COLUMNS.at, textAlign: 'right', color: readable(c.foregroundMuted, fill), fontSize: px(12) }}>{short(s.at, now)}</Text>;
  return <Pressable testID={'mailbox-row-' + row.thread.id} accessibilityRole="button" accessibilityState={{ selected }}
    accessibilityLabel={stateWords(s, person, m) + ' · ' + row.thread.subject} onPress={onPress} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ backgroundColor: fill, borderBottomWidth: 1, borderColor: c.border, paddingHorizontal: px(6), paddingVertical: wide ? px(7) : px(6),
      ...(selected ? { borderLeftWidth: 3, borderLeftColor: c.accent } : {}) }}>
    {wide ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(10) }}>
      <View style={{ width: COLUMNS.state }}><StatePill status={s} person={person} colors={c} m={m} onto={fill} /></View>
      <View style={{ width: COLUMNS.who }}><Who status={s} hits={hits} colors={c} m={m} onto={fill} /></View>
      {title}
      <View style={{ width: COLUMNS.kind, alignItems: 'center' }}><KindChip kind={s.kind} colors={c} onto={fill} /></View>
      {at}
      <View style={{ width: COLUMNS.due }}><DueText status={s} now={now} colors={c} m={m} onto={fill} /></View>
    </View> : <View style={{ gap: px(4) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
        <StatePill status={s} person={person} colors={c} m={m} onto={fill} />{title}{at}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(6), paddingLeft: px(2) }}>
        <View style={{ flexShrink: 1 }}><Who status={s} hits={hits} colors={c} m={m} onto={fill} /></View>
        <KindChip kind={s.kind} colors={c} onto={fill} />
        <Text numberOfLines={1} style={{ flexShrink: 0, color: readable(c.foregroundMuted, fill), fontSize: px(12) }}>{m.mailFiles(row.thread.files)}</Text>
        {s.due !== null && <DueText status={s} now={now} colors={c} m={m} onto={fill} />}
      </View>
    </View>}
  </Pressable>;
}

// ---- one thread --------------------------------------------------------------------------------------------------------
export function ThreadDetail({ hostId, row, person, now, onClose, colors: c, m, mobile = false }: {
  hostId: string; row: MailRow; person: string; now: number; onClose: () => void; colors: Palette; m: Copy;
  /** REQ-134 MA: on a phone the thread takes the list's place, its way back above it — no edge, no ×. */
  mobile?: boolean;
}) {
  const get = useRpc(mailThreadGet), newest = row.thread.latest[0]?.name ?? '';
  // A thread with a newer file is a new key here (read at once); the server's cache follows the folder's fingerprint.
  const read = useRead<MailThreadDTO>(hostId + ':mail-thread:' + row.thread.id + ':' + newest, () => get({ hostId, thread: row.thread.id }));
  const s = row.status, muted = readable(c.foregroundMuted, c.surface0), data = read.data;
  const turn = s.to.map(t => { const r = mailRecord(t); return r ? r.person + ' ' + m.mailRecordOf(r.keeper) : t; }).join(' · ') || (s.unknown ? m.mailUnknownTo : m.mailNoOne);
  const latest = data?.files.slice(0, data.latest) ?? [], earlier = data?.files.slice(data.latest) ?? [];
  return <View testID="mailbox-detail" style={{ flex: 1, minWidth: 0, borderLeftWidth: mobile ? 0 : 1, borderColor: c.border }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: px(16), gap: px(10) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), flexWrap: 'wrap' }}>
        <StatePill status={s} person={person} colors={c} m={m} onto={c.surface0} />
        <Text testID="mailbox-detail-turn" style={{ flex: 1, color: muted, fontSize: px(12) }}>{m.mailTurn + ': '}<Text style={{ color: c.foreground, fontWeight: '600' }}>{turn}</Text>
          {' · ' + m.mailDue(s.due === null ? null : dayText(s.due), s.dueToday, s.due !== null && s.due < kstDay(now))}</Text>
        {!mobile && <IconButton testID="mailbox-detail-close" name="X" label={m.mailCloseDetail} plain tooltip colors={c} mobile={false} onPress={onClose} />}
      </View>
      <Text testID="mailbox-detail-subject" style={{ color: c.foreground, fontSize: px(16), fontWeight: '700' }}>{row.thread.subject}</Text>
      {!!data?.path && <Text testID="mailbox-detail-path" selectable style={{ color: muted, fontSize: px(12) }}>{m.mailFolder + ' ' + data.path}</Text>}
      {!data && <Text testID={read.error ? 'mailbox-detail-error' : 'mailbox-detail-loading'} style={{ color: read.error ? readable(c.statusDanger, c.surface0) : muted, fontSize: px(12) }}>
        {read.error ? m.mailDetailMissing : m.mailDetailLoading}</Text>}
      {data && data.state !== 'ready' && <Text testID="mailbox-detail-error" style={{ color: readable(c.statusDanger, c.surface0), fontSize: px(12) }}>{m.mailDetailMissing}</Text>}
      {latest.length > 1 && <Text testID="mailbox-detail-tie" style={{ color: readable(c.statusWarning, c.surface0), fontSize: px(12), fontWeight: '600' }}>{m.mailTie(latest.length)}</Text>}
      {latest.map(file => <View key={file.name} testID="mailbox-detail-newest" style={{ gap: px(8) }}>
        <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: px(8), backgroundColor: c.panelHeader, padding: px(12), gap: px(4) }}>
          <View style={{ flexDirection: 'row', gap: px(8) }}>
            <Text numberOfLines={1} style={{ flex: 1, color: readable(c.foregroundMuted, c.panelHeader), fontSize: px(11) }}>{m.mailNewestFile + ' · ' + file.name}</Text>
            <Text style={{ color: readable(c.foregroundMuted, c.panelHeader), fontSize: px(11) }}>{m.mailHead}</Text>
          </View>
          {(file.head ?? []).map((line, i) => <Text key={i} testID="mailbox-detail-head" selectable style={{ color: c.foreground, fontSize: i ? px(12) : px(13), fontWeight: i ? '400' : '700' }}>{line}</Text>)}
        </View>
        {!!file.excerpt?.length && <View style={{ gap: px(4) }}>
          <Text style={{ color: muted, fontSize: px(11) }}>{m.mailExcerpt}</Text>
          <View style={{ borderLeftWidth: 3, borderColor: c.border, paddingLeft: px(10), gap: px(3) }}>
            {file.excerpt.map((line, i) => <Text key={i} testID="mailbox-detail-excerpt" selectable style={{ color: c.foreground, fontSize: px(12) }}>{line}</Text>)}
          </View>
        </View>}
      </View>)}
      {data?.state === 'ready' && <View style={{ gap: px(2), borderTopWidth: 1, borderColor: c.border, paddingTop: px(8) }}>
        <Text testID="mailbox-detail-earlier-title" style={{ color: c.foreground, fontSize: px(12), fontWeight: '700' }}>{m.mailEarlier(earlier.length + data.more)}</Text>
        {earlier.map(file => <View key={file.name} testID="mailbox-detail-earlier" style={{ flexDirection: 'row', alignItems: 'center', gap: px(10), paddingVertical: px(6),
          borderBottomWidth: 1, borderColor: c.border, borderStyle: 'dashed' }}>
          <Text style={{ width: px(84), color: muted, fontSize: px(12) }}>{short(file.at, now)}</Text>
          <View style={{ width: px(52) }}><KindChip kind={file.kind} colors={c} onto={c.surface0} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: c.foreground, fontSize: px(12), fontWeight: '600' }}>{file.title ?? file.name}</Text>
            <Text numberOfLines={1} style={{ color: muted, fontSize: px(11) }}>{(file.from ?? '?') + ' → ' + (file.to ? (mailRecord(file.to)?.person ?? file.to) : m.mailUnknownTo)}</Text>
          </View>
        </View>)}
        {data.more > 0 && <Text style={{ color: muted, fontSize: px(11), paddingTop: px(4) }}>{m.mailEarlierMore(data.more)}</Text>}
      </View>}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(6) }}>
        <Icon name="Lock" size={px(11)} color={muted} />
        <Text testID="mailbox-detail-note" style={{ color: muted, fontSize: px(11) }}>{m.mailReadOnlyNote}</Text>
      </View>
    </ScrollView>
  </View>;
}

// ---- the panel ---------------------------------------------------------------------------------------------------------
/**
 * The panel over the board. `read` is `useMailList`'s; `workspaces` Paseo's listing (each workspace's folder and name), for
 * the dropdowns' choices. The filters and the opened thread live in the session under `scope` (memory only) while the panel is
 * open, so the host's theme-driven remount keeps them (D48); the screen clears them when it closes the panel.
 */
export function MailboxPanel({ hostId, scope, read, workspaces, rule, onClose, colors: c, m }: {
  hostId: string; scope: string; read: { data: MailListDTO | null; error: string; loading: boolean; refresh: () => Promise<void> };
  workspaces: readonly { cwd: string; name: string }[]; rule: MailAliasRule; onClose: () => void; colors: Palette; m: Copy;
}) {
  const now = useMinuteClock(), data = read.data;
  const [filter, setFilter] = useSessionValue<MailFilter>(scope, 'filter', EMPTY_MAIL_FILTER), [closedOpen, setClosedOpen] = useSessionValue(scope, 'closedOpen', false);
  const [selected, setSelected] = useSessionValue<string | null>(scope, 'selected', null);
  const threads: MailListThreadDTO[] = data?.state === 'ready' ? data.threads : [];
  const people = useMemo(() => mailPeople(threads), [threads]), person = people[0] ?? '';
  const rows = useMemo(() => mailRows(threads, now, people), [threads, now, people]);
  const view = useMemo(() => mailGroups(rows, filter, closedOpen), [rows, filter, closedOpen]);
  const fromOptions = useMemo(() => mailOptions(rows, 'from', workspaces, rule), [rows, workspaces, rule]);
  const toOptions = useMemo(() => mailOptions(rows, 'to', workspaces, rule), [rows, workspaces, rule]);
  const decisions = rows.filter(r => r.status.state === 'decision').length;
  const stateOptions: MailOption[] = MAIL_STATE_CHOICES.map(id => ({ id, name: m.mailStateName[id],
    count: rows.filter(r => (r.status.state === 'decision' ? (r.status.stale ? 'stale' : 'open') : r.status.state) === id).length }));
  const nameOf = (id: string) => id === MAIL_PERSON ? m.mailPersonOf(person) : (m.mailStateName as Record<string, string>)[id] ?? id;
  const patch = (next: Partial<MailFilter>) => setFilter(f => ({ ...f, ...next }));
  const count = mailFilterCount(filter), row = selected ? rows.find(r => r.thread.id === selected) ?? null : null;
  const muted = readable(c.foregroundMuted, c.panelHeader);
  const meta = data ? [data.root ?? '', m.mailThreads(threads.length), data.readAt ? m.mailReadAt(localStamp(data.readAt, now)) : ''].filter(Boolean).join(' · ') : '';
  const body = !data ? <Text testID={read.error ? 'mailbox-error' : 'mailbox-loading'} style={{ padding: px(16), color: read.error ? readable(c.statusDanger, c.surface0) : c.foregroundMuted, fontSize: px(12) }}>
      {read.error ? m.labsMailUnreadable + ' ' + read.error : m.mailLoading}</Text>
    : data.state === 'off' ? <Text testID="mailbox-off" style={{ padding: px(16), color: c.foregroundMuted, fontSize: px(12) }}>{m.mailOff}</Text>
    : data.state === 'unreadable' ? <Text testID="mailbox-error" style={{ padding: px(16), color: readable(c.statusDanger, c.surface0), fontSize: px(12) }}>{m.labsMailUnreadable}</Text>
    : !threads.length ? <Text testID="mailbox-empty" style={{ padding: px(16), color: c.foregroundMuted, fontSize: px(12) }}>{m.mailEmpty}</Text>
    : <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
      <View testID="mailbox-list" style={row ? { width: '44%', flexShrink: 0 } : { flex: 1, minWidth: 0 }}>
        {!row && <View testID="mailbox-columns" style={{ flexDirection: 'row', alignItems: 'center', gap: px(10), paddingHorizontal: px(20), paddingVertical: px(6),
          borderBottomWidth: 1, borderColor: c.border }}>
          {[['state', m.mailColState], ['who', m.mailColWho]].map(([k, t]) => <Text key={k} style={{ width: COLUMNS[k as 'state' | 'who'], color: c.foregroundMuted, fontSize: px(11) }}>{t}</Text>)}
          <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: px(11) }}>{m.mailColTitle}</Text>
          <Text style={{ width: COLUMNS.kind, textAlign: 'center', color: c.foregroundMuted, fontSize: px(11) }}>{m.mailColKind}</Text>
          <Text style={{ width: COLUMNS.at, textAlign: 'right', color: c.foregroundMuted, fontSize: px(11) }}>{m.mailColAt}</Text>
          <Text style={{ width: COLUMNS.due, textAlign: 'right', color: c.foregroundMuted, fontSize: px(11) }}>{m.mailColDue}</Text>
        </View>}
        <ScrollView testID="mailbox-scroll" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: px(14), paddingBottom: px(14) }}>
          {!view.shown && <Text testID="mailbox-no-match" style={{ padding: px(12), color: c.foregroundMuted, fontSize: px(12) }}>{m.mailNoMatch}</Text>}
          {view.groups.map(group => <View key={group.state}>
            <GroupHeading state={group.state} count={group.rows.length + group.hidden} hidden={group.hidden} closedOpen={closedOpen}
              onToggle={() => setClosedOpen(v => !v)} person={person} colors={c} m={m} />
            {group.rows.map(r => <ListRow key={r.thread.id} row={r} hits={view.hits.get(r.thread.id)} wide={!row} selected={r.thread.id === selected}
              onPress={() => setSelected(r.thread.id === selected ? null : r.thread.id)} person={person} now={now} colors={c} m={m} />)}
          </View>)}
        </ScrollView>
      </View>
      {row && <ThreadDetail key={row.thread.id} hostId={hostId} row={row} person={person} now={now} onClose={() => setSelected(null)} colors={c} m={m} />}
    </View>;
  return <View testID="mailbox-panel" accessibilityRole="none" style={{ flex: 1, minHeight: 0, borderRadius: px(10), borderWidth: 1, borderColor: c.border,
    backgroundColor: c.surface0, overflow: 'hidden' }}>
    <View testID="mailbox-heading" style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), paddingHorizontal: px(14), paddingVertical: px(8),
      backgroundColor: c.panelHeader, borderBottomWidth: 1, borderColor: c.border }}>
      <Icon name="Mail" size={px(16)} color={c.foreground} />
      <Text style={{ color: c.foreground, fontSize: px(15), fontWeight: '700' }}>{m.mailbox}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(3), height: px(18), paddingHorizontal: px(6), borderRadius: px(9), backgroundColor: c.surface2 }}>
        <Icon name="Lock" size={px(10)} color={readable(c.foregroundMuted, c.surface2)} />
        <Text testID="mailbox-readonly" style={{ color: readable(c.foregroundMuted, c.surface2), fontSize: px(11) }}>{m.mailReadOnly}</Text>
      </View>
      <Text testID="mailbox-meta" numberOfLines={1} style={{ flexShrink: 1, color: muted, fontSize: px(12) }}>{meta}</Text>
      {!!data?.limits.length && <Text testID="mailbox-limits" style={{ color: readable(c.statusWarning, c.panelHeader), fontSize: px(12) }}>{m.mailLimits}</Text>}
      <View style={{ flex: 1 }} />
      <IconButton testID="mailbox-close" name="X" label={m.mailboxClose} plain tooltip colors={c} mobile={false} onPress={onClose} />
    </View>
    {/* research/236 D4: one line, never wrapped — the dropdowns and the search give way, the count and "Clear all" keep their width. */}
    {data?.state === 'ready' && threads.length > 0 && <View testID="mailbox-filters" style={{ flexDirection: 'row', alignItems: 'center', gap: px(8),
      paddingHorizontal: px(14), paddingVertical: px(8), borderBottomWidth: 1, borderColor: c.border }}>
      <MailPicker testID="mailbox-from" name={m.mailFrom} options={fromOptions} chosen={filter.from} onChange={from => patch({ from })}
        caption={m.mailOptionsCaption} countCaption={m.mailOptionsCount('from')} find={m.mailFindWorkspace(fromOptions.length)} colors={c} m={m} nameOf={nameOf} />
      <JoinPill join={filter.join} onChange={join => patch({ join })} colors={c} m={m} />
      <MailPicker testID="mailbox-to" name={m.mailTo} options={toOptions} chosen={filter.to} onChange={to => patch({ to })}
        pinned={{ id: MAIL_PERSON, label: m.mailPersonOf(person), note: m.mailPersonNote, count: decisions }}
        caption={m.mailOptionsCaption} countCaption={m.mailOptionsCount('to')} find={m.mailFindWorkspace(toOptions.length)} colors={c} m={m} nameOf={nameOf} />
      <MailPicker testID="mailbox-state-filter" name={m.mailState} options={stateOptions} chosen={filter.states}
        onChange={states => patch({ states: states as MailStateChoice[] })} caption={m.mailStatesCaption} countCaption="" find={null} colors={c} m={m} nameOf={nameOf} />
      <View style={{ width: px(1), height: px(20), flexShrink: 0, backgroundColor: c.border }} />
      <MailSearch value={filter.query} onChange={query => patch({ query })} colors={c} m={m} />
      <View style={{ flex: 1 }} />
      <Text testID="mailbox-shown" numberOfLines={1} style={{ flexShrink: 0, color: c.foregroundMuted, fontSize: px(12) }}><Text style={{ color: c.foreground, fontWeight: '700' }}>{view.shown}</Text>
        {m.mailShown(view.shown, threads.length).slice(String(view.shown).length)}</Text>
      <QuietLink testID="mailbox-clear" label={m.mailClearAll} description={m.mailClearAll} colors={c} disabled={!count} onPress={() => setFilter(EMPTY_MAIL_FILTER)} />
    </View>}
    {count > 0 && data?.state === 'ready' && <RuleLine filter={filter} nameOf={nameOf} colors={c} m={m} />}
    {body}
  </View>;
}
function MailSearch({ value, onChange, colors: c, m }: { value: string; onChange: (next: string) => void; colors: Palette; m: Copy }) {
  const [focused, setFocused] = useState(false);
  return <View style={{ width: px(240), flexShrink: 1, minWidth: px(140), flexDirection: 'row', alignItems: 'center' }}>
    <TextInput testID="mailbox-search" accessibilityLabel={m.mailSearch} placeholder={m.mailSearch} placeholderTextColor={c.foregroundMuted} value={value}
      onChangeText={onChange} autoCorrect={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{ flex: 1, height: px(30), borderRadius: px(6), borderWidth: 1, borderColor: focused ? c.accent : c.border, ...noOutline, backgroundColor: c.surface1,
        color: c.foreground, paddingLeft: px(30), paddingRight: value ? px(28) : px(8), fontSize: px(13) }} />
    <View pointerEvents="none" style={{ position: 'absolute', left: px(8), top: px(8) }}><Icon name="Search" size={px(14)} color={c.foregroundMuted} /></View>
    {!!value && <Pressable testID="mailbox-search-clear" accessibilityRole="button" accessibilityLabel={m.clearSearch} onPress={() => onChange('')}
      style={{ position: 'absolute', right: px(4), width: px(22), height: px(22), alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="X" size={px(12)} color={c.foregroundMuted} /></Pressable>}
  </View>;
}
