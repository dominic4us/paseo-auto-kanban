import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WORKFLOW_DEFINITION_PATH, workflowDefinitionSchema, type WorkflowDefinition } from '../shared/workflow.js';
import { createKanbanError } from '../shared/core/domain.js';
import { WORKFLOW_LIMITS, confine, type Limits } from './workflow.js';

/**
 * REQ-125 2단계 (research/288): "Export to the project folder" — the one place the plugin writes into a workspace folder,
 * kept apart from the reading (server/workflow.ts, which stays free of writes) and reached only from the owner's press
 * (`kanban.v1.workflow.export`, server/handlers.ts). It passes the reading's boundary check (`confine`).
 */
/** A path there in any form — a file, a folder, a link (dangling or not). */
const present = (file: string) => fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
/** Link errors of a file system that keeps no hard links: with no way to publish without replacing, the export is refused. */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']);
/** What an export leaves that it could not take back, by full path (295-F4); absent when nothing is left. */
export interface ExportResult { path: string; left?: string[] }
/**
 * REQ-125 2단계: writes `def` as the workspace's `.kanban/workflow.json` — on the owner's press only (server/handlers.ts).
 * - Never over anything: a file, folder or link already at that place is refused (`E_EXISTS`) and left as it is.
 * - The reading's boundary: `.kanban` must resolve (links followed) inside the folder's real path, else `E_OUTSIDE`; it is
 *   made, one level, when it is missing (the workspace folder itself must be there).
 * - 293-F1: the folder checked is opened, and everything after goes through that open folder (`/proc/self/fd/<fd>/…`), not
 *   through its name again — a name swapped for a link to elsewhere is never followed. The opened folder itself could be
 *   moved out of the workspace meanwhile, so once the file is published the folder's place is read again from the open
 *   handle: anywhere but where it was checked, what was written is taken back and the export is refused (`E_OUTSIDE`).
 * - Whole or nothing: the bytes go to a temporary file in that folder, then are hard-linked to the name — a link never
 *   replaces a file that appeared in between (EEXIST → `E_EXISTS`). 293-F2: a file system that refuses hard links has no
 *   publish that cannot replace, so the export is refused (`E_UNSUPPORTED`) instead of renaming; so is a host that is not
 *   Linux or has no `/proc/self/fd` (no folder handle to write through).
 * - 295-F3: taking back never removes a file by the public name `workflow.json`, which anyone may put a file at. What is
 *   there is first renamed to an unguessable name in the same open folder (its bytes kept); only if that is our file (the
 *   same device and inode as the temporary file) is it removed — otherwise it is linked back to `workflow.json` (never over
 *   anything) and the extra name removed, or, when it cannot go back, left under that name and said. The temporary file
 *   (an unguessable name too) is removed only while it is still ours.
 * - 295-F4: whatever could not be removed is said by full path — `details.left` of the refusal, or `left` of a success
 *   whose temporary file stayed — never "nothing was written".
 */
export async function exportDefinition(cwd: string, def: WorkflowDefinition, limits: Limits = WORKFLOW_LIMITS): Promise<ExportResult> {
  const where = WORKFLOW_DEFINITION_PATH, folderName = path.dirname(where), fileName = path.basename(where);
  const outside = () => createKanbanError('E_OUTSIDE', folderName + ' does not lead inside the workspace folder; nothing was written.', where,
    'Move or remove ' + folderName + ' in the project folder, then export again.');
  const exists = () => createKanbanError('E_EXISTS', where + ' is already in the project folder; it was not written over.', where,
    'Read the workflow again: the file there comes first.');
  const unsupported = () => createKanbanError('E_UNSUPPORTED', 'This host or file system cannot add a file without risking replacing one; nothing was written.',
    where, 'Copy the workflow into ' + where + ' by hand, or export from a Linux host on a file system with hard links.');
  if (!cwd || !path.isAbsolute(cwd)) throw createKanbanError('E_NOT_FOUND', 'The workspace folder is not known.', cwd, 'Open the workspace in Paseo.');
  let root: string;
  try { root = await fs.realpath(cwd); }
  catch { throw createKanbanError('E_NOT_FOUND', 'The workspace folder cannot be found.', cwd, 'Open the workspace in Paseo.'); }
  const bytes = JSON.stringify(def, null, 2) + '\n';
  if (Buffer.byteLength(bytes, 'utf8') > limits.definitionBytes || !workflowDefinitionSchema.safeParse(JSON.parse(bytes)).success)
    throw createKanbanError('E_VALIDATION', 'The workflow could not be written as a definition.', where);
  if (process.platform !== 'linux') throw unsupported();
  const named = path.join(root, folderName);
  let folder = await confine(named, root);
  if (folder.state === 'gone' && folder.code === 'ENOENT' && !await present(named)) {
    await fs.mkdir(named).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    folder = await confine(named, root);
  }
  if (folder.state !== 'inside') throw outside();
  if (!(await fs.stat(folder.real)).isDirectory())
    throw createKanbanError('E_IO', folderName + ' in the project folder is not a folder; nothing was written.', where, 'Move it away, then export again.');
  const checked = folder.real;
  if (await present(path.join(checked, fileName))) throw exists();
  // The folder that passed the check, held open: from here on it is reached through the handle only.
  let dir: Awaited<ReturnType<typeof fs.open>>;
  try { dir = await fs.open(checked, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
  catch { throw outside(); }
  try {
    const via = '/proc/self/fd/' + dir.fd, held = await dir.stat();
    /** Where the open folder is now: 'same' only at the real path that was checked, inside the workspace, the same folder. */
    const placeOf = async (): Promise<'same' | 'moved' | 'none'> => {
      const place = await confine(via, root);
      if (place.state === 'gone') return 'none';
      if (place.state !== 'inside' || place.real !== checked) return 'moved';
      const now = await fs.stat(via).catch(() => null);
      return now && now.dev === held.dev && now.ino === held.ino ? 'same' : 'moved';
    };
    const before = await placeOf();
    if (before === 'none') throw unsupported();
    if (before !== 'same') throw outside();
    const tmpName = `.${fileName}.tmp-${randomUUID()}`, temporary = path.join(via, tmpName), published = path.join(via, fileName);
    let ours: Stats | null = null, linked = false, after: 'same' | 'moved' | 'none' = 'same', thrown: unknown = null;
    const mine = (s: Stats | null) => !!ours && !!s && s.dev === ours.dev && s.ino === ours.ino;
    try {
      try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 }); }
      catch (error) {
        // Made by us unless the name was taken (wx): a part-written file is still ours to take back.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') ours = await fs.lstat(temporary).catch(() => null);
        throw error;
      }
      ours = await fs.lstat(temporary);
      try { await fs.link(temporary, published); linked = true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (code === 'EEXIST') throw exists();
        if (NO_LINK.has(code)) throw unsupported();
        throw error;
      }
      after = await placeOf();
    } catch (error) { thrown = error; }
    // Taking back: the names that could not be cleared are said by full path below.
    const failed: string[] = [];
    if (linked && after !== 'same') {
      const aside = `.${fileName}.out-${randomUUID()}`, asidePath = path.join(via, aside);
      let moved = false;
      try { await fs.rename(published, asidePath); moved = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(fileName); }
      if (moved) {
        const s = await fs.lstat(asidePath).catch(() => null);
        if (mine(s)) await fs.unlink(asidePath).catch(() => { failed.push(aside); });
        else {
          // Someone else's file came to the public name: back to it, never over anything; else kept aside and said.
          let back = false;
          try { await fs.link(asidePath, published); back = true; } catch { failed.push(aside); }
          if (back) await fs.unlink(asidePath).catch(() => { failed.push(aside); });
        }
      }
    }
    if (ours) {
      // The temporary file, an unguessable name: removed only while it is still our file.
      let s: Stats | null = null, gone = false;
      try { s = await fs.lstat(temporary); } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      if (!gone && !s) failed.push(tmpName);
      else if (mine(s)) await fs.unlink(temporary).catch(() => { failed.push(tmpName); });
    }
    const at = await fs.realpath(via).catch(() => checked);
    const left = failed.map(name => path.join(at, name));
    if (thrown) {
      if (left.length && thrown && typeof thrown === 'object' && (thrown as { details?: unknown }).details == null)
        (thrown as { details: unknown }).details = { left };
      throw thrown;
    }
    if (after !== 'same') {
      const why = after === 'moved' ? folderName + ' was moved out of the workspace folder while the file was written'
        : 'the place of ' + folderName + ' could not be confirmed after the file was written';
      throw createKanbanError('E_OUTSIDE', why + (left.length ? '; the export was called off, but these could not be removed: ' + left.join(', ')
        : '; the export was called off and nothing was left behind.'), where,
        left.length ? 'Remove the files named here by hand.' : 'Move ' + folderName + ' back into the project folder, then export again.', { left });
    }
    return left.length ? { path: where, left } : { path: where };
  } finally { await dir.close().catch(() => undefined); }
}
