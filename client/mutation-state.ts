import type { BoardSnapshot, EnsureReply, EnsureRequest, MutationReply, MutationRequest } from '../shared/rpc.js';
/** REQ-57 ③: a pending write is either an edit of a known board or the first card of a new one. */
export type WriteRequest = MutationRequest | EnsureRequest;
export type WriteReply = MutationReply | EnsureReply;
export const isEnsure = (request: WriteRequest): request is EnsureRequest => !('boardId' in request);
export interface MutationState {
  phase: 'idle' | 'sending' | 'failed' | 'conflict' | 'unknown' | 'saved';
  pending: WriteRequest | null; reply: WriteReply | null;
  checked: BoardSnapshot | null; checkError: string;
}
export const emptyMutation = (): MutationState => ({ phase: 'idle', pending: null, reply: null, checked: null, checkError: '' });
export type MutationAction = { type: 'send'; request: WriteRequest } | { type: 'reply'; reply: WriteReply }
  | { type: 'checked'; board: BoardSnapshot } | { type: 'check-error'; message: string } | { type: 'reset' };
export function mutationReducer(state: MutationState, action: MutationAction): MutationState {
  switch (action.type) {
    case 'send': return { ...emptyMutation(), phase: 'sending', pending: action.request };
    case 'reply': return { ...state, reply: action.reply,
      phase: action.reply.ok ? 'saved' : action.reply.committed === 'unknown' ? 'unknown'
        : action.reply.error.code === 'E_REVISION_CONFLICT' ? 'conflict' : 'failed',
      pending: action.reply.ok ? null : state.pending };
    case 'checked': return { ...state, checked: action.board, checkError: '' };
    case 'check-error': return { ...state, checkError: action.message };
    case 'reset': return state.phase === 'sending' || state.phase === 'unknown' ? state : emptyMutation();
  }
}
