import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createDemoData, demoSignals, mutationAllowed } from '../dist/client/demo.js';
import { SIGNAL_BUCKETS, boardAgentIds, bucketRank, signalBucket, summarizeSignals, summaryKey } from '../dist/client/signal-model.js';
import { swimlaneModel, collapseProject } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { normalizeSearch, matchesSearch, matchesLabels, filterCount, visibleProjects } from '../dist/client/filter-model.js';
import { projectChoices, projectSelection } from '../dist/client/visual-model.js';
import { readWorkspaceLabels } from '../dist/server/workspace-labels.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { workspaceLabelColor, palette } from '../dist/client/palette.js';
import { fixture, add, request } from './helpers.mjs';

test('demo is deterministic client data with six projects/thirteen workspaces, diverse lanes and no real ledger IDs', () => {
  const a = createDemoData(), b = createDemoData(); assert.deepEqual(a, b);
  assert.equal(a.boards.length, 13); assert.equal(new Set(Object.values(a.directory).map(w => w.projectId)).size, 6);
  const cards = a.boards.flatMap(b => b.stages.flatMap(s => s.cards));
  for (const predicate of [c => c.blocked, c => c.intent === 'draft', c => c.awaiting === 'user', c => /한글/.test(c.title)])
    assert.ok(cards.some(predicate));
  assert.ok(a.boards.some(b => b.stages.every(s => !s.cards.length)));
  assert.ok(a.boards.some(b => b.stages.slice(0, 3).every(s => !s.cards.length) && b.stages[3].cards.length === 12));
  assert.ok(a.boards.every(b => (b.summary.id.startsWith('demo_') || b.summary.id.startsWith('empty:demo_')) && b.summary.cwd.startsWith('demo://')));
  // REQ-57 ⑥: two workspaces have no board at all — one inside a project that has cards, one on its own.
  const pending = a.boards.filter(b => b.summary.hasLedger === false);
  assert.equal(pending.length, 2);
  assert.ok(pending.every(b => b.stages.length === 4 && b.stages.every(s => !s.cards.length) && b.summary.progress.percent === null));
  assert.equal(new Set(pending.map(b => a.directory[b.summary.workspaceId].projectId)).size, 2);
  assert.equal(a.boards.filter(b => b.summary.hasLedger !== false && b.stages.every(s => !s.cards.length)).length, 1);
  assert.ok(a.workspaceLabels.definitions.length > 1);
  assert.deepEqual(createDemoData('ko').boards[0].template.stages.map(s => s.name), ['대기', '진행', '검토', '완료']);
});
test('projects form one group each with aggregate progress/attention, and the flat list holds every lane once', () => {
  const d = createDemoData(), model = swimlaneModel(d.boards, d.directory, [], false);
  assert.equal(model.groups.length, 6); assert.equal(model.groups.reduce((n, g) => n + g.workspaceCount, 0), 13);
  // REQ-75 A1: a one-workspace project is no longer "merged"; the flat board lists all 13 lanes on their own.
  assert.equal(model.groups.filter(g => g.workspaceCount === 1).length, 2);
  assert.equal(model.groups.some(g => 'merged' in g), false);
  assert.equal(model.lanes.length, 13);
  assert.deepEqual(new Set(model.lanes.map(l => l.board.summary.id)), new Set(model.groups.flatMap(g => g.lanes.map(l => l.board.summary.id))));
  // REQ-57 ⑤: card-less lanes sink to the bottom of their project, and a project with only
  // card-less lanes sorts after the projects that have cards.
  for (const group of model.groups) {
    const totals = group.lanes.map(l => l.total);
    assert.deepEqual(totals, [...totals].sort((x, y) => Number(y > 0) - Number(x > 0)));
  }
  const firstEmptyGroup = model.groups.findIndex(g => g.lanes.every(l => l.total === 0));
  assert.equal(firstEmptyGroup, model.groups.length - 1);
  assert.ok(model.groups.slice(0, -1).every(g => g.lanes.some(l => l.total > 0)));
  for (const group of model.groups) {
    const members = d.boards.filter(b => d.directory[b.summary.workspaceId].projectId === group.projectId);
    assert.equal(group.progress.done, members.reduce((n, b) => n + b.summary.progress.done, 0));
    assert.equal(group.progress.requested, members.reduce((n, b) => n + b.summary.progress.requested, 0));
    assert.equal(group.attention, group.lanes.reduce((n, l) => n + l.attention, 0));
    assert.equal(group.progress.percent, group.progress.requested ? Math.floor(group.progress.done * 100 / group.progress.requested) : null);
  }
  assert.equal(model.groups[0].attentionSection, true);
});
test('project folding propagates to every child and preserves unrelated project choices', () => {
  const d = createDemoData(), group = swimlaneModel(d.boards, d.directory, [], false).groups[0];
  const old = { unrelated: { collapsed: false, expanded: true } };
  const folded = collapseProject({}, old, group, true);
  assert.ok(group.boardIds.every(id => folded.lanes[id].collapsed && folded.lanes[id].attentionCollapsed));
  assert.deepEqual(folded.lanes.unrelated, old.unrelated); assert.deepEqual(Object.keys(old), ['unrelated']);
  const view = swimlaneModel(d.boards, d.directory, [], false, folded.lanes, { projects: folded.projects });
  const g = view.groups.find(g => g.key === group.key); assert.equal(g.collapsed, true);
  assert.ok(g.lanes.every(l => l.collapsed && l.cells.every(c => !c.cards.length)));
  const opened = collapseProject(folded.projects, folded.lanes, group, false);
  assert.ok(group.boardIds.every(id => !opened.lanes[id].collapsed));
});
test('project hiding, attention and search combine with AND (selected labels are OR-ed within) and omit empty groups', () => {
  const d = createDemoData(), board = d.boards[0], project = d.directory[board.summary.workspaceId].projectId;
  const others = [...new Set(Object.values(d.directory).map(w => w.projectId))].filter(id => id !== project);
  const options = { labels: ['explore', 'prototype'], query: 'SKETCH workflow', workspaceLabels: d.workspaceLabels };
  const result = swimlaneModel(d.boards, d.directory, others, true, {}, options);
  assert.equal(result.groups.length, 1); assert.ok(result.groups[0].lanes.length > 0);
  for (const lane of result.groups[0].lanes) {
    assert.ok(matchesLabels(lane.board.summary.workspaceId, options.labels, d.workspaceLabels));
    const cards = lane.cells.flatMap(c => c.cards); assert.ok(cards.length > 0);
    assert.ok(cards.every(c => matchesSearch(c, options.query) && (c.awaiting === 'user' || c.blocked || c.intent === 'draft')));
  }
  assert.equal(swimlaneModel(d.boards, d.directory, others, true, {}, { ...options, query: 'never matching phrase' }).groups.length, 0);
  // REQ-57 ①: a card-less lane stays listed on its own, and hiding other projects never removes it;
  // only a real card filter (search/attention/labels) may drop it.
  const empty = d.boards.find(b => b.stages.every(s => !s.cards.length));
  assert.ok(swimlaneModel([empty], d.directory, [], false).groups.length);
  assert.ok(swimlaneModel([empty], d.directory, others.filter(id => id !== d.directory[empty.summary.workspaceId].projectId), false).groups.length);
  assert.equal(swimlaneModel([empty], d.directory, [d.directory[empty.summary.workspaceId].projectId], false).groups.length, 0);
  assert.equal(swimlaneModel([empty], d.directory, [], false, {}, { query: 'anything' }).groups.length, 0);
  assert.equal(filterCount({ hiddenProjects: others, labels: options.labels, attention: true, query: ' test ' }), 5);
});
test('selecting several labels keeps workspaces with any of them and still ANDs with other filters', () => {
  const data = { available: true, source: 'api', definitions: [], byWorkspace: { a: ['Explore'], b: ['Prototype'], c: ['Polish'], d: [] } };
  const pick = names => ['a', 'b', 'c', 'd'].filter(id => matchesLabels(id, names, data));
  assert.deepEqual(pick(['explore']), ['a']); assert.deepEqual(pick(['explore', 'prototype']), ['a', 'b']);
  assert.deepEqual(pick([' POLISH ', 'explore']), ['a', 'c']); assert.deepEqual(pick([]), ['a', 'b', 'c', 'd']);
  assert.equal(matchesLabels('d', ['explore'], { ...data, available: false }), true);
  const d = createDemoData(), lanes = names => swimlaneModel(d.boards, d.directory, [], false, {}, { labels: names, workspaceLabels: d.workspaceLabels })
    .groups.flatMap(g => g.lanes).map(l => l.board.summary.workspaceId);
  const explore = lanes(['explore']), polish = lanes(['polish']), both = lanes(['explore', 'polish']);
  assert.ok(explore.length && polish.length); assert.deepEqual([...both].sort(), [...new Set([...explore, ...polish])].sort());
  assert.ok(both.length > Math.max(explore.length, polish.length));
  const attention = swimlaneModel(d.boards, d.directory, [], true, {}, { labels: ['explore', 'polish'], workspaceLabels: d.workspaceLabels })
    .groups.flatMap(g => g.lanes);
  assert.ok(attention.length > 0 && attention.length < both.length);
  assert.equal(filterCount({ hiddenProjects: [], labels: ['explore', 'polish'], attention: false, query: '' }), 2);
});
test('search handles Latin case, composed Korean and whitespace, searches nextAction but never absent notes', () => {
  assert.equal(normalizeSearch('  ReVIEW\n 계획  '), 'review 계획');
  assert.equal(normalizeSearch('계획'.normalize('NFD')), '계획');
  const card = { title: 'Review 계획', nextAction: '결과 기록', notes: 'hidden-only-term' };
  assert.equal(matchesSearch(card, '  결과   REVIEW '), true);
  assert.equal(matchesSearch(card, 'hidden-only-term'), false);
  assert.equal(matchesSearch(card, ' 계획 '), true); assert.equal(matchesSearch(card, '   '), true);
});
test('mobile projects and card filters reuse the same ordering, aggregation and fold policy', () => {
  const d = createDemoData(), opts = { query: '검토', workspaceLabels: d.workspaceLabels, labels: ['prototype'] };
  const wide = swimlaneModel(d.boards, d.directory, [], false, {}, opts);
  const mobile = mobileSwimlaneModel(d.boards, d.directory, [], false, {}, 'doing', opts);
  assert.deepEqual(mobile.groups, wide.groups);
  assert.ok(mobile.sections.every(s => s.cell.stageId === 'doing' && s.cell.matchingCount > 0));
});
test('mutation guard rejects preview mode even for a real-shaped ID, and rejects demo IDs outside preview', () => {
  assert.equal(mutationAllowed(true, 'board_' + 'a'.repeat(64)), false);
  assert.equal(mutationAllowed(false, 'demo_board_0'), false);
  // REQ-57: the same guard now covers workspace ids and the id of a board that does not exist yet.
  assert.equal(mutationAllowed(false, 'demo_workspace_3'), false);
  assert.equal(mutationAllowed(false, 'empty:demo_workspace_3'), false);
  assert.equal(mutationAllowed(true, 'wks_real01'), false);
  assert.equal(mutationAllowed(false, 'wks_real01'), true);
  assert.equal(mutationAllowed(false, 'board_' + 'a'.repeat(64)), true);
});
test('REQ-57 the project dropdown reads its new state back as the list of hidden projects', () => {
  const options = new Map([['prj_a', 'A'], ['prj_b', 'B'], ['', 'Unlinked']]);
  const all = ['prj_a', 'prj_b', '', null];
  // The leading null row is the select-all control, not a project.
  assert.deepEqual(projectSelection(options, all, ['prj_a', 'prj_b', '']), ['prj_a', 'prj_b', ''], 'clearing the all row clears every box');
  assert.deepEqual(projectSelection(options, ['prj_a'], ['prj_a', null]), [], 'ticking it while some are off turns them all on');
  assert.deepEqual(projectSelection(options, all, ['prj_a', '', null]), ['prj_b'], 'unticking one project hides only that one');
  assert.deepEqual(projectSelection(options, ['prj_a'], ['prj_a', 'prj_b']), [''], 'the unlinked group is an ordinary choice');
  assert.deepEqual(projectSelection(options, [], []), ['prj_a', 'prj_b', '']);
  assert.deepEqual(projectChoices(options, 'All').map(o => o.id), [null, 'prj_a', 'prj_b', '']);
  assert.deepEqual(visibleProjects(options, ['prj_b']), ['prj_a', '']);
});
test('label adapter API path needs no file access when definitions are provided', async () => {
  const result = await readWorkspaceLabels({ home: '/tmp/unused-example',
    api: async () => ({ definitions: [{ name: 'Explore', color: 'violet' }], entries: [{ id: 'wks_example', labels: [' EXPLORE '] }] }),
    read: async () => { throw new Error('Files must not be read.'); } });
  assert.deepEqual(result, { available: true, source: 'api', definitions: [{ name: 'Explore', color: 'violet' }], byWorkspace: { wks_example: ['Explore'] } });
});
test('label adapter API name arrays use only the optional catalog file; fallback/absent/malformed paths stay read-only', async t => {
  const root = await fs.mkdtemp('/tmp/kanban-labels-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, 'projects'));
  const catalog = join(root, 'projects', 'workspace-labels.json'), workspaces = join(root, 'projects', 'workspaces.json');
  await fs.writeFile(catalog, JSON.stringify([{ name: 'Example', color: 'sky' }]));
  await fs.writeFile(workspaces, JSON.stringify([{ workspaceId: 'wks_file', labels: ['Example'] }]));
  const before = await fs.stat(catalog);
  const api = await readWorkspaceLabels({ home: root, api: async () => ({ entries: [{ id: 'wks_api', labels: ['Example'] }] }) });
  assert.equal(api.source, 'api'); assert.deepEqual(api.byWorkspace, { wks_api: ['Example'] });
  const file = await readWorkspaceLabels({ home: root, api: async () => { throw new Error('Unavailable'); } });
  assert.equal(file.source, 'file'); assert.deepEqual(file.byWorkspace, { wks_file: ['Example'] });
  assert.equal((await fs.stat(catalog)).mtimeMs, before.mtimeMs);
  await fs.writeFile(catalog, '{bad'); assert.equal((await readWorkspaceLabels({ home: root })).available, false);
  assert.equal(await fs.readFile(catalog, 'utf8'), '{bad');
  assert.equal((await readWorkspaceLabels({ home: join(root, 'missing') })).source, 'none');
  assert.deepEqual((await fs.readdir(root)).sort(), ['projects']);
});
test('optional label projection uses the handler Paseo context without changing card payloads or fetching while idle', async t => {
  const f = await fixture(t); await f.store.mutateBoard(f.id, request([add()]));
  let calls = 0, adapters = 0;
  const paseo = { workspaces: { list: async () => { calls++; return { entries: [{ id: 'wks_example01', labels: [] }], pageInfo: { nextCursor: null } }; } } };
  const handlers = createReadHandlers(f.store, () => '2026-01-01', async options => {
    adapters++; await options.api(); return { available: false, source: 'none', definitions: [], byWorkspace: {} };
  });
  const list = await handlers.overview({}, paseo); assert.equal(list.data.workspaceLabels, undefined); assert.equal(calls, 0);
  // REQ-57 ①: the workspace list is fetched once per request and only when the caller asks for it.
  const plain = await handlers.overview({ includeWorkspaces: true }, paseo);
  assert.equal(plain.data.workspaceLabels, undefined); assert.equal(calls, 1); assert.equal(adapters, 0);
  const detailed = await handlers.overview({ includeBoards: true }, paseo);
  assert.equal(detailed.data.workspaceLabels.available, false); assert.equal(calls, 2); assert.equal(adapters, 1);
  assert.equal('notes' in detailed.data.boardViews[0].stages[0].cards[0], false);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
});
test('sidebar label dots use the sidebar identityForeground colors in both themes', () => {
  const dots = { violet: '#a392d5', sky: '#6aa6ce', emerald: '#6cae96', orange: '#cc8f64', pink: '#d87da3',
    indigo: '#9299d5', teal: '#6cacab', red: '#d88381', amber: '#b29d64', blue: '#7ba1d5' };
  for (const [name, hex] of Object.entries(dots)) assert.equal(workspaceLabelColor(name), hex, name);
  // Measured sidebar dots (light and dark), one sample label per colour: emerald, violet, sky, amber, orange, red.
  assert.deepEqual(['emerald', 'violet', 'sky', 'amber', 'orange', 'red'].map(n => workspaceLabelColor(n)),
    ['rgb(108, 174, 150)', 'rgb(163, 146, 213)', 'rgb(106, 166, 206)', 'rgb(178, 157, 100)', 'rgb(204, 143, 100)', 'rgb(216, 131, 129)']
      .map(v => '#' + v.match(/\d+/g).map(n => Number(n).toString(16).padStart(2, '0')).join('')));
});
test('REQ-22 signal buckets read the installed SDK fields and rank by the user order', () => {
  const a = (patch = {}) => ({ status: 'idle', requiresAttention: false, attentionReason: null, pendingPermissions: [], ...patch });
  // Values observed from the installed daemon (spike/plugin-hello/evidence/r2-3a-feasibility/sdk-agent-fields.json).
  assert.equal(signalBucket(a({ status: 'error' })), 'error');
  assert.equal(signalBucket(a({ status: 'idle', attentionReason: 'error', requiresAttention: true })), 'error');
  assert.equal(signalBucket(a({ status: 'running', attentionReason: 'permission' })), 'permission', 'a permission wait outranks running');
  assert.equal(signalBucket(a({ status: 'running', pendingPermissions: [{ requestId: 'p1' }] })), 'permission');
  assert.equal(signalBucket(a({ status: 'running' })), 'working');
  assert.equal(signalBucket(a({ status: 'idle', requiresAttention: true, attentionReason: 'finished' })), 'attention');
  assert.equal(signalBucket(a({ status: 'closed', requiresAttention: true, attentionReason: 'finished' })), 'attention');
  assert.equal(signalBucket(a({ status: 'closed' })), 'idle', 'closed is not "unavailable"');
  assert.equal(signalBucket(a({ status: 'initializing' })), 'idle');
  assert.equal(signalBucket(a({ requiresAttention: true, attentionReason: null })), 'idle', 'attention needs the observed finished reason');
  assert.equal(signalBucket(undefined), 'unknown');
  assert.deepEqual(SIGNAL_BUCKETS.map(bucketRank), [0, 1, 2, 3, 4, 5, 6]);
});
test('REQ-22 a multi-agent card reports the most urgent signal, ties by agentId, and counts the rest', () => {
  const map = { z_error: 'error', b_working: 'working', a_working: 'working', c_idle: 'idle' };
  const read = id => map[id] ?? 'unknown';
  assert.deepEqual(summarizeSignals(['c_idle', 'b_working', 'z_error'], read),
    { bucket: 'error', agentId: 'z_error', others: 2, total: 3 });
  assert.deepEqual(summarizeSignals(['b_working', 'a_working'], read),
    { bucket: 'working', agentId: 'a_working', others: 1, total: 2 }, 'equal buckets break the tie by agentId');
  assert.deepEqual(summarizeSignals(['c_idle', 'c_idle'], read), { bucket: 'idle', agentId: 'c_idle', others: 0, total: 1 });
  assert.deepEqual(summarizeSignals(['missing'], read), { bucket: 'unknown', agentId: 'missing', others: 0, total: 1 });
  assert.equal(summarizeSignals([], read), null, 'a card with no linked agent shows no signal');
  assert.equal(summaryKey(summarizeSignals(['b_working', 'a_working'], read)), 'working|a_working|1');
  assert.equal(summaryKey(null), '');
  assert.deepEqual(boardAgentIds([{ cards: [{ agentIds: ['b', 'a'] }] }, { cards: [{ agentIds: ['a'] }, { agentIds: [] }] }]), ['a', 'b']);
});
test('REQ-22 demo signals cover every bucket with reserved demo ids and show a "+N" card', () => {
  const demo = createDemoData('en');
  const linked = new Set(demo.boards.flatMap(b => b.stages.flatMap(s => s.cards.flatMap(c => c.agentIds))));
  assert.ok(linked.size > 0);
  assert.ok([...linked].every(id => id.startsWith('demo_')), 'demo cards never carry a real agent id');
  const buckets = new Set([...linked].map(id => demoSignals[id] ?? 'unknown'));
  assert.deepEqual([...buckets].sort(), SIGNAL_BUCKETS.filter(b => b !== 'orphaned').sort(), 'agent buckets include unavailable; orphaned is a card-derived bucket tested in R2-B');
  const cards = demo.boards.flatMap(b => b.stages.flatMap(s => s.cards));
  assert.ok(cards.some(c => c.agentIds.length > 1 && c.agents === c.agentIds.length), 'at least one card shows "+N"');
  assert.deepEqual(createDemoData('en').boards[0].stages[0].cards.map(c => c.agentIds),
    demo.boards[0].stages[0].cards.map(c => c.agentIds), 'demo data stays deterministic');
});
