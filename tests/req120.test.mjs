// REQ-120 (research/194 v2 M2, the owner's choice): a topic lead's mark is a two-tone medal (REQ-123: antique gold, was silver) — a ring and split ribbon
// tails (the base) with a lighter face inside it — 16px, where the workspace's lead keeps the 13px gold crown. Two PNGs in
// one box, each tinted (React Native Image). REQ-121 moved the tails to a third layer of their own and REQ-122 grew the crown
// to 16px (tests/req121-122.test.mjs). The render is in tests/plugin-ui.test.mjs ("REQ-120 …"), the screens in
// tests/web/run.mjs ("req117-…"). REQ-123 (research/209 B, the owner's choice "은색보다 눈에 들어오되 금 왕관보다 덜 튀게"):
// an antique gold base with a champagne face, less saturated and less bright than the crown's gold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PASEO_THEMES, palette, crownColor, medalColors, contrast, hoverFill, resolveTheme, selectedTint, viewedTint } from '../dist/client/palette.js';
import { CROWN_FILLED_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG } from '../dist/client/leader-icons.js';

const WANT = {
  light: { base: '#987a59', light: '#f1e7d2', archived: { base: '#b5a99b', light: '#e5e1d9' } },
  dark: { base: '#bba07f', light: '#f5eedc', archived: { base: '#71675b', light: '#8c8982' } },
};
test('REQ-120 the medal\'s two tones, light and dark, active and archived', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), w = WANT[mode];
    const { ribbon, ...medal } = medalColors(c, c.card), { ribbon: oldRibbon, ...oldMedal } = medalColors(c, c.card, true);
    assert.deepEqual(medal, { base: w.base, light: w.light }, mode + ': active');
    assert.deepEqual(oldMedal, w.archived, mode + ': archived');
    assert.equal(medalColors(c, c.card).base, crownColor(c, c.card, false, true), mode + ': the base is crownColor\'s topic');
    assert.notEqual(medalColors(c, c.card).base, crownColor(c, c.card), mode + ': not the gold');
    // The face stands apart from its ring.
    const { base, light } = medalColors(c, c.card);
    assert.ok(contrast(base, light) >= 2, `${mode}: face on base ${contrast(base, light).toFixed(2)}`);
  }
});
// REQ-123: the gold medal sits under the crown's gold — lower saturation and brightness (HSV), so it is seen but quieter.
const hsv = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b);
  return { s: max ? (max - min) / max : 0, v: max }; };
test('REQ-123 the medal is antique gold, quieter than the crown: its base less saturated and less bright than the gold', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), medal = hsv(medalColors(c, c.card).base), gold = hsv(crownColor(c, c.card));
    assert.ok(medal.s < gold.s && medal.v < gold.v, `${mode}: medal s${medal.s.toFixed(2)} v${medal.v.toFixed(2)}, gold s${gold.s.toFixed(2)} v${gold.v.toFixed(2)}`);
  }
});
test('REQ-120 the active base stands 3:1 on every face a card takes, in every theme choice; the archived one sinks under it', () => {
  for (const host of ['light', 'dark']) for (const choice of ['paseo', 'system', 'light', 'dark']) for (const system of ['light', 'dark', null]) {
    const c = palette(resolveTheme(PASEO_THEMES[host], choice, system)), where = `${host}/${choice}/${system}`;
    for (const [name, face] of [['card', c.card], ['looked at', viewedTint(c, c.card)], ['selected', selectedTint(c, c.card)], ['hovered', hoverFill(c, c.card)]]) {
      const { base } = medalColors(c, face);
      assert.ok(contrast(base, face) >= 3, `${where} ${name}: ${base} ${contrast(base, face).toFixed(2)}`);
    }
    const out = medalColors(c, c.card, true), on = medalColors(c, c.card);
    assert.ok(contrast(out.base, c.card) < 3 && contrast(out.base, c.card) < contrast(on.base, c.card), where + ': archived is quieter');
  }
});
test('REQ-120 the medal\'s layers are 48px PNGs from assets/leader-icons', () => {
  const png = uri => Buffer.from(uri.replace(/^data:image\/png;base64,/, ''), 'base64');
  for (const uri of [CROWN_FILLED_PNG, MEDAL_BASE_PNG, MEDAL_LIGHT_PNG]) {
    const b = png(uri);
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [48, 48]);
  }
  assert.notEqual(MEDAL_BASE_PNG, MEDAL_LIGHT_PNG);
  const svg = name => readFileSync(new URL(`../assets/leader-icons/${name}.svg`, import.meta.url), 'utf8');
  assert.match(svg('medal-base'), /lucide "award".*ISC/);
  assert.match(svg('medal-light'), /ISC/);
  const source = readFileSync(new URL('../client/leader-icons.ts', import.meta.url), 'utf8');
  assert.match(source, /lucide "crown" and "award" \(https:\/\/lucide\.dev, ISC/);
  assert.match(source, /medal-ribbon\.svg, medal-base\.svg and medal-light\.svg/);
});
