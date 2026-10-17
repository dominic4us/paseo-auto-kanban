import { Fragment, useState, type ReactNode } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import type { WorkflowModelDTO } from '../shared/workflow.js';
import { mixColors, readable, selectedLine, type Palette } from './palette.js';
import type { Copy } from './i18n.js';
import type { HostPlatform } from './layout.js';
import { IconButton } from './components.js';
import { KanbanSheet } from './kanban-sheet.js';
import { localStamp } from './move-reason.js';
import { Evidence, FailedLine, PathList, absentWords, logNoteLines, rowName, toneColor, useWorkflowRead, verdictColor, workflowWords } from './workflow.js';
import type { WorkflowReleaseDTO } from '../shared/workflow.js';
import { EXPORTED_PICK, PROGRAM_ROW, byInstance, endTagText, programConflicts, programRow, sharedEvidence, shownExcluded, cellMark, instanceChip, ladderItems, releaseChip, tableStages, type LadderItem } from './workflow-model.js';
import type { Locale } from '../shared/core/domain.js';
import { BuiltinBanner, BuiltinEmpty, RestingPick, WorkflowPickSheet, exportedLine, type ExportDone } from './workflow-pick.js';
import { px } from './ui-scale.js';

/**
 * REQ-134 WA (research/267, the owner's choice): a lane's workflow on a 390px phone. Its ⋯ sheet offers "Show workflow" where
 * the workspace holds a definition (`offersWorkflow`, as the wide heading's "Board | Workflow"); it opens this sheet over the
 * whole screen — × and the back button close it. The same reading as the wide screens (`useWorkflowRead`, the same key and
 * RPC, read when it opens), drawn for a narrow screen: the flow as a ladder top to bottom (`ladderItems` — the steps of the
 * first row on it, the others beside it, a loop that went back as its own box), and the table as one mark per cell
 * (`cellMark`); a cell pressed shows the wide table's evidence in a sheet from the bottom.
 */
export interface WorkflowTarget { workspaceId: string; name: string }
export function MobileWorkflowSheet({ hostId, target, onClose, colors: c, m, platform, locale = 'ko', onPickChange }: {
  hostId: string; target: WorkflowTarget | null; onClose: () => void; colors: Palette; m: Copy; platform: HostPlatform;
  /** REQ-125: the screen's language for a built-in's names, and a pick changed from the banner (`null`: stopped — the sheet closes). */
  locale?: Locale; onPickChange?: ((template: string | null) => void) | undefined;
}) {
  const screen = useWindowDimensions();
  return <KanbanSheet testID="workflow-sheet" closeTestID="workflow-sheet-close" title={target ? m.workflowSheet(target.name) : m.workflowView}
    open={!!target} onClose={onClose} colors={c} platform={platform} closeLabel={m.close} centered={false} height={screen.height}>
    {target && <PhoneWorkflow key={target.workspaceId} hostId={hostId} target={target} colors={c} m={m} platform={platform} locale={locale}
      onPickChange={template => { onPickChange?.(template); if (template === null) onClose(); }} />}
  </KanbanSheet>;
}

function PhoneWorkflow({ hostId, target, colors: c, m, platform, locale, onPickChange }: {
  hostId: string; target: WorkflowTarget; colors: Palette; m: Copy; platform: HostPlatform; locale: Locale; onPickChange: (template: string | null) => void;
}) {
  const workspaceId = target.workspaceId;
  const read = useWorkflowRead(hostId, workspaceId), muted = readable(c.foregroundMuted, c.surface0);
  const [changing, setChanging] = useState(false);
  // REQ-125 2단계: said once the file is written, over the workflow now read from it.
  const [exported, setExported] = useState<null | ExportDone>(null);
  const resting = (template: string | undefined) => template
    ? <RestingPick workspaceId={workspaceId} template={template} locale={locale} onCleared={() => { void read.refresh(); }} colors={c} m={m} mobile /> : null;
  const again = <IconButton testID="workflow-refresh" name="RefreshCw" label={m.workflowAgain} plain colors={c} mobile
    disabled={read.loading} onPress={() => { void read.refresh(); }} />;
  // 317-F1: a failed reading is said instead of the last one (its old answers never stay up unsaid).
  if (read.error) return <FailedLine error={read.error} again={again} onto={c.surface0} size={px(13)} colors={c} m={m} />;
  if (!read.data) return <Text testID="workflow-loading" style={{ color: muted, fontSize: px(13) }}>{m.workflowLoading}</Text>;
  const data = read.data;
  if (!data.defined) return <View style={{ gap: px(4) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
      <Text testID="workflow-absent" style={{ flex: 1, color: c.foreground, fontSize: px(13) }}>{absentWords(m, data)}</Text>
      {again}
    </View>
    {data.reason !== 'needs-update' && (data.problems ?? []).slice(0, 3).map((p, i) => <Text key={i} testID="workflow-problem" style={{ color: muted, fontSize: px(12) }}>{p}</Text>)}
    {resting(data.restingPick)}
  </View>;
  return <View style={{ gap: px(12) }}>
    {data.builtin && <BuiltinBanner workspaceId={workspaceId} template={data.builtin.id} locale={locale} mobile colors={c} m={m}
      onChange={() => setChanging(true)} onStopped={() => onPickChange(null)}
      onExported={done => { setExported(done); void read.refresh(); onPickChange(EXPORTED_PICK); }} />}
    {exported && !data.builtin && <Text testID="workflow-exported" style={{ color: readable(c.statusSuccess, c.surface0), fontSize: px(13) }}>
      {exportedLine(m, exported)}</Text>}
    <PhoneWorkflowBody model={data} again={again} colors={c} m={m} platform={platform} />
    {resting(data.restingPick)}
    {/* REQ-125: "Change" — the same list in a sheet over this one; a pick reads the workflow again. */}
    <WorkflowPickSheet target={changing ? target : null} current={data.builtin?.id} locale={locale} onClose={() => setChanging(false)}
      onPicked={template => { setChanging(false); void read.refresh(); onPickChange(template); }} colors={c} m={m} platform={platform} />
  </View>;
}

function PhoneWorkflowBody({ model, again, colors: c, m, platform }: { model: WorkflowModelDTO; again: ReactNode; colors: Palette; m: Copy; platform: HostPlatform }) {
  const w = workflowWords(m), releases = model.releases, names = releases.map(r => r.release);
  const [chosen, setChosen] = useState<string | null>(null), [cell, setCell] = useState<{ release: string; stage: string } | null>(null);
  const [unknownOpen, setUnknownOpen] = useState(false), [listOpen, setListOpen] = useState<null | 'excluded' | 'incomplete'>(null);
  const release = releases.find(r => r.release === chosen) ?? releases[0];
  const muted = readable(c.foregroundMuted, c.surface0), bg = c.surface0;
  // REQ-125 U1 (research/290 3.2): rows are 건 — their chips ten characters at most, the whole name in each chip's label.
  const instances = byInstance(model), excluded = shownExcluded(model), incomplete = model.incomplete ?? [];
  const chip = (r: (typeof releases)[number]) => instances ? instanceChip(r.label ?? r.release, 10) : releaseChip(r.release, names);
  const listChip = (kind: 'excluded' | 'incomplete', text: string, label: string) => <Pressable testID={'workflow-' + kind} accessibilityRole="button"
    accessibilityState={{ expanded: listOpen === kind }} accessibilityLabel={text + ' · ' + label} onPress={() => setListOpen(v => v === kind ? null : kind)}
    hitSlop={px(10)} style={{ paddingHorizontal: px(8), height: px(24), justifyContent: 'center', borderRadius: px(12), backgroundColor: c.surface2 }}>
    <Text style={{ color: readable(c.statusWarning, c.surface2), fontSize: px(12), fontWeight: '600' }}>{text}</Text>
  </Pressable>;
  const meta = [m.workflowReadAt(localStamp(model.readAt, Date.now())), m.workflowFiles(model.cost.files)].join(' · ');
  // REQ-125: a built-in reads no document — no "when read · files", and its empty table is explained instead.
  const builtin = !!model.builtin;
  const items = ladderItems(model, release, w);
  // REQ-125 U3: the program's own row — the "공통" box over the ladder and its evidence.
  const common = programRow(model, m.programName);
  const evidenceRelease = cell ? cell.release === PROGRAM_ROW ? common : releases.find(r => r.release === cell.release) : undefined;
  const evidenceStage = cell ? model.definition.stages.find(s => s.id === cell.stage) : undefined;
  return <View testID="mobile-workflow" style={{ gap: px(12) }}>
    <View testID="workflow-heading" style={{ gap: px(4) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
        <Text testID="workflow-name" style={{ flex: 1, color: c.foreground, fontSize: px(15), fontWeight: '700' }}>{model.definition.name}</Text>
        {again}
      </View>
      {!builtin && <Text testID="workflow-meta" style={{ color: muted, fontSize: px(12) }}>{meta}</Text>}
      {(model.unknownFormat.length > 0 || model.limits.length > 0 || (instances && (excluded.length > 0 || incomplete.length > 0))) && <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
        {model.unknownFormat.length > 0 && <Pressable testID="workflow-unknown" accessibilityRole="button" accessibilityState={{ expanded: unknownOpen }}
          accessibilityLabel={m.workflowUnknownCount(model.unknownFormat.length) + ' · ' + m.workflowUnknownList} onPress={() => setUnknownOpen(v => !v)}
          hitSlop={px(10)} style={{ paddingHorizontal: px(8), height: px(24), justifyContent: 'center', borderRadius: px(12), backgroundColor: c.surface2 }}>
          <Text style={{ color: readable(c.statusWarning, c.surface2), fontSize: px(12), fontWeight: '600' }}>{m.workflowUnknownCount(model.unknownFormat.length)}</Text>
        </Pressable>}
        {model.limits.length > 0 && <Text testID="workflow-limits" style={{ color: readable(c.statusWarning, bg), fontSize: px(12) }}>
          {model.limits.includes('instances') ? m.workflowInstancesCut : m.workflowLimits}</Text>}
        {instances && excluded.length > 0 && listChip('excluded', m.workflowExcludedCount(excluded.length), m.workflowExcludedList)}
        {instances && incomplete.length > 0 && listChip('incomplete', m.workflowIncompleteCount(incomplete.length), m.workflowIncompleteList)}
      </View>}
      {listOpen && <PathList testID={'workflow-' + listOpen + '-list'} title={listOpen === 'excluded' ? m.workflowExcludedList : m.workflowIncompleteList}
        items={listOpen === 'excluded' ? excluded.map(x => x.path + ' — ' + (m.workflowExcludedWhy[x.why] ?? x.why)) : incomplete} color={muted} />}
      {unknownOpen && <View testID="workflow-unknown-list" style={{ gap: px(2) }}>
        {model.unknownFormat.slice(0, 20).map(u => <Text key={u.path} numberOfLines={1} style={{ color: muted, fontSize: px(11) }}>{u.path}</Text>)}
        {model.unknownFormat.length > 20 && <Text style={{ color: muted, fontSize: px(11) }}>{'+' + (model.unknownFormat.length - 20)}</Text>}
      </View>}
      {logNoteLines(model, m).map((line, i) => <Text key={'log' + i} testID="workflow-log-note" style={{ color: readable(c.statusWarning, bg), fontSize: px(12) }}>{'⚠ ' + line}</Text>)}
    </View>
    {releases.length > 0 && <ScrollView horizontal testID="mobile-workflow-releases" showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: px(8), paddingVertical: px(4) }}>
      {releases.map(r => {
        const on = r === release;
        return <Pressable key={r.release} testID={'mobile-workflow-release-' + r.release} accessibilityRole="button" accessibilityState={{ selected: on }}
          aria-pressed={on} accessibilityLabel={instances ? m.workflowShowInstance(r.label ?? r.release) : m.workflowShowRelease(r.release)}
          onPress={() => { setChosen(r.release); setCell(null); }} hitSlop={px(4)}
          style={{ minWidth: px(52), height: px(36), paddingHorizontal: px(12), alignItems: 'center', justifyContent: 'center', borderRadius: px(18),
            borderWidth: on ? 2 : 1, borderColor: on ? selectedLine(c, bg) : c.border, backgroundColor: on ? c.card : 'transparent' }}>
          <Text numberOfLines={1} style={{ color: on ? c.foreground : muted, fontSize: px(14), fontWeight: on ? '700' : '400' }}>{chip(r)}</Text>
        </Pressable>;
      })}
    </ScrollView>}
    <View testID="mobile-workflow-ladder" style={{ borderRadius: px(10), borderWidth: 1, borderColor: c.border, paddingVertical: px(10), paddingHorizontal: px(12) }}>
      {common && <ProgramBox model={model} row={common} cell={cell} colors={c} m={m} onPress={stage => setCell({ release: PROGRAM_ROW, stage })} />}
      <Ladder items={items} colors={c} m={m} />
      {!(builtin && !release) && <Text testID="workflow-legend" style={{ color: muted, fontSize: px(11), marginTop: px(8) }}>
        {instances ? (model.logNotes ? m.workflowInstanceLadderLegendLog : m.workflowInstanceLadderLegend)(release ? release.label ?? release.release : '—')
          : release ? m.workflowLadderLegend(release.release, releases.length) : m.workflowNoReleases}</Text>}
    </View>
    {builtin && releases.length === 0 && <BuiltinEmpty colors={c} m={m} mobile />}
    {instances && releases.length === 0 && <Text testID="workflow-no-instances" style={{ color: muted, fontSize: px(13) }}>
      {model.instanceFolder && !model.instanceFolder.found ? m.workflowInstanceFolderMissing(model.instanceFolder.path) : m.workflowNoInstances(model.instanceFolder?.path ?? '')}</Text>}
    {releases.length > 0 && <MarkTable model={model} release={release?.release} cell={cell} colors={c} m={m}
      onPress={(r, stage) => { setChosen(r); setCell({ release: r, stage }); }} />}
    {instances && <Text testID="workflow-instances-line" style={{ color: muted, fontSize: px(11) }}>{m.workflowInstancesLine(releases.length, excluded.length)}</Text>}
    <KanbanSheet testID="workflow-evidence-sheet" closeTestID="workflow-evidence-sheet-close" open={!!cell} onClose={() => setCell(null)}
      title={evidenceStage && evidenceRelease ? evidenceStage.label + ' · ' + (evidenceRelease.label ?? evidenceRelease.release) : m.workflowView} colors={c} platform={platform}
      closeLabel={m.evidenceClose} centered={false}>
      {cell && <Evidence release={evidenceRelease} stage={evidenceStage} colors={c} m={m} words={w} wrap
        {...cell.release === PROGRAM_ROW ? { program: true, conflicts: programConflicts(model, cell.stage) } : { shared: sharedEvidence(model, evidenceRelease, cell.stage), stages: model.definition.stages }} />}
    </KanbanSheet>
  </View>;
}

/**
 * REQ-125 U3 (research/290 3.2): the "공통" box at the top of the ladder — the program's steps, the same whichever 건 is chosen;
 * each line its mark (as a 건's cell: ● · ▨ · ? · –), its words and "규칙 충돌 N"; a line pressed opens its evidence.
 */
function ProgramBox({ model, row, cell, colors: c, m, onPress }: {
  model: WorkflowModelDTO; row: WorkflowReleaseDTO; cell: { release: string; stage: string } | null; colors: Palette; m: Copy; onPress: (stage: string) => void;
}) {
  const w = workflowWords(m), muted = readable(c.foregroundMuted, c.surface1);
  const stages = model.definition.stages.filter(s => row.cells.some(v => v.stage === s.id)).sort((a, b) => a.col - b.col || a.row - b.row);
  return <View testID="mobile-workflow-program" style={{ marginBottom: px(10), padding: px(10), gap: px(4), borderRadius: px(8), borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <Text testID="mobile-workflow-program-title" style={{ color: readable(c.foregroundMuted, c.surface1), fontSize: px(12), fontWeight: '700' }}>{m.programBand}</Text>
    {stages.map(s => {
      const v = cellMark(row, s, w, 'instance'), conflicts = programConflicts(model, s.id).length, picked = cell?.release === PROGRAM_ROW && cell.stage === s.id;
      const onto = c.surface1, base = v.tone === 'muted' ? onto : mixColors(onto, toneColor(c, v.tone, onto), .14), fg = toneColor(c, v.tone, base);
      const text = v.text + (conflicts ? ' · ' + m.programConflicts(conflicts) : '');
      return <Pressable key={s.id} testID={'mobile-workflow-program-' + s.id} accessibilityRole="button" accessibilityState={{ selected: picked }}
        accessibilityLabel={m.workflowCellLabel(s.label, m.programName, text)} onPress={() => onPress(s.id)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: px(10), minHeight: px(44) }}>
        <View testID={'mobile-workflow-program-mark-' + v.state} style={{ width: px(30), height: px(30), borderRadius: px(15), alignItems: 'center', justifyContent: 'center',
          backgroundColor: base, borderWidth: picked ? 2 : 0, borderColor: c.foreground }}>
          <Text style={{ color: fg, fontSize: px(14), fontWeight: '700' }}>{v.mark}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: c.foreground, fontSize: px(14), fontWeight: '600' }}>{s.label}</Text>
          <Text testID="mobile-workflow-program-text" style={{ color: v.state === 'found' ? muted : toneColor(c, v.tone, onto), fontSize: px(12) }}>{text}</Text>
        </View>
      </Pressable>;
    })}
  </View>;
}

// ---- the ladder -----------------------------------------------------------------------------------------------------
const RAIL = 28;
type Step = Extract<LadderItem, { kind: 'step' }>;
/** The rail beside one line: the line through it (bold where the release went on), and the step's mark or the loop's glyph. */
function Ladder({ items, colors: c, m }: { items: LadderItem[]; colors: Palette; m: Copy }) {
  const bg = c.surface0, hot = selectedLine(c, bg), plain = readable(c.foregroundMuted, bg, 3);
  const isMain = (v: LadderItem): v is Step => v.kind === 'step' && !v.side;
  const near = (i: number, dir: -1 | 1): Step | undefined => { for (let k = i + dir; k >= 0 && k < items.length; k += dir) { const v = items[k]!; if (isMain(v)) return v; } return undefined; };
  return <View testID="ladder" style={{ gap: 0 }}>
    {items.map((item, i) => {
      const prev = near(i, -1), next = near(i, 1), main = isMain(item);
      // U4b: a decision whose confirmed answer goes elsewhere cuts the bold line on from it (`cut`).
      const upHot = !!prev && prev.passed && !prev.cut && (main ? item.passed : !!next?.passed),
        downHot = !!next && next.passed && (main ? item.passed && !item.cut : !!prev?.passed && !prev.cut);
      const line = (on: boolean, flex: number, show: boolean) => <View style={{ flex, width: on ? px(4) : px(2), backgroundColor: show ? (on ? hot : plain) : 'transparent' }} />;
      const rail = (mark: ReactNode) => <View style={{ width: px(RAIL), alignItems: 'center', alignSelf: 'stretch' }}>
        {main ? <>{line(upHot, 0, !!prev)}<View style={{ height: px(10), width: upHot ? px(4) : px(2), backgroundColor: prev ? (upHot ? hot : plain) : 'transparent' }} />
          {mark}{line(downHot, 1, !!next)}</>
          : <>{line(upHot && downHot, 1, !!prev && !!next)}{mark ? <View style={{ position: 'absolute', top: px(12) }}>{mark}</View> : null}</>}
      </View>;
      if (item.kind === 'loop') {
        const last = item.loops.at(-1), back = item.loops.length > 0;
        const tone = back && last?.to !== undefined ? verdictColor(c, last.verdict, bg) : readable(c.foregroundMuted, bg, 3);
        return <View key={'loop' + item.index} style={{ flexDirection: 'row', gap: px(10) }}>
          {rail(<View style={{ backgroundColor: bg }}><Icon name="RotateCcw" size={px(16)} color={tone} /></View>)}
          <View testID={'ladder-loop-' + item.edge.from + '-' + item.edge.to} accessibilityState={{ selected: back }} aria-selected={back}
            style={{ flex: 1, marginVertical: px(6), paddingHorizontal: px(10), paddingVertical: px(7), borderRadius: px(8), borderWidth: back ? 2 : 1,
              borderColor: tone, borderStyle: back ? 'solid' : 'dashed' }}>
            <Text testID="ladder-loop-text" style={{ color: back ? c.foreground : readable(c.foregroundMuted, bg), fontSize: px(13), fontWeight: back ? '600' : '400' }}>
              {m.workflowLoopTo(item.to.label) + (item.text ? ' · ' + item.text : '')}</Text>
          </View>
        </View>;
      }
      return <LadderStep key={item.stage.id} item={item} rail={rail} colors={c} hot={hot} plain={plain} />;
    })}
  </View>;
}
function LadderStep({ item, rail, colors: c, hot, plain }: { item: Step; rail: (mark: ReactNode) => ReactNode; colors: Palette; hot: string; plain: string }) {
  const bg = c.surface0, muted = readable(c.foregroundMuted, bg), shape = item.stage.shape;
  const edge = item.passed ? hot : plain, warn = item.state === 'unknown-format' || item.state === 'title-unread' || item.state === 'incomplete' || item.state === 'ambiguous';
  const size = shape === 'diamond' ? px(15) : px(20);
  const mark = <View testID={'ladder-mark-' + item.stage.id} style={{ width: size, height: size, borderWidth: 2, borderColor: edge, backgroundColor: bg,
    borderStyle: item.outlined ? 'dashed' : 'solid', borderRadius: shape === 'pill' ? size / 2 : shape === 'diamond' ? px(2) : px(5),
    ...(shape === 'diamond' ? { transform: [{ rotate: '45deg' }], marginVertical: px(3) } : {}) }} />;
  const chip = item.chip ? <View testID={'ladder-count-' + item.stage.id} style={{ alignSelf: 'flex-start', paddingHorizontal: px(7), minHeight: px(22), justifyContent: 'center',
    borderRadius: px(11), borderWidth: 1, borderColor: c.border, maxWidth: px(150) }}>
    <Text style={{ color: c.foreground, fontSize: px(11), fontWeight: '600' }}>{item.chip}</Text></View> : null;
  const words = <View style={{ flex: 1, minWidth: 0, gap: px(1) }}>
    {!!item.via && item.side && <Text style={{ color: muted, fontSize: px(11) }}>{item.via + ' →'}</Text>}
    <Text style={{ color: item.outlined ? muted : c.foreground, fontSize: px(15), fontWeight: item.passed ? '700' : '500' }}>{item.stage.label}</Text>
    {!!item.note && <Text testID={'ladder-note-' + item.stage.id} style={{ color: warn ? readable(c.statusWarning, bg) : muted, fontSize: px(12),
      fontStyle: item.outlined ? 'italic' : 'normal' }}>{item.note}</Text>}
    {item.ways ? <Text testID={'ladder-ways-' + item.stage.id} style={{ color: muted, fontSize: px(12) }}>
      {item.ways.map((v, i) => <Fragment key={i}>{i ? ' · ' : ''}<Text testID={v.on ? 'ladder-way-on' : undefined}
        style={v.on ? { color: readable(hot, bg), fontWeight: '700' } : {}}>{(v.on ? '✓ ' : '') + v.text}</Text></Fragment>)}</Text>
      : !!item.via && !item.side && <Text style={{ color: muted, fontSize: px(12) }}>{item.via}</Text>}
  </View>;
  if (item.side) return <View style={{ flexDirection: 'row', gap: px(10) }}>
    {rail(null)}
    <View testID={'ladder-side-' + item.stage.id} accessibilityState={{ selected: item.passed }} aria-selected={item.passed} style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: px(8),
      marginVertical: px(6), paddingHorizontal: px(10), paddingVertical: px(7), borderRadius: px(8), borderWidth: item.passed ? 2 : 1,
      borderColor: item.passed ? hot : item.dashed ? plain : c.border, borderStyle: item.dashed && !item.passed ? 'dashed' : 'solid' }}>
      {words}{chip}
    </View>
  </View>;
  return <View testID={'ladder-step-' + item.stage.id} accessibilityState={{ selected: item.passed }} aria-selected={item.passed} style={{ flexDirection: 'row', gap: px(10), minHeight: px(56) }}>
    {rail(mark)}
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: px(8), paddingTop: px(7), paddingBottom: px(9) }}>{words}{chip}</View>
  </View>;
}

// ---- the table of marks ---------------------------------------------------------------------------------------------
const RELEASE_COL = 44, INSTANCE_COL = 84, MIN_COL = 40;
function MarkTable({ model, release, cell, colors: c, m, onPress }: {
  model: WorkflowModelDTO; release: string | undefined; cell: { release: string; stage: string } | null; colors: Palette; m: Copy;
  onPress: (release: string, stage: string) => void;
}) {
  const w = workflowWords(m), stages = tableStages(model), bg = c.surface0, names = model.releases.map(r => r.release);
  const [room, setRoom] = useState(0), muted = readable(c.foregroundMuted, c.surface1);
  // REQ-125 U1: the first column "건", each 건's name in two lines at most.
  const instances = byInstance(model), first = instances ? px(INSTANCE_COL) : px(RELEASE_COL);
  const colW = Math.max(px(MIN_COL), Math.floor((room - first) / Math.max(1, stages.length)) || px(MIN_COL)), wide = first + colW * stages.length > room && room > 0;
  const grid = <View style={{ width: first + colW * stages.length }}>
    <View style={{ flexDirection: 'row', backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border, minHeight: px(40), alignItems: 'center' }}>
      <Text testID="mobile-workflow-table-first" style={{ width: first, paddingHorizontal: px(6), color: muted, fontSize: px(12), fontWeight: '600' }}>{instances ? m.workflowInstance : m.workflowRelease}</Text>
      {stages.map(s => <Text key={s.id} numberOfLines={2} style={{ width: colW, paddingHorizontal: px(2), textAlign: 'center', color: muted, fontSize: px(11), fontWeight: '600' }}>{s.label}</Text>)}
    </View>
    {model.releases.map(r => {
      const on = r.release === release, onto = on ? c.surface2 : bg;
      return <View key={r.release} testID={'mobile-workflow-row-' + r.release} accessibilityState={{ selected: on }} aria-selected={on}
        style={{ flexDirection: 'row', alignItems: 'center', minHeight: px(44), borderBottomWidth: 1, borderColor: c.border, backgroundColor: on ? onto : 'transparent' }}>
        {instances ? <View style={{ width: first, paddingHorizontal: px(6) }}>
          <Text testID="mobile-workflow-rowname" numberOfLines={2} style={{ color: c.foreground, fontSize: px(13), fontWeight: on ? '700' : '400' }}>{rowName(r, names)}</Text>
          {/* U4b: where the 건 ended (research/309 4.3), under its name. */}
          {r.endTag && !r.endTag.held ? <Text testID="mobile-workflow-endtag" numberOfLines={2} style={{ color: readable(c.foregroundMuted, onto), fontSize: px(11), fontWeight: '600' }}>
            {endTagText(r, model.definition.stages, m).shown}</Text> : null}
        </View>
        : <Text testID="mobile-workflow-rowname" style={{ width: first, paddingHorizontal: px(6), color: c.foreground, fontSize: px(13), fontWeight: on ? '700' : '400' }}>
          {rowName(r, names)}</Text>}
        {stages.map(s => {
          const v = cellMark(r, s, w, model.unit), picked = cell?.release === r.release && cell.stage === s.id;
          const base = v.tone === 'muted' ? onto : mixColors(onto, toneColor(c, v.tone, onto), .14), fg = toneColor(c, v.tone, base);
          return <Pressable key={s.id} testID={'mobile-workflow-cell-' + s.id} accessibilityRole="button" accessibilityState={{ selected: picked }}
            accessibilityLabel={m.workflowCellLabel(s.label, r.label ?? r.release, v.text)} onPress={() => onPress(r.release, s.id)}
            style={{ width: colW, height: px(44), alignItems: 'center', justifyContent: 'center' }}>
            <View testID={'mobile-workflow-mark-' + v.state} style={{ width: px(30), height: px(30), borderRadius: px(15), alignItems: 'center', justifyContent: 'center',
              backgroundColor: base, borderWidth: picked ? 2 : 0, borderColor: c.foreground }}>
              <Text style={{ color: fg, fontSize: px(14), fontWeight: '700' }}>{v.mark}</Text>
            </View>
          </Pressable>;
        })}
      </View>;
    })}
  </View>;
  return <View testID="mobile-workflow-table" style={{ gap: px(6) }}>
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: px(8) }}>
      <Text style={{ color: c.foreground, fontSize: px(15), fontWeight: '700' }}>{instances ? m.workflowInstanceMarksTitle : m.workflowMarksTitle}</Text>
      <Text testID="mobile-workflow-marks-note" style={{ color: readable(c.foregroundMuted, bg), fontSize: px(12) }}>{instances ? model.logNotes ? m.workflowInstanceMarksNoteLog : m.workflowInstanceMarksNote : m.workflowMarksNote}</Text>
    </View>
    <View onLayout={e => { const next = Math.floor(e.nativeEvent.layout.width) - 2; setRoom(v => v === next ? v : next); }}
      style={{ borderRadius: px(8), borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
      {wide ? <ScrollView horizontal testID="mobile-workflow-table-scroll">{grid}</ScrollView> : grid}
    </View>
    <Text testID="mobile-workflow-marks-legend" style={{ color: readable(c.foregroundMuted, bg), fontSize: px(11) }}>{instances ? model.logNotes ? m.workflowInstanceMarksLegendLog : m.workflowInstanceMarksLegend : m.workflowMarksLegend}</Text>
  </View>;
}
