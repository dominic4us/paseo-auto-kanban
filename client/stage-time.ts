import type { Stage } from '../shared/core/domain.js';
import type { BoardCardDTO } from '../shared/rpc.js';
import { elapsed, type Elapsed } from './card-meta.js';
import { inProgressStage } from './lead-status.js';
import type { SignalBucket } from './signal-model.js';

/**
 * REQ-86: how long a card has sat in its column, and when that has gone on too long. Pure: no React, no SDK. It reads only
 * what the board and the agent signals already say — `stageEnteredAt` from the server's read (the ledger's movement
 * records), the agents' buckets and last activity (REQ-104's `activity`).
 *
 * - Shown in the progress column (the stage after the first) and every later column that is not a completion one (the
 *   review column) — never in the first (waiting) or a completion column — from one hour on.
 * - Review: a warning after 12 hours in the column.
 * - Progress: a warning after 2 hours with no linked agent at work — finished, unknown and no agent at all alike — counted
 *   from the later of entering the column and the linked agents' last activity. An agent asking for a permission is not
 *   counted: the card already turns orange for it ("Response needed"). REQ-107: nor is a card waiting for a person's answer
 *   (`awaiting` = user) — the same orange "Response needed" already asks. Nothing is said before the agents have been read.
 * - Never part of "needs attention" (the "확인 필요 N" count): it is a quieter signal on the card's face only.
 */
export const DWELL = { shownAfter: 3600_000, review: 12 * 3600_000, quiet: 2 * 3600_000 } as const;
export type DwellKind = 'progress' | 'review';
export interface Dwell {
  kind: DwellKind;
  /** When the card entered the column (ISO); `estimated` when the server had only the card's last change to go on. */
  enteredAt: string;
  estimated: boolean;
  /** How long it has sat there (ms, never negative) and that in the card's units ("14h"). */
  ms: number;
  age: Elapsed;
  /** Written on the card's face (an hour or more). */
  shown: boolean;
  warn: boolean;
}
export type DwellCard = Pick<BoardCardDTO, 'stageId' | 'agentIds' | 'stageEnteredAt' | 'stageEnteredEstimated' | 'updatedAt'> & Partial<Pick<BoardCardDTO, 'busy' | 'busyEndedAt' | 'awaiting'>>;
export interface DwellSignals {
  read: (agentId: string) => SignalBucket;
  /** The agent's last activity (ISO), if known. */
  activity?: ((agentId: string) => string | undefined) | undefined;
  /** Whether the agents have been read at all; before that a linked agent's "unknown" means nothing yet. */
  ready: boolean;
}
/** Which of the two rules a column follows, or null where no time is shown (the first column, a completion one). */
export function dwellKind(stageId: string, stages: readonly Pick<Stage, 'stageId' | 'countsAsDone'>[]): DwellKind | null {
  const index = stages.findIndex(s => s.stageId === stageId);
  if (index < 1 || stages[index]!.countsAsDone) return null;
  return inProgressStage(stageId, stages) ? 'progress' : 'review';
}
/**
 * The progress rule: when the card last had an agent at work (or entered the column, if later); null while one works or asks.
 * REQ-84: a busy mark (`kanban card busy` — a lead's own test run, a person's build) is work too: null while it is on, and
 * (research/174 J2) its end counts as the card's last activity, so turning it off starts the two hours rather than ending them.
 */
export function quietSince(card: Pick<DwellCard, 'agentIds' | 'busy' | 'busyEndedAt' | 'awaiting'>, enteredAt: number, signals: DwellSignals): number | null {
  // REQ-107: waiting for a person's answer, like asking for a permission below — the card already says "Response needed".
  if (card.busy || card.awaiting === 'user') return null;
  const ids = card.agentIds.filter(Boolean);
  if (ids.length && !signals.ready) return null;
  const buckets = ids.map(id => signals.read(id));
  if (buckets.includes('working') || buckets.includes('permission')) return null;
  return Math.max(enteredAt, ...[...ids.map(id => signals.activity?.(id)), card.busyEndedAt].map(at => Date.parse(at ?? '')).filter(Number.isFinite));
}
export function stageDwell(card: DwellCard, stages: readonly Pick<Stage, 'stageId' | 'countsAsDone'>[], signals: DwellSignals,
  now: number): Dwell | null {
  const kind = dwellKind(card.stageId, stages);
  if (!kind) return null;
  // An older server says nothing of the column: the card's last change stands in, as for a record cut off.
  const enteredAt = card.stageEnteredAt ?? card.updatedAt;
  const entered = enteredAt ? Date.parse(enteredAt) : NaN;
  if (!enteredAt || !Number.isFinite(entered)) return null;
  const ms = Math.max(0, now - entered), age = elapsed(enteredAt, now)!;
  const quiet = kind === 'progress' ? quietSince(card, entered, signals) : null;
  const warn = kind === 'review' ? ms >= DWELL.review : quiet !== null && now - quiet >= DWELL.quiet;
  return { kind, enteredAt, estimated: !card.stageEnteredAt || card.stageEnteredEstimated === true, ms, age,
    shown: ms >= DWELL.shownAfter, warn };
}
/**
 * REQ-112: why a warning time warns, in one line — the card's hint under the mouse (REQ-86) and the detail's line under
 * "Entered this stage" say the same words. '' where the time does not warn.
 */
export function dwellReason(dwell: Pick<Dwell, 'kind' | 'warn'> | null, m: { dwellWarnReview: string; dwellWarnQuiet: string }): string {
  return !dwell?.warn ? '' : dwell.kind === 'review' ? m.dwellWarnReview : m.dwellWarnQuiet;
}
