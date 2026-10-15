import type { MailDTO } from '../shared/rpc.js';
import type { Copy } from './i18n.js';
import { scaled } from './ui-scale.js';

/**
 * REQ-90: what the "messages waiting" badge's tip says, and how tall it will be. Pure: no React, no SDK.
 * research/179 D1: the tip is placed (below the badge, or above it near the bottom of the board) before it is drawn, from
 * this height. The old guess (22 + 30 a thread) left out that a newest file's path wraps onto two or three lines of a
 * 300px phone tip, so a tip that did not fit below was still hung there.
 */
export function mailTipText(threads: MailDTO['threads'], unknown: number, alias: string, m: Copy): string {
  return [m.mailTipTitle(alias, threads.length), ...threads.map(t => '· ' + t.thread + '\n  ' + t.file),
    ...(unknown ? [m.mailUnknown(unknown)] : [])].join('\n');
}
/** The tip's box around its words (components.tsx `Tip`): 8px each side, a 1px line, and (22 - 2 - lineHeight) / 2 above and below. */
export const MAIL_TIP = scaled({ font: 11, lineHeight: 15, padding: 8, border: 1, minHeight: 22 } as const, ['border']);
function wide(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x1100 && code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3
    || code >= 0xf900 && code <= 0xfaff || code >= 0xfe30 && code <= 0xfe4f || code >= 0xff00 && code <= 0xff60 || code >= 0x20000;
}
/** About how wide a character of the 11px tip font is: a Latin letter, digit or mark about 0.56em, Hangul, kana and CJK a whole one. */
function charWidth(ch: string): number { return MAIL_TIP.font * (wide(ch) ? 1 : 0.56); }
/**
 * Where a line may wrap, as the browser's line breaking does in a path (measured in Chromium, research/180): after a space
 * or a "-", after a "/" unless a digit follows, and on either side of a Hangul or CJK character. "_" never breaks.
 */
function pieces(line: string): string[] {
  const out: string[] = [], chars = [...line];
  let piece = '';
  chars.forEach((ch, i) => {
    const next = chars[i + 1];
    piece += ch;
    if (next === undefined) return;
    if (ch === ' ' || ch === '-' || ch === '/' && !/[0-9]/.test(next) || wide(ch) || wide(next)) { out.push(piece); piece = ''; }
  });
  return piece ? [...out, piece] : out;
}
/** How many lines one line of the tip takes at `room` px: pieces while they fit, one longer than a line broken anywhere. */
export function wrappedLines(line: string, room: number): number {
  let lines = 1, used = 0;
  for (const piece of pieces(line)) {
    const width = [...piece].reduce((sum, ch) => sum + charWidth(ch), 0);
    if (used + width <= room) { used += width; continue; }
    if (used > 0 && piece.trim()) { lines++; used = 0; }
    for (const ch of piece) {
      const w = charWidth(ch);
      if (used + w > room && used > 0) { lines++; used = 0; }
      used += w;
    }
  }
  return lines;
}
/** The tip's height at `width` (300 on a phone, 420 on the wide board). */
export function mailTipHeight(text: string, width: number): number {
  const room = width - 2 * (MAIL_TIP.padding + MAIL_TIP.border);
  const lines = text.split('\n').reduce((sum, line) => sum + wrappedLines(line, room), 0);
  return Math.max(MAIL_TIP.minHeight, lines * MAIL_TIP.lineHeight + (MAIL_TIP.minHeight - 2 - MAIL_TIP.lineHeight) + 2);
}
