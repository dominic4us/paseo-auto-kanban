import { matchesLabels, matchesSearch, normalizeSearch } from './filter-model.js';
import type { WorkspaceLabelsDTO } from '../shared/rpc.js';
import { needsHuman } from '../shared/core/domain.js';
import type { BoardDTO, BoardCardDTO } from '../shared/rpc.js';
import type { Directory } from './presentation.js';
import { workspaceEntry, workspaceKey, workspaceName } from './presentation.js';
import { compareByOrder, emptyLaneOrder, flatOrder, type LaneOrder } from './order-model.js';
import { sortCards, type CardOrder } from './card-order.js';
import { boardMark, inFocus, leadTitle, linkStages, type AgentLinks } from './card-groups.js';
import { busyOverdue } from './busy-view.js';
import { px, scaled } from './ui-scale.js';
export const SWIMLANE = scaled({ columnWidth: 280, cardWidth: 264, columnGap: 8, cellPadding: 8,
  projectGap: 14, laneGap: 8, headerHeight: 44, columnHeaderHeight: 36, previewCount: 3,
  /** REQ-92: how many more cards one "+N" shows in its own column, the done column too. */
  moreStep: 5,
  /**
   * REQ-45/REQ-60: a workspace row and its four columns sit this far inside the project row above them,
   * with a 1px rail down the left of the indented block. The host theme publishes colours only — no
   * spacing token exists — so the value follows this file's own 8px step: 16 was one step and read as
   * alignment rather than hierarchy, 24 is the next step and the smallest value REQ-60 allows.
   */
  laneIndent: 24,
  /** REQ-60 ⑥: the same step on 390px, where 24 would cost a tenth of the screen. */
  mobileLaneIndent: 12,
  /** REQ-60 ⑤: the 1px rail runs down the middle of the indent, clear of both the project row and the lane. */
  railInset: 11, mobileRailInset: 5 } as const, ['previewCount', 'moreStep']);
/**
 * A lane's folds, kept for the session only. REQ-92: `steps` says how many times each column's "+N" was pressed (five
 * more cards each time), per stage; the attention filter and a search keep their own (`attentionSteps`).
 */
export type LaneState = { collapsed?: boolean; attentionCollapsed?: boolean; steps?: Record<string, number>; attentionSteps?: Record<string, number>;
  /** REQ-109: the "+N" presses a highlight opened (`revealFamily`), to be taken back when it ends (`concealFamily`). */
  revealed?: Revealed };
/**
 * REQ-109: what a highlight opened in a lane — per column, its presses before (null: none were kept) and after — and
 * whether the attention filter's or a search's own steps were the ones opened. Kept with the lane's folds, so a refresh
 * or a screen drawn again still knows what to take back.
 */
export type Revealed = { attention: boolean; stages: Record<string, [from: number | null, to: number]> };
export type LaneStates = Record<string, LaneState>;
/** REQ-84 ④: a busy mark on for more than two hours needs a person too (`now`: the screen's clock). */
export function cardNeedsAttention(card: BoardCardDTO, stages: BoardDTO['template']['stages'], now = Date.now()): boolean {
  return needsHuman({ ...card, archivedAt: null, blockedReason: card.blocked ? '' : null }, stages) || busyOverdue(card.busy, now);
}
/**
 * Research/174 D2: which busy marks are past two hours at `now` (the screen's minute clock), as one string. A mark crosses
 * the line by time alone, with nothing read again, so the screens rebuild their model (the "needs a person" count and
 * filter) when this changes — once per crossing, not every minute. '' with none overdue.
 */
export function overdueKey(boards: readonly BoardDTO[], now: number): string {
  const ids: string[] = [];
  for (const board of boards) for (const stage of board.stages) for (const c of stage.cards) if (busyOverdue(c.busy, now)) ids.push(c.id);
  return ids.sort().join(' ');
}
export function isBasicBoard(board: BoardDTO): boolean {
  return board.template.id === 'basic' && board.template.version === 1 && board.stages.length === 4 &&
    board.stages.every((stage, index) => stage.stageId === ['todo', 'doing', 'review', 'done'][index] && stage.countsAsDone === (index === 3));
}
export function laneModel(board: BoardDTO, state: LaneState = {}, attentionOnly = false, query = '', orphaned: ReadonlySet<string> = new Set(),
  order: CardOrder = 'default', archived: (agentId: string) => boolean = () => false, agents?: AgentLinks) {
  // Every card, sub-cards included: the workspace's card count, its "needs a person" count and whether anything matches.
  const all = board.stages.flatMap(stage => stage.cards);
  const needsAttention = (c: BoardCardDTO) => cardNeedsAttention(c, board.template.stages) || orphaned.has(c.id);
  const hit = (c: BoardCardDTO) => (!attentionOnly || needsAttention(c)) && matchesSearch(c, query);
  const attention = all.filter(needsAttention).length;
  const emptyOrDone = all.length === 0 || board.stages.every(stage => stage.countsAsDone || stage.cards.length === 0);
  const filtered = attentionOnly || !!normalizeSearch(query);
  const collapsed = filtered ? state.attentionCollapsed ?? false : state.collapsed ?? emptyOrDone;
  const steps = (filtered ? state.attentionSteps ?? state.steps : state.steps) ?? {};
  const cells = cellsOf(board, order, hit, filtered, collapsed, steps, archived, agents);
  return { board, collapsed, attention, total: all.length,
    visible: !filtered || all.some(hit),
    /** REQ-92: whether any column of this lane shows more than its preview — the lane glyph then folds them back. */
    expanded: !collapsed && cells.some(c => c.step > 0),
    // REQ-93: every card in its own stage's column, a sub-card as any other; the counts are every card's.
    cells,
  };
}
function cellsOf(board: BoardDTO, order: CardOrder, hit: (c: BoardCardDTO) => boolean, filtered: boolean, collapsed: boolean,
  steps: Readonly<Record<string, number>>, archived: (agentId: string) => boolean, agents?: AgentLinks) {
  // REQ-79: the column is put in the chosen order first, so the 3-card preview and each "+N" cut that order.
  // REQ-102: a completion column's own flag lets an archived lead there fall out of "first" (card-order.ts).
  // REQ-117: the agents' labels, for a topic lead's own family (card-groups.ts).
  // REQ-137: and the chat marked as the board's lead, while the server holds it in effect (`boardMark`, 281 F1).
  return linkStages(board.stages, agents, boardMark(board.summary)).map(stage => {
    const sorted = sortCards(stage.cards, order, stage.countsAsDone, archived), matching = filtered ? sorted.filter(hit) : [...sorted];
    // REQ-92: three, then five more for each press of this column's "+N" — in this lane only.
    const step = steps[stage.stageId] ?? 0, cards = collapsed ? [] : matching.slice(0, SWIMLANE.previewCount + step * SWIMLANE.moreStep);
    const remaining = collapsed ? 0 : matching.length - cards.length;
    return { ...stage, cards, matchingCount: matching.length, remaining, step,
      /** Every card the column would show unfolded, in its order — what `revealFamily` looks through. */
      matching,
      /**
       * REQ-92: the column shows more than its preview, so it offers "Collapse". REQ-115: not only once every card shows —
       * part way too, beside the "+N" still left (and the done column's "… in the board"), so it folds back at any point.
       */
      open: !collapsed && step > 0 && cards.length > SWIMLANE.previewCount,
      /** REQ-75 B4: an opened done column that still leaves cards out also offers the board, which shows them all. */
      openBoard: !collapsed && stage.countsAsDone && step > 0 && remaining > 0 };
  });
}
export type ProjectStates = Record<string, boolean>;
/** REQ-57 ②: a workspace Paseo knows about that has no ledger board yet. */
export function isEmptyWorkspace(board: BoardDTO): boolean { return board.summary.hasLedger === false; }
export interface ViewFilterOptions { query?: string; labels?: string[]; workspaceLabels?: WorkspaceLabelsDTO;
  projects?: ProjectStates; orphaned?: ReadonlySet<string>;
  /** REQ-59 ③: the user's own order, which wins over the automatic keys below it. */
  order?: LaneOrder;
  /**
   * REQ-75 A2: whether the board is grouped under project headings. A project fold only exists there, so
   * the flat board (`false`) never folds a lane because of its project. Absent means grouped.
   */
  grouped?: boolean;
  /** REQ-79: the order of the cards inside every cell. Absent means the ledger's (the default). */
  cardOrder?: CardOrder;
  /** REQ-102: whether an agent is archived, for a lead's place in a completion column (card-order.ts). Absent means none are. */
  archived?: (agentId: string) => boolean;
  /** REQ-117: the agents' role and parent labels, for the topic leads (card-groups.ts). Absent means none are known. */
  agents?: AgentLinks }
export type LaneView = ReturnType<typeof laneModel> & { workspaceKey: string };
/** REQ-75 A1: a lane of the flat board, which still knows its project for the icon, the name and the D22 tier. */
export type FlatLane = LaneView & { group: ProjectGroup };
export interface ProjectGroup {
  key: string; projectId: string; projectName: string; projectViewKey: string;
  attentionSection: boolean; latest: string; lanes: LaneView[];
  boardIds: string[]; workspaceCount: number; collapsed: boolean; attention: number; total: number;
  progress: { done: number; requested: number; percent: number | null };
}
/**
 * REQ-57: hiding a project narrows the board down; it is not a card filter. `filtering` stays false so
 * card-less lanes are still listed (they are what a workspace without a board looks like), while a
 * search, a label or the attention chip keeps hiding lanes that match nothing.
 */
export function swimlaneModel(boards: BoardDTO[], directory: Directory, hidden: readonly string[],
  attentionOnly: boolean, states: LaneStates = {}, options: ViewFilterOptions = {}) {
  const scoped = boards.filter(b => {
    // D22: a re-matched board is filtered as the workspace it really belongs to, labels included.
    const entry = workspaceEntry(directory, b.summary.workspaceId, b.summary.cwd);
    return !hidden.includes(entry?.projectId ?? '') &&
      matchesLabels(entry?.id ?? b.summary.workspaceId, options.labels ?? [], options.workspaceLabels);
  });
  const filtering = attentionOnly || !!normalizeSearch(options.query ?? '') || !!options.labels?.length;
  const order = options.order ?? emptyLaneOrder();
  const basic = scoped.filter(isBasicBoard), other = scoped.filter(b => !isBasicBoard(b));
  const groups = new Map<string, ProjectGroup>();
  for (const board of basic) {
    const name = workspaceEntry(directory, board.summary.workspaceId, board.summary.cwd), projectId = name?.projectId ?? '';
    const lane = laneModel(board, states[board.summary.id], attentionOnly, options.query, options.orphaned, options.cardOrder, options.archived, options.agents);
    const visible = lane.visible && (!filtering || lane.cells.some(c => c.matchingCount > 0));
    let group = groups.get(projectId);
    if (!group) {
      group = { key: projectId, projectId, projectName: name?.projectName ?? '', projectViewKey: name?.projectViewKey ?? projectId,
        attentionSection: false, latest: board.summary.updatedAt, lanes: [], boardIds: [], workspaceCount: 0,
        collapsed: options.grouped !== false && (options.projects?.[projectId] ?? false), attention: 0, total: 0,
        progress: { done: 0, requested: 0, percent: null } };
      groups.set(projectId, group);
    }
    group.latest = group.latest > board.summary.updatedAt ? group.latest : board.summary.updatedAt;
    group.workspaceCount++; group.boardIds.push(board.summary.id); group.total += lane.total; group.attention += lane.attention;
    group.progress.done += board.summary.progress.done; group.progress.requested += board.summary.progress.requested;
    if (group.collapsed) { lane.collapsed = true; lane.expanded = false;
      lane.cells = lane.cells.map(c => ({ ...c, cards: [], remaining: 0, open: false, openBoard: false })); }
    if (visible) group.lanes.push({ ...lane, workspaceKey: workspaceKey(directory, board.summary.workspaceId, board.summary.cwd) });
  }
  const values = [...groups.values()].filter(g => g.lanes.length);
  for (const group of values) {
    group.attentionSection = group.attention > 0;
    group.progress.percent = group.progress.requested ? Math.floor(group.progress.done * 100 / group.progress.requested) : null;
    // REQ-64 ①②: two layers — lanes that hold cards above card-less ones, whatever was placed. Inside a
    // layer a workspace the user placed keeps that place (REQ-59 ③), then REQ-57 ⑤ orders the rest.
    group.lanes.sort((a, b) => Number(b.total > 0) - Number(a.total > 0) ||
      compareByOrder(order.workspaces, a.workspaceKey, b.workspaceKey) ||
      Number(b.attention > 0) - Number(a.attention > 0) ||
      b.board.summary.updatedAt.localeCompare(a.board.summary.updatedAt) ||
      workspaceName(a.board.summary.workspaceId, a.board.summary.cwd, directory)
        .localeCompare(workspaceName(b.board.summary.workspaceId, b.board.summary.cwd, directory)) ||
      a.board.summary.id.localeCompare(b.board.summary.id));
  }
  // D22 ④: workspaces Paseo no longer has are their own group and always sit below real projects. Above
  // that, REQ-64 ① keeps projects without a card in a lower layer and REQ-59 ③ arranges each layer on its
  // own — a stored order never lifts a card-less project over one with cards.
  values.sort((a, b) => Number(!a.projectId) - Number(!b.projectId) ||
    Number(b.total > 0) - Number(a.total > 0) ||
    compareByOrder(order.projects, a.projectId, b.projectId) ||
    Number(b.attentionSection) - Number(a.attentionSection) ||
    b.latest.localeCompare(a.latest) || a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId));
  // REQ-75 A1/A4: the flat board lists every lane on its own. The same two layers as REQ-64 hold across the
  // whole board, the flat board's own order (never the grouped one) arranges each layer, and D22's
  // workspaces Paseo no longer has stay below the real ones.
  const flat = flatOrder(order);
  const lanes: FlatLane[] = values.flatMap(group => group.lanes.map(lane => ({ ...lane, group })));
  lanes.sort((a, b) => Number(!a.group.projectId) - Number(!b.group.projectId) ||
    Number(b.total > 0) - Number(a.total > 0) ||
    compareByOrder(flat, a.workspaceKey, b.workspaceKey) ||
    Number(b.attention > 0) - Number(a.attention > 0) ||
    b.board.summary.updatedAt.localeCompare(a.board.summary.updatedAt) ||
    workspaceName(a.board.summary.workspaceId, a.board.summary.cwd, directory)
      .localeCompare(workspaceName(b.board.summary.workspaceId, b.board.summary.cwd, directory)) ||
    a.board.summary.id.localeCompare(b.board.summary.id));
  return { groups: values, lanes,
    other: other.map(b => laneModel(b, states[b.summary.id], attentionOnly, options.query, options.orphaned, options.cardOrder, options.archived, options.agents))
      .filter(l => l.visible && (!filtering || l.cells.some(c => c.matchingCount > 0))),
    attention: scoped.reduce((sum, b) => sum + b.stages.flatMap(s => s.cards).filter(c => cardNeedsAttention(c, b.template.stages) || options.orphaned?.has(c.id)).length, 0),
    done: scoped.reduce((sum, b) => sum + b.summary.progress.done, 0),
    requested: scoped.reduce((sum, b) => sum + b.summary.progress.requested, 0),
  };
}
/** REQ-64 ④: the rows of the upper layer — the ones holding cards — which a move never leaves. */
export function filledProjects(groups: readonly Pick<ProjectGroup, 'projectId' | 'total'>[]): Set<string> {
  return new Set(groups.filter(g => g.total > 0).map(g => g.projectId));
}
export function filledLanes(lanes: readonly Pick<LaneView, 'workspaceKey' | 'total'>[]): Set<string> {
  return new Set(lanes.filter(l => l.total > 0).map(l => l.workspaceKey));
}
/**
 * REQ-75 A4: the flat lanes one lane moves among — the real workspaces, or the D22 ones Paseo no longer has,
 * which always sit below them — so a move never tries to cross that line.
 */
export function flatTier(lanes: readonly Pick<FlatLane, 'workspaceKey' | 'group'>[], projectId: string): string[] {
  return lanes.filter(l => !l.group.projectId === !projectId).map(l => l.workspaceKey);
}
export function collapseProject(projects: ProjectStates, lanes: LaneStates, group: Pick<ProjectGroup, 'projectId' | 'boardIds'>, collapsed: boolean) {
  const next = { ...lanes };
  for (const id of group.boardIds) next[id] = { ...next[id], collapsed, attentionCollapsed: collapsed };
  return { projects: { ...projects, [group.projectId]: collapsed }, lanes: next };
}
/**
 * REQ-85 ⑦: every workspace the board shows folded, or every one opened. Opening also opens the projects around
 * them (a folded project would keep its workspaces out of sight); folding leaves the projects as they are.
 */
export function foldAllLanes(lanes: LaneStates, projects: ProjectStates, groups: readonly Pick<ProjectGroup, 'lanes'>[], collapsed: boolean) {
  const next = { ...lanes };
  for (const lane of groups.flatMap(g => g.lanes)) next[lane.board.summary.id] = { ...next[lane.board.summary.id], collapsed, attentionCollapsed: collapsed };
  return { lanes: next, projects: collapsed ? projects : Object.fromEntries(Object.keys(projects).map(id => [id, false])) };
}
/** REQ-85 ⑦: whether every workspace shown is folded (its project folded counts), so the one glyph offers to open them. */
export function allLanesFolded(groups: readonly Pick<ProjectGroup, 'lanes' | 'collapsed'>[]): boolean {
  return groups.some(g => g.lanes.length > 0) && groups.every(g => g.collapsed || g.lanes.every(l => l.collapsed));
}
export function gridWidth(columns = 4): number { return columns * SWIMLANE.columnWidth + Math.max(0, columns - 1) * SWIMLANE.columnGap; }
/** The horizontal content of the wide board: the stage columns plus the lane indent in front of them. */
export function swimlaneWidth(columns = 4): number { return gridWidth(columns) + SWIMLANE.laneIndent; }
/** REQ-93: the height of a sub-card's parent mark, the row over its title. */
export const MARK_ROW = 16;
/** REQ-93 (보완): the mark's press area on a touch screen, the phone's web page included — 32×32 at least. */
export const MARK_TOUCH = 32;
/** REQ-99/104: the rows a lead card has under its others — the family line and the status row. */
export const LEAD_ROWS = 2;
/**
 * REQ-119: the rows a card has for being a lead — none on any other card; the status row alone on a lead with no sub-card
 * yet (its family line, with nothing to press, is not shown); both on the rest. A topic lead keeps its "0" line (REQ-117).
 */
export function leadRows(family: { total: number } | undefined, topicLead = false): number {
  return !family ? 0 : family.total || topicLead ? LEAD_ROWS : LEAD_ROWS - 1;
}
/**
 * REQ-116: whether a lead card's title, as its face shows it (REQ-95 ⑥'s short head, "Lead-03"), surely fits one line of
 * a 264px card beside its state mark and crown (about 200px of 14px bold) — read on the safe side, a wide letter (Hangul,
 * CJK) as 14.5px and any other as 9.5px, so a title that might wrap keeps its second line.
 */
export const LEAD_TITLE_WIDTH = 190;
export function leadTitleOneLine(title: string, whole = false): boolean {
  let width = 0;
  // REQ-117: a topic lead's title is shown whole (`whole`), so the whole of it is measured.
  for (const char of whole ? title : leadTitle(title)) width += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(char) ? 14.5 : 9.5;
  return width <= LEAD_TITLE_WIDTH;
}
/**
 * A card's box. REQ-93: a sub-card is one row (the parent mark and the gap under it) taller. Every card keeps room for
 * two title lines, so the cards of a column line up whatever their titles (REQ-73); REQ-116: a lead whose short title fits
 * one line (`titleLines` 1, `leadTitleOneLine`) gives the second back, so its last row — the status row — ends the card.
 * A row a card does not have is never kept: no next action, no "→" line (84 rather than 104), a lead's alike.
 */
export function cardDimensions(hasNextAction: boolean, fontScale = 1, marked = false, summarised: boolean | number = false, busy = false, titleLines: 1 | 2 = 2) {
  // REQ-99: a lead is one row taller too — its family line (16 and the gap over it) under its last row. REQ-104: and
  // one more, its status row under that line. REQ-84: a card with a busy mark, one more for its row. REQ-119: `summarised`
  // may say how many lead rows (`leadRows`), true being both.
  const rows = summarised === true ? LEAD_ROWS : summarised || 0;
  // REQ-139: counted at 100% and then scaled as one, so the box is the sum of its scaled rows.
  const base = px((hasNextAction ? 104 : 84) + (marked ? MARK_ROW + 6 : 0) + rows * (16 + 6) + (busy ? 16 + 6 : 0)
    - (titleLines === 1 ? 18 : 0));
  return { minHeight: base, ...(fontScale <= 1 ? { height: base } : {}), paddingVertical: px(10),
    paddingHorizontal: px(12), gap: px(6), titleLineHeight: px(18), metaLineHeight: px(14), nextLineHeight: px(16) };
}

/** Preserve ordinary choices while starting a fresh attention-filter view. */
export function beginAttentionFilter(states: LaneStates): LaneStates {
  return Object.fromEntries(Object.entries(states).map(([id, value]) =>
    [id, { ...value, attentionCollapsed: false, attentionSteps: value.steps ?? {} }]));
}
const BASIC_STAGES = ['todo', 'doing', 'review', 'done'] as const;
function patchSteps(states: LaneStates, id: string, attentionOnly: boolean, next: (steps: Record<string, number>) => Record<string, number>): LaneStates {
  const value = states[id] ?? {}, own = (attentionOnly ? value.attentionSteps ?? value.steps : value.steps) ?? {};
  return { ...states, [id]: { ...value, ...(attentionOnly ? { attentionSteps: next(own), attentionCollapsed: false }
    : { steps: next(own), collapsed: false }) } };
}
/** REQ-92: one press of a column's "+N" — five more cards in that column of that lane, nothing else. */
export function stepCell(states: LaneStates, id: string, stageId: string, attentionOnly: boolean): LaneStates {
  return patchSteps(states, id, attentionOnly, steps => ({ ...steps, [stageId]: (steps[stageId] ?? 0) + 1 }));
}
/**
 * REQ-93 C′ (보완): a family highlighted in a lane whose columns cut some of it off behind "+N" — each such column opens,
 * five at a time as its "+N" does, until its last card of the family shows. Nothing is folded. REQ-104: `only`, a status
 * row part's cards (REQ-109: or the not-done sub-cards), for those alone — a column holding none of them stays as it is.
 * REQ-109: what it opens is written down (`revealed`), so the highlight's end takes it back (`concealFamily`). Read from
 * the lane's own steps in `states`, not the cards drawn, so it follows a `concealFamily` queued just before it.
 */
export function revealFamily(states: LaneStates, lane: Pick<LaneView, 'board' | 'cells' | 'collapsed'>, parentId: string,
  attentionOnly: boolean, only?: readonly string[]): LaneStates {
  if (lane.collapsed) return states;
  return revealWhere(states, lane, attentionOnly, card => inFocus(card, parentId, only));
}
/**
 * research/187 J3: a draft just made from a To Do "+" (or a phone lane's ⋯) — its column opens, five at a time, until it
 * shows, written down as a highlight's opening is (`revealed`): a later "Collapse" or lane fold is the person's and wins,
 * and a highlight's end takes it back with its own. A folded lane opens too — the card was asked for there.
 */
export function revealCard(states: LaneStates, lane: Pick<LaneView, 'board' | 'cells' | 'collapsed'>, cardId: string,
  attentionOnly: boolean): LaneStates {
  const opened = lane.collapsed ? patchSteps(states, lane.board.summary.id, attentionOnly, steps => steps) : states;
  return revealWhere(opened, lane, attentionOnly, card => card.id === cardId);
}
function revealWhere(states: LaneStates, lane: Pick<LaneView, 'board' | 'cells'>, attentionOnly: boolean,
  wanted: (card: LaneView['cells'][number]['matching'][number]) => boolean): LaneStates {
  const id = lane.board.summary.id, value = states[id] ?? {};
  const own = (attentionOnly ? value.attentionSteps ?? value.steps : value.steps) ?? {};
  const need: Record<string, number> = {};
  for (const cell of lane.cells) {
    let last = -1;
    cell.matching.forEach((card, index) => { if (wanted(card)) last = index; });
    const step = Math.ceil((last + 1 - SWIMLANE.previewCount) / SWIMLANE.moreStep);
    if (step > (own[cell.stageId] ?? 0)) need[cell.stageId] = step;
  }
  if (!Object.keys(need).length) return states;
  // A column already opened by an earlier highlight not yet taken back keeps what it had before that one.
  const kept = value.revealed?.attention === attentionOnly ? value.revealed.stages : {};
  const stages = { ...kept };
  for (const [stageId, step] of Object.entries(need)) stages[stageId] = [kept[stageId]?.[0] ?? own[stageId] ?? null, step];
  const next = patchSteps(states, id, attentionOnly, steps => ({ ...steps, ...need }));
  return { ...next, [id]: { ...next[id], revealed: { attention: attentionOnly, stages } } };
}
/**
 * REQ-109: a highlight ends — every column it opened (`revealed`) goes back to the presses it had before. A column the user
 * pressed "+N" or "Collapse" on since is theirs and is left as it is; one they had opened far enough beforehand was never
 * opened by the highlight. Every lane's, so what an older highlight left (a screen closed while it was on) goes back too.
 */
export function concealFamily(states: LaneStates): LaneStates {
  const lanes = Object.entries(states).filter(([, value]) => !!value?.revealed);
  if (!lanes.length) return states;
  const next = { ...states };
  for (const [id, { revealed, ...value }] of lanes) {
    const attention = revealed!.attention, steps = { ...(attention ? value.attentionSteps ?? value.steps : value.steps) ?? {} };
    for (const [stageId, [from, to]] of Object.entries(revealed!.stages)) {
      if ((steps[stageId] ?? 0) !== to) continue;
      if (from === null) delete steps[stageId]; else steps[stageId] = from;
    }
    next[id] = { ...value, [attention ? 'attentionSteps' : 'steps']: steps };
  }
  return next;
}
/**
 * research/166 J2: on a phone, the stage tab a status part's press moves to — none while this tab lists one of the cards
 * it names (`ids`), else the tab of the first of them the lane lists.
 */
export function focusTab(cells: readonly { stageId: string; matching: readonly { id: string }[] }[], selected: string,
  ids: readonly string[]): string | null {
  const stageOf = new Map(cells.flatMap(cell => cell.matching.map(card => [card.id, cell.stageId] as const)));
  const found = ids.flatMap(id => stageOf.get(id) ?? []);
  return !found.length || found.includes(selected) ? null : found[0]!;
}
/**
 * REQ-92: a column's "Collapse" — back to its three; the lane's other columns stay as they are. REQ-115: the person's fold
 * wins over a highlight's: what REQ-109 wrote down as opened by a highlight in this column is dropped, so the highlight's
 * end never puts anything back there.
 */
export function foldCell(states: LaneStates, id: string, stageId: string, attentionOnly: boolean): LaneStates {
  const next = patchSteps(states, id, attentionOnly, steps => Object.fromEntries(Object.entries(steps).filter(([key]) => key !== stageId)));
  return forget(next, id, attentionOnly, [stageId]);
}
/** REQ-115: drop what a highlight opened in the given columns of a lane (every column when none are named). */
function forget(states: LaneStates, id: string, attentionOnly: boolean, stageIds?: readonly string[]): LaneStates {
  const { revealed, ...value } = states[id] ?? {};
  if (!revealed || revealed.attention !== attentionOnly) return states;
  const stages = stageIds ? Object.fromEntries(Object.entries(revealed.stages).filter(([key]) => !stageIds.includes(key))) : {};
  return { ...states, [id]: Object.keys(stages).length ? { ...value, revealed: { ...revealed, stages } } : value };
}
/**
 * REQ-67 ① / REQ-92: the lane glyph. Opening gives five more cards to each of `stageIds` (the columns that leave cards
 * out; all four when not said) — one "+N" press in each; folding takes every column of the lane back to three.
 */
export function expandLane(states: LaneStates, id: string, expanded: boolean, attentionOnly: boolean,
  stageIds: readonly string[] = BASIC_STAGES): LaneStates {
  const next = patchSteps(states, id, attentionOnly, steps => expanded
    ? { ...steps, ...Object.fromEntries(stageIds.map(stageId => [stageId, (steps[stageId] ?? 0) + 1])) } : {});
  // REQ-115: folding the whole lane is the person's fold too — nothing a highlight opened here is put back later.
  return expanded ? next : forget(next, id, attentionOnly);
}
