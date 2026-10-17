import { useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView, TextInput } from '@getpaseo/plugin/client/react-native';
import type { MailAliasRule } from '../shared/rpc.js';
import { mailPeople, type MailListDTO, type MailListThreadDTO } from '../shared/mail-list.js';
import { EMPTY_MAIL_FILTER, MAIL_PERSON, MAIL_STATE_CHOICES, mailFilterCount, mailGroups, mailOptions, mailRows, pickerLabel,
  searchOptions, toggleChoice, type MailFilter, type MailOption, type MailStateChoice } from './mail-list-model.js';
import { GroupHeading, JoinPill, ListRow, OptionRow, RuleLine, ThreadDetail } from './mailbox.js';
import { useSessionValue } from './session.js';
import { QuietLink } from './components.js';
import { KanbanSheet } from './kanban-sheet.js';
import { useMinuteClock } from './minute-clock.js';
import { localStamp } from './move-reason.js';
import { countBadge, readable, type Palette } from './palette.js';
import type { HostPlatform } from './layout.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';

/*
 * REQ-134 MA (research/267, the owner's choice): the lab's message list on a 390px phone. The top bar's envelope (the same
 * count as the wide glyph: a person's decisions + left waiting) opens it over the whole screen: the wide list's two-line rows in
 * its groups, a button per filter (From · To · State), each choosing in a sheet from the bottom (the wide dropdown's find
 * field, pinned person, counts and "or" pill), the title search, and a thread in place of the list — "Back to the list" and
 * the back button return to it, × closes all. The same reading as the wide panel (`useMailList`, `mail-list-model.ts`, the
 * server's own folder boundary); nothing is written. Filters and the thread live in the session under `scope` while it is
 * open (as the wide panel, D48); closing forgets them. A lane's mail badge opens it filtered to that workspace (`initial`).
 */
// RN Web accepts outlineStyle 'none'; the RN types omit it (as filter-bar.tsx).
const noOutline = { outlineStyle: 'none', outlineWidth: 0 } as object;
type Side = 'from' | 'to' | 'state';

export function MobileMailboxSheet({ hostId, scope, open, read, workspaces, rule, onClose, colors: c, m, platform }: {
  hostId: string; scope: string; open: boolean; read: { data: MailListDTO | null; error: string; loading: boolean };
  workspaces: readonly { cwd: string; name: string }[]; rule: MailAliasRule; onClose: () => void; colors: Palette; m: Copy; platform: HostPlatform;
}) {
  // The list (and its thread) is drawn only while open, so it reads the session afresh each time; the back button asks it.
  const screen = useWindowDimensions(), back = useRef<() => boolean>(() => false);
  const lock = <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(3), height: px(22), paddingHorizontal: px(8), marginRight: px(4), borderRadius: px(11), backgroundColor: c.surface2 }}>
    <Icon name="Lock" size={px(11)} color={readable(c.foregroundMuted, c.surface2)} />
    <Text testID="mailbox-readonly" style={{ color: readable(c.foregroundMuted, c.surface2), fontSize: px(11) }}>{m.mailReadOnly}</Text>
  </View>;
  return <KanbanSheet testID="mailbox-sheet" closeTestID="mailbox-close" title={m.mailbox} open={open} onClose={onClose} colors={c} platform={platform}
    closeLabel={m.mailboxClose} centered={false} height={screen.height} scroll={false} headerExtra={lock}
    onBack={() => back.current()}>
    {open && <PhoneMailbox hostId={hostId} scope={scope} read={read} workspaces={workspaces} rule={rule} backRef={back} colors={c} m={m} platform={platform} />}
  </KanbanSheet>;
}

function PhoneMailbox({ hostId, scope, read, workspaces, rule, backRef, colors: c, m, platform }: {
  hostId: string; scope: string; read: { data: MailListDTO | null; error: string; loading: boolean }; workspaces: readonly { cwd: string; name: string }[];
  rule: MailAliasRule; backRef: MutableRefObject<() => boolean>; colors: Palette; m: Copy; platform: HostPlatform;
}) {
  const now = useMinuteClock(), data = read.data;
  const [selected, onSelect] = useSessionValue<string | null>(scope, 'selected', null);
  backRef.current = () => { if (!selected) return false; onSelect(null); return true; };
  const [filter, setFilter] = useSessionValue<MailFilter>(scope, 'filter', EMPTY_MAIL_FILTER), [closedOpen, setClosedOpen] = useSessionValue(scope, 'closedOpen', false);
  const [picker, setPicker] = useState<Side | null>(null), [focused, setFocused] = useState(false);
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
  const muted = readable(c.foregroundMuted, c.surface0);
  const meta = data ? [data.root ?? '', data.readAt ? m.mailReadAt(localStamp(data.readAt, now)) : ''].filter(Boolean).join(' · ') : '';
  if (row) return <View testID="mailbox-thread-view" style={{ flex: 1, minHeight: 0 }}>
    <Pressable testID="mailbox-back" accessibilityRole="button" accessibilityLabel={m.mailBack} onPress={() => onSelect(null)}
      style={{ minHeight: px(44), flexDirection: 'row', alignItems: 'center', gap: px(4), paddingHorizontal: px(10), borderBottomWidth: 1, borderColor: c.border }}>
      <Icon name="ChevronLeft" size={px(18)} color={c.foreground} />
      <Text style={{ color: c.foreground, fontSize: px(14), fontWeight: '600' }}>{m.mailBack}</Text>
    </Pressable>
    <ThreadDetail key={row.thread.id} hostId={hostId} row={row} person={person} now={now} onClose={() => onSelect(null)} colors={c} m={m} mobile />
  </View>;
  const sides: { id: Side; name: string; chosen: string[] }[] = [{ id: 'from', name: m.mailFrom, chosen: filter.from },
    { id: 'to', name: m.mailTo, chosen: filter.to }, { id: 'state', name: m.mailState, chosen: filter.states }];
  const ready = data?.state === 'ready' && threads.length > 0;
  return <View testID="mailbox-panel" style={{ flex: 1, minHeight: 0 }}>
    {!!meta && <Text testID="mailbox-meta" numberOfLines={1} style={{ paddingHorizontal: px(16), paddingTop: px(8), color: muted, fontSize: px(12) }}>{meta}</Text>}
    {!!data?.limits.length && <Text testID="mailbox-limits" style={{ paddingHorizontal: px(16), color: readable(c.statusWarning, c.surface0), fontSize: px(12) }}>{m.mailLimits}</Text>}
    {ready && <View testID="mailbox-filters" style={{ paddingHorizontal: px(12), paddingTop: px(8), gap: px(8) }}>
      <View style={{ flexDirection: 'row', gap: px(8) }}>
        {sides.map(side => <FilterButton key={side.id} testID={'mailbox-' + (side.id === 'state' ? 'state-filter' : side.id)} name={side.name} chosen={side.chosen}
          nameOf={nameOf} onPress={() => setPicker(side.id)} colors={c} />)}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TextInput testID="mailbox-search" accessibilityLabel={m.mailSearch} placeholder={m.mailSearch} placeholderTextColor={c.foregroundMuted} value={filter.query}
          onChangeText={query => patch({ query })} autoCorrect={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          style={{ flex: 1, height: px(44), borderRadius: px(8), borderWidth: 1, borderColor: focused ? c.accent : c.border, ...noOutline, backgroundColor: c.surface1,
            color: c.foreground, paddingLeft: px(36), paddingRight: filter.query ? px(40) : px(10), fontSize: px(15) }} />
        <View pointerEvents="none" style={{ position: 'absolute', left: px(12), top: px(14) }}><Icon name="Search" size={px(16)} color={c.foregroundMuted} /></View>
        {!!filter.query && <Pressable testID="mailbox-search-clear" accessibilityRole="button" accessibilityLabel={m.clearSearch} onPress={() => patch({ query: '' })}
          style={{ position: 'absolute', right: 0, width: px(44), height: px(44), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="X" size={px(14)} color={c.foregroundMuted} /></Pressable>}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text testID="mailbox-shown" numberOfLines={1} style={{ flex: 1, color: muted, fontSize: px(13) }}><Text style={{ color: c.foreground, fontWeight: '700' }}>{view.shown}</Text>
          {m.mailShown(view.shown, threads.length).slice(String(view.shown).length)}</Text>
        <QuietLink testID="mailbox-clear" mobile label={m.mailClearAll} description={m.mailClearAll} colors={c} disabled={!count} onPress={() => setFilter(EMPTY_MAIL_FILTER)} />
      </View>
    </View>}
    {count > 0 && ready && <RuleLine filter={filter} nameOf={nameOf} colors={c} m={m} />}
    {!data ? <Text testID={read.error ? 'mailbox-error' : 'mailbox-loading'} style={{ padding: px(16), color: read.error ? readable(c.statusDanger, c.surface0) : muted, fontSize: px(13) }}>
        {read.error ? m.labsMailUnreadable + ' ' + read.error : m.mailLoading}</Text>
      : data.state === 'off' ? <Text testID="mailbox-off" style={{ padding: px(16), color: muted, fontSize: px(13) }}>{m.mailOff}</Text>
      : data.state === 'unreadable' ? <Text testID="mailbox-error" style={{ padding: px(16), color: readable(c.statusDanger, c.surface0), fontSize: px(13) }}>{m.labsMailUnreadable}</Text>
      : !threads.length ? <Text testID="mailbox-empty" style={{ padding: px(16), color: muted, fontSize: px(13) }}>{m.mailEmpty}</Text>
      : <ScrollView testID="mailbox-scroll" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: px(12), paddingBottom: px(16) }}>
        {!view.shown && <Text testID="mailbox-no-match" style={{ padding: px(12), color: muted, fontSize: px(13) }}>{m.mailNoMatch}</Text>}
        {view.groups.map(group => <View key={group.state}>
          <GroupHeading state={group.state} count={group.rows.length + group.hidden} hidden={group.hidden} closedOpen={closedOpen}
            onToggle={() => setClosedOpen(v => !v)} person={person} colors={c} m={m} />
          {group.rows.map(r => <ListRow key={r.thread.id} row={r} hits={view.hits.get(r.thread.id)} wide={false} selected={false}
            onPress={() => onSelect(r.thread.id)} person={person} now={now} colors={c} m={m} />)}
        </View>)}
      </ScrollView>}
    <PickerSheet side={picker} onClose={() => setPicker(null)} filter={filter} patch={patch} shown={view.shown} person={person} decisions={decisions}
      options={picker === 'from' ? fromOptions : picker === 'to' ? toOptions : stateOptions} colors={c} m={m} platform={platform} />
  </View>;
}

/** A filter's button: its name (with one choice, the choice), a count with more, filled while any is chosen. */
function FilterButton({ testID, name, chosen, nameOf, onPress, colors: c }: {
  testID: string; name: string; chosen: readonly string[]; nameOf: (id: string) => string; onPress: () => void; colors: Palette;
}) {
  const label = pickerLabel(name, chosen, nameOf), active = chosen.length > 0, fill = active ? c.surface2 : 'transparent';
  const countLook = countBadge(c, active ? c.surface2 : c.surface0);
  return <Pressable testID={testID + '-trigger'} accessibilityRole="button" accessibilityLabel={name + (chosen.length ? ': ' + chosen.map(nameOf).join(', ') : '')}
    onPress={onPress} style={{ flex: 1, minWidth: 0, height: px(44), borderRadius: px(8), borderWidth: 1, borderColor: active ? c.accent : c.border, backgroundColor: fill,
      flexDirection: 'row', alignItems: 'center', gap: px(4), paddingLeft: px(10), paddingRight: px(8) }}>
    <Text testID={testID + '-label'} numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: px(14), fontWeight: active ? '600' : '400' }}>{label.text}</Text>
    {label.count > 1 && <View testID={testID + '-count'} style={{ minWidth: px(18), height: px(18), paddingHorizontal: px(4), borderRadius: px(9), borderWidth: 1,
      borderColor: countLook.line, backgroundColor: countLook.fill, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: countLook.text, fontSize: px(11), fontWeight: '700' }}>{label.count}</Text></View>}
    <Icon name="ChevronDown" size={px(16)} color={c.foregroundMuted} />
  </Pressable>;
}

/**
 * One filter's choices in a sheet from the bottom: the find field (workspaces), the person pinned first in To, the choices
 * with their counts (none faded), the "and/or" pill while both From and To hold choices, then "Clear all" and "Show N threads".
 */
function PickerSheet({ side, onClose, filter, patch, shown, person, decisions, options, colors: c, m, platform }: {
  side: Side | null; onClose: () => void; filter: MailFilter; patch: (next: Partial<MailFilter>) => void; shown: number; person: string; decisions: number;
  options: readonly MailOption[]; colors: Palette; m: Copy; platform: HostPlatform;
}) {
  const [query, setQuery] = useState('');
  const close = () => { setQuery(''); onClose(); };
  const name = side === 'from' ? m.mailFrom : side === 'to' ? m.mailTo : m.mailState;
  const chosen: string[] = side === 'from' ? filter.from : side === 'to' ? filter.to : filter.states;
  const set = (next: string[]) => patch(side === 'from' ? { from: next } : side === 'to' ? { to: next } : { states: next as MailStateChoice[] });
  const flip = (id: string) => set(toggleChoice(chosen, id));
  const id = 'mailbox-' + (side === 'state' ? 'state-filter' : side ?? 'from'), listed = side === 'state' ? [...options] : searchOptions(options, query);
  const primary = readable(c.surface0, c.accent);
  return <KanbanSheet testID="mailbox-picker-sheet" closeTestID="mailbox-picker-close" title={name} open={side !== null} onClose={close} colors={c} platform={platform}
    closeLabel={m.close} centered={false}>
    {side !== null && <View testID={id + '-menu'} style={{ gap: px(6) }}>
      {side !== 'state' && <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TextInput testID={id + '-search'} accessibilityLabel={m.mailFindWorkspace(options.length)} placeholder={m.mailFindWorkspace(options.length)}
          placeholderTextColor={c.foregroundMuted} value={query} onChangeText={setQuery} autoCorrect={false}
          style={{ flex: 1, height: px(44), borderRadius: px(8), borderWidth: 1, borderColor: c.border, ...noOutline, backgroundColor: c.surface1,
            color: c.foreground, paddingLeft: px(36), paddingRight: px(10), fontSize: px(15) }} />
        <View pointerEvents="none" style={{ position: 'absolute', left: px(12), top: px(14) }}><Icon name="Search" size={px(16)} color={c.foregroundMuted} /></View>
      </View>}
      {side === 'to' && <OptionRow testID={id + '-option-' + MAIL_PERSON} label={m.mailPersonOf(person)} note={m.mailPersonNote} count={decisions} strong tall
        chosen={chosen.includes(MAIL_PERSON)} onPress={() => flip(MAIL_PERSON)} colors={c} />}
      <View style={{ flexDirection: 'row', paddingHorizontal: px(8), paddingTop: px(4) }}>
        <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: px(12) }}>{side === 'state' ? m.mailStatesCaption : m.mailOptionsCaption + ' · ' + m.mailPickerHint}</Text>
        {side !== 'state' && <Text style={{ color: c.foregroundMuted, fontSize: px(12) }}>{m.mailOptionsCount(side)}</Text>}
      </View>
      <View testID={id + '-options'}>
        {listed.map(o => <OptionRow key={o.id} testID={id + '-option-' + o.id} label={o.name} note={o.note} count={o.count} tall
          chosen={chosen.includes(o.id)} onPress={() => flip(o.id)} colors={c} />)}
      </View>
      {side !== 'state' && filter.from.length > 0 && filter.to.length > 0 && <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), minHeight: px(44) }}>
        <JoinPill join={filter.join} onChange={join => patch({ join })} colors={c} m={m} />
        <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: px(12) }}>{m.mailRuleNote(filter.join === 'and')}</Text>
      </View>}
      <View style={{ flexDirection: 'row', gap: px(10), paddingTop: px(6) }}>
        <Pressable testID={id + '-none'} accessibilityRole="button" accessibilityLabel={m.mailClearPicker(name)} accessibilityState={{ disabled: !chosen.length }}
          disabled={!chosen.length} onPress={() => set([])} style={{ flex: 1, height: px(44), borderRadius: px(8), borderWidth: 1, borderColor: c.border,
            alignItems: 'center', justifyContent: 'center', opacity: chosen.length ? 1 : .5 }}>
          <Text style={{ color: c.foreground, fontSize: px(14) }}>{m.mailClearAll}</Text>
        </Pressable>
        <Pressable testID={id + '-apply'} accessibilityRole="button" accessibilityLabel={m.mailShowThreads(shown)} onPress={close}
          style={{ flex: 2, height: px(44), borderRadius: px(8), backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: primary, fontSize: px(15), fontWeight: '700' }}>{m.mailShowThreads(shown)}</Text>
        </Pressable>
      </View>
    </View>}
  </KanbanSheet>;
}
