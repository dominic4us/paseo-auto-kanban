import type { BoardCardDTO } from '../shared/rpc.js';

/**
 * REQ-149 (research/423): "Check up" — the cards a person may want to finish or put away, found from what the screens
 * already read and nothing else: the boards (`BoardDTO`) and the agent signal store (`SignalSource.archived`, `pending`,
 * `activity`). Pure: no React, no SDK, no ledger; it runs in Hermes as in node (tests/fixtures/hermes-runtime/entry.ts).
 * Nothing here moves a card: the screen lists the candidates, a person ticks some and chooses "Done" or "Archive", and the
 * screen sends those through the ledger's own `move` / `archive` (`checkupPlan`).
 *
 * The four rules, in the order the list shows them (each card at most once, the first that holds):
 * - `orphaned` (R1): a request in a stage after the first and before the completion ones whose every linked agent is known
 *   to be archived — the same evidence as the card's own "Done" (`isOrphanedCard`, `offersDone`). Suggests Done.
 * - `stalled` (R2): a request there that entered its stage, last changed and whose live agents were last active all more than
 *   `stalledDays` ago; the board's lead card is left out (a lead lives long on purpose). Suggests nothing — look only.
 * - `waiting` (R3): a request in the first stage that entered it and last changed more than `waitingDays` ago, its live
 *   agents quiet as long. Suggests nothing: a backlog waits on purpose.
 * - `draft` (R4): an instruction draft never sent, made and last changed more than `draftDays` ago. Suggests Archive.
 * Never a candidate: a card in a completion stage (REQ-52's "Tidy" and automatic archive look after those), one blocked,
 * waiting for a person's answer, under a busy mark or with a request on its way to the lead (each already says so), one
 * whose agents the store is still naming (`pending`), and one with a time it cannot read (an older server).
 */
export const DAY_MS = 86_400_000;
export interface CheckupLimits { stalledDays: number; waitingDays: number; draftDays: number }
export const CHECKUP_LIMITS: CheckupLimits = { stalledDays: 7, waitingDays: 14, draftDays: 14 };
export const CHECKUP_RULES = ['orphaned', 'stalled', 'waiting', 'draft'] as const;
export type CheckupRule = typeof CHECKUP_RULES[number];
export type CheckupAction = 'done' | 'archive';
/** A "skip" holds a card out of the list until it changes or this many days pass (per device). */
export const SKIP_DAYS = 7;

export interface CheckupSignals {
  /** True only on positive evidence that the agent is archived (`SignalSource.archived`). */
  archived: (agentId: string) => boolean;
  /** True while the store may still name the agent (REQ-78 ④); such a card waits until it is known. */
  pending?: ((agentId: string) => boolean) | undefined;
  /** The agent's last activity (ISO), if the store has seen it (REQ-104). */
  activity?: ((agentId: string) => string | undefined) | undefined;
  /** Whether the agents have been read at all; before that no card with an agent is judged. */
  ready: boolean;
}
export type CheckupCard = Pick<BoardCardDTO, 'id' | 'title' | 'stageId' | 'intent' | 'blocked' | 'awaiting' | 'agentIds'>
  & Partial<Pick<BoardCardDTO, 'updatedAt' | 'createdAt' | 'stageEnteredAt' | 'dispatch' | 'busy' | 'busyEndedAt'>>;
export interface CheckupStage { stageId: string; name: string; countsAsDone: boolean; cards: readonly CheckupCard[] }
export interface CheckupBoard { summary: { id: string; revision: string; lead?: string | undefined }; stages: readonly CheckupStage[] }
export interface CheckupCandidate {
  /** `boardId` and `cardId` joined — the selection's and the skip list's key. */
  key: string;
  boardId: string; cardId: string; title: string; rule: CheckupRule;
  /** What the list suggests (a tag only — nothing is ticked by it): Done, Archive, or nothing. */
  suggest: CheckupAction | null;
  stageId: string; stageName: string;
  /** What the days count from — entering the stage, or (a draft) being made — and those whole days. */
  since: string; days: number;
  /** The linked agents (distinct), and how many of them are known to be archived (gate 431 F4: none, some or all). */
  agents: number; archivedAgents: number;
  /** A card with a live agent whose activity is known: the latest activity among the live ones and whose it was. */
  lastActive?: { at: string; agentId: string; days: number };
  /** The one linked agent when it is archived (an `orphaned` card, or a waiting one whose agent left), to name on its line. */
  agentId?: string;
  /** The board's first completion stage, where Done takes it; absent for a draft (the ledger keeps drafts out) or none. */
  doneStageId?: string;
  revision: string; updatedAt: string;
}

/** True when `at` is a readable time more than `days` whole days before `now`. Unreadable or missing: false (fail closed). */
export function olderThan(at: string | undefined, now: number, days: number): boolean {
  const time = at ? Date.parse(at) : NaN;
  return Number.isFinite(time) && now - time > days * DAY_MS;
}
const wholeDays = (at: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(at)) / DAY_MS));
const distinct = (ids: readonly string[]): string[] => [...new Set(ids.filter(id => !!id))];

/** What already speaks for the card elsewhere, so the check up says nothing of it. */
function heldElsewhere(card: CheckupCard): boolean {
  return card.blocked || card.awaiting === 'user' || !!card.busy || (!!card.dispatch && card.dispatch.state !== 'sent');
}
/** The latest activity among `live` agents, or null when any of them has none the store knows (then nothing is judged). */
function latestActivity(live: readonly string[], signals: CheckupSignals): { at: string; agentId: string } | null {
  let best: { at: string; agentId: string; time: number } | null = null;
  for (const agentId of live) {
    const at = signals.activity?.(agentId), time = at ? Date.parse(at) : NaN;
    if (!at || !Number.isFinite(time)) return null;
    if (!best || time > best.time) best = { at, agentId, time };
  }
  return best ? { at: best.at, agentId: best.agentId } : null;
}
/** The rule one card meets in `stage` (`first`: the template's first stage), or null. */
export function checkupRule(card: CheckupCard, stage: Pick<CheckupStage, 'countsAsDone'>, first: boolean, lead: string | undefined,
  signals: CheckupSignals, now: number, limits: CheckupLimits = CHECKUP_LIMITS): CheckupRule | null {
  if (stage.countsAsDone || heldElsewhere(card)) return null;
  const ids = distinct(card.agentIds);
  if (ids.length && (!signals.ready || ids.some(id => signals.pending?.(id) === true))) return null;
  if (card.intent === 'draft')
    return !card.dispatch && olderThan(card.createdAt, now, limits.draftDays) && olderThan(card.updatedAt, now, limits.draftDays) ? 'draft' : null;
  const entered = card.stageEnteredAt ?? card.updatedAt;
  const live = ids.filter(id => !signals.archived(id));
  if (first) {
    if (!olderThan(entered, now, limits.waitingDays) || !olderThan(card.updatedAt, now, limits.waitingDays)) return null;
    if (!live.length) return 'waiting';
    const active = latestActivity(live, signals);
    return active && olderThan(active.at, now, limits.waitingDays) ? 'waiting' : null;
  }
  if (ids.length && !live.length) return 'orphaned';
  if (lead && ids.includes(lead)) return null;
  if (!olderThan(entered, now, limits.stalledDays) || !olderThan(card.updatedAt, now, limits.stalledDays)) return null;
  // Research/174 J2: a busy mark turned off lately is recent work too.
  if (card.busyEndedAt && !olderThan(card.busyEndedAt, now, limits.stalledDays)) return null;
  if (!live.length) return 'stalled';
  const active = latestActivity(live, signals);
  return active && olderThan(active.at, now, limits.stalledDays) ? 'stalled' : null;
}
function candidateOf(board: CheckupBoard, stage: CheckupStage, card: CheckupCard, rule: CheckupRule, done: string | undefined,
  signals: CheckupSignals, now: number): CheckupCandidate {
  const ids = distinct(card.agentIds), since = rule === 'draft' ? card.createdAt! : (card.stageEnteredAt ?? card.updatedAt)!;
  const live = ids.filter(id => !signals.archived(id)), active = rule !== 'draft' && live.length ? latestActivity(live, signals) : null;
  const doneStageId = card.intent === 'requested' ? done : undefined;
  return { key: board.summary.id + '\u0000' + card.id, boardId: board.summary.id, cardId: card.id, title: card.title, rule,
    suggest: rule === 'orphaned' ? (doneStageId ? 'done' : null) : rule === 'draft' ? 'archive' : null,
    stageId: stage.stageId, stageName: stage.name, since, days: wholeDays(since, now), agents: ids.length, archivedAgents: ids.length - live.length,
    ...(active ? { lastActive: { ...active, days: wholeDays(active.at, now) } } : {}),
    ...(ids.length === 1 && !live.length ? { agentId: ids[0]! } : {}),
    ...(doneStageId ? { doneStageId } : {}), revision: board.summary.revision, updatedAt: card.updatedAt ?? '' };
}
function boardCandidates(board: CheckupBoard, signals: CheckupSignals, now: number, limits: CheckupLimits, into: CheckupCandidate[]): void {
  const first = board.stages[0]?.stageId, done = board.stages.find(s => s.countsAsDone)?.stageId;
  for (const stage of board.stages) {
    if (stage.countsAsDone) continue;
    for (const card of stage.cards) {
      const rule = checkupRule(card, stage, stage.stageId === first, board.summary.lead, signals, now, limits);
      if (rule) into.push(candidateOf(board, stage, card, rule, done, signals, now));
    }
  }
}
/** Every candidate of `boards`, by rule (R1 → R4), then the longest waiting first, then by title. */
export function checkupCandidates(boards: readonly CheckupBoard[], signals: CheckupSignals, now: number,
  limits: CheckupLimits = CHECKUP_LIMITS): CheckupCandidate[] {
  const out: CheckupCandidate[] = [];
  for (const board of boards) boardCandidates(board, signals, now, limits, out);
  return out.sort((a, b) => CHECKUP_RULES.indexOf(a.rule) - CHECKUP_RULES.indexOf(b.rule) ||
    Date.parse(a.since) - Date.parse(b.since) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
}
/** A cheap identity of a list, so a screen re-renders only when a candidate comes, goes or changes. */
export function checkupKey(list: readonly CheckupCandidate[]): string {
  // Gate 433 F4: every field — the agents archived, the live one's activity, the names and the revision included — so a signal
  // that changes only what a line says still renews the list.
  return JSON.stringify(list);
}

/** "Skip": the card's key → when it was skipped and the change it was skipped at. */
export type CheckupSkips = Readonly<Record<string, { at: string; updatedAt: string }>>;
/** A skip holds while the card has not changed since and fewer than `SKIP_DAYS` days have passed. */
export function skipHolds(skips: CheckupSkips, candidate: Pick<CheckupCandidate, 'key' | 'updatedAt'>, now: number): boolean {
  const entry = skips[candidate.key];
  return !!entry && entry.updatedAt === candidate.updatedAt && !olderThan(entry.at, now, SKIP_DAYS);
}
export function withoutSkipped(list: readonly CheckupCandidate[], skips: CheckupSkips, now: number): CheckupCandidate[] {
  return list.filter(c => !skipHolds(skips, c, now));
}
/** The skips with one more, those that no longer hold dropped (the list a device keeps never grows on its own). */
export function addSkip(skips: CheckupSkips, candidate: Pick<CheckupCandidate, 'key' | 'updatedAt'>, now: number): CheckupSkips {
  const kept: Record<string, { at: string; updatedAt: string }> = {};
  for (const key of Object.keys(skips)) if (!olderThan(skips[key]!.at, now, SKIP_DAYS)) kept[key] = skips[key]!;
  kept[candidate.key] = { at: new Date(now).toISOString(), updatedAt: candidate.updatedAt };
  return kept;
}
/** A device's kept skips as read back: anything that is not one is dropped. */
export function readSkips(value: unknown): CheckupSkips {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, { at: string; updatedAt: string }> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as { at?: unknown; updatedAt?: unknown } | null;
    if (e && typeof e.at === 'string' && typeof e.updatedAt === 'string') out[key] = { at: e.at, updatedAt: e.updatedAt };
  }
  return out;
}

/** What the footer says of a selection: how many are ticked, how many Done can take (drafts and boards with no done stage cannot). */
export function selectionCounts(list: readonly CheckupCandidate[], selected: ReadonlySet<string>): { total: number; done: number; notDone: number } {
  const ticked = list.filter(c => selected.has(c.key)), done = ticked.filter(c => !!c.doneStageId).length;
  return { total: ticked.length, done, notDone: ticked.length - done };
}
/**
 * One board's share of an action: the ledger operations (100 at most per write, `BATCH`) and where each card was.
 * `revision` is the board's revision as the list read it — the only one the action writes on (the ledger's compare-and-swap);
 * in an outcome it is the revision the check up's own last write produced, the only one its Undo writes on (gate 433).
 */
export type CheckupOperation = { op: 'move'; id: string; to: string } | { op: 'archive'; id: string };
export interface CheckupPlanCard { cardId: string; from: string; to?: string; title: string }
export interface CheckupPlanBoard { boardId: string; revision: string; cards: CheckupPlanCard[] }
export const CHECKUP_BATCH = 100;
/** The ticked candidates `action` applies to, by board in list order; Done leaves out what it cannot take (`skipped`). */
export function checkupPlan(list: readonly CheckupCandidate[], selected: ReadonlySet<string>, action: CheckupAction): { boards: CheckupPlanBoard[]; skipped: number } {
  const boards = new Map<string, CheckupPlanBoard>();
  let skipped = 0;
  for (const c of list) {
    if (!selected.has(c.key)) continue;
    if (action === 'done' && !c.doneStageId) { skipped++; continue; }
    let board = boards.get(c.boardId);
    if (!board) { board = { boardId: c.boardId, revision: c.revision, cards: [] }; boards.set(c.boardId, board); }
    board.cards.push({ cardId: c.cardId, from: c.stageId, title: c.title, ...(action === 'done' ? { to: c.doneStageId! } : {}) });
  }
  return { boards: [...boards.values()], skipped };
}
export function operationsOf(cards: CheckupPlanBoard['cards']): CheckupOperation[] {
  return cards.map(card => card.to ? { op: 'move' as const, id: card.cardId, to: card.to } : { op: 'archive' as const, id: card.cardId });
}
/** The moves that take cards back to the stage they were in before Done. */
export function homeOperations(cards: CheckupPlanBoard['cards']): CheckupOperation[] {
  return cards.map(card => ({ op: 'move' as const, id: card.cardId, to: card.from }));
}
/** The candidates by rule, in the list's order, leaving out the rules with none. */
export function checkupGroups(list: readonly CheckupCandidate[]): { rule: CheckupRule; cards: CheckupCandidate[] }[] {
  return CHECKUP_RULES.map(rule => ({ rule, cards: list.filter(c => c.rule === rule) })).filter(group => group.cards.length > 0);
}
/** The words a candidate's line is made of (client/i18n.ts). */
export interface CheckupLineCopy {
  checkupDays: (stage: string, n: number) => string; checkupDraftDays: (n: number) => string;
  checkupArchivedOne: (name: string) => string; checkupArchivedAll: (n: number) => string;
  checkupLastActive: (n: number, name: string) => string; checkupNoAgent: string;
  checkupSomeArchived: (archived: number, total: number) => string; checkupNoActivity: (n: number) => string;
}
/**
 * A candidate's reason under its title: the workspace, how long in its stage (a draft: since it was made), and its agents —
 * the archived one by name, all archived, the latest active live one and when (gate 431 F4: with how many of them are archived,
 * when some are), or none. `name` names an agent (`assigneeName`).
 */
export function checkupLine(c: CheckupCandidate, workspace: string, name: (agentId: string) => string, m: CheckupLineCopy): string {
  const parts = workspace ? [workspace] : [];
  parts.push(c.rule === 'draft' ? m.checkupDraftDays(c.days) : m.checkupDays(c.stageName, c.days));
  if (c.rule === 'draft') return parts.join(' · ');
  const live = c.agents - c.archivedAgents;
  if (!c.agents) parts.push(m.checkupNoAgent);
  else if (!live) parts.push(c.agentId ? m.checkupArchivedOne(name(c.agentId)) : m.checkupArchivedAll(c.agents));
  else {
    parts.push(c.lastActive ? m.checkupLastActive(c.lastActive.days, name(c.lastActive.agentId)) : m.checkupNoActivity(live));
    if (c.archivedAgents) parts.push(m.checkupSomeArchived(c.archivedAgents, c.agents));
  }
  return parts.join(' · ');
}
/** What one action (or its Undo) did: cards changed, left as someone else moved them meanwhile, refused by the ledger, or unknown. */
export interface CheckupTally { count: number; left: number; refused: number; unknown: boolean }
export interface CheckupResultCopy {
  checkupMoved: (n: number) => string; checkupArchived: (n: number) => string; checkupUndone: (n: number) => string;
  checkupPartial: (n: number, left: number) => string; checkupUndoPartial: (n: number, left: number) => string;
  checkupPartialFailed: (n: number, refused: number) => string; checkupFailed: string; checkupUnknown: string;
  checkupLeftAll: (left: number) => string;
}
/**
 * The notice after an action: a lost reply first (whether it was saved is not known), then a refusal (nothing or only some
 * changed — read the board again), then cards someone moved meanwhile (left as they are), else what was done.
 */
export function checkupResult(t: CheckupTally, action: CheckupAction | 'undo', m: CheckupResultCopy): { text: string; error: boolean } {
  if (t.unknown) return { text: m.checkupUnknown, error: true };
  if (t.refused) return { text: t.count ? m.checkupPartialFailed(t.count, t.refused) : m.checkupFailed, error: true };
  if (t.left) return { text: !t.count ? m.checkupLeftAll(t.left) : action === 'undo' ? m.checkupUndoPartial(t.count, t.left) : m.checkupPartial(t.count, t.left), error: true };
  return { text: action === 'undo' ? m.checkupUndone(t.count) : action === 'done' ? m.checkupMoved(t.count) : m.checkupArchived(t.count), error: false };
}
