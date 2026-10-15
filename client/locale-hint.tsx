import { useEffect } from 'react';
import { View } from 'react-native';
import type { Locale } from '../shared/core/domain.js';
import type { Palette } from './palette.js';

/**
 * REQ-77+78 gate, observation a: a screen learns its language from its first read (the ledger's setting, Korean
 * unless it says otherwise), so until that read answered it drew in English and turned Korean 1.5–2 s later.
 * The last language a read brought is kept per host — in memory for this app session and, on the web, in the
 * browser's storage as a hint, like the theme (REQ-70) — and used until the read answers; the read always wins.
 * With nothing kept (the first opening ever in this browser, or the first in a native app session) the screen
 * draws no words until the read answers or fails (`null`), rather than words in a language it may not be in.
 */
const LOCALE_HINT = 'paseo-kanban:locale:';
const remembered = new Map<string, Locale>();
type Storage = { getItem(key: string): string | null; setItem?(key: string, value: string): void };
const storage = () => (globalThis as { localStorage?: Storage }).localStorage;
function readHint(hostId: string): Locale | undefined {
  try {
    const value = storage()?.getItem(LOCALE_HINT + hostId);
    return value === 'ko' || value === 'en' ? value : undefined;
  } catch { return undefined; }
}
export function lastLocale(hostId: string): Locale | undefined {
  return remembered.get(hostId) ?? readHint(hostId);
}
function rememberLocale(hostId: string, locale: Locale) {
  if (remembered.get(hostId) === locale) return;
  remembered.set(hostId, locale);
  try { storage()?.setItem?.(LOCALE_HINT + hostId, locale); } catch { /* private mode or no storage: memory still holds it */ }
}
/**
 * The language a screen draws in: what its read `answered`, else the last one kept for the host. `null` while
 * the read is still `waiting` with nothing kept; once it failed (or there is no read) English, as before.
 */
export function useScreenLocale(hostId: string, answered: Locale | undefined, waiting: boolean): Locale | null {
  useEffect(() => { if (answered) rememberLocale(hostId, answered); }, [hostId, answered]);
  return answered ?? lastLocale(hostId) ?? (waiting ? null : 'en');
}
/** What a screen shows while its language is not known: its background, no words. */
export function LocalePending({ colors }: { colors: Palette }) {
  return <View testID="locale-pending" style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }} />;
}
