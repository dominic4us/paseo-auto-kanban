import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { archivedList, archivedRestore, archiveSettingsSet, archiveTidy, type ArchivedCard, type AutoArchiveDTO } from '../shared/rpc.js';
import { ARCHIVE_DAY_CHOICES } from '../shared/archive.js';
import { readable, type Palette } from './palette.js';
import type { Copy } from './i18n.js';
import type { HostPlatform } from './layout.js';
import { Button, Notice, QuietLink } from './components.js';
import { KanbanSheet } from './kanban-sheet.js';
import { useConfirmedValue } from './confirmed-value.js';
import { archivedLine, shownArchive } from './archive-model.js';
import { px } from './ui-scale.js';

/**
 * REQ-52 (research/294): tidying finished cards on the screens.
 * - The done column's head says the finished cards archived beside the ones still there ("Done 12 · Archived 48"); the
 *   number opens the archived list. "Tidy" archives every card now in Done after one confirming line.
 * - A workspace's ⋯ offers "Archived cards": the list, latest first, each with "Restore".
 * - The settings window's Automation category sets the automatic archive's days for the whole plugin (`useAutoArchive`).
 * The cards are archived by the server (server/auto-archive.ts); the screens read the counts from `summary.progress`.
 */

export { archivedDoneOf, archivedLine } from './archive-model.js';

export type AutoArchiveSwitch = { days: number; damaged: boolean; set: (days: number) => Promise<boolean> };
/** The automatic archive's days as the server read them, until a write it confirmed; the demo never saves. */
export function useAutoArchive(scope: string, remote: AutoArchiveDTO | undefined, persist: boolean,
  readToken: unknown = remote): AutoArchiveSwitch {
  const save = useRpc(archiveSettingsSet), confirmed = useConfirmedValue(scope, remote, readToken, 'autoArchiveChoice');
  const set = async (days: number) => {
    if (!persist) return false;
    const ticket = confirmed.begin(); if (!ticket) return false;
    try {
      const reply = await save({ days });
      if (!reply?.ok) return false;
      confirmed.confirm(ticket, { days: reply.data.days }); return true;
    } catch { return false; }
  };
  return { ...shownArchive(confirmed.value, null), set };
}

/** The settings row's choices: Off, 3, 7, 14, 30 days (a value saved elsewhere shows as one more choice). */
export function AutoArchiveChoice({ value, damaged, onChange, disabled, colors: c, m }: {
  value: number; damaged: boolean; onChange: (days: number) => void; disabled: boolean; colors: Palette; m: Copy;
}) {
  const choices: number[] = [...ARCHIVE_DAY_CHOICES];
  if (!damaged && !choices.includes(value)) choices.push(value);
  return <View accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.autoArchive} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(8) }}>
    {choices.map(days => {
      const selected = !damaged && days === value, label = days ? m.autoArchiveDays(days) : m.autoArchiveOff;
      return <Pressable key={days} testID={'auto-archive-' + days} accessibilityRole="radio" accessibilityLabel={label}
        accessibilityState={{ checked: selected, disabled }} role="radio" aria-checked={selected} aria-disabled={disabled} disabled={disabled}
        onPress={() => onChange(days)}
        style={{ minHeight: px(30), justifyContent: 'center', paddingHorizontal: px(10), borderRadius: px(6), borderWidth: 1, opacity: disabled && !selected ? .5 : 1,
          borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.surface2 : 'transparent' }}>
        <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: px(12), fontWeight: selected ? '600' : '400' }}>{label}</Text>
      </Pressable>;
    })}
  </View>;
}

/**
 * The done column head's right end: "Archived N" (opens the list) and "Tidy" (asks first). Either is left out when there is
 * nothing to show or to tidy; the demo shows the number but cannot tidy.
 */
export function DoneHeadTools({ archived, live, name, onShow, onTidy, disabled = false, colors, m, mobile = false, onHead = false }: {
  archived: number; live: number; name: string; onShow: () => void; onTidy: () => void; disabled?: boolean; colors: Palette; m: Copy; mobile?: boolean;
  /** In a column's head (its own background), not on the column's panel: the words are held to 4.5:1 there. */
  onHead?: boolean;
}) {
  if (!archived && !live) return null;
  const c = onHead ? { ...colors, panel: colors.panelHeader } : colors;
  return <View testID="done-head-tools" style={{ flexDirection: 'row', alignItems: 'center', gap: mobile ? px(4) : px(2), flexShrink: 0 }}>
    {archived > 0 && <QuietLink testID="done-archived-count" label={m.archivedCount(archived)} description={m.archivedCountLabel(archived, name)}
      colors={c} mobile={mobile} disabled={disabled} onPress={onShow} />}
    {live > 0 && <QuietLink testID="done-tidy" label={m.tidy} description={m.tidyLabel(name)} colors={c} mobile={mobile} disabled={disabled} onPress={onTidy} />}
  </View>;
}

/**
 * "Tidy"'s one confirming line at the top of the done column (or the phone's Done list): how many go, that they stay in the
 * progress and can come back; then what happened. Nothing is written before "Archive".
 */
export function TidyConfirm({ boardId, count, onClose, onDone, colors: c, m, mobile = false }: {
  boardId: string; count: number; onClose: () => void; onDone: (archived: number) => void; colors: Palette; m: Copy; mobile?: boolean;
}) {
  const run = useRpc(archiveTidy), [state, setState] = useState<'ask' | 'busy' | 'failed'>('ask');
  const go = async () => {
    setState('busy');
    try { const reply = await run({ boardId }); if (reply?.ok) { onDone(reply.data.archived); return; } } catch { /* said below */ }
    setState('failed');
  };
  return <View testID="tidy-confirm" accessibilityRole="alert" style={{ gap: px(6), padding: px(8), borderRadius: px(6), borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <Text testID="tidy-confirm-text" style={{ color: c.foreground, fontSize: px(12), lineHeight: px(17) }}>{m.tidyConfirm(count)}</Text>
    {state === 'failed' && <Notice testID="tidy-failed" text={m.tidyFailed} colors={{ ...c, statusDanger: readable(c.statusDanger, c.surface1) }} error />}
    <View style={{ flexDirection: 'row', gap: px(8) }}>
      <Button testID="tidy-go" label={m.tidyGo} colors={c} mobile={mobile} selected disabled={state === 'busy'} onPress={() => { void go(); }} />
      <Button testID="tidy-cancel" label={m.cancel} colors={c} mobile={mobile} disabled={state === 'busy'} onPress={onClose} />
    </View>
  </View>;
}
/** What "Tidy" did, under the done column's head until closed. */
export function TidyNote({ text, onClose, colors: c, m, mobile = false }: { text: string; onClose: () => void; colors: Palette; m: Copy; mobile?: boolean }) {
  return <View testID="tidy-note" style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: px(6) }}>
    <Text testID="tidy-note-text" style={{ flexShrink: 1, color: readable(c.foregroundMuted, c.panel), fontSize: px(12) }}>{text}</Text>
    <QuietLink testID="tidy-note-close" label={m.close} description={m.close} colors={c} mobile={mobile} onPress={onClose} />
  </View>;
}


/** The archived list of one workspace's board, in a Kanban sheet; "Restore" brings a card back to where it was. */
export function ArchivedSheet({ open, boardId, name, stages, onClose, onChanged, colors: c, m, platform, mobile = platform !== 'web', now = Date.now }: {
  open: boolean; boardId: string; name: string; stages: readonly { stageId: string; name: string }[]; onClose: () => void;
  onChanged: () => void; colors: Palette; m: Copy; platform: HostPlatform;
  /** A phone's screen (a narrow web window too): finger-sized "Restore". */
  mobile?: boolean; now?: () => number;
}) {
  const list = useRpc(archivedList), restore = useRpc(archivedRestore);
  const calls = useRef({ list, restore }); calls.current = { list, restore };
  const [data, setData] = useState<{ cards: ArchivedCard[]; total: number } | null>(null), [error, setError] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null), [busy, setBusy] = useState<string | null>(null);
  const read = async () => {
    setError(false);
    try { const reply = await calls.current.list({ boardId }); if (reply?.ok) { setData(reply.data); return; } } catch { /* below */ }
    setError(true);
  };
  useEffect(() => { if (open) { setData(null); setNote(null); void read(); } }, [open, boardId]);
  const back = async (card: ArchivedCard) => {
    setBusy(card.id); setNote(null);
    try {
      const reply = await calls.current.restore({ boardId, cardId: card.id });
      if (reply?.ok) { setNote({ text: m.restored(card.title) }); onChanged(); await read(); return; }
    } catch { /* below */ } finally { setBusy(null); }
    setNote({ text: m.restoreFailed, error: true });
  };
  const stageName = (id: string) => stages.find(s => s.stageId === id)?.name ?? id;
  const muted = readable(c.foregroundMuted, c.surface0);
  return <KanbanSheet testID="archived-sheet" title={m.archivedTitle(name)} open={open} onClose={onClose} colors={c} platform={platform}
    closeLabel={m.close} width={px(560)}
    notice={note ? <View style={{ paddingHorizontal: px(16), paddingBottom: px(4) }}><Notice testID="archived-note" text={note.text} colors={c} error={!!note.error} /></View> : undefined}>
    <View testID="archived-list" style={{ gap: 0 }}>
      {!data && !error && <Notice testID="archived-loading" text={m.archivedLoading} colors={c} />}
      {error && <Notice testID="archived-failed" text={m.archivedFailed} colors={c} error />}
      {data && !data.cards.length && <Notice testID="archived-empty" text={m.archivedEmpty} colors={c} />}
      {data?.cards.map((card, index) => <View key={card.id} testID={'archived-row-' + index}
        style={{ flexDirection: 'row', alignItems: 'center', gap: px(10), paddingVertical: px(8), borderTopWidth: index ? 1 : 0, borderColor: c.divider }}>
        <View style={{ flex: 1, minWidth: 0, gap: px(2) }}>
          <Text testID="archived-title" style={{ color: c.foreground, fontSize: px(13), fontWeight: '600' }}>{card.title}</Text>
          <Text testID="archived-meta" style={{ color: card.done ? muted : readable(c.statusWarning, c.surface0), fontSize: px(12) }}>
            {archivedLine(card, stageName(card.stageId), m, now())}</Text>
        </View>
        <View accessibilityLabel={m.restoreLabel(card.title)}>
          <Button testID="archived-restore" label={m.restore} colors={c} mobile={mobile} disabled={busy !== null} onPress={() => { void back(card); }} />
        </View>
      </View>)}
      {data && data.total > data.cards.length && <Notice testID="archived-more" text={m.archivedMore(data.cards.length, data.total)} colors={c} />}
    </View>
  </KanbanSheet>;
}
