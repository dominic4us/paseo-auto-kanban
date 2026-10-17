/**
 * REQ-22 agent signal vocabulary. Pure derivation only: no React, no SDK, no ledger.
 * Buckets follow plans/04 (Paseo v0.8.0 lifecycle + attention reasons); the ordering below is the
 * user's, which deliberately puts error above a permission wait (Paseo's own aggregate does the
 * reverse). `idle` is the agent being finished, never the card being in a done stage.
 */
export type SignalBucket = 'error' | 'orphaned' | 'permission' | 'working' | 'attention' | 'idle' | 'unknown';
export const SIGNAL_BUCKETS = ['error', 'orphaned', 'permission', 'working', 'attention', 'idle', 'unknown'] as const;
/** REQ-50: only these buckets draw a glyph (and so only these get the press-to-reveal tooltip on a card tile). */
export function hasSignalIcon(bucket: SignalBucket): boolean {
  return bucket === 'error' || bucket === 'orphaned' || bucket === 'permission' || bucket === 'working' || bucket === 'attention';
}
/** The fields this plugin reads from an SDK agent snapshot; everything else is ignored. */
export interface AgentSnapshotLike {
  status?: string | null;
  requiresAttention?: boolean | undefined;
  attentionReason?: string | null | undefined;
  pendingPermissions?: readonly unknown[] | null | undefined;
  archivedAt?: string | null | undefined;
  /** REQ-133 (research/264 J1): the running turn and when it began, where the host's list says. */
  activeTurn?: { startedAt?: string | null | undefined } | null | undefined;
  /** REQ-133: when the agent's attention (finished, permission, error) was raised, where the host says. */
  attentionTimestamp?: string | null | undefined;
}
export function signalBucket(agent: AgentSnapshotLike | null | undefined): SignalBucket {
  if (!agent) return 'unknown';
  if (agent.archivedAt) return 'idle';
  if (agent.status === 'error' || agent.attentionReason === 'error') return 'error';
  if (agent.attentionReason === 'permission' || (agent.pendingPermissions?.length ?? 0) > 0) return 'permission';
  if (agent.status === 'running') return 'working';
  // Only the observed requiresAttention + finished pair means "done, please look"; never inferred.
  if (agent.requiresAttention === true && agent.attentionReason === 'finished') return 'attention';
  return 'idle';
}
/** REQ-133: how far ahead of this device's clock a host's time may be (the two clocks drift) before it is not believed. */
export const HOST_TIME_AHEAD_MS = 60_000;
/** REQ-133: no agent began before this (2020-01-01); an earlier time is a placeholder, not a start. */
const HOST_TIME_FLOOR = Date.UTC(2020, 0, 1);
/**
 * REQ-133 (research/264 J1): when the agent's present state began, as the host itself says — at work, its turn's
 * `activeTurn.startedAt`; finished and not looked at, asking you or stopped on an error, `attentionTimestamp` when the
 * attention's reason is that same state (a permission asked with no such attention has no time of its own). An ISO time, or
 * undefined with none, or one that cannot be read, is before 2020 or more than a minute ahead of `now`; one a little ahead
 * is kept as it is (`elapsed` reads it as just now), so a repeated snapshot says the same time.
 */
export function hostSince(agent: AgentSnapshotLike | null | undefined, bucket: SignalBucket, now: number): string | undefined {
  if (!agent) return undefined;
  const reason = bucket === 'attention' ? 'finished' : bucket === 'permission' || bucket === 'error' ? bucket : null;
  const raw = bucket === 'working' ? agent.activeTurn?.startedAt : reason && agent.attentionReason === reason ? agent.attentionTimestamp : undefined;
  if (typeof raw !== 'string' || !raw) return undefined;
  const at = Date.parse(raw);
  if (!Number.isFinite(at) || at < HOST_TIME_FLOOR || at > now + HOST_TIME_AHEAD_MS) return undefined;
  return new Date(at).toISOString();
}
export function bucketRank(bucket: SignalBucket): number {
  const index = SIGNAL_BUCKETS.indexOf(bucket as typeof SIGNAL_BUCKETS[number]);
  return index < 0 ? SIGNAL_BUCKETS.length : index;
}
export interface SignalSummary { bucket: SignalBucket; agentId: string; others: number; total: number }
/** The most urgent signal of the linked agents, ties broken by agentId; `others` feeds "+N". */
export function summarizeSignals(agentIds: readonly string[], read: (agentId: string) => SignalBucket): SignalSummary | null {
  const unique = [...new Set(agentIds.filter(id => !!id))];
  if (!unique.length) return null;
  const ranked = unique.map(agentId => ({ agentId, bucket: read(agentId) }))
    .sort((a, b) => bucketRank(a.bucket) - bucketRank(b.bucket) || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  const top = ranked[0]!;
  return { bucket: top.bucket, agentId: top.agentId, others: unique.length - 1, total: unique.length };
}
/** Cheap identity for a summary so a subscriber can skip re-rendering when nothing changed. */
export function summaryKey(summary: SignalSummary | null): string {
  return summary ? summary.bucket + '|' + summary.agentId + '|' + summary.others : '';
}
/** REQ-44: what a folded lane still has to say — how many of its agents are stuck right now. */
export interface SignalCounts { error: number; permission: number }
export function countUrgentSignals(agentIds: readonly string[], read: (agentId: string) => SignalBucket): SignalCounts {
  let error = 0, permission = 0;
  for (const agentId of new Set(agentIds.filter(id => !!id))) {
    const bucket = read(agentId);
    if (bucket === 'error') error++; else if (bucket === 'permission') permission++;
  }
  return { error, permission };
}
export function countsKey(counts: SignalCounts): string { return counts.error + '|' + counts.permission; }
/** Every agent linked anywhere on a board, so a lane header keeps one signal while filters change. */
export function boardAgentIds(stages: readonly { cards: readonly { agentIds: readonly string[] }[] }[]): string[] {
  const all = new Set<string>();
  for (const stage of stages) for (const card of stage.cards) for (const id of card.agentIds) all.add(id);
  return [...all].sort();
}
/**
 * REQ-51: a card outside a completion stage whose every linked agent is archived has nobody left to act
 * on it. `archived` is the signal store's own knowledge (a live event or a one-shot REQ-41 lookup), so
 * this never reads the ledger or infers anything from a bucket alone.
 */
export function isOrphanedCard(agentIds: readonly string[], countsAsDone: boolean, archived: (agentId: string) => boolean): boolean {
  if (countsAsDone) return false;
  const unique = [...new Set(agentIds.filter(id => !!id))];
  return unique.length > 0 && unique.every(id => archived(id));
}
/**
 * REQ-82: "No assignee" belongs to a card no agent is linked to at all — not to one whose agents were archived,
 * which waits for a person to confirm it done (`isOrphanedCard`). Done cards and drafts (ideas no agent has taken
 * yet, already marked "Instruction draft") say neither.
 */
export function isUnassignedCard(agentIds: readonly string[], countsAsDone: boolean, intent: 'draft' | 'requested'): boolean {
  return !countsAsDone && intent !== 'draft' && !agentIds.some(id => !!id);
}
/**
 * REQ-98: every linked agent archived, whatever the card's stage — unlike `isOrphanedCard`, a done card still counts.
 * A lead card this is true of reads its 1px edge grey (`stage-color.ts`'s backlog token), not its stage's colour, so a
 * lead sitting in the done column with no agent left behind it does not still look "완료" green.
 */
export function isArchivedLead(agentIds: readonly string[], archived: (agentId: string) => boolean): boolean {
  const unique = [...new Set(agentIds.filter(id => !!id))];
  return unique.length > 0 && unique.every(id => archived(id));
}
/** REQ-51: how many not-done cards on a board have lost every one of their agents to archival. */
export function countOrphanedCards(stages: readonly { countsAsDone: boolean; cards: readonly { agentIds: readonly string[] }[] }[],
  archived: (agentId: string) => boolean): number {
  let count = 0;
  for (const stage of stages) for (const card of stage.cards) if (isOrphanedCard(card.agentIds, stage.countsAsDone, archived)) count++;
  return count;
}
/**
 * REQ-53: the SDK fields this plugin reads to name an assignee's model (REQ-74: `modelShortName`, as on the card).
 * REQ-73: plus the agent's title and its `profile` label (the Paseo profile it was created from), which
 * name the agent on the card face.
 */
export interface AgentModelInfo { provider?: string | null | undefined; model?: string | null | undefined; thinkingOptionId?: string | null | undefined;
  title?: string | null | undefined; profile?: string | null | undefined;
  /** REQ-117: its `role` label ("주제총괄" marks a topic lead) and the agent it was started under (`paseo.parent-agent-id`). */
  role?: string | null | undefined; parentAgentId?: string | null | undefined;
  /** REQ-126: its model's display name from the provider's model list ("Opus 5.5"), once that list has been read. */
  modelLabel?: string | null | undefined }
