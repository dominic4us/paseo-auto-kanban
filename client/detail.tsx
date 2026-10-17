import type { DispatchHeld } from '../shared/dispatch.js';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { autoCardsResume, busyClear, busySet, cardGet, type CardSnapshot } from '../shared/rpc.js';
import { dispatchStage, type Locale } from '../shared/core/domain.js';
import { useRead } from './data.js';
import { copy, displayStageNames } from './i18n.js';
import { hoverFill, palette, readable, replyChip } from './palette.js';
import { Button, Field, Notice, useHovered } from './components.js';
import { AssigneeRow, useFullRow } from './status-icon.js';
import { TipLayer } from './group-header.js';
import { detailAgentIds, localStamp, moveReasonText, trackingText } from './move-reason.js';
import { agentIdSuffix, assigneeName } from './card-meta.js';
import { useSignalSource } from './signal-context.js';
import { useBusyBy, useSignalSummary } from './agent-signals.js';
import { useMinuteClock } from './minute-clock.js';
import { ChoiceRow, EditorSheet, FieldStatus, InlineTitle, PriorityChoice, TextField } from './editor-ui.js';
import { MoveToast, StageBar, useArchiveSender, useMoveSender, useUndoSender, type UndoRequest } from './quick-move.js';
import { doneStage, offersDone, sendsToLead, stageAllowed } from './move-model.js';
import { DispatchSheet, type DispatchRequest } from './dispatch-confirm.js';
import { dispatchFallback, dispatchLine } from './dispatch-view.js';
import { isOrphanedCard } from './signal-model.js';
import { spaceFlips } from './view-tools.js';
import { editorReducer, emptyEditor, type Fields } from './editor-state.js';
import { dirtyFields, useFieldSaves, type FieldKey } from './field-save.js';
import { detailLayout } from './visual-model.js';
import { criteriaLines, criteriaProgress, toggleCriterion } from '../shared/criteria.js';
import { busyView, memoText, SCREEN_BY } from './busy-view.js';
import { dwellReason, stageDwell } from './stage-time.js';
import { px } from './ui-scale.js';
import { useAgentLeave } from './agent-leave.js';

/** How long after a field used Escape (to undo its typing) the window ignores the same key's close (react-native-web: keyup). */
const ESCAPE_HELD_MS = 600;
const clockText = (at: Date) => String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');

/**
 * REQ-88 (research/129, the chosen samples): a card's detail. ① On a wide screen two columns in an 880px window — what the
 * card is about on the left (title, next action, notes, acceptance criteria, deliverables, history), a narrow panel of its
 * state on the right (stage flow and why it is there, priority, who is awaited, block reason, agents, who made it and when).
 * A phone is one column in that order of use: title, stage flow, next action, notes, the choices, the rest.
 * ② Text fields are faint until the mouse or the cursor is in them. ③ The title at the top is where it is edited.
 * ④ The stage flow moves the card at once (REQ-82 ④). ⑤ Every field saves itself (`useFieldSaves`); there is no
 * "Save changes". Closing with something still typed saves it first, and stays open only if that save fails.
 */
export function Detail({ boardId, cardId, locale, onClose, onChanged, lead = false, hereWorkspaceId, ...props }: PluginSurfaceProps & {
  boardId: string; cardId: string; locale: Locale; onClose: () => void; onChanged?: () => void;
  /** REQ-130: opened from a lead's card (one with its status row) — it offers the one-line memo. */
  lead?: boolean;
  /** REQ-142: the workspace the screen is in; opening an agent asks first unless it is known to be the agent's own (`leavesWorkspace`). */
  hereWorkspaceId?: string | undefined;
}) {
  const get = useRpc(cardGet);
  const read = useRead(`${props.host.id}:${boardId}:${cardId}`, () => get({ boardId, cardId }));
  const [editor, dispatch] = useReducer(editorReducer, undefined, emptyEditor);
  const [discard, setDiscard] = useState(false), [closing, setClosing] = useState(false);
  // REQ-74: a resume answered by the server shows at once; the next read of the card replaces it.
  const resume = useRpc(autoCardsResume);
  const [auto, setAuto] = useState<Pick<CardSnapshot, 'reason' | 'tracking'> | null>(null);
  const [resuming, setResuming] = useState(false), [resumeNote, setResumeNote] = useState<'' | 'resumed' | 'failed'>('');
  // REQ-82 ④: the stage flow's move — sent on its own — and its notice.
  const sendMove = useMoveSender(), sendUndo = useUndoSender();
  // REQ-52: the card put away from here; the detail closes once it is archived.
  const sendArchive = useArchiveSender(), [archiving, setArchiving] = useState<'busy' | 'failed' | null>(null);
  const archiveCard = async () => {
    if (!data || archiving === 'busy') return;
    setArchiving('busy');
    const ok = await sendArchive({ boardId, revision: data.revision, cardId });
    if (!alive.current) return;
    if (!ok) { setArchiving('failed'); return; }
    setArchiving(null); onChanged?.(); onClose();
  };
  const [moving, setMoving] = useState(false);
  const [moveNote, setMoveNote] = useState<{ text: string; error?: boolean; back?: UndoRequest } | null>(null);
  // REQ-84 ⑤: the busy mark turned off from here — gone at once when the server says so, the next read confirms it.
  const clearBusy = useRpc(busyClear);
  const [busyNote, setBusyNote] = useState<'' | 'clearing' | 'cleared' | 'failed'>('');
  // REQ-130 (research/260 C ②): a lead's one-line memo turned on from here — the same busy mark as `kanban card busy`.
  const setBusy = useRpc(busySet);
  const [memoDraft, setMemoDraft] = useState(''), [memoNote, setMemoNote] = useState<'' | 'saving' | 'failed' | 'invalid'>('');
  // REQ-97: a draft pressed onto the working stage asks first (the same sheet as the board's).
  const [dispatching, setDispatching] = useState<DispatchRequest | null>(null);
  const clock = useMinuteClock();
  const signals = useSignalSource();
  const width = useWindowDimensions().width;
  const agentParts = (agentId: string) => {
    const name = assigneeName(agentId, signals.model?.(agentId));
    return { name, id: agentIdSuffix(agentId, name) };
  };
  const agentText = (agentId: string) => {
    const { name, id } = agentParts(agentId);
    return name + (id ? ' · ' + id : '');
  };
  /*
   * REQ-126: every agent the detail names outside its assignee rows — the author, the one that moved the card, those in the
   * stage history — is read like them, so its model, version and thinking level show once known (an unknown one: its id).
   */
  const shown = read.data ?? editor.base;
  useSignalSummary(signals, shown ? detailAgentIds(shown) : []);
  const alive = useRef(true), escaped = useRef(-Infinity);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (read.data) dispatch({ type: 'load', snapshot: read.data }); }, [read.data]);
  useEffect(() => { setAuto(null); }, [editor.base]);
  // A mark read again (turned off, or marked anew elsewhere) replaces what the last "Turn off" said.
  useEffect(() => { setBusyNote(note => note === 'clearing' ? note : ''); }, [editor.base?.busy?.since]);
  const data = editor.base ? displayStageNames(editor.base, editor.base.locale) : null, c = palette(props.theme), m = copy(data?.locale ?? locale);
  // Research/174 J3: an agent that turned the mark on reads by its title, not its id.
  const busyName = useBusyBy(signals, data?.busy?.by), busyBy = busyName === SCREEN_BY ? m.busyByScreen : busyName;
  const mobile = props.layout.platform !== 'web' || props.layout.compact;
  const navigation = props.navigation;
  const leave = useAgentLeave({ openAgent: navigation ? input => navigation.openAgent(input) : undefined, here: hereWorkspaceId,
    colors: c, m, platform: props.layout.platform, mobile });
  const saves = useFieldSaves({ boardId, cardId, editor, m, onChanged,
    onSnapshot: snapshot => dispatch({ type: 'rebase', snapshot }) });
  const pending = dirtyFields(editor).length > 0 || saves.busy();
  /**
   * REQ-88 ⑤: asked before any close. Nothing typed and unsaved: close. Otherwise save it all first and close once saved;
   * if a save fails the window stays, says so, and a second close (or "Discard changes") lets it go.
   */
  const canClose = () => {
    if (Date.now() - escaped.current < ESCAPE_HELD_MS) return false;
    if (discard || (!dirtyFields(editor).length && !saves.busy())) return true;
    if (!closing) {
      setClosing(true);
      void saves.flush().then(ok => { if (!alive.current) return; setClosing(false); if (ok) onClose(); else setDiscard(true); });
    }
    return false;
  };
  const turnOffBusy = async () => {
    if (busyNote === 'clearing') return;
    setBusyNote('clearing');
    try {
      const reply = await clearBusy({ boardId, cardId });
      if (!reply?.ok) throw new Error(reply?.error.message);
      if (!alive.current) return;
      setBusyNote('cleared'); onChanged?.();
      const latest = await get({ boardId, cardId });
      if (alive.current && latest.ok) dispatch({ type: 'rebase', snapshot: latest.data });
    } catch { if (alive.current) setBusyNote('failed'); }
  };
  const turnOnMemo = async () => {
    if (memoNote === 'saving') return;
    const text = memoText(memoDraft);
    if (text === null) { setMemoNote('invalid'); return; }
    setMemoNote('saving');
    try {
      const reply = await setBusy({ boardId, cardId, text });
      if (!reply?.ok) throw new Error(reply?.error.message);
      if (!alive.current) return;
      setMemoNote(''); setMemoDraft(''); setBusyNote(''); onChanged?.();
      const latest = await get({ boardId, cardId });
      if (alive.current && latest.ok) dispatch({ type: 'rebase', snapshot: latest.data });
    } catch { if (alive.current) setMemoNote('failed'); }
  };
  const resumeTracking = async () => {
    if (resuming) return;
    setResuming(true); setResumeNote('');
    try {
      const reply = await resume({ boardId, cardId });
      if (!reply?.ok) throw new Error(reply?.error.message);
      const latest = await get({ boardId, cardId });
      if (!alive.current) return;
      if (latest.ok) setAuto({ reason: latest.data.reason, tracking: latest.data.tracking });
      else setAuto({ reason: data?.reason ?? null, tracking: { state: 'on', since: null } });
      setResumeNote('resumed');
    } catch { if (alive.current) setResumeNote('failed'); }
    finally { if (alive.current) setResuming(false); }
  };
  /**
   * REQ-82 ④: pressing a stage moves the card at once, as a person (REQ-74 pauses its automatic tracking). Only the
   * stage is sent; a field being typed in saves itself, apart from it (REQ-88 ⑤).
   */
  const moveTo = (to: string) => {
    if (!data || moving || to === data.card.stageId) return;
    if (sendsToLead(data.template.stages, data.card.intent, to)) { setDispatching({ boardId, cardId, to }); return; }
    const name = data.template.stages.find(s => s.stageId === to)?.name ?? to;
    void settleMove(sendMove({ boardId, revision: data.revision, cardId, to }), result =>
      ({ text: m.movedTo(name), back: { boardId, cardId, movedTo: to, revision: result.revision } }));
  };
  // REQ-82 G1: back where the ledger had the card right before the move, unless it was moved again since.
  const undoMove = (back: UndoRequest) => {
    if (!data || moving) return;
    void settleMove(sendUndo(back), result =>
      ({ text: m.movedBack(data.template.stages.find(s => s.stageId === result.to)?.name ?? result.to) }));
  };
  const settleMove = async <R extends { ok: true; revision: string }>(sent: Promise<R | { ok: false; unknown: boolean; meanwhile?: boolean }>,
    note: (result: R) => { text: string; back?: UndoRequest }) => {
    setMoving(true); setMoveNote(null);
    const result = await sent;
    if (!alive.current) return;
    try {
      const latest = await get({ boardId, cardId });
      if (alive.current && latest.ok) dispatch({ type: 'rebase', snapshot: latest.data });
    } catch { /* the notice below still says what happened; the next read catches up */ }
    if (!alive.current) return;
    if (result.ok) onChanged?.();
    setMoveNote(result.ok ? note(result)
      : { text: result.meanwhile ? m.undoMeanwhile : result.unknown ? m.moveUnknown : m.moveFailed, error: true });
    setMoving(false);
  };
  const signalArchived = (id: string) => signals.archived?.(id) === true;
  // REQ-96: as on the card, "Response needed" leads to the agent that waits — the one asking for a permission, else the
  // first — while one is asked for or the card waits for a person and is not done. (The summary keeps this live.)
  const agentIds = data?.card.agents.map(a => a.agentId) ?? [];
  useSignalSummary(signals, agentIds);
  const asking = agentIds.find(id => signals.read(id) === 'permission');
  const currentDone = !!data?.template.stages.find(s => s.stageId === data.card.stageId)?.countsAsDone;
  const finishing = !!data && offersDone(isOrphanedCard(data.card.agents.map(a => a.agentId), currentDone, signalArchived),
    data.card.intent, data.template.stages);
  const done = data ? doneStage(data.template.stages) : undefined;
  const replyAgent = data && (asking || !currentDone && data.card.awaiting === 'user') ? asking ?? agentIds[0] : undefined;
  const reply = replyAgent && leave.open ? () => leave.open?.(replyAgent) : undefined;
  // REQ-112: why the card's time in its column warns (REQ-86), the same words as the card's hint; nothing while it does not.
  const warnReason = data ? dwellReason(stageDwell({ stageId: data.card.stageId, agentIds, updatedAt: data.card.updatedAt,
    awaiting: data.card.awaiting, ...(data.busy ? { busy: data.busy } : {}), ...(data.stageEnteredAt ? { stageEnteredAt: data.stageEnteredAt } : {}),
    ...(data.stageEnteredEstimated ? { stageEnteredEstimated: true as const } : {}) }, data.template.stages,
    { read: signals.read, activity: id => signals.activity?.(id), ready: signals.ready() }, clock), m) : '';
  const layout = detailLayout(width, mobile), twoColumns = layout.columns === 2;
  const edit = (patch: Partial<Fields>) => { dispatch({ type: 'edit', patch }); if (discard) setDiscard(false); };
  const revert = (key: FieldKey) => { if (data) edit({ [key]: data.card[key] }); saves.clear(key); };
  const status = (key: FieldKey) => <FieldStatus id={key} status={saves.status[key]} m={m} colors={c} mobile={mobile}
    onRetry={() => { void saves.retry(key); }} onMine={() => { void saves.commit(key); }}
    onLatest={() => { const latest = saves.status[key]; if (latest?.state === 'conflict') edit({ [key]: latest.latest }); saves.clear(key); }} />;
  const text = (key: 'nextAction' | 'notes' | 'blockedReason', multiline = false) => <TextField key={key} testID={'field-' + key}
    label={m[key]} value={editor.draft[key] ?? ''} multiline={multiline} colors={c} mobile={mobile}
    minHeight={multiline ? (mobile ? px(88) : px(110)) : undefined}
    onChangeText={value => edit({ [key]: key === 'blockedReason' && !value.trim() ? null : value })}
    onCommit={() => { void saves.commit(key); }} onRevert={() => revert(key)} onEscape={() => { escaped.current = Date.now(); }}
    hint={multiline ? m.fieldHintNotes : m.fieldHintLine} placeholder={key === 'blockedReason' ? m.none : undefined} below={status(key)} />;
  const lastSaved = saves.lastSaved && <View testID="detail-last-saved" style={{ flexDirection: 'row', alignItems: 'center', gap: px(4) }}>
    <Icon name="Check" size={px(12)} color={readable(c.statusSuccess, c.surface0)} />
    <Text style={{ color: readable(c.foregroundMuted, c.surface0), fontSize: px(12) }}>{m.savedAt(clockText(saves.lastSaved))}</Text>
  </View>;
  const small = { color: readable(c.foregroundMuted, c.surface0), fontSize: px(12) } as const;
  const warnColor = readable(c.statusWarning, c.surface0);
  const warnLine = <View key="dwell-warn" testID="detail-dwell-warn" accessibilityRole="text" accessibilityLabel={warnReason}
    style={{ flexDirection: 'row', alignItems: 'center', gap: px(4) }}>
    <Icon name="TriangleAlert" size={px(12)} color={warnColor} />
    <Text testID="detail-dwell-warn-text" style={{ ...small, color: warnColor, fontWeight: '600' }}>{warnReason}</Text>
  </View>;
  // REQ-84: the card's busy mark, as on its face — the words and how long, since when and by whom; orange past two hours.
  const marked = busyNote === 'cleared' ? null : busyView(data?.busy, clock);
  const stageShown = (stageId: string) => data?.template.stages.find(s => s.stageId === stageId)?.name ?? stageId;
  const sections: Record<string, ReactNode> = data ? {
    title: <InlineTitle key="title" value={editor.draft.title} colors={c} m={m} mobile={mobile} disabled={false}
      onChangeText={title => edit({ title })} onCommit={typed => { void saves.commit('title', typed === undefined ? undefined : { value: typed }); }} onRevert={() => revert('title')}
      onEscape={() => { escaped.current = Date.now(); }} below={status('title')} />,
    // REQ-82 ④ / REQ-88 ④: the stage flow right under the title on a phone (seen without scrolling), atop the wide panel.
    stage: <View key="stage" testID="detail-stage" style={{ gap: px(8) }}>
      {twoColumns && <Text style={small}>{m.stage}</Text>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
        <StageBar stages={data.template.stages} current={data.card.stageId} colors={c} m={m} mobile={mobile} background={c.surface0}
          compact={twoColumns} allowed={stageId => stageAllowed(data.template.stages, data.card.intent, stageId)}
          disabled={moving} onPick={moveTo} />
        {/* REQ-88 ④: an archived card's one move waits at the end of the flow, next to the stage it goes to. */}
        {finishing && done && !mobile && <ConfirmDone label={m.confirmDone(done.name)} colors={c} mobile={false} disabled={moving}
          onPress={() => moveTo(done.stageId)} />}
      </View>
      {finishing && done && <View testID="detail-confirm-reason" style={{ flexDirection: 'row', alignItems: 'center', gap: px(6) }}>
        <Icon name="Archive" size={px(13)} color={readable(c.statusWarning, c.surface0)} />
        <Text style={{ flex: 1, color: readable(c.statusWarning, c.surface0), fontSize: px(12) }}>{m.confirmDoneReason}</Text>
      </View>}
      {finishing && done && mobile && <ConfirmDone label={m.confirmDone(done.name)} colors={c} mobile disabled={moving}
        onPress={() => moveTo(done.stageId)} />}
      {moveNote && <MoveToast inline text={moveNote.text} error={!!moveNote.error} colors={c} m={m} mobile={mobile}
        onUndo={moveNote.back ? () => undoMove(moveNote.back!) : undefined} onClose={() => setMoveNote(null)} />}
      {data.card.intent === 'draft' && <Notice text={m.draftRule(dispatchStage(data.template.stages)?.name ?? '')} colors={c} />}
      {/* REQ-97: where the card's request to the lead stands — the same words as the chip on its face. */}
      {!!data.card.dispatch && data.card.dispatch.state !== 'cancelled' && <Text testID="detail-dispatch" style={small}>
        {m.dispatchRequest + ' · ' + dispatchLine(data.card.dispatch, m, dispatchFallback({ ...data.card.dispatch, ...data.dispatchMode }, id => signals.model?.(id)), data.dispatchHeld)}</Text>}
      {!!marked && <View testID={marked.overdue ? 'detail-busy-overdue' : 'detail-busy'} accessibilityLabel={lead ? m.memoTitle : m.busyTitle} style={{ gap: px(6) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(6) }}>
          {/* REQ-130: on a lead's card the mark is its memo — a pencil, as on the card's face. */}
          {lead ? <Icon name="Pencil" size={px(12)} color={readable(marked.overdue ? c.statusWarning : c.foregroundMuted, c.surface0, 3)} />
            : <View style={{ width: px(12), height: px(12), borderRadius: px(6), borderWidth: 1.5, borderStyle: 'dashed',
            borderColor: readable(marked.overdue ? c.statusWarning : c.running, c.surface0, 3) }} />}
          <Text testID="detail-busy-text" style={{ flex: 1, fontSize: px(13), lineHeight: px(18), fontWeight: marked.overdue ? '600' : 'normal',
            color: marked.overdue ? readable(c.statusWarning, c.surface0) : c.foreground }}>
            {m.busyLine(marked.text, m.busyAge(marked.age)) + (marked.overdue ? ' · ' + m.busyOverdue : '')}</Text>
          <Button testID="detail-busy-off" label={m.busyOff} colors={c} mobile={mobile} disabled={busyNote === 'clearing'}
            onPress={() => { void turnOffBusy(); }} />
        </View>
        <Text testID="detail-busy-meta" selectable style={small}>{m.busyHint(localStamp(marked.since, clock), busyBy, marked.overdue)}</Text>
      </View>}
      {busyNote === 'failed' && <Notice text={m.busyOffFailed} colors={c} error />}
      {/* REQ-130 (research/260 C ②): a lead with no memo on — one line and "Show"; it then reads as above, "Turn off" ends it. */}
      {lead && !marked && !data.card.archivedAt && <View testID="detail-memo" style={{ gap: px(6) }}>
        <TextField testID="detail-memo-input" label={m.memoTitle} value={memoDraft} colors={c} mobile={mobile} placeholder={m.memoPlaceholder}
          onChangeText={value => { setMemoDraft(value); if (memoNote === 'invalid' || memoNote === 'failed') setMemoNote(''); }}
          onEscape={() => { escaped.current = Date.now(); }} onRevert={() => setMemoDraft('')}
          below={<View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
            <Button testID="detail-memo-on" label={m.memoOn} colors={c} mobile={mobile} disabled={memoNote === 'saving' || !memoDraft.trim()}
              onPress={() => { void turnOnMemo(); }} />
            <Text testID="detail-memo-hint" style={{ ...small, flex: 1 }}>{m.memoHint}</Text>
          </View>} />
        {memoNote === 'invalid' && <Notice text={m.memoInvalid} colors={c} error />}
        {memoNote === 'failed' && <Notice text={m.memoOnFailed} colors={c} error />}
      </View>}
      {!!(auto ?? data).reason && <View accessibilityLabel={m.moveReason} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: px(6) }}>
        <View style={{ height: px(16), justifyContent: 'center' }}><Icon name="History" size={px(12)} color={small.color} /></View>
        <Text testID="detail-move-reason" selectable style={{ ...small, flex: 1, lineHeight: px(16) }}>{moveReasonText((auto ?? data).reason!, m, clock, data.card.agents.map(a => a.agentId), agentText)}</Text>
      </View>}
      {!!(auto ?? data).tracking && <View style={{ gap: px(6) }}>
        <Text testID="detail-tracking" style={small}>{m.tracking + ' · ' + trackingText((auto ?? data).tracking!, m, clock)}</Text>
        {(auto ?? data).tracking!.state === 'paused' && <Button label={m.resumeTracking} colors={c} mobile={mobile}
          disabled={resuming} onPress={() => { void resumeTracking(); }} />}
        {resumeNote === 'resumed' && <Notice text={m.resumed} colors={c} />}
        {resumeNote === 'failed' && <Notice text={m.resumeFailed} colors={c} error />}
      </View>}
    </View>,
    nextAction: text('nextAction'),
    notes: text('notes', true),
    priority: <PriorityChoice key="priority" value={editor.draft.priority} m={m} colors={c} mobile={mobile} disabled={false}
      onChange={priority => { edit({ priority }); void saves.commit('priority', { value: priority }); }} below={status('priority')} />,
    awaiting: <View key="awaiting" style={{ gap: px(6) }}>
      <ChoiceRow testID="awaiting-choice" label={m.awaiting} value={editor.draft.awaiting} colors={c} mobile={mobile}
        disabled={false} options={([null, 'user', 'agent'] as const).map(id => ({ id, label: id ? m[id] : m.none }))}
        onChange={awaiting => { edit({ awaiting }); void saves.commit('awaiting', { value: awaiting }); }} below={status('awaiting')} />
      {reply && <ReplyLink label={m.awaitingUser + ' · ' + m.replyGo} description={m.replyAt(data.card.title)} colors={c} mobile={mobile}
        disabled={pending} onPress={reply} />}
    </View>,
    blockedReason: text('blockedReason'),
    agents: <TipLayer key="agents"><Field label={m.agents} colors={c}><View style={{ gap: px(4) }}>
      {!data.card.agents.length && <Text style={{ color: c.foregroundMuted }}>{m.none}</Text>}
      {/* REQ-77 ①: one row per agent; the row itself opens the agent (not while something typed is unsaved). */}
      {data.card.agents.map(agent => <AssigneeRow key={agent.agentId} label={agent.label} agentId={agent.agentId} colors={c} m={m}
        mobile={mobile} disabled={pending} oneLine={twoColumns}
        onOpen={leave.open ? () => leave.open?.(agent.agentId) : undefined} />)}
    </View></Field></TipLayer>,
    // REQ-103 ②: checklist lines (`- [ ]`) are ticked here, each tick saved as the criteria text (REQ-88 ⑤); other text stays read-only.
    acceptance: criteriaLines(editor.draft.acceptanceCriteria).length
      ? <Criteria key="acceptance" text={editor.draft.acceptanceCriteria} m={m} colors={c} mobile={mobile}
        onToggle={line => { const value = toggleCriterion(editor.draft.acceptanceCriteria, line);
          edit({ acceptanceCriteria: value }); void saves.commit('acceptanceCriteria', { value }); }} below={status('acceptanceCriteria')} />
      : <Field key="acceptance" label={m.acceptanceCriteria} colors={c}>{data.card.acceptanceCriteria || m.none}</Field>,
    deliverables: <Field key="deliverables" label={m.deliverables} colors={c}>{data.card.deliverables.join('\n') || m.none}</Field>,
    // REQ-77 ②: the author named as an assignee row names it, and every moment in this device's time.
    meta: <TipLayer key="meta"><View testID="detail-meta" style={{ gap: px(2), ...(twoColumns ? { paddingTop: px(10), borderTopWidth: 1, borderColor: c.border } : {}) }}>
      {([[m.createdBy, data.card.createdBy.kind === 'user' ? m.user : agentText(data.card.createdBy.agentId)],
        [m.createdAt, localStamp(data.card.createdAt, clock)], [m.updatedAt, localStamp(data.card.updatedAt, clock)],
        // REQ-86: when the card entered its stage (the server's read of the movement records; "(estimated)" when cut off).
        ...(data.stageEnteredAt ? [[m.stageEnteredAt, localStamp(data.stageEnteredAt, clock) + (data.stageEnteredEstimated ? ' ' + m.estimated : '')]] : []),
        [m.cardId, data.card.id]] as const).map(([label, value]) => twoColumns && label === m.createdBy && data.card.createdBy.kind === 'agent'
          ? <AuthorLine key={label} label={label} {...agentParts(data.card.createdBy.agentId)} agentId={data.card.createdBy.agentId} colors={c} style={small} />
          : <Text key={label} selectable style={small}>{label + ' · ' + value}</Text>)
        // REQ-112: under "Entered this stage", why its time warns — only while it does.
        .flatMap(line => line.key === m.stageEnteredAt || (!data.stageEnteredAt && line.key === m.updatedAt) ? [line, ...(warnReason ? [warnLine] : [])] : [line])}
    </View></TipLayer>,
    // REQ-136 H4: a movement names its stages as the board shows them ("In progress", "진행"), not by their ids (doing).
    history: <Field key="history" label={m.history} colors={c}>{data.history.map(h => `${localStamp(h.at, clock)} · ${h.from == null ? '—' : stageShown(h.from)} → ${stageShown(h.to)}`
      + (h.actor.kind === 'agent' ? ' · ' + agentText(h.actor.agentId) : '')).join('\n') || m.noHistory}</Field>,
    // REQ-52: "Archive" at the end of the card's properties, with what it means for the progress.
    archive: <View key="archive" testID="detail-archive" style={{ gap: px(6) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
        <Button testID="detail-archive-button" label={m.archiveCard} colors={c} mobile={mobile} disabled={archiving === 'busy'}
          onPress={() => { void archiveCard(); }} />
      </View>
      <Text testID="detail-archive-help" style={small}>{m.archiveCardHelp}</Text>
      {archiving === 'failed' && <Notice testID="detail-archive-failed" text={m.archiveFailed} colors={c} error />}
    </View>,
  } : {};
  const pick = (keys: string[]) => keys.map(key => sections[key]);
  const dispatched = async (result: { lead: string | null; fallback?: boolean; held?: DispatchHeld }) => {
    setDispatching(null);
    try {
      const latest = await get({ boardId, cardId });
      if (alive.current && latest.ok) dispatch({ type: 'rebase', snapshot: latest.data });
    } catch { /* the next read catches up */ }
    if (!alive.current) return;
    onChanged?.();
    setMoveNote({ text: m.dispatchQueued(result.lead, result.fallback, result.held) });
  };
  return <EditorSheet wide closeLabel={m.close} title={m.detail} props={props} colors={c} onClose={onClose} canClose={canClose}
    headerExtra={lastSaved || undefined}>
    {read.loading && !data && <Notice text={m.loading} colors={c} />}
    {!!read.error && <><Notice text={read.error} colors={c} error /><Button label={m.retry} colors={c} mobile={mobile}
      onPress={() => { void read.refresh(); }} /></>}
    {saves.warning && <Notice text={m.exportWarning} colors={c} error />}
    {discard && <View testID="detail-discard" style={{ gap: px(8) }}><Notice text={m.closeUnsaved} colors={c} error />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(8) }}>
        <Button label={m.continueEditing} colors={c} mobile={mobile} onPress={() => setDiscard(false)} />
        <Button label={m.discard} colors={c} mobile={mobile} onPress={onClose} /></View></View>}
    {closing && <Notice text={m.fieldSaving} colors={c} />}
    {data && (twoColumns
      ? <View testID="detail-columns" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: layout.gap }}>
        <View testID="detail-main" style={{ flex: 1, minWidth: 0, gap: px(18) }}>{pick(['title', 'nextAction', 'notes', 'acceptance', 'deliverables', 'history'])}</View>
        <View testID="detail-panel" accessibilityLabel={m.properties} style={{ width: layout.panelWidth, gap: px(14), padding: px(14), borderRadius: px(8),
          borderWidth: 1, borderColor: c.border }}>{pick(['stage', 'priority', 'awaiting', 'blockedReason', 'agents', 'meta', 'archive'])}</View>
      </View>
      : <View testID="detail-columns" style={{ gap: px(16) }}>{pick(['title', 'stage', 'nextAction', 'notes', 'priority', 'awaiting',
        'blockedReason', 'agents', 'acceptance', 'deliverables', 'meta', 'history', 'archive'])}</View>)}
    {dispatching && <DispatchSheet request={dispatching} colors={c} m={m} platform={props.layout.platform} mobile={mobile}
      onClose={() => setDispatching(null)} onSent={result => { void dispatched(result); }} />}
    {leave.sheet}
  </EditorSheet>;
}
/**
 * D45: the author in the wide detail's side panel, on one line as its assignee rows are — the name loses its end
 * (REQ-126: the thinking level, then the version), the id after it is never cut.
 */
function AuthorLine({ label, name, id, agentId, colors, style }: { label: string; name: string; id: string; agentId: string;
  colors: ReturnType<typeof palette>; style: { color: string; fontSize: number } }) {
  // REQ-131: the whole line as a tip under the mouse, two lines (name, then the whole id) once pressed on a touch screen.
  const full = useFullRow([label, name, agentId].join(' · '), colors);
  return <Pressable testID="detail-author" accessibilityState={{ expanded: full.open }} {...full.handlers} onPress={() => { full.press(); }}
    style={{ flexDirection: full.open ? 'column' : 'row', minWidth: 0, ...full.lift }}>
    {full.open ? <>
      <Text testID="detail-author-name" selectable style={style}>{label + ' · ' + name}</Text>
      <Text testID="detail-author-id" selectable style={style}>{agentId}</Text>
    </> : <>
      <Text testID="detail-author-name" selectable numberOfLines={1} style={{ ...style, flexShrink: 1, minWidth: 0 }}>{label + ' · ' + name}</Text>
      {!!id && <Text testID="detail-author-id" selectable numberOfLines={1} style={{ ...style, flexShrink: 0 }}>{' · ' + id}</Text>}
    </>}
    {full.tip}
  </Pressable>;
}
/**
 * REQ-103 ②: acceptance criteria written as a checklist. The heading says how many are ticked; each `- [ ]` line is a
 * box that ticks or unticks on a press (`onToggle`, its line number), and every other line is shown as written.
 */
function Criteria({ text, m, colors: c, mobile, onToggle, below }: {
  text: string; m: ReturnType<typeof copy>; colors: ReturnType<typeof palette>; mobile: boolean; onToggle: (line: number) => void; below: ReactNode;
}) {
  const boxes = new Map(criteriaLines(text).map(item => [item.line, item])), progress = criteriaProgress(text);
  const muted = readable(c.foregroundMuted, c.surface0);
  return <View testID="detail-criteria" style={{ gap: px(4) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
      <Text style={{ color: c.foregroundMuted, fontSize: px(12) }}>{m.acceptanceCriteria}</Text>
      {progress && <Text testID="detail-criteria-progress" style={{ color: muted, fontSize: px(12) }}>{m.criteriaProgress(progress.checked, progress.total)}</Text>}
    </View>
    <View style={{ gap: mobile ? 0 : px(2) }}>
      {text.split('\n').map((raw, line) => {
        const item = boxes.get(line);
        if (!item) return raw.trim() ? <Text key={line} selectable style={{ color: c.foreground, fontSize: px(14), lineHeight: px(20) }}>{raw.replace(/\r$/, '')}</Text> : null;
        return <CriterionRow key={line} line={line} label={item.text} checked={item.checked} colors={c} mobile={mobile}
          description={(item.checked ? m.criteriaUncheck : m.criteriaCheck)(item.text)} onPress={() => onToggle(line)} />;
      })}
    </View>
    {below}
  </View>;
}
function CriterionRow({ line, label, checked, colors: c, mobile, description, onPress }: {
  line: number; label: string; checked: boolean; colors: ReturnType<typeof palette>; mobile: boolean; description: string; onPress: () => void;
}) {
  const hover = useHovered();
  return <Pressable testID={'detail-criterion-' + line} accessibilityRole="checkbox" role="checkbox" aria-checked={checked}
    accessibilityState={{ checked }} accessibilityLabel={description} onPress={onPress} {...spaceFlips(onPress)}
    onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: mobile ? px(44) : px(28), flexDirection: 'row', alignItems: 'center', gap: px(8), marginHorizontal: px(-6), paddingHorizontal: px(6),
      borderRadius: px(6), backgroundColor: hover.hovered && !mobile ? hoverFill(c, c.surface0) : 'transparent' }}>
    <Icon name={checked ? 'SquareCheck' : 'Square'} size={px(16)} color={checked ? readable(c.statusSuccess, c.surface0, 3) : readable(c.foregroundMuted, c.surface0, 3)} />
    <Text style={{ flex: 1, color: checked ? readable(c.foregroundMuted, c.surface0) : c.foreground, fontSize: px(14), lineHeight: px(20) }}>{label}</Text>
  </Pressable>;
}
/**
 * REQ-96: "Response needed · Go answer ↗" under who is awaited — the agent's conversation, where its question or permission
 * request is. Like an agent row, it waits while something typed is unsaved. J5 (research/149): the card's chip; a phone's
 * press is 36px tall around it.
 */
function ReplyLink({ label, description, colors: c, mobile, disabled, onPress }: {
  label: string; description: string; colors: ReturnType<typeof palette>; mobile: boolean; disabled: boolean; onPress: () => void;
}) {
  const hover = useHovered(), chip = replyChip(c, c.surface0, hover.hovered && !mobile && !disabled);
  return <Pressable testID="detail-reply" accessibilityRole="button" accessibilityLabel={description} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: mobile ? px(36) : px(24), alignSelf: 'flex-start', justifyContent: 'center', opacity: disabled ? .5 : 1 }}>
    <View testID="detail-reply-chip" style={{ height: px(24), flexDirection: 'row', alignItems: 'center', gap: px(4), paddingHorizontal: px(9),
      borderRadius: px(12), borderWidth: 1, borderColor: chip.borderColor, backgroundColor: chip.backgroundColor }}>
      <Text style={{ color: chip.color, fontSize: px(13), lineHeight: px(16), fontWeight: '600',
        textDecorationLine: hover.hovered && !mobile && !disabled ? 'underline' : 'none' }}>{label}</Text>
      <Icon name="ArrowUpRight" size={px(13)} color={chip.color} />
    </View>
  </Pressable>;
}
/** REQ-88 ④: "Confirm done" — a small button at the end of the flow on a wide screen, a 44px one under it on a phone. */
function ConfirmDone({ label, colors: c, mobile, disabled, onPress }: {
  label: string; colors: ReturnType<typeof palette>; mobile: boolean; disabled: boolean; onPress: () => void;
}) {
  return <Pressable testID="detail-confirm-done" accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: mobile ? px(44) : px(28), paddingHorizontal: px(12), borderRadius: mobile ? px(8) : px(14), flexDirection: 'row', gap: px(6),
      alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent, opacity: disabled ? .5 : 1,
      ...(mobile ? { alignSelf: 'stretch' as const } : {}) }}>
    <Icon name="Check" size={px(14)} color={readable(c.accentForeground, c.accent)} />
    <Text style={{ color: readable(c.accentForeground, c.accent), fontSize: px(13), fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}
