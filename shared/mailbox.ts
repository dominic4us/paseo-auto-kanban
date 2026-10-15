import type { MailAliasRule, MailDTO } from './rpc.js';

/**
 * REQ-90: the lab's "messages waiting" badge, the parts both sides share. Pure: no file access (server/mailbox.ts reads the
 * folder), no React (client/mail-badge.tsx draws the badge).
 *
 * The message folder holds one sub-folder per thread; whose turn a thread is sits in its newest file (the last by name), in
 * the head line `받는 곳: <short name | a person (기록: <short name>) | 없음>`. A lane counts the open threads whose line names
 * exactly its workspace's short name — a question relayed to a person ("… (기록: X)") is the person's turn, not X's.
 */
export const MAIL_TO_LINE = '받는 곳:';
/** A thread whose newest file is its close is over and never counted. */
export const MAIL_CLOSE_SUFFIX = '_종결.md';
/** Only this much of a file's start is read for its head lines. */
export const MAIL_HEAD_BYTES = 4096;
/** NFC where the engine has it (a NAS may keep names decomposed); a phone's engine without it compares as given. */
export const nfc = (text: string) => typeof text.normalize === 'function' ? text.normalize('NFC') : text;

/** Who a thread file waits for: the text after the first `받는 곳:` line, or null when there is none (a format we do not know). */
export function mailRecipient(text: string): string | null {
  for (const line of nfc(text).slice(0, MAIL_HEAD_BYTES).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(MAIL_TO_LINE)) continue;
    const value = trimmed.slice(MAIL_TO_LINE.length).trim();
    return value || null;
  }
  return null;
}
/** A file name that closes its thread. Names are compared in NFC, as a NAS may store them decomposed. */
export const isMailClose = (name: string) => nfc(name).endsWith(MAIL_CLOSE_SUFFIX);

/**
 * A workspace's short name from its folder: the last folder's name, without its spaces (`compact`, the default) or as it
 * is (`folder`). A trailing slash is ignored; an empty result matches nothing.
 */
export function mailAlias(cwd: string, rule: MailAliasRule = 'compact'): string {
  const last = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const name = nfc(last).trim();
  return rule === 'folder' ? name : name.replace(/\s+/g, '');
}
/** The open threads waiting for this short name, in thread order. */
export function laneMail(mail: MailDTO | undefined, alias: string): MailDTO['threads'] {
  return mail && alias ? mail.threads.filter(thread => thread.to === alias) : [];
}
