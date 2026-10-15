import { createHash } from 'node:crypto';
import type { Board } from '../shared/core/domain.js';
import type { AutoState } from './auto-cards.js';

/**
 * REQ-76: which card of a board sits under which other card of the same board. Read-only, from the ledger and the
 * plugin's own file (`auto-cards.json`); nothing here writes, and the ledger never learns about it.
 *
 * - A card follows its first linked agent (`agents[0]`: links are appended, so that is the one linked first).
 * - That agent's top-level agent is found by following the parents this plugin remembered (the first parent each
 *   sub-agent had), so a detach or the orchestrator being archived, which drop Paseo's label, never undo it. The
 *   hierarchy is one level: a sub-agent's own sub-agent sits under the same top-level agent's card.
 * - The top-level agent's card is the one this plugin made for it (its automatic card), else the oldest card of the
 *   board it was linked to first. Only a card on the same board counts: a card on another board, or no card at all,
 *   leaves the sub-agent's card where it is.
 */
type Parents = Readonly<Record<string, { parentAgentId: string }>>;
/** The last agent up the remembered chain, or null for an agent that has no remembered parent. */
export function topAgent(parents: Parents, agentId: string): string | null {
  let current = agentId;
  const seen = new Set<string>([agentId]);
  for (let step = 0; step < 32; step++) {
    const next = parents[current]?.parentAgentId;
    if (!next || seen.has(next)) break;
    seen.add(next); current = next;
  }
  return current === agentId ? null : current;
}
/** Card id → the id of the card it sits under, for the board's live cards. */
export function cardParents(board: Pick<Board, 'id' | 'cards'>, state: Partial<Pick<AutoState, 'agents' | 'parents'>>): Map<string, string> {
  const parents = state.parents ?? {}, agents = state.agents ?? {};
  const result = new Map<string, string>();
  if (!Object.keys(parents).length) return result;
  const live = board.cards.filter(c => c.archivedAt === null);
  const owners = new Map<string, string | null>();
  const ownerCard = (agentId: string): string | null => {
    if (owners.has(agentId)) return owners.get(agentId)!;
    const kept = agents[agentId];
    const own = kept && kept.boardId === board.id
      ? live.find(c => c.id === kept.cardId && c.agents.some(a => a.agentId === agentId)) : undefined;
    const found = own ?? live.filter(c => c.agents[0]?.agentId === agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    owners.set(agentId, found?.id ?? null);
    return found?.id ?? null;
  };
  for (const card of live) {
    const first = card.agents[0]?.agentId;
    const top = first ? topAgent(parents, first) : null;
    const parent = top ? ownerCard(top) : null;
    if (parent && parent !== card.id) result.set(card.id, parent);
  }
  // One level only: a card that itself sits under another is never a parent.
  for (const [child, parent] of result) if (result.has(parent)) result.delete(child);
  return result;
}
/**
 * REQ-76 F1: a short fingerprint of a board's groups, or undefined when no card sits under another. Remembering a
 * parent writes the plugin's file, not the ledger, so the board's revision stays the same; the screens compare this
 * too when they poll `revisions.get`, so a parent remembered after their last read reaches them by itself.
 */
export function groupsKey(parents: ReadonlyMap<string, string> | undefined, lead?: string | null): string | undefined {
  if (!parents?.size && !lead) return undefined;
  // REQ-137: and the marked lead, kept in the same file — a mark set or taken off elsewhere changes the fingerprint.
  const pairs = [...(parents ?? [])].map(([child, parent]) => child + '>' + parent).sort().join('\n') + (lead ? '\nlead=' + lead : '');
  return createHash('sha256').update(pairs).digest('hex').slice(0, 16);
}
