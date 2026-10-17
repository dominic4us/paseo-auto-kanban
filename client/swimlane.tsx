import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Text, View, type ScrollView as NativeScrollView } from 'react-native';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useBoardSource } from './board-source.js';
import { useBoardFilters } from './board-filters.js';
import { useHiddenProjects } from './hidden-projects.js';
import { useLaneOrder } from './ui-order.js';
import { useAutoCards, useWorkspaceAutoCards, workspaceAutoEntries, workspaceLeadEntries } from './auto-cards.js';
import { orderActions } from './order-model.js';
import { OrderMenu } from './order-menu.js';
import { useSessionValue } from './session.js';
import { useMinuteKey } from './minute-clock.js';
import { sessionFor } from './session-store.js';
import { overdueKey, swimlaneModel, allLanesFolded, concealFamily, expandLane, filledLanes, filledProjects, flatTier, foldCell, revealFamily, stepCell, SWIMLANE, swimlaneWidth,
  type LaneStates, type LaneView, type ProjectGroup } from './swimlane-model.js';
import { useCardOrder, useGroupByProject } from './settings.js';
import { FoldAllButton, GroupToggle, SortMenu } from './view-tools.js';
import { projectOptions as projectChoices, projectWorkspaceKeys, sameName, workspaceDetail, workspaceName } from './presentation.js';
import { palette } from './palette.js';
import { copy } from './i18n.js';
import { stageColor } from './stage-color.js';
import { lanePanelHeight } from './panel-style.js';
import { boardHeaderWidth, boardOffset, projectHeaderHeight, STICKY, stickyHeaderStyle } from './layout.js';
import { CellPanel } from './cell-panel.js';
import { LaneProgress } from './progress.js';
import { Button, IconButton, Notice, QuietLink, TipArea, ViewSwitch, ViewedCardContext, useViewedCard } from './components.js';
import { FamilyFocusContext, LinkedCard, useFamilyFocus } from './card-group.js';
import { bringIntoView, FreshCardContext, useFreshCard } from './fresh-card.js';
import { FilterBar } from './filter-bar.js';
import { ProjectHeader, ProjectIcon, LaneName, DemoBanner, LaneRail, TipLayer } from './group-header.js';
import { LaneUrgentBadge } from './status-icon.js';
import { useAgentLinks, useArchivedAgents, useOrphanedCards } from './agent-signals.js';
import { leadAgentIds } from './card-groups.js';
import { useSignalSource } from './signal-context.js';
import { useSignalProblem } from './agent-signals.js';
import { PreviewDetail } from './preview-detail.js';
import { Detail } from './detail.js';
import { CreateDraft } from './create.js';
import { SettingsSheet, useSettingsWindow } from './settings-sheet.js';
import { MailBadge } from './mail-badge.js';
import { MailboxButton, MailboxPanel, mailboxCount, mailWorkspaceList, useMailList } from './mailbox.js';
import { RefreshStatus } from './refresh-status.js';
import { DirectoryReadyMark, DirectoryStatus, TrackingStatus } from './directory-status.js';
import { LocalePending } from './locale-hint.js';
import { QuickMoveContext, useQuickMoves } from './quick-move.js';
import { LaneViewSwitch, WorkflowPanel } from './workflow.js';
import { laneOffer, settlePicks, toggleLaneView, type LaneViews, type PickOverrides } from './workflow-model.js';
import { TryWorkflowButton } from './workflow-pick.js';
import { ArchivedSheet, archivedDoneOf, DoneHeadTools, TidyConfirm, TidyNote, useAutoArchive } from './archive.js';
import { px } from './ui-scale.js';

export function SwimlaneScreen({ width, onList, onBoard, preview = false, onPreview = () => {}, ...props }: PluginSurfaceProps & {
  width: number; onList: () => void; onBoard: (id: string) => void; preview?: boolean; onPreview?: (value: boolean) => void;
}) {
  const scope = props.host.id + ':surface' + (preview ? ':demo' : ''), source = useBoardSource(props.host.id, preview);
  const hidden = useHiddenProjects(scope, props.host.id, source.hiddenProjects, !preview);
  // D42: the projects there now, so a hidden project whose workspaces went away is neither counted nor shown.
  const present = useMemo(() => source.projectsKnown ? new Set(projectChoices(source.boards.map(b => b.summary), source.directory, '').keys()) : null,
    [source.projectsKnown, source.boards, source.directory]);
  const state = useBoardFilters(scope, source.labels?.available === true, hidden, present), { filters, lanes, projects } = state;
  const hiddenKey = filters.hiddenProjects.join('\u0000');
  const [order, setOrder] = useLaneOrder(scope, props.host.id, source.order, !preview);
  const autoCards = useAutoCards(scope, props.host.id, source.autoCards, !preview);
  const workspaceAuto = useWorkspaceAutoCards(scope, source.autoCardsOff, !preview);
  // REQ-52: the automatic archive's days (settings), the done column's "Tidy" line and a workspace's archived list.
  const autoArchive = useAutoArchive(scope, source.autoArchive, !preview);
  const [tidy, setTidy] = useState<{ boardId: string; ask: boolean; text?: string } | null>(null);
  const [archivedOf, setArchivedOf] = useState<{ boardId: string; name: string; stages: { stageId: string; name: string }[] } | null>(null);
  // Scroll offsets never enter React state: the anchored rows follow an Animated value and the
  // session keeps the last position in a plain Map, so scrolling re-renders nothing (REQ-26 ⑨).
  const store = sessionFor(scope);
  // The horizontal view always starts at 0 so the Animated offset and the real scroll can never disagree;
  // only the vertical position is restored (contentOffset is a no-op on RN Web, honoured on native).
  const start = useRef({ y: Number(store.get('scrollY') ?? 0) }).current;
  const scrollX = useRef(new Animated.Value(0)).current;
  // REQ-75 B1: a lane whose whole name a long press has shown; a tap on the name opens the board instead.
  const [namesExpanded, setNamesExpanded] = useSessionValue<Record<string, boolean>>(scope, 'expandedNames', {});
  // REQ-75 A2/A3: one lane per workspace (flat, the default) or lanes under their project headings, remembered per host.
  const [grouped, setGrouped] = useGroupByProject(scope, props.host.id, source.settings.groupByProject, !preview);
  // REQ-79: the order of the cards in every cell, remembered per host; the workspace boards follow the same choice.
  const [cardOrder, setCardOrder] = useCardOrder(scope, props.host.id, source.settings.cardOrder, !preview);
  const [create, setCreate] = useState(false);
  // REQ-66/REQ-68: the settings window opens from ⚙, sized from the plugin area; closing it returns focus to ⚙.
  const settingsWindow = useSettingsWindow(width);
  const [createBoard, setCreateBoard] = useState<string | null>(null);
  // REQ-113: the draft sheet opened by a To Do heading's "+" — that workspace, no choosing.
  const [createLane, setCreateLane] = useState<{ boardId: string; name: string } | null>(null);
  const draftIn = (boardId: string, name: string) => { if (!preview) { setCreateBoard(boardId); setCreateLane({ boardId, name }); setCreate(true); } };
  const [detail, setDetail] = useState<{ boardId: string; cardId: string; lead?: boolean } | null>(null);
  const horizontal = useRef<NativeScrollView>(null), vertical = useRef<NativeScrollView>(null), c = palette(props.theme), m = copy(source.locale);
  const signalSource = useSignalSource();
  const orphaned = useOrphanedCards(signalSource, source.boards);
  // REQ-83: the agents' states could not be read (the demo's fixed source never fails).
  const signalProblem = useSignalProblem(signalSource);
  // REQ-102: a lead's place in a completion column depends on whether its agent is archived (card-order.ts).
  // D35: the leads' agents are looked up first; see `useArchivedAgents`.
  // REQ-117: the agents' role and parent labels find the topic leads, whose agents are looked up first too.
  const agentLinks = useAgentLinks(signalSource);
  const leadIds = useMemo(() => leadAgentIds(source.boards, agentLinks), [source.boards, agentLinks]);
  const archived = useArchivedAgents(signalSource, leadIds);
  // REQ-82 ②③: a card's "Done", its ⋯ stage menu and the "Moved to … · Undo" notice; none in the demo.
  const moves = useQuickMoves({ hostId: props.host.id, enabled: !preview, touch: props.layout.platform !== 'web', boards: source.boards,
    refresh: source.revalidate, m, colors: c, platform: props.layout.platform, navigation: props.navigation, agents: agentLinks });
  // Research/174 D2: a busy mark past two hours by the clock alone needs a person too — rebuilt when one crosses.
  const overdue = useMinuteKey(now => overdueKey(source.boards, now), source.boards.some(b => !!b.summary.busy));
  const model = useMemo(() => swimlaneModel(source.boards, source.directory, filters.hiddenProjects, filters.attention, lanes,
    { query: filters.query, labels: filters.labels, ...(source.labels ? { workspaceLabels: source.labels } : {}), projects, orphaned, order, grouped, cardOrder, archived, agents: agentLinks }),
    [source.boards, overdue, source.directory, source.labels, hiddenKey, filters.attention, filters.query, filters.labels, lanes, projects, orphaned, order, grouped, cardOrder, archived, agentLinks]);
  // REQ-59: projects move among the projects shown; the group Paseo no longer has is never among them.
  // REQ-64 ④: and among the ones in the same layer (with cards / without).
  const movable = model.groups.filter(g => g.projectId);
  const arrange = orderActions(order, setOrder, movable.map(g => g.projectId), filledProjects(movable));
  // REQ-75 A4: a project heading exists only on the grouped board, so its ⋯ always offers the project's reset.
  const projectMenu = (group: ProjectGroup) => <OrderMenu testID="project-order-menu"
    name={group.projectName || m.unlinked} {...arrange.project(group.projectId)} disabled={!group.projectId}
    onReset={() => arrange.reset(projectWorkspaceKeys(source.boards, source.directory, group.projectId))}
    canReset={arrange.canReset(projectWorkspaceKeys(source.boards, source.directory, group.projectId))}
    colors={c} m={m} platform={props.layout.platform} />;
  // REQ-75 A4: on the flat board a lane moves among all the lanes of its layer (and of its D22 tier), in the flat order.
  const filledFlat = filledLanes(model.lanes);
  const viewport = Math.max(0, width - px(32)), contentWidth = swimlaneWidth();
  const web = props.layout.platform === 'web';
  // REQ-54: the title row, filter row and demo banner share the same right edge as the board content —
  // the board's own width when it fits, or the window when the board needs to scroll sideways.
  const headerWidth = boardHeaderWidth(width, contentWidth);
  // REQ-66: the whole block moves by one offset, so the REQ-54 edges stay shared. Zero when the board
  // needs to scroll sideways (it starts at the left whatever the setting says).
  const offset = boardOffset(width, contentWidth, source.settings.boardAlign);
  // Counter-translate so lane names and notices stay readable while the columns scroll sideways.
  const anchored = { width: headerWidth, transform: [{ translateX: scrollX }] };
  // Lane rows start one indent in (REQ-45/REQ-60), so their anchored width is that much narrower and
  // they still end on the same right edge. A flat lane's header has no project above it and keeps the full width.
  const laneAnchored = { ...anchored, width: Math.max(0, anchored.width - SWIMLANE.laneIndent) };
  // Two pinned levels (REQ-42): a project header at the top of its own section, a lane header under it.
  const projectSticky = stickyHeaderStyle(c, web, 0, STICKY.projectZIndex);
  // REQ-60: a lane header steps in under its project. REQ-75 A1: a flat lane is the top row itself (the old
  // single-workspace "merged" header), so only what hangs below it (stage headings, columns) steps in — the
  // columns therefore stay where they are when the board is grouped or flattened.
  // D23: no full-width bottom edge or shadow here — in dark the edge, in light the shadow, crossed the rail and
  // the gaps between columns. The line under the stage headings is each column's own heading divider, so it
  // stays inside the column boxes, pinned or not.
  const laneSticky = (top: number, flat: boolean) => ({ ...stickyHeaderStyle(c, web, top), borderBottomWidth: 0,
    shadowOpacity: 0, elevation: 0, paddingLeft: flat ? 0 : SWIMLANE.laneIndent });
  const filteredCards = filters.attention || !!filters.query.trim();
  const patchLane = (id: string, patch: LaneStates[string]) => state.setLanes(previous => ({ ...previous, [id]: { ...previous[id], ...patch } }));
  // REQ-124 (replacing REQ-103 2단계-1's big picture): the lanes showing their workflow instead of their columns, for the
  // session only (never written). The phone shows the board in this release; the choice waits here for a wide window again.
  const [views, setViews] = useSessionValue<LaneViews>(scope, 'laneViews', {});
  const showWorkflow = (lane: LaneView, on: boolean) => {
    const id = lane.board.summary.id;
    setViews(previous => toggleLaneView(previous, id, on));
    // A folded lane opens to show it; the fold is the lane's own and the workflow sits where its columns would.
    if (on && lane.collapsed) patchLane(id, filteredCards ? { attentionCollapsed: false } : { collapsed: false });
  };
  // REQ-125 C안 1단계: a pick saved here turns its lane at once (`laneOffer`), until the board's next reading says the same.
  const [pickOverrides, setPickOverrides] = useSessionValue<PickOverrides>(scope, 'workflowPicks', {});
  const picks = settlePicks(pickOverrides, source.summaries);
  useEffect(() => { if (picks !== pickOverrides) setPickOverrides(picks); }, [picks, pickOverrides, setPickOverrides]);
  const picked = (lane: LaneView, template: string | null) => {
    const id = lane.board.summary.id;
    setPickOverrides(previous => ({ ...previous, [id]: template }));
    // REQ-125 2단계: an export (`EXPORTED_PICK`) keeps the lane on its workflow, now read from the file.
    if (template !== null) showWorkflow(lane, true);
    else setViews(previous => toggleLaneView(previous, id, false));
    source.refresh();
  };
  // REQ-92: the lane glyph gives five more cards to every column that leaves some out, or folds them all back to three.
  const expand = (lane: LaneView, expanded: boolean) => {
    const id = lane.board.summary.id, cut = lane.cells.filter(c => c.remaining > 0).map(c => c.stageId);
    const group = model.groups.find(g => g.boardIds.includes(id));
    if (group?.collapsed) state.foldProject(group, false);
    state.setLanes(previous => expandLane(previous, id, expanded, filteredCards, cut.length ? cut : undefined));
  };
  // REQ-92: a column's "+N" — five more cards in that column of that lane; the other columns and lanes stay as they are.
  const more = (lane: LaneView, stageId: string) => state.setLanes(previous => stepCell(previous, lane.board.summary.id, stageId, filteredCards));
  const openBoard = (id: string, stageId?: string) => {
    if (preview) return;
    if (stageId) sessionFor(props.host.id + ':board:' + id).set('stage', stageId);
    onBoard(id);
  };
  const toggleDemo = () => { setCreate(false); setDetail(null);
    if (!preview) sessionFor(props.host.id + ':surface:demo').clear(); onPreview(!preview); };
  const projectOptions = projectChoices(source.boards.map(b => b.summary), source.directory, m.unlinked);
  const step = (delta: number) => {
    const value = Math.max(0, Math.min(contentWidth - viewport, Number(store.get('scrollX') ?? 0) + delta));
    store.set('scrollX', value); scrollX.setValue(value);
    horizontal.current?.scrollTo({ x: value, animated: false });
  };
  // REQ-93 C′: the family a parent mark or a parent's summary line highlights; a tap on an empty spot ends it. Turned on,
  // the columns of its lane that cut some of it off open far enough to show it (REQ-92's five at a time). REQ-109: when it
  // ends, what it opened folds back (a column the user opened beforehand, or pressed since, stays as it is).
  const family = useFamilyFocus(focus => {
    const lane = [...model.groups.flatMap(g => g.lanes), ...model.lanes].find(l => l.board.summary.id === focus.boardId);
    if (lane) state.setLanes(previous => revealFamily(previous, lane, focus.parentId, filteredCards, focus.part?.ids));
  }, () => state.setLanes(concealFamily));
  // research/187 J3: a draft made from a To Do "+" opens its column as far as it needs, scrolls into sight under the
  // pinned headings and rings for two seconds.
  const allLanes = useMemo(() => [...model.groups.flatMap(g => g.lanes), ...model.lanes], [model]);
  const fresh = useFreshCard({ lanes: allLanes, setLanes: state.setLanes, attention: filteredCards,
    scroll: node => bringIntoView(vertical.current, node, Number(store.get('scrollY') ?? 0),
      projectHeaderHeight() + SWIMLANE.headerHeight + SWIMLANE.columnHeaderHeight + px(16)) });
  const previewBoard = preview ? source.boards.find(b => b.summary.id === detail?.boardId) : undefined;
  const previewCard = previewBoard?.stages.flatMap(s => s.cards).find(c => c.id === detail?.cardId);
  /**
   * One workspace lane, on either board. `flat` (REQ-75 A1) draws it as the top row with its columns stepped in
   * under it; otherwise it is a row under its project heading (REQ-60). `keys` and `filled` are the rows its
   * ⋯ moves among: the project's lanes when grouped, every lane of the same tier when flat (REQ-75 A4).
   */
  const laneSection = (lane: LaneView, group: ProjectGroup, flat: boolean, marginTop: number, last: boolean,
    keys: string[], filled: ReadonlySet<string>) => {
    const id = lane.board.summary.id, title = workspaceName(lane.board.summary.workspaceId, lane.board.summary.cwd, source.directory);
    // REQ-65 ⑥: `branch · folder` beside a lane under a project header; menus name it in full.
    const detail = workspaceDetail(source.directory, lane.board.summary.workspaceId, lane.board.summary.cwd);
    const amount = filteredCards ? lane.cells.reduce((n, c) => n + c.matchingCount, 0) : lane.total;
    const laneTop = flat ? 0 : projectHeaderHeight();
    // REQ-60 ⑤: the rail starts where the indented block starts — the lane header, or under a flat lane's
    // header — and bridges the gap to the next lane so a project reads as one block.
    const railTop = flat ? SWIMLANE.headerHeight : 0, indented = !flat || !lane.collapsed;
    const menuName = flat ? title + (sameName(title, group.projectName) || !group.projectName ? '' : ' · ' + group.projectName)
      : title + (detail ? ' · ' + detail : '');
    // REQ-124: a lane whose workspace holds a workflow definition offers its workflow, shown in place of the columns.
    // REQ-125: one with none offers "Try a workflow" there instead — a built-in, kept in Kanban only.
    const offer = laneOffer(lane.board.summary, picks[id]), offered = offer === 'workflow', big = offered && views[id] === 'workflow';
    return <TipLayer key={id} testID="swimlane-lane-section" style={{ marginTop }}>
      {/* Pinned inside this section only, so the next lane's header pushes this one out. */}
      <View testID="lane-section-header" style={laneSticky(laneTop, flat)}>
        {/* REQ-75 F1: one step above the stage headings, which come later in the page, so the name tip is drawn over them. */}
        <Animated.View testID="swimlane-lane-header" style={{ ...(flat ? anchored : laneAnchored), zIndex: 1, minHeight: SWIMLANE.headerHeight, flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
          <IconButton name={lane.collapsed ? 'ChevronRight' : 'ChevronDown'} label={(lane.collapsed ? m.expandLane : m.foldLane) + ': ' + title}
            testID="lane-disclosure" plain colors={c} mobile={false}
            onPress={() => patchLane(id, filteredCards ? { attentionCollapsed: !lane.collapsed } : { collapsed: !lane.collapsed })} />
          <ProjectIcon group={group} m={m} />
          <LaneName project={group.projectName || m.unlinked} workspace={title} detail={detail} count={lane.total} flat={flat}
            colors={c} m={m} disabled={preview} onOpen={() => openBoard(id)}
            expanded={!!namesExpanded[id]} onToggleFull={() => setNamesExpanded(v => ({ ...v, [id]: !v[id] }))} />
          {offered && <LaneViewSwitch workflow={big} onChange={on => showWorkflow(lane, on)} name={title} colors={c} m={m} disabled={preview} />}
          {offer === 'try' && <TryWorkflowButton workspaceId={lane.board.summary.workspaceId} name={title} locale={source.locale} colors={c} m={m}
            disabled={preview} onPicked={template => picked(lane, template)} />}
          {/* REQ-90: the lab's "messages waiting" badge, while it is on. */}
          <MailBadge mail={source.mail} cwd={lane.board.summary.cwd} rule={source.mailAlias} colors={c} m={m} />
          {lane.collapsed && <LaneUrgentBadge stages={lane.board.stages} colors={c} m={m} />}
          {/* REQ-57 ②: a card-less lane says so and, once opened, offers its first card. */}
          {lane.total === 0 && <Text testID="lane-empty" style={{ color: c.foregroundMuted, fontSize: px(11) }}>{m.emptyLane}</Text>}
          {lane.total === 0 && !lane.collapsed && <IconButton name="Plus" testID="lane-create" plain
            label={m.startBoard + ': ' + title} colors={c} mobile={false} disabled={preview}
            onPress={() => { if (!preview) { setCreateBoard(lane.board.summary.id); setCreateLane(null); setCreate(true); } }} />}
          <LaneProgress progress={lane.board.summary.progress} colors={c} m={m} />
          <Text style={{ color: c.foregroundMuted, fontSize: px(11) }}>{m.needsHuman} {lane.attention}</Text>
          {/* REQ-67 ①: one glyph beside ⋯ opens every column of this workspace and folds them back to three. */}
          {/* REQ-92: only while there is something to open or fold back (a folded lane opens with it too). */}
          {amount > 0 && !big && (lane.expanded || lane.collapsed || lane.cells.some(v => v.remaining > 0)) && <IconButton testID="lane-toggle" name={lane.expanded ? 'ChevronsDownUp' : 'ChevronsUpDown'} plain tooltip
            label={lane.expanded ? m.collapseCards : m.moreInLane(lane.cells.reduce((n, c) => n + c.remaining, 0))}
            colors={c} mobile={false} onPress={() => expand(lane, !lane.expanded)} />}
          <OrderMenu testID="lane-order-menu" name={menuName}
            {...(flat ? arrange.flatLane(keys, lane.workspaceKey, filled) : arrange.lane(keys, lane.workspaceKey, filled))}
            onOpenBoard={preview ? undefined : () => openBoard(id)}
            onArchived={preview || !lane.board.summary.revision ? undefined : () => setArchivedOf({ boardId: id, name: title, stages: lane.board.template.stages })}
            colors={c} m={m} platform={props.layout.platform} />
        </Animated.View>
        {/* REQ-75 B2: the done heading no longer carries "Board ›" — the workspace name is the way into the board.
            REQ-52: it says the finished cards archived ("Archived N", the list) and offers "Tidy" instead. */}
        {!lane.collapsed && !big && <View testID="lane-stage-headers" style={{ flexDirection: 'row', gap: SWIMLANE.columnGap, paddingTop: px(8),
          marginLeft: flat ? SWIMLANE.laneIndent : 0 }}>
          {/* REQ-113: the To Do heading ends in "+", a draft straight into this workspace's To Do. */}
          {lane.cells.map((cell, index) => <CellPanel key={cell.stageId} colors={c} heading={cell.name} count={cell.matchingCount}
            color={stageColor(cell.stageId, lane.board.template.stages, c)} style={{ width: SWIMLANE.columnWidth, paddingBottom: 0 }}
            {...(index === 0 ? { headingTrailing: <IconButton testID="todo-create" name="Plus" plain tooltip label={m.newDraftIn(title)}
              colors={c} mobile={false} disabled={preview} onPress={() => draftIn(id, title)} /> } : {})}
            {...(cell.countsAsDone ? { headingTrailing: <DoneHeadTools archived={archivedDoneOf(lane.board.summary)} name={title} onHead
              live={lane.board.stages.find(v => v.stageId === cell.stageId)?.totalCount ?? 0} colors={c} m={m} disabled={preview}
              onShow={() => setArchivedOf({ boardId: id, name: title, stages: lane.board.template.stages })}
              onTidy={() => setTidy({ boardId: id, ask: true })} /> } : {})} />)}
        </View>}
        {indented && <LaneRail left={SWIMLANE.railInset} top={railTop} colors={c} />}
      </View>
      {!lane.collapsed && big && <View style={{ marginLeft: SWIMLANE.laneIndent }}>
        <WorkflowPanel hostId={props.host.id} workspaceId={lane.board.summary.workspaceId} colors={c} m={m} locale={source.locale}
          onPickChange={template => picked(lane, template)}
          width={lane.cells.length * SWIMLANE.columnWidth + Math.max(0, lane.cells.length - 1) * SWIMLANE.columnGap} />
      </View>}
      {!lane.collapsed && !big && <View testID="swimlane-cells" style={{ flexDirection: 'row', alignItems: 'stretch',
        gap: SWIMLANE.columnGap, marginLeft: SWIMLANE.laneIndent }}>
        {lane.cells.map(cell => <CellPanel key={cell.stageId} testID={'swimlane-cell-' + cell.stageId} colors={c}
          style={{ width: SWIMLANE.columnWidth, minHeight: lanePanelHeight(lane.cells) - SWIMLANE.columnHeaderHeight,
            paddingTop: px(8), borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          {cell.countsAsDone && tidy?.boardId === id && (tidy.ask
            ? <TidyConfirm boardId={id} count={lane.board.stages.find(v => v.stageId === cell.stageId)?.totalCount ?? 0} colors={c} m={m}
              onClose={() => setTidy(null)} onDone={n => { setTidy({ boardId: id, ask: false, text: m.tidyDone(n) }); source.refresh(); }} />
            : <TidyNote text={tidy.text ?? ''} onClose={() => setTidy(null)} colors={c} m={m} />)}
          {/* REQ-86: a card's hint (its time in the column says three lines) hangs over the card below it, so the slot lifts
              itself while one shows (`TipLayer`). */}
          {cell.cards.map(card => <TipLayer key={card.id} testID="swimlane-card-slot" style={{ width: SWIMLANE.cardWidth }}>
            {/* REQ-93: every card in its own stage's column; a sub-card names its parent, a parent says its sub-cards. */}
            <LinkedCard stages={lane.board.template.stages} countsAsDone={cell.countsAsDone} card={card} labels={lane.board.agentLabels}
              boardId={id} colors={c} m={m} onOpen={(cardId, lead) => setDetail({ boardId: id, cardId, lead: !!lead })} />
          </TipLayer>)}
          {/* REQ-67 ② / REQ-92: what this column leaves out, faint; five more of this column in this lane per press. Every
              card shown, the same spot folds the column back; an opened done column also offers the board. REQ-115: "Collapse" sits beside "+N"
              as soon as the column shows more than three, so it folds back part way too. */}
          {(cell.remaining > 0 || cell.open) && <View testID="cell-open-links"
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
            {cell.remaining > 0 && <QuietLink testID="cell-more" label={m.moreCards(cell.remaining)}
              description={m.moreCardsLabel(cell.remaining, Math.min(SWIMLANE.moreStep, cell.remaining)) + ': ' + cell.name}
              colors={c} onPress={() => more(lane, cell.stageId)} />}
            {cell.openBoard && <QuietLink testID="cell-rest-in-board" label={m.restInBoard(cell.remaining)}
              description={m.restInBoard(cell.remaining) + ': ' + title} colors={c} disabled={preview} onPress={() => openBoard(id, cell.stageId)} />}
            {cell.open && <QuietLink testID="cell-collapse" label={m.collapseCards} description={m.collapseCards + ': ' + cell.name + ' · ' + title}
              colors={c} onPress={() => state.setLanes(previous => foldCell(previous, id, cell.stageId, filteredCards))} />}
          </View>}
        </CellPanel>)}
      </View>}
      {indented && <LaneRail left={SWIMLANE.railInset} top={railTop} bottom={last ? 0 : -SWIMLANE.laneGap} colors={c} />}
    </TipLayer>;
  };
  // REQ-128: the lab's message list — its glyph while the lab's switch is on and a folder is set, its panel over the board.
  const mailboxOn = !preview && !!source.settings.labs.mail && !!source.settings.labs.mailDir;
  const mailList = useMailList(props.host.id, mailboxOn, source.mail?.key);
  // D48: the panel stays open, with its filters and thread, when the host draws the screen anew in its other theme (the
  // session outlives that remount); closing it forgets them as before.
  const mailScope = scope + ':mailbox';
  const [mailboxOpen, setMailboxOpen] = useSessionValue(scope, 'mailboxOpen', false), [titleBottom, setTitleBottom] = useState(0);
  const closeMailbox = () => { sessionFor(mailScope).clear(); setMailboxOpen(false); };
  const mailNow = useMinuteKey(now => String(Math.floor(now / 60000)), mailboxOn);
  const mailboxBadge = mailboxOn ? mailboxCount(mailList.data, Number(mailNow) * 60000) : 0;
  const mailWorkspaces = useMemo(() => mailWorkspaceList(source.directory), [source.directory]);
  // REQ-85 ⑨: the card whose detail was just closed stays tinted until another is opened or the screen is left.
  const viewed = useViewedCard(detail?.cardId ?? null);
  if (source.localePending) return <LocalePending colors={c} />;
  return <QuickMoveContext.Provider value={moves.context}><ViewedCardContext.Provider value={viewed}>
  <FamilyFocusContext.Provider value={family.value}><FreshCardContext.Provider value={fresh.value}>
  <View testID="swimlane-screen" ref={settingsWindow.root} {...family.responder} style={{ flex: 1, minHeight: 0, padding: px(16), gap: px(8), backgroundColor: c.surface0 }}>
    {/* REQ-80: above the rows after it, so the glyphs' tips, which hang below the row, are drawn over the filters and the board. */}
    <View testID="swimlane-title-row" onLayout={event => { const { y, height } = event.nativeEvent.layout; setTitleBottom(Math.round(y + height)); }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), width: '100%', maxWidth: headerWidth, marginLeft: offset, zIndex: mailboxOpen ? 3 : 1 }}>
      <Text style={{ color: c.foreground, fontSize: px(18), fontWeight: '600' }}>{m.kanban}</Text>
      {/* REQ-78: boards still waiting for the workspace listing would make this a partial sum, so it waits too. */}
      <Text testID="swimlane-progress" style={{ color: c.foregroundMuted, fontSize: px(12) }}>{source.placing ? '…'
        : m.cardsProgress(model.done, model.requested)}</Text>
      {/* REQ-66 ④: says whether the board keeps itself fresh, so a 3-minute pause does not read as broken. */}
      <View style={{ flex: 1, minWidth: 0 }}>{!preview && <RefreshStatus status={source.refreshStatus} colors={c} m={m} />}</View>
      <IconButton name="RefreshCw" label={m.refresh} colors={c} mobile={false} disabled={preview} onPress={source.refresh} tooltip />
      <IconButton name="Plus" label={m.create} colors={c} mobile={false} disabled={preview || !source.boards.length || !!source.error}
        onPress={() => { if (!preview) { setCreateBoard(null); setCreateLane(null); setCreate(true); } }} tooltip />
      {/* REQ-81: how the board is laid out sits with how the screen is shown — group by project and the card order right
          before the view switch, which therefore keeps its place from the list view's row (where neither applies). */}
      <GroupToggle value={grouped} onChange={setGrouped} colors={c} m={m} />
      <SortMenu value={cardOrder} onChange={setCardOrder} colors={c} m={m} />
      {/* REQ-85 ⑦: fold or open every workspace, with the other ways of laying the board out. */}
      <FoldAllButton folded={allLanesFolded(model.groups)} onChange={collapsed => state.foldAll(model.groups, collapsed)}
        disabled={!model.groups.length} colors={c} m={m} />
      {/* REQ-68: no ⋯ — how to look at the boards is a pair of glyphs, everything else is in the settings window.
          ⚙ closes the row, so it keeps the right edge the search field and the done column share (REQ-54/66). */}
      {/* REQ-128: the message list, with the ways of looking at the board (a lab feature; REQ-134 MA: the phone's is in its top bar, mobile-swimlane.tsx). */}
      {mailboxOn && <MailboxButton count={mailboxBadge} open={mailboxOpen} onPress={() => mailboxOpen ? closeMailbox() : setMailboxOpen(true)} colors={c} m={m} />}
      <ViewSwitch value="swimlane" onChange={() => { if (!preview) onList(); }} disabled={preview ? ['list'] : []} colors={c} m={m} />
      <IconButton testID="open-settings" name="Settings" label={m.settings} colors={c} mobile={false} tooltip
        buttonRef={settingsWindow.opener} onPress={settingsWindow.open} />
    </View>
    {preview && <View testID="swimlane-demo-row" style={{ width: '100%', maxWidth: headerWidth, marginLeft: offset }}><DemoBanner onExit={toggleDemo} colors={c} m={m} /></View>}
    {/* REQ-26/REQ-54: the filter row lives outside both scroll views (never leaves the top) and shares the board's right edge.
        REQ-118: its glyphs' tips hang below it over the board, drawn later, so it lifts itself while one shows (`TipLayer`). */}
    <TipLayer testID="swimlane-fixed-header" style={{ width: '100%', maxWidth: headerWidth, marginLeft: offset }}><FilterBar filters={filters} onChange={state.update} onReset={state.reset}
      projects={projectOptions} labels={source.labels} attentionCount={model.attention} colors={c} m={m}
      projectsLoading={!source.projectsKnown} /></TipLayer>
    {/* One horizontal viewport contains one vertical owner. Each lane is its own sticky section. */}
    <ScrollView testID="swimlane-horizontal" horizontal ref={horizontal} style={{ flex: 1, minHeight: 0, marginLeft: offset }}
      contentContainerStyle={{ height: '100%' }} contentOffset={{ x: 0, y: 0 }}
      onScroll={event => { const value = event.nativeEvent.contentOffset.x; store.set('scrollX', value); scrollX.setValue(value); }}
      scrollEventThrottle={16}>
      {/* research/121 F1: the lanes' tips are cut at this view's edge, so they flip above against it, not the window. */}
      <ScrollView testID="swimlane-vertical" ref={vertical} style={{ width: contentWidth, height: '100%' }} contentOffset={{ x: 0, y: start.y }}
        contentContainerStyle={{ paddingBottom: px(16) }} scrollEventThrottle={16}
        onScroll={event => { store.set('scrollY', event.nativeEvent.contentOffset.y); }}>
        <TipArea.Provider value={vertical}>
        {!!source.error && <Animated.View style={anchored}><Notice text={source.error} colors={c} error /></Animated.View>}
        {source.loading && !source.ready && <Animated.View style={anchored}><Notice text={m.loading} colors={c} /></Animated.View>}
        {!!source.errors.length && <Animated.View style={anchored}><Notice text={m.partial + ' (' + source.errors.length + ')'} colors={c} error /></Animated.View>}
        {/* REQ-78 ①③: boards waiting for the workspace listing, and a listing that failed (it is read again on its own). */}
        {source.ready && (source.placing || !!source.directoryError) && <Animated.View style={anchored}>
          <DirectoryStatus placing={source.placing} error={source.directoryError} colors={c} m={m} /></Animated.View>}
        {/* REQ-83: the agents' states, the automatic tracking and the auto refresh, each said apart. */}
        <Animated.View style={anchored}><TrackingStatus signals={signalProblem} health={source.autoHealth} autoCards={autoCards[0]}
          refreshFailing={source.refreshFailing} colors={c} m={m} /></Animated.View>
        {grouped ? model.groups.map((group, groupIndex) =>
          // One section per project: its header pins at the top of it, so the next project's header
          // replaces it instead of stacking, and the lanes pin just below the project header.
          <TipLayer key={group.key} testID="swimlane-project-section" style={{ marginTop: groupIndex ? SWIMLANE.projectGap : 0 }}>
            <View testID="swimlane-project" style={projectSticky}>
              <Animated.View style={anchored}>
                <ProjectHeader group={group} colors={c} m={m} onToggle={() => state.foldProject(group, !group.collapsed)}
                  trailing={projectMenu(group)} />
              </Animated.View>
            </View>
            {!group.collapsed && group.lanes.map((lane, laneIndex) => laneSection(lane, group, false, laneIndex ? SWIMLANE.laneGap : 0,
              laneIndex === group.lanes.length - 1, group.lanes.map(l => l.workspaceKey), filledLanes(group.lanes)))}
          </TipLayer>)
          // REQ-75 A1: the flat board — one section per workspace, each as far from the next as projects are when grouped.
          : model.lanes.map((lane, laneIndex) => laneSection(lane, lane.group, true, laneIndex ? SWIMLANE.projectGap : 0, true,
            flatTier(model.lanes, lane.group.projectId), filledFlat))}
        {model.other.length > 0 && <Animated.View testID="swimlane-other" style={{ ...anchored, marginTop: px(14) }}><Notice text={m.otherTemplates} colors={c} />
          {model.other.map(lane => <Button key={lane.board.summary.id} colors={c} disabled={preview}
            label={workspaceName(lane.board.summary.workspaceId, lane.board.summary.cwd, source.directory)} onPress={() => openBoard(lane.board.summary.id)} />)}
        </Animated.View>}
        {source.ready && !source.placing && !model.groups.length && !model.other.length && <Animated.View style={anchored}>
          <Notice text={state.count ? m.noMatches : source.errors.length ? m.partial : m.noBoards} colors={c} />
          {!state.count && !source.errors.length && <Notice text={m.initialize} colors={c} />}
        </Animated.View>}
        </TipArea.Provider>
      </ScrollView>
    </ScrollView>
    {contentWidth > viewport && <View style={{ flexDirection: 'row', gap: px(8) }}>
      <Button label={m.previousColumns} colors={c} onPress={() => step(-(SWIMLANE.columnWidth + SWIMLANE.columnGap))} />
      <Button label={m.nextColumns} colors={c} onPress={() => step(SWIMLANE.columnWidth + SWIMLANE.columnGap)} />
    </View>}
    {/* REQ-128: the message list over the filters and the board, under the title row; the board stays as it was underneath. */}
    {mailboxOn && mailboxOpen && <View testID="mailbox-layer" style={{ position: 'absolute', top: titleBottom + px(8), left: 0, right: 0, bottom: 0,
      paddingHorizontal: px(16), paddingBottom: px(16), backgroundColor: c.surface0, zIndex: 2 }}>
      <MailboxPanel hostId={props.host.id} scope={mailScope} read={mailList} workspaces={mailWorkspaces} rule={source.mailAlias} onClose={closeMailbox} colors={c} m={m} />
    </View>}
    {/* REQ-66: the window holds the agent auto-card switch (REQ-61 ⑧); REQ-68: and the demo and the order reset. */}
    <SettingsSheet {...settingsWindow.sheet} hostId={props.host.id} settings={source.settings} autoCards={autoCards}
      workspaces={{ entries: workspaceAutoEntries(source.boards.map(b => b.summary), source.directory), switch: workspaceAuto }}
      leads={workspaceLeadEntries(source.boards, source.directory, agentLinks, archived, m)}
      readOnly={preview} about={source.about} connection={{ host: props.host.label, observedAt: source.observedAt }} colors={c} m={m} platform={props.layout.platform}
      demo={{ on: preview, onChange: toggleDemo }} orderReset={{ enabled: arrange.arranged, onReset: arrange.resetAll }}
      labs={{ mail: source.mail, onChange: source.revalidate }} autoArchive={autoArchive} hiddenBoards={source.hiddenBoards} />
    {/* REQ-52: a workspace's archived cards, from its ⋯ or the done column's "Archived N". */}
    {!preview && archivedOf && <ArchivedSheet open boardId={archivedOf.boardId} name={archivedOf.name} stages={archivedOf.stages}
      onClose={() => setArchivedOf(null)} onChanged={source.refresh} colors={c} m={m} platform={props.layout.platform} />}
    {preview && previewBoard && previewCard && <PreviewDetail board={previewBoard} card={previewCard} colors={c} m={m}
      platform={props.layout.platform} onClose={() => setDetail(null)} />}
    {!preview && detail && <Detail {...props} {...detail} locale={source.locale} onClose={() => setDetail(null)} onChanged={source.refresh} />}
    {!preview && create && <CreateDraft {...props} boards={source.summaries} directory={source.directory} locale={source.locale}
      {...(createBoard ? { initialBoardId: createBoard } : {})} lane={createLane ?? undefined}
      onClose={() => setCreate(false)} onChanged={source.refresh} onSaved={fresh.created}
      onCreated={(boardId, cardId) => { setCreate(false); setDetail({ boardId, cardId }); }} />}
    {!preview && source.directorySettled && <DirectoryReadyMark />}
    {moves.layer()}
  </View>
  </FreshCardContext.Provider></FamilyFocusContext.Provider>
  </ViewedCardContext.Provider></QuickMoveContext.Provider>;
}
