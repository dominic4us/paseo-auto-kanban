import { needsHuman, type Stage } from '../shared/core/domain.js';
import type { BoardCardDTO } from '../shared/rpc.js';
import type { SignalBucket } from './signal-model.js';

/**
 * REQ-104: a lead card's second summary row — what the lead is waiting for, read from what the board and the agent
 * signals already say (nothing new is saved). Pure: no React, no SDK. The parts, each left out at zero:
 *
 * - running — its sub-cards with an agent at work (`working`);
 * - testing — REQ-84 first: the cards with a busy mark (`kanban card busy` — the lead's own test run), timed from when the
 *   earliest mark went on. REQ-130: not the lead's card itself — its mark is its memo line, shown under the row. Only with none, the older rule: the lead's check under way: a card in the progress column (the stage after the first, not a completion
 *   one) titled "총괄 확인…" or whose next action says "테스트 중"; its time is "시작 HH:MM" of that next action, else when
 *   the card last changed. Among its sub-cards and the lead agent's own other cards (a lead's check card is linked to the
 *   lead's agent, so it is no sub-card); the earliest one's time is shown;
 * - awaiting — its sub-cards waiting for you: the card's own "Response needed" rule (`needsReply`) — an agent asking for a
 *   permission, or the ledger's "needs attention" rule (`needsHuman`) for an awaited user. D43: and the lead itself, its
 *   own agent asking for a permission or a question (`lead` given) — the lead's card id first, counted once.
 *
 * With none of these the row says when the lead's agent was last active: "working" while that agent is at work itself
 * (research/166 J3), else idle.
 *
 * REQ-130 (research/260 C): the row now always starts with the lead's own state (`me`), whatever follows — at work
 * ("Lead working · 12m"), waiting on you, or resting ("Resting · since 17:42"). Read from the agent signals alone; nothing
 * is saved. REQ-133 (research/264 J7): the wait says which one it is — it asks you a question or a permission ("Awaiting
 * answer · 5m"), it finished a turn you have not looked at yet ("Awaiting review · 5m": Paseo's attention, which the app
 * clears when you open, type in or leave that chat), or it stopped on an error ("Error · 5m").
 */
export type StatusCard = Pick<BoardCardDTO, 'id' | 'title' | 'stageId' | 'nextAction' | 'awaiting' | 'agentIds' | 'blocked' | 'intent'>
  & { updatedAt?: string | undefined; busy?: BoardCardDTO['busy'] | undefined };
export type LeadStatusKind = 'running' | 'testing' | 'awaiting';
/**
 * REQ-130: the lead's own state — its agent at work, waiting on you, or resting. REQ-133: the wait split by what it wants —
 * an answer (`asking`: a question or a permission), a look (`unseen`: a finished turn not looked at yet) or a recovery (`error`).
 */
export type LeadSelfKind = 'working' | 'asking' | 'unseen' | 'error' | 'rest';
/** REQ-133: the states that wait on you, most urgent first (an error first, as the card's own mark ranks it). */
export const LEAD_WAITS: readonly LeadSelfKind[] = ['error', 'asking', 'unseen'];
export interface LeadSelf {
  kind: LeadSelfKind;
  /** ISO: when it began (at work, waiting on you) or the last activity (resting); '' when unknown. */
  since: string;
  /** REQ-133: the lead's agent in that state — the chat a press on a wait opens ('' resting). */
  agent: string;
}
export interface LeadStatus {
  running: string[];
  /** The earliest check's start ("21:40", or "09-26 21:40" before today) and every check card. */
  testing: { at: string; ids: string[] } | null;
  awaiting: string[];
  /** D43: the lead's own agent asks you — `awaiting` starts with the lead's card id. */
  self: boolean;
  /** Only when the three above are empty: when the lead's agent was last active ('' when unknown). */
  idle: string | null;
  /** With `idle`: the lead's own agent is at work, so the row says "working", not idle. */
  working: boolean;
  /** REQ-130: the lead's own state, first on the row; null for a card with no agent of its own. */
  me: LeadSelf | null;
}
export interface LeadStatusInput {
  /** The lead's sub-cards (`linkStages`). */
  members: readonly StatusCard[];
  /** The other cards of the board whose first agent is one of the lead's own. */
  own: readonly StatusCard[];
  stages: readonly Pick<Stage, 'stageId' | 'countsAsDone'>[];
  read: (agentId: string) => SignalBucket;
  /** REQ-84: the lead's own card (D43: its id; REQ-130: its busy mark is its memo, no check of this row). */
  lead?: Pick<StatusCard, 'id' | 'busy'> | undefined;
  /** The lead card's own agents, whose work keeps the row from reading idle. */
  leadAgentIds?: readonly string[] | undefined;
  /** The lead agent's last activity (ISO), or the lead card's last change when the host says none. */
  activeAt?: string | undefined;
  /** REQ-130: when an agent's state last changed as the screen saw it (`SignalSource.since`). */
  since?: ((agentId: string) => string | undefined) | undefined;
  /** REQ-130: an agent's own last activity (`SignalSource.activity`). */
  activity?: ((agentId: string) => string | undefined) | undefined;
  now: number;
}
/**
 * REQ-104 → REQ-136 H3 (research/272): the times on the row are the device's own, as every other time on the screens
 * (the detail's Created and Updated, "Last checked"). Until 0.1.51 they were fixed to Korea's (KST) whatever the device's
 * zone, so a device elsewhere saw a clock hours off beside its own; a device in Korea reads the same as before.
 */
const two = (n: number) => String(n).padStart(2, '0');
const dayOf = (at: Date) => at.getFullYear() * 10000 + at.getMonth() * 100 + at.getDate();
/** "21:40" for a time of the device's today, "09-26 21:40" before it; '' for no time. */
export function deviceClock(at: number | string | undefined, now: number): string {
  const time = typeof at === 'string' ? Date.parse(at) : at;
  if (time === undefined || !Number.isFinite(time)) return '';
  const local = new Date(time), clock = two(local.getHours()) + ':' + two(local.getMinutes());
  return dayOf(local) < dayOf(new Date(now)) ? two(local.getMonth() + 1) + '-' + two(local.getDate()) + ' ' + clock : clock;
}
/**
 * A lead's check card: "총괄 확인…" or "…테스트 중…" in the next action — the older rule, kept for the cards already written
 * so. REQ-136 H3: no English words are added to it — "testing" is common in any English next action and would mark cards
 * that are no check; the busy mark (`kanban card busy`, any language) is the way to say a check runs.
 */
export function isCheckCard(card: Pick<StatusCard, 'title' | 'nextAction'>): boolean {
  return card.title.trim().startsWith('총괄 확인') || card.nextAction.includes('테스트 중');
}
/** The progress column: the stage after the first, unless it counts as done ("진행" of the built-in template). */
export function inProgressStage(stageId: string, stages: LeadStatusInput['stages']): boolean {
  const index = stages.findIndex(s => s.stageId === stageId);
  return index === 1 && !stages[index]!.countsAsDone;
}
const KST_OFFSET = 9 * 3600_000;
/**
 * When a check started: "시작 HH:MM" in its next action — written in Korea's time (docs/agent-guide.md), so read as that clock
 * on the Korean day of the card's last change (the day before when that would put it more than an hour after the change).
 * REQ-136 F1: only the display follows the device (`deviceClock`); the instant does not. Else the change itself. NaN when neither says.
 */
export function checkStart(card: Pick<StatusCard, 'nextAction' | 'updatedAt'>, now: number): number {
  const changed = card.updatedAt ? Date.parse(card.updatedAt) : NaN;
  const said = /시작\s*(\d{1,2}):(\d{2})/.exec(card.nextAction);
  if (!said) return changed;
  const hours = Number(said[1]), minutes = Number(said[2]);
  if (hours > 23 || minutes > 59) return changed;
  const base = Number.isFinite(changed) ? changed : now;
  // Korea has no daylight saving: its day is the UTC fields of the instant shifted by nine hours, whatever the device's zone.
  const kst = new Date(base + KST_OFFSET);
  const start = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), hours, minutes) - KST_OFFSET;
  return start > base + 3600_000 ? start - 86_400_000 : start;
}
/** Whether a sub-card waits for you — `needsHuman`'s "awaiting the user" reason, not a block or a draft. */
export function awaitsUser(card: StatusCard, stages: LeadStatusInput['stages']): boolean {
  return card.awaiting === 'user' && needsHuman({ stageId: card.stageId, archivedAt: null, awaiting: card.awaiting,
    blockedReason: card.blocked ? '' : null, intent: card.intent }, stages);
}
/** The agent of a card asking for a permission, if one is — what turns the card's stripe orange whatever its stage. */
export function askingAgent(agentIds: readonly string[], read: LeadStatusInput['read']): string | undefined {
  return agentIds.find(id => !!id && read(id) === 'permission');
}
/**
 * The card's "Response needed" (research/166 D1): an agent of it asks for a permission, or it waits for you
 * (`awaitsUser`). The card's face and a lead's "awaiting" part read this one rule.
 */
export function needsReply(card: StatusCard, stages: LeadStatusInput['stages'], read: LeadStatusInput['read']): boolean {
  return !!askingAgent(card.agentIds, read) || awaitsUser(card, stages);
}
/** REQ-84: the busy-marked cards among the lead's sub-cards and its agent's other cards, each once (REQ-130: not the lead's own). */
function markedChecks(lead: LeadStatusInput['lead'], cards: readonly StatusCard[]): { id: string; start: number }[] {
  const seen = new Set<string>(lead ? [lead.id] : []), checks: { id: string; start: number }[] = [];
  for (const card of cards) {
    if (seen.has(card.id) || !card.busy) continue;
    seen.add(card.id); checks.push({ id: card.id, start: Date.parse(card.busy.since) });
  }
  return checks;
}
/** REQ-133: which wait each bucket is — asking you, finished and not looked at, stopped on an error. */
const WAIT: Partial<Record<SignalBucket, LeadSelfKind>> = { permission: 'asking', attention: 'unseen', error: 'error' };
/**
 * REQ-130: the lead's own state from its agents' signals — a wait first (any of them waits on you; REQ-133: the most urgent
 * of `LEAD_WAITS`), then at work, else resting. Its time: when the state began (REQ-133: the host's own time where it gives
 * one, see `SignalSource.since`, else when the screen saw it begin); for a wait, else that agent's last activity (when it
 * finished); resting, the lead's last activity. Null with no agent.
 */
export function leadSelf({ read, leadAgentIds = [], activeAt, since, activity }:
  Pick<LeadStatusInput, 'read' | 'leadAgentIds' | 'activeAt' | 'since' | 'activity'>): LeadSelf | null {
  const ids = leadAgentIds.filter(id => !!id);
  if (!ids.length) return null;
  for (const kind of LEAD_WAITS) {
    const wait = ids.find(id => WAIT[read(id)] === kind);
    if (wait) return { kind, since: since?.(wait) || activity?.(wait) || activeAt || '', agent: wait };
  }
  const working = ids.find(id => read(id) === 'working');
  if (working) return { kind: 'working', since: since?.(working) || '', agent: working };
  return { kind: 'rest', since: activeAt || '', agent: '' };
}
/** REQ-133: whether the lead's own state waits on you (an answer, a look or an error). */
export function selfWaits(self: LeadSelf | null | undefined): boolean {
  return !!self && LEAD_WAITS.includes(self.kind);
}
export function leadStatus({ members, own, stages, read, lead, leadAgentIds = [], activeAt, since, activity, now }: LeadStatusInput): LeadStatus {
  const running = members.filter(card => card.agentIds.some(id => !!id && read(id) === 'working')).map(card => card.id);
  const awaiting = members.filter(card => needsReply(card, stages, read)).map(card => card.id);
  // D43: the lead's own agent asking you (a question is a permission too) is one more wait, counted as the lead's card.
  const self = !!lead && !awaiting.includes(lead.id) && !!askingAgent(leadAgentIds, read);
  if (self) awaiting.unshift(lead!.id);
  // REQ-84: the busy marks lead; the check cards by title or next action only stand in where no card is marked.
  const seen = new Set<string>(), checks = markedChecks(lead, [...members, ...own]);
  if (!checks.length) for (const card of [...members, ...own]) {
    if (seen.has(card.id) || !inProgressStage(card.stageId, stages) || !isCheckCard(card)) continue;
    seen.add(card.id); checks.push({ id: card.id, start: checkStart(card, now) });
  }
  const first = checks.filter(v => Number.isFinite(v.start)).sort((a, b) => a.start - b.start)[0];
  const testing = checks.length ? { at: first ? deviceClock(first.start, now) : '', ids: checks.map(v => v.id) } : null;
  const idle = !running.length && !testing && !awaiting.length ? deviceClock(activeAt, now) : null;
  const working = idle !== null && leadAgentIds.some(id => !!id && read(id) === 'working');
  return { running, testing, awaiting, self, idle, working, me: leadSelf({ read, leadAgentIds, activeAt, since, activity }) };
}
/**
 * The cards a part highlights: its sub-cards at work, the check cards, or the cards waiting for you — D43: the lead's own
 * card when it asks itself and nothing else waits (its card rings alone, where `CardTile` has no jump to its agent); with
 * sub-cards waiting too, those alone — the lead's card rings anyway, and a phone moves to their tab (research/166 J2).
 */
export function statusIds(status: LeadStatus, kind: LeadStatusKind): string[] {
  if (kind === 'awaiting' && status.self && status.awaiting.length > 1) return status.awaiting.slice(1);
  return kind === 'testing' ? status.testing?.ids ?? [] : status[kind];
}
/**
 * REQ-130: how many waits the "awaiting" part shows — when the lead asks you itself its wait is already its state mark, so it
 * is not counted twice. REQ-133: only "Awaiting answer" is that wait; a mark saying "Awaiting review" or "Error" leaves it counted.
 */
export function awaitingShown(status: LeadStatus): number {
  return status.me?.kind === 'asking' && status.self ? status.awaiting.length - 1 : status.awaiting.length;
}
export function statusKey(status: LeadStatus): string { return JSON.stringify(status); }
/**
 * REQ-135: the sub-cards' parts of a lead's status — running, waiting for you, its check — each left out at zero, in the
 * order the family line says them after "Sub-cards N" ("Sub-cards 11 · Running 1 · not done 3 · Awaiting you 1 · Testing 21:40~").
 */
export function statusParts(status: LeadStatus): LeadStatusKind[] {
  return [...(status.running.length ? ['running' as const] : []), ...(awaitingShown(status) ? ['awaiting' as const] : []),
    ...(status.testing ? ['testing' as const] : [])];
}
/**
 * REQ-135: how much the family line says once the sub-cards' parts joined it — the first that fits the card's width:
 * - full: every part's own words ("Running 1", "Awaiting you 1", "Testing 21:40~");
 * - short: shorter words, the counts and the time whole ("Run 1", "open 3", "Await 1", "Test 21:40~"; 실행·미완·대기·테스트);
 * - clock: the check as a clock and its time alone ("🕘 21:40~");
 * - icon: the check as its clock alone (still its press; its words and time are what a screen reader hears);
 * - drop: the check left out (the least urgent part) — "Sub-cards N", running, not done and awaiting are never left out,
 *   and no count is ever cut;
 * - tight (research/275 F1): "Sub-cards" said by its tree alone ("🌳 101 · Run 100 · open 101 · Await 100") — the first part,
 *   the one word the line has a glyph for;
 * - bare: the other words cut to their first letter too ("🌳 1001 · R 1000 · o 1001 · A 1000"; 실·미·대) — the last fit, taken
 *   when nothing fits: four figures in every part still fit a 210px card, five a 264px one.
 * No count is left out, cut or wrapped at any fit, the parts keep their order and press, and a screen reader hears their whole words.
 * `width` says how wide the line is at a fit (`familyWidth` in components.tsx, read on the safe side).
 */
export type FamilyFit = 'full' | 'short' | 'clock' | 'icon' | 'drop' | 'tight' | 'bare';
export const FAMILY_FITS: readonly FamilyFit[] = ['full', 'short', 'clock', 'icon', 'drop', 'tight', 'bare'];
export function familyFit(width: (fit: FamilyFit) => number, room: number): FamilyFit {
  return FAMILY_FITS.find(fit => width(fit) <= room) ?? 'bare';
}
