import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import type { Stage } from '../shared/core/domain.js';
import type { Palette } from './palette.js';
import { selectedLine } from './palette.js';
import type { Copy } from './i18n.js';
import { CardTile } from './components.js';
import { TipLayer } from './group-header.js';
import { inFocus, openIds, type LinkedCard as Linked } from './card-groups.js';
import { useLeadStatus } from './agent-signals.js';
import { useSignalSource } from './signal-context.js';
import { useMinuteClock } from './minute-clock.js';
import { statusIds, type LeadStatusKind } from './lead-status.js';
import { FreshCardContext } from './fresh-card.js';
import { px } from './ui-scale.js';

/**
 * REQ-93 (research/141 C): a card in its own stage's column, with what ties it to its family (`card-groups.ts`). A
 * sub-card's face says its parent ("↳ Lead-02", `CardTile`'s mark); a parent says in its last row how many sub-cards it
 * has and how many are not done ("Sub-cards 5 · not done 2", REQ-99; under the card before) — nothing folded under it — and is outlined in its stage's
 * colour, with a crown before its title (REQ-95). Pressing either the mark or that line highlights the family on this board (C′): the parent and its
 * sub-cards get a ring in the main colour, the board's other cards step back. Pressing it again, or a tap on an empty spot
 * (not a card, not a control), ends it; scrolling and switching stage tabs keep it, so the family can be looked for.
 *
 * REQ-104: under that line a parent has its status row — its sub-cards at work, its check under way, its sub-cards waiting
 * for you (`lead-status.ts`). Pressing a part highlights the parent and just those cards, with the same ring.
 *
 * REQ-109: the family line is two presses — "Sub-cards N" (with its tree) the whole family, "not done M" the parent and
 * its sub-cards in any stage but done (`openIds`), a done column's left folded. Whatever a highlight opened behind "+N"
 * folds back when it ends (the screens' `conceal`, `concealFamily`).
 *
 * A sub-card is a card like any other: it opens its detail, offers "Done" when its agent is archived, and has the
 * stage menu (⋯, or a long press on a phone).
 */
export function LinkedCard({ card, stages, countsAsDone, boardId, labels, colors: c, m, onOpen, mobile = false }: {
  card: Linked; stages: readonly Stage[]; countsAsDone: boolean; boardId?: string; labels: Record<string, string>;
  /** REQ-130: `lead` — the card has a lead's status row, so its detail offers the one-line memo. */
  colors: Palette; m: Copy; onOpen: (cardId: string, lead?: boolean) => void; mobile?: boolean;
}) {
  const family = useContext(FamilyFocusContext), board = boardId ?? '';
  const focus = family.focus && family.focus.boardId === board ? family.focus : null;
  // null: no family of this board is highlighted; else whether this card is in it (REQ-104: in the part pressed).
  const lit = focus ? inFocus(card, focus.parentId, focus.part?.ids) : null, whole = lit === true && !focus?.part;
  // REQ-117: a topic lead's sub-card names the topic lead (`subParent`), the one its mark then highlights.
  const parent = card.subParent ?? card.parent;
  const status = useLeadStatus(useSignalSource(), card.crew, card, stages, useMinuteClock());
  const part = focus?.parentId === card.id ? focus.part?.kind ?? null : null;
  // REQ-109: the family line is two presses — "Sub-cards N" (the whole family) and "not done M" (those sub-cards alone).
  const summaryOn = focus?.parentId !== card.id ? null : !focus.part ? 'all' as const : part === 'open' ? 'open' as const : null;
  // research/187 J3: a draft just made rings for two seconds; drawn, it asks the screen to bring it into sight.
  const fresh = useContext(FreshCardContext), ringed = fresh.cardId === card.id, freshRing = useRef<View>(null);
  useEffect(() => { if (ringed) fresh.shown(freshRing.current); }, [ringed]);
  const tile = <CardTile stages={stages} card={card} labels={labels} countsAsDone={countsAsDone} {...(boardId ? { boardId } : {})}
    colors={c} m={m} onPress={() => onOpen(card.id, !!card.crew)} familyHead={!!card.family} topicLead={!!card.subLead} designated={!!card.designated}
    {...(parent ? { parentMark: { title: parent.title, on: whole, onPress: () => family.toggle(board, parent.id) } } : {})}
    {...(card.family ? { familySummary: { total: card.family.total, open: card.family.open, on: summaryOn, mobile,
      onPress: () => family.toggle(board, card.id),
      onPressOpen: () => family.toggle(board, card.id, { kind: 'open', ids: openIds(card, stages) }) } } : {})}
    {...(status ? { leadStatus: { status, on: part === 'open' ? null : part, mobile,
      onPress: (kind: LeadStatusKind) => family.toggle(board, card.id, { kind, ids: statusIds(status, kind) }) } } : {})} />;
  // The ring is drawn over the card, never around it, so the card is not re-mounted. REQ-99: the card is all it rings.
  // REQ-86: lifted over the next card while the card's hint shows (`TipLayer`), on the board and a phone too.
  return <TipLayer testID={'linked-card-' + card.id} style={lit === false ? { opacity: FAMILY_DIM } : {}}>
    {tile}
    {lit && <View testID="family-highlight" pointerEvents="none" style={familyRing(c)} />}
    {ringed && <View ref={freshRing} testID="fresh-highlight" pointerEvents="none" style={familyRing(c)} />}
  </TipLayer>;
}
/** REQ-93 C′: how far the board's other cards step back while a family is highlighted. */
export const FAMILY_DIM = .45;
/**
 * REQ-93 C′: the ring around a highlighted card — 2px in the main colour (`selectedLine`, ≥3.5:1 on the column), 2px out
 * from the card, so it never takes the card's own 1px edge (REQ-95's stage line on a parent) or its face (REQ-85 ⑨'s tint).
 */
export const RING_GAP = 2, RING_WIDTH = 2;
export function familyRing(c: Palette) {
  const out = -(RING_GAP + RING_WIDTH);
  return { position: 'absolute' as const, top: out, left: out, right: out, bottom: out, borderWidth: RING_WIDTH, borderRadius: px(8) + RING_GAP + RING_WIDTH,
    borderColor: selectedLine(c, c.panel) };
}
/**
 * REQ-93 C′: which family is highlighted, one screen at a time. `toggle` is the mark's or the summary's press (the same
 * one again ends it). REQ-104: or a part of a parent's status row — the parent and the cards it named when pressed.
 */
export interface FamilyFocus { boardId: string; parentId: string; part?: FocusPart }
/** REQ-109: 'open' — the family line's "not done M", its sub-cards in any stage but done. */
export interface FocusPart { kind: LeadStatusKind | 'open'; ids: readonly string[] }
export interface FamilyFocusValue { focus: FamilyFocus | null; toggle: (boardId: string, parentId: string, part?: FocusPart) => void }
export const FamilyFocusContext = createContext<FamilyFocusValue>({ focus: null, toggle: () => {} });
/**
 * What a click on the web leaves the highlight to: the family toggles themselves (they decide), a card (it opens its
 * detail) and every control — a stage tab, "+N", ⇕, the top bar's glyphs.
 */
const KEEPS = '[data-testid="family-mark"],[data-testid="family-summary"],[data-testid^="lead-status-"],[data-testid^="linked-card-"],button,a,input,textarea,select,'
  + '[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="switch"],[role="checkbox"]';
type Doc = { addEventListener(type: string, run: (event: { target?: unknown }) => void, capture: boolean): void;
  removeEventListener(type: string, run: (event: { target?: unknown }) => void, capture: boolean): void };
/** A phone app screen root's touch handling for the highlight (empty on the web, which listens to the page instead). */
export type FamilyResponder = { onStartShouldSetResponder?: () => boolean; onResponderTerminationRequest?: () => boolean;
  onResponderRelease?: () => void; onResponderTerminate?: () => void };
/**
 * A screen's highlighted family. REQ-93 (보완): only a tap on an empty spot ends it — scrolling to find the family's other
 * cards, a stage tab, "+N" or a card keep it. On the web a click listener on the page (a touch that scrolls makes no
 * click). On a phone app the screen root becomes a touch's responder only when nothing inside took it — a card and every
 * control are pressables that do — and a scroll view taking the touch over (`onResponderTerminate`) is no tap.
 * `reveal` hears of each family turned on, so the screen can open the columns that cut it off (`revealFamily`).
 * REQ-109: `conceal` hears of each one ending — pressed again, an empty spot, another turned on in its place, or the
 * screen closed while it is on — so the screen can fold back what `reveal` opened (`concealFamily`), before the next one's.
 */
export function useFamilyFocus(reveal?: (focus: FamilyFocus) => void, conceal?: (focus: FamilyFocus) => void):
  { value: FamilyFocusValue; responder: FamilyResponder } {
  const [focus, setFocus] = useState<FamilyFocus | null>(null);
  const current = useRef<FamilyFocus | null>(null), revealRef = useRef(reveal), concealRef = useRef(conceal);
  revealRef.current = reveal; concealRef.current = conceal;
  const set = useCallback((next: FamilyFocus | null) => {
    const previous = current.current;
    current.current = next; setFocus(next);
    if (previous && previous !== next) concealRef.current?.(previous);
  }, []);
  useEffect(() => () => { if (current.current) concealRef.current?.(current.current); }, []);
  useEffect(() => {
    const doc = (globalThis as { document?: Doc }).document;
    if (!focus || !doc || typeof doc.addEventListener !== 'function') return undefined;
    const run = (event: { target?: unknown }) => {
      const target = event.target as { closest?: (selector: string) => unknown } | null;
      if (!target?.closest?.(KEEPS)) set(null);
    };
    doc.addEventListener('click', run, true);
    return () => doc.removeEventListener('click', run, true);
  }, [focus, set]);
  const toggle = useCallback((boardId: string, parentId: string, part?: FocusPart) => {
    const now = current.current;
    const same = !!now && now.boardId === boardId && now.parentId === parentId && now.part?.kind === part?.kind;
    const next = same ? null : { boardId, parentId, ...(part ? { part } : {}) };
    set(next);
    if (next) revealRef.current?.(next);
  }, [set]);
  const responder = useMemo<FamilyResponder>(() => Platform.OS === 'web' ? {} : {
    onStartShouldSetResponder: () => current.current !== null,
    onResponderTerminationRequest: () => true,
    onResponderRelease: () => set(null),
    onResponderTerminate: () => {},
  }, [set]);
  const value = useMemo(() => ({ focus, toggle }), [focus, toggle]);
  return { value, responder };
}
