import { useSyncExternalStore } from 'react';

/**
 * REQ-158: where Paseo's left-menu Kanban opens — the main screen (the default) or the right panel (REQ-152's Explorer tab).
 * It is this device's window layout, not the host's: kept in the browser's storage per host, never in ui-state.json, so the
 * menu reads it at each press without a server read (the menu has none) and another device keeps its own. Without storage
 * (private browsing) the choice holds until the app reloads. Anything but 'panel' reads as the main screen.
 * Kept apart from settings.ts so the menu (client/sidebar.tsx) imports nothing beyond React and React Native.
 */
export type OpenLocation = 'main' | 'panel';
const OPEN_IN = 'paseo-kanban:open-in:';
type Storage = { getItem(key: string): string | null; setItem?(key: string, value: string): void };
const storage = () => (globalThis as { localStorage?: Storage }).localStorage;
const memory = new Map<string, OpenLocation>();
const listeners = new Set<() => void>();
export function readOpenLocation(hostId: string): OpenLocation {
  try {
    const value = storage()?.getItem(OPEN_IN + hostId);
    if (value !== null && value !== undefined) return value === 'panel' ? 'panel' : 'main';
  } catch { /* no storage: this session's choice */ }
  return memory.get(hostId) ?? 'main';
}
export function writeOpenLocation(hostId: string, value: OpenLocation) {
  memory.set(hostId, value);
  try { storage()?.setItem?.(OPEN_IN + hostId, value); } catch { /* private mode: this session's choice */ }
  for (const listener of [...listeners]) listener();
}
export function useOpenLocation(hostId: string): OpenLocation {
  const read = () => readOpenLocation(hostId);
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, read);
}
/** REQ-158: the choice is offered only while a newer web host registered the menu; older hosts and phone apps open the main screen. */
let sidebarPanel = false;
export const sidebarCanOpenPanel = () => sidebarPanel;
export function noteSidebarPanel(on: boolean) { sidebarPanel = on; }
