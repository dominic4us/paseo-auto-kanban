import { displayStageNames } from './i18n.js';
import { builtinTemplate, type Locale } from '../shared/core/domain.js';
import { emptyBoardView } from '../shared/rpc.js';
import type { BoardDTO, BoardCardDTO, WorkspaceLabelsDTO } from '../shared/rpc.js';
import type { Directory } from './presentation.js';
import type { AgentModelInfo, SignalBucket } from './signal-model.js';
/**
 * Demo agents are reserved demo_* ids, so a real SDK event can never land on a demo card (and the
 * demo screen does not subscribe at all). `demo_agent_offline` is deliberately missing from the map
 * so one card shows the '확인 불가' signal.
 */
export const demoAgents = ['demo_agent_working', 'demo_agent_permission', 'demo_agent_error',
  'demo_agent_attention', 'demo_agent_idle', 'demo_agent_offline'] as const;
export const demoArchived = ['demo_agent_archived'];
/**
 * REQ-73: every way line two can name an agent — a `profile` label, a model only (Claude, OpenAI, Gemini), a
 * title only, nothing at all (the offline id) — and an auto card (REQ-61) whose agent carries the card's title.
 */
export const DEMO_AUTO_AGENT = 'demo_agent_auto';
export const DEMO_AUTO_TITLE = 'Tidy the release notes';
export const demoModels: Record<string, AgentModelInfo> = {
  demo_agent_working: { provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'high', title: 'Build the prototype', profile: '구현_Opus' },
  demo_agent_permission: { provider: 'claude', model: 'claude-sonnet-5', thinkingOptionId: 'high', title: 'Plan the review', profile: null },
  demo_agent_error: { provider: 'codex', model: 'gpt-6-astra', thinkingOptionId: 'high', title: 'Check the sort order', profile: '검증_Astra' },
  demo_agent_attention: { provider: 'gemini', model: 'gemini-3.5-flash', thinkingOptionId: null, title: 'Survey the samples', profile: null },
  demo_agent_idle: { provider: 'codex', model: null, thinkingOptionId: null, title: 'Archive the old notes', profile: null },
  demo_agent_archived: { provider: 'codex', model: 'gpt-6-sol', thinkingOptionId: 'high', title: 'First prototype', profile: '구현_Sol' },
  [DEMO_AUTO_AGENT]: { provider: 'claude', model: 'claude-haiku-4-5', thinkingOptionId: null, title: DEMO_AUTO_TITLE, profile: null },
};
/** Link labels are rare in real ledgers, so most demo links have none. */
export const demoAgentLabels: Record<string, string> = { demo_agent_working: 'Builder', demo_agent_error: 'Reviewer',
  demo_agent_archived: 'Former builder' };
export const demoSignals: Record<string, SignalBucket> = { demo_agent_working: 'working',
  demo_agent_permission: 'permission', demo_agent_error: 'error', demo_agent_attention: 'attention',
  demo_agent_archived: 'idle', demo_agent_idle: 'idle', [DEMO_AUTO_AGENT]: 'working' };
/** REQ-73: how long ago each demo card changed, so every age format shows up; minutes before `now`. */
const DEMO_AGES = [0, 3, 45, 180, 60 * 26, 60 * 24 * 3, 60 * 24 * 45];
/** A fixed clock keeps the demo identical from call to call; the screen passes the real one. */
export const DEMO_NOW = Date.parse('2026-01-20T12:00:00.000Z');
/** Every bucket appears, and every third card links three agents so "+N" is visible. */
function demoAgentIds(board: number, card: number) {
  if (board === 0 && card === 0) return { agentIds: ['demo_agent_archived'], agents: 1 };
  if (board === 1 && card === 0) return { agentIds: [DEMO_AUTO_AGENT], agents: 1 };
  const primary = demoAgents[(board + card) % demoAgents.length]!;
  const extra = card % 3 === 1
    ? [demoAgents[(board + card + 2) % demoAgents.length]!, demoAgents[(board + card + 4) % demoAgents.length]!] : [];
  return { agentIds: [primary, ...extra], agents: 1 + extra.length };
}
/**
 * REQ-57 ⑥: two of these workspaces have no board at all (index 3 inside a project that has cards, and
 * the whole of 'Pine Yard'), so the demo shows both the "card-less lane at the bottom of its project"
 * and the "project that is entirely new" cases.
 */
const EMPTY_WORKSPACES = new Set([3, 12]);
/** Deliberately non-ledger IDs: deterministic client memory, never accepted by a mutation. */
export function createDemoData(locale: Locale = 'en', now = DEMO_NOW) {
  const projects = ['Aurora Workshop', 'Harbor Atelier', 'Meadow Lab', 'Cedar Works', 'Lumen Studio', 'Pine Yard'];
  const sizes = [4, 3, 2, 2, 1, 1], directory: Directory = {}, boards: BoardDTO[] = [];
  const labels: WorkspaceLabelsDTO = { available: true, source: 'api', definitions: [
    { name: 'Explore', color: 'violet' }, { name: 'Prototype', color: 'sky' }, { name: 'Polish', color: 'emerald' },
  ], byWorkspace: {} };
  let index = 0;
  for (const [projectIndex, amount] of sizes.entries()) for (let local = 0; local < amount; local++, index++) {
    const workspaceId = 'demo_workspace_' + index, id = 'demo_board_' + index;
    const name = index === 2 ? '새로운 작업 흐름을 작은 실험으로 확인하고 결과를 정리하는 아주 긴 워크스페이스 이름'
      : amount === 1 ? projects[projectIndex]! : ['Discovery', 'Prototype review', 'Delivery plan', 'Follow-up'][local]!;
    const template0 = displayStageNames({ template: builtinTemplate(locale) }, locale).template;
    if (EMPTY_WORKSPACES.has(index)) {
      directory[workspaceId] = { id: workspaceId, name, projectId: 'demo_project_' + projectIndex,
        projectName: projects[projectIndex]!, projectViewKey: 'demo_project_' + projectIndex, labels: [] };
      labels.byWorkspace[workspaceId] = [];
      boards.push({ template: template0, agentLabels: {},
        summary: { id: emptyBoardView(workspaceId), workspaceId, cwd: 'demo://' + projectIndex + '/' + index,
          workspaceStatus: 'active', hasLedger: false, revision: '', updatedAt: '',
          progress: { done: 0, requested: 0, draft: 0, archived: 0, percent: null } },
        stages: template0.stages.map(stage => ({ ...stage, cards: [], hiddenCount: 0, totalCount: 0 })) });
      continue;
    }
    directory[workspaceId] = { id: workspaceId, name, projectId: 'demo_project_' + projectIndex,
      projectName: projects[projectIndex]!, projectViewKey: 'demo_project_' + projectIndex };
    labels.byWorkspace[workspaceId] = index % 3 === 0 ? ['Explore', 'Prototype'] : [labels.definitions[index % 3]!.name];
    directory[workspaceId]!.labels = labels.byWorkspace[workspaceId];
    const template = displayStageNames({ template: builtinTemplate(locale) }, locale).template, cards: BoardCardDTO[] = [];
    const count = index === 4 ? 0 : index === 5 ? 12 : 5 + index % 7;
    for (let n = 0; n < count; n++) {
      const draft = index !== 5 && n === 0 && index % 2 === 0;
      const stageId = index === 5 ? 'done' : draft ? 'todo' : template.stages[n % 4]!.stageId;
      cards.push({ id: 'demo_card_' + index + '_' + n,
        title: index === 1 && n === 0 ? DEMO_AUTO_TITLE : n === 1 ? '사용자에게 보여 줄 결과를 검토하고 긴 한글 제목이 두 줄에서 어떻게 보이는지 확인하기'
          : ['Sketch the workflow', 'Review sample results', 'Prepare a prototype', 'Check the delivery'][n % 4]! + ' ' + (n + 1),
        stageId, priority: n % 5 === 0 ? 'high' : n % 5 === 3 ? 'low' : 'normal', intent: draft ? 'draft' : 'requested',
        blocked: stageId !== 'done' && n === 2, awaiting: n % 3 === 0 ? 'user' : null,
        nextAction: n % 2 ? '검토 결과를 기록하고 다음 실험을 정하기' : '', ...demoAgentIds(index, n),
        completedAt: stageId === 'done' ? '2026-01-02T00:00:00.000Z' : null,
        updatedAt: new Date(now - DEMO_AGES[(index + n) % DEMO_AGES.length]! * 60000).toISOString(),
        // REQ-79: made one day apart, card 0 first, so "newest first" differs from both the ledger order and the last change.
        createdAt: new Date(Date.UTC(2026, 0, 1 + n)).toISOString() });
    }
    const requested = cards.filter(c => c.intent === 'requested').length, done = cards.filter(c => c.stageId === 'done').length;
    boards.push({ template, summary: { id, workspaceId, cwd: 'demo://' + projectIndex + '/' + index,
      workspaceStatus: 'active', revision: 'demo:1', updatedAt: '2026-01-' + String(20 - index).padStart(2, '0') + 'T00:00:00.000Z',
      progress: { done, requested, draft: cards.length - requested, archived: 0, percent: requested ? Math.floor(done * 100 / requested) : null } },
      agentLabels: demoAgentLabels,
      stages: template.stages.map(stage => ({ ...stage, cards: cards.filter(c => c.stageId === stage.stageId),
        hiddenCount: 0, totalCount: cards.filter(c => c.stageId === stage.stageId).length })) });
  }
  return { boards, directory, workspaceLabels: labels, locale };
}
/** REQ-57: demo ids are refused whether they name a board, a workspace or a not-yet-created board. */
export function mutationAllowed(preview: boolean, target: string): boolean {
  return !preview && !target.startsWith('demo_') && !target.startsWith('empty:demo_');
}
/**
 * REQ-69: the demo is for tests and headless checks, not for the people using Kanban. Its switch shows in the
 * settings only while this browser's storage holds `paseo-kanban:dev-demo` = '1' — set from the developer tools
 * or a headless script, then reload. Nothing in Paseo or Kanban writes it, so no menu or setting can turn the
 * demo on; native hosts have no such storage and never show it.
 */
export const DEV_DEMO_KEY = 'paseo-kanban:dev-demo';
export function devDemoEntry(): boolean {
  try { return (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage?.getItem(DEV_DEMO_KEY) === '1'; }
  catch { return false; }
}
