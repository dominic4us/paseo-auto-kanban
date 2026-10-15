/**
 * REQ-52: the automatic archive of finished cards — how many days a card may sit in a completion stage before the plugin puts
 * it away. One value for the whole plugin (server/auto-archive.ts keeps it in its own file); 0 switches it off.
 */
export const DEFAULT_ARCHIVE_DAYS = 7;
export const MAX_ARCHIVE_DAYS = 365;
/** The settings window's choices, in order; 0 is "Off". */
export const ARCHIVE_DAY_CHOICES = [0, 3, 7, 14, 30] as const;
export const DAY_MS = 86400000;
/**
 * When a card's days toward the automatic archive started: when it entered its stage, or when it was last restored if that
 * came later (a restored card gets its full days again). NaN when neither can be read.
 */
export function archiveClock(enteredAt: string, restoredAt?: string): number {
  const entered = Date.parse(enteredAt), restored = restoredAt ? Date.parse(restoredAt) : NaN;
  return Number.isFinite(restored) && (!Number.isFinite(entered) || restored > entered) ? restored : entered;
}
/** Whether a card counted from `since` is due: exactly `days` days later it is, a moment before it is not. Never with 0 days. */
export function archiveDue(since: number, now: number, days: number): boolean {
  return days > 0 && Number.isFinite(since) && now - since >= days * DAY_MS;
}
/** A stored value read back: a whole number of days from 0 to 365, anything else is the default. */
export function cleanArchiveDays(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ARCHIVE_DAYS ? value : DEFAULT_ARCHIVE_DAYS;
}
