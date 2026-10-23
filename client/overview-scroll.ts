import { useLayoutEffect, useRef, type RefObject } from 'react';

type WorkspaceAnchor = { key: string; offset: number; following: string[] };

/** Owned by one mounted OverviewScreen, separately for each host/demo/layout. Never persisted. */
export interface OverviewScrollMemory {
  position?: { y: number; anchor?: WorkspaceAnchor };
}
type BoxNode = { getBoundingClientRect: () => { top: number; bottom: number } };
type WebScroll = BoxNode & { scrollTop: number; scrollHeight: number; clientHeight: number; isConnected?: boolean };
type ScrollHandle = { getScrollableNode?: () => unknown; scrollTo?: (options: { y: number; animated: boolean }) => void };

/**
 * RN Web ignores contentOffset on mount. Each committed layout owns one restoration generation.
 * Wait for a painted layout, restore once, then record only that live scroll view's events.
 * RN Web may deliver its final scroll event after unmount; it must not erase the saved position.
 */
export function useOverviewScroll(memory: OverviewScrollMemory | undefined, scroll: RefObject<unknown>, ready: boolean) {
  const pending = useRef(!!memory), frame = useRef<number | null>(null);
  const active = useRef(false), owner = useRef<OverviewScrollMemory | undefined>(undefined), generation = useRef(0);
  const restoring = useRef<{ generation: number; y: number } | null>(null);
  const lanes = useRef(new Map<string, BoxNode>());
  const callbacks = useRef(new Map<string, (node: unknown) => void>());
  const currentReady = useRef(ready);
  const owns = () => active.current && owner.current === memory;
  const valid = (ticket: number) => owns() && generation.current === ticket && currentReady.current;
  const node = (): WebScroll | null => {
    const handle = scroll.current as ScrollHandle | null;
    const inner = (handle?.getScrollableNode?.() ?? handle) as WebScroll | null;
    return inner && inner.isConnected !== false && typeof inner.scrollTop === 'number'
      && typeof inner.getBoundingClientRect === 'function' ? inner : null;
  };
  const remember = (y: number) => {
    if (!memory || !owns()) return;
    const area = node();
    // Ignore detached scroll-end timers and stale values, including events before restoration.
    if (!area || area.clientHeight <= 0 || Math.abs(area.scrollTop - y) > 1) return;
    if (pending.current) {
      const applied = restoring.current;
      if (!applied || !valid(applied.generation) || Math.abs(area.scrollTop - applied.y) > 1) return;
      pending.current = false;
      restoring.current = null;
    }
    const top = area.getBoundingClientRect().top;
    let anchor: WorkspaceAnchor | undefined;
    if (y > 0) {
      const rows = Array.from(lanes.current, ([key, lane]) => ({ key, box: lane.getBoundingClientRect() }))
        .filter(row => row.box.bottom > row.box.top).sort((a, b) => a.box.top - b.box.top);
      const index = rows.findIndex(row => row.box.bottom > top), first = rows[index];
      if (first) anchor = { key: first.key, offset: top - first.box.top, following: rows.slice(index + 1).map(row => row.key) };
    }
    memory.position = { y: area.scrollTop, ...(anchor ? { anchor } : {}) };
  };
  const cancel = () => {
    generation.current++;
    restoring.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const schedule = () => {
    if (!memory || !owns() || !pending.current || !currentReady.current || !node()) return;
    cancel();
    const ticket = generation.current;
    const queue = (run: () => void) => {
      frame.current = requestAnimationFrame(() => {
        // A canceled callback may already have been queued. Do not even clear the newer frame id.
        if (!valid(ticket) || !pending.current) return;
        frame.current = null;
        run();
      });
    };
    // One paint separates the committed layout from the imperative restore. A newer layout or
    // content-size event invalidates both stages, so a transient 0px layout never becomes memory.
    queue(() => queue(() => {
      const area = node();
      if (!area || area.clientHeight <= 0) return;
      const saved = memory.position;
      let target = saved?.y ?? 0;
      const key = saved?.anchor && [saved.anchor.key, ...saved.anchor.following].find(key => lanes.current.has(key));
      const lane = key !== undefined ? lanes.current.get(key) : undefined;
      if (lane && saved?.anchor) {
        const box = lane.getBoundingClientRect();
        const offset = saved.anchor.offset < box.bottom - box.top ? saved.anchor.offset : 0;
        target = area.scrollTop + box.top - area.getBoundingClientRect().top + offset;
      }
      target = Math.max(0, Math.min(target, area.scrollHeight - area.clientHeight));
      restoring.current = { generation: ticket, y: target };
      (scroll.current as ScrollHandle | null)?.scrollTo?.({ y: target, animated: false });
      // Mark restoration complete only when the live DOM confirms the requested/clamped position.
      // An asynchronous host scrollTo can acknowledge it through the subsequent onScroll instead.
      remember(target);
    }));
  };
  useLayoutEffect(() => {
    active.current = true; owner.current = memory; pending.current = !!memory;
    cancel();
    return () => { active.current = false; cancel(); };
  }, [memory]);
  useLayoutEffect(() => { currentReady.current = ready; schedule(); });
  return {
    remember, onLayout: schedule, onContentSizeChange: schedule,
    laneRef: (key: string) => {
      let callback = callbacks.current.get(key);
      if (!callback) {
        callback = (value: unknown) => {
          const lane = value as BoxNode | null;
          if (typeof lane?.getBoundingClientRect === 'function') lanes.current.set(key, lane);
          else lanes.current.delete(key);
        };
        callbacks.current.set(key, callback);
      }
      return memory ? callback : undefined;
    },
  };
}
