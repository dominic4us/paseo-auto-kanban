import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import { revealCard, type LaneStates, type LaneView } from './swimlane-model.js';

/**
 * research/187 J3: a draft just made from a To Do "+" (or, on a phone, a lane's ⋯) could sit behind its column's "+N" —
 * after the leads, which come first (REQ-95 ⑤), or last in the default order. Once the board read has it, its column
 * opens as far as it needs, five at a time (`revealCard`), the screen brings it into sight and a ring shows it for two
 * seconds. A draft the screen's filters leave out is not looked for past `FRESH_WAIT_MS`.
 */
export const FRESH_RING_MS = 2000;
export const FRESH_WAIT_MS = 10000;
export interface FreshCard { cardId: string | null; shown: (node: unknown) => void }
export const FreshCardContext = createContext<FreshCard>({ cardId: null, shown: () => {} });
type Lane = Pick<LaneView, 'board' | 'cells' | 'collapsed'>;
/**
 * `lanes`: every lane the screen's model has. `onStage`: the stage the draft is in, told while it is looked for (a phone
 * moves to its tab). `scroll`: brings the ringed card's node into sight.
 */
export function useFreshCard({ lanes, setLanes, attention, onStage, scroll }: {
  lanes: readonly Lane[]; setLanes: (update: (states: LaneStates) => LaneStates) => void; attention: boolean;
  onStage?: (stageId: string) => void; scroll: (node: unknown) => void;
}) {
  const [pending, setPending] = useState<{ boardId: string; cardId: string } | null>(null);
  const [ring, setRing] = useState<string | null>(null);
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), FRESH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!pending) return;
    const lane = lanes.find(l => l.board.summary.id === pending.boardId);
    const cell = lane?.cells.find(c => c.matching.some(card => card.id === pending.cardId));
    if (!lane || !cell) return;
    onStage?.(cell.stageId);
    if (lane.collapsed || !cell.cards.some(card => card.id === pending.cardId)) {
      setLanes(states => revealCard(states, lane, pending.cardId, attention));
      return;
    }
    setPending(null); setRing(pending.cardId);
  }, [pending, lanes]);
  useEffect(() => {
    if (!ring) return;
    const timer = setTimeout(() => setRing(null), FRESH_RING_MS);
    return () => clearTimeout(timer);
  }, [ring]);
  return {
    /** The draft `CreateDraft` just saved (`onSaved`). */
    created: (boardId: string, cardId: string) => { setRing(null); setPending({ boardId, cardId }); },
    value: useMemo<FreshCard>(() => ({ cardId: ring, shown: node => scrollRef.current(node) }), [ring]),
  };
}
type Box = { top: number; height: number };
type Measurable = { measureInWindow?: (done: (x: number, y: number, width: number, height: number) => void) => void;
  getBoundingClientRect?: () => { top: number; height: number }; getScrollableNode?: () => unknown;
  scrollTo?: (options: { y: number; animated: boolean }) => void; scrollTop?: number };
function measure(target: unknown, done: (box: Box) => void) {
  const node = target as Measurable | null;
  if (typeof node?.measureInWindow === 'function') { node.measureInWindow((_x, top, _w, height) => done({ top, height })); return; }
  const inner = (typeof node?.getScrollableNode === 'function' ? node.getScrollableNode() : node) as Measurable | null;
  if (typeof inner?.getBoundingClientRect === 'function') { const { top, height } = inner.getBoundingClientRect(); done({ top, height }); }
}
/**
 * Scrolls `scroller` (a vertical ScrollView at `offset`) so `node` shows under the `headroom` the pinned headings take at
 * its top — only when it is not in sight already.
 */
export function bringIntoView(scroller: unknown, node: unknown, offset: number, headroom: number) {
  const view = scroller as Measurable | null;
  if (typeof view?.scrollTo !== 'function') return;
  measure(scroller, area => measure(node, card => {
    if (card.top >= area.top + headroom && card.top + card.height <= area.top + area.height) return;
    const inner = (typeof view.getScrollableNode === 'function' ? view.getScrollableNode() : null) as Measurable | null;
    const from = typeof inner?.scrollTop === 'number' ? inner.scrollTop : offset;
    view.scrollTo!({ y: Math.max(0, from + card.top - area.top - headroom), animated: true });
  }));
}
