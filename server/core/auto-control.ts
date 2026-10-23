import { randomUUID } from 'node:crypto';
import type { Board, Card } from '../../shared/core/domain.js';

/**
 * D66 (research/470 (나), 476 F1–F3, 477): whether the automatic cards may move a card is the card's own decision, kept in
 * `auto-control/<boardId>.json` beside the ledger (never inside it: 0.2.3/0.2.4 readers reject unknown fields). The file is
 * the one place that decision is read from; the engine's memory (`auto-cards.json`) only remembers buckets and titles.
 *
 * - `unowned` — never tracked: a card a person, a CLI or the dispatcher added and nobody linked yet. Arranging it is not a
 *   choice to keep (REQ-61 ③). The first link of any agent ends it: tracked from then on (`managed`), or, for a card already
 *   in a completion stage, `paused` — its completion is protected.
 * - `managed` — the engine may move it, through its own entry point only (`Store.autoMutate`).
 * - `paused` — somebody else changed its stage after tracking began (the board, the detail view, `kanban card move` by a
 *   person, an orchestrator or the card's own agent). Recorded by that very commit; only an explicit resume lifts it.
 * - `unknown` — nothing tells whether a stage is somebody's decision: an old card linked before this file existed (owner decision,
 *   2026-10-18: shown as "needs a check" and resumed card by card), or a stage some writer changed without this file (an
 *   installed older CLI, a restored backup, a failed save of this file). Nothing automatic touches it until it is resumed.
 *
 * `generation` changes with every decision on the card (a pause, a first link, a resume, a mismatch), never with the
 * engine's own moves; a proposal made from an older generation is refused (476 F2: the board revision is not part of that
 * check — another card's edit must not refuse a resume). `stageId` is the stage this file last confirmed (476 F3): a card
 * whose stage differs is judged alone, the rest of the board keeps its modes.
 */
export const AUTO_CONTROL_DIR = 'auto-control';
export const AUTO_CONTROL_BYTES = 8 * 1024 * 1024;
export type ControlMode = 'unowned' | 'managed' | 'paused' | 'unknown';
export type ControlReason = 'created' | 'added' | 'linked' | 'linked-done' | 'moved' | 'resumed' | 'legacy' | 'legacy-done' | 'legacy-free' | 'mismatch'
  // G2b, the migration of a board from before the file (`migrate`): adopted from the engine's memory, paused by it, or
  // paused by a person's move it never saw.
  | 'legacy-adopted' | 'legacy-paused' | 'legacy-moved';
/**
 * `stageId`, `revision` and `entered` are what this entry has seen of the card: its stage, the ledger revision as of which
 * every stage record of the card is accounted for, and the card's `stageEnteredAt` then (null when it had none). Gate 481
 * F1: a stage that is the same again is no proof that nobody moved the card meanwhile — a later stage record of the card
 * (or another entry time) is, whatever stage it ended in.
 */
export interface ControlEntry { mode: ControlMode; generation: number; decisionId: string; stageId: string; revision: string; entered: string | null;
  reason: ControlReason; at: string }
export interface AutoControl {
  schemaVersion: 1; boardId: string; controlEpoch: string; controlSeq: number;
  /** The board revision when the file was last saved — for people reading it; nothing is judged by it. */
  revision: string;
  cards: Record<string, ControlEntry>;
}
/** What the engine's memory says of a board's cards: whether any agent entry names a card, and (G2b) what each entry holds. */
export interface ControlEvidence { readable: boolean; remembered: ReadonlySet<string>; entries?: ReadonlyMap<string, readonly RememberedEntry[]> }
/** One agent's entry of the engine's memory for a card: the ledger revision of its last own move, and whether it paused. */
export interface RememberedEntry { agentId: string; moved: string | null; paused: boolean }
export interface ControlClock { now(): string; newId(): string }

const MODES: readonly string[] = ['unowned', 'managed', 'paused', 'unknown'];
const REASONS: readonly string[] = ['created', 'added', 'linked', 'linked-done', 'moved', 'resumed', 'legacy', 'legacy-done', 'legacy-free', 'mismatch',
  'legacy-adopted', 'legacy-paused', 'legacy-moved'];
const isText = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The file's contents, or why they cannot be trusted (another board's file, an unknown schema, a value of the wrong type). */
export function parseControl(raw: unknown, boardId: string): { control: AutoControl } | { problem: string } {
  const value = raw as Partial<AutoControl> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'not an object' };
  if (value.schemaVersion !== 1) return { problem: 'schemaVersion' };
  if (value.boardId !== boardId) return { problem: 'boardId' };
  if (!isText(value.controlEpoch, 64) || !isCount(value.controlSeq) || typeof value.revision !== 'string') return { problem: 'header' };
  if (!value.cards || typeof value.cards !== 'object' || Array.isArray(value.cards)) return { problem: 'cards' };
  for (const [id, e] of Object.entries(value.cards)) {
    if (!e || typeof e !== 'object' || !MODES.includes(e.mode) || !isCount(e.generation) || !isText(e.decisionId, 64) ||
      !isText(e.stageId, 64) || !isText(e.revision, 128) || !(e.entered === null || isText(e.entered, 64)) ||
      !REASONS.includes(e.reason) || !isText(e.at, 64)) return { problem: 'card ' + id };
  }
  return { control: value as AutoControl };
}

const countsAsDone = (board: Pick<Board, 'template'>, stageId: string) => board.template.stages.some(s => s.stageId === stageId && s.countsAsDone);
/** What an entry has seen of a card as of a ledger revision (see `ControlEntry`). */
export interface Seen { stageId: string; revision: string; entered: string | null }
export const seen = (card: Pick<Card, 'stageId' | 'stageEnteredAt'>, revision: string): Seen =>
  ({ stageId: card.stageId, revision, entered: card.stageEnteredAt ?? null });
const decision = (clock: ControlClock, mode: ControlMode, generation: number, at: Seen, reason: ControlReason): ControlEntry =>
  ({ mode, generation, decisionId: clock.newId(), ...at, reason, at: clock.now() });
/** Whether ledger revision `a` is later than `b`; another epoch (a re-made or restored ledger) counts as later. */
function later(a: string, b: string): boolean {
  const [ea, sa] = a.split(':'), [eb, sb] = b.split(':');
  return ea !== eb || Number(sa) > Number(sb);
}
/**
 * Whether the card changed stage since the entry saw it: another stage, a stage record of the card after the entry's
 * revision (481 F1: done → doing → done in commits whose decisions could not be saved), or another `stageEnteredAt` — the
 * ledger keeps that one when its bounded history no longer holds the records.
 */
function movedSince(entry: ControlEntry, card: Pick<Card, 'stageId' | 'stageEnteredAt'>, last: string | undefined): boolean {
  return entry.stageId !== card.stageId || (last !== undefined && later(last, entry.revision)) ||
    (entry.entered !== null && card.stageEnteredAt !== undefined && entry.entered !== card.stageEnteredAt);
}

/**
 * A card this file has no entry for (a board from before it, a card an older writer added, a lost file). Without proof
 * nothing is tracked: a card in a completion stage is protected, a card nobody ever tracked (no link, nothing remembered,
 * never moved by an agent — 476 F1) is free to be tracked by a later link, and every other card needs a check. Adopting a
 * card from the memory's revisions is the explicit migration's job (G2), never this fallback's.
 */
export function classify(board: Pick<Board, 'template' | 'history' | 'revision'>, card: Pick<Card, 'id' | 'stageId' | 'agents' | 'stageEnteredAt'>,
  evidence: ControlEvidence, clock: ControlClock): ControlEntry {
  const at = seen(card, board.revision);
  if (countsAsDone(board, card.stageId)) return decision(clock, 'paused', 1, at, 'legacy-done');
  const tracked = card.agents.length > 0 || !evidence.readable || evidence.remembered.has(card.id) ||
    board.history.some(h => h.cardId === card.id && h.from !== null && h.actor.kind === 'agent');
  return tracked ? decision(clock, 'unknown', 1, at, 'legacy') : decision(clock, 'unowned', 0, at, 'legacy-free');
}

/**
 * G2b (research/470 B5, 498): the migration of a board from before the file — once, under the board's lock, written down in
 * a report (`Store`). Where `classify` proves nothing, the engine's memory of 0.2.3/0.2.4 may: a card in a completion stage
 * stays protected; an untracked card stays free; a card a linked agent's memory paused stays paused, as does one whose
 * newest stage record is a person's (an external move, whether or not the engine saw it — a resume made in the old release
 * is not carried over: its pause stands); and only a card whose newest stage record is the very move a linked agent's memory
 * names as its own — same epoch, the card still in that stage — is adopted. Anything else needs a check (owner decision, 2026-10-18:
 * a card linked with nothing remembered, an agent's own CLI move, a link without an agent's memory).
 */
export function migrate(board: Pick<Board, 'template' | 'history' | 'revision'>, card: Pick<Card, 'id' | 'stageId' | 'agents' | 'stageEnteredAt'>,
  evidence: ControlEvidence, clock: ControlClock): ControlEntry {
  const first = classify(board, card, evidence, clock);
  if (first.mode !== 'unknown' || !evidence.readable) return first;
  const at = seen(card, board.revision);
  const linked = (evidence.entries?.get(card.id) ?? []).filter(e => card.agents.some(a => a.agentId === e.agentId));
  if (!linked.length) return first;
  if (linked.some(e => e.paused)) return decision(clock, 'paused', 1, at, 'legacy-paused');
  let last: Board['history'][number] | undefined;
  for (const record of board.history) if (record.cardId === card.id && record.from !== null) last = record;
  if (!last) return first;
  if (last.actor.kind === 'user') return decision(clock, 'paused', 1, at, 'legacy-moved');
  const mover = last.actor.kind === 'agent' ? last.actor.agentId : null;
  const own = linked.some(e => e.agentId === mover && e.moved === last.revision);
  return own && last.to === card.stageId && last.revision.split(':')[0] === board.revision.split(':')[0]
    ? decision(clock, 'managed', 1, at, 'legacy-adopted') : first;
}

/**
 * The file as it holds for the board now: a missing file is made from the board's cards (`classify`), a card it lacks is
 * classified, and a card moved since its entry saw it (`movedSince`, 481 F1) needs a check — alone (476 F3). `changed` says whether
 * the result differs from what is saved (the reference `revision` aside), so a settled board writes nothing.
 */
export function reconcile(board: Board, saved: AutoControl | null, evidence: ControlEvidence, clock: ControlClock, migrating = false): { control: AutoControl; changed: boolean } {
  const control: AutoControl = saved ? structuredClone(saved) : emptyControl(board);
  let changed = !saved;
  // The newest stage record of each card (records are kept oldest first).
  const last = new Map<string, string>();
  for (const record of board.history) last.set(record.cardId, record.revision);
  for (const card of board.cards) {
    const entry = control.cards[card.id];
    if (!entry) {
      // 476 J1: a card nobody linked since the file exists is untracked and kept implicit — the file is written for decisions
      // only, not for every card a person adds or arranges. Once any agent is linked the card has an entry (the link decides),
      // so a linked card without one came from a writer that does not know this file, and is classified.
      if (saved && !card.agents.length) control.cards[card.id] = untracked(card, board.revision, clock);
      else { control.cards[card.id] = (migrating && !saved ? migrate : classify)(board, card, evidence, clock); changed = true; }
      continue;
    }
    // Arranging a card nobody tracked is no decision, whoever's writer did it; its stage needs no confirming.
    if (entry.mode === 'unowned' || !movedSince(entry, card, last.get(card.id))) continue;
    // A paused card stays paused (it is held already; e.g. its decision was saved and the ledger write after it failed).
    control.cards[card.id] = decision(clock, entry.mode === 'paused' ? 'paused' : 'unknown', entry.generation + 1, seen(card, board.revision), 'mismatch');
    changed = true;
  }
  return { control, changed };
}
export const emptyControl = (board: Pick<Board, 'id' | 'revision'>): AutoControl =>
  ({ schemaVersion: 1, boardId: board.id, controlEpoch: randomUUID(), controlSeq: 0, revision: board.revision, cards: {} });
/**
 * G2b: what a start of a board's decisions did — the migration of a board from before the file (`migrated`), or a strict
 * new start: a damaged file set aside (`damaged`), a file set aside for a restore (`restored`), a file gone after this board
 * had one (`lost`). Kept beside the decisions as `<boardId>.rebase-<time>-<id>.json`, never read for a decision.
 */
export type RebaseKind = 'migrated' | 'damaged' | 'restored' | 'lost';
export interface RebaseReport { schemaVersion: 1; kind: RebaseKind; boardId: string; revision: string; controlEpoch: string; at: string;
  /** The file set aside, by name, if any. */
  previous: string | null;
  counts: Record<ControlMode, number>;
  cards: { cardId: string; stageId: string; archived: boolean; mode: ControlMode; reason: ControlReason }[] }
export function rebaseReport(kind: RebaseKind, board: Board, control: AutoControl, previous: string | null, at: string): RebaseReport {
  const counts: Record<ControlMode, number> = { managed: 0, paused: 0, unknown: 0, unowned: 0 };
  const cards = board.cards.map(card => {
    const entry = control.cards[card.id]!;
    counts[entry.mode]++;
    return { cardId: card.id, stageId: card.stageId, archived: !!card.archivedAt, mode: entry.mode, reason: entry.reason };
  });
  return { schemaVersion: 1, kind, boardId: board.id, revision: board.revision, controlEpoch: control.controlEpoch, at, previous, counts, cards };
}
const untracked = (card: Pick<Card, 'stageId' | 'stageEnteredAt'>, revision: string, clock: ControlClock): ControlEntry =>
  ({ mode: 'unowned', generation: 0, decisionId: clock.newId(), ...seen(card, revision), reason: 'added', at: clock.now() });

/**
 * The decisions one ledger commit makes, from the board before and after it. `engine` is the engine's own entry point: its
 * cards start `managed` and its moves stay `managed`. Anything else is somebody's choice: a stage change pauses a tracked
 * card (whatever actor or caller made it), a first link starts tracking. Same-stage moves and a batch that ends where it
 * began change no stage, so they decide nothing; a replayed request never gets here.
 */
export function commitDecisions(before: Board, after: Board, control: AutoControl, engine: boolean, wall: ControlClock): boolean {
  // A decision of a commit is dated like the commit's own records (the ledger's clamped time), so the screens agree.
  const clock: ControlClock = { now: () => after.updatedAt, newId: () => wall.newId() };
  let changed = false;
  for (const card of after.cards) {
    const old = before.cards.find(c => c.id === card.id);
    if (!old) {
      // A person's or a CLI's new card is untracked and stays implicit (see `reconcile`); the engine's starts tracked.
      if (engine) { control.cards[card.id] = decision(clock, 'managed', 1, seen(card, after.revision), 'created'); changed = true; }
      else control.cards[card.id] = untracked(card, after.revision, clock);
      continue;
    }
    // `reconcile` gave every card of `before` an entry.
    let entry = control.cards[card.id]!;
    if (old.stageId !== card.stageId && entry.mode !== 'unowned') {
      control.cards[card.id] = engine ? { ...entry, ...seen(card, after.revision) } : decision(clock, 'paused', entry.generation + 1, seen(card, after.revision), 'moved');
      entry = control.cards[card.id]!; changed = true;
    }
    const joined = card.agents.some(a => !old.agents.some(o => o.agentId === a.agentId));
    if (joined && entry.mode === 'unowned') {
      const done = countsAsDone(after, card.stageId);
      control.cards[card.id] = decision(clock, done ? 'paused' : 'managed', entry.generation + 1, seen(card, after.revision), done ? 'linked-done' : 'linked');
      changed = true;
    }
  }
  return changed;
}

/**
 * Gate 489 F1: whether a commit could make a decision, judged without the decision file (it cannot be read): any card's
 * stage changed, or an agent newly linked to any card. A superset of what `commitDecisions` decides — an untracked card's
 * stage counts too, since which cards are untracked is what the file would tell.
 */
export function mayDecide(before: Board, after: Board): boolean {
  return after.cards.some(card => {
    const old = before.cards.find(c => c.id === card.id);
    return !!old && (old.stageId !== card.stageId || card.agents.some(a => !old.agents.some(o => o.agentId === a.agentId)));
  });
}

/**
 * Gate 495 F1: the card as a screen showed it — its stage, its entry time and its last stage record (the card's own, not
 * the board's revision: 476 F2, another card's edit never refuses a resume). A resume pressed on that screen is refused
 * once the card is not like that any more: the person did not see what they would be turning tracking back on over.
 */
export function cardSeen(board: Pick<Board, 'history'>, card: Pick<Card, 'id' | 'stageId' | 'stageEnteredAt'>): string {
  let last = '';
  for (const record of board.history) if (record.cardId === card.id) last = record.revision;
  return card.stageId + '|' + (card.stageEnteredAt ?? '') + '|' + last;
}

/** The token a screen or the engine read a card's decision by; a later proposal or resume is checked against it. */
export interface ControlToken { controlEpoch: string; generation: number }
export const tokenOf = (control: AutoControl, cardId: string): ControlToken | null => {
  const entry = control.cards[cardId];
  return entry ? { controlEpoch: control.controlEpoch, generation: entry.generation } : null;
};
