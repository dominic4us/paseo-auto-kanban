/**
 * REQ-146 (research/378): the inputs the Hermes run test computes in both engines. `scripts/hermes-runtime.mjs` copies this
 * file to the root of a copy of the plugin, bundles it with Paseo's own plugin compiler (the client settings the app
 * evaluates) and runs the one bundle in node and in the Hermes VM; the test compares the two JSON outputs.
 * Only modules whose bundle needs no host module but `zod` and `@getpaseo/plugin` are imported (no React, no React Native).
 * Paths are relative to the plugin root, where the script places this file.
 * This file itself runs in Hermes with no block scope: no function made in a loop may keep the loop's variable.
 */
import { setUiScale } from './client/ui-scale.js';
import * as uiScale from './client/ui-scale.js';
import * as layout from './client/layout.js';
import * as mobileLayout from './client/mobile-layout.js';
import * as mobileModel from './client/mobile-model.js';
import * as visualModel from './client/visual-model.js';
import * as dropdownState from './client/dropdown-state.js';
import * as swimlaneModel from './client/swimlane-model.js';
import * as workflowModel from './client/workflow-model.js';
import * as palette from './client/palette.js';
import * as panelStyle from './client/panel-style.js';
import * as leadStatusModel from './client/lead-status.js';
import * as signalModel from './client/signal-model.js';
import * as cardMeta from './client/card-meta.js';
import * as cardOrder from './client/card-order.js';
import * as orderModel from './client/order-model.js';
import * as filterModel from './client/filter-model.js';
import * as stageTime from './client/stage-time.js';
import * as busyView from './client/busy-view.js';
import * as refreshModel from './client/refresh-model.js';
import * as moveModel from './client/move-model.js';
import * as checkupModel from './client/checkup-model.js';
import * as i18n from './client/i18n.js';
import * as leaderIcons from './client/leader-icons.js';
import * as providerIcons from './client/provider-icons.js';
import * as stageColor from './client/stage-color.js';
import * as mailTip from './client/mail-tip.js';
import * as cardGroups from './client/card-groups.js';
import * as presentation from './client/presentation.js';
import * as domain from './shared/core/domain.js';
import * as dispatch from './shared/dispatch.js';
import * as criteria from './shared/criteria.js';
import * as archive from './shared/archive.js';
import * as mailbox from './shared/mailbox.js';
import * as workflow from './shared/workflow.js';
import * as workflowTemplates from './shared/workflow-templates.js';
import { attempt, type Json } from './client/__snapshot.js';


const MODULES: Record<string, Record<string, unknown>> = {
  'client/ui-scale': uiScale, 'client/layout': layout, 'client/mobile-layout': mobileLayout, 'client/visual-model': visualModel,
  'client/dropdown-state': dropdownState, 'client/swimlane-model': swimlaneModel, 'client/workflow-model': workflowModel,
  'client/palette': palette, 'client/panel-style': panelStyle, 'client/lead-status': leadStatusModel,
  'client/signal-model': signalModel, 'client/card-meta': cardMeta, 'client/card-order': cardOrder,
  'client/order-model': orderModel, 'client/filter-model': filterModel, 'client/stage-time': stageTime,
  'client/busy-view': busyView, 'client/refresh-model': refreshModel, 'client/move-model': moveModel, 'client/checkup-model': checkupModel, 'client/i18n': i18n,
  'client/leader-icons': leaderIcons, 'client/provider-icons': providerIcons, 'client/stage-color': stageColor,
  'client/mail-tip': mailTip, 'client/card-groups': cardGroups, 'client/presentation': presentation,
  'shared/core/domain': domain, 'shared/dispatch': dispatch, 'shared/criteria': criteria, 'shared/archive': archive,
  'shared/mailbox': mailbox, 'shared/workflow': workflow, 'shared/workflow-templates': workflowTemplates,
};
/** Every exported value that is not a function, read at the current scale (the size tables, colours, copy, limits). */
function exportedValues(): Json {
  const out: { [key: string]: Json } = {};
  for (const name of Object.keys(MODULES)) {
    const module = MODULES[name]!, values: { [key: string]: Json } = {};
    for (const key of Object.keys(module).sort()) if (typeof module[key] !== 'function') values[key] = attempt(() => module[key]);
    out[name] = values;
  }
  return out;
}

const NOW = Date.parse('2026-10-16T03:00:00.000Z');
const templates = workflowTemplates.BUILTIN_WORKFLOWS;
const statusCard = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: 'Card ' + id, stageId: 'todo', nextAction: '',
  awaiting: null, agentIds: [] as string[], blocked: false, intent: 'requested' as const, updatedAt: '2026-10-16T02:00:00.000Z', ...extra });
const buckets: Record<string, signalModel.SignalBucket> = { lead: 'working', w1: 'permission', w2: 'idle', w3: 'error', w4: 'attention' };
const readBucket = (id: string): signalModel.SignalBucket => buckets[id] ?? 'unknown';

/** The computations the screens make from sizes, per scale. */
function sized(): Record<string, () => unknown> {
  const flows: Record<string, () => unknown> = {};
  // D57 (research/418): English too, and at 760 — the narrowest column, where long names take three lines and diamonds grow.
  templates.forEach(template => (['ko', 'en'] as const).forEach(locale => {
    const definition = workflowTemplates.builtinDefinition(template, locale);
    [900, 760, 360].forEach(width => {
      flows['flowLayout ' + template.id + (locale === 'ko' ? '' : ' en') + ' ' + width] = () => {
        const flow = workflowModel.flowLayout(definition.stages, width, {}, {});
        return { flow, obstacles: workflowModel.flowObstacles(flow), routes: definition.edges.map(edge =>
          workflowModel.route(flow.at.get(edge.from)!, flow.at.get(edge.to)!, !!edge.back)) };
      };
    });
  }));
  return {
    ...flows,
    boardLayout: () => [360, 759, 760, 1400].map(width => [layout.boardLayout(width, true), layout.boardLayout(width, false)]),
    editorLayout: () => (['web', 'android', 'ios'] as const).map(platform => [layout.editorLayout(platform, true, 800), layout.editorLayout(platform, false, 800)]),
    settingsWindowSize: () => [layout.settingsWindowSize({ width: 1200, height: 800 }), layout.settingsWindowSize({ width: 500, height: 700 })],
    textWidth: () => [layout.textWidth('칸반 보드 Kanban', 13), layout.textWidth('', 12), layout.textWidth('W'.repeat(40), 16)],
    projectHeaderHeight: () => layout.projectHeaderHeight(),
    boardHeader: () => [layout.boardHeaderWidth(1400, 1200), layout.boardHeaderWidth(800, 1200), layout.boardOffset(1400, 1200, 'center'),
      layout.boardOffset(1400, 1200, 'left')],
    stickyHeaderStyle: () => layout.stickyHeaderStyle({ surface0: '#fff', cardShadow: '#000', stickyEdge: '#ccc' }),
    navigationInset: () => [layout.navigationInset('android', { screen: 800, window: 752, statusBar: 24 }), layout.navigationInset('ios'),
      layout.bottomClearance('android'), layout.sheetBottomGap()],
    firstCardY: () => (['surface', 'board', 'panel'] as const).map(kind => mobileLayout.firstCardY(kind)),
    // REQ-148: the tab a phone opens on — In progress while it has cards, else the first with cards, else In progress.
    openingStage: () => [[1, 2, 0, 0], [3, 0, 1, 0], [0, 0, 2, 1], [0, 0, 0, 0], [0, 0, 0, 4]].map(counts =>
      mobileModel.openingStage(['todo', 'doing', 'review', 'done'].map((stageId, i) => ({ stageId, count: counts[i]! })), 'doing'))
      .concat([mobileModel.openingStage([], 'todo'), mobileModel.openingStage([{ stageId: 'a', count: 0 }, { stageId: 'b', count: 2 }], 'a')]),
    mobileControls: () => [mobileLayout.mobileControls(360), mobileLayout.mobileControls(390, 5), mobileLayout.mobileControls(320, 4, 60, 40)],
    surfaceLayout: () => [mobileLayout.surfaceLayout(390, 'ios'), mobileLayout.surfaceLayout(1200, 'web'), mobileLayout.surfaceLayout(390, 'web')],
    sectionGap: () => [mobileLayout.sectionGap('a', 'b'), mobileLayout.sectionGap('a', 'a'), mobileLayout.sectionGap('a')],
    crowdedTitleRow: () => [mobileLayout.crowdedTitleRow(360, 20, 8), mobileLayout.crowdedTitleRow(360, 4, 8)],
    glyphLine: () => [mobileLayout.glyphLine(360, 5, 6), mobileLayout.glyphLine(360, 6, 6), mobileLayout.glyphLine(390, 6, 6), mobileLayout.glyphLine(390, 5, 4), mobileLayout.glyphLine(200, 6, 6)],
    detailLayout: () => [visualModel.detailLayout(1400, false), visualModel.detailLayout(1900, false), visualModel.detailLayout(390, true)],
    dropdownPosition: () => [dropdownState.dropdownPosition({ x: 10, y: 500, width: 100, height: 30 }, { width: 390, height: 700 }, 12),
      dropdownState.dropdownPosition({ x: 300, y: 40, width: 80, height: 30 }, { width: 390, height: 700 }, 3)],
    cardDimensions: () => [swimlaneModel.cardDimensions(false), swimlaneModel.cardDimensions(true), swimlaneModel.cardDimensions(false, 1, true),
      swimlaneModel.cardDimensions(false, 1, false, true), swimlaneModel.cardDimensions(false, 1, false, 2, true, 1),
      swimlaneModel.cardDimensions(true, 1.5, true, swimlaneModel.LEAD_ROWS, true, 2), swimlaneModel.cardDimensions(false, 1, false, 0, false, 2, 2)],
    gridWidth: () => [swimlaneModel.gridWidth(), swimlaneModel.gridWidth(1), swimlaneModel.swimlaneWidth(3)],
    tableWidths: () => workflowModel.tableWidths([['단계', '요청'], ['아주 긴 단계 이름 하나', '두 번째'], ['x']], 600),
    chipLines: () => [workflowModel.chipLines('3건 진행 · 1건 대기', 104), workflowModel.chipLines('짧음', 220)],
    stageLabels: () => ['Not selected · withdrawn', 'Do (handed off)', 'My review?', 'Review · edit?', '브리프·원자료 파악', '검증·통합?', 'Pass?', '']
      .map(label => [workflowModel.labelWidth(label, 12.5), workflowModel.labelLineCount(label, 72, 70, 12.5), workflowModel.diamondSize(label, 82),
        workflowModel.diamondSize(label, 60)]),
    wrapWords: () => [workflowModel.wrapWords('요청 받기 다음 검토 후 반영 그리고 기록', 80, 12), workflowModel.wrapNote('규칙 충돌 1 · 버전 0.2.3', 60, 11)],
  };
}
/** Pure computations that read no size (status, signals, names, orders, workflows): once is enough. */
function unsized(): Record<string, () => unknown> {
  const stages = domain.builtinTemplate('ko').stages;
  return {
    leadStatus: () => [
      leadStatusModel.leadStatus({ members: [statusCard('a', { agentIds: ['w1'] }), statusCard('b', { agentIds: ['w2'], stageId: 'doing' }),
        statusCard('c', { agentIds: ['w3'], nextAction: '총괄 테스트 중 · 시작 11:40' })], own: [], stages, read: readBucket,
        lead: { id: 'lead-card' }, leadAgentIds: ['lead'], activeAt: '2026-10-16T02:58:00.000Z', now: NOW }),
      leadStatusModel.leadStatus({ members: [], own: [], stages, read: readBucket, lead: { id: 'lead-card' }, leadAgentIds: ['w2'],
        activeAt: '2026-10-15T20:00:00.000Z', now: NOW })],
    familyFit: () => [leadStatusModel.familyFit(fit => fit.length * 30, 100), leadStatusModel.familyFit(() => 500, 100)],
    deviceClock: () => [leadStatusModel.deviceClock('2026-10-16T02:40:00.000Z', NOW), leadStatusModel.deviceClock('2026-10-14T02:40:00.000Z', NOW)],
    signalBucket: () => [{ status: 'running' }, { status: 'idle', requiresAttention: true }, { status: 'idle', pendingPermissions: [1] },
      { status: 'error' }, { status: 'closed', archivedAt: '2026-10-15T00:00:00.000Z' }, null].map(agent => signalModel.signalBucket(agent)),
    summarizeSignals: () => [signalModel.summarizeSignals(Object.keys(buckets), readBucket), signalModel.countUrgentSignals(Object.keys(buckets), readBucket),
      signalModel.SIGNAL_BUCKETS.map(bucket => [signalModel.bucketRank(bucket), signalModel.hasSignalIcon(bucket), cardMeta.sidebarMark(bucket)])],
    modelNames: () => [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'codex', model: 'gpt-5.5-codex' }, { provider: 'opencode', model: 'x/y-1.2' },
      null].map(info => [cardMeta.modelShortName(info), cardMeta.modelDisplayName(info), cardMeta.agentModelName(info), cardMeta.assigneeName('agent-123456', info)]),
    elapsed: () => ['2026-10-16T02:59:30.000Z', '2026-10-16T01:00:00.000Z', '2026-10-13T03:00:00.000Z', null].map(since => cardMeta.elapsed(since, NOW)),
    orders: () => [orderModel.moveKey(['a', 'b', 'c', 'd'], 'c', 'up'), orderModel.moveKey(['a', 'b', 'c', 'd'], 'd', 'top'),
      orderModel.canMove(['a', 'b'], 'a', 'up'), ['d', 'a', 'x', 'b'].sort((a, b) => orderModel.compareByOrder(['b', 'a'], a, b)),
      orderModel.pinGroup(['x', 'a'], ['a', 'b', 'c'])],
    search: () => ['  Ｋａｎｂａｎ   보드 ', 'ÉCOLE', ''].map(text => filterModel.normalizeSearch(text)),
    workflows: () => templates.map(template => {
      const definition = workflowTemplates.builtinDefinition(template, 'en');
      return { id: template.id, preview: workflowTemplates.builtinPreview(template, 'ko'), stages: definition.stages.length,
        valid: workflow.workflowDefinitionSchema ? workflow.workflowDefinitionSchema.safeParse(definition).success : '[none]' };
    }),
    dwell: () => stages.map(stage => stageTime.dwellKind(stage.stageId, stages)),
    // REQ-149: the check up's four rules over one board — R1 (every agent archived), R2 at and past 7 days, R3 past 14, R4 a draft,
    // what is held elsewhere, the plan of a choice, the skip list and the reason lines in both languages.
    checkup: () => {
      const day = checkupModel.DAY_MS, ago = (days: number, ms = 0) => new Date(NOW - days * day - ms).toISOString();
      const cards = [statusCard('r1', { stageId: 'doing', agentIds: ['w2'], updatedAt: ago(1) }), statusCard('r2', { stageId: 'review', updatedAt: ago(7, 1), stageEnteredAt: ago(9) }),
        statusCard('edge', { stageId: 'doing', updatedAt: ago(7), stageEnteredAt: ago(7) }), statusCard('r3', { stageId: 'todo', updatedAt: ago(20), stageEnteredAt: ago(20) }),
        statusCard('r4', { stageId: 'todo', intent: 'draft', updatedAt: ago(15), createdAt: ago(15) }), statusCard('held', { stageId: 'doing', agentIds: ['w2'], blocked: true }),
        statusCard('quiet', { stageId: 'doing', agentIds: ['lead'], updatedAt: ago(10), stageEnteredAt: ago(10) })];
      const board = { summary: { id: 'board-1', revision: 'rev:1' }, stages: stages.map(stage => ({ ...stage, cards: cards.filter(card => card.stageId === stage.stageId) })) };
      const signals = { archived: (id: string) => id === 'w2', activity: (id: string) => id === 'lead' ? ago(8) : undefined, ready: true };
      const list = checkupModel.checkupCandidates([board], signals, NOW);
      const selected = new Set(list.map(c => c.key));
      const skips = checkupModel.addSkip({}, list[0]!, NOW);
      return { list, groups: checkupModel.checkupGroups(list).map(g => [g.rule, g.cards.length]), counts: checkupModel.selectionCounts(list, selected),
        done: checkupModel.checkupPlan(list, selected, 'done'), archive: checkupModel.checkupPlan(list, selected, 'archive').boards.map(b => checkupModel.operationsOf(b.cards)),
        skipped: checkupModel.withoutSkipped(list, skips, NOW).length, read: checkupModel.readSkips({ ok: skips[list[0]!.key], bad: 1 }),
        lines: (['ko', 'en'] as const).map(locale => list.map(c => checkupModel.checkupLine(c, 'paseo-kanban', id => 'Agent ' + id, i18n.copy(locale)))) };
    },
  };
}
function run(group: Record<string, () => unknown>): Json {
  const out: { [key: string]: Json } = {};
  for (const name of Object.keys(group)) out[name] = attempt(group[name]!);
  return out;
}

export default function compute(): Json {
  const scales: { [key: string]: Json } = {};
  for (const percent of [100, 80, 150]) {
    setUiScale(percent);
    scales[String(percent)] = { values: exportedValues(), computed: run(sized()) };
  }
  setUiScale(100);
  return { scales, unsized: run(unsized()) };
}
