/**
 * REQ-97: the prompt a draft becomes when it is sent to an agent of the workspace — the same words in the confirmation
 * sheet's preview (client) and in what the server sends. v0.1.46-B: in the board's language (`readLocale`), written so an
 * agent that knows nothing of this plugin understands what to do from the words alone; the last line names the kanban
 * command with the real card and agent ids, for an agent that has the CLI. With no agent to send to yet (`agentId` null)
 * that line is left out — the server fills it in with the agent it sends to.
 */
export type DispatchLocale = 'ko' | 'en';
export interface DispatchText { title: string; cardId: string; boardTitle: string; notes: string; criteria: string;
  locale?: DispatchLocale; agentId?: string | null }
const DISPATCH_WORDS = {
  ko: { head: '[칸반 요청] ', card: '카드: ', board: ' · 보드: ', criteria: '완료 기준: ',
    todo: '할 일: 위 요청을 처리해 주세요. 완료 기준을 채우면 무엇을 했는지 짧게 알려 주세요.',
    cli: (command: string) => '(kanban CLI가 있으면 이 카드를 담당 카드로 이어 쓰세요: ' + command + ' — CLI가 없으면 이 줄은 건너뛰세요)' },
  en: { head: '[Kanban request] ', card: 'Card: ', board: ' · Board: ', criteria: 'Done when: ',
    todo: 'To do: please handle the request above. When the done-when line is met, reply with a short note on what you did.',
    cli: (command: string) => '(If you have the kanban CLI, keep this card as yours: ' + command + ' — no CLI? skip this line)' },
} as const;
export function dispatchMessage({ title, cardId, boardTitle, notes, criteria, locale = 'ko', agentId = null }: DispatchText): string {
  const w = DISPATCH_WORDS[locale === 'en' ? 'en' : 'ko'];
  return [w.head + title.trim(), w.card + cardId + w.board + boardTitle,
    ...(notes.trim() ? [notes.replace(/\r\n/g, '\n').trim()] : []),
    w.criteria + criteria.replace(/\r\n/g, '\n').trim(), w.todo,
    ...(agentId ? [w.cli('kanban card link ' + cardId + ' --agent ' + agentId)] : [])].join('\n');
}
/** The criteria a request goes out with: the card's own, else the ones typed in the sheet, else its title (the ledger's rule). */
export function dispatchCriteria(card: { title: string; acceptanceCriteria: string }, typed = ''): string {
  return card.acceptanceCriteria.trim() ? card.acceptanceCriteria : typed.trim() || card.title;
}
/**
 * A lead by name (REQ-97 `isLeadAgent` on the server, REQ-119 the lead's card on the board): titled "총괄-…" or given a
 * "총괄_…" profile. Whether it is top-level (and, for the server, not archived) is the caller's to check.
 */
export const LEAD_TITLE = '총괄-', LEAD_PROFILE = '총괄_';
/**
 * REQ-137 (research/273 B): the English aliases "Lead-…" and "Lead_…" name a lead too. Every prefix is matched in any
 * case ("lead-", "LEAD_"); the Korean ones have no case. The first of each list is the one the Korean screens quote.
 */
export const LEAD_TITLES: readonly string[] = [LEAD_TITLE, 'Lead-'], LEAD_PROFILES: readonly string[] = [LEAD_PROFILE, 'Lead_'];
const startsWithAny = (value: string | null | undefined, prefixes: readonly string[]) => {
  const text = (value ?? '').trim().toLowerCase();
  return prefixes.some(prefix => text.startsWith(prefix.toLowerCase()));
};
export function isLeadName(title: string | null | undefined, profile: string | null | undefined): boolean {
  return startsWithAny(title, LEAD_TITLES) || startsWithAny(profile, LEAD_PROFILES);
}
/**
 * REQ-117: the `role` label a workspace's lead gives a topic lead it starts. Labelled so, an agent is a topic lead and never
 * the workspace's lead — with or without a parent mark (research/191 D1): not REQ-97's `isLeadAgent`, not REQ-119's lead.
 * REQ-137: or `topic-lead`, in any case.
 */
export const TOPIC_LEAD_ROLE = '주제총괄';
export const TOPIC_LEAD_ROLES: readonly string[] = [TOPIC_LEAD_ROLE, 'topic-lead'];
export function isTopicRole(role: string | null | undefined): boolean {
  const text = (role ?? '').trim().toLowerCase();
  return TOPIC_LEAD_ROLES.some(name => name.toLowerCase() === text);
}
/**
 * REQ-137: how an agent is its workspace's lead — the one judgement the server (the draft's receiver: `isLeadAgent`,
 * `pickLead`) and the screens (the crown, the lead's own status row, the topic lead's medal) share. In order:
 * - `set`: the chat a person marked as the lead of the board's workspace (`designated`, kept in `auto-cards.json`);
 * - `name`: a lead by name (`isLeadName`, Korean or English);
 * - null: neither (a card with sub-cards is still a lead's on the board, REQ-119 — the board alone tells that).
 * Never a topic lead (`isTopicRole`) nor an agent started under another (`parent`). Whether it is archived is the caller's:
 * the server lists no archived chat, so a marked chat archived gives way to the next rule until it is restored.
 */
export type LeadRank = 'set' | 'name';
export function leadRank(agent: { id?: string | null | undefined; title?: string | null | undefined; profile?: string | null | undefined;
  role?: string | null | undefined; parent?: string | null | undefined }, designated?: string | null): LeadRank | null {
  if (agent.parent || isTopicRole(agent.role)) return null;
  if (designated && agent.id === designated) return 'set';
  return isLeadName(agent.title, agent.profile) ? 'name' : null;
}
/** The short name of a lead ("총괄-07" of "총괄-07_Paseo-Auto-Kanban_Fable", "Lead-03" of "Lead-03_Shop_Fable"): the part before the first "_" of three or more. */
export function leadShortName(title: string): string {
  const parts = title.split('_');
  return parts.length >= 3 && parts.every(part => part.trim()) ? parts[0]!.trim() : title.trim();
}
/**
 * 253-D3: why a request waits with no agent to go to — said apart, since each asks for something else. `targetGone`: the
 * agent the person confirmed is no longer one to send to (253-D2: no other chat takes it unasked, a lead by name aside);
 * `settings`: the start line cannot be read (`auto-cards.json` damaged), so only a lead by name takes it; `beforeFloor`:
 * requested before this version's first run, so only a lead by name takes it; `noAgent`: no agent there at all. `floor`
 * is that start line, null when it cannot be read. The ledger keeps none of this — it is worked out when read.
 * 255-D1: the start line comes first. A card with a confirmed agent is held only when that agent may not take it: gone, or
 * — alive but not a lead by name — barred by the start line. When the start line bars it, that is what to fix first (a
 * card sent again to another chat is barred all the same), so it is said whether the confirmed agent is alive or not;
 * `targetGone` is left for a card the start line lets through. So the same answer comes from the ledger and the start
 * line alone — the board and the card detail, which do not list agents, say what the sheet says.
 * 257: `listing` — Paseo's workspace listing could not be read whole (or the host has none), so whether the chat's workspace is
 * being archived is unknown: the request is neither sent nor given up on, and is looked at again at the next signal. Only the
 * sheet (server/dispatch.ts `targetOf`) says this; the ledger keeps the card as it was, so the board's chip does not change.
 */
export type DispatchHeld = 'noAgent' | 'beforeFloor' | 'settings' | 'targetGone' | 'listing';
export const DISPATCH_HELD = ['noAgent', 'beforeFloor', 'settings', 'targetGone', 'listing'] as const;
export function dispatchHeld(dispatch: { targetAgentId: string | null; requestedAt: string }, floor: string | null): DispatchHeld {
  const since = floor ? Date.parse(floor) : NaN, at = Date.parse(dispatch.requestedAt);
  if (Number.isNaN(since)) return 'settings';
  if (!Number.isNaN(at) && at < since) return 'beforeFloor';
  return dispatch.targetAgentId ? 'targetGone' : 'noAgent';
}
