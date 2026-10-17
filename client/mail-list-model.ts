import { mailAlias } from '../shared/mailbox.js';
import { isNoOne, mailPeople, mailRecord, mailStatus, type MailListThreadDTO, type MailState, type MailStatus } from '../shared/mail-list.js';
import type { MailAliasRule } from '../shared/rpc.js';
import { normalizeSearch } from './filter-model.js';

/**
 * REQ-128 (research/232 v2, the owner's choice: the mail list with filter row 1): what the message list shows, pure.
 *
 * - Rows are grouped a person's decision → left waiting → open → closed, newest first in each; closed shows its newest two
 *   until opened (`MAIL_CLOSED_SHOWN`).
 * - Filters read each thread's newest file(s): who sent it (`from`) and who it waits for (`to`). Several choices in one
 *   dropdown are "or"; the two dropdowns are "and" — or "or" when the pill between them is pressed (`join`), which is "any
 *   thread this workspace is part of". "A person's decision" heads the "to" dropdown (`MAIL_PERSON`). The state dropdown
 *   holds left waiting, open and closed (a person's decision is chosen in "to"; for the state it is open or left waiting).
 * - The title search looks in the subject and the thread id.
 */
export const MAIL_PERSON = '@person';
export const MAIL_CLOSED_SHOWN = 2;
export type MailStateChoice = 'stale' | 'open' | 'closed';
export const MAIL_STATE_CHOICES: readonly MailStateChoice[] = ['stale', 'open', 'closed'];
export interface MailFilter { from: string[]; to: string[]; join: 'and' | 'or'; states: MailStateChoice[]; query: string }
export const EMPTY_MAIL_FILTER: MailFilter = { from: [], to: [], join: 'and', states: [], query: '' };
export interface MailRow { thread: MailListThreadDTO; status: MailStatus }
export interface MailHits { from: Set<string>; to: Set<string>; person: boolean }

export function mailRows(threads: readonly MailListThreadDTO[], now: number, people = mailPeople(threads)): MailRow[] {
  const at = (row: MailRow) => row.status.at ?? '';
  return threads.map(thread => ({ thread, status: mailStatus(thread, now, people) }))
    .sort((a, b) => at(b) < at(a) ? -1 : at(b) > at(a) ? 1 : a.thread.id < b.thread.id ? 1 : -1);
}
/** A row's state as the state dropdown sees it: a person's decision is open, or left waiting. */
const stateChoice = (status: MailStatus): MailStateChoice => status.state === 'decision' ? (status.stale ? 'stale' : 'open') : status.state;
const fromHit = (row: MailRow, from: readonly string[]) => row.status.from.filter(f => from.includes(f));
const toHit = (row: MailRow, to: readonly string[]) => row.status.to.filter(t => !mailRecord(t) && to.includes(t));
const personHit = (row: MailRow, to: readonly string[]) => to.includes(MAIL_PERSON) && row.status.state === 'decision';
function matchesQuery(row: MailRow, query: string): boolean {
  const q = normalizeSearch(query);
  return !q || normalizeSearch(row.thread.subject + ' ' + row.thread.id).includes(q);
}
/** Which of the row's names the filter caught (drawn underlined), or null when the row is filtered out. */
export function mailMatch(row: MailRow, filter: MailFilter): MailHits | null {
  if (!matchesQuery(row, filter.query)) return null;
  if (filter.states.length && !filter.states.includes(stateChoice(row.status))) return null;
  const from = fromHit(row, filter.from), to = toHit(row, filter.to), person = personHit(row, filter.to);
  const fromOk = !filter.from.length || from.length > 0, toOk = !filter.to.length || to.length > 0 || person;
  const ok = filter.from.length && filter.to.length && filter.join === 'or' ? fromOk || toOk : fromOk && toOk;
  return ok ? { from: new Set(from), to: new Set(to), person } : null;
}
export const mailFilterCount = (f: MailFilter) => f.from.length + f.to.length + f.states.length + (f.query.trim() ? 1 : 0);

export interface MailGroup { state: MailState; rows: MailRow[]; hidden: number }
/** The rows the filter keeps, grouped in the list's order; empty groups left out. */
export function mailGroups(rows: readonly MailRow[], filter: MailFilter, closedOpen: boolean): { groups: MailGroup[]; shown: number; hits: Map<string, MailHits> } {
  const hits = new Map<string, MailHits>(), kept: MailRow[] = [];
  for (const row of rows) { const hit = mailMatch(row, filter); if (hit) { hits.set(row.thread.id, hit); kept.push(row); } }
  const groups: MailGroup[] = [];
  for (const state of ['decision', 'stale', 'open', 'closed'] as const) {
    const all = kept.filter(r => r.status.state === state);
    if (!all.length) continue;
    const rows = state === 'closed' && !closedOpen ? all.slice(0, MAIL_CLOSED_SHOWN) : all;
    groups.push({ state, rows, hidden: all.length - rows.length });
  }
  return { groups, shown: kept.length, hits };
}

export interface MailOption { id: string; name: string; note?: string; count: number }
/**
 * A dropdown's choices: every workspace's short name (from Paseo's listing, with its name as a note) and every name the
 * threads use on that side, each with how many threads name it there; most first, then by name. A person's record ("X (기록:
 * Y)") and "없음" are not workspaces and are left out — a person's decision is the pinned first row of "to".
 */
export function mailOptions(rows: readonly MailRow[], side: 'from' | 'to', workspaces: readonly { cwd: string; name: string }[], rule: MailAliasRule): MailOption[] {
  const notes = new Map<string, Set<string>>();
  for (const w of workspaces) {
    const alias = mailAlias(w.cwd, rule);
    if (!alias) continue;
    const set = notes.get(alias) ?? new Set<string>();
    if (w.name && w.name !== alias) set.add(w.name);
    notes.set(alias, set);
  }
  const counts = new Map<string, number>();
  for (const alias of notes.keys()) counts.set(alias, 0);
  for (const row of rows) for (const name of side === 'from' ? row.status.from : row.status.to) {
    if (isNoOne(name) || mailRecord(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => { const note = [...(notes.get(id) ?? [])].join(' · ');
    return { id, name: id, count, ...(note ? { note } : {}) }; })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
}
/** The choices whose name or note holds the typed words. */
export function searchOptions(options: readonly MailOption[], query: string): MailOption[] {
  const q = normalizeSearch(query);
  return q ? options.filter(o => normalizeSearch(o.name + ' ' + (o.note ?? '')).includes(q)) : [...options];
}
/** Picking a choice: on adds it, off removes it. */
export const toggleChoice = <T extends string>(list: readonly T[], id: T): T[] => list.includes(id) ? list.filter(v => v !== id) : [...list, id];
/** A dropdown's trigger words: its name; with one chosen, the name and the choice; with more, the name (the count is a badge). */
export function pickerLabel(name: string, chosen: readonly string[], nameOf: (id: string) => string): { text: string; count: number } {
  return chosen.length === 1 ? { text: name + ' ' + nameOf(chosen[0]!), count: 0 } : { text: name, count: chosen.length };
}
