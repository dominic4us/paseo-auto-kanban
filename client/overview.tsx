import { MenuSheet } from './menu-sheet.js';
import { PreviewContext } from './preview-context.js';
import { SignalContext } from './signal-context.js';
import { staticSignalSource, useAgentLinks, useLiveSignals, useSignalProblem } from './agent-signals.js';
import { boardMark, linkStages } from './card-groups.js';
import { useSignalSource } from './signal-context.js';
import { demoSignals, demoArchived, demoModels } from './demo.js';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { boardGet, overviewGet } from '../shared/rpc.js';
import { copy } from './i18n.js';
import { palette } from './palette.js';
import { useDirectory, useRead } from './data.js';
import { shownBoards, useRevealHidden } from './hidden-boards.js';
import { overviewSelection, placedBoards, projectOptions as projectChoices, workspaceDetail, workspaceEntry, workspaceName, workspaceProjectId } from './presentation.js';
import { Button, IconButton, Notice, ViewSwitch } from './components.js';
import { bottomClearance } from './layout.js';
import { CreateDraft } from './create.js';
import { Detail } from './detail.js';
import { MobileSwimlaneScreen } from './mobile-swimlane.js';
import { crowdedTitleRow, glyphLine, surfaceLayout } from './mobile-layout.js';
import { SwimlaneScreen } from './swimlane.js';
import { useSessionValue } from './session.js';
import { useHiddenProjects, type HiddenProjects } from './hidden-projects.js';
import { keepGoneHidden, presentHidden } from './filter-model.js';
import { useLaneOrder } from './ui-order.js';
import { emptyLaneOrder, flatOrder } from './order-model.js';
import { BoardScreen } from './board.js';
import { knownRevisions, noteActivity, ShownContext, useAutoRefresh, useShownWatch } from './auto-refresh.js';
import { answeredSettings, noteRefreshRead, useKanbanSettings, useKanbanTheme, useUiScale } from './settings.js';
import { useAutoCards, useWorkspaceAutoCards, workspaceAutoEntries } from './auto-cards.js';
import { SettingsSheet, useSettingsWindow } from './settings-sheet.js';
import { DirectoryReadyMark, DirectoryStatus, TrackingStatus } from './directory-status.js';
import { LocalePending, useScreenLocale } from './locale-hint.js';
import { px } from './ui-scale.js';

export function OverviewScreen(surface: PluginSurfaceProps & { availableWidth?: number }) {
  // REQ-70: every screen below, and what they open, draws with the theme chosen in the settings.
  // REQ-72: the sheets and windows too — Kanban draws them all (KanbanSheet)
  const props = { ...surface, theme: useKanbanTheme(surface.host.id, surface.theme) };
  // REQ-139: and at the size chosen there, set before anything below draws.
  useUiScale(surface.host.id);
  const [measuredWidth, setWidth] = useState(useWindowDimensions().width);
  const width = surface.availableWidth ?? measuredWidth;
  const [previewHost, setPreviewHost] = useState<string | null>(null);
  const preview = previewHost === props.host.id;
  useEffect(() => { setPreviewHost(null); }, [props.host.id]);
  const scope = props.host.id + ':surface';
  const [mode, setMode] = useSessionValue<'swimlane' | 'list'>(scope, 'mode', 'swimlane');
  const [board, setBoard] = useSessionValue<string | null>(scope, 'board', null);
  const layout = surfaceLayout(width, props.layout.platform), wide = layout === 'wide';
  // REQ-22: one SDK subscription per host feeds every card; the demo uses a fixed map instead.
  const live = useLiveSignals(props.host.id, !preview);
  const demoSource = useMemo(() => staticSignalSource(demoSignals, demoArchived, demoModels), []);
  // F1: the swimlane and the list stop looking while the host hides this surface.
  const shown = useShownWatch();
  return <PreviewContext.Provider value={preview}><SignalContext.Provider value={preview ? demoSource : live}><ShownContext.Provider value={shown}>
    <View ref={shown.ref} style={{ flex: 1, minHeight: 0 }} onTouchStart={noteActivity} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {board ? <BoardScreen {...props} key={board} selector={{ boardId: board }} onBack={() => setBoard(null)} />
      : wide && mode === 'swimlane' ? <SwimlaneScreen {...props} preview={preview} onPreview={value => setPreviewHost(value ? props.host.id : null)} width={width} onList={() => setMode('list')} onBoard={setBoard} />
        : (layout === 'mobile' || preview) && mode === 'swimlane' ? <MobileSwimlaneScreen {...props} preview={preview} onPreview={value => setPreviewHost(value ? props.host.id : null)} width={width} onList={() => setMode('list')} onBoard={setBoard} />
          : <ListOverview {...props} availableWidth={width} onBoard={setBoard} {...(layout !== 'legacy' ? { onKanban: () => setMode('swimlane') } : {})}
            onDemo={() => { setPreviewHost(props.host.id); setMode('swimlane'); }} />}
  </View></ShownContext.Provider></SignalContext.Provider></PreviewContext.Provider>;
}
/**
 * REQ-133 (research/264 J3): whether a card opened from this list is a lead's — the board's own rule (`linkStages`' crew,
 * what a board's card passes its detail), read from the card's board once its detail opens. The list itself carries only
 * the cards that wait, so until that read answers (or when it fails) the detail opens as any card's, without the memo line.
 */
function useLeadCard(hostId: string, detail: { boardId: string; cardId: string } | null): boolean {
  const get = useRpc(boardGet), links = useAgentLinks(useSignalSource());
  const read = useRead(detail ? hostId + ':lead:' + detail.boardId : '', () => get({ boardId: detail!.boardId, hostId }), !!detail);
  const stages = detail ? read.data?.board.stages : undefined, cardId = detail?.cardId, lead = boardMark(read.data?.board.summary);
  return useMemo(() => !!stages && linkStages(stages, links, lead).some(stage => stage.cards.some(card => card.id === cardId && !!card.crew)),
    [stages, links, cardId, lead]);
}
export function ListOverview({ onBoard, onKanban, onDemo, availableWidth, ...props }: PluginSurfaceProps & {
  availableWidth?: number;
  /** REQ-68: turning the demo on from this screen's settings shows it on the Kanban screen, where it lives. */
  onBoard: (id: string) => void; onKanban?: () => void; onDemo?: () => void;
}) {
  const get = useRpc(overviewGet), state = useRead(props.host.id, () => get({ hostId: props.host.id, includeWorkspaces: true }), true, undefined,
    (data, token) => noteRefreshRead(props.host.id, data.ui?.settings?.autoRefresh, token));
  // Observation a: the last language kept for the host until this read answers; `null` = no words yet.
  const locale = useScreenLocale(props.host.id, state.data?.locale, !state.data && !state.error);
  const names = useDirectory(props.host.id, true, locale ?? 'en');
  // REQ-62: the list shows every board too, so it watches the same way the swimlane does.
  const known = useMemo(() => state.data ? knownRevisions(state.data.boards) : null, [state.data]);
  // REQ-66: unless auto refresh is switched off in the settings.
  const settings = useKanbanSettings(props.host.id, answeredSettings(!!state.data?.ui, state.data?.ui?.settings));
  const looks = useAutoRefresh({ enabled: settings.autoRefresh, known, scope: 'all', busy: state.loading, revalidate: state.revalidate });
  // REQ-83: the agents' states, the automatic tracking (the latest look's report, else the read's) and the looks themselves.
  const signalProblem = useSignalProblem(useSignalSource());
  const [create, setCreate] = useState(false);
  // REQ-57 ④/⑥: the list screen hides the same projects as the board, from the same remembered set.
  const hidden = useHiddenProjects(props.host.id + ':surface', props.host.id, state.data?.ui?.hiddenProjects, true);
  // REQ-59 ④: and lists the projects and workspaces in the order arranged there.
  const [order, setOrder] = useLaneOrder(props.host.id + ':surface', props.host.id, state.data?.ui?.order, true);
  const [reason, setReason] = useState<'all' | 'awaitingUser' | 'blocked' | 'draft'>('all');
  const [all, setAll] = useState(false), [projectsOpen, setProjectsOpen] = useState(false);
  const [detail, setDetail] = useState<{ boardId: string; cardId: string } | null>(null);
  const lead = useLeadCard(props.host.id, detail);
  const [progressOnly, setProgressOnly] = useState(false);
  // REQ-67 ⑥/REQ-68: the same settings window as the Kanban screen, from this screen's ⚙.
  const autoCards = useAutoCards(props.host.id + ':surface', props.host.id, state.data?.autoCards, true, state.readToken);
  const workspaceAuto = useWorkspaceAutoCards(props.host.id + ':surface', state.data?.autoCardsOff, true, state.readToken);
  const settingsWindow = useSettingsWindow(useWindowDimensions().width);
  const c = palette(props.theme), m = copy(locale ?? 'en');
  const mobile = props.layout.platform !== 'web' || props.layout.compact;
  const bottom = bottomClearance(props.layout.platform);
  const windowWidth = useWindowDimensions().width, screenWidth = availableWidth ?? windowWidth;
  // REQ-78 ①②: as on the board, only what the workspace listing can already place is listed — nothing at all before
  // any listing is known, so no workspace is "not found in Paseo" or shown from a hidden project in the meantime.
  // REQ-138: the empty boards of archived or gone workspaces are left out here as on the Kanban screen, from the same switch.
  const [reveal, setReveal] = useRevealHidden(props.host.id + ':surface');
  const kept = useMemo(() => state.data ? shownBoards(state.data.boards, reveal, b => b) : null, [state.data, reveal]);
  const placed = useMemo(() => {
    if (!state.data || !kept) return null;
    const at = { ready: names.ready, settled: names.settled };
    return { ...state.data, boards: placedBoards(kept.boards, names.directory, at, b => b),
      attention: placedBoards(state.data.attention, names.directory, at, c => c) };
  }, [state.data, kept, names.directory, names.ready, names.settled]);
  const placing = !!kept && !!placed && (placed.boards.length < kept.boards.length || placed.attention.length < state.data!.attention.length);
  const selection = placed && names.ready ? overviewSelection(placed, names.directory, hidden[0], reason, order) : null;
  const projectOptions = projectChoices(placed?.boards ?? [], names.directory, m.unlinked);
  // D42: a hidden project whose workspaces went away is neither counted nor offered, yet stays stored (`keepGoneHidden`).
  const present = names.ready ? new Set(projectOptions.keys()) : null;
  const shown: HiddenProjects = [presentHidden(hidden[0], present), next => hidden[1](keepGoneHidden(next, hidden[0], present))];
  const projectCount = names.ready ? m.projectCount(projectOptions.size - shown[0].length, projectOptions.size) : m.projectsLoading;
  const refresh = () => { void state.refresh(); void names.refresh(); };
  // REQ-68: no ⋯ — the projects, refresh, the view and ⚙ are all on this row (a phone gets glyphs).
  // REQ-139: on a phone, the projects, refresh, +, the view and ⚙.
  const glyphs = [
    mobile ? <IconButton key="projects" testID="projects-button" name="ListFilter" label={projectCount}
      onPress={() => setProjectsOpen(true)} colors={c} mobile />
      : <Button key="projects" testID="projects-button" label={projectCount} onPress={() => setProjectsOpen(true)} colors={c} />,
    <IconButton key="refresh" name="RefreshCw" label={m.refresh} onPress={refresh} colors={c} mobile={mobile} tooltip={!mobile} />,
    <IconButton key="create" name="Plus" label={m.create} onPress={() => setCreate(true)} colors={c} mobile={mobile} disabled={!kept?.boards.length || !!state.error}
      tooltip={!mobile} />,
    // REQ-79: no card order here — the list shows what waits for a person and each board's progress, not columns of cards.
    ...(onKanban ? [mobile ? <IconButton key="view" testID="view-toggle" name="SquareKanban" label={m.swimlaneView} onPress={onKanban} colors={c} mobile />
      : <ViewSwitch key="view" value="list" onChange={onKanban} colors={c} m={m} />] : []),
    <IconButton key="settings" testID="open-settings" name="Settings" label={m.settings} onPress={settingsWindow.open} colors={c} mobile={mobile}
      tooltip={!mobile} buttonRef={settingsWindow.opener} />,
  ];
  const crowded = mobile && crowdedTitleRow(screenWidth, glyphs.length, px(6));
  // D60: crowded, the glyphs keep one line under the title — closer together, or the last beside the title.
  const line = crowded ? glyphLine(screenWidth, glyphs.length, px(6)) : { lifted: 0, gap: px(6) };
  const lifted = line.lifted ? glyphs.splice(glyphs.length - line.lifted) : null;
  // REQ-139: a size that leaves the title no room puts it on a line of its own, over the glyphs.
  const title = <Text numberOfLines={1} style={{ flex: 1, fontSize: px(19), fontWeight: '600', color: c.foreground, ...(crowded && !lifted ? { flexBasis: '100%' as const } : {}) }}>
    {shown[0].length ? projectCount : m.overview}
  </Text>;
  if (!locale) return <LocalePending colors={c} />;
  return <View ref={settingsWindow.root} style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}>
    <View style={{ flex: 1, minHeight: 0, padding: mobile ? px(8) : px(16), paddingBottom: bottom, gap: px(8) }}>
      {/* REQ-80: above what follows, so the glyphs' tips, which hang below the row, are drawn over it. */}
      <View testID="list-title-row" style={{ flexDirection: 'row', alignItems: 'center', ...(line.gap < px(6) ? { rowGap: px(6), columnGap: line.gap } : { gap: px(6) }), zIndex: 1,
        ...(crowded ? { flexWrap: 'wrap' as const, justifyContent: 'flex-end' as const } : {}) }}>
        {lifted ? <View testID="list-title-line" style={{ flex: 1, flexBasis: '100%', flexDirection: 'row', alignItems: 'center', gap: px(6) }}>
          {title}{lifted}</View> : title}
        {glyphs}
      </View>
      {state.loading && !state.data && <Notice text={m.loading} colors={c} />}
      {!!state.error && <><Notice text={`${state.data ? m.previous + ' · ' : ''}${state.error}`} colors={c} error />
        <Button label={m.retry} onPress={refresh} colors={c} mobile={mobile} /></>}
      {!!state.data?.errors.length && <Notice text={`${m.partial} (${state.data.errors.length})`} colors={c} error />}
      {/* REQ-68: said on the screen now that the ⋯ it sat in is gone. REQ-78 ①③: boards waiting for the workspace
          listing, and a listing that failed (read again on its own). */}
      <DirectoryStatus placing={placing} error={names.error} colors={c} m={m} />
      <TrackingStatus signals={signalProblem} health={looks.health ?? state.data?.autoHealth} autoCards={autoCards[0]}
        refreshFailing={!!looks.failing} colors={c} m={m} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: mobile ? px(12) : px(18), paddingBottom: bottom }}>
        {selection && <>
          <View style={{ gap: px(6) }}>
            {/* REQ-68: the section folds from its own heading (once "Workspace progress" in ⋯), leaving the progress. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(4) }}>
              <IconButton testID="attention-fold" name={progressOnly ? 'ChevronRight' : 'ChevronDown'} plain
                label={progressOnly ? m.expandAttention : m.foldAttention} onPress={() => setProgressOnly(!progressOnly)} colors={c} mobile={mobile} />
              <Text style={{ flex: 1, fontSize: px(15), fontWeight: '600', color: c.foreground }}>{m.attention} · {selection.attention.length}</Text>
              {!progressOnly && <Button label={all ? m.showLess : m.showAll} onPress={() => setAll(!all)} colors={c} mobile={mobile} />}
            </View>
            {!progressOnly && <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: px(4) }}>
              {(['all', 'awaitingUser', 'blocked', 'draft'] as const).map(value =>
                <Button key={value} label={m[value]} colors={c} mobile={mobile} selected={reason === value}
                  onPress={() => { setReason(value); setAll(false); }} />)}
            </ScrollView>
            {/* REQ-71: one line a card — the reason's glyph, the title cut to a line, the workspace small at the end.
                The stage and the next action are in the card it opens. */}
            {!!selection.attention.length && <View testID="attention-list" style={{ backgroundColor: c.surface1, borderWidth: 1,
              borderColor: c.border, borderRadius: px(8), overflow: 'hidden' }}>
              {(all ? selection.attention : selection.attention.slice(0, mobile ? 2 : 3)).map((card, index) => {
                const workspace = workspaceName(card.workspaceId, card.cwd, names.directory);
                return <Pressable key={card.id} testID="attention-row" accessibilityRole="button"
                  accessibilityHint={[workspace, card.stageName, ...card.reasons.map(r => m[r])].join(' · ')}
                  onPress={() => setDetail({ boardId: card.boardId, cardId: card.id })}
                  style={{ minHeight: mobile ? px(44) : px(32), paddingHorizontal: px(10), flexDirection: 'row', alignItems: 'center', gap: px(6),
                    borderTopWidth: index ? 1 : 0, borderColor: c.border }}>
                  <Icon name={card.awaiting === 'user' ? 'CircleAlert' : card.blocked ? 'CircleX' : 'FileText'} size={px(14)}
                    color={card.awaiting === 'user' ? c.statusWarning : card.blocked ? c.blocked : c.draft} />
                  <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: px(13), fontWeight: '600', color: c.foreground }}>{card.title}</Text>
                  <Text testID="attention-row-workspace" numberOfLines={1} style={{ flexShrink: 1, maxWidth: '40%', fontSize: px(11), color: c.foregroundMuted }}>{workspace}</Text>
                </Pressable>;
              })}
            </View>}
            {!selection.attention.length && <Notice text={m.noAttention} colors={c} />}
            </>}
          </View>
          <Text style={{ fontSize: px(15), fontWeight: '600', color: c.foreground }}>{m.progress} · {selection.boards.length}</Text>
          {!kept?.boards.length && <><Notice text={m.noWorkspaces} colors={c} /><Notice text={m.initialize} colors={c} /></>}
          {selection.boards.map((b, index) => {
            const w = workspaceEntry(names.directory, b.workspaceId, b.cwd);
            const group = w?.projectId ?? '';
            const previous = selection.boards[index - 1];
            const heading = !previous || workspaceProjectId(names.directory, previous.workspaceId, previous.cwd) !== group;
            const detail = workspaceDetail(names.directory, b.workspaceId, b.cwd);
            return <View key={b.id} style={{ gap: px(6) }}>
              {/* REQ-65 ⑧: the project leads in bold, as on the board and in Paseo's sidebar; its rows sit under it. */}
              {heading && <Text testID="overview-project-heading" numberOfLines={1} style={{ fontSize: px(13), fontWeight: '600', color: c.foreground }}>{w?.projectName ?? m.unlinked}</Text>}
              <Pressable accessibilityRole="button" testID={b.hasLedger === false ? 'overview-empty-row' : 'overview-board-row'} onPress={() => onBoard(b.id)}
                style={{ borderBottomWidth: 1, borderColor: c.border, paddingVertical: px(10), minHeight: px(52),
                  flexDirection: mobile ? 'column' : 'row', gap: px(8), alignItems: mobile ? 'stretch' : 'center' }}>
                <Text testID="overview-workspace-name" numberOfLines={1} style={{ flex: mobile ? undefined : 1, minWidth: 0, color: c.foreground, fontSize: px(14) }}>
                  {workspaceName(b.workspaceId, b.cwd, names.directory)}
                  {!!detail && <Text style={{ color: c.foregroundMuted, fontSize: px(11) }}> · {detail}</Text>}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(10) }}>
                  <Text testID="overview-ledger-state" style={{ color: c.foregroundMuted, fontSize: px(11) }}>{b.hasLedger === false ? m.emptyLane : m.hasLedgerLabel}</Text>
                  <Text style={{ color: c.foreground, fontSize: px(12) }}>{m.cardsProgress(b.progress.done, b.progress.requested)}</Text>
                  <View style={{ width: px(60), height: px(4), borderRadius: px(2), backgroundColor: c.surface2 }}>
                    <View style={{ width: `${b.progress.percent ?? 0}%`, height: px(4), backgroundColor: c.accent }} />
                  </View>
                  <Text style={{ color: b.needsHuman ? c.statusWarning : c.foregroundMuted, fontSize: px(11) }}>{m.needsHuman} {b.needsHuman}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: px(11) }}>{m.drafts} {b.progress.draft}</Text>
                  <Icon name="ChevronRight" size={px(14)} color={c.foregroundMuted} />
                </View>
              </Pressable>
            </View>;
          })}
          {state.data?.errors.map((error, i) => <Notice key={i} text={`${error.code}: ${error.message} ${error.target} ${error.nextAction}`} colors={c} error />)}
        </>}
      </ScrollView>
    </View>
    <SettingsSheet {...settingsWindow.sheet} hostId={props.host.id} settings={settings} autoCards={autoCards} readOnly={false}
      workspaces={selection ? { entries: workspaceAutoEntries(selection.boards, names.directory), switch: workspaceAuto } : undefined}
      hiddenBoards={kept && (kept.hidden || reveal) ? { count: kept.hidden, shown: reveal, onChange: setReveal } : undefined}
      about={state.data?.about} connection={{ host: props.host.label, observedAt: state.data?.observedAt ?? '' }} colors={c} m={m} platform={props.layout.platform}
      {...(onDemo ? { demo: { on: false, onChange: (next: boolean) => { if (next) onDemo(); } } } : {})}
      orderReset={{ enabled: order.projects.length + order.workspaces.length + flatOrder(order).length > 0, onReset: () => setOrder(emptyLaneOrder()) }} />
    <MenuSheet title={m.projects} open={projectsOpen} onClose={() => setProjectsOpen(false)} colors={c} platform={props.layout.platform} closeLabel={m.close}>{sc =>
      <View style={{ gap: px(4) }}>
        {/* REQ-57 ④: every project is on until it is switched off; the first row switches them all. */}
        <Button testID="project-toggle-all" label={m.allProjects} colors={sc} mobile selected={shown[0].length === 0}
          onPress={() => { shown[1](shown[0].length ? [] : [...projectOptions.keys()]); setAll(false); }} />
        {[...projectOptions].sort((a, b) => a[1].localeCompare(b[1])).map(([id, title]) =>
          <Button key={id || 'unlinked'} testID="project-choice" label={title} colors={sc} mobile selected={!shown[0].includes(id)}
            onPress={() => { shown[1](shown[0].includes(id) ? shown[0].filter(v => v !== id) : [...shown[0], id]); setAll(false); }} />)}
      </View>}
    </MenuSheet>
    {create && state.data && <CreateDraft {...props} boards={kept?.boards ?? state.data.boards} directory={names.directory}
      locale={state.data.locale} onClose={() => setCreate(false)} onChanged={refresh}
      onCreated={(boardId, cardId) => { setCreate(false); setDetail({ boardId, cardId }); }} />}
    {detail && <Detail {...props} key={`${props.host.id}:${detail.cardId}`} {...detail} lead={lead}
      locale={locale} onClose={() => setDetail(null)} onChanged={refresh} />}
    {names.settled && <DirectoryReadyMark />}
  </View>;
}
