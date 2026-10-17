import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { boardMutate, dispatchPreview, type DispatchPreviewDTO } from '../shared/rpc.js';
import { dispatchCriteria, dispatchMessage, leadShortName, type DispatchHeld } from '../shared/dispatch.js';
import { newRequestId } from './editor-state.js';
import { mutationAllowed } from './demo.js';
import { usePreview } from './preview-context.js';
import { KanbanSheet } from './kanban-sheet.js';
import { TextField } from './editor-ui.js';
import { Button, Notice } from './components.js';
import { readable, type Palette } from './palette.js';
import { dispatchAlreadyNotice } from './dispatch-view.js';
import type { HostPlatform } from './layout.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';

/**
 * REQ-97: a draft moved to the working stage — by its ⋯ menu, a long press or the detail's stage flow — asks first:
 * "Send to Lead-07?", with the card's title and the very words the lead will get. [Send] moves it there as requested
 * work waiting to be sent (the server sends it once the lead is idle); [Cancel], × or a press outside leaves it a draft
 * where it was. A card with no acceptance criteria gets one line for them here; left empty, the title is used.
 * 253-D2: [Send] names the agent shown (`targetAgentId`) — the server sends to it, or holds the card, never to another
 * chat. Read again after a conflict, a different agent is shown and not sent to until [Send] is pressed again.
 */
export interface DispatchRequest { boardId: string; cardId: string; to: string }
type Preview = Extract<DispatchPreviewDTO, { ok: true }>['data'];
export type DispatchResult = { ok: true; revision: string; lead: string | null; fallback?: boolean; held?: DispatchHeld } | { ok: false; unknown: boolean };

export function DispatchSheet({ request, colors: c, m, platform, mobile, onClose, onSent }: {
  request: DispatchRequest; colors: Palette; m: Copy; platform: HostPlatform; mobile: boolean;
  onClose: () => void; onSent: (result: DispatchResult & { ok: true }, request: DispatchRequest) => void;
}) {
  const read = useRpc(dispatchPreview), mutate = useRpc(boardMutate), preview = usePreview();
  const [data, setData] = useState<Preview | null>(null), [error, setError] = useState('');
  const [criteria, setCriteria] = useState(''), [sending, setSending] = useState(false), [already, setAlready] = useState('');
  const [changed, setChanged] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (): Promise<Preview | null> => {
    try {
      const reply = await read({ boardId: request.boardId, cardId: request.cardId });
      if (!reply.ok) throw new Error(reply.error.message);
      if (alive.current) { setData(reply.data); setError(''); }
      return reply.data;
    } catch { if (alive.current) setError(m.dispatchReadFailed); return null; }
  };
  useEffect(() => { void load(); }, [request.boardId, request.cardId]);
  const card = data?.card;
  const needsCriteria = !!card && !card.acceptanceCriteria.trim();
  // v0.1.46-B: a fallback agent may have no title yet — it is named by the start of its id then.
  const lead = data?.lead ? leadShortName(data.lead.title) || data.lead.agentId.slice(0, 8) : null;
  const fallback = !!data?.lead?.fallback;
  // 253-D3: with nobody to go to, why — "no agent there" keeps its own words.
  const held = !data?.lead && data?.held && data.held !== 'noAgent' ? data.held : undefined;
  const stillDraft = !!card && card.intent === 'draft' && !(card.dispatch && card.dispatch.state !== 'cancelled');
  // The very words the server sends: the board's language and the receiving agent's id in the kanban command line.
  const message = card && data ? dispatchMessage({ title: card.title, cardId: card.id, boardTitle: data.boardTitle, notes: card.notes,
    criteria: dispatchCriteria(card, criteria), locale: data.locale ?? 'ko', agentId: data.lead?.agentId ?? null }) : '';
  const send = async () => {
    if (!data || !card || sending) return;
    if (!mutationAllowed(preview, request.boardId)) { setError(m.moveFailed); return; }
    setSending(true); setError(''); setAlready(''); setChanged(false);
    let revision = data.revision;
    const confirmed = data.lead?.agentId ?? null;
    const operations = [{ op: 'dispatch' as const, id: card.id, to: request.to, ...(needsCriteria && criteria.trim() ? { acceptanceCriteria: criteria } : {}),
      ...(confirmed ? { targetAgentId: confirmed } : {}) }];
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply;
      try { reply = await mutate({ boardId: request.boardId, ifRevision: revision, requestId: newRequestId(), operations }); }
      catch { if (alive.current) { setSending(false); setError(m.moveUnknown); } return; }
      if (reply.ok) { if (alive.current) setSending(false); onSent({ ok: true, revision: reply.data.revision, lead, fallback, ...(held ? { held } : {}) }, request); return; }
      if (reply.committed === 'unknown') { if (alive.current) { setSending(false); setError(m.moveUnknown); } return; }
      if (reply.error.code !== 'E_REVISION_CONFLICT' || attempt) break;
      // The board changed meanwhile: read it again, and send only if the card is still a draft to send.
      const latest = await load();
      // J2: another screen sent it first — it is on its way, so say so rather than "Could not send".
      const notice = latest && dispatchAlreadyNotice(latest.card.dispatch, m);
      if (notice) { if (alive.current) { setSending(false); setAlready(notice); } return; }
      if (!latest || latest.card.intent !== 'draft' || latest.card.stageId === request.to) break;
      // 253-D2: another agent would get it now — the sheet shows that one, and waits for [Send] again.
      if ((latest.lead?.agentId ?? null) !== confirmed) { if (alive.current) { setSending(false); setChanged(true); } return; }
      revision = latest.revision;
    }
    if (alive.current) { setSending(false); setError(m.dispatchFailed); }
  };
  const title = !data ? m.dispatchChecking : lead ? m.dispatchTitle(lead) : held ? m.dispatchHeldTitle : m.dispatchNoLeadTitle;
  const muted = readable(c.foregroundMuted, c.surface0);
  return <KanbanSheet testID="dispatch-sheet" title={title} open onClose={onClose} colors={c} platform={platform} closeLabel={m.close} width={px(560)}>
    {!data && !error && <Notice text={m.loading} colors={c} />}
    {!!card && <View style={{ gap: px(12) }}>
      <View style={{ gap: px(2) }}>
        <Text style={{ color: muted, fontSize: px(12) }}>{m.dispatchCard}</Text>
        <Text testID="dispatch-card-title" style={{ color: c.foreground, fontSize: px(15), fontWeight: '600' }}>{card.title}</Text>
      </View>
      {needsCriteria && <TextField testID="dispatch-criteria" label={m.acceptanceCriteria} value={criteria} colors={c} mobile={mobile}
        onChangeText={setCriteria} placeholder={m.dispatchCriteriaHint} disabled={sending} />}
      <View style={{ gap: px(4) }}>
        <Text style={{ color: muted, fontSize: px(12) }}>{m.dispatchMessage}</Text>
        <Text testID="dispatch-message" selectable style={{ color: c.foreground, fontSize: px(13), lineHeight: px(19), padding: px(10), borderRadius: px(6),
          borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>{message}</Text>
      </View>
      <Notice testID="dispatch-when" text={lead ? (fallback ? m.dispatchFallbackWhen(lead) : m.dispatchWhen(lead)) : held ? m.dispatchHeld(held) : m.dispatchNoLead} colors={c} />
      {changed && <Notice testID="dispatch-target-changed" text={m.dispatchTargetChanged} colors={c} error />}
      {!stillDraft && !already && <Notice text={m.dispatchNotDraft} colors={c} error />}
      {!!already && <Notice testID="dispatch-already" text={already} colors={c} />}
    </View>}
    {!!error && <Notice testID="dispatch-error" text={error} colors={c} error />}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: px(8), paddingTop: px(4) }}>
      <Button testID="dispatch-cancel" label={m.cancel} colors={c} mobile={mobile} onPress={onClose} />
      <Pressable testID="dispatch-send" accessibilityRole="button" accessibilityLabel={lead ? m.dispatchSendTo(lead) : m.dispatchSend}
        accessibilityState={{ disabled: !card || !stillDraft || sending }} disabled={!card || !stillDraft || sending} onPress={() => { void send(); }}
        style={{ minHeight: mobile ? px(44) : px(30), minWidth: px(88), paddingHorizontal: px(14), borderRadius: px(6), alignItems: 'center', justifyContent: 'center',
          backgroundColor: c.accent, opacity: !card || !stillDraft || sending ? .4 : 1 }}>
        <Text style={{ color: readable(c.accentForeground, c.accent), fontSize: px(13), fontWeight: '600' }}>{m.dispatchSend}</Text>
      </Pressable>
    </View>
  </KanbanSheet>;
}
