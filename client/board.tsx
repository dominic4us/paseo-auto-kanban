import type { BoardCardDTO } from '../shared/rpc.js';
import { useAgentLinks, useArchivedAgents, useOrphanedCards, useSignalProblem } from './agent-signals.js';
import { DirectoryStatus, TrackingStatus } from './directory-status.js';
import { useSignalSource } from './signal-context.js';
import { MenuSheet } from './menu-sheet.js';
import { stageColor } from './stage-color.js';
import { CellPanel } from './cell-panel.js';
import { useSessionValue } from './session.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { knownRevisions, noteActivity, useAutoRefresh, useShownWatch } from './auto-refresh.js';
import { answeredSettings, noteRefreshRead, useCardOrder, useKanbanSettings, useKanbanTheme, useUiScale } from './settings.js';
import { sortCards } from './card-order.js';
import { SortMenu } from './view-tools.js';
import { useAutoCards, useWorkspaceAutoCards, workspaceAutoEntries, workspaceLeadEntries } from './auto-cards.js';
import { SettingsSheet, useSettingsWindow } from './settings-sheet.js';
import { Pressable, Text, View } from 'react-native';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { boardGet } from '../shared/rpc.js';
import { copy, displayStageNames } from './i18n.js';
import { palette } from './palette.js';
import { useDirectory, useRead } from './data.js';
import { sameName, workspaceDetail, workspaceEntry, workspaceName } from './presentation.js';
import { Button, IconButton, Notice, ViewedCardContext, useViewedCard } from './components.js';
import { FamilyFocusContext, LinkedCard, useFamilyFocus } from './card-group.js';
import { boardMark, leadAgentIds, linkStages } from './card-groups.js';
import { MobileControls } from './mobile-controls.js';
import { crowdedTitleRow, MOBILE } from './mobile-layout.js';
import { attentionStage, openingStage } from './mobile-model.js';
import { cardNeedsAttention } from './swimlane-model.js';
import { ArchivedSheet, archivedDoneOf, DoneHeadTools, TidyConfirm, TidyNote, useAutoArchive } from './archive.js';
import { boardLayout, bottomClearance } from './layout.js';
import { CreateDraft } from './create.js';
import { Detail } from './detail.js';
import { LocalePending, useScreenLocale } from './locale-hint.js';
import { QuickMoveContext, useMovedBoards, useQuickMoves } from './quick-move.js';
import { LaneViewSwitch, WorkflowPanel } from './workflow.js';
import { FLOW, offersWorkflow, toggleLaneView, type LaneViews } from './workflow-model.js';
import { px } from './ui-scale.js';

type Selector = { boardId: string; workspaceId?: never } | { workspaceId: string; boardId?: never };
export function BoardScreen({ selector, onBack, workspaceTitle, panel = false, ...surface }: PluginSurfaceProps & {
  panel?: boolean; selector: Selector; onBack?: () => void; workspaceTitle?: string | undefined;
}) {
  // REQ-70: the chosen theme, here too for the workspace panel (a theme already chosen passes through unchanged).
  const props = { ...surface, theme: useKanbanTheme(surface.host.id, surface.theme) };
  // REQ-139: the chosen size, here too for the workspace panel.
  useUiScale(surface.host.id);
  const get = useRpc(boardGet);
  const key = `${props.host.id}:${selector.boardId ?? selector.workspaceId}`;
  // REQ-66: the host id brings the host's settings along, so a panel opened first obeys auto refresh off.
  const state = useRead(key, () => get({ ...selector, hostId: props.host.id }), true, undefined,
    (data, token) => noteRefreshRead(props.host.id, data.settings?.autoRefresh, token));
  // Observation a: the last language kept for the host until this read answers; `null` = no words yet.
  const locale = useScreenLocale(props.host.id, state.data?.locale, !state.data && !state.error);
  const names = useDirectory(props.host.id, true, locale ?? 'en');
  const [width, setWidth] = useState(0);
  const [attention, setAttention] = useSessionValue(props.host.id + ':board:' + (selector.boardId ?? selector.workspaceId), 'attention', false);
  const [beforeAttention, setBeforeAttention] = useSessionValue(props.host.id + ':board:' + (selector.boardId ?? selector.workspaceId), 'beforeAttention', 'todo');
  const [selectedStage, setStage] = useSessionValue(props.host.id + ':board:' + (selector.boardId ?? selector.workspaceId), 'stage', '');
  const [create, setCreate] = useState(false);
  const [menu, setMenu] = useState(false), [card, setCard] = useState<string | null>(null), [lead, setLead] = useState(false);
  const c = palette(props.theme), m = copy(locale ?? 'en');
  const read = useMemo(() => state.data ? [displayStageNames(state.data.board, state.data.locale)] : [], [state.data]);
  // REQ-82 ③: a card a person just moved is drawn in its new column until the board is read with the move.
  const b = useMovedBoards(props.host.id, read)[0];
  // REQ-57 ②: a workspace with no board yet arrives as an empty board, so the panel shows four empty
  // columns and a + instead of an error; the first card creates the board through board.ensure.
  const pending = b?.summary.hasLedger === false;
  const empty = b?.stages.every(s => s.totalCount === 0) ?? false;
  // REQ-62: this board only; a workspace with no board yet waits for one to appear.
  const known = useMemo(() => !b ? null : pending ? {} : knownRevisions([{ ...b.summary, revision: state.data!.revision }]),
    [b, pending, state.data]);
  // F1: its own root, so the workspace panel stops looking too when the host hides it.
  const shown = useShownWatch();
  const settings = useKanbanSettings(props.host.id, answeredSettings(!!state.data, state.data?.settings));
  // REQ-79: the same card order as the swimlane board (the same scope), so a choice made on either is on both at once.
  const [cardOrder, setCardOrder] = useCardOrder(props.host.id + ':surface', props.host.id, settings.cardOrder, true);
  // REQ-67 ⑥/REQ-68: the same settings window as the Kanban screen, from this board's ⚙ (the narrow panel's ⋯).
  const autoCards = useAutoCards(props.host.id + ':surface', props.host.id, state.data?.autoCards, true, state.readToken);
  const workspaceAuto = useWorkspaceAutoCards(props.host.id + ':surface', state.data?.autoCardsOff, true, state.readToken);
  // REQ-52: as on the swimlane board — the days (settings), the done column's "Archived N" and "Tidy", the archived list.
  const autoArchive = useAutoArchive(props.host.id + ':surface', state.data?.autoArchive, true, state.readToken);
  const [tidy, setTidy] = useState<{ ask: boolean; text?: string } | null>(null), [archivedOpen, setArchivedOpen] = useState(false);
  const settingsWindow = useSettingsWindow(width, () => setMenu(false)), settingsRoot = settingsWindow.root;
  // REQ-68: a board that belongs to a Paseo workspace opens it from an ↗ in the top bar (once in ⋯).
  const openWorkspace = b && !pending && props.navigation && !b.summary.workspaceId.startsWith('local_')
    ? () => props.navigation?.openWorkspace({ workspaceId: b.summary.workspaceId }) : undefined;
  // One stable ref for both, so the shown watch is not re-attached on every render.
  const rootRef = useCallback((node: View | null) => { shown.ref(node); settingsRoot.current = node; }, [shown, settingsRoot]);
  const looks = useAutoRefresh({ enabled: settings.autoRefresh, known, scope: pending ? 'appeared' : 'listed',
    boardIds: b && !pending ? [b.summary.id] : undefined, busy: state.loading, revalidate: state.revalidate, shown, groups: true });
  const [crumb, setCrumb] = useState({ hover: false, focus: false });
  const signalSource = useSignalSource();
  const orphaned = useOrphanedCards(signalSource, b ? [b] : []);
  // REQ-83: what this board reads besides its ledger — the agents' states and the automatic tracking — said here too.
  const signalProblem = useSignalProblem(signalSource);
  // REQ-102: a lead's place in a completion column depends on whether its agent is archived (card-order.ts).
  // D35: the lead's agents are looked up first; see `useArchivedAgents`.
  // REQ-117: the agents' role and parent labels find the topic leads, whose agents are looked up first too.
  const agentLinks = useAgentLinks(signalSource);
  const leadIds = useMemo(() => leadAgentIds(b ? [b] : [], agentLinks), [b, agentLinks]);
  const archived = useArchivedAgents(signalSource, leadIds);
  const needsAttention = (card: BoardCardDTO) => cardNeedsAttention(card, b!.template.stages) || orphaned.has(card.id);
  const mobile = props.layout.platform !== 'web' || props.layout.compact;
  const sizing = boardLayout(width, mobile), tabs = sizing.tabs, compact = width < 760;
  // REQ-82 ②③: "Done" on an archived card, the stage menu (⋯, or a long press on a phone) and "Moved to … · Undo".
  // REQ-142: the workspace panel is in its workspace; a board opened from the overview is in none, so its "Go to agent" asks.
  const here = panel ? selector.workspaceId : undefined;
  const moves = useQuickMoves({ hostId: props.host.id, enabled: !!b && !pending, touch: mobile || compact, boards: b ? [b] : [],
    refresh: () => { void state.revalidate(); }, m, colors: c, platform: props.layout.platform, navigation: props.navigation, agents: agentLinks, here });
  const panelCompact = panel && compact;
  // REQ-127: the lane heading's "Board | Workflow" (REQ-124) on this board's top bar too — only with a definition, only on a
  // wide window (the phone waits for REQ-124's phone release), not in the workspace panel. The choice is the lane's own
  // session value (the swimlane's scope and key), so the lane and its board show the same view when either is left.
  const [views, setViews] = useSessionValue<LaneViews>(props.host.id + ':surface', 'laneViews', {});
  const offered = !!b && offersWorkflow(b) && !mobile && !compact && !panel, big = offered && views[b!.summary.id] === 'workflow';
  const bottom = bottomClearance(props.layout.platform);
  // REQ-148: a tab not chosen yet (nor handed over by the Kanban screen) is the first stage, or the first with cards while
  // that one is empty; on the tabs it is then kept as if chosen, so it does not jump when its cards move on.
  const opening = b ? openingStage(b.stages.map(s => ({ stageId: s.stageId, count: s.totalCount })), b.stages[0]?.stageId ?? '') : '';
  const selected = b?.stages.find(s => s.stageId === selectedStage)?.stageId ?? (opening || undefined);
  const opened = tabs && !selectedStage && !!b && b.stages.some(s => s.totalCount > 0);
  useEffect(() => { if (opened) setStage(opening); }, [opened, opening]);
  const title = workspaceTitle || (b ? workspaceName(b.summary.workspaceId, b.summary.cwd, names.directory) : m.loading);
  // REQ-77 ④: the title reads like the flat board's lane heading (REQ-75 A1) — the workspace in bold, then, muted,
  // its project when it is called something else. REQ-65 ⑧'s `branch · folder` stays last in the muted part, so a
  // worktree's board and the root's never look alike: this title is the only place the board screen tells them apart.
  const entry = b ? workspaceEntry(names.directory, b.summary.workspaceId, b.summary.cwd) : undefined;
  const heading = title;
  const subtitle = b ? [entry?.projectName ?? '', workspaceDetail(names.directory, b.summary.workspaceId, b.summary.cwd)]
    .filter(part => part && !sameName(part, heading)).join(' · ') : '';
  const refresh = () => { void state.refresh(); void names.refresh(); };
  const originalStages = b?.stages ?? [];
  const count = originalStages.flatMap(s => s.cards).filter(c => needsAttention(c)).length;
  // REQ-93: every card in its own stage's column, a sub-card marked with its parent; the phone's attention filter as for any card.
  const stages = linkStages(originalStages, agentLinks, boardMark(b?.summary))
    .map(s => ({ ...s, cards: sortCards(s.cards, cardOrder, s.countsAsDone, archived).filter(card => !(compact && attention) || needsAttention(card)) }));
  // REQ-93 C′: the family a parent mark or a parent's summary line highlights; a tap on an empty spot ends it.
  const family = useFamilyFocus();
  const toggleAttention = () => {
    if (!attention) { setBeforeAttention(selected ?? originalStages[0]?.stageId ?? 'todo');
      setStage(attentionStage(originalStages.map(s => ({ stageId: s.stageId, count: s.cards.filter(c => needsAttention(c)).length }))));
    } else setStage(beforeAttention);
    setAttention(!attention);
  };
  const doneTools = (stage: typeof stages[number]) => stage.countsAsDone && !pending ? <DoneHeadTools archived={archivedDoneOf(b!.summary)}
    live={stage.totalCount} name={heading} colors={c} m={m} mobile={tabs} onHead={!tabs} onShow={() => setArchivedOpen(true)} onTidy={() => setTidy({ ask: true })} /> : null;
  const lane = (stage: typeof stages[number]) => <CellPanel key={stage.stageId} colors={c} testID={`board-cell-${stage.stageId}`}
    style={sizing.lane} {...(!tabs ? { heading: stage.name, count: stage.totalCount, color: stageColor(stage.stageId, b!.template.stages, c),
      ...(stage.countsAsDone && !pending ? { headingTrailing: doneTools(stage) } : {}) } : {})}>
    <ScrollView nestedScrollEnabled style={{ flex: 1 }} contentContainerStyle={{ gap: px(8), paddingTop: compact ? MOBILE.boardCardGap : 0, paddingBottom: bottom }}>
      {tabs && doneTools(stage)}
      {stage.countsAsDone && tidy && (tidy.ask
        ? <TidyConfirm boardId={b!.summary.id} count={stage.totalCount} colors={c} m={m} mobile={tabs} onClose={() => setTidy(null)}
          onDone={n => { setTidy({ ask: false, text: m.tidyDone(n) }); refresh(); }} />
        : <TidyNote text={tidy.text ?? ''} onClose={() => setTidy(null)} colors={c} m={m} mobile={tabs} />)}
      {stage.cards.map(value => <LinkedCard stages={b!.template.stages} countsAsDone={stage.countsAsDone} key={value.id} card={value} labels={b!.agentLabels}
        boardId={b!.summary.id} colors={c} m={m} onOpen={(id, isLead) => { setCard(id); setLead(!!isLead); }} mobile={mobile || compact} />)}
    </ScrollView>
  </CellPanel>;
  const stageTabs = <View testID="stage-tabs" style={sizing.tabRow}>
    {stages.map(stage => <View key={stage.stageId} style={{ flex: stages.length <= 4 ? 1 : undefined,
      minWidth: stages.length > 4 ? px(100) : undefined, height: px(44), justifyContent: 'center' }}>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: selected === stage.stageId }}
        onPress={() => setStage(stage.stageId)} hitSlop={{ top: px(4), bottom: px(4) }}
        style={{ height: px(36), borderRadius: px(6), alignItems: 'center', justifyContent: 'center',
          backgroundColor: selected === stage.stageId ? c.surface2 : c.surface0 }}>
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: px(12) }}>{stage.name} {stage.totalCount}</Text>
      </Pressable>
    </View>)}
  </View>;
  // REQ-85 ⑨: the card whose detail was just closed stays tinted until another is opened or the board is left.
  const viewed = useViewedCard(card);
  // REQ-63 ⑧: on a phone the way back is a ‹ at the far left of the top bar.
  const backButton = (mobile || compact) && onBack ? <IconButton testID="board-back" name="ChevronLeft" label={m.backToAll} onPress={onBack}
        colors={c} mobile plain iconSize={px(22)} /> : null;
  const titleBlock = <View style={offered ? { flexShrink: 1, minWidth: 0 } : { flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: px(6), minWidth: 0 }}>
        {/* REQ-63 ⑦: a quiet path in front of the title, never a second title. */}
        {!mobile && !compact && onBack && <Pressable testID="board-breadcrumb" accessibilityRole="button" accessibilityLabel={m.backToAll}
          onPress={onBack} onHoverIn={() => setCrumb(v => ({ ...v, hover: true }))} onHoverOut={() => setCrumb(v => ({ ...v, hover: false }))}
          onFocus={() => setCrumb(v => ({ ...v, focus: true }))} onBlur={() => setCrumb(v => ({ ...v, focus: false }))}
          style={{ flexShrink: 0, borderRadius: px(4), paddingHorizontal: px(2), ...(crumb.focus ? { backgroundColor: c.surface2 } : {}),
            ...({ cursor: 'pointer' } as object) }}>
          <Text numberOfLines={1} style={{ color: crumb.hover || crumb.focus ? c.foreground : c.foregroundMuted, fontSize: px(13),
            textDecorationLine: crumb.hover ? 'underline' : 'none' }}>{`${m.allBoards} ›`}</Text>
        </Pressable>}
        <Text testID="board-title" numberOfLines={1} style={{ flexShrink: 1, color: c.foreground, fontSize: px(18), fontWeight: '600' }}>
          {heading}{!!subtitle && <Text style={{ color: c.foregroundMuted, fontSize: px(13), fontWeight: '400' }}> · {subtitle}</Text>}
        </Text>
      </View>
      {b && <Text testID="board-progress" style={{ color: c.foregroundMuted, fontSize: px(11) }}>
        {empty ? m.emptyLane + ' · ' : ''}{m.cardsProgress(b.summary.progress.done, b.summary.progress.requested)}
      </Text>}
    </View>;
  // REQ-139: on a phone, the ‹, refresh, +, ↗ workspace and ⚙ (width 0: not laid out yet).
  const crowded = (mobile || compact) && width > 0 && crowdedTitleRow(width, (backButton ? 1 : 0) + 3 + (openWorkspace ? 1 : 0), px(6));
  if (!locale) return <LocalePending colors={c} />;
  return <QuickMoveContext.Provider value={moves.context}><ViewedCardContext.Provider value={viewed}><FamilyFocusContext.Provider value={family.value}>
  <View testID="workspace-board" ref={rootRef} onTouchStart={noteActivity} {...family.responder} onLayout={event => setWidth(event.nativeEvent.layout.width)}
    style={{ flex: 1, minHeight: 0, padding: compact ? 0 : mobile ? px(8) : px(12), paddingHorizontal: compact ? MOBILE.horizontalPadding : mobile ? px(8) : px(12), paddingBottom: bottom, gap: compact ? 0 : px(8), backgroundColor: c.surface0 }}>
    {/* REQ-80: above the columns, so the glyphs' tips, which hang below the bar, are drawn over them. */}
    {!panelCompact && <View testID="board-appbar" style={{ flexDirection: 'row', alignItems: 'center', gap: px(6), height: compact && !crowded ? MOBILE.appbarHeight : undefined, zIndex: 1,
      ...(crowded ? { minHeight: MOBILE.appbarHeight, flexWrap: 'wrap' as const, justifyContent: 'flex-end' as const } : {}) }}>
      {/* REQ-139: a size that leaves the title no room puts it (with the ‹) on a line of its own, over the glyphs. */}
      {crowded ? <View style={{ flexBasis: '100%', flexDirection: 'row', alignItems: 'center', gap: px(6), minHeight: MOBILE.appbarHeight }}>{backButton}{titleBlock}</View>
        : <>{backButton}{titleBlock}</>}
      {offered && <LaneViewSwitch workflow={big} onChange={on => setViews(previous => toggleLaneView(previous, b!.summary.id, on))}
        name={heading} colors={c} m={m} />}
      {offered && <View style={{ flex: 1 }} />}
      {/* REQ-68: no ⋯ — refresh (a phone too, where it used to be in ⋯), +, ↗ workspace and ⚙. "Overview" is the ‹ or
          the path in front of the title; the host, folder and last check are gone with the sheet. */}
      <IconButton name="RefreshCw" label={m.refresh} onPress={refresh} colors={c} mobile={mobile || compact} tooltip={!mobile && !compact} />
      <IconButton name="Plus" label={m.create} onPress={() => setCreate(true)} colors={c} mobile={mobile || compact} disabled={!b || !!state.error}
        tooltip={!mobile && !compact} />
      {/* REQ-79: the card order on a wide board too; a phone's board follows the choice made in the filter sheet. */}
      {!mobile && !compact && <SortMenu value={cardOrder} onChange={setCardOrder} colors={c} m={m} />}
      {openWorkspace && <IconButton testID="open-workspace" name="SquareArrowOutUpRight" label={m.workspace} onPress={openWorkspace}
        colors={c} mobile={mobile || compact} tooltip={!mobile && !compact} />}
      <IconButton testID="open-settings" name="Settings" label={m.settings} onPress={settingsWindow.open} colors={c} mobile={mobile || compact}
        tooltip={!mobile && !compact} buttonRef={settingsWindow.opener} />
    </View>}
    {state.loading && !b && <Notice text={m.loading} colors={c} />}
    {!!state.error && <><Notice text={`${b ? m.previous + ' · ' : ''}${state.error}`} colors={c} error />
      <Button label={m.retry} onPress={refresh} colors={c} mobile={mobile} /></>}
    {/* REQ-83: the workspace listing (REQ-78's line; a board is never held back by it, so only its failure), then the rest. */}
    <DirectoryStatus placing={false} error={names.error} colors={c} m={m} />
    <TrackingStatus signals={signalProblem} health={looks.health ?? state.data?.autoHealth} autoCards={autoCards[0]}
      refreshFailing={!!looks.failing} colors={c} m={m} />
    {tabs && b && (compact ? <MobileControls stages={stages.map(s => ({ stageId: s.stageId, name: s.name, count: s.cards.length, color: stageColor(s.stageId, b!.template.stages, c) }))}
      actions={panelCompact ? <>
        <IconButton name="Ellipsis" label={m.more} onPress={() => setMenu(true)} colors={c} mobile buttonRef={settingsWindow.opener} />
      </> : undefined} selected={selected ?? ''} attention={attention} count={count} onStage={setStage} onAttention={toggleAttention} colors={c} m={m} />
      : stages.length <= 4 ? stageTabs : <View style={{ height: px(44) }}><ScrollView horizontal>{stageTabs}</ScrollView></View>)}
    {/* REQ-127: the workflow in place of the columns, the board's whole width (the flow's columns widen with it). */}
    {big && <ScrollView testID="board-workflow" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: bottom }}>
      <WorkflowPanel hostId={props.host.id} workspaceId={b!.summary.workspaceId} width={Math.max(0, width - px(24))} colors={c} m={m}
        maxColumn={FLOW.wideCol} locale={locale ?? 'en'}
        onPickChange={template => { if (template === null) setViews(previous => toggleLaneView(previous, b!.summary.id, false)); void state.revalidate(); }} />
    </ScrollView>}
    {!big && <View style={{ flex: 1, minHeight: 0 }}>
      {tabs ? stages.filter(s => s.stageId === selected).map(lane)
        : <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ height: '100%', gap: px(8) }}>{stages.map(lane)}</ScrollView>}
    </View>}
    {/* REQ-68: only the narrow workspace panel keeps a ⋯. It has no top bar, and its one 44px slot beside the stage
        tabs cannot take +, refresh and ⚙ without pushing the tabs under 44px. */}
    {panelCompact && <MenuSheet title={m.more} open={menu} onClose={() => setMenu(false)} colors={c} platform={props.layout.platform} closeLabel={m.close}>{sc =>
      <View style={{ gap: px(8) }}>
        <Button label={m.create} colors={sc} mobile disabled={!b || !!state.error} onPress={() => { setMenu(false); setCreate(true); }} />
        {openWorkspace && <Button label={m.workspace} colors={sc} mobile onPress={() => { setMenu(false); openWorkspace(); }} />}
        <Button label={m.refresh} colors={sc} mobile onPress={() => { setMenu(false); refresh(); }} />
        <Button testID="open-settings" label={m.openSettings} colors={sc} mobile onPress={settingsWindow.open} />
      </View>}
    </MenuSheet>}
    <SettingsSheet {...settingsWindow.sheet} hostId={props.host.id} settings={settings} autoCards={autoCards} readOnly={false}
      workspaces={b ? { entries: workspaceAutoEntries([b.summary], names.directory), switch: workspaceAuto } : undefined}
      leads={b ? workspaceLeadEntries([b], names.directory, agentLinks, archived, m) : undefined}
      about={state.data?.about} connection={{ host: props.host.label, observedAt: state.data?.observedAt ?? '' }} colors={c} m={m} platform={props.layout.platform}
      autoArchive={autoArchive} />
    {archivedOpen && b && !pending && <ArchivedSheet open boardId={b.summary.id} name={heading} stages={b.template.stages}
      onClose={() => setArchivedOpen(false)} onChanged={refresh} colors={c} m={m} platform={props.layout.platform} mobile={mobile || compact} />}
    {create && b && <CreateDraft {...props} boards={[b.summary]} directory={names.directory}
      initialBoardId={b.summary.id} locale={state.data!.locale} onClose={() => setCreate(false)}
      onChanged={refresh} onCreated={(_boardId, cardId) => { setCreate(false); setCard(cardId); setLead(false); }} />}
    {card && b && !pending && <Detail {...props} key={`${key}:${card}`} boardId={b.summary.id} cardId={card} lead={lead}
      hereWorkspaceId={here} locale={state.data!.locale} onClose={() => setCard(null)} onChanged={refresh} />}
    {moves.layer(bottom)}
  </View>
  </FamilyFocusContext.Provider></ViewedCardContext.Provider></QuickMoveContext.Provider>;
}
