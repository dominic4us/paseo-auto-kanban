import { px, scaled } from './ui-scale.js';
export function progressMetrics(progress: { done: number; requested: number }) {
  const ratio = progress.requested > 0 ? Math.max(0, Math.min(1, progress.done / progress.requested)) : 0;
  return { width: px(96), fillWidth: px(96) * ratio, percent: progress.requested > 0 ? Math.floor(ratio * 100) : null };
}
/** The leading `null` row is the select-all/clear-all control; the rest are the projects themselves. */
export function projectChoices(options: ReadonlyMap<string, string>, all: string) {
  return [{ id: null, name: all }, ...[...options].sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ id, name }))];
}
/**
 * REQ-57 ④: reads the dropdown's new selection back into a hidden-project list. Toggling the all row
 * selects or clears everything at once; any other change is taken literally.
 */
export function projectSelection(options: ReadonlyMap<string, string>, previous: readonly (string | null)[],
  next: readonly (string | null)[]): string[] {
  const all = [...options.keys()];
  const hadAll = previous.includes(null), hasAll = next.includes(null);
  if (hasAll && !hadAll) return [];
  if (!hasAll && hadAll) return all;
  const chosen = new Set(next.filter((id): id is string => id !== null));
  return all.filter(id => !chosen.has(id));
}
/**
 * REQ-88 ① (research/129 ①B): the wide detail is two columns — what the card is about on the left, a narrow panel of its
 * state on the right (`panelWidth`) — in a window up to 880px (REQ-28's 720 left the left column ~400px). Below
 * `DETAIL.twoColumns` the window, and every phone, is one column.
 */
export const DETAIL = scaled({ maxWidth: 880, panelWidth: 280, gap: 24, twoColumns: 700 } as const, ['twoColumns']);
export function detailLayout(windowWidth: number, mobile: boolean) {
  const width = Math.min(DETAIL.maxWidth, Math.floor(Math.max(0, windowWidth) * .9));
  return { width: mobile ? undefined : width, padding: mobile || width < 640 ? px(16) : px(24),
    columns: !mobile && width >= DETAIL.twoColumns ? 2 : 1, gap: DETAIL.gap, panelWidth: DETAIL.panelWidth };
}
