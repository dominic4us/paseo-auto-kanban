import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Modal as NativeModal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView, TextInput } from '@getpaseo/plugin/client/react-native';
import type { BoardAlign, LabsDTO, MailAliasRule, MailDTO, ThemeChoice, UiSettingsDTO } from '../shared/rpc.js';
import type { Copy } from './i18n.js';
import { readable, type Palette } from './palette.js';
import { SETTINGS_WINDOW, settingsWindowSize, type HostPlatform } from './layout.js';
import { Button, IconButton, Notice, usePointerTip } from './components.js';
import { canStep, px, stepScale, UI_SCALE } from './ui-scale.js';
import { useRowSaves, useSettingsWriter, type KanbanSettings, type RowState } from './settings.js';
import { sidebarCanOpenPanel, useOpenLocation, writeOpenLocation, type OpenLocation } from './open-location.js';
import type { AutoCardsSwitch, WorkspaceAutoSwitch } from './auto-cards.js';
import { normalizeCwd } from '../shared/rpc.js';
import { devDemoEntry } from './demo.js';
import { clockTime } from './refresh-status.js';
import { KanbanSheet } from './kanban-sheet.js';
import { AutoArchiveChoice, type AutoArchiveSwitch } from './archive.js';
import type { HiddenBoards } from './hidden-boards.js';
import { CheckupSettingsRow } from './checkup.js';

/**
 * REQ-66: the Kanban settings window. The structure follows a desktop settings window — categories on
 * the left, rows on the right (title and description, the control at the right end), faint dividers and a
 * rounded outline — in the host's colours only. The host `Modal` has no width, so the wide window draws
 * its own outline inside a transparent RN modal (which still gives Escape, the backdrop and the focus
 * trap), sized from the plugin area: min(720, area − 96) × min(560, area height − 96), centred on the
 * area when it can be measured. Below 760px, and on native hosts, it is one column: categories first,
 * then the chosen category's rows, with ‹ back — in a Kanban sheet from the bottom (REQ-72), not the host's.
 */
type AutomationTab = 'cards' | 'archive' | 'status';
export type SettingsCategory = 'display' | 'automation' | 'about' | 'labs';
export type PluginArea = { width: number; height?: number | undefined; x?: number | undefined; y?: number | undefined };

/**
 * REQ-66/REQ-67 ⑥/REQ-68: what a screen needs to open the settings window from its ⚙ — the plugin area
 * measured from `root` when it opens, and focus handed back to ⚙ (`opener`) once the window has gone.
 */
export function useSettingsWindow(width: number, closeMenu: () => void = () => {}) {
  const [area, setArea] = useState<PluginArea | null>(null);
  const root = useRef<View>(null), opener = useRef<View>(null), restore = useRef(false);
  const open = () => {
    closeMenu(); restore.current = true;
    const fallback = { width };
    const node = root.current as unknown as { measureInWindow?: (done: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (typeof node?.measureInWindow !== 'function') { setArea(fallback); return; }
    node.measureInWindow((x, y, w, h) => setArea(w > 0 && h > 0 ? { x, y, width: w, height: h } : fallback));
  };
  return { root, opener, open, sheet: { open: !!area, area: area ?? { width }, onClose: () => setArea(null),
    onDismiss: () => { if (restore.current) { restore.current = false; opener.current?.focus(); } } } };
}

/**
 * REQ-68: what the Kanban screens' ⋯ used to hold. A screen passes only what it can do — the board has no
 * demo and no order of its own, so its window shows neither row.
 */
export type DemoSwitch = { on: boolean; onChange: (next: boolean) => void };
export type OrderReset = { enabled: boolean; onReset: () => void };
/** REQ-69: the host a screen reads from and when it last read — once "Host" and "Last checked" in the list's and board's ⋯. */
export type Connection = { host: string; observedAt: string };
/**
 * REQ-90: the lab, for a screen that draws its features — what the message folder read last (`mail`, for the row's status
 * line) and `onChange`, called after a lab field is saved, so the screen reads the badge's data again at once.
 */
export type LabsLink = { mail?: MailDTO | undefined; onChange: () => void };
/** D44: the workspaces a screen shows (its lanes: folder and name) and their auto-card switches. */
export type WorkspaceAutoCards = { entries: { cwd: string; name: string }[]; switch: WorkspaceAutoSwitch };
/** REQ-137: the read-only "Leads by workspace" lines (`workspaceLeadEntries`); a screen without the boards' cards passes none. */
export type WorkspaceLeads = { cwd: string; name: string; text: string; kind: string }[];
export function SettingsSheet({ open, onClose, onDismiss, hostId, settings, autoCards, readOnly, about, area, colors, m, platform,
  demo, orderReset, connection, labs, workspaces, leads, autoArchive, hiddenBoards, checkup }: {
  open: boolean; onClose: () => void; onDismiss?: () => void; hostId: string; settings: KanbanSettings; autoCards: AutoCardsSwitch;
  readOnly: boolean; about?: { version: string; release?: string | undefined } | undefined; area: PluginArea;
  colors: Palette; m: Copy; platform: HostPlatform; demo?: DemoSwitch | undefined; orderReset?: OrderReset | undefined;
  connection?: Connection | undefined; labs?: LabsLink | undefined; workspaces?: WorkspaceAutoCards | undefined;
  leads?: WorkspaceLeads | undefined;
  /** REQ-52: the automatic archive's days, for the whole plugin; a screen without it (an older one) shows no row. */
  autoArchive?: AutoArchiveSwitch | undefined;
  /** REQ-138: the empty boards of archived or gone workspaces the screen leaves out; none hidden (and not shown again) shows no row. */
  hiddenBoards?: HiddenBoards | undefined;
  /** REQ-149: the phone's way to the check up — the first row of the category list, with how many cards it found. */
  checkup?: { count: number; onOpen: () => void } | undefined;
}) {
  const screen = useWindowDimensions();
  const wide = platform === 'web' && area.width >= SETTINGS_WINDOW.narrow;
  const [category, setCategory] = useState<SettingsCategory | null>(wide ? 'display' : null);
  const [automationTab, setAutomationTab] = useState<AutomationTab>('cards');
  const automationId = useId();
  // Every opening starts at the first category (wide) or at the category list (one column).
  // REQ-67 ⑥: and without the row errors of the last opening (a save still on its way keeps its note).
  const rows = useRowSaves(), write = useSettingsWriter(hostId);
  // REQ-158: where the left menu opens Kanban; only a newer web host's menu can open the right panel.
  const openIn = useOpenLocation(hostId), openInShown = platform === 'web' && sidebarCanOpenPanel();
  useEffect(() => { if (open) { setCategory(wide ? 'display' : null); rows.clearFailed(); } }, [open, wide]);
  useEffect(() => { if (open) setAutomationTab('cards'); }, [open]);
  // REQ-72: the window and the sheet are both drawn here, background and text in the chosen theme.
  const c = colors;
  // D28: `c.border` reads at ~1.2:1 on the sheet, too faint to find; `c.divider` is the set's own line
  // colour, already ~1.5-2:1 there without going as dark as a functional border.
  const divider = c.divider;
  // REQ-90: the lab is there only behind the developer key (REQ-69's `devDemoEntry`): testers and users never see it.
  const labsShown = devDemoEntry();
  // D44: one switch per folder, in the order the screen gave (two lanes of one folder share it). 249-D3: a folder is its
  // spelling (`normalizeCwd`); two Windows folders differing only in case are two rows, as the server judges them apart.
  const workspaceRows = (workspaces?.entries ?? []).map(w => ({ ...w, key: normalizeCwd(w.cwd) }))
    .filter((w, index, all) => !!w.key && all.findIndex(other => other.key === w.key) === index);
  // A failed workspace must stay visible even while another row is saving.
  const workspaceStates = workspaceRows.map(w => rows.state('autoCards:' + w.key));
  const workspaceState = workspaceStates.find(state => state?.state === 'failed') ?? workspaceStates.find(Boolean) ?? null;
  const automationAttention = {
    cards: rows.state('autoCards')?.state === 'failed' || workspaceState?.state === 'failed',
    archive: rows.state('autoArchive')?.state === 'failed' || !!autoArchive?.damaged,
    status: rows.state('autoRefresh')?.state === 'failed' || !!leads?.some(w => w.kind === 'setUnusable'),
  };
  const categories: { id: SettingsCategory; label: string }[] = [
    { id: 'display', label: m.settingsDisplay }, { id: 'automation', label: m.settingsAutomation }, { id: 'about', label: m.settingsAbout },
    ...(labsShown ? [{ id: 'labs' as const, label: m.settingsLabs }] : [])];
  const title = (id: SettingsCategory) => categories.find(entry => entry.id === id)?.label ?? '';
  const version = about ? m.version(about.version) + ' · ' + (about.release ? m.release(about.release) : m.devBuild) : '—';
  const stacked = !wide;
  const checkedAt = connection?.observedAt ? Date.parse(connection.observedAt) : NaN;
  const connected = connection ? connection.host + (Number.isFinite(checkedAt) ? ' · ' + m.lastCheckedAt(clockTime(checkedAt)) : '') : '';
  const body = (id: SettingsCategory) => <View testID={'settings-category-' + id}
    style={id === 'automation' ? { flex: 1, minHeight: 0 } : undefined}>
    {id === 'display' && <>
      {/* REQ-70: the theme leads the category. Four choices; Paseo (the host's colours) until one is picked. */}
      <SettingRow testID="setting-theme" title={m.theme} help={m.themeHelp} colors={c} m={m} stacked
        state={rows.state('theme')} onRetry={() => rows.retry('theme')}
        control={<ThemeChoiceRow value={settings.theme} colors={c} m={m} disabled={readOnly || rows.state('theme')?.state === 'saving'}
          onChange={value => { if (!readOnly && value !== settings.theme) void rows.run('theme', () => write({ theme: value })); }} />} />
      {/* REQ-139: how large the Kanban screens draw — one step smaller or larger, and back to 100%. */}
      <SettingRow testID="setting-ui-scale" title={m.uiScale} help={m.uiScaleHelp} colors={c} m={m} stacked={stacked}
        state={rows.state('uiScale')} onRetry={() => rows.retry('uiScale')}
        control={<ScaleControl value={settings.uiScale} colors={c} m={m} mobile={stacked} disabled={readOnly || rows.state('uiScale')?.state === 'saving'}
          onChange={value => { if (!readOnly && value !== settings.uiScale) void rows.run('uiScale', () => write({ uiScale: value })); }} />} />
      <SettingRow testID="setting-board-align" title={m.boardAlign} help={m.boardAlignHelp} colors={c} m={m} stacked last={!orderReset && !openInShown}
        state={rows.state('boardAlign')} onRetry={() => rows.retry('boardAlign')}
        control={<AlignChoice value={settings.boardAlign} colors={c} m={m} disabled={readOnly || rows.state('boardAlign')?.state === 'saving'}
          onChange={value => { if (!readOnly && value !== settings.boardAlign) void rows.run('boardAlign', () => write({ boardAlign: value })); }} />} />
      {/* REQ-158: kept on this device at once, with no server write, so the row has no saving or failed state. */}
      {openInShown && <SettingRow testID="setting-open-in" title={m.openIn} help={m.openInHelp} colors={c} m={m} stacked last={!orderReset}
        state={null} control={<OpenInChoice value={openIn} colors={c} m={m} disabled={readOnly}
          onChange={value => { if (!readOnly && value !== openIn) writeOpenLocation(hostId, value); }} />} />}
      {/* REQ-68: the way back from every arranged project and workspace (REQ-59 ③), once in ⋯. Like there, the
          demo resets its own in-memory order. */}
      {orderReset && <SettingRow testID="setting-order-reset" title={m.resetAllOrder} help={m.resetOrderHelp} colors={c} m={m} stacked={stacked} last
        state={null} control={<View style={{ opacity: orderReset.enabled ? 1 : .4 }}>
          <Button testID="order-reset-all" label={m.resetOrderButton} colors={c} selected mobile={stacked}
            disabled={!orderReset.enabled} onPress={orderReset.onReset} /></View>} />}
    </>}
    {id === 'automation' && <>
      <AutomationTabs value={automationTab} onChange={setAutomationTab} attention={automationAttention} id={automationId} colors={c} m={m} />
      <ScrollView key={automationTab} testID="automation-scroll" style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled">
      {(['cards', 'archive', 'status'] as const).filter(tab => tab !== automationTab).map(tab => <View key={tab} role="tabpanel"
        nativeID={automationId + '-panel-' + tab} style={{ display: 'none' }}
        {...({ 'aria-labelledby': automationId + '-tab-' + tab } as object)} />)}
      <View role="tabpanel" nativeID={automationId + '-panel-' + automationTab} testID={'automation-panel-' + automationTab}
        {...({ 'aria-labelledby': automationId + '-tab-' + automationTab, tabIndex: 0 } as object)}>
      <Text testID="automation-panel-title" accessibilityRole="header" style={{ color: c.foregroundMuted,
        fontSize: px(11), fontWeight: '600', paddingTop: px(12), paddingBottom: px(4) }}>
        {automationTab === 'cards' ? m.automationCardsTitle : automationTab === 'archive' ? m.automationArchiveTitle : m.automationStatusTitle}
      </Text>
      {automationTab === 'cards' && <>
      <SettingRow testID="setting-auto-cards" title={m.autoCards} help={m.autoCardsHelp} colors={c} m={m} stacked={stacked}
        state={rows.state('autoCards')} onRetry={() => rows.retry('autoCards')}
        control={<SettingSwitch testID="auto-cards-toggle" label={m.autoCards} value={autoCards[0]} colors={c}
          disabled={readOnly || rows.state('autoCards')?.state === 'saving'}
          onChange={next => { if (!readOnly) void rows.run('autoCards', () => autoCards[1](next)); }} />} />
      {/* D44: each workspace's own switch — off stops its cards, their moves and its automatic board. */}
      {!!workspaceRows.length && <SettingRow testID="setting-auto-cards-workspaces" title={m.autoCardsWorkspaces}
        help={autoCards[0] ? m.autoCardsWorkspacesHelp : m.autoCardsWorkspacesHostOff} colors={c} m={m} stacked
        state={workspaceState}
        onRetry={() => workspaceRows.forEach(w => { if (rows.state('autoCards:' + w.key)?.state === 'failed') rows.retry('autoCards:' + w.key); })}
        control={<View testID="auto-cards-workspace-list" style={{ alignSelf: 'stretch' }}>
          {workspaceRows.map((w, index) => <View key={w.key} testID={'auto-cards-workspace-' + index}
            style={{ minHeight: px(40), flexDirection: 'row', alignItems: 'center', gap: px(12),
              borderTopWidth: index ? 1 : 0, borderColor: divider }}>
            <Text style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: px(13) }}>{w.name}</Text>
            <SettingSwitch testID={'auto-cards-workspace-toggle-' + index} label={m.autoCardsWorkspaces + ' · ' + w.name}
              value={workspaces!.switch.isOn(w.cwd)} colors={c}
              disabled={readOnly || !autoCards[0] || rows.state('autoCards:' + w.key)?.state === 'saving'}
              onChange={next => { if (!readOnly) void rows.run('autoCards:' + w.key, () => workspaces!.switch.set(w.cwd, next)); }} />
          </View>)}
        </View>} />}
      </>}
      {automationTab === 'archive' && <>
      {/* REQ-52 (research/294): finished cards archived by themselves after these days, or never (Off). */}
      {autoArchive && <SettingRow testID="setting-auto-archive" title={m.autoArchive} help={m.autoArchiveHelp} colors={c} m={m} stacked
        state={rows.state('autoArchive')} onRetry={() => rows.retry('autoArchive')}
        control={<View style={{ gap: px(8), alignSelf: 'stretch' }}>
          <AutoArchiveChoice value={autoArchive.days} damaged={autoArchive.damaged} colors={c} m={m}
            disabled={readOnly || rows.state('autoArchive')?.state === 'saving'}
            onChange={days => { if (!readOnly) void rows.run('autoArchive', () => autoArchive.set(days)); }} />
          {autoArchive.damaged && <Notice testID="auto-archive-damaged" text={m.autoArchiveDamaged} colors={c} error />}
        </View>} />}
      </>}
      {automationTab === 'status' && <>
      {/* REQ-137 (research/273 B ⑤): who leads each workspace, read only — changed from a card's ⋯ ("Mark as lead"). */}
      {!!leads?.length && <SettingRow testID="setting-lead-status" title={m.leadStatusTitle} help={m.leadStatusHelp} colors={c} m={m} stacked state={null}
        control={<View testID="lead-status-list" style={{ alignSelf: 'stretch' }}>
          {/* The workspace on its line, who leads it under — neither cut, wide or on a phone. */}
          {leads.map((w, index) => <View key={w.cwd + ':' + index} testID={'lead-status-' + index} accessibilityLabel={w.name + ': ' + w.text}
            style={{ minHeight: px(36), paddingVertical: px(6), gap: px(2), borderTopWidth: index ? 1 : 0, borderColor: divider }}>
            <Text style={{ color: c.foreground, fontSize: px(13) }}>{w.name}</Text>
            <Text testID={'lead-status-text-' + index} style={{ fontSize: px(12),
              color: w.kind === 'set' ? c.foreground : c.foregroundMuted, fontWeight: w.kind === 'set' ? '600' : '400' }}>{w.text}</Text>
          </View>)}
        </View>} />}
      <SettingRow testID="setting-auto-refresh" title={m.autoRefresh} help={m.autoRefreshHelp} colors={c} m={m} stacked={stacked} last
        state={rows.state('autoRefresh')} onRetry={() => rows.retry('autoRefresh')}
        control={<SettingSwitch testID="auto-refresh-toggle" label={m.autoRefresh} value={settings.autoRefresh} colors={c}
          disabled={readOnly || rows.state('autoRefresh')?.state === 'saving'}
          onChange={next => { if (!readOnly) void rows.run('autoRefresh', () => write({ autoRefresh: next })); }} />} />
      </>}
      </View>
      {readOnly && <View style={{ paddingTop: px(12) }}><Notice text={m.demoReadOnly} colors={c} /></View>}
      </ScrollView>
    </>}
    {id === 'about' && <>
      {/* REQ-68: the demo switch, once "Preview demo data" in ⋯. It stays on while the demo is showing, to turn it off.
          REQ-69: and appears only behind the developer entry (`devDemoEntry`) — the demo is for tests, not users. */}
      {demo && (demo.on || devDemoEntry()) && <SettingRow testID="setting-demo" title={m.demo} help={m.demoHelp} colors={c} m={m} stacked={stacked} state={null}
        control={<SettingSwitch testID="demo-toggle" label={m.demo} value={demo.on} colors={c} disabled={false} onChange={demo.onChange} />} />}
      {connection && <SettingRow testID="setting-connection" title={m.connectedHost} colors={c} m={m} stacked={stacked} state={null}
        control={<Text testID="settings-connection" selectable style={{ color: c.foregroundMuted, fontSize: px(13) }}>{connected}</Text>} />}
      {/* REQ-138: how many empty boards of archived or gone workspaces are left out, and a switch that shows them for this session. */}
      {hiddenBoards && <SettingRow testID="setting-hidden-boards" title={m.hiddenBoards} help={m.hiddenBoardsHelp} colors={c} m={m} stacked={stacked} state={null}
        control={<View style={{ flexDirection: 'row', alignItems: 'center', gap: px(12) }}>
          <Text testID="hidden-boards-count" style={{ color: c.foregroundMuted, fontSize: px(13) }}>{m.hiddenBoardsCount(hiddenBoards.count)}</Text>
          <SettingSwitch testID="hidden-boards-toggle" label={m.hiddenBoardsShow} value={hiddenBoards.shown} colors={c} disabled={false}
            onChange={hiddenBoards.onChange} />
        </View>} />}
      <SettingRow testID="setting-version" title={m.versionRow} colors={c} m={m} stacked={stacked} last state={null}
        control={<Text testID="settings-version" selectable style={{ color: c.foregroundMuted, fontSize: px(13) }}>{version}</Text>} />
    </>}
    {id === 'labs' && labsShown && <LabsSection labs={settings.labs} readOnly={readOnly} rows={rows} write={write} link={labs}
      colors={c} m={m} stacked={stacked} />}
    {readOnly && id !== 'about' && id !== 'automation' && <View style={{ paddingTop: px(12) }}><Notice text={m.demoReadOnly} colors={c} /></View>}
  </View>;
  const categoryList = <View testID="settings-category-list">
    {checkup && <CheckupSettingsRow count={checkup.count} onPress={checkup.onOpen} colors={c} m={m} />}
    {categories.map((entry, index) => <Pressable key={entry.id} testID={'settings-open-' + entry.id} accessibilityRole="button"
      accessibilityLabel={entry.label} onPress={() => setCategory(entry.id)}
      style={{ minHeight: px(48), flexDirection: 'row', alignItems: 'center', gap: px(8),
        borderBottomWidth: index < categories.length - 1 ? 1 : 0, borderColor: divider }}>
      <Text style={{ flex: 1, color: c.foreground, fontSize: px(15) }}>{entry.label}</Text>
      <Icon name="ChevronRight" size={px(16)} color={c.foregroundMuted} />
    </Pressable>)}
  </View>;
  // One column: the list of categories, or one category under a ‹ back to the list.
  const column = <View style={{ gap: px(4), ...(category === 'automation' ? { flex: 1, minHeight: 0, padding: px(16), paddingBottom: px(8) } : {}) }}>
    {category && <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(4), marginLeft: px(-8) }}>
      <IconButton testID="settings-back" name="ChevronLeft" label={m.settingsBack} onPress={() => setCategory(null)}
        colors={c} mobile plain iconSize={px(22)} />
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: px(16), fontWeight: '600' }}>{title(category)}</Text>
    </View>}
    {category ? body(category) : categoryList}
  </View>;
  // D67: Automation's list scrolls under its tabs by itself, so its sheet is as tall as a sheet may be (90%) — without a
  // height Yoga lays that list out at 0 on the phone. The other categories scroll with the sheet and size to their rows.
  if (!wide) return <KanbanSheet testID="settings-sheet" closeTestID="settings-close" title={m.settings} open={open} onClose={onClose}
    onDismiss={onDismiss} colors={c} platform={platform} closeLabel={m.close} centered={false} scroll={category !== 'automation'}
    {...(category === 'automation' ? { height: screen.height * .9 } : {})}>{column}</KanbanSheet>;
  const header = <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: px(16), paddingRight: px(8), minHeight: px(48),
    borderBottomWidth: 1, borderColor: c.border }}>
    <Text accessibilityRole="header" style={{ flex: 1, color: c.foreground, fontSize: px(15), fontWeight: '600' }}>{m.settings}</Text>
    <IconButton testID="settings-close" name="X" label={m.close} onPress={onClose} colors={c} mobile={false} plain />
  </View>;
  const size = settingsWindowSize({ width: area.width, height: area.height ?? screen.height });
  // Centred on the plugin area when it was measured (the modal itself covers the whole window).
  const placed = area.x !== undefined && area.y !== undefined && area.height !== undefined
    ? { position: 'absolute' as const, left: Math.max(px(8), Math.round(area.x + (area.width - size.width) / 2)),
      top: Math.max(px(8), Math.round(area.y + (area.height - size.height) / 2)) } : {};
  return <NativeModal visible={open} transparent animationType="none" onRequestClose={onClose} {...(onDismiss ? { onDismiss } : {})}>
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Pressable accessibilityLabel={m.close} onPress={onClose}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: c.modalBackdrop }} />
      <View testID="settings-window" role="dialog" aria-label={m.settings} accessibilityViewIsModal
        style={{ ...placed, width: size.width, height: size.height, backgroundColor: c.surface0, borderRadius: px(12),
          borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
        {header}
        <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
          <View testID="settings-nav" style={{ width: area.width < 900 ? SETTINGS_WINDOW.navNarrow : SETTINGS_WINDOW.nav,
            padding: px(8), gap: px(2), borderRightWidth: 1, borderColor: c.border }}>
            {categories.map(entry => {
              const selected = entry.id === category;
              return <Pressable key={entry.id} testID={'settings-tab-' + entry.id} accessibilityRole="tab"
                accessibilityState={{ selected }} aria-selected={selected} onPress={() => setCategory(entry.id)}
                style={{ minHeight: px(32), justifyContent: 'center', paddingHorizontal: px(10), borderRadius: px(6),
                  backgroundColor: selected ? c.surface2 : 'transparent' }}>
                <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: px(13), fontWeight: selected ? '600' : '400' }}>{entry.label}</Text>
              </Pressable>;
            })}
          </View>
          {category === 'automation' ? <View style={{ flex: 1, minWidth: 0, paddingHorizontal: px(20), paddingVertical: px(8) }}>{body('automation')}</View>
          : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: px(20), paddingVertical: px(8) }}>
            {body(category ?? 'display')}
          </ScrollView>}
        </View>
      </View>
    </View>
  </NativeModal>;
}

/** REQ-151: automatic activation, one Tab stop, and paired tab/panel names on web and native.
 * Wrap labels rather than hide or horizontally scroll them at 360px / 150%. The bar stays above the list's scroll.
 */
function AutomationTabs({ value, onChange, attention, id, colors: c, m }: {
  value: AutomationTab; onChange: (next: AutomationTab) => void; attention: Record<AutomationTab, boolean>;
  id: string; colors: Palette; m: Copy;
}) {
  const refs = useRef<(View | null)[]>([]);
  const danger = readable(c.statusDanger, c.surface0, 4.5);
  const tabs: { id: AutomationTab; label: string }[] = [
    { id: 'cards', label: m.automationCardsTab }, { id: 'archive', label: m.automationArchiveTab }, { id: 'status', label: m.automationStatusTab }];
  return <View testID="automation-tabs" role="tablist" accessibilityLabel={m.settingsAutomation}
    style={{ flexDirection: 'row', flexShrink: 0, borderBottomWidth: 1, borderColor: c.divider }}>
    {tabs.map((tab, index) => {
      const selected = value === tab.id, label = tab.label + (attention[tab.id] ? ' · ' + m.automationNeedsAttention : '');
      const keys = { tabIndex: selected ? 0 : -1, 'aria-controls': id + '-panel-' + tab.id,
        onKeyDown: (e: { key?: string; preventDefault?: () => void }) => {
          const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
            : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : e.key === ' ' || e.key === 'Enter' ? index : -1;
          if (next < 0) return;
          e.preventDefault?.(); onChange(tabs[next]!.id); refs.current[next]?.focus();
        } } as object;
      return <Pressable key={tab.id} ref={node => { refs.current[index] = node; }} nativeID={id + '-tab-' + tab.id}
        testID={'automation-tab-' + tab.id} role="tab" accessibilityRole="tab" accessibilityLabel={label}
        accessibilityState={{ selected }} aria-selected={selected} {...keys} onPress={() => onChange(tab.id)}
        style={{ flex: 1, minWidth: 0, minHeight: px(44), paddingHorizontal: px(4), paddingVertical: px(8), justifyContent: 'center',
          borderBottomWidth: 2, borderBottomColor: selected ? (attention[tab.id] ? danger : c.accent) : 'transparent' }}>
        <Text style={{ color: attention[tab.id] ? danger : selected ? c.foreground : c.foregroundMuted, fontSize: px(13), lineHeight: px(18),
          fontWeight: selected ? '600' : '400', textAlign: 'center' }}>{tab.label}{attention[tab.id] ? ' !' : ''}</Text>
      </Pressable>;
    })}
  </View>;
}

/**
 * REQ-90: the lab's rows. A note says what the lab is; each feature has its switch, off by default. The badge's folder is
 * typed and saved with its button (or Enter), not on every key, so a half-typed path is never read. Every save sends the
 * whole lab, which the server keeps field by field (server/ui-state.ts), and then asks the screen to read the badge again.
 */
const noOutline = { outlineStyle: 'none', outlineWidth: 0 } as object;
function LabsSection({ labs, readOnly, rows, write, link, colors: c, m, stacked }: {
  labs: LabsDTO; readOnly: boolean; rows: ReturnType<typeof useRowSaves>; write: (patch: UiSettingsDTO) => Promise<boolean>;
  link?: LabsLink | undefined; colors: Palette; m: Copy; stacked: boolean;
}) {
  const [dir, setDir] = useState(labs.mailDir ?? ''), [focused, setFocused] = useState(false);
  useEffect(() => { setDir(labs.mailDir ?? ''); }, [labs.mailDir]);
  const save = (key: string, patch: LabsDTO) => {
    if (readOnly) return;
    void rows.run(key, async () => { const ok = await write({ labs: { ...labs, ...patch } }); if (ok) link?.onChange(); return ok; });
  };
  const saving = (key: string) => readOnly || rows.state(key)?.state === 'saving';
  const typed = dir.trim(), dirty = typed !== (labs.mailDir ?? '');
  const mail = labs.mail ? link?.mail : undefined;
  const status = mail ? mail.error ? m.labsMailUnreadable : m.labsMailStatus(mail.threads.length, mail.unknown.length) : '';
  return <>
    <Text testID="labs-note" style={{ color: c.foregroundMuted, fontSize: px(12), lineHeight: px(17), paddingTop: px(12), paddingBottom: px(4) }}>{m.labsNote}</Text>
    <SettingRow testID="setting-labs-mail" title={m.labsMail} help={m.labsMailHelp} colors={c} m={m} stacked={stacked}
      state={rows.state('labsMail')} onRetry={() => rows.retry('labsMail')}
      control={<View style={{ alignItems: stacked ? 'flex-start' : 'flex-end', gap: px(6) }}>
        <SettingSwitch testID="labs-mail-toggle" label={m.labsMail} value={!!labs.mail} colors={c} disabled={saving('labsMail')}
          onChange={next => save('labsMail', { mail: next })} />
        {!!status && <Text testID="labs-mail-status" style={{ color: c.foregroundMuted, fontSize: px(12) }}>{status}</Text>}
      </View>} />
    <SettingRow testID="setting-labs-mail-dir" title={m.labsMailDir} help={m.labsMailDirHelp} colors={c} m={m} stacked
      state={rows.state('labsMailDir')} onRetry={() => rows.retry('labsMailDir')}
      control={<View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), alignSelf: 'stretch' }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextInput testID="labs-mail-dir" accessibilityLabel={m.labsMailDir} placeholder={m.labsMailDirPlaceholder}
            placeholderTextColor={c.foregroundMuted} value={dir} onChangeText={setDir} autoCorrect={false} autoCapitalize="none"
            editable={!saving('labsMailDir')} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onSubmitEditing={() => { if (dirty) save('labsMailDir', { mailDir: typed }); }}
            style={{ height: stacked ? px(44) : px(30), borderRadius: px(6), borderWidth: 1, borderColor: focused ? c.accent : c.border, ...noOutline,
              backgroundColor: c.surface1, color: c.foreground, paddingHorizontal: px(8), fontSize: px(13) }} />
        </View>
        <View style={{ opacity: dirty ? 1 : .4 }}>
          <Button testID="labs-mail-dir-save" label={m.labsMailDirSave} colors={c} selected mobile={stacked}
            disabled={!dirty || saving('labsMailDir')} onPress={() => save('labsMailDir', { mailDir: typed })} />
        </View>
      </View>} />
    <SettingRow testID="setting-labs-mail-alias" title={m.labsMailAlias} help={m.labsMailAliasHelp} colors={c} m={m} stacked={stacked} last
      state={rows.state('labsMailAlias')} onRetry={() => rows.retry('labsMailAlias')}
      control={<AliasChoice value={labs.mailAlias ?? 'compact'} disabled={saving('labsMailAlias')} colors={c} m={m}
        onChange={value => { if (value !== (labs.mailAlias ?? 'compact')) save('labsMailAlias', { mailAlias: value }); }} />} />
  </>;
}
function AliasChoice({ value, onChange, disabled, colors: c, m }: {
  value: MailAliasRule; onChange: (next: MailAliasRule) => void; disabled: boolean; colors: Palette; m: Copy;
}) {
  const choices: { id: MailAliasRule; label: string }[] = [{ id: 'compact', label: m.labsAliasCompact }, { id: 'folder', label: m.labsAliasFolder }];
  return <View accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.labsMailAlias} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(8) }}>
    {choices.map(choice => {
      const selected = choice.id === value;
      return <Pressable key={choice.id} testID={'labs-alias-' + choice.id} accessibilityRole="radio" accessibilityLabel={choice.label}
        accessibilityState={{ checked: selected, disabled }} role="radio" aria-checked={selected} aria-disabled={disabled} disabled={disabled}
        onPress={() => onChange(choice.id)}
        style={{ minHeight: px(30), justifyContent: 'center', paddingHorizontal: px(10), borderRadius: px(6), borderWidth: 1, opacity: disabled && !selected ? .5 : 1,
          borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.surface2 : 'transparent' }}>
        <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: px(12), fontWeight: selected ? '600' : '400' }}>{choice.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/** Title and description on the left, the control on the right; a narrow row puts the control below. */
function SettingRow({ title, help, control, state, onRetry, colors: c, m, stacked, last = false, testID }: {
  title: string; help?: string; control: ReactNode; state: RowState; onRetry?: () => void; colors: Palette; m: Copy;
  stacked: boolean; last?: boolean; testID: string;
}) {
  return <View testID={testID} style={{ paddingVertical: px(14), gap: px(8), borderBottomWidth: last ? 0 : 1, borderColor: c.divider }}>
    <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: stacked ? px(10) : px(16) }}>
      <View style={{ flex: stacked ? undefined : 1, gap: px(3) }}>
        <Text style={{ color: c.foreground, fontSize: px(14), fontWeight: '600' }}>{title}</Text>
        {!!help && <Text style={{ color: c.foregroundMuted, fontSize: px(12), lineHeight: px(17) }}>{help}</Text>}
      </View>
      <View style={{ alignItems: stacked ? 'flex-start' : 'flex-end' }}>{control}</View>
    </View>
    {state?.state === 'saving' && <Text testID="setting-saving" style={{ color: c.foregroundMuted, fontSize: px(12) }}>{m.settingSaving}</Text>}
    {state?.state === 'failed' && <View testID="setting-error" style={{ flexDirection: 'row', alignItems: 'center', gap: px(8), flexWrap: 'wrap' }}>
      <View style={{ flexShrink: 1 }}><Notice text={m.settingFailed} colors={c} error /></View>
      {onRetry && <Button testID="setting-retry" label={m.settingRetry} colors={c} selected onPress={onRetry} />}
    </View>}
  </View>;
}

/** A plain switch: the track fills with the host accent when on. */
function SettingSwitch({ value, onChange, disabled, label, colors: c, testID }: {
  value: boolean; onChange: (next: boolean) => void; disabled: boolean; label: string; colors: Palette; testID: string;
}) {
  return <Pressable testID={testID} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }}
    role="switch" aria-checked={value} aria-disabled={disabled}
    disabled={disabled} onPress={() => onChange(!value)} hitSlop={px(8)}
    style={{ width: px(40), height: px(22), borderRadius: px(11), padding: px(2), borderWidth: 1, opacity: disabled ? .5 : 1,
      borderColor: value ? c.accent : c.border, backgroundColor: value ? c.accent : c.surface2,
      alignItems: value ? 'flex-end' : 'flex-start', justifyContent: 'center' }}>
    <View style={{ width: px(16), height: px(16), borderRadius: px(8), backgroundColor: value ? c.accentForeground : c.foregroundMuted }} />
  </Pressable>;
}

/**
 * REQ-139: − the size + and "Back to 100%". Each press is one step (10%) and one write; at 80% "−" and at 150% "+" are off,
 * at 100% the way back is. The figure between them says the size now.
 */
function ScaleControl({ value, onChange, disabled, colors: c, m, mobile }: {
  value: number; onChange: (next: number) => void; disabled: boolean; colors: Palette; m: Copy; mobile: boolean;
}) {
  return <View testID="ui-scale-control" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
    <IconButton testID="ui-scale-smaller" name="Minus" label={m.uiScaleSmaller} colors={c} mobile={mobile} tooltip
      disabled={disabled || !canStep(value, -1)} onPress={() => onChange(stepScale(value, -1))} />
    <Text testID="ui-scale-value" accessibilityLiveRegion="polite" style={{ minWidth: px(48), textAlign: 'center', color: c.foreground,
      fontSize: px(14), fontWeight: '600', fontVariant: ['tabular-nums'] }}>{m.uiScaleValue(value)}</Text>
    <IconButton testID="ui-scale-larger" name="Plus" label={m.uiScaleLarger} colors={c} mobile={mobile} tooltip
      disabled={disabled || !canStep(value, 1)} onPress={() => onChange(stepScale(value, 1))} />
    <View style={{ opacity: value === UI_SCALE.default ? .4 : 1 }}>
      <Button testID="ui-scale-reset" label={m.uiScaleReset} colors={c} mobile={mobile}
        disabled={disabled || value === UI_SCALE.default} onPress={() => onChange(UI_SCALE.default)} />
    </View>
  </View>;
}

/** REQ-66: three choices, each with a small picture of where the board sits in the area. */
function AlignChoice({ value, onChange, disabled, colors: c, m }: {
  value: BoardAlign; onChange: (next: BoardAlign) => void; disabled: boolean; colors: Palette; m: Copy;
}) {
  const choices: { id: BoardAlign; label: string; justify: 'flex-start' | 'center' | 'flex-end' }[] = [
    { id: 'left', label: m.alignLeft, justify: 'flex-start' }, { id: 'center', label: m.alignCenter, justify: 'center' },
    { id: 'right', label: m.alignRight, justify: 'flex-end' }];
  return <View accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.boardAlign} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(8) }}>
    {choices.map(choice => {
      const selected = choice.id === value;
      return <Pressable key={choice.id} testID={'board-align-' + choice.id} accessibilityRole="radio" accessibilityLabel={choice.label}
        accessibilityState={{ checked: selected, disabled }} role="radio" aria-checked={selected} aria-disabled={disabled} disabled={disabled} onPress={() => onChange(choice.id)}
        style={{ alignItems: 'center', gap: px(6), padding: px(8), borderRadius: px(8), borderWidth: 1, opacity: disabled && !selected ? .5 : 1,
          borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.surface2 : 'transparent' }}>
        <View testID={'board-align-picture-' + choice.id} style={{ width: px(64), height: px(36), borderRadius: px(4), borderWidth: 1, borderColor: c.border,
          backgroundColor: c.surface1, padding: px(4), flexDirection: 'row', justifyContent: choice.justify }}>
          <View style={{ width: px(30), gap: px(3) }}>
            <View style={{ height: px(4), borderRadius: px(2), backgroundColor: selected ? c.accent : c.foregroundMuted }} />
            <View style={{ flex: 1, borderRadius: px(2), backgroundColor: selected ? c.accent : c.foregroundMuted, opacity: .45 }} />
          </View>
        </View>
        <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: px(12), fontWeight: selected ? '600' : '400' }}>{choice.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/**
 * REQ-70: light, dark, the device's scheme, or Paseo's — a glyph and a word each, the current one outlined in
 * the accent like the board position. Hovering or focusing one says what it does, below it (the row is the
 * first in its category, so above would be cut off by the scroll area). REQ-80: by every glyph's rule
 * (`usePointerTip`) — a click leaves no tip behind, the keyboard's focus shows it.
 */
/** REQ-158: the main screen or the right panel, drawn like the board position's choices — a Paseo window, the place lit. */
function OpenInChoice({ value, onChange, disabled, colors: c, m }: {
  value: OpenLocation; onChange: (next: OpenLocation) => void; disabled: boolean; colors: Palette; m: Copy;
}) {
  const choices: { id: OpenLocation; label: string }[] = [{ id: 'main', label: m.openInMain }, { id: 'panel', label: m.openInPanel }];
  return <View accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.openIn} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(8) }}>
    {choices.map(choice => {
      const selected = choice.id === value, lit = selected ? c.accent : c.foregroundMuted;
      const part = (on: boolean, width?: number) => <View style={{ ...(width ? { width: px(width) } : { flex: 1 }), borderRadius: px(2),
        backgroundColor: on ? lit : c.foregroundMuted, opacity: on ? 1 : .3 }} />;
      return <Pressable key={choice.id} testID={'open-in-' + choice.id} accessibilityRole="radio" accessibilityLabel={choice.label}
        accessibilityState={{ checked: selected, disabled }} role="radio" aria-checked={selected} aria-disabled={disabled} disabled={disabled} onPress={() => onChange(choice.id)}
        style={{ alignItems: 'center', gap: px(6), padding: px(8), borderRadius: px(8), borderWidth: 1, opacity: disabled && !selected ? .5 : 1,
          borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.surface2 : 'transparent' }}>
        {/* Paseo's left menu, then the main screen and, for the panel, the right panel beside the chat. */}
        <View testID={'open-in-picture-' + choice.id} style={{ width: px(64), height: px(36), borderRadius: px(4), borderWidth: 1, borderColor: c.border,
          backgroundColor: c.surface1, padding: px(4), flexDirection: 'row', gap: px(3) }}>
          {part(false, 10)}{part(choice.id === 'main')}{choice.id === 'panel' && part(true, 18)}
        </View>
        <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: px(12), fontWeight: selected ? '600' : '400' }}>{choice.label}</Text>
      </Pressable>;
    })}
  </View>;
}
function ThemeChoiceRow({ value, onChange, disabled, colors: c, m }: {
  value: ThemeChoice; onChange: (next: ThemeChoice) => void; disabled: boolean; colors: Palette; m: Copy;
}) {
  const choices: { id: ThemeChoice; icon: string; label: string; hint: string }[] = [
    { id: 'light', icon: 'Sun', label: m.themeLight, hint: m.themeLightHint },
    { id: 'dark', icon: 'Moon', label: m.themeDark, hint: m.themeDarkHint },
    { id: 'system', icon: 'Monitor', label: m.themeSystem, hint: m.themeSystemHint },
    { id: 'paseo', icon: 'AppWindow', label: m.themePaseo, hint: m.themePaseoHint }];
  return <View accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.theme} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(8) }}>
    {choices.map((choice, index) => <ThemeChoiceItem key={choice.id} {...choice} selected={choice.id === value} left={index < 2}
      disabled={disabled} onPress={() => onChange(choice.id)} colors={c} />)}
  </View>;
}
function ThemeChoiceItem({ id, icon, label, hint, selected, left, disabled, onPress, colors: c }: {
  id: ThemeChoice; icon: string; label: string; hint: string; selected: boolean; left: boolean; disabled: boolean;
  onPress: () => void; colors: Palette;
}) {
  const tip = usePointerTip();
  return <View style={tip.shown ? { zIndex: 1 } : undefined}>
    <Pressable testID={'theme-' + id} accessibilityRole="radio" accessibilityLabel={label} accessibilityHint={hint}
      accessibilityState={{ checked: selected, disabled }} role="radio" aria-checked={selected} aria-disabled={disabled} disabled={disabled}
      onPress={onPress} {...tip.handlers}
      style={{ width: px(72), alignItems: 'center', gap: px(6), paddingVertical: px(10), borderRadius: px(8), borderWidth: 1,
        opacity: disabled && !selected ? .5 : 1,
        borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.surface2 : 'transparent' }}>
      <Icon name={icon} size={px(20)} color={selected ? c.foreground : c.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: px(12), fontWeight: selected ? '600' : '400' }}>{label}</Text>
    </Pressable>
    {tip.shown && <View testID="theme-tooltip" pointerEvents="none" style={{ position: 'absolute', top: '100%', ...(left ? { left: 0 } : { right: 0 }), marginTop: px(4),
      paddingHorizontal: px(8), paddingVertical: px(4), borderRadius: px(5), zIndex: 10, width: px(200),
      backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border }}>
      <Text style={{ color: c.foreground, fontSize: px(11), lineHeight: px(15) }}>{hint}</Text>
    </View>}
  </View>;
}
