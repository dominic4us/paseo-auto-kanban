import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { palette, saturate, contrast, luminance, rgb, DONE_SATURATION } from '../dist/client/palette.js';
import { stageColor } from '../dist/client/stage-color.js';
import { copy } from '../dist/client/i18n.js';
import { SWIMLANE } from '../dist/client/swimlane-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { boardGet } from '../dist/shared/rpc.js';
import { builtinTemplate } from '../dist/shared/core/domain.js';
import { fixture } from './helpers.mjs';

// Paseo 0.9.1's own statusSuccess values (light, dark), read from the host web bundle.
const HOST_SUCCESS = { light: '#3e704a', dark: '#6cb17b' };
const light = { colors: { surface0: '#ffffff', surface1: '#fafafa', surface2: '#f4f4f5', foreground: '#24282b',
  foregroundMuted: '#666666', border: '#dddddd', accent: '#268ae0', statusSuccess: HOST_SUCCESS.light,
  statusWarning: '#7b5d39', statusDanger: '#9d433b' } };
const dark = { colors: { ...light.colors, surface0: '#181b1a', surface1: '#1e2120', surface2: '#252927',
  foreground: '#eeeeee', foregroundMuted: '#999999', accent: '#5caaf6', statusSuccess: HOST_SUCCESS.dark } };

function hueSat(value) {
  const [r, g, b] = rgb(value).map(n => n / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = d === 0 ? 0 : (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return { h, s };
}

test('REQ-67 ④ the done colour is the host success hue, a little more saturated, at the same contrast', t => {
  const record = [];
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    const c = palette(theme), before = theme.colors.statusSuccess, after = c.stageDone;
    const a = hueSat(before), b = hueSat(after);
    assert.notEqual(after, before, name + ' changes');
    assert.ok(Math.abs(b.h - a.h) < 2, name + ' keeps the hue');
    assert.ok(Math.abs(b.s - a.s - DONE_SATURATION) < .02, name + ' saturation rises by the step');
    // Text drawn in it (the selected done tab on 390px) keeps its contrast on every surface it sits on — within
    // 1%, the 8-bit rounding of each channel.
    for (const bg of [theme.colors.surface0, theme.colors.surface2, c.panel, c.panelHeader, c.card])
      assert.ok(Math.abs(contrast(after, bg) / contrast(before, bg) - 1) < .01, name + ' contrast on ' + bg);
    const stages = builtinTemplate().stages;
    assert.equal(stageColor('done', stages, c), after, 'the dot, stripe and tab use it');
    record.push({ name, before, after, saturation: [+a.s.toFixed(3), +b.s.toFixed(3)],
      onSurface2: [+contrast(before, theme.colors.surface2).toFixed(2), +contrast(after, theme.colors.surface2).toFixed(2)],
      onPanel: [+contrast(before, c.panel).toFixed(2), +contrast(after, c.panel).toFixed(2)] });
  }
  t.diagnostic(JSON.stringify(record));
});

test('REQ-67 ④ saturate leaves greys, partial themes and non-hex values alone', () => {
  for (const grey of ['#222222', '#777777', '#ffffff']) assert.equal(saturate(grey, .12), grey);
  assert.equal(saturate(undefined, .12), undefined);
  assert.equal(saturate('rgb(0, 128, 0)', .12), 'rgb(0, 128, 0)');
  // Relative luminance is held, whatever the step.
  for (const value of ['#3e704a', '#6cb17b', '#287ac8', '#b06260'])
    assert.ok(Math.abs(luminance(saturate(value, .2)) - luminance(value)) < .002, value);
  assert.equal(palette({ colors: { ...light.colors, statusSuccess: '#222222' } }).stageDone, '#222222');
});

test('REQ-67 ③ card counts are the number alone in both languages; the show-all label keeps its count', () => {
  for (const locale of ['en', 'ko']) {
    const m = copy(locale);
    assert.equal(m.cardCount(24), '24');
    assert.equal(m.moreCards(3), '+3');
    assert.equal(m.doneInBoard, undefined, '"N more completed · Open board" is gone');
    assert.doesNotMatch(m.count(12), /장|cards/);
  }
  assert.equal(copy('ko').expandAll(24), '전부 보기 (24)'); assert.equal(copy('en').expandAll(24), 'Show all (24)');
  assert.equal(copy('ko').count(12), '카드 12'); assert.equal(copy('en').count(12), 'Cards 12');
  // REQ-75 B2: "Board ›" is gone; the ⋯ entry and the rest link into the board stay.
  assert.equal(copy('ko').boardLink, undefined); assert.equal(copy('ko').openInBoard, '보드에서 열기');
  assert.equal(copy('en').boardLink, undefined); assert.equal(copy('en').openInBoard, 'Open in board');
  assert.equal(copy('ko').restInBoard(12), '나머지 12장은 보드에서'); assert.equal(copy('en').restInBoard(12), '12 more in the board');
  assert.equal(SWIMLANE.toggleWidth, undefined, 'the text toggle and its reserved width are gone');
});

test('REQ-67 ⑥ board.get brings the auto-card switch along with the host id, so a board\'s settings window shows it', async t => {
  const f = await fixture(t), handlers = createReadHandlers(f.store);
  const read = async input => { const reply = await handlers.board(input); assert.equal(reply.ok, true); return boardGet.output.parse(reply).data; };
  assert.equal((await read({ workspaceId: 'wks_example01' })).autoCards, undefined, 'without a host id, as before');
  assert.equal((await read({ workspaceId: 'wks_example01', hostId: 'host_sample' })).autoCards, true, 'on unless turned off');
  await writeFile(join(f.store.dataDir, 'auto-cards.json'), JSON.stringify({ schemaVersion: 1, activatedAt: null,
    hosts: { host_sample: { enabled: false, changedAt: '2026-09-23T00:00:00.000Z' } }, agents: {} }));
  assert.equal((await read({ workspaceId: 'wks_example01', hostId: 'host_sample' })).autoCards, false);
});
