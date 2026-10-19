import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { archivedRestore, boardMutate } from '../shared/rpc.js';
import type { SignalSource } from './agent-signals.js';
import { assigneeName } from './card-meta.js';
import { addSkip, CHECKUP_BATCH, CHECKUP_LIMITS, checkupCandidates, checkupGroups, checkupKey, checkupLine, checkupPlan, operationsOf, readSkips,
  checkupResult, homeOperations, selectionCounts, withoutSkipped, type CheckupAction, type CheckupBoard, type CheckupCandidate, type CheckupPlanBoard,
  type CheckupSignals, type CheckupSkips, type CheckupTally } from './checkup-model.js';
import { newRequestId } from './editor-state.js';
import { mutationAllowed } from './demo.js';
import { usePreview } from './preview-context.js';
import { useSessionValue } from './session.js';
import { useMinuteKey } from './minute-clock.js';
import { KanbanSheet } from './kanban-sheet.js';
import { MOVE_TOAST_MS, MoveToast } from './quick-move.js';
import { Button, IconButton, Tip, joinHandlers, toolLook, useHovered, usePointerTip, useTipPlace } from './components.js';
import { countBadge, selectedLine, selectedTint, type Palette } from './palette.js';
import type { HostPlatform } from './layout.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';

/**
 * REQ-149 (research/423): "Check up" on the Kanban screens — beside refresh on a wide screen (with how many cards it found),
 * the first row of ⚙'s sheet on a phone (⚙ carries the number; D60: no glyph is added to the phone's top bar). It opens a list
 * of the cards `checkup-model.ts` finds, grouped by rule; nothing is ticked at first and nothing moves by itself. A person
 * ticks cards and chooses "Move to Done" (at once, with Undo for ten seconds) or "Archive" (asked once more, then Undo;
 * later the workspace's Archived cards). "Skip" keeps a card out until it changes or seven days pass, on this device.
 *
 * Every write is the ledger's own `move` / `archive` through `kanban.v1.board.mutate` as the user (REQ-74's pause applies, the
 * store's lock and revision check hold): one write a board (a hundred cards at most each) against the revision the list was
 * read at. A board changed meanwhile is not written to at all (gate 433: judged by its revision, never by a time).
 */

const signalsOf = (source: SignalSource): CheckupSignals => ({ archived: id => source.archived?.(id) === true,
  pending: id => source.pending?.(id) === true, activity: id => source.activity?.(id), ready: source.ready() });

/** The candidates of `boards`, kept live: read again when the agents' signals change it, and once an hour (days cross over). */
export function useCheckupList(source: SignalSource, boards: readonly CheckupBoard[], enabled: boolean): CheckupCandidate[] {
  const hour = useMinuteKey(now => String(Math.floor(now / 3600_000)), enabled);
  const [tick, bump] = useState(0);
  const list = useMemo(() => enabled ? checkupCandidates(boards, signalsOf(source), Date.now()) : [], [source, boards, enabled, tick, hour]);
  const seen = useRef(''); seen.current = checkupKey(list);
  const latest = useRef({ boards, enabled }); latest.current = { boards, enabled };
  useEffect(() => source.subscribe(() => {
    const { boards: shown, enabled: on } = latest.current;
    const next = on ? checkupKey(checkupCandidates(shown, signalsOf(source), Date.now())) : '';
    if (next !== seen.current) { seen.current = next; bump(value => value + 1); }
  }), [source]);
  return list;
}

/** "Skip" as this device keeps it — the browser's storage on the web, the session elsewhere (`readSkips` drops anything else). */
const SKIPS_KEY = 'paseo-kanban:checkup-skips:';
type Storage = { getItem(key: string): string | null; setItem?(key: string, value: string): void };
const storage = () => (globalThis as { localStorage?: Storage }).localStorage;
function storedSkips(hostId: string): CheckupSkips {
  try { const raw = storage()?.getItem(SKIPS_KEY + hostId); return raw ? readSkips(JSON.parse(raw)) : {}; } catch { return {}; }
}
function useCheckupSkips(scope: string, hostId: string): { skips: CheckupSkips; skip: (c: CheckupCandidate) => void } {
  const [kept, setKept] = useSessionValue<CheckupSkips | null>(scope, 'checkupSkips', null);
  const skips = useMemo(() => kept ?? storedSkips(hostId), [kept, hostId]);
  return { skips, skip: c => {
    const next = addSkip(skips, c, Date.now());
    setKept(next);
    try { storage()?.setItem?.(SKIPS_KEY + hostId, JSON.stringify(next)); } catch { /* private mode or no storage: this session keeps it */ }
  } };
}

/** What one action did, for the notice and its Undo. */
export interface CheckupOutcome extends CheckupTally { action: CheckupAction; changed: CheckupPlanBoard[]; skipped: number }
/**
 * `left`: cards not written because the board had changed elsewhere; `refused`: cards the ledger refused, or whose write's reply
 * was lost (`unknown`). `revision`: the board's revision after the last write that went through.
 */
type BoardResult = { changed: CheckupPlanBoard['cards']; left: number; refused: number; unknown: boolean; revision: string };
/**
 * The writes: `run` applies a plan board by board; `undo` puts back what an outcome changed.
 * Gate 433: whether anyone else wrote is judged by the board's revision alone — the value the ledger raises on every write and
 * checks before one (compare-and-swap) — never by a time, which a clock standing still or set back can repeat. An action writes
 * only on the revision the list was read at: if the board changed since, nothing more is written to it and its cards are left
 * as they are (no retry). Undo writes only on the revision the check up's own last write produced: if anything at all was
 * written to that board since, nothing is undone there. A busy board therefore refuses Undo more often; that is the price.
 */
export function useCheckupWrites() {
  const mutate = useRpc(boardMutate), restore = useRpc(archivedRestore), preview = usePreview();
  /** One board's cards in writes of a hundred, each on the revision the last one produced, starting from `revision`. */
  const write = async (boardId: string, revision: string, cards: CheckupPlanBoard['cards'],
    operations: (cards: CheckupPlanBoard['cards']) => ReturnType<typeof operationsOf>): Promise<BoardResult> => {
    const changed: CheckupPlanBoard['cards'] = [];
    let rest = cards, ifRevision = revision;
    while (rest.length) {
      const part = rest.slice(0, CHECKUP_BATCH);
      let reply;
      try { reply = await mutate({ boardId, ifRevision, requestId: newRequestId(), operations: operations(part) }); }
      catch { return { changed, left: 0, refused: rest.length, unknown: true, revision: ifRevision }; }
      if (reply.ok) { changed.push(...part); rest = rest.slice(part.length); ifRevision = reply.data.revision; continue; }
      if (reply.committed === 'unknown') return { changed, left: 0, refused: rest.length, unknown: true, revision: ifRevision };
      if (reply.error.code === 'E_REVISION_CONFLICT') return { changed, left: rest.length, refused: 0, unknown: false, revision: ifRevision };
      return { changed, left: 0, refused: rest.length, unknown: false, revision: ifRevision };
    }
    return { changed, left: 0, refused: 0, unknown: false, revision: ifRevision };
  };
  const total = (boards: readonly CheckupPlanBoard[]) => boards.reduce((n, b) => n + b.cards.length, 0);
  const run = async (boards: readonly CheckupPlanBoard[], action: CheckupAction, skipped: number): Promise<CheckupOutcome> => {
    const outcome: CheckupOutcome = { action, changed: [], count: 0, left: 0, refused: 0, skipped, unknown: false };
    for (const board of boards) {
      if (!mutationAllowed(preview, board.boardId)) { outcome.refused += board.cards.length; continue; }
      const result = await write(board.boardId, board.revision, board.cards, operationsOf);
      // A lost reply leaves the revision unknown: such a board's cards are never undone.
      if (result.changed.length) outcome.changed.push({ ...board, revision: result.unknown ? '' : result.revision, cards: result.changed });
      outcome.left += result.left; outcome.refused += result.refused; outcome.unknown ||= result.unknown;
    }
    outcome.count = total(outcome.changed);
    return outcome;
  };
  /**
   * Undo, board by board, only on the revision the check up's own last write there produced: moves home in one write a hundred
   * cards (the ledger refuses it if anything was written since), archived cards restored one by one, each on the revision the
   * last one produced (the server's `ifRevision`). Whatever the board refuses is left as it is (`left`).
   */
  const undo = async (done: CheckupOutcome): Promise<CheckupTally> => {
    let count = 0, left = 0, refused = 0, unknown = false;
    for (const board of done.changed) {
      if (!board.revision) { left += board.cards.length; continue; }
      if (done.action === 'archive') {
        let ifRevision = board.revision, broken = false;
        for (const card of board.cards) {
          if (broken) { left++; continue; }
          try {
            const reply = await restore({ boardId: board.boardId, cardId: card.cardId, ifRevision });
            if (reply?.ok && reply.data.kept) { left++; broken = true; }
            else if (reply?.ok && reply.data.revision) { count++; ifRevision = reply.data.revision; }
            else { refused++; broken = true; }
          } catch { refused++; broken = true; }
        }
        continue;
      }
      const result = await write(board.boardId, board.revision, board.cards, homeOperations);
      count += result.changed.length; left += result.left; refused += result.refused; unknown ||= result.unknown;
    }
    return { count, left, refused, unknown };
  };
  return { run, undo };
}

/** A tick box, 20px (a phone's touch area 44px). `mixed`: some of a group's cards are ticked. */
function TickBox({ checked, mixed = false, label, onPress, colors: c, mobile, testID }: {
  checked: boolean; mixed?: boolean; label: string; onPress: () => void; colors: Palette; mobile: boolean; testID: string;
}) {
  const on = checked || mixed, size = px(18);
  return <Pressable testID={testID} accessibilityRole="checkbox" role="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked: mixed ? 'mixed' : checked }} aria-checked={mixed ? 'mixed' : checked} onPress={onPress}
    hitSlop={mobile ? px(13) : px(6)} style={{ width: mobile ? px(28) : px(22), height: mobile ? px(28) : px(22), alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ width: size, height: size, borderRadius: px(4), borderWidth: on ? 0 : 1.5, alignItems: 'center', justifyContent: 'center',
      borderColor: c.foregroundMuted, backgroundColor: on ? c.accent : 'transparent' }}>
      {on && <Icon name={mixed && !checked ? 'Minus' : 'Check'} size={px(14)} color={c.accentForeground} />}
    </View>
  </Pressable>;
}

/** The suggestion's tag: Done in the main colour, Archive in the warning colour, the rest quiet. */
function SuggestTag({ c: cand, colors: c, m }: { c: CheckupCandidate; colors: Palette; m: Copy }) {
  const kind = cand.suggest ?? (cand.rule === 'stalled' ? 'look' : 'none');
  const tone = kind === 'done' ? selectedLine(c, c.surface0) : kind === 'archive' ? c.statusWarning : c.foregroundMuted;
  return <View testID={'checkup-suggest-' + kind} style={{ paddingHorizontal: px(7), height: px(20), borderRadius: px(10), justifyContent: 'center',
    borderWidth: 1, borderColor: kind === 'done' || kind === 'archive' ? tone : c.border, flexShrink: 0 }}>
    <Text numberOfLines={1} style={{ color: tone, fontSize: px(11) }}>{m.checkupSuggest[kind]}</Text>
  </View>;
}

/** The wide screen's button beside refresh: a glyph, "Check up", and how many cards it found (none: no number, same place). */
export function CheckupButton({ count, onPress, disabled = false, colors: c, m }: {
  count: number; onPress: () => void; disabled?: boolean; colors: Palette; m: Copy;
}) {
  const hover = useHovered(), tip = usePointerTip(), box = useRef<View>(null), place = useTipPlace(tip.shown, box);
  const look = toolLook(c, { hovered: hover.hovered && !disabled, fill: c.surface2, quiet: false });
  const badge = countBadge(c, look.backgroundColor === 'transparent' ? c.surface0 : look.backgroundColor);
  return <View ref={box} style={{ ...(tip.shown ? { zIndex: 1 } : {}) }}>
    <Pressable testID="checkup-button" accessibilityRole="button" accessibilityLabel={m.checkupLabel(count)} accessibilityState={{ disabled }}
      disabled={disabled} onPress={onPress} {...joinHandlers(tip.handlers, { onHoverIn: hover.onHoverIn, onHoverOut: hover.onHoverOut })}
      style={{ height: px(30), flexDirection: 'row', alignItems: 'center', gap: px(6), paddingLeft: px(8), paddingRight: count ? px(6) : px(10),
        borderRadius: px(6), borderWidth: look.borderWidth, borderColor: look.borderColor, backgroundColor: look.backgroundColor, opacity: disabled ? .4 : 1 }}>
      <Icon name="ListChecks" size={px(16)} color={look.icon} />
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: px(13), fontWeight: '600' }}>{m.checkup}</Text>
      {count > 0 && <View testID="checkup-count" style={{ minWidth: px(18), height: px(18), paddingHorizontal: px(5), borderRadius: px(9),
        alignItems: 'center', justifyContent: 'center', backgroundColor: badge.fill, borderWidth: 1, borderColor: badge.line }}>
        <Text style={{ color: badge.text, fontSize: px(11), lineHeight: px(14), fontWeight: '600' }}>{count > 99 ? '99+' : count}</Text>
      </View>}
    </Pressable>
    {tip.shown && <Tip label={m.checkupLabel(count)} place={place} offset={px(30)} span={px(80)} colors={c} />}
  </View>;
}

/**
 * The phone settings sheet's first row: "Check up", what it found, the number and ›. REQ-72: drawn from the chosen set only —
 * the glyph in the main colour's line (`selectedLine`), the number on its tint.
 */
export function CheckupSettingsRow({ count, onPress, colors: c, m }: { count: number; onPress: () => void; colors: Palette; m: Copy }) {
  const tint = selectedTint(c, c.surface0);
  return <Pressable testID="settings-checkup" accessibilityRole="button" accessibilityLabel={m.checkupLabel(count)} onPress={onPress}
    style={{ minHeight: px(56), flexDirection: 'row', alignItems: 'center', gap: px(10), borderBottomWidth: 1, borderColor: c.divider }}>
    <Icon name="ListChecks" size={px(18)} color={selectedLine(c, c.surface0)} />
    <View style={{ flex: 1, minWidth: 0, gap: px(2), paddingVertical: px(6) }}>
      <Text style={{ color: c.foreground, fontSize: px(15), fontWeight: '600' }}>{m.checkup}</Text>
      <Text testID="settings-checkup-help" style={{ color: c.foregroundMuted, fontSize: px(12), lineHeight: px(16) }}>{m.checkupSettingsHelp(count)}</Text>
    </View>
    {count > 0 && <View testID="settings-checkup-count" style={{ minWidth: px(20), height: px(20), paddingHorizontal: px(5), borderRadius: px(10),
      alignItems: 'center', justifyContent: 'center', backgroundColor: tint }}>
      <Text style={{ color: c.foreground, fontSize: px(12), lineHeight: px(15), fontWeight: '700' }}>{count > 99 ? '99+' : count}</Text>
    </View>}
    <Icon name="ChevronRight" size={px(16)} color={c.foregroundMuted} />
  </Pressable>;
}

type Notice149 = { text: string; error?: boolean; undo?: CheckupOutcome };
/**
 * A screen's check up: the list (live), its count, the sheet and the notice. `boards` are the boards the screen shows
 * (hidden projects left out); `enabled` is false in the demo. `layer` draws the sheet and, while it is closed, the notice
 * at the bottom of the screen (as a quick move's).
 */
export function useCheckup({ hostId, scope, source, boards, enabled, refresh }: {
  hostId: string; scope: string; source: SignalSource; boards: readonly CheckupBoard[]; enabled: boolean; refresh: () => void;
}) {
  const found = useCheckupList(source, boards, enabled);
  const { skips, skip } = useCheckupSkips(scope, hostId);
  // Cards an action changed leave the list at once, before the boards are read again.
  const [gone, setGone] = useState<readonly string[]>([]);
  const list = useMemo(() => { const out = new Set(gone); return withoutSkipped(found, skips, Date.now()).filter(c => !out.has(c.key)); }, [found, skips, gone]);
  useEffect(() => { if (gone.length && gone.some(key => !found.some(c => c.key === key))) setGone(keys => keys.filter(key => found.some(c => c.key === key))); }, [found]);
  const [open, setOpen] = useSessionValue(scope, 'checkupOpen', false);
  const [ticked, setTicked] = useSessionValue<readonly string[]>(scope, 'checkupSelected', []);
  const selected = useMemo(() => { const keys = new Set(list.map(c => c.key)); return new Set(ticked.filter(key => keys.has(key))); }, [ticked, list]);
  const [notice, setNotice] = useState<Notice149 | null>(null), [busy, setBusy] = useState(false);
  const writes = useCheckupWrites();
  // A notice with Undo goes after ten seconds (REQ-82's); one saying what failed stays until closed.
  useEffect(() => {
    if (!notice?.undo) return undefined;
    const timer = setTimeout(() => setNotice(value => value === notice ? null : value), MOVE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const act = async (action: CheckupAction, m: Copy) => {
    const plan = checkupPlan(list, selected, action);
    if (!plan.boards.length || busy) return;
    setBusy(true); setNotice(null);
    const outcome = await writes.run(plan.boards, action, plan.skipped);
    setBusy(false);
    const changed = outcome.changed.flatMap(b => b.cards.map(card => b.boardId + '\u0000' + card.cardId));
    if (changed.length) { setGone(keys => [...keys, ...changed]); setTicked(keys => keys.filter(key => !changed.includes(key))); }
    // Gate 433: a board changed elsewhere is read again, so the cards left ticked are tried on its new revision next time.
    if (changed.length || outcome.left) refresh();
    setNotice({ ...checkupResult(outcome, action, m), ...(outcome.count ? { undo: outcome } : {}) });
  };
  const undo = async (m: Copy) => {
    const last = notice?.undo;
    if (!last || busy) return;
    setBusy(true); setNotice(null);
    const result = await writes.undo(last);
    setBusy(false);
    const back = last.changed.flatMap(b => b.cards.map(card => b.boardId + '\u0000' + card.cardId));
    setGone(keys => keys.filter(key => !back.includes(key)));
    refresh();
    setNotice(checkupResult(result, 'undo', m));
  };
  return {
    list, count: list.length, open: () => { if (enabled) setOpen(true); },
    layer: ({ workspaceOf, colors, m, platform, mobile, onOpenCard, bottom = 0 }: {
      workspaceOf: (boardId: string) => string; colors: Palette; m: Copy; platform: HostPlatform; mobile: boolean;
      onOpenCard: (boardId: string, cardId: string) => void; bottom?: number;
    }): ReactNode => <>
      {enabled && <CheckupSheet open={open} list={list} selected={selected} busy={busy} notice={notice} onNotice={() => setNotice(null)}
        onTick={(keys, on) => setTicked(current => on ? [...new Set([...current.filter(k => selected.has(k)), ...keys])] : current.filter(k => selected.has(k) && !keys.includes(k)))}
        onSkip={c => { skip(c); setTicked(current => current.filter(k => k !== c.key)); }}
        onOpenCard={c => { setOpen(false); onOpenCard(c.boardId, c.cardId); }}
        onAct={action => { void act(action, m); }} onUndo={() => { void undo(m); }}
        workspaceOf={workspaceOf} agentName={id => assigneeName(id, source.model?.(id), source.pending?.(id) === true)}
        onClose={() => setOpen(false)} colors={colors} m={m} platform={platform} mobile={mobile} />}
      {!open && notice && <MoveToast text={notice.text} error={!!notice.error} onUndo={notice.undo ? () => { void undo(m); } : undefined}
        onClose={() => setNotice(null)} colors={colors} m={m} bottom={bottom} mobile={mobile} />}
    </>,
  };
}
export type Checkup = ReturnType<typeof useCheckup>;

/**
 * The list: on a wide screen a centred window 640px wide, on a phone a sheet from the bottom. Its head says nothing moves by
 * itself and what it looks for; the groups follow the rules' order, each with its tick box (all or none), name and count; a
 * row is a tick box, the title (opens the card), its reason and suggestion, and Skip (a phone: ⋯ → open, skip). The bottom row
 * says how many are ticked and offers Archive and Move to Done; Archive first asks in that row.
 */
export function CheckupSheet({ open, list, selected, busy, notice, onNotice, onTick, onSkip, onOpenCard, onAct, onUndo, workspaceOf, agentName,
  onClose, colors: c, m, platform, mobile }: {
  open: boolean; list: readonly CheckupCandidate[]; selected: ReadonlySet<string>; busy: boolean; notice: Notice149 | null; onNotice: () => void;
  onTick: (keys: readonly string[], on: boolean) => void; onSkip: (c: CheckupCandidate) => void; onOpenCard: (c: CheckupCandidate) => void;
  onAct: (action: CheckupAction) => void; onUndo: () => void; workspaceOf: (boardId: string) => string; agentName: (agentId: string) => string;
  onClose: () => void; colors: Palette; m: Copy; platform: HostPlatform; mobile: boolean;
}) {
  const screen = useWindowDimensions();
  const [asking, setAsking] = useState(false), [rowMenu, setRowMenu] = useState<string | null>(null);
  useEffect(() => { if (!open) { setAsking(false); setRowMenu(null); } }, [open]);
  const counts = selectionCounts(list, selected), groups = checkupGroups(list);
  useEffect(() => { if (!counts.total) setAsking(false); }, [counts.total]);
  const muted = c.foregroundMuted, limits = CHECKUP_LIMITS;
  const daysOf = (rule: CheckupCandidate['rule']) => rule === 'stalled' ? limits.stalledDays : rule === 'waiting' ? limits.waitingDays : limits.draftDays;
  const dialog = !mobile && platform === 'web' && screen.width >= 760;
  // A phone's sheet is 90% of the screen (Yoga gives a flexible list no height without one); a wide window is as tall as its
  // list, up to the sheet's 85%.
  const height = Math.round(screen.height * .9);
  // Ticked cards Done cannot take (drafts) are said on the button, even when none is left for it.
  const doneLabel = counts.notDone ? m.checkupDoneLeftOut(counts.done, counts.notDone) : mobile ? m.checkupDoneCount(counts.done) : m.checkupDone;
  const head = <View testID="checkup-head" style={{ paddingHorizontal: px(16), paddingTop: px(10), paddingBottom: px(8), gap: px(2), borderBottomWidth: 1, borderColor: c.divider }}>
    <Text testID="checkup-intro" style={{ color: c.foreground, fontSize: px(12), lineHeight: px(17) }}>{m.checkupIntro}</Text>
    {!mobile && <Text testID="checkup-rules" style={{ color: muted, fontSize: px(12), lineHeight: px(17) }}>{m.checkupRules(limits.stalledDays, limits.waitingDays)}</Text>}
  </View>;
  const empty = <View testID="checkup-empty" style={{ alignItems: 'center', gap: px(8), paddingVertical: px(28), paddingHorizontal: px(16) }}>
    <View style={{ width: px(40), height: px(40), borderRadius: px(20), alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface2 }}>
      <Icon name="ListChecks" size={px(20)} color={selectedLine(c, c.surface2)} />
    </View>
    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: px(15), fontWeight: '600', textAlign: 'center' }}>{m.checkupEmptyTitle}</Text>
    <Text testID="checkup-empty-body" style={{ color: muted, fontSize: px(12), lineHeight: px(18), textAlign: 'center' }}>
      {m.checkupEmptyBody(limits.stalledDays, limits.waitingDays)}</Text>
    <Text testID="checkup-empty-tidy" style={{ color: muted, fontSize: px(12), lineHeight: px(18), textAlign: 'center' }}>{m.checkupEmptyTidy}</Text>
  </View>;
  const row = (cand: CheckupCandidate, index: number) => {
    const on = selected.has(cand.key), menu = rowMenu === cand.key;
    return <View key={cand.key} testID={'checkup-row-' + cand.rule + '-' + index} style={{ borderRadius: px(6), backgroundColor: on ? c.surface1 : 'transparent' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), paddingVertical: px(6), paddingLeft: px(4), paddingRight: px(2), minHeight: mobile ? px(52) : px(44) }}>
        <TickBox testID="checkup-tick" checked={on} label={m.checkupTick(cand.title)} onPress={() => onTick([cand.key], !on)} colors={c} mobile={mobile} />
        <Pressable testID="checkup-title" accessibilityRole="link" accessibilityLabel={m.checkupOpenCard + ': ' + cand.title} onPress={() => onOpenCard(cand)}
          style={{ flex: 1, minWidth: 0, gap: px(2) }}>
          <Text numberOfLines={2} style={{ color: c.foreground, fontSize: px(13), fontWeight: '600', lineHeight: px(18) }}>{cand.title}</Text>
          <Text testID="checkup-line" numberOfLines={mobile ? 3 : 2} style={{ color: muted, fontSize: px(12), lineHeight: px(16) }}>
            {checkupLine(cand, workspaceOf(cand.boardId), agentName, m)}</Text>
        </Pressable>
        {!mobile && <SuggestTag c={cand} colors={c} m={m} />}
        {mobile
          ? <IconButton testID="checkup-row-more" name="Ellipsis" label={m.checkupMore(cand.title)} colors={c} mobile plain
            onPress={() => setRowMenu(menu ? null : cand.key)} on={menu} />
          : <Pressable testID="checkup-skip" accessibilityRole="button" accessibilityLabel={m.checkupSkipLabel(cand.title)} onPress={() => onSkip(cand)}
            style={{ minHeight: px(30), paddingHorizontal: px(8), justifyContent: 'center', borderRadius: px(6) }}>
            <Text style={{ color: muted, fontSize: px(12) }}>{m.checkupSkip}</Text>
          </Pressable>}
      </View>
      {mobile && menu && <View testID="checkup-row-menu" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8), paddingLeft: px(40), paddingBottom: px(8) }}>
        <SuggestTag c={cand} colors={c} m={m} />
        <Button testID="checkup-open" label={m.checkupOpenCard} colors={c} mobile selected onPress={() => { setRowMenu(null); onOpenCard(cand); }} />
        <Button testID="checkup-skip" label={m.checkupSkip} colors={c} mobile selected onPress={() => { setRowMenu(null); onSkip(cand); }} />
      </View>}
    </View>;
  };
  const group = (g: { rule: CheckupCandidate['rule']; cards: CheckupCandidate[] }, index: number) => {
    const keys = g.cards.map(card => card.key), some = keys.filter(key => selected.has(key)).length, all = some === keys.length;
    const name = mobile ? m.checkupRuleShort(g.rule, daysOf(g.rule)) : m.checkupRuleName(g.rule, daysOf(g.rule));
    return <View key={g.rule} testID={'checkup-group-' + g.rule} style={{ gap: px(2), marginTop: index ? px(10) : 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), paddingLeft: px(4), minHeight: mobile ? px(44) : px(32) }}>
        <TickBox testID={'checkup-group-tick-' + g.rule} checked={all} mixed={some > 0 && !all} label={m.checkupGroupLabel(name, keys.length)}
          onPress={() => onTick(keys, !all)} colors={c} mobile={mobile} />
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: px(6) }}>
          <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: px(13), fontWeight: '700' }}>{(index + 1) + '. ' + name}</Text>
          <Text testID={'checkup-group-count-' + g.rule} style={{ color: muted, fontSize: px(12), fontWeight: '600' }}>{keys.length}</Text>
          {!mobile && <Text style={{ color: muted, fontSize: px(12) }}>{'— ' + m.checkupRuleHint(g.rule, daysOf(g.rule))}</Text>}
        </View>
        <Pressable testID={'checkup-group-all-' + g.rule} accessibilityRole="button" accessibilityLabel={(all ? m.checkupClear : m.checkupSelectAll) + ': ' + name}
          onPress={() => onTick(keys, !all)} hitSlop={px(6)} style={{ minHeight: px(30), paddingHorizontal: px(6), justifyContent: 'center' }}>
          <Text style={{ color: selectedLine(c, c.surface0), fontSize: px(12), fontWeight: '600' }}>
            {all ? (mobile ? m.checkupClearShort : m.checkupClear) : (mobile ? m.checkupSelectAllShort : m.checkupSelectAll)}</Text>
        </Pressable>
      </View>
      {g.cards.map(row)}
    </View>;
  };
  const primary = (label: string, onPress: () => void, testID: string, disabled: boolean, description?: string) =>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={description ?? label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{ ...(mobile ? { flex: 2, height: px(44) } : { height: px(32), paddingHorizontal: px(14) }), borderRadius: px(8), alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.accent, opacity: disabled ? .4 : 1 }}>
      <Text numberOfLines={1} style={{ color: c.accentForeground, fontSize: px(13), fontWeight: '600' }}>{label}</Text>
    </Pressable>;
  const secondary = (label: string, onPress: () => void, testID: string, disabled: boolean) =>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{ ...(mobile ? { flex: 1, height: px(44) } : { height: px(32), paddingHorizontal: px(12) }), borderRadius: px(8), alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, opacity: disabled ? .4 : 1 }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: px(13), fontWeight: '600' }}>{label}</Text>
    </Pressable>;
  const noticeBar = notice && <View testID="checkup-notice" accessibilityRole={notice.error ? 'alert' : 'text'} accessibilityLiveRegion="polite"
    style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), paddingHorizontal: px(16), paddingVertical: px(6), borderTopWidth: 1, borderColor: c.divider }}>
    <Text testID="checkup-notice-text" style={{ flex: 1, color: notice.error ? c.statusDanger : c.foreground, fontSize: px(12), lineHeight: px(17) }}>{notice.text}</Text>
    {notice.undo && <Pressable testID="checkup-undo" accessibilityRole="button" accessibilityLabel={m.undo} onPress={onUndo} disabled={busy}
      hitSlop={px(6)} style={{ minHeight: px(30), paddingHorizontal: px(8), justifyContent: 'center' }}>
      <Text style={{ color: selectedLine(c, c.surface0), fontSize: px(13), fontWeight: '600' }}>{m.undo}</Text>
    </Pressable>}
    <IconButton testID="checkup-notice-close" name="X" label={m.close} onPress={onNotice} colors={c} mobile={mobile} plain />
  </View>;
  const footer = asking
    ? <View testID="checkup-archive-ask" accessibilityRole="alert" style={{ gap: px(8), padding: px(12), paddingHorizontal: px(16), borderTopWidth: 1, borderColor: c.divider, backgroundColor: c.surface1 }}>
      <Text testID="checkup-archive-ask-text" style={{ color: c.foreground, fontSize: px(13), lineHeight: px(18), fontWeight: '600' }}>{m.checkupArchiveAsk(counts.total)}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: px(8) }}>
        {secondary(m.cancel, () => setAsking(false), 'checkup-archive-cancel', busy)}
        {primary(m.checkupArchive, () => { setAsking(false); onAct('archive'); }, 'checkup-archive-go', busy)}
      </View>
    </View>
    : <View testID="checkup-footer" style={{ gap: px(6), paddingHorizontal: px(16), paddingVertical: px(10), borderTopWidth: 1, borderColor: c.divider, backgroundColor: c.surface1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
        {!mobile && <Text testID="checkup-selected" style={{ flex: 1, color: c.foreground, fontSize: px(13) }}>{m.checkupSelected(counts.total)}</Text>}
        {!mobile && secondary(m.close, onClose, 'checkup-close', false)}
        {secondary(m.checkupArchive, () => setAsking(true), 'checkup-archive', busy || !counts.total)}
        {primary(doneLabel, () => onAct('done'), 'checkup-done', busy || !counts.done, counts.notDone ? doneLabel + ' — ' + m.checkupDoneLeftOutLabel(counts.notDone) : undefined)}
      </View>
      {!mobile && <Text testID="checkup-note" style={{ color: muted, fontSize: px(11), lineHeight: px(15) }}>{m.checkupNote}</Text>}
    </View>;
  return <KanbanSheet testID="checkup-sheet" closeTestID="checkup-sheet-close" title={mobile ? m.checkupPhoneTitle(list.length) : m.checkupTitle(list.length)}
    open={open} onClose={onClose} colors={c} platform={platform} closeLabel={m.close} width={dialog ? px(640) : px(560)} scroll={false}
    {...(list.length && !dialog ? { height } : {})} centered={dialog}>
    <View style={{ ...(list.length && !dialog ? { flex: 1 } : { flexShrink: 1 }), minHeight: 0 }}>
      {head}
      {list.length
        ? <ScrollView testID="checkup-list" style={dialog ? { flexGrow: 0, flexShrink: 1, minHeight: 0 } : { flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: px(12), paddingBottom: px(16) }}>
          {groups.map(group)}
          {mobile && <Text testID="checkup-note" style={{ color: muted, fontSize: px(11), marginTop: px(12), paddingHorizontal: px(4) }}>{m.checkupNoteShort}</Text>}
        </ScrollView>
        : empty}
      {noticeBar}
      {list.length > 0 && footer}
    </View>
  </KanbanSheet>;
}
