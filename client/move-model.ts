/**
 * REQ-82: moving a card at once, by a person — the card's "Done" button, its ⋯ menu (a long press on a phone) and
 * the detail's stage bar. Pure derivation only: no React, no SDK, no ledger. Every move is the ledger's own `move`
 * operation sent through `kanban.v1.board.mutate` as the user, so REQ-74's pause of automatic tracking applies.
 */
import type { BoardCardDTO, BoardDTO } from '../shared/rpc.js';
import { placeCard, type CardOrder } from './card-order.js';

type StageLike = { stageId: string; countsAsDone: boolean };
/** Where "Done" moves a card: the template's first completion stage. */
export function doneStage<S extends StageLike>(stages: readonly S[]): S | undefined {
  return stages.find(stage => stage.countsAsDone);
}
/**
 * A draft stays in the first stage (the ledger refuses anything else) — REQ-97: or goes to the working stage, which
 * sends it to the workspace's lead after the confirmation sheet (`sendsToLead`). Review and done stay closed to it.
 */
export function stageAllowed(stages: readonly StageLike[], intent: 'draft' | 'requested', stageId: string): boolean {
  return intent !== 'draft' || stageId === stages[0]?.stageId || sendsToLead(stages, intent, stageId);
}
/** REQ-97: the working stage a draft is sent to the lead by — the second open stage (shared/core/domain.ts `dispatchStage`). */
export function dispatchStageId(stages: readonly StageLike[]): string | undefined {
  return stages.filter(stage => !stage.countsAsDone)[1]?.stageId;
}
/** REQ-97: this move of this card is a request to the lead, asked about first (client/dispatch-confirm.tsx). */
export function sendsToLead(stages: readonly StageLike[], intent: 'draft' | 'requested', to: string): boolean {
  return intent === 'draft' && to === dispatchStageId(stages);
}
/**
 * REQ-82 ②: the card offers "Done" when every linked agent is archived and it is not done yet (`isOrphanedCard`),
 * the template has a done stage, and it is not a draft (a draft cannot leave the first stage).
 */
export function offersDone(orphaned: boolean, intent: 'draft' | 'requested', stages: readonly StageLike[]): boolean {
  return orphaned && intent !== 'draft' && !!doneStage(stages);
}

/**
 * A move sent, or on its way, that the screen already shows. `base` is the board revision it was made against:
 * the move is drawn over a board still at that revision, and dropped as soon as the board is read at any other
 * one (the new read has the move, or a later change that outranks it). `at` is when it was chosen: the ledger stamps
 * the card changed then, so the screen does too (REQ-79 — the age on the card, and "latest change first").
 */
export interface PendingMove { boardId: string; cardId: string; to: string; base: string; at?: string }
export function applyPendingMoves<B extends BoardDTO>(boards: B[], pending: readonly PendingMove[], order: CardOrder = 'default'): B[] {
  if (!pending.length) return boards;
  let changed = false;
  const next = boards.map(board => {
    const moves = pending.filter(p => p.boardId === board.summary.id && p.base === board.summary.revision);
    const moved = moves.reduce<B>((value, move) => moveCard(value, move, order), board);
    if (moved !== board) changed = true;
    return moved;
  });
  return changed ? next : boards;
}
export function moveCard<B extends BoardDTO>(board: B, move: PendingMove, order: CardOrder = 'default'): B {
  const from = board.stages.find(stage => stage.cards.some(card => card.id === move.cardId));
  const card = from?.cards.find(value => value.id === move.cardId);
  if (!from || !card || from.stageId === move.to || !board.stages.some(stage => stage.stageId === move.to)) return board;
  const placed: BoardCardDTO = { ...card, stageId: move.to, ...(move.at ? { updatedAt: move.at } : {}) };
  // REQ-79: the moved card takes the place the next read will give it in the chosen order — the top of its new column
  // when the latest change leads, and its own place (priority, then age) in the ledger's order or "newest first".
  // Every screen also sorts each column itself, so this only keeps the model right where it is read unsorted.
  return { ...board, stages: board.stages.map(stage => stage === from
    ? { ...stage, cards: stage.cards.filter(value => value.id !== move.cardId), totalCount: Math.max(0, stage.totalCount - 1) }
    : stage.stageId === move.to ? { ...stage, cards: placeCard(stage.cards, placed, order), totalCount: stage.totalCount + 1 } : stage) };
}
/**
 * REQ-82 G1: where undoing a move takes the card — the stage the ledger had it in right before the move, which is not
 * always the one the screen showed (an agent's turn may have moved it since the board was read). `history` is the
 * card's moves, oldest first (`kanban.v1.card.get`); `revision` is the one the move produced. The last move of the
 * card must be the one that put it in `movedTo`, made at or before `revision`. If the card moved again since, there
 * is nothing to undo safely: null.
 */
export function undoTarget(history: readonly { from: string | null; to: string; revision: string }[], current: string,
  movedTo: string, revision: string): string | null {
  const last = history.at(-1);
  if (current !== movedTo || !last || last.to !== movedTo || laterRevision(last.revision, revision)) return null;
  return last.from && last.from !== movedTo ? last.from : null;
}
/**
 * Whether `read` is a later ledger revision than `base` ("epoch:sequence"). An undo is made against the revision
 * the first move produced, which the screen may not have read yet; only a later read retires it.
 */
export function laterRevision(read: string | undefined, base: string): boolean {
  if (!read || read === base) return false;
  const [readEpoch, readSeq] = read.split(':'), [baseEpoch, baseSeq] = base.split(':');
  return readEpoch !== baseEpoch || Number(readSeq) > Number(baseSeq);
}
