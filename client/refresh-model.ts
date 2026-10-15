/**
 * REQ-62: the 0.9.1 SDK has no server → screen push, so an open screen asks the light `revisions.get`
 * whether the ledger moved (another agent's or a person's `kanban` CLI, REQ-61 auto cards). It asks only
 * while it is mounted and in the foreground, stops after `idleMs` without any touch, click, scroll or key
 * (zero requests from then on), and asks once at once when someone comes back. Tests shorten the values.
 */
export const AUTO_REFRESH = { intervalMs: 4000, idleMs: 180_000, minGapMs: 1000 };

export interface RevisionsReply {
  boards: readonly { id: string; revision: string; groups?: string | undefined; busy?: string | undefined }[];
  errors: readonly { target: string }[];
}
/**
 * `all`: the reply lists every board, so a board that appeared or vanished is a change too.
 * `listed`: the reply covers only the boards asked for. `appeared`: the screen has no board yet (a
 * workspace without a ledger) and only waits for a board id it has not seen before.
 * A board that failed to read is neither changed nor gone; the screen already shows that error.
 */
export type RevisionScope = 'all' | 'listed' | 'appeared';
export function revisionsChanged(known: Readonly<Record<string, string>>, reply: RevisionsReply, scope: RevisionScope): boolean {
  const failed = new Set(reply.errors.map(e => e.target));
  const seen = new Set<string>();
  for (const board of reply.boards) {
    seen.add(board.id);
    const before = known[board.id];
    if (before === undefined) { if (scope !== 'listed') return true; }
    else if (before !== shownRevision(board)) return true;
  }
  if (scope === 'appeared') return false;
  return Object.keys(known).some(id => !seen.has(id) && !failed.has(id));
}

interface Timers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
/**
 * The clock and timers a screen's poller runs on when none is given — the real ones. H6 (research/133): a test swaps in
 * a hand-driven clock here, so its looks are counted by the clock it moves, not by how busy the machine is.
 */
export const POLL_CLOCK: { now: () => number; timers: Timers } = { now: () => Date.now(), timers: realTimers };
/**
 * REQ-66: what the screen says about the auto refresh. `live` while a look is waiting or running;
 * otherwise paused (3 minutes without a touch, or the screen hidden) since the last finished look.
 */
export type RefreshStatus = { live: true } | { live: false; lastLook: number };
/**
 * The timing alone, without React or the SDK. One timer at a time and never two checks in flight:
 * the next wait starts only after a check has finished. `onStatus` hears only the changes between live
 * and paused — never every look — so a screen that shows the status re-renders a few times per pause.
 */
export function createPoller({ check, now = POLL_CLOCK.now, timers = POLL_CLOCK.timers, visible = true, config = AUTO_REFRESH, onStatus }: {
  check: () => Promise<unknown>; now?: () => number; timers?: Timers; visible?: boolean;
  config?: { intervalMs: number; idleMs: number; minGapMs: number }; onStatus?: (status: RefreshStatus) => void;
}) {
  let timer: unknown = null, busy = false, disposed = false, shown = visible;
  let lastActivity = now(), lastCheck = -Infinity, checks = 0, lastLook = now(), reported: boolean | null = null;
  const report = () => {
    const live = timer !== null || busy;
    if (disposed || live === reported) return;
    reported = live;
    onStatus?.(live ? { live: true } : { live: false, lastLook });
  };
  const clear = () => { if (timer !== null) { timers.clear(timer); timer = null; } };
  const idle = () => now() - lastActivity >= config.idleMs;
  const schedule = () => {
    clear();
    if (!disposed && shown && !idle()) timer = timers.set(tick, config.intervalMs);
    report();
  };
  const run = async () => {
    if (disposed || busy || !shown) return;
    busy = true; lastCheck = now(); checks++; report();
    try { await check(); } catch { /* a failed look is just skipped; the next one tries again */ }
    busy = false; lastLook = now();
    schedule();
  };
  function tick() { timer = null; if (!disposed && shown && !idle()) void run(); else report(); }
  /** Someone is back (focus, foreground): look now unless a look just happened, then keep going. */
  const wake = () => {
    if (disposed) return;
    lastActivity = now();
    if (!shown || busy) return;
    if (now() - lastCheck < config.minGapMs) { if (timer === null) schedule(); return; }
    clear(); void run();
  };
  return {
    /** Mounting starts the wait; the data was just read, so the first look is one interval away. */
    start: () => { lastActivity = now(); schedule(); },
    /** Every touch, click, scroll and key. While polling it only moves the idle deadline. */
    activity: () => {
      if (disposed) return;
      const stopped = timer === null && !busy;
      lastActivity = now();
      if (stopped) wake();
    },
    wake,
    visibility: (value: boolean) => {
      if (disposed || value === shown) return;
      shown = value;
      if (value) wake(); else { clear(); report(); }
    },
    dispose: () => { disposed = true; clear(); },
    /** Test seam. */
    state: () => ({ polling: timer !== null, busy, checks, visible: shown, disposed }),
  };
}
export type Poller = ReturnType<typeof createPoller>;
/**
 * REQ-90: a screen showing the lab's badge says its host, so each look also hears the message folder's fingerprint, and
 * the one it shows (`key`, the read's `mail.key`). A different one is a change like a board's: the screen reads again.
 * Without it (the lab off) the look is as before and the server never touches the folder.
 */
export type MailWatch = { hostId: string; key: string | undefined };
export const mailChanged = (watch: MailWatch | undefined, reported: string | undefined) => !!watch && (reported ?? '') !== (watch.key ?? '');
/** Board id → revision of the ledger boards a screen shows; a workspace without a board has none. */
export function knownRevisions(summaries: readonly { id: string; revision: string; hasLedger?: boolean | undefined; groups?: string | undefined;
  busy?: string | undefined }[]) {
  const known: Record<string, string> = {};
  for (const s of summaries) if (s.hasLedger !== false) known[s.id] = shownRevision(s);
  return known;
}
/**
 * REQ-76 F1: what a screen compares for a board — the ledger's revision, and the fingerprint of its groups when the
 * server gave one (a parent remembered later changes that and not the ledger). A screen that asks `revisions.get` for
 * `groups` reads boards that carry them, so both sides say the same thing when nothing changed.
 */
export function shownRevision(board: { revision: string; groups?: string | undefined; busy?: string | undefined }): string {
  // REQ-84: and of its busy marks, which change the plugin's `busy.json` and not the ledger (said with every look).
  return (board.groups ? board.revision + ' ' + board.groups : board.revision) + (board.busy ? ' busy:' + board.busy : '');
}

/*
 * F1: moving to another Paseo screen (History, an agent) does not unmount a plugin screen and does
 * not change `document.visibilityState`; the host only hides it (a `display:none` ancestor) or takes
 * its DOM out of the page. The screen's root element says so: it has no box any more. On the web an
 * IntersectionObserver reports that change both ways, and the same box check guards every look in
 * case a report is late. Native has no DOM element, so a native screen always counts as shown.
 */
type Box = { isConnected?: boolean; getClientRects(): { length: number } };
type ObserverClass = new (report: (entries: readonly { isIntersecting: boolean }[]) => void) =>
  { observe(target: object): void; disconnect(): void };
export function createShownWatch(Observer = (globalThis as { IntersectionObserver?: ObserverClass }).IntersectionObserver) {
  let element: Box | null = null, observer: { disconnect(): void } | null = null, reported = true;
  const listeners = new Set<(shown: boolean) => void>();
  const boxed = () => !element || (element.isConnected !== false && element.getClientRects().length > 0);
  // Every report is passed on, even an unchanged one: the first report after mounting settles a screen
  // that mounted hidden. The poller ignores a visibility it already has.
  const publish = (value: boolean) => { reported = value; for (const listener of [...listeners]) listener(value); };
  return {
    /** The screen's root view ref. Anything without a DOM box (native, tests) leaves the watch at "shown". */
    ref: (node: unknown) => {
      observer?.disconnect(); observer = null;
      element = node && typeof (node as Box).getClientRects === 'function' ? node as Box : null;
      // Detaching (unmount) reports nothing: a report would wake a screen that is going away.
      if (element && Observer) {
        const next = new Observer(entries => { const last = entries[entries.length - 1]; if (last) publish(last.isIntersecting && boxed()); });
        next.observe(element);
        observer = next;
      }
    },
    shown: () => reported && boxed(),
    subscribe: (listener: (shown: boolean) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type ShownWatch = ReturnType<typeof createShownWatch>;
