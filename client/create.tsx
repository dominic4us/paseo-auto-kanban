import { useState } from 'react';
import { View } from 'react-native';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { boardEnsure, boardGet, boardMutate, workspaceOfEmptyBoard } from '../shared/rpc.js';
import type { WriteReply } from './mutation-state.js';
import type { Locale } from '../shared/core/domain.js';
import { useRead } from './data.js';
import type { Directory } from './presentation.js';
import { workspaceLabel } from './presentation.js';
import { copy } from './i18n.js';
import { palette } from './palette.js';
import { Button, Notice } from './components.js';
import { EditorSheet, EditFields, MutationNotice, TextField } from './editor-ui.js';
import { emptyFields, newRequestId } from './editor-state.js';
import { useMutation } from './mutation.js';
import { px } from './ui-scale.js';

/**
 * The instruction draft sheet. REQ-113: `lane` opens it from a workspace's To Do heading (its "+") — the workspace is that
 * one, so the choice of workspace is left out; the title is needed before saving, and besides the notes the acceptance
 * criteria can be written too. Saved, the sheet closes at once and the draft sits in that To Do column, brought into sight
 * (`onSaved`, research/187 J3); a phone opens it from the lane's ⋯ sheet instead (J2). Moving it on to
 * In progress asks first (REQ-97), as for any draft. The criteria go in with an ordinary update right after the add
 * (the add itself takes none), so nothing new is asked of the server.
 */
export function CreateDraft({ boards, directory, initialBoardId, lane, locale, onClose, onCreated, onSaved, onChanged, ...props }: PluginSurfaceProps & {
  boards: { id: string; workspaceId: string; cwd: string; hasLedger?: boolean | undefined }[]; directory: Directory;
  initialBoardId?: string; lane?: { boardId: string; name: string } | undefined; locale: Locale; onClose: () => void;
  onCreated: (boardId: string, cardId: string) => void; onChanged: () => void;
  /** research/187 J3: a `lane` draft saved and the sheet closing — the screen brings the new card into sight. */
  onSaved?: (boardId: string, cardId: string) => void;
}) {
  const get = useRpc(boardGet), mutate = useRpc(boardMutate), flow = useMutation();
  const [criteria, setCriteria] = useState('');
  if (lane) initialBoardId = lane.boardId;
  const [boardId, select] = useState(initialBoardId ?? ''), [fields, edit] = useState(emptyFields);
  const read = useRead(`${props.host.id}:${boardId}`, async () => boardId ? get({ boardId }) : { ok: true as const, data: null });
  const [acceptedRevision, acceptRevision] = useState<string | null>(null);
  const [message, setMessage] = useState(''), [discard, setDiscard] = useState(false);
  const mobile = props.layout.platform !== 'web' || props.layout.compact;
  const m = copy(read.data?.locale ?? locale), c = palette(props.theme);
  const locked = ['sending', 'unknown', 'saved'].includes(flow.state.phase);
  const dirty = fields.title !== '' || fields.notes !== '' || fields.nextAction !== '' || fields.priority !== 'normal' || criteria !== '';
  const untitled = !!lane && !fields.title.trim();
  const finish = async (reply: WriteReply | null) => {
    if (reply?.ok) {
      const cardId = reply.data.cardIds[0];
      if (lane && cardId && criteria.trim()) {
        const saved = await mutate({ boardId: reply.data.boardId, ifRevision: reply.data.revision, requestId: newRequestId(),
          operations: [{ op: 'update', id: cardId, patch: { acceptanceCriteria: criteria } }] }).catch(() => null);
        if (!saved?.ok) { onChanged(); setMessage(m.draftCriteriaFailed); return; }
      }
      onChanged();
      if (lane) { if (cardId) onSaved?.(reply.data.boardId, cardId); onClose(); }
    }
    else if (reply?.error.code === 'E_REVISION_CONFLICT') await flow.check();
  };
  const openCreated = () => {
    if (flow.state.reply?.ok && flow.state.reply.data.cardIds[0])
      onCreated(flow.state.reply.data.boardId, flow.state.reply.data.cardIds[0]);
  };
  // REQ-57 ③: a workspace with no board yet is saved through board.ensure, which initializes the board
  // and writes the card in one request; everything else keeps the ordinary compare-and-set path.
  const pendingWorkspace = workspaceOfEmptyBoard(boardId);
  const save = async () => {
    if (flow.state.phase === 'saved') { openCreated(); return; }
    if (!read.data || locked || flow.state.phase === 'conflict') return;
    if (untitled) { setMessage(m.draftTitleRequired); return; }
    const operations = [{ op: 'add' as const, title: fields.title, notes: fields.notes,
      nextAction: fields.nextAction, priority: fields.priority }];
    const request = pendingWorkspace
      ? { workspaceId: pendingWorkspace, requestId: newRequestId(), operations }
      : { boardId, ifRevision: acceptedRevision ?? read.data.revision, requestId: newRequestId(), operations };
    const contract = pendingWorkspace ? boardEnsure : boardMutate;
    if (!contract.input.safeParse(request).success) { setMessage(m.invalid); return; }
    setMessage(''); await finish(await flow.send(request));
  };
  const close = () => {
    if (flow.state.phase === 'sending' || flow.state.phase === 'unknown') return;
    if (dirty && flow.state.phase !== 'saved') setDiscard(true); else onClose();
  };
  return <EditorSheet title={lane ? m.newDraftIn(lane.name) : m.create} closeLabel={m.close} props={props} colors={c} onClose={close}
    action={() => { void save(); }} actionLabel={flow.state.phase === 'saved' ? m.openCard : flow.state.phase === 'sending' ? m.saving : m.saveDraft}
    disabled={flow.state.phase !== 'saved' && (!read.data || read.loading || !!read.error || locked || flow.state.phase === 'conflict' || untitled)}>
    <Notice text={m.draftHelp} colors={c} />
    {discard && <View style={{ gap: px(8) }}><Notice text={m.discardPrompt} colors={c} />
      <Button label={m.continueEditing} colors={c} mobile={mobile} onPress={() => setDiscard(false)} />
      <Button label={m.discard} colors={c} mobile={mobile} onPress={onClose} /></View>}
    {!lane && <View style={{ gap: px(4) }}><Notice text={m.selectBoard} colors={c} />
      {boards.map(board => <Button key={board.id} testID="create-board-choice"
        label={workspaceLabel(board.workspaceId, board.cwd, directory) + (board.hasLedger === false ? ' · ' + m.emptyLane : '')}
        colors={c} mobile={mobile} selected={boardId === board.id} disabled={locked || flow.state.phase === 'conflict'}
        onPress={() => { select(board.id); acceptRevision(null); flow.reset(); }} />)}
      {!boards.length && <Notice text={m.noWorkspaces} colors={c} />}
    </View>}
    {!!read.error && <><Notice text={read.error} colors={c} error /><Button label={m.retry} colors={c} mobile={mobile}
      onPress={() => { void read.refresh(); }} /></>}
    {!!message && <Notice text={message} colors={c} error />}
    <MutationNotice state={flow.state} m={m} colors={c} onCheck={() => { void flow.check(); }}
      onRetry={() => { void flow.retry().then(finish); }} />
    {flow.state.phase === 'unknown' && flow.state.checked && <View style={{ gap: px(4) }}>
      {flow.state.checked.board.stages.flatMap(stage => stage.cards).map(card =>
        <Notice key={card.id} text={`${card.id.slice(0, 13)} · ${card.title}`} colors={c} />)}
    </View>}
    {flow.state.phase === 'conflict' && <View style={{ gap: px(8) }}>
      <Notice text={m.conflict} colors={c} error />
      <Button label={m.latestBoard} colors={c} mobile={mobile} onPress={() => { void flow.check(); }} />
      {flow.state.checked && <><Notice text={`${m.currentBoard}: ${flow.state.checked.revision}`} colors={c} />
        <Button label={m.useBoard} colors={c} mobile={mobile} onPress={() => { acceptRevision(flow.state.checked!.revision); flow.reset(); }} /></>}
    </View>}
    <EditFields value={fields} onChange={patch => edit(previous => ({ ...previous, ...patch }))}
      m={m} colors={c} mobile={mobile} disabled={locked} draft />
    {!!lane && <TextField testID="create-criteria" label={m.acceptanceCriteria} value={criteria} onChangeText={setCriteria} multiline
      colors={c} mobile={mobile} disabled={locked} minHeight={mobile ? px(88) : px(60)} />}
  </EditorSheet>;
}
