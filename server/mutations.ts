import { randomUUID } from 'node:crypto';
import { createKanbanError, isKanbanError, normalizeOperations } from '../shared/core/domain.js';
import { boardEnsure, boardMutate, normalizeCwd, type EnsureReply, type EnsureRequest,
  type MutationReply, type MutationRequest } from '../shared/rpc.js';
import type { Store } from './core/store.js';
import { readError, type WorkspaceContext } from './handlers.js';
import { boardCreateKey, serially } from './serial.js';
import { sameFolder } from './auto-cards.js';

const draft = (operations: MutationRequest['operations'] | EnsureRequest['operations']) =>
  normalizeOperations(operations.map(op => op.op === 'add'
    ? { ...op, intent: 'draft', acceptanceCriteria: '', awaiting: null } : op));

/** UI capabilities are intentionally smaller than the CLI's operation vocabulary. */
export function createMutationHandler(store: Store) {
  return async (input: MutationRequest): Promise<MutationReply> => {
    let submitted = false;
    try {
      const value = boardMutate.input.parse(input);
      const operations = draft(value.operations);
      // Never infer actor from the plugin process environment.
      submitted = true;
      const result = await store.mutateBoard(value.boardId, {
        actor: { kind: 'user' }, requestId: value.requestId, ifRevision: value.ifRevision, operations,
      }, 'board'); // D37: the board screen is the only place a draft is sent to the lead from.
      return { ok: true, data: result.data, committed: result.committed, warnings: result.warnings };
    } catch (error) {
      return { ok: false, error: readError(error),
        committed: isKanbanError(error) ? error.committed : submitted ? 'unknown' : false };
    }
  };
}

/**
 * REQ-57 ③: the first card of a workspace that has no board yet. Everything that can be checked is
 * checked before the first byte is written — the request shape, the card text, and that Paseo really
 * has this workspace — and the workspace directory comes from Paseo, never from the caller, so the
 * board and its PROCESS.md land exactly where `kanban init` would put them. Initialization uses the
 * core's own init path; the cards then go in under the caller's requestId, so repeating the whole
 * request replays instead of adding a second card.
 */
export function createEnsureHandler(store: Store,
  resolve: (paseo: WorkspaceContext | undefined, workspaceId: string) => Promise<{ id: string; cwd: string }>,
  newId: () => string = randomUUID) {
  return async (input: EnsureRequest, paseo?: WorkspaceContext): Promise<EnsureReply> => {
    let submitted = false;
    try {
      const value = boardEnsure.input.parse(input);
      const operations = draft(value.operations);
      const identities = await store.listBoardIdentities();
      let existing = identities.find(b => b.workspaceId === value.workspaceId);
      let boardId = existing?.id ?? '';
      let created = false;
      if (!existing) {
        const workspace = await resolve(paseo, value.workspaceId);
        // D22 ③: a board already at this directory owns this workspace even under an older `local_` id,
        // so the card goes into that ledger. One board per directory; no second `wks_` board is created.
        // 247-D4: a Windows folder spelled in another case is the same folder.
        existing = sameFolder(identities, workspace.cwd, b => b.cwd);
        if (existing) boardId = existing.id;
        else {
          // D44: the same queue as the automatic board, looked at again inside it, so a tap and an agent's first
          // signal at the same moment leave one board (a symbolic link to the folder is the same folder).
          const real = normalizeCwd(await store.assertAllowedPath(workspace.cwd));
          ({ boardId, created } = await serially(boardCreateKey(real), async () => {
            const now = await store.listBoardIdentities();
            const found = now.find(b => b.workspaceId === value.workspaceId) ??
              sameFolder(now, workspace.cwd, b => b.cwd) ?? sameFolder(now, real, b => b.cwd);
            if (found) return { boardId: found.id, created: false };
            submitted = true;
            const init = await store.initBoard({ cwd: workspace.cwd, workspaceId: workspace.id,
              actor: { kind: 'user' }, requestId: newId(), ifRevision: '0' });
            return { boardId: init.data.boardId, created: init.data.changed };
          }));
        }
      }
      if (!boardId) throw createKanbanError('E_IO', 'The board could not be initialized.', value.workspaceId,
        'Inspect the data directory and retry.');
      submitted = true;
      // No compare-and-set: the caller has no revision to hold against a board it has never seen, and
      // adding a card is conflict-free. Repeating the request replays through the stored receipt instead.
      const result = await store.mutateBoard(boardId, { actor: { kind: 'user' },
        requestId: value.requestId, operations });
      return { ok: true, data: { ...result.data, created }, committed: result.committed, warnings: result.warnings };
    } catch (error) {
      return { ok: false, error: readError(error),
        committed: isKanbanError(error) ? error.committed : submitted ? 'unknown' : false };
    }
  };
}
