import test from 'node:test';
import assert from 'node:assert/strict';
import { stageColor } from '../dist/client/stage-color.js';
import { palette, blueAccent, luminance, contrast, SURFACE_STEP } from '../dist/client/palette.js';
import { SWIMLANE, gridWidth, swimlaneWidth } from '../dist/client/swimlane-model.js';
import { projectHeaderHeight, STICKY } from '../dist/client/layout.js';
import { countUrgentSignals, countsKey } from '../dist/client/signal-model.js';
import { progressMetrics, projectChoices, detailLayout } from '../dist/client/visual-model.js';
import { mobileControls, firstCardY } from '../dist/client/mobile-layout.js';
import { builtinTemplate, applyOperations, summarizeBoard } from '../dist/shared/core/domain.js';
import { board, add, actor, context } from './helpers.mjs';
const light = { colors: { surface0: '#ffffff', surface1: '#fafafa', surface2: '#f5f5f5',
  foreground: '#24282b', foregroundMuted: '#666666', border: '#dddddd', accent: '#a17834',
  statusSuccess: '#318255', statusWarning: '#aa8833', statusDanger: '#aa4433' } };
const dark = { colors: { ...light.colors, surface0: '#181b1a', surface1: '#1e2120', surface2: '#252927',
  foreground: '#eeeeee', foregroundMuted: '#999999', statusSuccess: '#69ab85', accent: '#74acec' } };

test('REQ-21 basic stages use gray/blue/purple/green, never attention or error colors', () => {
  for (const theme of [light, dark]) {
    const c = palette(theme), stages = builtinTemplate().stages;
    // REQ-67 ④: the done green is the host success colour made a little livelier (stageDone), no longer the token itself.
    assert.deepEqual(stages.map(s => stageColor(s.stageId, stages, c)),
      [c.foregroundMuted, c.stageBlue, c.stagePurple, c.stageDone]);
    assert.ok(stages.every(s => ![c.statusWarning, c.statusDanger].includes(stageColor(s.stageId, stages, c))));
  }
});
test('REQ-21 custom stages alternate non-completion middle stages, with explicit completion precedence', () => {
  const stages = ['start', 'work', 'publish', 'check', 'ship', 'rework'].map(stageId =>
    ({ stageId, countsAsDone: ['publish', 'ship'].includes(stageId) }));
  const c = palette(light);
  assert.deepEqual(stages.map(s => stageColor(s.stageId, stages, c)),
    [c.foregroundMuted, c.stageBlue, c.stageDone, c.stagePurple, c.stageDone, c.stageBlue]); // REQ-67 ④: stageDone, see above.
  assert.equal(stageColor('unknown', stages, c), c.foregroundMuted);
  assert.equal(stageColor('start', [{ stageId: 'start', countsAsDone: true }], c), c.stageDone);
});
test('blue host accents are reused, warm/gray/purple accents use the single auxiliary palette', () => {
  for (const value of ['#268ae0', '#74acec', '#00f']) assert.equal(blueAccent(value), true);
  for (const value of ['#ccaa00', '#777777', '#8844cc', '#338844', 'transparent']) assert.equal(blueAccent(value), false);
  assert.equal(palette(dark).stageBlue, dark.colors.accent);
  assert.notEqual(palette(light).stageBlue, light.colors.accent);
});
test('D6 reference host colors gain >=1.15 contrast with brighter cards; suitable host surfaces remain reusable', t => {
  for (const theme of [light, dark]) {
    const c = palette(theme);
    assert.ok(luminance(c.card) > luminance(c.panel)); assert.ok(contrast(c.card, c.panel) >= SURFACE_STEP);
    assert.ok(luminance(c.badge) < luminance(c.panelHeader));
    t.diagnostic(JSON.stringify({ theme: theme === light ? 'light' : 'dark', panel: c.panel, card: c.card,
      ratio: contrast(c.card, c.panel) }));
  }
  // REQ-40 changed which token the dark panel comes from: the host surface is reused for the *panel*,
  // because that is the plane that has to separate from the page, and the brighter card comes from the
  // auxiliary table (no host token is brighter still). A host surface that cannot host a panel is replaced.
  assert.equal(palette(dark).panel, dark.colors.surface2);
  const bright = palette({ colors: { ...dark.colors, surface2: '#3c4540' } });
  assert.ok(luminance(bright.card) > luminance(bright.panel));
  const flat = palette({ colors: { ...dark.colors, surface2: '#1a1d1c' } });
  assert.notEqual(flat.panel, '#1a1d1c');
  assert.ok(contrast(flat.panel, flat.surface0) >= SURFACE_STEP);
});
test('REQ-40 dark repeats the light contrast relationships: panel over the page, card over the panel, visible progress track and pinned edge', t => {
  const record = [];
  for (const [name, theme] of [['light', light], ['dark', dark],
    // The values the installed app actually ships for its default themes.
    ['app-light', { colors: { ...light.colors, surface0: '#ffffff', surface1: '#fafafa', surface2: '#f4f4f5' } }],
    ['app-dark', { colors: { ...dark.colors, surface0: '#181B1A', surface1: '#1E2120', surface2: '#272A29' } }]]) {
    const c = palette(theme);
    assert.ok(contrast(c.panel, theme.colors.surface0) >= SURFACE_STEP, name + ': the column panel separates from the page');
    assert.ok(contrast(c.card, c.panel) >= SURFACE_STEP, name + ': the card separates from its panel');
    // D11: the progress track is drawn in the panel colour on the page background of a header row.
    assert.ok(contrast(c.panel, theme.colors.surface0) >= SURFACE_STEP, name + ': the progress track is visible');
    assert.ok(luminance(c.panelHeader) > luminance(c.panel), name + ': the stage band stays brighter than the panel');
    const lightTheme = name.endsWith('light');
    // D17: the pinned header edge is what marks the boundary in dark; light keeps the shadow alone.
    if (lightTheme) assert.equal(c.stickyEdge, 'transparent', name + ': light is unchanged');
    else assert.ok(contrast(c.stickyEdge, theme.colors.surface0) >= SURFACE_STEP, name + ': the pinned edge is visible');
    record.push({ name, panel: c.panel, card: c.card, panelHeader: c.panelHeader, stickyEdge: c.stickyEdge,
      panelOverPage: +contrast(c.panel, theme.colors.surface0).toFixed(3), cardOverPanel: +contrast(c.card, c.panel).toFixed(3) });
  }
  t.diagnostic(JSON.stringify(record));
  // Light must look exactly as it shipped in 686e443.
  const before = palette({ colors: { ...light.colors, surface0: '#ffffff', surface1: '#fafafa', surface2: '#f4f4f5' } });
  assert.equal(before.panel, '#e7eaed'); assert.equal(before.card, '#ffffff'); assert.equal(before.panelHeader, '#fafafa');
});
test('REQ-43/45 the lane toggle reserves one width and lane rows step in under their project header', () => {
  // REQ-67 ①: the text toggle became a 30px glyph, the same box in both states, so its reserved width is gone.
  assert.equal(SWIMLANE.toggleWidth, undefined);
  // REQ-60 replaced REQ-45's 16px step with 24 (the next 8px step, inside the 24~32 range).
  assert.equal(SWIMLANE.laneIndent, 24);
  assert.equal(swimlaneWidth(), gridWidth() + 24);
  assert.equal(gridWidth(), 1144, 'the stage columns themselves are unchanged');
  // REQ-42: a lane header pins directly under the project header it belongs to.
  assert.equal(projectHeaderHeight(), SWIMLANE.headerHeight + STICKY.edgeWidth);
  assert.equal(projectHeaderHeight(), 45); assert.ok(STICKY.projectZIndex > STICKY.zIndex);
});
test('REQ-44 the folded-lane tally counts only error and permission waits, once per agent', () => {
  const map = { a: 'error', b: 'permission', c: 'working', d: 'idle', e: 'attention', f: 'unknown', g: 'error' };
  const read = id => map[id] ?? 'unknown';
  assert.deepEqual(countUrgentSignals(['a', 'b', 'c', 'd', 'e', 'f', 'g'], read), { error: 2, permission: 1 });
  assert.deepEqual(countUrgentSignals(['a', 'a', 'a'], read), { error: 1, permission: 0 }, 'one agent counts once');
  assert.deepEqual(countUrgentSignals(['', 'zz'], read), { error: 0, permission: 0 });
  assert.deepEqual(countUrgentSignals([], read), { error: 0, permission: 0 });
  assert.equal(countsKey({ error: 2, permission: 1 }), '2|1');
  assert.notEqual(countsKey({ error: 2, permission: 1 }), countsKey({ error: 1, permission: 2 }));
});
test('REQ-23 progress handles zero cards, excludes drafts and reaches the full 96px only when all requested work is done', () => {
  assert.deepEqual(progressMetrics({ done: 0, requested: 0 }), { width: 96, fillWidth: 0, percent: null });
  const made = applyOperations(board(), [{ op: 'add', title: 'Draft' }, { ...add(), stageId: 'done' }], actor, context()).board;
  assert.deepEqual(progressMetrics(summarizeBoard(made).progress), { width: 96, fillWidth: 96, percent: 100 });
  const more = applyOperations(made, [add('In flight')], actor, context()).board;
  assert.deepEqual(progressMetrics(summarizeBoard(more).progress), { width: 96, fillWidth: 48, percent: 50 });
});
test('REQ-27 dropdown choices have a distinct all-projects value and preserve an unlinked empty ID', () => {
  assert.deepEqual(projectChoices(new Map([['b', 'Beta'], ['', 'Unlinked'], ['a', 'Alpha']]), 'All projects'),
    [{ id: null, name: 'All projects' }, { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: '', name: 'Unlinked' }]);
});
test('REQ-28 / REQ-88 ① desktop detail is <=880 and <=90% width, two columns (a 280px side panel) only with room for the left one', () => {
  for (const width of [390, 600, 720, 760, 1000, 1400, 1900]) {
    const d = detailLayout(width, false);
    assert.ok(d.width <= 880 && d.width <= width * .9);
    assert.equal(d.columns, d.width >= 700 ? 2 : 1);
    if (d.columns === 2) assert.ok(d.width - 2 * d.padding - d.gap - d.panelWidth >= 340, 'the left column keeps 340px or more');
  }
  assert.equal(detailLayout(1400, false).width, 880); assert.equal(detailLayout(1400, false).panelWidth, 280);
  assert.equal(detailLayout(1900, false).padding, 24);
  assert.equal(detailLayout(390, true).width, undefined); assert.equal(detailLayout(390, true).columns, 1);
});
test('D5 visible attention chip, four tabs and one menu retain the proven 149px panel budget', () => {
  for (const width of [360, 390, 430, 759]) {
    const d = mobileControls(width, 4, 76, 44); // REQ-71: tabs │ chip ⋯
    assert.equal(d.contentWidth, width - 16); assert.ok(d.tabWidth >= 44);
    assert.equal(d.tabWidth * 4 + 4 + 1 + 4 + 76 + 4 + 44, d.contentWidth);
    assert.equal(firstCardY('panel'), 149);
  }
});
