import type { BoardDTO } from '../shared/rpc.js';
import type { CellState, Verdict, WorkflowEventDTO, WorkflowModelDTO, WorkflowReleaseDTO, WorkflowTally } from '../shared/workflow.js';
import { textWidth } from './layout.js';
import { px, scaled } from './ui-scale.js';

/**
 * REQ-124 2단위 (research/215·216·217): a lane's "Workflow" — its workspace's procedure drawn left to right (the steps of
 * `.kanban/workflow.json`, straight-angled lines, a diamond for a decision, the loops that went back) with the way the
 * chosen release went over it, and a release × step table of what the documents say. It replaces REQ-103 2단계-1's
 * read-only "Big picture" (the board already said all of that). Everything here comes from the server's reading
 * (`kanban.v1.workflow.get`, shared/workflow.ts); nothing is stored or inferred. Pure: no React, no SDK.
 */

/** A lane offers "Board | Workflow" only when its workspace folder holds a definition (the overview's `summary.workflow`). */
export function offersWorkflow(board: Pick<BoardDTO, 'summary'>): boolean {
  return board.summary.workflow === true;
}
/**
 * REQ-125: a pick just saved from this screen, by board id — a built-in's id, or `null` for one just taken out — laid over
 * the board's summary until the next reading says the same (`settlePicks`), so the lane turns at once. REQ-125 2단계:
 * `EXPORTED_PICK` for one just written into the project folder — the lane keeps its workflow, now the file's.
 */
export type PickOverrides = Record<string, string | null>;
/** REQ-125 2단계: the override (and `onPickChange` value) for a pick just exported; settled once the summary says "a file, no pick". */
export const EXPORTED_PICK = '';
/** REQ-125: what a lane's heading offers — its workflow (a definition file, or a built-in it is trying), or "Try a workflow". */
export function laneOffer(summary: { workflow?: true | undefined; workflowPick?: string | undefined }, override: string | null | undefined): 'workflow' | 'try' {
  if (override === undefined) return summary.workflow ? 'workflow' : 'try';
  if (override === null) return summary.workflow && !summary.workflowPick ? 'workflow' : 'try';
  return 'workflow';
}
/** REQ-125: the overrides the summaries do not say yet; the same object when none has settled. */
export function settlePicks(overrides: PickOverrides, summaries: readonly { id: string; workflow?: true | undefined; workflowPick?: string | undefined }[]): PickOverrides {
  let next: PickOverrides | null = null;
  for (const summary of summaries) {
    if (!(summary.id in overrides)) continue;
    const want = overrides[summary.id];
    if ((want === null && !summary.workflowPick) || (want === EXPORTED_PICK && summary.workflow && !summary.workflowPick)
      || (want !== null && want !== EXPORTED_PICK && summary.workflowPick === want)) {
      next ??= { ...overrides };
      delete next[summary.id];
    }
  }
  return next ?? overrides;
}
/** Which lanes show their workflow, by board id — kept for the session only (`useSessionValue`), never written. */
export type LaneViews = Record<string, 'workflow'>;
export function toggleLaneView(views: LaneViews, boardId: string, workflow: boolean): LaneViews {
  const { [boardId]: _, ...rest } = views;
  return workflow ? { ...rest, [boardId]: 'workflow' } : rest;
}
/** The words the screen needs from the copy (client/i18n.ts). */
export interface WorkflowWords {
  verdict: Record<Verdict, string>; stateNoRecord: string; stateNoSource: string; stateUnknown: string; titleUnread: string;
  statePerson: string; firstRound: string; countFound: (n: number) => string; loopNone: string; loopTimes: (label: string, n: number) => string;
  timesShort: (n: number) => string; resultNotOk: string; resultMissing: string;
  /** REQ-125 U1: a 건's cells — "자료 있음", the three grades, and a step's figure (how many 건 hold data). */
  dataThere: string; stateCandidate: string; stateAmbiguous: (n: number) => string; stateIncomplete: string; countInstances: (n: number) => string;
  /** REQ-125 U2: a document's versions — "관측된 첫 판", "이전 판은 이 폴더에 없음", "다음 판 N개 관측", "관측된 판 N개", "날짜 여러 개". */
  versionFirst: string; versionNoEarlier: string; versionNext: (n: number) => string; versionsSeen: (n: number) => string; daysMany: string;
  /** REQ-125 U3: "공통" — a program step's chip on the flow and the band's row name. */
  programName: string;
  /** U3 311-F2: "규칙 충돌 N" after a 건 cell whose files a common rule took. */
  conflicts?: (n: number) => string;
  /** REQ-125 U4a: a decision's answers ("예", "아니오") and the record a confirmed cell rests on ("「건 기록」 기준"). */
  answerYes?: string; answerNo?: string; logBasis?: (section: string) => string;
}
/**
 * REQ-125 U1 302-J1 · 303-F5: folders that file systems, NAS boxes and desktops make by themselves in every shared folder —
 * never a 건 someone made. Only a hidden-named (`.`, `@`, `#`) folder can be one: the 건 list leaves those out as `hidden`, so a
 * name here is quietly left out of the screen's "제외 N" too. research/301 「303 후속 수정」 lists where each comes from.
 * Windows' `$RECYCLE.BIN` and `System Volume Information` start with no hidden mark: a `/2` reading takes them as 건 like any
 * folder, so this screen list cannot (and does not) touch them.
 */
export const SYSTEM_HELPER_NAMES: ReadonlySet<string> = new Set([
  // A NAS (its own folders): per-folder metadata and thumbnails, a share's recycle bin, a share's snapshots, temporary files
  '@eaDir', '#recycle', '#snapshot', '@tmp', '@sharebin',
  // Another NAS: recycle bin, snapshots, thumbnails
  '@Recycle', '@Recently-Snapshot', '.@__thumb', '.@__qini',
  // macOS: Spotlight index, Trash on a volume, file-system events, temporary items, versions, AppleShare double/database folders
  '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', '.DocumentRevisions-V100', '.AppleDouble', '.AppleDB', '.AppleDesktop',
]);
/** A system helper's name: one of `SYSTEM_HELPER_NAMES`, or a Linux desktop's per-user Trash on a volume (`.Trash-1000`). */
export const systemHelper = (name: string): boolean => SYSTEM_HELPER_NAMES.has(name) || /^\.Trash-\d+$/.test(name);
/**
 * The folders the screen counts as "제외 N" (and lists with their reason): every left-out folder — links, NFC collisions, outside,
 * unknown kind, and hidden, `@` or `#` names someone made (`@고객과제`, `#긴급건`) — but a system helper's (`systemHelper`),
 * which would show "제외 1" in every folder on such a NAS. The reading keeps every one with its reason; a screen policy only, what a
 * `/2` file means does not change.
 */
export function shownExcluded(model: { excluded?: readonly { path: string; why: string }[] | undefined }): { path: string; why: string }[] {
  return (model.excluded ?? []).filter(x => !(x.why === 'hidden' && systemHelper(x.path.split('/').at(-1) ?? '')));
}
/** REQ-125 U1: the rows are 건 (a `/2` reading), not releases. */
export const byInstance = (model: { unit?: 'instance' | undefined }): boolean => model.unit === 'instance';
/** A 건's name cut to `most` characters (whole characters, never half a pair) with "…"; the whole name goes in its label. */
export function instanceChip(label: string, most: number): string {
  const chars = Array.from(label);
  return chars.length > most ? chars.slice(0, most).join('') + '…' : label;
}

/**
 * REQ-125 U3 (research/290 2.4·3): the steps of `scope: "program"` rules — common to every 건, in no row and no table column.
 */
export function programStages(model: { program?: WorkflowModelDTO['program'] | undefined }): Set<string> {
  return new Set(model.program?.cells.map(c => c.stage) ?? []);
}
/** The program's cells as a row of their own (the band's chips, their evidence): no 건's — its id is '' (a 건's id is a path, never empty). */
export const PROGRAM_ROW = '';
export function programRow(model: { program?: WorkflowModelDTO['program'] | undefined }, label: string): WorkflowReleaseDTO | undefined {
  return model.program ? { release: PROGRAM_ROW, label, reqs: [], firstVerdict: null, finalVerdict: null, regates: 0, cells: model.program.cells, path: [], warnings: [] } : undefined;
}
/**
 * A 건 with the program's cells laid in (U3): the flow and the phone's ladder say a program step inside its node whichever 건 is
 * chosen — the server already puts a program step with data on every 건's way.
 */
export function withProgram(model: { program?: WorkflowModelDTO['program'] | undefined }, release: WorkflowReleaseDTO | undefined): WorkflowReleaseDTO | undefined {
  return release && model.program ? { ...release, cells: [...release.cells, ...model.program.cells] } : release;
}
/** A program step's chip in the band: its cell in words, and how many things it found inside a 건 folder ("규칙 충돌 1"). */
export function programConflicts(model: { program?: WorkflowModelDTO['program'] | undefined }, stage: string): string[] {
  return (model.program?.conflicts ?? []).filter(c => c.stage === stage).map(c => c.path);
}

type Definition = WorkflowModelDTO['definition'];
export type WorkflowStage = Definition['stages'][number];
export type WorkflowEdge = Definition['edges'][number];

// ---- the drawing -------------------------------------------------------------------------------------------------
/**
 * The flow's measures. research/216: a node's label is 12.5px, a note line (the chosen release's verdict, "No record") 11px;
 * `gap` is the room between rows for the count chips and the loop lines. A column never gets narrower than `minCol`
 * (then the flow scrolls sideways) and a node never wider than `maxNodeW`. REQ-127: on the board screen (a whole window wide) a
 * column is at most `wideCol`, so its steps are not strung out along long lines; the flow is centred in what is left.
 */
export const FLOW = scaled({ pad: 20, top: 36, gap: 56, chipH: 18, chipLine: 14, nodeH: 44, labelLine: 16, noteLine: 14, nodePad: 12, diamond: 56, minCol: 104, maxNodeW: 124, wideCol: 220,
  line: 2, hot: 4, arrow: 6, loopGap: 7, label: 12.5, note: 11, bottom: 34 } as const, ['line', 'hot']);
export interface FlowNode { stage: WorkflowStage; cx: number; cy: number; w: number; h: number; left: number; right: number; top: number; bottom: number;
  /** The label's lines, and the note's, each a line of its own (216: at ten columns "301 불통과 → 통과" was cut). */
  labelLines: number; note: string[];
  /**
   * REQ-125 U3 313-F3 (`segmented`, a 건's flow): the note's lines grouped by part, each drawn as one text — so a 건 cell's words
   * ("기록 없음 · 규칙 충돌 1") read as one, as in the table. Absent for releases (`/1`), whose lines stay one text each.
   */
  noteBlocks?: string[][];
  /** 314-F4: how many screen lines each of `noteBlocks` takes — a line wider than the node (a word without spaces) takes as many as it fills. */
  noteBlockLines?: number[];
  /** The step's count chip (`stageCounts`), one line or two when the column is narrow; its top. */
  chip: string[]; chipTop: number }
export interface FlowLayout { cols: number; rows: number; colW: number; nodeW: number; width: number; height: number; at: Map<string, FlowNode> }
/** Words laid in lines no wider than `room` at font `size` (a word longer than that keeps a line of its own). */
export function wrapWords(text: string, room: number, size: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    const last = lines.at(-1);
    if (last !== undefined && textWidth(last + ' ' + word, size) <= room) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word);
  }
  return lines;
}
/**
 * REQ-125 U3 313-F3: a 건 cell's words in lines no wider than `room`, broken at " · " first — each piece whole on its line,
 * the " ·" left at the end of the line before — and only a piece too long for a line by its words (`wrapWords`).
 */
export function wrapNote(text: string, room: number, size: number): string[] {
  const lines: string[] = [];
  for (const piece of text.split(' · ')) {
    const last = lines.at(-1);
    if (last !== undefined && textWidth(last + ' · ' + piece, size) <= room) { lines[lines.length - 1] = last + ' · ' + piece; continue; }
    if (last !== undefined) lines[lines.length - 1] = last + ' ·';
    lines.push(...(textWidth(piece, size) <= room ? [piece] : wrapWords(piece, room, size)));
  }
  return lines;
}
/**
 * 314-F4: the screen lines one note line takes in a node whose words have `room`: one, or for a line wider than that (a word
 * without spaces, which the screen breaks anywhere) as many as it fills — measured with a little less room, never short.
 */
export function noteLineCount(line: string, room: number): number {
  const width = textWidth(line, FLOW.note);
  return width <= room ? 1 : Math.ceil(width / Math.max(1, room - px(8)));
}
/** 314-F4: lines grouped into texts — a line wider than `room` (a word without spaces) closes its text, so the next starts on its own. */
export function noteBlocksOf(lines: readonly string[], room: number): string[][] {
  const blocks: string[][] = [[]];
  for (const line of lines) {
    blocks.at(-1)!.push(line);
    if (textWidth(line, FLOW.note) > room) blocks.push([]);
  }
  return blocks.filter(b => b.length);
}
/** A count chip's lines: one when it fits the column, else its " · " parts in two lines as even as they go. */
export function chipLines(text: string, colW: number): string[] {
  if (textWidth(text, FLOW.note) <= colW - px(20)) return [text];
  const parts = text.split(' · ');
  if (parts.length < 2) return [text];
  const halves = parts.slice(1).map((_, i) => [parts.slice(0, i + 1).join(' · '), parts.slice(i + 1).join(' · ')]);
  const widest = (pair: string[]) => Math.max(...pair.map(v => textWidth(v, FLOW.note)));
  return halves.reduce((best, pair) => widest(pair) < widest(best) ? pair : best);
}
/**
 * Places every stage on its row and column. The note of a node (the chosen release's facts, `flowOverlay`) takes one line
 * when it fits the node's width, else one line per part, and a part too long for one line two — the node grows to hold it
 * and its row with it, so nothing is cut. `maxCol` (REQ-127, the board screen) caps a column; a capped flow is centred.
 * `segmented` (REQ-125 U3 313-F3, a 건's flow): a part too long for one line breaks at its " · " first (`wrapNote`), so
 * "규칙 충돌 1" never splits over two lines, and its lines come grouped (`noteBlocks`) — one text per part, so a part the
 * screen lays wider than measured (a long name without spaces) is cut short in its own lines, never pushing the next part out.
 * 314-F4: a line wider than the node (a long name without spaces, which the screen lays over more lines than measured) ends
 * its text (`noteBlocksOf`): that text is cut short with an ellipsis in its own lines, and what follows — "규칙 충돌 1" — keeps
 * its own line, in the table's order.
 */
export function flowLayout(stages: readonly WorkflowStage[], width: number, notes: Record<string, string[]> = {}, counts: Record<string, string> = {},
  maxCol = Infinity, segmented = false): FlowLayout {
  const cols = Math.max(...stages.map(s => s.col)) + 1, rows = Math.max(...stages.map(s => s.row)) + 1;
  const fit = Math.floor((width - FLOW.pad * 2) / cols), colW = Math.max(FLOW.minCol, Math.min(maxCol, fit));
  // Uncapped, the flow starts at the pad as on the lane (unchanged there); capped, it keeps as much room on either side.
  const inset = colW < fit ? Math.floor((width - cols * colW) / 2) : FLOW.pad;
  const nodeW = Math.min(FLOW.maxNodeW, colW - px(22)), room = nodeW - px(10);
  const sized = stages.map(stage => {
    const chip = counts[stage.id] ? chipLines(counts[stage.id]!, colW) : [];
    if (stage.shape === 'diamond') return { stage, w: FLOW.diamond, h: FLOW.diamond, labelLines: 1, note: [], chip };
    const parts = notes[stage.id] ?? [], joined = parts.join(' ');
    const blocks = !parts.length ? [] : textWidth(joined, FLOW.note) <= room ? [[joined]]
      : parts.flatMap(part => segmented ? noteBlocksOf(wrapNote(part, room, FLOW.note), room) : [wrapWords(part, room, FLOW.note)]);
    const note = blocks.flat();
    // 314-F4: a 건's line wider than the node is laid over more screen lines — the node grows for them, so nothing is cut.
    const blockLines = blocks.map(block => block.reduce((n, line) => n + (segmented ? noteLineCount(line, room) : 1), 0));
    const noteLines = blockLines.reduce((a, b) => a + b, 0);
    const labelLines = textWidth(stage.label, FLOW.label) > room ? 2 : 1;
    return { stage, w: nodeW, h: Math.max(FLOW.nodeH, FLOW.nodePad + labelLines * FLOW.labelLine + noteLines * FLOW.noteLine), labelLines, note, chip,
      ...(segmented ? { noteBlocks: blocks, noteBlockLines: blockLines } : {}) };
  });
  const chipRoom = (lines: number) => lines ? FLOW.chipH + (lines - 1) * FLOW.chipLine : 0;
  // The first row's chips hang over it, the others' under them: a two-line chip takes room above the first row or below the last.
  const over = Math.max(0, ...sized.filter(n => n.stage.row === 0).map(n => chipRoom(n.chip.length) - FLOW.chipH));
  const under = Math.max(0, ...sized.filter(n => n.stage.row === rows - 1 && rows > 1).map(n => chipRoom(n.chip.length) - FLOW.chipH));
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(FLOW.nodeH, ...sized.filter(n => n.stage.row === r).map(n => n.h)));
  const rowY = rowH.map((_, r) => FLOW.top + over + rowH.slice(0, r).reduce((y, h) => y + h + FLOW.gap, 0));
  const at = new Map(sized.map(n => {
    const cx = inset + n.stage.col * colW + colW / 2, cy = rowY[n.stage.row]! + rowH[n.stage.row]! / 2;
    const top = cy - n.h / 2, bottom = cy + n.h / 2;
    return [n.stage.id, { ...n, cx, cy, left: cx - n.w / 2, right: cx + n.w / 2, top, bottom,
      chipTop: n.stage.row > 0 ? bottom + px(5) : top - px(6) - chipRoom(n.chip.length) }] as const;
  }));
  return { cols, rows, colW, nodeW, at, width: Math.max(width, FLOW.pad * 2 + cols * colW),
    height: rowY.at(-1)! + rowH.at(-1)! + FLOW.bottom + under };
}
export interface Segment { x1: number; y1: number; x2: number; y2: number }
/**
 * A straight-angled route: the same row is one horizontal line (a line going back along its row detours under it, so it
 * never runs through the steps between), the same column one vertical line; going up (a loop back, or a step after a
 * lower one) runs sideways first, then up; going down runs down first, then sideways. `offset` moves a loop's line aside.
 */
export function route(a: FlowNode, b: FlowNode, back: boolean, offset = 0, under = 0): Segment[] {
  if (a.stage.row === b.stage.row) {
    if (!back && a.cx < b.cx) return [{ x1: a.right, y1: a.cy, x2: b.left, y2: b.cy }];
    const y = under + px(16) + offset;
    return [{ x1: a.cx + offset, y1: a.bottom, x2: a.cx + offset, y2: y }, { x1: a.cx + offset, y1: y, x2: b.cx - offset, y2: y },
      { x1: b.cx - offset, y1: y, x2: b.cx - offset, y2: b.bottom }];
  }
  if (a.stage.col === b.stage.col) return a.cy < b.cy ? [{ x1: a.cx, y1: a.bottom, x2: b.cx, y2: b.top }] : [{ x1: a.cx, y1: a.top, x2: b.cx, y2: b.bottom }];
  if (back || a.stage.row > b.stage.row) {
    const y = a.cy + offset, x = b.cx - offset, side = b.cx < a.cx ? a.left : a.right;
    return [{ x1: side, y1: y, x2: x, y2: y }, { x1: x, y1: y, x2: x, y2: b.bottom }];
  }
  const into = b.cx > a.cx ? b.left : b.right;
  return [{ x1: a.cx, y1: a.bottom, x2: a.cx, y2: b.cy }, { x1: a.cx, y1: b.cy, x2: into, y2: b.cy }];
}
/** Where a label chip sits: its anchor `x` (its middle, or its left or right edge per `align`) and its top `y`. */
export interface LabelSpot { x: number; y: number; align: 'center' | 'left' | 'right' }
export interface Rect { l: number; r: number; t: number; b: number }
/** The box a one-line chip of `text` takes at `spot` (workflow.tsx `Chip`: 6 px either side and a 1 px line). */
export function spotRect(spot: LabelSpot, text: string): Rect {
  const w = textWidth(text, FLOW.note) + px(12) + 2;
  const l = spot.align === 'center' ? spot.x - w / 2 : spot.align === 'right' ? spot.x - w : spot.x;
  return { l, r: l + w, t: spot.y, b: spot.y + FLOW.chipH };
}
/** A forward line's label: beside a vertical line, over a level one. */
export function edgeLabelSpot(s: Segment): LabelSpot {
  const vertical = s.x1 === s.x2;
  return vertical ? { x: s.x1 + px(6), y: (s.y1 + s.y2) / 2 - px(9), align: 'left' } : { x: (s.x1 + s.x2) / 2, y: s.y1 - px(21), align: 'center' };
}
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
/** What a label must keep clear of on the flow: every step and every step's count chip. */
export function flowObstacles(layout: FlowLayout): Rect[] {
  const out: Rect[] = [];
  for (const node of layout.at.values()) {
    out.push({ l: node.left, r: node.right, t: node.top, b: node.bottom });
    if (node.chip.length) {
      const w = Math.max(...node.chip.map(v => textWidth(v, FLOW.note))) + px(12) + 2;
      out.push({ l: node.cx - w / 2, r: node.cx + w / 2, t: node.chipTop, b: node.chipTop + FLOW.chipH + (node.chip.length - 1) * FLOW.chipLine });
    }
  }
  return out;
}
/**
 * 347 X10 (gate 351 F1): where a loop's label goes (`n` lines drawn for it, `segs` its `route`). Every spot along the line is
 * tried in order — a loop under a row: below its detour in the middle (where it always was), along it, above it, then a level or two lower;
 * any other: before the corner of the sideways run (where it always was), beside the line going up — left first, as a
 * forward line down the same column has its label on the right — middle first, then along the sideways run; last, under or over the two steps it joins. The first that
 * keeps `px(2)` clear of every step, count chip and label in `taken` (the forward lines' labels and the loop labels placed
 * before) and stays on the canvas wins; none free: the one that covers least, a step counting most. A loop straight up a
 * column used to put its label on the top edge of the step it leaves, a loop under a row on a forward line's label.
 * workflow.tsx draws loop labels after the steps, so nothing hides them.
 */
export function loopLabelSpot(layout: FlowLayout, segs: readonly Segment[], n: number, text: string, taken: readonly Rect[] = []): LabelSpot {
  const h = FLOW.chipH, along = [.5, .35, .65, .2, .8, .08, .92], spots: LabelSpot[] = [];
  const level = (s: Segment) => s.y1 === s.y2, lo = (s: Segment) => Math.min(s.x1, s.x2), hi = (s: Segment) => Math.max(s.x1, s.x2);
  const beside = (s: Segment) => { const top = Math.min(s.y1, s.y2), bottom = Math.max(s.y1, s.y2);
    for (const f of along) { const y = top + (bottom - top) * f - h / 2; spots.push({ x: s.x1 - px(6), y, align: 'right' }, { x: s.x1 + px(6), y, align: 'left' }); } };
  if (segs.length === 3) {
    const s = segs[1]!, below = s.y1 + (n + 1) * FLOW.loopGap / 2 + px(2), above = s.y1 - (n - 1) * FLOW.loopGap / 2 - h - px(2);
    for (const y of [below, above, below + h + px(4), below + 2 * (h + px(4))]) for (const f of along) spots.push({ x: lo(s) + (hi(s) - lo(s)) * f, y, align: 'center' });
    beside(segs[0]!); beside(segs[2]!);
  } else {
    const first = segs[0]!, up = segs.at(-1)!;
    if (segs.length === 2) spots.push({ x: first.x2 - (n - 1) * FLOW.loopGap / 2 - px(8), y: first.y1 - px(9), align: 'right' });
    if (!level(up)) beside(up);
    if (level(first)) for (const f of along) spots.push({ x: lo(first) + (hi(first) - lo(first)) * f, y: first.y1 - px(9), align: 'center' });
  }
  // Last, by the two steps it joins: under the one it leaves, over the one it comes back to (a long label of many rounds).
  const nodeAt = (x: number, y: number) => [...layout.at.values()].find(v => x >= v.left - 1 && x <= v.right + 1 && y >= v.top - 1 && y <= v.bottom + 1);
  const from = nodeAt(segs[0]!.x1, segs[0]!.y1), to = nodeAt(segs.at(-1)!.x2, segs.at(-1)!.y2);
  for (const [v, y] of [[from, from ? from.bottom + px(4) : 0], [to, to ? to.top - h - px(4) : 0], [to, to ? to.bottom + px(4) : 0], [from, from ? from.top - h - px(4) : 0]] as const)
    if (v) spots.push({ x: v.cx, y, align: 'center' }, { x: v.left, y, align: 'left' }, { x: v.right, y, align: 'right' });
  const steps = flowObstacles(layout), labels = [...taken], gap = px(2);
  const grow = (r: Rect): Rect => ({ l: r.l - gap, r: r.r + gap, t: r.t - gap, b: r.b + gap });
  const cost = (spot: LabelSpot) => {
    const r = spotRect(spot, text);
    if (r.l < 0 || r.r > layout.width || r.t < 0 || r.b > layout.height) return Infinity;
    const g = grow(r);
    return steps.reduce((sum, b) => sum + 4 * overlapArea(g, b), 0) + labels.reduce((sum, b) => sum + overlapArea(g, b), 0);
  };
  let best = spots[0]!, least = Infinity;
  for (const spot of spots) { const c = cost(spot); if (c === 0) return spot; if (c < least) { least = c; best = spot; } }
  return best;
}
/** The lowest edge of the nodes in `row` — where a line going back along that row runs under. */
export function rowBottom(layout: FlowLayout, row: number): number {
  return Math.max(...[...layout.at.values()].filter(n => n.stage.row === row).map(n => n.bottom));
}

// ---- the chosen release over the drawing ----------------------------------------------------------------------------
/** One time round a loop (a `back` edge): the document that went back (`from`), the one it came back to (`to`) and its verdict. */
export interface FlowLoop { from?: number; to?: number; verdict?: Verdict }
export interface FlowOverlay {
  /** The steps the release went through (its `path`), and a decision between two of them. */
  passed: Set<string>;
  /** The indexes of the forward edges the release took (both ends passed). */
  hot: Set<number>;
  /** Per back edge (its index), the rounds the release went back. */
  loops: Map<number, FlowLoop[]>;
  /** What the release says at a step, drawn inside its node. */
  notes: Record<string, string[]>;
  /** Each step's state in this release (shared/workflow.ts `CellState`). */
  states: Record<string, CellState>;
}
/**
 * `unit` (REQ-125 U1): a 건's way is the steps with data only — no decision is taken as passed from the steps around it and
 * no loop as gone round (research/290 2.8: only a confirmed answer draws a branch).
 * U4b (research/309 4.2): a decision on a 건's way is one whose record cell is confirmed (the server's `path`); of the lines out of
 * it only its answer's `when` branch is bold — whether the step there holds data or not — and never two: a definition with two
 * branches of one answer draws neither. An ambiguous, partly read or unrecorded decision is off the way, its branches plain.
 */
/**
 * The report's own word ("반려", "조건부") for a verdict where it was read, else the kind's. D54: a function of its own, not one made
 * in flowOverlay's loop, where Hermes (the phone apps' engine) would let it keep the loop's last cell (research/364).
 */
function verdictWord(events: readonly WorkflowEventDTO[], item: { doc?: number | undefined; verdict?: Verdict | undefined }, w: WorkflowWords): string {
  return events.find(e => e.kind === 'verdict' && e.doc === item.doc && e.verdict === item.verdict)?.word ?? w.verdict[item.verdict ?? 'unknown'];
}
export function flowOverlay(definition: Pick<Definition, 'stages' | 'edges'>, release: WorkflowReleaseDTO | undefined, w: WorkflowWords, unit?: 'instance'): FlowOverlay {
  const passed = new Set(release?.path.map(p => p.stage) ?? []);
  const { edges, stages } = definition;
  const instances = unit === 'instance';
  // A decision is passed when the release came into it and went on out of it.
  for (const stage of stages) if (!instances && stage.shape === 'diamond' && edges.some(e => !e.back && e.to === stage.id && passed.has(e.from))
    && edges.some(e => !e.back && e.from === stage.id && passed.has(e.to))) passed.add(stage.id);
  const branch = instances ? chosenBranches(definition, release) : new Map<string, number>();
  const decides = (id: string) => instances && stages.some(s => s.id === id && s.shape === 'diamond');
  const hot = new Set(edges.flatMap((e, i) => e.back ? [] : decides(e.from) ? (branch.get(e.from) === i ? [i] : [])
    : passed.has(e.from) && passed.has(e.to) ? [i] : []));
  const loops = new Map<number, FlowLoop[]>();
  for (const [i, e] of edges.entries()) {
    if (!e.back || instances) continue;
    const list: FlowLoop[] = [];
    let seen = false, open: { doc?: number | undefined } | null = null;
    for (const item of release?.path ?? []) {
      if (item.stage === e.to) {
        if (seen) { list.push({ ...(open?.doc !== undefined ? { from: open.doc } : {}), ...(item.doc !== undefined ? { to: item.doc } : {}),
          ...(item.verdict ? { verdict: item.verdict } : {}) }); open = null; }
        seen = true;
      } else if (item.stage === e.from) {
        if (open) list.push(open.doc !== undefined ? { from: open.doc } : {});
        open = item;
      }
    }
    if (open) list.push(open.doc !== undefined ? { from: open.doc } : {});
    loops.set(i, list);
  }
  const states: Record<string, CellState> = {}, notes: Record<string, string[]> = {};
  for (const cell of release?.cells ?? []) states[cell.stage] = cell.state;
  for (const stage of stages) {
    const cell = release?.cells.find(c => c.stage === stage.id);
    if (!cell) continue;
    // A loop's step carries its verdicts on the way (`path`); any other judged step on its own events, in document order.
    const walked = (release?.path ?? []).filter(p => p.stage === stage.id && p.verdict);
    const judged = walked.length ? walked : cell.events.filter(e => e.kind === 'verdict' && e.verdict);
    if (judged.length) {
      const first = judged[0]!, last = judged.at(-1)!;
      notes[stage.id] = [[first.doc, verdictWord(cell.events, first, w)].filter(v => v !== undefined).join(' '),
        ...(judged.length > 1 && last.verdict !== first.verdict ? ['→ ' + verdictWord(cell.events, last, w)] : [])];
    // A 건's step says what its table cell says (313-F3): "기록 없음 · 규칙 충돌 1" where a common rule took its files, never a bare "기록 없음".
    } else if (instances && cell.state !== 'decision' && cell.state !== 'no-source') notes[stage.id] = [tableCell(release!, stage, w).text];
    else if (cell.state === 'no-record') notes[stage.id] = [w.stateNoRecord];
    else if (cell.state === 'unknown-format') notes[stage.id] = [w.stateUnknown];
    else if (cell.state === 'title-unread') notes[stage.id] = [cell.events[0]?.sha ?? '', w.titleUnread].filter(Boolean);
  }
  return { passed, hot, loops, notes, states };
}
/**
 * U4b: per decision on a 건's way (`path`) with a confirmed answer, the index of its one forward line of that answer (`when`) —
 * none where its cell is not confirmed, or where no line or more than one carries that answer.
 */
export function chosenBranches(definition: Pick<Definition, 'stages' | 'edges'>, release: WorkflowReleaseDTO | undefined): Map<string, number> {
  const out = new Map<string, number>(), on = new Set(release?.path.map(p => p.stage) ?? []);
  for (const stage of definition.stages) {
    if (stage.shape !== 'diamond' || !on.has(stage.id)) continue;
    const cell = release?.cells.find(c => c.stage === stage.id);
    if (cell?.state !== 'found' || !cell.answer) continue;
    const ways = definition.edges.flatMap((e, i) => !e.back && e.from === stage.id && e.when === cell.answer ? [i] : []);
    if (ways.length === 1) out.set(stage.id, ways[0]!);
  }
  return out;
}
/**
 * REQ-125 U4b (research/309 4.3): a 건's end tag in words — "끝: 불참 · 9/22 15:04" — when it is shown; why it is held otherwise
 * ("끝 꼬리표 보류 — …"), for the evidence of the cells that found it. Empty when the 건 has none.
 */
export interface EndWords { endTag: (stage: string, day: string) => string; endHeld: Record<NonNullable<NonNullable<WorkflowReleaseDTO['endTag']>['held']>, (stage: string, at: string) => string> }
export function endTagText(release: WorkflowReleaseDTO | undefined, stages: readonly WorkflowStage[], m: EndWords): { shown: string; held: string } {
  const tag = release?.endTag;
  if (!tag) return { shown: '', held: '' };
  const label = (id: string) => stages.find(s => s.id === id)?.label ?? id;
  if (!tag.held) return { shown: m.endTag(label(tag.stage), logDay(tag.time)), held: '' };
  const at = tag.held === 'disagree' || tag.held === 'branches' || tag.held === 'incomplete' ? label(tag.at ?? '') : tag.at ?? '';
  return { shown: '', held: m.endHeld[tag.held](label(tag.stage), at) };
}
/**
 * A read that failed, in words a person reads: a reply the screen's check refused (the SDK says its schema's problems as JSON) is
 * "the reply did not fit — N places", never the JSON; any other error its first line. `detail` is the whole text, for "자세히".
 */
export function readFailure(error: string): { kind: 'reply' | 'other'; count: number; first: string; detail: string } {
  try {
    const issues: unknown = JSON.parse(error);
    if (Array.isArray(issues) && issues.length && issues.every(i => i && typeof i === 'object' && 'message' in i)) {
      const one = issues[0] as { path?: unknown[]; message?: unknown };
      return { kind: 'reply', count: issues.length, first: [Array.isArray(one.path) ? one.path.join('.') : '', String(one.message ?? '')].filter(Boolean).join(': '), detail: error };
    }
  } catch { /* not the check's list */ }
  const first = error.split('\n').find(line => line.trim()) ?? '';
  return { kind: 'other', count: 0, first: Array.from(first.trim()).slice(0, 160).join(''), detail: error };
}
/** The loop's label: "재게이트 1회: 210→212", "210→없음" for a round that did not come back (yet). */
export function loopLabel(edge: WorkflowEdge, loops: readonly FlowLoop[], w: WorkflowWords): string {
  const label = edge.label ?? '';
  if (!loops.length) return label;
  const rounds = loops.map(l => `${l.from ?? '?'}→${l.to ?? w.loopNone}`).join(' · ');
  return w.loopTimes(label, loops.length) + ': ' + rounds;
}
/**
 * What each step counts over the releases shown (`totals[].window`), the chip over (row 0) or under a node: a verdict
 * step its first round and how many failed or passed on conditions; any other step how many things were read. A step with
 * nothing to read has no chip: its node says so (`sourceNotes`).
 */
export function stageCounts(model: Pick<WorkflowModelDTO, 'totals' | 'definition'> & { unit?: 'instance' | undefined; program?: WorkflowModelDTO['program'] | undefined }, w: WorkflowWords): Record<string, string> {
  const out: Record<string, string> = {};
  // REQ-125 U1: how many 건 hold data for the step ("자료 있는 건 2"); U3: a program step is every 건's — "공통".
  if (byInstance(model)) {
    for (const t of model.totals) if (model.definition.stages.some(s => s.id === t.stage && s.shape !== 'diamond')) out[t.stage] = w.countInstances(t.window.count);
    for (const stage of programStages(model)) out[stage] = w.programName;
    return out;
  }
  const unknown = (t: WorkflowTally) => t.unknown ? ' · ' + w.stateUnknown + ' ' + t.unknown : '';
  for (const stage of model.definition.stages) {
    const totals = model.totals.filter(t => t.stage === stage.id);
    if (stage.shape === 'diamond') continue;
    if (!totals.length) continue;
    const first = totals.find(t => t.round === 'first');
    if (first) { const t = first.window; out[stage.id] = `${w.firstRound} ${t.count} · ${w.verdict.fail} ${t.fail} · ${w.verdict.conditional} ${t.conditional}${unknown(t)}`; continue; }
    const t = totals.reduce((sum, v) => ({ count: sum.count + v.window.count, unknown: sum.unknown + v.window.unknown }), { count: 0, unknown: 0 });
    out[stage.id] = w.countFound(t.count) + (t.unknown ? ' · ' + w.stateUnknown + ' ' + t.unknown : '');
  }
  return out;
}

/**
 * A step the definition reads nothing for says so inside its node — a person's step as the person's (216's "휴대폰 확인").
 * REQ-125: a built-in reads nothing anywhere (the panel says so once), so only a person's step is marked, as the person's.
 */
export function sourceNotes(model: Pick<WorkflowModelDTO, 'totals' | 'definition'> & { builtin?: unknown; program?: WorkflowModelDTO['program'] | undefined }, w: WorkflowWords): Record<string, string[]> {
  if (model.builtin) return Object.fromEntries(model.definition.stages.filter(s => s.person && s.shape !== 'diamond').map(s => [s.id, [w.statePerson]]));
  // U3: a program step is read (once, for every 건), so it is no "읽을 자료 없음" step.
  const common = programStages(model);
  return Object.fromEntries(model.definition.stages.filter(s => s.shape !== 'diamond' && !model.totals.some(t => t.stage === s.id) && !common.has(s.id))
    .map(s => [s.id, s.person ? [w.stateNoSource, w.statePerson] : [w.stateNoSource]]));
}

// ---- the table ----------------------------------------------------------------------------------------------------
/**
 * The table's step columns: every step the definition reads (a decision and a step with nothing to read would say the same
 * in every row — the flow says it once), in the drawing's order (column, then row).
 */
export function tableStages(model: Pick<WorkflowModelDTO, 'definition' | 'totals'> & { unit?: 'instance' | undefined }): WorkflowStage[] {
  // REQ-125 U4a: a 건 decision a record rule reads has a column of its answers (research/309 8.1); a release's never.
  return model.definition.stages.filter(s => (s.shape !== 'diamond' || byInstance(model)) && model.totals.some(t => t.stage === s.id))
    .sort((a, b) => a.col - b.col || a.row - b.row);
}
/**
 * The table's column widths: each as wide as its longest text at 12px (padding included) between `min` and `max`; when
 * they leave room in `available`, they share it in proportion, else the table scrolls sideways.
 */
export function tableWidths(columns: readonly (readonly string[])[], available: number, min = px(64), max = px(240)): number[] {
  const want = columns.map(texts => Math.min(max, Math.max(min, ...texts.map(t => textWidth(t, px(12)) + px(18)))));
  const sum = want.reduce((a, b) => a + b, 0);
  return sum >= available ? want : want.map(v => Math.floor(v * available / sum));
}
/** "2026-09-30 12:49 KST" → "09-30 12:49" (a document's first KST line as written, a commit's time in KST). */
export function shortTime(time: string | null | undefined): string {
  const m = time?.match(/\d{4}-(\d\d-\d\d) (\d\d:(?:\d\d|xx))/);
  return m ? `${m[1]} ${m[2]}` : '';
}
/** The releases' common "0." dropped from their chips ("1.42"), kept when any release does not start with it. */
export function releaseChip(release: string, all: readonly string[]): string {
  return all.every(r => r.startsWith('0.')) ? release.slice(2) : release;
}
export type CellTone = 'plain' | 'muted' | 'warning' | Verdict;
export interface TableCell { text: string; tone: CellTone; state: CellState; warned: boolean;
  /** U3 311-F2: the end of `text` that must stay in sight ("규칙 충돌 1") — the table draws it apart, so a long name cut short never hides it. */
  tail?: string }
const shown = (list: readonly string[], most = 3) => list.slice(0, most).join(' ') + (list.length > most ? ` +${list.length - most}` : '');
/**
 * One step of one release, as the table says it. `found`: what was read — a verdict's first round and where it ended
 * ("208 불통과 → 212 조건부"), the REQ ids of a heading step (the release's own list), document numbers, a result's time, a
 * commit's hash and time. The other states say what they are and never a dash: "No record" is not "not done".
 */
export function tableCell(release: WorkflowReleaseDTO, stage: WorkflowStage, w: WorkflowWords): TableCell {
  const said = cellWords(release, stage, w), held = release.cells.find(c => c.stage === stage.id)?.conflicts?.length ?? 0;
  // U3 311-F2: a 건 cell whose files a common rule took says so — "기록 없음 · 규칙 충돌 1" is never a quiet "기록 없음".
  return held && w.conflicts ? { ...said, text: said.text + ' · ' + w.conflicts(held), tail: w.conflicts(held) } : said;
}
function cellWords(release: WorkflowReleaseDTO, stage: WorkflowStage, w: WorkflowWords): TableCell {
  const cell = release.cells.find(c => c.stage === stage.id);
  const state = cell?.state ?? 'no-record', events = cell?.events ?? [];
  const warned = release.warnings.some(x => x.stage === stage.id);
  const make = (text: string, tone: CellTone) => ({ text, tone, state, warned });
  if (state === 'no-record') return make(w.stateNoRecord, 'muted');
  if (state === 'no-source' || state === 'decision') return make(w.stateNoSource, 'muted');
  // REQ-125 U1: the grades say what they are (research/290 3.1) — the hatch glyph and the warning sign are part of the words.
  // 302-F2: read in part even where data was found — the folders found are said after it, never as all there is.
  // A 건's cell: its versions (U2) and its folders with data (U1), each in its words — a step may read both.
  const versions = events.filter(e => e.kind === 'version'), folders = events.filter(e => e.kind === 'folder');
  const said = events.length && versions.length + folders.length === events.length ? [versions.length ? versionText(versions, w) : '',
    folders.length ? w.dataThere + ' · ' + (folders[0]!.path.split('/').at(-1) ?? '') + (folders.length > 1 ? ' +' + (folders.length - 1) : '') : ''].filter(Boolean).join(' · ') : '';
  if (state === 'incomplete') return make('▨ ' + w.stateIncomplete + (said ? ' · ' + said : ''), 'warning');
  // U4a: a record cell's evidence counts the pieces standing in every 건 too (`shared`).
  if (state === 'ambiguous') return make('⚠ ' + w.stateAmbiguous(events.length + (cell?.shared ?? 0)), 'warning');
  if (state === 'found' && events.length && events.every(e => e.kind === 'log')) return make(logText(cell!, w), 'plain');
  if (said) return state === 'candidate' ? make(w.stateCandidate + ' · ' + said, 'muted') : make(said, state === 'unknown-format' ? 'warning' : 'plain');
  if (state === 'candidate') return make(w.stateCandidate, 'muted');
  if (state === 'title-unread') return make(`${events[0]?.sha ?? ''} · ${w.titleUnread}`, 'warning');
  if (state === 'unknown-format') return make(w.stateUnknown + (events.some(e => e.doc !== undefined) ? ' ' + shown(events.flatMap(e => e.doc !== undefined ? [String(e.doc)] : [])) : ''), 'warning');
  const verdicts = events.filter(e => e.kind === 'verdict');
  if (verdicts.length) {
    const first = verdicts.find(e => e.round === 'first') ?? verdicts[0]!, again = verdicts.filter(e => e !== first && e.round === 'again'), last = again.at(-1);
    const say = (e: WorkflowEventDTO) => [e.doc, e.verdict && e.verdict !== 'unknown' && e.word ? e.word : w.verdict[e.verdict ?? 'unknown']].filter(v => v !== undefined).join(' ');
    return make(say(first) + (last ? ' → ' + say(last) + (again.length > 1 ? ' ' + w.timesShort(again.length) : '') : ''), last?.verdict ?? first.verdict ?? 'unknown');
  }
  if (events.every(e => e.kind === 'heading')) {
    const ids = release.reqs.map(r => r.id);
    return make(shown(ids.length ? ids : [...new Set(events.flatMap(e => e.ids ?? []))]), 'plain');
  }
  if (events.every(e => e.kind === 'commit')) {
    const last = events.at(-1)!;
    return make([last.sha?.slice(0, 7), shortTime(last.time)].filter(Boolean).join(' '), 'plain');
  }
  if (events.every(e => e.kind === 'result')) {
    return make(events.map(e => e.missing ? w.resultMissing : [shortTime(e.time) || '?', e.ok === false ? w.resultNotOk : ''].filter(Boolean).join(' ')).join(' · '),
      events.some(e => e.ok === false) ? 'fail' : 'plain');
  }
  const docs = events.flatMap(e => e.doc !== undefined ? [String(e.doc)] : e.ids?.length ? e.ids : [e.path.split('/').at(-1) ?? e.path]);
  return make(shown([...new Set(docs)], 4), 'plain');
}
/**
 * REQ-125 U4a (research/309 8.1): a confirmed record cell in words — the latest confirmed piece's answer (a decision) or act, its
 * day ("10/1", "10/1 17:00"), and the record it rests on ("「건 기록」 기준"), always: what is written outside it is not read.
 */
export function logText(cell: Pick<WorkflowReleaseDTO['cells'][number], 'events' | 'answer'>, w: WorkflowWords): string {
  const sure = cell.events.filter(e => e.strength === 'confirmed' && (!cell.answer || e.answer === cell.answer));
  const last = [...sure].sort((a, b) => (a.time ?? '') < (b.time ?? '') ? -1 : (a.time ?? '') > (b.time ?? '') ? 1 : 0).at(-1);
  const said = cell.answer === 'yes' ? w.answerYes ?? 'yes' : cell.answer === 'no' ? w.answerNo ?? 'no' : last?.word ?? '';
  return [said, logDay(last?.time), last?.section && w.logBasis ? w.logBasis(last.section) : ''].filter(Boolean).join(' · ');
}
/** A record time as written → "10/1" or "10/1 17:00". */
export const logDay = (time: string | null | undefined): string => {
  const m = time?.match(/^\d{4}-(\d\d)-(\d\d)(?: (\d\d:\d\d) KST)?$/);
  return m ? Number(m[1]) + '/' + Number(m[2]) + (m[3] ? ' ' + m[3] : '') : '';
};
/**
 * REQ-125 U4a: the evidence of a record cell that stands in every 건 (the model's `logShared`): its step's first `shared`, those
 * the cell found earlier than its latest confirmed ones marked `earlier`.
 */
export function sharedEvidence(model: { logShared?: WorkflowModelDTO['logShared'] | undefined }, release: WorkflowReleaseDTO | undefined, stage: string): WorkflowEventDTO[] {
  const cell = release?.cells.find(c => c.stage === stage);
  if (!cell?.shared) return [];
  const earlier = new Set(cell.earlierShared ?? []);
  return (model.logShared ?? []).flatMap((e, i) => e.stage === stage ? [earlier.has(i) ? { ...e, earlier: true as const } : e] : []).slice(0, cell.shared);
}
/** "2026-09-17" → "9/17". */
export const shortDay = (day: string | null | undefined): string => { const m = day?.match(/^\d{4}-(\d\d)-(\d\d)$/); return m ? Number(m[1]) + '/' + Number(m[2]) : ''; };
/**
 * REQ-125 U2 (research/290 2.2·3.1): a `file-versions` cell in words — the order of the versions seen, never "재작업 N회" or
 * "최초 작성". Its first document (chain, by name) speaks; other documents are "+N", unreadable files "· 형식 모름 N".
 * - only the lowest version: "v1.0 9/17 (관측된 첫 판)"; a lowest that is not 1, 1.0, 1.0.0 or 0.x adds "— 이전 판은 이 폴더에 없음"
 * - versions above it: the highest, "v2.0 9/17 (다음 판 1개 관측)"
 * - both (no `observed`): "v1.0 → v2.0 9/17 (관측된 판 2개)"
 * A version whose files name several days adds "· 날짜 여러 개" (its day is the earliest).
 */
export function versionText(events: readonly WorkflowEventDTO[], w: WorkflowWords): string {
  const read = events.filter(e => e.ver !== undefined), unread = events.length - read.length;
  const chains = [...new Set(read.map(e => e.chain ?? ''))];
  const tail = unread ? (read.length ? ' · ' : '') + w.stateUnknown + ' ' + unread : '';
  if (!read.length) return w.stateUnknown + ' · ' + (events[0]!.path.split('/').at(-1) ?? '') + (events.length > 1 ? ' +' + (events.length - 1) : '');
  const of = read.filter(e => (e.chain ?? '') === chains[0]), low = of.find(e => e.observed === 'lowest'), later = of.filter(e => e.observed === 'later');
  const last = later.at(-1) ?? low!, day = shortDay(last.time);
  const head = (low && later.length ? 'v' + low.ver + ' → ' : '') + 'v' + last.ver + (day ? ' ' + day : '');
  const first = (ver: string) => { const n = ver.split('.').map(Number); return n[0] === 0 || (n[0] === 1 && n.slice(1).every(v => v === 0)); };
  const said = low && later.length ? w.versionsSeen(of.length) : later.length ? w.versionNext(later.length)
    : w.versionFirst + (first(low!.ver!) ? '' : ' — ' + w.versionNoEarlier);
  return head + ' (' + said + (last.days ? ' · ' + w.daysMany : '') + ')' + (chains.length > 1 ? ' +' + (chains.length - 1) : '') + tail;
}
/** Where an event's evidence is: "research/208_…md:12" (a plugin cannot open a file, so the path is shown). */
export function evidencePlace(event: Pick<WorkflowEventDTO, 'path' | 'line'>): string {
  return event.path + (event.line !== undefined ? ':' + event.line : '');
}

// ---- REQ-134 WA: the 390px reading (research/267) --------------------------------------------------------------------
/**
 * One line of the phone's ladder, top to bottom: the steps in the drawing's order (column, then row) — a step of the first
 * row on the ladder itself, any other row's as a box beside it (`side`), right after the ladder's step of its column — and
 * after a loop's starting step the loop (a `back` edge) as its own box, so where the release went back reads on one screen.
 */
export type LadderItem =
  | { kind: 'step'; stage: WorkflowStage; side: boolean; passed: boolean; outlined: boolean; note: string; chip: string;
    /** The label of the edge into a side step ("아니오"), or of a decision's ways out ("예 → 커밋"). */
    via: string; dashed: boolean; state: CellState | undefined;
    /**
     * U4b: a decision's ways out one by one (`via`'s parts), the confirmed answer's marked `on` (research/309 4.2) — and `cut`: the
     * ladder's line on from this decision is not the 건's way (its answer goes elsewhere), so it is never bold.
     */
    ways?: { text: string; on: boolean }[]; cut?: boolean }
  | { kind: 'loop'; edge: WorkflowEdge; index: number; to: WorkflowStage; text: string; loops: FlowLoop[] };
export function ladderItems(model: Pick<WorkflowModelDTO, 'definition' | 'totals'> & { builtin?: unknown; unit?: 'instance' | undefined; program?: WorkflowModelDTO['program'] | undefined },
  chosen: WorkflowReleaseDTO | undefined, w: WorkflowWords): LadderItem[] {
  // U3: a program step speaks on the ladder whichever 건 is chosen.
  const release = withProgram(model, chosen);
  const def = model.definition, overlay = flowOverlay(def, release, w, model.unit), counts = stageCounts(model, w), sources = sourceNotes(model, w);
  const branches = byInstance(model) ? chosenBranches(def, release) : new Map<string, number>();
  const byId = new Map(def.stages.map(s => [s.id, s]));
  const ordered = [...def.stages].sort((a, b) => a.col - b.col || a.row - b.row);
  const items: LadderItem[] = [];
  for (const stage of ordered) {
    const side = stage.row > 0, into = def.edges.filter(e => !e.back && e.to === stage.id);
    // 325-F1: a 건's decision lists every line the flow may choose (`chosenBranches`: a `when` line, named or not) besides the named
    // ones — so a confirmed branch with no label is never dropped from the phone; a release's (`/1`) ways stay its named lines.
    const out = def.edges.filter(e => !e.back && e.from === stage.id && (e.label || (byInstance(model) && stage.shape === 'diamond' && e.when)));
    const cell = release?.cells.find(c => c.stage === stage.id);
    // The verdicts on the way read as one ("60 불통과 → 조건부"); a step with nothing to read says why ("읽을 자료 없음 · 사람이 확인").
    // U4a: a 건's decision a record rule reads says its cell ("예 · 10/1 · …", "⚠ 모호 — 근거 2"); no branch is drawn for it.
    const note = stage.shape === 'diamond' ? (byInstance(model) && release && cell && cell.state !== 'decision' ? tableCell(release, stage, w).text : '')
      : overlay.notes[stage.id] ? overlay.notes[stage.id]!.join(' ')
      : (sources[stage.id] ?? (cell && release ? [tableCell(release, stage, w).text] : [])).join(' · ');
    // A line with no name says its answer ("아니오 → 미선정 종료").
    const way = (e: WorkflowEdge) => (e.label ?? (e.when === 'yes' ? w.answerYes ?? 'yes' : w.answerNo ?? 'no')) + ' → ' + (byId.get(e.to)?.label ?? e.to);
    const via = stage.shape === 'diamond' ? out.map(way).join(' · ')
      : side ? into.map(e => e.label ?? '').filter(Boolean).join(' · ') : '';
    // U4b: the confirmed answer's way out of a decision; the ladder's line on goes bold only when it leads to the next step down.
    const pick = branches.get(stage.id), picked = pick === undefined ? undefined : def.edges[pick];
    const below = ordered.slice(ordered.indexOf(stage) + 1).find(s => s.row === 0);
    const extra = stage.shape === 'diamond' && overlay.passed.has(stage.id) && byInstance(model)
      ? { ways: out.map(e => ({ text: way(e), on: e === picked })), cut: picked?.to !== below?.id } : {};
    items.push({ kind: 'step', stage, side, passed: overlay.passed.has(stage.id), outlined: !!sources[stage.id], note, chip: counts[stage.id] ?? '',
      via, dashed: !!stage.person || into.some(e => e.optional), state: overlay.states[stage.id], ...extra });
    for (const [index, edge] of def.edges.entries()) {
      if (!edge.back || edge.from !== stage.id) continue;
      const to = byId.get(edge.to);
      if (to) items.push({ kind: 'loop', edge, index, to, text: loopLabel(edge, overlay.loops.get(index) ?? [], w), loops: overlay.loops.get(index) ?? [] });
    }
  }
  return items;
}
/**
 * A table cell as one mark (research/267 WA: seven columns fit 390): ✓ read (a pass, a document, a commit), △ conditional or a
 * warning (a commit title unread, a hash that differs), × failed, ? unknown format, – nothing read; a step judged more than
 * once shows how many rounds instead, in the last verdict's colour. Its words (`tableCell`) are the accessible label and the
 * evidence sheet's title.
 */
export interface CellMark { mark: string; tone: CellTone; state: CellState; text: string }
export function cellMark(release: WorkflowReleaseDTO, stage: WorkflowStage, w: WorkflowWords, unit?: 'instance'): CellMark {
  const cell = tableCell(release, stage, w), events = release.cells.find(c => c.stage === stage.id)?.events ?? [];
  const make = (mark: string, tone: CellTone) => ({ mark, tone, state: cell.state, text: cell.text + (cell.warned ? ' ⚠' : '') });
  // REQ-125 U1 (research/290 3.2): a 건's marks tell the grades apart by shape alone — ● data, ◌ candidate, ⚠ ambiguous, ▨ read in part.
  if (unit === 'instance') {
    // U4a: a decision's confirmed answer — ✓ yes, ✕ no (research/309 8.1 "휴대폰 ◇ 열").
    const answer = release.cells.find(c => c.stage === stage.id)?.answer;
    if (cell.state === 'found' && answer) return answer === 'yes' ? make('✓', 'pass') : make('✕', 'plain');
    if (cell.state === 'found') return make('●', 'pass');
    if (cell.state === 'candidate') return make('◌', 'muted');
    if (cell.state === 'ambiguous') return make('⚠', 'warning');
    if (cell.state === 'incomplete') return make('▨', 'warning');
    // U2: files that fit a document's name but read no version.
    if (cell.state === 'unknown-format') return make('?', 'unknown');
    return make('–', 'muted');
  }
  if (cell.state === 'no-record' || cell.state === 'no-source' || cell.state === 'decision') return make('–', 'muted');
  if (cell.state === 'unknown-format') return make('?', 'unknown');
  if (cell.state === 'title-unread' || cell.warned) return make('△', 'warning');
  const rounds = events.filter(e => e.kind === 'verdict').length;
  if (rounds > 1) return make(String(rounds), cell.tone);
  if (cell.tone === 'fail') return make('×', 'fail');
  if (cell.tone === 'conditional') return make('△', 'conditional');
  if (cell.tone === 'unknown') return make('?', 'unknown');
  return make('✓', cell.tone === 'plain' ? 'pass' : cell.tone);
}
