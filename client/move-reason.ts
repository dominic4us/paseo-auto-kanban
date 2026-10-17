/**
 * REQ-74: the detail view's "why it is here" line. Pure derivation only: no React, no SDK, no ledger.
 * The server tells the automatic cards' own moves apart from a person's by ledger revision (server/auto-cards.ts).
 */
import type { CardSnapshot, MoveReasonDTO, TrackingDTO } from '../shared/rpc.js';
import { elapsed } from './card-meta.js';
import type { Copy } from './i18n.js';

const two = (n: number) => String(n).padStart(2, '0');
/** A moment as this device reads it: "09-25 14:03", with the year only when it is not this year's. */
export function localStamp(iso: string, now: number): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const day = two(at.getMonth() + 1) + '-' + two(at.getDate());
  return (at.getFullYear() !== new Date(now).getFullYear() ? at.getFullYear() + '-' : '') + day + ' ' + two(at.getHours()) + ':' + two(at.getMinutes());
}
/**
 * Keeps a short phrase on one line: its spaces become no-break spaces and a word joiner (U+2060) sits
 * between its characters, since Korean may otherwise break between any two syllables ("(17\uc2dc" / "\uac04 \uc804)").
 * Plain text works the same on web and native; a style such as `wordBreak: 'keep-all'` reaches the web only.
 */
const unbroken = (text: string) => Array.from(text.replace(/ /g, '\u00a0')).join('\u2060');
/**
 * "Automatic — work finished · 09-25 14:03 (5m ago)", "Moved by a person · …", "Moved by another agent (1a2b3c4d) · …".
 * An agent linked to the card (`cardAgents`) moving it, for example with `kanban card move`, is "this card's agent".
 * REQ-126: `agentText` names that agent (its model, version and thinking level, then the id); by default its id alone.
 * The "(16h ago)" part never wraps inside itself on a narrow screen.
 */
export function moveReasonText(reason: MoveReasonDTO, m: Copy, now: number, cardAgents: readonly string[] = [],
  agentText: (agentId: string) => string = agentId => agentId.slice(0, 8)): string {
  const who = reason.by === 'auto' ? m.reasonAuto(reason.cause ? m.moveCause[reason.cause] : null)
    : reason.by === 'user' ? m.reasonUser(reason.created)
    : m.reasonAgent(reason.agentId ? agentText(reason.agentId) : '', !!reason.agentId && cardAgents.includes(reason.agentId));
  const age = elapsed(reason.at, now);
  return who + ' · ' + localStamp(reason.at, now) + (age ? ' ' + unbroken('(' + m.ago(age) + ')') : '');
}
export function trackingText(tracking: TrackingDTO, m: Copy, now: number): string {
  return tracking.state === 'on' ? m.trackingOn : tracking.state === 'off' ? m.trackingOff
    : m.trackingPaused + (tracking.since ? ' · ' + localStamp(tracking.since, now) : '');
}
/** REQ-126: the agents a card's detail names besides its assignees — its author, the one that moved it, those in its history. */
export function detailAgentIds(data: Pick<CardSnapshot, 'card' | 'history' | 'reason'>): string[] {
  const ids = new Set<string>();
  if (data.card.createdBy.kind === 'agent') ids.add(data.card.createdBy.agentId);
  if (data.reason?.by === 'agent' && data.reason.agentId) ids.add(data.reason.agentId);
  for (const h of data.history) if (h.actor.kind === 'agent') ids.add(h.actor.agentId);
  return [...ids].sort();
}
