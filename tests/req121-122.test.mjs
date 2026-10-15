// REQ-121 (research/202 R3, the owner's choice): the topic lead's medal (REQ-123: antique gold) gets a quiet petrol ribbon — a third PNG under
// the ring and disc (the tails left the base layer), tinted light #497b83 / dark #82b5be, archived #9cafb2 / #5b6d70.
// REQ-122 (research/202 K3, the owner's choice "K3. 다크는 #f2c230 톤으로"; research/203): the lead's gold crown in two tones — a
// round mount on each of its points in the base PNG, three deep-amber beads over them; the dark gold stays #F2C230; 16px like
// the medal, so both titles start at one x. The render is in tests/plugin-ui.test.mjs ("REQ-121·122 …"), the screens in
// tests/web/run.mjs ("req117-…", "req95-96-…").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PASEO_THEMES, palette, crownColor, crownColors, medalColors, contrast, resolveTheme, selectedTint, viewedTint } from '../dist/client/palette.js';
import { CROWN_BEADS_PNG, CROWN_FILLED_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG, MEDAL_RIBBON_PNG } from '../dist/client/leader-icons.js';

const RIBBON = { light: { on: '#497b83', out: '#9cafb2' }, dark: { on: '#82b5be', out: '#5b6d70' } };
const CROWN = { light: { base: '#bb8e14', beads: '#6c4701', out: { base: '#aba491', beads: '#777165' } },
  dark: { base: '#F2C230', beads: '#8a5d00', out: { base: '#79725e', beads: '#585246' } } };
const png = uri => Buffer.from(uri.replace(/^data:image\/png;base64,/, ''), 'base64');
const svg = name => readFileSync(new URL(`../assets/leader-icons/${name}.svg`, import.meta.url), 'utf8');

test('REQ-121 the medal\'s ribbon: petrol, light and dark, active and archived; the base as it was', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), w = RIBBON[mode];
    assert.equal(medalColors(c, c.card).ribbon, w.on, mode + ': active');
    assert.equal(medalColors(c, c.card, true).ribbon, w.out, mode + ': archived');
    assert.equal(c.crownSubRibbon, w.on, mode + ': the token, unchanged by readable on the default card');
    assert.equal(medalColors(c, c.card).base, crownColor(c, c.card, false, true), mode + ': the base is still crownColor\'s topic');
    assert.deepEqual(Object.keys(medalColors(c, c.card)), ['ribbon', 'base', 'light'], mode + ': three layers, bottom first');
    assert.notEqual(medalColors(c, c.card).ribbon, medalColors(c, c.card).base, mode + ': the ribbon is not the base');
  }
});
test('REQ-121 the active ribbon stands 3:1 on its card in every theme choice (readable, as the base); the archived one sinks under it', () => {
  for (const host of ['light', 'dark']) for (const choice of ['paseo', 'system', 'light', 'dark']) for (const system of ['light', 'dark', null]) {
    const c = palette(resolveTheme(PASEO_THEMES[host], choice, system)), where = `${host}/${choice}/${system}`;
    for (const [name, face] of [['card', c.card], ['looked at', viewedTint(c, c.card)], ['selected', selectedTint(c, c.card)]]) {
      const { ribbon } = medalColors(c, face);
      assert.ok(contrast(ribbon, face) >= 3, `${where} ${name}: ${ribbon} ${contrast(ribbon, face).toFixed(2)}`);
    }
    const out = medalColors(c, c.card, true).ribbon, on = medalColors(c, c.card).ribbon;
    assert.ok(contrast(out, c.card) < 3 && contrast(out, c.card) < contrast(on, c.card), `${where}: archived is quieter`);
  }
  // A theme whose card is near the ribbon's own lightness: readable moves it, as it moves the medal's base.
  const c = palette(PASEO_THEMES.light), face = '#5a8a92';
  assert.ok(contrast(medalColors(c, face).ribbon, face) >= 3);
});
test('REQ-122 the crown\'s two tones: the gold as it was (dark #F2C230 kept), deep-amber beads, archived sunk', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), w = CROWN[mode];
    assert.deepEqual(crownColors(c, c.card), { base: w.base, beads: w.beads }, mode + ': active');
    assert.deepEqual(crownColors(c, c.card, true), w.out, mode + ': archived');
    assert.equal(crownColors(c, c.card).base, crownColor(c, c.card), mode + ': the base is crownColor');
    // The beads are darker than the gold — they must read on it at 16px (a white bead is 1.68:1 on the dark gold).
    const { base, beads } = crownColors(c, c.card);
    assert.ok(contrast(base, beads) >= 2.5, `${mode}: beads on gold ${contrast(base, beads).toFixed(2)}`);
    assert.ok(contrast(beads, '#000') < contrast(base, '#000'), mode + ': darker than the gold');
    const out = crownColors(c, c.card, true);
    assert.ok(contrast(out.beads, out.base) > 1.4 && contrast(out.beads, out.base) < contrast(beads, base), mode + ': archived beads quieter');
  }
  assert.equal(palette(PASEO_THEMES.dark).crown, '#F2C230', 'the owner: "다크는 #f2c230 톤으로"');
});
test('REQ-122 the crown is 16px, the medal\'s size, so both titles start at one x', () => {
  const source = readFileSync(new URL('../client/components.tsx', import.meta.url), 'utf8');
  assert.match(source, /export const LEADER_ICON = 16;/);
  assert.match(source, /export const TOPIC_LEADER_ICON = 16;/);
});
test('REQ-121·122 five 48px layer PNGs from assets/leader-icons: the tails left the base, mounts joined the crown', () => {
  for (const uri of [CROWN_FILLED_PNG, CROWN_BEADS_PNG, MEDAL_RIBBON_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG]) {
    const b = png(uri);
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [48, 48]);
    assert.equal(new Set([CROWN_FILLED_PNG, CROWN_BEADS_PNG, MEDAL_RIBBON_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG]).size, 5);
  }
  assert.doesNotMatch(svg('medal-base'), /<path/, 'no tails in the base');
  assert.equal((svg('medal-ribbon').match(/<path /g) ?? []).length, 2, 'the two tails');
  assert.equal((svg('crown-filled').match(/<circle /g) ?? []).length, 3, 'three mounts');
  assert.equal((svg('crown-beads').match(/<circle /g) ?? []).length, 3, 'three beads');
  // Each bead lies inside its mount, with a gold rim round it.
  const circles = name => [...svg(name).matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(m => m.slice(1).map(Number));
  const mounts = circles('crown-filled'), beads = circles('crown-beads');
  beads.forEach(([x, y, r], i) => { const [mx, my, mr] = mounts[i]; assert.ok(x === mx && y === my && mr - r >= .9, `bead ${i}`); });
  for (const name of ['crown-filled', 'crown-beads', 'medal-ribbon', 'medal-base', 'medal-light']) assert.match(svg(name), /lucide.*ISC/, name);
  const source = readFileSync(new URL('../client/leader-icons.ts', import.meta.url), 'utf8');
  assert.match(source, /lucide "crown" and "award" \(https:\/\/lucide\.dev, ISC/);
  for (const name of ['CROWN_BEADS_PNG', 'MEDAL_RIBBON_PNG']) assert.match(source, new RegExp(`export const ${name} = 'data:image/png;base64,`));
});
