import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';

/**
 * D61: what a write needs of the file system on every host the plugin runs on. Windows has neither flag: Node leaves
 * them undefined there, so they are 0 rather than silently so (research/406_D61_Windows_fsync).
 */
export const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
/**
 * D61: Node flushes a handle on Windows with FlushFileBuffers, which needs write access — a folder (always opened for
 * reading) and a file opened read-only are refused with EPERM, so no folder is flushed there and a file is flushed
 * through a handle opened for writing. NTFS journals the folder entry a rename makes, so the rename is as lasting there
 * as it gets without one. Elsewhere a folder flush is made as before, and one that fails fails the write (research/407 F2).
 */
export const isWindows = () => process.platform === 'win32';
/** The access a file is opened with only to be flushed: read-only as before, but for writing on Windows. */
export const flushAccess = () => isWindows() ? constants.O_RDWR : constants.O_RDONLY;
/**
 * D61: replacing a file on Windows (MoveFileEx) is refused with EPERM, EACCES or EBUSY while another program — a virus
 * scanner, an indexer, an editor — holds the target for a moment. There the rename is tried again for under a second;
 * on every other host it is one rename, as before. Only for files of the data folder that the plugin alone writes: a file
 * a person may edit (PROCESS.md) is never retried, since a retry would replace an edit made meanwhile (research/407 F1).
 */
const HELD = new Set(['EPERM', 'EACCES', 'EBUSY']);
export async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (!isWindows() || !HELD.has((error as NodeJS.ErrnoException)?.code ?? '') || attempt >= 7) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, 10 * 2 ** attempt)));
    }
  }
}
