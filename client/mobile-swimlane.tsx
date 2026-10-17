import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
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
import { mobileSwimlaneModel, attentionStage } from './mobile-model.js';
import { concealFamily, expandLane, filledLanes, overdueKey, filledProjects, flatTier, foldCell, focusTab, revealFamily, stepCell, SWIMLANE, type ProjectGroup } from './swimlane-model.js';
import { useCardOrder, useGroupByProject } from './settings.js';
import { stageColor } from './stage-color.js';
import { crowdedTitleRow, glyphLine, MOBILE } from './mobile-layout.js';
import { bottomClearance, projectHeaderHeight, STICKY, stickyHeaderStyle } from './layout.js';
import { palette } from './palette.js';
import { copy } from './i18n.js';
import { projectOptions as projectChoices, projectWorkspaceKeys, sameName, workspaceDetail, workspaceName } from './presentation.js';
import { MobileControls } from './mobile-controls.js';
import { Button, IconButton, Notice, QuietLink, TipArea, ViewedCardContext, useViewedCard } from './components.js';
import { FamilyFocusContext, LinkedCard, useFamilyFocus } from './card-group.js';
import { bringIntoView, FreshCardContext, useFreshCard } from './fresh-card.js';
import { CellPanel } from './cell-panel.js';
import { FilterBar } from './filter-bar.js';
import { ProjectHeader, ProjectIcon, LaneName, DemoBanner, LaneRail, TipLayer } from './group-header.js';
import { LaneUrgentBadge } from './status-icon.js';
import { useAgentLinks, useArchivedAgents, useOrphanedCards, useSignalProblem } from './agent-signals.js';
import { leadAgentIds } from './card-groups.js';
import { useSignalSource } from './signal-context.js';
import { MenuSheet } from './menu-sheet.js';
import { PreviewDetail } from './preview-detail.js';
import { Detail } from './detail.js';
import { CreateDraft } from './create.js';
import type { BoardFilters } from './filter-model.js';
import { SettingsSheet, useSettingsWindow } from './settings-sheet.js';
import { MailBadge } from './mail-badge.js';
import { RefreshStatus } from './refresh-status.js';
import { QuickMoveContext, useQuickMoves } from './quick-move.js';
import { DirectoryReadyMark, DirectoryStatus, TrackingStatus } from './directory-status.js';
import { LocalePending } from './locale-hint.js';
import { offersWorkflow } from './workflow-model.js';
import { MobileWorkflowSheet, type WorkflowTarget } from './mobile-workflow.js';
import { WorkflowPickSheet } from './workflow-pick.js';
import { mailboxCount, mailWorkspaceList, useMailList } from './mailbox.js';
import { MobileMailboxSheet } from './mobile-mailbox.js';
import { EMPTY_MAIL_FILTER } from './mail-list-model.js';
import { mailAlias } from '../shared/mailbox.js';
import { ArchivedSheet, archivedDoneOf, DoneHeadTools, TidyConfirm, TidyNote, useAutoArchive } from './archive.js';
import { px } from './ui-scale.js';

export function MobileSwimlaneScreen({ width, onList, onBoard, preview = false, onPreview = () => {}, ...props }: PluginSurfaceProps & {
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
  // REQ-52: as on the wide board — the days (settings), "Tidy" on the Done tab and a workspace's archived list (its ⋯ sheet).
  const autoArchive = useAutoArchive(scope, source.autoArchive, !preview);
  const [tidy, setTidy] = useState<{ boardId: string; ask: boolean; text?: string } | null>(null);
  const [archivedOf, setArchivedOf] = useState<{ boardId: string; name: string; stages: { stageId: string; name: string }[] } | null>(null);
  // REQ-148: '' until a tab is chosen (or the screen opened on one, below); the tab shown is the model's `stageId`.
  const [chosen, setSelected] = useSessionValue(scope, 'mobileStage', '');
  const [beforeAttention, setBeforeAttention] = useSessionValue(scope, 'mobileBeforeAttention', 'doing');
  // The stage tabs already sit outside the scroll view; the vertical offset stays out of React state (REQ-26 ⑨).
  const store = sessionFor(scope), startY = useRef(Number(store.get('mobileScrollY') ?? 0)).current, sections = useRef(null);
  // REQ-75 B1: a long press on a workspace name shows it whole; a tap opens its board.
  const [namesExpanded, setNamesExpanded] = useSessionValue<Record<string, boolean>>(scope, 'expandedNames', {});
  // REQ-75 A2/A3: the same switch as the wide board, in the filter sheet.
  const [grouped, setGrouped] = useGroupByProject(scope, props.host.id, source.settings.groupByProject, !preview);
  // REQ-79: the card order, as on the wide board; its row sits under the grouping switch in the filter sheet (REQ-81).
  const [cardOrder, setCardOrder] = useCardOrder(scope, props.host.id, source.settings.cardOrder, !preview);
  const [filtersOpen, setFiltersOpen] = useState(false), [create, setCreate] = useState(false);
  // REQ-66/REQ-68: the settings sheet opens from ⚙, sized from the plugin area, and hands focus back to ⚙.
  const settingsWindow = useSettingsWindow(width);
  const [createBoard, setCreateBoard] = useState<string | null>(null);
  // REQ-113: the draft sheet for one workspace, no choosing — research/187 J2: opened from its ⋯ sheet's "New draft".
  const [createLane, setCreateLane] = useState<{ boardId: string; name: string } | null>(null);
  const draftIn = (boardId: string, name: string) => { if (!preview) { setCreateBoard(boardId); setCreateLane({ boardId, name }); setCreate(true); } };
  const [detail, setDetail] = useState<{ boardId: string; cardId: string; lead?: boolean } | null>(null);
  // REQ-134 WA: the workflow sheet a lane's ⋯ opened (session only, so the host's theme remount keeps it open, as D48).
  const [workflow, setWorkflow] = useSessionValue<WorkflowTarget | null>(scope, 'mobileWorkflow', null);
  // REQ-125 C안 1단계: the built-in list a lane's ⋯ "Try a workflow" opened; a pick opens that lane's workflow sheet at once.
  const [trying, setTrying] = useSessionValue<WorkflowTarget | null>(scope, 'mobileWorkflowTry', null);
  // REQ-134 MA: the lab's message list — the wide rule (the switch on, a folder set, not the demo), its reading and its count.
  const mailboxOn = !preview && !!source.settings.labs.mail && !!source.settings.labs.mailDir;
  const mailList = useMailList(props.host.id, mailboxOn, source.mail?.key);
  const mailScope = scope + ':mailbox', mailNow = useMinuteKey(now => String(Math.floor(now / 60000)), mailboxOn);
  const mailboxBadge = mailboxOn ? mailboxCount(mailList.data, Number(mailNow) * 60000) : 0;
  const [mailboxOpen, setMailboxOpen] = useSessionValue(scope, 'mailboxOpen', false);
  const mailWorkspaces = useMemo(() => mailWorkspaceList(source.directory), [source.directory]);
  const openMailbox = (to?: string) => {
    sessionFor(mailScope).clear();
    if (to) sessionFor(mailScope).set('filter', { ...EMPTY_MAIL_FILTER, to: [to] });
    setMailboxOpen(true);
  };
  const closeMailbox = () => { sessionFor(mailScope).clear(); setMailboxOpen(false); };
  const c = palette(props.theme), m = copy(source.locale), bottom = bottomClearance(props.layout.platform);
  // REQ-42 on 390px too: the project heading pins at the top of its group, the workspace heading below it.
  const web = props.layout.platform === 'web';
  const projectSticky = stickyHeaderStyle(c, web, 0, STICKY.projectZIndex);
  const sticky = (top: number) => stickyHeaderStyle(c, web, top);
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
  // REQ-82 ②③: "Done" always shows on an archived card here, and a long press opens the stage menu; none in the demo.
  const moves = useQuickMoves({ hostId: props.host.id, enabled: !preview, touch: true, boards: source.boards,
    refresh: source.revalidate, m, colors: c, platform: props.layout.platform, navigation: props.navigation, agents: agentLinks });
  const options = { query: filters.query, labels: filters.labels, ...(source.labels ? { workspaceLabels: source.labels } : {}), projects, orphaned, order, grouped, cardOrder, archived, agents: agentLinks };
  // Research/174 D2: a busy mark past two hours by the clock alone needs a person too — rebuilt when one crosses.
  const overdue = useMinuteKey(now => overdueKey(source.boards, now), source.boards.some(b => !!b.summary.busy));
  const model = useMemo(() => mobileSwimlaneModel(source.boards, source.directory, filters.hiddenProjects, filters.attention, lanes, chosen, options),
    [source.boards, overdue, source.directory, source.labels, hiddenKey, filters.attention, filters.query, filters.labels, lanes, chosen, projects, orphaned, order, grouped, cardOrder, archived, agentLinks]);
  const selected = model.stageId;
  // REQ-148: once there are cards, the tab the screen opened on is kept as if chosen, so it does not jump under a person when
  // its cards move on; a tab a person picks (or a board opened at one) is kept as before, for the session.
  const opened = !chosen && model.stages.some(s => s.count > 0);
  useEffect(() => { if (opened) setSelected(selected); }, [opened, selected]);
  // REQ-148: the tabs say the wide board's names ("In progress", once "Doing" on a phone); mobile-controls.tsx makes room for them.
  const stageNames = [m.waitingStage, m.doingStage, m.reviewStage, m.doneStage];
  const stages = model.stages.map((s, i) => ({ ...s, name: stageNames[i]!,
    color: stageColor(s.stageId, model.stages.map(v => ({ stageId: v.stageId, countsAsDone: v.stageId === 'done' })), c) }));
  const updateFilters = (patch: Partial<BoardFilters>) => {
    const next = { ...filters, ...patch }; state.update(patch);
    if (patch.attention === true) setBeforeAttention(selected);
    if (patch.attention === false) { setSelected(beforeAttention); return; }
    const view = mobileSwimlaneModel(source.boards, source.directory, next.hiddenProjects, next.attention, {}, selected,
      { query: next.query, labels: next.labels, ...(source.labels ? { workspaceLabels: source.labels } : {}), orphaned, archived });
    if (!view.stages.find(s => s.stageId === selected)?.count) setSelected(attentionStage(view.stages));
  };
  const projectOptions = projectChoices(source.boards.map(b => b.summary), source.directory, m.unlinked);
  const openBoard = (id: string, stageId: string, clearAttention = false) => {
    if (preview) return;
    const board = sessionFor(props.host.id + ':board:' + id); board.set('stage', stageId);
    if (clearAttention) board.set('attention', false); onBoard(id);
  };
  // REQ-68: the filter sheet opens from its own button in the top bar (once "Filters" in ⋯) and hands focus back to it.
  const filterButton = useRef<View>(null), restoreFilters = useRef(false);
  const openFilters = () => { restoreFilters.current = true; setFiltersOpen(true); };
  const restoreFilterFocus = () => { if (restoreFilters.current && !filtersOpen) { restoreFilters.current = false; filterButton.current?.focus(); } };
  const toggleDemo = () => { setFiltersOpen(false); setCreate(false); setDetail(null);
    if (!preview) sessionFor(props.host.id + ':surface:demo').clear(); onPreview(!preview); };
  const previewBoard = preview ? source.boards.find(b => b.summary.id === detail?.boardId) : undefined;
  const previewCard = previewBoard?.stages.flatMap(s => s.cards).find(c => c.id === detail?.cardId);
  const visibleGroups = model.groups.filter(g => model.sections.some(s => s.group.key === g.key));
  // REQ-59 ④: the same order as the wide board; a move acts on the rows this stage tab is showing.
  // REQ-64 ④: a move stays among the rows of the same layer (with cards / without).
  const movable = visibleGroups.filter(g => g.projectId);
  const arrange = orderActions(order, setOrder, movable.map(g => g.projectId), filledProjects(movable));
  const projectMenu = (group: ProjectGroup) => <OrderMenu testID="project-order-menu" mobile
    name={group.projectName || m.unlinked} {...arrange.project(group.projectId)} disabled={!group.projectId}
    onReset={() => arrange.reset(projectWorkspaceKeys(source.boards, source.directory, group.projectId))}
    canReset={arrange.canReset(projectWorkspaceKeys(source.boards, source.directory, group.projectId))}
    colors={c} m={m} platform={props.layout.platform} />;
  const indent = SWIMLANE.mobileLaneIndent, rail = SWIMLANE.mobileRailInset;
  // REQ-75 A4: on the flat board a workspace moves among the workspaces this stage tab shows, in the flat order.
  const flatKeys = (projectId: string) => flatTier(model.sections.map(v => ({ workspaceKey: v.lane.workspaceKey, group: v.group })), projectId);
  const filledFlat = filledLanes(model.sections.map(v => v.lane));
  type Section = (typeof model.sections)[number];
  /**
   * One workspace section, on either board. REQ-60 ⑥: everything in it steps in by the 390px indent. `flat`
   * (REQ-75 A1) makes its heading the top row, stepping back out over the indent (its opaque background
   * hides the rail there) — the old single-workspace heading; otherwise the heading pins under its project's.
   */
  const workspaceSection = (section: Section, flat: boolean, marginTop: number, keys: string[], filled: ReadonlySet<string>) => {
    const { lane, cell, group } = section;
    const id = lane.board.summary.id, name = workspaceName(lane.board.summary.workspaceId, lane.board.summary.cwd, source.directory);
    const detail = workspaceDetail(source.directory, lane.board.summary.workspaceId, lane.board.summary.cwd);
    const filtered = filters.attention || !!filters.query.trim();
    // REQ-92: the glyph gives five more to the columns that leave cards out (this tab's among them), or folds them all back.
    const toggle = (expanded: boolean) => {
      if (group.collapsed) state.foldProject(group, false);
      const more = lane.cells.filter(v => v.remaining > 0).map(v => v.stageId);
      state.setLanes(v => expandLane(v, id, expanded, filtered, more.length ? more : undefined));
    };
    const menuName = flat ? name + (sameName(name, group.projectName) || !group.projectName ? '' : ' · ' + group.projectName)
      : name + (detail ? ' · ' + detail : '');
    // research/179 D1: a tip hanging from the heading (the mail badge's) runs past a short section, and the next section,
    // drawn later, would cover it; while one shows, this section and its project lift themselves (`TipLayer`, REQ-86).
    return <TipLayer key={id} testID={'mobile-workspace-' + id} style={{ paddingLeft: indent, marginTop }}>
      {/* Pinned inside this workspace section only, so the next section's heading pushes it out. */}
      <View testID="mobile-workspace-heading" style={{ ...sticky(flat ? 0 : projectHeaderHeight()),
        minHeight: MOBILE.contextHeight, flexDirection: 'row', alignItems: 'center', gap: px(4), marginLeft: flat ? -indent : 0 }}>
        <ProjectIcon group={group} m={m} />
        <LaneName project={group.projectName || m.unlinked} workspace={name} detail={detail} count={lane.total} flat={flat} compact
          colors={c} m={m} disabled={preview} onOpen={() => openBoard(id, selected)}
          expanded={!!namesExpanded[id]} onToggleFull={() => setNamesExpanded(v => ({ ...v, [id]: !v[id] }))} />
        {lane.collapsed && <LaneUrgentBadge stages={lane.board.stages} colors={c} m={m} compact />}
        {lane.total === 0 && <Text testID="lane-empty" style={{ color: c.foregroundMuted, fontSize: px(10), lineHeight: px(14) }}>{m.emptyLane}</Text>}
        {/* research/210 (208-D1): the figures give way (cut with …) before the name does; the name keeps its floor (`nameFloor`). */}
        <Text testID="lane-cards-progress" numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: c.foregroundMuted, fontSize: px(10), lineHeight: px(14) }}>{m.cardsProgress(lane.board.summary.progress.done, lane.board.summary.progress.requested)}</Text>
        <Text testID="lane-needs-human" numberOfLines={1} accessibilityLabel={m.needsHuman + ' ' + lane.attention} style={{ flexShrink: 1, minWidth: 0, color: c.foregroundMuted, fontSize: px(10), lineHeight: px(14) }}>{m.needsHuman} {lane.attention}</Text>
        {/* REQ-90: the lab's "messages waiting" badge, while it is on; a press shows its threads. research/179 J3: the envelope
            and the number only, at the right end by the controls, so the name next to it keeps what room there is. */}
        {/* REQ-134 MA: with the message list there, a press opens it filtered to this workspace (To = its short name) instead of the tip. */}
        <MailBadge mail={source.mail} cwd={lane.board.summary.cwd} rule={source.mailAlias} colors={c} m={m} compact
          onOpen={mailboxOn ? () => openMailbox(mailAlias(lane.board.summary.cwd, source.mailAlias) || undefined) : undefined} />
        {/* REQ-67 ① on 390px: the glyph and ⋯ close the heading as on the wide board, so they stay pinned while the
            cards scroll. The 44px boxes hang over the 16px line, so the first card stays at 168px (D1). REQ-75 B2:
            no "Board ›" — the workspace name opens the board. No tooltip here: a tap leaves the glyph focused, and
            its label would cover the heading. */}
        <View testID="mobile-heading-controls" style={{ flexDirection: 'row', alignItems: 'center', height: MOBILE.touchSize,
          marginVertical: (MOBILE.contextHeight - MOBILE.touchSize) / 2 }}>
          {/* REQ-124: no "Workflow" glyph here (research/210 D1's room); REQ-134 WA: its ⋯ sheet opens it instead. */}
          {lane.total > 0 && (lane.collapsed || cell.remaining > 0 || lane.expanded) && <IconButton testID="lane-toggle" mobile plain
            name={lane.expanded ? 'ChevronsDownUp' : 'ChevronsUpDown'} iconSize={px(18)}
            label={lane.expanded ? m.collapseCards : m.moreInLane(lane.cells.reduce((n, v) => n + v.remaining, 0))} colors={c}
            onPress={() => toggle(!lane.expanded)} />}
          <OrderMenu testID="lane-order-menu" mobile name={menuName}
            {...(flat ? arrange.flatLane(keys, lane.workspaceKey, filled) : arrange.lane(keys, lane.workspaceKey, filled))}
            onOpenBoard={preview ? undefined : () => openBoard(id, selected)} onDraft={preview ? undefined : () => draftIn(id, name)}
            onWorkflow={!preview && offersWorkflow(lane.board) ? () => setWorkflow({ workspaceId: lane.board.summary.workspaceId, name }) : undefined}
            onTryWorkflow={!preview && !offersWorkflow(lane.board) ? () => setTrying({ workspaceId: lane.board.summary.workspaceId, name }) : undefined}
            onArchived={preview || !lane.board.summary.revision ? undefined : () => setArchivedOf({ boardId: id, name, stages: lane.board.template.stages })}
            colors={c} m={m} platform={props.layout.platform} />
        </View>
      </View>
      <CellPanel colors={c} testID="mobile-cell-panel">
        {/* REQ-52: the Done tab says the finished cards archived beside the list and offers "Tidy" — the phone has no column head. */}
        {cell.countsAsDone && <DoneHeadTools archived={archivedDoneOf(lane.board.summary)} name={name} mobile colors={c} m={m} disabled={preview}
          live={lane.board.stages.find(v => v.stageId === cell.stageId)?.totalCount ?? 0}
          onShow={() => setArchivedOf({ boardId: id, name, stages: lane.board.template.stages })} onTidy={() => setTidy({ boardId: id, ask: true })} />}
        {cell.countsAsDone && tidy?.boardId === id && (tidy.ask
          ? <TidyConfirm boardId={id} count={lane.board.stages.find(v => v.stageId === cell.stageId)?.totalCount ?? 0} colors={c} m={m} mobile
            onClose={() => setTidy(null)} onDone={n => { setTidy({ boardId: id, ask: false, text: m.tidyDone(n) }); source.refresh(); }} />
          : <TidyNote text={tidy.text ?? ''} onClose={() => setTidy(null)} colors={c} m={m} mobile />)}
        {cell.cards.map(card =>
        <LinkedCard key={card.id} stages={lane.board.template.stages} countsAsDone={cell.countsAsDone} card={card} labels={lane.board.agentLabels}
          boardId={id} colors={c} m={m} onOpen={(cardId, lead) => setDetail({ boardId: id, cardId, lead: !!lead })} mobile />)}
        {/* REQ-67 ② / REQ-92: the faint "+N" shows five more of this tab's cards in this workspace; every card shown, the
            same spot folds it back; an opened done list also offers the board. REQ-115: "Collapse" beside "+N" part way too. */}
        {(cell.remaining > 0 || cell.open) && <View testID="cell-open-links"
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
          {cell.remaining > 0 && <QuietLink testID="cell-more" mobile label={m.moreCards(cell.remaining)}
            description={m.moreCardsLabel(cell.remaining, Math.min(SWIMLANE.moreStep, cell.remaining)) + ': ' + name} colors={c}
            onPress={() => state.setLanes(v => stepCell(v, id, cell.stageId, filtered))} />}
          {cell.openBoard && <QuietLink testID="cell-rest-in-board" mobile label={m.restInBoard(cell.remaining)}
            description={m.restInBoard(cell.remaining) + ': ' + name} colors={c} disabled={preview} onPress={() => openBoard(id, selected, true)} />}
          {cell.open && <QuietLink testID="cell-collapse" mobile label={m.collapseCards} description={m.collapseCards + ': ' + name}
            colors={c} onPress={() => state.setLanes(v => foldCell(v, id, cell.stageId, filtered))} />}
        </View>}</CellPanel>
      {/* REQ-57 ②/⑥: the card-less workspace offers its first card right where its cards would be. */}
      {lane.total === 0 && <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Button testID="lane-create" label={m.startBoard} colors={c} mobile disabled={preview}
          onPress={() => { if (!preview) { setCreateBoard(lane.board.summary.id); setCreateLane(null); setCreate(true); } }} />
      </View>}
      <LaneRail left={rail} colors={c} />
    </TipLayer>;
  };
  // REQ-93 C′: the family a parent mark or a parent's summary line highlights; a tap on an empty spot ends it, a scroll or
  // another stage tab keeps it. Turned on, the workspace's lists that cut some of it off open far enough to show it.
  // research/166 J2: a status part whose cards are all in other tabs moves to the first one's tab (`focusTab`).
  // REQ-109: when it ends, what it opened folds back, and a tab it moved to goes back unless another was chosen since.
  const tabMoved = useRef<{ from: string; to: string } | null>(null), shownTab = useRef(selected);
  shownTab.current = selected;
  const family = useFamilyFocus(focus => {
    const lane = model.sections.find(s => s.lane.board.summary.id === focus.boardId)?.lane;
    if (lane) state.setLanes(v => revealFamily(v, lane, focus.parentId, filters.attention || !!filters.query.trim(), focus.part?.ids));
    const tab = lane && focus.part ? focusTab(lane.cells, shownTab.current, focus.part.ids) : null;
    if (tab) { tabMoved.current = { from: tabMoved.current?.from ?? shownTab.current, to: tab }; shownTab.current = tab; setSelected(tab); }
  }, () => {
    state.setLanes(concealFamily);
    const moved = tabMoved.current;
    tabMoved.current = null;
    if (moved && shownTab.current === moved.to) { shownTab.current = moved.from; setSelected(moved.from); }
  });
  // research/187 J3: a draft made from a lane's ⋯ moves to its tab (To Do), opens its list as far as it needs, scrolls
  // into sight under the pinned headings and rings for two seconds.
  const allLanes = useMemo(() => [...model.groups.flatMap(g => g.lanes), ...model.lanes], [model]);
  const fresh = useFreshCard({ lanes: allLanes, setLanes: state.setLanes, attention: filters.attention || !!filters.query.trim(),
    onStage: stageId => { if (shownTab.current !== stageId) { shownTab.current = stageId; setSelected(stageId); } },
    scroll: node => bringIntoView(sections.current, node, Number(store.get('mobileScrollY') ?? 0),
      projectHeaderHeight() + MOBILE.touchSize + px(8)) });
  // REQ-85 ⑨: the card whose detail was just closed stays tinted until another is opened or the screen is left.
  const viewed = useViewedCard(detail?.cardId ?? null);
  if (source.localePending) return <LocalePending colors={c} />;
  // REQ-68: no ⋯. What it held is a glyph here — filters, refresh, the view — or in the settings sheet (⚙).
  // The view is one glyph that goes to the other view: two joined 44px glyphs would leave the title no room.
  // REQ-139: filters, refresh, +, the mailbox when on, the view and ⚙.
  const glyphs = [
    // REQ-91: always the same filter glyph; with filters applied it is on (REQ-85 tint, glyph in the main colour) and carries how many.
    <IconButton key="filters" testID="open-filters" name="ListFilter" label={state.count > 0 ? m.filtersApplied(state.count) : m.filters} colors={c} mobile
      on={state.count > 0} badge={state.count} buttonRef={filterButton} onPress={openFilters} />,
    <IconButton key="refresh" name="RefreshCw" label={m.refresh} colors={c} mobile disabled={preview} onPress={source.refresh} />,
    <IconButton key="create" name="Plus" label={m.create} colors={c} mobile disabled={preview || !source.boards.length || !!source.error}
      onPress={() => { if (!preview) { setCreateBoard(null); setCreateLane(null); setCreate(true); } }} />,
    // REQ-134 MA: after +, as research/267 drew it; a sixth glyph cuts the status words ("자동…") before the title.
    ...(mailboxOn ? [<IconButton key="mailbox" testID="mailbox-button" name="Mail" label={m.mailboxOpen(mailboxBadge)} colors={c} mobile on={mailboxOpen}
      badge={mailboxBadge} onPress={() => openMailbox()} />] : []),
    <IconButton key="view" testID="view-toggle" name="List" label={m.listView} colors={c} mobile disabled={preview}
      onPress={() => { if (!preview) onList(); }} />,
    <IconButton key="settings" testID="open-settings" name="Settings" label={m.settings} colors={c} mobile
      buttonRef={settingsWindow.opener} onPress={settingsWindow.open} />,
  ];
  const crowded = crowdedTitleRow(width, glyphs.length, px(4));
  // D60: crowded, the glyphs keep one line under the title — closer together, or the last beside the title.
  const line = crowded ? glyphLine(width, glyphs.length, px(4)) : { lifted: 0, gap: px(4) };
  const lifted = line.lifted ? glyphs.splice(glyphs.length - line.lifted) : null;
  // REQ-139: a size that leaves the title no room puts it on a line of its own, over the glyphs.
  const title = <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: px(8),
    ...(crowded && !lifted ? { flexBasis: '100%' as const, height: MOBILE.appbarHeight, alignItems: 'center' as const } : {}) }}>
    {/* REQ-68: five glyphs leave the title about 130px; the title keeps its width and the status line gives way. */}
    <Text numberOfLines={1} style={{ flexShrink: 0, color: c.foreground, fontSize: px(18), fontWeight: '600' }}>{m.kanban}</Text>
    {/* REQ-78: inside the title, so the 390px screen keeps its three rows (the 168px budget counts them). */}
    {!preview && source.directorySettled && <DirectoryReadyMark />}
    {!preview && <RefreshStatus status={source.refreshStatus} colors={c} m={m} compact />}
  </View>;
  return <QuickMoveContext.Provider value={moves.context}><ViewedCardContext.Provider value={viewed}>
  <FamilyFocusContext.Provider value={family.value}><FreshCardContext.Provider value={fresh.value}>
  <View testID="mobile-swimlane-screen" {...family.responder} style={{ flex: 1, minHeight: 0, paddingHorizontal: MOBILE.horizontalPadding,
    paddingBottom: bottom, backgroundColor: c.surface0 }}>
    <View testID="mobile-appbar" style={{ ...(crowded ? { minHeight: MOBILE.appbarHeight, flexWrap: 'wrap' as const, justifyContent: 'flex-end' as const }
      : { height: MOBILE.appbarHeight }), flexDirection: 'row', alignItems: 'center', ...(line.gap < px(4) ? { rowGap: px(4), columnGap: line.gap } : { gap: px(4) }) }}>
      {lifted ? <View testID="mobile-title-line" style={{ flex: 1, flexBasis: '100%', height: MOBILE.appbarHeight, flexDirection: 'row', alignItems: 'center', gap: px(4) }}>
        {title}{lifted}</View> : title}
      {glyphs}
    </View>
    {preview && <DemoBanner mobile onExit={toggleDemo} colors={c} m={m} />}
    <MobileControls stages={stages} selected={selected} attention={filters.attention} count={model.attention}
      onStage={setSelected} onAttention={() => updateFilters({ attention: !filters.attention })} colors={c} m={m} />
    <ScrollView testID="mobile-workspace-sections" ref={sections} style={{ flex: 1, minHeight: 0 }} contentOffset={{ x: 0, y: startY }}
      onScroll={event => { store.set('mobileScrollY', event.nativeEvent.contentOffset.y); }} scrollEventThrottle={16}
      contentContainerStyle={{ paddingBottom: bottom }}>
      {source.loading && !source.ready && <Notice text={m.loading} colors={c} />}
      {!!source.error && <Notice text={source.error} colors={c} error />}
      {!!source.errors.length && <Notice text={m.partial} colors={c} error />}
      {/* REQ-78 ①③: the same quiet lines as the wide board — boards waiting for the workspace listing, a failed listing. */}
      {source.ready && <DirectoryStatus placing={source.placing} error={source.directoryError} colors={c} m={m} />}
      {/* REQ-83: the agents' states, the automatic tracking and the auto refresh, each said apart. */}
      <TrackingStatus signals={signalProblem} health={source.autoHealth} autoCards={autoCards[0]} refreshFailing={source.refreshFailing} colors={c} m={m} />
      {/* research/179 D1: tips are cut at this view's edge, so one near its bottom hangs above instead (research/121 F1). */}
      <TipArea.Provider value={sections}>
      {grouped ? visibleGroups.map((group, groupIndex) => <TipLayer key={group.key} testID="mobile-project-group" style={{ marginTop: groupIndex ? MOBILE.projectGap : 0 }}>
        <View testID="mobile-project-heading" style={projectSticky}>
          <ProjectHeader group={group} onToggle={() => state.foldProject(group, !group.collapsed)} colors={c} m={m} mobile
            trailing={projectMenu(group)} />
        </View>
        {!group.collapsed && model.sections.filter(v => v.group.key === group.key).map((section, _index, shown) =>
          workspaceSection(section, false, 0, shown.map(v => v.lane.workspaceKey), filledLanes(shown.map(v => v.lane))))}
      </TipLayer>)
        // REQ-75 A1: the flat board — every workspace on its own, as far apart as projects are when grouped.
        : model.sections.map((section, index) => workspaceSection(section, true, index ? MOBILE.projectGap : 0,
          flatKeys(section.group.projectId), filledFlat))}
      </TipArea.Provider>
      {source.ready && !source.placing && !model.sections.length && <Notice text={state.count ? m.noMatches : !source.boards.length ? m.noBoards : m.noCards} colors={c} />}
      {source.ready && !source.placing && !source.boards.length && !source.errors.length && <Notice text={m.initialize} colors={c} />}
      {model.other.length > 0 && <View style={{ marginTop: px(12) }}><Notice text={m.otherTemplates} colors={c} />
        {model.other.map(lane => <Button key={lane.board.summary.id} label={workspaceName(lane.board.summary.workspaceId, lane.board.summary.cwd, source.directory)}
          colors={c} mobile disabled={preview} onPress={() => openBoard(lane.board.summary.id, selected)} />)}
      </View>}
    </ScrollView>
    <SettingsSheet {...settingsWindow.sheet} hostId={props.host.id} settings={source.settings} autoCards={autoCards} readOnly={preview}
      workspaces={{ entries: workspaceAutoEntries(source.boards.map(b => b.summary), source.directory), switch: workspaceAuto }}
      leads={workspaceLeadEntries(source.boards, source.directory, agentLinks, archived, m)}
      about={source.about} connection={{ host: props.host.label, observedAt: source.observedAt }} colors={c} m={m} platform={props.layout.platform}
      demo={{ on: preview, onChange: toggleDemo }} orderReset={{ enabled: arrange.arranged, onReset: arrange.resetAll }}
      labs={{ mail: source.mail, onChange: source.revalidate }} autoArchive={autoArchive} hiddenBoards={source.hiddenBoards} />
    {!preview && archivedOf && <ArchivedSheet open boardId={archivedOf.boardId} name={archivedOf.name} stages={archivedOf.stages}
      onClose={() => setArchivedOf(null)} onChanged={source.refresh} colors={c} m={m} platform={props.layout.platform} mobile />}
    <MenuSheet title={m.filters} open={filtersOpen} onClose={() => setFiltersOpen(false)} onDismiss={restoreFilterFocus} colors={c} platform={props.layout.platform} closeLabel={m.close}>{sc => <>
      <FilterBar filters={filters} onChange={updateFilters} onReset={state.reset} projects={projectOptions} labels={source.labels}
        attentionCount={model.attention} colors={sc} m={m} mobile grouped={{ value: grouped, onChange: setGrouped }} sort={{ value: cardOrder, onChange: setCardOrder }}
        folds={{ onChange: collapsed => state.foldAll(model.groups, collapsed) }}
        projectsLoading={!source.projectsKnown} />
      <Notice text={m.count(model.stages.reduce((n, s) => n + s.count, 0))} colors={sc} />
    </>}
    </MenuSheet>
    {preview && previewBoard && previewCard && <PreviewDetail board={previewBoard} card={previewCard} colors={c} m={m}
      platform={props.layout.platform} onClose={() => setDetail(null)} />}
    {!preview && detail && <Detail {...props} {...detail} locale={source.locale} onClose={() => setDetail(null)} onChanged={source.refresh} />}
    {!preview && create && <CreateDraft {...props} boards={source.summaries} directory={source.directory} locale={source.locale}
      {...(createBoard ? { initialBoardId: createBoard } : {})} lane={createLane ?? undefined}
      onClose={() => setCreate(false)} onChanged={source.refresh} onSaved={fresh.created}
      onCreated={(boardId, cardId) => { setCreate(false); setSelected('todo'); setDetail({ boardId, cardId }); }} />}
    {!preview && <MobileWorkflowSheet hostId={props.host.id} target={workflow} onClose={() => setWorkflow(null)} colors={c} m={m} platform={props.layout.platform}
      locale={source.locale} onPickChange={() => source.refresh()} />}
    {!preview && <WorkflowPickSheet target={trying} locale={source.locale} onClose={() => setTrying(null)} colors={c} m={m} platform={props.layout.platform}
      onPicked={() => { const target = trying; setTrying(null); source.refresh(); if (target) setWorkflow(target); }} />}
    {mailboxOn && <MobileMailboxSheet hostId={props.host.id} scope={mailScope} open={mailboxOpen} read={mailList} workspaces={mailWorkspaces} rule={source.mailAlias}
      onClose={closeMailbox} colors={c} m={m} platform={props.layout.platform} />}
    {moves.layer(bottom)}
  </View>
  </FreshCardContext.Provider></FamilyFocusContext.Provider>
  </ViewedCardContext.Provider></QuickMoveContext.Provider>;
}
