import { usePreview } from './preview-context.js';
import { mutationAllowed } from './demo.js';
import { useEffect, useReducer, useRef } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { boardEnsure, boardGet, boardMutate, type ReadError } from '../shared/rpc.js';
import { emptyMutation, isEnsure, mutationReducer, type MutationAction, type WriteReply, type WriteRequest } from './mutation-state.js';
const target = (request: WriteRequest) => isEnsure(request) ? request.workspaceId : request.boardId;
export function useMutation() {
  const preview = useRef(false); preview.current = usePreview();
  const mutate = useRpc(boardMutate), ensure = useRpc(boardEnsure), read = useRpc(boardGet);
  const [state, dispatch] = useReducer(mutationReducer, undefined, emptyMutation);
  const current = useRef(state); current.current = state;
  const busy = useRef(false), alive = useRef(true);
  const transition = (action: MutationAction) => { current.current = mutationReducer(current.current, action); dispatch(action); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const check = async (request = current.current.pending) => {
    if (!alive.current || !request || !mutationAllowed(preview.current, target(request))) return null;
    try {
      const reply = await read(isEnsure(request) ? { workspaceId: request.workspaceId } : { boardId: request.boardId });
      if (!alive.current) return null;
      if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
      transition({ type: 'checked', board: reply.data }); return reply.data;
    } catch (error) {
      if (alive.current) transition({ type: 'check-error', message: String(error) });
      return null;
    }
  };
  const send = async (request: WriteRequest): Promise<WriteReply | null> => {
    if (!alive.current) return null;
    if (!mutationAllowed(preview.current, target(request))) return { ok: false, committed: false,
      error: { code: 'E_READ_ONLY', message: 'Demo data cannot be changed.', target: target(request),
        nextAction: 'Exit the demo before editing real work.', details: null } };
    if (busy.current || (current.current.phase === 'unknown' && request !== current.current.pending)) return null;
    busy.current = true; transition({ type: 'send', request });
    let reply: WriteReply;
    try { reply = isEnsure(request) ? await ensure(request) : await mutate(request); }
    catch (error) {
      const failure: ReadError = { code: 'E_CONNECTION', message: String(error), target: target(request),
        nextAction: 'Inspect the board, then retry the original request.', details: null };
      reply = { ok: false, error: failure, committed: 'unknown' };
    }
    if (!alive.current) { busy.current = false; return null; }
    transition({ type: 'reply', reply }); busy.current = false;
    if (!reply.ok && reply.committed === 'unknown') await check(request);
    return reply;
  };
  return { state, send, check, reset: () => transition({ type: 'reset' }),
    retry: () => current.current.pending ? send(current.current.pending) : Promise.resolve(null) };
}
