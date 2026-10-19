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

/** Legacy adapter: only a confirmed choice based on the current reading can extend that reading.
 * Pending choices never override a server value or damage warning. useAutoArchive now keeps confirmed
 * values in a component-local request controller and does not create ArchiveChoice.saving objects.
 */
export type ArchiveChoice = { days: number; base: AutoArchiveDTO | undefined; saving?: true };
export function shownArchive(remote: AutoArchiveDTO | undefined, local: ArchiveChoice | null): { days: number; damaged: boolean } {
  if (local && !local.saving && local.base === remote) return { days: local.days, damaged: false };
  return { days: remote?.days ?? DEFAULT_ARCHIVE_DAYS, damaged: !!remote?.damaged };
}
