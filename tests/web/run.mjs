// REQ-79~81 headless browser runner: the real Kanban screen under react-native-web in Chromium, driven only by real
// input — Playwright mouse moves/presses, the keyboard (Tab, Enter, Escape) and taps. No onPress calls, no DOM click().
//
//   npm run build && npm run test:web            (or: node tests/web/run.mjs [output-dir])
//
// Needs tests/web/node_modules (react-native-web, react-dom, esbuild, playwright-core; see tests/web/package.json) and
// Playwright's Chromium in ~/.cache/ms-playwright. Where the system lacks Chromium's libraries, a shell file that exports
// LD_LIBRARY_PATH (and FONTCONFIG_FILE) is read first: $KANBAN_CHROMIUM_ENV, else spike/plugin-hello/scripts/chromium-env.sh
// when this checkout has it (the gates' local copy; spike/ is not in git). The page answers from a synthetic fixture built here with the real
// read model; nothing touches a ledger. Results: <output-dir>/result.json and screenshots. J4 (research/136): by default a
// fresh folder per run, _archive/test-web/<KST time>/ (outside git), so a run never overwrites an earlier gate's evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { applyOperations, builtinTemplate, summarizeBoard } from '../../dist/server/core/index.js';
import { dispatchMode, emptyGoneBoards, enteredOf, stageEntries, stageEntry, toBoardDTO, toOverview } from '../../dist/server/read-model.js';
import { judgeLead, readLeadEntry } from '../../dist/server/dispatch.js';
import { cardParents } from '../../dist/server/card-parents.js';
import { deviceClock } from '../../dist/client/lead-status.js';
import { copy } from '../../dist/client/i18n.js';
import { archivedDone } from '../../dist/shared/core/domain.js';
import { readWorkflow, WORKFLOW_LIMITS } from '../../dist/server/workflow.js';
import { exportDefinition } from '../../dist/server/workflow-export.js';
import { BUILTIN_WORKFLOWS } from '../../dist/shared/workflow-templates.js';
import { exportedDefinition } from '../../dist/server/handlers.js';
import { gateDefinition, gateFiles, otherDefinition, otherFiles, writeWorkspace } from '../fixtures/workflow-fixtures.mjs';
import { COUNT_BADGE, countBadge, PASEO_THEMES, palette, readable, crownColor, crownColors, medalColors, leaderOutline, selectedLine, selectedTint, hoverFill, contrast, markLine, replyColor, replyChip, viewedTint, fieldLine } from '../../dist/client/palette.js';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const stamp = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace(/:/g, '') + 'KST';
const out = path.resolve(process.argv[2] ?? path.join(root, '_archive/test-web', stamp));
fs.mkdirSync(out, { recursive: true });

// ---- fixture: two workspaces of one project; the "doing" column of the first holds four cards a day apart ----------
const actor = { kind: 'user' };
const T = day => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const newBoard = (n, workspaceId) => ({ schemaVersion: 1, id: 'board_' + String(n).repeat(64), workspaceId, cwd: '/tmp/' + workspaceId,
  workspaceStatus: 'active', template: builtinTemplate(), revision: `${crypto.randomUUID()}:1`, cards: [], history: [], receipts: [],
  createdAt: T(1), updatedAt: T(1) });
const ctx = now => ({ newId: () => crypto.randomUUID(), now: () => now });
const add = (title, stageId = 'doing') => ({ op: 'add', title, intent: 'requested', acceptanceCriteria: 'A reviewable result exists.', stageId });
let a = newBoard(1, 'wks_example01');
for (const [title, day] of [['Card one', 1], ['Card two', 2], ['Card three', 3], ['Card four', 4]]) a = applyOperations(a, [add(title)], actor, ctx(T(day))).board;
a = applyOperations(a, [add('Waiting card', 'todo')], actor, ctx(T(4))).board;
a = applyOperations(a, [{ op: 'update', id: a.cards.find(c => c.title === 'Card two').id, patch: { notes: 'Changed later' } }], actor, ctx(T(5))).board;
// REQ-76: a lead card in review with three sub-agent cards (one of them done). REQ-93: each sits in its own column — none
// in progress here, so the REQ-79 checks on this workspace's In progress column keep their four cards.
const LEAD = '00000000-0000-4000-8000-000000000001', SUBS = [2, 3, 4].map(n => '00000000-0000-4000-8000-00000000000' + n);
for (const [title, stageId, agentId] of [['Lead card', 'review', LEAD], ['Helper one', 'review', SUBS[0]], ['Helper two', 'todo', SUBS[1]],
  ['Helper done', 'done', SUBS[2]]]) {
  // A minute apart, so the default order (priority, then the oldest) is the order they were made in.
  const at = T(5).replace('00:00:00', '00:0' + a.cards.length + ':00');
  a = applyOperations(a, [add(title, stageId)], actor, ctx(at)).board;
  a = applyOperations(a, [{ op: 'link', id: a.cards.at(-1).id, agentId }], actor, ctx(at)).board;
}
const SUB_OF = cardParents(a, { agents: {}, parents: Object.fromEntries(SUBS.map(id => [id, { parentAgentId: LEAD }])) });
const cardId = title => a.cards.find(c => c.title === title).id;
let b = newBoard(2, 'wks_example02');
b = applyOperations(b, [add('Second board card')], actor, ctx(T(2))).board;
// REQ-92: the lane glyph shows only where a column leaves cards out, so this last lane's In progress has four (research/121 F1's glyph).
for (const n of ['two', 'three', 'four']) b = applyOperations(b, [add('Second board ' + n)], actor, ctx(T(2))).board;
// REQ-85 ⑥: a card whose title is cut to two lines, worked on by an agent the page lists (a state mark and a model).
const LONG = 'A long card title that runs well past two lines of the card so that its end is cut off and only a hint shows all of it';
const WORKER = '00000000-0000-4000-8000-0000000000a1';
b = applyOperations(b, [add(LONG, 'todo')], actor, ctx(T(3))).board;
b = applyOperations(b, [{ op: 'link', id: b.cards.at(-1).id, agentId: WORKER }], actor, ctx(T(3))).board;
const AGENTS = [{ id: WORKER, provider: 'claude', model: 'claude-opus-5-5', status: 'running', title: 'Worker', labels: {}, pendingPermissions: [],
  requiresAttention: false, attentionReason: null, archivedAt: null, cwd: '/tmp/wks_example02', workspaceId: 'wks_example02', createdAt: T(3), updatedAt: T(3), lastUserMessageAt: T(3) }];
const ORDERS = { default: ['Card one', 'Card two', 'Card three'], updated: ['Card two', 'Card four', 'Card three'], created: ['Card four', 'Card three', 'Card two'] };
const groupsOf = board => board === a ? SUB_OF : undefined;
const boardReply = board => ({ board: toBoardDTO(board, 'en', 'off', Date.now(), groupsOf(board)), revision: board.revision, locale: 'en', observedAt: T(6) });
// REQ-76 F1/H1: the same board with eleven more done sub-cards (twelve in all) whose parents the plugin remembers only
// after the screen's first read; `later` is what the server answers once it has (window.__remember()).
let late = a;
const LATE_SUBS = Array.from({ length: 11 }, (_, i) => '00000000-0000-4000-8000-0000000001' + String(i).padStart(2, '0'));
for (const [i, agentId] of LATE_SUBS.entries()) {
  const at = T(5).replace('00:00:00', '01:' + String(i).padStart(2, '0') + ':00');
  late = applyOperations(late, [add('Old helper ' + i, 'done')], actor, ctx(at)).board;
  late = applyOperations(late, [{ op: 'link', id: late.cards.at(-1).id, agentId }], actor, ctx(at)).board;
}
const LATE_OF = cardParents(late, { agents: {}, parents: Object.fromEntries([...SUBS, ...LATE_SUBS].map(id => [id, { parentAgentId: LEAD }])) });
const lateReads = parents => ({
  overview: { ...toOverview([late, b], 'en', T(6)), boardViews: [late, b].map(x => toBoardDTO(x, 'en', 'off', Date.now(), x === late ? parents : undefined)),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([late, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now(), x === late ? parents : undefined),
    revision: x.revision, locale: 'en', observedAt: T(6) }])) });
// REQ-89: the stable release's case — a lead card in review whose two sub-cards are in progress and one waits; nothing
// else of that workspace is in progress, so its In progress column read 0 and the phone's tab dropped the workspace.
let r = newBoard(3, 'wks_example01');
const R_SUBS = ['00000000-0000-4000-8000-0000000002a1', '00000000-0000-4000-8000-0000000002a2', '00000000-0000-4000-8000-0000000002a3'];
for (const [i, [title, stageId, agentId]] of [['Lead card', 'review', LEAD], ['Helper one', 'doing', R_SUBS[0]], ['Helper three', 'doing', R_SUBS[1]],
  ['Helper two', 'todo', R_SUBS[2]], ['Plain waiting', 'todo', null]].entries()) {
  const at = T(5).replace('00:00:00', '02:0' + i + ':00');
  r = applyOperations(r, [add(title, stageId)], actor, ctx(at)).board;
  if (agentId) r = applyOperations(r, [{ op: 'link', id: r.cards.at(-1).id, agentId }], actor, ctx(at)).board;
}
const R_OF = cardParents(r, { agents: {}, parents: Object.fromEntries(R_SUBS.map(id => [id, { parentAgentId: LEAD }])) });
const rId = title => r.cards.find(c => c.title === title).id;
const refReads = () => ({
  overview: { ...toOverview([r, b], 'en', T(6)), boardViews: [r, b].map(x => toBoardDTO(x, 'en', 'off', Date.now(), x === r ? R_OF : undefined)),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([r, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now(), x === r ? R_OF : undefined),
    revision: x.revision, locale: 'en', observedAt: T(6) }])) });
// REQ-95·96: a lead card with an automatic title in review among four plain ones (it is neither the oldest, the newest nor the
// highest), its sub-card at work, a card whose agent asks for a permission and a card waiting for a person with no agent.
// REQ-100: and a lead whose agent is archived, done with its sub-card (its crown filled and toned down).
let q = newBoard(4, 'wks_example01');
const Q_LEAD = '00000000-0000-4000-8000-0000000003a1', Q_SUB = '00000000-0000-4000-8000-0000000003a2', Q_ASK = '00000000-0000-4000-8000-0000000003a3';
const Q_TITLE = '총괄-03_example-app_Opus';
const Q_OLD = '00000000-0000-4000-8000-0000000003b1', Q_OLD_SUB = '00000000-0000-4000-8000-0000000003b2';
// REQ-103: criteria as a checklist — all ticked on "Old high", two of three on "Plain review", one of two on the done "Old helper".
const Q_CRITERIA = { all: '- [x] Draft written\n- [x] Links checked\n- [X] Owner reviewed', some: 'Scope: the sample only.\n- [x] Draft written\n- [x] Links checked\n- [ ] Owner reviewed',
  unmet: '- [x] Result recorded\n- [ ] Owner confirmed' };
for (const [title, stageId, day, extra, agentId] of [['Old high', 'review', 1, { priority: 'high', acceptanceCriteria: Q_CRITERIA.all }],
  ['Plain review', 'review', 2, { acceptanceCriteria: Q_CRITERIA.some }],
  [Q_TITLE, 'review', 3, { priority: 'low' }, Q_LEAD], ['Newest review', 'review', 5, {}], ['Sub worker', 'doing', 3, {}, Q_SUB],
  ['Asking card', 'doing', 4, {}, Q_ASK], ['Waiting on you', 'todo', 4, { awaiting: 'user' }], ['Old lead', 'done', 2, {}, Q_OLD],
  ['Old helper', 'done', 2, { acceptanceCriteria: Q_CRITERIA.unmet }, Q_OLD_SUB]]) {
  q = applyOperations(q, [{ ...add(title, stageId), ...extra }], actor, ctx(T(day))).board;
  if (agentId) q = applyOperations(q, [{ op: 'link', id: q.cards.at(-1).id, agentId }], actor, ctx(T(day))).board;
}
const Q_OF = cardParents(q, { agents: {}, parents: { [Q_SUB]: { parentAgentId: Q_LEAD }, [Q_OLD_SUB]: { parentAgentId: Q_OLD } } });
const qId = title => q.cards.find(c => c.title === title).id;
const Q_AGENTS = [[Q_LEAD, []], [Q_SUB, []], [Q_ASK, [{ id: 'perm' }]]].map(([id, pendingPermissions]) => ({ ...AGENTS[0], id, title: 'Agent',
  pendingPermissions, cwd: '/tmp/wks_example01', workspaceId: 'wks_example01' })).concat([Q_OLD, Q_OLD_SUB].map(id => ({ ...AGENTS[0], id, title: 'Agent', status: 'idle',
  archivedAt: T(3), cwd: '/tmp/wks_example01', workspaceId: 'wks_example01' })));
const leadReads = () => ({ agents: [...AGENTS, ...Q_AGENTS],
  overview: { ...toOverview([q, b], 'en', T(6)), boardViews: [q, b].map(x => toBoardDTO(x, 'en', 'off', Date.now(), x === q ? Q_OF : undefined)),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([q, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now(), x === q ? Q_OF : undefined),
    revision: x.revision, locale: 'en', observedAt: T(6) }])) });
// REQ-104: a lead in review whose sub-card runs, one sub-card waits for you, and whose own check card ("총괄 확인", its own
// agent) is in progress, started ten minutes ago; and a quiet lead, its sub-card done, last active twenty minutes ago.
// research/166 J3: a busy lead too — its sub-card done, its own agent at work, last active twenty minutes ago.
// D43: an asking lead — its sub-card done, its own agent waiting on a question it put to you (AskUserQuestion).
let st = newBoard(5, 'wks_example01');
const S_LEAD = '00000000-0000-4000-8000-0000000004a1', S_RUN = '00000000-0000-4000-8000-0000000004a2', S_ASK = '00000000-0000-4000-8000-0000000004a3';
const S_IDLE = '00000000-0000-4000-8000-0000000004b1', S_IDLE_SUB = '00000000-0000-4000-8000-0000000004b2';
const S_BUSY = '00000000-0000-4000-8000-0000000004c1', S_BUSY_SUB = '00000000-0000-4000-8000-0000000004c2';
const S_QUESTION = '00000000-0000-4000-8000-0000000004d1', S_QUESTION_SUB = '00000000-0000-4000-8000-0000000004d2';
// Gate 167: the expected "HH:MM" (or "MM-DD HH:MM" once the check started before today, KST) is worked out when it is
// checked, against the clock the page reads then — a run that crosses midnight after this file loaded still agrees.
const S_TITLE = '총괄-05_example-app_Opus', S_NOW = Date.now(), S_CHECK = () => deviceClock(S_NOW - 10 * 60000, Date.now());
const S_ACTIVE = new Date(S_NOW - 20 * 60000).toISOString();
for (const [title, stageId, extra, agentId, at] of [[S_TITLE, 'review', {}, S_LEAD, T(3)], ['Runner', 'doing', {}, S_RUN, T(3)],
  ['Asker', 'todo', { awaiting: 'user', nextAction: 'Choose the layout' }, S_ASK, T(3)], ['Plain card', 'todo', {}, null, T(3)],
  ['총괄 확인 — tests', 'doing', { nextAction: '총괄 테스트 중 · 시작 ' + new Date(S_NOW - 10 * 60000 + 9 * 3600_000).toISOString().slice(11, 16) + ' · 예상 +30분' }, S_LEAD, new Date(S_NOW).toISOString()],
  ['Quiet lead', 'review', {}, S_IDLE, T(4)], ['Quiet helper', 'done', {}, S_IDLE_SUB, T(4)],
  ['Busy lead', 'review', {}, S_BUSY, T(4)], ['Busy helper', 'done', {}, S_BUSY_SUB, T(4)],
  ['Asking lead', 'doing', {}, S_QUESTION, T(4)], ['Asking helper', 'done', {}, S_QUESTION_SUB, T(4)]]) {
  st = applyOperations(st, [{ ...add(title, stageId), ...extra }], actor, ctx(at)).board;
  if (agentId) st = applyOperations(st, [{ op: 'link', id: st.cards.at(-1).id, agentId }], actor, ctx(at)).board;
}
const S_OF = cardParents(st, { agents: {}, parents: { [S_RUN]: { parentAgentId: S_LEAD }, [S_ASK]: { parentAgentId: S_LEAD },
  [S_IDLE_SUB]: { parentAgentId: S_IDLE }, [S_BUSY_SUB]: { parentAgentId: S_BUSY }, [S_QUESTION_SUB]: { parentAgentId: S_QUESTION } } });
const S_AGENTS = [[S_LEAD, 'idle'], [S_RUN, 'running'], [S_ASK, 'idle'], [S_IDLE, 'idle'], [S_IDLE_SUB, 'idle'], [S_BUSY, 'running'], [S_BUSY_SUB, 'idle'],
  [S_QUESTION, 'running', [{ id: 'q', kind: 'question' }]], [S_QUESTION_SUB, 'idle']].map(([id, status, pendingPermissions = []]) =>
  ({ ...AGENTS[0], id, title: 'Agent', status, pendingPermissions, cwd: '/tmp/wks_example01', updatedAt: S_ACTIVE, lastActivityAt: S_ACTIVE }));
const statusReads = () => ({ agents: [...AGENTS, ...S_AGENTS],
  overview: { ...toOverview([st, b], 'en', T(6)), boardViews: [st, b].map(x => toBoardDTO(x, 'en', 'off', Date.now(), x === st ? S_OF : undefined)),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([st, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now(), x === st ? S_OF : undefined),
    revision: x.revision, locale: 'en', observedAt: T(6) }])) });
// REQ-86: cards a set time into their column (made oldest first: the ledger's clock never runs back) — in review 14h (past
// 12h) and 3h; in progress 5h with its agent at work, 3h with its agent finished 2.5h ago (past 2h) and half an hour; waiting
// (one of them waits for you) and done 20h.
let dw = newBoard(6, 'wks_example01');
const D_NOW = Date.now(), D_AGO = hours => new Date(D_NOW - hours * 3600_000).toISOString();
const D_BUSY = '00000000-0000-4000-8000-0000000006a1', D_STALL = '00000000-0000-4000-8000-0000000006a2';
for (const [title, stageId, hours, agentId, extra] of [['Old waiting', 'todo', 20], ['Finished card', 'done', 20], ['Review for long', 'review', 14],
  ['Busy work', 'doing', 5, D_BUSY], ['Review short', 'review', 3], ['Stalled work', 'doing', 3, D_STALL],
  ['Asks you', 'todo', 1, null, { awaiting: 'user', nextAction: 'Choose the layout' }], ['Fresh work', 'doing', .5]]) {
  dw = applyOperations(dw, [{ ...add(title, stageId), ...(extra ?? {}) }], actor, ctx(D_AGO(hours))).board;
  if (agentId) dw = applyOperations(dw, [{ op: 'link', id: dw.cards.at(-1).id, agentId }], actor, ctx(D_AGO(hours))).board;
}
const D_AGENTS = [[D_BUSY, 'running', D_AGO(.1)], [D_STALL, 'idle', D_AGO(2.5)]].map(([id, status, at]) =>
  ({ ...AGENTS[0], id, title: 'Agent', status, cwd: '/tmp/wks_example01', updatedAt: at, lastActivityAt: at }));
const dwellReads = () => ({ agents: [...AGENTS, ...D_AGENTS],
  overview: { ...toOverview([dw, b], 'en', T(6)), boardViews: [dw, b].map(x => toBoardDTO(x, 'en', 'off', Date.now())),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([dw, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now()), revision: x.revision, locale: 'en', observedAt: T(6) }])) });
// REQ-84: busy marks (`kanban card busy`, the plugin's busy.json) on a board made when its page is written, so the times are
// exact: in progress 3h each — one marked 12 minutes ago (REQ-86's 2h warning stays quiet), one 2.5h ago (over 2h: orange,
// needs a person), one unmarked (warns as before) — and a lead in review whose sub-card was marked 30 minutes ago.
const U_LEAD = '00000000-0000-4000-8000-0000000007a1', U_SUB = '00000000-0000-4000-8000-0000000007a2';
const U_AGENTS = [U_LEAD, U_SUB].map(id => ({ ...AGENTS[0], id, title: 'Agent', status: 'idle', cwd: '/tmp/wks_example01' }));
let U_SINCE = '';
const busyReads = () => {
  const now = Date.now(), at = hours => new Date(now - hours * 3600_000).toISOString();
  let u = newBoard(7, 'wks_example01');
  for (const [title, stageId, agentId] of [['Lead-07', 'review', U_LEAD], ['Sub check', 'todo', U_SUB], ['Test run', 'doing'], ['Long build', 'doing'],
    ['Plain work', 'doing']]) {
    u = applyOperations(u, [add(title, stageId)], actor, ctx(at(3))).board;
    if (agentId) u = applyOperations(u, [{ op: 'link', id: u.cards.at(-1).id, agentId }], actor, ctx(at(3))).board;
  }
  const id = title => u.cards.find(c => c.title === title).id;
  U_SINCE = at(.5);
  const marks = new Map([[id('Test run'), { text: 'Testing', since: at(.2), by: 'cli' }], [id('Long build'), { text: 'Build', since: at(2.5), by: 'reviewer' }],
    [id('Sub check'), { text: 'Checking', since: U_SINCE, by: U_LEAD }]]);
  const parents = cardParents(u, { agents: {}, parents: { [U_SUB]: { parentAgentId: U_LEAD } } });
  const view = x => toBoardDTO(x, 'en', 'off', now, x === u ? parents : undefined, x === u ? marks : undefined);
  return { agents: [...AGENTS, ...U_AGENTS],
    overview: { ...toOverview([u, b], 'en', new Date(now).toISOString(), boardId => boardId === u.id ? marks : undefined), boardViews: [u, b].map(view),
      removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries([u, b].map(x => [x.id, { board: view(x), revision: x.revision, locale: 'en', observedAt: T(6) }])),
    cards: { ...cardReads(), ...Object.fromEntries(u.cards.map(card => [card.id, { boardId: u.id, revision: u.revision, card, template: u.template,
      history: u.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(u), card)), busy: marks.get(card.id) ?? null }])) } };
};
// REQ-130 (research/260 C): a board of three leads in review — at work (its sub-card running too, its memo on), your turn (its
// sub-card waiting for you) and resting (its sub-card running) — and a plain card with a CLI busy mark (REQ-84 as it was).
// `req130-<locale>-<width>`: the language the board reads in and the window width. Made-up names only.
const R_IDS = Object.fromEntries(['work', 'workSub', 'turn', 'turnSub', 'rest', 'restSub', 'plain']
  .map((key, i) => [key, '00000000-0000-4000-8000-0000000013' + String(i).padStart(2, '0')]));
let R_NOW = 0;
const R_AGENT = (id, extra = {}) => ({ ...AGENTS[0], id, title: 'Agent', status: 'idle', cwd: '/tmp/wks_example01', ...extra });
const req130Reads = key => {
  const [locale, width] = key.split('-'), now = R_NOW = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  let r = newBoard('f', 'wks_example01');
  for (const [title, stageId, agentId, extra] of [['Release lead', 'review', R_IDS.work], ['Payment fix', 'doing', R_IDS.workSub],
    ['Review lead', 'review', R_IDS.turn], ['Copy edit', 'todo', R_IDS.turnSub, { awaiting: 'user', nextAction: 'Pick the wording' }],
    ['Quiet lead', 'review', R_IDS.rest], ['Image swap', 'doing', R_IDS.restSub], ['Nightly build', 'doing', R_IDS.plain]]) {
    r = applyOperations(r, [{ ...add(title, stageId), ...(extra ?? {}) }], actor, ctx(ago(90))).board;
    r = applyOperations(r, [{ op: 'link', id: r.cards.at(-1).id, agentId }], actor, ctx(ago(90))).board;
  }
  const id = title => r.cards.find(c => c.title === title).id;
  const marks = new Map([[id('Release lead'), { text: locale === 'ko' ? '출시 전 시험' : 'Release tests', since: ago(0), by: 'screen' }],
    [id('Nightly build'), { text: 'Build', since: ago(20), by: 'cli' }]]);
  const parents = cardParents(r, { agents: {}, parents: { [R_IDS.workSub]: { parentAgentId: R_IDS.work }, [R_IDS.turnSub]: { parentAgentId: R_IDS.turn },
    [R_IDS.restSub]: { parentAgentId: R_IDS.rest } } });
  const view = x => toBoardDTO(x, locale, 'off', now, x === r ? parents : undefined, x === r ? marks : undefined);
  const agents = [R_AGENT(R_IDS.work, { lastActivityAt: ago(30), updatedAt: ago(30) }), R_AGENT(R_IDS.workSub, { status: 'running' }),
    R_AGENT(R_IDS.turn, { status: 'running', lastActivityAt: ago(1), updatedAt: ago(1) }), R_AGENT(R_IDS.turnSub),
    R_AGENT(R_IDS.rest, { lastActivityAt: ago(48), updatedAt: ago(48) }), R_AGENT(R_IDS.restSub, { status: 'running' }), R_AGENT(R_IDS.plain)];
  return { width: Number(width), agents: [...AGENTS, ...agents], cardLocale: locale,
    overview: { ...toOverview([r], locale, new Date(now).toISOString(), boardId => boardId === r.id ? marks : undefined), boardViews: [r].map(view),
      removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: { [r.id]: { board: view(r), revision: r.revision, locale, observedAt: new Date(now).toISOString() } },
    cards: Object.fromEntries(r.cards.map(card => [card.id, { boardId: r.id, revision: r.revision, card, template: r.template,
      history: r.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(r), card)), busy: marks.get(card.id) ?? null }])) };
};
// REQ-133 (research/264 J7·J1·J3): five leads in review, one in each state — at work (its turn begun 12 minutes ago, its
// sub-card running), asking you (3 minutes), its turn not looked at (7 minutes, its sub-card waiting for you), stopped on an
// error (4 minutes; the card itself waits for you, so the list has it) and resting (its sub-card running). The times are the
// host's own (`activeTurn.startedAt`, `attentionTimestamp`), already there when the screen opens. Made-up names only.
const R3_IDS = Object.fromEntries(['work', 'workSub', 'ask', 'askSub', 'look', 'lookSub', 'fail', 'failSub', 'rest', 'restSub']
  .map((key, i) => [key, '00000000-0000-4000-8000-0000000133' + String(i).padStart(2, '0')]));
/** The column (a phone's tab) each lead is in. */
const R3_TAB = { 'Release lead': 'doing', 'Question lead': 'doing', 'Review lead': 'review', 'Broken lead': 'review', 'Quiet lead': 'review' };
let R3_NOW = 0;
const req133Reads = key => {
  const [locale] = key.split('-'), now = R3_NOW = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  let r = newBoard('e', 'wks_example01');
  // A column shows three cards: two leads in progress, three in review, their sub-cards to do.
  for (const [title, stageId, agentId, extra] of [['Release lead', 'doing', R3_IDS.work], ['Payment fix', 'doing', R3_IDS.workSub],
    ['Question lead', 'doing', R3_IDS.ask], ['Doc pass', 'todo', R3_IDS.askSub],
    ['Review lead', 'review', R3_IDS.look], ['Copy edit', 'todo', R3_IDS.lookSub, { awaiting: 'user', nextAction: 'Pick the wording' }],
    ['Broken lead', 'review', R3_IDS.fail, { awaiting: 'user', nextAction: 'Read the error' }], ['Retry job', 'todo', R3_IDS.failSub],
    ['Quiet lead', 'review', R3_IDS.rest], ['Image swap', 'todo', R3_IDS.restSub]]) {
    r = applyOperations(r, [{ ...add(title, stageId), ...(extra ?? {}) }], actor, ctx(ago(90))).board;
    r = applyOperations(r, [{ op: 'link', id: r.cards.at(-1).id, agentId }], actor, ctx(ago(90))).board;
  }
  const parents = cardParents(r, { agents: {}, parents: Object.fromEntries(['work', 'ask', 'look', 'fail', 'rest'].map(k => [R3_IDS[k + 'Sub'], { parentAgentId: R3_IDS[k] }])) });
  const view = x => toBoardDTO(x, locale, 'off', now, x === r ? parents : undefined);
  const agents = [
    R_AGENT(R3_IDS.work, { status: 'running', activeTurn: { turnId: 't1', startedAt: ago(12) }, lastActivityAt: ago(0), updatedAt: ago(0) }),
    R_AGENT(R3_IDS.workSub, { status: 'running' }),
    R_AGENT(R3_IDS.ask, { status: 'running', activeTurn: { turnId: 't2', startedAt: ago(20) }, pendingPermissions: [{ requestId: 'q1' }],
      requiresAttention: true, attentionReason: 'permission', attentionTimestamp: ago(3), lastActivityAt: ago(3), updatedAt: ago(3) }),
    R_AGENT(R3_IDS.askSub),
    R_AGENT(R3_IDS.look, { requiresAttention: true, attentionReason: 'finished', attentionTimestamp: ago(7), lastActivityAt: ago(7), updatedAt: ago(7) }),
    R_AGENT(R3_IDS.lookSub),
    R_AGENT(R3_IDS.fail, { status: 'error', requiresAttention: true, attentionReason: 'error', attentionTimestamp: ago(4), lastActivityAt: ago(4), updatedAt: ago(4) }),
    R_AGENT(R3_IDS.failSub),
    R_AGENT(R3_IDS.rest, { lastActivityAt: ago(48), updatedAt: ago(48) }), R_AGENT(R3_IDS.restSub, { status: 'running' })];
  return { agents: [...AGENTS, ...agents], cardLocale: locale,
    overview: { ...toOverview([r], locale, new Date(now).toISOString()), boardViews: [r].map(view),
      removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: { [r.id]: { board: view(r), revision: r.revision, locale, observedAt: new Date(now).toISOString() } },
    cards: Object.fromEntries(r.cards.map(card => [card.id, { boardId: r.id, revision: r.revision, card, template: r.template,
      history: r.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(r), card)), busy: null }])) };
};
// REQ-135: five leads, one in each of their own states, with their sub-cards' parts on the family line — at work with every
// part (a sub-card running, one waiting for you, one under a busy mark: "Sub-cards 3 · Running 1 · not done 3 · Awaiting you 1
// · Testing HH:MM~", too long for a 264px card), asking you (a sub-card running), its turn not looked at (a sub-card waiting for
// you), stopped on an error (a sub-card's check) and resting (nothing). D51: a second workspace with a long made-up folder name,
// so its To Do "+" says a tip longer than a tip's widest. `req135-<locale>`. Made-up names only.
const R5_IDS = Object.fromEntries(['full', 'fullRun', 'fullWait', 'fullTest', 'ask', 'askSub', 'look', 'lookSub', 'fail', 'failSub', 'rest', 'restSub']
  .map((key, i) => [key, '00000000-0000-4000-8000-0000000135' + String(i).padStart(2, '0')]));
const R5_TAB = { 'Full lead': 'doing', 'Ask lead': 'doing', 'Look lead': 'review', 'Broken lead': 'review', 'Quiet lead': 'review' };
const R5_LONG = 'wks_example_tooltip_wrapping_check_with_a_long_folder_name_02';
let R5_NOW = 0;
const req135Reads = key => {
  const [locale] = key.split('-'), now = R5_NOW = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  let r = newBoard('a', 'wks_example01'), w = newBoard('b', R5_LONG);
  for (const [title, stageId, agentId, extra] of [['Full lead', 'doing', R5_IDS.full], ['Build step', 'todo', R5_IDS.fullRun],
    ['Pick copy', 'todo', R5_IDS.fullWait, { awaiting: 'user', nextAction: 'Pick the wording' }], ['Check run', 'todo', R5_IDS.fullTest],
    ['Ask lead', 'doing', R5_IDS.ask], ['Doc pass', 'todo', R5_IDS.askSub],
    ['Look lead', 'review', R5_IDS.look], ['Copy edit', 'todo', R5_IDS.lookSub, { awaiting: 'user', nextAction: 'Pick the wording' }],
    ['Broken lead', 'review', R5_IDS.fail], ['Retry job', 'todo', R5_IDS.failSub],
    ['Quiet lead', 'review', R5_IDS.rest], ['Image swap', 'todo', R5_IDS.restSub]]) {
    r = applyOperations(r, [{ ...add(title, stageId), ...(extra ?? {}) }], actor, ctx(ago(90))).board;
    r = applyOperations(r, [{ op: 'link', id: r.cards.at(-1).id, agentId }], actor, ctx(ago(90))).board;
  }
  for (const title of ['Long one', 'Long two']) w = applyOperations(w, [add(title, 'todo')], actor, ctx(ago(90))).board;
  const id = title => r.cards.find(c => c.title === title).id;
  const marks = new Map([[id('Check run'), { text: 'Tests', since: ago(10), by: 'cli' }], [id('Retry job'), { text: 'Tests', since: ago(6), by: 'cli' }]]);
  const parents = cardParents(r, { agents: {}, parents: Object.fromEntries([['fullRun', 'full'], ['fullWait', 'full'], ['fullTest', 'full'], ['askSub', 'ask'],
    ['lookSub', 'look'], ['failSub', 'fail'], ['restSub', 'rest']].map(([sub, lead]) => [R5_IDS[sub], { parentAgentId: R5_IDS[lead] }])) });
  const view = x => toBoardDTO(x, locale, 'off', now, x === r ? parents : undefined, x === r ? marks : undefined);
  const agents = [
    R_AGENT(R5_IDS.full, { status: 'running', activeTurn: { turnId: 't1', startedAt: ago(12) }, lastActivityAt: ago(0), updatedAt: ago(0) }),
    R_AGENT(R5_IDS.fullRun, { status: 'running' }), R_AGENT(R5_IDS.fullWait), R_AGENT(R5_IDS.fullTest),
    R_AGENT(R5_IDS.ask, { status: 'running', activeTurn: { turnId: 't2', startedAt: ago(20) }, pendingPermissions: [{ requestId: 'q1' }],
      requiresAttention: true, attentionReason: 'permission', attentionTimestamp: ago(3), lastActivityAt: ago(3), updatedAt: ago(3) }),
    R_AGENT(R5_IDS.askSub, { status: 'running' }),
    R_AGENT(R5_IDS.look, { requiresAttention: true, attentionReason: 'finished', attentionTimestamp: ago(7), lastActivityAt: ago(7), updatedAt: ago(7) }),
    R_AGENT(R5_IDS.lookSub),
    R_AGENT(R5_IDS.fail, { status: 'error', requiresAttention: true, attentionReason: 'error', attentionTimestamp: ago(4), lastActivityAt: ago(4), updatedAt: ago(4) }),
    R_AGENT(R5_IDS.failSub),
    R_AGENT(R5_IDS.rest, { lastActivityAt: ago(48), updatedAt: ago(48) }), R_AGENT(R5_IDS.restSub)];
  return { agents: [...AGENTS, ...agents], cardLocale: locale,
    overview: { ...toOverview([r, w], locale, new Date(now).toISOString(), boardId => boardId === r.id ? marks : undefined), boardViews: [r, w].map(view),
      removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries([r, w].map(x => [x.id, { board: view(x), revision: x.revision, locale, observedAt: new Date(now).toISOString() }])),
    cards: Object.fromEntries([r, w].flatMap(x => x.cards.map(card => [card.id, { boardId: x.id, revision: x.revision, card, template: x.template,
      history: x.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(x), card)), busy: marks.get(card.id) ?? null }]))) };
};
// REQ-90: the lab's "messages waiting" badge, on for this host, in Korean (the words the user reads). The server's reading of the
// message folder is given as it would answer: two open threads waiting for the first workspace's short name (its folder's
// last name, "wks_example01"), one for the second, a person's turn relayed for the first (not counted) and one whose newest
// file has no "받는 곳:" line. Made-up names only.
const MAIL_DIR = '/data/example-mail';
const mailThread = (thread, file, to) => ({ thread, file: MAIL_DIR + '/' + thread + '/' + file, ...(to === undefined ? {} : { to }) });
const MAIL = { key: 'mailkey000000001', threads: [mailThread('20260928-0900_wsB_one', '20260928-0910_wsB_회신.md', 'wks_example01'),
  mailThread('20260928-0901_wsB_two', '20260928-0901_wsB_요청.md', 'wks_example01'),
  mailThread('20260928-0902_wsB_person', '20260928-0902_wsB_요청.md', '사람 (기록: wks_example01)'),
  mailThread('20260928-0903_wsA_three', '20260928-0903_wsA_요청.md', 'wks_example02')],
  unknown: [mailThread('20260928-0904_wsB_odd', '20260928-0904_wsB_요청.md')] };
// research/179 D1: three threads each, with the long file names a real folder has, so a phone's 300px tip runs to about 260px —
// past the first lane's short To do column into the next lane, and too tall to hang below the second lane near the bottom.
const LONG_MAIL = n => `20260928-1${n}00_wsB_long_example_thread_about_a_review_${n}`;
const MAIL_TALL = { key: 'mailkey000000002', threads: [1, 2, 3, 4, 5, 6].map(n => mailThread(LONG_MAIL(n),
  `20260928-1${n}10_wsB_회신_long_example_file_name_${n}.md`, n <= 3 ? 'wks_example01' : 'wks_example02')), unknown: MAIL.unknown };
// REQ-134: `locale` for the phone's message list in English; `mailDir` empty for the lab on with no folder (no glyph).
const mailReads = (mail = MAIL, locale = 'ko', mailDir = MAIL_DIR) => ({ ui: { hiddenProjects: [], order: { projects: [], workspaces: [] }, settings: { labs: { mail: true, mailDir } } },
  overview: { ...toOverview([a, b], locale, T(6)), boardViews: [a, b].map(x => toBoardDTO(x, locale, 'off', Date.now(), groupsOf(x))), removedIds: [],
    workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} }, mail },
  boards: Object.fromEntries([a, b].map(x => [x.id, { board: toBoardDTO(x, locale, 'off', Date.now(), groupsOf(x)), revision: x.revision, locale, observedAt: T(6) }])) });
// REQ-128: the lab's message list over a made-up message folder, as the server would read it (dates relative to now): two
// waiting for a person "검토자" (one recorded for wks_example01), two left waiting (a due date passed, 7 days), an open one, two
// newest files at one time, and four closed. Paseo lists the two example workspaces with their folders (their short names) and
// two quiet ones (no thread: shown faded). Made-up names only.
const M128_DIR = '/data/example-mail';
/** `long` (research/236 D4): one more thread between two workspaces with long folder names (made up). */
const M128_LONG = ['보낸곳이매우길고여러팀이함께쓰는워크스페이스이름', '받는곳도매우길고여러팀이함께쓰는워크스페이스이름'];
function mail128Reads(long = false, locale = 'ko') {
  const now = Date.now(), DAY = 86_400_000, H = 3600e3, P = '검토자';
  const at = ms => new Date(ms + 9 * H).toISOString().slice(0, 16).replace('T', ' ');
  const stamp = ms => at(ms).replace(/[-:]/g, '').replace(' ', '-'), day = ms => at(ms).slice(0, 10);
  const f = (ms, from, kind, to, title, due = null) => ({ name: stamp(ms) + '_' + from + '_' + kind + '.md', at: at(ms), from, kind, title: kind + ' — ' + title, to, due });
  const t = (ms, from, topic, subject, files, latest) => ({ id: stamp(ms) + '_' + from + '_' + topic, subject, files, latest });
  const threads = [
    t(now - 3 * DAY, 'wsA', '시험정리', '게이트 시험용 워크스페이스 정리 + 절차에 정리 단계', 4, [f(now - 3 * H, 'wks_example01', '재질의', `${P} (기록: wsA)`, '남은 워크스페이스 1개 보관 시점', day(now))]),
    t(now - 6 * DAY, 'wks_example01', '실험실', '칸반 "실험실"(기본 꺼짐) + 교신 도착 표시', 2, [f(now - 4 * DAY, 'wks_example01', '회신', `${P} (기록: wks_example01)`, '표시 완료, 켤지 정해 주세요')]),
    t(now - 9 * DAY, 'wks_example01', '이름규칙', '스킬 1장: 총괄이 이름 바꿀 때 라벨도 붙이기', 1, [f(now - 8 * DAY + 2 * H, 'wks_example01', '요청', 'wsA', '이름 규칙 반영', day(now - DAY))]),
    t(now - 11 * DAY, 'wsA', '작업단위', '작업 단위: 구현은 작게, 검증·배포·화면 확인은 묶어서', 2, [f(now - 9 * DAY, 'wks_example01', '회신', 'wsA', '반영했습니다')]),
    t(now - DAY, 'wsA', '설정검토', '프로젝트 설정 파일 채우기 검토', 1, [f(now - 2 * H, 'wsA', '요청', 'wks_example02', '설정 검토')]),
    t(now - 2 * DAY, 'ws_c', '시안비교', '로고 시안 두 장 비교', 3, [f(now - 40 * 60e3, 'ws_c', '회신', 'wks_example01', '시안 B 추천'), f(now - 40 * 60e3, 'wks_example02', '질문', 'ws_c', '크기 기준')]),
    t(now - 5 * DAY, 'wks_example01', '누락방지', '오케스트레이터 스킬 반영 — 완료 알림 누락 방지 + 미반영 2건', 3, [f(now - 4 * DAY, 'wks_example01', '종결', '없음', '닫음')]),
    t(now - 3 * DAY, 'wks_example02', '이름변경', '개인 스킬 이름 변경(접두어)', 2, [f(now - 2 * DAY, 'wks_example02', '종결', '없음', '닫음')]),
    t(now - 12 * DAY, 'wsA', '정렬', '보드 정렬 기본값', 2, [f(now - 10 * DAY, 'wsA', '종결', '없음', '닫음')]),
    t(now - 14 * DAY, 'wsA', '머리폭', '휴대폰 머리 줄 폭', 2, [f(now - 13 * DAY, 'wsA', '종결', '없음', '닫음')]),
    ...(long ? [t(now - DAY, M128_LONG[0], '긴이름', '긴 이름끼리', 1, [f(now - 3 * H, M128_LONG[0], '요청', M128_LONG[1], '긴 이름')])] : []),
  ];
  const head = (file, from, body) => ({ ...file, head: ['# ' + file.title, `스레드: x · 보낸 곳: ${from} (총괄-07) · ${file.kind} · ${file.at} KST`, '받는 곳: ' + file.to,
    '기한: ' + (file.due ?? '없음'), '승인: 해당없음'], excerpt: body });
  const first = threads[0], tie = threads[5];
  const mailThreads = {
    [first.id]: { state: 'ready', id: first.id, path: M128_DIR + '/' + first.id, latest: 1, more: 0, files: [
      head(first.latest[0], 'wks_example01', ['- 쟁점 1: 시험 워크스페이스를 게이트가 쓰는 중이라 지금 보관하면 게이트가 끊긴다.', '- 쟁점 2: 게이트 뒤 보관하면 사이드바에 하루 더 남는다.', '- 쟁점 3: 재질의 1회를 이미 썼다 — 규약대로 사람 결정으로 올린다.']),
      f(now - 2 * DAY, 'wks_example01', '회신', 'wsA', '시험 워크스페이스 정리 완료(5/5 보관, 절차 반영)'),
      f(now - 3 * DAY + 2 * 60e3, 'wks_example01', '접수', 'wks_example01', '시험 워크스페이스 정리 착수'),
      f(now - 3 * DAY, 'wsA', '요청', 'wks_example01', '게이트 시험용 워크스페이스 정리 + 절차에 정리 단계')] },
    [tie.id]: { state: 'ready', id: tie.id, path: M128_DIR + '/' + tie.id, latest: 2, more: 0, files: [
      head(tie.latest[0], 'ws_c', ['시안 B가 작은 크기에서도 읽힌다.']), head(tie.latest[1], 'wks_example02', ['어느 크기를 기준으로 볼까요?']),
      f(now - 2 * DAY, 'ws_c', '요청', 'wks_example02', '로고 시안 두 장 비교')] } };
  const ws = (id, name, folder) => ({ id, name, projectId: 'prj_example01', projectDisplayName: 'Example Project', workspaceDirectory: '/w/' + folder });
  return { ...mailReads(MAIL, locale), mailList: { state: 'ready', root: M128_DIR, key: 'list0000000000001', limits: [], readAt: new Date(now).toISOString(), threads }, mailThreads,
    workspaces: { entries: [ws('wks_example01', 'Example Workspace', 'wks_example01'), ws('wks_example02', 'Second Workspace', 'wks_example02'),
      ws('wks_example03', 'Quiet Tool', 'quiet-tool'), ws('wks_example04', 'Notes App', 'notes app')], pageInfo: { nextCursor: null } } };
}
// REQ-117: three levels — the workspace's lead "총괄-01" → a topic lead "T01_샘플주제_1" (labels.role 주제총괄, profile 총괄_…,
// started under the lead) → its two sub-agents' cards, one running in progress, one done; and an archived topic lead
// "T02_샘플주제_1" done with its archived sub-card. Every card sits under the lead's, as the server sends it (one level);
// the topic lead's own family comes from the agents' labels. In progress holds the three made sub-card first, lead last,
// so the pins (lead, then topic lead) are what puts them in order. Made-up topics only.
const V_LEAD = '00000000-0000-4000-8000-0000000008a1', V_TOPIC = '00000000-0000-4000-8000-0000000008a2';
const V_SUBS = ['00000000-0000-4000-8000-0000000008a3', '00000000-0000-4000-8000-0000000008a4'];
const V_OLD = '00000000-0000-4000-8000-0000000008b1', V_OLD_SUB = '00000000-0000-4000-8000-0000000008b2';
const V = { lead: '총괄-01_sample-app_Opus', topic: 'T01_샘플주제_1', subA: 'T01_수집_대상A', subB: 'T01_수집_대상B', old: 'T02_샘플주제_1', oldSub: 'T02_정리_대상' };
let v = newBoard(8, 'wks_example01');
for (const [i, [title, stageId, agentId, extra]] of [[V.subA, 'doing', V_SUBS[0]], [V.topic, 'doing', V_TOPIC], [V.lead, 'doing', V_LEAD],
  ['Plain done', 'done'], [V.old, 'done', V_OLD], [V.oldSub, 'done', V_OLD_SUB], [V.subB, 'done', V_SUBS[1]], ['Plain waiting', 'todo'],
  ['Plain review', 'review', null, { priority: 'high' }]].entries()) {
  const at = T(5).replace('00:00:00', '03:0' + i + ':00');
  v = applyOperations(v, [{ ...add(title, stageId), ...(extra ?? {}) }], actor, ctx(at)).board;
  if (agentId) v = applyOperations(v, [{ op: 'link', id: v.cards.at(-1).id, agentId }], actor, ctx(at)).board;
}
const V_OF = cardParents(v, { agents: {}, parents: { [V_TOPIC]: { parentAgentId: V_LEAD }, [V_SUBS[0]]: { parentAgentId: V_TOPIC },
  [V_SUBS[1]]: { parentAgentId: V_TOPIC }, [V_OLD]: { parentAgentId: V_LEAD }, [V_OLD_SUB]: { parentAgentId: V_OLD } } });
const vId = title => v.cards.find(c => c.title === title).id;
const topicLabels = parent => ({ profile: '총괄_Opus-5.5', role: '주제총괄', 'paseo.parent-agent-id': parent });
const V_AGENTS = [[V_LEAD, 'idle', { profile: '총괄_Opus-5.5' }], [V_TOPIC, 'idle', topicLabels(V_LEAD)],
  [V_SUBS[0], 'running', { 'paseo.parent-agent-id': V_TOPIC }], [V_SUBS[1], 'idle', { 'paseo.parent-agent-id': V_TOPIC }]]
  .map(([id, status, labels]) => ({ ...AGENTS[0], id, title: 'Agent', status, labels, cwd: '/tmp/wks_example01' }))
  .concat([[V_OLD, topicLabels(V_LEAD)], [V_OLD_SUB, { 'paseo.parent-agent-id': V_OLD }]].map(([id, labels]) => ({ ...AGENTS[0], id, title: 'Agent',
    status: 'idle', labels, archivedAt: T(4), cwd: '/tmp/wks_example01' })));
const topicReads = () => ({ agents: [...AGENTS, ...V_AGENTS],
  overview: { ...toOverview([v, b], 'en', T(6)), boardViews: [v, b].map(x => toBoardDTO(x, 'en', 'off', Date.now(), x === v ? V_OF : undefined)),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([v, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now(), x === v ? V_OF : undefined),
    revision: x.revision, locale: 'en', observedAt: T(6) }])) });
// REQ-119: a lead that has started no sub-agent yet — "총괄-08_Sample-App_Opus" (profile 총괄_…, top-level) last in review
// under two older plain cards, one of them a worker's that is no lead's (profile build_…). No parents: its card is a lead's
// by its name alone. Made-up names only.
const NL_LEAD = '00000000-0000-4000-8000-0000000009a1', NL_WORKER = '00000000-0000-4000-8000-0000000009a2';
const NL = { lead: '총괄-08_Sample-App_Opus', worker: 'Build the sample', plain: 'Plain review' };
let nl = newBoard(9, 'wks_example01');
for (const [i, [title, stageId, agentId]] of [[NL.plain, 'review'], [NL.worker, 'review', NL_WORKER], [NL.lead, 'review', NL_LEAD],
  ['Plain waiting', 'todo'], ['Plain doing', 'doing']].entries()) {
  const at = T(5).replace('00:00:00', '04:0' + i + ':00');
  nl = applyOperations(nl, [add(title, stageId)], actor, ctx(at)).board;
  if (agentId) nl = applyOperations(nl, [{ op: 'link', id: nl.cards.at(-1).id, agentId }], actor, ctx(at)).board;
}
const nlId = title => nl.cards.find(c => c.title === title).id;
const NL_AGENTS = [[NL_LEAD, NL.lead, { profile: '총괄_Opus-5.5' }], [NL_WORKER, 'Build_sample_Opus', { profile: 'build_Opus' }]]
  .map(([id, title, labels]) => ({ ...AGENTS[0], id, title, status: 'idle', labels, cwd: '/tmp/wks_example01' }));
const newLeadReads = () => ({ agents: [...AGENTS, ...NL_AGENTS],
  overview: { ...toOverview([nl, b], 'en', T(6)), boardViews: [nl, b].map(x => toBoardDTO(x, 'en', 'off', Date.now())),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([nl, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now()), revision: x.revision, locale: 'en', observedAt: T(6) }])) });
// REQ-88: every card as the detail reads it (kanban.v1.card.get), from the ledger boards above. REQ-86: with when it entered its stage.
const cardReads = () => Object.fromEntries([late, a, b, r, q, st, dw].flatMap(board => board.cards.map(card => [card.id, { boardId: board.id,
  revision: board.revision, card, template: board.template, history: board.history.filter(h => h.cardId === card.id),
  ...enteredOf(stageEntry(stageEntries(board), card)) }])));
// REQ-52 (research/294): the first workspace with finished cards put away — two by the automatic archive, one by hand — and a
// cancelled card archived from To Do (not counted); the archived list as the server answers it (latest first).
let a52 = a;
for (const title of ['Shipped report', 'Old release note', 'Closed review']) a52 = applyOperations(a52, [add(title, 'done')], actor, ctx(T(6))).board;
a52 = applyOperations(a52, [add('Cancelled idea', 'todo')], actor, ctx(T(6))).board;
const id52 = title => a52.cards.find(c => c.title === title).id;
a52 = applyOperations(a52, [{ op: 'archive', id: id52('Shipped report'), reason: 'auto' }, { op: 'archive', id: id52('Old release note'), reason: 'auto' }],
  actor, ctx(T(14)), 'archiver').board;
a52 = applyOperations(a52, [{ op: 'archive', id: id52('Closed review') }], actor, ctx(T(15))).board;
a52 = applyOperations(a52, [{ op: 'archive', id: id52('Cancelled idea') }], actor, ctx(T(16))).board;
const archived52 = board => { const all = board.cards.filter(c => c.archivedAt).sort((x, y) => y.archivedAt.localeCompare(x.archivedAt));
  return { total: all.length, archivedDone: all.filter(c => archivedDone(c, board.template.stages)).length,
    cards: all.map(c => ({ id: c.id, title: c.title, stageId: c.stageId, archivedAt: c.archivedAt, ...(c.archiveReason ? { auto: true } : {}), done: archivedDone(c, board.template.stages) })) }; };
const req52Reads = (locale = 'ko') => {
  const view = x => toBoardDTO(x, locale, 'off', Date.now(), x === a52 ? SUB_OF : undefined);
  return { overview: { ...toOverview([a52, b], locale, T(16)), boardViews: [a52, b].map(view), removedIds: [], autoArchive: { days: 7 },
      workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries([a52, b].map(x => [x.id, { board: view(x), revision: x.revision, locale, observedAt: T(16), autoArchive: { days: 7 } }])),
    archived: { [a52.id]: archived52(a52), [b.id]: archived52(b) } };
};
// REQ-138: two boards of workspaces Paseo no longer lists — "probe-ws" with one archived card only (hidden), "left-ws" with a
// live card in To Do (shown) — beside the two live workspaces; marked as the server marks them (`emptyGoneBoards`).
const G_ID = n => 'board_' + '0'.repeat(63) + n;
let g138 = { ...newBoard(1, 'wks_probe01'), id: G_ID(1), cwd: '/tmp/probe-ws' };
g138 = applyOperations(g138, [add('Probe check', 'done')], actor, ctx(T(2))).board;
g138 = applyOperations(g138, [{ op: 'archive', id: g138.cards[0].id }], actor, ctx(T(3))).board;
let l138 = { ...newBoard(2, 'wks_left01'), id: G_ID(2), cwd: '/tmp/left-ws' };
l138 = applyOperations(l138, [add('Left open', 'todo')], actor, ctx(T(3))).board;
const req138Reads = (locale = 'ko') => {
  const all = [a, b, g138, l138], gone = emptyGoneBoards(all, [{ id: 'wks_example01', cwd: a.cwd }, { id: 'wks_example02', cwd: b.cwd }]);
  const mark = id => gone.has(id) ? { emptyGone: true } : {};
  const view = x => { const v = toBoardDTO(x, locale, 'off', Date.now(), groupsOf(x)); return { ...v, summary: { ...v.summary, ...mark(x.id) } }; };
  const base = toOverview(all, locale, T(6));
  return { overview: { ...base, boards: base.boards.map(r => ({ ...r, ...mark(r.id) })), boardViews: all.map(view), removedIds: [],
      workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries(all.map(x => [x.id, { board: view(x), revision: x.revision, locale, observedAt: T(6) }])),
    archived: Object.fromEntries(all.map(x => [x.id, archived52(x)])) };
};
/**
 * REQ-142: `lead-panel…` is the lead fixture in the first workspace's panel; `lead-panel-foreign` gives every agent another
 * workspace (gate 340 F1: a card on this board whose agent belongs elsewhere), `…-ko` reads every reply in Korean.
 */
const fixture = (mode, mobile, remembered = false) => {
  const f = fixtureBase(mode, mobile, remembered), variant = String(remembered);
  if (variant.startsWith('lead-panel-foreign')) f.agents = f.agents.map(agent => ({ ...agent, workspaceId: 'wks_foreign', cwd: '/tmp/wks_foreign' }));
  if (variant.startsWith('lead-panel') && variant.endsWith('-ko')) {
    const korean = value => { if (!value || typeof value !== 'object') return; for (const [key, inner] of Object.entries(value)) if (key === 'locale') value[key] = 'ko'; else korean(inner); };
    korean(f.boards); korean(f.overview); korean(f.cards);
  }
  return f;
};
const fixtureBase = (mode, mobile, remembered = false) => ({ mobile, width: mobile ? 390 : 1400, theme: PASEO_THEMES[mode],
  ...(String(remembered).startsWith('lead-panel') ? { panel: 'wks_example01' } : {}), ui: { hiddenProjects: [], order: { projects: [], workspaces: [] } },
  cards: cardReads(),
  overview: { ...toOverview([a, b], 'en', T(6)), boardViews: [a, b].map(x => toBoardDTO(x, 'en', 'off', Date.now(), groupsOf(x))), removedIds: [],
    workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([a, b].map(x => [x.id, boardReply(x)])),
  projects: { projects: [{ projectId: 'prj_example01', projectDisplayName: 'Example Project' }] }, agents: AGENTS,
  workspaces: { entries: [{ id: 'wks_example01', name: 'Example Workspace', projectId: 'prj_example01', projectDisplayName: 'Example Project' },
    { id: 'wks_example02', name: 'Second Workspace', projectId: 'prj_example01', projectDisplayName: 'Example Project' }], pageInfo: { nextCursor: null } },
  ...(String(remembered).startsWith('req52-') ? req52Reads(remembered.slice(6)) : String(remembered).startsWith('req139-') ? req139Reads(remembered.slice(7)) : String(remembered).startsWith('req138-') ? req138Reads(remembered.slice(7)) : String(remembered).startsWith('req137-') ? req137Reads(remembered.slice(7)) : String(remembered).startsWith('req136f2-') ? req136f2Reads(remembered.slice(9)) : String(remembered).startsWith('req136-') ? req136Reads(remembered.slice(7)) : String(remembered).startsWith('req135-') ? req135Reads(remembered.slice(7)) : String(remembered).startsWith('req133-') ? req133Reads(remembered.slice(7)) : String(remembered).startsWith('req130-') ? req130Reads(remembered.slice(7)) : remembered === 'models' ? modelReads() : String(remembered).startsWith('modelsperm-') ? permReads(remembered.slice(11)) : String(remembered).startsWith('modelstate-') ? stateReads(remembered.slice(11)) : remembered === 'mail128long' ? mail128Reads(true) : remembered === 'mail128en' ? mail128Reads(false, 'en') : remembered === 'mailnodir' ? mailReads(MAIL, 'ko', '') : String(remembered).startsWith('wf-') ? workflowReads(remembered.slice(3)) : String(remembered).startsWith('bplong-') ? longNameReads({ locale: remembered.slice(7) }) : String(remembered).startsWith('dispatchheld-') ? heldReads(remembered.slice(13)) : String(remembered).startsWith('dispatch-') ? dispatchReads(remembered.slice(9)) : remembered === 'newlead' ? newLeadReads() : remembered === 'topic' ? topicReads() : remembered === 'lead' || String(remembered).startsWith('lead-panel') ? leadReads() : remembered === 'status' ? statusReads() : remembered === 'refs' ? refReads() : remembered === 'dwell' ? dwellReads() : remembered === 'busy' ? busyReads() : remembered === 'mail' ? mailReads() : remembered === 'mail128' ? mail128Reads() : remembered === 'mailtall' ? mailReads(MAIL_TALL) : remembered ? { ...lateReads(undefined), later: lateReads(LATE_OF) } : {}) });

// REQ-126: agents named "<label>-<version>-<thinking>" — the version from the host's model list (`models`). A lead "총괄-09_…" in
// review, a topic lead and its worker (two agents: "· +1") in progress, a label from before 09-30 ("실행_Sol-6"), a long label on a
// card crowded with flags, one agent with no label, an archived one in done and one the host does not know. The worker's card was
// made by the lead and moved by the worker, so its detail names both. Made-up names only.
const M_IDS = Object.fromEntries(['lead', 'topic', 'sol', 'gemini', 'old', 'long', 'plain', 'archived', 'unknown']
  .map((key, i) => [key, '00000000-0000-4000-8000-0000000012' + String(i).padStart(2, '0')]));
const M = { lead: '총괄-09_Sample-App_Opus', topic: 'T03_샘플주제', work: '샘플 구현', old: '옛 이름 확인', long: '긴 이름 확인', plain: '라벨 없음',
  archived: '보관된 작업', unknown: '모르는 에이전트' };
const M_MODELS = { claude: [{ provider: 'claude', id: 'claude-opus-5-5', label: 'Opus 5.5' }, { provider: 'claude', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
  codex: [{ provider: 'codex', id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { provider: 'codex', id: 'gpt-6-sol', label: 'GPT-6-Sol' },
    { provider: 'codex', id: 'gpt-6-astra', label: 'GPT-6-Astra' }], gemini: [{ provider: 'gemini', id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }] };
const M_WANT = { [M.lead]: '총괄_Opus-5.5-High', [M.topic]: '산출물_Opus-5.5-XHigh', [M.work]: '실행_Sol-6.1-High', [M.old]: '실행_Sol-6-High',
  [M.long]: '실행_환경_장문검증_Astra-6-XHigh', [M.plain]: 'Opus-5.5-Max', [M.archived]: '조사_Sonnet-5.5-Medium', [M.unknown]: M_IDS.unknown.slice(0, 8) };
const M_MOVED = T(5).replace('00:00:00', '05:30:00');
let mb = newBoard('d', 'wks_example01');
for (const [i, [title, stageId, agentIds, extra, by]] of [[M.lead, 'review', ['lead']], [M.topic, 'doing', ['topic']],
  [M.work, 'todo', ['sol', 'gemini'], {}, { kind: 'agent', agentId: M_IDS.lead }], [M.old, 'review', ['old']],
  [M.long, 'doing', ['long'], { awaiting: 'user', blockedReason: 'Waiting', priority: 'high' }, { kind: 'agent', agentId: M_IDS.long }], [M.plain, 'todo', ['plain']],
  [M.archived, 'done', ['archived']], [M.unknown, 'todo', ['unknown']]].entries()) {
  const at = T(5).replace('00:00:00', '05:0' + i + ':00');
  mb = applyOperations(mb, [{ ...add(title, stageId), ...(extra ?? {}) }], by ?? actor, ctx(at)).board;
  for (const key of agentIds) mb = applyOperations(mb, [{ op: 'link', id: mb.cards.at(-1).id, agentId: M_IDS[key] }], actor, ctx(at)).board;
}
const mId = title => mb.cards.find(c => c.title === title).id;
mb = applyOperations(mb, [{ op: 'move', id: mId(M.work), to: 'doing' }], { kind: 'agent', agentId: M_IDS.sol }, ctx(M_MOVED)).board;
const M_OF = cardParents(mb, { agents: {}, parents: { [M_IDS.topic]: { parentAgentId: M_IDS.lead }, [M_IDS.sol]: { parentAgentId: M_IDS.topic },
  [M_IDS.gemini]: { parentAgentId: M_IDS.topic } } });
const M_AGENTS = [['lead', 'idle', 'claude', 'claude-opus-5-5', 'high', { profile: '총괄_Opus' }],
  ['topic', 'running', 'claude', 'claude-opus-5-5', 'xhigh', { profile: '산출물_Opus', role: '주제총괄', 'paseo.parent-agent-id': M_IDS.lead }],
  ['sol', 'running', 'codex', 'gpt-6.1-sol', 'high', { profile: '실행_Sol', 'paseo.parent-agent-id': M_IDS.topic }],
  ['gemini', 'idle', 'gemini', 'gemini-3.5-flash', null, { 'paseo.parent-agent-id': M_IDS.topic }],
  ['old', 'idle', 'codex', 'gpt-6-sol', 'high', { profile: '실행_Sol-6' }], ['long', 'idle', 'codex', 'gpt-6-astra', 'xhigh', { profile: '실행_환경_장문검증_Astra' }],
  ['plain', 'idle', 'claude', 'claude-opus-5-5', 'max', {}], ['archived', 'idle', 'claude', 'claude-sonnet-5-5', 'medium', { profile: '조사_Sonnet' }, T(5)]]
  .map(([key, status, provider, model, thinkingOptionId, labels, archivedAt]) => ({ ...AGENTS[0], id: M_IDS[key], title: 'Agent', status, provider, model,
    thinkingOptionId, labels, archivedAt: archivedAt ?? null, cwd: '/tmp/wks_example01' }));
/** research/236 D5: the same, the long-label agent asking for a permission (the longest state), in either language. */
const localeReads = locale => {
  const reads = modelReads(), relocale = value => { if (Array.isArray(value)) value.forEach(relocale);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (k === 'locale' && v === 'en') value[k] = locale; else relocale(v); } };
  relocale(reads);
  return { ...reads, cardLocale: locale };
};
const permReads = locale => {
  const reads = localeReads(locale);
  return { ...reads, agents: reads.agents.map(a => a.id === M_IDS.long ? { ...a, pendingPermissions: [{ requestId: 'p1' }] } : a) };
};
/** D47: the long-label ("…_Astra-6-XHigh") and the old short-label ("실행_Sol-6-High") agents both in one state, in either language —
 * every state an assignee row says: an error, asking for a permission, working, finished and to be looked at, finished, archived
 * (said as finished) and one the host does not know (left out of its listing). Spec "<state>-<locale>". */
const D47_STATES = { error: { status: 'error' }, permission: { pendingPermissions: [{ requestId: 'p1' }] }, working: { status: 'running' },
  attention: { requiresAttention: true, attentionReason: 'finished' }, idle: {}, archived: { archivedAt: T(5) }, unknown: null };
const stateReads = spec => {
  const [state, locale] = spec.split('-'), reads = localeReads(locale), set = D47_STATES[state];
  return { ...reads, agents: reads.agents.flatMap(a => a.id !== M_IDS.long && a.id !== M_IDS.old ? [a] : set ? [{ ...a, ...set }] : []) };
};
const modelReads = () => ({ agents: [...AGENTS, ...M_AGENTS], models: M_MODELS,
  overview: { ...toOverview([mb, b], 'en', T(6)), boardViews: [mb, b].map(x => toBoardDTO(x, 'en', 'off', Date.now(), x === mb ? M_OF : undefined)),
    removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
  boards: Object.fromEntries([mb, b].map(x => [x.id, { board: toBoardDTO(x, 'en', 'off', Date.now(), x === mb ? M_OF : undefined),
    revision: x.revision, locale: 'en', observedAt: T(6) }])),
  cards: { ...cardReads(), ...Object.fromEntries(mb.cards.map(card => [card.id, { boardId: mb.id, revision: mb.revision, card, template: mb.template,
    history: mb.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(mb), card)),
    ...(card.title === M.work ? { reason: { by: 'agent', cause: null, agentId: M_IDS.sol, at: M_MOVED, created: false } } : {}) }])) } });

// v0.1.46-B: a workspace with no lead by name — one plain chat ("Sample chat"), a draft to send, and the three request chips:
// sent to the latest agent (linked by the server), waiting for it, and no agent. The sheet's preview names that chat as the
// fallback, in `locale` (the board's language). Made-up names only.
const FALLBACK_AGENT = '00000000-0000-4000-8000-000000001460';
const DB = { draft: 'Sample draft', sent: 'Sent to the latest', waiting: 'Waiting for the latest', none: 'No agent yet' };
const dispatchReads = (locale = 'en') => {
  let db = newBoard('e', 'wks_example01');
  db = applyOperations(db, [{ op: 'add', title: DB.draft, intent: 'draft', acceptanceCriteria: '', stageId: 'todo' },
    ...[DB.sent, DB.waiting, DB.none].map(title => ({ op: 'add', title, intent: 'draft', acceptanceCriteria: '', stageId: 'todo' }))], actor, ctx(T(5))).board;
  const id = title => db.cards.find(c => c.title === title).id;
  db = applyOperations(db, [DB.sent, DB.waiting, DB.none].map(title => ({ op: 'dispatch', id: id(title), to: 'doing' })), actor, ctx(T(5)), 'board').board;
  db = applyOperations(db, [{ op: 'dispatched', id: id(DB.sent), state: 'sent', targetAgentId: FALLBACK_AGENT },
    { op: 'link', id: id(DB.sent), agentId: FALLBACK_AGENT, role: 'worker' },
    { op: 'dispatched', id: id(DB.waiting), state: 'noLead', targetAgentId: null }], actor, ctx(T(5).replace('00:00:00', '05:30:00')), 'dispatcher').board;
  db = applyOperations(db, [{ op: 'dispatched', id: id(DB.waiting), state: 'pending', targetAgentId: FALLBACK_AGENT },
    { op: 'dispatched', id: id(DB.none), state: 'noLead', targetAgentId: null }], actor, ctx(T(5).replace('00:00:00', '05:31:00')), 'dispatcher').board;
  const view = toBoardDTO(db, locale, 'off', Date.now());
  return { agents: [...AGENTS, { ...AGENTS[0], id: FALLBACK_AGENT, title: 'Sample chat', status: 'idle', cwd: '/tmp/wks_example01', createdAt: T(4) }],
    overview: { ...toOverview([db], locale, T(6)), boardViews: [view], removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: { [db.id]: { board: view, revision: db.revision, locale, observedAt: T(6) } },
    cards: Object.fromEntries(db.cards.map(card => [card.id, { boardId: db.id, revision: db.revision, card, template: db.template,
      history: db.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(db), card)) }])),
    cardLocale: locale, dispatchPreview: { lead: { agentId: FALLBACK_AGENT, title: 'Sample chat', fallback: true }, locale, boardTitle: 'Example Workspace' } };
};

// research/253-D3: cards waiting with nobody to go to, each for its reason — requested before the start line, the confirmed
// chat gone, and no agent at all — and a draft whose sheet is held because the settings file cannot be read. Made-up names only.
const HD = { draft: 'Sample held draft', before: 'Requested before the upgrade', gone: 'Confirmed chat closed', none: 'Nobody here yet' };
const GONE_AGENT = '00000000-0000-4000-8000-000000002530';
// ---- REQ-136 (research/272·277): the English screens' fixes — the boards above read in either language, "Card one" moved on
// from In progress to Review so its history names two stages. `req136-<locale>`. Made-up names only.
const req136Reads = locale => {
  const moved = applyOperations(a, [{ op: 'move', id: cardId('Card one'), to: 'review' }], actor, ctx(T(6))).board;
  const view = x => toBoardDTO(x, locale, 'off', Date.now(), groupsOf(x === moved ? a : x));
  return { overview: { ...toOverview([moved, b], locale, T(6)), boardViews: [moved, b].map(view), removedIds: [],
      workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries([moved, b].map(x => [x.id, { board: view(x), revision: x.revision, locale, observedAt: T(6) }])),
    cards: Object.fromEntries([moved, b].flatMap(board => board.cards.map(card => [card.id, { boardId: board.id, revision: board.revision, card,
      template: view(board).template, history: board.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(board), card)) }]))),
    cardLocale: locale };
};
/**
 * REQ-136 F2 (research/278): a board with one draft in its first stage, read as the built-in template (`req136f2-basic`) or as a
 * user template whose second open stage is "Build" (`req136f2-build`) — the draft rule must name the stage that really sends it.
 */
const F2_DRAFT = 'Sample draft idea';
const req136f2Reads = kind => {
  const stages = kind === 'build'
    ? [['waiting', 'Waiting', false], ['build', 'Build', false], ['review', 'Review', false], ['done', 'Done', true]]
    : null;
  let db = newBoard('f', 'wks_example01');
  if (stages) db = { ...db, template: { schemaVersion: 1, id: 'sample-build', version: 1, name: 'Sample build flow',
    stages: stages.map(([stageId, name, countsAsDone]) => ({ stageId, name, countsAsDone })) } };
  db = applyOperations(db, [{ op: 'add', title: F2_DRAFT, intent: 'draft', acceptanceCriteria: '', stageId: stages ? 'waiting' : 'todo' }], actor, ctx(T(5))).board;
  const view = toBoardDTO(db, 'en', 'off', Date.now());
  return { agents: AGENTS,
    overview: { ...toOverview([db], 'en', T(6)), boardViews: [view], removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: { [db.id]: { board: view, revision: db.revision, locale: 'en', observedAt: T(6) } },
    cards: Object.fromEntries(db.cards.map(card => [card.id, { boardId: db.id, revision: db.revision, card, template: view.template,
      history: db.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(db), card)) }])),
    cardLocale: 'en', dispatchPreview: { lead: null, held: 'settings', locale: 'en', boardTitle: 'Example Workspace' } };
};
/** REQ-136 H3: a time as a device in `zone` shows it — "21:40", or "09-26 21:40" before that device's today. */
const zoneClock = (zone, at, now) => {
  const parts = t => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(v => [v.type, v.value]));
  const x = parts(at), y = parts(now), clock = x.hour + ':' + x.minute;
  return x.year + x.month + x.day < y.year + y.month + y.day ? x.month + '-' + x.day + ' ' + clock : clock;
};
const heldReads = (locale = 'en') => {
  let db = newBoard('e', 'wks_example01');
  db = applyOperations(db, Object.values(HD).map(title => ({ op: 'add', title, intent: 'draft', acceptanceCriteria: '', stageId: 'todo' })), actor, ctx(T(5))).board;
  const id = title => db.cards.find(c => c.title === title).id, at = hhmm => T(5).replace('00:00:00', hhmm + ':00');
  db = applyOperations(db, [{ op: 'dispatch', id: id(HD.before), to: 'doing' }], actor, ctx(at('05:00')), 'board').board;
  db = applyOperations(db, [{ op: 'dispatch', id: id(HD.gone), to: 'doing', targetAgentId: GONE_AGENT }, { op: 'dispatch', id: id(HD.none), to: 'doing' }],
    actor, ctx(at('05:20')), 'board').board;
  db = applyOperations(db, [HD.before, HD.gone, HD.none].map(title => ({ op: 'dispatched', id: id(title), state: 'noLead', targetAgentId: null })),
    actor, ctx(at('05:21')), 'dispatcher').board;
  const view = toBoardDTO(db, locale, 'off', Date.now(), undefined, undefined, undefined, at('05:10'));
  return { agents: AGENTS,
    overview: { ...toOverview([db], locale, T(6)), boardViews: [view], removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: { [db.id]: { board: view, revision: db.revision, locale, observedAt: T(6) } },
    cards: Object.fromEntries(db.cards.map(card => [card.id, { boardId: db.id, revision: db.revision, card, template: db.template,
      history: db.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(db), card)) }])),
    cardLocale: locale, dispatchPreview: { lead: null, held: 'settings', locale, boardTitle: 'Example Workspace' } };
};

/**
 * REQ-137 (research/273 B): two workspaces — "Example Workspace" with two plain chats' cards (no lead by name, so no crown until
 * one is marked), "Second Workspace" with a lead by its English name ("Lead-04_…", a crown from the start). The card ⋯ marks
 * "Shop renewal plan"; the settings list who leads each workspace. Made-up names only.
 * 281: each board view carries the server's own judgement (`judgeLead` over these chats, `leadNow`) and the request modes
 * (`dispatchMode` from the kept mark), as the read handlers give them. Variants (`req137-<kind>-<locale>`): `order` — the first
 * workspace's two chats named "Lead-01" (older chat, newer card) and "Lead-02" (newer chat, older card); `sent-as`, `sent-moved`,
 * `sent-cleared` — "History request" sent to the older plain chat while it was marked, then the mark as it is (still there,
 * moved to the newer chat, taken off); `sent-never` — the same request with no mark ever (a real fallback, "the latest agent");
 * `unusable` — "Shop renewal plan" marked, but its chat works in a third workspace (another board's chat): kept, not in effect.
 */
const RL = { mark: '00000000-0000-4000-8000-0000000013a1', plain: '00000000-0000-4000-8000-0000000013a2', named: '00000000-0000-4000-8000-0000000013a3' };
const RL_T = { mark: 'Shop renewal plan', plain: 'Photo batch', named: 'Lead-04_second-shop_Fable', note: 'Plain note' };
const RL_ORDER = { mark: 'Lead-01_example_Opus', plain: 'Lead-02_example_Opus' }, RL_HISTORY = 'History request';
const req137Reads = arg => {
  const parts = arg.split('-'), locale = parts.pop(), kind = parts.join('-'), order = kind === 'order', sent = kind.startsWith('sent-') ? kind.slice(5) : null;
  const titles = order ? { ...RL_T, ...RL_ORDER } : RL_T, at = hm => T(5).replace('00:00', hm);
  let one = newBoard('e', 'wks_example01'), two = newBoard('f', 'wks_example02');
  // `order`: the newer chat's card first. Otherwise the older (marked) chat's card first, as before.
  for (const [title, agentId, i] of order ? [[titles.plain, RL.plain, 0], [titles.mark, RL.mark, 1]] : [[titles.mark, RL.mark, 0], [titles.plain, RL.plain, 1]]) {
    one = applyOperations(one, [add(title, 'doing')], actor, ctx(T(5).replace('00:00', '0' + i + ':00'))).board;
    one = applyOperations(one, [{ op: 'link', id: one.cards.at(-1).id, agentId }], actor, ctx(T(5).replace('00:00', '0' + i + ':30'))).board;
  }
  two = applyOperations(two, [add(RL_T.named, 'doing'), add(RL_T.note, 'todo')], actor, ctx(T(5))).board;
  two = applyOperations(two, [{ op: 'link', id: two.cards[0].id, agentId: RL.named }], actor, ctx(T(5))).board;
  if (sent) {
    one = applyOperations(one, [{ op: 'add', title: RL_HISTORY, intent: 'draft', acceptanceCriteria: '', stageId: 'todo' }], actor, ctx(at('03:00'))).board;
    const id = one.cards.at(-1).id;
    one = applyOperations(one, [{ op: 'dispatch', id, to: 'doing' }], actor, ctx(at('03:00')), 'board').board;
    one = applyOperations(one, [{ op: 'dispatched', id, state: 'sent', targetAgentId: RL.mark }, { op: 'link', id, agentId: RL.mark, role: 'worker' }],
      actor, ctx(at('03:30')), 'dispatcher').board;
  }
  // The mark kept for the first workspace (`leadRecord`): set before the request was sent, then moved or taken off after it.
  const record = { 'as': { agentId: RL.mark, changedAt: at('02:00') }, unusable: { agentId: RL.mark, changedAt: at('02:00') }, moved: { agentId: RL.plain, changedAt: at('04:00') },
    cleared: { agentId: null, changedAt: at('04:00') } }[sent ?? kind] ?? null;
  const agents = [[RL.mark, titles.mark, 'wks_example01', T(1)], [RL.plain, titles.plain, 'wks_example01', T(3)], [RL.named, RL_T.named, 'wks_example02', T(2)]]
    .map(([id, title, w, createdAt]) => kind === 'unusable' && id === RL.mark ? [id, title, 'wks_example03', createdAt] : [id, title, w, createdAt])
    .map(([id, title, w, createdAt]) => ({ ...AGENTS[0], id, title, status: 'idle', labels: {}, cwd: '/tmp/' + w, workspaceId: w, createdAt }));
  const listing = { rows: [one, two].map(x => ({ id: x.workspaceId, workspaceDirectory: x.cwd })), read: 'complete' };
  const recordOf = x => x === one ? record : null;
  const leadOf = x => ({ record: recordOf(x), now: judgeLead(agents.map(agent => readLeadEntry({ agent })), x, listing, () => false, recordOf(x)?.agentId ?? null) ?? undefined });
  const view = x => toBoardDTO(x, locale, 'off', Date.now(), undefined, undefined, undefined, undefined, leadOf(x));
  const modeOf = (x, card) => { const mode = card.dispatch ? dispatchMode(card.dispatch, recordOf(x)) : {}; return mode.marked || mode.modeUnknown ? { dispatchMode: mode } : {}; };
  return { agents: [...AGENTS, ...agents],
    overview: { ...toOverview([one, two], locale, T(6)), boardViews: [one, two].map(view), removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries([one, two].map(x => [x.id, { board: view(x), revision: x.revision, locale, observedAt: T(6) }])),
    cards: Object.fromEntries([one, two].flatMap(board => board.cards.map(card => [card.id, { boardId: board.id, revision: board.revision, card,
      template: view(board).template, history: board.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(board), card)),
      ...modeOf(board, card) }]))),
    cardLocale: locale };
};

// research/210 (208-D1) and REQ-124: names shaped like the gate's on 390px, in `locale` — 198 cards on the first workspace (186 of them
// done, so its figures are as long as the real ledger's) called "Sample-Long-Board", the second "2026 가상실증기술 지원사업";
// the first holds a workflow definition, which offers no button on a phone in this release. Made-up cards only.
const BP_LONG = { first: 'Sample-Long-Board', second: '2026 가상실증기술 지원사업' };
let bp = null;
const longNameReads = ({ locale = 'ko' } = {}) => {
  const now = Date.now(), ago = hours => new Date(now - hours * 3600_000).toISOString();
  bp = newBoard('c', 'wks_example01');
  for (const [i, [title, stageId, extra]] of [['공개 기준 문장 정하기', 'todo', { awaiting: 'user' }], ['테스터 알림 초안', 'todo', { intent: 'draft' }],
    ['빌드 확인', 'doing', {}], ['문서 다듬기', 'doing', {}], ['휴대폰 확인 합본 보기', 'review', { awaiting: 'user' }],
    ['v0.1.40 게이트 통과', 'done', {}], ['v0.1.41 게이트 통과', 'done', {}]].entries())
    bp = applyOperations(bp, [{ ...add(title, stageId), ...extra }], actor, ctx(ago(5 - i * .1))).board;
  for (const half of [0, 93]) bp = applyOperations(bp, Array.from({ length: 93 }, (_, i) => add('Done ' + (half + i + 1), 'done')), actor, ctx(ago(1))).board;
  const view = x => { const v = toBoardDTO(x, locale, 'off', now); return x === bp ? { ...v, summary: { ...v.summary, workflow: true } } : v; };
  return { overview: { ...toOverview([bp, b], locale, new Date(now).toISOString()), boardViews: [bp, b].map(view),
      removedIds: [], workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries([bp, b].map(x => [x.id, { board: view(x), revision: x.revision, locale, observedAt: T(6) }])),
    workflow: { wks_example01: WF.gate },
    workspaces: { entries: [{ id: 'wks_example01', name: BP_LONG.first, projectId: 'prj_example01', projectDisplayName: 'Example Project' },
      { id: 'wks_example02', name: BP_LONG.second, projectId: 'prj_example01', projectDisplayName: 'Example Project' }], pageInfo: { nextCursor: null } },
    cards: { ...cardReads(), ...Object.fromEntries(bp.cards.map(card => [card.id, { boardId: bp.id, revision: bp.revision, card, template: bp.template,
      history: bp.history.filter(h => h.cardId === card.id), ...enteredOf(stageEntry(stageEntries(bp), card)) }])) } };
};

// REQ-124 2단위: the lane "Example Workspace" holds a workflow definition, "Second Workspace" none. What the server reads is the
// real reader (dist/server/workflow.js) over the made-up workspaces of tests/fixtures/workflow-fixtures.mjs, written to a temporary
// folder: `gate` (six releases, loops, an unread commit title, an unknown format, a person's step), `other` (another field with no
// gate — REQ-125), `ten` (the gate's files under a ten-column procedure, research/216's cut second line).
const WF_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-web-wf-'));
const WF_NOW = () => new Date('2026-03-03T07:00:00.000Z');
// U4a: the record's lines are dated October 2026 — read after them (a line later than the reading is ambiguous).
const WF_NOW_U4 = () => new Date('2026-10-06T03:00:00.000Z');
const tenDefinition = { ...gateDefinition, name: '열 단계 합성 절차', stages: [
  { id: 'req', label: '요구 접수', shape: 'pill', row: 0, col: 0 }, { id: 'sketch', label: '시안', shape: 'box', row: 0, col: 1 },
  { id: 'impl', label: '구현', shape: 'box', row: 0, col: 2 }, { id: 'lead', label: '총괄 테스트', shape: 'box', row: 0, col: 3 },
  { id: 'gate', label: '게이트', shape: 'box', row: 0, col: 4 }, { id: 'pass', label: '통과?', shape: 'diamond', row: 0, col: 5 },
  { id: 'commit', label: '커밋', shape: 'box', row: 0, col: 6 }, { id: 'stable', label: '안정판', shape: 'box', row: 0, col: 7 },
  { id: 'tester', label: '테스터 배포', shape: 'box', row: 0, col: 8 }, { id: 'public', label: '공개', shape: 'pill', row: 0, col: 9 },
  { id: 'fix', label: '수정', shape: 'box', row: 1, col: 5 }, { id: 'phone', label: '휴대폰 확인', shape: 'box', row: 1, col: 7, person: true }],
  edges: [{ from: 'req', to: 'sketch' }, { from: 'sketch', to: 'impl' }, { from: 'impl', to: 'lead' }, { from: 'lead', to: 'gate' },
    ...gateDefinition.edges.filter(e => !['req', 'impl'].includes(e.from)), { from: 'tester', to: 'public' }] };
const WF = {};
for (const [key, definition, files] of [['gate', gateDefinition, gateFiles], ['other', otherDefinition, otherFiles], ['ten', tenDefinition, gateFiles]])
  WF[key] = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, key), definition, files), { now: WF_NOW });
// REQ-125: every built-in in both languages, as the real reader answers a workspace with no file that is trying it.
const BUILTIN_READS = {};
fs.mkdirSync(path.join(WF_ROOT, 'none'));
for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en'])
  BUILTIN_READS[t.id + '-' + locale] = await readWorkflow(path.join(WF_ROOT, 'none'), { now: WF_NOW, pick: { template: t.id, locale } });
// REQ-125 2단계: the real reader's answer once a built-in is exported — the file written by the real writer, then read.
const EXPORTED_READS = {};
for (const t of BUILTIN_WORKFLOWS) for (const locale of ['ko', 'en']) {
  const folder = path.join(WF_ROOT, 'exported-' + t.id + '-' + locale);
  fs.mkdirSync(folder); await exportDefinition(folder, exportedDefinition(t, locale));
  EXPORTED_READS[t.id + '-' + locale] = await readWorkflow(folder, { now: WF_NOW });
}
// REQ-125 U1 (research/301): a `/2` definition — rows of 건, one per made-up company folder right under the 건 folder, read by
// the real reader. `inst`: A사 (data in three steps, dated), B사 (a README-only folder), C사 (its 선정·계약 folder cut at the
// per-folder cap, so "일부만 읽음"), a link and a hidden folder left out. `instzero`: the 건 folder with no 건. `instlong`: a 40-character name.
const U1_ROOT = '사업/05_지원기업 서류', U1_LONG = '초장문회사명주식회사'.repeat(4);
const u1Grant = BUILTIN_WORKFLOWS.find(t => t.id === 'gov-grant');
const u1Definition = { format: 'paseo-kanban.workflow/2', features: ['instance-folder', 'folder'], name: '지원사업 — 건 행',
  instanceKey: { from: 'folder', path: U1_ROOT + '/*', label: 'strip-number-prefix' },
  stages: u1Grant.stages.map(s => ({ id: s.id, label: s.ko, shape: s.shape, row: s.row, col: s.col, ...(s.person ? { person: true } : {}) })),
  edges: u1Grant.edges.map(e => ({ from: e.from, to: e.to, ...(e.when ? { when: e.when } : {}), ...(e.back ? { back: true } : {}), ...(e.optional ? { optional: true } : {}), ...(e.ko ? { label: e.ko } : {}) })),
  sources: [{ stage: 'docs', read: 'folder', files: ['{instance}/03_삽입도식'] }, { stage: 'submit', read: 'folder', files: ['{instance}/00_제출서류_*'] },
    { stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] }] };
const u1Files = { [U1_ROOT + '/01_A사/03_삽입도식/a.svg']: '<svg/>', [U1_ROOT + '/01_A사/00_제출서류_20260918/x.pdf']: '', [U1_ROOT + '/01_A사/10_선정·계약/c.md']: '-',
  [U1_ROOT + '/02_B사/03_삽입도식/README.md']: '#', [U1_ROOT + '/02_B사/draft.md']: '-', [U1_ROOT + '/@eaDir/x']: '',
  // 303-F5: a 건 folder someone named with "#" — no row (the /2 rule), but said in "제외 N"; the NAS's @eaDir stays quiet.
  [U1_ROOT + '/#긴급건/10_선정·계약/x.md']: '-' };
for (let i = 0; i < 8; i++) u1Files[U1_ROOT + `/03_C사/10_선정·계약/sub${i}/x.md`] = '-';
{
  const at = path.join(WF_ROOT, 'inst');
  await writeWorkspace(at, u1Definition, u1Files);
  fs.symlinkSync(path.join(at, U1_ROOT, '01_A사'), path.join(at, U1_ROOT, '04_링크'));
  WF.inst = await readWorkflow(at, { now: WF_NOW, limits: { ...WORKFLOW_LIMITS, folderEntries: 7 } });
  // 303-F5: only someone's "@" folder and the NAS's helper — 건 0, but "제외 1" says why, never 건 0 · 제외 0.
  WF.instzero = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instzero'), u1Definition,
    { [U1_ROOT + '/README.md']: '#', [U1_ROOT + '/@고객과제/10_선정·계약/x.md']: '-', [U1_ROOT + '/@eaDir/x']: '' }), { now: WF_NOW });
  WF.instlong = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlong'), u1Definition,
    { [U1_ROOT + '/01_A사/10_선정·계약/c.md']: '-', [U1_ROOT + '/02_' + U1_LONG + '/10_선정·계약/d.md']: '-' }), { now: WF_NOW });
}
// REQ-125 U2 (research/305): `file-versions` — the versions of the made-up 붙임2 per 건, read by the real reader. A사: v1.0 as
// DOCX and PDF (one version) then v2.0; B사: only v2.0 left; C사: a day not on the calendar (형식 모름); D사: v1.0 on two days, then v1.1.
const U2_PAPER = '{instance}/{nn}_붙임2_4번_작성본_v{ver}_{yyyymmdd}.{ext}';
const u2Definition = { ...u1Definition, features: ['instance-folder', 'folder', 'file-versions'], name: '지원사업 — 판 사슬',
  sources: [{ stage: 'docs', read: 'file-versions', files: [U2_PAPER], ver: 'major.minor', observed: 'lowest' },
    { stage: 'redo', read: 'file-versions', files: [U2_PAPER], ver: 'major.minor', observed: 'later' },
    { stage: 'submit', read: 'folder', files: ['{instance}/00_제출서류_*'] }, { stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] }] };
const U2_DOC = '붙임2_4번_작성본';
WF.instver = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instver'), u2Definition, {
  [U1_ROOT + `/01_A사/02_${U2_DOC}_v1.0_20260917.docx`]: '', [U1_ROOT + `/01_A사/02_${U2_DOC}_v1.0_20260917.pdf`]: '', [U1_ROOT + `/01_A사/02_${U2_DOC}_v2.0_20260918.md`]: '-',
  [U1_ROOT + '/01_A사/00_제출서류_20260918/x.pdf']: '', [U1_ROOT + '/01_A사/10_선정·계약/c.md']: '-',
  [U1_ROOT + `/02_B사/03_${U2_DOC}_v2.0_20260922.md`]: '-', [U1_ROOT + `/03_C사/03_${U2_DOC}_v1.0_20260231.md`]: '-',
  [U1_ROOT + `/04_D사/01_${U2_DOC}_v1.0_20260920.md`]: '-', [U1_ROOT + `/04_D사/01_${U2_DOC}_v1.0_20260921.hwp`]: '', [U1_ROOT + `/04_D사/01_${U2_DOC}_v1.1_20260923.md`]: '-' }), { now: WF_NOW });
// REQ-125 U3 (research/308): `scope: "program"` — the notice common to every 건 (the made-up 공고문 folder), read once by the
// real reader, and A사's copy of it inside the 건 folder: 규칙 충돌, said in the band, its evidence and "제외 1". `settle` is a common
// step with nothing there (기록 없음). The 건's own rules are U2's.
const U3_LONG_KO = '사업참여신청서_제출서류_최종정리', U3_LONG_EN = 'ApplicationEvidenceDocumentsWithoutSpaces';
const u3Definition = { ...u2Definition, features: ['instance-folder', 'folder', 'file-versions', 'program'], name: '지원사업 — 공통 띠',
  sources: [{ stage: 'notice', read: 'folder', scope: 'program', files: ['사업/01_공고문', U1_ROOT + '/*/01_공고문'] },
    { stage: 'settle', read: 'folder', scope: 'program', files: ['사업/09_결과보고'] }, ...u2Definition.sources,
    // 311-F2 · 313-F3: a 건 rule of another step reaching A사's copy — held out, its cell and its step on the flow say "기록 없음 · 규칙 충돌 1".
    { stage: 'submit', read: 'folder', files: ['{instance}/01_공고문'] },
    // 314-F4: a step with data under a long name without spaces (Korean 17, English 41 characters) and the copy too — "규칙 충돌 1" stays seen.
    { stage: 'perform', read: 'folder', files: ['{instance}/01_공고문', '{instance}/' + U3_LONG_KO] },
    { stage: 'evaluate', read: 'folder', files: ['{instance}/01_공고문', '{instance}/' + U3_LONG_EN] }] };
WF.instprog = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instprog'), u3Definition, {
  '사업/01_공고문/모집공고.pdf': '', '사업/01_공고문/README.md': '#', [U1_ROOT + '/01_A사/01_공고문/모집공고.pdf']: '',
  [U1_ROOT + '/01_A사/' + U3_LONG_KO + '/x.pdf']: '', [U1_ROOT + '/01_A사/' + U3_LONG_EN + '/x.pdf']: '',
  [U1_ROOT + `/01_A사/02_${U2_DOC}_v1.0_20260917.md`]: '-', [U1_ROOT + `/01_A사/02_${U2_DOC}_v2.0_20260918.md`]: '-', [U1_ROOT + '/01_A사/10_선정·계약/c.md']: '-',
  [U1_ROOT + `/02_B사/03_${U2_DOC}_v1.0_20260922.md`]: '-' }), { now: WF_NOW });
// REQ-125 U4a (research/316): `state-log` — the made-up 「건 기록」 section of STATE.md, read by the real reader. `instlog`: A사 confirmed
// (제출, 보완 제출, 선정 예), B사 ambiguous (an act typo after its 예), C사 no record, D사 no row's tag issue, "[E]사" a name no tag can
// hold (said in the heading). `instlogmemo`: the same with one memo line mixed in — every record cell ambiguous, the note with its line.
// `instlogcut`: the record past 2 MB — every record cell 일부만 읽음. A사's 협약·계약 folder holds data: the decision's branches stay undrawn.
const u4Definition = { ...u1Definition, features: ['instance-folder', 'folder', 'state-log'], name: '지원사업 — 기록 읽기',
  sources: [{ stage: 'submit', read: 'state-log', files: ['STATE.md'], section: '건 기록', words: ['제출'] },
    { stage: 'supplement', read: 'state-log', files: ['STATE.md'], section: '건 기록', words: ['보완 제출'] },
    { stage: 'selected', read: 'state-log', files: ['STATE.md'], section: '건 기록', words: { yes: ['선정'], no: ['미선정'] } },
    { stage: 'skip', read: 'state-log', files: ['STATE.md'], section: '건 기록', words: ['철회'] },
    { stage: 'agree', read: 'folder', files: ['{instance}/10_선정·계약'] }] };
const U4_LOG = ['- 2026-09-19: [A사][제출]', '- 2026-09-29: [A사][보완 제출]', '- 2026-10-01 17:00 KST: [A사][선정]', '- 2026-10-01: [B사][선정]', '- 2026-10-02: [B사][미선졍]'];
const u4State = (...extra) => ['# 상태', '', '## 작업 기록', '- 2026-10-01: A사 선정 통보. 서술은 읽지 않음.', '', '## 건 기록', ...U4_LOG, ...extra, ''].join('\n');
const u4Files = { [U1_ROOT + '/01_A사/10_선정·계약/c.md']: '-', [U1_ROOT + '/02_B사/x.md']: '-', [U1_ROOT + '/03_C사/x.md']: '-', [U1_ROOT + '/05_[E]사/x.md']: '-' };
WF.instlog = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlog'), u4Definition, { ...u4Files, 'STATE.md': u4State() }), { now: WF_NOW_U4 });
WF.instlogmemo = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlogmemo'), u4Definition, { ...u4Files, 'STATE.md': u4State('메모: 협약 일정은 다음 주') }), { now: WF_NOW_U4 });
WF.instlogcut = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlogcut'), u4Definition,
  { ...u4Files, 'STATE.md': u4State() + 'x'.repeat(WORKFLOW_LIMITS.wholeFileBytes) }), { now: WF_NOW_U4 });
// 317-F1: a long memo holding an emoji, a ZWJ family, a flag and a letter with a combining mark — its excerpt cut in the reply's unit
// (UTF-16) between graphemes, so the reply passes the SDK's check and the cells say ⚠ 모호. `instlogrefused`: the same reading with an
// excerpt one emoji past the reply's limit (as 0.1.61's first candidate made it) — a reply the SDK refuses.
const U4_EMOJI_MEMO = '취소 정정 🔴 ' + '기록 설명 '.repeat(80) + '👨‍👩‍👧‍👦🇰🇷e\u0301';
WF.instlogemoji = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlogemoji'), u4Definition, { ...u4Files, 'STATE.md': u4State(U4_EMOJI_MEMO) }), { now: WF_NOW_U4 });
WF.instlogrefused = JSON.parse(JSON.stringify(WF.instlogemoji));
WF.instlogrefused.logShared[0].excerpt = '🔴'.repeat(151);
// REQ-125 U4b (research/324): where a 건 ended. A사 예 (협약 data — no end), B사 미선정 alone (끝: 미선정·철회), C사 철회 (끝: 불참), D사 미선정
// but a 협약 folder with no date in its name — the tag held, its reason on the decision's evidence.
WF.instlogend = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlogend'), u4Definition, { ...u4Files, [U1_ROOT + '/04_D사/10_선정·계약/c.md']: '-',
  'STATE.md': ['# 상태', '', '## 건 기록', '- 2026-09-19: [A사][제출]', '- 2026-10-01 17:00 KST: [A사][선정]', '- 2026-10-02: [B사][미선정]', '- 2026-09-22 15:04 KST: [C사][철회]',
    '- 2026-10-02: [D사][미선정]', ''].join('\n') }), { now: WF_NOW_U4 });
// 325-F1: the same with the 미선정 line unnamed (`when` only) — the phone lists it by its answer and marks it for B사.
// 325-J3: the same with a second 아니오 line (선정? → 불참) — B사's answer has two lines: no branch, the tag held (`branches`).
const u4Variant = edges => ({ ...u4Definition, edges });
const u4EndState = ['# 상태', '', '## 건 기록', '- 2026-09-19: [A사][제출]', '- 2026-10-01 17:00 KST: [A사][선정]', '- 2026-10-02: [B사][미선정]', '- 2026-09-22 15:04 KST: [C사][철회]', ''].join('\n');
WF.instlognolabel = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlognolabel'), u4Variant(u4Definition.edges.map(e => e.from === 'selected' && e.when === 'no' ? { from: e.from, to: e.to, when: 'no' } : e)),
  { ...u4Files, 'STATE.md': u4EndState }), { now: WF_NOW_U4 });
WF.instlogsplit = await readWorkflow(await writeWorkspace(path.join(WF_ROOT, 'instlogsplit'), u4Variant([...u4Definition.edges, { from: 'selected', to: 'skip', when: 'no', label: '미선정 2' }]),
  { ...u4Files, 'STATE.md': u4EndState }), { now: WF_NOW_U4 });
fs.rmSync(WF_ROOT, { recursive: true, force: true });
// REQ-134: a definition the server could not read, as it answers (the phone sheet's words).
// 269-F1: the gate's evidence paths made 78 characters long (synthetic), to see the place line whole.
const LONG_PATH = 'docs/release_0_2_6/269_REQ134_mobile_workflow_independent_gate_verification.md';
WF.long = JSON.parse(JSON.stringify(WF.gate));
for (const r of WF.long.releases) for (const c of r.cells) for (const e of c.events ?? []) if (e.path) e.path = LONG_PATH;
WF.absent = { defined: false, reason: 'unknown-format', definitionPath: '.kanban/workflow.json' };
/**
 * REQ-139: the screens' size as the server keeps it (absent at 100%) beside the workflow reads — 'req139-<percent>[-<data>]', the gate's
 * definition by default, 'instlogend' for a format-2 (by 건) one. Made-up names only.
 */
const req139Reads = spec => { const [percent, data = 'gate'] = spec.split('-');
  return { ...workflowReads(data + '-ko'), ui: { hiddenProjects: [], order: { projects: [], workspaces: [] }, ...(percent === '100' ? {} : { settings: { uiScale: Number(percent) } }) } }; };
const workflowReads = (spec = 'gate-ko') => {
  // REQ-125: a third part picks a built-in — for the second workspace (no file), or (`resting-<id>`) for the first, whose file wins.
  const [data, locale = 'ko', ...rest] = spec.split('-'), pickSpec = rest.join('-');
  const resting = pickSpec.startsWith('resting.'), picked = resting ? pickSpec.slice(8) : pickSpec;
  const workflowPicks = picked ? { [resting ? 'wks_example01' : 'wks_example02']: picked } : {};
  const view = x => { const v = toBoardDTO(x, locale, 'off', Date.now(), groupsOf(x));
    return x === a ? { ...v, summary: { ...v.summary, workflow: true } } : picked && !resting ? { ...v, summary: { ...v.summary, workflow: true, workflowPick: picked } } : v; };
  return { overview: { ...toOverview([a, b], locale, T(6)), boardViews: [a, b].map(view), removedIds: [],
      workspaceLabels: { available: false, source: 'none', definitions: [], byWorkspace: {} } },
    boards: Object.fromEntries([a, b].map(x => [x.id, { board: view(x), revision: x.revision, locale, observedAt: T(6) }])),
    workflow: { wks_example01: WF[data] }, builtins: BUILTIN_READS, exported: EXPORTED_READS, workflowPicks };
};

// ---- bundle -------------------------------------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-web-'));
await build({ entryPoints: [path.join(here, 'page.tsx')], bundle: true, format: 'iife', outfile: path.join(dir, 'page.js'),
  jsx: 'automatic', target: 'es2022', logLevel: 'error', define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' },
  nodePaths: [path.join(here, 'node_modules'), path.join(root, 'node_modules')],
  alias: { 'react-native': 'react-native-web', '@getpaseo/plugin/client/react-native': path.join(here, 'shims/plugin-react-native.tsx'),
    '@getpaseo/plugin/client': path.join(here, 'shims/plugin-client.tsx'), react: path.join(root, 'node_modules/react'),
    'react-dom': path.join(here, 'node_modules/react-dom') } });
const page = (mode, mobile, remembered = false) => {
  const file = path.join(dir, `${mode}-${mobile ? 390 : 1400}${remembered ? '-' + (remembered === true ? 'late' : remembered) : ''}.html`);
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{height:100%;margin:0}
#root{display:flex}</style></head><body><div id="root"></div><script>window.__FIXTURE__=${JSON.stringify(fixture(mode, mobile, remembered))}</script>
<script src="page.js"></script></body></html>`);
  return 'file://' + file;
};

// ---- checks -------------------------------------------------------------------------------------------------------
const results = [];
/** REQ-120: the medal's painted tints, contrasts and boxes per scene, written to medal.json. REQ-121·122: the ribbon, the crown's beads. */
const medalLog = [];
const check = (scene, name, ok, detail = '') => { results.push({ scene, name, ok: !!ok, detail }); if (!ok) console.log('FAIL', scene, name, detail); };
const byId = id => `[data-testid="${id}"]`;
const rgb = s => '#' + (s.match(/\d+/g) || []).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
const box = async (p, sel) => (await p.locator(sel).first().boundingBox());
const style = (p, sel, props) => p.locator(sel).first().evaluate((el, names) => { const s = getComputedStyle(el); return Object.fromEntries(names.map(n => [n, s[n]])); }, props);
// The first match only: the second workspace has a "doing" cell too.
const titles = (p, sel) => p.locator(sel).first().locator('[data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
const readableHex = (text, background) => readable(text, background).toLowerCase();
const center = b => [b.x + b.width / 2, b.y + b.height / 2];
async function moveTo(p, sel) { const b = await box(p, sel); await p.mouse.move(...center(b), { steps: 6 }); await p.waitForTimeout(120); return b; }
async function clickAt(p, sel) { const b = await moveTo(p, sel); await p.mouse.down(); await p.waitForTimeout(60); await p.mouse.up(); await p.waitForTimeout(150); return b; }
/** REQ-134: a finger held on `sel` (the nth match) for 700ms — RN's long press (a real touch through CDP, no click). */
async function hold(p, sel, nth = 0) {
  const b = await p.locator(sel).nth(nth).boundingBox(), [x, y] = center(b), cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await p.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(350);
}
const away = async p => { await p.mouse.move(700, 880, { steps: 4 }); await p.waitForTimeout(120); };
/**
 * REQ-142: the page is the overview, in no workspace, so opening an agent asks first; [Open] by the same kind of input,
 * the question said as a check of `scene`. Opened at once (nothing asked), it is a failure there.
 */
async function leaveOpen(p, scene, touch = false) {
  await p.waitForSelector(byId('agent-leave-open'), { timeout: 5000 }).catch(() => {});
  const asked = (await p.locator(byId('agent-leave-open')).count()) > 0;
  check(scene, 'REQ-142 asked before opening an agent of another workspace', asked);
  if (!asked) return;
  if (touch) await p.locator(byId('agent-leave-open')).first().tap(); else await clickAt(p, byId('agent-leave-open'));
  await p.waitForSelector(byId('agent-leave-sheet'), { state: 'detached', timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(touch ? 300 : 150);
}
const visible = async (p, sel) => (await p.locator(sel).count()) > 0 && await p.locator(sel).first().isVisible();
/**
 * REQ-135: the sub-cards' parts a lead's family line (`sel`) says, in order, by their whole words — what a screen reader hears,
 * whatever fit a narrow card says them at ("Running 1 · Awaiting you 1 · Testing 21:40~").
 */
const spokenParts = (p, sel) => p.locator(sel + ' [data-testid^="lead-status-"]').evaluateAll(els => els.filter(e => /^lead-status-(running|testing|awaiting)$/.test(e.dataset.testid))
  .map(e => e.getAttribute('aria-label').replace(/(: highlight those cards of | — 해당 카드 강조: ).*$/, ''))).then(v => v.join(' · '));
/**
 * J3′ (research/145): react-native-web's Modal hears Escape only once it is the active modal — a render after it is
 * drawn, when it takes the role "dialog" and the focus. Under load a press 150ms after the click came before that, was
 * lost, and the open menu then swallowed the next scene's click. Escape waits for it, as a person's reaction would.
 */
async function escapeFrom(p, modal) {
  await p.waitForSelector(byId(modal) + '[role="dialog"]', { state: 'attached', timeout: 5000 }).catch(() => {});
  await p.keyboard.press('Escape');
}
async function tipBelow(p, scene, name, sel) {
  await away(p);
  const b = await moveTo(p, sel), tip = await box(p, byId('icon-tooltip'));
  check(scene, name + ': tip shows on hover', !!tip);
  if (!tip) return;
  check(scene, name + ': tip below the glyph', tip.y >= b.y + b.height - 1, JSON.stringify({ glyph: b, tip }));
  check(scene, name + ': tip not beside it', tip.x < b.x + b.width && tip.x + tip.width > b.x, JSON.stringify({ glyph: b, tip }));
  check(scene, name + ': tip inside the window', tip.x >= 0 && tip.x + tip.width <= 1400, JSON.stringify(tip));
  // REQ-85 ①: centred on the glyph — or, where that would run past the window, kept 8px inside it.
  const off = Math.abs((tip.x + tip.width / 2) - (b.x + b.width / 2)), edge = Math.abs(tip.x + tip.width - 1392) <= 1 || Math.abs(tip.x - 8) <= 1;
  check(scene, name + ': REQ-85 tip centred on the glyph', off <= 1.5 || edge, JSON.stringify({ glyph: b, tip, off }));
}
/** REQ-85 ②: an "on" glyph — the main colour's tint behind it, the glyph in the main colour, no line. */
async function onLook(p, scene, name, sel, c, onto) {
  const s = await style(p, sel, ['backgroundColor', 'borderTopWidth', 'borderTopColor']), glyph = await style(p, sel + ' [data-icon-glyph]', ['color']);
  const tint = selectedTint(c, onto), bg = rgb(s.backgroundColor);
  check(scene, name + ': REQ-85 tinted', bg === tint.toLowerCase(), bg + ' want ' + tint);
  check(scene, name + ': REQ-85 no line', s.borderTopWidth === '0px' || /rgba\(0, 0, 0, 0\)|transparent/.test(s.borderTopColor), JSON.stringify(s));
  check(scene, name + ': REQ-85 glyph in the main colour, 3:1 on the tint', rgb(glyph.color) === selectedLine(c, tint).toLowerCase() && contrast(rgb(glyph.color), tint) >= 3,
    rgb(glyph.color) + ' ' + contrast(rgb(glyph.color), tint).toFixed(2));
}

const envFile = process.env.KANBAN_CHROMIUM_ENV ?? path.join(root, 'spike/plugin-hello/scripts/chromium-env.sh');
const extra = fs.existsSync(envFile) ? Object.fromEntries(execFileSync('/bin/sh', ['-c', '. "$1"; printf "%s\n%s" "$LD_LIBRARY_PATH" "$FONTCONFIG_FILE"',
  'chromium-env', envFile], { encoding: 'utf8' }).split('\n').map((value, i) => [['LD_LIBRARY_PATH', 'FONTCONFIG_FILE'][i], value]).filter(([, v]) => v)) : {};
const browser = await chromium.launch({ headless: true, env: { ...process.env, ...extra }, args: ['--no-sandbox'] });
try {
  // REQ-124: KANBAN_WEB_ONLY=req124 skips every scene before the workflow ones (a gate looking at those alone).
  // REQ-138: =req138 only the hidden empty boards (research/318), a bundle of its own like req125u1.
  // REQ-125 U1 (research/301): =req125u1 only the rows of 건 of a /2 definition — a bundle of its own, run with the others for all of it.
  // REQ-126: =early runs only those earlier scenes, =req126 only the model-name ones — the whole run is longer than ten minutes,
  // so it can be run in two parts (early, then req124) that together are all of it. REQ-127: =req127 only the board screen's
  // workflow switch (part of req124's half too).
  // v0.1.46-B: =v0146b only the request sheet's fallback scenes (part of early's half).
  // D47: =d47 only the wide detail's assignee rows in every state (the matrix below 236-D5's scenes), which req124's half no
  // longer runs — early, req124 and d47 together are all of it.
  // REQ-130: =req130 only the lead's own state and memo scenes (1920 and 390). REQ-133: =req133 only the lead's five states, their
  // host times and presses, and the list's lead detail — early, req124, d47, req130 and req133 together are all of it. =early1 and
  // =early2 are early's two halves (each under ten minutes): early1, early2, req124, d47, req130 and req133 are all of it too.
  // REQ-134: =req134 only the phone's workflow sheet and message list — early1, early2, req124, d47, req130, req133 and req134 are all of it.
  // REQ-135: =req135 the family line. REQ-136: =req136 only the English screen fixes (research/277) — early1, early2, req124, d47, req130,
  // req133, req134, req135 and req136 are all of it.
  const ONLY = process.env.KANBAN_WEB_ONLY ?? '', D47 = ONLY === 'd47', R130 = ONLY === 'req130', R133 = ONLY === 'req133', R134 = ONLY === 'req134', R135 = ONLY === 'req135', R136 = ONLY === 'req136', R137 = ONLY === 'req137', R125 = ONLY === 'req125', R52 = ONLY === 'req52', R125U1 = ONLY === 'req125u1', R125U2 = ONLY === 'req125u2', R125U3 = ONLY === 'req125u3', R125U4 = ONLY === 'req125u4', R138 = ONLY === 'req138', R139 = ONLY === 'req139', R142 = ONLY === 'req142';
  const E1 = ONLY === 'early1', E2 = ONLY === 'early2', EARLY = ONLY === 'early' || E1 || E2;
  // Helpers the early scenes share across its two halves (=early1, =early2).
  const label = t => `[aria-label="${t}"]`;
  const lead = rId('Lead card');
  const slot = id => byId('linked-card-' + id);
  const ringed = p => p.locator(byId('family-highlight')).evaluateAll(els => els.map(e => e.parentElement.querySelector('[data-testid^="kanban-card-"]')?.getAttribute('aria-label')));
  const markOf = t => label(t) + ' ' + byId('family-mark');
  const moveCalls = p => p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').map(v => v.input.operations));
  const sId = title => st.cards.find(c => c.title === title).id;
  const writesOf = p => p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').map(v => v.input));
  const seqOf = revision => Number(String(revision).split(':')[1]);
  // The heading's words (its accessible name), without the pencil the mouse shows beside them.
  const titleOf = async p => (await p.locator(byId('detail-title')).first().getAttribute('aria-label')).replace(/^Edit title: /, '');
  const longPress = async (p, sel) => {
    const b = await box(p, sel), cdp = await p.context().newCDPSession(p), [x, y] = center(b).map(Math.round);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await p.waitForTimeout(900);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await p.waitForTimeout(400);
  };
  if (ONLY !== 'req124' && ONLY !== 'req126' && ONLY !== 'req127' && ONLY !== 'req128' && ONLY !== 'v0146b' && !D47 && !R130 && !R133 && !R134 && !R135 && !R136 && !R137 && !R125 && !R52 && !R125U1 && !R125U2 && !R125U3 && !R125U4 && !R138 && !R139 && !R142 && !E2) {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), scene = `wide-${mode}`, line = selectedLine(c, c.surface0);
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false));
    await p.waitForSelector(byId('swimlane-cell-doing') + ' [data-testid^="kanban-card-"]', { timeout: 15000 });
    check(scene, 'ledger order first', JSON.stringify(await titles(p, byId('swimlane-cell-doing'))) === JSON.stringify(ORDERS.default),
      JSON.stringify(await titles(p, byId('swimlane-cell-doing'))));
    // REQ-81: group by project and sort sit right before the view switch in the title row, not in the filter row.
    const order = await p.locator(byId('swimlane-title-row') + ' [data-testid="group-toggle"], ' + byId('swimlane-title-row') + ' [data-testid="sort-menu"], '
      + byId('swimlane-title-row') + ' [data-testid="view-switch"]').evaluateAll(els => els.map(e => [e.dataset.testid, e.getBoundingClientRect().x]));
    check(scene, 'REQ-81 group, sort, view switch left to right', order.map(v => v[0]).join() === 'group-toggle,sort-menu,view-switch'
      && order[0][1] < order[1][1] && order[1][1] < order[2][1], JSON.stringify(order));
    check(scene, 'REQ-81 nothing but the search in the filter row tools', (await p.locator(byId('swimlane-filters') + ' ' + byId('group-toggle')).count()) === 0);
    // REQ-80: hover fill on every tool glyph, tips below.
    for (const [name, sel, base] of [['refresh', '[aria-label="Refresh"]', c.surface2], ['group', byId('group-toggle'), c.surface0],
      ['sort', byId('sort-menu'), c.surface0], ['list view', byId('view-list'), c.surface0], ['settings', byId('open-settings'), c.surface2]]) {
      await away(p);
      const rest = rgb((await style(p, sel, ['backgroundColor'])).backgroundColor);
      await moveTo(p, sel);
      const hovered = rgb((await style(p, sel, ['backgroundColor'])).backgroundColor);
      check(scene, `REQ-80 ${name}: hover fill`, hovered === hoverFill(c, base) && hovered !== rest, `${rest} → ${hovered}, want ${hoverFill(c, base)}`);
      // research/121 H2: the change is plain to see — 1.6:1 against the glyph's resting fill and against the page.
      check(scene, `H2 ${name}: hover stands 1.6:1 apart`, contrast(hovered, base) >= 1.6 && contrast(hovered, c.surface0) >= 1.6,
        `${contrast(hovered, base).toFixed(2)} / ${contrast(hovered, c.surface0).toFixed(2)}`);
      await tipBelow(p, scene, 'REQ-80 ' + name, sel);
    }
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    // REQ-79: open the menu with the mouse, choose, and the cell re-sorts at once.
    await clickAt(p, byId('sort-menu'));
    check(scene, 'REQ-79 a click opens the menu', await visible(p, byId('sort-menu-list')));
    check(scene, 'REQ-80 a click leaves no tip behind', !(await visible(p, byId('icon-tooltip'))));
    const menu = await box(p, byId('sort-menu-list')), trigger = await box(p, byId('sort-menu'));
    check(scene, 'REQ-79 the menu opens under the glyph', menu && menu.y >= trigger.y + trigger.height, JSON.stringify({ menu, trigger }));
    check(scene, 'REQ-79 and ends at its right edge', menu && Math.abs(menu.x + menu.width - (trigger.x + trigger.width)) <= 1, JSON.stringify({ menu, trigger }));
    await moveTo(p, byId('sort-option-updated'));
    await p.screenshot({ path: path.join(out, `${scene}-menu.png`) });
    const optionHover = rgb((await style(p, byId('sort-option-updated'), ['backgroundColor'])).backgroundColor);
    check(scene, 'REQ-80 a menu row takes the hover fill', optionHover === hoverFill(c, c.surface1), optionHover);
    await clickAt(p, byId('sort-option-updated'));
    check(scene, 'REQ-79 choosing closes the menu', !(await visible(p, byId('sort-menu-list'))));
    check(scene, 'REQ-79 latest change first', JSON.stringify(await titles(p, byId('swimlane-cell-doing'))) === JSON.stringify(ORDERS.updated),
      JSON.stringify(await titles(p, byId('swimlane-cell-doing'))));
    const writes = await p.evaluate(() => window.__writes);
    check(scene, 'REQ-79 one settings write', JSON.stringify(writes) === JSON.stringify([{ hostId: 'host_example', settings: { cardOrder: 'updated' } }]), JSON.stringify(writes));
    await away(p);
    await onLook(p, scene, 'sort on', byId('sort-menu'), c, c.surface0);
    // REQ-85 ③ (③B): the chosen row of the menu is tinted only.
    await clickAt(p, byId('sort-menu'));
    const row = await style(p, byId('sort-option-updated'), ['backgroundColor', 'borderTopWidth']);
    check(scene, 'REQ-85 ③ chosen menu row: tint only', rgb(row.backgroundColor) === selectedTint(c, c.surface1).toLowerCase() && row.borderTopWidth === '0px', JSON.stringify(row));
    await escapeFrom(p, 'sort-menu-modal'); await p.waitForTimeout(200); await away(p);
    // Keyboard: Tab onto the glyph shows its tip; Enter opens; Escape closes and focus comes back.
    await p.locator(byId('group-toggle')).focus();
    await p.keyboard.press('Tab');
    await p.waitForTimeout(120);
    const focused = await p.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    check(scene, 'keyboard: Tab from group lands on sort', focused === 'sort-menu', focused);
    check(scene, 'REQ-80 keyboard focus shows the tip', await visible(p, byId('icon-tooltip')));
    await p.keyboard.press('Enter'); await p.waitForTimeout(150);
    check(scene, 'keyboard: Enter opens the menu', await visible(p, byId('sort-menu-list')));
    await escapeFrom(p, 'sort-menu-modal'); await p.waitForTimeout(200);
    check(scene, 'keyboard: Escape closes it', !(await visible(p, byId('sort-menu-list'))));
    check(scene, 'keyboard: focus back on the glyph', await p.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'sort-menu',
      await p.evaluate(() => document.activeElement?.getAttribute('data-testid')));
    check(scene, 'keyboard: Escape wrote nothing', (await p.evaluate(() => window.__writes.length)) === 1);
    // Group by project: a click turns it on (line), and leaves no tip.
    await clickAt(p, byId('group-toggle'));
    check(scene, 'REQ-80 group click leaves no tip', !(await visible(p, byId('icon-tooltip'))));
    // REQ-85 ②: under the mouse an "on" glyph deepens its tint — never the grey of hover, which stays for "off" glyphs.
    const hot = rgb((await style(p, byId('group-toggle'), ['backgroundColor'])).backgroundColor);
    check(scene, 'REQ-85 ② hovered while on: a deeper tint, not grey', hot === selectedTint(c, c.surface0, true).toLowerCase() && hot !== hoverFill(c, c.surface0).toLowerCase(), hot);
    await away(p);
    await onLook(p, scene, 'group on', byId('group-toggle'), c, c.surface0);
    await onLook(p, scene, 'current view', byId('view-swimlane'), c, c.surface0);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-sorted.png`) });
    // The lane name's tip: below, gone after a press.
    await clickAt(p, byId('group-toggle'));
    await away(p);
    const name = await moveTo(p, byId('workspace-name-link')), nameTip = await box(p, byId('lane-name-tooltip'));
    check(scene, 'REQ-80 lane name tip below the name', nameTip && nameTip.y >= name.y + name.height - 1, JSON.stringify({ name, nameTip }));
    // research/121 F1: the window made just short enough that the last lane's glyphs sit right above the bottom of the board —
    // room below in the window, none in the board. Their tips go above and stay inside the board, so nothing is cut.
    await away(p);
    const lastToggle = p.locator(byId('lane-toggle')).last(), lastName = p.locator(byId('workspace-name-link')).last();
    const before = await lastToggle.boundingBox(), board0 = await box(p, byId('swimlane-vertical'));
    await p.setViewportSize({ width: 1400, height: Math.round(900 - (board0.y + board0.height - (before.y + before.height + 22))) });
    await p.waitForTimeout(250);
    const viewport = p.viewportSize(), board = await box(p, byId('swimlane-vertical')), glyph = await lastToggle.boundingBox();
    const bottom = board.y + board.height, need = 4 + 22 + 8;
    check(scene, 'F1 setup: the glyph is inside the board, too near its bottom for a tip below', glyph.y + glyph.height <= bottom
      && glyph.y + glyph.height + need > bottom && glyph.y + glyph.height + need <= viewport.height, JSON.stringify({ glyph, bottom, viewport }));
    await p.mouse.move(...center(glyph), { steps: 6 }); await p.waitForTimeout(160);
    const lowTip = await box(p, byId('icon-tooltip'));
    check(scene, 'F1 lane ⇕ tip at the bottom of the board: above the glyph', lowTip && lowTip.y + lowTip.height <= glyph.y + 1, JSON.stringify({ glyph, lowTip }));
    check(scene, 'F1 lane ⇕ tip: whole inside the board', lowTip && lowTip.y >= board.y && lowTip.y + lowTip.height <= bottom, JSON.stringify({ board, lowTip }));
    await p.screenshot({ path: path.join(out, `${scene}-f1-lane-tip.png`) });
    await p.mouse.move(board.x + 4, board.y + 4, { steps: 4 }); await p.waitForTimeout(120);
    const lowName = await lastName.boundingBox();
    await p.mouse.move(lowName.x + 6, lowName.y + lowName.height / 2, { steps: 6 }); await p.waitForTimeout(160);
    const lowNameTip = await box(p, byId('lane-name-tooltip'));
    check(scene, 'F1 lane name tip at the bottom of the board: above, inside it', lowNameTip && lowNameTip.y + lowNameTip.height <= lowName.y + 1
      && lowNameTip.y >= board.y, JSON.stringify({ lowName, lowNameTip, board }));
    await p.mouse.move(board.x + 4, board.y + 4, { steps: 4 }); await p.waitForTimeout(120);
    // The title row's tips are outside the board: still below, by the window alone.
    await tipBelow(p, scene, 'F1 short window: title row settings', byId('open-settings'));
    await p.setViewportSize({ width: 1400, height: 900 }); await p.waitForTimeout(250);
    // The workspace board follows the same order and has its own sort glyph.
    await clickAt(p, byId('workspace-name-link'));
    await p.waitForSelector(byId('board-cell-doing') + ' [data-testid^="kanban-card-"]', { timeout: 10000 });
    const boardTitles = await titles(p, byId('board-cell-doing'));
    check(scene, 'REQ-79 the board follows the order', JSON.stringify(boardTitles) === JSON.stringify([...ORDERS.updated, 'Card one']), JSON.stringify(boardTitles));
    await tipBelow(p, scene, 'REQ-80 board sort', byId('sort-menu'));
    await clickAt(p, byId('sort-menu'));
    await clickAt(p, byId('sort-option-created'));
    check(scene, 'REQ-79 newest first on the board', JSON.stringify(await titles(p, byId('board-cell-doing'))) === JSON.stringify([...ORDERS.created, 'Card one']),
      JSON.stringify(await titles(p, byId('board-cell-doing'))));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-board.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // 390px: the filter sheet's first rows, tapped.
  for (const mode of ['light', 'dark']) {
    const scene = `phone-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true));
    await p.waitForSelector('[data-testid^="kanban-card-"]', { timeout: 15000 });
    const phoneTitles = () => p.locator('[data-testid^="mobile-workspace-board_1"] [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    const first = await phoneTitles();
    check(scene, 'ledger order first', JSON.stringify(first.slice(0, 3)) === JSON.stringify(ORDERS.default), JSON.stringify(first));
    check(scene, 'no sort glyph in the top bar', (await p.locator(byId('sort-menu')).count()) === 0);
    await p.locator(byId('open-filters')).first().tap(); await p.waitForTimeout(300);
    const rows = await p.locator(byId('swimlane-filters') + ' > *').evaluateAll(els => els.slice(0, 3).map(e => e.dataset.testid));
    check(scene, 'REQ-81/85 group row, fold row, then sort row', rows.join() === 'group-toggle-row,fold-all-row,sort-choice-row', rows.join());
    const fold = await box(p, byId('fold-all'));
    check(scene, 'REQ-85 ⑦ fold buttons are 44px', fold && fold.height >= 44, JSON.stringify(fold));
    const choice = await box(p, byId('sort-choice-created'));
    check(scene, '44px choices', choice && choice.height >= 44, JSON.stringify(choice));
    await p.locator(byId('sort-choice-created')).tap(); await p.waitForTimeout(200);
    const chosen = await style(p, byId('sort-choice-created'), ['backgroundColor']);
    check(scene, 'REQ-85 ③ chosen: tint only', rgb(chosen.backgroundColor) === selectedTint(c, c.surface1).toLowerCase(), JSON.stringify(chosen));
    await p.screenshot({ path: path.join(out, `${scene}-sheet.png`) });
    await p.locator(byId('menu-sheet-backdrop')).first().tap({ position: { x: 20, y: 20 } }); await p.waitForTimeout(400);
    const after = await phoneTitles();
    check(scene, 'REQ-79 newest first on the phone', JSON.stringify(after.slice(0, 3)) === JSON.stringify(ORDERS.created), JSON.stringify(after));
    check(scene, 'one write', JSON.stringify(await p.evaluate(() => window.__writes)) === JSON.stringify([{ hostId: 'host_example', settings: { cardOrder: 'created' } }]));
    // REQ-85 ⑦: "Fold all" from the sheet, tapped; the cards go; "Expand all" brings them back.
    await p.locator(byId('open-filters')).first().tap(); await p.waitForTimeout(300);
    await p.locator(byId('fold-all')).first().tap(); await p.waitForTimeout(200);
    await p.locator(byId('menu-sheet-backdrop')).first().tap({ position: { x: 20, y: 20 } }); await p.waitForTimeout(400);
    check(scene, 'REQ-85 ⑦ fold all on the phone', (await phoneTitles()).length === 0, JSON.stringify(await phoneTitles()));
    await p.locator(byId('open-filters')).first().tap(); await p.waitForTimeout(300);
    await p.locator(byId('open-all')).first().tap(); await p.waitForTimeout(200);
    await p.locator(byId('menu-sheet-backdrop')).first().tap({ position: { x: 20, y: 20 } }); await p.waitForTimeout(400);
    check(scene, 'REQ-85 ⑦ expand all on the phone', (await phoneTitles()).length >= 3, JSON.stringify(await phoneTitles()));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-85: fold all, card hints, the ⋯ menu with the card id, the card just seen — by the mouse and the keyboard ----
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), scene = `req85-wide-${mode}`;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const p = await context.newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false));
    await p.waitForSelector(byId('swimlane-cell-doing') + ' [data-testid^="kanban-card-"]', { timeout: 15000 });
    await p.waitForSelector('[data-testid="card-signal-press"]', { timeout: 10000 });
    // ⑦ fold every workspace from the title row, then open them again from the same glyph.
    const cells = () => p.locator(byId('swimlane-cells')).count();
    check(scene, '⑦ both workspaces open', await cells() === 2, String(await cells()));
    await tipBelow(p, scene, '⑦ fold all tip', byId('fold-all'));
    await clickAt(p, byId('fold-all'));
    check(scene, '⑦ a click folds every workspace', await cells() === 0, String(await cells()));
    check(scene, '⑦ the glyph now opens them', await p.locator(byId('fold-all')).getAttribute('aria-label') === 'Expand all workspaces');
    await clickAt(p, byId('fold-all'));
    check(scene, '⑦ and a second click opens them all', await cells() === 2, String(await cells()));
    await away(p);
    // ⑥ each element of the long card says what it is under the mouse, below it.
    const long = '[aria-label="' + LONG + '"]';
    const mark = await moveTo(p, long + ' ' + byId('card-signal-press'));
    const stateHint = await box(p, byId('card-hint-state'));
    check(scene, '⑥ the state mark says its state', stateHint && (await p.locator(byId('card-hint-state')).innerText()) === 'Working');
    check(scene, '⑥ below the mark', stateHint && stateHint.y >= mark.y + mark.height - 1, JSON.stringify({ mark, stateHint }));
    const agent = await moveTo(p, long + ' ' + byId('card-agent'));
    check(scene, '⑥ the name says the model and provider', (await p.locator(byId('card-hint-model')).count()) === 1
      && (await p.locator(byId('card-hint-model')).innerText()) === 'Opus 5.5 · Claude', await p.locator(byId('card-hint-model')).count() ? await p.locator(byId('card-hint-model')).innerText() : 'none');
    const modelHint = await box(p, byId('card-hint-model'));
    check(scene, '⑥ below the name', modelHint && modelHint.y >= agent.y + agent.height - 1, JSON.stringify({ agent, modelHint }));
    await moveTo(p, long + ' ' + byId('card-title'));
    check(scene, '⑥ a title cut short shows whole', (await p.locator(byId('card-hint-title')).count()) === 1
      && (await p.locator(byId('card-hint-title')).innerText()) === LONG);
    await moveTo(p, '[aria-label="Card one"] ' + byId('card-title'));
    check(scene, '⑥ a title shown whole says nothing', (await p.locator(byId('card-hint-title')).count()) === 0);
    await away(p);
    await moveTo(p, long + ' ' + byId('card-signal-press'));
    await p.screenshot({ path: path.join(out, `${scene}-hint.png`) });
    await away(p);
    // ⑧ the ⋯ menu under the ⋯: stages as they are, a line, "Copy card ID" — copied to the real clipboard.
    const openMenu = async title => { await moveTo(p, '[aria-label="' + title + '"]'); return clickAt(p, '[aria-label="Move to another stage: ' + title + '"]'); };
    const dots = await openMenu('Card one');
    const menu = await box(p, byId('card-menu'));
    check(scene, '⑧ a click opens the menu under the ⋯', menu && menu.y >= dots.y + dots.height - 1 && Math.abs(menu.x + menu.width - (dots.x + dots.width)) <= 1,
      JSON.stringify({ dots, menu }));
    const rows = await p.locator(byId('card-menu') + ' [data-testid]').evaluateAll(els => els.map(e => e.dataset.testid).filter(id => /^(move-to-|menu-divider|copy-card-id)/.test(id)));
    check(scene, '⑧ stages, a line, copy', rows.join() === 'move-to-todo,move-to-doing,move-to-review,move-to-done,menu-divider,copy-card-id', rows.join());
    const current = await style(p, byId('move-to-doing'), ['backgroundColor']);
    check(scene, '⑧ the current stage is tinted', rgb(current.backgroundColor) === selectedTint(c, c.surface1).toLowerCase(), JSON.stringify(current));
    await p.screenshot({ path: path.join(out, `${scene}-menu.png`) });
    await clickAt(p, byId('copy-card-id'));
    const id = cardId('Card one'), clip = await p.evaluate(() => navigator.clipboard.readText());
    check(scene, '⑧ the card id is on the clipboard', clip === id, clip);
    check(scene, '⑧ and the notice says so', (await p.locator(byId('move-toast-text')).innerText()) === 'Card ID copied · ' + id);
    await clickAt(p, byId('move-toast-close'));
    // A host that cannot copy: the id is shown, selectable, until closed.
    await p.evaluate(() => { window.__noClipboard = true; });
    await openMenu('Card one'); await clickAt(p, byId('copy-card-id'));
    const shown = p.locator(byId('move-toast-selectable'));
    check(scene, '⑧ a failed copy shows the id', (await shown.count()) === 1 && (await shown.innerText()) === id);
    check(scene, '⑧ which can be selected', (await shown.evaluate(el => getComputedStyle(el).userSelect)) !== 'none');
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(out, `${scene}-copy-failed.png`) });
    await clickAt(p, byId('move-toast-close'));
    // Escape closes the menu and gives the focus to the card.
    await openMenu('Card two');
    await escapeFrom(p, 'card-menu-modal'); await p.waitForTimeout(250);
    check(scene, '⑧ Escape closes it', !(await visible(p, byId('card-menu'))));
    const focused = await p.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    check(scene, '⑧ the focus is back on the card', focused === 'Card two', focused);
    await away(p);
    // ⑨ the card whose detail was just closed is tinted (no line) until another card is opened.
    const face = title => style(p, '[aria-label="' + title + '"]', ['backgroundColor', 'borderTopWidth']);
    await clickAt(p, '[aria-label="Card three"]');
    await p.waitForSelector(byId('detail-backdrop'), { timeout: 5000 });
    await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }); await p.waitForTimeout(250);
    await away(p);
    // REQ-95 ④: grey, no longer the main colour's tint.
    const seen = await face('Card three'), tint = viewedTint(c, c.card).toLowerCase();
    check(scene, '⑨ the card just seen is tinted (REQ-95 ④ grey)', rgb(seen.backgroundColor) === tint, rgb(seen.backgroundColor) + ' want ' + tint);
    check(scene, '⑨ with no line', (await face('Card three')).borderTopWidth === '0px');
    check(scene, '⑨ the others are not', rgb((await face('Waiting card')).backgroundColor) === c.card.toLowerCase());
    await p.screenshot({ path: path.join(out, `${scene}-seen.png`) });
    await clickAt(p, '[aria-label="Waiting card"]');
    await p.waitForSelector(byId('detail-backdrop'), { timeout: 5000 });
    await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }); await p.waitForTimeout(250);
    await away(p);
    check(scene, '⑨ opening another card moves it', rgb((await face('Card three')).backgroundColor) === c.card.toLowerCase()
      && rgb((await face('Waiting card')).backgroundColor) === tint);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  // ---- REQ-93 (replacing REQ-76's gathering and REQ-89's lines): sub-cards in their own columns; C′ by real input ----
  for (const mode of ['light', 'dark']) {
    const scene = `req93-wide-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'refs'));
    await p.waitForSelector(slot(lead), { timeout: 15000 });
    const lane = p.locator(byId('swimlane-lane-section')).filter({ has: p.locator(slot(lead)) });
    const cellTitles = stageId => lane.locator(byId('swimlane-cell-' + stageId) + ' [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, '① the running sub-cards are in the In progress column', JSON.stringify(await cellTitles('doing')) === JSON.stringify(['Helper one', 'Helper three']),
      JSON.stringify(await cellTitles('doing')));
    check(scene, '① the waiting one waits in To Do, the parent alone in Review', JSON.stringify(await cellTitles('todo')) === JSON.stringify(['Helper two', 'Plain waiting'])
      && JSON.stringify(await cellTitles('review')) === JSON.stringify(['Lead card']), JSON.stringify([await cellTitles('todo'), await cellTitles('review')]));
    const heads = (await lane.locator(byId('lane-stage-headers')).innerText()).replace(/\s+/g, ' ');
    // REQ-113: the To Do heading ends in "+" (the page's glyph stand-in draws its first letter, "P").
    check(scene, '① the headings count every card, no "(+sub n)"', /To Do 2 (P )?In progress 2 Review 1 Done 0/.test(heads) && !/sub/.test(heads), heads);
    check(scene, '① no reference line, no fold line', (await p.locator('[data-testid^="sub-ref-"]').count()) === 0 && (await p.locator(byId('card-group-toggle')).count()) === 0);
    // The mark over the title: "↳" (an icon) and the parent's short name, inside the card, above its title.
    const mark = p.locator(markOf('Helper one')).first(), title = p.locator(label('Helper one') + ' ' + byId('card-title')).first();
    const mb = await mark.boundingBox(), tb = await title.boundingBox(), cb = await p.locator(label('Helper one')).first().boundingBox();
    check(scene, '① the mark says the parent, over the title, inside the card', (await mark.innerText()).includes('Lead card')
      && (await mark.locator('[data-icon="CornerDownRight"]').count()) === 1 && mb.y + mb.height <= tb.y + 1 && mb.y >= cb.y && mb.height >= 15,
      JSON.stringify({ text: await mark.innerText(), mb, tb, cb }));
    const summary = p.locator(slot(lead) + ' ' + byId('family-summary'));
    check(scene, '① the parent says its sub-cards in one line', (await summary.textContent()).includes('Sub-cards 3·not done 3'), await summary.textContent());
    // REQ-99: that line is inside the parent card's box — no longer a line under the card; REQ-104: over its status row, the last.
    const lastRow = await p.locator(label('Lead card') + ' ' + byId('card-content') + ' > ' + byId('family-summary')).evaluateAll(els => els.map(e =>
      e.nextElementSibling === e.parentElement.lastElementChild && e.nextElementSibling.getAttribute('data-testid') === 'lead-status'));
    const sumBox = await summary.boundingBox(), leadBox = await box(p, label('Lead card'));
    check(scene, 'REQ-99 the summary is inside the parent card, over its status row (REQ-104)', JSON.stringify(lastRow) === '[true]'
      && sumBox.y >= leadBox.y && sumBox.y + sumBox.height <= leadBox.y + leadBox.height, JSON.stringify({ lastRow, sumBox, leadBox }));
    // REQ-105 (replacing REQ-95 ①'s stage-coloured edge): the parent's edge is plain grey, not its stage's colour — ≥3:1.
    const edgeOf = async t => rgb((await style(p, label(t) + ' ' + byId('card-content'), ['borderTopColor'])).borderTopColor);
    const panel = rgb((await style(p, byId('swimlane-cell-review'), ['backgroundColor'])).backgroundColor);
    const leadEdge = await edgeOf('Lead card');
    check(scene, 'REQ-105 the parent\'s 1px edge is plain grey, not its stage\'s colour', leadEdge === leaderOutline(c, c.card).toLowerCase()
      && (await style(p, label('Lead card') + ' ' + byId('card-content'), ['borderTopWidth'])).borderTopWidth === '1px', leadEdge);
    check(scene, 'REQ-105 3:1 on the card and on the column', contrast(leadEdge, c.card) >= 3 && contrast(leadEdge, panel) >= 3,
      JSON.stringify({ card: contrast(leadEdge, c.card).toFixed(2), panel: contrast(leadEdge, panel).toFixed(2) }));
    check(scene, 'REQ-106: a filled gold crown before the lead\'s title only, no line crown',
      (await p.locator(label('Lead card') + ' ' + byId('card-leader') + ' ' + byId('card-leader-filled')).count()) === 1
      && (await p.locator(label('Lead card') + ' ' + byId('card-leader') + ' [data-icon="Crown"]').count()) === 0
      && (await p.locator(byId('card-leader')).count()) === 1);
    check(scene, 'REQ-95 ① other cards keep the plain border', (await edgeOf('Helper one')) === c.border.toLowerCase() && (await edgeOf('Plain waiting')) === c.border.toLowerCase());
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    // C′ by the mouse: the mark highlights the family, the other cards of the lane step back.
    await clickAt(p, markOf('Helper one'));
    const family = ['Helper two', 'Helper one', 'Helper three', 'Lead card'];
    check(scene, 'C′ a click on the mark rings the parent and every sub-card', JSON.stringify(await ringed(p)) === JSON.stringify(family), JSON.stringify(await ringed(p)));
    check(scene, 'C′ it opens no detail', (await p.locator(byId('detail-backdrop')).count()) === 0);
    const dim = Number((await style(p, slot(rId('Plain waiting')), ['opacity'])).opacity);
    check(scene, 'C′ the rest of the board steps back', dim > .4 && dim < .5 && Number((await style(p, slot(rId('Helper one')), ['opacity'])).opacity) === 1, String(dim));
    check(scene, 'C′ the mark and the summary say they are on', await mark.getAttribute('aria-pressed') === 'true' && await p.locator(slot(lead) + ' ' + byId('family-summary-all')).getAttribute('aria-pressed') === 'true');
    const ringColor = rgb((await style(p, byId('family-highlight'), ['borderTopColor'])).borderTopColor);
    const ring = await box(p, slot(lead) + ' ' + byId('family-highlight')), card = await box(p, label('Lead card'));
    check(scene, 'C′ the ring: the main colour, 2px out from the card', ringColor === selectedLine(c, c.panel).toLowerCase() && Math.abs(card.x - ring.x - 4) <= 1,
      JSON.stringify({ ringColor, ring, card }));
    check(scene, 'REQ-99 the ring goes round the card alone', Math.abs(ring.y + ring.height - (card.y + card.height) - 4) <= 1, JSON.stringify({ ring, card }));
    check(scene, 'REQ-95 the stage edge stays under the ring', (await edgeOf('Lead card')) === leadEdge);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-lit.png`) });
    await clickAt(p, markOf('Helper one'));
    check(scene, 'C′ a second click on the mark ends it', (await ringed(p)).length === 0 && Number((await style(p, slot(rId('Plain waiting')), ['opacity'])).opacity) === 1);
    const gets = () => p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.card.get').length), got = await gets();
    await clickAt(p, slot(lead) + ' ' + byId('family-summary-all'));
    check(scene, 'C′ the summary line does the same', JSON.stringify(await ringed(p)) === JSON.stringify(family), JSON.stringify(await ringed(p)));
    check(scene, 'REQ-99 a click on the summary opens no detail', (await p.locator(byId('detail-backdrop')).count()) === 0
      && (await gets()) === got);
    // 보완: looking for the family keeps it — the wheel scrolls, a click on another card opens that card.
    await p.mouse.move(700, 500, { steps: 4 }); await p.mouse.wheel(0, 160); await p.waitForTimeout(250); await p.mouse.wheel(0, -160); await p.waitForTimeout(250);
    check(scene, 'C′ 보완 scrolling keeps it', (await ringed(p)).length === 4, JSON.stringify(await ringed(p)));
    await clickAt(p, label('Plain waiting'));
    await p.waitForSelector(byId('detail-backdrop'), { timeout: 5000 }).catch(() => {});
    check(scene, 'C′ 보완 a click on a card opens it and keeps it', (await p.locator(byId('detail-backdrop')).count()) > 0 && (await ringed(p)).length === 4,
      JSON.stringify(await ringed(p)));
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    if (await p.locator(byId('detail-backdrop')).count()) { await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }); await p.waitForTimeout(250); }
    if ((await ringed(p)).length === 0) await clickAt(p, slot(lead) + ' ' + byId('family-summary-all'));
    // A click anywhere else — an empty stretch of the Done column — ends it.
    const empty = await lane.locator(byId('swimlane-cell-done')).first().boundingBox();
    await p.mouse.move(empty.x + empty.width / 2, empty.y + empty.height - 10, { steps: 4 }); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(200);
    check(scene, 'C′ a click elsewhere ends it', (await ringed(p)).length === 0, JSON.stringify(empty));
    // The keyboard: the mark is a button of its own; Enter turns it on and off, and never opens the card.
    await p.locator(markOf('Helper three')).first().focus();
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    check(scene, 'C′ keyboard: Enter on the mark rings the family', (await ringed(p)).length === 4 && (await p.locator(byId('detail-backdrop')).count()) === 0);
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    check(scene, 'C′ keyboard: Enter again ends it', (await ringed(p)).length === 0);
    // A sub-card is a card: a click opens its own detail; its ⋯ moves it on its own.
    await away(p);
    await clickAt(p, label('Helper three'));
    const asked = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.card.get').map(v => v.input.cardId));
    check(scene, 'a click on the sub-card opens its detail', asked.at(-1) === rId('Helper three'), JSON.stringify(asked));
    await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }); await p.waitForTimeout(250);
    await moveTo(p, label('Helper one'));
    await clickAt(p, label('Move to another stage: Helper one'));
    await p.waitForSelector(byId('move-to-review'), { timeout: 5000 });
    await clickAt(p, byId('move-to-review')); await p.waitForTimeout(300);
    check(scene, 'the move is the sub-card\'s own', JSON.stringify((await moveCalls(p)).at(-1)) === JSON.stringify([{ op: 'move', id: rId('Helper one'), to: 'review' }]));
    check(scene, 'and it is drawn in its new column, still marked', JSON.stringify(await cellTitles('review')) === JSON.stringify(['Lead card', 'Helper one'])
      && (await p.locator(markOf('Helper one')).count()) === 1, JSON.stringify(await cellTitles('review')));
    // The workspace board: the same, and C′ there.
    await p.keyboard.press('Escape'); await away(p);
    const name = lane.locator(byId('workspace-name-link')).first(), nameBox = await name.boundingBox();
    await p.mouse.move(...center(nameBox), { steps: 4 }); await p.mouse.down(); await p.mouse.up();
    await p.waitForSelector(byId('board-cell-review') + ' ' + slot(lead), { timeout: 10000 }).catch(() => {});
    const boardDoing = await p.locator(byId('board-cell-doing') + ' [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, 'the board: the running sub-card in In progress', boardDoing.includes('Helper three'), JSON.stringify(boardDoing));
    if (await p.locator(byId('board-cell-review') + ' ' + byId('family-summary-all')).count()) {
      await clickAt(p, byId('board-cell-review') + ' ' + byId('family-summary-all'));
      check(scene, 'the board: the summary rings the family', (await ringed(p)).length === 4, JSON.stringify(await ringed(p)));
      await away(p);
      await p.screenshot({ path: path.join(out, `${scene}-board.png`) });
    } else check(scene, 'the board: the summary rings the family', false, 'no summary on the board');
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const mode of ['light', 'dark']) {
    const scene = `req93-phone-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'refs'));
    await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 });
    const tab = id => p.locator(byId('mobile-tab-' + id)).first();
    const labels = await Promise.all(['todo', 'doing', 'review', 'done'].map(id => tab(id).getAttribute('aria-label')));
    check(scene, 'the tabs count every card, sub-cards too', JSON.stringify(labels) === JSON.stringify(['To Do 3', 'In progress 6', 'Review 1', 'Done 0']),
      JSON.stringify(labels));
    check(scene, 'no "+n" beside a tab', (await p.locator(byId('mobile-tab-sub')).count()) === 0);
    const section = p.locator(byId('mobile-workspace-' + r.id));
    const shown = await section.locator('[data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, 'the In progress tab shows the running sub-cards themselves', JSON.stringify(shown) === JSON.stringify(['Helper one', 'Helper three']), JSON.stringify(shown));
    const mark = section.locator(markOf('Helper one')).first(), mb = await mark.boundingBox();
    check(scene, 'the mark is drawn, 16px tall at least', mb && mb.height >= 15, JSON.stringify(mb));
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    await mark.tap(); await p.waitForTimeout(300);
    check(scene, 'C′ a tap on the mark rings this tab\'s part of the family', JSON.stringify(await ringed(p)) === JSON.stringify(['Helper one', 'Helper three']),
      JSON.stringify(await ringed(p)));
    check(scene, 'C′ it opens no detail', (await p.locator(byId('editor-sheet')).count()) === 0);
    await p.screenshot({ path: path.join(out, `${scene}-lit.png`) });
    await mark.tap(); await p.waitForTimeout(300);
    check(scene, 'C′ a second tap ends it', (await ringed(p)).length === 0);
    await mark.tap(); await p.waitForTimeout(300);
    const title = await p.locator(byId('mobile-appbar')).first().boundingBox();
    await p.touchscreen.tap(title.x + 30, title.y + title.height / 2); await p.waitForTimeout(300);
    check(scene, 'C′ a tap elsewhere ends it', (await ringed(p)).length === 0);
    await tab('review').tap(); await p.waitForTimeout(300);
    // REQ-109: the line holds two presses; "Sub-cards N" is the family's.
    const line = p.locator(slot(lead) + ' ' + byId('family-summary')).first();
    const summary = p.locator(slot(lead) + ' ' + byId('family-summary-all')).first(), sb = await summary.boundingBox();
    // REQ-104: the status row under it takes half the gap: 6 over, 16, 3 under.
    check(scene, 'the parent\'s summary is a 25px press', sb && sb.height >= 25 && (await line.textContent()).includes('Sub-cards 3·not done 3'), JSON.stringify(sb));
    await summary.tap(); await p.waitForTimeout(300);
    check(scene, 'C′ a tap on the summary rings the parent', JSON.stringify(await ringed(p)) === JSON.stringify(['Lead card']), JSON.stringify(await ringed(p)));
    check(scene, 'REQ-99 the summary is over the card\'s status row, the last (REQ-104); a tap on it opens no detail', (await p.locator(byId('editor-sheet')).count()) === 0
      && JSON.stringify(await p.locator(slot(lead) + ' ' + byId('card-content') + ' > ' + byId('family-summary')).evaluateAll(els => els.map(e =>
        e.nextElementSibling === e.parentElement.lastElementChild && e.nextElementSibling.getAttribute('data-testid') === 'lead-status'))) === '[true]');
    await p.screenshot({ path: path.join(out, `${scene}-summary.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  // ---- REQ-104: a lead's status row — what it waits for; a click or a tap on a part rings its cards ----------------
  for (const mode of ['light', 'dark']) {
    const scene = `req104-wide-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'status'));
    // REQ-135: the sub-cards' parts are on the family line (`fam`), the row is the lead's own state.
    const lead = slot(sId(S_TITLE)), row = lead + ' ' + byId('lead-status'), fam = lead + ' ' + byId('family-summary');
    await p.waitForSelector(fam + ' ' + byId('lead-status-running'), { timeout: 15000 }).catch(() => {});
    // The page's Icon stand-in draws its name's first letter: the clock's "C" is not part of the words.
    const words = async sel => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim().replace(/^C /, '');
    // REQ-130: every lead's row starts with its own state — here its agent resting since its last activity (KST).
    const resting = 'Idle · since ' + deviceClock(S_ACTIVE, Date.now());
    check(scene, 'the lead says what it waits for (REQ-135: its own state on the row, its sub-cards\' parts on the family line)', await words(row) === resting
      && await spokenParts(p, fam) === 'Running 1 · Needs you 1 · Testing ' + S_CHECK() + '~', await words(row) + ' / ' + await spokenParts(p, fam));
    check(scene, 'the quiet lead: idle, and when its agent was last active (KST)',
      await words(slot(sId('Quiet lead')) + ' ' + byId('lead-status')) === resting, await words(slot(sId('Quiet lead')) + ' ' + byId('lead-status')));
    check(scene, 'research/166 J3 the busy lead: working (REQ-130: at work already when the screen opened — no start to time)',
      await words(slot(sId('Busy lead')) + ' ' + byId('lead-status')) === 'Lead working',
      await words(slot(sId('Busy lead')) + ' ' + byId('lead-status')));
    check(scene, 'D43 the asking lead: awaiting you, not idle (REQ-130: your turn, since its last activity)',
      /^Needs your answer · \d+m$/.test(await words(slot(sId('Asking lead')) + ' ' + byId('lead-status'))), await words(slot(sId('Asking lead')) + ' ' + byId('lead-status')));
    check(scene, 'on the leads alone', (await p.locator(byId('lead-status')).count()) === 4);
    const rb = await box(p, row), cb = await box(p, label(S_TITLE)), sb = await box(p, lead + ' ' + byId('family-summary'));
    check(scene, 'the last row, under the family line, inside the card', rb.y >= sb.y + sb.height - 1 && rb.y + rb.height <= cb.y + cb.height - 9
      && JSON.stringify(await p.locator(label(S_TITLE) + ' ' + byId('card-content') + ' > ' + byId('lead-status')).evaluateAll(els => els.map(e => e.parentElement.lastElementChild === e))) === '[true]',
      JSON.stringify({ rb, sb, cb }));
    check(scene, 'REQ-130 its own state leads it, in the clock\'s place', (await p.locator(row + ' [data-icon="Clock"]').count()) === 0
      && (await p.locator(row + ' ' + byId('lead-status-me-rest')).count()) === 1);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    const gets = () => p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.card.get').length), got = await gets();
    const lit = async (kind, want) => {
      await clickAt(p, fam + ' ' + byId('lead-status-' + kind));
      check(scene, 'a click on "' + kind + '" rings the lead and its cards', JSON.stringify(await ringed(p)) === JSON.stringify(want), JSON.stringify(await ringed(p)));
      check(scene, '"' + kind + '" is on and opens no detail', (await p.locator(fam + ' ' + byId('lead-status-' + kind)).getAttribute('aria-pressed')) === 'true'
        && (await p.locator(byId('detail-backdrop')).count()) === 0 && (await gets()) === got);
    };
    // research/166 J1: a click on an idle or working row does nothing — no detail, no ring, no read.
    for (const quiet of ['Quiet lead', 'Busy lead']) {
      await clickAt(p, slot(sId(quiet)) + ' ' + byId('lead-status-quiet'));
      check(scene, 'J1 a click on ' + quiet + '\'s row does nothing', (await p.locator(byId('detail-backdrop')).count()) === 0
        && (await ringed(p)).length === 0 && (await gets()) === got);
    }
    await lit('running', ['Runner', S_TITLE]);
    const dim = Number((await style(p, slot(sId('Asker')), ['opacity'])).opacity);
    check(scene, 'the other cards step back, the family\'s too', dim > .4 && dim < .5, String(dim));
    await lit('testing', ['총괄 확인 — tests', S_TITLE]);
    await lit('awaiting', ['Asker', S_TITLE]);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-lit.png`) });
    await clickAt(p, fam + ' ' + byId('lead-status-awaiting'));
    check(scene, 'the same part again ends it', (await ringed(p)).length === 0);
    await clickAt(p, fam + ' ' + byId('lead-status-running'));
    const empty = await p.locator(byId('swimlane-lane-section')).filter({ has: p.locator(lead) }).locator(byId('swimlane-cell-done')).first().boundingBox();
    await p.mouse.move(empty.x + empty.width / 2, empty.y + empty.height - 10, { steps: 4 }); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(200);
    check(scene, 'a click on an empty spot ends it', (await ringed(p)).length === 0, JSON.stringify(empty));
    // The keyboard: a part is a button of its own.
    await p.locator(fam + ' ' + byId('lead-status-testing')).first().focus();
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    check(scene, 'keyboard: Enter on a part rings its cards', JSON.stringify(await ringed(p)) === JSON.stringify(['총괄 확인 — tests', S_TITLE])
      && (await p.locator(byId('detail-backdrop')).count()) === 0);
    // D43 / REQ-130: the asking lead's own wait is its "Awaiting answer" mark (REQ-133) — no second "Awaiting you" part, so nothing there to click.
    const asking = slot(sId('Asking lead')), before = JSON.stringify(await ringed(p));
    await p.locator(asking).first().scrollIntoViewIfNeeded(); await away(p);
    await p.screenshot({ path: path.join(out, `d43-${scene}.png`) });
    await clickAt(p, asking + ' ' + byId('lead-status-awaiting'));
    await leaveOpen(p, scene);
    check(scene, 'D43 a click on the asking lead\'s "Needs your answer" mark opens its agent, no detail, no new ring',
      JSON.stringify((await p.evaluate(() => window.__opened.slice())).at(-1)) === JSON.stringify(['agent', S_QUESTION])
      && (await p.locator(asking + ' ' + byId('lead-status-awaiting')).count()) === 1 && !/Awaiting you|결정 대기/.test(await words(asking + ' ' + byId('lead-status')))
      && (await p.locator(byId('detail-backdrop')).count()) === 0 && JSON.stringify(await ringed(p)) === before,
      JSON.stringify(await p.evaluate(() => window.__opened.slice())) + ' ' + JSON.stringify(await ringed(p)));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  {
    const scene = 'req104-phone-light';
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true, 'status'));
    await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 });
    await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400);
    const row = slot(sId(S_TITLE)) + ' ' + byId('lead-status'), fam = slot(sId(S_TITLE)) + ' ' + byId('family-summary');
    await p.waitForSelector(fam + ' ' + byId('lead-status-running'), { timeout: 10000 }).catch(() => {});
    const text = (await p.locator(row).first().innerText()).replace(/\s+/g, ' ').trim().replace(/^C /, '');
    check(scene, 'the same row and family line on a phone (REQ-135)', text === 'Idle · since ' + deviceClock(S_ACTIVE, Date.now())
      && await spokenParts(p, fam) === 'Running 1 · Needs you 1 · Testing ' + S_CHECK() + '~', text + ' / ' + await spokenParts(p, fam));
    // REQ-135: on the family line a part reaches as "Sub-cards N" does — the gap over it and half the one under it (25px), 32px wide.
    const part = p.locator(fam + ' ' + byId('lead-status-awaiting')).first(), pb = await part.boundingBox();
    check(scene, 'a part is a finger-sized press', pb && pb.height >= 24 && pb.width >= 32, JSON.stringify(pb));
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    await part.tap(); await p.waitForTimeout(300);
    // research/166 J2: the card awaiting you is in no card of this tab — the screen moves to its tab.
    check(scene, 'J2 a tap moves to the tab of the card awaiting you, rings it and opens no detail',
      (await p.locator(slot(sId(S_TITLE))).count()) === 0 && (await p.locator(slot(sId('Asker'))).count()) === 1
      && JSON.stringify(await ringed(p)) === JSON.stringify(['Asker']) && (await p.locator(byId('editor-sheet')).count()) === 0, JSON.stringify(await ringed(p)));
    await p.screenshot({ path: path.join(out, `${scene}-lit.png`) });
    await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(300);
    check(scene, 'another tab keeps it: the lead', JSON.stringify(await ringed(p)) === JSON.stringify([S_TITLE]), JSON.stringify(await ringed(p)));
    const title = await p.locator(byId('mobile-appbar')).first().boundingBox();
    await p.touchscreen.tap(title.x + 30, title.y + title.height / 2); await p.waitForTimeout(300);
    check(scene, 'a tap elsewhere ends it', (await ringed(p)).length === 0);
    // D43: the asking lead on a phone — the same row, and a tap opens its agent.
    const asking = slot(sId('Asking lead')), askRow = asking + ' ' + byId('lead-status');
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(400);
    await p.locator(asking).first().scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
    const askText = (await p.locator(askRow).first().innerText()).replace(/\s+/g, ' ').trim().replace(/^C /, '');
    check(scene, 'D43 the asking lead on a phone: awaiting you, not idle', /^Needs your answer · \d+m$/.test(askText), askText);
    await p.screenshot({ path: path.join(out, `d43-${scene}.png`) });
    await p.locator(askRow + ' ' + byId('lead-status-awaiting')).first().tap(); await p.waitForTimeout(300);
    await leaveOpen(p, scene, true);
    check(scene, 'D43 a tap on the "Needs your answer" mark opens its agent, no sheet, no ring',
      JSON.stringify((await p.evaluate(() => window.__opened.slice())).at(-1)) === JSON.stringify(['agent', S_QUESTION])
      && (await p.locator(byId('editor-sheet')).count()) === 0 && (await ringed(p)).length === 0, JSON.stringify(await p.evaluate(() => window.__opened.slice())));
    const mb = await box(p, askRow + ' ' + byId('lead-status-awaiting'));
    check(scene, 'the mark\'s press is 32px wide at least', mb && mb.width >= 32, JSON.stringify(mb));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  // ---- REQ-92: a column's "+N" five at a time, "Collapse" at the end, in that column only — the mouse and a tap ----
  for (const mode of ['light', 'dark']) for (const mobile of [false, true]) {
    const scene = `req92-${mobile ? 'phone' : 'wide'}-${mode}`;
    const p = await (await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, mobile, true));
    const doneCell = mobile ? byId('mobile-workspace-' + late.id) : byId('swimlane-lane-section') + ':has(' + byId('swimlane-cell-done') + ' ' + label('Helper done') + ') ' + byId('swimlane-cell-done');
    if (mobile) { await p.waitForSelector(byId('mobile-tab-done'), { timeout: 15000 }); await p.locator(byId('mobile-tab-done')).first().tap(); await p.waitForTimeout(300); }
    await p.waitForSelector(doneCell + ' [data-testid^="kanban-card-"]', { timeout: 15000 });
    const count = () => p.locator(doneCell + ' [data-testid^="kanban-card-"]').count();
    const link = id => p.locator(doneCell + ' ' + byId(id));
    // Scrolled to first, as a person would: the links sit under the cards, below the window once a column grows.
    const press = async id => { await link(id).first().scrollIntoViewIfNeeded();
      if (mobile) await link(id).first().tap(); else await clickAt(p, doneCell + ' ' + byId(id)); await p.waitForTimeout(250); };
    const doingCount = () => mobile ? Promise.resolve(-1) : p.locator(byId('swimlane-lane-section') + ':has(' + label('Helper done') + ') ' + byId('swimlane-cell-doing') + ' [data-testid^="kanban-card-"]').count();
    const before = await doingCount();
    check(scene, 'three done cards and "+9"', await count() === 3 && (await link('cell-more').innerText()) === '+9', String(await count()));
    await press('cell-more');
    check(scene, 'a press: five more, "+4" left', await count() === 8 && (await link('cell-more').innerText()) === '+4', String(await count()));
    check(scene, 'the done column offers the board for the rest', (await link('cell-rest-in-board').innerText()) === '4 more in the board');
    // REQ-115: part way too, "Collapse" beside them on the same line.
    const [mb, cb2] = [await box(p, doneCell + ' ' + byId('cell-more')), await box(p, doneCell + ' ' + byId('cell-collapse'))];
    check(scene, 'REQ-115 "Collapse" part way, beside "+4"', !!cb2 && (await link('cell-collapse').innerText()) === 'Collapse' && Math.abs(cb2.y - mb.y) <= 2 && cb2.x > mb.x,
      JSON.stringify({ mb, cb2 }));
    check(scene, 'the lane\'s other columns stay as they were', await doingCount() === before, String(await doingCount()));
    await press('cell-more');
    check(scene, 'the last four, then "Collapse" only', await count() === 12 && (await link('cell-more').count()) === 0 && (await link('cell-collapse').innerText()) === 'Collapse');
    await p.screenshot({ path: path.join(out, `${scene}-all.png`), fullPage: false });
    await press('cell-collapse');
    check(scene, '"Collapse" takes the column back to three', await count() === 3 && (await link('cell-more').innerText()) === '+9');
    if (!mobile) {
      // The lane glyph: five more in each column that leaves cards out.
      const glyph = byId('swimlane-lane-section') + ':has(' + label('Helper done') + ') ' + byId('lane-toggle');
      await p.locator(glyph).first().scrollIntoViewIfNeeded();
      await clickAt(p, glyph);
      check(scene, 'the lane glyph: five more in each such column', await count() === 8 && await doingCount() === Math.min(4, before + 5), JSON.stringify([await count(), await doingCount()]));
      await clickAt(p, glyph);
      check(scene, 'and folds them all back', await count() === 3 && await doingCount() === before);
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  for (const mode of ['light', 'dark']) {
    const scene = `req93-late-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, true));
    await p.waitForSelector(byId('swimlane-cell-review') + ' ' + label('Lead card'), { timeout: 15000 });
    await p.waitForTimeout(4500);
    check(scene, 'F1 before: no marks', (await p.locator(byId('family-summary')).count()) === 0 && (await p.locator(byId('family-mark')).count()) === 0);
    const reads = await p.evaluate(() => window.__calls.filter(n => n === 'kanban.v1.overview.get').length);
    await p.evaluate(() => window.__remember());
    const started = Date.now();
    let marked = false;
    while (!marked && Date.now() - started < 10_000) { await p.waitForTimeout(250); marked = (await p.locator(byId('family-summary')).count()) > 0; }
    check(scene, 'F1 the marks appear by the auto refresh alone (≤10s)', marked, 'waited ' + (Date.now() - started) + 'ms');
    check(scene, 'F1 one re-read', (await p.evaluate(() => window.__calls.filter(n => n === 'kanban.v1.overview.get').length)) === reads + 1);
    if (marked) check(scene, 'the summary counts every sub-card', (await p.locator(byId('family-summary')).first().textContent()).includes('Sub-cards 14·not done 2'),
      await p.locator(byId('family-summary')).first().textContent());
    // 보완: twelve done sub-cards, three shown ("+9"). Highlighting the family opens the column five at a time until all show.
    const doneCell = byId('swimlane-lane-section') + ':has(' + label('Helper done') + ') ' + byId('swimlane-cell-done');
    const doneShown = () => p.locator(doneCell + ' [data-testid^="kanban-card-"]').count();
    check(scene, '보완 before: three done and "+9"', await doneShown() === 3 && (await p.locator(doneCell + ' ' + byId('cell-more')).innerText()) === '+9');
    if (marked) {
      await clickAt(p, byId('family-summary-all'));
      check(scene, '보완 the highlight opens the done column to its last sub-card', await doneShown() === 12 && (await p.locator(doneCell + ' ' + byId('cell-more')).count()) === 0
        && (await p.locator(doneCell + ' ' + byId('cell-collapse')).count()) === 1, String(await doneShown()));
      check(scene, '보완 and rings all fifteen', (await ringed(p)).length === 15, String((await ringed(p)).length));
      await p.screenshot({ path: path.join(out, `${scene}-revealed.png`) });
      await clickAt(p, byId('swimlane-progress'));
      // REQ-109: what the highlight opened folds back when it ends.
      check(scene, '보완 a click on an empty spot ends it, the column folds back (REQ-109)', (await ringed(p)).length === 0 && await doneShown() === 3, String(await doneShown()));
      // REQ-109: "not done M" rings the lead and its two sub-cards not done; the done column is left folded.
      await clickAt(p, byId('family-summary-open'));
      check(scene, 'REQ-109 "not done" rings the not-done alone, the done column left folded', (await ringed(p)).length === 3 && await doneShown() === 3
        && (await p.locator(byId('family-summary-open')).first().getAttribute('aria-pressed')) === 'true', JSON.stringify([(await ringed(p)).length, await doneShown()]));
      await clickAt(p, byId('swimlane-progress'));
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  // ---- REQ-93 보완 on 390px, by touch: the mark's 32px area, a stage tab and a swipe keep the highlight, a tap on an empty
  // spot ends it; a family cut off behind "+N" opens its lists ----
  for (const mode of ['light', 'dark']) {
    const scene = `req93-phone-reveal-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, true));
    await p.waitForSelector(byId('mobile-tab-done'), { timeout: 15000 });
    const tab = id => p.locator(byId('mobile-tab-' + id)).first();
    const section = byId('mobile-workspace-' + late.id), shown = () => p.locator(section + ' [data-testid^="kanban-card-"]').count();
    await tab('done').tap(); await p.waitForTimeout(300);
    check(scene, 'before: three done and "+9"', await shown() === 3 && (await p.locator(section + ' ' + byId('cell-more')).innerText()) === '+9', String(await shown()));
    await tab('review').tap(); await p.waitForTimeout(300);
    await p.evaluate(() => window.__remember());
    const started = Date.now();
    let marked = false;
    while (!marked && Date.now() - started < 10_000) { await p.waitForTimeout(250); marked = (await p.locator(section + ' ' + byId('family-mark')).count()) > 0; }
    check(scene, 'the marks appear', marked);
    if (marked) {
      // The mark: a 16px face, a 32×32 press area around it — a tap 6px above the face still reaches it.
      const mark = p.locator(markOf('Helper one')).first(), area = await mark.boundingBox();
      const face = await p.locator(markOf('Helper one') + ' ' + byId('family-mark-face')).first().boundingBox();
      check(scene, 'the mark\'s press area is 32×32 at least, its face 16px', area.height >= 32 && area.width >= 32 && Math.abs(face.height - 16) <= 1,
        JSON.stringify({ area, face }));
      // What the page itself finds 6px above and below the face (the browser's own touch adjustment would snap a tap anyway).
      const hits = await p.evaluate(([x, top, bottom]) => [top, bottom].map(y => !!document.elementFromPoint(x, y)?.closest('[data-testid="family-mark"]')),
        [face.x + 8, face.y - 6, face.y + face.height + 6]);
      check(scene, '6px above and below the face is still the mark', hits.every(Boolean), JSON.stringify(hits));
      await p.touchscreen.tap(face.x + 8, face.y - 6); await p.waitForTimeout(300);
      check(scene, 'a tap 6px above the face highlights the family', JSON.stringify(await ringed(p)) === JSON.stringify(['Lead card', 'Helper one']), JSON.stringify(await ringed(p)));
      check(scene, 'and opens no card', (await p.locator(byId('editor-sheet')).count()) === 0);
      // Another stage tab keeps it; the done list opened to its last sub-card while the highlight came on.
      await tab('done').tap(); await p.waitForTimeout(300);
      check(scene, 'a stage tab keeps it, and the done list shows all twelve', (await ringed(p)).length === 12 && await shown() === 12,
        JSON.stringify([(await ringed(p)).length, await shown()]));
      await p.screenshot({ path: path.join(out, `${scene}-done.png`) });
      // A swipe scrolls the list (a real touch drag): no click, so it keeps it.
      const cdp = await p.context().newCDPSession(p);
      const list = await p.locator(section).boundingBox();
      await p.evaluate(() => { window.__touch = { down: 0, click: 0 }; addEventListener('pointerdown', () => window.__touch.down++, true);
        addEventListener('click', () => window.__touch.click++, true); });
      const x = Math.round(list.x + list.width / 2), touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: y === null ? [] : [{ x, y }] });
      await touch('touchStart', 640);
      for (let y = 620; y >= 340; y -= 20) { await touch('touchMove', y); await p.waitForTimeout(16); }
      await touch('touchEnd', null); await p.waitForTimeout(500);
      const moved = await p.evaluate(() => ({ top: Math.max(0, ...[...document.querySelectorAll('*')].map(e => e.scrollTop)), ...window.__touch }));
      check(scene, 'a swipe scrolls the list and keeps it', moved.top > 0 && moved.down > 0 && moved.click === 0 && (await ringed(p)).length === 12,
        JSON.stringify({ ...moved, ringed: (await ringed(p)).length }));
      const bar = await p.locator(byId('mobile-appbar')).first().boundingBox();
      await p.touchscreen.tap(bar.x + 30, bar.y + bar.height / 2); await p.waitForTimeout(300);
      check(scene, 'a tap on an empty spot ends it; the list folds back (REQ-109)', (await ringed(p)).length === 0 && await shown() === 3, String(await shown()));
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  // ---- H4: the state mark's press tooltip goes when a card's ⋯ menu or the order menu is pressed ----
  for (const mode of ['light', 'dark']) {
    const scene = `h4-wide-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 560 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'refs'));
    await p.waitForSelector('[data-testid="card-signal-press"]', { timeout: 15000 });
    const mark = '[aria-label="' + LONG + '"] ' + byId('card-signal-press');
    await p.locator(mark).first().scrollIntoViewIfNeeded(); await away(p);
    await clickAt(p, mark);
    check(scene, 'H4 the press shows the tooltip', await visible(p, byId('card-signal-tooltip')));
    // Another card on the same screen as the tooltip, so both are in the window.
    const other = p.locator(byId('swimlane-lane-section')).filter({ has: p.locator('[aria-label="' + LONG + '"]') }).locator('[data-testid^="kanban-card-"]')
      .filter({ hasNot: p.locator(byId('card-signal-press')) }).first();
    const otherTitle = await other.getAttribute('aria-label');
    await moveTo(p, label(otherTitle));
    await clickAt(p, label('Move to another stage: ' + otherTitle));
    check(scene, 'H4 another card\'s ⋯ closes it', (await visible(p, byId('card-menu'))) && !(await visible(p, byId('card-signal-tooltip'))));
    await escapeFrom(p, 'card-menu-modal'); await p.waitForTimeout(200); await away(p);
    await clickAt(p, mark);
    check(scene, 'H4 shown again', await visible(p, byId('card-signal-tooltip')));
    await clickAt(p, byId('sort-menu'));
    check(scene, 'H4 the order menu closes it', !(await visible(p, byId('card-signal-tooltip'))));
    await escapeFrom(p, 'sort-menu-modal'); await p.waitForTimeout(200); await away(p);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-88 (research/129): the card detail by real input — two columns in 880px, faint fields, the title where it
  // stands, fields saved when left (one after another), a refused save kept with "Try again", the stage flow and its undo,
  // and REQ-87 ⑥'s round × ----
  for (const mode of ['light', 'dark']) {
    const scene = `req88-wide-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false));
    await p.waitForSelector(byId('swimlane-cell-doing') + ' [data-testid^="kanban-card-"]', { timeout: 15000 });
    await clickAt(p, '[aria-label="Card one"]');
    await p.waitForSelector(byId('detail-panel'), { timeout: 5000 });
    const dialog = await box(p, byId('desktop-detail-dialog')), main = await box(p, byId('detail-main')), panel = await box(p, byId('detail-panel'));
    check(scene, '① an 880px window', Math.abs(dialog.width - 880) <= 1, JSON.stringify(dialog));
    check(scene, '① content on the left, a 280px panel on the right', panel.x >= main.x + main.width - 1 && Math.abs(panel.width - 280) <= 1, JSON.stringify({ main, panel }));
    check(scene, '⑤ no "Save changes"', (await p.getByText('Save changes', { exact: true }).count()) === 0);
    check(scene, '③ one title, no second title field', (await p.locator('[aria-label="Title"]').count()) === 0);
    const empty = async () => { await p.mouse.click(panel.x + 5, panel.y + 5); await p.waitForTimeout(500); };
    // ② the next action field: faint at rest, the main colour at the same 1px under the mouse.
    const next = byId('field-nextAction');
    const edge = async () => { const s = await style(p, next, ['borderTopColor', 'borderTopWidth']); return [rgb(s.borderTopColor), s.borderTopWidth]; };
    await away(p);
    const rest = await edge();
    check(scene, '② resting edge faint', rest[0] === fieldLine(c, c.surface1).toLowerCase() && rest[1] === '1px', JSON.stringify(rest));
    await moveTo(p, next);
    const hover = await edge();
    check(scene, '② under the mouse: the main colour, still 1px', hover[0] === selectedLine(c, c.surface1).toLowerCase() && hover[1] === '1px', JSON.stringify(hover));
    await away(p);
    // ③ the title where it stands: a click, typing, Enter.
    await clickAt(p, byId('detail-title'));
    await p.waitForSelector(byId('detail-title-input'), { timeout: 3000 });
    check(scene, '③ a click on the title edits it there', await p.evaluate(() => document.activeElement?.dataset?.testid) === 'detail-title-input');
    await p.keyboard.press('End'); await p.keyboard.type(' edited'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
    let w = await writesOf(p);
    check(scene, '③ Enter saves the title alone', JSON.stringify(w.at(-1)?.operations) === JSON.stringify([{ op: 'update', id: cardId('Card one'), patch: { title: 'Card one edited' } }]),
      JSON.stringify(w.at(-1)));
    check(scene, '③ back to the heading with the new words', await titleOf(p) === 'Card one edited', await titleOf(p));
    await clickAt(p, byId('detail-title')); await p.waitForSelector(byId('detail-title-input'));
    await p.keyboard.press('End'); await p.keyboard.type(' nope'); await p.keyboard.press('Escape'); await p.waitForTimeout(500);
    check(scene, '③ Escape puts the title back and sends nothing',
      await titleOf(p) === 'Card one edited' && (await writesOf(p)).length === w.length, await titleOf(p));
    check(scene, '③ and the same Escape does not close the window', await visible(p, byId('desktop-detail-dialog')));
    // ⑤ a field saves itself when it is left; the next field's save goes on the revision the first one produced.
    await clickAt(p, next); await p.keyboard.type('First step');
    await clickAt(p, byId('field-notes')); await p.keyboard.type('Some notes');
    await empty();
    w = await writesOf(p);
    const [one, two] = w.slice(-2).map(v => ({ patch: v.operations[0].patch, at: v.ifRevision }));
    check(scene, '⑤ leaving each field saves it, one write each', JSON.stringify([one.patch, two.patch]) === JSON.stringify([{ nextAction: 'First step' }, { notes: 'Some notes' }]),
      JSON.stringify(w.slice(-2)));
    check(scene, '⑤ the second on the revision the first produced', seqOf(two.at) === seqOf(one.at) + 1, JSON.stringify([one.at, two.at]));
    check(scene, '⑤ "Saved" under the field', /Saved/.test(await p.locator(byId('field-status-notes')).innerText().catch(() => '')));
    check(scene, '⑤ and the time in the head', /Saved \d\d:\d\d$/.test((await p.locator(byId('detail-last-saved')).innerText().catch(() => '')).trim()));
    // A refused save keeps what was typed and offers "Try again".
    await p.evaluate(() => { window.__failNext = 'failed'; });
    await clickAt(p, next); await p.keyboard.press('End'); await p.keyboard.type(' twice');
    await empty();
    check(scene, '⑤ refused: "Not saved", the words kept', /Not saved/.test(await p.locator(byId('field-status-nextAction')).innerText().catch(() => ''))
      && await p.locator(next).inputValue() === 'First step twice');
    await clickAt(p, byId('field-retry-nextAction')); await p.waitForTimeout(500);
    w = await writesOf(p);
    check(scene, '⑤ "Try again" saves them', JSON.stringify(w.at(-1).operations[0].patch) === JSON.stringify({ nextAction: 'First step twice' })
      && /Saved/.test(await p.locator(byId('field-status-nextAction')).innerText().catch(() => '')));
    // A choice saves at its click, tinted.
    await clickAt(p, byId('priority-choice-high')); await p.waitForTimeout(500);
    w = await writesOf(p);
    const chip = rgb((await p.locator(byId('priority-choice-high') + ' > div').first().evaluate(el => getComputedStyle(el).backgroundColor)));
    check(scene, '⑤ a choice saves at its click', JSON.stringify(w.at(-1).operations[0].patch) === JSON.stringify({ priority: 'high' }));
    check(scene, '⑤ and is tinted', chip === selectedTint(c, c.surface0, true).toLowerCase() || chip === selectedTint(c, c.surface0).toLowerCase(), chip);
    // ④ the stage flow: as wide as its stages, the current one tinted; a click moves at once; undo.
    const widths = await Promise.all(['todo', 'doing', 'review', 'done'].map(async id => (await box(p, byId('stage-bar-' + id))).width));
    check(scene, '④ each pill as wide as its name (not shared out)', new Set(widths.map(Math.round)).size > 1, JSON.stringify(widths));
    // The panel's flow stays inside the panel. REQ-136 H5: four stages whose names outrun it (English "In progress") wrap onto a
    // second line instead of scrolling "Done" out of sight under a fade (five or more still scroll, on one line).
    const flow = await box(p, (await p.locator(byId('stage-bar-frame')).count()) ? byId('stage-bar-frame') : byId('stage-bar'));
    check(scene, '④ the flow stays inside the panel, on one line or (REQ-136 H5) two', flow.x + flow.width <= panel.x + panel.width - 13 && flow.height <= 2 * 30 + 6, JSON.stringify({ flow, panel }));
    const current = rgb((await style(p, byId('stage-bar-doing'), ['backgroundColor'])).backgroundColor);
    check(scene, '④ the current stage is tinted', current === selectedTint(c, c.surface0).toLowerCase(), current);
    await clickAt(p, byId('stage-bar-review')); await p.waitForTimeout(600);
    w = await writesOf(p);
    check(scene, '④ a click moves the card at once', JSON.stringify(w.at(-1).operations) === JSON.stringify([{ op: 'move', id: cardId('Card one'), to: 'review' }]));
    check(scene, '④ the flow follows, the passed stage has a ✓', await p.locator(byId('stage-bar-review')).getAttribute('aria-checked') === 'true'
      && (await p.locator(byId('stage-bar-doing') + ' [data-icon="Check"]').count()) === 1);
    check(scene, '④ "Moved to Review · Undo"', /^Moved to Review/.test(await p.locator(byId('move-toast-text')).innerText().catch(() => '')));
    await p.screenshot({ path: path.join(out, `${scene}-detail.png`) });
    await clickAt(p, byId('move-undo')); await p.waitForTimeout(600);
    check(scene, '④ Undo moves it back', JSON.stringify((await writesOf(p)).at(-1).operations) === JSON.stringify([{ op: 'move', id: cardId('Card one'), to: 'doing' }]));
    // REQ-87 ⑥: the head's round × closes it.
    const x = await box(p, byId('sheet-close')), radius = (await style(p, byId('sheet-close'), ['borderTopLeftRadius'])).borderTopLeftRadius;
    check(scene, '⑥ a round 32px ×', Math.round(x.width) === 32 && radius === '16px', JSON.stringify({ x, radius }));
    await clickAt(p, byId('sheet-close')); await p.waitForTimeout(400);
    check(scene, '⑥ the × closes it', !(await visible(p, byId('desktop-detail-dialog'))));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-87 ⑥⑦ · REQ-91 · REQ-88 ③ on 390px, by touch: the filter glyph and its count, every sheet's round × and no
  // "Close" row, the content 8px above the bottom, the title's × and ✓, the stage flow in the first screen ----
  // A held finger. It is let go as a cancelled touch: an emulated touch that ends normally is followed by a click where the
  // finger was — by then the sheet's backdrop — which a phone's browser does not send after a long press (it sends contextmenu).
  for (const mode of ['light', 'dark']) {
    const scene = `req87-phone-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true));
    await p.waitForSelector('[data-testid^="kanban-card-"]', { timeout: 15000 });
    const tap = async sel => { await p.locator(sel).first().tap(); await p.waitForTimeout(400); };
    const words = (sheet, text) => p.locator(byId(sheet)).getByText(text, { exact: true }).count();
    const round = async (id, what) => { const b = await box(p, byId(id)), r = (await style(p, byId(id), ['borderTopLeftRadius'])).borderTopLeftRadius;
      check(scene, `⑥ ${what}: a round 32px × in the head`, b && Math.round(b.width) === 32 && r === '16px', JSON.stringify({ b, r })); };
    // REQ-91: the filter glyph, no count while nothing is filtered.
    check(scene, 'REQ-91 no badge at first', (await p.locator(byId('open-filters-badge')).count()) === 0
      && await p.locator(byId('open-filters')).first().getAttribute('aria-label') === 'Filters and search');
    await tap(byId('open-filters'));
    check(scene, '⑥ filters: no "Close" row', await words('menu-sheet', 'Close') === 0);
    await round('sheet-close', 'filters');
    // ⑦ the sheet's content box ends 8px above the page's bottom (the web page has no system bar).
    const content = await box(p, byId('menu-sheet') + ' ' + byId('sheet-content')), pad = (await style(p, byId('menu-sheet') + ' ' + byId('sheet-content'), ['paddingBottom'])).paddingBottom;
    check(scene, '⑦ the content stops 8px above the bottom', pad === '8px' && Math.abs(content.y + content.height - 844) <= 1, JSON.stringify({ content, pad }));
    await tap(byId('board-search')); await p.keyboard.type('Card');
    await tap(byId('sheet-close'));
    check(scene, '⑥ the × closes the filters', (await p.locator(byId('menu-sheet')).count()) === 0);
    check(scene, 'REQ-91 one filter: the same glyph with "1"', (await p.locator(byId('open-filters-badge')).innerText().catch(() => '')) === '1'
      && await p.locator(byId('open-filters')).first().getAttribute('aria-label') === 'Filters: 1 applied'
      && (await p.locator(byId('open-filters') + ' [data-icon="ListFilter"]').count()) === 1);
    await onLook(p, scene, 'REQ-91 filter glyph on', byId('open-filters'), c, c.surface0);
    await p.screenshot({ path: path.join(out, `${scene}-filter.png`), clip: { x: 0, y: 0, width: 390, height: 120 } });
    await tap(byId('open-filters')); await tap(byId('board-search')); await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace');
    await tap(byId('sheet-close'));
    check(scene, 'REQ-91 filter cleared: no badge', (await p.locator(byId('open-filters-badge')).count()) === 0);
    // The card detail sheet.
    await tap('[aria-label="Card one"]');
    await p.waitForSelector(byId('editor-sheet'), { timeout: 5000 });
    check(scene, '⑥ card: no "Close" row, no "Save changes"', await words('editor-sheet', 'Close') === 0 && await words('editor-sheet', 'Save changes') === 0);
    await round('sheet-close', 'card');
    const flow = await box(p, byId('stage-bar')), pill = await box(p, byId('stage-bar-doing'));
    check(scene, '④ the stage flow in the first screen', flow.y + flow.height < 844 - 8, JSON.stringify(flow));
    check(scene, '④ 32px pills (a 44px reach)', Math.round(pill.height) === 32, JSON.stringify(pill));
    await tap(byId('detail-title'));
    const ok = await box(p, byId('detail-title-save')), no = await box(p, byId('detail-title-cancel'));
    check(scene, '③ × and ✓ under the field, 44px each', ok && no && Math.round(ok.height) === 44 && Math.round(no.height) === 44, JSON.stringify({ ok, no }));
    const before = (await writesOf(p)).length;
    await p.keyboard.press('End'); await p.keyboard.type(' nope'); await tap(byId('detail-title-cancel'));
    check(scene, '③ × puts the title back, nothing sent', await titleOf(p) === 'Card one' && (await writesOf(p)).length === before, await titleOf(p));
    await tap(byId('detail-title')); await p.keyboard.press('End'); await p.keyboard.type(' phone'); await tap(byId('detail-title-save')); await p.waitForTimeout(300);
    check(scene, '③ ✓ saves the title', JSON.stringify((await writesOf(p)).at(-1)?.operations?.[0]?.patch) === JSON.stringify({ title: 'Card one phone' }));
    check(scene, '⑦ the card sheet\'s content stops 8px above the bottom', (await style(p, byId('editor-sheet') + ' ' + byId('sheet-content'), ['paddingBottom'])).paddingBottom === '8px');
    await p.screenshot({ path: path.join(out, `${scene}-card.png`) });
    await tap(byId('sheet-close'));
    check(scene, '⑥ the × closes the card', (await p.locator(byId('editor-sheet')).count()) === 0);
    // The ⋯ stage sheet, by a long press.
    await longPress(p, '[aria-label="Card two"]');
    check(scene, '⑥ ⋯ stages open by a long press', (await p.locator(byId('move-to-todo')).count()) === 1);
    check(scene, '⑥ ⋯ stages: no "Close" row', await words('menu-sheet', 'Close') === 0);
    await round('sheet-close', '⋯ stages');
    await tap(byId('sheet-close'));
    check(scene, '⑥ the × closes ⋯ stages', (await p.locator(byId('menu-sheet')).count()) === 0);
    // The settings sheet.
    await tap(byId('open-settings'));
    await round('settings-close', 'settings');
    await tap(byId('settings-close'));
    check(scene, '⑥ the × closes the settings', (await p.locator(byId('settings-sheet')).count()) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // REQ-133: =early grew past ten minutes (588 s at 0.1.48, over 595 s now), so it runs as =early1 (the scenes above) and =early2
  // (from here); =early is still both. Their shared helpers are declared before the first half.
  if (ONLY !== 'req124' && ONLY !== 'req126' && ONLY !== 'req127' && ONLY !== 'req128' && ONLY !== 'v0146b' && !D47 && !R130 && !R133 && !R134 && !R135 && !R136 && !R137 && !R125 && !R52 && !R125U1 && !R125U2 && !R125U3 && !R125U4 && !R138 && !R139 && !R142 && !E1) {
  // ---- REQ-95·96 by real input: the lead card first whatever the order, its head title, crown and stage edge; the orange of
  // an awaited answer; "Go to agent ↗" on hover and atop ⋯; "Response needed" to the agent that waits; the phone's sheet ----
  const opened = p => p.evaluate(() => window.__opened.slice());
  for (const mode of ['light', 'dark']) {
    const scene = `req95-wide-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'lead'));
    const leadSel = `[aria-label="${Q_TITLE}"]`;
    await p.waitForSelector(leadSel, { timeout: 15000 });
    const lane = p.locator(byId('swimlane-lane-section')).filter({ has: p.locator(leadSel) });
    const review = () => lane.locator(byId('swimlane-cell-review') + ' [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, '⑤ default order: the lead first, the rest by priority then age, three shown', JSON.stringify(await review())
      === JSON.stringify([Q_TITLE, 'Old high', 'Plain review']), JSON.stringify(await review()));
    for (const order of ['updated', 'created']) {
      await clickAt(p, byId('sort-menu'));
      await p.waitForSelector(byId('sort-option-' + order), { timeout: 5000 });
      await clickAt(p, byId('sort-option-' + order)); await p.waitForTimeout(300);
      check(scene, `⑤ ${order}: the lead still first, the newest after it`, JSON.stringify(await review()) === JSON.stringify([Q_TITLE, 'Newest review', 'Plain review']),
        JSON.stringify(await review()));
    }
    await away(p);
    const title = p.locator(leadSel + ' ' + byId('card-title')).first();
    check(scene, '⑥ the lead shows the head of its title', (await title.innerText()).trim() === '총괄-03', await title.innerText());
    await moveTo(p, leadSel + ' ' + byId('card-title'));
    await p.waitForSelector(byId('card-hint-title'), { timeout: 3000 }).catch(() => {});
    check(scene, '⑥ the whole title under the mouse', (await p.locator(byId('card-hint-title')).innerText().catch(() => '')).includes(Q_TITLE));
    const edge = rgb((await style(p, leadSel + ' ' + byId('card-content'), ['borderTopColor'])).borderTopColor);
    check(scene, 'REQ-105 the lead\'s edge: plain grey, not review\'s purple, 1px', edge === leaderOutline(c, c.card).toLowerCase()
      && (await style(p, leadSel + ' ' + byId('card-content'), ['borderTopWidth'])).borderTopWidth === '1px', edge);
    const crown = p.locator(leadSel + ' ' + byId('card-leader') + ' ' + byId('card-leader-filled'));
    const cb = await crown.first().boundingBox(), tb = await title.boundingBox();
    check(scene, '② a crown right before the title', (await crown.count()) === 1 && cb.x + cb.width <= tb.x + 1 && Math.abs((cb.y + cb.height / 2) - (tb.y + 10)) <= 6,
      JSON.stringify({ cb, tb }));
    check(scene, 'REQ-106 no line crown remains', (await p.locator(leadSel + ' ' + byId('card-leader') + ' [data-icon="Crown"]').count()) === 0);
    check(scene, 'REQ-122 the active crown is 16px, the medal\'s size (REQ-106\'s 13px before)', Math.abs(cb.width - 16) <= .5 && Math.abs(cb.height - 16) <= .5, JSON.stringify(cb));
    // REQ-100: the crown in a fixed gold (not the edge's grey); the archived lead's is the same filled crown, toned down.
    const tintOf = async loc => await loc.first().evaluate(el => el.outerHTML.match(/flood-color="([^"]+)"/)?.[1] ?? el.outerHTML.slice(0, 400));
    const activeTint = await tintOf(crown);
    check(scene, 'REQ-100/106 the active crown is gold, not the edge\'s grey', (rgb(activeTint) === crownColor(c, c.card).toLowerCase()
      || String(activeTint).toLowerCase() === crownColor(c, c.card).toLowerCase()) && activeTint !== edge, activeTint);
    // REQ-122: its beads, a second image on the same 16px spot, in the deep amber.
    const beadsOf = sel => p.locator(sel + ' ' + byId('card-leader') + ' ' + byId('card-leader-beads'));
    const bb = await beadsOf(leadSel).first().boundingBox().catch(() => null), beadTint = await tintOf(beadsOf(leadSel)).catch(() => '');
    check(scene, 'REQ-122 the crown\'s beads: over it, same box, deep amber', !!bb && Math.abs(bb.x - cb.x) <= .5 && Math.abs(bb.y - cb.y) <= .5
      && Math.abs(bb.width - cb.width) <= .5 && [rgb(beadTint), String(beadTint).toLowerCase()].includes(crownColors(c, c.card).beads.toLowerCase()),
      JSON.stringify({ bb, beadTint }));
    check(scene, 'REQ-122 the crown\'s title line stays 18px', Math.abs((await box(p, leadSel + ' ' + byId('card-leader'))).height - 18) <= .5);
    const oldSel = '[aria-label="Old lead"]', filled = p.locator(oldSel + ' ' + byId('card-leader-filled'));
    const fb = await filled.first().boundingBox().catch(() => null);
    check(scene, 'REQ-100 an archived lead: the same filled crown, 16px (REQ-122), no line crown', (await filled.count()) === 1 && !!fb && Math.abs(fb.width - 16) <= .5
      && Math.abs(fb.height - 16) <= .5 && (await p.locator(oldSel + ' [data-icon="Crown"]').count()) === 0, JSON.stringify(fb));
    const tint = await tintOf(filled);
    check(scene, 'REQ-100 … in the archived gold', rgb(tint) === c.crownArchived.toLowerCase() || String(tint).toLowerCase() === c.crownArchived.toLowerCase(), tint);
    const oldBeads = await tintOf(beadsOf(oldSel)).catch(() => '');
    check(scene, 'REQ-122 … its beads sunk with it', rgb(oldBeads) === c.crownArchivedBead.toLowerCase() || String(oldBeads).toLowerCase() === c.crownArchivedBead.toLowerCase(), oldBeads);
    const oldEdge = rgb((await style(p, oldSel + ' ' + byId('card-content'), ['borderTopColor'])).borderTopColor);
    check(scene, 'REQ-105 an archived lead\'s edge is a darker grey than an active lead\'s', oldEdge === leaderOutline(c, c.card, true).toLowerCase()
      && oldEdge !== edge, JSON.stringify({ oldEdge, edge }));
    const stripe = async t => rgb((await style(p, `[aria-label="${t}"] ` + byId('card-stage-stripe'), ['backgroundColor'])).backgroundColor);
    const orange = markLine(replyColor(c), c, c.card).toLowerCase();
    check(scene, '③ asking for a permission: an orange stripe in progress', await stripe('Asking card') === orange, await stripe('Asking card'));
    check(scene, '③ waiting for a person: an orange stripe in to do', await stripe('Waiting on you') === orange, await stripe('Waiting on you'));
    check(scene, '③ the others keep their stage', await stripe('Sub worker') === c.stageBlue.toLowerCase() && await stripe(Q_TITLE) === c.stagePurple.toLowerCase());
    check(scene, '③ 3:1 on the card and the column', contrast(orange, c.card) >= 3 && contrast(orange, c.panel) >= 3);
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    // REQ-96: hover shows ↗ beside ⋯ (not over it); a click opens the lead's agent, not the detail.
    await away(p);
    check(scene, 'REQ-96 ↗ hidden at rest', (await p.locator(leadSel + ' ' + byId('card-jump')).count()) === 0);
    await moveTo(p, leadSel);
    await p.waitForSelector(leadSel + ' ' + byId('card-jump'), { timeout: 3000 }).catch(() => {});
    const jb = await box(p, leadSel + ' ' + byId('card-jump')), mb = await box(p, leadSel + ' ' + byId('card-move-menu'));
    check(scene, 'REQ-96 ↗ shows on hover, left of ⋯, not touching it', !!jb && !!mb && jb.x + jb.width <= mb.x && Math.abs(jb.y - mb.y) <= 1, JSON.stringify({ jb, mb }));
    await p.screenshot({ path: path.join(out, `${scene}-hover.png`) });
    await clickAt(p, leadSel + ' ' + byId('card-jump'));
    await leaveOpen(p, scene);
    check(scene, 'REQ-96 ↗ opens the lead\'s agent (openAgent)', JSON.stringify((await opened(p)).at(-1)) === JSON.stringify(['agent', Q_LEAD]), JSON.stringify(await opened(p)));
    check(scene, 'REQ-96 ↗ opens no detail', (await p.locator(byId('detail-backdrop')).count()) === 0);
    // ⋯: "Go to agent" first, then the stages.
    await moveTo(p, leadSel); await clickAt(p, leadSel + ' ' + byId('card-move-menu'));
    await p.waitForSelector(byId('card-menu-jump'), { timeout: 5000 }).catch(() => {});
    const first = await p.locator(byId('card-menu') + ' [role="menuitem"]').first().getAttribute('data-testid');
    check(scene, 'REQ-96 ⋯ starts with "Go to agent"', first === 'card-menu-jump', String(first));
    await clickAt(p, byId('card-menu-jump'));
    await leaveOpen(p, scene);
    check(scene, 'REQ-96 ⋯ "Go to agent" opens it and closes the menu', (await opened(p)).length === 2 && (await p.locator(byId('card-menu')).count()) === 0,
      JSON.stringify(await opened(p)));
    // "Response needed": the agent asking; no agent → the workspace.
    await away(p);
    await clickAt(p, '[aria-label="Asking card"] ' + byId('card-reply'));
    await leaveOpen(p, scene);
    check(scene, 'REQ-96 "Response needed" opens the agent asking', JSON.stringify((await opened(p)).at(-1)) === JSON.stringify(['agent', Q_ASK]), JSON.stringify(await opened(p)));
    check(scene, 'REQ-96 … and no detail', (await p.locator(byId('detail-backdrop')).count()) === 0);
    await clickAt(p, '[aria-label="Waiting on you"] ' + byId('card-reply'));
    check(scene, 'REQ-96 no agent: its workspace (openWorkspace)', JSON.stringify((await opened(p)).at(-1)) === JSON.stringify(['workspace', 'wks_example01']));
    // The keyboard: the reply is a link of its own; Enter on it opens the agent.
    await p.locator('[aria-label="Asking card"] ' + byId('card-reply')).first().focus();
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    await leaveOpen(p, scene);
    check(scene, 'REQ-96 keyboard: Enter on "Response needed"', (await opened(p)).length === 5 && (await p.locator(byId('detail-backdrop')).count()) === 0,
      JSON.stringify(await opened(p)));
    // J5 (research/149): "Response needed" is a chip — a 1px orange edge on an orange fill, underlined under the mouse —
    // and only the chip opens the agent: the card's middle and the row beside the chip open the detail.
    await away(p);
    const chipSel = '[aria-label="Asking card"] ' + byId('card-reply-chip'), chipWant = replyChip(c, c.card);
    const chipLook = await style(p, chipSel, ['backgroundColor', 'borderTopWidth', 'borderTopColor']);
    check(scene, 'J5 "Response needed" is a chip', chipLook.borderTopWidth === '1px' && rgb(chipLook.backgroundColor) === chipWant.backgroundColor.toLowerCase()
      && rgb(chipLook.borderTopColor) === chipWant.borderColor.toLowerCase(), JSON.stringify(chipLook));
    await moveTo(p, chipSel);
    const chipLit = await p.locator(chipSel).first().evaluate(el => [getComputedStyle(el).backgroundColor,
      ...[...el.querySelectorAll('*')].map(e => getComputedStyle(e).textDecorationLine)]);
    check(scene, 'J5 … underlined and deeper under the mouse', chipLit.includes('underline') && rgb(chipLit[0]) === replyChip(c, c.card, true).backgroundColor.toLowerCase(),
      JSON.stringify(chipLit));
    const cardBox = await box(p, '[aria-label="Asking card"]'), chipBox = await box(p, chipSel);
    let openedBefore = 0;
    // Here the card's middle is on the chip, which is the link now; so the middle just under it.
    const [midX, midY] = center(cardBox), onChip = midX >= chipBox.x && midX <= chipBox.x + chipBox.width && midY >= chipBox.y && midY <= chipBox.y + chipBox.height;
    const pressAt = async (x, y) => { openedBefore = (await opened(p)).length; await p.mouse.move(x, y, { steps: 4 }); await p.mouse.down(); await p.waitForTimeout(60); await p.mouse.up(); await p.waitForTimeout(250); };
    const detailThenClose = async what => {
      await p.waitForSelector(byId('detail-backdrop'), { timeout: 5000 }).catch(() => {});
      check(scene, 'J5 ' + what + ' opens the detail, not the agent', (await p.locator(byId('detail-backdrop')).count()) > 0 && (await opened(p)).length === openedBefore,
        JSON.stringify({ opened: (await opened(p)).slice(openedBefore), cardBox, chipBox }));
      await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }).catch(() => {}); await p.waitForTimeout(250); await away(p);
    };
    await pressAt(midX, onChip ? chipBox.y + chipBox.height + 5 : midY); await detailThenClose('the card\'s middle off the chip');
    await pressAt(chipBox.x - 4, chipBox.y + chipBox.height / 2); await detailThenClose('the row just left of the chip');
    await pressAt(chipBox.x + chipBox.width / 2, chipBox.y - 3); await detailThenClose('just over the chip');
    await clickAt(p, chipSel);
    await leaveOpen(p, scene);
    check(scene, 'J5 the chip opens the agent asking (openAgent)', JSON.stringify((await opened(p)).at(-1)) === JSON.stringify(['agent', Q_ASK])
      && (await p.locator(byId('detail-backdrop')).count()) === 0, JSON.stringify(await opened(p)));
    // The detail says the same under who is awaited.
    await away(p);
    await clickAt(p, '[aria-label="Asking card"] ' + byId('card-title'));
    await p.waitForSelector(byId('detail-reply'), { timeout: 5000 }).catch(() => {});
    if (!await visible(p, byId('detail-reply'))) await p.screenshot({ path: path.join(out, `${scene}-no-reply.png`) });
    if (await visible(p, byId('detail-reply'))) {
      const look = await style(p, byId('detail-reply-chip'), ['backgroundColor', 'borderTopWidth']);
      check(scene, 'J5 the detail\'s link is the same chip', look.borderTopWidth === '1px' && rgb(look.backgroundColor) === replyChip(c, c.surface0).backgroundColor.toLowerCase(),
        JSON.stringify(look));
      await clickAt(p, byId('detail-reply'));
      await leaveOpen(p, scene);
    }
    check(scene, 'REQ-96 the detail\'s "Response needed · Go answer" opens the agent asking', JSON.stringify((await opened(p)).at(-1)) === JSON.stringify(['agent', Q_ASK]),
      JSON.stringify(await opened(p)));
    // ④ once closed, the card just seen is grey.
    await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }).catch(() => {}); await p.waitForTimeout(250); await away(p);
    const seen = rgb((await style(p, '[aria-label="Asking card"]', ['backgroundColor'])).backgroundColor);
    check(scene, '④ the card just seen is grey-tinted', seen === viewedTint(c, c.card).toLowerCase(), seen);
    check(scene, 'J4 … 1.25–1.35 from a plain card', contrast(seen, c.card) >= 1.25 && contrast(seen, c.card) <= 1.35,
      contrast(seen, c.card).toFixed(3) + ' (column ' + contrast(seen, c.panel).toFixed(3) + ')');
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'no card written (only the order setting)', (await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').length)) === 0);
    await p.context().close();
  }
  for (const mode of ['light', 'dark']) {
    const scene = `req96-phone-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'lead'));
    await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 });
    await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400);
    const leadSel = `[aria-label="${Q_TITLE}"]`;
    const shown = await p.locator(byId('mobile-workspace-' + q.id) + ' [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, 'REQ-95 ⑤ the lead first in its tab', shown[0] === Q_TITLE, JSON.stringify(shown));
    check(scene, 'no ↗ on a phone card', (await p.locator(byId('card-jump')).count()) === 0);
    // REQ-135: the family line ("Sub-cards N · Running N · not done N") now reaches the card's middle, its own presses: hold the title.
    await longPress(p, leadSel + ' ' + byId('card-title'));
    const first = await p.locator(byId('menu-sheet') + ' [role="menuitem"]').first().getAttribute('data-testid').catch(() => null);
    check(scene, 'the long-press sheet starts with "Go to agent"', first === 'card-menu-jump', String(first));
    const jb = await box(p, byId('card-menu-jump'));
    check(scene, 'a 44px row', !!jb && jb.height >= 44, JSON.stringify(jb));
    await p.screenshot({ path: path.join(out, `${scene}-sheet.png`) });
    await p.locator(byId('card-menu-jump')).first().tap(); await p.waitForTimeout(400);
    await leaveOpen(p, scene, true);
    check(scene, 'a tap opens the lead\'s agent', JSON.stringify(await opened(p)) === JSON.stringify([['agent', Q_LEAD]]) && (await p.locator(byId('menu-sheet')).count()) === 0,
      JSON.stringify(await opened(p)));
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(400);
    await p.locator('[aria-label="Asking card"] ' + byId('card-reply')).first().tap(); await p.waitForTimeout(400);
    await leaveOpen(p, scene, true);
    check(scene, 'a tap on "Response needed" opens the agent asking', JSON.stringify((await opened(p)).at(-1)) === JSON.stringify(['agent', Q_ASK]), JSON.stringify(await opened(p)));
    check(scene, '… and no detail', (await p.locator(byId('editor-sheet')).count()) === 0);
    // J5: the chip takes a 32px press (over it and under it), never the title's; a tap over the chip still opens the agent.
    const rb = await box(p, '[aria-label="Asking card"] ' + byId('card-reply')), tb = await box(p, '[aria-label="Asking card"] ' + byId('card-title'));
    const cb = await box(p, '[aria-label="Asking card"] ' + byId('card-reply-chip'));
    check(scene, 'J5 a 32px press around the 18px chip', !!rb && rb.height >= 32 && !!cb && cb.height <= 19, JSON.stringify({ rb, cb }));
    check(scene, 'J5 … not over the title', !!rb && !!tb && rb.y >= tb.y + tb.height - .5, JSON.stringify({ rb, tb }));
    const count = (await opened(p)).length;
    await p.touchscreen.tap(cb.x + cb.width / 2, cb.y - 4); await p.waitForTimeout(400);
    await leaveOpen(p, scene, true);
    check(scene, 'J5 a tap just over the chip opens the agent', (await opened(p)).length === count + 1 && JSON.stringify((await opened(p)).at(-1)) === JSON.stringify(['agent', Q_ASK]),
      JSON.stringify(await opened(p)));
    await p.touchscreen.tap(tb.x + 10, tb.y + tb.height / 2); await p.waitForTimeout(600);
    check(scene, 'J5 a tap on the title opens the detail', (await p.locator(byId('editor-sheet')).count()) > 0 && (await opened(p)).length === count + 1);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-103 by real input: "Criteria n/m" on the card's second row, the quiet "Criteria unchecked" in done, never
  // counted as needing attention; "Cards N/M" beside the bars; a click on a checklist line in the detail ticks and saves it ----
  for (const [mode, mobile] of [['light', false], ['dark', false], ['light', true]]) {
    const scene = `req103-${mobile ? 'phone' : 'wide'}-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, mobile, 'lead'));
    if (mobile) { await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 }); await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400); }
    const some = '[aria-label="Plain review"]', all = '[aria-label="Old high"]', done = '[aria-label="Old helper"]';
    // The words themselves (the icon shim draws its glyph as a letter beside them).
    const words = ' > div[dir="auto"]:not([data-icon-glyph])';
    await p.waitForSelector(some + ' ' + byId('card-criteria'), { timeout: 15000 });
    check(scene, '② "Criteria 2/3" on the card', (await p.locator(some + ' ' + byId('card-criteria') + words).innerText()).trim() === 'Criteria 2/3');
    check(scene, '② "Criteria 3/3" with a check', (await p.locator(all + ' ' + byId('card-criteria') + words).innerText()).trim() === 'Criteria 3/3'
      && (await p.locator(all + ' ' + byId('card-criteria') + ' [data-icon="Check"]').count()) === 1);
    // On the second row, inside the card, clear of the age and the name.
    const cb = await box(p, some + ' ' + byId('card-criteria')), nb = await box(p, some + ' ' + byId('card-agent')), card = await box(p, some);
    const ab = await box(p, some + ' ' + byId('card-age')).catch(() => null);
    check(scene, '② on the row of the name, inside the card', !!cb && !!nb && Math.abs((cb.y + cb.height / 2) - (nb.y + nb.height / 2)) <= 3
      && cb.x >= nb.x + nb.width - .5 && cb.x + cb.width <= card.x + card.width + .5 && (!ab || cb.x + cb.width <= ab.x + .5), JSON.stringify({ cb, nb, ab, card }));
    // A plain card with no next action is 84px (cardDimensions); the criteria add no row.
    check(scene, '② the card keeps its height', Math.abs(card.height - 84) <= 1 && Math.abs((await box(p, all)).height - 84) <= 1, JSON.stringify(card));
    if (mobile) { await p.locator(byId('mobile-tab-done')).first().tap(); await p.waitForTimeout(400); }
    await p.waitForSelector(done + ' ' + byId('card-criteria-unmet'), { timeout: 5000 }).catch(() => {});
    const mark = p.locator(done + ' ' + byId('card-criteria-unmet'));
    check(scene, '② a done card with unticked lines says "Criteria unchecked 1/2"', (await mark.count()) === 1 && (await mark.locator(words.trim()).innerText()).trim() === 'Criteria unchecked 1/2');
    if (await mark.count()) {
      const look = await style(p, done + ' ' + byId('card-criteria-unmet'), ['borderTopWidth', 'backgroundColor']);
      const tone = await p.locator(done + ' ' + byId('card-criteria-unmet') + words).first().evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).fontWeight]);
      check(scene, '② … plain orange words, no chip', look.borderTopWidth === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(look.backgroundColor)
        && rgb(tone[0]) === readableHex(c.statusWarning, c.card) && Number(tone[1]) < 600, JSON.stringify({ look, tone }));
      const mb = await box(p, done + ' ' + byId('card-criteria-unmet')), db = await box(p, done);
      check(scene, '② … inside the card', !!mb && mb.x + mb.width <= db.x + db.width + .5, JSON.stringify({ mb, db }));
    }
    check(scene, '② no "Response needed" on it', (await p.locator(done + ' ' + byId('card-reply')).count()) === 0);
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-cards.png`) });
    // ③ the words beside the bars.
    if (!mobile) {
      const top = (await p.locator(byId('swimlane-progress')).innerText()).trim();
      const lanes = await p.locator(byId('lane-progress')).evaluateAll(els => els.map(e => e.innerText.trim()));
      check(scene, '③ the top says "Cards N/M", no percent', /^Cards \d+\/\d+$/.test(top), top);
      check(scene, '③ each lane head too, with its bar', lanes.length >= 2 && lanes.every(v => /^Cards \d+\/\d+$/.test(v))
        && (await p.locator(byId('lane-progress-fill')).count()) === lanes.length, JSON.stringify(lanes));
      const attention = (await p.locator(byId('attention-count')).innerText()).trim();
      // "Waiting on you" alone (it waits for a person); the done card with unticked lines is not counted.
      check(scene, '② "Needs attention" leaves the done card out', attention === String(toOverview([q], 'en', T(6)).boards[0].needsHuman) && attention === '1', attention);
    } else {
      const heads = await p.locator(byId('mobile-workspace-heading')).evaluateAll(els => els.map(e => e.innerText));
      check(scene, '③ the phone lane heading says "Cards N/M", no percent', heads.length > 0 && heads.every(v => /Cards \d+\/\d+/.test(v) && !/%/.test(v)), JSON.stringify(heads));
    }
    // The detail: a click on a line ticks it and saves the criteria.
    if (mobile) { await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400);
      const tb = await box(p, some + ' ' + byId('card-title')); await p.touchscreen.tap(tb.x + 10, tb.y + tb.height / 2); }
    else await clickAt(p, some + ' ' + byId('card-title'));
    await p.waitForSelector(byId('detail-criteria'), { timeout: 5000 }).catch(() => {});
    const progress = async () => (await p.locator(byId('detail-criteria-progress')).innerText().catch(() => '')).trim();
    check(scene, '② the detail says "Criteria 2/3"', await progress() === 'Criteria 2/3', await progress());
    const line = byId('detail-criterion-3'), lb = await box(p, line).catch(() => null);
    check(scene, '② a line is a checkbox', (await p.locator(line).getAttribute('role')) === 'checkbox' && (await p.locator(line).getAttribute('aria-checked')) === 'false'
      && !!lb && lb.height >= (mobile ? 44 : 28) - .5, JSON.stringify(lb));
    if (mobile) { await p.locator(line).scrollIntoViewIfNeeded(); const b = await box(p, line); await p.touchscreen.tap(b.x + 20, b.y + b.height / 2); }
    else await clickAt(p, line);
    await p.waitForTimeout(500);
    const sent = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').map(v => v.input.operations));
    check(scene, '② the click saved the criteria alone, that line ticked', sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify([{ op: 'update',
      id: qId('Plain review'), patch: { acceptanceCriteria: Q_CRITERIA.some.replace('- [ ] Owner', '- [x] Owner') } }]), JSON.stringify(sent));
    check(scene, '② … and the detail says "Criteria 3/3"', await progress() === 'Criteria 3/3' && (await p.locator(line).getAttribute('aria-checked')) === 'true', await progress());
    await p.screenshot({ path: path.join(out, `${scene}-detail.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-86: the time a card has sat in its column, an orange ⚠ past the limit — the mouse, a tap, the detail ----------
  const dwellOf = async (p, title) => {
    const sel = label(title) + ' [data-testid^="card-dwell"]';
    if (!(await p.locator(sel).count())) return null;
    return { id: await p.locator(sel).first().getAttribute('data-testid'), text: (await p.locator(label(title) + ' ' + byId('card-dwell-text')).first().innerText()).trim(),
      icon: await p.locator(sel + ' [data-icon]').first().getAttribute('data-icon') };
  };
  const dwellWant = { 'Review for long': ['card-dwell-warn', '14h', 'TriangleAlert'], 'Review short': ['card-dwell', '3h', 'Clock'],
    'Stalled work': ['card-dwell-warn', '3h', 'TriangleAlert'], 'Busy work': ['card-dwell', '5h', 'Clock'] };
  const dwellAttention = String(toOverview([dw, b], 'en', T(6)).boards.reduce((n, v) => n + v.needsHuman, 0));
  for (const mode of ['light', 'dark']) {
    const scene = `req86-wide-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'dwell'));
    await p.waitForSelector(label('Stalled work') + ' ' + byId('card-dwell-warn'), { timeout: 15000 }).catch(() => {});
    for (const [title, [id, text, icon]] of Object.entries(dwellWant)) {
      const got = await dwellOf(p, title);
      check(scene, title + ': ' + (id === 'card-dwell' ? 'a clock and ' : 'an orange ⚠ and ') + text, JSON.stringify(got) === JSON.stringify({ id, text, icon }), JSON.stringify(got));
    }
    check(scene, 'under an hour the age stays', (await dwellOf(p, 'Fresh work')) === null
      && /^\d+m ago$/.test((await p.locator(label('Fresh work') + ' ' + byId('card-age')).first().innerText()).trim()));
    check(scene, 'waiting and done: none', (await dwellOf(p, 'Old waiting')) === null && (await dwellOf(p, 'Finished card')) === null);
    const warnText = rgb((await style(p, label('Review for long') + ' ' + byId('card-dwell-text'), ['color'])).color);
    check(scene, 'the warning\'s orange: 4.5:1 on the card (readable)', warnText === readableHex(c.statusWarning, c.card) && contrast(warnText, c.card) >= 4.5, warnText);
    const muted = rgb((await style(p, label('Review short') + ' ' + byId('card-dwell-text'), ['color'])).color);
    check(scene, 'a plain time is muted like the age', muted === readableHex(c.foregroundMuted, c.card), muted);
    // Line two's right end, level with the name; the card no taller than one without it.
    const db = await box(p, label('Review for long') + ' ' + byId('card-dwell-warn')), ab = await box(p, label('Review for long') + ' ' + byId('card-agent'));
    const cb = await box(p, label('Review for long') + ' ' + byId('card-content'));
    check(scene, 'on line two\'s right, level with the assignee', Math.abs(db.x + db.width - (cb.x + cb.width - 13)) <= 2
      && Math.abs(db.y + db.height / 2 - (ab.y + ab.height / 2)) <= 2 && db.x >= ab.x + ab.width - 1, JSON.stringify({ db, ab, cb }));
    const tall = async title => (await box(p, label(title))).height;
    check(scene, 'the card as tall', await tall('Review for long') === await tall('Fresh work') && await tall('Stalled work') === await tall('Old waiting'));
    check(scene, 'not counted as needing attention', (await p.locator(byId('attention-count')).first().innerText()).trim() === dwellAttention && dwellAttention === '1', dwellAttention);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    // The mouse on it: when it came in, why it warns, the last change — under it, inside the window.
    await moveTo(p, label('Review for long') + ' ' + byId('card-dwell-warn'));
    const tip = byId('card-hint-dwell'), tb = await box(p, tip).catch(() => null);
    const tipText = tb ? (await p.locator(tip).first().innerText()).trim() : '';
    check(scene, 'the hint: entered, why, the last change', /^Entered this stage \d{2}-\d{2} \d{2}:\d{2}\nWaiting in review over 12h\nUpdated \d+h ago$/.test(tipText), tipText);
    check(scene, 'the hint under the time, inside the window', !!tb && tb.y >= db.y + db.height - 1 && tb.x >= 0 && tb.x + tb.width <= 1400, JSON.stringify({ tb, db }));
    await p.screenshot({ path: path.join(out, `${scene}-hint.png`) });
    await away(p);
    check(scene, 'gone when the mouse leaves', !(await visible(p, tip)));
    // The detail says when it came in.
    await clickAt(p, label('Review for long') + ' ' + byId('card-title'));
    await p.waitForSelector(byId('detail-meta'), { timeout: 5000 }).catch(() => {});
    const meta = (await p.locator(byId('detail-meta')).first().innerText().catch(() => '')).trim();
    check(scene, 'the detail: "Entered this stage · MM-DD HH:MM"', /Entered this stage · \d{2}-\d{2} \d{2}:\d{2}(\n|$)/.test(meta), meta);
    // REQ-112: right under it, why it warns — the hint's words, in the warning orange with its ⚠.
    check(scene, 'REQ-112 the detail: why it warns, under "Entered this stage"', /Entered this stage · [^\n]+\n(T\n)?Waiting in review over 12h(\n|$)/.test(meta), meta);
    const detailWarn = rgb((await style(p, byId('detail-dwell-warn-text'), ['color'])).color);
    check(scene, 'REQ-112 … in the warning colour (readable on the detail)', detailWarn === readableHex(c.statusWarning, c.surface0), detailWarn);
    await p.screenshot({ path: path.join(out, `${scene}-detail.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  {
    const scene = 'req86-phone-light';
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true, 'dwell'));
    await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 });
    for (const [tab, titles] of [['review', ['Review for long', 'Review short']], ['doing', ['Stalled work', 'Busy work']]]) {
      await p.locator(byId('mobile-tab-' + tab)).first().tap(); await p.waitForTimeout(400);
      for (const title of titles) {
        const [id, text, icon] = dwellWant[title], got = await dwellOf(p, title);
        check(scene, title + ' on a phone', JSON.stringify(got) === JSON.stringify({ id, text, icon }), JSON.stringify(got));
      }
      if (tab === 'review') await p.screenshot({ path: path.join(out, `${scene}-review.png`) });
    }
    const db = await box(p, label('Stalled work') + ' ' + byId('card-dwell-warn')), cb = await box(p, label('Stalled work') + ' ' + byId('card-content'));
    check(scene, 'at line two\'s right end on a phone too', Math.abs(db.x + db.width - (cb.x + cb.width - 13)) <= 2, JSON.stringify({ db, cb }));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  // ---- REQ-84: busy marks — a dashed ring and edge, the words and how long; orange past 2h; the detail turns one off ------
  const busyOf = async (p, title) => {
    const sel = label(title) + ' [data-testid^="card-busy"]';
    if (!(await p.locator(sel).count())) return null;
    const row = p.locator(label(title) + ' ' + byId('card-busy')).or(p.locator(label(title) + ' ' + byId('card-busy-overdue')));
    return { id: await row.first().getAttribute('data-testid'), text: (await row.first().innerText()).replace(/\s+/g, ' ').trim() };
  };
  const dwellId = async (p, title) => p.locator(label(title) + ' [data-testid^="card-dwell"]').first().getAttribute('data-testid').catch(() => null);
  for (const mode of ['light', 'dark']) {
    const scene = `req84-wide-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'busy'));
    await p.waitForSelector(label('Long build') + ' ' + byId('card-busy-overdue'), { timeout: 15000 }).catch(() => {});
    check(scene, 'the marked card: its words and how long', JSON.stringify(await busyOf(p, 'Test run')) === JSON.stringify({ id: 'card-busy', text: 'Testing · 12m' }),
      JSON.stringify(await busyOf(p, 'Test run')));
    check(scene, 'over 2h: orange, "Over 2h"', JSON.stringify(await busyOf(p, 'Long build')) === JSON.stringify({ id: 'card-busy-overdue', text: 'Build · 2h · Over 2h' }),
      JSON.stringify(await busyOf(p, 'Long build')));
    check(scene, 'no mark, no row', (await busyOf(p, 'Plain work')) === null);
    // Dashed, unlike an agent's ring: the ring and the card's edge, blue as work (orange once over 2h), 3:1 on the face.
    const edge = await style(p, label('Test run') + ' ' + byId('card-content'), ['borderTopStyle', 'borderTopColor']);
    const ring = await style(p, label('Test run') + ' ' + byId('card-busy-ring'), ['borderTopStyle', 'borderTopColor']);
    const blue = markLine(c.running, c, c.card).toLowerCase();
    check(scene, 'a dashed edge and ring in the work colour', edge.borderTopStyle === 'dashed' && ring.borderTopStyle === 'dashed'
      && rgb(edge.borderTopColor) === blue && rgb(ring.borderTopColor) === blue && contrast(blue, c.card) >= 3, JSON.stringify({ edge, ring, blue }));
    const late = await style(p, label('Long build') + ' ' + byId('card-content'), ['borderTopStyle', 'borderTopColor']);
    const lateText = rgb((await style(p, label('Long build') + ' ' + byId('card-busy-overdue-text'), ['color'])).color);
    check(scene, 'over 2h: the edge orange (3:1), the words orange (4.5:1)', late.borderTopStyle === 'dashed'
      && rgb(late.borderTopColor) === markLine(c.statusWarning, c, c.card).toLowerCase() && lateText === readableHex(c.statusWarning, c.card)
      && contrast(lateText, c.card) >= 4.5, JSON.stringify({ late, lateText }));
    check(scene, 'an unmarked card keeps its solid edge', (await style(p, label('Plain work') + ' ' + byId('card-content'), ['borderTopStyle'])).borderTopStyle === 'solid');
    // One row taller, under line two and over nothing else.
    const tall = async title => (await box(p, label(title))).height;
    check(scene, 'a row taller (16 and its gap)', await tall('Test run') - await tall('Plain work') === 22, String(await tall('Test run') - await tall('Plain work')));
    // REQ-86: while marked, the 2h no-agent warning stays quiet; unmarked, it warns as before.
    check(scene, 'REQ-86: marked in progress 3h — a plain clock; unmarked — the warning', await dwellId(p, 'Test run') === 'card-dwell'
      && await dwellId(p, 'Plain work') === 'card-dwell-warn', JSON.stringify([await dwellId(p, 'Test run'), await dwellId(p, 'Plain work')]));
    check(scene, 'over 2h counts as needing a person', (await p.locator(byId('attention-count')).first().innerText()).trim() === '1');
    // REQ-104: the lead's "Testing HH:MM~" from its sub-card's mark (no "총괄 확인" card on this board).
    const lead = (await p.locator(label('Lead-07') + ' ' + byId('lead-status')).first().innerText()).replace(/\s+/g, ' ').trim().replace(/^C /, '');
    const leadParts = await spokenParts(p, label('Lead-07') + ' ' + byId('family-summary'));
    check(scene, 'REQ-104: the lead reads the mark\'s time (REQ-130: its own state on the row; REQ-135: the part on the family line)', /^Idle · since [0-9: -]+$/.test(lead)
      && leadParts === 'Testing ' + deviceClock(U_SINCE, Date.now()) + '~', lead + ' / ' + leadParts);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    // The mouse on the row: since when and by whom (and, over 2h, what to do).
    await moveTo(p, label('Long build') + ' ' + byId('card-busy-overdue'));
    const tip = (await p.locator(byId('card-hint-busy')).first().innerText().catch(() => '')).trim();
    check(scene, 'the hint: since, by whom, what to do', /^Since \d{2}-\d{2} \d{2}:\d{2} · by reviewer\nOn for over 2h — check it is still running, then turn it off$/.test(tip), tip);
    await p.screenshot({ path: path.join(out, `${scene}-hint.png`) });
    await away(p);
    // The detail: the same line and "Turn off", by a real click; the card loses its mark and the count its one.
    await clickAt(p, label('Long build') + ' ' + byId('card-title'));
    await p.waitForSelector(byId('detail-busy-overdue'), { timeout: 5000 }).catch(() => {});
    const line = (await p.locator(byId('detail-busy-text')).first().innerText().catch(() => '')).trim();
    check(scene, 'the detail says it too', line === 'Build · 2h · Over 2h', line);
    await p.screenshot({ path: path.join(out, `${scene}-detail.png`) });
    await clickAt(p, byId('detail-busy-off'));
    await p.waitForSelector(byId('detail-busy-overdue'), { state: 'detached', timeout: 5000 }).catch(() => {});
    const sent = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.busy.clear').map(v => v.input));
    check(scene, '"Turn off" sends busy.clear for that card, once', sent.length === 1 && sent[0].cardId && Object.keys(sent[0]).sort().join() === 'boardId,cardId', JSON.stringify(sent));
    check(scene, 'the detail\'s line is gone', !(await visible(p, byId('detail-busy-overdue'))));
    await escapeFrom(p, 'editor-sheet');
    await p.waitForFunction(() => !document.querySelector('[aria-label="Long build"] [data-testid^="card-busy"]'), null, { timeout: 8000 }).catch(() => {});
    check(scene, 'the card loses its mark, the count its one', (await busyOf(p, 'Long build')) === null
      && (await p.locator(byId('attention-count')).count() === 0 || (await p.locator(byId('attention-count')).first().innerText()).trim() === '0'));
    // Turned off from outside (`kanban card busy --off`): the revision stays, the fingerprint moves; the next look (4 s) shows it.
    await p.evaluate(() => { const id = [...window.__cards.values()].find(s => s.card.title === 'Test run').card.id; window.__busyOff(id); });
    await p.waitForFunction(() => !document.querySelector('[aria-label="Test run"] [data-testid^="card-busy"]'), null, { timeout: 10000 }).catch(() => {});
    check(scene, 'auto refresh: turned off elsewhere, gone within a look', (await busyOf(p, 'Test run')) === null);
    // Research/174 J2: the run just ended counts as the card's last activity — the 2h starts from its end, so no warning yet.
    check(scene, 'J2: turned off just now — the clock, no 2h warning', await dwellId(p, 'Test run') === 'card-dwell');
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'no settings written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  {
    // Research/174 D1: the list view with a mark on and nothing changing reads the overview once, then only looks (4 s):
    // its boards carry the same busy fingerprint as revisions.get, so no look is a change. 24 s, as the gate measured.
    const scene = 'req84-list-quiet';
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', false, 'busy'));
    await p.waitForSelector(byId('view-list'), { timeout: 15000 });
    await clickAt(p, byId('view-list'));
    await p.waitForSelector(byId('list-title-row'), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(1000);
    const count = name => p.evaluate(n => window.__calls.filter(c => c === n).length, name);
    const reads = await count('kanban.v1.overview.get'), looks = await count('kanban.v1.revisions.get');
    await p.waitForTimeout(24000);
    const reread = await count('kanban.v1.overview.get') - reads, looked = await count('kanban.v1.revisions.get') - looks;
    check(scene, 'the list view is shown', await visible(p, byId('list-title-row')));
    check(scene, '24 s with a mark on and no change: looks, but no overview.get', reread === 0 && looked >= 5, JSON.stringify({ reread, looked }));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  {
    const scene = 'req84-phone-light';
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true, 'busy'));
    await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 });
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(400);
    check(scene, 'the marked card on a phone', JSON.stringify(await busyOf(p, 'Test run')) === JSON.stringify({ id: 'card-busy', text: 'Testing · 12m' }),
      JSON.stringify(await busyOf(p, 'Test run')));
    check(scene, 'over 2h on a phone', JSON.stringify(await busyOf(p, 'Long build')) === JSON.stringify({ id: 'card-busy-overdue', text: 'Build · 2h · Over 2h' }),
      JSON.stringify(await busyOf(p, 'Long build')));
    const rb = await box(p, label('Long build') + ' ' + byId('card-busy-overdue')), cb = await box(p, label('Long build') + ' ' + byId('card-content'));
    check(scene, 'the row inside the card', rb.x >= cb.x && rb.x + rb.width <= cb.x + cb.width + 1 && rb.y + rb.height <= cb.y + cb.height, JSON.stringify({ rb, cb }));
    await p.screenshot({ path: path.join(out, `${scene}-doing.png`) });
    await p.locator(label('Test run') + ' ' + byId('card-title')).first().tap();
    await p.waitForSelector(byId('detail-busy'), { timeout: 5000 }).catch(() => {});
    const off = await box(p, byId('detail-busy-off'));
    check(scene, 'the detail\'s "Turn off" on a phone: 44px tall', !!off && off.height >= 44, JSON.stringify(off));
    await p.locator(byId('detail-busy-off')).first().tap();
    await p.waitForSelector(byId('detail-busy'), { state: 'detached', timeout: 5000 }).catch(() => {});
    check(scene, 'tapped off', !(await visible(p, byId('detail-busy'))) && (await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.busy.clear').length)) === 1);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-90: the lab (behind the developer key) and its "messages waiting" badge; Korean words -------------------------
  const devKey = async context => context.addInitScript(() => { window.localStorage.setItem('paseo-kanban:dev-demo', '1'); });
  const badgeText = async p => (await p.locator(byId('lane-mail-badge-text')).allInnerTexts()).map(v => v.replace(/\s+/g, ' ').trim());
  for (const mode of ['light', 'dark']) {
    const scene = `req90-wide-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'mail'));
    await p.waitForSelector(byId('lane-mail-badge'), { timeout: 15000 }).catch(() => {});
    check(scene, 'a badge on each lane with threads waiting: 교신 2 and 교신 1', JSON.stringify(await badgeText(p)) === JSON.stringify(['교신 2', '교신 1']),
      JSON.stringify(await badgeText(p)));
    const color = rgb((await style(p, byId('lane-mail-badge-text'), ['color'])).color);
    check(scene, 'the badge\'s words read 4.5:1 on the heading', contrast(color, c.surface0) >= 4.5, color);
    const bb = await box(p, byId('lane-mail-badge')), heading = await box(p, byId('swimlane-lane-header'));
    check(scene, 'inside the lane heading', bb && heading && bb.y >= heading.y - 1 && bb.y + bb.height <= heading.y + heading.height + 1, JSON.stringify({ bb, heading }));
    await away(p);
    await moveTo(p, byId('lane-mail-badge'));
    const tip = (await p.locator(byId('lane-mail-tip')).first().innerText().catch(() => '')).trim();
    check(scene, 'the tip: whose turn, each thread and its newest file, the unknown ones',
      tip === ['wks_example01 차례 2건', '· 20260928-0900_wsB_one', '  ' + MAIL_DIR + '/20260928-0900_wsB_one/20260928-0910_wsB_회신.md',
        '· 20260928-0901_wsB_two', '  ' + MAIL_DIR + '/20260928-0901_wsB_two/20260928-0901_wsB_요청.md', '형식 모름 1'].join('\n'), JSON.stringify(tip));
    const tb = await box(p, byId('lane-mail-tip'));
    check(scene, 'the tip is inside the window', tb && tb.x >= 0 && tb.x + tb.width <= 1920 && tb.y >= 0, JSON.stringify(tb));
    await p.screenshot({ path: path.join(out, `${scene}-tip.png`) });
    await away(p);
    check(scene, 'the tip goes with the mouse', !(await visible(p, byId('lane-mail-tip'))));
    if (mode === 'light') {
      // The looks (4 s) carry the host and hear the same fingerprint: nothing is read again.
      const count = name => p.evaluate(n => window.__calls.filter(c => c === n).length, name);
      const reads = await count('kanban.v1.overview.get');
      await p.waitForTimeout(9000);
      const looks = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.revisions.get').map(v => v.input));
      check(scene, 'looks carry the host; the same fingerprint reads nothing again', looks.length >= 2 && looks.every(v => v.hostId === 'host_example')
        && await count('kanban.v1.overview.get') === reads, JSON.stringify({ looks: looks.length, reads, now: await count('kanban.v1.overview.get') }));
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  {
    // The settings window: no lab without the developer key; with it, the lab's note and rows; a real click turns it off.
    const scene = 'req90-settings-light';
    const plain = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    const errors = []; plain.on('pageerror', e => errors.push(String(e)));
    await plain.goto(page('light', false, 'mail'));
    await plain.waitForSelector(byId('open-settings'), { timeout: 15000 });
    await clickAt(plain, byId('open-settings'));
    await plain.waitForSelector(byId('settings-tab-display'), { timeout: 5000 }).catch(() => {});
    check(scene, 'no developer key: no lab tab', await visible(plain, byId('settings-tab-display')) && !(await visible(plain, byId('settings-tab-labs'))));
    await plain.context().close();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); await devKey(context);
    const p = await context.newPage(); p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', false, 'mail'));
    await p.waitForSelector(byId('lane-mail-badge'), { timeout: 15000 }).catch(() => {});
    await clickAt(p, byId('open-settings'));
    await p.waitForSelector(byId('settings-tab-labs'), { timeout: 5000 }).catch(() => {});
    await clickAt(p, byId('settings-tab-labs'));
    await p.waitForSelector(byId('labs-note'), { timeout: 5000 }).catch(() => {});
    const note = (await p.locator(byId('labs-note')).first().innerText().catch(() => '')).trim();
    check(scene, 'the lab\'s note', note.startsWith('베타 · 개발 기기 전용'), note);
    check(scene, 'the switch shows on, the folder and the rule as saved', (await p.locator(byId('labs-mail-toggle')).first().getAttribute('aria-checked')) === 'true'
      && (await p.locator(byId('labs-mail-dir')).first().inputValue()) === MAIL_DIR
      && (await p.locator(byId('labs-alias-compact')).first().getAttribute('aria-checked')) === 'true');
    const status = (await p.locator(byId('labs-mail-status')).first().innerText().catch(() => '')).trim();
    check(scene, 'what the folder read', status === '열린 스레드 4건 읽음 · 형식 모름 1', status);
    await p.screenshot({ path: path.join(out, `${scene}-labs.png`) });
    check(scene, 'opening writes nothing', (await p.evaluate(() => window.__writes.length)) === 0);
    await clickAt(p, byId('labs-mail-toggle'));
    await p.waitForFunction(() => window.__writes.length === 1, null, { timeout: 5000 }).catch(() => {});
    const sent = await p.evaluate(() => window.__writes);
    check(scene, 'a click turns it off, the whole lab sent', JSON.stringify(sent) === JSON.stringify([{ hostId: 'host_example', settings: { labs: { mail: false, mailDir: MAIL_DIR } } }]),
      JSON.stringify(sent));
    await escapeFrom(p, 'settings-window');
    await p.waitForSelector(byId('lane-mail-badge'), { state: 'detached', timeout: 5000 }).catch(() => {});
    check(scene, 'off: the badges go', !(await visible(p, byId('lane-mail-badge'))));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  {
    const scene = 'req90-phone-light';
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); await devKey(context);
    const p = await context.newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true, 'mail'));
    await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 });
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(400);
    // research/179 J3: the envelope and the number only; "교신 N" stays in the label a screen reader reads.
    check(scene, 'the badges in the workspace headings: the number only', JSON.stringify(await badgeText(p)) === JSON.stringify(['2', '1']), JSON.stringify(await badgeText(p)));
    check(scene, 'J3 the label still says 교신 N', ((await p.locator(byId('lane-mail-badge')).first().getAttribute('aria-label')) ?? '').startsWith('교신 2: '));
    const bb = await box(p, byId('lane-mail-badge')), hb = await box(p, byId('mobile-workspace-heading'));
    check(scene, 'inside the heading, within the screen', bb && hb && bb.y >= hb.y - 1 && bb.y + bb.height <= hb.y + hb.height + 1 && bb.x + bb.width <= 390,
      JSON.stringify({ bb, hb }));
    const controls = await box(p, byId('mobile-heading-controls'));
    check(scene, 'J3 about 29px wide, at the right end by the controls', bb.width <= 32 && controls && controls.x - (bb.x + bb.width) >= 0 && controls.x - (bb.x + bb.width) <= 6,
      JSON.stringify({ bb, controls }));
    // J3: how much of the same name shows — with the badge, with it at the old "교신 N" width (52px), and with no badge.
    const names = async () => (await p.locator(byId('mobile-workspace-heading')).first().locator(byId('workspace-name-primary') + ', ' + byId('workspace-name-detail'))
      .evaluateAll(els => els.map(el => {
        const right = el.getBoundingClientRect().right - (el.scrollWidth > el.clientWidth ? 8 : 0), walk = document.createTreeWalker(el, 4), range = document.createRange();
        let n = 0, node;
        while ((node = walk.nextNode())) for (let i = 0; i < node.length; i++) { range.setStart(node, i); range.setEnd(node, i + 1); if (range.getBoundingClientRect().right <= right) n++; }
        return n;
      }))).reduce((sum, n) => sum + n, 0);
    const restyle = css => p.evaluate(text => { document.getElementById('r180')?.remove(); if (!text) return;
      const tag = document.createElement('style'); tag.id = 'r180'; tag.textContent = text; document.head.append(tag); }, css);
    const now = await names();
    await restyle('[data-testid="lane-mail-badge"] { min-width: 52px }'); await p.waitForTimeout(150); const old = await names();
    await restyle('[data-testid="lane-mail-badge"] { display: none }'); await p.waitForTimeout(150); const none = await names();
    await restyle(''); await p.waitForTimeout(150);
    check(scene, 'J3 the same name shows more than beside the old-width badge', now > old && now <= none, JSON.stringify({ now, old, none }));
    console.log('research/180 J3 characters shown (name and project):', JSON.stringify({ now, old, none }));
    // REQ-134 MA: a tap opens the message list (=req134); the threads' tip is the long press's.
    await hold(p, byId('lane-mail-badge'));
    const tb = await box(p, byId('lane-mail-tip'));
    check(scene, 'a long press shows the threads, inside the screen', !!tb && tb.x >= 0 && tb.x + tb.width <= 390, JSON.stringify(tb));
    await p.screenshot({ path: path.join(out, `${scene}-tip.png`) });
    await hold(p, byId('lane-mail-badge'));
    check(scene, 'a second long press closes it', !(await visible(p, byId('lane-mail-tip'))));
    // The settings sheet: the lab among the categories (the developer key is set here).
    await p.locator(byId('open-settings')).first().tap();
    await p.waitForSelector(byId('settings-open-labs'), { timeout: 5000 }).catch(() => {});
    await p.locator(byId('settings-open-labs')).first().tap();
    await p.waitForSelector(byId('labs-note'), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(500);
    check(scene, 'the lab on a phone', await visible(p, byId('labs-mail-toggle')) && await visible(p, byId('labs-mail-dir')));
    await p.screenshot({ path: path.join(out, `${scene}-labs.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  // ---- D44: each workspace's auto-card switch in the settings window, wide and on a phone ----------------------------------
  for (const [scene, width, height, mobile] of [['d44-settings-workspaces-light', 1920, 1080, false], ['d44-settings-workspaces-phone-light', 390, 844, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const p = await context.newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', mobile));
    await p.waitForSelector(byId('open-settings'), { timeout: 15000 });
    const press = sel => mobile ? p.locator(sel).first().tap() : clickAt(p, sel);
    await press(byId('open-settings'));
    const tab = mobile ? 'settings-open-automation' : 'settings-tab-automation';
    await p.waitForSelector(byId(tab), { timeout: 5000 }).catch(() => {});
    await press(byId(tab));
    await p.waitForSelector(byId('auto-cards-workspace-list'), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(300);
    const rows = await p.locator('[data-testid^="auto-cards-workspace-toggle-"]').count();
    const names = await p.locator('[data-testid^="auto-cards-workspace-"]:not([data-testid*="toggle"]):not([data-testid$="list"])').allInnerTexts();
    check(scene, 'one switch per workspace, all on', rows >= 2 && (await p.locator('[data-testid^="auto-cards-workspace-toggle-"][aria-checked="true"]').count()) === rows,
      JSON.stringify({ rows, names }));
    const lb = await box(p, byId('auto-cards-workspace-list'));
    check(scene, 'the list fits the window', !!lb && lb.x >= 0 && lb.x + lb.width <= width, JSON.stringify(lb));
    await p.screenshot({ path: path.join(out, `${scene}-on.png`) });
    await press(byId('auto-cards-workspace-toggle-0'));
    await p.waitForFunction(() => window.__inputs.some(v => v.name === 'kanban.v1.auto_cards.workspace.set'), null, { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(300);
    const sent = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.auto_cards.workspace.set').map(v => v.input));
    check(scene, 'a press turns one workspace off by its folder', sent.length === 1 && sent[0].enabled === false && typeof sent[0].cwd === 'string' && sent[0].cwd.startsWith('/'),
      JSON.stringify(sent));
    check(scene, 'that switch shows off, the others on', (await p.locator(byId('auto-cards-workspace-toggle-0')).first().getAttribute('aria-checked')) === 'false'
      && (await p.locator('[data-testid^="auto-cards-workspace-toggle-"][aria-checked="true"]').count()) === rows - 1);
    await p.screenshot({ path: path.join(out, `${scene}-off.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'no setting or card written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  // ---- research/179 D1: the phone tip is never covered by the next lane, and hangs above near the bottom of the board --------
  /** Which of 16 bands down the tip's middle show the tip itself on top (its pointer-events turned on for the probe only). */
  const onTop = p => p.evaluate(sel => {
    const tag = document.createElement('style'); tag.textContent = sel + ', ' + sel + ' * { pointer-events: auto !important }'; document.head.append(tag);
    const el = document.querySelector(sel), r = el.getBoundingClientRect(), bands = [];
    for (let k = 0; k < 16; k++) bands.push(el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + (k + .5) * r.height / 16)) ? 1 : 0);
    tag.remove(); return bands.join('');
  }, byId('lane-mail-tip'));
  for (const [scene, height, tab, nth] of [['r180-phone-tip-light', 844, 'todo', 0], ['r180-phone-tip-above-light', 600, 'doing', 1]]) {
    const context = await browser.newContext({ viewport: { width: 390, height }, hasTouch: true, isMobile: true });
    const p = await context.newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true, 'mailtall'));
    await p.waitForSelector(byId('mobile-tab-' + tab), { timeout: 15000 });
    await p.locator(byId('mobile-tab-' + tab)).first().tap(); await p.waitForTimeout(400);
    const badge = p.locator(byId('lane-mail-badge')).nth(nth), bb = await badge.boundingBox(), area = await box(p, byId('mobile-workspace-sections'));
    const next = (await p.locator('[data-testid^="mobile-workspace-board_"]').evaluateAll(els => els.map(e => e.getBoundingClientRect().top)))[1];
    await hold(p, byId('lane-mail-badge'), nth); await p.waitForTimeout(50);
    const tb = await box(p, byId('lane-mail-tip'));
    check(scene, 'a long press shows the tip, inside the screen (REQ-134: a tap opens the list)', !!tb && tb.x >= 0 && tb.x + tb.width <= 390, JSON.stringify(tb));
    if (!tb) { await context.close(); continue; }
    check(scene, 'the whole tip inside the board', tb.y >= area.y - 1 && tb.y + tb.height <= area.y + area.height + 1, JSON.stringify({ tb, area }));
    if (nth === 0) check(scene, 'D1 case: the tip runs past the first lane into the next one', tb.y + tb.height > next + 40, JSON.stringify({ tb, next }));
    else check(scene, 'too tall to fit below: it hangs above the badge', tb.y + tb.height <= bb.y + 1
      && bb.y + bb.height + 4 + tb.height > area.y + area.height, JSON.stringify({ tb, bb, area }));
    const bands = await onTop(p);
    check(scene, 'D1 nothing covers any part of the tip', bands === '1'.repeat(16), bands);
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    await hold(p, byId('lane-mail-badge'), nth);
    check(scene, 'a second long press closes it', !(await visible(p, byId('lane-mail-tip'))));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  // ---- REQ-110~116 by real input (the owner's screenshots, 2026-09-28): the lane name's tip, the lane ⋯ as a small menu, the
  // filter glyph and its menu, the To Do "+", a lead card as tall as what it holds ----
  for (const mode of ['light', 'dark']) {
    const scene = `req110-wide-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'lead'));
    await p.waitForSelector(byId('workspace-name-link'), { timeout: 15000 });
    await p.waitForSelector(byId('family-summary'), { timeout: 15000 }).catch(() => {});
    // REQ-110: the name's tip says what a press does, nothing more.
    await moveTo(p, byId('workspace-name-link'));
    check(scene, 'REQ-110 the name tip: "Open board" alone', (await p.locator(byId('lane-name-tooltip')).first().innerText().catch(() => '')).trim() === 'Open board');
    await away(p);
    // REQ-111: the lane ⋯ — a small menu hanging from it, its right edge on the ⋯'s; Escape closes it.
    const dots = await clickAt(p, byId('lane-order-menu')); await p.waitForTimeout(200);
    const menu = await box(p, byId('order-popover')).catch(() => null);
    check(scene, 'REQ-111 the ⋯ opens a small menu right under it', !!menu && menu.y >= dots.y + dots.height - 1 && menu.y <= dots.y + dots.height + 12
      && Math.abs(menu.x + menu.width - (dots.x + dots.width)) <= 2, JSON.stringify({ dots, menu }));
    check(scene, 'REQ-111 … no sheet, the same items', (await p.locator(byId('menu-sheet')).count()) === 0
      && JSON.stringify(await p.locator(byId('order-popover') + ' [role="menuitem"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid'))))
        // REQ-52: a workspace's archived cards, right under "Open in board".
        === JSON.stringify(['order-open-board', 'order-archived', 'order-move-top', 'order-move-up', 'order-move-down']));
    if (mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-order.png`) });
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    check(scene, 'REQ-111 Escape closes it', !(await visible(p, byId('order-popover'))));
    // REQ-114: one glyph with a count; its menu under it, clearing one filter or all.
    check(scene, 'REQ-114 no filters: the glyph without a count, no words', (await p.locator(byId('filter-menu-badge')).count()) === 0
      && (await p.locator(byId('active-filter-count')).count()) === 0 && (await p.locator(byId('filter-menu')).count()) === 1);
    await p.locator(byId('board-search')).first().fill('card'); await p.waitForTimeout(300);
    await clickAt(p, byId('attention-chip')); await p.waitForTimeout(200);
    check(scene, 'REQ-114 two filters: "2" on the glyph', (await p.locator(byId('filter-menu-badge')).first().innerText().catch(() => '')).trim() === '2'
      && (await p.locator(byId('filter-menu')).first().getAttribute('aria-label')) === 'Filters: 2 applied');
    const fg = await clickAt(p, byId('filter-menu')); await p.waitForTimeout(200);
    const fl = await box(p, byId('filter-menu-list')).catch(() => null);
    check(scene, 'REQ-114 the menu hangs under the glyph, from its left edge', !!fl && fl.y >= fg.y + fg.height - 1 && Math.abs(fl.x - fg.x) <= 2, JSON.stringify({ fg, fl }));
    if (mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-filters.png`) });
    await clickAt(p, byId('filter-clear-query')); await p.waitForTimeout(250);
    check(scene, 'REQ-114 ✕ clears that one alone', (await p.locator(byId('board-search')).first().inputValue()) === ''
      && (await p.locator(byId('filter-menu-badge')).first().innerText().catch(() => '')).trim() === '1' && await visible(p, byId('filter-menu-list')));
    await clickAt(p, byId('filter-clear-all')); await p.waitForTimeout(250);
    check(scene, 'REQ-114 "Clear all" clears the rest and closes', (await p.locator(byId('filter-menu-badge')).count()) === 0 && !(await visible(p, byId('filter-menu-list'))));
    // REQ-116: the lead's short title keeps no second line — its status row ends the card.
    const lead = await box(p, byId('swimlane-cell-review') + ' ' + label(Q_TITLE)), status = await box(p, label(Q_TITLE) + ' ' + byId('lead-status'));
    // Under it only the card's padding and the few px line two keeps for "Done" (35px before: a second title line kept for nothing).
    check(scene, 'REQ-116 the lead card ends with its status row', !!lead && !!status && lead.y + lead.height - (status.y + status.height) <= 20, JSON.stringify({ lead, status }));
    // REQ-113: the To Do heading's "+" — the sheet names the workspace and offers none to pick; saving adds a draft there.
    await clickAt(p, byId('todo-create'));
    await p.waitForSelector(byId('create-criteria'), { timeout: 5000 }).catch(() => {});
    check(scene, 'REQ-113 the sheet: that workspace, none to pick', (await p.locator(byId('create-board-choice')).count()) === 0
      && (await p.getByText(/^New draft in To Do: /).count()) > 0);
    if (mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-draft.png`) });
    await p.locator('[aria-label="Title"]').first().fill('Quick idea');
    await p.getByText('Save draft', { exact: true }).first().click(); await p.waitForTimeout(600);
    const added = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').map(v => v.input.operations.map(o => o.op + ':' + (o.title ?? ''))));
    check(scene, 'REQ-113 one add, the title given', JSON.stringify(added) === JSON.stringify([['add:Quick idea']]), JSON.stringify(added));
    check(scene, 'REQ-113 the sheet closes at once', !(await visible(p, byId('create-criteria'))));
    // research/187 J3: the new draft is in sight in its To Do column with a ring, which goes after two seconds.
    const ringed = '[data-testid^="linked-card-"]:has([aria-label="Quick idea"]) ' + byId('fresh-highlight');
    await p.waitForSelector(ringed, { timeout: 5000 }).catch(() => {});
    const fresh = await box(p, ringed).catch(() => null);
    check(scene, 'research/187 J3 the new draft rings, in sight', !!fresh && fresh.y >= 0 && fresh.y + fresh.height <= 900, JSON.stringify(fresh));
    await p.waitForTimeout(2300);
    check(scene, 'research/187 J3 the ring goes after two seconds', (await p.locator(byId('fresh-highlight')).count()) === 0
      && await visible(p, '[aria-label="Quick idea"]'));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  {
    const scene = 'req113-phone-light';
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true));
    await p.waitForSelector(byId('mobile-tab-todo'), { timeout: 15000 });
    // research/187 J2: no "+" on any workspace heading, so the name keeps the same room on the To Do tab as on another.
    const nameWidth = async () => (await box(p, byId('mobile-workspace-heading') + ' ' + byId('workspace-name-link')).catch(() => null))?.width ?? 0;
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(300);
    const doingName = await nameWidth();
    check(scene, 'research/187 J2 no "+" on the in-progress tab', (await p.locator(byId('todo-create')).count()) === 0);
    await p.locator(byId('mobile-tab-todo')).first().tap(); await p.waitForTimeout(300);
    const todoName = await nameWidth();
    check(scene, 'research/187 J2 no "+" on the To Do tab either', (await p.locator(byId('todo-create')).count()) === 0);
    // The in-progress heading may carry the lane glyph (⇕) the To Do one has not here, so "no narrower" rather than equal.
    check(scene, 'research/187 J2 the workspace name no narrower on the To Do tab than on another', todoName > 0 && todoName >= doingName - 1,
      JSON.stringify({ doingName, todoName }));
    // The lane ⋯ sheet, opened on the in-progress tab, starts with "New draft" — a draft into that workspace's To Do.
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(300);
    await p.locator(byId('lane-order-menu')).first().tap();
    await p.waitForSelector(byId('order-draft'), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(400);
    const items = await p.locator(byId('menu-sheet') + ' [data-testid^="order-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')));
    check(scene, 'research/187 J2 the sheet starts with "New draft"', items[0] === 'order-draft'
      && (await p.locator(byId('order-draft')).first().innerText().catch(() => '')).trim() === 'New draft', JSON.stringify(items));
    const item = await box(p, byId('order-draft')).catch(() => null);
    check(scene, 'research/187 J2 "New draft" is a 44px press', !!item && item.height >= 44, JSON.stringify(item));
    await p.screenshot({ path: path.join(out, `${scene}-lane-sheet.png`) });
    await p.locator(byId('order-draft')).first().tap();
    await p.waitForSelector(byId('create-criteria'), { timeout: 5000 }).catch(() => {});
    check(scene, 'REQ-113 the sheet with no workspace to pick', await visible(p, byId('create-criteria')) && (await p.locator(byId('create-board-choice')).count()) === 0
      && (await p.getByText(/^New draft in To Do: Example Workspace/).count()) > 0);
    await p.locator('[aria-label="Title"]').first().fill('Phone idea'); await p.waitForTimeout(200);
    await p.getByText('Save draft', { exact: true }).first().tap(); await p.waitForTimeout(600);
    // research/187 J3 on a phone: the To Do tab, the new card in sight with its ring.
    const ringed = '[data-testid^="linked-card-"]:has([aria-label="Phone idea"]) ' + byId('fresh-highlight');
    await p.waitForSelector(ringed, { timeout: 5000 }).catch(() => {});
    const fresh = await box(p, ringed).catch(() => null);
    check(scene, 'research/187 J3 the To Do tab, the new draft in sight with a ring', !!fresh && fresh.y >= 0 && fresh.y + fresh.height <= 844
      && (await p.locator(byId('create-criteria')).count()) === 0, JSON.stringify(fresh));
    await p.screenshot({ path: path.join(out, `${scene}-fresh.png`) });
    await p.waitForTimeout(2300);
    check(scene, 'research/187 J3 the ring goes after two seconds', (await p.locator(byId('fresh-highlight')).count()) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-118 (the owner's screenshot, 2026-09-29): the filter glyph's count as quiet as the glyph, its tip drawn whole over
  // the board; D42: a hidden project Paseo no longer has is neither counted nor shown, and stays stored ----
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), scene = `req118-wide-${mode}`, want = countBadge(c, c.surface0);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    // D42: the stored list names two projects no workspace belongs to any more.
    await p.addInitScript(() => { let f; Object.defineProperty(window, '__FIXTURE__', { configurable: true, get: () => f,
      set: value => { f = value; f.ui = { ...f.ui, hiddenProjects: ['prj_gone01', 'prj_gone02'] }; } }); });
    await p.goto(page(mode, false));
    await p.waitForSelector(byId('swimlane-cell-doing') + ' [data-testid^="kanban-card-"]', { timeout: 15000 });
    check(scene, 'D42 gone projects: no count, no badge, every project shown', (await p.locator(byId('filter-menu-badge')).count()) === 0
      && (await p.locator(byId('filter-menu')).first().getAttribute('aria-label')) === 'Filters: 0 applied'
      && (await p.locator(byId('project-dropdown-trigger')).first().innerText()).includes('(1/1)'));
    await clickAt(p, byId('filter-menu')); await p.waitForTimeout(200);
    check(scene, 'D42 … and the menu lists no hidden projects', (await p.locator(byId('filter-menu-empty')).count()) === 1
      && (await p.locator(byId('filter-clear-projects')).count()) === 0);
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    // Hiding the one project there: counted as one, and the stored list keeps the two gone ones.
    await clickAt(p, byId('project-dropdown-trigger')); await p.waitForTimeout(200);
    await clickAt(p, byId('project-dropdown-menu') + ' [role="menuitem"][aria-label="Example Project"]'); await p.waitForTimeout(200);
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    const saved = (await p.evaluate(() => window.__writes)).filter(w => w.hiddenProjects).at(-1)?.hiddenProjects ?? [];
    check(scene, 'D42 hiding one: the stored list keeps the gone ones', JSON.stringify([...saved].sort()) === JSON.stringify(['prj_example01', 'prj_gone01', 'prj_gone02']),
      JSON.stringify(saved));
    check(scene, 'D42 … and the glyph counts one', (await p.locator(byId('filter-menu-badge')).first().innerText().catch(() => '')).trim() === '1');
    await clickAt(p, byId('filter-menu')); await p.waitForTimeout(200);
    check(scene, 'D42 … "1 project hidden" in the menu', (await p.locator(byId('filter-clear-projects')).first().innerText().catch(() => '')).trim().startsWith('1 project hidden'));
    await clickAt(p, byId('filter-clear-projects')); await p.waitForTimeout(250);
    const cleared = (await p.evaluate(() => window.__writes)).filter(w => w.hiddenProjects).at(-1)?.hiddenProjects ?? [];
    check(scene, 'D42 clearing it leaves the gone ones stored', JSON.stringify([...cleared].sort()) === JSON.stringify(['prj_gone01', 'prj_gone02']), JSON.stringify(cleared));
    // REQ-118: the count — 14px, weight 500, the glyph's tint, a thin line, the main colour's figure at 4.5:1.
    await p.locator(byId('board-search')).first().fill('card'); await p.waitForTimeout(300);
    const badge = await box(p, byId('filter-menu-badge')), glyph = await box(p, byId('filter-menu'));
    const face = await style(p, byId('filter-menu-badge'), ['backgroundColor', 'borderTopWidth', 'borderTopColor']);
    const figure = await p.locator(byId('filter-menu-badge') + ' div[dir="auto"]').first().evaluate(el => { const s = getComputedStyle(el); return { color: s.color, fontWeight: s.fontWeight, fontSize: s.fontSize }; });
    check(scene, 'REQ-118 the count is small: 14px on the glyph\'s corner', !!badge && badge.height === COUNT_BADGE.size && badge.width <= 16
      && badge.x + badge.width <= glyph.x + glyph.width + COUNT_BADGE.overhang + .5 && badge.y >= glyph.y - COUNT_BADGE.overhang - .5, JSON.stringify({ badge, glyph }));
    check(scene, 'REQ-118 the glyph\'s tint behind it and a 1px line', rgb(face.backgroundColor) === want.fill.toLowerCase() && face.borderTopWidth === '1px'
      && rgb(face.borderTopColor) === want.line.toLowerCase(), JSON.stringify(face));
    check(scene, 'REQ-118 the figure: main colour, weight 500, 4.5:1', rgb(figure.color) === want.text.toLowerCase() && figure.fontWeight === '500'
      && contrast(rgb(figure.color), want.fill) >= 4.5, JSON.stringify(figure) + ' ' + contrast(rgb(figure.color), want.fill).toFixed(2));
    // REQ-118: the tip hangs below the glyph, inside the window, and drawn over the board (nothing covers any of its corners).
    await away(p);
    await moveTo(p, byId('filter-menu')); await p.waitForTimeout(300);
    const tip = await box(p, byId('icon-tooltip')).catch(() => null);
    check(scene, 'REQ-118 the tip inside the window', !!tip && tip.x >= 0 && tip.y >= 0 && tip.x + tip.width <= 1920 && tip.y + tip.height <= 1000 && tip.y >= glyph.y + glyph.height, JSON.stringify(tip));
    const covered = tip ? await p.evaluate(t => { const el = document.querySelector('[data-testid="icon-tooltip"]');
      // The tip lets presses through (RN Web's pointer-events: none !important), so it is made hittable for this look only.
      [el, ...el.querySelectorAll('*')].forEach(n => n.style.setProperty('pointer-events', 'auto', 'important')); return [[t.x + 2, t.y + 2], [t.x + t.width - 2, t.y + 2], [t.x + 2, t.y + t.height - 2], [t.x + t.width - 2, t.y + t.height - 2]]
      .filter(([x, y]) => !document.elementFromPoint(x, y)?.closest('[data-testid="icon-tooltip"]')).length; }, tip) : 4;
    check(scene, 'REQ-118 the tip drawn whole over the board', covered === 0, String(covered));
    await p.screenshot({ path: path.join(out, `${scene}-1920.png`) });
    await p.screenshot({ path: path.join(out, `${scene}-1920-crop.png`), clip: { x: Math.max(0, glyph.x - 420), y: 0, width: 640, height: 200 } });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-117: three levels — the topic lead's mark (REQ-120: a two-tone medal, REQ-123 antique gold, 16px; REQ-121: a petrol ribbon), its whole title, its family line and status row, its place ----
  for (const mode of ['light', 'dark']) {
    const scene = `req117-wide-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'topic'));
    const label = t => `[aria-label="${t}"]`, slot = id => byId('linked-card-' + vId(id));
    const topic = slot(V.topic), lead = slot(V.lead);
    await p.waitForSelector(topic + ' ' + byId('family-summary'), { timeout: 15000 }).catch(() => {});
    const lane = p.locator(byId('swimlane-lane-section')).filter({ has: p.locator(topic) });
    const cellTitles = stageId => lane.locator(byId('swimlane-cell-' + stageId) + ' [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    const ringed = async () => (await p.locator(byId('family-highlight')).evaluateAll(els => els.map(e => e.parentElement.querySelector('[data-testid^="kanban-card-"]')?.getAttribute('aria-label')))).sort();
    const text = async sel => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    check(scene, '④ in progress: the lead, then the topic lead, then the rest', JSON.stringify(await cellTitles('doing')) === JSON.stringify([V.lead, V.topic, V.subA]),
      JSON.stringify(await cellTitles('doing')));
    check(scene, '④ an archived topic lead in done is not pinned', (await cellTitles('done'))[0] === 'Plain done' && (await cellTitles('done'))[1] === V.old,
      JSON.stringify(await cellTitles('done')));
    check(scene, '⑤ the topic lead\'s title whole, the lead\'s its head', await text(topic + ' ' + byId('card-title')) === V.topic
      && await text(lead + ' ' + byId('card-title')) === '총괄-01', JSON.stringify([await text(topic + ' ' + byId('card-title')), await text(lead + ' ' + byId('card-title'))]));
    check(scene, '③ the topic lead keeps "↳ 총괄-01"; its sub-card says "↳ T01"', (await text(topic + ' ' + byId('family-mark'))).endsWith('총괄-01')
      && (await text(slot(V.subA) + ' ' + byId('family-mark'))).endsWith('T01'), JSON.stringify([await text(topic + ' ' + byId('family-mark')), await text(slot(V.subA) + ' ' + byId('family-mark'))]));
    check(scene, '③ its family line: 2 sub-cards, 1 not done', /2\D+1\b/.test(await text(topic + ' ' + byId('family-summary'))), await text(topic + ' ' + byId('family-summary')));
    // REQ-135: its sub-cards' running count now sits between the two, so each part is read on its own.
    check(scene, '⑥ the lead counts every card under it (5, 2 not done)', /\b5$/.test(await text(lead + ' ' + byId('family-summary-all')))
      && /\b2$/.test(await text(lead + ' ' + byId('family-summary-open'))), await text(lead + ' ' + byId('family-summary')));
    await p.waitForSelector(topic + ' ' + byId('lead-status-running'), { timeout: 8000 }).catch(() => {});
    check(scene, '③ its family line: Running 1 (REQ-135)', (await text(topic + ' ' + byId('family-summary'))).includes('Running 1'), await text(topic + ' ' + byId('family-summary')));
    // ② REQ-120 (replacing REQ-117's grey crown): a two-tone medal (REQ-123 antique gold), 16px — the base PNG (3:1 on the card) and the face
    // PNG laid on the same spot, each tinted; the lead's crown stays gold, 13px; an archived topic lead's two sunk tones.
    // REQ-121: a third PNG, the ribbon, under the two. REQ-122: the lead's crown 16px with its beads over it.
    const tintOf = async sel => await p.locator(sel).first().evaluate(el => el.outerHTML.match(/flood-color="([^"]+)"/)?.[1] ?? '');
    const hexOf = t => t.startsWith('#') ? t.toLowerCase() : rgb(t);
    const base = hexOf(await tintOf(topic + ' ' + byId('card-leader-filled'))), face = hexOf(await tintOf(topic + ' ' + byId('card-leader-light')));
    const ribbon = hexOf(await tintOf(topic + ' ' + byId('card-leader-ribbon'))), oldRibbon = hexOf(await tintOf(slot(V.old) + ' ' + byId('card-leader-ribbon')));
    const gold = hexOf(await tintOf(lead + ' ' + byId('card-leader-filled'))), beads = hexOf(await tintOf(lead + ' ' + byId('card-leader-beads')));
    const oldBase = hexOf(await tintOf(slot(V.old) + ' ' + byId('card-leader-filled'))), oldFace = hexOf(await tintOf(slot(V.old) + ' ' + byId('card-leader-light')));
    const want = medalColors(c, c.card), wantOld = medalColors(c, c.card, true);
    check(scene, '② the topic lead\'s medal: antique gold base (crownSub, REQ-123), 3:1 on the card, not grey', base === want.base.toLowerCase() && base === { light: '#987a59', dark: '#bba07f' }[mode] && contrast(base, c.card) >= 3
      && base !== PASEO_THEMES[mode].colors.foregroundMuted.toLowerCase(), base + ' ' + contrast(base, c.card).toFixed(2));
    check(scene, '② its lighter face (crownSubLight), apart from the base', face === want.light.toLowerCase() && contrast(face, base) >= 2,
      face + ' on base ' + contrast(face, base).toFixed(2));
    check(scene, '② the lead\'s stays gold, a crown', gold === crownColor(c, c.card).toLowerCase() && gold !== base
      && (await p.locator(lead + ' ' + byId('card-leader-medal')).count()) === 0, gold);
    check(scene, '② an archived topic lead\'s: the sunk tones, under 3:1', oldBase === wantOld.base.toLowerCase() && oldFace === wantOld.light.toLowerCase()
      && contrast(oldBase, c.card) < 3, oldBase + ' ' + oldFace + ' ' + contrast(oldBase, c.card).toFixed(2));
    // REQ-121: the ribbon, petrol, 3:1 on the card; archived, sunk under 3:1. REQ-122: the lead's crown beads, deep amber, dark gold kept.
    check(scene, 'REQ-121 the medal\'s ribbon: petrol (crownSubRibbon), 3:1 on the card', ribbon === want.ribbon.toLowerCase() && contrast(ribbon, c.card) >= 3
      && ribbon === { light: '#497b83', dark: '#82b5be' }[mode], ribbon + ' ' + contrast(ribbon, c.card).toFixed(2));
    check(scene, 'REQ-121 … archived: sunk, under 3:1', oldRibbon === wantOld.ribbon.toLowerCase() && contrast(oldRibbon, c.card) < 3, oldRibbon);
    const layerIds = await p.locator(topic + ' ' + byId('card-leader-medal')).first().evaluate(el => [...el.querySelectorAll('[data-testid^="card-leader-"]')].map(e => e.dataset.testid));
    check(scene, 'REQ-121 the medal\'s layers bottom to top: ribbon, base, face', JSON.stringify(layerIds) === JSON.stringify(['card-leader-ribbon', 'card-leader-filled', 'card-leader-light']),
      JSON.stringify(layerIds));
    check(scene, 'REQ-122 the lead\'s crown: gold kept (dark #F2C230), deep-amber beads', beads === crownColors(c, c.card).beads.toLowerCase()
      && gold === { light: '#bb8e14', dark: '#f2c230' }[mode] && contrast(beads, gold) >= 2.5, gold + ' ' + beads + ' ' + contrast(beads, gold).toFixed(2));
    const cb = await box(p, topic + ' ' + byId('card-leader-filled')), lb = await box(p, topic + ' ' + byId('card-leader-light')), rb = await box(p, topic + ' ' + byId('card-leader-ribbon'));
    const gb = await box(p, lead + ' ' + byId('card-leader-filled')), kb = await box(p, lead + ' ' + byId('card-leader-beads'));
    const same = (x, y) => !!x && !!y && Math.abs(x.x - y.x) <= .5 && Math.abs(x.y - y.y) <= .5 && Math.abs(x.width - y.width) <= .5 && Math.abs(x.height - y.height) <= .5;
    check(scene, '② 16px, the three layers on one spot; the lead\'s crown 16px (REQ-122), its beads on it', !!cb && !!gb && Math.abs(cb.width - 16) <= .5 && Math.abs(cb.height - 16) <= .5
      && same(cb, lb) && same(cb, rb) && Math.abs(gb.width - 16) <= .5 && Math.abs(gb.height - 16) <= .5 && same(gb, kb), JSON.stringify({ cb, lb, rb, gb, kb }));
    const tt = await box(p, topic + ' ' + byId('card-title')), lt = await box(p, lead + ' ' + byId('card-title'));
    const row = await box(p, topic + ' ' + byId('card-leader')), leadRow = await box(p, lead + ' ' + byId('card-leader'));
    check(scene, '② the title lines keep 18px; the medal and crown centred on them; both titles start at one x (REQ-122)', !!tt && !!row && !!leadRow && Math.abs(row.height - 18) <= .5
      && Math.abs(leadRow.height - 18) <= .5 && Math.abs((cb.y + cb.height / 2) - (row.y + row.height / 2)) <= .5 && Math.abs((gb.y + gb.height / 2) - (leadRow.y + leadRow.height / 2)) <= .5
      && Math.abs((tt.x - cb.x) - (lt.x - gb.x)) <= .5 && Math.abs(tt.x - lt.x) <= .5, JSON.stringify({ tt, lt, row, leadRow }));
    medalLog.push({ scene, ribbon, base, face, gold, beads, oldRibbon, oldBase, oldFace, card: c.card, ribbonOnCard: +contrast(ribbon, c.card).toFixed(2), baseOnCard: +contrast(base, c.card).toFixed(2),
      faceOnBase: +contrast(face, base).toFixed(2), goldOnCard: +contrast(gold, c.card).toFixed(2), beadsOnGold: +contrast(beads, gold).toFixed(2),
      oldRibbonOnCard: +contrast(oldRibbon, c.card).toFixed(2), oldBaseOnCard: +contrast(oldBase, c.card).toFixed(2), medal: cb, crown: gb, title: tt, leadTitle: lt });
    check(scene, '② spoken as a topic lead', (await p.locator(topic + ' ' + byId('card-leader')).getAttribute('aria-label')) === 'Topic lead card (under the lead)');
    const edge = rgb((await style(p, topic + ' ' + byId('card-content'), ['borderTopColor'])).borderTopColor);
    check(scene, '③ the lead\'s grey edge (REQ-105)', edge === leaderOutline(c, c.card).toLowerCase(), edge);
    const oldEdge = rgb((await style(p, slot(V.old) + ' ' + byId('card-content'), ['borderTopColor'])).borderTopColor);
    check(scene, '③ archived: the darker grey edge', oldEdge === leaderOutline(c, c.card, true).toLowerCase(), oldEdge);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-rest.png`) });
    // The presses (REQ-99·104·109) on the topic lead: its own family, not the lead's.
    await clickAt(p, topic + ' ' + byId('family-summary-all'));
    await p.waitForTimeout(300);
    check(scene, '"Sub-cards 2" rings the topic lead and its two', JSON.stringify(await ringed()) === JSON.stringify([V.subA, V.subB, V.topic].sort()), JSON.stringify(await ringed()));
    const dim = Number((await style(p, lead, ['opacity'])).opacity);
    check(scene, '… the lead steps back with the others', dim > .4 && dim < .5, String(dim));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-family.png`) });
    await clickAt(p, topic + ' ' + byId('family-summary-open'));
    check(scene, '"not done 1" rings the topic lead and the one at work', JSON.stringify(await ringed()) === JSON.stringify([V.subA, V.topic].sort()), JSON.stringify(await ringed()));
    await clickAt(p, topic + ' ' + byId('lead-status-running'));
    check(scene, '"Running 1" rings the topic lead and the one running', JSON.stringify(await ringed()) === JSON.stringify([V.subA, V.topic].sort())
      && (await p.locator(topic + ' ' + byId('lead-status-running')).getAttribute('aria-pressed')) === 'true', JSON.stringify(await ringed()));
    await clickAt(p, topic + ' ' + byId('lead-status-running'));
    check(scene, 'the same part again ends it', (await ringed()).length === 0);
    await clickAt(p, slot(V.subA) + ' ' + byId('family-mark'));
    check(scene, 'the sub-card\'s "↳ T01" rings the topic lead\'s family', JSON.stringify(await ringed()) === JSON.stringify([V.subA, V.subB, V.topic].sort()), JSON.stringify(await ringed()));
    await clickAt(p, lead + ' ' + byId('family-summary-all'));
    check(scene, 'the lead\'s "Sub-cards 5" rings all three levels', JSON.stringify(await ringed()) === JSON.stringify([V.lead, V.topic, V.subA, V.subB, V.old, V.oldSub].sort()),
      JSON.stringify(await ringed()));
    await clickAt(p, lead + ' ' + byId('family-summary-all'));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  for (const mode of ['light', 'dark']) {
    const scene = `req117-phone-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'topic'));
    await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 });
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(400);
    const slot = t => byId('linked-card-' + vId(t)), topic = slot(V.topic);
    await p.waitForSelector(topic + ' ' + byId('family-summary'), { timeout: 8000 }).catch(() => {});
    const order = await p.locator(byId('mobile-workspace-' + v.id) + ' [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, 'the lead, then the topic lead, then the rest', JSON.stringify(order) === JSON.stringify([V.lead, V.topic, V.subA]), JSON.stringify(order));
    check(scene, 'the title whole', (await p.locator(topic + ' ' + byId('card-title')).first().innerText()).trim() === V.topic);
    // REQ-120: the medal (REQ-123 antique gold), two layers, 16px, on the phone too.
    const tintAt = async sel => { const t = await p.locator(sel).first().evaluate(el => el.outerHTML.match(/flood-color="([^"]+)"/)?.[1] ?? '');
      return t.startsWith('#') ? t.toLowerCase() : rgb(t); };
    const base = await tintAt(topic + ' ' + byId('card-leader-filled')), face = await tintAt(topic + ' ' + byId('card-leader-light')), want = medalColors(c, c.card);
    const ribbon = await tintAt(topic + ' ' + byId('card-leader-ribbon'));
    check(scene, 'the gold medal: base and face; REQ-121 its petrol ribbon', base === want.base.toLowerCase() && face === want.light.toLowerCase() && contrast(base, c.card) >= 3
      && ribbon === want.ribbon.toLowerCase() && contrast(ribbon, c.card) >= 3, base + ' ' + face + ' ' + ribbon);
    const cb = await box(p, topic + ' ' + byId('card-leader-filled')), lb = await box(p, topic + ' ' + byId('card-leader-light')), rb = await box(p, topic + ' ' + byId('card-leader-ribbon'));
    check(scene, '16px, the three layers on one spot', !!cb && !!lb && !!rb && Math.abs(cb.width - 16) <= .5 && Math.abs(cb.x - lb.x) <= .5 && Math.abs(cb.y - lb.y) <= .5
      && Math.abs(cb.x - rb.x) <= .5 && Math.abs(cb.y - rb.y) <= .5 && Math.abs(rb.width - 16) <= .5, JSON.stringify({ cb, lb, rb }));
    const gold = await tintAt(slot(V.lead) + ' ' + byId('card-leader-filled')), beads = await tintAt(slot(V.lead) + ' ' + byId('card-leader-beads'));
    const gb = await box(p, slot(V.lead) + ' ' + byId('card-leader-filled'));
    check(scene, 'the lead keeps the gold crown; REQ-122 its beads, 16px', gold === crownColor(c, c.card).toLowerCase() && beads === crownColors(c, c.card).beads.toLowerCase()
      && !!gb && Math.abs(gb.width - 16) <= .5 && (await p.locator(slot(V.lead) + ' ' + byId('card-leader-medal')).count()) === 0, gold + ' ' + beads + ' ' + JSON.stringify(gb));
    const row = await box(p, topic + ' ' + byId('lead-status')), card = await box(p, topic);
    check(scene, 'the family line and the status row inside the card', !!row && !!card && row.y + row.height <= card.y + card.height, JSON.stringify({ row, card }));
    await p.screenshot({ path: path.join(out, `${scene}-doing.png`) });
    // REQ-120: the archived topic lead in done — the sunk tones.
    await p.locator(byId('mobile-tab-done')).first().tap(); await p.waitForTimeout(400);
    const oldBase = await tintAt(slot(V.old) + ' ' + byId('card-leader-filled')), oldFace = await tintAt(slot(V.old) + ' ' + byId('card-leader-light')), wantOld = medalColors(c, c.card, true);
    const oldRibbon = await tintAt(slot(V.old) + ' ' + byId('card-leader-ribbon'));
    check(scene, 'done: the archived topic lead\'s sunk tones and ribbon', oldBase === wantOld.base.toLowerCase() && oldFace === wantOld.light.toLowerCase()
      && oldRibbon === wantOld.ribbon.toLowerCase(), oldBase + ' ' + oldFace + ' ' + oldRibbon);
    await p.screenshot({ path: path.join(out, `${scene}-done.png`) });
    medalLog.push({ scene, ribbon, base, face, gold, beads, oldRibbon, oldBase, oldFace, card: c.card, ribbonOnCard: +contrast(ribbon, c.card).toFixed(2), baseOnCard: +contrast(base, c.card).toFixed(2),
      faceOnBase: +contrast(face, base).toFixed(2), goldOnCard: +contrast(gold, c.card).toFixed(2), beadsOnGold: +contrast(beads, gold).toFixed(2), oldBaseOnCard: +contrast(oldBase, c.card).toFixed(2), medal: cb, crown: gb });
    await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(400);
    await p.locator(topic + ' ' + byId('family-summary-open')).first().tap(); await p.waitForTimeout(300);
    const lit = (await p.locator(byId('family-highlight')).evaluateAll(els => els.map(e => e.parentElement.querySelector('[data-testid^="kanban-card-"]')?.getAttribute('aria-label')))).sort();
    check(scene, 'a tap on "not done 1": the topic lead and the one at work', JSON.stringify(lit) === JSON.stringify([V.subA, V.topic].sort()), JSON.stringify(lit));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-119: a lead with no sub-card yet is a lead's card from the start — crown, grey edge, first in its column, short
  // title, status row, no "Sub-cards 0" line; the other cards as they were ----
  for (const [mode, mobile] of [['light', false], ['dark', false], ['light', true], ['dark', true]]) {
    const scene = `req119-${mobile ? 'phone' : 'wide'}-${mode}`, c = palette(PASEO_THEMES[mode]);
    const p = await (await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, mobile, 'newlead'));
    const slot = t => byId('linked-card-' + nlId(t)), lead = slot(NL.lead);
    if (mobile) {
      await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 });
      await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400);
    }
    await p.waitForSelector(lead + ' ' + byId('card-leader'), { timeout: 15000 }).catch(() => {});
    const order = mobile ? await p.locator(byId('mobile-workspace-' + nl.id) + ' [data-testid^="kanban-card-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')))
      : await p.locator(byId('swimlane-lane-section')).filter({ has: p.locator(lead) }).locator(byId('swimlane-cell-review') + ' [data-testid^="kanban-card-"]')
        .evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, 'first in review, the others in their order', JSON.stringify(order) === JSON.stringify([NL.lead, NL.plain, NL.worker]), JSON.stringify(order));
    const text = async sel => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    check(scene, 'the short title "총괄-08"', await text(lead + ' ' + byId('card-title')) === '총괄-08', await text(lead + ' ' + byId('card-title')));
    const tint = await p.locator(lead + ' ' + byId('card-leader-filled')).first().evaluate(el => el.outerHTML.match(/flood-color="([^"]+)"/)?.[1] ?? '').catch(() => '');
    check(scene, 'the gold crown', (tint.startsWith('#') ? tint.toLowerCase() : rgb(tint)) === crownColor(c, c.card).toLowerCase(), tint);
    check(scene, 'a crown on the lead alone', (await p.locator(byId('card-leader')).count()) === 1);
    const edge = rgb((await style(p, lead + ' ' + byId('card-content'), ['borderTopColor'])).borderTopColor);
    check(scene, 'the lead\'s grey edge (REQ-105)', edge === leaderOutline(c, c.card).toLowerCase(), edge);
    const plainEdge = rgb((await style(p, slot(NL.worker) + ' ' + byId('card-content'), ['borderTopColor'])).borderTopColor);
    check(scene, 'a plain card keeps its border', plainEdge === c.border.toLowerCase(), plainEdge);
    check(scene, 'no "Sub-cards 0" line', (await p.locator(byId('family-summary')).count()) === 0);
    const row = await box(p, lead + ' ' + byId('lead-status')), card = await box(p, lead);
    check(scene, 'its status row, inside the card', !!row && !!card && row.y + row.height <= card.y + card.height, JSON.stringify({ row, card }));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    await p.context().close();
  }
  } // KANBAN_WEB_ONLY=req124 runs only the scenes below
  // v0.1.46-B: part of "early" (early, req124 and d47 together are still all of it); KANBAN_WEB_ONLY=v0146b runs it alone.
  if (ONLY === '' || ONLY === 'early' || E2 || ONLY === 'v0146b') {
  const holdOn = async (p, sel) => {
    const b = await box(p, sel), cdp = await p.context().newCDPSession(p), [x, y] = center(b).map(Math.round);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await p.waitForTimeout(900);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await p.waitForTimeout(400);
  };
  // ---- v0.1.46-B: no lead by name — the sheet names the latest agent and shows the very words sent (with its id), the card
  // chips say "latest agent" once it is linked, and "no agent" in plain words. 1920 in English, 390 in Korean, light and dark ----
  for (const [width, height, mobile, lang] of [[1920, 1080, false, 'en'], [390, 844, true, 'ko']]) for (const mode of ['light', 'dark']) {
    const scene = `v0146b-dispatch-${width}-${mode}`, m = copy(lang);
    const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const p = await context.newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, mobile, 'dispatch-' + lang));
    await p.waitForSelector('[data-testid^="kanban-card-"]', { timeout: 15000 });
    if (mobile) { await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(500); }
    await p.waitForTimeout(600);
    const chip = async (title, look) => { const sel = '[aria-label="' + title + '"] ' + byId('card-dispatch-' + look);
      return (await p.locator(sel).count()) ? p.locator(sel).first().getAttribute('aria-label') : null; };
    const sentChip = await chip(DB.sent, 'sent');
    check(scene, 'sent to a linked plain chat: "latest agent" on the card', !!sentChip && sentChip.endsWith(m.dispatchSentFallback('').replace(/^\S+ /, '')), String(sentChip));
    check(scene, 'no agent at all: plain words, no lead rule', await chip(DB.none, 'noLead') === m.dispatchRequest + ' · ' + m.dispatchNoLeadChip, String(await chip(DB.none, 'noLead')));
    check(scene, 'waiting for a plain chat the host lists: "latest agent" too', await chip(DB.waiting, 'pending') === m.dispatchRequest + ' · ' + m.dispatchPendingFallback,
      String(await chip(DB.waiting, 'pending')));
    await p.screenshot({ path: path.join(out, `${scene}-cards.png`) });
    // The draft to In progress: the confirmation sheet.
    if (mobile) {
      await p.locator(byId('mobile-tab-todo')).first().tap(); await p.waitForTimeout(500);
      await holdOn(p, '[aria-label="' + DB.draft + '"]');
      await p.locator(byId('move-to-doing')).first().tap(); await p.waitForTimeout(600);
    } else {
      await moveTo(p, '[aria-label="' + DB.draft + '"]');
      await clickAt(p, '[aria-label="' + m.moveCard + ': ' + DB.draft + '"]');
      await p.waitForSelector(byId('move-to-doing'), { timeout: 5000 }).catch(() => {});
      await clickAt(p, byId('move-to-doing'));
      await p.waitForTimeout(600);
    }
    await p.waitForSelector(byId('dispatch-message'), { timeout: 5000 }).catch(() => {});
    const words = (await p.locator(byId('dispatch-message')).count()) ? await p.locator(byId('dispatch-message')).first().innerText() : '';
    const cardId = words.match(/card_[0-9a-f-]{36}/)?.[0] ?? '';
    check(scene, 'the sheet names the latest agent', (await p.locator(byId('dispatch-when')).count()) > 0
      && (await p.locator(byId('dispatch-when')).first().innerText()).startsWith(m.dispatchFallbackWhen('Sample chat').slice(0, 12)));
    check(scene, 'the words in the board\'s language, with the kanban line and the real ids', words.startsWith(lang === 'ko' ? '[칸반 요청] ' : '[Kanban request] ')
      && !!cardId && words.split('\n').at(-1).includes('kanban card link ' + cardId + ' --agent ' + FALLBACK_AGENT), words);
    const sheet = await box(p, byId('dispatch-sheet'));
    check(scene, 'the sheet inside the window', !!sheet && sheet.x >= 0 && sheet.x + sheet.width <= width + 1 && sheet.y >= 0, JSON.stringify(sheet));
    const message = await box(p, byId('dispatch-message'));
    check(scene, 'the words inside the sheet', !!message && !!sheet && message.x >= sheet.x && message.x + message.width <= sheet.x + sheet.width + 1, JSON.stringify({ message, sheet }));
    await p.screenshot({ path: path.join(out, `${scene}-sheet.png`) });
    const before = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').length);
    if (mobile) await p.locator(byId('dispatch-send')).first().tap(); else await clickAt(p, byId('dispatch-send'));
    await p.waitForTimeout(700);
    const writes = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').map(v => v.input.operations));
    check(scene, 'Send writes one dispatch', writes.length === before + 1 && writes.at(-1).length === 1 && writes.at(-1)[0].op === 'dispatch' && writes.at(-1)[0].id === cardId,
      JSON.stringify(writes.at(-1)));
    const toast = (await p.locator(byId('move-toast')).count()) ? await p.locator(byId('move-toast')).first().innerText() : '';
    check(scene, 'the notice says the latest agent', toast.includes(m.dispatchQueued('Sample chat', true)), toast);
    await p.screenshot({ path: path.join(out, `${scene}-sent.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  // ---- research/253-D3: held cards say why on their face, and a held sheet says why instead of "open a new chat" ----
  for (const [width, height, mobile, lang] of [[1920, 1080, false, 'en'], [390, 844, true, 'ko']]) for (const mode of ['light', 'dark']) {
    const scene = `v0146b-held-${width}-${mode}`, m = copy(lang);
    const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const p = await context.newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, mobile, 'dispatchheld-' + lang));
    await p.waitForSelector('[data-testid^="kanban-card-"]', { timeout: 15000 });
    if (mobile) { await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(500); }
    await p.waitForTimeout(600);
    const chip = async title => { const sel = '[aria-label="' + title + '"] ' + byId('card-dispatch-noLead');
      return (await p.locator(sel).count()) ? p.locator(sel).first().getAttribute('aria-label') : null; };
    for (const [title, want] of [[HD.before, m.dispatchHeldChip('beforeFloor')], [HD.gone, m.dispatchHeldChip('targetGone')], [HD.none, m.dispatchNoLeadChip]])
      check(scene, 'the chip of "' + title + '" says its reason', await chip(title) === m.dispatchRequest + ' · ' + want, String(await chip(title)));
    const face = await box(p, '[aria-label="' + HD.before + '"] ' + byId('card-dispatch-noLead'));
    const card = await box(p, '[aria-label="' + HD.before + '"]');
    check(scene, 'the held chip inside its card', !!face && !!card && face.x >= card.x - 1 && face.x + face.width <= card.x + card.width + 1, JSON.stringify({ face, card }));
    await p.screenshot({ path: path.join(out, `${scene}-cards.png`) });
    if (mobile) {
      await p.locator(byId('mobile-tab-todo')).first().tap(); await p.waitForTimeout(500);
      await holdOn(p, '[aria-label="' + HD.draft + '"]');
      await p.locator(byId('move-to-doing')).first().tap(); await p.waitForTimeout(600);
    } else {
      await moveTo(p, '[aria-label="' + HD.draft + '"]');
      await clickAt(p, '[aria-label="' + m.moveCard + ': ' + HD.draft + '"]');
      await p.waitForSelector(byId('move-to-doing'), { timeout: 5000 }).catch(() => {});
      await clickAt(p, byId('move-to-doing'));
      await p.waitForTimeout(600);
    }
    await p.waitForSelector(byId('dispatch-when'), { timeout: 5000 }).catch(() => {});
    const when = (await p.locator(byId('dispatch-when')).count()) ? await p.locator(byId('dispatch-when')).first().innerText() : '';
    check(scene, 'the sheet says why it is held, not "open a new chat"', when.trim() === m.dispatchHeld('settings') && !when.includes(m.dispatchNoLead), when);
    const sheet = await box(p, byId('dispatch-sheet')), notice = await box(p, byId('dispatch-when'));
    check(scene, 'the sheet and its notice inside the window', !!sheet && !!notice && sheet.x >= 0 && sheet.x + sheet.width <= width + 1 && sheet.y >= 0
      && notice.x >= sheet.x && notice.x + notice.width <= sheet.x + sheet.width + 1, JSON.stringify({ sheet, notice }));
    await p.screenshot({ path: path.join(out, `${scene}-sheet.png`) });
    if (mobile) await p.locator(byId('dispatch-send')).first().tap(); else await clickAt(p, byId('dispatch-send'));
    await p.waitForTimeout(700);
    const toast = (await p.locator(byId('move-toast')).count()) ? await p.locator(byId('move-toast')).first().innerText() : '';
    check(scene, 'the notice says held, why', toast.includes(m.dispatchQueued(null, false, 'settings')), toast);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  }
  // REQ-124/REQ-127: shared by the lane's workflow scenes and the board screen's.
  // The lane with a definition is the one with the switch (its cards give way to the workflow).
  const wfLane = `[data-testid="swimlane-lane-section"]:has(${byId('lane-view-switch')})`;
  // The lane without one, by its workspace's name: a card of it may be past the three a lane shows (research/230 F2).
  const wfOther = `[data-testid="swimlane-lane-section"]:has(${byId('workspace-name-primary')}:text-is("Second Workspace"))`;
  const textOf = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  /** A count chip's text: its lines (two in a narrow column) joined as one. */
  const chipOf = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).split('\n').map(v => v.trim()).filter(Boolean).join(' · ');
  const textsOf = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  /** Every step inside the canvas, no two overlapping, and no label or note cut (research/216's ten-column second line). */
  async function flowShape(p, scene, sel, want) {
    const nodes = await p.locator(sel + ' [data-testid^="flow-node-"]').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect();
      return { id: e.dataset.testid, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    const canvas = await box(p, sel + ' ' + byId('flow-canvas'));
    check(scene, `${want} steps drawn`, nodes.length === want, String(nodes.length));
    check(scene, 'every step inside the canvas', !!canvas && nodes.every(n => n.x >= canvas.x - .5 && n.right <= canvas.x + canvas.width + .5 && n.y >= canvas.y - .5 && n.bottom <= canvas.y + canvas.height + .5), JSON.stringify(canvas));
    const overlap = nodes.flatMap((n, i) => nodes.slice(i + 1).filter(m => n.x < m.right && m.x < n.right && n.y < m.bottom && m.y < n.bottom).map(m => n.id + '×' + m.id));
    check(scene, 'no two steps overlap', overlap.length === 0, overlap.join());
    const cut = await p.locator(sel + ' [data-testid^="flow-node-"] [dir="auto"], ' + sel + ' [data-testid^="flow-note-"]').evaluateAll(els =>
      els.filter(e => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map(e => e.innerText));
    check(scene, 'no label or note cut', cut.length === 0, JSON.stringify(cut));
  }
  if (!EARLY && ONLY !== 'req126' && ONLY !== 'req127' && ONLY !== 'req128' && ONLY !== 'v0146b' && !D47 && !R130 && !R133 && !R134 && !R135 && !R136 && !R137 && !R125 && !R52 && !R125U1 && !R125U2 && !R125U3 && !R125U4 && !R138 && !R139 && !R142) {
  // ---- REQ-124 2단위 (research/215·216·217): the wide lane heading's "보드 | 워크플로", only on the lane whose workspace holds
  // a workflow definition; the flow (steps, straight-angled lines, the diamond, the loops that went back, the chosen release's
  // way bold), the release × step table whose states are told apart ("기록 없음" is not "not done"), and a cell's evidence.
  // 1400 and 1920, light and dark, Korean and English. It replaces REQ-103 2단계-1's big picture: no dot, no big picture. ----
  for (const [width, mode, lang] of [[1400, 'light', 'ko'], [1400, 'dark', 'ko'], [1920, 'light', 'ko'], [1920, 'dark', 'ko'], [1400, 'light', 'en']]) {
    const scene = `req124-wide${width}-${mode}-${lang}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-gate-' + lang));
    await p.waitForSelector(wfLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    check(scene, 'the switch on the lane with a definition only', await visible(p, wfLane + ' ' + byId('lane-view-switch'))
      && (await p.locator(wfOther).count()) === 1 && (await p.locator(wfOther + ' ' + byId('lane-view-switch')).count()) === 0);
    check(scene, 'its words', await textOf(p, wfLane + ' ' + byId('lane-view-board')) === m.boardView && await textOf(p, wfLane + ' ' + byId('lane-view-workflow')) === m.workflowView);
    check(scene, 'REQ-103 2단계-1 gone: no waiting dot, no big picture', (await p.locator(byId('lane-view-waiting') + ',' + byId('big-picture')).count()) === 0);
    check(scene, 'nothing read before it is opened', !(await p.evaluate(() => window.__calls)).includes('kanban.v1.workflow.get'));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-board.png`) });
    await clickAt(p, wfLane + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(wfLane + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the workflow in place of the columns', await visible(p, wfLane + ' ' + byId('workflow')) && (await p.locator(wfLane + ' ' + byId('swimlane-cells')).count()) === 0);
    const asked = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.workflow.get').map(v => v.input));
    check(scene, 'one read, for this workspace', JSON.stringify(asked) === JSON.stringify([{ workspaceId: 'wks_example01' }]), JSON.stringify(asked));
    await flowShape(p, scene, wfLane, 9);
    const panel = await box(p, wfLane + ' ' + byId('workflow'));
    const cellCut = await p.locator(wfLane + ' [data-testid^="workflow-cell-text-"]').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.innerText));
    check(scene, 'no table text cut', cellCut.length === 0, JSON.stringify(cellCut));
    check(scene, 'the lane\'s width, inside the window', !!panel && Math.abs(panel.width - 1144) <= 1 && panel.x + panel.width <= width, JSON.stringify(panel));
    check(scene, 'the heading: name, when, files, unknown format', await textOf(p, wfLane + ' ' + byId('workflow-name')) === '합성 개발 절차(게이트 있음)'
      && (await textOf(p, wfLane + ' ' + byId('workflow-meta'))).includes(m.workflowFiles(WF.gate.cost.files)) && await textOf(p, wfLane + ' ' + byId('workflow-unknown')) === m.workflowUnknownCount(1));
    check(scene, 'the newest release chosen', await p.locator(wfLane + ' ' + byId('workflow-release-0.2.6')).first().getAttribute('aria-pressed') === 'true');
    // The chosen release over the flow: its gate went back once and passed on conditions; its commit title could not be read.
    check(scene, 'the gate says where it began and ended', (await textsOf(p, wfLane + ' ' + byId('flow-note-gate'))).join(' ') === `60 ${lang === 'ko' ? '불통과' : '불통과'} → 조건부`,
      JSON.stringify(await textsOf(p, wfLane + ' ' + byId('flow-note-gate'))));
    check(scene, 'the commit: the stable hash, said as such', (await textsOf(p, wfLane + ' ' + byId('flow-note-commit'))).join(' ') === '6666666 ' + m.titleUnread);
    check(scene, 'no record on the tester, said', (await textsOf(p, wfLane + ' ' + byId('flow-note-tester'))).join(' ') === m.stateNoRecord);
    check(scene, 'the loop: once, 61→62', await textOf(p, wfLane + ' ' + byId('flow-loop-label')) === m.loopTimes('재게이트', 1) + ': 61→62');
    check(scene, 'the counts over the releases shown', await chipOf(p, wfLane + ' ' + byId('flow-count-gate')) === `${m.firstRound} 6 · ${m.verdictFail} 3 · ${m.verdictConditional} 0 · ${m.stateUnknown} 1`,
      await chipOf(p, wfLane + ' ' + byId('flow-count-gate')));
    check(scene, 'a person\'s step: dashed, nothing to read', (await style(p, wfLane + ' ' + byId('flow-node-phone'), ['borderTopStyle'])).borderTopStyle === 'dashed'
      && (await textsOf(p, wfLane + ' ' + byId('flow-note-phone'))).join(' · ') === m.stateNoSource + ' · ' + m.statePerson);
    // research/216: the bold line in the main colour moved to 3:1 on the flow's background (the dark accent alone was under it).
    const hotLine = await p.locator(wfLane + ' ' + byId('flow-edge-gate-pass') + ' > div').first().evaluate(e => { const s = getComputedStyle(e); return { bg: s.backgroundColor, h: e.getBoundingClientRect().height }; });
    const hot = rgb(hotLine.bg);
    check(scene, 'the way it went: bold, 3:1 on the background', hotLine.h === 4 && contrast(hot, c.surface0) >= 3 && hot === selectedLine(c, c.surface0).toLowerCase(), JSON.stringify({ ...hotLine, hot, contrast: contrast(hot, c.surface0).toFixed(2) }));
    // 325-J1: read from the drawn line (its first piece, never the arrowhead) — RN-web does not draw aria-selected on a View.
    const thin = await p.locator(wfLane + ' ' + byId('flow-edge-stable-tester') + ' > div').first().evaluate(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height));
    check(scene, 'a step not taken stays thin', thin === 2, String(thin));
    // The table tells its states apart.
    const cellText = async (release, stage) => textOf(p, `${wfLane} ${byId('workflow-row-' + release)} ${byId('workflow-cell-' + stage)}`);
    check(scene, 'six releases in the table', (await p.locator(wfLane + ' [data-testid^="workflow-row-0"]').count()) === 6);
    check(scene, '"기록 없음" where the rule found nothing', await cellText('0.2.6', 'tester') === m.stateNoRecord && await cellText('0.2.2', 'stable') === m.stateNoRecord);
    check(scene, '"형식 모름" where a report has no verdict line', await cellText('0.2.2', 'gate') === m.stateUnknown + ' 40');
    check(scene, '"커밋 제목 못 읽음" with the stable hash', await cellText('0.2.6', 'commit') === '6666666 · ' + m.titleUnread);
    check(scene, 'no column for a step with nothing to read (the flow says it once)', (await p.locator(`${wfLane} ${byId('workflow-cell-phone')}`).count()) === 0);
    check(scene, 'what was read: verdicts, loops, commits, results', await cellText('0.2.4', 'gate') === '50 불통과 → 54 통과 ' + m.timesShort(2)
      && await cellText('0.2.5', 'tester') === '03-03 13:00' && await cellText('0.2.6', 'req') === 'REQ-36' && /^5{7} 03-03 /.test(await cellText('0.2.5', 'commit')), await cellText('0.2.5', 'commit'));
    const noRecord = rgb((await style(p, `${wfLane} ${byId('workflow-row-0.2.6')} ${byId('workflow-cell-tester')} [dir="auto"]`, ['color'])).color);
    const unknown = rgb((await style(p, `${wfLane} ${byId('workflow-row-0.2.2')} ${byId('workflow-cell-gate')} [dir="auto"]`, ['color'])).color);
    check(scene, 'no record and unknown format look different, each readable', noRecord !== unknown && contrast(noRecord, c.surface0) >= 4.5 && contrast(unknown, c.surface0) >= 4.5, JSON.stringify({ noRecord, unknown }));
    // A cell's evidence: the verdict line and where it is; a cell with no record says what that means.
    await clickAt(p, `${wfLane} ${byId('workflow-row-0.2.6')} ${byId('workflow-cell-gate')}`);
    const places = await textsOf(p, wfLane + ' ' + byId('workflow-evidence-place')), excerpts = await textsOf(p, wfLane + ' ' + byId('workflow-evidence-excerpt'));
    check(scene, 'the gate\'s evidence: both reports, line and excerpt', places.length === 2 && places[0].startsWith('docs/60_v0206_게이트검증.md:5 · 2026-03-03 12:00')
      && places[1].startsWith('docs/62_v0206_재게이트.md:5') && excerpts[0] === '“## 종합 판정: 불통과 — 결함 1”', JSON.stringify({ places, excerpts }));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-workflow.png`) });
    await clickAt(p, `${wfLane} ${byId('workflow-row-0.2.6')} ${byId('workflow-cell-tester')}`);
    check(scene, 'no record: not "not done"', await textOf(p, wfLane + ' ' + byId('workflow-evidence-why')) === m.evidenceNoRecord);
    await clickAt(p, wfLane + ' ' + byId('workflow-unknown'));
    check(scene, 'the unknown-format files listed', (await textOf(p, wfLane + ' ' + byId('workflow-unknown-list'))).includes('docs/40_v0202_게이트검증.md'));
    // Another release: its own way, loops and notes.
    await clickAt(p, wfLane + ' ' + byId('workflow-release-0.2.4'));
    check(scene, '0.2.4 went back twice', await textOf(p, wfLane + ' ' + byId('flow-loop-label')) === m.loopTimes('재게이트', 2) + ': 51→52 · 53→54'
      && (await textsOf(p, wfLane + ' ' + byId('flow-note-gate'))).join(' ') === '50 불통과 → 통과');
    check(scene, 'two loop lines, each its verdict\'s colour', (await p.locator(wfLane + ' ' + byId('flow-loop-fix-gate') + ' > div').count()) >= 2 * 3);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-v024.png`) });
    await clickAt(p, wfLane + ' ' + byId('workflow-release-0.2.1'));
    check(scene, '0.2.1: fixed, committed without a second gate', await textOf(p, wfLane + ' ' + byId('flow-loop-label')) === m.loopTimes('재게이트', 1) + ': 36→' + m.loopNone);
    await clickAt(p, wfLane + ' ' + byId('lane-view-board'));
    check(scene, 'back to the board', (await p.locator(wfLane + ' ' + byId('workflow')).count()) === 0 && await visible(p, wfLane + ' ' + byId('swimlane-cells')));
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0 && !calls.some(n => /mutate|ensure|ui\.set|busy\.clear/.test(n)), calls.join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-124 ⑤ (REQ-125 ahead): another field's procedure — no gate, no commit — drawn by the same screen; a step with no
  // record says "기록 없음" and one with nothing to read says so; a loop back along its own row runs under it. ----
  for (const mode of ['light', 'dark']) {
    const scene = `req124-other-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy('ko');
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-other-ko'));
    await p.waitForSelector(wfLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, wfLane + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(wfLane + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
    await flowShape(p, scene, wfLane, 7);
    const cellText = async (release, stage) => textOf(p, `${wfLane} ${byId('workflow-row-' + release)} ${byId('workflow-cell-' + stage)}`);
    const heads = await p.locator(wfLane + ' ' + byId('workflow-table') + ' > div > div').first().evaluate(e => [...e.children].map(c => c.innerText));
    check(scene, 'the other field\'s steps it reads as columns', JSON.stringify(heads) === JSON.stringify(['판', '초안', '담당자 검토', '수정', '전달']), JSON.stringify(heads));
    check(scene, 'delivered with no review on record: "기록 없음", not a dash', await cellText('0.1.3', 'review') === m.stateNoRecord && await cellText('0.1.3', 'draft') === m.stateNoRecord
      && await cellText('0.1.3', 'deliver') === '04-05 09:00');
    check(scene, 'the review in its own word', await cellText('0.1.2', 'review') === '9 반려' && await cellText('0.1.2', 'revise') === m.stateNoRecord);
    check(scene, 'the flow says no record on the review', (await textsOf(p, wfLane + ' ' + byId('flow-note-review'))).join(' ') === m.stateNoRecord);
    check(scene, 'grasp and the reply say they have nothing to read', (await textsOf(p, wfLane + ' ' + byId('flow-note-grasp'))).join(' · ') === m.stateNoSource
      && (await textsOf(p, wfLane + ' ' + byId('flow-note-reply'))).join(' · ') === m.stateNoSource + ' · ' + m.statePerson
      && (await p.locator(wfLane + ' ' + byId('flow-count-grasp')).count()) === 0
      && (await style(p, wfLane + ' ' + byId('flow-node-grasp'), ['borderTopStyle'])).borderTopStyle === 'dashed');
    await clickAt(p, wfLane + ' ' + byId('workflow-release-0.1.1'));
    const labels = await textsOf(p, wfLane + ' ' + byId('flow-loop-label'));
    check(scene, 'revised once and approved; "새 요청" not taken', JSON.stringify(labels) === JSON.stringify(['다시 검토 1회: 5→6', '새 요청']), JSON.stringify(labels));
    check(scene, 'the review in its own words', (await textsOf(p, wfLane + ' ' + byId('flow-note-review'))).join(' ') === '4 반려 → 승인');
    const under = await p.locator(wfLane + ' ' + byId('flow-loop-reply-grasp') + ' > div').evaluateAll(els => els.map(e => e.getBoundingClientRect().bottom));
    const row = await box(p, wfLane + ' ' + byId('flow-node-grasp'));
    check(scene, 'the loop along its row runs under it', under.length > 0 && Math.max(...under) > row.y + row.height, JSON.stringify({ under, row }));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- research/216's open item: at ten columns a node's second line was cut ("301 불통과 → 통과"); it takes lines now. ----
  for (const mode of ['light', 'dark']) {
    const scene = `req124-ten-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-ten-ko'));
    await p.waitForSelector(wfLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, wfLane + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(wfLane + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
    await flowShape(p, scene, wfLane, 12);
    check(scene, 'the gate\'s note on two lines', JSON.stringify(await textsOf(p, wfLane + ' ' + byId('flow-note-gate'))) === JSON.stringify(['60 불통과', '→ 조건부']));
    check(scene, 'no sideways scroll at ten columns', (await p.locator(wfLane + ' ' + byId('flow-scroll')).count()) === 0);
    const chips = await p.locator(wfLane + ' [data-testid^="flow-count-"]').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { id: e.dataset.testid, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    const clash = chips.flatMap((n, i) => chips.slice(i + 1).filter(v => n.x < v.right && v.x < n.right && n.y < v.bottom && v.y < n.bottom).map(v => n.id + '×' + v.id));
    check(scene, 'no two count chips overlap', clash.length === 0, clash.join());
    const cellCut = await p.locator(wfLane + ' [data-testid^="workflow-cell-text-"]').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.innerText));
    check(scene, 'no table text cut', cellCut.length === 0, JSON.stringify(cellCut));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  if (!EARLY && ONLY !== 'req127' && ONLY !== 'req128' && ONLY !== 'v0146b' && !D47 && !R130 && !R133 && !R134 && !R135 && !R136 && !R137 && !R125 && !R52 && !R125U1 && !R125U2 && !R125U3 && !R125U4 && !R138 && !R139 && !R142) {
  // ---- REQ-126: every agent named "<label>-<version>-<thinking>" on the cards (a lead, a topic lead, a worker with "· +1", an old label, a
  // long label on a crowded card, no label, archived, unknown) and in the detail (assignees, author, the move's reason, the history) ----
  for (const [mode, mobile] of [['light', false], ['dark', false], ['light', true], ['dark', true]]) {
    const scene = `req126-${mobile ? 'phone' : 'wide'}-${mode}`;
    const p = await (await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, mobile, 'models'));
    const slot = title => byId('linked-card-' + mId(title)), nameSel = title => slot(title) + ' ' + byId('card-agent-name');
    const textOf = async sel => ((await p.locator(sel).first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    const stages = mobile ? [['review', [M.lead, M.old]], ['doing', [M.topic, M.long, M.work]], ['todo', [M.plain, M.unknown]], ['done', [M.archived]]]
      : [['all', Object.keys(M_WANT)]];
    await p.waitForSelector(mobile ? byId('mobile-tab-doing') : slot(M.work), { timeout: 15000 });
    for (const [stage, titles] of stages) {
      if (mobile) { await p.locator(byId('mobile-tab-' + stage)).first().tap(); await p.waitForTimeout(400); }
      // The model list is read after the agents: wait until its version shows (and the unknown agent's lookup has answered).
      await p.waitForFunction(([sel, want]) => document.querySelector(sel)?.textContent === want, [nameSel(titles[0]), M_WANT[titles[0]]], { timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(300);
      for (const title of titles) check(scene, `line two of "${title}"`, await textOf(nameSel(title)) === M_WANT[title], await textOf(nameSel(title)));
      if (titles.includes(M.lead)) check(scene, 'the lead card keeps its crown', (await p.locator(slot(M.lead) + ' ' + byId('card-leader')).count()) === 1);
      if (titles.includes(M.topic)) check(scene, 'the topic lead keeps its medal', (await p.locator(slot(M.topic) + ' ' + byId('card-leader-medal')).count()) === 1);
      if (titles.includes(M.work)) {
        check(scene, '"· +1" beside the worker\'s name', await textOf(slot(M.work) + ' ' + byId('card-agent-others')) === '· +1', await textOf(slot(M.work) + ' ' + byId('card-agent-others')));
        // A long name on a crowded card is cut at its end (the thinking level, then the version); the label it starts with stays, "· +1" is never cut.
        const cut = await p.locator(nameSel(M.long)).first().evaluate(el => {
          const s = getComputedStyle(el), right = el.getBoundingClientRect().right - (el.scrollWidth > el.clientWidth ? 8 : 0);
          const walk = document.createTreeWalker(el, 4), range = document.createRange(); let shown = 0, node;
          while ((node = walk.nextNode())) for (let i = 0; i < node.length; i++) { range.setStart(node, i); range.setEnd(node, i + 1); if (range.getBoundingClientRect().right <= right) shown++; }
          return { cut: el.scrollWidth > el.clientWidth, ellipsis: s.textOverflow, nowrap: s.whiteSpace, shown, width: el.clientWidth };
        });
        console.log('REQ-126 long name:', JSON.stringify({ scene, ...cut }));
        check(scene, 'a long name is cut at its end, one line', cut.ellipsis === 'ellipsis' && /nowrap|pre/.test(cut.nowrap), JSON.stringify(cut));
        check(scene, '… its label\'s head shown (the role, "실행_환경"), however crowded', cut.shown >= 5, JSON.stringify(cut));
        const others = await p.locator(slot(M.work) + ' ' + byId('card-agent-others')).first().evaluate(el => el.scrollWidth <= el.clientWidth);
        check(scene, '"· +1" whole', others);
      }
      await away(p);
      await p.screenshot({ path: path.join(out, `${scene}-cards${mobile ? '-' + stage : ''}.png`) });
    }
    if (mobile) { await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(400); await p.locator(slot(M.work) + ' ' + byId('card-title')).first().tap(); }
    else await clickAt(p, slot(M.work) + ' ' + byId('card-title'));
    await p.waitForSelector(byId('detail-meta'), { timeout: 10000 }).catch(() => {});
    await p.waitForTimeout(400);
    const rows = await p.locator(byId('agent-signal-text')).evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    check(scene, 'detail: each assignee row', rows.length === 2 && rows[0].startsWith('실행_Sol-6.1-High · ') && rows[1].startsWith('Gemini-3.5-Flash · '), JSON.stringify(rows));
    const meta = await textOf(byId('detail-meta'));
    check(scene, 'detail: the author', meta.includes('Created by · 총괄_Opus-5.5-High · 00000000'), meta);
    const reason = (await textOf(byId('detail-move-reason'))).replace(/⁠/g, '');
    check(scene, 'detail: the agent that moved it', reason.includes('(실행_Sol-6.1-High · 00000000)'), reason);
    const sheet = (await p.evaluate(() => document.body.innerText)).replace(/\u2060/g, '').replace(/\u00a0/g, ' ');
    // REQ-136 H4: the stages by their names (English board), not their ids.
    check(scene, 'detail: the history names the agents', sheet.includes('— → To Do · 총괄_Opus-5.5-High · 00000000') && sheet.includes('To Do → In progress · 실행_Sol-6.1-High · 00000000'), sheet.slice(-400));
    await p.screenshot({ path: path.join(out, `${scene}-detail.png`), fullPage: true });
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0 && !calls.includes('kanban.v1.board.mutate'), calls.join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  if (!EARLY && ONLY !== 'req127' && ONLY !== 'req128' && ONLY !== 'v0146b' && !D47 && !R130 && !R133 && !R134 && !R135 && !R136 && !R137 && !R125 && !R52 && !R125U1 && !R125U2 && !R125U3 && !R125U4 && !R138 && !R139 && !R142) {
  // ---- D45: the wide detail's side panel (280px) keeps each assignee row on one line — a long label ("…_Astra-6-XHigh", also
  // the card's author), an old one ("실행_Sol-6-High"), new ones ("실행_Sol-6.1-High", with a second agent) — the name cut at its end,
  // the state and id whole; on 390px the rows read and wrap as before. ----
  for (const [mode, mobile] of [['light', false], ['dark', false], ['light', true], ['dark', true]]) {
    const scene = `d45-${mobile ? 'phone' : 'wide'}-${mode}`;
    const p = await (await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1920, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    // On a phone the long-label card (it asks the user) opens its agent when pressed, not the detail: its 390 rows are the unit test's.
    for (const [title, stage, want] of [[M.long, 'doing', [M_WANT[M.long]]], [M.old, 'review', [M_WANT[M.old]]], [M.work, 'doing', [M_WANT[M.work], 'Gemini-3.5-Flash']]]
      .filter(([title]) => !mobile || title !== M.long)) {
      await p.goto(page(mode, mobile, 'models'));
      const card = byId('linked-card-' + mId(title)) + ' ' + byId('card-title');
      if (mobile) {
        await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 }); await p.waitForTimeout(800);
        await p.locator(byId('mobile-tab-' + stage)).first().tap();
      } else await p.waitForSelector(card, { timeout: 15000 });
      // The model list is read after the agents: open the card once its name carries the version (the card no longer moves).
      const face = byId('linked-card-' + mId(title)) + ' ' + byId('card-agent-name');
      await p.waitForFunction(([sel, name]) => document.querySelector(sel)?.textContent === name, [face, want[0]], { timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(400);
      // A phone's first tap can land while the tab still settles: tap again if no sheet opened.
      for (let i = 0; i < (mobile ? 3 : 1); i++) {
        if (mobile) await p.locator(card + ' >> visible=true').first().tap(); else await clickAt(p, card);
        if (await p.waitForSelector(byId('detail-meta'), { timeout: mobile ? 3000 : 10000 }).then(() => true, () => false)) break;
      }
      await p.waitForFunction(first => document.querySelector('[data-testid="agent-signal-text"]')?.textContent.startsWith(first + ' · '), want[0], { timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(300);
      const rows = await p.locator(byId('agent-signal')).evaluateAll(els => els.map(el => {
        const words = el.querySelector('[data-testid="agent-signal-text"]'), name = el.querySelector('[data-testid="agent-name"]');
        const rest = el.querySelector('[data-testid="agent-signal-rest"]'), id = el.querySelector('[data-testid="agent-id"]');
        // One line: the words' box is one 16px line high and the id's box sits inside it.
        const box = words.getBoundingClientRect(), idBox = id?.getBoundingClientRect();
        return { text: words.textContent.replace(/\s+/g, ' ').trim(), height: Math.round(box.height),
          name: name ? { cut: name.scrollWidth > name.clientWidth + 1, ellipsis: getComputedStyle(name).textOverflow, width: Math.round(name.clientWidth) } : null,
          rest: rest ? { whole: rest.scrollWidth <= rest.clientWidth + 1, ellipsis: getComputedStyle(rest).textOverflow, text: rest.textContent } : null,
          idWhole: !!id && id.scrollWidth <= id.clientWidth + 1, idText: id?.textContent ?? '',
          idInside: !!idBox && idBox.top >= box.top - 1 && idBox.bottom <= box.bottom + 1, width: Math.round(box.width) };
      }));
      const label = `"${title}"`;
      check(scene, label + ': the assignee rows read as before', rows.length === want.length && rows.every((r, i) => r.text.startsWith(want[i] + ' · ') && /· [0-9a-f]{8}$/.test(r.text)), JSON.stringify(rows));
      if (mobile) check(scene, label + ': a phone keeps its wrapping words (no cut name)', rows.every(r => !r.name && !r.rest), JSON.stringify(rows));
      else {
        check(scene, label + ': every assignee row one line (16px)', rows.every(r => r.height <= 18), JSON.stringify(rows));
        // research/236 D5: the state may lose its end ("…"), the id never.
        check(scene, label + ': its state on that line (whole, or cut with "…"), the id whole', rows.every(r => r.idWhole && r.idInside && /^ · [0-9a-f]{8}$/.test(r.idText)
          && /^ · .+$/.test(r.rest?.text ?? '') && (r.rest.whole || r.rest.ellipsis === 'ellipsis')), JSON.stringify(rows));
        check(scene, label + ': a name too long is cut at its end (its head, 72px and more, kept), not wrapped', rows.every(r => r.name && (!r.name.cut || r.name.ellipsis === 'ellipsis'))
          && rows.every(r => !r.name.cut || r.name.width >= 72), JSON.stringify(rows));
        // The card made by an agent names it in the panel's foot (the old-label card was made by a person).
        if (title !== M.old) {
          const author = await p.locator(byId('detail-author')).first().evaluate(el => {
            const id = el.querySelector('[data-testid="detail-author-id"]'), name = el.querySelector('[data-testid="detail-author-name"]');
            return { text: el.textContent, height: Math.round(el.getBoundingClientRect().height), whole: !id || id.scrollWidth <= id.clientWidth + 1,
              cut: name.scrollWidth > name.clientWidth + 1, ellipsis: getComputedStyle(name).textOverflow };
          }).catch(e => ({ error: String(e) }));
          const by = title === M.long ? M_WANT[M.long] : M_WANT[M.lead];
          check(scene, label + ': the author one line, its id whole', author.text?.startsWith('Created by · ' + by + ' · ') && author.height <= 18 && author.whole
            && (!author.cut || author.ellipsis === 'ellipsis'), JSON.stringify(author));
          if (title === M.long) console.log('D45 long row:', JSON.stringify({ scene, row: rows[0], author }));
        }
      }
      if (title !== M.old) await p.screenshot({ path: path.join(out, `${scene}-${title === M.long ? 'long' : 'work'}-detail.png`), fullPage: true });
    }
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // ---- REQ-131: on 1920 the cut one-line assignee and author rows say it all — under a mouse a tip (name, state, whole agent id
  // in one block), on a touch screen a press opens the row to two lines and the next folds it; the '>' still opens the agent,
  // the line stays one line at rest (D45·D47). Part of "early". ----
  for (const [mode, touch] of [['light', false], ['dark', false], ['light', true], ['dark', true]]) {
    const scene = `req131-${touch ? 'touch' : 'mouse'}-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1000 }, ...(touch ? { hasTouch: true } : {}) })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'models'));
    const card = byId('linked-card-' + mId(M.long)) + ' ' + byId('card-title');
    await p.waitForSelector(card, { timeout: 15000 });
    await p.waitForFunction(([sel, name]) => document.querySelector(sel)?.textContent === name, [byId('linked-card-' + mId(M.long)) + ' ' + byId('card-agent-name'), M_WANT[M.long]], { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(400);
    if (touch) await p.locator(card).first().tap(); else await clickAt(p, card);
    await p.waitForSelector(byId('detail-meta'), { timeout: 10000 });
    await p.waitForFunction(first => document.querySelector('[data-testid="agent-signal-text"]')?.textContent.startsWith(first + ' · '), M_WANT[M.long], { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(300);
    const agentId = M_IDS.long, rowSel = byId('agent-signal') + ' >> nth=0', words = byId('agent-words') + ' >> nth=0';
    const height = sel => p.locator(sel).first().evaluate(el => Math.round(el.getBoundingClientRect().height));
    const state = await p.locator(byId('agent-signal-rest')).first().textContent();
    const named = (await p.locator(byId('agent-name')).first().textContent());
    const cutName = await p.locator(byId('agent-name')).first().evaluate(el => el.scrollWidth > el.clientWidth + 1);
    check(scene, 'at rest: one line, the name cut at its end (D45)', cutName && await height(byId('agent-signal-text')) <= 18, `cut ${cutName}`);
    const hit = async sel => (await p.locator(sel).first().boundingBox());
    const tipOf = async () => p.locator(byId('agent-full-tip')).first().evaluate(el => {
      // elementFromPoint skips pointer-events:none, so the tip is made hit-testable for the look and put back.
      const box = el.getBoundingClientRect(), was = el.style.getPropertyValue('pointer-events'); el.style.setProperty('pointer-events', 'auto', 'important');
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); el.style.removeProperty('pointer-events'); if (was) el.style.pointerEvents = was;
      return { text: el.textContent, topmost: el === top || el.contains(top), box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } };
    }).catch(() => null);
    if (!touch) {
      await moveTo(p, byId('agent-words'));
      await p.waitForTimeout(250);
      const tip = await tipOf();
      check(scene, 'a mouse over the row: one tip with the whole name, the state and the whole agent id', !!tip && tip.text === `${M_WANT[M.long]} · ${state.replace(/^ · /, '')} · ${agentId}`
        || !!tip && tip.text.endsWith(' · ' + agentId) && tip.text.includes(state.replace(/^ · /, '')) && tip.text.startsWith(M_WANT[M.long]), JSON.stringify(tip));
      check(scene, 'the tip is on top of what is under it', !!tip && tip.topmost, JSON.stringify(tip));
      await p.screenshot({ path: path.join(out, `${scene}-tip.png`) });
      await away(p); await p.waitForTimeout(200);
      check(scene, 'the tip goes when the mouse leaves', (await p.locator(byId('agent-full-tip')).count()) === 0);
      await moveTo(p, byId('detail-author'));
      await p.waitForTimeout(250);
      const own = await tipOf();
      check(scene, 'the author line: tip with the whole name and the whole agent id', !!own && own.text.startsWith('Created by · ' + M_WANT[M.long]) && own.text.endsWith(' · ' + M_IDS.lead)
        || !!own && own.text.startsWith('Created by · ') && /· [0-9a-f-]{36}$/.test(own.text), JSON.stringify(own));
      await away(p);
      check(scene, 'a click on the name still opens the agent', (await (async () => { await clickAt(p, byId('agent-words')); await leaveOpen(p, scene); return p.evaluate(() => window.__opened.length); })()) === 1);
    } else {
      check(scene, 'touch: no tip', (await p.locator(byId('agent-full-tip')).count()) === 0);
      await p.locator(words).tap(); await p.waitForTimeout(250);
      const open = await p.locator(byId('agent-signal-text')).first().evaluate(el => ({ text: el.textContent, height: Math.round(el.getBoundingClientRect().height), lines: [...el.children].length }));
      check(scene, 'a touch on the name opens it: the whole name, then the state and the whole agent id', open.text === M_WANT[M.long] + state.replace(/^ · /, '') + ' · ' + agentId
        || (open.text.startsWith(M_WANT[M.long]) && open.text.endsWith(' · ' + agentId)), JSON.stringify(open));
      check(scene, 'two lines (32px, a longer name wraps on)', open.lines === 2 && open.height >= 32 && open.height <= 52, JSON.stringify(open));
      check(scene, 'a touch opened no agent', (await p.evaluate(() => window.__opened.length)) === 0);
      await p.screenshot({ path: path.join(out, `${scene}-open.png`) });
      await p.locator(words).tap(); await p.waitForTimeout(250);
      check(scene, 'the next touch folds it to one line again', await height(byId('agent-signal-text')) <= 18 && (await p.locator(byId('agent-name')).first().textContent()) === named);
      await p.locator(byId('detail-author')).first().tap(); await p.waitForTimeout(250);
      const author = await p.locator(byId('detail-author')).first().evaluate(el => ({ text: el.textContent, height: Math.round(el.getBoundingClientRect().height) }));
      check(scene, 'the author line opens to two lines with the whole agent id', author.height >= 28 && /[0-9a-f-]{36}$/.test(author.text), JSON.stringify(author));
      await p.locator(byId('detail-author')).first().tap(); await p.waitForTimeout(250);
      check(scene, 'and folds again', await height(byId('detail-author')) <= 18);
      const chevron = await p.locator(byId('agent-open')).first().boundingBox(); await p.touchscreen.tap(chevron.x + chevron.width - 8, chevron.y + chevron.height / 2); await p.waitForTimeout(250);
      await leaveOpen(p, scene, true);
      check(scene, 'the > button still opens the agent', (await p.evaluate(() => window.__opened.map(o => o[1]))).includes(agentId), JSON.stringify(await p.evaluate(() => window.__opened)));
    }
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // research/236 D5: the long-label agent asking for a permission — the longest state ("Waiting for input or permission",
  // "입력·권한 대기") — is still one line on 1920: the state cut with "…" when it must, the id whole after it.
  for (const [mode, lang] of [['light', 'en'], ['dark', 'ko']]) {
    const scene = `d45-permission-${mode}-${lang}`, state = lang === 'ko' ? '입력·권한 대기' : 'Waiting for input or permission';
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'modelsperm-' + lang));
    const card = byId('linked-card-' + mId(M.long)) + ' ' + byId('card-title');
    await p.waitForSelector(card, { timeout: 15000 });
    await p.waitForFunction(([sel, name]) => document.querySelector(sel)?.textContent === name, [byId('linked-card-' + mId(M.long)) + ' ' + byId('card-agent-name'), M_WANT[M.long]], { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(400);
    await clickAt(p, card);
    await p.waitForSelector(byId('detail-meta'), { timeout: 10000 });
    await p.waitForFunction(s => document.querySelector('[data-testid="agent-signal-rest"]')?.textContent === ' · ' + s, state, { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(300);
    const row = await p.locator(byId('agent-signal')).first().evaluate(el => {
      const words = el.querySelector('[data-testid="agent-signal-text"]'), name = el.querySelector('[data-testid="agent-name"]');
      const rest = el.querySelector('[data-testid="agent-signal-rest"]'), id = el.querySelector('[data-testid="agent-id"]');
      const box = words.getBoundingClientRect(), idBox = id?.getBoundingClientRect();
      return { text: words.textContent, height: Math.round(box.height),
        name: { cut: name.scrollWidth > name.clientWidth + 1, ellipsis: getComputedStyle(name).textOverflow, width: Math.round(name.clientWidth) },
        rest: { text: rest.textContent, whole: rest.scrollWidth <= rest.clientWidth + 1, ellipsis: getComputedStyle(rest).textOverflow, width: Math.round(rest.clientWidth) },
        idText: id?.textContent ?? '', idWhole: !!id && id.scrollWidth <= id.clientWidth + 1, idInside: !!idBox && idBox.top >= box.top - 1 && idBox.bottom <= box.bottom + 1 };
    });
    check(scene, 'the permission state on the row', row.rest.text === ' · ' + state && row.text.startsWith(M_WANT[M.long]), JSON.stringify(row));
    check(scene, 'one line (16px), the id whole on it', row.height <= 18 && row.idWhole && row.idInside && /^ · [0-9a-f]{8}$/.test(row.idText), JSON.stringify(row));
    // D47: "입력·권한 대기" stays whole (the name, 56px, gave way); the English one is cut after the name keeps 72px and more.
    check(scene, `the state ${lang === 'ko' ? 'whole' : 'whole or cut with "…"'}; the name cut with "…" keeps its head (${lang === 'ko' ? 48 : 72}px and more)`,
      (row.rest.whole || (lang === 'en' && row.rest.ellipsis === 'ellipsis'))
      && (!row.name.cut || (row.name.ellipsis === 'ellipsis' && row.name.width >= (lang === 'ko' ? 48 : 72))), JSON.stringify(row));
    console.log('D45 permission row:', JSON.stringify({ scene, row }));
    await p.screenshot({ path: path.join(out, `${scene}-detail.png`) });
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  if (ONLY === '' || D47) {
  // ---- D47: on 1920 every state an assignee row says, beside the long label and the old short one, in either language and theme.
  // 236-D5 let the state shrink in proportion with the name, so "끝남" read "…" and "작업 중" "작…" beside a long name. Now a state is
  // whole unless it is one of the two longest (English "Waiting for input or permission", "Finished · needs review": with the id
  // they pass the 198px line on their own), and those are cut only after the name gave way; one line, the id whole. Beside a whole
  // state the name keeps 48px and more ("실행_환…" by "끝남 · 확인 필요"), beside a long one 72px and more. Each row's widths go to
  // d47.json, a picture of it to d47-*.png. ----
  const d47Log = [], D47_CUTTABLE = new Set(['permission-en', 'attention-en']);
  for (const mode of ['light', 'dark']) for (const lang of ['ko', 'en']) for (const state of Object.keys(D47_STATES)) {
    const scene = `d47-${state}-${mode}-${lang}`, t = copy(lang);
    const want = { error: t.signalError, permission: t.signalPermission, working: t.signalWorking, attention: t.signalAttention,
      idle: t.signalIdle, archived: t.signalIdle, unknown: t.signalUnknown }[state];
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    for (const title of [M.long, M.old]) {
      const label = title === M.long ? 'long label' : 'short label';
      await p.goto(page(mode, false, `modelstate-${state}-${lang}`));
      const card = byId('linked-card-' + mId(title)) + ' ' + byId('card-title');
      await p.waitForSelector(card, { timeout: 15000 });
      await p.waitForTimeout(state === 'unknown' || state === 'archived' ? 1200 : 400);
      await clickAt(p, card);
      await p.waitForSelector(byId('detail-meta'), { timeout: 10000 });
      await p.waitForFunction(s => document.querySelector('[data-testid="agent-signal-rest"]')?.textContent === s, ' · ' + want, { timeout: 8000 }).catch(() => {});
      if (state !== 'unknown') await p.waitForFunction(name => document.querySelector('[data-testid="agent-name"]')?.textContent === name, M_WANT[title], { timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(300);
      const row = await p.locator(byId('agent-signal')).first().evaluate(el => {
        const words = el.querySelector('[data-testid="agent-signal-text"]'), name = el.querySelector('[data-testid="agent-name"]');
        const rest = el.querySelector('[data-testid="agent-signal-rest"]'), id = el.querySelector('[data-testid="agent-id"]');
        const box = words.getBoundingClientRect(), idBox = id?.getBoundingClientRect();
        return { text: words.textContent, height: Math.round(box.height), words: Math.round(box.width),
          name: { text: name.textContent, cut: name.scrollWidth > name.clientWidth + 1, ellipsis: getComputedStyle(name).textOverflow, width: Math.round(name.clientWidth), full: name.scrollWidth },
          rest: { text: rest.textContent, whole: rest.scrollWidth <= rest.clientWidth + 1, ellipsis: getComputedStyle(rest).textOverflow, width: Math.round(rest.clientWidth), full: rest.scrollWidth },
          idText: id?.textContent ?? '', idWhole: !!id && id.scrollWidth <= id.clientWidth + 1, idInside: !!idBox && idBox.top >= box.top - 1 && idBox.bottom <= box.bottom + 1 };
      });
      d47Log.push({ scene, label, row });
      const what = label + ': ';
      check(scene, what + 'the state in its own words', row.rest.text === ' · ' + want, JSON.stringify(row));
      check(scene, what + 'one line (16px), the id whole on it', row.height <= 18 && (state === 'unknown' && !row.idText
        || row.idWhole && row.idInside && /^ · [0-9a-f]{8}$/.test(row.idText)), JSON.stringify(row));
      if (!D47_CUTTABLE.has(state + '-' + lang)) check(scene, what + 'a short state whole, never "…"', row.rest.whole, JSON.stringify(row));
      check(scene, what + 'the name gives way first: the state is cut only when the name is', row.rest.whole || (row.name.cut && row.rest.ellipsis === 'ellipsis'), JSON.stringify(row));
      const floor = D47_CUTTABLE.has(state + '-' + lang) ? 72 : 48;
      check(scene, what + `a name too long is cut at its end, its head (${floor}px and more) kept`, !row.name.cut || (row.name.ellipsis === 'ellipsis' && row.name.width >= floor), JSON.stringify(row));
      if (state !== 'unknown') check(scene, what + 'the name is the agent\'s', M_WANT[title].startsWith(row.name.text.replace(/…$/, '')) || row.name.text === M_WANT[title], JSON.stringify(row.name));
      await p.locator(byId('agent-open')).first().screenshot({ path: path.join(out, `${scene}-${title === M.long ? 'long' : 'short'}.png`) });
    }
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  fs.writeFileSync(path.join(out, 'd47.json'), JSON.stringify(d47Log, null, 2) + '\n');
  }
  if (!EARLY && ONLY !== 'req126' && ONLY !== 'req127' && ONLY !== 'req128' && ONLY !== 'v0146b' && !D47 && !R130 && !R133 && !R134 && !R135 && !R136 && !R137 && !R125 && !R52 && !R125U1 && !R125U2 && !R125U3 && !R125U4 && !R138 && !R139 && !R142) {
  // ---- research/210 (208-D1) kept, REQ-124 ③: on 390px no workflow button in this release (not even on the lane with a
  // definition); the gate's real names keep eight characters and more, the heading's parts side by side inside the screen. ----
  for (const [mode, lang] of [['light', 'en'], ['dark', 'en'], ['light', 'ko'], ['dark', 'ko']]) {
    const scene = `req124-phone-${mode}-${lang}`;
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'bplong-' + lang));
    const lanes = [[byId('mobile-workspace-' + bp.id), BP_LONG.first], [byId('mobile-workspace-' + b.id), BP_LONG.second]];
    await p.waitForSelector(lanes[0][0] + ' ' + byId('workspace-name-link'), { timeout: 15000 });
    await p.waitForTimeout(300);
    check(scene, 'no workflow button on a phone, not even with a definition', (await p.locator(byId('lane-view-toggle') + ',' + byId('lane-view-switch') + ',' + byId('lane-view-workflow')).count()) === 0);
    const shown = sel => p.locator(sel + ' ' + byId('workspace-name-primary')).first().evaluate(el => {
      const right = el.getBoundingClientRect().right - (el.scrollWidth > el.clientWidth ? 8 : 0), walk = document.createTreeWalker(el, 4), range = document.createRange();
      let n = 0, node;
      while ((node = walk.nextNode())) for (let i = 0; i < node.length; i++) { range.setStart(node, i); range.setEnd(node, i + 1); if (range.getBoundingClientRect().right <= right) n++; }
      return n;
    });
    for (const [section, name] of lanes) {
      const text = await p.locator(section + ' ' + byId('workspace-name-primary')).first().innerText();
      check(scene, `the real name (${name})`, text === name, text);
      const chars = await shown(section);
      console.log('REQ-124 workspace name on 390px:', JSON.stringify({ scene, name, chars }));
      check(scene, `its name keeps eight characters and more (${name})`, chars >= 8, String(chars));
      const parts = await p.locator(section + ' ' + byId('mobile-workspace-heading')).first().evaluate(el => [...el.children].map(c => { const r = c.getBoundingClientRect(); return { id: c.getAttribute('data-testid'), x: r.x, right: r.right }; }));
      check(scene, `the heading's parts side by side, inside the screen (${name})`, parts.every((v, i) => i === 0 || v.x >= parts[i - 1].right - .5) && parts.at(-1).right <= 390 + .5, JSON.stringify(parts));
    }
    await p.screenshot({ path: path.join(out, `${scene}-board.png`) });
    await p.locator(lanes[1][0] + ' ' + byId('workspace-name-link')).first().tap();
    await p.waitForSelector(byId('board-appbar'), { timeout: 10000 }).catch(() => {});
    const read = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.get').map(v => v.input.boardId));
    check(scene, 'a press on the name opens its board', await visible(p, byId('board-appbar')) && read.at(-1) === b.id, JSON.stringify(read));
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'no workflow read on a phone, nothing written', !calls.includes('kanban.v1.workflow.get') && (await p.evaluate(() => window.__writes.length)) === 0, calls.join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  if (!EARLY && ONLY !== 'req126' && ONLY !== 'req128' && ONLY !== 'v0146b' && !D47 && !R130 && !R133 && !R134 && !R135 && !R136 && !R137 && !R125 && !R52 && !R125U1 && !R125U2 && !R125U3 && !R125U4 && !R138 && !R139 && !R142) {
  // ---- REQ-127: the board screen a lane's name opens has the lane's "보드 | 워크플로" too, beside its title — only for a workspace
  // with a definition, only on a wide window. The workflow takes the board's whole width in place of its columns; the choice is the
  // lane's own (one session value), so the lane shows what its board showed when it is left. 1400 and 1920, light and dark. ----
  const wfBoard = byId('board-workflow');
  for (const [width, mode] of [[1400, 'light'], [1400, 'dark'], [1920, 'light'], [1920, 'dark']]) {
    const scene = `req127-board${width}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy('ko');
    const p = await (await browser.newContext({ viewport: { width, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-gate-ko'));
    await p.waitForSelector(wfLane + ' ' + byId('workspace-name-link'), { timeout: 15000 });
    await clickAt(p, wfLane + ' ' + byId('workspace-name-link'));
    await p.waitForSelector(byId('board-appbar') + ' ' + byId('lane-view-switch'), { timeout: 10000 }).catch(() => {});
    const bar = byId('board-appbar');
    check(scene, 'the switch in the board\'s top bar', await visible(p, bar + ' ' + byId('lane-view-switch'))
      && await textOf(p, bar + ' ' + byId('lane-view-board')) === m.boardView && await textOf(p, bar + ' ' + byId('lane-view-workflow')) === m.workflowView);
    check(scene, 'the board first, its columns shown', await p.locator(bar + ' ' + byId('lane-view-board')).first().getAttribute('aria-checked') === 'true'
      && await visible(p, byId('board-cell-doing')) && (await p.locator(wfBoard).count()) === 0);
    // Beside the title (as the lane's is beside the name), the top bar's tools still at its right end.
    const title = await box(p, byId('board-title')), sw = await box(p, bar + ' ' + byId('lane-view-switch')), gear = await box(p, bar + ' ' + byId('open-settings'));
    check(scene, 'right after the title, the tools at the right', !!title && !!sw && !!gear && sw.x >= title.x + title.width - .5 && sw.x - (title.x + title.width) <= 200
      && gear.x > sw.x + sw.width && gear.x + gear.width <= width, JSON.stringify({ title, sw, gear }));
    check(scene, 'nothing read before it is opened', !(await p.evaluate(() => window.__calls)).includes('kanban.v1.workflow.get'));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-board.png`) });
    await clickAt(p, bar + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(wfBoard + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the workflow in place of the columns', await visible(p, wfBoard + ' ' + byId('workflow')) && (await p.locator('[data-testid^="board-cell-"]').count()) === 0
      && await p.locator(bar + ' ' + byId('lane-view-workflow')).first().getAttribute('aria-checked') === 'true');
    const asked = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.workflow.get').map(v => v.input));
    check(scene, 'one read, for this workspace', JSON.stringify(asked) === JSON.stringify([{ workspaceId: 'wks_example01' }]), JSON.stringify(asked));
    await flowShape(p, scene, wfBoard, 9);
    const root = await box(p, byId('workspace-board')), panel = await box(p, wfBoard + ' ' + byId('workflow')), canvas = await box(p, wfBoard + ' ' + byId('flow-canvas'));
    check(scene, 'the board\'s whole width, inside the window', !!panel && Math.abs(panel.width - (root.width - 24)) <= 1 && panel.x >= root.x + 11 && panel.x + panel.width <= width,
      JSON.stringify({ root, panel }));
    check(scene, 'no sideways scroll, the flow as wide as its box', (await p.locator(wfBoard + ' ' + byId('flow-scroll') + ',' + wfBoard + ' ' + byId('workflow-table-scroll')).count()) === 0
      && !!canvas && Math.abs(canvas.width - (panel.width - 26)) <= 1, JSON.stringify(canvas));
    // Widened, not stretched: the steps stay their lane size, spread over the canvas and centred in it (no empty right half).
    const nodes = await p.locator(wfBoard + ' [data-testid^="flow-node-"]').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, w: r.width }; }));
    const left = Math.min(...nodes.map(n => n.x)) - canvas.x, right = canvas.x + canvas.width - Math.max(...nodes.map(n => n.right));
    console.log('REQ-127 flow on the board:', JSON.stringify({ scene, canvas: canvas.width, left, right, widest: Math.max(...nodes.map(n => n.w)) }));
    check(scene, 'the steps no wider than on the lane', nodes.every(n => n.w <= 124.5), JSON.stringify(nodes.map(n => n.w)));
    // Within the columns' rounding (at most a pixel a column) where the columns are not capped.
    check(scene, 'the flow centred: as much room left as right', Math.abs(left - right) <= 8, JSON.stringify({ left, right }));
    check(scene, 'the steps spread wider than on the lane', Math.max(...nodes.map(n => n.right)) - Math.min(...nodes.map(n => n.x)) > 1118 - 80, JSON.stringify({ left, right }));
    const cellCut = await p.locator(wfBoard + ' [data-testid^="workflow-cell-text-"]').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.innerText));
    check(scene, 'no table text cut', cellCut.length === 0, JSON.stringify(cellCut));
    check(scene, 'the same reading: the gate\'s note, the loop, six releases', (await textsOf(p, wfBoard + ' ' + byId('flow-note-gate'))).join(' ') === '60 불통과 → 조건부'
      && await textOf(p, wfBoard + ' ' + byId('flow-loop-label')) === m.loopTimes('재게이트', 1) + ': 61→62'
      && (await p.locator(wfBoard + ' [data-testid^="workflow-row-0"]').count()) === 6);
    await clickAt(p, `${wfBoard} ${byId('workflow-row-0.2.6')} ${byId('workflow-cell-gate')}`);
    check(scene, 'a cell\'s evidence', (await textsOf(p, wfBoard + ' ' + byId('workflow-evidence-place'))).length === 2);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-workflow.png`) });
    await clickAt(p, wfBoard + ' ' + byId('workflow-release-0.2.4'));
    check(scene, 'another release: its own loops', await textOf(p, wfBoard + ' ' + byId('flow-loop-label')) === m.loopTimes('재게이트', 2) + ': 51→52 · 53→54');
    // Back to the overview with the workflow open: the lane shows it too (one choice per workspace), and the lane's switch puts both back.
    await clickAt(p, byId('board-breadcrumb'));
    await p.waitForSelector(wfLane + ' ' + byId('lane-view-switch'), { timeout: 10000 }).catch(() => {});
    check(scene, 'the lane shows what its board showed', await visible(p, wfLane + ' ' + byId('workflow'))
      && await p.locator(wfLane + ' ' + byId('lane-view-workflow')).first().getAttribute('aria-checked') === 'true');
    await clickAt(p, wfLane + ' ' + byId('lane-view-board'));
    await clickAt(p, wfLane + ' ' + byId('workspace-name-link'));
    await p.waitForSelector(byId('board-cell-doing'), { timeout: 10000 }).catch(() => {});
    check(scene, 'the lane\'s board choice opens the board with its columns', await visible(p, byId('board-cell-doing')) && (await p.locator(wfBoard).count()) === 0
      && await p.locator(bar + ' ' + byId('lane-view-board')).first().getAttribute('aria-checked') === 'true');
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0 && !calls.some(n => /mutate|ensure|ui\.set|busy\.clear/.test(n)), calls.join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // A workspace with no definition: its board as it was, no switch; one light shot.
  {
    const scene = 'req127-none-1400-light';
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', false, 'wf-gate-ko'));
    await p.waitForSelector(wfOther + ' ' + byId('workspace-name-link'), { timeout: 15000 });
    await clickAt(p, wfOther + ' ' + byId('workspace-name-link'));
    await p.waitForSelector(byId('board-cell-doing'), { timeout: 10000 }).catch(() => {});
    const read = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.get').map(v => v.input.boardId));
    check(scene, 'its own board opened', await visible(p, byId('board-appbar')) && read.at(-1) === b.id, JSON.stringify(read));
    check(scene, 'no switch without a definition', (await p.locator(byId('lane-view-switch')).count()) === 0 && await visible(p, byId('board-cell-doing')));
    const title = await box(p, byId('board-title')), gear = await box(p, byId('open-settings'));
    check(scene, 'the top bar as it was', !!title && !!gear && gear.x + gear.width <= 1400 && title.x < gear.x, JSON.stringify({ title, gear }));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'nothing read', !(await p.evaluate(() => window.__calls)).includes('kanban.v1.workflow.get'));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // 390px: the board a lane with a definition opens has no switch in this release (REQ-124's phone release brings both).
  for (const mode of ['light', 'dark']) {
    const scene = `req127-phone-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'bplong-ko'));
    const lane = byId('mobile-workspace-' + bp.id);
    await p.waitForSelector(lane + ' ' + byId('workspace-name-link'), { timeout: 15000 });
    await p.locator(lane + ' ' + byId('workspace-name-link')).first().tap();
    await p.waitForSelector(byId('board-appbar'), { timeout: 10000 }).catch(() => {});
    await p.waitForTimeout(300);
    const read = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.get').map(v => v.input.boardId));
    check(scene, 'the board with a definition opened', await visible(p, byId('board-appbar')) && read.at(-1) === bp.id, JSON.stringify(read));
    check(scene, 'no workflow button on its board on a phone', (await p.locator(byId('lane-view-switch') + ',' + byId('lane-view-workflow') + ',' + byId('board-workflow')).count()) === 0);
    const parts = await p.locator(byId('board-appbar')).first().evaluate(el => [...el.children].map(c => { const r = c.getBoundingClientRect(); return { x: r.x, right: r.right }; }));
    check(scene, 'the top bar inside the screen', parts.every(v => v.right <= 390 + .5), JSON.stringify(parts));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'no workflow read, nothing written', !calls.includes('kanban.v1.workflow.get') && (await p.evaluate(() => window.__writes.length)) === 0, calls.join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-128 (research/232 v2, filter row 1): the lab's message list — a glyph on the wide title row (count: a person's
  // decisions + left waiting), its panel over the board, the filter dropdowns, the rule in words, a thread's newest file. 1400 and
  // 1920, light and dark, Korean. Then: none on 390, none with the lab off. Made-up folder (mail128Reads). ----
  if (ONLY === '' || ONLY === 'req124' || ONLY === 'req128') {
  const tx = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const txs = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const rowIds = p => p.locator('[data-testid^="mailbox-row-"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(12)));
  const inside = (b, w, h) => !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= w + .5 && b.y + b.height <= h + .5;
  // research/236 D4: a 1400 window less Paseo's 320px sidebar (1080), two long names chosen — the filter row stays one line, the
  // dropdowns cut with "…", the count and "Clear all" whole on it; the rule line under it names them in full.
  for (const mode of ['light', 'dark']) {
    const scene = `req128-filters-1080-${mode}`, width = 1080, height = 900;
    const p = await (await browser.newContext({ viewport: { width, height } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'mail128long'));
    await p.waitForSelector(byId('mailbox-button'), { timeout: 15000 });
    await clickAt(p, byId('mailbox-button'));
    await p.waitForSelector(byId('mailbox-filters'), { timeout: 5000 });
    const row = () => p.locator(byId('mailbox-filters')).evaluate(n => { const b = n.getBoundingClientRect(); return { height: Math.round(b.height), width: Math.round(b.width) }; });
    const plain = await row();
    for (const [side, name] of [['from', M128_LONG[0]], ['to', M128_LONG[1]]]) {
      await clickAt(p, byId(`mailbox-${side}-trigger`));
      await p.waitForSelector(byId(`mailbox-${side}-menu`), { timeout: 5000 });
      await clickAt(p, byId(`mailbox-${side}-option-${name}`));
      await escapeFrom(p, `mailbox-${side}-modal`); await p.waitForTimeout(200);
    }
    const chosen = await row();
    const labels = await p.locator('[data-testid="mailbox-from-label"], [data-testid="mailbox-to-label"]').evaluateAll(els => els.map(e => ({ text: e.textContent,
      cut: e.scrollWidth > e.clientWidth + 1, ellipsis: getComputedStyle(e).textOverflow, width: Math.round(e.clientWidth) })));
    check(scene, 'one line before choosing', plain.height <= 48, JSON.stringify(plain));
    check(scene, 'two long names chosen: still one line, as high as before', chosen.height === plain.height, JSON.stringify({ plain, chosen }));
    check(scene, 'the long names cut with "…" on their triggers', labels.length === 2 && labels.every((l, i) => l.text.endsWith(M128_LONG[i]) && l.cut && l.ellipsis === 'ellipsis'), JSON.stringify(labels));
    const shown = await box(p, byId('mailbox-shown')), clear = await box(p, byId('mailbox-clear')), filters = await box(p, byId('mailbox-filters'));
    check(scene, 'the count and "Clear all" whole, on the row, inside the window', !!shown && !!clear && clear.x + clear.width <= width + .5
      && shown.y >= filters.y && clear.y + clear.height <= filters.y + filters.height && await tx(p, byId('mailbox-shown')) === '1/11 스레드', JSON.stringify({ shown, clear, filters }));
    const rule = await tx(p, byId('mailbox-rule-text'));
    check(scene, 'the rule line names them in full', rule.includes(M128_LONG[0]) && rule.includes(M128_LONG[1]), rule);
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const [width, mode] of [[1400, 'light'], [1400, 'dark'], [1920, 'light'], [1920, 'dark']]) {
    const scene = `req128-${width}-${mode}`, c = palette(PASEO_THEMES[mode]), height = width === 1400 ? 900 : 1080;
    const p = await (await browser.newContext({ viewport: { width, height } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'mail128'));
    await p.waitForSelector(byId('mailbox-button'), { timeout: 15000 });
    await p.waitForSelector(byId('mailbox-button-badge'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the glyph\'s count: 2 decisions + 2 left waiting', await tx(p, byId('mailbox-button-badge')) === '4', await tx(p, byId('mailbox-button-badge')));
    const order = await p.locator(byId('swimlane-title-row') + ' [data-testid]').evaluateAll(els => els.map(e => e.dataset.testid));
    check(scene, 'on the title row, after fold-all and before the view switch', order.indexOf('mailbox-button') > order.indexOf('fold-all') && order.indexOf('mailbox-button') < order.indexOf('view-switch'), order.join());
    check(scene, 'the list asked with the host only', JSON.stringify(await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.mail.list').map(v => v.input)))
      === JSON.stringify([{ hostId: 'host_example' }]));
    await away(p);
    await clickAt(p, byId('mailbox-button'));
    await p.waitForSelector(byId('mailbox-panel'), { timeout: 5000 });
    const panel = await box(p, byId('mailbox-panel')), title = await box(p, byId('swimlane-title-row'));
    check(scene, 'the panel under the title row, inside the window', inside(panel, width, height) && panel.y >= title.y + title.height && panel.width >= width - 40, JSON.stringify({ panel, title }));
    check(scene, 'groups: person\'s decision → left waiting → open → closed', JSON.stringify(await txs(p, '[data-testid^="mailbox-group-"][data-testid$="-title"]'))
      === JSON.stringify(['검토자 결정 2', '방치 2', '진행 2', '종결 4']), JSON.stringify(await txs(p, '[data-testid^="mailbox-group-"][data-testid$="-title"]')));
    check(scene, 'closed shows its newest two', (await rowIds(p)).length === 8, String((await rowIds(p)).length));
    check(scene, 'the count line', await tx(p, byId('mailbox-shown')) === '10/10 스레드', await tx(p, byId('mailbox-shown')));
    const titleCut = await p.locator(byId('mailbox-title')).evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).length);
    check(scene, 'titles fit on one line (none cut) at this width', width === 1400 || titleCut === 0, String(titleCut));
    // Contrast: each state's words on its pill, the due words, the muted columns.
    const pills = await p.locator(byId('mailbox-state')).evaluateAll(els => els.map(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e.firstElementChild ?? e).color]));
    const worst = Math.min(...pills.map(([bg, fg]) => contrast(rgb(fg), rgb(bg))));
    check(scene, 'state words 4.5:1 on their pills', worst >= 4.5, worst.toFixed(2));
    const due = await p.locator(byId('mailbox-due')).evaluateAll(els => els.map(e => [e.innerText, getComputedStyle(e).color]));
    check(scene, 'a passed due date in the danger colour, 4.5:1', due.some(([t, col]) => /지남/.test(t) && contrast(rgb(col), c.surface0) >= 4.5), JSON.stringify(due.slice(0, 4)));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-open.png`) });
    // To: the find field, the person pinned on top, workspaces most first with the quiet ones faded.
    await clickAt(p, byId('mailbox-to-trigger'));
    await p.waitForSelector(byId('mailbox-to-menu'), { timeout: 5000 });
    const menu = await box(p, byId('mailbox-to-menu')), trig = await box(p, byId('mailbox-to-trigger'));
    check(scene, 'the menu under its trigger, inside the window', inside(menu, width, height) && menu.y >= trig.y + trig.height, JSON.stringify({ menu, trig }));
    const opts = await p.locator(byId('mailbox-to-menu') + ' [role="checkbox"]').evaluateAll(els => els.map(e => [e.dataset.testid.slice(18), getComputedStyle(e).opacity]));
    check(scene, 'the person first, then most first; none faded', opts[0]?.[0] === '@person' && opts[1]?.[0] === 'wsA' && opts.filter(([, o]) => o === '0.5').map(([id]) => id).sort().join() === 'notesapp,quiet-tool',
      JSON.stringify(opts));
    check(scene, 'a workspace\'s name beside its short name', (await tx(p, byId('mailbox-to-option-wks_example01'))).includes('Example Workspace'), await tx(p, byId('mailbox-to-option-wks_example01')));
    check(scene, 'the find field has the focus', await p.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'mailbox-to-search');
    await p.keyboard.type('exam');
    const found = await p.locator(byId('mailbox-to-options') + ' [role="checkbox"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(18)));
    check(scene, 'typing finds by short name or name', found.join() === 'wks_example01,wks_example02', found.join());
    await p.locator(byId('mailbox-to-search')).fill('');
    await clickAt(p, byId('mailbox-to-option-@person'));
    await clickAt(p, byId('mailbox-to-option-wsA'));
    await moveTo(p, byId('mailbox-to-option-wks_example02'));
    await p.screenshot({ path: path.join(out, `${scene}-dropdown.png`) });
    await escapeFrom(p, 'mailbox-to-modal'); await p.waitForTimeout(200);
    check(scene, 'Escape closes the menu', !(await visible(p, byId('mailbox-to-menu'))));
    check(scene, 'two chosen: the name and a count', await tx(p, byId('mailbox-to-label')) === '받는 곳' && await tx(p, byId('mailbox-to-count')) === '2');
    // From: one choice — its name on the trigger; the two dropdowns are "and".
    await clickAt(p, byId('mailbox-from-trigger'));
    await clickAt(p, byId('mailbox-from-option-wks_example01'));
    await escapeFrom(p, 'mailbox-from-modal'); await p.waitForTimeout(200);
    check(scene, 'one chosen: its name on the trigger', await tx(p, byId('mailbox-from-label')) === '보낸 곳 wks_example01');
    check(scene, 'from wks_example01 and to (the person or wsA) = 4', JSON.stringify((await rowIds(p)).map(id => id.split('_').pop())) === JSON.stringify(['시험정리', '실험실', '이름규칙', '작업단위']),
      JSON.stringify(await rowIds(p)));
    check(scene, 'the rule in words', (await tx(p, byId('mailbox-rule-text'))).startsWith('보낸 곳 wks_example01 그리고 받는 곳 (검토자 결정 또는 wsA)'), await tx(p, byId('mailbox-rule-text')));
    check(scene, '4/10', await tx(p, byId('mailbox-shown')) === '4/10 스레드');
    const hit = await p.locator(byId('mailbox-who') + ' span, ' + byId('mailbox-who') + ' div').evaluateAll(els => els.filter(e => getComputedStyle(e).textDecorationLine === 'underline').map(e => [e.innerText, getComputedStyle(e).color]));
    check(scene, 'the names caught are underlined in the hit colour, 4.5:1', hit.length >= 4 && hit.every(([, col]) => contrast(rgb(col), c.surface0) >= 4.5), JSON.stringify(hit.slice(0, 3)));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-applied.png`) });
    // The pill: or — any thread these are part of.
    await clickAt(p, byId('mailbox-join'));
    check(scene, 'the pill makes it or', await tx(p, byId('mailbox-join-text')) === '또는' && (await rowIds(p)).length === 5, String((await rowIds(p)).length));
    await clickAt(p, byId('mailbox-clear'));
    check(scene, 'clear all', (await rowIds(p)).length === 8 && !(await visible(p, byId('mailbox-rule'))));
    // A thread: the list stays left, the newest file's head and excerpt and the earlier files right.
    const firstRow = (await rowIds(p))[0];
    await clickAt(p, byId('mailbox-row-' + firstRow));
    await p.waitForSelector(byId('mailbox-detail-head'), { timeout: 5000 }).catch(() => {});
    const detail = await box(p, byId('mailbox-detail')), list = await box(p, byId('mailbox-list'));
    check(scene, 'the thread beside the list', detail && list && list.width >= width * .35 && detail.x >= list.x + list.width - 1 && inside(detail, width, height)
      && (await rowIds(p)).length === 8, JSON.stringify({ detail, list }));
    check(scene, 'the newest file\'s 5 head lines and its excerpt', (await txs(p, byId('mailbox-detail-head'))).length === 5 && (await txs(p, byId('mailbox-detail-excerpt'))).length === 3);
    check(scene, 'whose turn, with the record', (await tx(p, byId('mailbox-detail-turn'))).startsWith('차례: 검토자 (기록: wsA)'), await tx(p, byId('mailbox-detail-turn')));
    check(scene, 'earlier files', await tx(p, byId('mailbox-detail-earlier-title')) === '이전 파일 3' && (await p.locator(byId('mailbox-detail-earlier')).count()) === 3);
    const asked = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.mail.thread').map(v => v.input));
    // research/236 J3: the host and the thread's id only — no file name rides along any more.
    check(scene, 'one thread read, by its id only', asked.length === 1 && Object.keys(asked[0]).sort().join() === 'hostId,thread', JSON.stringify(asked));
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-thread.png`) });
    // Two newest files at one time: both shown.
    const tieRow = (await rowIds(p)).find(id => id.endsWith('시안비교'));
    await clickAt(p, byId('mailbox-row-' + tieRow));
    await p.waitForSelector(byId('mailbox-detail-tie'), { timeout: 5000 }).catch(() => {});
    check(scene, 'two newest files: both, said', await tx(p, byId('mailbox-detail-tie')) === '최신 시각 파일 2개 — 모두 읽기' && (await p.locator(byId('mailbox-detail-newest')).count()) === 2);
    if (width === 1920) await p.screenshot({ path: path.join(out, `${scene}-tie.png`) });
    await clickAt(p, byId('mailbox-close'));
    check(scene, 'closed: the board again', !(await visible(p, byId('mailbox-panel'))) && await visible(p, byId('swimlane-cells')));
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'reads only: nothing written, no other call', (await p.evaluate(() => window.__writes.length)) === 0
      && calls.every(n => /overview\.get|revisions\.get|mail\.list|mail\.thread|board\.get/.test(n)), [...new Set(calls)].join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const mode of ['light', 'dark']) {
    // 390: no glyph and nothing read (the lane's badge stays); and a wide board with the lab off has no glyph either.
    const phone = `req128-390-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'mail128'));
    await p.waitForSelector(byId('lane-mail-badge'), { timeout: 15000 }).catch(() => {});
    // REQ-134 MA: the phone has the glyph now (its scenes: =req134); no thread is read before one is pressed.
    check(phone, 'REQ-134: the glyph on a phone too', (await p.locator(byId('mailbox-button')).count()) === 1);
    check(phone, 'no thread read for it', !(await p.evaluate(() => window.__calls)).some(n => /mail\.thread/.test(n)));
    check(phone, 'the lane badge stays', await visible(p, byId('lane-mail-badge')));
    const names = await p.locator(byId('mobile-workspace-heading')).first().evaluate(el => el.getBoundingClientRect().width).catch(() => 0);
    check(phone, 'the heading keeps its width', names > 300, String(names));
    await p.screenshot({ path: path.join(out, `${phone}.png`) });
    check(phone, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
    const wide = `req128-off-${mode}`, q = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await q.goto(page(mode, false));
    await q.waitForSelector(byId('swimlane-title-row'), { timeout: 15000 });
    await q.waitForTimeout(300);
    check(wide, 'the lab off: no glyph, nothing read', (await q.locator(byId('mailbox-button')).count()) === 0
      && !(await q.evaluate(() => window.__calls)).some(n => /mail\./.test(n)));
    await q.context().close();
  }
  }
  // ---- D48: the wide message list stays open — its search, the closed threads shown and the thread opened — when the host
  // hands over its other theme and draws the screen anew (Paseo's remount took the panel's state with it), and back again; a
  // change of the device's scheme alone keeps it too. Closing it still forgets them. 1920, light → dark and dark → light. ----
  if (ONLY === '' || ONLY === 'req124' || ONLY === 'req128') {
  const tx = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const rowIds = p => p.locator('[data-testid^="mailbox-row-"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(12)));
  for (const [from, to] of [['light', 'dark'], ['dark', 'light']]) {
    const scene = `d48-${from}-to-${to}`;
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1000 }, colorScheme: from })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(from, false, 'mail128'));
    await p.waitForSelector(byId('mailbox-button'), { timeout: 15000 });
    await clickAt(p, byId('mailbox-button'));
    await p.waitForSelector(byId('mailbox-panel'), { timeout: 5000 });
    await clickAt(p, byId('mailbox-closed-toggle'));
    const all = await rowIds(p), word = (await tx(p, byId('mailbox-title'))).split(' ')[0];
    await p.locator(byId('mailbox-search')).fill(word);
    await p.waitForTimeout(300);
    const pick = (await rowIds(p))[0];
    await clickAt(p, byId('mailbox-row-' + pick));
    await p.waitForSelector(byId('mailbox-detail-subject'), { timeout: 5000 });
    await away(p);
    const look = async () => ({ open: await visible(p, byId('mailbox-panel')), rows: await rowIds(p), shown: await tx(p, byId('mailbox-shown')),
      search: await p.locator(byId('mailbox-search')).inputValue().catch(() => null), closed: await tx(p, byId('mailbox-closed-toggle')),
      subject: await tx(p, byId('mailbox-detail-subject')),
      back: await p.locator(byId('mailbox-layer')).evaluate(e => getComputedStyle(e).backgroundColor).catch(() => '') });
    const before = await look();
    check(scene, 'set up: the closed shown, a search, a thread open', before.open && before.rows.length > 0 && before.rows.length <= all.length && !!before.subject && before.search === word,
      JSON.stringify({ before, all: all.length, word }));
    await p.screenshot({ path: path.join(out, `${scene}-before.png`) });
    // The host's other theme, the screen drawn anew (as Paseo does), and the device's scheme with it.
    await p.evaluate(theme => window.__hostTheme(theme, true), PASEO_THEMES[to]);
    await p.emulateMedia({ colorScheme: to });
    await p.waitForSelector(byId('swimlane-title-row'), { timeout: 10000 });
    await p.waitForTimeout(800);
    const after = await look();
    check(scene, 'after the remount in the other theme: still open, the same search, rows and thread', after.open && after.search === before.search
      && JSON.stringify(after.rows) === JSON.stringify(before.rows) && after.shown === before.shown && after.closed === before.closed && after.subject === before.subject,
      JSON.stringify({ before, after }));
    check(scene, 'drawn in the other theme', rgb(after.back) === palette(PASEO_THEMES[to]).surface0.toLowerCase() && after.back !== before.back, JSON.stringify([before.back, after.back]));
    await p.screenshot({ path: path.join(out, `${scene}-after.png`) });
    // Back, the same way; then the device's scheme alone (no remount).
    await p.evaluate(theme => window.__hostTheme(theme, true), PASEO_THEMES[from]);
    await p.emulateMedia({ colorScheme: from });
    await p.waitForTimeout(800);
    const back = await look();
    check(scene, 'and back: still open, the same', back.open && back.search === before.search && JSON.stringify(back.rows) === JSON.stringify(before.rows) && back.subject === before.subject
      && back.back === before.back, JSON.stringify({ before, back }));
    await p.emulateMedia({ colorScheme: to });
    await p.waitForTimeout(500);
    check(scene, 'the device\'s scheme alone: still open', (await look()).open);
    // Closing forgets: open again, nothing searched, no thread.
    await clickAt(p, byId('mailbox-close'));
    check(scene, 'closed', !(await visible(p, byId('mailbox-panel'))));
    await clickAt(p, byId('mailbox-button'));
    await p.waitForSelector(byId('mailbox-panel'), { timeout: 5000 });
    const again = await look();
    check(scene, 'opened again: no search, no thread, closed threads folded', again.search === '' && !again.subject && again.closed !== before.closed, JSON.stringify(again));
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'reads only: nothing written', (await p.evaluate(() => window.__writes.length)) === 0
      && calls.every(n => /overview\.get|revisions\.get|mail\.list|mail\.thread|board\.get/.test(n)), [...new Set(calls)].join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-130 (research/260 C): the lead's own state first on its row, and its memo — 1920 and 390, ko and en, light and dark ----
  if (ONLY === '' || R130) {
  for (const width of [1920, 390]) for (const locale of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const mobile = width === 390, scene = `req130-${width}-${locale}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(locale);
    const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1920, height: 1080 } };
    const p = await (await browser.newContext(ctxOpts)).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const url = page(mode, mobile, `req130-${locale}-${width}`);
    await p.clock.install({ time: R_NOW });
    await p.goto(url);
    if (mobile) { await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 }); await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(300); }
    const label = t => `[aria-label="${t}"]`, card = t => label(t) + ' ', row = t => card(t) + byId('lead-status');
    await p.waitForSelector(row('Release lead'), { timeout: 15000 });
    const words = async sel => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
    const upsert = agent => p.evaluate(value => { const at = new Date().toISOString(); window.__agentUpsert({ ...value, updatedAt: at, lastActivityAt: at }); }, agent);
    // The lead at work from now; seven minutes on, the other lead's turn ends; five more: 12 and 5 minutes.
    await upsert(R_AGENT(R_IDS.work, { status: 'running' }));
    await p.clock.fastForward(7 * 60000); await p.waitForTimeout(100);
    await upsert(R_AGENT(R_IDS.turn, { status: 'idle', requiresAttention: true, attentionReason: 'finished' }));
    await p.clock.fastForward(5 * 60000); await p.waitForTimeout(300);
    const pageNow = await p.evaluate(() => Date.now()), age = n => m.busyAge({ unit: 'minute', count: n });
    // REQ-135: the row is its own state; its sub-cards' part is on the family line.
    const fam = t => card(t) + byId('family-summary');
    const want = {
      'Release lead': [m.leadSelfWorking(age(12)), m.statusRunning(1)],
      'Review lead': [m.leadSelfUnseen(age(5)), m.statusAwaiting(1)],
      'Quiet lead': [m.leadSelfRest(deviceClock(R_NOW - 48 * 60000, pageNow)), m.statusRunning(1)] };
    for (const [title, [text, part]] of Object.entries(want)) check(scene, title + ': its own state on the row, its sub-cards on the family line',
      await words(row(title)) === text && await spokenParts(p, fam(title)) === part, await words(row(title)) + ' / ' + await spokenParts(p, fam(title)) + ' / want ' + text + ' / ' + part);
    for (const [title, mark] of [['Release lead', 'lead-status-me-ring'], ['Review lead', 'lead-status-me-hollow'], ['Quiet lead', 'lead-status-me-circle']])
      check(scene, title + ': its mark (' + mark.slice(15) + ')', (await p.locator(row(title) + ' ' + byId(mark)).count()) === 1);
    const tint = async title => rgb((await style(p, row(title) + ' ' + byId('lead-status-me-text'), ['color'])).color);
    check(scene, 'colours: blue at work, orange awaiting review, muted resting', await tint('Release lead') === readableHex(c.running, c.card)
      && await tint('Review lead') === readableHex(c.statusWarning, c.card) && await tint('Quiet lead') === readableHex(c.foregroundMuted, c.card),
      [await tint('Release lead'), await tint('Review lead'), await tint('Quiet lead')].join());
    // ② the memo: a pencil line under the row, last in the card; the card keeps its own edge.
    const memo = card('Release lead') + byId('lead-memo');
    // The page's Icon stand-in draws its name's first letter: the pencil's "P" is not part of the words.
    check(scene, 'the memo under the status row', (await words(memo)).replace(/^P /, '') === (locale === 'ko' ? '출시 전 시험' : 'Release tests') + ' · ' + age(12)
      && (await p.locator(memo + ' [data-icon="Pencil"]').count()) === 1
      && JSON.stringify(await p.locator(card('Release lead') + byId('lead-status')).evaluateAll(els => els.map(e => e.nextElementSibling?.getAttribute('data-testid') === 'lead-memo'
        && e.parentElement.lastElementChild === e.nextElementSibling))) === '[true]', await words(memo));
    check(scene, 'a lead with a memo keeps its own edge', (await style(p, card('Release lead') + byId('card-content'), ['borderTopStyle'])).borderTopStyle === 'solid');
    check(scene, 'a plain card\'s mark as REQ-84 had it', (await p.locator(card('Nightly build') + byId('card-busy')).count()) === (mobile ? 0 : 1)
      && (await p.locator(byId('lead-memo')).count()) === 1);
    for (const title of Object.keys(want)) {
      const rb = await box(p, row(title)), cb = await box(p, label(title));
      check(scene, title + ': the row inside its card', rb && cb && rb.x + rb.width <= cb.x + cb.width + 0.5 && rb.y + rb.height <= cb.y + cb.height, JSON.stringify([rb, cb]));
    }
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}.png`), fullPage: !mobile });
    if (mobile) {
      await p.locator(byId('mobile-tab-doing')).first().tap(); await p.waitForTimeout(300);
      check(scene, 'phone: a plain card\'s mark as REQ-84 had it', (await p.locator(card('Nightly build') + byId('card-busy')).count()) === 1);
      await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(300);
    }
    // The detail of a resting lead turns its memo on (busy.set), the board then shows it; another card's detail has none.
    if (locale === 'en' && mode === 'light') {
      // Its title, not its middle (the status row there is a press of its own that does nothing — research/166 J1).
      if (mobile) await p.locator(label('Quiet lead')).first().tap({ position: { x: 60, y: 16 } }); else await p.locator(label('Quiet lead')).first().click({ position: { x: 60, y: 16 } });
      await p.waitForSelector(byId('detail-memo'), { timeout: 5000 }).catch(() => {});
      check(scene, 'the lead\'s detail offers the memo', await visible(p, byId('detail-memo')));
      await p.locator(byId('detail-memo-input')).first().fill('Night tests');
      await p.screenshot({ path: path.join(out, `${scene}-detail-memo.png`) });
      await p.locator(byId('detail-memo-on')).first().click(); await p.waitForTimeout(500);
      const sent = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.busy.set').map(v => v.input));
      check(scene, 'busy.set once, that card, those words', sent.length === 1 && sent[0].text === 'Night tests', JSON.stringify(sent));
      check(scene, 'the detail shows it, with "Turn off"', /^Night tests · <1m/.test(await words(byId('detail-busy-text'))) && await visible(p, byId('detail-busy-off')),
        await words(byId('detail-busy-text')));
      await p.screenshot({ path: path.join(out, `${scene}-detail-on.png`) });
      if (mobile) await p.keyboard.press('Escape'); else await p.keyboard.press('Escape');
      await p.waitForTimeout(600);
      if (await visible(p, byId('detail-backdrop'))) { await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }); await p.waitForTimeout(400); }
      await p.waitForSelector(card('Quiet lead') + byId('lead-memo'), { timeout: 8000 }).catch(() => {});
      check(scene, 'the board reads the memo on the lead', /^(P )?Night tests · /.test(await words(card('Quiet lead') + byId('lead-memo')).catch(() => '')));
      await p.screenshot({ path: path.join(out, `${scene}-memo-on.png`) });
      if (!mobile) {
        await p.locator(label('Nightly build')).first().click({ position: { x: 60, y: 16 } });
        await p.waitForSelector(byId('detail-backdrop'), { timeout: 5000 }).catch(() => {});
        check(scene, 'another card\'s detail: no memo', (await p.locator(byId('detail-memo')).count()) === 0 && await visible(p, byId('detail-busy')));
      }
    }
    // Asking you itself on your turn is one wait, not two: the sub-card's wait alone is counted; with none, no "awaiting" part.
    await upsert(R_AGENT(R_IDS.turn, { status: 'idle', pendingPermissions: [{ requestId: 'p1' }] }));
    await upsert(R_AGENT(R_IDS.rest, { status: 'idle', pendingPermissions: [{ requestId: 'p2' }] }));
    await p.waitForTimeout(300);
    check(scene, 'asking itself + a sub-card waiting: that one counted once', await spokenParts(p, fam('Review lead')) === m.statusAwaiting(1), await spokenParts(p, fam('Review lead')));
    check(scene, 'asking itself alone: no awaiting part', await spokenParts(p, fam('Quiet lead')) === m.statusRunning(1) && !(await words(row('Quiet lead'))).includes(m.statusAwaiting(1)), await spokenParts(p, fam('Quiet lead')));
    check(scene, 'asking itself alone (with a running part): the mark is the press; asking + sub-card: the mark is no press, the part is',
       (await p.locator(fam('Review lead') + ' ' + byId('lead-status-awaiting')).count()) === 1 && (await p.locator(row('Review lead') + ' ' + byId('lead-status-awaiting')).count()) === 0
      && (await p.locator(row('Quiet lead') + ' ' + byId('lead-status-awaiting')).count()) === 1 && /Needs your answer|답변 대기/.test(await words(row('Quiet lead'))) && (await p.locator(row('Quiet lead') + ' ' + byId('lead-status-awaiting') + ' ' + byId('lead-status-me-text')).count()) === 1);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written to the ledger or settings', (await p.evaluate(() => window.__writes.length)) === 0
      && (await p.evaluate(() => window.__calls.filter(n => /mutate|ensure/.test(n)).length)) === 0);
    await p.context().close();
  }
  }
  // ---- REQ-133 (research/264 J7·J1·J3): the lead's five states, timed by the host, their presses, and the list's lead detail ----
  if (ONLY === '' || R133) {
  for (const width of [1920, 390]) for (const locale of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const mobile = width === 390, scene = `req133-${width}-${locale}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(locale);
    const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1920, height: 1080 } };
    const p = await (await browser.newContext(ctxOpts)).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const url = page(mode, mobile, `req133-${locale}-${width}`);
    await p.clock.install({ time: R3_NOW });
    await p.goto(url);
    let tab = '';
    // A phone shows one column: the lead's tab first.
    const go = async title => { if (!mobile || R3_TAB[title] === tab) return; tab = R3_TAB[title];
      await p.waitForSelector(byId('mobile-tab-' + tab), { timeout: 15000 }); await p.locator(byId('mobile-tab-' + tab)).first().tap(); await p.waitForTimeout(300); };
    const label = t => `[aria-label="${t}"]`, card = t => label(t) + ' ', row = t => card(t) + byId('lead-status');
    await go('Release lead');
    await p.waitForSelector(row('Release lead'), { timeout: 15000 });
    await p.waitForTimeout(300);
    const words = async sel => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
    const age = n => m.busyAge({ unit: 'minute', count: n });
    // REQ-135: the row is the lead's own state; its sub-cards' part is on the family line.
    const fam = t => card(t) + byId('family-summary');
    const parts = { 'Release lead': m.statusRunning(1), 'Question lead': '', 'Review lead': m.statusAwaiting(1), 'Broken lead': '', 'Quiet lead': m.statusRunning(1) };
    const want = shift => ({
      'Release lead': m.leadSelfWorking(age(12 + shift)),
      'Question lead': m.leadSelfAsking(age(3 + shift)),
      'Review lead': m.leadSelfUnseen(age(7 + shift)),
      'Broken lead': m.leadSelfError(age(4 + shift)),
      'Quiet lead': m.leadSelfRest(deviceClock(R3_NOW - 48 * 60000, R3_NOW + shift * 60000)) });
    // J1: begun before the screen opened, yet timed — from the host's own start, at once.
    for (const [title, text] of Object.entries(want(0))) { await go(title); check(scene, title + ': its state timed by the host at first sight', await words(row(title)) === text
      && await spokenParts(p, fam(title)) === parts[title], await words(row(title)) + ' / ' + await spokenParts(p, fam(title)) + ' / want ' + text); }
    await p.clock.fastForward(5 * 60000); await p.waitForTimeout(300);
    for (const [title, text] of Object.entries(want(5))) { await go(title); check(scene, title + ': five minutes on', await words(row(title)) === text, await words(row(title)) + ' / want ' + text); }
    const marks = { 'Release lead': ['working', 'ring', c.running], 'Question lead': ['asking', 'dot', c.statusWarning], 'Review lead': ['unseen', 'hollow', c.statusWarning],
      'Broken lead': ['error', 'danger', c.statusDanger], 'Quiet lead': ['rest', 'circle', c.foregroundMuted] };
    for (const [title, [kind, glyph, tone]] of Object.entries(marks)) {
      await go(title);
      check(scene, title + ': its mark (' + kind + ', ' + glyph + ')', (await p.locator(row(title) + ' ' + byId('lead-status-me-' + kind)).count()) === 1
        && (await p.locator(row(title) + ' ' + byId('lead-status-me-' + glyph)).count()) === 1);
      const tint = rgb((await style(p, row(title) + ' ' + byId('lead-status-me-text'), ['color'])).color);
      check(scene, title + ': its colour', tint === readableHex(tone, c.card), tint + ' / want ' + readableHex(tone, c.card));
    }
    const dotOf = async title => rgb((await style(p, row(title) + ' ' + byId('lead-status-me-' + marks[title][1]) + ' > div', ['backgroundColor', 'borderTopColor'])).borderTopColor);
    await go('Question lead');
    const question = rgb((await style(p, row('Question lead') + ' ' + byId('lead-status-me-dot') + ' > div', ['backgroundColor'])).backgroundColor);
    if (mobile) await p.screenshot({ path: path.join(out, `${scene}-doing.png`) });
    await go('Review lead');
    check(scene, 'the question\'s dot is filled orange, the look\'s an orange ring, the error\'s dot red',
      question === readable(c.statusWarning, c.card, 3).toLowerCase()
      && await dotOf('Review lead') === readable(c.statusWarning, c.card, 3).toLowerCase()
      && rgb((await style(p, row('Broken lead') + ' ' + byId('lead-status-me-danger') + ' > div', ['backgroundColor'])).backgroundColor) === readable(c.statusDanger, c.card, 3).toLowerCase(),
      await dotOf('Review lead'));
    for (const title of Object.keys(marks)) {
      await go(title);
      const rb = await box(p, row(title)), cb = await box(p, label(title));
      check(scene, title + ': the row inside its card', rb && cb && rb.x + rb.width <= cb.x + cb.width + 0.5 && rb.y + rb.height <= cb.y + cb.height, JSON.stringify([rb, cb]));
    }
    await go('Review lead'); await away(p);
    await p.screenshot({ path: path.join(out, `${scene}.png`), fullPage: !mobile });
    // J7: the presses — "Awaiting answer" (D43), "Awaiting review" and "Error" open that lead's chat; at work and resting, none.
    const hit = async sel => { if (mobile) await p.locator(sel).first().tap(); else await clickAt(p, sel); await p.waitForTimeout(250); };
    for (const [title, id, press] of [['Question lead', R3_IDS.ask, 'lead-status-awaiting'], ['Review lead', R3_IDS.look, 'lead-status-me-open'],
      ['Broken lead', R3_IDS.fail, 'lead-status-me-open']]) {
      await go(title);
      const sel = row(title) + ' ' + byId(press);
      check(scene, title + ': its mark is a press (' + press + ')', (await p.locator(sel).count()) === 1);
      if (!(await p.locator(sel).count())) continue;
      await p.locator(sel).first().scrollIntoViewIfNeeded();
      const pb = await box(p, sel);
      if (mobile) check(scene, title + ': a finger-sized press', pb && pb.width >= 32 && pb.height >= 28, JSON.stringify(pb));
      await hit(sel);
      await leaveOpen(p, scene, mobile);
      check(scene, title + ': the press opens its chat, no detail', JSON.stringify((await p.evaluate(() => window.__opened.slice())).at(-1)) === JSON.stringify(['agent', id])
        && (await p.locator(byId('detail-backdrop') + ',' + byId('editor-sheet')).count()) === 0, JSON.stringify(await p.evaluate(() => window.__opened.slice())));
    }
    await go('Review lead');
    if (!mobile) check(scene, 'the review lead\'s press is labelled for a screen reader', (await p.locator(row('Review lead') + ' ' + byId('lead-status-me-open')).first().getAttribute('aria-label'))
      === m.leadSelfOpen(m.leadSelfUnseen(age(12)), 'Review lead'), await p.locator(row('Review lead') + ' ' + byId('lead-status-me-open')).first().getAttribute('aria-label'));
    check(scene, 'resting: no press on the mark', (await p.locator(row('Quiet lead') + ' ' + byId('lead-status-me-open') + ',' + row('Quiet lead') + ' ' + byId('lead-status-awaiting')).count()) === 0);
    await go('Release lead');
    check(scene, 'at work and resting: no press on the mark', (await p.locator(row('Release lead') + ' ' + byId('lead-status-me-open') + ',' + row('Quiet lead') + ' ' + byId('lead-status-me-open')).count()) === 0
      && (await p.locator(row('Release lead') + ' ' + byId('lead-status-awaiting') + ',' + row('Quiet lead') + ' ' + byId('lead-status-awaiting')).count()) === 0);
    // J3: the list view's detail of a lead offers its memo as the board's does (en light); another card's has none.
    if (locale === 'en' && mode === 'light') {
      if (mobile) await p.locator(byId('view-toggle')).first().tap(); else await clickAt(p, byId('view-list'));
      await p.waitForSelector(byId('attention-row'), { timeout: 10000 }).catch(() => {});
      const listRow = t => byId('attention-row') + `:has-text("${t}")`;
      check(scene, 'the list has the lead that waits for you', (await p.locator(listRow('Broken lead')).count()) === 1);
      await hit(listRow('Broken lead'));
      await p.waitForSelector(byId('detail-memo'), { timeout: 8000 }).catch(() => {});
      check(scene, 'the list\'s lead detail offers the memo', await visible(p, byId('detail-memo')));
      await p.locator(byId('detail-memo-input')).first().fill('Error triage');
      await p.screenshot({ path: path.join(out, `${scene}-list-memo.png`) });
      await p.locator(byId('detail-memo-on')).first().click(); await p.waitForTimeout(500);
      const sent = () => p.evaluate(() => window.__inputs.filter(v => /busy\.(set|clear)$/.test(v.name)).map(v => [v.name.split('.').at(-1), v.input.text ?? null]));
      check(scene, 'list detail: busy.set once with those words', JSON.stringify(await sent()) === JSON.stringify([['set', 'Error triage']]), JSON.stringify(await sent()));
      check(scene, 'list detail: on, with "Turn off"', /^Error triage · <1m/.test(await words(byId('detail-busy-text')).catch(() => '')) && await visible(p, byId('detail-busy-off')));
      await p.screenshot({ path: path.join(out, `${scene}-list-memo-on.png`) });
      await p.locator(byId('detail-busy-off')).first().click(); await p.waitForTimeout(500);
      check(scene, 'list detail: off by busy.clear, the memo offered again', JSON.stringify(await sent()) === JSON.stringify([['set', 'Error triage'], ['clear', null]])
        && await visible(p, byId('detail-memo')), JSON.stringify(await sent()));
      await p.keyboard.press('Escape'); await p.waitForTimeout(600);
      if (await visible(p, byId('detail-backdrop'))) { await p.locator(byId('detail-backdrop')).first().click({ position: { x: 8, y: 8 } }); await p.waitForTimeout(400); }
      if (await p.locator(listRow('Copy edit')).count()) {
        await hit(listRow('Copy edit'));
        await p.waitForSelector(byId('detail-backdrop') + ',' + byId('editor-sheet'), { timeout: 5000 }).catch(() => {});
        await p.waitForTimeout(500);
        check(scene, 'the list\'s detail of a sub-card: no memo', (await p.locator(byId('detail-memo')).count()) === 0);
      } else check(scene, 'the list\'s detail of a sub-card: no memo', false, 'Copy edit is not listed');
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written to the ledger or settings', (await p.evaluate(() => window.__writes.length)) === 0
      && (await p.evaluate(() => window.__calls.filter(n => /mutate|ensure/.test(n)).length)) === 0);
    await p.context().close();
  }
  }
  // ---- REQ-135: the sub-cards' parts on the family line, the lead's own state alone on the row under it — five states × their
  // parts × 1920 and 390 × ko and en × light and dark; a 264px card's narrow rule (no count cut, the check first to give way);
  // a part's press highlights its cards as before. D51: the tips stay inside what can be seen — the window, a host panel beside
  // the plugin on either side — and a tip longer than 320px wraps. Made-up fixtures only. ----
  if (ONLY === '' || R135) {
  for (const width of [1920, 390]) for (const locale of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const mobile = width === 390, scene = `req135-${width}-${locale}-${mode}`, m = copy(locale);
    const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1920, height: 1080 } };
    const p = await (await browser.newContext(ctxOpts)).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.clock.install({ time: Date.now() });
    await p.goto(page(mode, mobile, `req135-${locale}`));
    let tab = '';
    const go = async title => { if (!mobile || R5_TAB[title] === tab) return; tab = R5_TAB[title];
      await p.waitForSelector(byId('mobile-tab-' + tab), { timeout: 15000 }); await p.locator(byId('mobile-tab-' + tab)).first().tap(); await p.waitForTimeout(300); };
    const label = t => `[aria-label="${t}"]`, card = t => label(t) + ' ', row = t => card(t) + byId('lead-status'), fam = t => card(t) + byId('family-summary');
    await go('Full lead');
    await p.waitForSelector(fam('Full lead'), { timeout: 15000 }); await p.waitForTimeout(400);
    // The words without the page's glyph stand-ins (an Icon draws its name's first letter).
    const words = sel => p.locator(sel).first().evaluate(el => { const copy = el.cloneNode(true); copy.querySelectorAll('[data-icon]').forEach(n => n.remove());
      return copy.innerText.replace(/\s+/g, ' ').trim(); });
    const parts = sel => p.locator(sel + ' [data-testid^="family-summary-all"], ' + sel + ' [data-testid^="family-summary-open"], ' + sel + ' [data-testid^="lead-status-"]')
      .evaluateAll(els => els.map(e => e.dataset.testid).filter(id => !/face|quiet/.test(id)).map(id => id.replace(/^lead-status-|^family-summary-/, '')));
    const age = n => m.busyAge({ unit: 'minute', count: n }), testAt = deviceClock(R5_NOW - 10 * 60000, R5_NOW), failAt = deviceClock(R5_NOW - 6 * 60000, R5_NOW);
    // Each lead: its own state alone on the row; its family line's parts in order; the words it may say at each fit.
    const leads = {
      'Full lead': { me: m.leadSelfWorking(age(12)), order: ['all', 'running', 'open', 'awaiting', 'testing'], total: 3, open: 3, running: 1, awaiting: 1, at: testAt },
      'Ask lead': { me: m.leadSelfAsking(age(3)), order: ['all', 'running', 'open'], total: 1, open: 1, running: 1 },
      'Look lead': { me: m.leadSelfUnseen(age(7)), order: ['all', 'open', 'awaiting'], total: 1, open: 1, awaiting: 1 },
      'Broken lead': { me: m.leadSelfError(age(4)), order: ['all', 'open', 'testing'], total: 1, open: 1, at: failAt },
      'Quiet lead': { me: m.leadSelfRest(deviceClock(R5_NOW - 48 * 60000, R5_NOW)), order: ['all', 'open'], total: 1, open: 1 } };
    const say = (lead, fit) => { const full = fit === 'full' || lead.order.length === 2, out = [m.subCount(lead.total)];
      // research/275 F1: past 'drop', "Sub-cards" by its tree alone ('tight'), then the words a letter ('bare').
      if (fit === 'tight' || fit === 'bare') out[0] = String(lead.total);
      const words = (whole, short, mark) => full ? whole : fit === 'bare' ? mark : short;
      if (lead.running) out.push(words(m.statusRunning, m.statusRunningShort, m.statusRunningMark)(lead.running));
      out.push(words(m.openCount, m.openCountShort, m.openCountMark)(lead.open));
      if (lead.awaiting) out.push(words(m.statusAwaiting, m.statusAwaitingShort, m.statusAwaitingMark)(lead.awaiting));
      // 'icon': the check's clock alone (no words) still sits after its dot.
      if (lead.at && ['full', 'short', 'clock', 'icon'].includes(fit)) out.push(full ? m.statusTesting(lead.at) : fit === 'short' ? m.statusTestingShort(lead.at) : fit === 'clock' ? m.statusTestingClock(lead.at) : '');
      return out.join('·'); };
    const fits = {};
    for (const [title, lead] of Object.entries(leads)) {
      await go(title);
      const rowWords = await words(row(title)), line = await words(fam(title));
      check(scene, title + ': the row is the lead\'s own state alone', rowWords === lead.me, rowWords + ' / want ' + lead.me);
      check(scene, title + ': no sub-card part on the row', (await p.locator(row(title) + ' ' + byId('lead-status-running') + ',' + row(title) + ' ' + byId('lead-status-testing')
        + ',' + row(title) + ' [data-testid="lead-status-awaiting"]:not(:has([data-testid="lead-status-me-text"]))').count()) === 0);
      const fit = ['full', 'short', 'clock', 'icon', 'drop', 'tight', 'bare'].find(f => say(lead, f) === line.replace(/ ?· ?/g, '·'));
      fits[title] = fit ?? '?';
      check(scene, title + ': the family line says "Sub-cards · Running · not done · Awaiting · Testing" at one fit', !!fit, line);
      const order = await parts(fam(title)), want = lead.order.filter(k => k !== 'testing' || !['drop', 'tight', 'bare'].includes(fit));
      check(scene, title + ': parts in the family line\'s order', JSON.stringify(order) === JSON.stringify(want), JSON.stringify(order));
      // No count is cut: every words box shows all it has, and the line ends inside the card.
      const cut = await p.locator(fam(title) + ' div[dir="auto"]').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
      check(scene, title + ': nothing cut', cut.length === 0, JSON.stringify(cut));
      const fb = await box(p, fam(title)), cb = await box(p, card(title) + byId('card-content'));
      check(scene, title + ': the line inside the card', fb && cb && fb.x + fb.width <= cb.x + cb.width - 11 && fb.x >= cb.x, JSON.stringify([fb, cb]));
      check(scene, title + ': one line, the card as tall as before', fb && fb.height <= 17 && (await box(p, label(title))).height === 84 + 44 - 18, JSON.stringify(fb));
    }
    // The narrow rule: what the full lead says at 264px (wide) and on a phone — written down, the counts always there.
    check(scene, 'Full lead: every count said (sub-cards 3, running 1, not done 3, awaiting 1)', ['all', 'running', 'open', 'awaiting'].every(k => (fits['Full lead'] ?? '') !== '?'));
    check(scene, 'Full lead fit: ' + fits['Full lead'], true);
    // The parts press as before: running, awaiting, the check, not done, the family — each rings its cards and the lead.
    await go('Full lead');
    const hit = async sel => { if (mobile) await p.locator(sel).first().tap(); else await clickAt(p, sel); await p.waitForTimeout(300); };
    const lit = async () => (await ringed(p)).filter(Boolean).sort().join();
    const presses = [['lead-status-running', 'Build step,Full lead'], ['lead-status-awaiting', 'Full lead,Pick copy'],
      ...(['drop', 'tight', 'bare'].includes(fits['Full lead']) ? [] : [['lead-status-testing', 'Check run,Full lead']]), ['family-summary-open', 'Build step,Check run,Full lead,Pick copy']];
    for (const [id, want] of presses) {
      const sel = fam('Full lead') + ' ' + byId(id);
      // A family line part reaches the gap over it and half the gap under it (25px, as "Sub-cards N" and "not done N"), 32px wide.
      if (mobile) { const pb = await box(p, sel); check(scene, id + ': a finger-sized press', pb && pb.width >= 32 && pb.height >= 24, JSON.stringify(pb)); }
      await hit(sel);
      // A phone moves to the tab of the cards it rings (research/166 J2): those there are of the part's, the lead too where it is.
      const got = await lit();
      check(scene, id + ': rings ' + want, mobile ? !!got && got.split(',').every(t => want.split(',').includes(t)) : got === want, got);
      if (mobile) { tab = ''; await go('Full lead'); }
      check(scene, id + ': says it is on', await p.locator(sel).first().getAttribute('aria-pressed') === 'true');
    }
    await hit(fam('Full lead') + ' ' + byId('family-summary-open'));
    check(scene, 'the same part again ends it', (await lit()) === '', await lit());
    check(scene, 'no detail opened', (await p.locator(byId('detail-backdrop') + ',' + byId('editor-sheet')).count()) === 0);
    // The lead's own waits still press from the row: the question (D43) and the error.
    await go('Ask lead');
    check(scene, 'Ask lead: its "Needs your answer" mark is the press', (await p.locator(row('Ask lead') + ' ' + byId('lead-status-awaiting')).count()) === 1);
    await go('Broken lead');
    check(scene, 'Broken lead: its "Error" opens its chat', (await p.locator(row('Broken lead') + ' ' + byId('lead-status-me-open')).count()) === 1);
    if (!mobile) check(scene, 'Full lead: a part\'s screen-reader words are whole whatever the fit', (await p.locator(fam('Full lead') + ' ' + byId('lead-status-running')).first().getAttribute('aria-label'))
      === m.statusLabel(m.statusRunning(1), 'Full lead'));
    await go('Full lead'); await away(p);
    await p.screenshot({ path: path.join(out, `${scene}.png`), fullPage: false });
    if (mobile) { await go('Look lead'); await p.screenshot({ path: path.join(out, `${scene}-review.png`) }); }
    // ---- D51: the tips of the glyphs at the right end of a lane and the To Do "+" ----
    if (!mobile) {
      const tipBox = () => box(p, byId('icon-tooltip'));
      const toggle = byId('swimlane-lane-section') + ':has(' + label('Full lead') + ') ' + byId('lane-toggle');
      const inside = (tb, left, right) => !!tb && tb.x >= left + 8 - 1 && tb.x + tb.width <= right - 8 + 1;
      await away(p); await moveTo(p, toggle); await p.waitForTimeout(150);
      let tb = await tipBox(), gb = await box(p, toggle);
      check(scene, 'D51 the lane\'s "5 more" tip: inside the window', inside(tb, 0, 1920) && tb.y >= gb.y + gb.height - 1, JSON.stringify({ tb, gb }));
      const clippedTip = () => p.locator(byId('icon-tooltip') + ' div[dir="auto"]').evaluateAll(els => els.some(e => e.scrollWidth > e.clientWidth + 1));
      check(scene, 'D51 the lane\'s "5 more" tip: its words whole on one line, none cut off', !!tb && tb.height <= 23 && !(await clippedTip())
        && (await words(byId('icon-tooltip'))) === m.moreInLane(4), await words(byId('icon-tooltip')).catch(() => '') + JSON.stringify(tb));
      await p.screenshot({ path: path.join(out, `${scene}-d51-right.png`), clip: { x: 1100, y: 0, width: 820, height: 400 } });
      // A host panel on the right: the plugin's pane 1180px wide, just room for the board, so the glyph sits at the pane's right end.
      const restyle = css => p.evaluate(text => { document.getElementById('d51')?.remove(); if (!text) return;
        const el = document.createElement('style'); el.id = 'd51'; el.textContent = text; document.head.appendChild(el); }, css);
      await away(p); await restyle('#root{width:1180px;overflow:hidden}'); await p.waitForTimeout(400);
      await moveTo(p, toggle); await p.waitForTimeout(150);
      tb = await tipBox(); gb = await box(p, toggle);
      const pane = await box(p, '#root');
      check(scene, 'D51 setup: the glyph in the narrower pane', !!gb && gb.x + gb.width <= pane.x + pane.width + 0.5 && gb.x + gb.width > pane.x + pane.width - 90, JSON.stringify({ gb, pane }));
      check(scene, 'D51 a host panel on the right: the tip inside the pane, not just the window', inside(tb, pane.x, pane.x + pane.width) && !(await clippedTip()), JSON.stringify({ tb, pane }));
      await p.screenshot({ path: path.join(out, `${scene}-d51-panel.png`), clip: { x: 500, y: 0, width: 1020, height: 400 } });
      // A long tip (the second workspace's "+", its long folder name): 320px at most, wrapped, inside.
      await away(p); await restyle(''); await p.waitForTimeout(400);
      const plus = byId('swimlane-lane-section') + ':has(' + label('Long one') + ') ' + byId('todo-create');
      await moveTo(p, plus); await p.waitForTimeout(150);
      tb = await tipBox();
      check(scene, 'D51 a tip longer than 320px wraps at 320 and stays inside', !!tb && tb.width <= 321 && tb.width >= 300 && tb.height >= 30 && inside(tb, 0, 1920), JSON.stringify(tb));
      check(scene, 'D51 the long tip says it all', (await words(byId('icon-tooltip'))) === m.newDraftIn(R5_LONG), await words(byId('icon-tooltip')).catch(() => ''));
      await p.screenshot({ path: path.join(out, `${scene}-d51-wrap.png`), clip: { x: 0, y: 0, width: 900, height: 700 } });
      // A host panel on the left over the pane's first 600px (the pane shifted under it): the To Do "+" tip keeps right of it.
      const first = byId('swimlane-lane-section') + ':has(' + label('Full lead') + ') ' + byId('todo-create');
      // The pane's content is moved left under the panel (a transform: its layout stays) until its "+" sits 20px right of the panel's edge.
      await away(p); await restyle('body{padding-left:300px;box-sizing:border-box}#root{overflow:hidden}'); await p.waitForTimeout(400);
      const shift = (await box(p, first)).x - 320;
      await restyle('body{padding-left:300px;box-sizing:border-box}#root{overflow:hidden}#root>*{transform:translateX(' + (-shift) + 'px)}'); await p.waitForTimeout(400);
      await moveTo(p, first); await p.waitForTimeout(150);
      tb = await tipBox(); gb = await box(p, first);
      const left = await box(p, '#root');
      check(scene, 'D51 setup: the "+" near the pane\'s left edge', !!gb && gb.x > left.x && gb.x < left.x + 40, JSON.stringify({ gb, left }));
      check(scene, 'D51 a host panel on the left: the tip right of it, inside the pane', inside(tb, left.x, left.x + left.width) && !(await clippedTip()), JSON.stringify({ tb, left }));
      await p.screenshot({ path: path.join(out, `${scene}-d51-left.png`), clip: { x: 0, y: 0, width: 900, height: 400 } });
      await away(p); await restyle(''); await p.waitForTimeout(300);
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    check(scene, 'nothing written to the ledger or settings', (await p.evaluate(() => window.__writes.length)) === 0
      && (await p.evaluate(() => window.__calls.filter(n => /mutate|ensure/.test(n)).length)) === 0);
    await p.context().close();
  }
  }
  // ---- REQ-136 (research/277): the English screen fixes, each at 1920 and 390 × light and dark — H2 a held request's words
  // without Korean, H3 the lead's resting time in the device's zone (New York for English, Seoul for Korean), H4 the detail's
  // history by the board's stage names in both languages, H5 the wide detail's stage flow with "Done" in sight, H6 the phone's
  // In progress tab whole. Made-up fixtures only; nothing is written. ----
  if (ONLY === '' || R136) {
  const HANGUL = /[가-힣ㄱ-ㆎ]/;
  for (const width of [1920, 390]) for (const mode of ['light', 'dark']) for (const locale of ['en', 'ko']) {
    const mobile = width === 390, m = copy(locale), zone = locale === 'en' ? 'America/New_York' : 'Asia/Seoul';
    const ctxOpts = { ...(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1920, height: 1080 } }), timezoneId: zone };
    const tap = async (p, sel) => { if (mobile) { await p.locator(sel).first().tap(); await p.waitForTimeout(400); } else await clickAt(p, sel); };
    const textOf = (p, sel) => p.locator(sel).first().evaluate(el => { const copy = el.cloneNode(true); copy.querySelectorAll('[data-icon]').forEach(n => n.remove());
      return copy.innerText.replace(/\s+/g, ' ').trim(); });
    // H3: the resting lead's "since" in the device's zone (req135's fixture), not Korea's whatever the device.
    {
      const scene = `req136-h3-${width}-${locale}-${mode}`;
      const p = await (await browser.newContext(ctxOpts)).newPage();
      const errors = []; p.on('pageerror', e => errors.push(String(e)));
      await p.clock.install({ time: Date.now() });
      await p.goto(page(mode, mobile, `req135-${locale}`));
      if (mobile) { await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 }); await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400); }
      const row = '[aria-label="Quiet lead"] ' + byId('lead-status');
      await p.waitForSelector(row, { timeout: 15000 }); await p.waitForTimeout(300);
      const said = await textOf(p, row), at = R5_NOW - 48 * 60000, want = m.leadSelfRest(zoneClock(zone, at, R5_NOW)), kst = m.leadSelfRest(zoneClock('Asia/Seoul', at, R5_NOW));
      check(scene, 'the resting time is the device\'s (' + zone + ')', said === want, said + ' / want ' + want);
      if (locale === 'en') check(scene, 'not Korea\'s clock on a device elsewhere', said !== kst, said + ' / KST ' + kst);
      else check(scene, 'a device in Korea reads as before (KST)', said === kst, said);
      check(scene, 'the browser runs in ' + zone, await p.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) === zone);
      await p.screenshot({ path: path.join(out, `${scene}.png`) });
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      await p.context().close();
    }
    // H4·H5·H6: the boards above, "Card one" in Review.
    {
      const scene = `req136-detail-${width}-${locale}-${mode}`;
      const p = await (await browser.newContext(ctxOpts)).newPage();
      const errors = []; p.on('pageerror', e => errors.push(String(e)));
      await p.goto(page(mode, mobile, `req136-${locale}`));
      const names = Object.fromEntries(['todo', 'doing', 'review', 'done'].map((id, i) => [id, [m.waitingStage, m.doingStage, m.reviewStage, m.doneStage][i]]));
      if (mobile) {
        // H6: the In progress tab's face says its short name whole; its spoken name stays whole; no tab's words are cut.
        await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 }); await p.waitForTimeout(300);
        const tabs = await p.locator('[data-testid^="mobile-tab-"]').evaluateAll(els => els.filter(e => !/face/.test(e.dataset.testid)).map(e => {
          const words = e.querySelector('div[dir="auto"]'); return { id: e.dataset.testid, label: e.getAttribute('aria-label'), text: words?.textContent ?? '',
            cut: !!words && words.scrollWidth > words.clientWidth + 1 }; }));
        const doing = tabs.find(t => t.id === 'mobile-tab-doing');
        check(scene, 'H6 the In progress tab says "' + m.doingStageTab + '"', doing?.text === m.doingStageTab, JSON.stringify(doing));
        check(scene, 'H6 its spoken name is the whole stage name', !!doing && doing.label.startsWith(m.doingStage + ' '), JSON.stringify(doing));
        check(scene, 'H6 no stage tab cut', tabs.length === 4 && tabs.every(t => !t.cut), JSON.stringify(tabs));
        await p.screenshot({ path: path.join(out, `${scene}-tabs.png`) });
        await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400);
        await p.locator('[aria-label="Card one"] ' + byId('card-title')).first().tap(); await p.waitForTimeout(600);
      } else {
        await p.waitForSelector('[aria-label="Card one"]', { timeout: 15000 });
        await clickAt(p, '[aria-label="Card one"]');
      }
      await p.waitForSelector(byId('detail-stage'), { timeout: 8000 });
      // H4: the history by the board's stage names, never their ids.
      const history = await p.getByText(m.history, { exact: true }).first().evaluate(el => el.parentElement.innerText);
      const lines = history.split('\n').slice(1);
      check(scene, 'H4 created into ' + names.doing + ', then ' + names.doing + ' → ' + names.review,
        lines.some(l => l.endsWith(' · — → ' + names.doing)) && lines.some(l => l.endsWith(' · ' + names.doing + ' → ' + names.review)), JSON.stringify(lines));
      check(scene, 'H4 no stage id shown', !lines.some(l => / → (todo|doing|review|done)$|· (todo|doing|review|done) →/.test(l)), JSON.stringify(lines));
      if (locale === 'en') check(scene, 'H4 no Korean in the English history', !HANGUL.test(history), history);
      if (!mobile) {
        // H5: the side panel's flow — four stages inside the 280px panel, none cut, no chevron hiding one; current and ✓ kept.
        const panel = await box(p, byId('detail-panel'));
        const pills = await Promise.all(['todo', 'doing', 'review', 'done'].map(async id => ({ id, b: await box(p, byId('stage-bar-' + id)),
          cut: await p.locator(byId('stage-bar-' + id) + ' div[dir="auto"]').first().evaluate(e => e.scrollWidth > e.clientWidth + 1),
          checked: await p.locator(byId('stage-bar-' + id)).first().getAttribute('aria-checked') })));
        check(scene, 'H5 every stage inside the panel', !!panel && pills.every(v => v.b && v.b.x >= panel.x && v.b.x + v.b.width <= panel.x + panel.width + .5), JSON.stringify({ panel, pills }));
        check(scene, 'H5 "' + names.done + '" in sight and whole', pills.find(v => v.id === 'done')?.b?.width > 20 && !pills.find(v => v.id === 'done').cut, JSON.stringify(pills.at(-1)));
        check(scene, 'H5 no stage name cut', pills.every(v => !v.cut), JSON.stringify(pills));
        check(scene, 'H5 no chevron over the flow', (await p.locator(byId('stage-bar-more-end')).count()) === 0 && (await p.locator(byId('stage-bar-more-start')).count()) === 0);
        check(scene, 'H5 the current stage is still the checked one', pills.filter(v => v.checked === 'true').map(v => v.id).join() === 'review', JSON.stringify(pills.map(v => v.checked)));
        check(scene, 'H5 the stages before it keep their ✓', await p.locator(byId('stage-bar-todo') + ' [data-icon="Check"],' + byId('stage-bar-doing') + ' [data-icon="Check"]').count() === 2);
        const rows = [...new Set(pills.map(v => Math.round(v.b.y)))].length;
        check(scene, 'H5 at most two lines (' + rows + ')', rows <= 2, JSON.stringify(pills.map(v => v.b.y)));
        const shot = { x: panel.x - 8, y: panel.y - 8, width: panel.width + 16, height: 220 };
        await p.screenshot({ path: path.join(out, `${scene}-stagebar.png`), clip: shot });
      }
      await p.screenshot({ path: path.join(out, `${scene}.png`) });
      check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      await p.context().close();
    }
    // F2 (research/278): the draft rule names the stage that really sends the draft — "In progress" on the built-in template,
    // "Build" on a user template — in the card's detail and in the quick-move menu, whole (wrapped, not cut, inside the window).
    if (locale === 'en') for (const kind of ['basic', 'build']) {
      const scene = `req136-f2-${kind}-${width}-${mode}`, want = kind === 'build' ? 'Build' : 'In progress', first = kind === 'build' ? 'waiting' : 'todo', sending = kind === 'build' ? 'build' : 'doing';
      const context = await browser.newContext(ctxOpts), p = await context.newPage();
      const errors = []; p.on('pageerror', e => errors.push(String(e)));
      await p.goto(page(mode, mobile, `req136f2-${kind}`));
      // A board of a user template is listed under "Other templates" by its workspace's name; opening it shows its stages.
      const openOther = async () => {
        if (kind === 'build') { const open = p.getByText('Example Workspace', { exact: true }).first(); await open.waitFor({ timeout: 15000 }).catch(() => {});
          if (mobile) await open.tap(); else await open.click(); await p.waitForTimeout(500); }
        await p.waitForSelector('[aria-label="' + F2_DRAFT + '"]', { timeout: 15000 }).catch(() => {});
      };
      const notice = async () => {
        const n = p.getByText(/^Drafts stay in the first stage/).first();
        await n.waitFor({ timeout: 5000 }).catch(() => {});
        if (!(await n.count())) return { text: '', cut: true, inside: false, lines: 0 };
        return n.evaluate(el => { const b = el.getBoundingClientRect(), line = parseFloat(getComputedStyle(el).lineHeight) || 16;
          return { text: el.innerText.replace(/\s+/g, ' ').trim(), cut: el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).overflow === 'hidden' && el.scrollHeight > el.clientHeight + 1,
            inside: b.left >= -.5 && b.right <= window.innerWidth + .5, lines: Math.round(b.height / line) }; });
      };
      await openOther();
      if (mobile) {
        await p.waitForSelector(byId('mobile-tab-' + first), { timeout: 15000 }); await p.locator(byId('mobile-tab-' + first)).first().tap(); await p.waitForTimeout(400);
        await p.locator('[aria-label="' + F2_DRAFT + '"] ' + byId('card-title')).first().tap(); await p.waitForTimeout(600);
      } else await clickAt(p, '[aria-label="' + F2_DRAFT + '"]');
      await p.waitForSelector(byId('detail-stage'), { timeout: 8000 });
      const detail = await notice(), shown = (await p.locator(byId('stage-bar-' + sending)).first().innerText()).replace(/\s+/g, ' ').trim();
      check(scene, 'F2 the stage flow shows "' + want + '" as the sending stage', shown.includes(want), shown);
      check(scene, 'F2 the detail\'s rule says "' + want + '", the stage on screen', detail.text === m.draftRule(want), detail.text);
      check(scene, 'F2 the detail\'s rule is whole, inside the window', !detail.cut && detail.inside && detail.lines >= 1, JSON.stringify(detail));
      if (kind === 'build') check(scene, 'F2 no "In progress" the board does not have', !/In progress/.test(detail.text), detail.text);
      await p.screenshot({ path: path.join(out, `${scene}-detail.png`) });
      await p.goto(page(mode, mobile, `req136f2-${kind}`));
      await openOther();
      if (mobile) {
        await p.locator(byId('mobile-tab-' + first)).first().tap(); await p.waitForTimeout(500);
        const b = await box(p, '[aria-label="' + F2_DRAFT + '"]'), cdp = await p.context().newCDPSession(p), [x, y] = center(b).map(Math.round);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await p.waitForTimeout(900);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await p.waitForTimeout(400);
      } else {
        await moveTo(p, '[aria-label="' + F2_DRAFT + '"]');
        await clickAt(p, '[aria-label="' + m.moveCard + ': ' + F2_DRAFT + '"]');
      }
      await p.waitForSelector(byId('move-to-' + sending), { timeout: 5000 }).catch(() => {});
      const menu = await notice();
      check(scene, 'F2 the quick-move menu\'s rule says "' + want + '"', menu.text === m.draftRule(want), menu.text);
      check(scene, 'F2 the menu\'s rule is whole, inside the window', !menu.cut && menu.inside && menu.lines >= 1, JSON.stringify(menu));
      await p.screenshot({ path: path.join(out, `${scene}-menu.png`) });
      check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      await context.close();
    }
    // H2: the held sheet's words in English carry no Korean (the lead's prefix is named, not quoted).
    if (locale === 'en') {
      const scene = `req136-h2-${width}-${mode}`;
      const context = await browser.newContext(ctxOpts), p = await context.newPage();
      const errors = []; p.on('pageerror', e => errors.push(String(e)));
      await p.goto(page(mode, mobile, 'dispatchheld-en'));
      await p.waitForSelector('[data-testid^="kanban-card-"]', { timeout: 15000 }); await p.waitForTimeout(600);
      if (mobile) {
        await p.locator(byId('mobile-tab-todo')).first().tap(); await p.waitForTimeout(500);
        const b = await box(p, '[aria-label="' + HD.draft + '"]'), cdp = await p.context().newCDPSession(p), [x, y] = center(b).map(Math.round);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await p.waitForTimeout(900);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await p.waitForTimeout(400);
        await p.locator(byId('move-to-doing')).first().tap(); await p.waitForTimeout(600);
      } else {
        await moveTo(p, '[aria-label="' + HD.draft + '"]');
        await clickAt(p, '[aria-label="' + m.moveCard + ': ' + HD.draft + '"]');
        await p.waitForSelector(byId('move-to-doing'), { timeout: 5000 }).catch(() => {});
        await clickAt(p, byId('move-to-doing')); await p.waitForTimeout(600);
      }
      await p.waitForSelector(byId('dispatch-when'), { timeout: 5000 }).catch(() => {});
      const when = (await p.locator(byId('dispatch-when')).count()) ? await p.locator(byId('dispatch-when')).first().innerText() : '';
      check(scene, 'H2 the held words are the new English ones', when.trim() === m.dispatchHeld('settings'), when);
      // REQ-137: the real prefixes are quoted, "Lead-…" (or "총괄-…") — that quoted Korean prefix is the only Korean allowed.
      const bare = text => text.replaceAll('"총괄-…"', '');
      check(scene, 'H2 no Korean in them but the quoted prefix ("Lead-…" (or "총괄-…"))', !!when && !HANGUL.test(bare(when)) && when.includes('"Lead-…" (or "총괄-…")'), when);
      const sheetText = (await p.locator(byId('dispatch-sheet')).count()) ? await p.locator(byId('dispatch-sheet')).first().innerText() : '';
      check(scene, 'H2 no Korean anywhere on the sheet but the quoted prefix', !!sheetText && !HANGUL.test(bare(sheetText)), sheetText);
      await p.screenshot({ path: path.join(out, `${scene}.png`) });
      check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }
  }
  // ---- REQ-137 (research/273 B, research/280): the card ⋯ "Mark as lead" (the wide dropdown and the phone's sheet), the crown it
  // gives a plain chat's card ("set by you"), an English "Lead-…" name's crown, and the settings' read-only "Leads by workspace".
  // 1920 and 390, light and dark, en and ko. Made-up names only. ----
  if (ONLY === '' || R137) {
  for (const width of [1920, 390]) for (const mode of ['light', 'dark']) for (const locale of ['en', 'ko']) {
    const mobile = width === 390, m = copy(locale), scene = `req137-${width}-${locale}-${mode}`, height = mobile ? 844 : 1080;
    const p = await (await browser.newContext(mobile ? { viewport: { width, height }, hasTouch: true, isMobile: true } : { viewport: { width, height } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, mobile, 'req137-' + locale));
    const cardOf = title => `[data-testid^="kanban-card-"][aria-label="${title}"]`;
    const press = sel => mobile ? p.locator(sel).first().tap().then(() => p.waitForTimeout(400)) : clickAt(p, sel);
    if (mobile) {
      await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 });
      for (let i = 0; i < await p.locator(byId('mobile-tab-doing')).count(); i++) { await p.locator(byId('mobile-tab-doing')).nth(i).tap(); await p.waitForTimeout(300); }
    }
    await p.waitForSelector(cardOf(RL_T.mark), { timeout: 15000 }); await p.waitForTimeout(500);
    check(scene, 'before: a plain chat\'s card has no crown', (await p.locator(cardOf(RL_T.mark) + ' ' + byId('card-leader')).count()) === 0);
    check(scene, 'an English "Lead-…" name is a lead from the start (crown)', (await p.locator(cardOf(RL_T.named) + ' ' + byId('card-leader')).count()) === 1);
    const openMenu = async () => {
      if (mobile) await longPress(p, cardOf(RL_T.mark));
      else { await moveTo(p, cardOf(RL_T.mark)); await clickAt(p, `[aria-label="${m.moveCard}: ${RL_T.mark}"]`); }
      await p.waitForSelector(byId('card-menu-lead'), { timeout: 5000 }).catch(() => {});
    };
    await openMenu();
    const row = await box(p, byId('card-menu-mark-lead')), help = await box(p, byId('card-menu-lead-help'));
    check(scene, 'the menu offers "' + m.markLead + '"', !!row && (await p.locator(byId('card-menu-mark-lead')).first().getAttribute('aria-label')) === m.markLead);
    const helpText = help ? await p.locator(byId('card-menu-lead-help')).first().innerText() : '';
    check(scene, 'its line says where drafts go', helpText.trim() === m.markLeadHelp('wks_example01'), helpText);
    check(scene, 'row and line inside the screen', !!row && !!help && row.x >= 0 && help.x + help.width <= width + 0.5 && help.y + help.height <= height + 0.5, JSON.stringify({ row, help }));
    if (!mobile) {
      const menu = await box(p, byId('card-menu'));
      check(scene, 'the line inside the menu\'s outline (nothing hangs below it)', !!menu && !!help && help.y + help.height <= menu.y + menu.height + 0.5
        && help.x >= menu.x - 0.5 && help.x + help.width <= menu.x + menu.width + 0.5, JSON.stringify({ menu, help }));
    }
    const cut = await p.locator(byId('card-menu-lead-help')).first().evaluate(e => e.scrollWidth > e.clientWidth + 1);
    check(scene, 'the line is whole (wraps, never cut)', !cut);
    if (locale === 'en') check(scene, 'no Korean in the English row', !/[가-힣]/.test(helpText + m.markLead));
    await p.screenshot({ path: path.join(out, `${scene}-menu.png`) });
    await press(byId('card-menu-mark-lead'));
    await p.waitForTimeout(900);
    const sent = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.auto_cards.lead.set').map(v => v.input));
    check(scene, 'one save, lead: true, of that card', sent.length === 1 && sent[0].lead === true && sent[0].boardId === 'board_' + 'e'.repeat(64), JSON.stringify(sent));
    const toast = (await p.locator(byId('move-toast-text')).count()) ? await p.locator(byId('move-toast-text')).first().innerText() : '';
    check(scene, 'the notice says so', toast.trim() === m.leadMarked('wks_example01'), toast);
    await p.waitForSelector(cardOf(RL_T.mark) + ' ' + byId('card-leader'), { timeout: 8000 }).catch(() => {});
    const crown = (await p.locator(cardOf(RL_T.mark) + ' ' + byId('card-leader')).count()) ? await p.locator(cardOf(RL_T.mark) + ' ' + byId('card-leader')).first().getAttribute('aria-label') : '';
    check(scene, 'after: the marked card has a crown, spoken "' + m.leadSetByYou + '"', crown === m.leadCard + ' · ' + m.leadSetByYou, crown);
    check(scene, 'and the lead\'s own status row (REQ-130)', (await p.locator(cardOf(RL_T.mark) + ' ' + byId('lead-status')).count()) >= 1);
    check(scene, 'the other plain card stays plain', (await p.locator(cardOf(RL_T.plain) + ' ' + byId('card-leader')).count()) === 0);
    await p.screenshot({ path: path.join(out, `${scene}-marked.png`) });
    await openMenu();
    check(scene, 'the same menu now offers "' + m.unmarkLead + '"', await visible(p, byId('card-menu-unmark-lead')));
    check(scene, 'with its line', ((await p.locator(byId('card-menu-lead-help')).first().innerText()) || '').trim() === m.unmarkLeadHelp);
    await p.keyboard.press('Escape'); await p.waitForTimeout(500);
    if (await visible(p, byId('card-menu-lead'))) { await p.keyboard.press('Escape'); await p.waitForTimeout(500); }
    // The settings: Automation lists who leads each workspace, read only.
    await press(byId('open-settings'));
    const tab = mobile ? 'settings-open-automation' : 'settings-tab-automation';
    await p.waitForSelector(byId(tab), { timeout: 5000 }).catch(() => {});
    await press(byId(tab));
    await p.waitForSelector(byId('setting-lead-status'), { timeout: 5000 }).catch(() => {});
    await p.locator(byId('setting-lead-status')).first().scrollIntoViewIfNeeded().catch(() => {}); await p.waitForTimeout(300);
    const lines = await p.locator(byId('lead-status-list') + ' [data-testid^="lead-status-text-"]').allInnerTexts();
    check(scene, 'one line per workspace: set by you, and by name', lines.length === 2 && lines.some(t => t.trim() === m.leadStatusSet(RL_T.mark))
      && lines.some(t => t.trim() === m.leadStatusName('Lead-04')), JSON.stringify(lines));
    const rows = await p.locator(byId('lead-status-list') + ' [data-testid^="lead-status-"]:not([data-testid^="lead-status-text-"])').evaluateAll(els =>
      els.map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, cut: [...e.querySelectorAll('div')].some(d => d.scrollWidth > d.clientWidth + 1 && getComputedStyle(d).overflow === 'hidden') }; }));
    check(scene, 'the lines inside the window', rows.length === 2 && rows.every(r => r.left >= 0 && r.right <= width + 0.5), JSON.stringify(rows));
    const names = await p.locator(byId('lead-status-list') + ' [data-testid^="lead-status-"]:not([data-testid^="lead-status-text-"]) > div:first-child').evaluateAll(els =>
      els.map(e => ({ text: e.innerText, cut: e.scrollWidth > e.clientWidth + 1 })));
    check(scene, 'the workspace names whole', names.length === 2 && names.every(n => !n.cut && !n.text.includes('…')) && names[0].text.includes('Example Workspace'), JSON.stringify(names));
    check(scene, 'read only: no switch in the lead lines', (await p.locator(byId('lead-status-list') + ' [role="switch"]').count()) === 0);
    const helpLine = await p.locator(byId('setting-lead-status')).first().innerText();
    check(scene, 'it says how to change it', helpLine.includes(m.leadStatusHelp), helpLine);
    await p.screenshot({ path: path.join(out, `${scene}-settings.png`) });
    check(scene, 'no settings written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- research/281 F1·F2 (the gate on v0.1.53): the settings name the lead the server judged (the chats' own order, not their
  // cards'), and a request sent to the marked chat keeps saying "Sent" — on the card and in its detail — after the mark moves or is
  // taken off; a request that really went to the newest chat still says "the latest agent". 1920 and 390, light and dark, en and ko. ----
  if (ONLY === '' || R137) {
  for (const width of [1920, 390]) for (const mode of ['light', 'dark']) for (const locale of ['en', 'ko']) {
    const mobile = width === 390, m = copy(locale), height = mobile ? 844 : 1080, latest = m.dispatchSentFallback('').slice(m.dispatchSent('').trim().length);
    const cardOf = title => `[data-testid^="kanban-card-"][aria-label="${title}"]`;
    const open = async variant => {
      const p = await (await browser.newContext(mobile ? { viewport: { width, height }, hasTouch: true, isMobile: true } : { viewport: { width, height } })).newPage();
      const errors = []; p.on('pageerror', e => errors.push(String(e)));
      await p.goto(page(mode, mobile, 'req137-' + variant + '-' + locale));
      if (mobile) {
        await p.waitForSelector(byId('mobile-tab-doing'), { timeout: 15000 });
        for (let i = 0; i < await p.locator(byId('mobile-tab-doing')).count(); i++) { await p.locator(byId('mobile-tab-doing')).nth(i).tap(); await p.waitForTimeout(300); }
      }
      await p.waitForSelector(cardOf(RL_T.named), { timeout: 15000 }); await p.waitForTimeout(500);
      return { p, errors, press: sel => mobile ? p.locator(sel).first().tap().then(() => p.waitForTimeout(400)) : clickAt(p, sel) };
    };
    // F1: the first workspace's chats "Lead-01" (older chat, newer card) and "Lead-02" (newer chat, older card).
    {
      const scene = `req137-281-order-${width}-${locale}-${mode}`, { p, errors, press } = await open('order');
      await press(byId('open-settings'));
      const tab = mobile ? 'settings-open-automation' : 'settings-tab-automation';
      await p.waitForSelector(byId(tab), { timeout: 5000 }).catch(() => {}); await press(byId(tab));
      await p.waitForSelector(byId('setting-lead-status'), { timeout: 5000 }).catch(() => {});
      await p.locator(byId('setting-lead-status')).first().scrollIntoViewIfNeeded().catch(() => {}); await p.waitForTimeout(300);
      const lines = (await p.locator(byId('lead-status-list') + ' [data-testid^="lead-status-text-"]').allInnerTexts()).map(t => t.trim());
      check(scene, 'F1 the settings name the server\'s lead (the newer chat "Lead-02"), never the newer card\'s', lines.includes(m.leadStatusName('Lead-02'))
        && !lines.includes(m.leadStatusName('Lead-01')), JSON.stringify(lines));
      await p.screenshot({ path: path.join(out, `${scene}.png`) });
      check(scene, 'no settings written', (await p.evaluate(() => window.__writes.length)) === 0);
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      await p.context().close();
    }
    // F1: a mark kept on another board's chat — no "set by you" crown, and the settings say so in a whole line.
    {
      const scene = `req137-281-unusable-${width}-${locale}-${mode}`, { p, errors, press } = await open('unusable');
      check(scene, 'F1 no "set by you" crown on a mark the server cannot send to', (await p.locator(cardOf(RL_T.mark) + ' ' + byId('card-leader')).count()) === 0);
      await press(byId('open-settings'));
      const tab = mobile ? 'settings-open-automation' : 'settings-tab-automation';
      await p.waitForSelector(byId(tab), { timeout: 5000 }).catch(() => {}); await press(byId(tab));
      await p.waitForSelector(byId('setting-lead-status'), { timeout: 5000 }).catch(() => {});
      await p.locator(byId('setting-lead-status')).first().scrollIntoViewIfNeeded().catch(() => {}); await p.waitForTimeout(300);
      const lines = (await p.locator(byId('lead-status-list') + ' [data-testid^="lead-status-text-"]').allInnerTexts()).map(t => t.trim());
      check(scene, 'F1 the settings: set by you, but not in effect', lines.includes(m.leadStatusSetUnusable(RL_T.mark)), JSON.stringify(lines));
      const texts = await p.locator(byId('lead-status-list') + ' [data-testid^="lead-status-text-"]').evaluateAll(els =>
        els.map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, cut: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 }; }));
      check(scene, 'the long line wraps inside the window, never cut', texts.length === 2 && texts.every(r => !r.cut && r.left >= 0 && r.right <= width + 0.5), JSON.stringify(texts));
      if (locale === 'en') check(scene, 'no Korean in the English line', !/[가-힣]/.test(lines.join(' ')));
      await p.screenshot({ path: path.join(out, `${scene}.png`) });
      check(scene, 'no settings written', (await p.evaluate(() => window.__writes.length)) === 0);
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      await p.context().close();
    }
    // F2: "History request", sent to the older plain chat while it was marked; then the mark as it is now.
    for (const step of ['as', 'moved', 'cleared', 'never']) {
      const scene = `req137-281-sent-${step}-${width}-${locale}-${mode}`, { p, errors } = await open('sent-' + step);
      const face = cardOf(RL_HISTORY) + ' ' + byId('card-dispatch-sent');
      await p.waitForSelector(face, { timeout: 8000 }).catch(() => {});
      const chip = (await p.locator(face).count()) ? (await p.locator(face).first().innerText()).trim() : '';
      const said = step === 'never';
      check(scene, `F2 the card's line says "${m.dispatchSent('').trim()}"` + (said ? ' and the latest agent (a real fallback)' : ', never the latest agent'),
        chip.startsWith(m.dispatchSent('').trim()) && chip.endsWith(latest) === said, chip);
      const crown = async title => (await p.locator(cardOf(title) + ' ' + byId('card-leader')).count())
        ? await p.locator(cardOf(title) + ' ' + byId('card-leader')).first().getAttribute('aria-label') : '';
      const setBy = m.leadCard + ' · ' + m.leadSetByYou;
      check(scene, 'the "set by you" crown follows the mark as it is', (await crown(RL_T.mark) === setBy) === (step === 'as') && (await crown(RL_T.plain) === setBy) === (step === 'moved'),
        JSON.stringify([await crown(RL_T.mark), await crown(RL_T.plain)]));
      await p.screenshot({ path: path.join(out, `${scene}.png`) });
      // The detail: the same words.
      if (mobile) await p.locator(cardOf(RL_HISTORY)).first().tap(); else await clickAt(p, cardOf(RL_HISTORY));
      await p.waitForSelector(byId('detail-dispatch'), { timeout: 8000 }).catch(() => {});
      const detail = (await p.locator(byId('detail-dispatch')).count()) ? (await p.locator(byId('detail-dispatch')).first().innerText()).trim() : '';
      check(scene, 'F2 the detail says the same', !!detail && detail.startsWith(m.dispatchRequest + ' · ' + m.dispatchSent('').trim()) && detail.endsWith(latest) === said, detail);
      await p.screenshot({ path: path.join(out, `${scene}-detail.png`) });
      check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      await p.context().close();
    }
  }
  }
  // ---- REQ-134 (research/267 WA·MA, the owner's choices): the phone's workflow sheet from a lane's ⋯ (a ladder top to bottom, a
  // table of marks, a cell's evidence in a sheet) and the lab's message list from the top bar (the wide count, a sheet per filter,
  // the title search, a thread in place of the list, the lane badge opening it filtered). 390, ko and en, light and dark; the
  // lab off or without a folder: no glyph; the wide order popover keeps no "Show workflow". Made-up fixtures only. ----
  if (ONLY === '' || R134) {
  const tx = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const txs = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const tap = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
  const rowIds = p => p.locator(byId('mailbox-sheet') + ' [data-testid^="mailbox-row-"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(12)));
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  for (const locale of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req134-wa-390-${locale}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(locale);
    const p = await (await browser.newContext(phone)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'wf-gate-' + locale));
    const lane = id => byId('mobile-workspace-' + id);
    await p.waitForSelector(lane(a.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
    check(scene, 'nothing read before it is asked', !(await p.evaluate(() => window.__calls)).includes('kanban.v1.workflow.get'));
    check(scene, 'no glyph added to the lane heading', (await p.locator(byId('lane-view-switch') + ',' + byId('lane-view-workflow')).count()) === 0);
    // The lane without a definition: its ⋯ has no "Show workflow".
    await tap(p, lane(b.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('menu-sheet'), { timeout: 5000 });
    check(scene, 'no definition: no "Show workflow" in its ⋯', (await p.locator(byId('order-workflow')).count()) === 0 && await visible(p, byId('order-open-board')));
    await tap(p, byId('menu-sheet') + ' ' + byId('sheet-close')); await p.waitForTimeout(300);
    // The lane with one: "Show workflow" right under "Open board".
    await tap(p, lane(a.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('order-workflow'), { timeout: 5000 });
    const rows = await p.locator(byId('menu-sheet') + ' [data-testid^="order-"]').evaluateAll(els => els.map(e => e.dataset.testid));
    check(scene, 'a definition: "Show workflow" in its ⋯, after "Open board"', rows.indexOf('order-workflow') === rows.indexOf('order-open-board') + 1
      && await tx(p, byId('order-workflow')) === m.workflowShow, rows.join());
    if (locale === 'ko' && mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-menu.png`) });
    await tap(p, byId('order-workflow'));
    await p.waitForSelector(byId('mobile-workflow-ladder'), { timeout: 8000 }).catch(() => {});
    const sheet = await box(p, byId('workflow-sheet'));
    check(scene, 'a sheet over (nearly) the whole screen, inside it', sheet && sheet.x >= -.5 && sheet.x + sheet.width <= 390.5 && sheet.height >= 844 * .85, JSON.stringify(sheet));
    check(scene, 'its title names the workspace', (await tx(p, byId('workflow-sheet') + ' [role="heading"]')).startsWith(m.workflowSheet('')), await tx(p, byId('workflow-sheet') + ' [role="heading"]'));
    const asked = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.workflow.get').map(v => v.input));
    check(scene, 'the wide RPC read once, for this workspace', asked.length === 1 && asked[0].workspaceId === 'wks_example01', JSON.stringify(asked));
    check(scene, 'the definition\'s name', await tx(p, byId('workflow-name')) === '합성 개발 절차(게이트 있음)', await tx(p, byId('workflow-name')));
    // The ladder: the first row's steps in order on it, the others beside it, the loop as its own box after "수정".
    const order = await p.locator(byId('ladder') + ' [data-testid^="ladder-step-"], ' + byId('ladder') + ' [data-testid^="ladder-side-"], ' + byId('ladder') + ' [data-testid^="ladder-loop-"]:not([data-testid="ladder-loop-text"])')
      .evaluateAll(els => els.map(e => e.dataset.testid.replace(/^ladder-/, '')));
    check(scene, 'the ladder top to bottom: steps, side steps and the loop in place', JSON.stringify(order) === JSON.stringify(['step-req', 'step-impl', 'step-gate', 'step-pass',
      'side-fix', 'loop-fix-gate', 'step-commit', 'step-stable', 'side-phone', 'step-tester']), JSON.stringify(order));
    const ladder = await box(p, byId('mobile-workflow-ladder')), loop = await box(p, byId('ladder-loop-fix-gate'));
    check(scene, 'the ladder fits the width; the loop on the first screen', ladder.x >= 0 && ladder.x + ladder.width <= 390.5 && loop && loop.y + loop.height <= 844, JSON.stringify({ ladder, loop }));
    const noScroll = await p.locator(byId('mobile-workflow-ladder')).evaluate(el => [...el.querySelectorAll('*')].every(n => n.scrollWidth <= n.clientWidth + 1 || getComputedStyle(n).overflowX === 'visible'));
    check(scene, 'nothing in the ladder scrolls sideways', noScroll);
    const loopOn = async () => (await p.locator(byId('ladder-loop-fix-gate')).first().getAttribute('aria-selected')) === 'true';
    check(scene, '0.2.6 went back once: the loop drawn, its rounds said', await loopOn() && /(×1|1회): \d+→\d+/.test(await tx(p, byId('ladder-loop-fix-gate'))) && (await tx(p, byId('ladder-loop-fix-gate'))).startsWith(m.workflowLoopTo('게이트')),
      await tx(p, byId('ladder-loop-fix-gate')));
    check(scene, 'the way 0.2.6 went: gate passed, tester not', (await p.locator(byId('ladder-step-gate')).first().getAttribute('aria-selected')) === 'true'
      && (await p.locator(byId('ladder-step-tester')).first().getAttribute('aria-selected')) !== 'true');
    check(scene, 'the person\'s step said as such', (await tx(p, byId('ladder-side-phone'))).includes(m.statePerson), await tx(p, byId('ladder-side-phone')));
    const bg = rgb((await style(p, byId('workflow-sheet'), ['backgroundColor'])).backgroundColor);
    check(scene, 'drawn in the theme', bg === c.surface0.toLowerCase(), bg);
    await p.screenshot({ path: path.join(out, `${scene}-ladder.png`) });
    // Another release: its chip, its way (went back twice).
    await tap(p, byId('mobile-workflow-release-0.2.4'));
    check(scene, 'the release chip: 0.2.4 went back twice', /(×2|2회)/.test(await tx(p, byId("ladder-loop-fix-gate"))) && (await p.locator(byId('mobile-workflow-release-0.2.4')).first().getAttribute('aria-pressed')) === 'true',
      await tx(p, byId('ladder-loop-fix-gate')));
    await tap(p, byId('mobile-workflow-release-0.2.3'));
    check(scene, '0.2.3 did not go back: the loop quiet', !(await loopOn()), await tx(p, byId('ladder-loop-fix-gate')));
    // The table: seven steps of marks inside the width, no sideways scroll.
    await p.locator(byId('mobile-workflow-table')).first().scrollIntoViewIfNeeded();
    const table = await box(p, byId('mobile-workflow-table'));
    const heads = await p.locator(byId('mobile-workflow-row-0.2.6') + ' [data-testid^="mobile-workflow-cell-"]').count();
    check(scene, 'seven steps a row, inside 390, no sideways scroll', heads === 7 && table.x + table.width <= 390.5 && (await p.locator(byId('mobile-workflow-table-scroll')).count()) === 0, JSON.stringify({ heads, table }));
    check(scene, 'the chosen release\'s row marked', (await p.locator(byId('mobile-workflow-row-0.2.3')).first().getAttribute('aria-selected')) === 'true');
    const marks = await p.locator(byId('mobile-workflow-row-0.2.6') + ' [data-testid^="mobile-workflow-cell-"]').evaluateAll(els => els.map(e => e.innerText.trim()));
    check(scene, '0.2.6: ✓ ✓ 2 ✓ △ ✓ – (two gate rounds, commit title unread, no tester)', JSON.stringify(marks) === JSON.stringify(['✓', '✓', '2', '✓', '△', '✓', '–']), JSON.stringify(marks));
    const look = await p.locator(byId('mobile-workflow-table') + ' [data-testid^="mobile-workflow-mark-"]').evaluateAll(els => els.map(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e.firstElementChild ?? e).color]));
    const worst = Math.min(...look.map(([b2, f]) => contrast(rgb(f), /rgba\(0, 0, 0, 0\)/.test(b2) ? c.surface0 : rgb(b2))));
    check(scene, 'marks 3:1 and more on their fill', worst >= 3, worst.toFixed(2));
    const cellBox = await box(p, byId('mobile-workflow-row-0.2.6') + ' ' + byId('mobile-workflow-cell-gate'));
    check(scene, 'a cell is a finger-sized press', cellBox.width >= 40 && cellBox.height >= 44, JSON.stringify(cellBox));
    // A cell pressed: its evidence in a sheet from the bottom, the workflow sheet still under it.
    await tap(p, byId('mobile-workflow-row-0.2.6') + ' ' + byId('mobile-workflow-cell-gate'));
    await p.waitForSelector(byId('workflow-evidence-sheet'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the evidence sheet: the step and the release', (await tx(p, byId('workflow-evidence-sheet') + ' [role="heading"]')) === '게이트 · 0.2.6', await tx(p, byId('workflow-evidence-sheet') + ' [role="heading"]'));
    const lines = await txs(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-excerpt'));
    const places = await txs(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-place'));
    check(scene, 'the verdict lines and their paths, as the wide table says', lines.length === 2 && lines.every(l => l.includes('판정')) && places.every(v => /^docs\/.+\.md:\d+/.test(v)), JSON.stringify({ lines, places }));
    check(scene, 'the evidence sheet\'s close only (no second ×)', (await p.locator(byId('workflow-evidence-close')).count()) === 0);
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    await tap(p, byId('workflow-evidence-sheet-close')); await p.waitForTimeout(300);
    check(scene, '× closes the evidence, the workflow stays', !(await visible(p, byId('workflow-evidence-sheet'))) && await visible(p, byId('mobile-workflow-ladder')));
    if (locale === 'ko' && mode === 'light') {
      // D48's rule: the host's theme remount keeps it open.
      await p.evaluate(theme => window.__hostTheme(theme, true), PASEO_THEMES.dark); await p.waitForTimeout(900);
      check(scene, 'the host\'s other theme, drawn anew: still open', await visible(p, byId('mobile-workflow-ladder'))
        && rgb((await style(p, byId('workflow-sheet'), ['backgroundColor'])).backgroundColor) === palette(PASEO_THEMES.dark).surface0.toLowerCase());
      await p.evaluate(theme => window.__hostTheme(theme, true), PASEO_THEMES.light); await p.waitForTimeout(900);
    }
    // Back (Escape, the web's back) closes it; ⋯ opens it again, × closes it.
    await escapeFrom(p, 'workflow-sheet'); await p.waitForTimeout(500);
    check(scene, 'back closes the sheet', !(await visible(p, byId('workflow-sheet'))));
    await tap(p, lane(a.id) + ' ' + byId('lane-order-menu'));
    await tap(p, byId('order-workflow'));
    await p.waitForSelector(byId('mobile-workflow-ladder'), { timeout: 8000 }).catch(() => {});
    await tap(p, byId('workflow-sheet-close')); await p.waitForTimeout(500);
    check(scene, 'opened again, × closes it', !(await visible(p, byId('workflow-sheet'))) && await visible(p, lane(a.id)));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // A workflow file the server could not read: the sheet says so (the wide words), nothing else.
  {
    const scene = 'req134-wa-390-absent', m = copy('ko');
    const p = await (await browser.newContext(phone)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true, 'wf-absent-ko'));
    await p.waitForSelector(byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
    await tap(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'));
    await tap(p, byId('order-workflow'));
    await p.waitForSelector(byId('workflow-absent'), { timeout: 8000 }).catch(() => {});
    check(scene, 'the wide words for a definition it cannot read', await tx(p, byId('workflow-absent')) === m.workflowAbsent['unknown-format'], await tx(p, byId('workflow-absent')));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const locale of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req134-ma-390-${locale}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(locale);
    const p = await (await browser.newContext(phone)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, locale === 'ko' ? 'mail128' : 'mail128en'));
    await p.waitForSelector(byId('mailbox-button'), { timeout: 15000 });
    await p.waitForSelector(byId('mailbox-button-badge'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the glyph\'s count as the wide one: 2 decisions + 2 left waiting', await tx(p, byId('mailbox-button-badge')) === '4', await tx(p, byId('mailbox-button-badge')));
    const bar = await p.locator(byId('mobile-appbar') + ' [role="button"]').evaluateAll(els => els.map(e => ({ id: e.dataset.testid ?? e.getAttribute('aria-label'), right: e.getBoundingClientRect().right })));
    const at = id => bar.findIndex(v => v.id === id);
    check(scene, 'after + and before the view glyph, all six inside 390', at('mailbox-button') === at(m.create) + 1 && at('view-toggle') === at('mailbox-button') + 1
      && bar.every(v => v.right <= 390.5), JSON.stringify(bar));
    const appbar = await box(p, byId('mobile-appbar'));
    check(scene, 'the top bar keeps its 44px', Math.round(appbar.height) === 44, JSON.stringify(appbar));
    await tap(p, byId('mailbox-button'));
    await p.waitForSelector(byId('mailbox-sheet') + ' ' + byId('mailbox-group-decision'), { timeout: 8000 }).catch(() => {});
    const sheet = await box(p, byId('mailbox-sheet'));
    check(scene, 'a sheet over (nearly) the whole screen', sheet && sheet.x + sheet.width <= 390.5 && sheet.height >= 844 * .85, JSON.stringify(sheet));
    check(scene, 'read only, said', await tx(p, byId('mailbox-readonly')) === m.mailReadOnly);
    const groups = await txs(p, byId('mailbox-sheet') + ' [data-testid^="mailbox-group-"][data-testid$="-title"]');
    check(scene, 'the wide groups, in order', JSON.stringify(groups) === JSON.stringify([m.mailPersonOf('검토자') + ' 2', m.mailStateName.stale + ' 2', m.mailStateName.open + ' 2', m.mailStateName.closed + ' 4']), JSON.stringify(groups));
    check(scene, 'closed shows its newest two; 10 threads counted', (await rowIds(p)).length === 8 && await tx(p, byId('mailbox-shown')) === m.mailShown(10, 10), await tx(p, byId('mailbox-shown')));
    const row0 = await box(p, byId('mailbox-sheet') + ' [data-testid^="mailbox-row-"]');
    check(scene, 'the two-line rows inside the width', row0 && row0.x >= 0 && row0.x + row0.width <= 390.5 && row0.height >= 44, JSON.stringify(row0));
    const pills = await p.locator(byId('mailbox-sheet') + ' ' + byId('mailbox-state')).evaluateAll(els => els.map(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e.firstElementChild ?? e).color]));
    const worst = Math.min(...pills.map(([b2, f]) => contrast(rgb(f), rgb(b2))));
    check(scene, 'state words 4.5:1 on their pills', worst >= 4.5, worst.toFixed(2));
    await p.screenshot({ path: path.join(out, `${scene}-list.png`) });
    // To: a sheet from the bottom — the person pinned first, workspaces most first, none faded; two picked, "Show N threads".
    await tap(p, byId('mailbox-to-trigger'));
    await p.waitForSelector(byId('mailbox-picker-sheet'), { timeout: 5000 });
    const opts = await p.locator(byId('mailbox-picker-sheet') + ' [role="checkbox"]').evaluateAll(els => els.map(e => [e.dataset.testid.slice(18), getComputedStyle(e).opacity]));
    check(scene, 'To: the person first, then most first; none faded', opts[0]?.[0] === '@person' && opts[1]?.[0] === 'wsA'
      && opts.filter(([, o]) => o === '0.5').map(([id]) => id).sort().join() === 'notesapp,quiet-tool', JSON.stringify(opts));
    const optBox = await box(p, byId('mailbox-to-option-wsA'));
    check(scene, 'a finger-sized choice', optBox.height >= 44, JSON.stringify(optBox));
    await p.locator(byId('mailbox-to-search')).fill('exam'); await p.waitForTimeout(200);
    const found = await p.locator(byId('mailbox-to-options') + ' [role="checkbox"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(18)));
    check(scene, 'the find field finds by short name or name', found.join() === 'wks_example01,wks_example02', found.join());
    await p.locator(byId('mailbox-to-search')).fill('');
    await tap(p, byId('mailbox-to-option-@person'));
    await tap(p, byId('mailbox-to-option-wsA'));
    check(scene, 'the apply button counts what shows', await tx(p, byId('mailbox-to-apply')) === m.mailShowThreads(4), await tx(p, byId('mailbox-to-apply')));
    await p.screenshot({ path: path.join(out, `${scene}-to.png`) });
    await tap(p, byId('mailbox-to-apply')); await p.waitForTimeout(300);
    check(scene, 'applied: the sheet down, 4 threads, the button counting 2', !(await visible(p, byId('mailbox-picker-sheet'))) && (await rowIds(p)).length === 4
      && await tx(p, byId('mailbox-to-count')) === '2' && await tx(p, byId('mailbox-shown')) === m.mailShown(4, 10), await tx(p, byId('mailbox-shown')));
    check(scene, 'the rule in words', (await tx(p, byId('mailbox-rule-text'))).startsWith(m.mailTo + ' (' + m.mailPersonOf('검토자') + ' ' + m.mailOr + ' wsA)'), await tx(p, byId('mailbox-rule-text')));
    // From too: the and/or pill inside its sheet.
    await tap(p, byId('mailbox-from-trigger'));
    await tap(p, byId('mailbox-from-option-wks_example01'));
    check(scene, 'From and To both: the and/or pill in the sheet', await visible(p, byId('mailbox-join')));
    await tap(p, byId('mailbox-join'));
    check(scene, 'or: any thread these are part of (5)', await tx(p, byId('mailbox-from-apply')) === m.mailShowThreads(5), await tx(p, byId('mailbox-from-apply')));
    await tap(p, byId('mailbox-from-apply'));
    // State: three choices, no find field.
    await tap(p, byId('mailbox-state-filter-trigger'));
    check(scene, 'State: three choices, no find field', (await p.locator(byId('mailbox-picker-sheet') + ' [role="checkbox"]').count()) === 3 && (await p.locator(byId('mailbox-state-filter-search')).count()) === 0);
    await tap(p, byId('mailbox-picker-close'));
    await tap(p, byId('mailbox-clear'));
    check(scene, 'clear all: 8 rows again', (await rowIds(p)).length === 8 && !(await visible(p, byId('mailbox-rule'))));
    // The title search, then a thread in place of the list, and back.
    await p.locator(byId('mailbox-search')).fill('시안'); await p.waitForTimeout(300);
    const hit = await rowIds(p);
    check(scene, 'the title search', hit.length === 1 && hit[0].endsWith('시안비교'), JSON.stringify(hit));
    await tap(p, byId('mailbox-row-' + hit[0]));
    await p.waitForSelector(byId('mailbox-detail-subject'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the thread in place of the list', await tx(p, byId('mailbox-detail-subject')) === '로고 시안 두 장 비교' && (await rowIds(p)).length === 0
      && await visible(p, byId('mailbox-back')) && await tx(p, byId('mailbox-detail-tie')) === m.mailTie(2), await tx(p, byId('mailbox-detail-subject')));
    const detail = await box(p, byId('mailbox-detail'));
    check(scene, 'the thread inside the width; no second ×', detail.x >= 0 && detail.x + detail.width <= 390.5 && (await p.locator(byId('mailbox-detail-close')).count()) === 0, JSON.stringify(detail));
    const threadAsked = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.mail.thread').map(v => Object.keys(v.input).sort().join()));
    check(scene, 'one thread read, by its id only', JSON.stringify(threadAsked) === JSON.stringify(['hostId,thread']), JSON.stringify(threadAsked));
    await p.screenshot({ path: path.join(out, `${scene}-thread.png`) });
    await tap(p, byId('mailbox-back'));
    check(scene, '"Back to the list": the list, the search kept', (await rowIds(p)).length === 1 && await p.locator(byId('mailbox-search')).inputValue() === '시안');
    await tap(p, byId('mailbox-row-' + hit[0]));
    await escapeFrom(p, 'mailbox-sheet'); await p.waitForTimeout(400);
    check(scene, 'back from a thread: the list, still open', await visible(p, byId('mailbox-sheet')) && (await rowIds(p)).length === 1);
    await escapeFrom(p, 'mailbox-sheet'); await p.waitForTimeout(500);
    check(scene, 'back from the list: closed', !(await visible(p, byId('mailbox-sheet'))));
    // The lane's badge: the list filtered to that workspace (To = its short name), no tip.
    await tap(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-mail-badge'));
    await p.waitForSelector(byId('mailbox-sheet') + ' ' + byId('mailbox-to-label'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the lane badge opens the list filtered to its workspace', await tx(p, byId('mailbox-to-label')) === m.mailTo + ' wks_example01'
      && (await p.locator(byId('lane-mail-tip')).count()) === 0 && (await p.locator(byId('mailbox-search')).inputValue()) === '', await tx(p, byId('mailbox-to-label')));
    const toA = await rowIds(p);
    check(scene, 'its threads only (to wks_example01)', toA.length === 1 && toA[0].endsWith('시안비교'), JSON.stringify(toA));
    await p.screenshot({ path: path.join(out, `${scene}-lane.png`) });
    await tap(p, byId('mailbox-close')); await p.waitForTimeout(400);
    check(scene, '× closes it', !(await visible(p, byId('mailbox-sheet'))));
    await hold(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-mail-badge'));
    check(scene, 'a long press on the lane badge: its tip, not the list', await visible(p, byId('lane-mail-tip')) && !(await visible(p, byId('mailbox-sheet'))));
    await hold(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-mail-badge'));
    const calls = await p.evaluate(() => window.__calls);
    check(scene, 'reads only: nothing written, no other call', (await p.evaluate(() => window.__writes.length)) === 0
      && calls.every(n => /overview\.get|revisions\.get|mail\.list|mail\.thread|board\.get|ui\.get|agents|workspaces/.test(n)), [...new Set(calls)].join());
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const [fixture, why] of [[false, 'the lab off'], ['mailnodir', 'no folder set']]) {
    const scene = `req134-ma-390-none-${fixture || 'off'}`;
    const p = await (await browser.newContext(phone)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', true, fixture));
    await p.waitForSelector(byId('mobile-appbar'), { timeout: 15000 });
    await p.waitForTimeout(500);
    check(scene, why + ': no glyph, the list never read', (await p.locator(byId('mailbox-button')).count()) === 0
      && !(await p.evaluate(() => window.__calls)).some(n => /mail\.(list|thread)/.test(n)));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // 269-F1: the phone's evidence place line wraps whole (a 78-character path, no overflow); the wide one stays one line.
  for (const locale of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req134-path-390-${locale}-${mode}`;
    const p = await (await browser.newContext(phone)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'wf-long-' + locale));
    await p.waitForSelector(byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
    await p.locator(byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu')).first().tap(); await p.waitForTimeout(450);
    await p.locator(byId('order-workflow')).first().tap();
    await p.waitForSelector(byId('mobile-workflow-ladder'), { timeout: 8000 }).catch(() => {});
    await p.locator(byId('mobile-workflow-row-0.2.6') + ' ' + byId('mobile-workflow-cell-gate')).first().scrollIntoViewIfNeeded().catch(() => {});
    await p.locator(byId('mobile-workflow-row-0.2.6') + ' ' + byId('mobile-workflow-cell-gate')).first().tap(); await p.waitForTimeout(450);
    await p.waitForSelector(byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-place'), { timeout: 5000 }).catch(() => {});
    const info = await p.locator(byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-place')).evaluateAll(els => els.map(e => {
      const s = getComputedStyle(e), line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
      return { text: e.innerText, cut: e.scrollWidth > e.clientWidth + 1, ellipsis: s.textOverflow === 'ellipsis' && s.overflow === 'hidden', lines: Math.round(e.getBoundingClientRect().height / line),
        right: e.getBoundingClientRect().right };
    }));
    check(scene, 'both places shown, the whole path and its line number in the text', info.length === 2 && info.every(v => v.text.includes(LONG_PATH + ':')), JSON.stringify(info));
    check(scene, 'not cut: no overflow, no ellipsis, wrapped onto more than one line, inside 390', info.every(v => !v.cut && !v.ellipsis && v.lines >= 2 && v.right <= 390.5), JSON.stringify(info));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const [locale, mode] of [['ko', 'light'], ['en', 'dark']]) {
    const scene = `req134-path-1920-${locale}-${mode}`;
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1000 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-long-' + locale));
    const lane = `[data-testid="swimlane-lane-section"]:has(${byId('lane-view-switch')})`;
    await p.waitForSelector(lane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, lane + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(lane + ' ' + byId('workflow-row-0.2.6'), { timeout: 5000 }).catch(() => {});
    await clickAt(p, `${lane} ${byId('workflow-row-0.2.6')} ${byId('workflow-cell-gate')}`);
    const info = await p.locator(lane + ' ' + byId('workflow-evidence-place')).evaluateAll(els => els.map(e => {
      const s = getComputedStyle(e), line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
      return { text: e.innerText, cut: e.scrollWidth > e.clientWidth + 1, lines: Math.round(e.getBoundingClientRect().height / line), nowrap: s.whiteSpace };
    }));
    check(scene, 'the wide place line is one line, whole, as before', info.length === 2 && info.every(v => v.text.includes(LONG_PATH + ':') && !v.cut && v.lines === 1), JSON.stringify(info));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // The wide screens unchanged: the order popover has no "Show workflow" (their heading keeps "Board | Workflow").
  {
    const scene = 'req134-wide-unchanged';
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', false, 'wf-gate-ko'));
    await p.waitForSelector(byId('lane-view-switch'), { timeout: 15000 });
    await clickAt(p, byId('lane-order-menu'));
    await p.waitForSelector(byId('order-popover'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the wide ⋯: no "Show workflow"; the switch stays', (await p.locator(byId('order-workflow')).count()) === 0 && await visible(p, byId('lane-view-switch')));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-125 C안 1단계 (research/282 → 284): "Try a workflow" where the workspace holds no definition file. The wide lane
  // heading's button in the switch's place and its list of the eight built-ins (grade, what for, first steps), a pick that turns
  // the lane at once (banner: which built-in, kept in Kanban only; "Change"; "Stop using"), the empty table explained, a picks
  // file that cannot be read (the pick fails and says why), a pick resting under a definition file; every built-in drawn in
  // both languages; the phone's ⋯ entry, its list sheet and the workflow sheet with the same banner. 1920 and 390, ko/en,
  // light/dark. The lane with a definition (REQ-124/127/134) is unchanged. ----
  if (ONLY === '' || R125) {
  const t125 = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const t125s = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const hangul = /[ᄀ-ᇿ㄰-㆏가-힣]/;
  const fileLane = `[data-testid="swimlane-lane-section"]:has(${byId('workspace-name-primary')}:text-is("Example Workspace"))`;
  const tryLane = `[data-testid="swimlane-lane-section"]:has(${byId('workspace-name-primary')}:text-is("Second Workspace"))`;
  const picksOf = p => p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.workflow.pick.set').map(v => v.input));
  const ids8 = BUILTIN_WORKFLOWS.map(t => t.id);
  /** A row of the wide list, scrolled into its box first (the list scrolls when the window is short). */
  const pickAt = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.waitForTimeout(100); return clickAt(p, sel); };
  // Cut: wider than its box (one line) or taller (a line clamp, "…").
  const cut = (p, sel) => p.locator(sel).evaluateAll(els => els.filter(e => e.innerText.trim() && ((e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible')
    || (e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== 'visible'))).map(e => e.innerText.trim()));
  /** English words broken in the middle across two lines (a diamond's narrow box): each word's text must sit on one line. */
  const brokenWords = (p, sel) => p.locator(sel).evaluateAll(els => els.flatMap(e => {
    const node = [...e.childNodes].find(n => n.nodeType === 3); if (!node) return [];
    const out = [], text = node.textContent; let at = 0;
    for (const word of text.split(/\s+/)) { const i = text.indexOf(word, at); at = i + word.length; if (!word) continue;
      const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + word.length);
      if (new Set([...r.getClientRects()].map(x => Math.round(x.top))).size > 1) out.push(word); }
    return out; }));
  for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req125-wide1920-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-gate-' + lang));
    await p.waitForSelector(tryLane + ' ' + byId('lane-workflow-try'), { timeout: 15000 });
    check(scene, '"Try a workflow" on the lane with no definition, in the switch\'s place', await t125(p, tryLane + ' ' + byId('lane-workflow-try')) === m.workflowTry
      && (await p.locator(tryLane + ' ' + byId('lane-view-switch')).count()) === 0);
    check(scene, 'the lane with a definition: its switch as before, no "Try"', await visible(p, fileLane + ' ' + byId('lane-view-switch'))
      && (await p.locator(fileLane + ' ' + byId('lane-workflow-try')).count()) === 0);
    const head = await box(p, tryLane + ' ' + byId('swimlane-lane-header')), tryBox = await box(p, tryLane + ' ' + byId('lane-workflow-try'));
    check(scene, 'the button inside the heading, one line', tryBox && head && tryBox.y >= head.y - .5 && tryBox.y + tryBox.height <= head.y + head.height + .5 && tryBox.height <= 30, JSON.stringify({ head, tryBox }));
    check(scene, 'nothing read or written before it is pressed', !(await p.evaluate(() => window.__calls)).some(n => n === 'kanban.v1.workflow.get' || n === 'kanban.v1.workflow.pick.set'));
    await clickAt(p, tryLane + ' ' + byId('lane-workflow-try'));
    await p.waitForSelector(byId('workflow-pick-popover'), { timeout: 5000 }).catch(() => {});
    const rows = await p.locator(byId('workflow-pick-popover') + ' [data-testid^="workflow-pick-"]').evaluateAll(els => els.map(e => e.dataset.testid).filter(id => !/-(name|one|steps|hint|list|error)$/.test(id)));
    check(scene, 'the eight built-ins in order', JSON.stringify(rows) === JSON.stringify(ids8.map(id => 'workflow-pick-' + id)), JSON.stringify(rows));
    const names = await t125s(p, byId('workflow-pick-popover') + ' ' + byId('workflow-pick-name'));
    check(scene, 'their names in the screen\'s language', JSON.stringify(names) === JSON.stringify(BUILTIN_WORKFLOWS.map(t => t.name[lang])), JSON.stringify(names));
    const grades = await p.locator(byId('workflow-pick-popover') + ' [data-testid^="workflow-grade-"]').evaluateAll(els => els.map(e => [e.dataset.testid.slice(15), e.innerText.trim()]));
    check(scene, 'each with its grade', JSON.stringify(grades) === JSON.stringify(BUILTIN_WORKFLOWS.map(t => [t.grade, m.workflowGrade[t.grade]])), JSON.stringify(grades));
    check(scene, 'the hint: seen at once, no file made', await t125(p, byId('workflow-pick-hint')) === m.workflowPickHint);
    const pop = await box(p, byId('workflow-pick-popover'));
    check(scene, 'the list inside the window, beside the button (under it, or over it when there is more room there), never on it', pop && pop.x >= 0 && pop.x + pop.width <= 1920
      && pop.y >= 0 && pop.y + pop.height <= 1080 && (pop.y >= tryBox.y + tryBox.height || pop.y + pop.height <= tryBox.y), JSON.stringify({ pop, tryBox }));
    check(scene, 'no name or line cut in the list', (await cut(p, byId('workflow-pick-popover') + ' ' + byId('workflow-pick-name'))).length === 0);
    if (lang === 'en') check(scene, 'English: no Hangul in the list', !hangul.test(await t125(p, byId('workflow-pick-popover'))), await t125(p, byId('workflow-pick-popover')));
    const nameColor = rgb((await style(p, byId('workflow-pick-popover') + ' ' + byId('workflow-pick-name'), ['color'])).color);
    check(scene, 'names 4.5:1 on the list', contrast(nameColor, c.surface1) >= 4.5, contrast(nameColor, c.surface1).toFixed(2));
    for (const g of ['verified', 'adapted', 'reference']) {
      const gc = rgb((await style(p, byId('workflow-pick-popover') + ' ' + byId('workflow-grade-' + g) + ' div', ['color'])).color);
      check(scene, `grade ${g} 4.5:1`, contrast(gc, c.surface1) >= 4.5, gc + ' ' + contrast(gc, c.surface1).toFixed(2));
    }
    await p.screenshot({ path: path.join(out, `${scene}-list.png`) });
    // One press: the lane shows the built-in at once.
    await pickAt(p, byId('workflow-pick-design'));
    await p.waitForSelector(tryLane + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
    check(scene, 'one press saves the pick by the workspace only', JSON.stringify(await picksOf(p)) === JSON.stringify([{ workspaceId: 'wks_example02', template: 'design' }]), JSON.stringify(await picksOf(p)));
    check(scene, 'the list closed, the lane shows its workflow in place of the columns', (await p.locator(byId('workflow-pick-popover')).count()) === 0
      && await visible(p, tryLane + ' ' + byId('workflow')) && (await p.locator(tryLane + ' ' + byId('swimlane-cells')).count()) === 0);
    check(scene, 'its heading now "Board | Workflow", the workflow chosen', (await p.locator(tryLane + ' ' + byId('lane-workflow-try')).count()) === 0
      && (await p.locator(tryLane + ' ' + byId('lane-view-workflow')).first().getAttribute('aria-checked')) === 'true');
    check(scene, 'the banner: which built-in, its grade, kept in Kanban only', await t125(p, tryLane + ' ' + byId('workflow-builtin-name')) === m.workflowTrying(lang === 'ko' ? '디자인' : 'Design')
      && await visible(p, tryLane + ' ' + byId('workflow-builtin-banner') + ' ' + byId('workflow-grade-verified')) && await t125(p, tryLane + ' ' + byId('workflow-builtin-kept')) === m.workflowKeptInKanban);
    const steps = await p.locator(tryLane + ' [data-testid^="flow-node-"]').count();
    check(scene, 'the flow: all thirteen steps of "Design"', steps === 13, String(steps));
    check(scene, 'the flow\'s step names cut nowhere', (await cut(p, tryLane + ' [data-testid^="flow-node-"] div')).length === 0, JSON.stringify(await cut(p, tryLane + ' [data-testid^="flow-node-"] div')));
    check(scene, 'the empty table explained, no table, no "read · files"', await t125(p, tryLane + ' ' + byId('workflow-builtin-empty')) === m.workflowBuiltinEmpty
      && (await p.locator(tryLane + ' ' + byId('workflow-table') + ',' + tryLane + ' ' + byId('workflow-meta')).count()) === 0);
    const bannerBg = rgb((await style(p, tryLane + ' ' + byId('workflow-builtin-banner'), ['backgroundColor'])).backgroundColor);
    const keptColor = rgb((await style(p, tryLane + ' ' + byId('workflow-builtin-kept'), ['color'])).color);
    check(scene, 'the banner\'s words 4.5:1', contrast(keptColor, bannerBg) >= 4.5, contrast(keptColor, bannerBg).toFixed(2));
    const emptyColor = rgb((await style(p, tryLane + ' ' + byId('workflow-builtin-empty') + ' div', ['color'])).color);
    check(scene, 'the empty-table words 4.5:1', contrast(emptyColor, c.panel) >= 4.5, contrast(emptyColor, c.panel).toFixed(2));
    if (lang === 'en') check(scene, 'English: no Hangul in the lane\'s workflow', !hangul.test(await t125(p, tryLane + ' ' + byId('workflow'))), await t125(p, tryLane + ' ' + byId('workflow')));
    check(scene, 'the lane with a definition still shows its board', (await p.locator(fileLane + ' ' + byId('swimlane-cells')).count()) === 1);
    await away(p);
    await p.screenshot({ path: path.join(out, `${scene}-picked.png`) });
    // Change: the same list under the button, the one in use marked; another pick shows at once.
    await clickAt(p, tryLane + ' ' + byId('workflow-change'));
    await p.waitForSelector(byId('workflow-pick-popover'), { timeout: 5000 }).catch(() => {});
    check(scene, 'Change: the list with the one in use marked', (await p.locator(byId('workflow-pick-design')).first().getAttribute('aria-pressed')) === 'true'
      && await t125(p, byId('workflow-pick-design')).then(v => v.includes(m.workflowPickNow)));
    await pickAt(p, byId('workflow-pick-sales-b2b'));
    await p.waitForTimeout(300);
    check(scene, 'Change: another built-in at once', await t125(p, tryLane + ' ' + byId('workflow-builtin-name')) === m.workflowTrying(lang === 'ko' ? '영업' : 'Sales')
      && (await p.locator(tryLane + ' [data-testid^="flow-node-"]').count()) === 11 && await visible(p, tryLane + ' ' + byId('workflow-grade-reference')));
    // Stop using: the pick taken out, the lane back to its board and "Try".
    await clickAt(p, tryLane + ' ' + byId('workflow-stop'));
    await p.waitForSelector(tryLane + ' ' + byId('lane-workflow-try'), { timeout: 5000 }).catch(() => {});
    check(scene, 'Stop: the pick taken out', JSON.stringify((await picksOf(p)).map(v => v.template)) === JSON.stringify(['design', 'sales-b2b', null]), JSON.stringify(await picksOf(p)));
    check(scene, 'Stop: the board again, "Try" again, no workflow', await visible(p, tryLane + ' ' + byId('swimlane-cells')) && await visible(p, tryLane + ' ' + byId('lane-workflow-try'))
      && (await p.locator(tryLane + ' ' + byId('workflow')).count()) === 0);
    // A picks file that cannot be read: the pick fails and says why; the lane stays as it was.
    await p.evaluate(() => { window.__pickFail = 'E_CORRUPT'; });
    await clickAt(p, tryLane + ' ' + byId('lane-workflow-try'));
    await p.waitForSelector(byId('workflow-pick-popover'), { timeout: 5000 }).catch(() => {});
    await pickAt(p, byId('workflow-pick-common'));
    await p.waitForTimeout(250);
    check(scene, 'a damaged picks file: said in the list, nothing shown', await t125(p, byId('workflow-pick-error')) === m.workflowPickDamaged
      && (await p.locator(tryLane + ' ' + byId('workflow')).count()) === 0 && await visible(p, byId('workflow-pick-popover')));
    const errColor = rgb((await style(p, byId('workflow-pick-error'), ['color'])).color);
    check(scene, 'the error 4.5:1', contrast(errColor, c.surface1) >= 4.5, contrast(errColor, c.surface1).toFixed(2));
    if (lang === 'ko' && mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-damaged.png`) });
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    if (await visible(p, byId('workflow-pick-dismiss'))) await p.locator(byId('workflow-pick-dismiss')).first().click({ position: { x: 5, y: 5 } });
    await p.waitForTimeout(200);
    check(scene, 'the list closes', (await p.locator(byId('workflow-pick-popover')).count()) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // Every built-in, both languages: picked one after another through "Change", each drawn whole (its steps, no name cut, no table).
  for (const lang of ['ko', 'en']) {
    const scene = `req125-all8-1920-${lang}`, m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', false, 'wf-gate-' + lang + '-common'));
    await p.waitForSelector(tryLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    check(scene, 'a workspace already trying one: "Board | Workflow", no "Try"', (await p.locator(tryLane + ' ' + byId('lane-workflow-try')).count()) === 0);
    await clickAt(p, tryLane + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(tryLane + ' ' + byId('workflow-builtin-banner'), { timeout: 5000 }).catch(() => {});
    for (const t of BUILTIN_WORKFLOWS) {
      if (t.id !== 'common') {
        await clickAt(p, tryLane + ' ' + byId('workflow-change'));
        await p.waitForSelector(byId('workflow-pick-popover'), { timeout: 5000 }).catch(() => {});
        await pickAt(p, byId('workflow-pick-' + t.id)); await p.waitForTimeout(300);
      }
      const nodes = await p.locator(tryLane + ' [data-testid^="flow-node-"]').count(), cuts = await cut(p, tryLane + ' [data-testid^="flow-node-"] div');
      check(scene, t.id + ': drawn whole', await t125(p, tryLane + ' ' + byId('workflow-builtin-name')) === m.workflowTrying(t.name[lang]) && nodes === t.stages.length
        && cuts.length === 0 && await visible(p, tryLane + ' ' + byId('workflow-builtin-empty')), JSON.stringify({ nodes, cuts }));
      const canvas = await box(p, tryLane + ' ' + byId('flow-canvas')), panel = await box(p, tryLane + ' ' + byId('workflow'));
      check(scene, t.id + ': the flow inside the lane\'s panel', canvas && panel && canvas.x >= panel.x - .5 && canvas.x + canvas.width <= panel.x + panel.width + .5
        || (await p.locator(tryLane + ' ' + byId('flow-scroll')).count()) === 1, JSON.stringify({ canvas, panel }));
      if (lang === 'en') check(scene, t.id + ': no Hangul', !hangul.test(await t125(p, tryLane + ' ' + byId('workflow'))));
      if (lang === 'en') { const broken = await brokenWords(p, tryLane + ' [data-testid^="flow-node-"] div');
        check(scene, t.id + ': no English word broken across lines', broken.length === 0, JSON.stringify(broken)); }
      if (['gov-grant', 'dev-gated'].includes(t.id)) { await away(p); await p.screenshot({ path: path.join(out, `${scene}-${t.id}.png`) }); }
    }
    check(scene, 'each change saved once', JSON.stringify((await picksOf(p)).map(v => v.template)) === JSON.stringify(ids8.slice(1)), JSON.stringify(await picksOf(p)));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // A definition file wins: the lane shows the file's workflow; the pick rests, said in one line with "Clear the pick".
  for (const lang of ['ko', 'en']) {
    const scene = `req125-resting-1920-${lang}`, m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', false, 'wf-gate-' + lang + '-resting.design'));
    await p.waitForSelector(fileLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, fileLane + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(fileLane + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the file\'s workflow, not the built-in', await t125(p, fileLane + ' ' + byId('workflow-name')) === '합성 개발 절차(게이트 있음)'
      && (await p.locator(fileLane + ' ' + byId('workflow-builtin-banner')).count()) === 0 && await visible(p, fileLane + ' ' + byId('workflow-table')));
    check(scene, 'the resting pick said', (await t125(p, fileLane + ' ' + byId('workflow-resting-pick'))).startsWith(m.workflowResting(lang === 'ko' ? '디자인' : 'Design')));
    await clickAt(p, fileLane + ' ' + byId('workflow-clear-pick')); await p.waitForTimeout(300);
    check(scene, 'Clear the pick: taken out, the file\'s workflow stays', JSON.stringify(await picksOf(p)) === JSON.stringify([{ workspaceId: 'wks_example01', template: null }])
      && await visible(p, fileLane + ' ' + byId('workflow-table')) && (await p.locator(fileLane + ' ' + byId('workflow-resting-pick')).count()) === 0, JSON.stringify(await picksOf(p)));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // The phone: the lane's ⋯ "Try a workflow", the list in a sheet, a pick opening the workflow sheet with the same banner.
  const phone125 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const tap125 = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
  for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req125-390-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext(phone125)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'wf-gate-' + lang));
    const lane = id => byId('mobile-workspace-' + id);
    await p.waitForSelector(lane(b.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
    check(scene, 'no button added to the heading', (await p.locator(byId('lane-workflow-try')).count()) === 0);
    await tap125(p, lane(a.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('menu-sheet'), { timeout: 5000 });
    check(scene, 'a definition: "Show workflow", no "Try"', await visible(p, byId('order-workflow')) && (await p.locator(byId('order-workflow-try')).count()) === 0);
    await tap125(p, byId('menu-sheet') + ' ' + byId('sheet-close')); await p.waitForTimeout(300);
    await tap125(p, lane(b.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('order-workflow-try'), { timeout: 5000 }).catch(() => {});
    const rows = await p.locator(byId('menu-sheet') + ' [data-testid^="order-"]').evaluateAll(els => els.map(e => e.dataset.testid));
    check(scene, 'no definition: "Try a workflow" in its ⋯, after "Open board"', rows.indexOf('order-workflow-try') === rows.indexOf('order-open-board') + 1
      && await t125(p, byId('order-workflow-try')) === m.workflowTry && !rows.includes('order-workflow'), rows.join());
    if (mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-menu.png`) });
    await tap125(p, byId('order-workflow-try'));
    await p.waitForSelector(byId('workflow-pick-sheet'), { timeout: 5000 }).catch(() => {});
    const rowBoxes = await p.locator(byId('workflow-pick-sheet') + ' [data-testid^="workflow-pick-"]').evaluateAll(els => els.filter(e => !/-(name|one|steps|hint|list|error|sheet|sheet-close)$/.test(e.dataset.testid))
      .map(e => { const r = e.getBoundingClientRect(); return [e.dataset.testid, r.x, r.width, r.height]; }));
    check(scene, 'the list sheet: eight rows, inside 390, finger-sized', rowBoxes.length === 8 && rowBoxes.every(([, x, w, h]) => x >= 0 && x + w <= 390.5 && h >= 44), JSON.stringify(rowBoxes));
    check(scene, 'its title names the workspace', (await t125(p, byId('workflow-pick-sheet') + ' [role="heading"]')) === m.workflowTryFor('Second Workspace'), await t125(p, byId('workflow-pick-sheet') + ' [role="heading"]'));
    if (lang === 'en') check(scene, 'English: no Hangul in the list', !hangul.test(await t125(p, byId('workflow-pick-sheet'))));
    const wide = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-pick-sheet"] *')].filter(n => n.getBoundingClientRect().right > 391).length);
    check(scene, 'nothing past the screen\'s edge', wide === 0, String(wide));
    await p.screenshot({ path: path.join(out, `${scene}-list.png`) });
    await tap125(p, byId('workflow-pick-design'));
    await p.waitForSelector(byId('workflow-sheet') + ' ' + byId('workflow-builtin-banner'), { timeout: 8000 }).catch(() => {});
    check(scene, 'one tap saves the pick and opens the workflow sheet', JSON.stringify(await picksOf(p)) === JSON.stringify([{ workspaceId: 'wks_example02', template: 'design' }])
      && (await p.locator(byId('workflow-pick-sheet')).count()) === 0 && await visible(p, byId('workflow-sheet')), JSON.stringify(await picksOf(p)));
    check(scene, 'the banner on the phone', await t125(p, byId('workflow-builtin-name')) === m.workflowTrying(lang === 'ko' ? '디자인' : 'Design')
      && await visible(p, byId('workflow-change')) && await visible(p, byId('workflow-stop')));
    const ladderSteps = await p.locator(byId('ladder') + ' [data-testid^="ladder-step-"]').count();
    check(scene, 'the ladder: the first row\'s ten steps', ladderSteps === 10, String(ladderSteps));
    check(scene, 'the empty table explained, no table of marks', await visible(p, byId('workflow-builtin-empty')) && (await p.locator(byId('mobile-workflow-table')).count()) === 0);
    const btn = await box(p, byId('workflow-stop'));
    check(scene, 'the banner\'s buttons finger-sized', btn && btn.height >= 40, JSON.stringify(btn));
    const bannerBg = rgb((await style(p, byId('workflow-builtin-banner'), ['backgroundColor'])).backgroundColor);
    const keptColor = rgb((await style(p, byId('workflow-builtin-kept'), ['color'])).color);
    check(scene, 'the banner\'s words 4.5:1', contrast(keptColor, bannerBg) >= 4.5, contrast(keptColor, bannerBg).toFixed(2));
    const over = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')].filter(n => n.getBoundingClientRect().right > 391 && !n.closest('[data-testid="flow-scroll"]')).length);
    check(scene, 'the sheet inside 390', over === 0, String(over));
    if (lang === 'en') check(scene, 'English: no Hangul in the sheet', !hangul.test(await t125(p, byId('mobile-workflow'))));
    await p.screenshot({ path: path.join(out, `${scene}-picked.png`) });
    // Change: the list over the sheet, the one in use marked; another pick shows at once.
    await tap125(p, byId('workflow-change'));
    await p.waitForSelector(byId('workflow-pick-sheet'), { timeout: 5000 }).catch(() => {});
    check(scene, 'Change: the one in use marked', (await p.locator(byId('workflow-pick-sheet') + ' ' + byId('workflow-pick-design')).first().getAttribute('aria-pressed')) === 'true');
    await tap125(p, byId('workflow-pick-sheet') + ' ' + byId('workflow-pick-gov-grant'));
    await p.waitForTimeout(400);
    check(scene, 'Change: another built-in at once', await t125(p, byId('workflow-builtin-name')) === m.workflowTrying(lang === 'ko' ? '지원사업' : 'Grants')
      && (await p.locator(byId('workflow-pick-sheet')).count()) === 0);
    // Stop: the sheet closes, the lane's ⋯ offers "Try" again.
    await tap125(p, byId('workflow-stop'));
    await p.waitForTimeout(500);
    check(scene, 'Stop: taken out, the sheet closed', JSON.stringify((await picksOf(p)).map(v => v.template)) === JSON.stringify(['design', 'gov-grant', null])
      && (await p.locator(byId('workflow-sheet')).count()) === 0, JSON.stringify(await picksOf(p)));
    await tap125(p, lane(b.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('menu-sheet'), { timeout: 5000 }).catch(() => {});
    check(scene, 'Stop: "Try a workflow" in the ⋯ again', await visible(p, byId('order-workflow-try')) && (await p.locator(byId('order-workflow')).count()) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // REQ-125 F2 (research/286): a refused save (E_LIMIT, E_VALIDATION) is said in a line fixed outside the list's scroll — seen at
  // once, with no scrolling, inside the popover or the sheet and the window. ko/en x light/dark x 1920/390 x both codes = 16 scenes.
  const refusals = { E_LIMIT: 'workflowPickFull', E_VALIDATION: 'workflowPickFolder' };
  const shown = async (p, host) => p.evaluate(host => {
    const e = document.querySelector('[data-testid="workflow-pick-error"]'), h = document.querySelector('[data-testid="' + host + '"]');
    if (!e || !h) return null;
    const r = e.getBoundingClientRect(), o = h.getBoundingClientRect();
    const seen = Math.max(0, Math.min(r.bottom, o.bottom, innerHeight) - Math.max(r.top, o.top, 0));
    return { seen, inside: r.left >= o.left - .5 && r.right <= o.right + .5 && r.top >= o.top - .5 && r.bottom <= o.bottom + .5 && r.top >= 0 && r.bottom <= innerHeight, scrolled: [...h.querySelectorAll('*')].some(n => n.scrollTop > 0) };
  }, host);
  for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) for (const wide of [true, false]) for (const code of Object.keys(refusals)) {
    const scene = `req125-refused-${wide ? 1920 : 390}-${lang}-${mode}-${code}`, c = palette(PASEO_THEMES[mode]), m = copy(lang), words = m[refusals[code]];
    const p = await (await browser.newContext(wide ? { viewport: { width: 1920, height: 1080 } } : phone125)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, !wide, 'wf-gate-' + lang));
    const host = wide ? 'workflow-pick-popover' : 'workflow-pick-sheet';
    const open = async () => {
      if (wide) { await p.waitForSelector(tryLane + ' ' + byId('lane-workflow-try'), { timeout: 15000 }); await clickAt(p, tryLane + ' ' + byId('lane-workflow-try')); }
      else { await p.waitForSelector(byId('mobile-workspace-' + b.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
        await tap125(p, byId('mobile-workspace-' + b.id) + ' ' + byId('lane-order-menu')); await p.waitForSelector(byId('order-workflow-try'), { timeout: 5000 }); await tap125(p, byId('order-workflow-try')); }
      await p.waitForSelector(byId(host), { timeout: 5000 });
    };
    await open();
    check(scene, 'no refusal line before a pick', (await p.locator(byId('workflow-pick-error')).count()) === 0);
    await p.evaluate(c => { window.__pickFail = c; }, code);
    if (wide) await clickAt(p, byId('workflow-pick-design')); else await tap125(p, byId('workflow-pick-design'));
    await p.waitForTimeout(300);
    const at = await shown(p, host);
    check(scene, 'the refusal said in the copy\'s words', await t125(p, byId('workflow-pick-error')) === words, await t125(p, byId('workflow-pick-error')));
    check(scene, 'seen with no scrolling: height > 0, inside the ' + (wide ? 'popover' : 'sheet') + ' and the window', !!at && at.seen > 0 && at.inside && !at.scrolled, JSON.stringify(at));
    const refused = await box(p, byId('workflow-pick-error'));
    check(scene, 'a line, not cut', !!refused && refused.height >= 12 && (await cut(p, byId('workflow-pick-error'))).length === 0, JSON.stringify(refused));
    const errColor = rgb((await style(p, byId('workflow-pick-error'), ['color'])).color);
    check(scene, 'the refusal 4.5:1', contrast(errColor, c.surface1) >= 4.5, contrast(errColor, c.surface1).toFixed(2));
    check(scene, 'the list stays open, nothing picked', await visible(p, byId(host)) && await visible(p, byId('workflow-pick-design')) && (await p.locator(byId('workflow')).count()) === 0);
    if (lang === 'en') check(scene, 'English: no Hangul in the refusal', !hangul.test(await t125(p, byId('workflow-pick-error'))));
    if (lang === 'ko' && mode === 'light') await p.screenshot({ path: path.join(out, scene + '.png') });
    // Another pick (saved) takes the line away: the list closes with it. Closing and opening again starts without it.
    await p.evaluate(c => { window.__pickFail = c; }, code);
    if (wide) await clickAt(p, byId('workflow-pick-common')); else await tap125(p, byId('workflow-pick-common'));
    await p.waitForTimeout(250);
    check(scene, 'a second refusal still one line', (await p.locator(byId('workflow-pick-error')).count()) === 1);
    if (wide) { await p.keyboard.press('Escape'); await p.waitForTimeout(200); if (await visible(p, byId('workflow-pick-dismiss'))) await p.locator(byId('workflow-pick-dismiss')).first().click({ position: { x: 5, y: 5 } }); }
    else await tap125(p, byId('workflow-pick-sheet-close'));
    await p.waitForTimeout(300);
    check(scene, 'closed: the line gone with the list', (await p.locator(byId('workflow-pick-error')).count()) === 0 && (await p.locator(byId(host)).count()) === 0);
    await open();
    check(scene, 'opened again: no refusal line', (await p.locator(byId('workflow-pick-error')).count()) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // REQ-125 2단계 (research/288): "Export to the project folder" in the banner, wide and phone — one confirming line first
  // (a file in the project folder, git), Cancel writes nothing, a refusal said in the banner in sight, an export turns the
  // workflow into the file's (the banner gone, a line saying so, the lane still on its workflow). ko/en x light/dark x 1920/390.
  const exportsOf = p => p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.workflow.export').map(v => v.input));
  const inSight = async (p, sel) => (await p.locator(sel).count()) === 0 ? null : p.locator(sel).first().evaluate(e => { const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, ok: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; });
  const exportRefusals = { E_EXISTS: 'workflowExportExists', E_OUTSIDE: 'workflowExportOutside', E_CONFLICT: 'workflowExportConflict', E_UNSUPPORTED: 'workflowExportUnsupported', E_IO: 'workflowExportFailed' };
  for (const wide of [true, false]) for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req125-export-${wide ? 1920 : 390}-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext(wide ? { viewport: { width: 1920, height: 1080 } } : phone125)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, !wide, 'wf-gate-' + lang + '-design'));
    const press = (sel) => wide ? clickAt(p, sel) : tap125(p, sel);
    const scope = wide ? tryLane + ' ' : byId('workflow-sheet') + ' ';
    if (wide) {
      await p.waitForSelector(tryLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
      await clickAt(p, tryLane + ' ' + byId('lane-view-workflow'));
    } else {
      await p.waitForSelector(byId('mobile-workspace-' + b.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
      await tap125(p, byId('mobile-workspace-' + b.id) + ' ' + byId('lane-order-menu'));
      await p.waitForSelector(byId('order-workflow'), { timeout: 5000 }); await tap125(p, byId('order-workflow'));
    }
    await p.waitForSelector(scope + byId('workflow-builtin-banner'), { timeout: 8000 }).catch(() => {});
    const exportBtn = scope + byId('workflow-export');
    check(scene, 'the banner offers "Export to the project folder"', await t125(p, exportBtn) === m.workflowExport && (await cut(p, exportBtn + ' div')).length === 0);
    const banner = await box(p, scope + byId('workflow-builtin-banner')), eb = await box(p, exportBtn);
    check(scene, 'the button inside the banner and the window' + (wide ? '' : ', finger-sized'), !!banner && !!eb && eb.x >= banner.x - .5 && eb.x + eb.width <= banner.x + banner.width + .5
      && eb.y >= banner.y - .5 && eb.y + eb.height <= banner.y + banner.height + .5 && eb.x + eb.width <= (wide ? 1920 : 390.5) && (wide || eb.height >= 40), JSON.stringify({ banner, eb }));
    check(scene, 'nothing exported before it is pressed', (await exportsOf(p)).length === 0);
    await press(exportBtn);
    await p.waitForSelector(scope + byId('workflow-export-confirm'), { timeout: 3000 }).catch(() => {});
    check(scene, 'pressed: one confirming line first — the file and git — and nothing written yet', await t125(p, scope + byId('workflow-export-note')) === m.workflowExportConfirm
      && await visible(p, scope + byId('workflow-export-go')) && await visible(p, scope + byId('workflow-export-cancel')) && (await exportsOf(p)).length === 0
      && (await p.locator(exportBtn).count()) === 0, await t125(p, scope + byId('workflow-export-note')));
    const note = await inSight(p, scope + byId('workflow-export-note'));
    check(scene, 'the confirming line in sight, not cut', !!note?.ok && (await cut(p, scope + byId('workflow-export-note'))).length === 0, JSON.stringify(note));
    const bannerBg = rgb((await style(p, scope + byId('workflow-builtin-banner'), ['backgroundColor'])).backgroundColor);
    const noteColor = rgb((await style(p, scope + byId('workflow-export-note'), ['color'])).color);
    check(scene, 'the confirming line 4.5:1', contrast(noteColor, bannerBg) >= 4.5, contrast(noteColor, bannerBg).toFixed(2));
    if (!wide) { const go = await box(p, scope + byId('workflow-export-go')), no = await box(p, scope + byId('workflow-export-cancel'));
      check(scene, 'Export and Cancel finger-sized, inside 390', !!go && !!no && go.height >= 40 && no.height >= 40 && go.x + go.width <= 390.5 && no.x + no.width <= 390.5, JSON.stringify({ go, no })); }
    if (lang === 'en') check(scene, 'English: no Hangul in the banner', !hangul.test(await t125(p, scope + byId('workflow-builtin-banner'))));
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-confirm.png`) });
    await press(scope + byId('workflow-export-cancel'));
    await p.waitForTimeout(200);
    check(scene, 'Cancel: the line gone, the button back, nothing written', (await p.locator(scope + byId('workflow-export-confirm')).count()) === 0
      && await visible(p, exportBtn) && (await exportsOf(p)).length === 0);
    // Refusals, each in the copy's words, in sight under the buttons; the banner and the confirming line stay.
    await press(exportBtn); await p.waitForSelector(scope + byId('workflow-export-go'), { timeout: 3000 }).catch(() => {});
    for (const [code, key] of Object.entries(exportRefusals)) {
      await p.evaluate(c => { window.__exportFail = c; }, code);
      await press(scope + byId('workflow-export-go')); await p.waitForTimeout(250);
      const err = await inSight(p, scope + byId('workflow-export-error'));
      check(scene, code + ': said in the copy\'s words, in sight, nothing turned', await t125(p, scope + byId('workflow-export-error')) === m[key] && !!err?.ok
        && (await p.locator(scope + byId('workflow-export-error')).count()) === 1 && await visible(p, scope + byId('workflow-builtin-banner')), JSON.stringify(err));
      if (code === 'E_EXISTS') {
        const ec = rgb((await style(p, scope + byId('workflow-export-error'), ['color'])).color);
        check(scene, 'the refusal 4.5:1', contrast(ec, bannerBg) >= 4.5, contrast(ec, bannerBg).toFixed(2));
        if (lang === 'ko' && mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-exists.png`) });
      }
    }
    // 295-F4: the folder moved out while writing — said as such, and the files that could not be removed in full, in sight.
    const leftPaths = ['/srv/elsewhere/moved-kanban/workflow.json', '/srv/elsewhere/moved-kanban/.workflow.json.tmp-0000'];
    for (const left of [[], leftPaths]) {
      await p.evaluate(l => { window.__exportFail = 'E_OUTSIDE'; window.__exportFailDetails = { left: l }; }, left);
      await press(scope + byId('workflow-export-go')); await p.waitForTimeout(250);
      const want = m.workflowExportMoved + (left.length ? ' ' + m.workflowExportLeft(left) : ''), err = await inSight(p, scope + byId('workflow-export-error'));
      check(scene, 'moved while writing, ' + left.length + ' left: said, with every path whole, in sight', await t125(p, scope + byId('workflow-export-error')) === want
        && !!err?.ok && (await cut(p, scope + byId('workflow-export-error'))).length === 0, JSON.stringify({ err, text: await t125(p, scope + byId('workflow-export-error')) }));
      if (left.length && lang === 'ko' && mode === 'light') await p.screenshot({ path: path.join(out, `${scene}-left.png`) });
    }
    // Export: the workflow is the file's now — the banner gone, the line saying so, the same steps, no pick changed.
    await press(scope + byId('workflow-export-go'));
    await p.waitForSelector(scope + byId('workflow-exported'), { timeout: 5000 }).catch(() => {});
    check(scene, 'Export: the workspace and its built-in only, every press one call', JSON.stringify(await exportsOf(p)) === JSON.stringify(Array(Object.keys(exportRefusals).length + 3).fill({ workspaceId: 'wks_example02', template: 'design' })), JSON.stringify(await exportsOf(p)));
    check(scene, 'Export: the banner gone, "made the file" said', (await p.locator(scope + byId('workflow-builtin-banner')).count()) === 0
      && await t125(p, scope + byId('workflow-exported')) === m.workflowExported && (await p.locator(scope + byId('workflow-resting-pick')).count()) === 0);
    const doneColor = rgb((await style(p, scope + byId('workflow-exported'), ['color'])).color), doneOn = wide ? c.panel : c.surface0;
    check(scene, 'the line 4.5:1', contrast(doneColor, doneOn) >= 4.5, contrast(doneColor, doneOn).toFixed(2));
    const steps = wide ? await p.locator(tryLane + ' [data-testid^="flow-node-"]').count() : await p.locator(byId('ladder') + ' [data-testid^="ladder-step-"]').count();
    check(scene, 'the same steps, now read from the file', steps === (wide ? 13 : 10), String(steps));
    check(scene, 'no pick saved or taken out by the screen', (await picksOf(p)).length === 0);
    if (lang === 'en') check(scene, 'English: no Hangul in the workflow', !hangul.test(await t125(p, wide ? tryLane + ' ' + byId('workflow') : byId('mobile-workflow'))));
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-exported.png`) });
    if (wide) {
      // The board's next readings: the lane stays on its workflow ("Board | Workflow"), never "Try" again.
      await p.waitForTimeout(4500);
      check(scene, 'after the next reading the lane keeps its workflow', (await p.locator(tryLane + ' ' + byId('lane-workflow-try')).count()) === 0
        && (await p.locator(tryLane + ' ' + byId('lane-view-workflow')).first().getAttribute('aria-checked')) === 'true' && await visible(p, tryLane + ' ' + byId('workflow')));
    } else {
      await tap125(p, byId('workflow-sheet-close')); await p.waitForTimeout(300);
      await tap125(p, byId('mobile-workspace-' + b.id) + ' ' + byId('lane-order-menu'));
      await p.waitForSelector(byId('menu-sheet'), { timeout: 5000 }).catch(() => {});
      check(scene, 'the ⋯ still "Show workflow", not "Try"', await visible(p, byId('order-workflow')) && (await p.locator(byId('order-workflow-try')).count()) === 0);
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  // 293-J3: the file written but the pick could not be cleared — said after "made the file", and the resting pick offers "Clear the pick".
  // 293-J2: the file's workflow is named without the "built-in" tail.
  for (const lang of ['ko', 'en']) {
    const scene = `req125-export-kept-1920-${lang}`, m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page('light', false, 'wf-gate-' + lang + '-design'));
    await p.waitForSelector(tryLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, tryLane + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(tryLane + ' ' + byId('workflow-export'), { timeout: 8000 });
    await p.evaluate(() => { window.__exportPickKept = true; });
    await clickAt(p, tryLane + ' ' + byId('workflow-export'));
    await clickAt(p, tryLane + ' ' + byId('workflow-export-go'));
    await p.waitForSelector(tryLane + ' ' + byId('workflow-exported'), { timeout: 5000 }).catch(() => {});
    check(scene, 'made the file, the pick not cleared: both said', await t125(p, tryLane + ' ' + byId('workflow-exported')) === m.workflowExported + ' ' + m.workflowExportedPickKept,
      await t125(p, tryLane + ' ' + byId('workflow-exported')));
    check(scene, 'the resting pick with "Clear the pick" below', await visible(p, tryLane + ' ' + byId('workflow-clear-pick')));
    check(scene, 'the lane keeps its workflow, the file\'s, named without the built-in tail', await t125(p, tryLane + ' ' + byId('workflow-name')) === (lang === 'ko' ? '디자인' : 'Design')
      && (await p.locator(tryLane + ' ' + byId('workflow-builtin-banner')).count()) === 0, await t125(p, tryLane + ' ' + byId('workflow-name')));
    if (lang === 'en') check(scene, 'English: no Hangul', !hangul.test(await t125(p, tryLane + ' ' + byId('workflow'))));
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    await clickAt(p, tryLane + ' ' + byId('workflow-clear-pick')); await p.waitForTimeout(300);
    check(scene, 'Clear the pick: taken out, the file stays', (await p.locator(tryLane + ' ' + byId('workflow-resting-pick')).count()) === 0 && await visible(p, tryLane + ' ' + byId('workflow-name')));
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-52 (research/294): tidying finished cards — the done column's "Archived N" and "Tidy", the archived list with its
  // restore, the automatic archive's days in the settings window. 1920 and 390, ko/en, light/dark (=req52).
  if (ONLY === '' || R52) {
  const t52 = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const hangul52 = /[ᄀ-ᇿ㄰-㆏가-힣]/;
  const phone52 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const tap52 = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
  const callsOf = (p, name) => p.evaluate(n => window.__inputs.filter(v => v.name === n).map(v => v.input), name);
  const cut52 = (p, sel) => p.locator(sel).evaluateAll(els => els.filter(e => e.innerText.trim() && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').map(e => e.innerText.trim()));
  /** The colour a text is painted in and the first painted background behind it. */
  const paint = (p, sel) => p.locator(sel).first().evaluate(e => { const fg = getComputedStyle(e).color; let n = e, bg = 'rgba(0, 0, 0, 0)';
    while (n && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; } return { fg, bg }; });
  const ratio = async (p, sel) => { const v = await paint(p, sel); return contrast(rgb(v.fg), rgb(v.bg)); };
  const lane52 = `[data-testid="swimlane-lane-section"]:has(${byId('workspace-name-primary')}:text-is("Example Workspace"))`;
  const live52 = a52.cards.filter(c => !c.archivedAt && c.stageId === 'done').length, progress52 = summarizeBoard(a52).progress;
  for (const wide of [true, false]) for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req52-${wide ? 1920 : 390}-${lang}-${mode}`, m = copy(lang), W = wide ? 1920 : 390;
    const p = await (await browser.newContext(wide ? { viewport: { width: 1920, height: 1080 } } : phone52)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, !wide, 'req52-' + lang));
    const press = sel => wide ? clickAt(p, sel) : tap52(p, sel);
    const scope = wide ? lane52 + ' ' : byId('mobile-workspace-' + a52.id) + ' ';
    if (!wide) { await p.waitForSelector(byId('mobile-tab-done'), { timeout: 15000 }); await tap52(p, byId('mobile-tab-done')); }
    await p.waitForSelector(scope + byId('done-archived-count'), { timeout: 15000 }).catch(() => {});
    // The head: "Archived 3" beside the done count (the cancelled card is not counted) and "Tidy", whole and in the window.
    check(scene, 'the done head says the finished cards archived', await t52(p, scope + byId('done-archived-count')) === m.archivedCount(progress52.archivedDone)
      && progress52.archivedDone === 3, await t52(p, scope + byId('done-archived-count')));
    check(scene, '"Tidy" beside it', await t52(p, scope + byId('done-tidy')) === m.tidy);
    const tools = await box(p, scope + byId('done-head-tools'));
    if (wide) {
      const head = await p.locator(scope + byId('lane-stage-headers') + ' ' + byId('cell-panel-heading')).last().boundingBox();
      check(scene, 'inside the done column\'s head', !!tools && !!head && tools.x >= head.x - .5 && tools.x + tools.width <= head.x + head.width + .5
        && tools.y >= head.y - .5 && tools.y + tools.height <= head.y + head.height + .5, JSON.stringify({ tools, head }));
      check(scene, 'the head still says Done and its count', (await t52(p, scope + byId('lane-stage-headers'))).includes(m.doneStage + String(live52)) || (await t52(p, scope + byId('lane-stage-headers'))).includes(m.doneStage + ' ' + live52),
        await t52(p, scope + byId('lane-stage-headers')));
    }
    check(scene, 'in the window, not cut', !!tools && tools.x >= 0 && tools.x + tools.width <= W + .5 && (await cut52(p, scope + byId('done-head-tools') + ' div')).length === 0, JSON.stringify(tools));
    for (const id of ['done-archived-count', 'done-tidy']) {
      const r = await ratio(p, scope + byId(id) + ' div');
      check(scene, id + ' 4.5:1', r >= 4.5, r.toFixed(2));
    }
    if (!wide) { const cb = await box(p, scope + byId('done-archived-count')), tb = await box(p, scope + byId('done-tidy'));
      check(scene, 'finger-sized on a phone', !!cb && !!tb && cb.height >= 32 && tb.height >= 32, JSON.stringify({ cb, tb })); }
    // The progress counts the finished cards archived: the lane's cards figure is the ledger's done/requested, archived ones in.
    const progressSel = wide ? scope + byId('lane-progress') : scope + byId('lane-cards-progress');
    check(scene, 'the lane\'s progress counts the archived finished cards', (await t52(p, progressSel)).includes(m.cardsProgress(progress52.done, progress52.requested)),
      await t52(p, progressSel) + ' want ' + m.cardsProgress(progress52.done, progress52.requested));
    if (lang === 'en') check(scene, 'English: no Hangul in the head', !hangul52.test(await t52(p, scope + byId('done-head-tools'))));
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-head.png`) });
    // "Tidy": one confirming line first; Cancel writes nothing; "Archive" archives every card in Done of that workspace.
    await press(scope + byId('done-tidy'));
    await p.waitForSelector(scope + byId('tidy-confirm'), { timeout: 3000 }).catch(() => {});
    check(scene, 'Tidy: one confirming line, nothing archived yet', await t52(p, scope + byId('tidy-confirm-text')) === m.tidyConfirm(live52)
      && (await callsOf(p, 'kanban.v1.archive.tidy')).length === 0, await t52(p, scope + byId('tidy-confirm-text')));
    const cb = await box(p, scope + byId('tidy-confirm'));
    check(scene, 'the line in the window', !!cb && cb.x >= 0 && cb.x + cb.width <= W + .5 && cb.y + cb.height <= (wide ? 1080 : 844), JSON.stringify(cb));
    const cr = await ratio(p, scope + byId('tidy-confirm-text'));
    check(scene, 'the line 4.5:1', cr >= 4.5, cr.toFixed(2));
    if (!wide) { const go = await box(p, scope + byId('tidy-go')), no = await box(p, scope + byId('tidy-cancel'));
      check(scene, 'Archive and Cancel finger-sized', !!go && !!no && go.height >= 40 && no.height >= 40, JSON.stringify({ go, no })); }
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-tidy-confirm.png`) });
    await press(scope + byId('tidy-cancel'));
    check(scene, 'Cancel: the line gone, nothing archived', (await p.locator(scope + byId('tidy-confirm')).count()) === 0 && (await callsOf(p, 'kanban.v1.archive.tidy')).length === 0);
    await press(scope + byId('done-tidy'));
    await p.waitForSelector(scope + byId('tidy-go'), { timeout: 3000 }).catch(() => {});
    await press(scope + byId('tidy-go'));
    await p.waitForSelector(scope + byId('tidy-note'), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(600);
    check(scene, 'Archive: that workspace once', JSON.stringify(await callsOf(p, 'kanban.v1.archive.tidy')) === JSON.stringify([{ boardId: a52.id }]), JSON.stringify(await callsOf(p, 'kanban.v1.archive.tidy')));
    if (wide) check(scene, 'Archive: said how many, the head counts them, nothing left to tidy', await t52(p, scope + byId('tidy-note-text')) === m.tidyDone(live52)
      && await t52(p, scope + byId('done-archived-count')) === m.archivedCount(progress52.archivedDone + live52) && (await p.locator(scope + byId('done-tidy')).count()) === 0,
      await t52(p, scope + byId('tidy-note-text')) + ' / ' + await t52(p, scope + byId('done-archived-count')));
    // A phone's Done tab lists a workspace only while it holds cards there (as before REQ-52): tidied, the workspace leaves the tab.
    else check(scene, 'Archive: the workspace\'s done cards gone from the Done tab', (await p.locator(byId('mobile-workspace-' + a52.id) + ' [data-testid^="kanban-card-"]').count()) === 0);
    if (!wide) await tap52(p, byId('mobile-tab-todo'));
    check(scene, 'Archive: the progress unchanged', (await t52(p, progressSel)).includes(m.cardsProgress(progress52.done, progress52.requested)), await t52(p, progressSel));
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-tidied.png`) });
    // The archived list — from the head's number (wide), from the workspace's ⋯ (a phone's To Do tab): latest first, how each was
    // archived, the cancelled one said apart.
    if (wide) await press(scope + byId('done-archived-count'));
    else {
      await press(scope + byId('lane-order-menu'));
      await p.waitForSelector(byId('order-archived'), { timeout: 5000 }).catch(() => {});
      check(scene, 'the ⋯ offers "Archived cards"', (await t52(p, byId('order-archived'))).includes(m.archivedShow), await t52(p, byId('order-archived')));
      await press(byId('order-archived'));
    }
    await p.waitForSelector(byId('archived-row-0'), { timeout: 5000 }).catch(() => {});
    const titles = await p.locator(byId('archived-sheet') + ' ' + byId('archived-title')).allInnerTexts();
    // The two archived automatically in the same sweep share their time; their order between them is the server's (by id).
    check(scene, 'the list: every archived card, the tidied first', titles.length === 4 + live52 && titles[0] === 'Helper done'
      && titles.slice(live52, live52 + 2).join('|') === 'Cancelled idea|Closed review' && titles.slice(live52 + 2).sort().join('|') === 'Old release note|Shipped report', JSON.stringify(titles));
    const metas = await p.locator(byId('archived-sheet') + ' ' + byId('archived-meta')).allInnerTexts();
    const autoWord = lang === 'ko' ? '자동 보관' : 'Archived automatically';
    check(scene, 'how each was archived', metas.filter(v => v.includes(autoWord)).length === 2 && metas.filter(v => v.includes(m.archivedNotDone)).length === 1
      && metas[titles.indexOf('Cancelled idea')].includes(m.archivedNotDone), JSON.stringify(metas));
    for (const [i, title] of [[0, 'tidied'], [titles.indexOf('Cancelled idea'), 'cancelled']]) {
      const r = await ratio(p, byId('archived-sheet') + ' ' + byId('archived-row-' + i) + ' ' + byId('archived-meta'));
      check(scene, 'the ' + title + ' line 4.5:1', r >= 4.5, r.toFixed(2));
    }
    const sheet = await box(p, byId('archived-sheet') + ' ' + byId('archived-list'));
    check(scene, 'the list in the window, nothing cut', !!sheet && sheet.x >= 0 && sheet.x + sheet.width <= W + .5
      && (await cut52(p, byId('archived-sheet') + ' ' + byId('archived-list') + ' div')).length === 0, JSON.stringify(sheet));
    if (!wide) { const rb = await box(p, byId('archived-row-0') + ' ' + byId('archived-restore'));
      check(scene, 'Restore finger-sized', !!rb && rb.height >= 40, JSON.stringify(rb)); }
    if (lang === 'en') check(scene, 'English: no Hangul in the list', !hangul52.test(await t52(p, byId('archived-sheet'))));
    await away(p).catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-list.png`) });
    // Restore the cancelled card: one call for it, said, and gone from the list.
    const ci = titles.indexOf('Cancelled idea');
    await press(byId('archived-row-' + ci) + ' ' + byId('archived-restore'));
    await p.waitForSelector(byId('archived-note'), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(400);
    check(scene, 'Restore: that card once', JSON.stringify(await callsOf(p, 'kanban.v1.archived.restore')) === JSON.stringify([{ boardId: a52.id, cardId: id52('Cancelled idea') }]),
      JSON.stringify(await callsOf(p, 'kanban.v1.archived.restore')));
    check(scene, 'Restore: said, and the list one shorter', await t52(p, byId('archived-note')) === m.restored('Cancelled idea')
      && (await p.locator(byId('archived-sheet') + ' ' + byId('archived-title')).count()) === titles.length - 1, await t52(p, byId('archived-note')));
    await p.screenshot({ path: path.join(out, `${scene}-restored.png`) });
    if (wide) await escapeFrom(p, 'archived-sheet'); else await tap52(p, byId('archived-sheet') + ' ' + byId('sheet-close'));
    await p.waitForTimeout(400);
    check(scene, 'the list closes', (await p.locator(byId('archived-list')).count()) === 0);
    // The workspace's ⋯ opens the same list (wide; the phone opened it from there above).
    if (wide) {
      await press(scope + byId('lane-order-menu'));
      await p.waitForSelector(byId('order-archived'), { timeout: 5000 }).catch(() => {});
      check(scene, 'the ⋯ offers "Archived cards"', (await t52(p, byId('order-archived'))).includes(m.archivedShow), await t52(p, byId('order-archived')));
      await press(byId('order-archived'));
      await p.waitForSelector(byId('archived-row-0'), { timeout: 5000 }).catch(() => {});
      check(scene, 'and it opens the list', await visible(p, byId('archived-sheet') + ' ' + byId('archived-row-0')));
      await escapeFrom(p, 'archived-sheet');
      await p.waitForTimeout(400);
    }
    // The settings window: Automation → "Archive finished cards", 7 days until another is chosen; a choice saves the days.
    await press(byId('open-settings'));
    const tab = wide ? 'settings-tab-automation' : 'settings-open-automation';
    await p.waitForSelector(byId(tab), { timeout: 5000 }).catch(() => {});
    await press(byId(tab));
    await p.waitForSelector(byId('setting-auto-archive'), { timeout: 5000 }).catch(() => {});
    await p.locator(byId('setting-auto-archive')).first().scrollIntoViewIfNeeded().catch(() => {});
    check(scene, 'the setting: 7 days chosen, Off among the choices', (await p.locator(byId('auto-archive-7')).first().getAttribute('aria-checked')) === 'true'
      && await t52(p, byId('auto-archive-0')) === m.autoArchiveOff && await t52(p, byId('auto-archive-30')) === m.autoArchiveDays(30));
    await press(byId('auto-archive-14'));
    await p.waitForTimeout(400);
    check(scene, 'a choice saves the days once', JSON.stringify(await callsOf(p, 'kanban.v1.archive.settings.set')) === JSON.stringify([{ days: 14 }])
      && (await p.locator(byId('auto-archive-14')).first().getAttribute('aria-checked')) === 'true', JSON.stringify(await callsOf(p, 'kanban.v1.archive.settings.set')));
    const row = await box(p, byId('setting-auto-archive'));
    check(scene, 'the row in the window', !!row && row.x >= 0 && row.x + row.width <= W + .5, JSON.stringify(row));
    if (lang === 'en') check(scene, 'English: no Hangul in the row', !hangul52.test(await t52(p, byId('setting-auto-archive'))));
    await p.screenshot({ path: path.join(out, `${scene}-settings.png`) });
    // 298-F2: another screen turns the automatic archive off; this screen's next reading (its own Refresh) shows Off, not its 14 —
    // and a damaged file read afterwards shows its notice. The settings window is closed and opened again in between.
    const reread = async value => {
      await p.evaluate(v => { window.__FIXTURE__.overview.autoArchive = v; for (const b of Object.values(window.__FIXTURE__.boards)) b.autoArchive = v; }, value);
      await press(byId('settings-close')); await p.waitForTimeout(250);
      await p.getByRole('button', { name: m.refresh, exact: true }).first().click(); await p.waitForTimeout(500);
      await press(byId('open-settings'));
      await p.waitForSelector(byId(tab), { timeout: 5000 }).catch(() => {}); await press(byId(tab));
      await p.waitForSelector(byId('setting-auto-archive'), { timeout: 5000 }).catch(() => {});
      await p.locator(byId('setting-auto-archive')).first().scrollIntoViewIfNeeded().catch(() => {});
    };
    await reread({ days: 0 });
    check(scene, '298-F2 another screen\'s Off wins on the next reading', (await p.locator(byId('auto-archive-0')).first().getAttribute('aria-checked')) === 'true'
      && (await p.locator(byId('auto-archive-14')).first().getAttribute('aria-checked')) === 'false');
    await p.screenshot({ path: path.join(out, `${scene}-settings-reread.png`) });
    await reread({ days: 0, damaged: true });
    check(scene, '298-F2 a damaged file read later says so', await visible(p, byId('auto-archive-damaged')) && await t52(p, byId('auto-archive-damaged')) === m.autoArchiveDamaged
      && (await p.locator('[data-testid^="auto-archive-"][aria-checked="true"]').count()) === 0);
    await p.screenshot({ path: path.join(out, `${scene}-settings-damaged.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-125 U1 (research/301): a `/2` definition's rows of 건. 1920: the table's first column "건", each row's name a chip that
  // chooses it (no release chips in the heading), "자료 있음 · 폴더" / "기록 없음" / hatched "일부만 읽음" told apart, "제외 N" and
  // "일부만 읽음 N" opening their lists, the order and rename line, a 건's way that never passes a decision, its evidence; the 건
  // folder with no 건; a 40-character name cut at twelve characters with the whole name in its label. 390: the 건 chips, the marks
  // ● / ▨ / –, the evidence sheet. ko/en × light/dark. ----
  if (ONLY === '' || R125U1) {
  const hangulU1 = /[ᄀ-ᇿ㄰-㆏가-힣]/;
  const tU1 = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const tsU1 = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const laneU1 = `[data-testid="swimlane-lane-section"]:has(${byId('lane-view-switch')})`;
  const cellU1 = (row, stage) => `${laneU1} ${byId('workflow-row-' + U1_ROOT + '/' + row)} ${byId('workflow-cell-' + stage)}`;
  const openWide = async (p, spec) => {
    await p.goto(page(spec.mode, false, 'wf-' + spec.data + '-' + spec.lang));
    await p.waitForSelector(laneU1 + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, laneU1 + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(laneU1 + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
  };
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u1-1920-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await openWide(p, { mode, lang, data: 'inst' });
    check(scene, 'the first column says 건', await tU1(p, laneU1 + ' ' + byId('workflow-table-first')) === m.workflowInstance, await tU1(p, laneU1 + ' ' + byId('workflow-table-first')));
    const names = await tsU1(p, laneU1 + ' ' + byId('workflow-rowname'));
    check(scene, 'three 건 rows by shown name, the dated one first', JSON.stringify(names) === JSON.stringify(['A사', 'B사', 'C사']), JSON.stringify(names));
    check(scene, 'no release chips in the heading', (await p.locator(laneU1 + ' [data-testid^="workflow-release-"]').count()) === 0);
    const cells = {};
    for (const [row, stage] of [['01_A사', 'docs'], ['01_A사', 'submit'], ['01_A사', 'agree'], ['02_B사', 'docs'], ['03_C사', 'agree']]) cells[row + ' ' + stage] = await tU1(p, cellU1(row, stage));
    check(scene, 'A사: 자료 있음 · the folder, in each step with data', cells['01_A사 docs'] === m.dataThere + ' · 03_삽입도식' && cells['01_A사 submit'] === m.dataThere + ' · 00_제출서류_20260918'
      && cells['01_A사 agree'] === m.dataThere + ' · 10_선정·계약', JSON.stringify(cells));
    check(scene, 'B사: a README-only folder is 기록 없음', cells['02_B사 docs'] === m.stateNoRecord, cells['02_B사 docs']);
    check(scene, 'C사: cut at the cap is ▨ 일부만 읽음, never 기록 없음', cells['03_C사 agree'] === '▨ ' + m.stateIncomplete, cells['03_C사 agree']);
    const hatch = await style(p, cellU1('03_C사', 'agree'), ['borderTopStyle', 'borderTopWidth']);
    check(scene, '일부만 읽음 is framed apart (dashed)', hatch.borderTopStyle === 'dashed' && hatch.borderTopWidth === '1px', JSON.stringify(hatch));
    const plainFrame = await style(p, cellU1('02_B사', 'docs'), ['borderTopWidth']);
    check(scene, '기록 없음 has no frame', plainFrame.borderTopWidth === '0px', JSON.stringify(plainFrame));
    const incColor = rgb((await style(p, cellU1('03_C사', 'agree') + ' div', ['color'])).color), dataColor = rgb((await style(p, cellU1('01_A사', 'agree') + ' div', ['color'])).color);
    check(scene, 'cell words 4.5:1 (일부만 읽음, 자료 있음)', contrast(incColor, c.surface0) >= 4.5 && contrast(dataColor, c.surface2) >= 4.5,
      contrast(incColor, c.surface0).toFixed(2) + ' ' + contrast(dataColor, c.surface2).toFixed(2));
    const nameColor = rgb((await style(p, laneU1 + ' ' + byId('workflow-rowname'), ['color'])).color);
    check(scene, 'the 건 chips\' names 4.5:1', contrast(nameColor, c.card) >= 4.5, contrast(nameColor, c.card).toFixed(2));
    check(scene, 'the line under the table: count, left out, order, rename', await tU1(p, laneU1 + ' ' + byId('workflow-instances-line')) === m.workflowInstancesLine(3, 2));
    check(scene, '303-F5: 제외 2 (the link, someone\'s #긴급건; @eaDir not counted) and 일부만 읽음 1 in the heading', await tU1(p, laneU1 + ' ' + byId('workflow-excluded')) === m.workflowExcludedCount(2)
      && await tU1(p, laneU1 + ' ' + byId('workflow-incomplete')) === m.workflowIncompleteCount(1));
    check(scene, 'the flow legend names the chosen 건', await tU1(p, laneU1 + ' ' + byId('workflow-legend')) === m.workflowInstanceLegend('A사'));
    // 325-J1: bold read from the drawn line's thickness (4px bold, 2px plain), not aria-selected (RN-web leaves it off a View).
    const edge = async id => { const t = await p.locator(laneU1 + ' ' + byId('flow-edge-' + id) + ' > div').first().evaluate(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height));
      return t === 4 ? true : t === 2 ? false : 'thickness ' + t; };
    const rim = async id => (await style(p, laneU1 + ' ' + byId('flow-node-' + id), ['borderTopWidth'])).borderTopWidth;
    const way = [await rim('docs'), await rim('submit'), await rim('agree'), await rim('evaluate'), await edge('docs-check'), await edge('check-submit'), await edge('check-redo')];
    check(scene, 'A사\'s way: its steps with data bold, no line into or out of a decision', JSON.stringify(way) === JSON.stringify(['2px', '2px', '2px', '1px', false, false, false]), JSON.stringify(way));
    check(scene, 'the step figure: 건 with data', await tU1(p, laneU1 + ' ' + byId('flow-count-agree')) === m.countInstances(1));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    await clickAt(p, laneU1 + ' ' + byId('workflow-excluded'));
    const left = await tsU1(p, laneU1 + ' ' + byId('workflow-excluded-list') + ' div');
    check(scene, '제외: the link and someone\'s #긴급건 with their reasons; the system helper @eaDir not listed', left.includes(U1_ROOT + '/04_링크 — ' + m.workflowExcludedWhy.link)
      && left.includes(U1_ROOT + '/#긴급건 — ' + m.workflowExcludedWhy.hidden) && !left.some(v => v.includes('@eaDir')), JSON.stringify(left));
    await clickAt(p, laneU1 + ' ' + byId('workflow-row-instance-1'));
    check(scene, 'a 건 chip chooses its row', (await p.locator(laneU1 + ' ' + byId('workflow-row-instance-1')).first().getAttribute('aria-pressed')) === 'true'
      && await tU1(p, laneU1 + ' ' + byId('workflow-legend')) === m.workflowInstanceLegend('B사') && (await p.locator(laneU1 + ' ' + byId('workflow-evidence')).count()) === 0);
    await clickAt(p, cellU1('01_A사', 'agree'));
    const title = await tU1(p, laneU1 + ' ' + byId('workflow-evidence-title')), place = await tU1(p, laneU1 + ' ' + byId('workflow-evidence-place'));
    check(scene, 'the evidence: step · 건 · what it says, and where', title === '협약·계약 · A사 · ' + m.dataThere + ' · 10_선정·계약'
      && place === U1_ROOT + '/01_A사/10_선정·계약 · ' + m.evidenceFolder(1), JSON.stringify({ title, place }));
    await clickAt(p, cellU1('03_C사', 'agree'));
    check(scene, 'the evidence of 일부만 읽음 says why', await tU1(p, laneU1 + ' ' + byId('workflow-evidence-why')) === m.evidenceIncomplete);
    if (lang === 'en') check(scene, 'English: the screen\'s own words in English', !hangulU1.test(await tU1(p, laneU1 + ' ' + byId('workflow-instances-line'))));
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const mode of ['light', 'dark']) {
    const scene = `req125u1-1920-ko-${mode}-edge`, c = palette(PASEO_THEMES[mode]), m = copy('ko');
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await openWide(p, { mode, lang: 'ko', data: 'instzero' });
    check(scene, 'no 건: said with where they go, no table', await tU1(p, laneU1 + ' ' + byId('workflow-no-instances')) === m.workflowNoInstances(U1_ROOT)
      && (await p.locator(laneU1 + ' ' + byId('workflow-table')).count()) === 0 && await visible(p, laneU1 + ' ' + byId('flow-canvas')));
    check(scene, 'no 건: the line says 건 0 · 제외 1 (303-F5: someone\'s @고객과제; @eaDir quiet)', await tU1(p, laneU1 + ' ' + byId('workflow-instances-line')) === m.workflowInstancesLine(0, 1)
      && await tU1(p, laneU1 + ' ' + byId('workflow-excluded')) === m.workflowExcludedCount(1));
    await clickAt(p, laneU1 + ' ' + byId('workflow-excluded'));
    const zl = await tsU1(p, laneU1 + ' ' + byId('workflow-excluded-list') + ' div');
    check(scene, 'no 건: its list says why @고객과제 is not a 건', zl.includes(U1_ROOT + '/@고객과제 — ' + m.workflowExcludedWhy.hidden) && !zl.some(v => v.includes('@eaDir')), JSON.stringify(zl));
    const zc = rgb((await style(p, laneU1 + ' ' + byId('workflow-no-instances'), ['color'])).color);
    check(scene, 'no 건: words 4.5:1', contrast(zc, c.panel) >= 4.5, contrast(zc, c.panel).toFixed(2));
    await p.screenshot({ path: path.join(out, `${scene}-zero.png`) });
    await openWide(p, { mode, lang: 'ko', data: 'instlong' });
    const long = await tsU1(p, laneU1 + ' ' + byId('workflow-rowname'));
    check(scene, 'a 40-character name: twelve characters and …', long.includes(U1_LONG.slice(0, 12) + '…') && long.includes('A사'), JSON.stringify(long));
    const labels = await p.locator(laneU1 + ' [data-testid^="workflow-row-instance-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    check(scene, 'its whole name in its label', labels.includes(m.workflowShowInstance(U1_LONG)), JSON.stringify(labels));
    const fit = await p.locator(laneU1 + ' [data-testid^="workflow-row-instance-"]').evaluateAll(els => els.map(e => {
      const chip = e.firstElementChild.getBoundingClientRect(), col = e.getBoundingClientRect(), t = e.querySelector('[data-testid="workflow-rowname"]');
      return { inside: chip.right <= col.right + .5, cut: t.scrollWidth > t.clientWidth + 1 }; }));
    check(scene, 'the chips inside their column, uncut', fit.every(v => v.inside && !v.cut), JSON.stringify(fit));
    await p.screenshot({ path: path.join(out, `${scene}-long.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  const phoneU1 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const tapU1 = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
  const openPhone = async (p, spec) => {
    await p.goto(page(spec.mode, true, 'wf-' + spec.data + '-' + spec.lang));
    await p.waitForSelector(byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
    await tapU1(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('order-workflow'), { timeout: 5000 }).catch(() => {});
    await tapU1(p, byId('order-workflow'));
    await p.waitForSelector(byId('workflow-sheet') + ' ' + byId('ladder'), { timeout: 8000 }).catch(() => {});
  };
  const outside390 = p => p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')]
    .filter(n => n.getBoundingClientRect().right > 391 && !n.closest('[data-testid="flow-scroll"], [data-testid="mobile-workflow-releases"], [data-testid="mobile-workflow-table-scroll"]')).length);
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u1-390-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext(phoneU1)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await openPhone(p, { mode, lang, data: 'inst' });
    const chips = await tsU1(p, byId('mobile-workflow-releases') + ' [data-testid^="mobile-workflow-release-"]');
    check(scene, 'the 건 chips', JSON.stringify(chips) === JSON.stringify(['A사', 'B사', 'C사']), JSON.stringify(chips));
    check(scene, 'the table of marks: first column 건, its title and legend', await tU1(p, byId('mobile-workflow-table-first')) === m.workflowInstance
      && await tU1(p, byId('mobile-workflow-marks-legend')) === m.workflowInstanceMarksLegend);
    const marks = await p.locator('[data-testid^="mobile-workflow-row-"]').evaluateAll(els => els.map(e => [...e.querySelectorAll('[data-testid^="mobile-workflow-cell-"]')]
      .map(c => c.dataset.testid.slice(21) + ':' + c.innerText.trim()).join(' ')));
    check(scene, 'marks: ● data, – none, ▨ read in part', JSON.stringify(marks) === JSON.stringify(['docs:● submit:● agree:●', 'docs:– submit:– agree:–', 'docs:– submit:– agree:▨']), JSON.stringify(marks));
    const glyph = rgb((await style(p, '[data-testid^="mobile-workflow-row-"] [data-testid="mobile-workflow-mark-incomplete"] div', ['color'])).color);
    const glyphBg = rgb((await style(p, '[data-testid^="mobile-workflow-row-"] [data-testid="mobile-workflow-mark-incomplete"]', ['backgroundColor'])).backgroundColor);
    check(scene, 'the ▨ mark 3:1 on its disc', contrast(glyph, glyphBg) >= 3, contrast(glyph, glyphBg).toFixed(2));
    check(scene, 'the ladder legend names the chosen 건', await tU1(p, byId('workflow-legend')) === m.workflowInstanceLadderLegend('A사'));
    check(scene, '303-F5: 제외 2 · 일부만 읽음 1 and the line under the table', await tU1(p, byId('workflow-excluded')) === m.workflowExcludedCount(2)
      && await tU1(p, byId('workflow-instances-line')) === m.workflowInstancesLine(3, 2));
    check(scene, 'the sheet inside 390', await outside390(p) === 0, String(await outside390(p)));
    await p.screenshot({ path: path.join(out, `${scene}.png`), fullPage: true });
    await tapU1(p, byId('mobile-workflow-row-' + U1_ROOT + '/03_C사') + ' ' + byId('mobile-workflow-cell-agree'));
    await p.waitForSelector(byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-why'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the evidence sheet: step · 건, and why it is read in part', (await tU1(p, byId('workflow-evidence-sheet') + ' [role="heading"]')) === '협약·계약 · C사'
      && await tU1(p, byId('workflow-evidence-why')) === m.evidenceIncomplete, await tU1(p, byId('workflow-evidence-sheet') + ' [role="heading"]'));
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  for (const mode of ['light', 'dark']) {
    const scene = `req125u1-390-ko-${mode}-edge`, m = copy('ko');
    const p = await (await browser.newContext(phoneU1)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await openPhone(p, { mode, lang: 'ko', data: 'instzero' });
    check(scene, 'no 건: said, no table of marks', await tU1(p, byId('workflow-no-instances')) === m.workflowNoInstances(U1_ROOT) && (await p.locator(byId('mobile-workflow-table')).count()) === 0);
    check(scene, 'no 건: 제외 1 said (303-F5)', await tU1(p, byId('workflow-excluded')) === m.workflowExcludedCount(1) && await tU1(p, byId('workflow-instances-line')) === m.workflowInstancesLine(0, 1));
    check(scene, 'no 건: inside 390', await outside390(p) === 0);
    await p.screenshot({ path: path.join(out, `${scene}-zero.png`), fullPage: true });
    await p.context().close();
    const q = await (await browser.newContext(phoneU1)).newPage(); q.setDefaultTimeout(5000); q.on('pageerror', e => errors.push(String(e)));
    await openPhone(q, { mode, lang: 'ko', data: 'instlong' });
    const chips = await tsU1(q, byId('mobile-workflow-releases') + ' [data-testid^="mobile-workflow-release-"]');
    check(scene, 'a 40-character name: ten characters and … on its chip', chips.includes(U1_LONG.slice(0, 10) + '…'), JSON.stringify(chips));
    const rowName = await q.locator(byId('mobile-workflow-rowname')).evaluateAll(els => els.map(e => { const s = getComputedStyle(e), line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
      return Math.round(e.getBoundingClientRect().height / line); }));
    check(scene, 'its row name two lines at most', rowName.every(n => n <= 2), JSON.stringify(rowName));
    check(scene, 'long: inside 390', await outside390(q) === 0, String(await outside390(q)));
    await q.screenshot({ path: path.join(out, `${scene}-long.png`), fullPage: true });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await q.context().close();
  }
  }
  // ---- REQ-125 U2 (research/305): `file-versions` cells of a `/2` definition. 1920: the versions seen in words — "v1.0 9/17 (관측된
  // 첫 판)", "v2.0 … (다음 판 1개 관측)", "— 이전 판은 이 폴더에 없음", "날짜 여러 개", "형식 모름" — never "재작업"/"최초"; the
  // heading's 형식 모름 count and list (each file once); a version's evidence: its two formats, its document, the meaning line.
  // 390: the marks ● / ? / –, the evidence sheet. ko/en × light/dark. ----
  if (ONLY === '' || R125U2) {
  const tU2 = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const tsU2 = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const laneU2 = `[data-testid="swimlane-lane-section"]:has(${byId('lane-view-switch')})`;
  const cellU2 = (row, stage) => `${laneU2} ${byId('workflow-row-' + U1_ROOT + '/' + row)} ${byId('workflow-cell-' + stage)}`;
  const paper = (who, nn, ver, day, ext) => U1_ROOT + '/' + who + '/' + nn + '_' + U2_DOC + '_v' + ver + '_' + day + '.' + ext;
  const CHAIN = '{nn}_' + U2_DOC + '_v{ver}_{yyyymmdd}.{ext}';
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u2-1920-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-instver-' + lang));
    await p.waitForSelector(laneU2 + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, laneU2 + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(laneU2 + ' ' + byId('flow-canvas'), { timeout: 5000 }).catch(() => {});
    const names = await tsU2(p, laneU2 + ' ' + byId('workflow-rowname'));
    check(scene, 'rows by the latest day read: D사 9/23, B사 9/22, A사 9/18, then C사 (no day read)', JSON.stringify(names) === JSON.stringify(['D사', 'B사', 'A사', 'C사']), JSON.stringify(names));
    const cells = {};
    for (const [row, stage] of [['01_A사', 'docs'], ['01_A사', 'redo'], ['02_B사', 'docs'], ['02_B사', 'redo'], ['03_C사', 'docs'], ['04_D사', 'docs'], ['04_D사', 'redo']])
      cells[row + ' ' + stage] = await tU2(p, cellU2(row, stage));
    const want = {
      '01_A사 docs': 'v1.0 9/17 (' + m.versionFirst + ')', '01_A사 redo': 'v2.0 9/18 (' + m.versionNext(1) + ')',
      '02_B사 docs': 'v2.0 9/22 (' + m.versionFirst + ' — ' + m.versionNoEarlier + ')', '02_B사 redo': m.stateNoRecord,
      '03_C사 docs': m.stateUnknown + ' · 03_' + U2_DOC + '_v1.0_20260231.md',
      '04_D사 docs': 'v1.0 9/20 (' + m.versionFirst + ' · ' + m.daysMany + ')', '04_D사 redo': 'v1.1 9/23 (' + m.versionNext(1) + ')' };
    check(scene, 'the versions seen, in words: first seen, next seen, no earlier one here, several days, 형式 모름', JSON.stringify(cells) === JSON.stringify(want), JSON.stringify(cells));
    check(scene, 'never "rework" or "first written"', !Object.values(cells).some(v => /재작업|최초|rework|first written/i.test(v)));
    const warnColor = rgb((await style(p, cellU2('03_C사', 'docs') + ' div', ['color'])).color), verColor = rgb((await style(p, cellU2('01_A사', 'redo') + ' div', ['color'])).color);
    check(scene, 'cell words 4.5:1 (형식 모름, a version)', contrast(warnColor, c.surface0) >= 4.5 && contrast(verColor, c.surface2) >= 4.5,
      contrast(warnColor, c.surface0).toFixed(2) + ' ' + contrast(verColor, c.surface2).toFixed(2));
    check(scene, 'the heading: 형식 모름 1 (C사\'s file once, though two steps read it)', await tU2(p, laneU2 + ' ' + byId('workflow-unknown')) === m.workflowUnknownCount(1));
    check(scene, 'the step figures: 건 with a version', await tU2(p, laneU2 + ' ' + byId('flow-count-docs')) === m.countInstances(3) && await tU2(p, laneU2 + ' ' + byId('flow-count-redo')) === m.countInstances(2));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    await clickAt(p, laneU2 + ' ' + byId('workflow-unknown'));
    const unknown = await p.locator(laneU2 + ' ' + byId('workflow-unknown-list')).first().innerText().catch(() => '');
    check(scene, '형식 모름 list: C사\'s file', unknown.includes(paper('03_C사', '03', '1.0', '20260231', 'md')), unknown);
    await clickAt(p, cellU2('01_A사', 'docs'));
    const places = await tsU2(p, laneU2 + ' ' + byId('workflow-evidence-place'));
    check(scene, 'the evidence: v1.0\'s two formats, one version', places.length === 2 && places[0] === paper('01_A사', '02', '1.0', '20260917', 'docx') + ' · 2026-09-17'
      && places[1] === paper('01_A사', '02', '1.0', '20260917', 'pdf'), JSON.stringify(places));
    check(scene, 'the evidence: its document and how many versions it shows', await tU2(p, laneU2 + ' ' + byId('workflow-evidence-version')) === m.evidenceVersion('1.0', m.versionFirst, CHAIN) + ' · ' + m.versionsSeen(2));
    check(scene, 'the evidence says what versions mean (order seen, not rework)', await tU2(p, laneU2 + ' ' + byId('workflow-evidence-why')) === m.evidenceVersions);
    const why = rgb((await style(p, laneU2 + ' ' + byId('workflow-evidence-why'), ['color'])).color);
    check(scene, 'the meaning line 4.5:1', contrast(why, c.surface0) >= 4.5, contrast(why, c.surface0).toFixed(2));
    await clickAt(p, cellU2('04_D사', 'docs'));
    check(scene, 'D사\'s v1.0: earliest day, two days, two files', JSON.stringify(await tsU2(p, laneU2 + ' ' + byId('workflow-evidence-place')))
      === JSON.stringify([paper('04_D사', '01', '1.0', '20260920', 'md') + ' · 2026-09-20 · ' + m.evidenceDays(2), paper('04_D사', '01', '1.0', '20260921', 'hwp')]));
    await clickAt(p, cellU2('03_C사', 'docs'));
    check(scene, '형식 모름: why, and the file is no version', await tU2(p, laneU2 + ' ' + byId('workflow-evidence-why')) === m.evidenceUnknown
      && await tU2(p, laneU2 + ' ' + byId('workflow-evidence-version')) === m.evidenceVersionUnread);
    const unread = rgb((await style(p, laneU2 + ' ' + byId('workflow-evidence-version'), ['color'])).color);
    check(scene, 'the unread line 4.5:1', contrast(unread, c.surface0) >= 4.5, contrast(unread, c.surface0).toFixed(2));
    if (lang === 'en') check(scene, 'English: the version words in English', !/[가-힣]/.test(cells['01_A사 redo'] + cells['02_B사 docs'] + cells['04_D사 docs']));
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  const phoneU2 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const tapU2 = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u2-390-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext(phoneU2)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'wf-instver-' + lang));
    await p.waitForSelector(byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
    await tapU2(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('order-workflow'), { timeout: 5000 }).catch(() => {});
    await tapU2(p, byId('order-workflow'));
    await p.waitForSelector(byId('workflow-sheet') + ' ' + byId('ladder'), { timeout: 8000 }).catch(() => {});
    const marks = await p.locator('[data-testid^="mobile-workflow-row-"]').evaluateAll(els => els.map(e => [...e.querySelectorAll('[data-testid^="mobile-workflow-cell-"]')]
      .map(c => c.dataset.testid.slice(21) + ':' + c.innerText.trim()).join(' ')));
    check(scene, 'marks: ● a version, ? 형식 모름, – none', JSON.stringify(marks) === JSON.stringify(['docs:● redo:● submit:– agree:–', 'docs:● redo:– submit:– agree:–',
      'docs:● redo:● submit:● agree:●', 'docs:? redo:? submit:– agree:–']), JSON.stringify(marks));
    check(scene, 'the legend names ? 형식 모름', await tU2(p, byId('mobile-workflow-marks-legend')) === m.workflowInstanceMarksLegend);
    const q = await p.locator('[data-testid^="mobile-workflow-row-"] [data-testid="mobile-workflow-mark-unknown-format"]').count();
    check(scene, 'the ? marks are there (two cells of C사)', q === 2, String(q));
    if (q) {
      const glyph = rgb((await style(p, '[data-testid^="mobile-workflow-row-"] [data-testid="mobile-workflow-mark-unknown-format"] div', ['color'])).color);
      const disc = rgb((await style(p, '[data-testid^="mobile-workflow-row-"] [data-testid="mobile-workflow-mark-unknown-format"]', ['backgroundColor'])).backgroundColor);
      check(scene, 'the ? mark 3:1 on its disc', contrast(glyph, disc) >= 3, contrast(glyph, disc).toFixed(2));
    }
    const outside = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')]
      .filter(n => n.getBoundingClientRect().right > 391 && !n.closest('[data-testid="flow-scroll"], [data-testid="mobile-workflow-releases"], [data-testid="mobile-workflow-table-scroll"]')).length);
    check(scene, 'the sheet inside 390', outside === 0, String(outside));
    await p.screenshot({ path: path.join(out, `${scene}.png`), fullPage: true });
    await tapU2(p, byId('mobile-workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('mobile-workflow-cell-docs'));
    await p.waitForSelector(byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-version'), { timeout: 5000 }).catch(() => {});
    const places = await tsU2(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-place'));
    check(scene, 'the evidence sheet: step · 건, the meaning line, the two formats wrapped whole', (await tU2(p, byId('workflow-evidence-sheet') + ' [role="heading"]')) === '신청서·계획서 작성 · A사'
      && await tU2(p, byId('workflow-evidence-why')) === m.evidenceVersions && places.length === 2 && places[1] === paper('01_A사', '02', '1.0', '20260917', 'pdf'), JSON.stringify(places));
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-125 U3 (research/308): the "공통 · 모든 건" band of a `/2` definition. 1920: the band under the flow — one chip per common
  // step, its words as a 건's cell plus "규칙 충돌 N"; the step out of the table and its node chipped "공통"; the band the same
  // whichever 건 is chosen; a chip's evidence (said common, the copy inside A사 as 규칙 충돌); "제외 1" lists the copy. 390: the "공통"
  // box at the top of the ladder, its marks, its evidence sheet. ko/en × light/dark. ----
  if (ONLY === '' || R125U3) {
  const tU3 = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const tsU3 = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const laneU3 = `[data-testid="swimlane-lane-section"]:has(${byId('lane-view-switch')})`;
  const COPY = U1_ROOT + '/01_A사/01_공고문';
  const noticeLabel = u1Grant.stages.find(s => s.id === 'notice').ko, settleLabel = u1Grant.stages.find(s => s.id === 'settle').ko;
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u3-1920-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, false, 'wf-instprog-' + lang));
    await p.waitForSelector(laneU3 + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
    await clickAt(p, laneU3 + ' ' + byId('lane-view-workflow'));
    await p.waitForSelector(laneU3 + ' ' + byId('workflow-program'), { timeout: 5000 }).catch(() => {});
    const band = laneU3 + ' ' + byId('workflow-program');
    check(scene, 'the band\'s title', await tU3(p, band + ' ' + byId('workflow-program-title')) === m.programBand);
    const want = [noticeLabel + ' · ' + m.dataThere + ' · 01_공고문 · ' + m.programConflicts(1), settleLabel + ' · ' + m.stateNoRecord];
    const chips = [await tU3(p, band + ' ' + byId('workflow-program-notice')), await tU3(p, band + ' ' + byId('workflow-program-settle'))];
    check(scene, 'one chip per common step: its words as a 건\'s cell, and 규칙 충돌 1', JSON.stringify(chips) === JSON.stringify(want), JSON.stringify(chips));
    // Under the flow, over the table.
    const [flowBox, bandBox, tableBox] = await Promise.all([byId('workflow-flow'), byId('workflow-program'), byId('workflow-table')].map(sel => p.locator(laneU3 + ' ' + sel).first().boundingBox()));
    check(scene, 'the band sits under the flow and over the table', !!flowBox && !!bandBox && !!tableBox && bandBox.y >= flowBox.y + flowBox.height - 1 && bandBox.y + bandBox.height <= tableBox.y + 1,
      JSON.stringify([flowBox?.y, flowBox?.height, bandBox?.y, bandBox?.height, tableBox?.y]));
    const columns = await p.locator(laneU3 + ' ' + byId('workflow-row-' + U1_ROOT + '/01_A사') + ' [data-testid^="workflow-cell-"]').evaluateAll(els => els.map(e => e.dataset.testid));
    check(scene, 'common steps are in no table column', !columns.includes('workflow-cell-notice') && !columns.includes('workflow-cell-settle') && columns.includes('workflow-cell-docs'), JSON.stringify(columns));
    check(scene, 'the notice\'s node: chip "공통", its words inside', await tU3(p, laneU3 + ' ' + byId('flow-count-notice')) === m.programName
      && (await tsU3(p, laneU3 + ' ' + byId('flow-note-notice'))).join(' ') === m.dataThere + ' · 01_공고문', JSON.stringify(await tsU3(p, laneU3 + ' ' + byId('flow-note-notice'))));
    const chipFg = rgb((await style(p, band + ' ' + byId('workflow-program-text-found'), ['color'])).color), chipBg = rgb((await style(p, band + ' ' + byId('workflow-program-notice'), ['backgroundColor'])).backgroundColor);
    const mutedFg = rgb((await style(p, band + ' ' + byId('workflow-program-text-no-record'), ['color'])).color), titleFg = rgb((await style(p, band + ' ' + byId('workflow-program-title'), ['color'])).color);
    check(scene, 'band words 4.5:1 (found, 기록 없음, title)', contrast(chipFg, chipBg) >= 4.5 && contrast(mutedFg, chipBg) >= 4.5 && contrast(titleFg, c.surface0) >= 4.5,
      [contrast(chipFg, chipBg), contrast(mutedFg, chipBg), contrast(titleFg, c.surface0)].map(v => v.toFixed(2)).join(' '));
    check(scene, 'the heading: 제외 1 (the copy)', await tU3(p, laneU3 + ' ' + byId('workflow-excluded')) === m.workflowExcludedCount(1));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    await clickAt(p, laneU3 + ' ' + byId('workflow-excluded'));
    const list = await p.locator(laneU3 + ' ' + byId('workflow-excluded-list')).first().innerText().catch(() => '');
    check(scene, '제외 list: the copy — 규칙 충돌', list.includes(COPY + ' — ' + m.workflowExcludedWhy['rule-conflict']), list);
    await clickAt(p, laneU3 + ' ' + byId('workflow-excluded'));
    // The band is the same whichever 건 is chosen.
    await clickAt(p, laneU3 + ' ' + byId('workflow-row-' + U1_ROOT + '/01_A사') + ' [data-testid^="workflow-row-instance-"]');
    const rowB = await p.locator(laneU3 + ' [data-testid^="workflow-row-instance-"]').evaluateAll(els => els.map(e => e.getAttribute('aria-pressed')));
    check(scene, 'A사 chosen (it was B사, the first row)', JSON.stringify(rowB) === JSON.stringify(['false', 'true']), JSON.stringify(rowB));
    const after = [await tU3(p, band + ' ' + byId('workflow-program-notice')), await tU3(p, band + ' ' + byId('workflow-program-settle'))];
    check(scene, 'choosing another 건 leaves the band as it was', JSON.stringify(after) === JSON.stringify(want), JSON.stringify([after, rowB]));
    // 313-F3: A사's 접수·제출 found only the copy a common rule took — the table cell and the step on the flow say the same.
    const heldWords = m.stateNoRecord + ' · ' + m.programConflicts(1);
    const heldCell = await tU3(p, laneU3 + ' ' + byId('workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('workflow-cell-submit'));
    const heldFlow = (await tsU3(p, laneU3 + ' ' + byId('flow-note-submit'))).join(' ');
    check(scene, 'a step whose only file was the copy: "기록 없음 · 규칙 충돌 1" in the table and on the flow', heldCell === heldWords && heldFlow === heldWords, JSON.stringify([heldCell, heldFlow]));
    // 314-F4: a long folder name without spaces (Korean, English) beside the copy — the node's words in the table's order, the name's
    // text cut short, and "규칙 충돌 1" the last text of its own, wholly inside the node.
    for (const [stage, name] of [['perform', U3_LONG_KO], ['evaluate', U3_LONG_EN]]) {
      const cellWords = await tU3(p, laneU3 + ' ' + byId('workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('workflow-cell-' + stage));
      const first = laneU3 + ' ' + byId('flow-note-' + stage);
      const seen = await p.locator(first).last().evaluate((el, nodeSel) => {
        const node = el.closest('[data-testid^="flow-node-"]'), r = el.getBoundingClientRect(), n = node.getBoundingClientRect();
        // Its words may take two lines on a narrow node (out of 314-F4's scope, 314-J4); whole and inside the node is what counts.
        return { text: el.innerText.replace(/\s+/g, ' ').trim(), inside: r.height > 0 && r.top >= n.top - 0.5 && r.bottom <= n.bottom + 0.5 && el.scrollHeight <= el.clientHeight + 1 };
      }).catch(e => ({ text: String(e), inside: false }));
      const all = (await tsU3(p, first)).join(' ');
      check(scene, `a long name (${stage}): on the flow the table's words, "규칙 충돌 1" its own last text, whole inside the node`,
        seen.text === m.programConflicts(1) && seen.inside && all === m.dataThere + ' · ' + name + ' · ' + m.programConflicts(1)
        && cellWords === m.dataThere + ' · ' + name + ' · ' + m.programConflicts(1), JSON.stringify([seen, all, cellWords]));
      // U4b (stable-fa226af 미해결 1): the table's one-line cell — the long name cut short with its own "…", "규칙 충돌 1" whole and in sight.
      const cellSel = laneU3 + ' ' + byId('workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('workflow-cell-' + stage);
      const tail = await p.locator(cellSel + ' ' + byId('workflow-cell-tail')).first().evaluate(el => {
        const cellBox = el.closest('[data-testid^="workflow-cell-"][role="button"]') ?? el.closest('[data-testid^="workflow-cell-"]:not([data-testid^="workflow-cell-t"]):not([data-testid^="workflow-cell-h"])');
        const r = el.getBoundingClientRect(), c = cellBox.getBoundingClientRect(), head = el.parentElement.querySelector('[data-testid="workflow-cell-head"]');
        return { text: el.innerText.trim(), inside: r.width > 0 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && el.scrollWidth <= el.clientWidth + 1,
          headCut: head.scrollWidth > head.clientWidth + 1, overlap: head.getBoundingClientRect().right <= r.left + 0.5 };
      }).catch(e => ({ text: String(e) }));
      check(scene, `a long name (${stage}) in the table: " · 규칙 충돌 1" whole inside its cell, the name cut on its own`,
        tail.text === '· ' + m.programConflicts(1) && tail.inside && tail.headCut && tail.overlap, JSON.stringify(tail));
    }
    await clickAt(p, band + ' ' + byId('workflow-program-notice'));
    await p.waitForSelector(laneU3 + ' ' + byId('workflow-evidence'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the chip\'s evidence: step · 공통 · words', await tU3(p, laneU3 + ' ' + byId('workflow-evidence-title')) === noticeLabel + ' · ' + m.programName + ' · ' + m.dataThere + ' · 01_공고문');
    check(scene, 'the evidence says it is common', await tU3(p, laneU3 + ' ' + byId('workflow-evidence-program')) === m.evidenceProgram);
    check(scene, 'the evidence: the original, its data files', await tU3(p, laneU3 + ' ' + byId('workflow-evidence-place')) === '사업/01_공고문 · ' + m.evidenceFolder(1));
    check(scene, 'the evidence: the copy as 규칙 충돌', await tU3(p, laneU3 + ' ' + byId('workflow-evidence-conflict')) === COPY
      && (await tU3(p, laneU3 + ' ' + byId('workflow-evidence-conflicts'))).startsWith(m.evidenceConflict));
    const conflictFg = rgb((await style(p, laneU3 + ' ' + byId('workflow-evidence-conflicts') + ' div', ['color'])).color);
    check(scene, 'the conflict line 4.5:1', contrast(conflictFg, c.surface0) >= 4.5, contrast(conflictFg, c.surface0).toFixed(2));
    await clickAt(p, band + ' ' + byId('workflow-program-settle'));
    check(scene, 'a common step with nothing: why, never "not done"', await tU3(p, laneU3 + ' ' + byId('workflow-evidence-why')) === m.evidenceNoRecordProgram);
    if (lang === 'en') check(scene, 'English: the band in English', !/[가-힣]/.test(m.programBand + chips.join('').replace(noticeLabel, '').replace(settleLabel, '').replace('01_공고문', '')));
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  const phoneU3 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const tapU3 = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u3-390-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang);
    const p = await (await browser.newContext(phoneU3)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, true, 'wf-instprog-' + lang));
    await p.waitForSelector(byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
    await tapU3(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('order-workflow'), { timeout: 5000 }).catch(() => {});
    await tapU3(p, byId('order-workflow'));
    await p.waitForSelector(byId('workflow-sheet') + ' ' + byId('mobile-workflow-program'), { timeout: 8000 }).catch(() => {});
    const box = byId('workflow-sheet') + ' ' + byId('mobile-workflow-program');
    const [boxBox, ladderBox] = await Promise.all([box, byId('workflow-sheet') + ' ' + byId('ladder')].map(sel => p.locator(sel).first().boundingBox()));
    check(scene, 'the "공통" box at the top of the ladder', !!boxBox && !!ladderBox && boxBox.y + boxBox.height <= ladderBox.y + 1
      && await p.locator(byId('mobile-workflow-ladder') + ' ' + byId('mobile-workflow-program')).count() === 1, JSON.stringify([boxBox, ladderBox]));
    check(scene, 'its title', await tU3(p, box + ' ' + byId('mobile-workflow-program-title')) === m.programBand);
    const lines = await tsU3(p, box + ' [data-testid="mobile-workflow-program-text"]');
    const want = [m.dataThere + ' · 01_공고문 · ' + m.programConflicts(1), m.stateNoRecord];
    check(scene, 'its lines: words and 규칙 충돌 1, 기록 없음', JSON.stringify(lines) === JSON.stringify(want), JSON.stringify(lines));
    const marks = [await tU3(p, box + ' ' + byId('mobile-workflow-program-mark-found')), await tU3(p, box + ' ' + byId('mobile-workflow-program-mark-no-record'))];
    check(scene, 'its marks: ● data, – none', JSON.stringify(marks) === JSON.stringify(['●', '–']), JSON.stringify(marks));
    const glyph = rgb((await style(p, box + ' ' + byId('mobile-workflow-program-mark-found') + ' div', ['color'])).color);
    const disc = rgb((await style(p, box + ' ' + byId('mobile-workflow-program-mark-found'), ['backgroundColor'])).backgroundColor);
    const lineFg = rgb((await style(p, box + ' [data-testid="mobile-workflow-program-text"]', ['color'])).color), boxBg = rgb((await style(p, box, ['backgroundColor'])).backgroundColor);
    check(scene, 'the ● mark 3:1 on its disc, the line 4.5:1 on the box', contrast(glyph, disc) >= 3 && contrast(lineFg, boxBg) >= 4.5, contrast(glyph, disc).toFixed(2) + ' ' + contrast(lineFg, boxBg).toFixed(2));
    const cols = await p.locator(byId('mobile-workflow-row-' + U1_ROOT + '/01_A사') + ' [data-testid^="mobile-workflow-cell-"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(21)));
    check(scene, 'the marks table has no common column', JSON.stringify(cols) === JSON.stringify(['docs', 'redo', 'submit', 'evaluate', 'agree', 'perform']), JSON.stringify(cols));
    const outside = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')]
      .filter(n => n.getBoundingClientRect().right > 391 && !n.closest('[data-testid="flow-scroll"], [data-testid="mobile-workflow-releases"], [data-testid="mobile-workflow-table-scroll"]')).length);
    check(scene, 'the sheet inside 390', outside === 0, String(outside));
    await p.screenshot({ path: path.join(out, `${scene}.png`), fullPage: true });
    // The box is the same whichever 건 is chosen.
    await tapU3(p, byId('mobile-workflow-release-' + U1_ROOT + '/01_A사'));
    check(scene, 'choosing another 건 leaves the box as it was', JSON.stringify(await tsU3(p, box + ' [data-testid="mobile-workflow-program-text"]')) === JSON.stringify(want));
    // 313-F3: the ladder says A사's held-out step as the table does.
    const heldLadder = await tU3(p, byId('workflow-sheet') + ' ' + byId('ladder-note-submit'));
    check(scene, 'the ladder: A사\'s 접수·제출 "기록 없음 · 규칙 충돌 1"', heldLadder === m.stateNoRecord + ' · ' + m.programConflicts(1), heldLadder);
    // 314-F4: the phone says the table's words for the long names too.
    const longLadder = [await tU3(p, byId('workflow-sheet') + ' ' + byId('ladder-note-perform')), await tU3(p, byId('workflow-sheet') + ' ' + byId('ladder-note-evaluate'))];
    check(scene, 'the ladder: the long names, then "규칙 충돌 1"', JSON.stringify(longLadder) === JSON.stringify([U3_LONG_KO, U3_LONG_EN].map(n => m.dataThere + ' · ' + n + ' · ' + m.programConflicts(1))), JSON.stringify(longLadder));
    await tapU3(p, box + ' ' + byId('mobile-workflow-program-notice'));
    await p.waitForSelector(byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-program'), { timeout: 5000 }).catch(() => {});
    check(scene, 'the evidence sheet: step · 공통, said common, the copy as 규칙 충돌 (wrapped whole)',
      (await tU3(p, byId('workflow-evidence-sheet') + ' [role="heading"]')) === noticeLabel + ' · ' + m.programName
      && await tU3(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-program')) === m.evidenceProgram
      && await tU3(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-conflict')) === COPY);
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-125 U4a (research/316): a `/2` decision read from the 「건 기록」 section. 1920: the ◇ column in the table (A사 "예 · 10/1
  // 17:00 · 「건 기록」 기준", B사 "⚠ 모호 — 근거 2", C사 "기록 없음"), the flow drawing no branch of the decision though A사 has data on
  // both sides, the evidence (what it rests on, each piece), the heading's notes; a memo mixed in (every record cell ambiguous, the
  // note with its line) and the record past 2 MB (▨ 일부만 읽음). 390: the marks table's ◇ column (✓ ⚠ –), the ladder's ◇ line, the
  // evidence sheet, the notes inside 390. ko/en × light/dark. ----
  if (ONLY === '' || R125U4) {
  const tU4 = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const tsU4 = (p, sel) => p.locator(sel).evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const laneU4 = `[data-testid="swimlane-lane-section"]:has(${byId('lane-view-switch')})`;
  const rowU4 = name => byId('workflow-row-' + U1_ROOT + '/' + name);
  const selLabel = u1Grant.stages.find(s => s.id === 'selected').ko;
  const wantU4 = m => ({ a: m.answerYes + ' · 10/1 17:00 · ' + m.logBasis('건 기록'), b: '⚠ ' + m.stateAmbiguous(2), c: m.stateNoRecord });
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u4-1920-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang), want = wantU4(m);
    const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const open = async data => {
      await p.goto(page(mode, false, 'wf-' + data + '-' + lang));
      await p.waitForSelector(laneU4 + ' ' + byId('lane-view-workflow'), { timeout: 15000 });
      await clickAt(p, laneU4 + ' ' + byId('lane-view-workflow'));
      await p.waitForSelector(laneU4 + ' ' + byId('workflow-table'), { timeout: 5000 }).catch(() => {});
    };
    await open('instlog');
    const cols = await p.locator(laneU4 + ' ' + rowU4('01_A사') + ' [data-testid^="workflow-cell-"]:not([data-testid^="workflow-cell-text-"])').evaluateAll(els => els.map(e => e.dataset.testid.slice(14)));
    check(scene, 'the decision a record rule reads has its column, in the drawing\'s order (column, then row)', JSON.stringify(cols) === JSON.stringify(['skip', 'submit', 'supplement', 'selected', 'agree']), JSON.stringify(cols));
    const said = [await tU4(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected')), await tU4(p, laneU4 + ' ' + rowU4('02_B사') + ' ' + byId('workflow-cell-selected')),
      await tU4(p, laneU4 + ' ' + rowU4('03_C사') + ' ' + byId('workflow-cell-selected'))];
    check(scene, 'the ◇ cells: 확인됨 with its basis, 모호 with its count, 기록 없음', JSON.stringify(said) === JSON.stringify([want.a, want.b, want.c]), JSON.stringify(said));
    check(scene, 'A사\'s confirmed acts: 제출 · 9/19, 보완 제출 · 9/29', await tU4(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-submit')) === '제출 · 9/19 · ' + m.logBasis('건 기록')
      && await tU4(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-supplement')) === '보완 제출 · 9/29 · ' + m.logBasis('건 기록'));
    // U4b (309 4.2): A사's confirmed 예 — the decision passed, its 예 branch bold, the 아니오 branch and the line from 기관 평가 (no data) plain.
    // A line's thickness says it: 4px bold (the way), 2px plain — read from the drawn line, not a property.
    const lineW = async id => p.locator(laneU4 + ' ' + byId('flow-edge-' + id) + ' > div').first().evaluate(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height));
    const boldU4 = ids => Promise.all(ids.map(async id => (await lineW(id)) === 4 ? 'bold' : (await lineW(id)) === 2 ? 'plain' : String(id)));
    const edges = await boldU4(['selected-agree', 'selected-drop', 'evaluate-selected']);
    const rimU4 = async id => (await style(p, laneU4 + ' ' + byId('flow-node-' + id), ['borderTopWidth'])).borderTopWidth;
    const diamond = (await style(p, laneU4 + ' ' + byId('flow-node-selected') + ' > div', ['borderTopWidth'])).borderTopWidth;
    check(scene, 'U4b: the confirmed 예 — only its branch bold, the decision passed', JSON.stringify(edges) === JSON.stringify(['bold', 'plain', 'plain']) && diamond === '2px', JSON.stringify([edges, diamond]));
    check(scene, 'U4b: the 예 line drawn 4px, the 아니오 line 2px', await lineW('selected-agree') === 4 && await lineW('selected-drop') === 2, JSON.stringify([await lineW('selected-agree'), await lineW('selected-drop')]));
    // B사 (ambiguous) chosen: no line into or out of the decision.
    await clickAt(p, laneU4 + ' ' + rowU4('02_B사') + ' [data-testid^="workflow-row-instance-"]');
    const edgesB = await boldU4(['selected-agree', 'selected-drop', 'evaluate-selected']);
    const diamondB = (await style(p, laneU4 + ' ' + byId('flow-node-selected') + ' > div', ['borderTopWidth'])).borderTopWidth;
    check(scene, 'U4b: B사 (모호) — no branch bold, the decision not passed', edgesB.every(v => v === 'plain') && diamondB === '1px', JSON.stringify([edgesB, diamondB]));
    await clickAt(p, laneU4 + ' ' + rowU4('01_A사') + ' [data-testid^="workflow-row-instance-"]');
    const way = [await rimU4('submit'), await rimU4('supplement'), await rimU4('agree'), await rimU4('evaluate')];
    check(scene, 'A사\'s way: its confirmed record steps and its data bold, the others not', JSON.stringify(way) === JSON.stringify(['2px', '2px', '2px', '1px']), JSON.stringify(way));
    check(scene, 'the legend says only a confirmed answer\'s branch is bold', await tU4(p, laneU4 + ' ' + byId('workflow-legend')) === m.workflowInstanceLegendLog('A사'));
    const notes = await tsU4(p, laneU4 + ' ' + byId('workflow-log-note'));
    check(scene, 'the heading: a name no tag can hold', JSON.stringify(notes) === JSON.stringify(['⚠ ' + m.logUntaggable('[E]사')]), JSON.stringify(notes));
    const noteFg = rgb((await style(p, laneU4 + ' ' + byId('workflow-log-note'), ['color'])).color);
    check(scene, 'the note 4.5:1 on the panel', contrast(noteFg, c.panel) >= 4.5, contrast(noteFg, c.panel).toFixed(2));
    const ambFg = rgb((await style(p, laneU4 + ' ' + rowU4('02_B사') + ' ' + byId('workflow-cell-text-ambiguous'), ['color'])).color);
    check(scene, '모호 4.5:1 on the table', contrast(ambFg, c.surface0) >= 4.5, contrast(ambFg, c.surface0).toFixed(2));
    await p.screenshot({ path: path.join(out, `${scene}.png`) });
    // A사's answer: its title, what it rests on, its one piece.
    await clickAt(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected'));
    await p.waitForSelector(laneU4 + ' ' + byId('workflow-evidence'), { timeout: 5000 }).catch(() => {});
    check(scene, 'A사\'s evidence: title, basis, the tag line confirmed',
      await tU4(p, laneU4 + ' ' + byId('workflow-evidence-title')) === selLabel + ' · A사 · ' + want.a
      && await tU4(p, laneU4 + ' ' + byId('workflow-evidence-basis')) === m.evidenceLogBasis('건 기록')
      && await tU4(p, laneU4 + ' ' + byId('workflow-evidence-excerpt')) === '“- 2026-10-01 17:00 KST: [A사][선정]”'
      && await tU4(p, laneU4 + ' ' + byId('workflow-evidence-log')) === m.logConfirmed + ' · ' + m.answerYes
      && await tU4(p, laneU4 + ' ' + byId('workflow-evidence-place')) === 'STATE.md:9 · 2026-10-01 17:00 KST');
    await clickAt(p, laneU4 + ' ' + rowU4('02_B사') + ' ' + byId('workflow-cell-selected'));
    const logs = await tsU4(p, laneU4 + ' ' + byId('workflow-evidence-log'));
    check(scene, 'B사\'s evidence: why first, both pieces (the typo said)', await tU4(p, laneU4 + ' ' + byId('workflow-evidence-why')) === m.evidenceLogAmbiguous
      && JSON.stringify(logs) === JSON.stringify([m.logConfirmed + ' · ' + m.answerYes, m.logAmbiguous + ' — ' + m.logWhy['unknown-word']]), JSON.stringify(logs));
    const whyFg = rgb((await style(p, laneU4 + ' ' + byId('workflow-evidence-why'), ['color'])).color), logFg = rgb((await style(p, laneU4 + ' ' + byId('workflow-evidence-log') + ' >> nth=1', ['color'])).color);
    check(scene, 'the evidence\'s warnings 4.5:1', contrast(whyFg, c.surface0) >= 4.5 && contrast(logFg, c.surface0) >= 4.5, [contrast(whyFg, c.surface0), contrast(logFg, c.surface0)].map(v => v.toFixed(2)).join(' '));
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    await clickAt(p, laneU4 + ' ' + rowU4('03_C사') + ' ' + byId('workflow-cell-selected'));
    check(scene, 'C사: 기록 없음 is never "not done"', await tU4(p, laneU4 + ' ' + byId('workflow-evidence-why')) === m.evidenceLogNoRecord);
    if (lang === 'en') check(scene, 'English: the record words in English', !/[가-힣]/.test(m.answerYes + m.logBasis('x') + m.evidenceLogAmbiguous + m.workflowInstanceLegendLog('x')));
    // A memo mixed into the section: every record cell ambiguous, the note with the memo's line.
    await open('instlogmemo');
    const memo = await tsU4(p, laneU4 + ' ' + byId('workflow-log-note'));
    check(scene, 'memo: the note names the section, one piece of writing, line 12', memo[0] === '⚠ ' + m.logNotTagLines('건 기록', 1, '12'), JSON.stringify(memo));
    const memoCells = await p.locator(laneU4 + ' ' + rowU4('01_A사') + ' [data-testid^="workflow-cell-text-"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(19)));
    check(scene, 'memo: A사\'s record cells all ambiguous, its folder step still found', JSON.stringify(memoCells) === JSON.stringify(['ambiguous', 'ambiguous', 'ambiguous', 'ambiguous', 'found']), JSON.stringify(memoCells));
    check(scene, 'memo: A사\'s 접수·제출 is off its way, 협약·계약 still on it', await rimU4('submit') === '1px' && await rimU4('agree') === '2px');
    await clickAt(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected'));
    await p.waitForSelector(laneU4 + ' ' + byId('workflow-evidence'), { timeout: 5000 }).catch(() => {});
    check(scene, 'memo: the evidence says the writing and its line too, after why', await tU4(p, laneU4 + ' ' + byId('workflow-evidence-log-wrong')) === m.logNotTagLines('건 기록', 1, '12')
      && await tU4(p, laneU4 + ' ' + byId('workflow-evidence-why')) === m.evidenceLogAmbiguous);
    const memoLogs = await tsU4(p, laneU4 + ' ' + byId('workflow-evidence-log'));
    check(scene, 'memo: A사\'s pieces — its confirmed one, then the memo (every 건, no time)', JSON.stringify(memoLogs) === JSON.stringify([m.logConfirmed + ' · ' + m.answerYes,
      m.logAmbiguous + ' — ' + m.logWhy['not-a-tag-line'] + ' · ' + m.logEveryCase]), JSON.stringify(memoLogs));
    await p.screenshot({ path: path.join(out, `${scene}-memo.png`) });
    // The record past 2 MB: not read — 일부만 읽음, hatched (a dashed frame), and its evidence says why.
    await open('instlogcut');
    const cut = await tU4(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected'));
    const frame = (await style(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected'), ['borderTopStyle'])).borderTopStyle;
    check(scene, '2 MB+: ▨ 일부만 읽음 in a dashed frame', cut === '▨ ' + m.stateIncomplete && frame === 'dashed', JSON.stringify([cut, frame]));
    check(scene, '2 MB+: the heading says partly read', await tU4(p, laneU4 + ' ' + byId('workflow-limits')) === m.workflowLimits);
    await clickAt(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected'));
    check(scene, '2 MB+: the evidence says why, no answer', await tU4(p, laneU4 + ' ' + byId('workflow-evidence-why')) === m.evidenceLogIncomplete);
    await p.screenshot({ path: path.join(out, `${scene}-cut.png`) });
    // 317-F1: a long memo with emoji — the reply passes the SDK's check (this page checks it), every record cell ⚠, the excerpt whole graphemes.
    await open('instlogemoji');
    const emojiCells = [await tU4(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected')), await tU4(p, laneU4 + ' ' + rowU4('02_B사') + ' ' + byId('workflow-cell-selected'))];
    check(scene, 'emoji memo: the reply arrives and the ◇ cells are ambiguous, never the old 예', emojiCells.every(v => v.startsWith('⚠')) && !emojiCells.some(v => v.includes(m.answerYes + ' ·')), JSON.stringify(emojiCells));
    await clickAt(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected'));
    const quotes = await tsU4(p, laneU4 + ' ' + byId('workflow-evidence-excerpt'));
    const memoQuote = quotes.find(q => q.includes('🔴')) ?? '';
    check(scene, 'emoji memo: its excerpt keeps the emoji and ends cut with "…"', memoQuote.startsWith('“취소 정정 🔴') && memoQuote.endsWith('…”'), JSON.stringify(quotes));
    await p.screenshot({ path: path.join(out, `${scene}-emoji.png`) });
    // 317-F1: a reply the SDK refuses replaces the confirmed 예 with an error — the old answer never stays up unsaid.
    await open('instlog');
    check(scene, 'refused reply: first the confirmed 예', (await tU4(p, laneU4 + ' ' + rowU4('01_A사') + ' ' + byId('workflow-cell-selected'))) === want.a);
    await p.evaluate(v => { window.__FIXTURE__.workflow.wks_example01 = v; }, WF.instlogrefused);
    await clickAt(p, laneU4 + ' ' + byId('workflow-refresh'));
    await p.waitForSelector(laneU4 + ' ' + byId('workflow-error'), { timeout: 5000 }).catch(() => {});
    const failed = await tU4(p, laneU4 + ' ' + byId('workflow-error'));
    check(scene, 'refused reply: the error is said and the old ◇ cell is gone', failed === m.workflowFailedReply(1) && await p.locator(laneU4 + ' ' + byId('workflow-cell-selected')).count() === 0
      && await p.locator(laneU4 + ' ' + byId('workflow-refresh')).count() === 1, failed.slice(0, 160));
    // U4b (317 남은 것): the words a person reads — no JSON on the line; the check's text only under "자세히".
    check(scene, 'refused reply: no JSON on the error line, the details closed', !/[{}\[\]"]|too_big/.test(failed) && await p.locator(laneU4 + ' ' + byId('workflow-error-detail')).count() === 0, failed);
    await p.screenshot({ path: path.join(out, `${scene}-refused.png`) });
    await clickAt(p, laneU4 + ' ' + byId('workflow-error-more'));
    const detail = await tU4(p, laneU4 + ' ' + byId('workflow-error-detail'));
    check(scene, 'refused reply: "자세히" opens the first problem and the check\'s text', detail.startsWith(m.workflowFailedFirst('')) && /logShared\.0\.excerpt/.test(detail) && detail.includes('too_big')
      && await p.locator(laneU4 + ' ' + byId('workflow-error-more')).first().getAttribute('aria-expanded') === 'true', detail.slice(0, 160));
    const detailFg = rgb((await style(p, laneU4 + ' ' + byId('workflow-error-detail') + ' div', ['color'])).color), errFg = rgb((await style(p, laneU4 + ' ' + byId('workflow-error'), ['color'])).color);
    check(scene, 'refused reply: its words 4.5:1 on the panel', contrast(detailFg, c.panel) >= 4.5 && contrast(errFg, c.panel) >= 4.5, [contrast(detailFg, c.panel), contrast(errFg, c.panel)].map(v => v.toFixed(2)).join(' '));
    await p.screenshot({ path: path.join(out, `${scene}-refused-detail.png`) });
    // U4b (309 4.3): where a 건 ended — under its name; a held tag only on the evidence of the cell it rests on.
    await open('instlogend');
    const dropLabel = u1Grant.stages.find(s => s.id === 'drop').ko, skipLabel = u1Grant.stages.find(s => s.id === 'skip').ko;
    const ends = {};
    for (const name of ['01_A사', '02_B사', '03_C사', '04_D사']) ends[name] = await tU4(p, laneU4 + ' ' + rowU4(name) + ' ' + byId('workflow-endtag'));
    check(scene, 'end tags: B사 끝 미선정·철회 10/2, C사 끝 불참 9/22 15:04, none for A사 (예) and D사 (held)',
      JSON.stringify(ends) === JSON.stringify({ '01_A사': '', '02_B사': m.endTag(dropLabel, '10/2'), '03_C사': m.endTag(skipLabel, '9/22 15:04'), '04_D사': '' }), JSON.stringify(ends));
    const endBox = await p.locator(laneU4 + ' ' + rowU4('03_C사') + ' ' + byId('workflow-endtag')).first().evaluate(e => { const r = e.getBoundingClientRect(), b = e.closest('[data-testid^="workflow-row-instance-"]').getBoundingClientRect();
      return r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && e.scrollWidth <= e.clientWidth + 1; });
    check(scene, 'an end tag whole inside the name column', endBox);
    const endFg = rgb((await style(p, laneU4 + ' ' + rowU4('03_C사') + ' ' + byId('workflow-endtag'), ['color'])).color);
    check(scene, 'an end tag 4.5:1 on the table', contrast(endFg, c.surface0) >= 4.5, contrast(endFg, c.surface0).toFixed(2));
    const label = await p.locator(laneU4 + ' ' + rowU4('02_B사') + ' [data-testid^="workflow-row-instance-"]').first().getAttribute('aria-label');
    check(scene, 'the name\'s label holds its end tag', label === m.workflowShowInstance('B사') + ' · ' + m.endTag(dropLabel, '10/2'), label);
    await clickAt(p, laneU4 + ' ' + rowU4('02_B사') + ' [data-testid^="workflow-row-instance-"]');
    const edgesEnd = await boldU4(['selected-agree', 'selected-drop']);
    check(scene, 'B사 (아니오): only the 아니오 branch bold', JSON.stringify(edgesEnd) === JSON.stringify(['plain', 'bold']), JSON.stringify(edgesEnd));
    await p.screenshot({ path: path.join(out, `${scene}-end.png`) });
    await clickAt(p, laneU4 + ' ' + rowU4('02_B사') + ' ' + byId('workflow-cell-selected'));
    check(scene, 'B사\'s decision evidence: its end tag said', await tU4(p, laneU4 + ' ' + byId('workflow-evidence-end')) === m.endTag(dropLabel, '10/2'));
    await clickAt(p, laneU4 + ' ' + rowU4('04_D사') + ' ' + byId('workflow-cell-selected'));
    const held = await tU4(p, laneU4 + ' ' + byId('workflow-evidence-end-held'));
    check(scene, 'D사\'s decision evidence: why its tag is held (a folder with no date)', held === m.endHeld.undated(dropLabel, U1_ROOT + '/04_D사/10_선정·계약'), held);
    const heldFg = rgb((await style(p, laneU4 + ' ' + byId('workflow-evidence-end-held'), ['color'])).color);
    check(scene, 'the held reason 4.5:1', contrast(heldFg, c.surface0) >= 4.5, contrast(heldFg, c.surface0).toFixed(2));
    await p.screenshot({ path: path.join(out, `${scene}-end-held.png`) });
    // 325-J3: B사's 아니오 has two lines (미선정·철회, 불참) — no branch bold, no tag under its name, why on its decision's evidence; C사's own 철회 still tags.
    await open('instlogsplit');
    await clickAt(p, laneU4 + ' ' + rowU4('02_B사') + ' [data-testid^="workflow-row-instance-"]');
    const split = await boldU4(['selected-agree', 'selected-drop', 'selected-skip']);
    check(scene, '325-J3: a split answer — no branch of the decision bold', split.every(v => v === 'plain'), JSON.stringify(split));
    check(scene, '325-J3: no end tag under B사, C사 still tagged', await tU4(p, laneU4 + ' ' + rowU4('02_B사') + ' ' + byId('workflow-endtag')) === ''
      && await tU4(p, laneU4 + ' ' + rowU4('03_C사') + ' ' + byId('workflow-endtag')) === m.endTag(skipLabel, '9/22 15:04'));
    await clickAt(p, laneU4 + ' ' + rowU4('02_B사') + ' ' + byId('workflow-cell-selected'));
    const splitWhy = await tU4(p, laneU4 + ' ' + byId('workflow-evidence-end-held'));
    check(scene, '325-J3: B사\'s decision evidence says the answer splits', splitWhy === m.endHeld.branches(skipLabel, selLabel), splitWhy);
    await p.screenshot({ path: path.join(out, `${scene}-split.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  const phoneU4 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const tapU4 = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
  for (const [lang, mode] of [['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark']]) {
    const scene = `req125u4-390-${lang}-${mode}`, c = palette(PASEO_THEMES[mode]), m = copy(lang), want = wantU4(m);
    const p = await (await browser.newContext(phoneU4)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const open = async data => {
      await p.goto(page(mode, true, 'wf-' + data + '-' + lang));
      await p.waitForSelector(byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'), { timeout: 15000 });
      await tapU4(p, byId('mobile-workspace-' + a.id) + ' ' + byId('lane-order-menu'));
      await p.waitForSelector(byId('order-workflow'), { timeout: 5000 }).catch(() => {});
      await tapU4(p, byId('order-workflow'));
      await p.waitForSelector(byId('workflow-sheet') + ' ' + byId('mobile-workflow-table'), { timeout: 8000 }).catch(() => {});
    };
    await open('instlog');
    const cols = await p.locator(byId('mobile-workflow-row-' + U1_ROOT + '/01_A사') + ' [data-testid^="mobile-workflow-cell-"]').evaluateAll(els => els.map(e => e.dataset.testid.slice(21)));
    check(scene, 'the marks table has the ◇ column', JSON.stringify(cols) === JSON.stringify(['skip', 'submit', 'supplement', 'selected', 'agree']), JSON.stringify(cols));
    const marks = [];
    for (const name of ['01_A사', '02_B사', '03_C사']) marks.push(await tU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/' + name) + ' ' + byId('mobile-workflow-cell-selected')));
    check(scene, 'the ◇ marks: ✓ yes, ⚠ ambiguous, – none', JSON.stringify(marks) === JSON.stringify(['✓', '⚠', '–']), JSON.stringify(marks));
    const label = await p.locator(byId('mobile-workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('mobile-workflow-cell-selected')).first().getAttribute('aria-label');
    check(scene, 'the ✓ cell\'s label holds its words', label === m.workflowCellLabel(selLabel, 'A사', want.a), label);
    const glyphText = rgb((await style(p, byId('mobile-workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('mobile-workflow-cell-selected') + ' div div', ['color'])).color);
    const discOf = rgb((await style(p, byId('mobile-workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('mobile-workflow-cell-selected') + ' ' + byId('mobile-workflow-mark-found'), ['backgroundColor'])).backgroundColor);
    check(scene, 'the ✓ mark 3:1 on its disc', contrast(glyphText, discOf) >= 3, contrast(glyphText, discOf).toFixed(2));
    check(scene, 'the marks legend names ✓ and ✕', await tU4(p, byId('mobile-workflow-marks-legend')) === m.workflowInstanceMarksLegendLog);
    // The ladder: A사 (the first row) — the decision says its words; U4b: confirmed, it is passed and its 예 way is marked ✓.
    check(scene, 'the ladder\'s ◇ line: its words, passed (U4b)', await tU4(p, byId('workflow-sheet') + ' ' + byId('ladder-note-selected')) === want.a
      && await p.locator(byId('workflow-sheet') + ' ' + byId('ladder-step-selected')).first().getAttribute('aria-selected') === 'true');
    const agreeLabel = u1Grant.stages.find(s => s.id === 'agree').ko, dropLabelP = u1Grant.stages.find(s => s.id === 'drop').ko;
    const wayOn = await tsU4(p, byId('workflow-sheet') + ' ' + byId('ladder-way-on'));
    check(scene, 'the ladder: ✓ on the 예 way only', JSON.stringify(wayOn) === JSON.stringify(['✓ 선정 → ' + agreeLabel]), JSON.stringify(wayOn));
    const wayFg = rgb((await style(p, byId('workflow-sheet') + ' ' + byId('ladder-way-on'), ['color'])).color);
    check(scene, 'the ✓ way 4.5:1', contrast(wayFg, c.surface0) >= 4.5, contrast(wayFg, c.surface0).toFixed(2));
    check(scene, 'the ladder\'s legend', await tU4(p, byId('workflow-sheet') + ' ' + byId('workflow-legend')) === m.workflowInstanceLadderLegendLog('A사'));
    check(scene, 'the heading\'s note', JSON.stringify(await tsU4(p, byId('workflow-sheet') + ' ' + byId('workflow-log-note'))) === JSON.stringify(['⚠ ' + m.logUntaggable('[E]사')]));
    const outside = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')]
      .filter(n => n.getBoundingClientRect().right > 391 && !n.closest('[data-testid="flow-scroll"], [data-testid="mobile-workflow-releases"], [data-testid="mobile-workflow-table-scroll"]')).length);
    check(scene, 'the sheet inside 390', outside === 0, String(outside));
    await p.screenshot({ path: path.join(out, `${scene}.png`), fullPage: true });
    await tapU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/02_B사') + ' ' + byId('mobile-workflow-cell-selected'));
    await p.waitForSelector(byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-basis'), { timeout: 5000 }).catch(() => {});
    const logs = await tsU4(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-log'));
    check(scene, 'B사\'s evidence sheet: basis, why, both pieces', await tU4(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-basis')) === m.evidenceLogBasis('건 기록')
      && await tU4(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-why')) === m.evidenceLogAmbiguous
      && JSON.stringify(logs) === JSON.stringify([m.logConfirmed + ' · ' + m.answerYes, m.logAmbiguous + ' — ' + m.logWhy['unknown-word']]), JSON.stringify(logs));
    await p.screenshot({ path: path.join(out, `${scene}-evidence.png`) });
    await open('instlogmemo');
    const memo = await tsU4(p, byId('workflow-sheet') + ' ' + byId('workflow-log-note'));
    check(scene, 'memo: the note with its line, wrapped inside 390', memo[0] === '⚠ ' + m.logNotTagLines('건 기록', 1, '12'), JSON.stringify(memo));
    const memoMarks = [];
    for (const name of ['01_A사', '02_B사', '03_C사']) memoMarks.push(await tU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/' + name) + ' ' + byId('mobile-workflow-cell-selected')));
    check(scene, 'memo: every ◇ mark ⚠', JSON.stringify(memoMarks) === JSON.stringify(['⚠', '⚠', '⚠']), JSON.stringify(memoMarks));
    const outsideMemo = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')]
      .filter(n => n.getBoundingClientRect().right > 391 && !n.closest('[data-testid="flow-scroll"], [data-testid="mobile-workflow-releases"], [data-testid="mobile-workflow-table-scroll"]')).length);
    check(scene, 'memo: the sheet inside 390', outsideMemo === 0, String(outsideMemo));
    await p.screenshot({ path: path.join(out, `${scene}-memo.png`), fullPage: true });
    await open('instlogcut');
    const cutMarks = [];
    for (const name of ['01_A사', '02_B사']) cutMarks.push(await tU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/' + name) + ' ' + byId('mobile-workflow-cell-selected')));
    check(scene, '2 MB+: ▨ marks', JSON.stringify(cutMarks) === JSON.stringify(['▨', '▨']), JSON.stringify(cutMarks));
    await p.screenshot({ path: path.join(out, `${scene}-cut.png`), fullPage: true });
    // 317-F1 on the phone: the emoji memo's reply arrives (⚠ marks); a refused reply shows the error, not the old ✓.
    await open('instlogemoji');
    const emojiMarks = [];
    for (const name of ['01_A사', '02_B사']) emojiMarks.push(await tU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/' + name) + ' ' + byId('mobile-workflow-cell-selected')));
    check(scene, 'emoji memo: ⚠ marks, never ✓', JSON.stringify(emojiMarks) === JSON.stringify(['⚠', '⚠']), JSON.stringify(emojiMarks));
    await open('instlog');
    check(scene, 'refused reply: first ✓', (await tU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/01_A사') + ' ' + byId('mobile-workflow-cell-selected'))) === '✓');
    await p.evaluate(v => { window.__FIXTURE__.workflow.wks_example01 = v; }, WF.instlogrefused);
    await tapU4(p, byId('workflow-sheet') + ' ' + byId('workflow-refresh'));
    await p.waitForSelector(byId('workflow-sheet') + ' ' + byId('workflow-error'), { timeout: 5000 }).catch(() => {});
    const failedP = await tU4(p, byId('workflow-sheet') + ' ' + byId('workflow-error'));
    check(scene, 'refused reply: the error is said in words (no JSON) and the old ✓ is gone', failedP === m.workflowFailedReply(1) && !/[{}\[\]"]|too_big/.test(failedP)
      && await p.locator(byId('workflow-sheet') + ' ' + byId('mobile-workflow-cell-selected')).count() === 0, failedP.slice(0, 160));
    await tapU4(p, byId('workflow-sheet') + ' ' + byId('workflow-error-more'));
    const detailP = await tU4(p, byId('workflow-sheet') + ' ' + byId('workflow-error-detail'));
    check(scene, 'refused reply: "자세히" opens the check\'s text', detailP.includes('too_big'), detailP.slice(0, 120));
    const outsideErr = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')].filter(n => n.getBoundingClientRect().right > 391).length);
    check(scene, 'refused reply: the details inside 390', outsideErr === 0, String(outsideErr));
    await p.screenshot({ path: path.join(out, `${scene}-refused.png`), fullPage: true });
    // U4b (309 4.3): the end tags under the names; B사 chosen — the ladder marks its 아니오 way and the line down to 협약 is not bold.
    await open('instlogend');
    const endsP = {};
    for (const name of ['01_A사', '02_B사', '03_C사', '04_D사']) endsP[name] = await tU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/' + name) + ' ' + byId('mobile-workflow-endtag'));
    check(scene, 'end tags under the names: B사, C사; none for A사 and D사 (held)', JSON.stringify(endsP) === JSON.stringify({ '01_A사': '', '02_B사': m.endTag(dropLabelP, '10/2'),
      '03_C사': m.endTag(u1Grant.stages.find(s => s.id === 'skip').ko, '9/22 15:04'), '04_D사': '' }), JSON.stringify(endsP));
    const endFgP = rgb((await style(p, byId('mobile-workflow-row-' + U1_ROOT + '/03_C사') + ' ' + byId('mobile-workflow-endtag'), ['color'])).color);
    check(scene, 'an end tag 4.5:1', contrast(endFgP, c.surface0) >= 4.5, contrast(endFgP, c.surface0).toFixed(2));
    await tapU4(p, byId('mobile-workflow-release-' + U1_ROOT + '/02_B사'));
    const wayB = await tsU4(p, byId('workflow-sheet') + ' ' + byId('ladder-way-on'));
    check(scene, 'B사 chosen: ✓ on the 미선정 way', JSON.stringify(wayB) === JSON.stringify(['✓ 미선정 → ' + dropLabelP]), JSON.stringify(wayB));
    const outsideEnd = await p.evaluate(() => [...document.querySelectorAll('[data-testid="workflow-sheet"] *')]
      .filter(n => n.getBoundingClientRect().right > 391 && !n.closest('[data-testid="flow-scroll"], [data-testid="mobile-workflow-releases"], [data-testid="mobile-workflow-table-scroll"]')).length);
    check(scene, 'end tags: the sheet inside 390', outsideEnd === 0, String(outsideEnd));
    await p.locator(byId('workflow-sheet') + ' ' + byId('ladder-step-selected')).first().scrollIntoViewIfNeeded().catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-end-ladder.png`) });
    await p.locator(byId('mobile-workflow-row-' + U1_ROOT + '/03_C사')).first().scrollIntoViewIfNeeded().catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-end.png`) });
    await tapU4(p, byId('mobile-workflow-row-' + U1_ROOT + '/04_D사') + ' ' + byId('mobile-workflow-cell-selected'));
    await p.waitForSelector(byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-end-held'), { timeout: 5000 }).catch(() => {});
    check(scene, 'D사\'s evidence sheet: why its tag is held', await tU4(p, byId('workflow-evidence-sheet') + ' ' + byId('workflow-evidence-end-held')) === m.endHeld.undated(dropLabelP, U1_ROOT + '/04_D사/10_선정·계약'));
    await p.screenshot({ path: path.join(out, `${scene}-end-held.png`), fullPage: true });
    // 325-F1: the 미선정 line has no name — the ladder still lists it, by its answer, and marks it for B사 as the flow draws it.
    await open('instlognolabel');
    await tapU4(p, byId('mobile-workflow-release-' + U1_ROOT + '/02_B사'));
    const wayNo = await tsU4(p, byId('workflow-sheet') + ' ' + byId('ladder-way-on'));
    check(scene, '325-F1: an unnamed confirmed line is marked by its answer', JSON.stringify(wayNo) === JSON.stringify(['✓ ' + m.answerNo + ' → ' + dropLabelP]), JSON.stringify(wayNo));
    check(scene, '325-F1: the ways list both lines', await tU4(p, byId('workflow-sheet') + ' ' + byId('ladder-ways-selected')) === '선정 → ' + agreeLabel + ' · ✓ ' + m.answerNo + ' → ' + dropLabelP);
    await p.locator(byId('workflow-sheet') + ' ' + byId('ladder-step-selected')).first().scrollIntoViewIfNeeded().catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-nolabel.png`) });
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  // ---- REQ-138: the empty boards of archived or gone workspaces left out of the lanes, the list and the settings' workspace
  // list; the settings' "Hidden empty boards 1" and its switch show them again, and a shown one's ⋯ still opens its archived
  // cards. 1920 and 390, ko/en, light/dark (=req138).
  if (ONLY === '' || R138) {
  const t138 = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const phone138 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const paint138 = (p, sel) => p.locator(sel).first().evaluate(e => { const fg = getComputedStyle(e).color; let n = e, bg = 'rgba(0, 0, 0, 0)';
    while (n && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; } return { fg, bg }; });
  const cut138 = (p, sel) => p.locator(sel).evaluateAll(els => els.filter(e => e.innerText.trim() && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').map(e => e.innerText.trim()));
  const laneOf = name => `[data-testid="swimlane-lane-section"]:has(${byId('workspace-name-primary')}:text-is("${name}"))`;
  for (const wide of [true, false]) for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `req138-${wide ? 1920 : 390}-${lang}-${mode}`, m = copy(lang), W = wide ? 1920 : 390, H = wide ? 1080 : 844;
    const p = await (await browser.newContext(wide ? { viewport: { width: 1920, height: 1080 } } : phone138)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, !wide, 'req138-' + lang));
    const press = async sel => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); if (wide) await clickAt(p, sel); else await p.locator(sel).first().tap(); await p.waitForTimeout(400); };
    const lane = name => wide ? laneOf(name) : byId('mobile-workspace-' + (name === 'probe-ws' ? g138.id : l138.id));
    await p.waitForSelector(byId('open-settings'), { timeout: 15000 });
    if (!wide) await press(byId('mobile-tab-todo'));
    await p.waitForSelector(lane('left-ws'), { timeout: 10000 }).catch(() => {});
    // Hidden: no lane, no word of it anywhere on the board; the gone workspace with a live card stays.
    check(scene, 'the empty board of the gone workspace is not drawn', (await p.locator(lane('probe-ws')).count()) === 0
      && !(await p.locator('body').innerText()).includes('probe-ws'));
    check(scene, 'the gone workspace with a live card is drawn', (await p.locator(lane('left-ws')).count()) === 1);
    check(scene, 'the live workspaces are drawn', (await p.locator('body').innerText()).includes('Example Workspace'));
    await p.screenshot({ path: path.join(out, `${scene}-hidden.png`) });
    // The list screen leaves it out too.
    await press(wide ? byId('view-list') : byId('view-toggle'));
    await p.waitForSelector(byId('list-title-row'), { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(400);
    const listText = await p.locator('body').innerText();
    check(scene, 'the list: left out, the others listed', !listText.includes('probe-ws') && listText.includes('left-ws') && listText.includes('Example Workspace'));
    await press(wide ? byId('view-swimlane') : byId('view-toggle'));
    await p.waitForSelector(byId('open-settings'), { timeout: 8000 }).catch(() => {});
    // The settings: the automation's workspace list without it, then "Hidden empty boards 1" under About.
    await press(byId('open-settings'));
    await press(byId(wide ? 'settings-tab-automation' : 'settings-open-automation'));
    await p.waitForSelector(byId('auto-cards-workspace-list'), { timeout: 5000 }).catch(() => {});
    const autoNames = await p.locator(byId('auto-cards-workspace-list')).first().innerText().catch(() => '');
    check(scene, 'the automation list: left out, the others listed', !autoNames.includes('probe-ws') && autoNames.includes('left-ws') && autoNames.includes('Example Workspace'), autoNames.replace(/\s+/g, ' '));
    if (!wide) await press(byId('settings-back'));
    await press(byId(wide ? 'settings-tab-about' : 'settings-open-about'));
    await p.waitForSelector(byId('setting-hidden-boards'), { timeout: 5000 }).catch(() => {});
    const rowText = await t138(p, byId('setting-hidden-boards'));
    check(scene, 'About: "Hidden empty boards" with its count and help', rowText.includes(m.hiddenBoards) && rowText.includes(m.hiddenBoardsHelp)
      && await t138(p, byId('hidden-boards-count')) === m.hiddenBoardsCount(1), rowText);
    check(scene, 'the switch off, named for a screen reader', (await p.locator(byId('hidden-boards-toggle')).first().getAttribute('aria-checked')) === 'false'
      && (await p.locator(byId('hidden-boards-toggle')).first().getAttribute('aria-label')) === m.hiddenBoardsShow);
    const rb = await box(p, byId('setting-hidden-boards')), sb = await box(p, byId('hidden-boards-toggle'));
    check(scene, 'the row in the window, not cut', !!rb && rb.x >= 0 && rb.x + rb.width <= W + .5 && (await cut138(p, byId('setting-hidden-boards') + ' div')).length === 0, JSON.stringify(rb));
    if (!wide) check(scene, 'the switch reachable by a finger (8px slop around 40×22)', !!sb && sb.width >= 40 && sb.height >= 22, JSON.stringify(sb));
    for (const id of ['hidden-boards-count']) { const v = await paint138(p, byId(id)), r = contrast(rgb(v.fg), rgb(v.bg));
      check(scene, id + ' 4.5:1', r >= 4.5, r.toFixed(2)); }
    if (lang === 'en') check(scene, 'English: no Hangul in the row', !/[ᄀ-ᇿ㄰-㆏가-힣]/.test(rowText));
    await p.screenshot({ path: path.join(out, `${scene}-settings.png`) });
    // Shown again: the switch on, the lane back with its ⋯ opening the archived card; nothing written.
    await press(byId('hidden-boards-toggle'));
    check(scene, 'the switch on', (await p.locator(byId('hidden-boards-toggle')).first().getAttribute('aria-checked')) === 'true'
      && await t138(p, byId('hidden-boards-count')) === m.hiddenBoardsCount(1));
    await press(byId('settings-close'));
    await p.waitForSelector(lane('probe-ws'), { timeout: 8000 }).catch(() => {});
    check(scene, 'shown again: its lane drawn', (await p.locator(lane('probe-ws')).count()) === 1);
    await p.locator(lane('probe-ws')).first().scrollIntoViewIfNeeded().catch(() => {});
    await p.screenshot({ path: path.join(out, `${scene}-shown.png`) });
    await press(lane('probe-ws') + ' ' + byId('lane-order-menu'));
    await p.waitForSelector(byId('order-archived'), { timeout: 5000 }).catch(() => {});
    await press(byId('order-archived'));
    await p.waitForSelector(byId('archived-row-0'), { timeout: 5000 }).catch(() => {});
    const archivedTitles = await p.locator(byId('archived-sheet') + ' ' + byId('archived-title')).allInnerTexts();
    check(scene, 'its ⋯ still opens the archived card', JSON.stringify(archivedTitles) === JSON.stringify(['Probe check']), JSON.stringify(archivedTitles));
    const sheet = await box(p, byId('archived-sheet'));
    check(scene, 'the archived list in the window', !!sheet && sheet.x >= -.5 && sheet.x + sheet.width <= W + .5 && sheet.y + sheet.height <= H + .5, JSON.stringify(sheet));
    await p.screenshot({ path: path.join(out, `${scene}-archived.png`) });
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    if (await p.locator(byId('archived-sheet')).count()) { await press(byId('archived-sheet') + ' ' + byId('kanban-sheet-close')).catch(() => {}); }
    // The list screen shows it again too, from the same switch.
    await press(wide ? byId('view-list') : byId('view-toggle'));
    await p.waitForSelector(byId('list-title-row'), { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(400);
    check(scene, 'the list: shown again with the same switch', (await p.locator('body').innerText()).includes('probe-ws'));
    // Hidden again from the list screen's own settings.
    await press(byId('open-settings'));
    await press(byId(wide ? 'settings-tab-about' : 'settings-open-about'));
    await p.waitForSelector(byId('hidden-boards-toggle'), { timeout: 5000 }).catch(() => {});
    await press(byId('hidden-boards-toggle'));
    await press(byId('settings-close'));
    await p.waitForTimeout(300);
    check(scene, 'the list: hidden again', !(await p.locator('body').innerText()).includes('probe-ws'));
    check(scene, 'nothing written', (await p.evaluate(() => window.__writes.length)) === 0);
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }

  // ---- REQ-139: the Kanban screens' own size, 80/100/150% — the board, a card's ⋯ menu, a card's detail, the settings, the list,
  // the workflow (the gate's and a format-2 one by 건) on 1920 and 390, light and dark. Every size is measured against the same scene
  // at 100%: what is drawn grows by the size, stays inside the window and is not cut; the menu still opens at its ⋯ (=req139). ----
  // ---- REQ-142 (research/336) by real input: from the overview (in no workspace) "Go to agent ↗" asks first — [Cancel] opens
  // nothing, [Open] opens it; from the workspace panel its own board's agent opens at once. 1920 and 390, light and dark ----
  if (ONLY === '' || R142) {
  const opened142 = p => p.evaluate(() => window.__opened.slice());
  const routes142 = [['overview', 'en'], ['panel', 'en'], ['foreign', 'en'], ['foreign', 'ko']];
  for (const wide of [true, false]) for (const mode of ['light', 'dark']) for (const [where, lang] of routes142) {
    const W = wide ? 1920 : 390, H = wide ? 1080 : 844, scene = `req142-${W}-${mode}-${where}${lang === 'ko' ? '-ko' : ''}`, leadSel = `[aria-label="${Q_TITLE}"]`;
    const p = await (await browser.newContext(wide ? { viewport: { width: W, height: H } } : { viewport: { width: W, height: H }, hasTouch: true, isMobile: true })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.goto(page(mode, !wide, where === 'panel' ? 'lead-panel' : where === 'foreign' ? 'lead-panel-foreign' + (lang === 'ko' ? '-ko' : '') : 'lead'));
    if (!wide) { await p.waitForSelector(byId('mobile-tab-review'), { timeout: 15000 }); await p.locator(byId('mobile-tab-review')).first().tap(); await p.waitForTimeout(400); }
    await p.waitForSelector(leadSel, { timeout: 15000 }).catch(() => {});
    check(scene, 'the lead card is drawn', (await p.locator(leadSel).count()) > 0);
    // The card's ↗ on a wide screen (on hover), the long-press sheet's "Go to agent" on a phone.
    const jump = async () => {
      if (wide) {
        await away(p); await moveTo(p, leadSel);
        await p.waitForSelector(leadSel + ' ' + byId('card-jump'), { timeout: 3000 }).catch(() => {});
        await clickAt(p, leadSel + ' ' + byId('card-jump'));
      } else {
        await longPress(p, leadSel + ' ' + byId('card-title'));
        await p.waitForSelector(byId('card-menu-jump'), { timeout: 5000 }).catch(() => {});
        await p.locator(byId('card-menu-jump')).first().tap(); await p.waitForTimeout(400);
      }
    };
    const press = async sel => { if (wide) await clickAt(p, sel); else await p.locator(sel).first().tap(); await p.waitForTimeout(300); };
    await jump();
    if (where !== 'panel') {
      await p.waitForSelector(byId('agent-leave-sheet'), { timeout: 5000 }).catch(() => {});
      check(scene, 'asks first: the sheet, nothing opened yet', (await p.locator(byId('agent-leave-sheet')).count()) === 1 && (await opened142(p)).length === 0,
        JSON.stringify(await opened142(p)));
      const said = (await p.locator(byId('agent-leave-text')).first().innerText().catch(() => '')).trim();
      check(scene, 'the words', said === copy(lang).agentLeaveText, said);
      const sheet = await box(p, byId('agent-leave-sheet')), open = await box(p, byId('agent-leave-open')), cancel = await box(p, byId('agent-leave-cancel'));
      check(scene, 'inside the window, [Cancel] left of [Open]', !!sheet && sheet.x >= 0 && sheet.x + sheet.width <= W + .5 && sheet.y >= 0 && sheet.y + sheet.height <= H + .5
        && !!open && !!cancel && cancel.x + cancel.width <= open.x, JSON.stringify({ sheet, open, cancel }));
      if (!wide) check(scene, 'finger-sized buttons', !!open && open.height >= 44 && !!cancel && cancel.height >= 44, JSON.stringify({ open, cancel }));
      await p.screenshot({ path: path.join(out, `${scene}-ask.png`) });
      await press(byId('agent-leave-cancel'));
      await p.waitForSelector(byId('agent-leave-sheet'), { state: 'detached', timeout: 5000 }).catch(() => {});
      check(scene, '[Cancel] closes it and opens nothing', (await p.locator(byId('agent-leave-sheet')).count()) === 0 && (await opened142(p)).length === 0);
      await jump();
      await p.waitForSelector(byId('agent-leave-open'), { timeout: 5000 }).catch(() => {});
      await press(byId('agent-leave-open'));
      await p.waitForSelector(byId('agent-leave-sheet'), { state: 'detached', timeout: 5000 }).catch(() => {});
      check(scene, '[Open] opens the agent', JSON.stringify(await opened142(p)) === JSON.stringify([['agent', Q_LEAD]]) && (await p.locator(byId('agent-leave-sheet')).count()) === 0,
        JSON.stringify(await opened142(p)));
    } else {
      check(scene, 'its own workspace: opened at once, nothing asked', JSON.stringify(await opened142(p)) === JSON.stringify([['agent', Q_LEAD]])
        && (await p.locator(byId('agent-leave-sheet')).count()) === 0, JSON.stringify(await opened142(p)));
      await p.screenshot({ path: path.join(out, `${scene}-direct.png`) });
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
  if (ONLY === '' || R139) {
  const phone139 = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const cut139 = (p, sel) => p.locator(sel).evaluateAll(els => els.filter(e => e.innerText.trim() && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible'
    && getComputedStyle(e).textOverflow !== 'ellipsis').map(e => e.innerText.trim().slice(0, 40)));
  const inside139 = (b, W, H) => !!b && b.x >= -.5 && b.x + b.width <= W + .5 && b.y >= -.5 && b.y + b.height <= H + .5;
  const font139 = (p, sel) => p.locator(sel).first().evaluate(e => parseFloat(getComputedStyle(e).fontSize)).catch(() => NaN);
  const near = (a, b, tol = 1) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
  const base139 = {};
  for (const wide of [true, false]) for (const mode of ['light', 'dark']) for (const percent of [100, 80, 150]) {
    const W = wide ? 1920 : 390, H = wide ? 1080 : 844, k = percent / 100, scene = `req139-${W}-${mode}-${percent}`, m = copy('ko'), key = W + mode;
    const p = await (await browser.newContext(wide ? { viewport: { width: W, height: H } } : phone139)).newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const press = async sel => { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); if (wide) await clickAt(p, sel); else await p.locator(sel).first().tap(); await p.waitForTimeout(450); };
    const shot = name => p.screenshot({ path: path.join(out, `${scene}-${name}.png`) });
    await p.goto(page(mode, !wide, 'req139-' + percent));
    await p.waitForSelector(byId('open-settings'), { timeout: 15000 });
    await p.waitForSelector('[aria-label="Card one"]', { timeout: 10000 }).catch(() => {});
    await p.waitForTimeout(400);
    // The board: its sizes against 100%, nothing past the window's sides but the board's own sideways scroll.
    const title = await font139(p, byId('card-title')), card = await box(p, '[aria-label="Card one"]');
    const settingsGlyph = await box(p, byId('open-settings')), pageWide = await p.evaluate(() => document.documentElement.scrollWidth);
    if (percent === 100) base139[key] = { title, card, settingsGlyph };
    const b0 = base139[key];
    check(scene, 'the card title at the size', near(title, b0.title * k, .05), title + ' vs ' + b0.title + ' × ' + k);
    // A phone's card fills the screen's width (less the scaled padding), so there only its height follows the size.
    check(scene, 'a card\'s box at the size', !!card && (wide ? near(card.width, b0.card.width * k, 1) : card.x >= 0 && card.x + card.width <= W)
      && near(card.height, b0.card.height * k, 1.5), JSON.stringify({ card, base: b0.card }));
    check(scene, 'the ⚙ glyph at the size', !!settingsGlyph && near(settingsGlyph.width, b0.settingsGlyph.width * k, 1), JSON.stringify(settingsGlyph));
    check(scene, 'the page itself never wider than the window', pageWide <= W + 1, String(pageWide));
    // The title of the top row: whole on the screen, never under the glyphs (a phone gives it a line of its own when they leave no room).
    const titleRow139 = async (row, glyph) => { const t = await box(p, byId(row) + ' div[dir="auto"]'), g = await box(p, byId(glyph));
      return { ok: !!t && !!g && t.x >= -.5 && t.width >= 20 && (t.x + t.width <= g.x + .5 || t.y + t.height <= g.y + .5), t, g }; };
    if (!wide) { const r = await titleRow139('mobile-appbar', 'open-filters'); check(scene, 'the title clear of the glyphs', r.ok, JSON.stringify(r)); }
    await away(p);
    await shot('board');
    // A card's ⋯ menu (wide): opens right under its ⋯, inside the window — what is measured is where it is drawn.
    if (wide) {
      await moveTo(p, '[aria-label="Card one"]');
      const dots = await clickAt(p, '[data-testid="card-shadow"]:has([aria-label="Card one"]) ' + byId('card-move-menu')).catch(() => null);
      await p.waitForSelector(byId('card-menu'), { timeout: 5000 }).catch(() => {});
      const menu = await box(p, byId('card-menu'));
      check(scene, 'the ⋯ menu under its ⋯, right edges lined up', !!dots && !!menu && menu.y >= dots.y + dots.height - 1 && near(menu.x + menu.width, dots.x + dots.width, 1.5), JSON.stringify({ dots, menu }));
      check(scene, 'the ⋯ menu inside the window', inside139(menu, W, H), JSON.stringify(menu));
      await shot('menu');
      await escapeFrom(p, 'card-menu-modal'); await p.waitForTimeout(300);
      // A glyph's tip: under the glyph, centred on it or kept inside the window.
      const glyph = await moveTo(p, byId('open-settings')), tip = await box(p, byId('icon-tooltip'));
      check(scene, 'a glyph\'s tip under it, inside the window', !!tip && tip.y >= glyph.y + glyph.height - 1 && inside139(tip, W, H), JSON.stringify({ glyph, tip }));
      await away(p);
    }
    // A card's detail: inside the window, its sizes at the size.
    await press('[aria-label="Card one"]');
    await p.waitForSelector(byId('detail-stage'), { timeout: 8000 }).catch(() => {});
    const detailBox = wide ? 'desktop-detail-dialog' : 'editor-sheet', sheet = await box(p, byId(detailBox));
    check(scene, 'the detail inside the window', inside139(sheet, W, H), JSON.stringify(sheet));
    check(scene, 'the detail\'s rows not cut', (await cut139(p, byId(detailBox) + ' div[dir="auto"]')).length === 0, JSON.stringify(await cut139(p, byId(detailBox) + ' div[dir="auto"]')));
    await shot('detail');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    if (await p.locator(byId(detailBox)).count()) await press(byId(detailBox) + ' ' + byId('sheet-close')).catch(() => {});
    await p.waitForTimeout(300);
    // The settings: Display's size row says the size; the window and the row inside the window; nothing cut.
    await press(byId('open-settings'));
    if (!wide) await press(byId('settings-open-display'));
    await p.waitForSelector(byId('setting-ui-scale'), { timeout: 5000 }).catch(() => {});
    const value = (await p.locator(byId('ui-scale-value')).first().innerText().catch(() => '')).trim();
    check(scene, 'the row says the size', value === percent + '%', value);
    const win = await box(p, byId(wide ? 'settings-window' : 'settings-sheet')), row = await box(p, byId('setting-ui-scale')), control = await box(p, byId('ui-scale-control'));
    check(scene, 'the settings inside the window', inside139(win, W, H), JSON.stringify(win));
    check(scene, 'the size row and its control inside the settings', !!row && !!control && control.x >= win.x - .5 && control.x + control.width <= win.x + win.width + .5, JSON.stringify({ win, row, control }));
    check(scene, 'the size row not cut', (await cut139(p, byId('setting-ui-scale') + ' div[dir="auto"]')).length === 0);
    const choices139 = await p.locator('[data-testid^="theme-"][role="radio"], [data-testid^="board-align-"][role="radio"], ' + byId('ui-scale-reset'))
      .evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { id: e.dataset.testid, x: r.x, right: r.right }; })).catch(() => []);
    check(scene, 'every choice of the display rows inside the settings', choices139.length >= 4 && choices139.every(v => v.x >= win.x - .5 && v.right <= win.x + win.width + .5), JSON.stringify(choices139));
    const off139 = async id => (await p.locator(byId(id)).first().getAttribute('aria-disabled')) === 'true';
    check(scene, 'the ends turn their step off', await off139('ui-scale-larger') === (percent === 150) && await off139('ui-scale-smaller') === (percent === 80)
      && await off139('ui-scale-reset') === (percent === 100));
    await shot('settings');
    if (percent === 100) {
      // Real presses: "+" saves 110 and the screen behind redraws at it; "Back to 100%" puts it back.
      await press(byId('ui-scale-larger')); await p.waitForTimeout(300);
      const after = await font139(p, byId('card-title'));
      check(scene, '"+" saves 110 and the screen redraws at it', JSON.stringify(await p.evaluate(() => window.__writes.at(-1)?.settings)) === '{"uiScale":110}'
        && near(after, title * 1.1, .05) && (await p.locator(byId('ui-scale-value')).first().innerText()).trim() === '110%', String(after));
      await shot('settings-110');
      await press(byId('ui-scale-reset')); await p.waitForTimeout(300);
      check(scene, '"Back to 100%" saves 100 and redraws', JSON.stringify(await p.evaluate(() => window.__writes.at(-1)?.settings)) === '{"uiScale":100}' && near(await font139(p, byId('card-title')), title, .05));
    }
    await press(byId('settings-close'));
    await p.waitForTimeout(300);
    // The list.
    await press(wide ? byId('view-list') : byId('view-toggle'));
    await p.waitForSelector(byId('list-title-row'), { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(400);
    check(scene, 'the list: the page not wider than the window', (await p.evaluate(() => document.documentElement.scrollWidth)) <= W + 1);
    if (!wide) { const r = await titleRow139('list-title-row', 'projects-button'); check(scene, 'the list: the title clear of the glyphs', r.ok, JSON.stringify(r)); }
    await shot('list');
    await press(wide ? byId('view-swimlane') : byId('view-toggle'));
    await p.waitForSelector(byId('open-settings'), { timeout: 8000 }).catch(() => {});
    // The workflow: the gate's (format 1), then a format-2 one by 건 — on a wide lane, or the phone's ladder sheet.
    for (const data of ['gate', 'instlogend']) {
      if (data !== 'gate') { await p.goto(page(mode, !wide, 'req139-' + percent + '-' + data)); await p.waitForSelector(byId('open-settings'), { timeout: 15000 }); }
      if (wide) {
        const wfLane = `[data-testid="swimlane-lane-section"]:has(${byId('lane-view-switch')})`;
        await p.waitForSelector(wfLane + ' ' + byId('lane-view-workflow'), { timeout: 15000 }).catch(() => {});
        await clickAt(p, wfLane + ' ' + byId('lane-view-workflow')).catch(() => {});
        await p.waitForSelector(byId('flow-canvas'), { timeout: 8000 }).catch(() => {});
        const canvas = await box(p, byId('flow-canvas'));
        const nodes = await p.locator('[data-testid^="flow-node-"]').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, h: r.height }; }));
        check(scene, data + ': the flow drawn, its steps inside it', !!canvas && nodes.length > 0 && nodes.every(n => n.x >= canvas.x - .5 && n.right <= canvas.x + canvas.width + .5 && n.bottom <= canvas.y + canvas.height + .5), JSON.stringify({ canvas, n: nodes.length }));
        check(scene, data + ': a step at least the scaled 44px', nodes.every(n => n.h >= 44 * k - .5), JSON.stringify(nodes.map(n => n.h)));
        const overlap = nodes.some((a, i) => nodes.some((b, j) => j > i && a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1));
        check(scene, data + ': no two steps overlap', !overlap);
        await p.locator(byId('workflow-table')).first().scrollIntoViewIfNeeded().catch(() => {});
        await away(p);
        await shot('workflow-' + data);
      } else {
        const lane = `[data-testid^="mobile-workspace-"]:has(${byId('lane-order-menu')})`;
        await p.waitForSelector(lane, { timeout: 15000 }).catch(() => {});
        await press(lane + ' ' + byId('lane-order-menu')).catch(() => {});
        await p.waitForSelector(byId('order-workflow'), { timeout: 5000 }).catch(() => {});
        await press(byId('order-workflow')).catch(() => {});
        await p.waitForSelector(byId('mobile-workflow-ladder'), { timeout: 8000 }).catch(() => {});
        const ws = await box(p, byId('workflow-sheet')), ladder = await box(p, byId('mobile-workflow-ladder'));
        check(scene, data + ': the ladder sheet inside the window', inside139(ws, W, H) && !!ladder && ladder.x >= -.5 && ladder.x + ladder.width <= W + .5, JSON.stringify({ ws, ladder }));
        const sideways = await p.locator(byId('mobile-workflow-ladder')).evaluate(el => [...el.querySelectorAll('*')].filter(n => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'visible'
          && getComputedStyle(n).textOverflow !== 'ellipsis').length).catch(() => -1);
        check(scene, data + ': nothing in the ladder cut sideways', sideways === 0, String(sideways));
        await shot('workflow-' + data);
      }
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await p.context().close();
  }
  }
} catch (error) {
  // J3′: a scene that throws (a wait that timed out) is reported with the checks so far, not lost with them.
  check('runner', 'stopped by an error', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
} finally {
  await browser.close();
  // KANBAN_WEB_KEEP=1 leaves the built pages (page.js and each fixture's html) for a gate's own screenshots at other sizes.
  if (process.env.KANBAN_WEB_KEEP === '1') console.log('pages kept in ' + dir); else fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
fs.writeFileSync(path.join(out, 'medal.json'), JSON.stringify(medalLog, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2) + '\n');
console.log(`web: ${results.length - failed.length}/${results.length} passed → ${path.relative(root, out)}/result.json`);
process.exit(failed.length ? 1 : 0);
