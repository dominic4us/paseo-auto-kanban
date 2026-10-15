import { useRef, useState } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { workflowExport, workflowPickSet } from '../shared/rpc.js';
import { BUILTIN_WORKFLOWS, builtinPreview, builtinWorkflow, type BuiltinGrade, type BuiltinWorkflow } from '../shared/workflow-templates.js';
import type { Locale } from '../shared/core/domain.js';
import { readable, selectedLine, type Palette } from './palette.js';
import type { Copy } from './i18n.js';
import { toolLook, useHovered } from './components.js';
import { usePopover } from './popover-menu.js';
import type { HostPlatform } from './layout.js';
import { KanbanSheet } from './kanban-sheet.js';
import { px } from './ui-scale.js';

/**
 * REQ-125 C안 1단계 (research/282 안 C, research/284): a lane whose workspace holds no workflow definition offers "Try a
 * workflow" where "Board | Workflow" would be (the phone: its ⋯ sheet). Its list is the eight built-in workflows
 * (shared/workflow-templates.ts) — name, grade, what it is for and the first steps; one press picks it and the lane shows it
 * at once (no preview, no "create"). Only the plugin's `workflow-picks.json` changes (`kanban.v1.workflow.pick.set`); the
 * workflow's banner says so and offers "Change" and "Stop using", which takes the pick out and leaves nothing behind.
 */

/** Saves a pick (a built-in's id) or takes it out (`null`); the error is said in the copy's words. */
export function usePickSaver(m: Copy) {
  const set = useRpc(workflowPickSet), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (workspaceId: string, template: string | null): Promise<boolean> => {
    setBusy(true); setError('');
    try {
      const reply = await set({ workspaceId, template });
      if (reply.ok) return true;
      setError(reply.error.code === 'E_CORRUPT' ? m.workflowPickDamaged : reply.error.code === 'E_LIMIT' ? m.workflowPickFull
        : reply.error.code === 'E_VALIDATION' ? m.workflowPickFolder : m.workflowPickFailed);
      return false;
    } catch { setError(m.workflowPickFailed); return false; } finally { setBusy(false); }
  };
  return { save, busy, error, clear: () => setError('') };
}

/** A written export: whether the pick was cleared (293-J3) and what could not be removed (295-F4). */
export interface ExportDone { pickCleared: boolean; left: string[] }
/** The line said after an export: made the file, then the pick not cleared and the files left, when so. */
export function exportedLine(m: Copy, done: ExportDone): string {
  return m.workflowExported + (done.pickCleared ? '' : ' ' + m.workflowExportedPickKept) + (done.left.length ? ' ' + m.workflowExportLeft(done.left) : '');
}
/**
 * REQ-125 2단계 (research/288): writes the pick into the project folder as `.kanban/workflow.json`; the error is said in the
 * copy's words (E_EXISTS: a file is there and was not written over, E_OUTSIDE: `.kanban` leads outside, E_CONFLICT: the pick
 * changed on another screen, 293 E_UNSUPPORTED: no safe way to add the file on this host). A success says whether the pick was cleared.
 * 295-F4: files the export could not take back (`left`, by full path) are always said — with the refusal, or after a success.
 */
export function useExporter(m: Copy) {
  const run = useRpc(workflowExport), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const write = async (workspaceId: string, template: string): Promise<ExportDone | null> => {
    setBusy(true); setError('');
    try {
      const reply = await run({ workspaceId, template });
      if (reply.ok) return { pickCleared: reply.data.pickCleared, left: reply.data.left ?? [] };
      const code = reply.error.code, details = reply.error.details as { left?: unknown } | null;
      // 295-F4: `details.left` (an array, maybe empty) comes with a folder moved out while writing; its names are said in full.
      const moved = !!details && Array.isArray(details.left), left = moved ? (details!.left as unknown[]).map(String) : [];
      const tail = left.length ? ' ' + m.workflowExportLeft(left) : '';
      setError((code === 'E_EXISTS' ? m.workflowExportExists : code === 'E_OUTSIDE' ? (moved ? m.workflowExportMoved : m.workflowExportOutside)
        : code === 'E_CONFLICT' ? m.workflowExportConflict : code === 'E_UNSUPPORTED' ? m.workflowExportUnsupported : m.workflowExportFailed) + tail);
      return null;
    } catch { setError(m.workflowExportFailed); return null; } finally { setBusy(false); }
  };
  return { write, busy, error, clear: () => setError('') };
}

/** A grade's colour: tested in the success colour, adapted in the accent, reference in grey — held to 4.5:1 on `onto`. */
export function gradeColor(c: Palette, grade: BuiltinGrade, onto: string): string {
  return readable(grade === 'verified' ? c.statusSuccess : grade === 'adapted' ? selectedLine(c, onto) : c.foregroundMuted, onto);
}
export function GradeBadge({ grade, colors: c, m, onto }: { grade: BuiltinGrade; colors: Palette; m: Copy; onto: string }) {
  const color = gradeColor(c, grade, onto);
  return <View testID={'workflow-grade-' + grade} style={{ paddingHorizontal: px(6), height: px(18), justifyContent: 'center', borderRadius: px(9),
    borderWidth: 1, borderColor: color }}>
    <Text numberOfLines={1} style={{ color, fontSize: px(11), fontWeight: '600' }}>{m.workflowGrade[grade] ?? grade}</Text>
  </View>;
}

/** How many first steps a row previews before "+N". */
const PREVIEW_STEPS = 5;
/** The eight built-ins, one row each; `current` marks the one in use (from "Change"). */
export function WorkflowPickList({ locale, current, onPick, disabled, colors: c, m, mobile }: {
  locale: Locale; current?: string | undefined; onPick: (template: BuiltinWorkflow) => void; disabled: boolean;
  colors: Palette; m: Copy; mobile: boolean;
}) {
  const bg = c.surface1, muted = readable(c.foregroundMuted, bg);
  return <View testID="workflow-pick-list" style={{ gap: px(2) }}>
    <Text testID="workflow-pick-hint" style={{ color: muted, fontSize: mobile ? px(13) : px(12), paddingHorizontal: px(8), paddingBottom: px(4) }}>{m.workflowPickHint}</Text>
    {BUILTIN_WORKFLOWS.map(t => <PickRow key={t.id} template={t} locale={locale} now={t.id === current} disabled={disabled}
      onPress={() => onPick(t)} colors={c} m={m} mobile={mobile} />)}
  </View>;
}
/** REQ-125 F2: a refused save, said in a fixed line outside the scrolling list (the popover's top, the sheet's `notice`). */
export function PickError({ error, colors: c, mobile }: { error: string; colors: Palette; mobile: boolean }) {
  if (!error) return null;
  return <Text testID="workflow-pick-error" accessibilityRole="alert" style={{ color: readable(c.statusDanger, c.surface1), fontSize: mobile ? px(13) : px(12),
    paddingHorizontal: mobile ? px(16) : px(8), paddingTop: mobile ? px(8) : px(4), paddingBottom: px(4) }}>{error}</Text>;
}
function PickRow({ template: t, locale, now, disabled, onPress, colors: c, m, mobile }: {
  template: BuiltinWorkflow; locale: Locale; now: boolean; disabled: boolean; onPress: () => void; colors: Palette; m: Copy; mobile: boolean;
}) {
  const hover = useHovered(), bg = c.surface1;
  const look = toolLook(c, { hovered: hover.hovered && !disabled, fill: bg, quiet: false, onto: bg, mark: false });
  const face = now ? c.surface2 : look.backgroundColor, steps = builtinPreview(t, locale), shown = steps.slice(0, PREVIEW_STEPS);
  const muted = readable(c.foregroundMuted, face), name = t.name[locale];
  return <Pressable testID={'workflow-pick-' + t.id} accessibilityRole="button" accessibilityState={{ disabled, selected: now }} aria-pressed={now}
    accessibilityLabel={name + ' · ' + (m.workflowGrade[t.grade] ?? '') + ' · ' + t.one[locale]} disabled={disabled}
    onPress={onPress} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
    style={{ minHeight: mobile ? px(56) : px(44), paddingHorizontal: px(8), paddingVertical: px(6), borderRadius: px(6), gap: px(3), backgroundColor: face,
      borderWidth: now ? 1 : 0, borderColor: selectedLine(c, face), opacity: disabled ? .6 : 1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(8) }}>
      <Text testID="workflow-pick-name" numberOfLines={1} style={{ color: c.foreground, fontSize: mobile ? px(15) : px(13), fontWeight: '700', flexShrink: 1 }}>{name}</Text>
      <GradeBadge grade={t.grade} colors={c} m={m} onto={face} />
      {now && <Text style={{ color: muted, fontSize: px(11) }}>{m.workflowPickNow}</Text>}
    </View>
    <Text testID="workflow-pick-one" numberOfLines={mobile ? 2 : 1} style={{ color: muted, fontSize: mobile ? px(12) : px(11) }}>{t.one[locale]}</Text>
    <View testID="workflow-pick-steps" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(4) }}>
      {shown.map((s, i) => <View key={i} style={{ paddingHorizontal: px(5), height: px(18), justifyContent: 'center', borderRadius: px(4),
        backgroundColor: s.decision ? c.surface0 : c.surface2, borderWidth: s.decision ? 1 : 0, borderColor: c.border }}>
        <Text numberOfLines={1} style={{ color: s.decision ? readable(c.statusWarning, c.surface0) : c.foreground, fontSize: px(11) }}>{s.label}</Text>
      </View>)}
      {steps.length > shown.length && <Text style={{ color: muted, fontSize: px(11), alignSelf: 'center' }}>{'+' + (steps.length - shown.length)}</Text>}
    </View>
  </Pressable>;
}

/**
 * The wide list, hanging under the control that opened it (as `PopoverMenu`, wider): right-aligned, scrolled when the
 * window is short; Escape or a press outside closes it and the focus goes back.
 */
export function WorkflowPickPopover({ open, anchor, onClose, onDismiss, children, label, error, colors: c, m }: {
  open: boolean; anchor: { x: number; y: number; width: number; height: number }; onClose: () => void; onDismiss: () => void;
  children: React.ReactNode; label: string; error: string; colors: Palette; m: Copy;
}) {
  const viewport = useWindowDimensions(), width = Math.min(px(560), viewport.width - px(16));
  const left = Math.max(px(8), Math.min(anchor.x + anchor.width - width, viewport.width - width - px(8)));
  const below = viewport.height - anchor.y - anchor.height - px(12), above = anchor.y - px(12);
  // The eight rows want about 520px: below when they fit there, else on the side with more room.
  const down = below >= px(520) || below >= above, maxHeight = Math.max(px(160), (down ? below : above) - px(4));
  const place = down ? { top: anchor.y + anchor.height + px(4) } : { bottom: viewport.height - anchor.y + px(4) };
  return <Modal testID="workflow-pick-modal" visible={open} transparent animationType="none" onRequestClose={onClose} onDismiss={onDismiss}>
    <View style={{ flex: 1 }} onAccessibilityEscape={onClose}>
      <Pressable testID="workflow-pick-dismiss" accessibilityRole="button" accessibilityLabel={m.close} onPress={onClose}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <View testID="workflow-pick-popover" accessibilityLabel={label} style={{ position: 'absolute', left, width, maxHeight, ...place,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, borderRadius: px(8), padding: px(4),
        shadowColor: '#000', shadowOpacity: .12, shadowRadius: px(12), shadowOffset: { width: 0, height: px(4) } }}>
        <PickError error={error} colors={c} mobile={false} />
        <ScrollView style={{ flexGrow: 0, flexShrink: 1, minHeight: 0, maxHeight: maxHeight - px(10) }}>{children}</ScrollView>
      </View>
    </View>
  </Modal>;
}

/**
 * The wide lane heading's "Try a workflow", in the place of "Board | Workflow": opens the list; a pick is saved, then
 * `onPicked` shows the lane's workflow.
 */
export function TryWorkflowButton({ workspaceId, name, locale, onPicked, colors: c, m, disabled = false }: {
  workspaceId: string; name: string; locale: Locale; onPicked: (template: string) => void; colors: Palette; m: Copy; disabled?: boolean;
}) {
  const trigger = useRef<View>(null), popover = usePopover(trigger), saver = usePickSaver(m), hover = useHovered();
  const look = toolLook(c, { hovered: hover.hovered && !disabled });
  const pick = async (t: BuiltinWorkflow) => { if (await saver.save(workspaceId, t.id)) { popover.close(); onPicked(t.id); } };
  return <>
    <Pressable ref={trigger} testID="lane-workflow-try" accessibilityRole="button" accessibilityLabel={m.workflowTryFor(name)}
      accessibilityState={{ disabled, expanded: popover.open }} disabled={disabled}
      onPress={() => { saver.clear(); if (popover.open) popover.close(); else popover.show(); }} onHoverIn={hover.onHoverIn} onHoverOut={hover.onHoverOut}
      style={{ height: px(28), paddingHorizontal: px(10), borderRadius: px(6), borderWidth: 1, borderColor: c.border, borderStyle: 'dashed',
        backgroundColor: look.backgroundColor, flexDirection: 'row', alignItems: 'center', opacity: disabled ? .4 : 1 }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: px(12) }}>{m.workflowTry}</Text>
    </Pressable>
    <WorkflowPickPopover open={popover.open} anchor={popover.anchor} onClose={popover.close} onDismiss={popover.returnFocus}
      label={m.workflowTryFor(name)} error={saver.error} colors={c} m={m}>
      <WorkflowPickList locale={locale} onPick={t => { void pick(t); }} disabled={saver.busy} colors={c} m={m} mobile={false} />
    </WorkflowPickPopover>
  </>;
}

/** The phone's list, in a sheet from a lane's ⋯ ("Try a workflow") or the workflow's "Change". */
export function WorkflowPickSheet({ target, current, locale, onClose, onPicked, colors: c, m, platform }: {
  target: { workspaceId: string; name: string } | null; current?: string | undefined; locale: Locale; onClose: () => void;
  onPicked: (template: string) => void; colors: Palette; m: Copy; platform: HostPlatform;
}) {
  const saver = usePickSaver(m);
  const pick = async (t: BuiltinWorkflow) => { if (target && await saver.save(target.workspaceId, t.id)) onPicked(t.id); };
  return <KanbanSheet testID="workflow-pick-sheet" closeTestID="workflow-pick-sheet-close" title={target ? m.workflowTryFor(target.name) : m.workflowTry}
    open={!!target} onClose={() => { saver.clear(); onClose(); }} colors={c} platform={platform} closeLabel={m.close} centered={false}
    notice={<PickError error={saver.error} colors={c} mobile />}>
    {target && <WorkflowPickList locale={locale} current={current} onPick={t => { void pick(t); }} disabled={saver.busy}
      colors={c} m={m} mobile />}
  </KanbanSheet>;
}

/**
 * The banner over a built-in's workflow: which built-in, its grade, that it lives in Kanban only, and "Change" / "Stop using"
 * / (REQ-125 2단계) "Export to the project folder". `onChange` opens the list (the wide screen hangs it under the button, the
 * phone opens its sheet); `onStopped` follows a stop that was saved, `onExported` a file that was written. Export asks first
 * in one line under the buttons (a file appears in the project folder, which git may pick up); a refusal is said right there.
 */
export function BuiltinBanner({ workspaceId, template, locale, onChange, onStopped, onExported, colors: c, m, mobile, changeRef }: {
  workspaceId: string; template: string; locale: Locale; onChange: () => void; onStopped: () => void; onExported: (done: ExportDone) => void;
  colors: Palette; m: Copy; mobile: boolean; changeRef?: React.RefObject<View | null>;
}) {
  const t = builtinWorkflow(template), saver = usePickSaver(m), exporter = useExporter(m), bg = c.surface2;
  const [confirming, setConfirming] = useState(false);
  if (!t) return null;
  const muted = readable(c.foregroundMuted, bg), busy = saver.busy || exporter.busy, error = exporter.error || saver.error;
  const stop = async () => { setConfirming(false); exporter.clear(); if (await saver.save(workspaceId, null)) onStopped(); };
  const write = async () => { saver.clear(); const done = await exporter.write(workspaceId, t.id); if (done) { setConfirming(false); onExported(done); } };
  const button = (testID: string, label: string, onPress: () => void, ref?: React.RefObject<View | null>, strong = false) =>
    <Pressable ref={ref} testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={onPress}
      style={{ height: mobile ? px(40) : px(26), paddingHorizontal: mobile ? px(14) : px(10), borderRadius: px(6), borderWidth: 1, borderColor: strong ? selectedLine(c, bg) : c.border,
        backgroundColor: c.surface0, justifyContent: 'center', alignItems: 'center', opacity: busy ? .6 : 1, ...(mobile ? { flex: 1 } : {}) }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: mobile ? px(14) : px(12), fontWeight: strong ? '600' : '400' }}>{label}</Text>
    </Pressable>;
  const ask = () => { saver.clear(); exporter.clear(); setConfirming(true); };
  return <View testID="workflow-builtin-banner" style={{ backgroundColor: bg, borderRadius: px(8), paddingHorizontal: px(10), paddingVertical: mobile ? px(10) : px(6), gap: px(6) }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
      <Text testID="workflow-builtin-name" style={{ color: c.foreground, fontSize: mobile ? px(14) : px(12), fontWeight: '700' }}>{m.workflowTrying(t.name[locale])}</Text>
      <GradeBadge grade={t.grade} colors={c} m={m} onto={bg} />
      <Text testID="workflow-builtin-kept" style={{ color: muted, fontSize: mobile ? px(12) : px(12), flexShrink: 1 }}>{m.workflowKeptInKanban}</Text>
      {!mobile && <View style={{ flex: 1 }} />}
      {!mobile && button('workflow-change', m.workflowChange, onChange, changeRef)}
      {!mobile && button('workflow-stop', m.workflowStop, () => { void stop(); })}
      {!mobile && !confirming && button('workflow-export', m.workflowExport, ask)}
    </View>
    <Text testID="workflow-builtin-reads" style={{ color: muted, fontSize: mobile ? px(13) : px(12) }}>{m.workflowBuiltinReadsNothing}</Text>
    {mobile && <View style={{ flexDirection: 'row', gap: px(8) }}>
      {button('workflow-change', m.workflowChange, onChange)}
      {button('workflow-stop', m.workflowStop, () => { void stop(); })}
    </View>}
    {mobile && !confirming && <View style={{ flexDirection: 'row' }}>{button('workflow-export', m.workflowExport, ask)}</View>}
    {confirming && <View testID="workflow-export-confirm" style={{ flexDirection: mobile ? 'column' : 'row', flexWrap: 'wrap',
      alignItems: mobile ? 'stretch' : 'center', gap: px(8) }}>
      <Text testID="workflow-export-note" style={{ color: c.foreground, fontSize: mobile ? px(13) : px(12), flexShrink: 1, ...(mobile ? {} : { flexBasis: px(320), flexGrow: 1 }) }}>
        {m.workflowExportConfirm}</Text>
      <View style={{ flexDirection: 'row', gap: px(8) }}>
        {button('workflow-export-go', m.workflowExportGo, () => { void write(); }, undefined, true)}
        {button('workflow-export-cancel', m.cancel, () => { exporter.clear(); setConfirming(false); })}
      </View>
    </View>}
    {!!error && <Text testID={exporter.error ? 'workflow-export-error' : 'workflow-pick-error'} accessibilityRole="alert"
      style={{ color: readable(c.statusDanger, bg), fontSize: mobile ? px(13) : px(12) }}>{error}</Text>}
  </View>;
}

/** "No records yet — the flow only": a built-in has no reading rules, so its table would only ever be empty. */
export function BuiltinEmpty({ colors: c, m, mobile }: { colors: Palette; m: Copy; mobile: boolean }) {
  return <View testID="workflow-builtin-empty" style={{ borderRadius: px(8), borderWidth: 1, borderStyle: 'dashed', borderColor: c.border,
    paddingHorizontal: px(12), paddingVertical: mobile ? px(14) : px(10), alignItems: 'center' }}>
    <Text style={{ color: readable(c.foregroundMuted, c.panel), fontSize: mobile ? px(13) : px(12), textAlign: 'center' }}>{m.workflowBuiltinEmpty}</Text>
  </View>;
}

/** A pick resting under a definition file: said in one line, with "Clear the pick" so nothing is left behind unseen. */
export function RestingPick({ workspaceId, template, locale, onCleared, colors: c, m, mobile }: {
  workspaceId: string; template: string; locale: Locale; onCleared: () => void; colors: Palette; m: Copy; mobile: boolean;
}) {
  const t = builtinWorkflow(template), saver = usePickSaver(m), muted = readable(c.foregroundMuted, c.panel);
  if (!t) return null;
  return <View testID="workflow-resting-pick" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
    <Text style={{ color: muted, fontSize: mobile ? px(12) : px(11), flexShrink: 1 }}>{m.workflowResting(t.name[locale])}</Text>
    <Pressable testID="workflow-clear-pick" accessibilityRole="button" accessibilityLabel={m.workflowClearPick} disabled={saver.busy}
      onPress={() => { void saver.save(workspaceId, null).then(ok => { if (ok) onCleared(); }); }} hitSlop={mobile ? px(10) : px(4)}
      style={{ paddingHorizontal: px(8), height: mobile ? px(32) : px(22), justifyContent: 'center', borderRadius: px(6), borderWidth: 1, borderColor: c.border }}>
      <Text style={{ color: c.foreground, fontSize: mobile ? px(13) : px(11) }}>{m.workflowClearPick}</Text>
    </Pressable>
    {!!saver.error && <Text testID="workflow-pick-error" style={{ color: readable(c.statusDanger, c.panel), fontSize: px(11) }}>{saver.error}</Text>}
  </View>;
}
