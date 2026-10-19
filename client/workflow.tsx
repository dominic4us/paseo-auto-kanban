import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { workflowGet } from '../shared/rpc.js';
import type { WorkflowDTO, WorkflowEventDTO, WorkflowModelDTO, WorkflowReleaseDTO, Verdict } from '../shared/workflow.js';
import type { Palette } from './palette.js';
import { readable, selectedLine, selectedTint } from './palette.js';
import { textWidth } from './layout.js';
import type { Copy } from './i18n.js';
import { useRead } from './data.js';
import { IconButton, toolLook, useHovered } from './components.js';
import { localStamp } from './move-reason.js';
import type { Locale } from '../shared/core/domain.js';
import { usePopover } from './popover-menu.js';
import { BuiltinBanner, BuiltinEmpty, RestingPick, WorkflowPickList, WorkflowPickPopover, exportedLine, usePickSaver, type ExportDone } from './workflow-pick.js';
import { EXPORTED_PICK, PROGRAM_ROW, byInstance, endTagText, readFailure, programConflicts, programRow, sharedEvidence, withProgram, shownExcluded, evidencePlace, flowLabelLayout, flowLayout, flowOverlay, FLOW, instanceChip, loopLabel, releaseChip, route, rowBottom, sourceNotes, stageCounts, tableCell, tableStages, tableWidths,
  type CellTone, type FlowNode, type FlowOverlay, type Segment, type WorkflowStage, type WorkflowWords } from './workflow-model.js';
import { px } from './ui-scale.js';

/** The copy's words for the pure model (client/workflow-model.ts). */
export function workflowWords(m: Copy): WorkflowWords {
  return { verdict: { pass: m.verdictPass, conditional: m.verdictConditional, fail: m.verdictFail, unknown: m.verdictUnknown },
    stateNoRecord: m.stateNoRecord, stateNoSource: m.stateNoSource, stateUnknown: m.stateUnknown, titleUnread: m.titleUnread,
    statePerson: m.statePerson, firstRound: m.firstRound, countFound: m.countFound, loopNone: m.loopNone, loopTimes: m.loopTimes,
    timesShort: m.timesShort, resultNotOk: m.resultNotOk, resultMissing: m.resultMissing,
    dataThere: m.dataThere, stateCandidate: m.stateCandidate, stateAmbiguous: m.stateAmbiguous, stateIncomplete: m.stateIncomplete, countInstances: m.countInstances,
    versionFirst: m.versionFirst, versionNoEarlier: m.versionNoEarlier, versionNext: m.versionNext, versionsSeen: m.versionsSeen, daysMany: m.daysMany,
    programName: m.programName, conflicts: m.programConflicts, answerYes: m.answerYes, answerNo: m.answerNo, logBasis: m.logBasis };
}
/**
 * REQ-125 U4a (research/309 2.3·2.4): what the heading says about the record files, warnings first — a section not there ("기록 확인
 * 필요"), writing in it that is no tag line (and that every step read from it is ambiguous, with the lines), a section-shaped heading
 * inside a comment, a tag left to a folder that is no row, a 건 that cannot be named in a tag.
 */
export function logNoteLines(model: Pick<WorkflowModelDTO, 'logNotes'>, m: Copy): string[] {
  const lines = (n: readonly number[] | undefined) => (n ?? []).join(', ');
  const order = ['not-a-tag-line', 'no-section', 'section-in-comment', 'other-item', 'untaggable'];
  return [...model.logNotes ?? []].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).map(note =>
    note.kind === 'no-section' ? m.logNoSection(note.path, note.section ?? '')
      : note.kind === 'not-a-tag-line' ? m.logNotTagLines(note.section ?? '', note.count ?? 0, lines(note.lines))
      : note.kind === 'section-in-comment' ? m.logSectionInComment(note.path, note.section ?? '', lines(note.lines))
      : note.kind === 'other-item' ? m.logOtherItem(note.name ?? '', lines(note.lines))
      : m.logUntaggable(note.name ?? ''));
}
/** Why a reading has no workflow, in words: REQ-125 U1's "update Kanban" names the features it needs. */
export function absentWords(m: Copy, data: Extract<WorkflowDTO, { defined: false }>): string {
  if (data.reason === 'needs-update') return m.workflowNeedsUpdate((data.problems ?? []).join(', '));
  return m.workflowAbsent[data.reason] ?? m.workflowAbsent.unreadable!;
}
/** A row's name: a 건's shown name, or a release's chip. */
export const rowName = (r: WorkflowReleaseDTO, names: readonly string[]) => r.label ?? releaseChip(r.release, names);

/**
 * REQ-124 (replacing REQ-103 2단계-1's "Board | Big picture"): the wide lane heading's "Board | Workflow", two joined words
 * beside the workspace name, the one showing filled (as `ViewSwitch`). Only a lane whose workspace holds a workflow
 * definition has it (`offersWorkflow`); the 390px heading has none — REQ-134 WA: its ⋯ opens the phone's sheet (mobile-workflow.tsx).
 */
export function LaneViewSwitch({ workflow, onChange, name, colors: c, m, disabled = false }: {
  workflow: boolean; onChange: (workflow: boolean) => void; name: string; colors: Palette; m: Copy; disabled?: boolean;
}) {
  return <View testID="lane-view-switch" accessibilityRole="radiogroup" role="radiogroup" accessibilityLabel={m.laneView + ': ' + name}
    style={{ flexDirection: 'row', height: px(28), borderRadius: px(6), borderWidth: 1, borderColor: c.border }}>
    <LaneViewItem id="board" label={m.boardView} first selected={!workflow} off={disabled} onPress={() => onChange(false)} colors={c} />
    <LaneViewItem id="workflow" label={m.workflowView} first={false} selected={workflow} off={disabled} onPress={() => onChange(true)} colors={c} />
  </View>;
}
function LaneViewItem({ id, label, first, selected, off, onPress, colors: c }: {
  id: string; label: string; first: boolean; selected: boolean; off: boolean; onPress: () => void; colors: Palette;
}) {
  const hover = useHovered(), look = toolLook(c, { on: selected, hovered: hover.hovered && !off });
  return <Pressable testID={'lane-view-' + id} accessibilityRole="radio" accessibilityLabel={label}
    accessibilityState={{ checked: selected, disabled: off }} role="radio" aria-checked={selected} disabled={off}
    onPress={() => { if (!selected) onPress(); }} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ height: px(26), paddingHorizontal: px(10), flexDirection: 'row', alignItems: 'center', opacity: off ? .4 : 1,
      backgroundColor: look.backgroundColor, borderWidth: look.borderWidth, borderColor: look.borderColor,
      ...(first ? { borderTopLeftRadius: px(5), borderBottomLeftRadius: px(5) } : { borderTopRightRadius: px(5), borderBottomRightRadius: px(5) }) }}>
    <Text numberOfLines={1} style={{ color: selected ? look.icon : c.foreground, fontSize: px(12), fontWeight: selected ? '600' : '400' }}>{label}</Text>
  </Pressable>;
}

/** A verdict's colour on `onto`: 3:1 for a line, 4.5:1 for words. */
export function verdictColor(c: Palette, verdict: Verdict | null | undefined, onto: string, min = 3): string {
  const base = verdict === 'pass' ? c.statusSuccess : verdict === 'conditional' ? c.statusWarning : verdict === 'fail' ? c.statusDanger : c.foregroundMuted;
  return readable(base, onto, min);
}
export function toneColor(c: Palette, tone: CellTone, onto: string): string {
  if (tone === 'plain') return c.foreground;
  if (tone === 'muted') return readable(c.foregroundMuted, onto);
  if (tone === 'warning' || tone === 'unknown') return readable(c.statusWarning, onto);
  return verdictColor(c, tone, onto, 4.5);
}

/**
 * A lane's workflow, in place of its columns (research/216's shape): a heading row (the definition's name, when it was read,
 * how many documents, "Unknown format N" and the releases to choose from), the flow (`FlowView`) with the chosen release's
 * way over it, and the release × step table; a cell pressed shows its evidence — the verdict or title line and where it is
 * (`path:line`), since a plugin cannot open a file. The server reads the workspace's own documents at most once a minute
 * (server/workflow.ts); this asks when it opens and when "read again" is pressed, never with the 4-second refresh.
 */
export function WorkflowPanel({ hostId, workspaceId, width, colors: c, m, now = Date.now(), maxColumn, locale = 'ko', onPickChange }: {
  hostId: string; workspaceId: string; width: number; colors: Palette; m: Copy; now?: number;
  /** REQ-127: the board screen's cap on a flow column (`FLOW.wideCol`); the lane has none. */
  maxColumn?: number;
  /** REQ-125: the screen's language, for a built-in's names. */
  locale?: Locale;
  /** REQ-125: a pick saved from the banner — another built-in, or `null` after "Stop using" / "Clear the pick". */
  onPickChange?: ((template: string | null) => void) | undefined;
}) {
  const read = useWorkflowRead(hostId, workspaceId);
  const picked = (template: string | null) => { void read.refresh(); onPickChange?.(template); };
  // REQ-125 2단계: said once the file is written, over the workflow now read from it (until the panel closes).
  const [exported, setExported] = useState<null | ExportDone>(null);
  const resting = (template: string | undefined) => template
    ? <RestingPick workspaceId={workspaceId} template={template} locale={locale} onCleared={() => { void read.refresh(); }} colors={c} m={m} mobile={false} /> : null;
  const muted = readable(c.foregroundMuted, c.panel);
  const frame = (children: ReactNode) => <View testID="workflow" style={{ width, marginTop: px(8), padding: px(12), gap: px(10), borderRadius: px(10), backgroundColor: c.panel }}>{children}</View>;
  const again = <IconButton testID="workflow-refresh" name="RefreshCw" label={m.workflowAgain} plain tooltip colors={c} mobile={false}
    disabled={read.loading} onPress={() => { void read.refresh(); }} />;
  // 317-F1: a failed reading (a reply the screen refused, a host error) is said instead of the last one — never its old answers unsaid.
  if (!read.data || read.error) return frame(read.error ? <FailedLine error={read.error} again={again} onto={c.panel} size={px(12)} colors={c} m={m} />
    : <Text testID="workflow-loading" style={{ color: muted, fontSize: px(12) }}>{m.workflowLoading}</Text>);
  const data = read.data;
  if (!data.defined) return frame(<View style={{ gap: px(4) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
      <Text testID="workflow-absent" style={{ flex: 1, color: c.foreground, fontSize: px(12) }}>{absentWords(m, data)}</Text>
      {again}
    </View>
    {data.reason !== 'needs-update' && (data.problems ?? []).slice(0, 3).map((p, i) => <Text key={i} testID="workflow-problem" style={{ color: muted, fontSize: px(11) }}>{p}</Text>)}
    {resting(data.restingPick)}
  </View>);
  return frame(<>
    {data.builtin && <WideBanner workspaceId={workspaceId} template={data.builtin.id} locale={locale} onPicked={picked} colors={c} m={m}
      onExported={done => { setExported(done); picked(EXPORTED_PICK); }} />}
    {exported && !data.builtin && <Text testID="workflow-exported" style={{ color: readable(c.statusSuccess, c.panel), fontSize: px(12) }}>
      {exportedLine(m, exported)}</Text>}
    <WorkflowBody model={data} width={width - px(24)} colors={c} m={m} now={now} again={again} maxColumn={maxColumn} />
    {resting(data.restingPick)}
  </>);
}
/**
 * A failed reading in words (`readFailure`): a reply the screen's check refused says so and how many problems — never the check's
 * JSON — and any other error its first line; "자세히" opens the whole text (selectable). The phone's sheet uses it too.
 */
export function FailedLine({ error, again, onto, size, colors: c, m }: { error: string; again: ReactNode; onto: string; size: number; colors: Palette; m: Copy }) {
  const [open, setOpen] = useState(false), failure = readFailure(error), muted = readable(c.foregroundMuted, onto);
  const said = failure.kind === 'reply' ? m.workflowFailedReply(failure.count) : m.workflowFailed + (failure.first ? ' ' + failure.first : '');
  const more = failure.kind === 'reply' || failure.detail.trim() !== failure.first;
  return <View style={{ gap: px(4) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
      <Text testID="workflow-error" style={{ flex: 1, color: readable(c.statusDanger, onto), fontSize: size }}>{said}</Text>
      {more && <Pressable testID="workflow-error-more" accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
        accessibilityLabel={m.workflowFailedDetail} onPress={() => setOpen(v => !v)} hitSlop={px(8)}
        style={{ paddingHorizontal: px(8), height: px(24), justifyContent: 'center', borderRadius: px(12), backgroundColor: c.surface2 }}>
        <Text style={{ color: c.foreground, fontSize: size - px(1), fontWeight: '600' }}>{open ? m.workflowFailedHide : m.workflowFailedDetail}</Text>
      </Pressable>}
      {again}
    </View>
    {open && <View testID="workflow-error-detail" style={{ gap: px(2) }}>
      {failure.kind === 'reply' && failure.first ? <Text style={{ color: muted, fontSize: size - px(1) }}>{m.workflowFailedFirst(failure.first)}</Text> : null}
      <Text selectable numberOfLines={12} style={{ color: muted, fontSize: size - px(2), fontFamily: 'monospace', ...({ wordBreak: 'break-all', overflowWrap: 'anywhere' } as object) }}>
        {Array.from(failure.detail).slice(0, 2000).join('')}</Text>
    </View>}
  </View>;
}
/** REQ-125: the built-in's banner on a wide screen; "Change" hangs the list under itself. */
function WideBanner({ workspaceId, template, locale, onPicked, onExported, colors: c, m }: {
  workspaceId: string; template: string; locale: Locale; onPicked: (template: string | null) => void; onExported: (done: ExportDone) => void; colors: Palette; m: Copy;
}) {
  const trigger = useRef<View>(null), popover = usePopover(trigger), saver = usePickSaver(m);
  return <>
    <BuiltinBanner workspaceId={workspaceId} template={template} locale={locale} changeRef={trigger} mobile={false} colors={c} m={m}
      onChange={() => { saver.clear(); popover.show(); }} onStopped={() => onPicked(null)} onExported={onExported} />
    <WorkflowPickPopover open={popover.open} anchor={popover.anchor} onClose={popover.close} onDismiss={popover.returnFocus} label={m.workflowChange} error={saver.error} colors={c} m={m}>
      <WorkflowPickList locale={locale} current={template} disabled={saver.busy} colors={c} m={m} mobile={false}
        onPick={t => { if (t.id === template) { popover.close(); return; }
          void saver.save(workspaceId, t.id).then(ok => { if (ok) { popover.close(); onPicked(t.id); } }); }} />
    </WorkflowPickPopover>
  </>;
}

/** The server's reading of a workspace's workflow — one key for the lane, the board screen and the phone's sheet (REQ-134). */
export function useWorkflowRead(hostId: string, workspaceId: string) {
  const get = useRpc(workflowGet);
  return useRead<WorkflowDTO>(hostId + ':workflow:' + workspaceId, () => get({ workspaceId }));
}

function WorkflowBody({ model, width, colors: c, m, now, again, maxColumn }: {
  model: WorkflowModelDTO; width: number; colors: Palette; m: Copy; now: number; again: ReactNode; maxColumn: number | undefined;
}) {
  const w = workflowWords(m), releases = model.releases, names = releases.map(r => r.release);
  const [chosen, setChosen] = useState<string | null>(null), [cell, setCell] = useState<{ release: string; stage: string } | null>(null);
  const [unknownOpen, setUnknownOpen] = useState(false), [listOpen, setListOpen] = useState<null | 'excluded' | 'incomplete'>(null);
  const release = releases.find(r => r.release === chosen) ?? releases[0];
  const muted = readable(c.foregroundMuted, c.panel);
  // REQ-125 U1: rows are 건 — chosen in the table, not by chips in the heading (there may be up to 200).
  const instances = byInstance(model), excluded = shownExcluded(model), incomplete = model.incomplete ?? [];
  // REQ-125 U3: the program's steps speak inside their nodes whichever 건 is chosen; their own row is the band's (`programRow`).
  const flow = flowOverlay(model.definition, withProgram(model, release), w, model.unit), counts = stageCounts(model, w), common = programRow(model, m.programName);
  const sources = sourceNotes(model, w), overlay = { ...flow, notes: { ...sources, ...flow.notes } };
  // The steps drawn outlined: those with nothing to read (REQ-125: with a built-in, a person's steps only).
  const noSource = new Set(Object.keys(sources));
  const choose = (value: string) => { setChosen(value); setCell(null); };
  const meta = [m.workflowReadAt(localStamp(model.readAt, now)), m.workflowFiles(model.cost.files)].join(' · ');
  // REQ-125: a built-in reads no document, so "when read · files" says nothing; its empty table is explained instead.
  const builtin = !!model.builtin;
  return <>
    <View testID="workflow-heading" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
      <Text testID="workflow-name" style={{ color: c.foreground, fontSize: px(13), fontWeight: '700' }}>{model.definition.name}</Text>
      {!builtin && <Text testID="workflow-meta" style={{ color: muted, fontSize: px(12) }}>{meta}</Text>}
      {model.unknownFormat.length > 0 && <Pressable testID="workflow-unknown" accessibilityRole="button" accessibilityState={{ expanded: unknownOpen }}
        accessibilityLabel={m.workflowUnknownCount(model.unknownFormat.length) + ' · ' + m.workflowUnknownList} onPress={() => setUnknownOpen(v => !v)}
        style={{ paddingHorizontal: px(6), height: px(20), justifyContent: 'center', borderRadius: px(10), backgroundColor: c.surface2 }}>
        <Text style={{ color: readable(c.statusWarning, c.surface2), fontSize: px(11), fontWeight: '600' }}>{m.workflowUnknownCount(model.unknownFormat.length)}</Text>
      </Pressable>}
      {model.limits.length > 0 && <Text testID="workflow-limits" style={{ color: readable(c.statusWarning, c.panel), fontSize: px(11) }}>
        {model.limits.includes('instances') ? m.workflowInstancesCut : m.workflowLimits}</Text>}
      {instances && excluded.length > 0 && <ListChip testID="workflow-excluded" text={m.workflowExcludedCount(excluded.length)} label={m.workflowExcludedList}
        open={listOpen === 'excluded'} onPress={() => setListOpen(v => v === 'excluded' ? null : 'excluded')} colors={c} />}
      {instances && incomplete.length > 0 && <ListChip testID="workflow-incomplete" text={m.workflowIncompleteCount(incomplete.length)} label={m.workflowIncompleteList}
        open={listOpen === 'incomplete'} onPress={() => setListOpen(v => v === 'incomplete' ? null : 'incomplete')} colors={c} />}
      <View style={{ flex: 1 }} />
      {!instances && releases.map(r => {
        const on = r === release;
        return <Pressable key={r.release} testID={'workflow-release-' + r.release} accessibilityRole="button" accessibilityState={{ selected: on }}
          aria-pressed={on} accessibilityLabel={m.workflowShowRelease(r.release)} onPress={() => choose(r.release)}
          style={{ paddingHorizontal: px(7), height: px(22), justifyContent: 'center', borderRadius: px(6), borderWidth: 1,
            borderColor: on ? selectedLine(c, c.panel) : c.border, backgroundColor: on ? c.card : 'transparent' }}>
          <Text style={{ color: on ? c.foreground : muted, fontSize: px(12), fontWeight: on ? '700' : '400' }}>{releaseChip(r.release, names)}</Text>
        </Pressable>;
      })}
      {again}
    </View>
    {unknownOpen && <View testID="workflow-unknown-list" style={{ gap: px(2) }}>
      <Text style={{ color: muted, fontSize: px(11), fontWeight: '600' }}>{m.workflowUnknownList}</Text>
      {model.unknownFormat.slice(0, 20).map(u => <Text key={u.path} numberOfLines={1} style={{ color: muted, fontSize: px(11) }}>{u.path}</Text>)}
      {model.unknownFormat.length > 20 && <Text style={{ color: muted, fontSize: px(11) }}>{'+' + (model.unknownFormat.length - 20)}</Text>}
    </View>}
    {listOpen && <PathList testID={'workflow-' + listOpen + '-list'} title={listOpen === 'excluded' ? m.workflowExcludedList : m.workflowIncompleteList}
      items={listOpen === 'excluded' ? excluded.map(x => x.path + ' — ' + (m.workflowExcludedWhy[x.why] ?? x.why)) : incomplete} color={muted} />}
    {logNoteLines(model, m).map((line, i) => <Text key={'log' + i} testID="workflow-log-note" style={{ color: readable(c.statusWarning, c.panel), fontSize: px(12) }}>{'⚠ ' + line}</Text>)}
    <View testID="workflow-flow" style={{ backgroundColor: c.surface0, borderRadius: px(8), borderWidth: 1, borderColor: c.border }}>
      <FlowView model={model} width={width - 2} colors={c} overlay={overlay} counts={counts} noSource={noSource} words={w} maxColumn={maxColumn} />
      {!(builtin && !release) && <Text testID="workflow-legend" style={{ color: readable(c.foregroundMuted, c.surface0), fontSize: px(11), paddingHorizontal: px(12), paddingBottom: px(8) }}>
        {instances ? (model.logNotes ? m.workflowInstanceLegendLog : m.workflowInstanceLegend)(release ? release.label ?? release.release : '—')
          : release ? m.workflowLegend(release.release, releases.length) : m.workflowNoReleases}</Text>}
    </View>
    {common && <ProgramBand model={model} row={common} cell={cell} colors={c} m={m} words={w}
      onPress={stage => setCell(v => v && v.release === PROGRAM_ROW && v.stage === stage ? null : { release: PROGRAM_ROW, stage })} />}
    {builtin && releases.length === 0 && <BuiltinEmpty colors={c} m={m} mobile={false} />}
    {instances && releases.length === 0 && <Text testID="workflow-no-instances" style={{ color: muted, fontSize: px(12) }}>
      {model.instanceFolder && !model.instanceFolder.found ? m.workflowInstanceFolderMissing(model.instanceFolder.path) : m.workflowNoInstances(model.instanceFolder?.path ?? '')}</Text>}
    {releases.length > 0 && <WorkflowTable model={model} release={release} cell={cell} width={width} colors={c} m={m} words={w}
      onChoose={r => { setChosen(r); setCell(null); }}
      onPress={(r, stage) => { setChosen(r); setCell(v => v && v.release === r && v.stage === stage ? null : { release: r, stage }); }} />}
    {instances && <Text testID="workflow-instances-line" style={{ color: muted, fontSize: px(11) }}>{m.workflowInstancesLine(releases.length, excluded.length)}</Text>}
    {cell && <Evidence release={cell.release === PROGRAM_ROW ? common : releases.find(r => r.release === cell.release)} stage={model.definition.stages.find(s => s.id === cell.stage)}
      colors={c} m={m} words={w} onClose={() => setCell(null)} {...cell.release === PROGRAM_ROW ? { program: true, conflicts: programConflicts(model, cell.stage) }
        : { shared: sharedEvidence(model, releases.find(r => r.release === cell.release), cell.stage), stages: model.definition.stages }} />}
  </>;
}
/**
 * REQ-125 U3 (research/290 3.1): the "공통 · 모든 건" band under the flow — one chip per program step, the same whichever 건 is
 * chosen: the step, its cell in words (the grades as a 건's) and "규칙 충돌 N" where the rule found things inside a 건 folder. A
 * chip pressed shows its evidence.
 */
function ProgramBand({ model, row, cell, colors: c, m, words: w, onPress }: {
  model: WorkflowModelDTO; row: WorkflowReleaseDTO; cell: { release: string; stage: string } | null; colors: Palette; m: Copy; words: WorkflowWords;
  onPress: (stage: string) => void;
}) {
  const bg = c.surface0, stages = model.definition.stages.filter(s => row.cells.some(v => v.stage === s.id)).sort((a, b) => a.col - b.col || a.row - b.row);
  return <View testID="workflow-program" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8), paddingHorizontal: px(10), paddingVertical: px(8),
    backgroundColor: bg, borderRadius: px(8), borderWidth: 1, borderColor: c.border }}>
    <Text testID="workflow-program-title" style={{ color: readable(c.foregroundMuted, bg), fontSize: px(12), fontWeight: '700' }}>{m.programBand}</Text>
    {stages.map(s => {
      const value = tableCell(row, s, w), conflicts = programConflicts(model, s.id).length, picked = cell?.release === PROGRAM_ROW && cell.stage === s.id;
      const face = picked ? selectedTint(c, bg) : c.surface1;
      const text = s.label + ' · ' + value.text + (conflicts ? ' · ' + m.programConflicts(conflicts) : '');
      return <Pressable key={s.id} testID={'workflow-program-' + s.id} accessibilityRole="button" accessibilityState={{ selected: picked }} aria-pressed={picked}
        accessibilityLabel={m.workflowCellLabel(s.label, m.programName, text)} onPress={() => onPress(s.id)}
        style={{ paddingHorizontal: px(9), minHeight: px(24), paddingVertical: px(2), justifyContent: 'center', borderRadius: px(12), backgroundColor: face, borderWidth: picked ? 2 : 1,
          borderColor: picked ? selectedLine(c, face) : value.state === 'incomplete' ? readable(c.statusWarning, face, 3) : c.border,
          borderStyle: value.state === 'incomplete' ? 'dashed' : 'solid' }}>
        <Text testID={'workflow-program-text-' + value.state} numberOfLines={2} style={{ color: toneColor(c, value.tone, face), fontSize: px(12),
          // An italic line's last letter leans past its box: a little room keeps it whole.
          fontStyle: value.tone === 'muted' ? 'italic' : 'normal', paddingRight: value.tone === 'muted' ? px(2) : 0 }}>{text}</Text>
      </Pressable>;
    })}
  </View>;
}
/** REQ-125 U1: a count in the heading that opens its list ("제외 2", "일부만 읽음 1"), as "형식 모름 N" does. */
function ListChip({ testID, text, label, open, onPress, colors: c }: { testID: string; text: string; label: string; open: boolean; onPress: () => void; colors: Palette }) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={text + ' · ' + label} onPress={onPress}
    style={{ paddingHorizontal: px(6), height: px(20), justifyContent: 'center', borderRadius: px(10), backgroundColor: c.surface2 }}>
    <Text style={{ color: readable(c.statusWarning, c.surface2), fontSize: px(11), fontWeight: '600' }}>{text}</Text>
  </Pressable>;
}
export function PathList({ testID, title, items, color }: { testID: string; title: string; items: readonly string[]; color: string }) {
  return <View testID={testID} style={{ gap: px(2) }}>
    <Text style={{ color, fontSize: px(11), fontWeight: '600' }}>{title}</Text>
    {items.slice(0, 20).map((v, i) => <Text key={i} numberOfLines={1} style={{ color, fontSize: px(11) }}>{v}</Text>)}
    {items.length > 20 && <Text style={{ color, fontSize: px(11) }}>{'+' + (items.length - 20)}</Text>}
  </View>;
}

// ---- the flow (research/216: View only — no SVG in a plugin) ------------------------------------------------------------
function Line({ seg, color, width, dashed }: { seg: Segment; color: string; width: number; dashed?: boolean }) {
  const horiz = seg.y1 === seg.y2, len = horiz ? Math.abs(seg.x2 - seg.x1) : Math.abs(seg.y2 - seg.y1);
  const left = Math.min(seg.x1, seg.x2) - (horiz ? 0 : width / 2), top = Math.min(seg.y1, seg.y2) - (horiz ? width / 2 : 0);
  if (!dashed) return <View pointerEvents="none" style={{ position: 'absolute', left, top, width: horiz ? len : width, height: horiz ? width : len, backgroundColor: color }} />;
  // Dashes as short views: a one-sided dashed border does not draw on iOS.
  const dashes = [];
  for (let d = 0; d < len; d += px(8)) dashes.push(<View key={d} style={{ position: 'absolute', left: horiz ? d : 0, top: horiz ? 0 : d,
    width: horiz ? Math.min(px(4), len - d) : width, height: horiz ? width : Math.min(px(4), len - d), backgroundColor: color }} />);
  return <View pointerEvents="none" style={{ position: 'absolute', left, top, width: horiz ? len : width, height: horiz ? width : len }}>{dashes}</View>;
}
/** The arrowhead: a bordered triangle at the end of the last piece. */
function Arrow({ seg, color, size }: { seg: Segment; color: string; size: number }) {
  const dir = seg.y1 === seg.y2 ? (seg.x2 > seg.x1 ? 'right' : 'left') : (seg.y2 > seg.y1 ? 'down' : 'up');
  const t = 'transparent', s = size;
  const style = {
    right: { borderLeftWidth: s * 1.4, borderLeftColor: color, borderTopWidth: s, borderTopColor: t, borderBottomWidth: s, borderBottomColor: t, left: seg.x2 - s * 1.4, top: seg.y2 - s },
    left: { borderRightWidth: s * 1.4, borderRightColor: color, borderTopWidth: s, borderTopColor: t, borderBottomWidth: s, borderBottomColor: t, left: seg.x2, top: seg.y2 - s },
    down: { borderTopWidth: s * 1.4, borderTopColor: color, borderLeftWidth: s, borderLeftColor: t, borderRightWidth: s, borderRightColor: t, left: seg.x2 - s, top: seg.y2 - s * 1.4 },
    up: { borderBottomWidth: s * 1.4, borderBottomColor: color, borderLeftWidth: s, borderLeftColor: t, borderRightWidth: s, borderRightColor: t, left: seg.x2 - s, top: seg.y2 },
  }[dir];
  return <View pointerEvents="none" style={{ position: 'absolute', width: 0, height: 0, ...style }} />;
}
/** A small label; centred in a wide box with `alignItems` (a percentage transform is not dependable on native). */
function Chip({ x, y, text, fg, bg, line, testID, align = 'center' }: { x: number; y: number; text: string | string[]; fg: string; bg: string; line?: string; testID?: string; align?: 'center' | 'right' | 'left' }) {
  const lines = typeof text === 'string' ? [text] : text;
  return <View pointerEvents="none" style={{ position: 'absolute', left: align === 'center' ? x - px(200) : align === 'right' ? x - px(400) : x, top: y, width: px(400),
    alignItems: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start' }}>
    <View testID={testID} style={{ paddingHorizontal: px(6), minHeight: FLOW.chipH, paddingVertical: lines.length > 1 ? px(2) : 0, borderRadius: px(9), backgroundColor: bg,
      borderWidth: line ? 1 : 0, borderColor: line, justifyContent: 'center', alignItems: 'center' }}>
      {lines.map((v, i) => <Text key={i} numberOfLines={1} style={{ color: fg, fontSize: FLOW.note, lineHeight: FLOW.chipLine, fontWeight: '600' }}>{v}</Text>)}
    </View>
  </View>;
}
/**
 * The procedure left to right: each step on its row and column, straight-angled lines with arrowheads, a diamond for a
 * decision, a dashed line for an optional step, a dashed outline for a step with nothing to read. The chosen release's way
 * is drawn bold in the main colour moved to 3:1 on the flow's background (research/216: the dark theme's accent alone was
 * under it); each time it went back is one more line beside the loop, coloured by the verdict it came back to.
 */
function FlowView({ model, width, colors: c, overlay, counts, noSource, words: w, maxColumn }: {
  model: WorkflowModelDTO; width: number; colors: Palette; overlay: FlowOverlay; counts: Record<string, string>; noSource: ReadonlySet<string>; words: WorkflowWords;
  maxColumn: number | undefined;
}) {
  const bg = c.surface0, def = model.definition;
  const loopLabels = new Map(def.edges.flatMap((e, i) => {
    if (!e.back) return [];
    const loops = overlay.loops.get(i) ?? [];
    return [[i, { text: loopLabel(e, loops, w), n: Math.max(1, loops.length) }] as const];
  }));
  const { layout: L, forward, loops: spots } = flowLabelLayout(flowLayout(def.stages, width, overlay.notes, counts, maxColumn, byInstance(model)), def.edges, loopLabels);
  const muted = readable(c.foregroundMuted, bg, 3), hot = selectedLine(c, bg), faint = readable(c.foregroundMuted, bg);
  const node = (id: string) => L.at.get(id)!;
  const parts: ReactNode[] = [];
  for (const [i, e] of def.edges.entries()) {
    if (e.back) continue;
    const segs = route(node(e.from), node(e.to), false, 0, rowBottom(L, node(e.from).stage.row)), on = overlay.hot.has(i);
    const color = on ? hot : e.when === 'no' ? readable(c.statusDanger, bg, 3) : muted;
    parts.push(<View key={'e' + i} testID={'flow-edge-' + e.from + '-' + e.to} accessibilityState={{ selected: on }} pointerEvents="none"
      style={{ position: 'absolute', left: 0, top: 0 }}>
      {segs.map((s, k) => <Line key={k} seg={s} color={color} width={on ? FLOW.hot : FLOW.line} dashed={!!e.optional} />)}
      <Arrow seg={segs.at(-1)!} color={color} size={on ? FLOW.arrow + px(1) : FLOW.arrow} />
    </View>);
    if (e.label) {
      const spot = forward.get(i)!;
      parts.push(<Chip key={'el' + i} testID="flow-edge-label" x={spot.x} align={spot.align} y={spot.y} text={e.label} fg={e.when === 'no' ? readable(c.statusDanger, bg) : faint} bg={bg} />);
    }
  }
  for (const [i, e] of def.edges.entries()) {
    if (!e.back) continue;
    const a = node(e.from), b = node(e.to), loops = overlay.loops.get(i) ?? [], n = Math.max(1, loops.length), under = rowBottom(L, a.stage.row);
    parts.push(<View key={'b' + i} testID={'flow-loop-' + e.from + '-' + e.to} accessibilityState={{ selected: loops.length > 0 }} pointerEvents="none"
      style={{ position: 'absolute', left: 0, top: 0 }}>
      {Array.from({ length: n }, (_, k) => {
        const loop = loops[k], segs = route(a, b, true, (k - (n - 1) / 2) * FLOW.loopGap, under);
        // A round that came back takes its verdict's colour; one still open (or none at all) is a grey dashed line.
        const color = loop?.to !== undefined ? verdictColor(c, loop.verdict, bg) : muted;
        return <Fragment key={k}>{segs.map((s, j) => <Line key={j} seg={s} color={color} width={loop ? 3 : FLOW.line} dashed={!loop || loop.to === undefined} />)}
          <Arrow seg={segs.at(-1)!} color={color} size={FLOW.arrow} /></Fragment>;
      })}
    </View>);
  }
  const labels = [...loopLabels].filter(([, label]) => label.text).map(([i, { text }]) => { const spot = spots.get(i)!;
    return <Chip key={'bl' + i} testID="flow-loop-label" align={spot.align} x={spot.x} y={spot.y} text={text}
      fg={(overlay.loops.get(i)?.length ?? 0) > 0 ? c.foreground : faint} bg={c.surface1} line={c.border} />; });
  for (const n of L.at.values()) parts.push(<FlowStep key={'n' + n.stage.id} n={n} colors={c} bg={bg} hot={hot} on={overlay.passed.has(n.stage.id)}
    outlined={noSource.has(n.stage.id)} state={overlay.states[n.stage.id]} />);
  parts.push(...labels);
  const canvas = <View testID="flow-canvas" style={{ width: L.width, height: L.height, position: 'relative' }}>{parts}</View>;
  return L.width > width ? <ScrollView horizontal testID="flow-scroll" style={{ width }}>{canvas}</ScrollView> : canvas;
}
function FlowStep({ n, colors: c, bg, hot, on, outlined, state }: {
  n: FlowNode; colors: Palette; bg: string; hot: string; on: boolean; outlined: boolean; state: string | undefined;
}) {
  const id = n.stage.id, line = on ? hot : outlined ? readable(c.foregroundMuted, bg, 3) : c.border, fill = on ? c.card : outlined ? 'transparent' : c.surface1;
  const label = { color: outlined ? readable(c.foregroundMuted, bg) : c.foreground, fontSize: FLOW.label, lineHeight: FLOW.labelLine,
    fontWeight: on ? '700' as const : '500' as const, textAlign: 'center' as const };
  const noteColor = state === 'unknown-format' || state === 'title-unread' || state === 'incomplete' || state === 'ambiguous' ? readable(c.statusWarning, fill === 'transparent' ? bg : fill)
    : readable(c.foregroundMuted, fill === 'transparent' ? bg : fill);
  const chip = n.chip.length ? <Chip key="count" testID={'flow-count-' + id} x={n.cx} y={n.chipTop} text={n.chip}
    fg={outlined ? readable(c.foregroundMuted, bg) : c.foreground} bg={bg} {...(outlined ? {} : { line: c.border })} /> : null;
  if (n.stage.shape === 'diamond') {
    const side = n.w / Math.SQRT2;
    return <>
      <View testID={'flow-node-' + id} accessibilityState={{ selected: on }} style={{ position: 'absolute', left: n.left, top: n.top, width: n.w, height: n.h, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: side, height: side, borderWidth: on ? 2 : 1, borderColor: line, backgroundColor: fill, transform: [{ rotate: '45deg' }], borderRadius: px(3) }} />
        <Text numberOfLines={2} style={{ ...label, fontSize: px(11.5), lineHeight: px(14), maxWidth: side }}>{n.stage.label}</Text>
      </View>
      {chip}
    </>;
  }
  return <>
    <View testID={'flow-node-' + id} accessibilityState={{ selected: on }} style={{ position: 'absolute', left: n.left, top: n.top, width: n.w, height: n.h,
      borderRadius: n.stage.shape === 'pill' ? Math.min(n.h, FLOW.nodeH) / 2 : px(8), borderWidth: on ? 2 : 1, borderColor: line, borderStyle: outlined ? 'dashed' : 'solid',
      backgroundColor: fill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: px(4) }}>
      <Text numberOfLines={n.labelLines} style={label}>{n.stage.label}</Text>
      {/* REQ-125 U3 313-F3: a 건's note part is one text over its lines ("기록 없음 ·" / "규칙 충돌 1"); a release's, one text a line. */}
      {(n.noteBlocks ?? n.note.map(line => [line])).map((block, i) => <Text key={i} testID={'flow-note-' + id} numberOfLines={n.noteBlockLines?.[i] ?? block.length}
        style={{ color: noteColor, fontSize: FLOW.note, lineHeight: FLOW.noteLine, fontWeight: '600', textAlign: 'center' }}>{block.join('\n')}</Text>)}
    </View>
    {chip}
  </>;
}

// ---- the table and its evidence --------------------------------------------------------------------------------------
const RELEASE_COLUMN = 56;
/** REQ-125 U1: a 건's chip shows twelve characters at most (research/290 3.1); its whole name is its label and the evidence's title. */
export const INSTANCE_CHIP = 12;
/**
 * Releases (newest first) × steps; a cell says what was read, or which of "No record", "Unknown format", "Nothing to read".
 * REQ-125 U1: or 건 × steps — the first column "건", each row's name a chip that chooses the row (`onChoose`).
 */
function WorkflowTable({ model, release, cell, width, colors: c, m, words: w, onPress, onChoose }: {
  model: WorkflowModelDTO; release: WorkflowReleaseDTO | undefined; cell: { release: string; stage: string } | null; width: number;
  colors: Palette; m: Copy; words: WorkflowWords; onPress: (release: string, stage: string) => void; onChoose: (release: string) => void;
}) {
  const stages = tableStages(model), bg = c.surface0, muted = readable(c.foregroundMuted, c.surface1), instances = byInstance(model);
  const cells = model.releases.map(r => stages.map(s => tableCell(r, s, w)));
  // U4b (research/309 4.3): where a 건 ended, under its name ("끝: 불참 · 9/22"); held tags are said in the evidence only.
  const ends = model.releases.map(r => endTagText(r, model.definition.stages, m).shown);
  const firstColumn = instances ? Math.min(px(176), Math.max(px(72), ...model.releases.map((r, k) => Math.max(textWidth(instanceChip(r.label ?? r.release, INSTANCE_CHIP), px(12)) + px(34),
    ends[k] ? textWidth(ends[k]!, px(11)) + px(16) : 0)))) : px(RELEASE_COLUMN);
  const widths = tableWidths(stages.map((s, k) => [s.label, ...cells.map(row => row[k]!.text + (row[k]!.warned ? ' ⚠' : ''))]), width - 2 - firstColumn);
  const total = firstColumn + widths.reduce((a, b) => a + b, 0);
  const table = <View style={{ width: Math.max(total, width - 2) }}>
    <View style={{ flexDirection: 'row', backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border }}>
      <Text testID="workflow-table-first" style={{ width: firstColumn, paddingHorizontal: px(8), paddingVertical: px(5), color: muted, fontSize: px(12), fontWeight: '600' }}>
        {instances ? m.workflowInstance : m.workflowRelease}</Text>
      {stages.map((s, k) => <Text key={s.id} numberOfLines={1} style={{ width: widths[k], paddingHorizontal: px(8), paddingVertical: px(5), color: muted, fontSize: px(12), fontWeight: '600' }}>{s.label}</Text>)}
    </View>
    {model.releases.map((r, row) => {
      const on = r === release, rowBg = on ? c.surface2 : 'transparent', onto = on ? c.surface2 : bg;
      return <View key={r.release} testID={'workflow-row-' + r.release} style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: c.border, backgroundColor: rowBg }}>
        {instances ? <Pressable testID={'workflow-row-instance-' + row} accessibilityRole="button" accessibilityState={{ selected: on }} aria-pressed={on}
          accessibilityLabel={m.workflowShowInstance(r.label ?? r.release) + (ends[row] ? ' · ' + ends[row] : '')} onPress={() => onChoose(r.release)}
          style={{ width: firstColumn, paddingHorizontal: px(6), paddingVertical: px(3), justifyContent: 'center', gap: px(2) }}>
          <View style={{ alignSelf: 'flex-start', maxWidth: firstColumn - px(12), paddingHorizontal: px(7), height: px(22), justifyContent: 'center', borderRadius: px(11), borderWidth: on ? 2 : 1,
            borderColor: on ? selectedLine(c, onto) : c.border, backgroundColor: on ? c.card : 'transparent' }}>
            <Text testID="workflow-rowname" numberOfLines={1} style={{ color: c.foreground, fontSize: px(12), fontWeight: on ? '700' : '400' }}>{instanceChip(r.label ?? r.release, INSTANCE_CHIP)}</Text>
          </View>
          {ends[row] ? <Text testID="workflow-endtag" numberOfLines={1} style={{ color: readable(c.foregroundMuted, onto), fontSize: px(11), fontWeight: '600', paddingLeft: px(2) }}>{ends[row]}</Text> : null}
        </Pressable>
        : <Pressable testID={'workflow-row-release-' + r.release} accessibilityRole="button" accessibilityLabel={m.workflowShowRelease(r.release)}
          onPress={() => onPress(r.release, stages[0]?.id ?? '')} style={{ width: px(RELEASE_COLUMN), paddingHorizontal: px(8), paddingVertical: px(4) }}>
          <Text style={{ color: c.foreground, fontSize: px(12), fontWeight: on ? '700' : '400' }}>{releaseChip(r.release, model.releases.map(x => x.release))}</Text>
        </Pressable>}
        {stages.map((s, k) => {
          const value = cells[row]![k]!, picked = cell?.release === r.release && cell.stage === s.id;
          const face = picked ? selectedTint(c, onto) : onto;
          return <Pressable key={s.id} testID={'workflow-cell-' + s.id} accessibilityRole="button" accessibilityState={{ selected: picked }}
            accessibilityLabel={m.workflowCellLabel(s.label, r.label ?? r.release, value.text)} onPress={() => onPress(r.release, s.id)}
            style={{ width: widths[k], paddingHorizontal: px(8), paddingVertical: px(4), backgroundColor: picked ? face : 'transparent', justifyContent: 'center',
              // REQ-125 U1: "일부만 읽음" is hatched apart from "기록 없음" (research/290 2.10) — a dashed frame around its words.
              ...(value.state === 'incomplete' ? { borderWidth: 1, borderStyle: 'dashed' as const, borderColor: readable(c.statusWarning, face, 3) } : {}) }}>
            {value.tail ? <CellWithTail value={value} color={toneColor(c, value.tone, face)} />
              : <Text testID={'workflow-cell-text-' + value.state} numberOfLines={1} style={{ color: toneColor(c, value.tone, face), fontSize: px(12),
              fontStyle: value.tone === 'muted' || value.state === 'candidate' ? 'italic' : 'normal' }}>{value.text + (value.warned ? ' ⚠' : '')}</Text>}
          </Pressable>;
        })}
      </View>;
    })}
  </View>;
  return <View testID="workflow-table" style={{ backgroundColor: bg, borderRadius: px(8), borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
    {total > width - 2 ? <ScrollView horizontal testID="workflow-table-scroll">{table}</ScrollView> : table}
  </View>;
}
/**
 * U3 stable-fa226af: a cell whose end must stay in sight ("규칙 충돌 1", `tail`) — its words cut short with "…" on their own, the tail
 * after them (" · 규칙 충돌 1", its separator too) never cut, so a long folder name without spaces cannot push it out of a one-line cell (the 314-F4 trap, in the table).
 */
function CellWithTail({ value, color }: { value: ReturnType<typeof tableCell>; color: string }) {
  const head = value.text.slice(0, value.text.length - value.tail!.length).replace(/ · $/, '');
  const italic = value.tone === 'muted' || value.state === 'candidate' ? 'italic' as const : 'normal' as const;
  return <View testID={'workflow-cell-text-' + value.state} style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
    <Text testID="workflow-cell-head" numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color, fontSize: px(12), fontStyle: italic }}>{head}</Text>
    <Text testID="workflow-cell-tail" numberOfLines={1} style={{ flexShrink: 0, color, fontSize: px(12), fontStyle: italic }}>{' · ' + value.tail! + (value.warned ? ' ⚠' : '')}</Text>
  </View>;
}
/**
 * A cell's evidence: why it says what it says, and each document read — its verdict or title line, and `path:line`.
 * REQ-134: the phone shows it in a sheet of its own, whose × closes it (no `onClose` here then).
 */
export function Evidence({ release, stage, colors: c, m, words: w, onClose, wrap, program = false, conflicts = [], shared = [], stages = [] }: {
  release: WorkflowReleaseDTO | undefined; stage: WorkflowStage | undefined; colors: Palette; m: Copy; words: WorkflowWords; onClose?: (() => void) | undefined;
  /** The phone's sheet: the place line (path, line, time) wraps and a long path breaks anywhere, instead of one line cut short. */
  wrap?: boolean | undefined;
  /** REQ-125 U3: a program step's evidence (the band's row) — said common, with what it found inside a 건 folder ("규칙 충돌"). */
  program?: boolean | undefined; conflicts?: readonly string[] | undefined;
  /** REQ-125 U4a: a record cell's evidence that stands in every 건 (`sharedEvidence`), listed after its own. */
  shared?: readonly WorkflowEventDTO[] | undefined;
  /** U4b: the definition's steps, to name the end tag's — said on the end step's and its founding cells' evidence. */
  stages?: readonly WorkflowStage[] | undefined;
}) {
  if (!release || !stage) return null;
  const cell = release.cells.find(v => v.stage === stage.id), bg = c.surface0, muted = readable(c.foregroundMuted, bg);
  // U4a: a record cell (one a `state-log` rule reads says how many shared pieces count in it): what it rests on, always — then why.
  const log = cell?.shared !== undefined, section = [...cell?.events ?? [], ...shared].find(e => e.section)?.section;
  const basis = log ? section ? m.evidenceLogBasis(section) : m.evidenceLogBasisAny : '';
  const why = log ? (cell!.state === 'ambiguous' ? m.evidenceLogAmbiguous : cell!.state === 'incomplete' ? m.evidenceLogIncomplete : cell!.state === 'no-record' ? m.evidenceLogNoRecord : '')
    : cell?.state === 'no-record' ? (program ? m.evidenceNoRecordProgram : release.label !== undefined ? m.evidenceNoRecordInstance : m.evidenceNoRecord) : cell?.state === 'no-source' ? m.evidenceNoSource
    : cell?.state === 'unknown-format' ? m.evidenceUnknown : cell?.state === 'title-unread' ? m.evidenceTitleUnread
    : cell?.state === 'incomplete' ? m.evidenceIncomplete : cell?.state === 'candidate' ? m.evidenceCandidate : cell?.state === 'ambiguous' ? m.evidenceAmbiguous
    // REQ-125 U2: versions are the order seen in the folder now (research/290 2.2) — said once over them.
    : cell?.state === 'found' && cell.events.some(e => e.kind === 'version') ? m.evidenceVersions : '';
  // 309 2.4: writing in the section that is no tag line, said on the sheet too — how many, which lines, that every answer from it waits.
  const wrong = [...new Set(shared.filter(e => e.why === 'not-a-tag-line').map(e => e.line ?? 0))].sort((x, y) => x - y);
  const wrongLine = wrong.length ? m.logNotTagLines(shared.find(e => e.why === 'not-a-tag-line')?.section ?? '', wrong.length, wrong.slice(0, 20).join(', ')) : '';
  // U4b (research/309 4.3): the 건's end tag, on the cells it rests on — shown, or held and why.
  const tag = release.endTag, end = tag && (tag.stage === stage.id || tag.by.includes(stage.id)) ? endTagText(release, stages, m) : null;
  const quiet = cell?.state === 'no-record' || cell?.state === 'no-source' || cell?.state === 'candidate' || (cell?.state === 'found' && why === m.evidenceVersions);
  const events = [...cell?.events ?? [], ...shared];
  /** U4a: a record piece's own line — "확인됨 · 예", "모호 — 이 구역 규칙에 없는 행위 · 모든 건", "· 앞선 근거 — 답을 막지 않음". */
  const logLine = (e: WorkflowEventDTO) => e.kind !== 'log' ? '' : [e.strength === 'confirmed' ? m.logConfirmed + (e.answer ? ' · ' + (e.answer === 'yes' ? m.answerYes : m.answerNo) : '')
    : m.logAmbiguous + (e.why ? ' — ' + (m.logWhy[e.why] ?? e.why) : ''), e.scope === 'all' ? m.logEveryCase : '', e.earlier ? m.logEarlier : ''].filter(Boolean).join(' · ');
  // U3 311-F2: a 건 cell's files a common rule took (규칙 충돌) — listed as the band's are.
  const held = conflicts.length ? conflicts : cell?.conflicts ?? [];
  /** U2: a version's own line — "v1.0 · 관측된 첫 판 · 문서 …" — or why a file that fits is no version. */
  const versionLine = (e: WorkflowEventDTO) => e.kind !== 'version' ? '' : e.ver === undefined ? m.evidenceVersionUnread
    : m.evidenceVersion(e.ver, e.observed === 'later' ? m.versionLater : w.versionFirst, e.chain ?? '')
      + (e.seen ? ' · ' + w.versionsSeen(e.seen) : '');
  return <View testID="workflow-evidence" style={{ backgroundColor: bg, borderRadius: px(8), borderWidth: 1, borderColor: c.border, padding: px(10), gap: px(6) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
      <Text testID="workflow-evidence-title" style={{ flex: 1, color: c.foreground, fontSize: px(13), fontWeight: '700' }}>
        {stage.label + ' · ' + (release.label ?? release.release) + ' · ' + tableCell(release, stage, w).text}</Text>
      {onClose && <IconButton testID="workflow-evidence-close" name="X" label={m.evidenceClose} plain colors={c} mobile={false} onPress={onClose} />}
    </View>
    {program ? <Text testID="workflow-evidence-program" style={{ color: muted, fontSize: px(12) }}>{m.evidenceProgram}</Text> : null}
    {basis ? <Text testID="workflow-evidence-basis" style={{ color: muted, fontSize: px(12) }}>{basis}</Text> : null}
    {why ? <Text testID="workflow-evidence-why" style={{ color: quiet ? muted : readable(c.statusWarning, bg), fontSize: px(12) }}>{why}</Text> : null}
    {end?.shown ? <Text testID="workflow-evidence-end" style={{ color: c.foreground, fontSize: px(12), fontWeight: '600' }}>{end.shown}</Text> : null}
    {end?.held ? <Text testID="workflow-evidence-end-held" style={{ color: readable(c.statusWarning, bg), fontSize: px(12), ...(wrap ? { wordBreak: 'break-all', overflowWrap: 'anywhere' } as object : {}) }}>{end.held}</Text> : null}
    {wrongLine ? <Text testID="workflow-evidence-log-wrong" style={{ color: readable(c.statusWarning, bg), fontSize: px(12) }}>{wrongLine}</Text> : null}
    {release.warnings.filter(x => x.stage === stage.id).map((x, i) => <Text key={'w' + i} testID="workflow-evidence-warning"
      style={{ color: readable(c.statusWarning, bg), fontSize: px(12) }}>{'⚠ ' + m.evidenceShaMismatch(x.sha, x.resultSha) + ' ' + x.path}</Text>)}
    {events.slice(0, 12).map((e, i) => <View key={i} testID="workflow-evidence-item" style={{ gap: px(1), paddingLeft: px(8), borderLeftWidth: 2,
      borderColor: e.verdict ? verdictColor(c, e.verdict, bg) : c.border }}>
      {(e.excerpt ?? e.subject) ? <Text testID="workflow-evidence-excerpt" numberOfLines={2} style={{ color: c.foreground, fontSize: px(12) }}>{'“' + (e.excerpt ?? e.subject) + '”'}</Text> : null}
      {e.kind === 'log' ? <Text testID="workflow-evidence-log" numberOfLines={wrap ? undefined : 2}
        style={{ color: e.strength === 'confirmed' ? c.foreground : e.earlier ? muted : readable(c.statusWarning, bg), fontSize: px(12) }}>{logLine(e)}</Text> : null}
      {e.kind === 'version' ? <Text testID="workflow-evidence-version" numberOfLines={wrap ? undefined : 2}
        style={{ color: e.ver === undefined ? readable(c.statusWarning, bg) : c.foreground, fontSize: px(12) }}>{versionLine(e)}</Text> : null}
      {(e.paths ?? [e.path]).map((place, k) => <Text key={k} testID="workflow-evidence-place" selectable numberOfLines={wrap ? undefined : 1}
        style={{ color: muted, fontSize: px(11), ...(wrap ? { wordBreak: 'break-all', overflowWrap: 'anywhere' } as object : {}) }}>
        {k > 0 ? place : [evidencePlace({ ...e, path: place }), e.time ?? '', e.days ? m.evidenceDays(e.days) : '', e.releaseFrom ? m.releaseFrom[e.releaseFrom] ?? '' : '', e.sha ?? '',
          e.files !== undefined ? m.evidenceFolder(e.files) : ''].filter(Boolean).join(' · ')}</Text>)}
    </View>)}
    {events.length > 12 && <Text style={{ color: muted, fontSize: px(11) }}>{'+' + (events.length - 12)}</Text>}
    {held.length > 0 && <View testID="workflow-evidence-conflicts" style={{ gap: px(1), paddingLeft: px(8), borderLeftWidth: 2, borderColor: readable(c.statusWarning, bg, 3) }}>
      <Text style={{ color: readable(c.statusWarning, bg), fontSize: px(12) }}>{m.evidenceConflict}</Text>
      {held.slice(0, 12).map((place, k) => <Text key={k} testID="workflow-evidence-conflict" selectable numberOfLines={wrap ? undefined : 1}
        style={{ color: muted, fontSize: px(11), ...(wrap ? { wordBreak: 'break-all', overflowWrap: 'anywhere' } as object : {}) }}>{place}</Text>)}
      {held.length > 12 && <Text style={{ color: muted, fontSize: px(11) }}>{'+' + (held.length - 12)}</Text>}
    </View>}
    <Text style={{ color: muted, fontSize: px(11) }}>{m.evidencePaths}</Text>
  </View>;
}
