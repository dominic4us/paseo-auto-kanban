import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assigneeLine, assigneeName, elapsed, modelShortName, providerKey, providerName, sidebarMark } from '../dist/client/card-meta.js';
import { copy } from '../dist/client/i18n.js';
import { PASEO_THEMES, contrast, palette, readable, resolveTheme } from '../dist/client/palette.js';
import { PROVIDER_ICON_PNG } from '../dist/client/provider-icons.js';
import { DEMO_AUTO_AGENT, DEMO_AUTO_TITLE, createDemoData, demoAgentLabels, demoModels, demoSignals } from '../dist/client/demo.js';
import { toBoardDTO } from '../dist/server/read-model.js';

// REQ-73: the card face — sidebar state mark + title / provider mark + name (+N) … age / → next action.
const ID = 'abcdef12-3456-4789-8abc-def012345678';

// REQ-126: the profile label and the model now carry the model's version (and thinking level, when set).
test('REQ-73 the name is the profile label, else the model, else the title, else the id', () => {
  const full = { provider: 'claude', model: 'claude-opus-5-5', title: 'Fix the sort order', profile: 'build_Opus' };
  assert.equal(assigneeName(ID, full), 'build_Opus-5.5', 'profile first');
  assert.equal(assigneeName(ID, { ...full, profile: '  ' }), 'Opus-5.5', 'a blank profile falls through to the model');
  assert.equal(assigneeName(ID, { ...full, profile: null, model: null }), 'Fix the sort order', 'then the title');
  assert.equal(assigneeName(ID, { provider: 'codex' }), 'abcdef12', 'then the first 8 characters of the id');
  assert.equal(assigneeName(ID, undefined), 'abcdef12', 'an agent the store never saw');
  // REQ-61: an auto card carries its agent's title; the profile or the model comes first, so it is not repeated.
  assert.equal(assigneeName(ID, { ...full, profile: null }), 'Opus-5.5');
  // Gate F2 (research/99): this case used to expect the provider name ("Claude") when the title matched the card's.
  // The accepted order is strict — profile → model → title → id — so the agent's own title stays, with no provider.
  assert.equal(assigneeName(ID, { provider: 'claude', model: null, title: 'Fix  the sort order' }), 'Fix  the sort order',
    'with only a title, the title — never the provider name');
  assert.equal(assigneeName(ID, { provider: 'claude', title: '  ' }), 'abcdef12', 'a blank title falls through to the id');
  assert.equal(assigneeName(ID, { title: 'Fix the sort order' }), 'Fix the sort order',
    'nothing else to say: the title stays rather than an opaque id');
});

test('REQ-73 gate F2: the name never inserts the provider, whatever the card is titled', () => {
  const info = { provider: 'claude', model: null, profile: null, title: '한국어 작업' };
  assert.equal(assigneeName('agent-example-123', info), '한국어 작업', 'research/99 repro: expected the title, got "Claude"');
  assert.equal(assigneeName.length, 2, 'the card title is no longer an input');
  for (const provider of ['claude', 'codex', 'gemini'])
    assert.equal(assigneeName(ID, { ...info, provider }), '한국어 작업');
});

test('REQ-73 model ids become short readable names', () => {
  const cases = [
    ['claude', 'claude-opus-5-5', 'Opus 5.5'], ['claude', 'claude-opus-5', 'Opus 5'], ['claude', 'claude-sonnet-5', 'Sonnet 5'],
    ['claude', 'claude-fable-5-1', 'Fable 5.1'], ['claude', 'claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude', 'claude-sonnet-5[1m]', 'Sonnet 5'], ['claude', 'claude-opus-4-8[1m]', 'Opus 4.8'],
    ['claude', 'us.anthropic.claude-sonnet-4-6', 'Sonnet 4.6'], ['claude', 'claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['codex', 'gpt-6-astra', 'GPT-6 Astra'], ['codex', 'gpt-5.6-sol', 'GPT-5.6 Sol'], ['codex', 'gpt-5.5', 'GPT-5.5'],
    ['codex', 'gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini'],
    ['gemini', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro'], ['gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash'],
    ['gemini', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite'], ['gemini', 'auto', 'Gemini Auto'],
    ['opencode', 'some/other-model', 'some/other-model'],
  ];
  for (const [provider, model, expected] of cases) assert.equal(modelShortName({ provider, model }), expected, model);
  assert.equal(modelShortName({ provider: 'claude', model: null }), null);
  assert.equal(modelShortName({ provider: 'claude', model: '' }), null);
  assert.equal(modelShortName(undefined), null);
});

test('REQ-73 the age reads just now, minutes, hours, days, months, years — in both languages', () => {
  const now = Date.parse('2026-03-01T12:00:00.000Z'), before = minutes => new Date(now - minutes * 60000).toISOString();
  const en = copy('en'), ko = copy('ko');
  const cases = [[0, 'just now', '방금'], [0.9, 'just now', '방금'], [1, '1m ago', '1분 전'], [59, '59m ago', '59분 전'],
    [60, '1h ago', '1시간 전'], [60 * 23 + 59, '23h ago', '23시간 전'], [60 * 24, '1d ago', '1일 전'], [60 * 24 * 3, '3d ago', '3일 전'],
    [60 * 24 * 29, '29d ago', '29일 전'], [60 * 24 * 30, '1mo ago', '1개월 전'], [60 * 24 * 364, '12mo ago', '12개월 전'],
    [60 * 24 * 365, '1y ago', '1년 전'], [-5, 'just now', '방금']];
  for (const [age, english, korean] of cases) {
    const value = elapsed(before(age), now);
    assert.equal(en.ago(value), english, `${age} minutes`); assert.equal(ko.ago(value), korean, `${age} minutes`);
  }
  assert.equal(elapsed(undefined, now), null, 'an older server without updatedAt shows no age');
  assert.equal(elapsed('not a date', now), null);
  assert.equal(ko.updatedAgo('3일 전'), '마지막 변경 3일 전');
});

test('REQ-73 each state takes the sidebar mark; Kanban-only states draw none on line one', () => {
  assert.deepEqual(Object.fromEntries(['working', 'permission', 'error', 'attention', 'idle', 'unknown', 'orphaned']
    .map(bucket => [bucket, sidebarMark(bucket)])), { working: 'ring', permission: 'alert', error: 'dot-danger',
    attention: 'dot-success', idle: 'dot-idle', unknown: null, orphaned: null });
});

test('REQ-73 "+N" joins the lead name, and providers map to Paseo marks or its Bot fallback', () => {
  assert.equal(assigneeLine('build_Opus', 0, copy('ko').otherAgents), 'build_Opus');
  assert.equal(assigneeLine('build_Opus', 2, copy('ko').otherAgents), 'build_Opus · 외 2명');
  assert.equal(assigneeLine('Opus 5.5', 1, copy('en').otherAgents), 'Opus 5.5 · +1');
  assert.deepEqual(['claude', 'claude-acp', 'codex', 'codex-acp', 'openai', 'gemini', 'copilot', '', null].map(providerKey),
    ['claude', 'claude', 'codex', 'codex', 'codex', 'gemini', null, null, null]);
  assert.deepEqual(['claude', 'codex', 'gemini', 'opencode', null].map(providerName), ['Claude', 'Codex', 'Gemini', 'Opencode', null]);
  for (const key of ['claude', 'codex', 'gemini']) assert.match(PROVIDER_ICON_PNG[key], /^data:image\/png;base64,iVBOR/);
});

test('REQ-73 the provider marks are Paseo\'s paths unchanged, with their source and a NOTICE', async () => {
  const raw = await readFile('raw_sources/icon_rights_20260925/icon-files-raw.txt', 'utf8').catch(() => null);
  for (const name of ['claude', 'codex', 'gemini']) {
    const svg = await readFile(`assets/provider-icons/${name}.svg`, 'utf8');
    assert.match(svg, /Copied unchanged from Paseo \(https:\/\/github\.com\/getpaseo\/paseo, Apache-2\.0\)/);
    assert.doesNotMatch(svg, /transform|rotate|scale\(/, 'no transform of any kind');
    const path = /<path d="([^"]+)"/.exec(svg)[1];
    // The research copy is not shipped; when present, the path must match it character for character.
    if (raw) assert.ok(raw.includes(path), `${name} path is Paseo's own`);
  }
  const notice = await readFile('NOTICE', 'utf8');
  assert.match(notice, /getpaseo\/paseo/); assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /not made, sponsored, endorsed or certified by Anthropic, OpenAI, Google/);
});

test('REQ-73 ① card-face colours hold 4.5:1 for words and 3:1 for marks on every theme choice × host mode', () => {
  const checked = [];
  for (const host of [PASEO_THEMES.light, PASEO_THEMES.dark]) for (const choice of ['paseo', 'system', 'light', 'dark'])
    for (const system of ['light', 'dark']) {
      const c = palette(resolveTheme(host, choice, system)), card = c.card;
      const words = { name: c.foreground, muted: readable(c.foregroundMuted, card), warn: readable(c.statusWarning, card),
        orphan: readable(c.statusDotWarning, card), blocked: c.blocked, draft: c.draft };
      for (const [key, value] of Object.entries(words))
        assert.ok(contrast(value, card) >= 4.5, `${choice}/${system} ${key} ${contrast(value, card).toFixed(2)}`);
      const marks = { provider: readable(c.foregroundMuted, card), quietProvider: readable(c.foregroundMuted, card, 3),
        ring: readable(c.running, card, 3), alert: readable(c.statusDotWarning, card, 3), danger: readable(c.statusDotDanger, card, 3),
        success: readable(c.statusDotSuccess, card, 3), orphanMark: readable(c.statusDotWarning, card, 3) };
      for (const [key, value] of Object.entries(marks))
        assert.ok(contrast(value, card) >= 3, `${choice}/${system} ${key} ${contrast(value, card).toFixed(2)}`);
      // The CircleAlert's own lines are drawn in the card colour on the warning fill, as the sidebar does.
      assert.ok(contrast(card, marks.alert) >= 3, `${choice}/${system} alert glyph on its fill`);
      checked.push(choice + '/' + system);
    }
  assert.equal(checked.length, 16);
});

test('REQ-73 ④ the demo mixes providers, profile labels, unlabelled links and an auto card named after its agent', () => {
  const providers = new Set(Object.values(demoModels).map(info => info.provider));
  assert.deepEqual([...providers].sort(), ['claude', 'codex', 'gemini']);
  assert.ok(Object.values(demoModels).some(info => info.profile), 'some agents carry a profile label');
  assert.ok(Object.values(demoModels).some(info => !info.profile && info.model), 'some only a model');
  assert.ok(Object.values(demoModels).some(info => !info.profile && !info.model && info.title), 'one only a title');
  const demo = createDemoData('en');
  const linked = new Set(demo.boards.flatMap(b => b.stages.flatMap(s => s.cards.flatMap(c => c.agentIds))));
  assert.ok([...linked].some(id => !demoAgentLabels[id]), 'links without a label are the common case');
  assert.ok([...linked].some(id => !demoModels[id]), 'and one agent the store knows nothing about (the id shows)');
  const auto = demo.boards.flatMap(b => b.stages.flatMap(s => s.cards)).find(c => c.agentIds.includes(DEMO_AUTO_AGENT));
  assert.equal(auto.title, DEMO_AUTO_TITLE);
  assert.equal(demoModels[DEMO_AUTO_AGENT].title, auto.title);
  assert.equal(assigneeName(DEMO_AUTO_AGENT, demoModels[DEMO_AUTO_AGENT]), 'Haiku-4.5', 'the model, not the title again');
  assert.equal(demoSignals[DEMO_AUTO_AGENT], 'working');
  const cards = demo.boards.flatMap(b => b.stages.flatMap(s => s.cards));
  assert.ok(cards.every(c => typeof c.updatedAt === 'string'), 'every demo card has an age');
  assert.ok(cards.some(c => c.priority === 'low') && cards.some(c => c.priority === 'high'));
  const now = Date.parse('2026-01-20T12:00:00.000Z');
  const units = new Set(cards.map(c => elapsed(c.updatedAt, now).unit));
  assert.deepEqual([...units].sort(), ['day', 'hour', 'minute', 'month', 'now']);
});

test('REQ-73 the board view carries each card\'s updatedAt, for the age on its face', () => {
  const at = '2026-02-03T04:05:06.000Z';
  const board = { schemaVersion: 1, id: 'board_' + 'a'.repeat(64), workspaceId: 'wks_example', cwd: '/example', workspaceStatus: 'active',
    template: { schemaVersion: 1, id: 'basic', version: 1, name: 'Basic', stages: [{ stageId: 'todo', name: 'To Do', countsAsDone: false }] },
    revision: 'r1', cards: [{ id: 'card_' + '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12), title: 'Example', stageId: 'todo',
      acceptanceCriteria: '', notes: '', priority: 'normal', blockedReason: null, nextAction: '', intent: 'requested', awaiting: null,
      deliverables: [], agents: [], createdBy: { kind: 'user' }, createdAt: at, updatedAt: at, archivedAt: null }],
    history: [], receipts: [], createdAt: at, updatedAt: at };
  const dto = toBoardDTO(board, 'en');
  assert.equal(dto.stages[0].cards[0].updatedAt, at);
});
