import type { BoardCardDTO, BoardDTO } from '../shared/rpc.js';
import type { Copy } from './i18n.js';
import { workspaceLabel, type Directory } from './presentation.js';
import { isTopicRole, leadRank, TOPIC_LEAD_ROLE } from '../shared/dispatch.js';

/**
 * REQ-93 (research/141 C, replacing REQ-76's gathering and REQ-89's reference lines): every card, a sub-agent's included,
 * sits in the column of its own stage as an ordinary card. The server still says which card belongs under which
 * (`parentCardId`, server/card-parents.ts); here that only becomes two marks:
 *
 * - a sub-card carries its parent (`parent`) — the card face shows "↳ <parent>" over its title;
 * - a parent carries how many sub-cards it has and how many are not done (`family`) — one summary line under it, and
 *   (REQ-95) its outline in its stage's colour, a crown and, first in its column, its place.
 *   REQ-119: a lead by name (`isLeadName`, top-level) has one from the start — none yet, `{ total: 0, open: 0 }`.
 *
 * Columns, their counts, the preview, "+N", the order (REQ-79), the search and the filters treat a sub-card as any card.
 * A sub-card whose parent is not among the cards read (another board, archived, or a done card hidden by age) has no mark.
 */
export type LinkedCard<C extends BoardCardDTO = BoardCardDTO> = C & {
  /** The card this one's agent was started under, when it is among the cards read. */
  parent?: { id: string; title: string };
  /**
   * On a parent: its sub-cards, and how many of them are in any stage but done. Absent on a card with none, except a lead
   * by name (REQ-119) or a labelled topic lead (REQ-117), whose card is a lead's before its first sub-card.
   */
  family?: { total: number; open: number };
  /**
   * REQ-104: on a parent, the cards its status row reads (`lead-status.ts`) — its sub-cards, and the board's other
   * cards whose first agent is one of the parent's own (a lead's check card). Kept apart from `family`, which is counted.
   */
  crew?: { members: C[]; own: C[] };
  /**
   * REQ-117: a topic lead — a lead under the workspace's lead (`isTopicLead`). It keeps its own "↳ <lead>" mark and, like a
   * lead, has `family` and `crew` (its own sub-cards); its crown is grey, its title whole, its place after the lead's.
   */
  subLead?: true;
  /** REQ-117: on a topic lead's sub-card, the topic lead's card — the one its face names ("↳ T01"), over `parent`. */
  subParent?: { id: string; title: string };
  /** REQ-137: the card of the chat a person marked as the workspace's lead (`summary.lead`) — its crown says "Set by you". */
  designated?: true;
};
/**
 * REQ-117: what `linkStages` reads of an agent to find the third level — its `role` label and the agent it was started
 * under (`paseo.parent-agent-id`), as the agents' listing gives them (`AgentModelInfo`). Unknown agents read as neither.
 * REQ-119: and its title and `profile` label, which name a lead (`isLeadName`).
 */
export type AgentLinks = (agentId: string) => { role?: string | null | undefined; parentAgentId?: string | null | undefined;
  title?: string | null | undefined; profile?: string | null | undefined } | undefined;
/** REQ-117: the `role` label a workspace's lead gives a topic lead it starts (shared with the server's `isLeadAgent`). */
export { TOPIC_LEAD_ROLE };
/**
 * REQ-117: whether an agent is a topic lead — labelled `role: 주제총괄`, or, with no label, started under another agent
 * (`hasParent`) and with sub-cards of its own (`hasSubCards`). The workspace's own lead (top-level) is never one.
 */
export function isTopicLead(info: ReturnType<AgentLinks>, hasParent: boolean, hasSubCards: boolean): boolean {
  return isTopicRole(info?.role) || ((hasParent || !!info?.parentAgentId) && hasSubCards);
}
type StageLike<C> = { stageId: string; countsAsDone: boolean; cards: readonly C[] };

/**
 * The stages as they are, each card marked with its parent or, on a parent, its sub-cards' counts.
 *
 * REQ-117: with `agents`, a third level. The server keeps one (a sub-agent's own sub-agent sits under the top-level
 * agent's card, server/card-parents.ts), so the workspace lead's family is every card under it, as before. Among those,
 * a topic lead (`isTopicLead`) gets a family of its own: the cards whose first agent was started under its first agent
 * (`parentAgentId`), each then marked `subParent`. An agent's card is the oldest card whose first agent it is.
 *
 * REQ-119: with `agents` too, a lead by name (`isLeadName`: "총괄-…" or a "총괄_…" profile — the server's `isLeadAgent`)
 * started under no agent is a lead's card before it has any sub-card: its own card gets a family of none. Once it has
 * sub-cards the family is theirs, as before; its archive state is the look's (REQ-98), not what makes it a lead.
 *
 * REQ-137: `lead`, the chat marked as the board's lead (`summary.lead`), is a lead by the same judgement as the server's
 * (`leadRank`, the marked chat first): its card gets a family of none and `designated` — even before its agent is listed,
 * unless the card sits under another. An English "Lead-…" name counts as a Korean one. Archived, it keeps its crown in the
 * archived look (REQ-98), as a lead by name does; the draft's receiver skips it until it is restored (server/dispatch.ts).
 */
export function linkStages<C extends BoardCardDTO, S extends StageLike<C>>(stages: readonly S[], agents?: AgentLinks, lead?: string | null):
  (Omit<S, 'cards'> & { cards: LinkedCard<C>[] })[] {
  const byId = new Map<string, C>();
  for (const stage of stages) for (const card of stage.cards) byId.set(card.id, card);
  const parentOf = (card: C): C | null => {
    const parent = card.parentCardId ? byId.get(card.parentCardId) : undefined;
    // One level: a parent that itself sits under a card that was read is never a parent here.
    return parent && parent.id !== card.id && !(parent.parentCardId && byId.has(parent.parentCardId)) ? parent : null;
  };
  const done = new Set(stages.filter(s => s.countsAsDone).map(s => s.stageId));
  const families = new Map<string, { total: number; open: number }>(), members = new Map<string, C[]>();
  for (const card of byId.values()) {
    const parent = parentOf(card);
    if (!parent) continue;
    const family = families.get(parent.id) ?? { total: 0, open: 0 };
    family.total++; if (!done.has(card.stageId)) family.open++;
    families.set(parent.id, family);
    const list = members.get(parent.id); if (list) list.push(card); else members.set(parent.id, [card]);
  }
  // REQ-117: the topic leads and their sub-cards, from the agents' own labels.
  const topics = new Set<string>(), subParents = new Map<string, C>();
  let marked: string | null = null;
  if (agents || lead) {
    const links: AgentLinks = agents ?? (() => undefined);
    const firstAgent = (card: C) => card.agentIds.find(id => !!id);
    const cards = [...byId.values()], own = new Map<string, C>(), kids = new Map<string, C[]>();
    for (const card of [...cards].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))) {
      const first = firstAgent(card);
      if (first && !own.has(first)) own.set(first, card);
    }
    for (const card of cards) {
      const first = firstAgent(card), up = first ? links(first)?.parentAgentId : null, head = up ? own.get(up) : undefined;
      if (!head || head.id === card.id || families.has(card.id)) continue;
      const list = kids.get(head.id); if (list) list.push(card); else kids.set(head.id, [card]);
    }
    for (const card of cards) {
      const first = firstAgent(card), list = kids.get(card.id) ?? [];
      if (!first || own.get(first) !== card || !isTopicLead(links(first), !!parentOf(card), list.length > 0)) continue;
      topics.add(card.id);
      if (families.has(card.id)) continue;
      families.set(card.id, { total: list.length, open: list.filter(kid => !done.has(kid.stageId)).length });
      members.set(card.id, list);
    }
    for (const id of topics) for (const kid of kids.get(id) ?? []) if (parentOf(kid)?.id !== id) subParents.set(kid.id, byId.get(id)!);
    // REQ-119: a top-level lead by name with no sub-card yet — unless another of its cards already has its family.
    // REQ-137: the marked chat by the same judgement (`leadRank`), known to be a lead before its agent is listed.
    const headed = new Set([...families.keys()].map(id => firstAgent(byId.get(id)!)));
    for (const card of cards) {
      const first = firstAgent(card), info = first ? links(first) : undefined;
      if (!first || own.get(first) !== card || card.parentCardId || topics.has(card.id)) continue;
      const rank = leadRank({ id: first, title: info?.title, profile: info?.profile, role: info?.role, parent: info?.parentAgentId }, lead);
      if (!rank || (rank === 'name' && !info)) continue;
      if (rank === 'set') marked = card.id;
      if (headed.has(first)) continue;
      families.set(card.id, { total: 0, open: 0 });
      members.set(card.id, []);
    }
  }
  // REQ-104: the cards each agent was linked to first, for a parent's own other cards.
  const firstOf = new Map<string, C[]>();
  if (families.size) for (const card of byId.values()) {
    const first = card.agentIds[0];
    const list = first ? firstOf.get(first) : undefined;
    if (list) list.push(card); else if (first) firstOf.set(first, [card]);
  }
  const crewOf = (card: C) => ({ members: members.get(card.id) ?? [],
    own: [...new Set(card.agentIds.filter(id => !!id).flatMap(id => firstOf.get(id) ?? []))].filter(other => other.id !== card.id) });
  return stages.map(stage => ({ ...stage, cards: stage.cards.map(card => {
    const parent = parentOf(card), family = families.get(card.id), sub = subParents.get(card.id);
    return !parent && !family && !sub && marked !== card.id ? card : { ...card, ...(parent ? { parent: { id: parent.id, title: parent.title } } : {}),
      ...(family ? { family, crew: crewOf(card) } : {}), ...(topics.has(card.id) ? { subLead: true as const } : {}),
      ...(sub ? { subParent: { id: sub.id, title: sub.title } } : {}), ...(marked === card.id ? { designated: true as const } : {}) };
  }) }));
}
/**
 * D35: the agents of every lead (a card with sub-cards, REQ-119 or a lead by name) on these boards, a completion column's leads first — whose
 * archive state `useArchivedAgents` asks for before any other agent's (REQ-98/100/102 decide a lead's look and place by it).
 */
export function leadAgentIds<C extends BoardCardDTO>(boards: readonly { stages: readonly StageLike<C>[]; summary?: LeadSummary }[],
  agents?: AgentLinks): string[] {
  const done: string[] = [], other: string[] = [];
  for (const board of boards) for (const stage of linkStages(board.stages, agents, boardMark(board.summary))) for (const card of stage.cards)
    if (card.family) (stage.countsAsDone ? done : other).push(...card.agentIds.filter(id => !!id));
  return [...new Set([...done, ...other])];
}
/**
 * REQ-93: the parent's name on a sub-card, short — the part before the first "_" (an agent title such as
 * "Lead-02_sample-app_Opus" reads "Lead-02"), cut at 14 characters. The whole title is the mark's spoken label.
 */
export const PARENT_MARK_LENGTH = 14;
export function parentMark(title: string): string {
  const head = title.split('_')[0]!.trim() || title.trim();
  return head.length > PARENT_MARK_LENGTH ? head.slice(0, PARENT_MARK_LENGTH - 1) + '…' : head;
}
/** REQ-93 C′: whether a card is the highlighted parent or one of its sub-cards (REQ-117: a topic lead's too). */
export function inFamily(card: Pick<LinkedCard, 'id' | 'parent' | 'subParent'>, parentId: string): boolean {
  return card.id === parentId || card.parent?.id === parentId || card.subParent?.id === parentId;
}
/**
 * REQ-104: whether a card is in what is highlighted — the parent and, when a part of its status row was pressed
 * (`only`), the cards that part names; else the whole family (`inFamily`).
 */
export function inFocus(card: Pick<LinkedCard, 'id' | 'parent' | 'subParent'>, parentId: string, only?: readonly string[]): boolean {
  return only ? card.id === parentId || only.includes(card.id) : inFamily(card, parentId);
}
/** REQ-109: a parent's sub-cards in any stage but a completion one — what its "not done M" highlights. */
export function openIds(card: Pick<LinkedCard, 'crew'>, stages: readonly { stageId: string; countsAsDone: boolean }[]): string[] {
  const done = new Set(stages.filter(s => s.countsAsDone).map(s => s.stageId));
  return (card.crew?.members ?? []).filter(member => !done.has(member.stageId)).map(member => member.id);
}
/**
 * REQ-95 ⑥: a lead card's title on its face, short — an automatic card named `<head>_<workspace folder>_<model>`
 * ("Lead-03_sample-app_Opus") reads "Lead-03"; the whole title stays in the title's hint, its spoken label and the detail.
 * A title of another shape (fewer than three parts, an empty part) is shown as it is.
 */
export function leadTitle(title: string): string {
  const parts = title.split('_');
  return parts.length >= 3 && parts.every(part => part.trim()) ? parts[0]!.trim() : title;
}
/** REQ-137 / 281 F1: what a board view says of its lead — the mark kept (`lead`) and the server's judgement now (`leadNow`). */
type LeadSummary = { lead?: string | undefined; leadNow?: BoardDTO['summary']['leadNow'] | undefined };
/**
 * 281 F1: the marked chat as the screens draw it (crown "set by you", the lead's own status row) — the kept mark while the
 * server holds it in effect (`leadNow.by === 'set'`) or its chat is only archived (REQ-98's look, until it is restored), and
 * not when the server cannot send to it (`unusable`: another board's chat, a sub-chat, a topic lead…). Not judged by the
 * server (no `leadNow`: an older server, no host listing): the kept mark, as before.
 */
export function boardMark(summary: LeadSummary | undefined): string | null {
  const mark = summary?.lead ?? null, now = summary?.leadNow;
  return mark && (!now || now.by === 'set' || now.mark === 'archived') ? mark : null;
}
/**
 * REQ-137 (research/273 B ⑤): who leads a board's workspace, for the settings' read-only "Leads by workspace". 281 F1: the
 * server's own answer when it gives one (`leadNow`, the very judgement of a draft's receiver — the chats' own order, the root
 * before a worktree, only chats this board sends to), never judged again here: the marked chat (`set`); a kept mark not in
 * effect (`setArchived`, `setUnusable`) with whom the drafts go to by name meanwhile (`now`); a lead by name (`name`); else
 * the first card with sub-cards (`family`, REQ-119: a crown, though a draft goes to the newest top-level chat), else none.
 * Without it (an older server, no host listing), the board's own reading as before. `name` is the card's short title
 * (`leadTitle`), or the chat's when it has no card here.
 */
export type BoardLead = { kind: 'set' | 'setArchived' | 'setUnusable' | 'name' | 'family' | 'none'; name: string; now?: string };
export function boardLead(board: { stages: readonly StageLike<BoardCardDTO>[]; summary?: LeadSummary },
  agents?: AgentLinks, archived: (agentId: string) => boolean = () => false): BoardLead {
  const cards = linkStages(board.stages, agents, boardMark(board.summary)).flatMap(stage => stage.cards);
  const firstAgent = (card: LinkedCard) => card.agentIds.find(id => !!id) ?? '';
  const marked = board.summary?.lead, now = board.summary?.leadNow;
  const family = () => { const card = cards.find(c => c.family && !c.subLead && c.family.total > 0);
    return card ? { kind: 'family' as const, name: leadTitle(card.title) } : { kind: 'none' as const, name: '' }; };
  if (now) {
    const nameOf = (agentId: string, title?: string | null) => { const card = cards.find(c => firstAgent(c) === agentId);
      return card ? leadTitle(card.title) : leadTitle(title?.trim() || agents?.(agentId)?.title?.trim() || '') || agentId.slice(0, 8); };
    const lead = now.agentId ? nameOf(now.agentId, now.title) : '';
    if (now.by === 'set') return { kind: 'set', name: lead };
    if (marked && now.mark) return { kind: now.mark === 'archived' ? 'setArchived' : 'setUnusable', name: nameOf(marked), ...(now.by === 'name' ? { now: lead } : {}) };
    return now.by === 'name' ? { kind: 'name', name: lead } : family();
  }
  if (marked) {
    const card = cards.find(c => c.designated);
    const name = card ? leadTitle(card.title) : agents?.(marked)?.title?.trim() || marked.slice(0, 8);
    return { kind: archived(marked) ? 'setArchived' : 'set', name };
  }
  const named = cards.filter(c => c.family && !c.subLead && !archived(firstAgent(c)) && (() => {
    const info = agents?.(firstAgent(c));
    return !!info && leadRank({ id: firstAgent(c), title: info.title, profile: info.profile, role: info.role, parent: info.parentAgentId }) === 'name';
  })()).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  if (named[0]) return { kind: 'name', name: leadTitle(named[0].title) };
  return family();
}
/** REQ-137: the workspace's name as a card's menu says it — the last part of the board's folder. */
export const workspaceOf = (board: BoardDTO) => board.summary.cwd.split(/[\\/]/).filter(Boolean).pop() ?? board.summary.cwd;
/**
 * REQ-137 (research/273 B): the card menu's lead row. `mark`: no chat is marked (or another is — `help` names it, a press
 * moves the mark); `unmark`: this card's chat is the marked one; `blocked`: a sub-card, a sub-chat or a topic lead (REQ-117
 * by the agent's labels) — shown faded with why; `none`: no chat on the card. Which chat a press marks is the card's first.
 */
export type LeadMenu = { state: 'mark' | 'unmark' | 'blocked' | 'none'; help: string; onPress: (lead: boolean) => void };
export function leadMenu(board: BoardDTO, card: BoardDTO['stages'][number]['cards'][number], m: Copy, agents: AgentLinks | undefined,
  onPress: (lead: boolean) => void): LeadMenu {
  const first = card.agentIds.find(id => !!id), marked = board.summary.lead, info = first ? agents?.(first) : undefined;
  if (!first) return { state: 'none', help: m.markLeadNoChat, onPress };
  if (card.parentCardId || info?.parentAgentId || isTopicRole(info?.role)) return { state: 'blocked', help: m.markLeadBlocked, onPress };
  if (marked === first) return { state: 'unmark', help: m.unmarkLeadHelp, onPress };
  if (!marked) return { state: 'mark', help: m.markLeadHelp(workspaceOf(board)), onPress };
  const markedCard = board.stages.flatMap(stage => stage.cards).find(c => c.agentIds.find(id => !!id) === marked);
  const name = markedCard ? leadTitle(markedCard.title) : agents?.(marked)?.title?.trim() || marked.slice(0, 8);
  return { state: 'mark', help: m.markLeadReplace(name), onPress };
}
/**
 * REQ-137: the settings' read-only "Leads by workspace" lines — one per board the screen shows, by `boardLead` (281 F1: the server's answer),
 * (`boardLead`), in the order and names of `workspaceAutoEntries`.
 */
export function workspaceLeadEntries(boards: readonly { summary: LeadSummary & { workspaceId: string; cwd: string; hasLedger?: boolean | undefined };
  stages: BoardDTO['stages'] }[], directory: Directory, agents: AgentLinks | undefined, archived: (agentId: string) => boolean, m: Copy) {
  return boards.filter(b => b.summary.hasLedger !== false).map(b => {
    const lead = boardLead(b, agents, archived);
    const text = lead.kind === 'set' ? m.leadStatusSet(lead.name) : lead.kind === 'setArchived' ? m.leadStatusSetArchived(lead.name, lead.now)
      : lead.kind === 'setUnusable' ? m.leadStatusSetUnusable(lead.name, lead.now)
      : lead.kind === 'name' ? m.leadStatusName(lead.name) : lead.kind === 'family' ? m.leadStatusFamily(lead.name) : m.leadStatusNone;
    return { cwd: b.summary.cwd, name: workspaceLabel(b.summary.workspaceId, b.summary.cwd, directory), text, kind: lead.kind };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
