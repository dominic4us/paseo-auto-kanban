import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useSessionValue } from './session.js';
import { sessionFor } from './session-store.js';
import { uiStateSet, type BoardAlign, type LabsDTO, type ThemeChoice, type UiSettingsDTO } from '../shared/rpc.js';
import { resolveTheme } from './palette.js';
import { DEFAULT_CARD_ORDER, type CardOrder } from './card-order.js';
import { clampScale, setUiScale, UI_SCALE } from './ui-scale.js';

/**
 * REQ-66: the Kanban settings window. The server remembers each row per host in `ui-state.json`; an
 * absent row is its default. Confirmed display preferences are shared by
 * every screen of the host (the board, the list and the workspace panel poll by the same switch); a fresh server
 * read supersedes the auto-refresh confirmation. A
 * change made in the window reaches them all without another read.
 */
/** REQ-90: `labs` is the lab's fields as stored — every one absent (off, no folder, the default short-name rule) by default. */
/** REQ-139: `uiScale` is the screens' size in percent (80–150, 100 by default). */
export interface KanbanSettings { boardAlign: BoardAlign; autoRefresh: boolean; theme: ThemeChoice; groupByProject: boolean; cardOrder: CardOrder;
  labs: LabsDTO; uiScale: number }
export const DEFAULT_SETTINGS: KanbanSettings = { boardAlign: 'center', autoRefresh: true, theme: 'paseo', groupByProject: false,
  cardOrder: DEFAULT_CARD_ORDER, labs: {}, uiScale: UI_SCALE.default };

/**
 * REQ-70: `theme` is the last choice a read brought. The theme is picked above the screens, before any read
 * of theirs has answered, so it cannot come in as `remote` like the other rows.
 */
/** REQ-139: `uiScale` likewise — the size is set above the screens, before their reads answer. */
type Store = { saved: UiSettingsDTO; theme: ThemeChoice | undefined; uiScale: number | undefined; listeners: Set<() => void>;
  refreshRead: object | null; refreshEpoch: number; refreshSequence: number; remoteRefresh: boolean | undefined };
const stores = new Map<string, Store>();
function storeFor(hostId: string): Store {
  let store = stores.get(hostId);
  if (!store) { store = { saved: {}, theme: readThemeHint(hostId), uiScale: readScaleHint(hostId), listeners: new Set(), refreshRead: null, refreshEpoch: 0, refreshSequence: 0, remoteRefresh: undefined }; stores.set(hostId, store); }
  return store;
}
const notify = (store: Store) => { for (const listener of [...store.listeners]) listener(); };
/** Applies a value the server has confirmed. */
export function commitSettings(hostId: string, patch: UiSettingsDTO) {
  const store = storeFor(hostId);
  store.saved = { ...store.saved, ...patch };
  if (patch.theme) writeThemeHint(hostId, patch.theme);
  if (patch.uiScale !== undefined) writeScaleHint(hostId, clampScale(patch.uiScale));
  notify(store);
}
/** 451 F3: called only after useRead accepted a successful settings read. Even equal values are authoritative. */
export function noteRefreshRead(hostId: string, value: boolean | undefined, token: object) {
  const store = storeFor(hostId);
  if (store.refreshRead === token) return;
  store.refreshRead = token; store.refreshEpoch++; store.remoteRefresh = value ?? DEFAULT_SETTINGS.autoRefresh;
  store.saved = { ...store.saved }; delete store.saved.autoRefresh;
  notify(store);
}
/** REQ-70: a read's settings; only a changed theme wakes the screens. REQ-139: or a changed size. */
export function noteRemoteSettings(hostId: string, remote: UiSettingsDTO) {
  const store = storeFor(hostId), theme = remote.theme ?? DEFAULT_SETTINGS.theme, uiScale = clampScale(remote.uiScale);
  if (store.theme === theme && store.uiScale === uiScale) return;
  if (store.theme !== theme) { store.theme = theme; writeThemeHint(hostId, theme); }
  if (store.uiScale !== uiScale) { store.uiScale = uiScale; writeScaleHint(hostId, uiScale); }
  notify(store);
}
export function resolveSettings(remote: UiSettingsDTO | undefined, saved: UiSettingsDTO = {}): KanbanSettings {
  return { boardAlign: saved.boardAlign ?? remote?.boardAlign ?? DEFAULT_SETTINGS.boardAlign,
    autoRefresh: saved.autoRefresh ?? remote?.autoRefresh ?? DEFAULT_SETTINGS.autoRefresh,
    theme: saved.theme ?? remote?.theme ?? DEFAULT_SETTINGS.theme,
    groupByProject: saved.groupByProject ?? remote?.groupByProject ?? DEFAULT_SETTINGS.groupByProject,
    cardOrder: saved.cardOrder ?? remote?.cardOrder ?? DEFAULT_SETTINGS.cardOrder,
    // REQ-90: the lab is saved whole (client/settings-sheet.tsx sends every field of it), so the saved one replaces the read one.
    labs: saved.labs ?? remote?.labs ?? DEFAULT_SETTINGS.labs,
    uiScale: clampScale(saved.uiScale ?? remote?.uiScale ?? DEFAULT_SETTINGS.uiScale) };
}
function useStore(hostId: string) {
  const store = storeFor(hostId);
  useSyncExternalStore(listener => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; },
    () => store.saved.theme ?? store.theme, () => store.saved.theme ?? store.theme);
  return store;
}
/**
 * REQ-70: a read that answered without settings means none are saved — every row at its default, the theme
 * included, which must then replace a stale hint. `undefined` (no answer yet) changes nothing.
 */
const NO_SETTINGS: UiSettingsDTO = Object.freeze({});
export const answeredSettings = (answered: boolean, settings: UiSettingsDTO | undefined) =>
  answered ? settings ?? NO_SETTINGS : undefined;
export function useKanbanSettings(hostId: string, remote: UiSettingsDTO | undefined): KanbanSettings {
  const store = storeFor(hostId);
  const saved = useSyncExternalStore(listener => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; },
    () => store.saved, () => store.saved);
  useEffect(() => { if (remote) noteRemoteSettings(hostId, remote); }, [hostId, remote]);
  return resolveSettings(remote, { ...saved, autoRefresh: saved.autoRefresh ?? store.remoteRefresh ?? remote?.autoRefresh ?? DEFAULT_SETTINGS.autoRefresh });
}
/** REQ-70: the host's theme choice for the screens: what this client saved, else what a read brought. */
export function useThemeChoice(hostId: string): ThemeChoice {
  const store = useStore(hostId);
  return store.saved.theme ?? store.theme ?? DEFAULT_SETTINGS.theme;
}

/**
 * REQ-70 F1: the device's scheme (web `prefers-color-scheme`, native `Appearance`). Not RN's
 * `useColorScheme`: react-native-web's subscribes again after every render, and the browser skips a
 * listener removed while a change is being delivered. A board under the Kanban screen resolves the theme
 * twice, so the screen's update re-rendered the board and dropped its listener before it was called — the
 * board kept the old scheme. Here one listener serves every screen, and each render reads the scheme afresh.
 */
const schemeListeners = new Set<() => void>();
let schemeSubscription: { remove(): void } | null = null;
function subscribeScheme(listener: () => void) {
  schemeListeners.add(listener);
  schemeSubscription ??= Appearance.addChangeListener(() => { for (const each of [...schemeListeners]) each(); });
  return () => {
    schemeListeners.delete(listener);
    if (!schemeListeners.size) { schemeSubscription?.remove(); schemeSubscription = null; }
  };
}
function deviceScheme(): 'light' | 'dark' | null {
  const scheme = Appearance.getColorScheme();
  return scheme === 'light' || scheme === 'dark' ? scheme : null;
}

/**
 * REQ-70: the theme a Kanban screen draws with — the host's, the device's scheme or a forced mode. Picked
 * above the screens so everything under them, sheets and dialogs included, gets the same one.
 */
export function useKanbanTheme(hostId: string, host: PluginSurfaceProps['theme']): PluginSurfaceProps['theme'] {
  const choice = useThemeChoice(hostId), system = useSyncExternalStore(subscribeScheme, deviceScheme, deviceScheme);
  return resolveTheme(host, choice, system);
}
/**
 * REQ-139: the host's screen size in percent — what this client saved, else what a read brought, else the last one kept on
 * this device (web), else 100. Called by each screen's root while it draws, so every `px` under it reads this size; a change
 * wakes the root, and the whole screen draws again at the new size (no screen holds its sizes in a memo).
 */
export function useUiScale(hostId: string): number {
  const store = storeFor(hostId);
  const read = () => clampScale(store.saved.uiScale ?? store.uiScale ?? DEFAULT_SETTINGS.uiScale);
  const percent = useSyncExternalStore(listener => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; }, read, read);
  setUiScale(percent);
  return percent;
}

/**
 * REQ-70: the last choice is also kept in the browser's storage (web only), so a reload draws in the chosen
 * colours before the first read answers instead of flashing the host's. It is only a hint: the ledger's
 * ui-state.json stays the record, and a read overrides it.
 */
const THEME_HINT = 'paseo-kanban:theme:';
type Storage = { getItem(key: string): string | null; setItem?(key: string, value: string): void };
const storage = () => (globalThis as { localStorage?: Storage }).localStorage;
function readThemeHint(hostId: string): ThemeChoice | undefined {
  try {
    const value = storage()?.getItem(THEME_HINT + hostId);
    return value === 'paseo' || value === 'system' || value === 'light' || value === 'dark' ? value : undefined;
  } catch { return undefined; }
}
function writeThemeHint(hostId: string, theme: ThemeChoice) {
  try { storage()?.setItem?.(THEME_HINT + hostId, theme); } catch { /* private mode or no storage: the read still decides */ }
}
/** REQ-139: the size kept the same way, so a reload draws at the chosen size before the first read answers. */
const SCALE_HINT = 'paseo-kanban:scale:';
function readScaleHint(hostId: string): number | undefined {
  try {
    const value = storage()?.getItem(SCALE_HINT + hostId);
    return value ? clampScale(Number(value)) : undefined;
  } catch { return undefined; }
}
function writeScaleHint(hostId: string, percent: number) {
  try { storage()?.setItem?.(SCALE_HINT + hostId, String(percent)); } catch { /* as the theme's hint */ }
}

/**
 * One row's save: the control shows the old value until the server confirms the new one, a failure keeps
 * the old value and says so on the row, and the same write can be tried again. A row is disabled while
 * its write is on the way, so two writes of one row never race.
 */
export type RowState = { state: 'saving' | 'failed' } | null;
export function useRowSaves() {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const attempts = useRef(new Map<string, () => Promise<boolean>>());
  const run = async (key: string, write: () => Promise<boolean>) => {
    attempts.current.set(key, write);
    setRows(previous => ({ ...previous, [key]: { state: 'saving' } }));
    let ok = false;
    try { ok = await write(); } catch { ok = false; }
    setRows(previous => ({ ...previous, [key]: ok ? null : { state: 'failed' } }));
    return ok;
  };
  return { state: (key: string): RowState => rows[key] ?? null, run,
    /** REQ-67 ⑥: forget the failures shown last time the window was open. */
    clearFailed: () => setRows(previous => Object.values(previous).some(row => row?.state === 'failed')
      ? Object.fromEntries(Object.entries(previous).filter(([, row]) => row?.state !== 'failed')) : previous),
    retry: (key: string) => { const write = attempts.current.get(key); if (write) void run(key, write); } };
}

/** The settings rows stored in `ui-state.json`. The demo never saves. */
export function useSettingsWriter(hostId: string) {
  const save = useRpc(uiStateSet);
  const lifetime = useRef({ hostId, alive: true });
  if (lifetime.current.hostId !== hostId) lifetime.current = { hostId, alive: true };
  const owner = lifetime.current;
  useEffect(() => { owner.alive = true; return () => { owner.alive = false; }; }, [owner]);
  return async (patch: UiSettingsDTO): Promise<boolean> => {
    const store = storeFor(hostId), guarded = patch.autoRefresh !== undefined;
    if (guarded && !owner.alive) return false;
    const epoch = store.refreshEpoch, sequence = guarded ? ++store.refreshSequence : 0;
    const reply = await save({ hostId, settings: patch });
    if (!reply?.ok) return false;
    if (!guarded || owner.alive && store.refreshEpoch === epoch && store.refreshSequence === sequence) commitSettings(hostId, patch);
    return true;
  };
}

/**
 * REQ-75 A3: "group by project" on the swimlane board, remembered per host like the project filter. It is a
 * glyph beside the filters rather than a settings row, so it switches at once: the session keeps the choice,
 * one write goes out, and the confirmed value reaches the host's other screens through the settings store.
 * The demo keeps its own scope and never saves.
 */
export function useGroupByProject(scope: string, hostId: string, remembered: boolean, persist: boolean): readonly [boolean, (next: boolean) => void] {
  const save = useRpc(uiStateSet);
  const [local, setLocal] = useSessionValue<boolean | null>(scope, 'groupByProject', null);
  const value = local ?? remembered;
  const update = (next: boolean) => {
    if (next === value) return;
    setLocal(next);
    if (persist) void save({ hostId, settings: { groupByProject: next } })
      .then(reply => { if (reply?.ok) commitSettings(hostId, { groupByProject: next }); }).catch(() => {});
  };
  return [value, update];
}

/**
 * REQ-79: the card order, switched at once from the sort menu like "group by project" (one write, the demo never
 * saves). Unlike that switch it is read by more than one screen at a time — the swimlane board and the workspace
 * board or panel — so the choice not yet confirmed is kept per scope in one place every screen of it reads, and a
 * change made on one is on the others at once. A refused write keeps the choice for this session, as REQ-75 A3 does.
 */
const orderListeners = new Map<string, Set<() => void>>();
const listenersFor = (scope: string) => {
  let listeners = orderListeners.get(scope);
  if (!listeners) { listeners = new Set(); orderListeners.set(scope, listeners); }
  return listeners;
};
export function useCardOrder(scope: string, hostId: string, remembered: CardOrder, persist: boolean): readonly [CardOrder, (next: CardOrder) => void] {
  // The session keeps the choice (so the demo's is dropped with the demo's session); the listeners wake every screen.
  const save = useRpc(uiStateSet), session = sessionFor(scope), listeners = listenersFor(scope);
  const read = () => (session.get('cardOrder') ?? null) as CardOrder | null;
  const local = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, read);
  const value = local ?? remembered;
  const update = (next: CardOrder) => {
    if (next === value) return;
    session.set('cardOrder', next);
    for (const listener of [...listeners]) listener();
    if (persist) void save({ hostId, settings: { cardOrder: next } })
      .then(reply => { if (reply?.ok) commitSettings(hostId, { cardOrder: next }); }).catch(() => {});
  };
  return [value, update];
}
