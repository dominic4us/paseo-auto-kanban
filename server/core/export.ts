import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isKanbanError, fail, parseJson, renderProcess, type Board, type Warning } from '../../shared/core/domain.js';
import { autoMadeBoard, readAutoState } from './auto-state.js';
import type { CommitEffect, Result, Store } from './store.js';

export interface ExportOptions { readExisting?: (file: string) => Promise<Buffer> }
export interface ExportData { boardId: string; revision: string; status: CommitEffect['status'] }
interface Inspection { board: Board; target: string; bytes: Buffer; previous: Buffer | null; effect: CommitEffect }
const blankEffect = (status: CommitEffect['status']): CommitEffect => ({ status, warnings: [], exportWrites: 0, bytesWritten: 0 });
function blocked(board: Board, code: string, message: string, status: 'skipped' | 'failed'): Inspection {
  const effect = blankEffect(status);
  effect.warnings.push({ code, message, target: path.join(board.cwd, 'PROCESS.md'), nextAction: `Check the output path and run kanban export --workspace ${board.id}.` });
  return { board, target: path.join(board.cwd, 'PROCESS.md'), bytes: Buffer.alloc(0), previous: null, effect };
}
function codeOf(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
async function readExisting(file: string, store?: Store): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('E_EXPORT', 'Output is not a regular file.', file);
    if (info.size > 4 * 1024 * 1024) fail('E_EXPORT', 'Existing output exceeds 4 MiB.', file);
    const bytes = await handle.readFile();
    store?.recordRead(file, bytes.length);
    return bytes;
  } finally { await handle.close(); }
}
async function inspect(store: Store, board: Board, options: ExportOptions): Promise<Inspection> {
  const target = path.join(board.cwd, 'PROCESS.md');
  try {
    const config = await store.readConfig();
    if (!config.exportEnabled) return { board, target, bytes: Buffer.alloc(0), previous: null, effect: blankEffect('skipped') };
    try { await store.assertAllowedPath(board.cwd); await store.assertAllowedPath(target); }
    catch (error) { if (isKanbanError(error) && error.code === 'E_PATH_FORBIDDEN') return blocked(board,
         'W_PATH_FORBIDDEN',
         'Export path is inside a protected root.',
         'skipped');
         throw error;
         }
    try { if (!(await fs.stat(board.cwd)).isDirectory()) return blocked(board, 'W_CWD_MISSING', 'Workspace directory is missing.', 'skipped'); }
    catch (error) { if (codeOf(error) === 'ENOENT') return blocked(board, 'W_CWD_MISSING', 'Workspace directory is missing.', 'skipped'); throw error; }
    const owners = (await store.listBoardIdentities()).filter(b => b.cwd === board.cwd && b.workspaceStatus === 'active');
    if (owners.length !== 1 || owners[0]!.id !== board.id) return blocked(board, 'W_EXPORT_OWNER', 'Export requires exactly one active board for this directory.', 'skipped');
    const bytes = Buffer.from(renderProcess(board, config.locale, config.export.detail));
    if (bytes.length > 4 * 1024 * 1024) return blocked(board, 'W_EXPORT_SIZE', 'Rendered output exceeds 4 MiB.', 'failed');
    let previous: Buffer | null = null;
    let observed = false;
    try {
      const info = await fs.lstat(target); observed = true;
      if (!info.isFile() || info.isSymbolicLink()) return blocked(board, 'W_EXPORT_TARGET', 'Refusing to replace a symbolic link or non-regular file.', 'failed');
      previous = await (options.readExisting ?? (file => readExisting(file, store)))(target);
      const marker = `<!-- paseo-kanban:generated:v1 board=${board.id} -->\n`;
      if (!previous.subarray(0,
           Buffer.byteLength(marker)).equals(Buffer.from(marker))) return blocked(board,
           'W_EXPORT_TARGET',
           'Refusing to replace a manual file or another board output.',
           'failed');
    } catch (error) {
      // Only a confirmed missing directory entry permits creation. A read failure does not.
      if (observed) return blocked(board, 'W_EXPORT_COMPARE', 'Reading the existing output failed; no output was written.', 'failed');
      if (codeOf(error) !== 'ENOENT') throw error;
      try { await fs.lstat(target); return blocked(board, 'W_EXPORT_COMPARE', 'Output comparison failed; the existing target was preserved.', 'failed'); }
      catch (probe) { if (codeOf(probe) !== 'ENOENT') throw probe; }
    }
    return { board, target, bytes, previous, effect: blankEffect(previous?.equals(bytes) ? 'unchanged' : 'written') };
  } catch (error) {
    return blocked(board, 'W_EXPORT_COMPARE', `Export comparison failed (${codeOf(error) ?? 'unknown'}); no output was written.`, 'failed');
  }
}
async function writeInspected(store: Store, inspection: Inspection): Promise<CommitEffect> {
  const { board, target, bytes, previous, effect } = inspection;
  if (effect.status !== 'written') return effect;
  const temporary = path.join(board.cwd, `.PROCESS.md.tmp-${randomUUID()}`);
  let owned = false;
  try {
    await store.assertAllowedPath(target);
    // Preserve files changed by an external editor between comparison and publication.
    if (previous === null) {
      try { await fs.lstat(target); return blocked(board, 'W_EXPORT_TARGET', 'Output appeared during comparison; preserving it.', 'failed').effect; }
      catch (error) { if (codeOf(error) !== 'ENOENT') throw error; }
    } else if (!(await readExisting(target, store)).equals(previous)) return blocked(board, 'W_EXPORT_COMPARE', 'Output changed during comparison; preserving it.', 'failed').effect;
    const handle = await fs.open(temporary, 'wx', 0o600); owned = true;
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    await fs.rename(temporary, target); owned = false;
    return { ...effect, exportWrites: 1, bytesWritten: bytes.length };
  } catch (error) {
    return blocked(board, 'W_EXPORT_FAILED', `Output write failed (${codeOf(error) ?? 'unknown'}); the board remains valid.`, 'failed').effect;
  } finally { if (owned) await fs.unlink(temporary).catch(() => undefined); }
}
/**
 * D44: whether this board never creates PROCESS.md after a commit — a board the plugin made by itself (server/auto-cards.ts)
 * for a workspace that never asked for one: a folder of a person with no skill or CLI gets no file it was not told about.
 * One a person made with `kanban export` is still kept up to date. 247-D1/249-D1: the one reading of the plugin's file
 * (`readAutoState`, server/core/auto-state.ts) and the one judgement (`autoMadeBoard`): a missing file (and backup) means
 * "not such a board"; a file that cannot be read means "maybe", and no file is created.
 */
export async function quietBoard(store: Pick<Store, 'dataDir'>, board: Pick<Board, 'id' | 'cwd'>): Promise<boolean> {
  return autoMadeBoard(await readAutoState(store.dataDir), board);
}
// Called by Store only while the board writer lock is held, after its durable commit.
export async function exportCommittedBoard(board: Board, store: Store): Promise<CommitEffect> {
  const inspection = await inspect(store, board, {});
  // D44: no PROCESS.md is created for (and no warning raised about) a board the plugin made by itself.
  if (inspection.previous === null && inspection.effect.status !== 'skipped' && await quietBoard(store, board)) return blankEffect('skipped');
  return writeInspected(store, inspection);
}
export async function exportBoard(store: Store, id: string, options: ExportOptions = {}): Promise<Result<ExportData>> {
  const started = performance.now(); const initial = await inspect(store, await store.readBoard(id), options);
  const io = { ...store.readMetrics(), lockHeldMs: 0, lockWaitMs: 0, boardWrites: 0, backupLinks: 0, backupWrites: 0, exportWrites: 0, fsyncCalls: 0, bytesWritten: 0, lockAcquisitions: 0 };
  if (initial.effect.status !== 'written') return { data: { boardId: id,
       revision: initial.board.revision,
       status: initial.effect.status },
       committed: false,
       warnings: initial.effect.warnings,
       meta: { io,
       durationMs: performance.now() - started } };
  const locked = await store.withBoardLock(id, async current => ({ revision: current.revision, effect: await writeInspected(store, await inspect(store, current, options)) }));
  const { effect, revision } = locked.data;
  return { data: { boardId: id,
       revision,
       status: effect.status },
       committed: false,
       warnings: [...locked.warnings,
       ...effect.warnings],
       meta: { io: { ...locked.meta.io,
       exportWrites: effect.exportWrites,
       bytesWritten: effect.bytesWritten },
       durationMs: performance.now() - started } };
}
export async function inspectExport(store: Store, id: string): Promise<{ status: CommitEffect['status']; warnings: Warning[] }> {
  const current = await inspect(store, await store.readBoard(id), {});
  return { status: current.effect.status, warnings: current.effect.warnings };
}
export async function readInputJson(file: string, stdin: AsyncIterable<Uint8Array> = process.stdin): Promise<unknown> {
  let bytes: Buffer;
  if (file === '-') {
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of stdin) { const chunk = Buffer.from(part); size += chunk.length; if (size > 1048576) fail('E_LIMIT', 'Input exceeds 1 MiB.', file); chunks.push(chunk); }
    bytes = Buffer.concat(chunks);
  } else {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); if (!info.isFile() || info.size > 1048576) fail('E_LIMIT', 'Expected a regular input file of at most 1 MiB.', file); bytes = await handle.readFile(); }
    finally { await handle.close(); }
  }
  try { return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { if (isKanbanError(error)) throw error; fail('E_VALIDATION', 'Input must be UTF-8 JSON.', file); }
}
