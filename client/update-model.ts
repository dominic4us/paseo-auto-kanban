import type { UpdateCheckDTO } from '../shared/rpc.js';
import type { Copy } from './i18n.js';

/**
 * REQ-156: what the settings window's About says about new versions, from the server's reading (`UpdateCheckDTO`).
 * `newer` — the registry's release is newer than the running plugin: the line, the two update commands and a dot on ⚙.
 * `current` — the registry answered and nothing is newer. `unchecked` — on, but no answer in the last seven days (none yet, failing,
 * or a broken cache — gate 486 F5/J2: the server then sends neither). `off` — switched off.
 * `damaged` — the setting file cannot be read: nothing is asked (the Automation row says how to save it again).
 * `none` — an older server that sends no reading: the row is left out.
 */
export type UpdateState = 'newer' | 'current' | 'unchecked' | 'off' | 'damaged' | 'none';
export function updateState(update: UpdateCheckDTO | undefined): UpdateState {
  if (!update) return 'none';
  if (update.damaged) return 'damaged';
  if (!update.enabled) return 'off';
  if (update.newer) return 'newer';
  return update.checkedAt && Number.isFinite(Date.parse(update.checkedAt)) ? 'current' : 'unchecked';
}
/** The day and the time on this device's clock, `2026-10-19 09:30` — a look made once a day needs its day. */
export function checkedTime(at: number): string {
  const time = new Date(at), pad = (n: number) => String(n).padStart(2, '0');
  return time.getFullYear() + '-' + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) + ' ' + pad(time.getHours()) + ':' + pad(time.getMinutes());
}
export function updateLine(update: UpdateCheckDTO | undefined, running: string | undefined, m: Copy): string {
  const state = updateState(update);
  if (state === 'newer') return m.updateNewer(update!.newer!, running ?? '—');
  if (state === 'current') return m.updateCurrent(checkedTime(Date.parse(update!.checkedAt!)));
  if (state === 'unchecked') return m.updateNotChecked;
  if (state === 'off') return m.updateOff;
  if (state === 'damaged') return m.updateCheckDamaged;
  return '';
}
/** Whether ⚙ carries the dot: a newer release, and only while the check is on. */
export const updateDot = (update: UpdateCheckDTO | undefined): boolean => updateState(update) === 'newer';
