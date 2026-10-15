import { useCallback, useSyncExternalStore } from 'react';

/*
 * REQ-73: one clock for every card's age. It ticks once a minute while any card is on screen, so an age
 * moves from "just now" to "1m ago" without a refresh, and it never keeps a test process alive.
 */
let minuteNow = Date.now();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
const minuteListeners = new Set<() => void>();
function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener);
  if (!minuteTimer) {
    minuteNow = Date.now();
    minuteTimer = setInterval(() => { minuteNow = Date.now(); for (const notify of [...minuteListeners]) notify(); }, 60000);
    (minuteTimer as { unref?: () => void }).unref?.();
  }
  return () => {
    minuteListeners.delete(listener);
    if (!minuteListeners.size && minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
  };
}
export function useMinuteClock(): number { return useSyncExternalStore(subscribeMinute, () => minuteNow, () => minuteNow); }
/**
 * Research/174 D2: a string read off the same clock that re-renders only when it changes (not every minute), and follows
 * no clock at all while `active` is false.
 */
export function useMinuteKey(read: (now: number) => string, active: boolean): string {
  const subscribe = useCallback((listener: () => void) => active ? subscribeMinute(listener) : () => {}, [active]);
  const snapshot = () => read(active ? minuteNow : Date.now());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
