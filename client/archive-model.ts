import type { ArchivedCard, AutoArchiveDTO } from '../shared/rpc.js';
import { DEFAULT_ARCHIVE_DAYS } from '../shared/archive.js';
import type { Copy } from './i18n.js';
import { localStamp } from './move-reason.js';

/** REQ-52: how many finished cards of a board are archived (0 from an older server). Pure, no React. */
export const archivedDoneOf = (summary: { progress: { archivedDone?: number | undefined } }) => summary.progress.archivedDone ?? 0;
/** REQ-52: one line under an archived card's title — its stage, when and how it was archived, or that it is not counted. */
export function archivedLine(card: ArchivedCard, stageName: string, m: Copy, now: number): string {
  const when = localStamp(card.archivedAt, now);
  return card.done ? stageName + ' · ' + (card.auto ? m.archivedAuto(when) : m.archivedByHand(when))
    : stageName + ' · ' + m.archivedByHand(when) + ' · ' + m.archivedNotDone;
}

/**
 * REQ-52 / 298-F2: a choice this screen made, held only until the server's own reading says otherwise. `saving` while the write
 * is on its way; once saved, `base` is the reading the screen had when it chose — the choice is shown while that same reading
 * is the latest, and the next reading (which already holds the write, or another screen's later one) wins.
 */
export type ArchiveChoice = { days: number; base: AutoArchiveDTO | undefined; saving?: true };
export function shownArchive(remote: AutoArchiveDTO | undefined, local: ArchiveChoice | null): { days: number; damaged: boolean } {
  if (local && (local.saving || local.base === remote)) return { days: local.days, damaged: false };
  return { days: remote?.days ?? DEFAULT_ARCHIVE_DAYS, damaged: !!remote?.damaged };
}
