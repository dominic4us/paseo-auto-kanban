import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The one way into the message folder: every listing and every file read of REQ-90 (the lanes' badge and fingerprint,
 * server/mailbox.ts) and REQ-128 (the message list and a thread, server/mail-list.ts) goes through here. Reads only.
 *
 * - The root is the folder set in the lab, by its real path (resolved once, trusted). A thread is a real sub-folder of it
 *   and a message a regular file in a thread; paths are built from the root's real path.
 * - research/236 D3, research/240 D1: a check and a read are two moments — a folder swapped for a link between them would
 *   be followed (O_NOFOLLOW guards the last part only). So a file is opened without following a last-part link, and read
 *   only if, once opened, it is still the regular file at that very path (its real path unchanged, the same device and
 *   inode). A folder is listed only if it is the same real folder (not a link) before and after the listing.
 * - What fails those checks is a `MailBoundaryError`: nothing of it was read, and the thread it belongs to is left out
 *   of the badge, the fingerprint and the list alike. Other failures (a file gone meanwhile) read as a missing head.
 */
export class MailBoundaryError extends Error {}
export const isMailBoundary = (error: unknown) => error instanceof MailBoundaryError;

export interface MailHead { text: string; size: number; mtimeMs: number }
export interface MailEntry { name: string; directory: boolean; file: boolean }
export interface MailFsIo {
  realpath: (file: string) => Promise<string>;
  list: (dir: string) => Promise<MailEntry[]>;
  /** The first `bytes` of a regular file, with its size and modification time from the opened file itself. */
  head: (file: string, bytes: number) => Promise<MailHead>;
}

async function readHead(file: string, bytes: number): Promise<MailHead> {
  let handle: fs.FileHandle;
  // O_NONBLOCK: a pipe put in a file's place does not hold the reading.
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new MailBoundaryError('a link in a message\'s place');
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new MailBoundaryError('not a regular file');
    // What was opened must be the file this path names now — not one reached through a folder swapped for a link.
    let real: string, there: { dev: number; ino: number };
    try { real = await fs.realpath(file); there = await fs.stat(real); } catch { throw new MailBoundaryError('moved while read'); }
    if (real !== file || there.dev !== opened.dev || there.ino !== opened.ino) throw new MailBoundaryError('moved while read');
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), size: opened.size, mtimeMs: opened.mtimeMs };
  } finally { await handle.close(); }
}
export const realMailFsIo: MailFsIo = {
  realpath: file => fs.realpath(file),
  // `withFileTypes` says what the entry itself is: a link is neither a directory nor a file here, so it is never followed.
  list: async dir => {
    const before = await fs.lstat(dir), entries = await fs.readdir(dir, { withFileTypes: true }), after = await fs.lstat(dir);
    if (!before.isDirectory() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) throw new MailBoundaryError('moved while listed');
    return entries.map(e => ({ name: e.name, directory: e.isDirectory(), file: e.isFile() }));
  },
  head: readHead,
};

export interface MailRoot { real: string; shown: string }
const within = (root: string, real: string) => real === root || real.startsWith(root + path.sep);
/** The lab's folder: an absolute path, by its real path. */
export async function mailRoot(dir: string, io: MailFsIo): Promise<MailRoot | null> {
  if (!dir || !path.isAbsolute(dir)) return null;
  try { return { real: await io.realpath(dir), shown: dir }; } catch { return null; }
}
/** A thread folder by its listed name: directly inside the root, a real folder (not a link, not even to a sibling). Its real path, or null. */
export async function mailThreadFolder(root: MailRoot, raw: string, io: MailFsIo): Promise<string | null> {
  const at = path.join(root.real, raw);
  if (path.dirname(at) !== root.real) return null;
  try { const real = await io.realpath(at); return real === at && within(root.real, real) ? real : null; } catch { return null; }
}
