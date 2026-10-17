import type { CardSnapshot, MutationRequest } from '../shared/rpc.js';
export type Fields = Pick<CardSnapshot['card'], 'title' | 'notes' | 'nextAction' | 'priority' | 'blockedReason' | 'awaiting' | 'acceptanceCriteria'>;
// REQ-103 ①: the criteria are saved from the detail's checklist (a tick), not typed there.
export const editableKeys = ['title', 'notes', 'nextAction', 'priority', 'blockedReason', 'awaiting', 'acceptanceCriteria'] as const;
export function fieldsOf(card: Fields): Fields {
  return { title: card.title, notes: card.notes, nextAction: card.nextAction,
    priority: card.priority, blockedReason: card.blockedReason, awaiting: card.awaiting, acceptanceCriteria: card.acceptanceCriteria };
}
export interface EditorState {
  base: CardSnapshot | null; draft: Fields; stageId: string; latest: CardSnapshot | null;
}
export const emptyFields = (): Fields => ({ title: '', notes: '', nextAction: '', priority: 'normal', blockedReason: null, awaiting: null, acceptanceCriteria: '' });
export const emptyEditor = (): EditorState => ({ base: null, draft: emptyFields(), stageId: '', latest: null });
export type EditorAction = { type: 'load' | 'saved' | 'rebase'; snapshot: CardSnapshot }
  | { type: 'edit'; patch: Partial<Fields> } | { type: 'stage'; stageId: string }
  | { type: 'conflict'; latest: CardSnapshot } | { type: 'use-latest' | 'keep-mine' };
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'load': if (state.base) return state; // A background read must never overwrite a draft.
    // fall through
    case 'saved': return { base: action.snapshot, draft: fieldsOf(action.snapshot.card),
      stageId: action.snapshot.card.stageId, latest: null };
    // REQ-82 ④: the stage bar saved the stage alone. The card is read again, and what was typed and not saved yet stays.
    case 'rebase': {
      if (!state.base) return { base: action.snapshot, draft: fieldsOf(action.snapshot.card), stageId: action.snapshot.card.stageId, latest: null };
      const draft = fieldsOf(action.snapshot.card);
      for (const key of editableKeys) if (state.draft[key] !== state.base.card[key]) Object.assign(draft, { [key]: state.draft[key] });
      return { base: action.snapshot, draft, stageId: action.snapshot.card.stageId, latest: state.latest };
    }
    case 'edit': return { ...state, draft: { ...state.draft, ...action.patch } };
    case 'stage': return { ...state, stageId: action.stageId };
    case 'conflict': return { ...state, latest: action.latest };
    case 'use-latest': return state.latest ? { base: state.latest, draft: fieldsOf(state.latest.card),
      stageId: state.latest.card.stageId, latest: null } : state;
    case 'keep-mine': {
      if (!state.latest || !state.base) return state;
      // Preserve only fields edited locally; unrelated concurrent edits remain authoritative.
      const draft = fieldsOf(state.latest.card);
      for (const key of editableKeys) if (state.draft[key] !== state.base.card[key])
        Object.assign(draft, { [key]: state.draft[key] });
      return { base: state.latest, draft, latest: null,
        stageId: state.stageId === state.base.card.stageId ? state.latest.card.stageId : state.stageId };
    }
  }
}
export function isDirty(state: EditorState): boolean {
  return !!state.base && (state.stageId !== state.base.card.stageId ||
    editableKeys.some(key => state.draft[key] !== state.base!.card[key]));
}
export function compareEdits(state: EditorState) {
  if (!state.latest) return [];
  return [...editableKeys, 'stageId' as const].map(key => ({ key,
    latest: key === 'stageId' ? state.latest!.card.stageId : state.latest!.card[key],
    mine: key === 'stageId' ? state.stageId : state.draft[key],
  })).filter(row => row.latest !== row.mine);
}
export function editorOperations(state: EditorState): MutationRequest['operations'] {
  if (!state.base) return [];
  const patch: Partial<Fields> = {};
  for (const key of editableKeys) if (state.draft[key] !== state.base.card[key])
    Object.assign(patch, { [key]: state.draft[key] });
  const operations: MutationRequest['operations'] = Object.keys(patch).length
    ? [{ op: 'update', id: state.base.card.id, patch }] : [];
  if (state.stageId !== state.base.card.stageId) {
    const move = { op: 'move' as const, id: state.base.card.id, to: state.stageId };
    const reopening = state.base.template.stages.find(s => s.stageId === state.base!.card.stageId)?.countsAsDone &&
      !state.base.template.stages.find(s => s.stageId === state.stageId)?.countsAsDone;
    if (reopening) operations.unshift(move); else operations.push(move);
  }
  return operations;
}
/** Request IDs identify retries, not authentication secrets; no unavailable native crypto dependency. */
export function newRequestId(random = Math.random): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const value = Math.floor(random() * 16); return (c === 'x' ? value : (value & 3) | 8).toString(16);
  });
}
export function reclaimSeconds(details: unknown, now: number): number | null {
  if (!details || typeof details !== 'object') return null;
  const at = (details as { reclaimableAtMs?: unknown }).reclaimableAtMs;
  return typeof at === 'number' && Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}
