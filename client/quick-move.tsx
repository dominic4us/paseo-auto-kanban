import type { DispatchHeld } from '../shared/dispatch.js';
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions, type LayoutChangeEvent, type ScrollView as NativeScrollView } from 'react-native';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import * as hostUi from '@getpaseo/plugin/client/react-native';
import { dropdownPosition } from './dropdown-state.js';
import { useRpc } from '@getpaseo/plugin/client';
import { autoCardsLeadSet, boardGet, boardMutate, cardGet, type BoardDTO } from '../shared/rpc.js';
import { leadMenu, workspaceOf, type AgentLinks, type LeadMenu } from './card-groups.js';
import { dispatchStage } from '../shared/core/domain.js';
import { newRequestId } from './editor-state.js';
import { mutationAllowed } from './demo.js';
import { usePreview } from './preview-context.js';
import { applyPendingMoves, laterRevision, sendsToLead, stageAllowed, undoTarget, type PendingMove } from './move-model.js';
import { DispatchSheet, type DispatchRequest } from './dispatch-confirm.js';
import { IconButton, Notice, toolLook, useHovered } from './components.js';
import { MenuSheet } from './menu-sheet.js';
import { fieldLine, hoverFill, readable, selectedTint, type Palette } from './palette.js';
import type { HostPlatform } from './layout.js';
import type { Copy } from './i18n.js';
import { afterThisTask, focusFromKeyboard, watchFocusKeys } from './focus-origin.js';
import { dismissPressTip } from './press-tip.js';
import { jumpFor, type HostNavigation, type Jump } from './agent-jump.js';
import { useAgentLeave } from './agent-leave.js';
import { px, scaled } from './ui-scale.js';

/*
 * REQ-82 ③: moves a person made that the board has not been read with yet, per host. Every screen of the host draws
 * them (`usePendingMoves` + `applyPendingMoves`), so a card is in its new column the moment it is chosen.
 */
const stores = new Map<string, { list: readonly PendingMove[]; listeners: Set<() => void> }>();
const storeFor = (hostId: string) => {
  let store = stores.get(hostId);
  if (!store) { store = { list: [], listeners: new Set() }; stores.set(hostId, store); }
  return store;
};
function setPending(hostId: string, update: (list: readonly PendingMove[]) => readonly PendingMove[]) {
  const store = storeFor(hostId), next = update(store.list);
  if (next === store.list) return;
  store.list = next;
  for (const listener of [...store.listeners]) listener();
}
export function usePendingMoves(hostId: string): readonly PendingMove[] {
  const store = storeFor(hostId);
  return useSyncExternalStore(listener => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; },
    () => store.list, () => store.list);
}
/** The boards as this host's screens show them: the pending moves drawn over what was read, stale ones dropped. */
export function useMovedBoards<B extends BoardDTO>(hostId: string, boards: B[], enabled = true): B[] {
  const pending = usePendingMoves(hostId);
  useEffect(() => {
    // A board read at a later revision than a move was made against already has it (or a later change outranks it).
    const read = new Map(boards.map(b => [b.summary.id, b.summary.revision]));
    setPending(hostId, list => { const kept = list.filter(p => !laterRevision(read.get(p.boardId), p.base));
      return kept.length === list.length ? list : kept; });
  }, [hostId, boards]);
  return enabled ? applyPendingMoves(boards, pending) : boards;
}

export interface MoveRequest { boardId: string; revision: string; cardId: string; to: string }
export type MoveResult = { ok: true; revision: string } | { ok: false; unknown: boolean };
/**
 * REQ-82: one person's move of one card, through the same `board.mutate` as the detail's save (actor user), so the
 * REQ-74 pause applies. When the board changed since it was read, the latest board is read and the move is sent
 * once more against it — unless the card is already where it was sent. A lost reply is reported as unknown.
 */
export function useMoveSender() {
  const mutate = useRpc(boardMutate), read = useRpc(boardGet), preview = usePreview();
  return async ({ boardId, revision, cardId, to }: MoveRequest): Promise<MoveResult> => {
    if (!mutationAllowed(preview, boardId)) return { ok: false, unknown: false };
    let ifRevision = revision;
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply;
      try { reply = await mutate({ boardId, ifRevision, requestId: newRequestId(), operations: [{ op: 'move', id: cardId, to }] }); }
      catch { return { ok: false, unknown: true }; }
      if (reply.ok) return { ok: true, revision: reply.data.revision };
      if (reply.committed === 'unknown') return { ok: false, unknown: true };
      if (reply.error.code !== 'E_REVISION_CONFLICT' || attempt) return { ok: false, unknown: false };
      try {
        const latest = await read({ boardId });
        if (!latest.ok) return { ok: false, unknown: false };
        const card = latest.data.board.stages.flatMap(stage => stage.cards).find(value => value.id === cardId);
        if (card?.stageId === to) return { ok: true, revision: latest.data.revision };
        ifRevision = latest.data.revision;
      } catch { return { ok: false, unknown: false }; }
    }
    return { ok: false, unknown: false };
  };
}

/**
 * REQ-52: the detail's "Archive" — a person's own act (no reason kept: a cancelled card or a duplicate before Done counts
 * nowhere). A board changed meanwhile is read once more; a card already gone from it counts as archived.
 */
export function useArchiveSender() {
  const mutate = useRpc(boardMutate), read = useRpc(boardGet), preview = usePreview();
  return async ({ boardId, revision, cardId }: { boardId: string; revision: string; cardId: string }): Promise<boolean> => {
    if (!mutationAllowed(preview, boardId)) return false;
    let ifRevision = revision;
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply;
      try { reply = await mutate({ boardId, ifRevision, requestId: newRequestId(), operations: [{ op: 'archive', id: cardId }] }); }
      catch { return false; }
      if (reply.ok) return true;
      if (reply.error.code !== 'E_REVISION_CONFLICT' || attempt) return false;
      try {
        const latest = await read({ boardId });
        if (!latest.ok) return false;
        if (!latest.data.board.stages.some(stage => stage.cards.some(value => value.id === cardId))) return true;
        ifRevision = latest.data.revision;
      } catch { return false; }
    }
    return false;
  };
}
/** A move made, for its undo: where it put the card and the revision it produced. */
export interface UndoRequest { boardId: string; cardId: string; movedTo: string; revision: string }
export type UndoResult = { ok: true; revision: string; to: string } | { ok: false; unknown: boolean; meanwhile?: boolean };
/**
 * REQ-82 G1: undo is one more move by a person, back to the stage the ledger had the card in right before the move
 * (`undoTarget`), read from the card's history at the time of the undo — not the stage the screen showed. If the
 * card was moved again in between, nothing is sent (`meanwhile`). A board changed otherwise is read once more.
 */
export function useUndoSender() {
  const mutate = useRpc(boardMutate), get = useRpc(cardGet), preview = usePreview();
  return async ({ boardId, cardId, movedTo, revision }: UndoRequest): Promise<UndoResult> => {
    if (!mutationAllowed(preview, boardId)) return { ok: false, unknown: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      let snapshot;
      try { const reply = await get({ boardId, cardId }); if (!reply.ok) return { ok: false, unknown: false }; snapshot = reply.data; }
      catch { return { ok: false, unknown: false }; }
      const to = undoTarget(snapshot.history, snapshot.card.stageId, movedTo, revision);
      if (!to) return { ok: false, unknown: false, meanwhile: true };
      let reply;
      try { reply = await mutate({ boardId, ifRevision: snapshot.revision, requestId: newRequestId(), operations: [{ op: 'move', id: cardId, to }] }); }
      catch { return { ok: false, unknown: true }; }
      if (reply.ok) return { ok: true, revision: reply.data.revision, to };
      if (reply.committed === 'unknown') return { ok: false, unknown: true };
      if (reply.error.code !== 'E_REVISION_CONFLICT') return { ok: false, unknown: false };
    }
    return { ok: false, unknown: false };
  };
}

/**
 * REQ-82 ②③: whether a card's quick controls show on a wide screen — while the pointer is anywhere over the card,
 * or the keyboard's focus is on it or on anything in it. Focus a click or a closing window hands back is not the
 * keyboard's (research/113), so it shows nothing; once shown by the keyboard, focus moving on inside the card (a
 * click on "Done", say) keeps it. Leaving is judged a moment later, so focus moving from the card to the state mark,
 * "Done" or ⋯, or back, never hides the control it is moving to.
 *
 * `area` goes on the box around the card (research/117 F1·F2). A Pressable's own hover ends as the pointer enters
 * a Pressable inside it (the web keeps only the innermost one hovered), and its focus handlers hear only its own
 * focus, so the card's own handlers hid "Done" the moment the pointer or Tab reached it. The box's pointer enter
 * and leave, and its focus and blur, which the web hands up from everything inside, do not end there. `card` and
 * `inner` are the same focus handlers for a native keyboard, where focus is not handed up; on the web they only
 * repeat what the box hears.
 */
export function useRevealOnHover() {
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false);
  const within = useRef(false), byFocus = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; watchFocusKeys(); return () => { alive.current = false; }; }, []);
  const show = (value: boolean) => { byFocus.current = value; setFocus(value); };
  const focusIn = () => { within.current = focusFromKeyboard() || byFocus.current; if (within.current) show(true); };
  const focusOut = () => { within.current = false; setTimeout(() => { if (alive.current) show(within.current); }, 0); };
  const focusHandlers = { onFocus: focusIn, onBlur: focusOut };
  return { shown: hover || focus,
    area: { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false), ...focusHandlers },
    card: focusHandlers, inner: focusHandlers };
}
/**
 * REQ-85 ⑧: where the ⋯ that opened the menu is in the window, so a wide screen's menu hangs right under it, and the
 * ⋯ itself, which gets the focus back when the menu closes. Without it (a long press, a screen reader's action) the
 * menu is the centred window or the phone's sheet, as before.
 */
export interface MenuOrigin { anchor?: { x: number; y: number; width: number; height: number }; trigger?: { focus?: () => void } | null }
/** What the card tiles of a screen reach: move a card now, open its stage menu, and whether a move of it is on its way. */
export interface QuickMove {
  /** A phone (or a narrow window): the card's "Done" always shows and a long press opens the menu, no ⋯. */
  touch: boolean;
  move: (boardId: string, cardId: string, to: string) => void;
  openMenu: (boardId: string, cardId: string, origin?: MenuOrigin) => void;
  busy: (cardId: string) => boolean;
  /** REQ-96: the card's way to `agentId` (or, with none, its workspace) — `jumpFor` on the screen's boards. */
  jump?: (boardId: string, agentId: string | undefined) => Jump | null;
}
export const QuickMoveContext = createContext<QuickMove | null>(null);
export const useQuickMove = () => useContext(QuickMoveContext);

/** REQ-85 ⑧: `selectable` is words a person may select by hand (the card id a copy could not place); such a notice stays until closed. */
type Toast = { text: string; error?: boolean; undo?: UndoRequest; selectable?: string };
/**
 * REQ-85 ⑧: the card id onto this device's clipboard through the host (`copyText`, Paseo 0.9: the browser's clipboard
 * on the web). A host without it, or one that refuses, rejects — the caller then shows the id to select by hand.
 */
export async function copyCardId(cardId: string, copy = (hostUi as { copyText?: (text: string) => Promise<void> }).copyText): Promise<boolean> {
  try { if (typeof copy !== 'function') return false; await copy(cardId); return true; } catch { return false; }
}
/** How long "Moved to … · Undo" stays unless something replaces or closes it. */
export const MOVE_TOAST_MS = 10000;
/**
 * REQ-82 ②③: the quick moves of one screen — the card tiles' context, the stage menu, and the "Moved to … · Undo"
 * notice. `boards` are the boards the screen shows (pending moves drawn), `refresh` reads them again quietly.
 */
export function useQuickMoves({ hostId, enabled, touch, boards, refresh, m, colors, platform, navigation, agents, here }: {
  hostId: string; enabled: boolean; touch: boolean; boards: readonly BoardDTO[]; refresh: () => void;
  m: Copy; colors: Palette; platform: HostPlatform;
  /** REQ-96: the host's navigation (`props.navigation`); without it no card offers "Go to agent". */
  navigation?: HostNavigation | undefined;
  /** REQ-137: the agents' labels (`useAgentLinks`), so a sub-chat or a topic lead is not offered "Mark as lead". */
  agents?: AgentLinks | undefined;
  /** REQ-142: the workspace this screen is in (the workspace panel's); without it every "Go to agent" asks first. */
  here?: string | undefined;
}) {
  const send = useMoveSender(), sendUndo = useUndoSender(), setLead = useRpc(autoCardsLeadSet), preview = usePreview();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [menu, setMenu] = useState<{ boardId: string; cardId: string } & MenuOrigin | null>(null);
  // REQ-97: a draft on its way to the working stage waits here for the confirmation sheet.
  const [dispatching, setDispatching] = useState<DispatchRequest & { base: string } | null>(null);
  const shown = useRef(boards); shown.current = boards;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!toast || toast.selectable) return;
    const timer = setTimeout(() => { if (alive.current) setToast(null); }, MOVE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const find = (boardId: string, cardId: string) => {
    const board = shown.current.find(b => b.summary.id === boardId);
    const card = board?.stages.flatMap(stage => stage.cards).find(value => value.id === cardId);
    return board && card ? { board, card } : null;
  };
  const stageName = (board: BoardDTO, stageId: string) => board.template.stages.find(s => s.stageId === stageId)?.name ?? stageId;
  const hold = (cardId: string, value: boolean) => setBusy(set => { const next = new Set(set);
    if (value) next.add(cardId); else next.delete(cardId); return next; });
  const run = async (request: MoveRequest, board: BoardDTO) => {
    const { cardId, to } = request;
    hold(cardId, true); setToast(null);
    setPending(hostId, list => [...list.filter(p => p.cardId !== cardId), { boardId: request.boardId, cardId, to, base: request.revision,
      at: new Date().toISOString() }]);
    const result = await send(request);
    if (!result.ok) setPending(hostId, list => list.filter(p => !(p.cardId === cardId && p.base === request.revision)));
    refresh();
    if (!alive.current) return;
    hold(cardId, false);
    if (!result.ok) { setToast({ text: result.unknown ? m.moveUnknown : m.moveFailed, error: true }); return; }
    setToast({ text: m.movedTo(stageName(board, to)), undo: { boardId: request.boardId, cardId, movedTo: to, revision: result.revision } });
  };
  const move = (boardId: string, cardId: string, to: string) => {
    const found = find(boardId, cardId);
    if (!enabled || !found || busy.has(cardId) || found.card.stageId === to) return;
    if (!stageAllowed(found.board.template.stages, found.card.intent, to)) return;
    if (sendsToLead(found.board.template.stages, found.card.intent, to)) {
      setDispatching({ boardId, cardId, to, base: found.board.summary.revision }); return;
    }
    void run({ boardId, revision: found.board.summary.revision, cardId, to }, found.board);
  };
  // REQ-82: undo is one more move by a person, back where the ledger had the card right before the move (G1), and
  // only if nothing moved it since. Automatic tracking stays paused, as after any move a person makes (REQ-74); the
  // detail's "Resume automatic tracking" lifts it.
  const undo = async () => {
    const back = toast?.undo;
    if (!back || busy.has(back.cardId)) return;
    hold(back.cardId, true); setToast(null);
    const result = await sendUndo(back);
    const shownBoard = shown.current.find(b => b.summary.id === back.boardId);
    if (result.ok && shownBoard) setPending(hostId, list => [...list.filter(p => p.cardId !== back.cardId),
      { boardId: back.boardId, cardId: back.cardId, to: result.to, base: shownBoard.summary.revision }]);
    refresh();
    if (!alive.current) return;
    hold(back.cardId, false);
    setToast(result.ok ? { text: m.movedBack(shownBoard ? stageName(shownBoard, result.to) : result.to) }
      : { text: result.meanwhile ? m.undoMeanwhile : result.unknown ? m.moveUnknown : m.moveFailed, error: true });
  };
  const leave = useAgentLeave({ openAgent: navigation ? input => navigation.openAgent(input) : undefined, here, colors, m, platform, mobile: touch });
  const jump = (boardId: string, agentId: string | undefined) =>
    jumpFor(navigation, agentId, shown.current.find(b => b.summary.id === boardId)?.summary, leave.open);
  const context: QuickMove | null = enabled ? { touch, move, busy: cardId => busy.has(cardId), jump,
    // H4: a card's menu closes a state mark's press tooltip left open on any card.
    openMenu: (boardId, cardId, origin) => { dismissPressTip(); if (find(boardId, cardId)) setMenu({ boardId, cardId, ...origin }); } } : null;
  const open = menu ? find(menu.boardId, menu.cardId) : null;
  // REQ-85 ⑧: the card id, copied — or, where the host cannot copy, shown until closed so it can be selected by hand.
  const copyId = async (cardId: string) => {
    setMenu(null);
    const copied = await copyCardId(cardId);
    if (alive.current) setToast(copied ? { text: m.cardIdCopied + ' · ' + cardId } : { text: m.cardIdCopyFailed, error: true, selectable: cardId });
  };
  // REQ-137 (research/273 B): "Mark as lead" / "Unmark as lead" for the card's first chat, saved at once (no ledger change).
  const markLead = async (board: BoardDTO, cardId: string, lead: boolean) => {
    setMenu(null); setToast(null);
    if (!mutationAllowed(preview, board.summary.id)) { setToast({ text: m.leadMarkFailed, error: true }); return; }
    let ok = false;
    try { ok = (await setLead({ boardId: board.summary.id, cardId, lead })).ok; } catch { ok = false; }
    refresh();
    if (alive.current) setToast(ok ? { text: lead ? m.leadMarked(workspaceOf(board)) : m.leadUnmarked } : { text: m.leadMarkFailed, error: true });
  };
  const menuProps = open && menu ? { board: open.board, cardId: open.card.id, colors, m, busy: busy.has(open.card.id),
    lead: leadMenu(open.board, open.card, m, agents, lead => { void markLead(open.board, open.card.id, lead); }),
    // Escape or a press outside: the focus goes back to where the menu was opened from (the card on a wide screen).
    onClose: () => { const trigger = menu.trigger; setMenu(null); if (trigger) afterThisTask(() => trigger.focus?.()); },
    onCopy: () => { void copyId(open.card.id); },
    // REQ-96: the menu's first row (the phone's long-press sheet included) — the card's first agent, else its workspace.
    jump: jump(open.board.summary.id, open.card.agentIds[0]),
    onJump: (go: () => void) => { setMenu(null); go(); },
    onPick: (to: string) => { setMenu(null); move(menu.boardId, menu.cardId, to); } } : null;
  // REQ-97: sent — the card shows in the working stage at once, and the notice says who it waits for.
  const dispatched = (result: { revision: string; lead: string | null; fallback?: boolean; held?: DispatchHeld }, request: DispatchRequest) => {
    const base = dispatching?.base ?? '';
    setDispatching(null);
    setPending(hostId, list => [...list.filter(p => p.cardId !== request.cardId),
      { boardId: request.boardId, cardId: request.cardId, to: request.to, base, at: new Date().toISOString() }]);
    refresh();
    if (alive.current) setToast({ text: m.dispatchQueued(result.lead, result.fallback, result.held) });
  };
  const layer = (bottom = 0) => <>
    {leave.sheet}
    {dispatching && <DispatchSheet request={dispatching} colors={colors} m={m} platform={platform} mobile={touch}
      onClose={() => setDispatching(null)} onSent={dispatched} />}
    {menuProps && (menu?.anchor && !touch ? <StageDropdown {...menuProps} anchor={menu.anchor} />
      : <StageMenu {...menuProps} platform={platform} mobile={touch} />)}
    {toast && <MoveToast text={toast.text} error={!!toast.error} onUndo={toast.undo ? () => { void undo(); } : undefined}
      selectable={toast.selectable} onClose={() => setToast(null)} colors={colors} m={m} bottom={bottom} mobile={touch} />}
  </>;
  return { context, layer };
}

type MenuProps = { board: BoardDTO; cardId: string; colors: Palette; m: Copy; busy: boolean;
  onPick: (stageId: string) => void; onClose: () => void; onCopy: () => void; jump: Jump | null; onJump: (go: () => void) => void;
  lead: LeadMenu };
/** REQ-137: the lead row and its one-line reason under it, after "Copy card ID". */
function LeadRow({ lead, colors: c, m, background, mobile }: { lead: LeadMenu; colors: Palette; m: Copy; background: string; mobile: boolean }) {
  const off = lead.state === 'blocked' || lead.state === 'none';
  return <View testID="card-menu-lead" style={{ gap: 0 }}>
    <MenuRow testID={lead.state === 'unmark' ? 'card-menu-unmark-lead' : 'card-menu-mark-lead'} icon="Crown"
      label={lead.state === 'unmark' ? m.unmarkLead : m.markLead} colors={c} background={background} mobile={mobile} disabled={off}
      onPress={() => lead.onPress(lead.state !== 'unmark')} />
    <Text testID="card-menu-lead-help" style={{ color: readable(c.foregroundMuted, background), fontSize: px(11), lineHeight: px(15),
      paddingLeft: px(32), paddingRight: px(10), paddingBottom: px(4) }}>{lead.help}</Text>
  </View>;
}
/**
 * REQ-85 ⑧/③: one row of the card's menu. The current stage is tinted (③B) with bold words and a check, and cannot be
 * picked; the mouse fills a row grey (`hoverFill`). `background` is what the menu is drawn on.
 */
function MenuRow({ testID, label, chosen = false, disabled = false, icon, onPress, colors: c, background, mobile }: {
  testID: string; label: string; chosen?: boolean; disabled?: boolean; icon?: string; onPress: () => void; colors: Palette;
  background: string; mobile: boolean;
}) {
  const hover = useHovered();
  const look = toolLook(c, { on: chosen, hovered: hover.hovered && !disabled, fill: background, quiet: false, onto: background, mark: false });
  return <Pressable testID={testID} accessibilityRole="menuitem" role="menuitem" accessibilityLabel={label}
    accessibilityState={{ disabled, ...(chosen ? { checked: true } : {}) }} disabled={disabled} onPress={onPress}
    onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: mobile ? px(44) : px(32), paddingHorizontal: px(10), borderRadius: px(6), flexDirection: 'row', alignItems: 'center', gap: px(8),
      backgroundColor: look.backgroundColor, opacity: disabled && !chosen ? .4 : 1 }}>
    {!!icon && <Icon name={icon} size={px(14)} color={c.foregroundMuted} />}
    <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: mobile ? px(14) : px(13), fontWeight: chosen ? '600' : '400' }}>{label}</Text>
    {chosen && <Icon name="Check" size={px(14)} color={c.foreground} />}
  </Pressable>;
}
/** REQ-85 ⑧ (⑧B): the stages as they are, a line, then "Copy card ID" — the same list in the dropdown and the sheet. */
function MenuItems(props: MenuProps & { background: string; mobile: boolean }) {
  const { board, cardId, colors: c, m, busy, onPick, onCopy, background, mobile } = props;
  const card = board.stages.flatMap(stage => stage.cards).find(value => value.id === cardId)!;
  const stages = board.template.stages;
  return <>
    {card.intent === 'draft' && <Notice text={m.draftRule(dispatchStage(stages)?.name ?? '')} colors={c} />}
    {stages.map(stage => {
      const current = stage.stageId === card.stageId;
      return <MenuRow key={stage.stageId} testID={'move-to-' + stage.stageId} colors={c} background={background} mobile={mobile} chosen={current}
        label={current ? stage.name + ' · ' + m.currentStage : stage.name}
        disabled={current || busy || !stageAllowed(stages, card.intent, stage.stageId)} onPress={() => onPick(stage.stageId)} />;
    })}
    <View testID="menu-divider" style={{ height: px(1), marginVertical: px(4), backgroundColor: c.border }} />
    <MenuRow testID="copy-card-id" icon="Copy" label={m.copyCardId} colors={c} background={background} mobile={mobile} onPress={onCopy} />
    <LeadRow lead={props.lead} colors={c} m={m} background={background} mobile={mobile} />
  </>;
}
/** REQ-96: "Go to agent ↗" (or "Go to workspace ↗") atop the card's menu, then a line; nothing where there is nowhere to go. */
function JumpRow({ jump, onJump, colors: c, m, background, mobile }: MenuProps & { background: string; mobile: boolean }) {
  if (!jump) return null;
  return <>
    <MenuRow testID="card-menu-jump" icon="SquareArrowOutUpRight" label={jump.kind === 'agent' ? m.goToAgent : m.goToWorkspace}
      colors={c} background={background} mobile={mobile} onPress={() => onJump(jump.go)} />
    <View style={{ height: px(1), marginVertical: px(4), backgroundColor: c.border }} />
  </>;
}
/** REQ-82 ③: the card's stages; the current one is marked and cannot be picked, a draft offers only the first. */
function StageMenu(props: MenuProps & { platform: HostPlatform; mobile: boolean }) {
  const { board, cardId, m, platform, mobile, onClose } = props;
  const card = board.stages.flatMap(stage => stage.cards).find(value => value.id === cardId);
  if (!card) return null;
  return <MenuSheet title={m.moveMenu(card.title)} open onClose={onClose} colors={props.colors} platform={platform} closeLabel={m.close}>{sc => <>
    <JumpRow {...props} colors={sc} background={sc.surface0} mobile={mobile} />
    <MenuItems {...props} colors={sc} background={sc.surface0} mobile={mobile} />
  </>}</MenuSheet>;
}
/**
 * REQ-85 ⑧ (⑧B): on a wide screen the ⋯ opens a small menu right under it, like the card order's — "Move to stage"
 * over the stages, a line, "Copy card ID". Escape or a press outside closes it; the focus goes back to the ⋯.
 */
function StageDropdown(props: MenuProps & { anchor: NonNullable<MenuOrigin['anchor']> }) {
  const { board, cardId, colors: c, m, anchor, onClose } = props;
  const card = board.stages.flatMap(stage => stage.cards).find(value => value.id === cardId);
  const viewport = useWindowDimensions(), rows = board.template.stages.length + 4 + (props.jump ? 1 : 0);
  const below = dropdownPosition(anchor, viewport, rows, px(34));
  // REQ-137: with the lead row and its line the menu is taller than a dropdown's usual cap (280): it takes the height it needs,
  // kept inside the window, so nothing hangs below its outline.
  const need = Math.min(rows * px(34) + px(30), viewport.height - px(16));
  const tall = need > below.maxHeight ? { maxHeight: viewport.height - px(16), top: Math.max(px(8), Math.min(below.top, viewport.height - need - px(8))) } : {};
  const position = { ...below, ...tall, left: Math.max(px(8), Math.min(anchor.x + anchor.width - below.width, viewport.width - below.width - px(8))) };
  if (!card) return null;
  return <Modal testID="card-menu-modal" visible transparent animationType="none" onRequestClose={onClose}>
    <View style={{ flex: 1 }} onAccessibilityEscape={onClose}>
      <Pressable testID="card-menu-dismiss" accessibilityRole="button" accessibilityLabel={m.close} onPress={onClose}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <View testID="card-menu" accessibilityRole="menu" accessibilityLabel={m.moveMenu(card.title)} style={{ position: 'absolute', ...position,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, borderRadius: px(8), padding: px(4), gap: px(2) }}>
        <JumpRow {...props} background={c.surface1} mobile={false} />
        <Text style={{ color: readable(c.foregroundMuted, c.surface1), fontSize: px(11), paddingHorizontal: px(10), paddingTop: px(4), paddingBottom: px(2) }}>{m.moveSection}</Text>
        <MenuItems {...props} background={c.surface1} mobile={false} />
      </View>
    </View>
  </Modal>;
}

/**
 * REQ-82: "Moved to Done · Undo", at the bottom of the screen for the time it takes to change one's mind
 * (`MOVE_TOAST_MS`), or the reason a move did not happen. A screen reader hears it as it appears.
 */
export function MoveToast({ text, error = false, onUndo, onClose, colors: c, m, bottom = 0, mobile = false, inline = false, selectable }: {
  text: string; error?: boolean; onUndo?: (() => void) | undefined; onClose: () => void; colors: Palette; m: Copy;
  bottom?: number; mobile?: boolean;
  /** REQ-85 ⑧: words to select by hand under the message (the card id a copy could not place). */
  selectable?: string | undefined;
  /** In the detail sheet the notice sits in the flow under the stage bar, not over the screen. */
  inline?: boolean;
}) {
  const back = c.surface2;
  const body = <View testID="move-toast" accessibilityRole={error ? 'alert' : 'text'} accessibilityLiveRegion="polite"
    style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), maxWidth: px(520), minHeight: mobile ? px(48) : px(40), paddingLeft: px(12),
      paddingRight: px(4), borderRadius: px(8), borderWidth: 1, borderColor: c.border, backgroundColor: back,
      ...(inline ? { alignSelf: 'stretch' as const } : { shadowColor: c.cardShadow, shadowOpacity: .18, shadowRadius: px(8),
        shadowOffset: { width: 0, height: px(2) }, elevation: 4 }) }}>
    <View style={{ flex: 1, flexShrink: 1, paddingVertical: selectable ? px(6) : 0, gap: px(2) }}>
      <Text testID="move-toast-text" style={{ fontSize: px(13), color: error ? readable(c.statusDanger, back) : c.foreground }}>{text}</Text>
      {!!selectable && <Text testID="move-toast-selectable" selectable style={{ fontSize: px(13), color: c.foreground,
        fontFamily: 'monospace', ...({ userSelect: 'text' } as object) }}>{selectable}</Text>}
    </View>
    {onUndo && <Pressable testID="move-undo" accessibilityRole="button" accessibilityLabel={m.undo} onPress={onUndo}
      hitSlop={mobile ? px(6) : 0} style={{ minHeight: mobile ? px(36) : px(30), paddingHorizontal: px(10), justifyContent: 'center', borderRadius: px(6) }}>
      <Text style={{ color: readable(c.accent, back), fontSize: px(13), fontWeight: '600' }}>{m.undo}</Text>
    </Pressable>}
    <IconButton testID="move-toast-close" name="X" label={m.close} onPress={onClose} colors={c} mobile={mobile} plain />
  </View>;
  if (inline) return body;
  return <View pointerEvents="box-none" style={{ position: 'absolute', left: px(12), right: px(12), bottom: bottom + 12, alignItems: 'center', zIndex: 30 }}>
    {body}
  </View>;
}

/**
 * REQ-82 ④ → REQ-88 ④ (research/129 ④A): every stage of the card's template as a flow — pills joined by thin lines, as wide
 * as they are (never stretched to the window's edge). The stages before the current one in the template's order carry a ✓
 * and plain words, their joining line one step darker; the current one alone is tinted (REQ-85 `selectedTint`, no line)
 * with bold words; the ones after are quiet. Pressing another stage moves the card at once (REQ-82 ④, unchanged); a stage
 * it cannot go to is faded. Up to four stages sit on one line; five or more scroll sideways. `compact`, the smaller flow of
 * the wide detail's side panel, scrolled at any count until 0.1.51, so English names ("To Do – In progress – Review") hid
 * "Done" under the fade; REQ-136 H5: up to four now wrap onto a second line instead (each joining line goes with the stage
 * after it, so a line never ends on a dangling joint), every stage, its ✓ and the current one's tint in sight at once.
 *
 * G2: a bar that scrolls opens with the current stage in view (centred when it would be cut off), and an edge
 * with more stages beyond it fades out under a chevron — pressing the chevron scrolls that way — so a phone shows
 * that there is more than it can fit.
 */
export const STEP = scaled({ height: 28, compactHeight: 26, mobileHeight: 32, touch: 44, line: 1.5, lineWidth: 12, compactLineWidth: 6 } as const, ['line']);
export function StageBar({ stages, current, allowed, disabled, onPick, colors: c, m, mobile, background, compact = false }: {
  stages: readonly { stageId: string; name: string }[]; current: string; allowed: (stageId: string) => boolean;
  disabled: boolean; onPick: (stageId: string) => void; colors: Palette; m: Copy; mobile: boolean; background: string; compact?: boolean;
}) {
  const fit = stages.length <= 4, wrap = fit && compact, at = stages.findIndex(stage => stage.stageId === current);
  const height = mobile ? STEP.mobileHeight : compact ? STEP.compactHeight : STEP.height;
  const [hovered, setHovered] = useState<string | null>(null);
  const scroller = useRef<NativeScrollView>(null);
  const view = useRef({ width: 0, content: 0, x: 0 }), spots = useRef(new Map<string, { x: number; width: number }>());
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = () => { const { width, content, x } = view.current;
    const next = { start: x > 1, end: width > 0 && x + width < content - 1 };
    setEdges(value => value.start === next.start && value.end === next.end ? value : next); };
  const scrollTo = (x: number) => { const { width, content } = view.current;
    view.current.x = Math.max(0, Math.min(content - width, x)); scroller.current?.scrollTo({ x: view.current.x, animated: false }); measure(); };
  // The current stage, once its place and the bar's width are known, and again whenever it changes.
  const shown = useRef('');
  const reveal = () => {
    const spot = spots.current.get(current), { width, x } = view.current;
    if (fit || !spot || !width || !view.current.content || shown.current === current) return;
    shown.current = current;
    if (spot.x < x || spot.x + spot.width > x + width) scrollTo(spot.x - (width - spot.width) / 2); else measure();
  };
  useEffect(reveal, [current]);
  const passed = readable(c.foregroundMuted, background, 3), quiet = fieldLine(c, background);
  const joint = (index: number) => <View key={'line-' + index} testID="stage-flow-line" accessibilityElementsHidden importantForAccessibility="no"
    style={{ width: compact ? STEP.compactLineWidth : STEP.lineWidth, height: STEP.line, alignSelf: 'center',
      backgroundColor: at >= 0 && index <= at ? passed : quiet }} />;
  const row = <View testID="stage-bar" accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.stage}
    style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', ...(wrap ? { flexWrap: 'wrap', rowGap: px(6), flexShrink: 1, minWidth: 0, maxWidth: '100%' } : {}) }}>
    {stages.flatMap((stage, index) => {
      const selected = stage.stageId === current, done = at >= 0 && index < at;
      const off = disabled || (!selected && !allowed(stage.stageId)), lit = hovered === stage.stageId && !off && !mobile;
      const face = selected ? selectedTint(c, background, lit) : lit ? hoverFill(c, background) : background;
      const pill = <Pressable key={stage.stageId} testID={'stage-bar-' + stage.stageId} accessibilityRole="radio" role="radio"
        aria-checked={selected} accessibilityLabel={stage.name} accessibilityHint={done ? m.stepDone(stage.name) : undefined}
        accessibilityState={{ checked: selected, disabled: off }}
        disabled={off} onPress={() => { if (!selected) onPick(stage.stageId); }}
        onHoverIn={() => setHovered(stage.stageId)} onHoverOut={() => setHovered(value => value === stage.stageId ? null : value)}
        {...(fit ? {} : { onLayout: (event: LayoutChangeEvent) => {
          const { x, width } = event.nativeEvent.layout; spots.current.set(stage.stageId, { x, width }); reveal(); } })}
        hitSlop={mobile ? { top: (STEP.touch - height) / 2, bottom: (STEP.touch - height) / 2 } : undefined}
        style={{ height, paddingHorizontal: compact ? px(7) : px(10), borderRadius: height / 2, flexDirection: 'row', alignItems: 'center', gap: px(3),
          opacity: off && !selected ? .4 : 1, borderWidth: 1, borderColor: selected ? 'transparent' : quiet, backgroundColor: face,
          ...(mobile ? { marginVertical: (STEP.touch - height) / 2 } : {}) }}>
        {done && <Icon name="Check" size={compact ? px(11) : px(12)} color={c.foreground} />}
        <Text numberOfLines={1} style={{ color: selected || done ? c.foreground : readable(c.foregroundMuted, face),
          fontSize: compact ? px(12) : px(13), fontWeight: selected ? '600' : '400' }}>{stage.name}</Text>
      </Pressable>;
      if (wrap && index) return [<View key={'step-' + stage.stageId} testID="stage-bar-step" style={{ flexDirection: 'row', alignItems: 'center' }}>{joint(index)}{pill}</View>];
      return index ? [joint(index), pill] : [pill];
    })}
  </View>;
  if (fit) return row;
  // The fade: the bar's own background, thicker toward the edge, then a chevron over it.
  const edge = (side: 'start' | 'end') => <Pressable testID={'stage-bar-more-' + side} accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants" focusable={false}
    onPress={() => scrollTo(view.current.x + (side === 'end' ? 1 : -1) * view.current.width * .7)}
    style={{ position: 'absolute', top: 0, bottom: 0, width: px(36), [side === 'end' ? 'right' : 'left']: 0,
      flexDirection: side === 'end' ? 'row' : 'row-reverse', alignItems: 'center' }}>
    {[.35, .7].map(opacity => <View key={opacity} style={{ width: px(8), alignSelf: 'stretch', backgroundColor: background, opacity }} />)}
    <View style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', backgroundColor: background }}>
      <Icon name={side === 'end' ? 'ChevronRight' : 'ChevronLeft'} size={px(16)} color={readable(c.foregroundMuted, background, 3)} />
    </View>
  </Pressable>;
  return <View testID="stage-bar-frame" style={{ flexShrink: 1, minWidth: 0, maxWidth: '100%' }}>
    <ScrollView horizontal ref={scroller} testID="stage-bar-scroll" showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingRight: px(4) }} scrollEventThrottle={16}
      onLayout={event => { view.current.width = event.nativeEvent.layout.width; reveal(); measure(); }}
      onContentSizeChange={width => { view.current.content = width; reveal(); measure(); }}
      onScroll={event => { view.current.x = event.nativeEvent.contentOffset.x; measure(); }}>{row}</ScrollView>
    {edges.start && edge('start')}
    {edges.end && edge('end')}
  </View>;
}
