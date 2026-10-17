import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { revisionsGet, type AutoHealthDTO } from '../shared/rpc.js';
import { AUTO_REFRESH, createPoller, createShownWatch, knownRevisions, mailChanged, revisionsChanged, shownRevision, type MailWatch, type RefreshStatus, type RevisionScope, type ShownWatch } from './refresh-model.js';
export { knownRevisions } from './refresh-model.js';

/*
 * One set of environment listeners, however many screens poll: web listens on the document (the plugin
 * runs inside the host page, so any interaction there means the person is present), native on AppState.
 * Native touches reach `noteActivity` through the screens' root `onTouchStart`.
 */
interface Watcher { activity(): void; wake(): void; foreground(value: boolean): void }
const pollers = new Set<Watcher>();
let detachEnvironment: (() => void) | null = null;
type Doc = { visibilityState?: string; addEventListener(type: string, run: () => void, options?: unknown): void;
  removeEventListener(type: string, run: () => void, options?: unknown): void };
type Win = { addEventListener(type: string, run: () => void): void; removeEventListener(type: string, run: () => void): void };
function environment() {
  const g = globalThis as { document?: Doc; window?: Win };
  return { doc: g.document && typeof g.document.addEventListener === 'function' ? g.document : undefined,
    win: g.window && typeof g.window.addEventListener === 'function' ? g.window : undefined };
}
function foreground(): boolean {
  const { doc } = environment();
  if (doc?.visibilityState) return doc.visibilityState !== 'hidden';
  return AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
}
/** D41: when a touch, click, scroll or key last reached any screen. */
let lastPresence = Date.now();
export function noteActivity() { lastPresence = Date.now(); for (const poller of pollers) poller.activity(); }
/**
 * D41: whether someone is looking — the screen in the foreground and an interaction within `AUTO_REFRESH.idleMs` (3 minutes),
 * the auto refresh's own rule. On the web the interactions are heard while a screen polls, so with auto refresh off it stops too.
 */
export function present(): boolean { return foreground() && Date.now() - lastPresence < AUTO_REFRESH.idleMs; }
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
function attachEnvironment() {
  const { doc, win } = environment();
  const wakeAll = () => { for (const poller of pollers) poller.wake(); };
  const onVisibility = () => { const value = foreground(); for (const poller of pollers) poller.foreground(value); };
  const options = { capture: true, passive: true };
  for (const type of ACTIVITY_EVENTS) doc?.addEventListener(type, noteActivity, options);
  doc?.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('focus', wakeAll);
  const app = AppState.addEventListener('change', state => {
    const value = state === 'active';
    for (const poller of pollers) poller.foreground(value);
  });
  return () => {
    for (const type of ACTIVITY_EVENTS) doc?.removeEventListener(type, noteActivity, options);
    doc?.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('focus', wakeAll);
    app.remove();
  };
}
function register(poller: Watcher) {
  pollers.add(poller);
  if (pollers.size === 1) detachEnvironment = attachEnvironment();
  return () => {
    pollers.delete(poller);
    if (!pollers.size) { detachEnvironment?.(); detachEnvironment = null; }
  };
}
/** Test seam: how many screens are polling right now (0 after every unmount). */
export function activePollers() { return pollers.size; }

/**
 * F1: the root view of a screen reports whether the host still shows it. OverviewScreen provides one
 * for the swimlane and the list; a board watches its own root, so the panel is covered too.
 */
export const ShownContext = createContext<ShownWatch | null>(null);
export function useShownWatch() { return useState(() => createShownWatch())[0]; }

/**
 * Keeps a screen's read fresh. `known` is what the screen shows now (board id → revision), so a
 * screen's own write, already re-read through `onChanged`, compares equal and does nothing. Only a
 * difference calls `revalidate`, which replaces the data without a loading state.
 * REQ-66: `enabled` false (the demo, or auto refresh switched off in the settings) means no poller at
 * all. The returned status is what the screen says about it: off, live, or paused since a time.
 */
export type AutoRefreshStatus = { kind: 'off' } | { kind: 'live' } | { kind: 'paused'; lastLook: number };
/**
 * REQ-83: what the looks found besides changes. `failing` once `REFRESH_FAILS` looks in a row could not read the
 * revisions or the changed boards (the screen keeps what it shows, so without this it would look current);
 * `health` is the server's automatic tracking as the latest look reported it (`undefined` before any).
 */
export type AutoRefreshReport = AutoRefreshStatus & { failing?: boolean; health?: AutoHealthDTO | undefined };
export const REFRESH_FAILS = 2;
export function useAutoRefresh({ enabled, known, scope, boardIds, busy, revalidate, shown, groups = false, mail }: {
  enabled: boolean; known: Readonly<Record<string, string>> | null; scope: RevisionScope;
  boardIds?: readonly string[] | undefined; busy: boolean; revalidate: () => Promise<boolean>;
  shown?: ShownWatch | undefined;
  /** REQ-76 F1: the screen draws sub-cards under their parent, so its `known` carries the boards' groups. */
  groups?: boolean;
  mail?: MailWatch | undefined;
}): AutoRefreshReport {
  const [status, setStatus] = useState<RefreshStatus>({ live: true });
  const [failing, setFailing] = useState(false), [health, setHealth] = useState<AutoHealthDTO | undefined>(undefined);
  const provided = useContext(ShownContext), watch = shown ?? provided;
  const get = useRpc(revisionsGet);
  const latest = useRef({ get, known, scope, boardIds, busy, revalidate, mail });
  latest.current = { get, known, scope, boardIds, busy, revalidate, mail };
  const idKey = boardIds?.join('\n') ?? '';
  useEffect(() => {
    if (!enabled) return undefined;
    // `appeared`: what existed at the first look is the baseline; only a board after it counts.
    let baseline: Record<string, string> | null = null;
    // A re-read already asked for this exact change; the screen just has not shown its result yet.
    let asked: { known: object; reply: string } | null = null;
    // Looks only while the app is in front and the host shows this screen (F1).
    let front = foreground(), onScreen = watch?.shown() ?? true;
    // Only a change between live and paused reaches React; an unchanged report keeps the same state object.
    const onStatus = (next: RefreshStatus) => setStatus(previous => previous.live === next.live ? previous : next);
    // REQ-83: looks in a row that could not read; one success clears it.
    let fails = 0;
    const note = (ok: boolean) => { fails = ok ? 0 : fails + 1; setFailing(fails >= REFRESH_FAILS); };
    const poller = createPoller({ visible: front && onScreen, onStatus, check: async () => {
      const { get, known, scope, boardIds, busy, mail } = latest.current;
      if (!known || busy || (watch && !watch.shown())) return;
      // REQ-76 F1: with each board's groups, which a remembered parent changes and the ledger's revision does not.
      let reply: Awaited<ReturnType<typeof get>>;
      try { reply = await get({ ...(boardIds?.length ? { boardIds: [...boardIds] } : {}), ...(groups ? { groups: true } : {}),
        ...(mail ? { hostId: mail.hostId } : {}) }); }
      catch (error) { note(false); throw error; }
      if (!reply.ok) { note(false); return; }
      const reported = reply.data.autoHealth;
      if (reported) setHealth(previous => JSON.stringify(previous) === JSON.stringify(reported) ? previous : reported);
      // The screen may have changed while the reply travelled; compare with what it shows now.
      const now = latest.current;
      if (!now.known || now.busy || now.known !== known) { note(true); return; }
      if (scope === 'appeared' && !baseline) { baseline = knownRevisions(reply.data.boards); return; }
      const messages = mailChanged(now.mail, reply.data.mail);
      if (!revisionsChanged(scope === 'appeared' ? baseline! : known, reply.data, scope) && !messages) { note(true); return; }
      const signature = JSON.stringify([reply.data.boards.map(b => [b.id, shownRevision(b)]), reply.data.mail ?? '']);
      if (asked && asked.known === known && asked.reply === signature) { note(true); return; }
      asked = { known, reply: signature };
      // The next look waits for this read, so one change is read once.
      // A read that failed or was superseded is asked for again at the next look.
      const read = await now.revalidate() === true;
      if (!read) asked = null;
      note(read);
    } });
    const release = register({ activity: poller.activity, wake: poller.wake,
      foreground: value => { front = value; poller.visibility(front && onScreen); } });
    const unwatch = watch?.subscribe(value => { onScreen = value; poller.visibility(front && onScreen); });
    poller.start();
    return () => { poller.dispose(); unwatch?.(); release(); setStatus(previous => previous.live ? previous : { live: true }); setFailing(false); };
  }, [enabled, idKey, scope, watch, groups]);
  const extra = { failing: enabled && failing, health };
  return !enabled ? { kind: 'off', ...extra } : status.live ? { kind: 'live', ...extra } : { kind: 'paused', lastLook: status.lastLook, ...extra };
}
