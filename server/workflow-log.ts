import type { WorkflowEventDTO, WorkflowModelDTO, WorkflowReleaseDTO } from '../shared/workflow.js';

/**
 * REQ-125 U4a (research/309 5판 2·3): reading a `state-log` record — text only, no file system (server/workflow.ts opens the file
 * once, through `openConfined`, and hands its text here).
 *
 * - Only a **pure tag line** confirms anything: in the record's own section (`## 건 기록`), a line `- YYYY-MM-DD: [건][행위]` or
 *   `- YYYY-MM-DD HH:MM KST: [건][행위]` with nothing after its tags but spaces and nothing under it but empty lines (2.2).
 * - Everything else in the section is read as no meaning at all — it only stops answers: no time, every 건, every step reading
 *   the section (2.4 E). A pure line names a 건 no row shows → every 건 (D″); a word no rule of its section has, a time later than
 *   the reading, a name a hidden item shares → that 건 (B, C, D).
 * - The section is found by its whole heading (one leading emoji or symbol group aside), never inside a fenced code block or an
 *   HTML comment, which are tracked from the top of the file (2.3, 312 R1). Line order is never time (2.5).
 * Every rule is a fixed pass over the lines: no regular expression with an open repeat that can backtrack runs on a line.
 */
type Event = WorkflowEventDTO;
type Stage = WorkflowModelDTO['definition']['stages'][number];
type Edge = WorkflowModelDTO['definition']['edges'][number];
export type LogNote = NonNullable<WorkflowModelDTO['logNotes']>[number];

export interface LogLine {
  /** 1-based, as an editor counts lines. */
  n: number; text: string; blank: boolean;
  /** A real heading (`#`~`######` at the very start of a line outside code and comments): its level and words. */
  heading: { level: number; text: string } | null;
  /** In a fenced code block (its fences too) — never a heading, never an item. */
  code: boolean;
  /** Some of the line is inside an HTML comment (it starts in one, or one opens on it). */
  comment: boolean;
  /** A heading-shaped line inside a comment (312 R1): said in `logNotes` when it names a section, never a section. */
  commentHeading: string | null;
}
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/, FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** Spaces and tabs off both ends, by a plain walk (a line may be 2 MB long: no pattern that backtracks over it). */
const trimSpaces = (s: string) => {
  let a = 0, b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return s.slice(a, b);
};
/** `#`~`######` at the very start, then a space, a tab or the end: its level and its words. Indented, it is no heading here. */
function headingOf(line: string): { level: number; text: string } | null {
  let level = 0;
  while (level < line.length && line[level] === '#') level++;
  if (level < 1 || level > 6 || (level < line.length && line[level] !== ' ' && line[level] !== '\t')) return null;
  return { level, text: trimSpaces(line.slice(level)) };
}
/** Whether a comment is still open at the end of `rest`, which starts inside one (`open`) or outside. */
function commentOpenAfter(rest: string, open: boolean): boolean {
  let at = 0;
  for (;;) {
    if (open) { const end = rest.indexOf('-->', at); if (end < 0) return true; at = end + 3; open = false; }
    const start = rest.indexOf('<!--', at);
    if (start < 0) return false;
    at = start + 4; open = true;
  }
}
/** The record's lines: a BOM at the very start and a `\r` at each end dropped, NFC, with each line's place among fences and comments. */
export function logLines(raw: string): LogLine[] {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const out: LogLine[] = [];
  let fence: { char: string; size: number } | null = null, comment = false;
  for (const [i, piece] of text.split('\n').entries()) {
    const line = (piece.endsWith('\r') ? piece.slice(0, -1) : piece).normalize('NFC');
    const item: LogLine = { n: i + 1, text: line, blank: line.trim() === '', heading: null, code: false, comment: false, commentHeading: null };
    out.push(item);
    if (fence) {
      // A fence closes with the same character, at least as many, and nothing after; never closed, it runs to the end.
      item.code = true;
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.size) fence = null;
      continue;
    }
    if (comment) {
      item.comment = true;
      item.commentHeading = headingOf(line)?.text ?? null;
      comment = commentOpenAfter(line, true);
      continue;
    }
    // A fence opens only outside a comment (a "```" inside one is the comment's words), and a "<!--" inside a fence is code.
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1]![0] === '`' && line.slice(open[0].length).includes('`'))) { fence = { char: open[1]![0]!, size: open[1]!.length }; item.code = true; continue; }
    item.heading = headingOf(line);
    if (line.includes('<!--')) { item.comment = true; comment = commentOpenAfter(line, false); }
  }
  return out;
}
/** One leading emoji or symbol group (`🔴 `, `★★ `) a heading may wear; its words are compared whole after it (2.3). */
const LEAD = /^[\p{Extended_Pictographic}\p{S}‍️⃣]+[ \t]*/u;
export function namesSection(heading: string, section: string): boolean {
  const title = trimSpaces(heading);
  return title === section || title.replace(LEAD, '') === section;
}
/** The section's ranges `[from, to)` (line indexes): after each heading named so, up to the next heading of the same or a higher level. */
export function sectionRanges(lines: readonly LogLine[], section: string): [number, number][] {
  const out: [number, number][] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.heading || !namesSection(line.heading.text, section)) continue;
    let end = i + 1;
    while (end < lines.length && !(lines[end]!.heading && lines[end]!.heading!.level <= line.heading.level)) end++;
    out.push([i + 1, end]);
  }
  return out;
}

// ---- the pure tag line (2.2) and its time (2.5) -----------------------------------------------------------------------------
export interface LogTime { day: string; minute?: number; text: string }
const TAG = /^- (\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}) KST)?: \[([^[\]\r\n]{1,40})\]\[([^[\]\r\n]{1,20})\][ \t]*$/u;
/** A pure tag line's day (on the calendar), minute (00:00~23:59, KST only), 건 and act; null for any other line. */
export function tagLine(line: string): { time: LogTime; name: string; word: string } | null {
  const m = TAG.exec(line);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])], day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  const dayText = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return { time: { day: dayText, text: dayText }, name: m[6]!, word: m[7]! };
  const [h, mi] = [Number(m[4]), Number(m[5])];
  if (h > 23 || mi > 59) return null;
  return { time: { day: dayText, minute: h * 60 + mi, text: `${dayText} ${m[4]}:${m[5]} KST` }, name: m[6]!, word: m[7]! };
}
/** "2026-10-01 17:00 KST" or "2026-10-01" (an event's `time`) back to a time; anything else is none. */
export function logTime(text: string | null | undefined): LogTime | null {
  const m = text?.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2}) KST)?$/);
  if (!m) return null;
  return m[2] === undefined ? { day: m[1]!, text: text! } : { day: m[1]!, minute: Number(m[2]) * 60 + Number(m[3]), text: text! };
}
/**
 * `a` is surely earlier than `b`: different days, or the same day with both minutes and `a`'s smaller. A day against a minute of
 * the same day, the same minute, the same day twice, or no time on either side cannot be told (2.5) — never by line order.
 */
export function surelyEarlier(a: LogTime | null, b: LogTime | null): boolean {
  if (!a || !b) return false;
  if (a.day !== b.day) return a.day < b.day;
  return a.minute !== undefined && b.minute !== undefined && a.minute < b.minute;
}
/** The reading's moment in KST: today's day and minute. */
export function kstNow(now: Date): LogTime {
  const k = new Date(now.getTime() + 9 * 3600e3), day = k.toISOString().slice(0, 10);
  return { day, minute: k.getUTCHours() * 60 + k.getUTCMinutes(), text: day };
}
/** Later than the reading (2.4 C): a day after today, or today at a minute after now. */
export const future = (t: LogTime, now: LogTime) => t.day > now.day || (t.day === now.day && t.minute !== undefined && t.minute > now.minute!);

// ---- an answer from the evidence (3.2) ------------------------------------------------------------------------------------
export interface Piece { strength: 'confirmed' | 'ambiguous'; answer?: 'yes' | 'no' | undefined; time: LogTime | null }
/**
 * A record cell from its evidence (not read in part — the caller says that first):
 * - none → `no-record`; no confirmed piece → `ambiguous`.
 * - The latest confirmed pieces are all those no other confirmed piece is surely later than (312 J2: kept as a set, never one
 *   picked by line or rule order). Two answers among them → `ambiguous`.
 * - Any piece but a confirmed one of that answer that is not surely earlier than **every** latest one → `ambiguous`; a piece with
 *   no time (writing that is no tag line) is never earlier. Else `found`, with the answer (a decision) — and the pieces that were
 *   surely earlier than every latest one and would have stood against it (`earlier`, said "앞선 근거").
 */
export function decide(pieces: readonly Piece[]): { state: 'no-record' | 'ambiguous' | 'found'; answer?: 'yes' | 'no'; earlier: number[] } {
  if (!pieces.length) return { state: 'no-record', earlier: [] };
  const confirmed = pieces.filter(p => p.strength === 'confirmed');
  if (!confirmed.length) return { state: 'ambiguous', earlier: [] };
  const latest = confirmed.filter(c => !confirmed.some(o => o !== c && surelyEarlier(c.time, o.time)));
  if (new Set(latest.map(c => c.answer)).size > 1) return { state: 'ambiguous', earlier: [] };
  const answer = latest[0]!.answer, agrees = (p: Piece) => p.strength === 'confirmed' && p.answer === answer;
  const before = (p: Piece) => latest.every(l => surelyEarlier(p.time, l.time));
  if (pieces.some(p => !agrees(p) && !before(p))) return { state: 'ambiguous', earlier: [] };
  return { state: 'found', ...(answer ? { answer } : {}), earlier: pieces.flatMap((p, i) => !agrees(p) && before(p) ? [i] : []) };
}

// ---- U4b: where a 건 ended (4.3) ----------------------------------------------------------------------------------------------
export type EndTag = NonNullable<WorkflowReleaseDTO['endTag']>;
/** One cell of a 건 as the end tag weighs it: its state, answer, and every event that counts in it (a record step's shared ones too). */
export interface TagCell { stage: string; state: string; answer?: 'yes' | 'no' | undefined; log: boolean;
  events: readonly Pick<Event, 'time' | 'days' | 'strength' | 'path' | 'line'>[] }
/**
 * REQ-125 U4b (research/309 4.3, 312 J6): a 건's end tag. An end step is a pill no line leaves with a decision's `when` branch
 * into it. Its founding evidence: its own record cell confirmed (ⓐ), a decision into it confirmed with that branch's answer (ⓑ).
 * Shown only when nothing disagrees — every decision into it is not ambiguous, not read in part and not answered another way, nor
 * is its own cell — no other cell of the 건 is read in part (J6), and every other event of the 건 (the founding cells' and the end
 * cell's aside) is surely earlier than the latest founding piece. An event with no day, or several days, can never be. Held
 * otherwise, with why — a decision whose answer has several lines (325-J3) too. Of several end steps the shown one, else the first held
 * one (in the drawing's order); none founded → none.
 */
export function endTag(stages: readonly Pick<Stage, 'id' | 'shape' | 'col' | 'row'>[], edges: readonly Pick<Edge, 'from' | 'to' | 'when' | 'back'>[],
  cells: readonly TagCell[]): EndTag | undefined {
  const cellOf = new Map(cells.map(c => [c.stage, c])), shape = new Map(stages.map(s => [s.id, s.shape]));
  const tags: EndTag[] = [];
  for (const s of [...stages].sort((a, b) => a.col - b.col || a.row - b.row)) {
    if (s.shape !== 'pill' || edges.some(e => e.from === s.id)) continue;
    const into = edges.filter(e => e.to === s.id && e.when);
    if (!into.length) continue;
    // Each decision with a branch into the end step, and the answers those branches stand for.
    const deciders = new Map<string, Set<string>>();
    for (const e of into) if (shape.get(e.from) === 'diamond') deciders.set(e.from, new Set([...deciders.get(e.from) ?? [], e.when!]));
    const end = cellOf.get(s.id), founding: TagCell[] = [];
    if (end?.log && end.state === 'found') founding.push(end);
    for (const [id, whens] of deciders) { const d = cellOf.get(id); if (d?.log && d.state === 'found' && d.answer && whens.has(d.answer)) founding.push(d); }
    if (!founding.length) continue;
    const tag = { stage: s.id, by: founding.map(c => c.stage) };
    const times = founding.flatMap(c => c.events.filter(e => e.strength === 'confirmed').map(e => logTime(e.time)).filter((t): t is LogTime => !!t));
    const latest = times.filter(t => !times.some(o => surelyEarlier(t, o)));
    const shown = latest.map(t => t.text).sort().at(-1);
    const held = (why: NonNullable<EndTag['held']>, at: string) => tags.push({ ...tag, ...(shown ? { time: shown } : {}), held: why, at });
    // 2: nothing disagrees — no decision into it unsettled or answered the other way, nor its own cell.
    const unsettled = (c: TagCell | undefined) => c?.state === 'ambiguous' || c?.state === 'incomplete';
    const against = [...deciders].find(([id, whens]) => { const d = cellOf.get(id); return unsettled(d) || (d?.state === 'found' && d.answer && !whens.has(d.answer)); })?.[0]
      ?? (unsettled(end) ? s.id : undefined);
    if (against) { held('disagree', against); continue; }
    // 325-J3: a decision whose confirmed answer has more than one line (to this end and another step) does not say where the 건
    // went — the flow draws neither (`chosenBranches`), and the tag waits too, whatever the drawing's order.
    const split = founding.find(c => c.answer && deciders.has(c.stage) && edges.filter(e => !e.back && e.from === c.stage && e.when === c.answer).length > 1);
    if (split) { held('branches', split.stage); continue; }
    // 312 J6: another cell read in part may hold what came after — no event there is no proof nothing happened.
    const partial = cells.find(c => c.state === 'incomplete');
    if (partial) { held('incomplete', partial.stage); continue; }
    if (!latest.length) { held('undated', s.id); continue; }
    // 4: every other event of the 건 surely earlier than every latest founding piece.
    const skip = new Set([s.id, ...founding.map(c => c.stage)]);
    let blocked = false;
    for (const c of cells) {
      if (skip.has(c.stage) || blocked) continue;
      for (const e of c.events) {
        const t = e.days !== undefined && e.days > 1 ? null : logTime(e.time), at = e.path + (e.line !== undefined ? ':' + e.line : '');
        if (!t) { held('undated', at); blocked = true; break; }
        if (!latest.every(l => surelyEarlier(t, l))) { held('later', at); blocked = true; break; }
      }
    }
    if (!blocked) tags.push({ ...tag, ...(shown ? { time: shown } : {}) });
  }
  return tags.find(t => !t.held) ?? tags[0];
}

// ---- one record file's lines into evidence (2.3·2.4) ------------------------------------------------------------------------
export interface LogRule { stage: string; section: string; words: Map<string, 'yes' | 'no' | null> }
/**
 * The 건 names a tag is matched with (2.4 「이름 맞추기」), all NFC: `shown` — a row's final shown name → its id; `shownNames` and
 * `shownStripped` — the rows' folder names and number-stripped names; `hidden` and `hiddenStripped` — the same of every folder the
 * list did not show (a link, two names one in NFC, hidden, excluded, past the 200).
 */
export interface LogNames { shown: Map<string, string>; shownNames: Set<string>; shownStripped: Set<string>; hidden: Set<string>; hiddenStripped: Set<string> }
/** The reply's own limit for a record excerpt (shared/workflow.ts `excerpt`, counted as the schema counts: UTF-16 units). */
export const EXCERPT_UNITS = 300;
const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/**
 * 317-F1: `text` within `max` UTF-16 units — the unit every reply limit is checked in (zod's `max` counts `length`) — cut only
 * between graphemes (an emoji's surrogate pair, a flag, a ZWJ sequence, a letter and its combining marks stay whole), "…" when
 * cut. Before, a record excerpt was cut at 300 code points: one emoji made it 301 units, the reply was refused, and the screen kept
 * the answer it had. Walks the segments only until full, so a 2 MB line costs what the excerpt costs.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const { segment } of graphemes ? graphemes.segment(text) : Array.from(text, segment => ({ segment }))) {
    if (out.length + segment.length > max - 1) break;
    out += segment;
  }
  return out + '…';
}
const clipLine = (text: string) => clipText(text.trim(), EXCERPT_UNITS);
/**
 * A record file's evidence for the rules reading it (`rules`, all of them, in any order): `own` — a shown 건's pieces (`release` its
 * id), `shared` — the pieces standing in every 건 (`scope: 'all'`), `notes` for the heading. One piece per line and step at most.
 */
export function readRecord(file: string, text: string, rules: readonly LogRule[], names: LogNames, now: LogTime):
  { own: Event[]; shared: Event[]; notes: LogNote[] } {
  const lines = logLines(text);
  const sections = [...new Set(rules.map(r => r.section))].sort();
  const ranges = new Map(sections.map(s => [s, sectionRanges(lines, s)]));
  const inside = (s: string, i: number) => ranges.get(s)!.some(([a, b]) => i >= a && i < b);
  const own = new Map<string, Event>(), shared = new Map<string, Event>(), notes: LogNote[] = [];
  const put = (map: Map<string, Event>, e: Event) => { const at = e.line + '\0' + e.stage + '\0' + (e.release ?? ''); if (!map.has(at)) map.set(at, e); };
  const base = (stage: string, line: LogLine, section: string): Event =>
    ({ stage, kind: 'log', release: null, releaseFrom: null, path: file, line: line.n, excerpt: clipLine(line.text), section });
  const others = new Map<string, number[]>();
  for (const section of sections) {
    // The steps reading this section, and (312 R2) for each line the rules whose own section holds it.
    const reading = [...new Set(rules.filter(r => r.section === section).map(r => r.stage))];
    const commented = lines.filter(l => l.commentHeading !== null && namesSection(l.commentHeading, section)).map(l => l.n);
    if (commented.length) notes.push({ kind: 'section-in-comment', path: file, section, lines: commented.slice(0, 20) });
    if (!ranges.get(section)!.length) { notes.push({ kind: 'no-section', path: file, section }); continue; }
    const wrong: number[] = [];
    for (const [from, to] of ranges.get(section)!) {
      // Items: a line starting "- " at its very start (not in code or a comment) and every line up to the next such line or the
      // section's end. Lines before the first item are writing of their own.
      const items: { start: number | null; rest: number[] }[] = [{ start: null, rest: [] }];
      for (let i = from; i < to; i++) {
        const line = lines[i]!;
        if (!line.code && !line.comment && line.text.startsWith('- ')) items.push({ start: i, rest: [] });
        else items.at(-1)!.rest.push(i);
      }
      for (const item of items) {
        const first = item.start ?? item.rest.find(i => !lines[i]!.blank);
        if (first === undefined) continue;
        const head = item.start !== null ? tagLine(lines[item.start]!.text) : null, under = item.rest.find(i => !lines[i]!.blank);
        const tag = under === undefined ? head : null;
        // The line to fix: what hangs under a pure head (a memo, a sub-line), else the item's own line or the first writing.
        const line = lines[head && under !== undefined ? under : first]!;
        if (!tag) {
          // E: no time, every 건, every step reading this section (2.4).
          wrong.push(line.n);
          for (const stage of reading) put(shared, { ...base(stage, line, section), strength: 'ambiguous', why: 'not-a-tag-line', scope: 'all' });
          continue;
        }
        const applying = rules.filter(r => inside(r.section, first));
        const steps = [...new Set(applying.map(r => r.stage))];
        const timed = { time: tag.time.text, word: tag.word };
        const id = names.shown.get(tag.name);
        if (id === undefined) {
          // D′: the exact folder name of an item no row shows, and no shown 건's folder or stripped name — left to that item.
          if (names.hidden.has(tag.name) && !names.shownNames.has(tag.name) && !names.shownStripped.has(tag.name)) {
            others.set(tag.name, [...others.get(tag.name) ?? [], line.n]); continue;
          }
          // D″: a name no row shows (a typo, an old folder name) or one only a number-stripped name fits — never an alias.
          const why = names.shownStripped.has(tag.name) || names.hiddenStripped.has(tag.name) ? 'stripped-name' as const : 'unknown-instance' as const;
          for (const stage of steps) put(shared, { ...base(stage, line, section), ...timed, strength: 'ambiguous', why, scope: 'all' });
          continue;
        }
        const mine = (stage: string, extra: Partial<Event>) => put(own, { ...base(stage, line, section), release: id, ...timed, ...extra });
        // D: a shown name that a folder no row shows shares (its name or its number-stripped name) — whose record is not sure.
        if (names.hidden.has(tag.name) || names.hiddenStripped.has(tag.name)) { for (const stage of steps) mine(stage, { strength: 'ambiguous', why: 'hidden-overlap' }); continue; }
        const rule = applying.find(r => r.words.has(tag.word));
        // B: no rule of this line's sections has the word — a typo, or another section's word (312 R2): every step reading here.
        if (!rule) { for (const stage of steps) mine(stage, { strength: 'ambiguous', why: 'unknown-word' }); continue; }
        const answer = rule.words.get(tag.word);
        // C: later than the reading.
        if (future(tag.time, now)) { mine(rule.stage, { strength: 'ambiguous', why: 'future' }); continue; }
        mine(rule.stage, { strength: 'confirmed', ...(answer ? { answer } : {}) });
      }
    }
    if (wrong.length) notes.push({ kind: 'not-a-tag-line', path: file, section, count: new Set(wrong).size, lines: [...new Set(wrong)].sort((a, b) => a - b).slice(0, 20) });
  }
  for (const [name, at] of [...others].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    notes.push({ kind: 'other-item', path: file, name, lines: [...new Set(at)].sort((a, b) => a - b).slice(0, 20) });
  const order = (a: Event, b: Event) => (a.line ?? 0) - (b.line ?? 0) || (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0)
    || ((a.release ?? '') < (b.release ?? '') ? -1 : (a.release ?? '') > (b.release ?? '') ? 1 : 0);
  return { own: [...own.values()].sort(order), shared: [...shared.values()].sort(order), notes };
}
