/**
 * REQ-97: how a card's request to the lead reads — "Waiting to send ⏳", "Sent 14:05" (this device's time) or "No lead" —
 * the same words on the card's face and in its detail. Pure: no React, no SDK.
 */
import type { Copy } from './i18n.js';
import { leadRank, type DispatchHeld } from '../shared/dispatch.js';

export type DispatchLook = 'pending' | 'sent' | 'noLead';
export function dispatchLook(dispatch: { state: string } | undefined): DispatchLook | null {
  return dispatch && (dispatch.state === 'pending' || dispatch.state === 'sent' || dispatch.state === 'noLead') ? dispatch.state : null;
}
const hhmm = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
/**
 * `fallback` (v0.1.46-B): the request waits for, or went to, the workspace's latest agent rather than a lead — said so.
 * `held` (253-D3): a card with nobody to go to says why when it is not "no agent there".
 */
export function dispatchLine(dispatch: { state: string; sentAt: string | null; held?: DispatchHeld | undefined } | undefined, m: Copy,
  fallback = false, held: DispatchHeld | undefined = dispatch?.held): string {
  const look = dispatchLook(dispatch);
  return look === 'pending' ? (fallback ? m.dispatchPendingFallback : m.dispatchPending)
    : look === 'sent' ? (fallback ? m.dispatchSentFallback : m.dispatchSent)(hhmm(dispatch!.sentAt ?? '')).trim()
    : look === 'noLead' ? (held && held !== 'noAgent' ? m.dispatchHeldChip(held) : m.dispatchNoLeadChip) : '';
}
/**
 * v0.1.46-B: whether the agent a request waits for (or went to) is the fallback — known to this screen and not a lead by
 * name. The server sends to a lead by name whenever there is one, so any other target is the workspace's latest agent.
 * Not known yet (still being looked up): false, the plain words. REQ-137: nor the chat marked as the board's lead — for a sent
 * request, the one marked when it was sent (`marked`, the server's `dispatchMode`, on the board card and the detail alike).
 * 281 F2: nor a request sent before the mark last changed (`modeUnknown`): the rule it went by is not kept, so only "Sent".
 */
export function dispatchFallback(dispatch: { targetAgentId?: string | null | undefined; marked?: true | undefined; modeUnknown?: true | undefined } | undefined,
  info: (agentId: string) => { title?: string | null | undefined; profile?: string | null | undefined } | null | undefined): boolean {
  const target = dispatch?.targetAgentId;
  const known = target ? info(target) : null;
  return !!known && !dispatch?.marked && !dispatch?.modeUnknown && leadRank({ id: target, title: known.title, profile: known.profile }) === null;
}
/**
 * J2: another screen sent the same card first — read again after the conflict, it is already on its way. Says so
 * instead of "Could not send"; null when the card is not the lead's yet (a real failure).
 */
export function dispatchAlreadyNotice(dispatch: { state: string } | undefined, m: Copy): string | null {
  const look = dispatchLook(dispatch);
  return look === 'sent' ? m.dispatchAlreadySent : look ? m.dispatchAlreadyQueued : null;
}
