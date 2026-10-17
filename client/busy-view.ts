import type { BusyDTO } from '../shared/rpc.js';
import { elapsed, type Elapsed } from './card-meta.js';

/**
 * REQ-84: a card's busy mark (`kanban card busy`, server/busy.ts) as the card and the detail show it — the words, how long
 * it has been on ("Testing · 12m") and, past two hours, that a person should look ("Busy over 2h", counted with the cards
 * needing a person). Never switched off by time. Pure: no React, no SDK.
 */
export const BUSY_OVERDUE_MS = 2 * 3600_000;
export interface BusyView {
  text: string;
  since: string;
  by: string;
  age: Elapsed;
  overdue: boolean;
}
export function busyView(mark: BusyDTO | null | undefined, now: number): BusyView | null {
  if (!mark) return null;
  const since = Date.parse(mark.since);
  if (!Number.isFinite(since)) return null;
  return { text: mark.text, since: mark.since, by: mark.by, age: elapsed(mark.since, now)!, overdue: now - since > BUSY_OVERDUE_MS };
}
/** REQ-130: who the detail's memo is recorded as (server/busy.ts `BUSY_BY_SCREEN`) — shown as "the board screen". */
export const SCREEN_BY = 'screen';
/** REQ-130: the memo's words as `busyText` keeps them (one line, trimmed, 1-200 characters), or null. */
export function memoText(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  return text && [...text].length <= 200 ? text : null;
}
/** A Paseo agent's id (`PASEO_AGENT_ID`, what `kanban card busy` records when an agent marks a card). */
export function isAgentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
/**
 * Research/174 J3: who turned the mark on, as a person reads it — an agent by its title in the signal store ("총괄-07"), else
 * its id's first 8 characters; "cli" and a person's name (`--by`) as they are.
 */
export function busyByName(by: string, title?: string | null): string {
  if (!isAgentId(by)) return by;
  return title?.trim() || by.slice(0, 8);
}
/** Whether the card's mark has been on for more than two hours — a reason it needs a person. */
export function busyOverdue(mark: BusyDTO | null | undefined, now: number): boolean {
  return !!busyView(mark, now)?.overdue;
}
