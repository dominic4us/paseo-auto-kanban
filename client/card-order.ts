/**
 * REQ-79: the order cards take inside a column — on every cell of the swimlane board, on a workspace board and on
 * the 390px board. The ledger's own order (`shared/core/domain.ts sortedCards`: priority, then creation) stays
 * the default; the two others put the newest first. Pure derivation only: the ledger is never re-ordered.
 *
 *   default  priority (high → low), then the oldest card first — what the server sends
 *   updated  the card changed most recently first (`updatedAt`, the time the card face shows as its age)
 *   created  the card made most recently first (`createdAt`)
 *
 * "Changed" is the card's own `updatedAt`: the ledger stamps it on every change of the card, a stage move
 * included, and it is the age the card face already shows (REQ-73), so the top card is the one reading "now".
 * A time the reply does not carry (an older server) sorts as the oldest, and ties fall back to the default.
 *
 * REQ-95 ⑤: whatever the order, a card with sub-cards (a lead's, `family` from `linkStages`) comes first in its column —
 * before any "+N" cuts the column short — and the leads among themselves keep the chosen order. REQ-119: a lead by name
 * with no sub-card yet has a `family` of none, so it is pinned too.
 *
 * REQ-102: except a lead in a completion column whose every linked agent is archived (`isArchivedLead`, REQ-98) — the
 * owner no longer wants a card nobody can act on held at the top of "완료"; it falls back to the column's own order.
 * A lead outside a completion column, or one not archived, still comes first — `countsAsDone` is the column's own flag.
 *
 * REQ-117: a topic lead (`subLead`, card-groups.ts) is pinned too, after the workspace's lead and before the other cards;
 * archived in a completion column, it falls back like a lead.
 */
import type { BoardCardDTO } from '../shared/rpc.js';
import { isArchivedLead } from './signal-model.js';

export const CARD_ORDERS = ['default', 'updated', 'created'] as const;
export type CardOrder = typeof CARD_ORDERS[number];
export const DEFAULT_CARD_ORDER: CardOrder = 'default';
export function isCardOrder(value: unknown): value is CardOrder {
  return typeof value === 'string' && (CARD_ORDERS as readonly string[]).includes(value);
}
type Sortable = Pick<BoardCardDTO, 'id' | 'priority'> &
  { createdAt?: string | undefined; updatedAt?: string | undefined; family?: unknown; subLead?: boolean; agentIds?: readonly string[] };
const PRIORITY = { high: 0, normal: 1, low: 2 } as const;
/** ISO times in one format compare as strings; newest first means the larger one leads. */
const newer = (a: string | undefined, b: string | undefined) => (b ?? '') < (a ?? '') ? -1 : (b ?? '') > (a ?? '') ? 1 : 0;
function ledgerOrder(a: Sortable, b: Sortable): number {
  return PRIORITY[a.priority] - PRIORITY[b.priority] || -newer(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
const isLead = (c: Sortable, countsAsDone: boolean, archived: (agentId: string) => boolean) =>
  !!c.family && !(countsAsDone && isArchivedLead(c.agentIds ?? [], archived));
/** REQ-117: the workspace's lead first (0), then the topic leads (1), then every other card (2). */
const leadRank = (c: Sortable, countsAsDone: boolean, archived: (agentId: string) => boolean) =>
  !isLead(c, countsAsDone, archived) ? 2 : c.subLead ? 1 : 0;
const leadFirst = (a: Sortable, b: Sortable, countsAsDone: boolean, archived: (agentId: string) => boolean) =>
  leadRank(a, countsAsDone, archived) - leadRank(b, countsAsDone, archived);
const NEVER_ARCHIVED = () => false;
export function compareCards(order: CardOrder, countsAsDone = false,
  archived: (agentId: string) => boolean = NEVER_ARCHIVED): (a: Sortable, b: Sortable) => number {
  const lead = (a: Sortable, b: Sortable) => leadFirst(a, b, countsAsDone, archived);
  if (order === 'updated') return (a, b) => lead(a, b) || newer(a.updatedAt, b.updatedAt) || ledgerOrder(a, b);
  if (order === 'created') return (a, b) => lead(a, b) || newer(a.createdAt, b.createdAt) || ledgerOrder(a, b);
  return (a, b) => lead(a, b) || ledgerOrder(a, b);
}
/** A column's cards in `order`. The same array comes back when it is already in that order, so memoised views keep it. */
export function sortCards<C extends Sortable>(cards: readonly C[], order: CardOrder, countsAsDone = false,
  archived: (agentId: string) => boolean = NEVER_ARCHIVED): readonly C[] {
  const compare = compareCards(order, countsAsDone, archived);
  for (let i = 1; i < cards.length; i++) if (compare(cards[i - 1]!, cards[i]!) > 0) return [...cards].sort(compare);
  return cards;
}
/** Where `card` goes in a column already in `order`: before the first card it sorts ahead of. */
export function placeCard<C extends Sortable>(cards: readonly C[], card: C, order: CardOrder, countsAsDone = false,
  archived: (agentId: string) => boolean = NEVER_ARCHIVED): C[] {
  const compare = compareCards(order, countsAsDone, archived), index = cards.findIndex(value => compare(card, value) < 0);
  return index < 0 ? [...cards, card] : [...cards.slice(0, index), card, ...cards.slice(index)];
}
