// REQ-139: the Kanban screens' own size (80–150%) — the factor every fixed size goes through (client/ui-scale.ts), the tables
// read at the current size, and the setting kept in ui-state.json beside the others. The screens are exercised in
// plugin-ui.test.mjs ("REQ-139") and tests/web/run.mjs (=req139). Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canStep, clampScale, px, scaled, setUiScale, stepScale, uiScaleFactor, UI_SCALE } from '../dist/client/ui-scale.js';
import { SWIMLANE, cardDimensions, gridWidth, swimlaneWidth } from '../dist/client/swimlane-model.js';
import { boardLayout, projectHeaderHeight, settingsWindowSize, STICKY } from '../dist/client/layout.js';
import { MOBILE, mobileControls } from '../dist/client/mobile-layout.js';
import { FLOW } from '../dist/client/workflow-model.js';
import { dropdownPosition } from '../dist/client/dropdown-state.js';
import { readUiState, writeUiState } from '../dist/server/ui-state.js';
import { uiStateSet, uiSettingsSchema } from '../dist/shared/rpc.js';
import { createReadHandlers } from '../dist/server/handlers.js';

async function dataDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-req139-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}
/** Runs `body` at `percent` and puts 100% back whatever happens, so no other test sees the size. */
function at(percent, body) {
  setUiScale(percent);
  try { return body(); } finally { setUiScale(100); }
}

test('REQ-139 the steps: 80 to 150 by 10, 100 by default, anything unreadable 100', () => {
  assert.deepEqual(UI_SCALE, { min: 80, max: 150, step: 10, default: 100 });
  for (const [value, want] of [[100, 100], [80, 80], [150, 150], [110, 110], [79, 80], [151, 150], [40, 80], [400, 150],
    [104, 100], [105, 110], [126, 130], [undefined, 100], [null, 100], ['120', 100], [NaN, 100], [Infinity, 100]]) assert.equal(clampScale(value), want, String(value));
  assert.equal(stepScale(100, 1), 110); assert.equal(stepScale(100, -1), 90);
  // The ends: a step past them stays at them, and says it cannot step.
  assert.equal(stepScale(150, 1), 150); assert.equal(canStep(150, 1), false); assert.equal(canStep(150, -1), true);
  assert.equal(stepScale(80, -1), 80); assert.equal(canStep(80, -1), false); assert.equal(canStep(80, 1), true);
  // From 80 up to 150 is eight steps, each one 10.
  const seen = [80]; while (canStep(seen.at(-1), 1)) seen.push(stepScale(seen.at(-1), 1));
  assert.deepEqual(seen, [80, 90, 100, 110, 120, 130, 140, 150]);
});

test('REQ-139 px: the number itself at 100%, the number × the size otherwise (to a hundredth)', () => {
  assert.equal(uiScaleFactor(), 1);
  for (const n of [1, 2, 11, 12.5, 13, 44, 264, 280, -1, -4]) assert.equal(px(n), n, '100% leaves ' + n + ' exactly as it was');
  at(150, () => { assert.equal(uiScaleFactor(), 1.5); assert.equal(px(280), 420); assert.equal(px(11), 16.5); assert.equal(px(-4), -6); });
  at(80, () => { assert.equal(px(280), 224); assert.equal(px(13), 10.4); assert.equal(px(12.5), 10); });
  at(110, () => { assert.equal(px(280), 308, 'no float noise (280 × 1.1)'); assert.equal(px(3), 3.3); });
  // An unreadable size set by mistake is 100%.
  at(NaN, () => assert.equal(px(280), 280));
  assert.equal(px(280), 280, 'back to 100% after');
});

test('REQ-139 scaled tables: sizes follow the current size whenever read; the fields that are not sizes never move', () => {
  const table = scaled({ width: 100, zIndex: 10, opacity: .5, line: 1, name: 'x' }, ['zIndex', 'opacity', 'line']);
  assert.deepEqual({ ...table }, { width: 100, zIndex: 10, opacity: .5, line: 1, name: 'x' });
  at(150, () => assert.deepEqual({ ...table }, { width: 150, zIndex: 10, opacity: .5, line: 1, name: 'x' }));
  assert.throws(() => { 'use strict'; table.width = 1; }, TypeError, 'frozen');
  // The plugin's own tables, built when their modules loaded, still follow.
  assert.equal(SWIMLANE.columnWidth, 280); assert.equal(SWIMLANE.cardWidth, 264);
  at(150, () => {
    assert.equal(SWIMLANE.columnWidth, 420); assert.equal(SWIMLANE.cardWidth, 396); assert.equal(SWIMLANE.laneIndent, 36);
    // Counts are not sizes.
    assert.equal(SWIMLANE.previewCount, 3); assert.equal(SWIMLANE.moreStep, 5);
    // A line stays 1px; z-order and the shadow's look stay.
    assert.deepEqual([STICKY.edgeWidth, STICKY.zIndex, STICKY.projectZIndex, STICKY.opacity, STICKY.elevation, STICKY.headerHeight], [1, 10, 11, .12, 3, 66]);
    assert.equal(projectHeaderHeight(), 67, 'the 66px header and its 1px edge');
    // The host's own header heights are the host's; the divider is a line.
    assert.deepEqual([MOBILE.referenceHostHeader, MOBILE.referencePanelHeader, MOBILE.dividerWidth, MOBILE.touchSize], [64, 101, 1, 66]);
    assert.deepEqual([FLOW.line, FLOW.hot, FLOW.nodeH, FLOW.label], [2, 4, 66, 18.75]);
  });
  assert.equal(projectHeaderHeight(), 45);
});

test('REQ-139 the board\'s geometry scales as one: columns, the grid, a card\'s box and its rows', () => {
  const base = { grid: gridWidth(), lane: swimlaneWidth(), card: cardDimensions(true), sub: cardDimensions(false, 1, true, 2, true, 1) };
  assert.deepEqual([base.grid, base.lane, base.card.height, base.card.titleLineHeight], [1144, 1168, 104, 18], '100% is what it was');
  for (const percent of [80, 150]) at(percent, () => {
    const k = percent / 100;
    assert.equal(gridWidth(), base.grid * k); assert.equal(swimlaneWidth(), base.lane * k);
    const card = cardDimensions(true), sub = cardDimensions(false, 1, true, 2, true, 1);
    for (const key of ['height', 'minHeight', 'paddingVertical', 'paddingHorizontal', 'gap', 'titleLineHeight', 'metaLineHeight', 'nextLineHeight']) {
      assert.equal(card[key], Math.round(base.card[key] * k * 100) / 100, percent + '% ' + key);
      assert.equal(sub[key], Math.round(base.sub[key] * k * 100) / 100, percent + '% sub-card ' + key);
    }
    // A wide board's lane: the floor and the padding both scale; 760 still chooses tabs or lanes by the real width.
    assert.equal(boardLayout(1400, false).tabs, false); assert.equal(boardLayout(700, false).tabs, true);
    assert.equal(boardLayout(1400, false).tabRow.height, 44 * k);
    // The phone's controls: stage tabs share what the 390px screen leaves after the scaled chip and gaps.
    const controls = mobileControls(390);
    assert.equal(controls.contentWidth, Math.max(390 - 16 * k, 4 * 2 * k + 1 + 76 * k + 4 * 44 * k), percent + '% phone controls');
  });
});

test('REQ-139 popovers stay inside the window at every size, measured in the same pixels they are drawn in', () => {
  const viewport = { width: 390, height: 844 }, anchor = { x: 300, y: 700, width: 30, height: 30 };
  for (const percent of [80, 100, 150]) at(percent, () => {
    const place = dropdownPosition(anchor, viewport, 6);
    assert.ok(place.left >= px(8) && place.left + place.width <= viewport.width - px(8) + .001, percent + '% inside sideways');
    assert.ok(place.top >= px(8) && place.top + place.maxHeight <= viewport.height - px(8) + .001, percent + '% inside top to bottom');
    assert.equal(place.width, Math.min(px(240), viewport.width - px(16)));
    // Near the bottom it opens above the anchor, as at 100%.
    assert.ok(place.top + place.maxHeight <= anchor.y, percent + '% above the anchor');
  });
  // The settings window: never wider than its scaled maximum, nor outside the area's scaled margin.
  at(150, () => assert.deepEqual(settingsWindowSize({ width: 1400, height: 900 }), { width: 1080, height: 756 }));
  at(80, () => assert.deepEqual(settingsWindowSize({ width: 1400, height: 900 }), { width: 576, height: 448 }));
});

test('REQ-139 storage: kept beside the other display settings, absent at 100%, an older file reads 100%', async t => {
  const dir = await dataDir(t), host = 'host_sample', other = 'host_other';
  // An older file: no uiScale anywhere, its other fields as they were.
  const older = { schemaVersion: 1, hosts: { [host]: { hiddenProjects: ['prj_hidden'], order: { projects: ['prj_a'], workspaces: ['wks_b'], flatWorkspaces: ['wks_c'] },
    settings: { theme: 'dark', boardAlign: 'left', cardOrder: 'updated', groupByProject: true } }, [other]: { hiddenProjects: ['prj_other'], order: { projects: [], workspaces: [] } } } };
  await writeFile(join(dir, 'ui-state.json'), JSON.stringify(older, null, 2) + '\n');
  const before = await readFile(join(dir, 'ui-state.json'), 'utf8');
  const read = await readUiState(dir, host);
  assert.equal(read.settings.uiScale, undefined, 'absent: 100%');
  // Saving 100 on an older file changes nothing and writes nothing.
  let result = await writeUiState(dir, host, { settings: { uiScale: 100 } });
  assert.equal(result.changed, false);
  assert.equal(await readFile(join(dir, 'ui-state.json'), 'utf8'), before, 'byte for byte the same file');
  // 120: stored beside the theme, the position, the order and the hidden projects, which all stay.
  result = await writeUiState(dir, host, { settings: { uiScale: 120 } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings, { theme: 'dark', boardAlign: 'left', cardOrder: 'updated', groupByProject: true, uiScale: 120 });
  const stored = JSON.parse(await readFile(join(dir, 'ui-state.json'), 'utf8'));
  assert.deepEqual(stored.hosts[host].hiddenProjects, ['prj_hidden']);
  assert.deepEqual(stored.hosts[host].order, older.hosts[host].order);
  assert.deepEqual(stored.hosts[other], older.hosts[other], 'another host untouched');
  // Reopened (a new read of the file): the size is back.
  assert.equal((await readUiState(dir, host)).settings.uiScale, 120);
  // Another row saved afterwards keeps the size, and the size saved again keeps the others.
  await writeUiState(dir, host, { settings: { theme: 'light' } });
  await writeUiState(dir, host, { hiddenProjects: [] });
  assert.deepEqual((await readUiState(dir, host)).settings, { theme: 'light', boardAlign: 'left', cardOrder: 'updated', groupByProject: true, uiScale: 120 });
  // The ends are kept; back to 100 takes the field out, so the file is the older shape again (other changes aside).
  for (const value of [80, 150]) { await writeUiState(dir, host, { settings: { uiScale: value } }); assert.equal((await readUiState(dir, host)).settings.uiScale, value); }
  await writeUiState(dir, host, { settings: { uiScale: 100 } });
  const back = JSON.parse(await readFile(join(dir, 'ui-state.json'), 'utf8'));
  assert.equal('uiScale' in back.hosts[host].settings, false);
  // A damaged file's size (out of range, not a step, not a number) reads as 100%.
  for (const bad of [70, 160, 115, '120', true, null, 100.5]) {
    await writeFile(join(dir, 'ui-state.json'), JSON.stringify({ schemaVersion: 1, hosts: { [host]: { settings: { theme: 'dark', uiScale: bad } } } }));
    assert.deepEqual((await readUiState(dir, host)).settings, { theme: 'dark' }, JSON.stringify(bad));
  }
});

test('REQ-139 the write: one setting on its own, a step between 80 and 150, nothing else', () => {
  const ok = value => uiStateSet.input.safeParse({ hostId: 'host_sample', settings: { uiScale: value } }).success;
  for (const value of [80, 90, 100, 110, 150]) assert.equal(ok(value), true, String(value));
  for (const value of [70, 160, 115, 100.5, '120', null]) assert.equal(ok(value), false, String(value));
  assert.equal(uiSettingsSchema.safeParse({ uiScale: 130 }).success, true);
  assert.equal(uiSettingsSchema.safeParse({}).success, true, 'absent');
});

// research/330 F1: saves of one file at the same moment each read the old file and the later replace dropped the other's change.
const seed = (dir, host, settings) => writeFile(join(dir, 'ui-state.json'),
  JSON.stringify({ schemaVersion: 1, hosts: { [host]: { hiddenProjects: [], order: { projects: [], workspaces: [] }, settings } } }));
test('research/330 F1 different settings saved at once: every one is kept, every time', async t => {
  const dir = await dataDir(t), host = 'host_sample';
  for (let n = 0; n < 20; n++) {
    await seed(dir, host, { theme: 'dark', uiScale: 120, boardAlign: 'left' });
    const patches = [{ uiScale: 130 }, { theme: 'light' }, { boardAlign: 'right' }];
    const replies = await Promise.all(patches.map(settings => writeUiState(dir, host, { settings })));
    assert.ok(replies.every(r => r.changed), 'each says it saved');
    assert.deepEqual((await readUiState(dir, host)).settings, { theme: 'light', boardAlign: 'right', uiScale: 130 }, 'round ' + n);
    // The filter and the order saved beside a setting at once are kept too.
    await Promise.all([writeUiState(dir, host, { hiddenProjects: ['prj_hidden'] }), writeUiState(dir, host, { order: { projects: ['prj_a'], workspaces: [] } }),
      writeUiState(dir, host, { settings: { uiScale: 90 } })]);
    const all = await readUiState(dir, host);
    assert.deepEqual([all.hiddenProjects, all.order.projects, all.settings.uiScale], [['prj_hidden'], ['prj_a'], 90], 'round ' + n);
  }
  // Two hosts in one file at once: neither loses its own.
  await Promise.all([writeUiState(dir, 'host_other', { settings: { uiScale: 80 } }), writeUiState(dir, host, { settings: { uiScale: 150 } })]);
  assert.deepEqual([(await readUiState(dir, 'host_other')).settings.uiScale, (await readUiState(dir, host)).settings.uiScale], [80, 150]);
});
test('research/330 F1 the same setting saved at once: the last call wins; a failed save never stops the next', async t => {
  const dir = await dataDir(t), host = 'host_sample';
  for (let n = 0; n < 20; n++) {
    await seed(dir, host, { uiScale: 120 });
    await Promise.all([110, 140, 90, 130].map(uiScale => writeUiState(dir, host, { settings: { uiScale } })));
    assert.equal((await readUiState(dir, host)).settings.uiScale, 130, 'round ' + n);
  }
  // One save whose write fails (a full disk) in the middle of three: it says so, and the other two are saved.
  await seed(dir, host, { theme: 'dark' });
  const failing = { write: async () => { throw new Error('Synthetic full disk'); } };
  const [a, b, c] = await Promise.allSettled([writeUiState(dir, host, { settings: { uiScale: 130 } }),
    writeUiState(dir, host, { settings: { boardAlign: 'right' } }, failing), writeUiState(dir, host, { settings: { theme: 'light' } })]);
  assert.deepEqual([a.status, b.status, c.status], ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual((await readUiState(dir, host)).settings, { theme: 'light', uiScale: 130 });
  // Through the server's own handler: a value the request check refuses (115) fails alone; the two sent beside it are saved.
  const handlers = createReadHandlers({ dataDir: dir });
  const replies = await Promise.all([{ boardAlign: 'left' }, { uiScale: 115 }, { uiScale: 150 }].map(settings => handlers.ui({ hostId: host, settings })));
  assert.deepEqual(replies.map(r => r.ok), [true, false, true]);
  assert.deepEqual((await readUiState(dir, host)).settings, { theme: 'light', boardAlign: 'left', uiScale: 150 });
});
