import type { PluginTheme } from '@getpaseo/plugin';
import { scaled } from './ui-scale.js';
// Semantic fallbacks live here only; prefer usable host surface/accent tokens.
// statusDot* are Paseo v0.8.0 theme.ts status-dot values (Apache-2.0); PluginTheme has no such token.
// https://github.com/getpaseo/paseo/blob/v0.8.0/packages/app/src/styles/theme.ts
const auxiliary = {
  // REQ-73: statusDotIdle is the sidebar's finished dot (extra-muted grey, Paseo 0.9.1 web bundle; drawn at .3 opacity).
  light: { running: '#268ae0', statusDotWarning: '#b37824', statusDotDanger: '#f12e2f', statusDotSuccess: '#299f51', statusDotIdle: '#a1a1aa',
    draft: '#746186', blocked: '#8e5464', cardShadow: '#24282b', modalBackdrop: 'rgba(0,0,0,0.45)',
    stageBlue: '#287ac8', stagePurple: '#8057b0', panel: '#e7eaed', card: '#ffffff', badge: '#d0d5db', divider: '#c2c9d0',
    panelHeader: '#f3f5f7', stickyEdge: 'transparent', crown: '#D4A017', crownArchived: '#aba491', leaderOutlineArchived: '#52525b',
    crownBead: '#6c4701', crownArchivedBead: '#777165',
    crownSub: '#987a59', crownSubLight: '#f1e7d2', crownSubArchived: '#b5a99b', crownSubArchivedLight: '#e5e1d9',
    crownSubRibbon: '#497b83', crownSubRibbonArchived: '#9cafb2' },
  dark: { running: '#5caaf6', statusDotWarning: '#db932e', statusDotDanger: '#f7796d', statusDotSuccess: '#35c264', statusDotIdle: '#717574',
    draft: '#bfb0d3', blocked: '#c5a7af', cardShadow: '#000000', modalBackdrop: 'rgba(0,0,0,0.6)',
    stageBlue: '#65aff2', stagePurple: '#ba98e4', panel: '#262a29', card: '#343a38', badge: '#101412', divider: '#48514d',
    panelHeader: '#2f3432', stickyEdge: '#48514d', crown: '#F2C230', crownArchived: '#79725e', leaderOutlineArchived: '#6b6f6d',
    crownBead: '#8a5d00', crownArchivedBead: '#585246',
    crownSub: '#bba07f', crownSubLight: '#f5eedc', crownSubArchived: '#71675b', crownSubArchivedLight: '#8c8982',
    crownSubRibbon: '#82b5be', crownSubRibbonArchived: '#5b6d70' },
};
export function rgb(value: string): number[] | null {
  const hex = value.replace(/^#/, '');
  if (!/^(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(hex)) return null;
  const n = parseInt(hex.length === 3 ? [...hex].map(c => c + c).join('') : hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function luminance(value: string): number | null {
  const channels = rgb(value)?.map(n => { const s = n / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
  return channels ? channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722 : null;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return x === null || y === null ? 0 : (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
/**
 * D27: nudges `text`'s lightness, toward black or white (whichever direction the background favours),
 * just far enough that it reads at `min` contrast against `background`. Hue and saturation are kept, so a
 * muted or status colour stays recognisably itself instead of collapsing to plain foreground text.
 */
export function readable(text: string, background: string, min = 4.5): string {
  if (contrast(text, background) >= min) return text;
  const channels = rgb(text);
  if (!channels) return text;
  const [h, s, l] = hsl(channels);
  const towardBlack = contrast('#000000', background) >= contrast('#ffffff', background);
  let lo = towardBlack ? 0 : l, hi = towardBlack ? l : 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2, ok = contrast(hex([h, s, mid]), background) >= min;
    if (towardBlack) { if (ok) lo = mid; else hi = mid; } else { if (ok) hi = mid; else lo = mid; }
  }
  return hex([h, s, towardBlack ? lo : hi]);
}
export function blueAccent(value: string): boolean {
  const channels = rgb(value); if (!channels) return false;
  const [r, g, b] = channels as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta === 0 || delta / max < .25) return false;
  const hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  return hue >= 200 && hue <= 255;
}
function hsl([r, g, b]: number[]): [number, number, number] {
  const [x, y, z] = [r! / 255, g! / 255, b! / 255], max = Math.max(x, y, z), min = Math.min(x, y, z), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === x ? (y - z) / d + (y < z ? 6 : 0) : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return [h / 6, s, l];
}
function hex([h, s, l]: [number, number, number]): string {
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (t: number) => { t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return '#' + [h + 1 / 3, h, h - 1 / 3].map(t => Math.round(channel(t) * 255).toString(16).padStart(2, '0')).join('');
}
/**
 * REQ-67 ④: `amount` more HSL saturation at the same relative luminance, so the colour is livelier but any
 * text drawn in it keeps its contrast against every background (the lightness is searched to hold it).
 */
export function saturate(value: string, amount: number): string {
  // A partial host theme may leave the colour out; there is nothing to change then.
  if (typeof value !== 'string') return value;
  const channels = rgb(value), target = luminance(value);
  if (!channels || target === null) return value;
  const [h, s] = hsl(channels), next = Math.min(1, s + amount);
  // A grey has no hue to strengthen; saturating it would invent one (red, at hue 0).
  if (s < .05) return value;
  let low = 0, high = 1;
  for (let i = 0; i < 24; i++) { const mid = (low + high) / 2; if ((luminance(hex([h, next, mid])) ?? 0) < target) low = mid; else high = mid; }
  // Each channel is rounded to 8 bits; of the nearby lightnesses keep the one whose rounded colour is closest.
  const mid = (low + high) / 2, error = (l: number) => Math.abs((luminance(hex([h, next, l])) ?? 0) - target);
  let best = mid;
  for (let step = -20; step <= 20; step++) { const l = mid + step * .0005; if (l > 0 && l < 1 && error(l) < error(best)) best = l; }
  return hex([h, next, best]);
}
/**
 * REQ-70: the host gives only the current mode's colours, so a forced light or dark needs a set of its own.
 * These are Paseo 0.9.1's default light and default ("Paseo") dark themes as its `toPluginTheme` hands them
 * to plugins — the same eleven tokens, read from the shipped web bundle (@getpaseo/server 0.9.1
 * dist/server/web-ui, `styles/theme.ts`; Apache-2.0). Copy: raw_sources/paseo_0.9.1/theme-defaults-0.9.1.md.
 */
export const PASEO_THEMES: Record<'light' | 'dark', PluginTheme> = {
  light: { colors: { surface0: '#ffffff', surface1: '#fafafa', surface2: '#f4f4f5', border: '#e4e4e7',
    foreground: '#1a1a1e', foregroundMuted: '#71717a', accent: '#20744A', accentForeground: '#ffffff',
    statusSuccess: '#3e704a', statusWarning: '#7b5d39', statusDanger: '#9d433b' } },
  dark: { colors: { surface0: '#181B1A', surface1: '#1E2120', surface2: '#272A29', border: '#252B2A',
    foreground: '#fafafa', foregroundMuted: '#A1A5A4', accent: '#20744A', accentForeground: '#ffffff',
    statusSuccess: '#6cb17b', statusWarning: '#c09664', statusDanger: '#d8847b' } },
};
/** Which mode a host theme is in, by its page colour (the same test `palette` uses). */
export function themeMode(theme: PluginTheme): 'light' | 'dark' {
  return (luminance(theme.colors.surface0) ?? 0) > .45 ? 'light' : 'dark';
}
/**
 * REQ-70: the theme Kanban draws with. Paseo, or a choice that lands on the mode the host is already in,
 * keeps the host's colours exactly (its tint and accent included); only the other mode uses the set above.
 * "System" follows the device's scheme, or the host when the device does not say.
 */
export function resolveTheme(host: PluginTheme, choice: 'paseo' | 'system' | 'light' | 'dark',
  system: 'light' | 'dark' | null | undefined): PluginTheme {
  const mode = choice === 'system' ? system ?? null : choice === 'paseo' ? null : choice;
  return mode === null || mode === themeMode(host) ? host : PASEO_THEMES[mode];
}
/**
 * REQ-82: what is chosen right now — the detail's current stage — is outlined in the theme's main colour (its
 * accent). A non-text mark needs 3:1 (WCAG 1.4.11); the line is held to 3.5:1 so it reads with room to spare
 * (research/117 G3: a dark theme's accent measured 3.02). An accent that falls short is replaced by the theme's own
 * colour nearest to it in hue that clears the mark — never a new colour, since a Kanban window is drawn from the
 * chosen set only (REQ-72 ①). Only with no such colour is the accent lightened or darkened. REQ-80 is to draw a
 * toggle that is on in the same line, so both come from here.
 */
export const SELECTED_LINE_WIDTH = 2, SELECTED_LINE_CONTRAST = 3.5;
export function selectedLine(colors: { accent: string } & Record<string, unknown>, background: string): string {
  if (contrast(colors.accent, background) >= SELECTED_LINE_CONTRAST) return colors.accent;
  const hue = (value: string) => { const channels = rgb(value); return channels ? hsl(channels) : null; };
  const accent = hue(colors.accent);
  let best: { value: string; distance: number } | null = null;
  for (const value of Object.values(colors)) {
    const shade = typeof value === 'string' ? hue(value) : null;
    // A colour, not a grey, that clears the mark on this background.
    if (!accent || !shade || shade[1] < .25 || contrast(value as string, background) < SELECTED_LINE_CONTRAST) continue;
    const apart = Math.abs(shade[0] - accent[0]), distance = Math.min(apart, 1 - apart);
    if (!best || distance < best.distance) best = { value: value as string, distance };
  }
  return best?.value ?? readable(colors.accent, background, SELECTED_LINE_CONTRAST);
}
/**
 * REQ-85 ②③⑨ (research/128, the chosen sample): what is switched on or chosen is no longer outlined but filled — the
 * selected line's colour (`selectedLine`) mixed into what it sits on, 16% on a light background and 18% on a dark one
 * (26%/28% under the mouse). A tint alone stands only about 1.3:1 from its background, under the 3:1 a mark needs
 * (WCAG 1.4.11), so a tool glyph that is on also draws its glyph in the main colour (`selectedLine` against the tint,
 * ≥3.5:1), and a chosen row keeps its check mark and bold words. Grey hover (`hoverFill`) stays apart from it by hue.
 */
export const SELECTED_TINT = { light: .16, dark: .18 }, SELECTED_TINT_HOVER = { light: .26, dark: .28 };
export function mixColors(base: string, top: string, amount: number): string {
  const a = rgb(base), b = rgb(top);
  if (!a || !b) return base;
  return '#' + a.map((value, i) => Math.round(value + (b[i]! - value) * amount).toString(16).padStart(2, '0')).join('');
}
export function selectedTint(colors: { accent: string } & Record<string, unknown>, background: string, hovered = false): string {
  const light = (luminance(background) ?? 1) > .4, step = hovered ? SELECTED_TINT_HOVER : SELECTED_TINT;
  return mixColors(background, selectedLine(colors, background), light ? step.light : step.dark);
}
/**
 * REQ-118: a glyph's count (the filters applied, REQ-91/REQ-114) in the same quiet key as the glyph it sits on when that
 * is on — the light tint behind it, a 1px line of the main colour half mixed into what it sits on (so it keeps its own
 * edge on the tinted glyph), and the figure in the main colour at 4.5:1 on the tint. It was a solid main-colour disc
 * with a white figure, which drew the eye before anything else on the row. `COUNT_BADGE` is its size and weight.
 */
export const COUNT_BADGE = scaled({ size: 14, fontSize: 10, lineHeight: 12, fontWeight: '500', line: .45, overhang: 4 } as const, ['line']);
export function countBadge(colors: { accent: string } & Record<string, unknown>, background: string) {
  const fill = selectedTint(colors, background);
  return { fill, line: mixColors(background, selectedLine(colors, background), COUNT_BADGE.line), text: readable(selectedLine(colors, fill), fill) };
}
/**
 * REQ-80: a glyph button under the mouse. The host publishes no hover token, and its surfaces can sit almost on top
 * of each other (dark surface2 and border are 1.0:1 apart), so the fill is the button's own background moved a set
 * step toward the theme's text colour — darker in light, lighter in dark, from two host tokens only.
 * research/121 H2: a set 14% was 1.33:1 on a light page, too faint to notice, so the step now grows from there until
 * the fill stands `HOVER_CONTRAST` apart from the button's own resting fill (light ≈23%, dark ≈16%), capped at `HOVER_MIX_MAX`.
 * It stays a grey of the theme's own two tokens, never the main colour, so it cannot be taken for the on line.
 */
export const HOVER_MIX = .14, HOVER_MIX_MAX = .4, HOVER_CONTRAST = 1.6;
export function hoverFill(colors: { foreground: string }, base: string): string {
  const a = rgb(base), b = rgb(colors.foreground);
  if (!a || !b) return base;
  const mix = (step: number) => '#' + a.map((value, i) => Math.round(value + (b[i]! - value) * step).toString(16).padStart(2, '0')).join('');
  let step = HOVER_MIX;
  while (step < HOVER_MIX_MAX && contrast(mix(step), base) < HOVER_CONTRAST) step = Math.round((step + .01) * 100) / 100;
  return mix(step);
}
/**
 * REQ-88 ② (research/129 ②A, replacing D28's 3:1 field edge): a text field's resting edge is faint — the theme's border
 * moved toward its text colour only until it stands `FIELD_LINE_CONTRAST` from the field's own fill (light ≈#c8c8cd, dark
 * ≈#434947), so a field keeps its shape without its line reading before its words. Under the mouse and while typing the edge
 * is the main colour (`selectedLine`) at the same 1px, so nothing shifts. The label above every field and that line stand
 * for WCAG 1.4.11's 3:1 boundary, which a resting edge this quiet does not meet — the trade chosen over D28.
 */
export const FIELD_LINE_CONTRAST = 1.5, FIELD_LINE_WIDTH = 1;
export function fieldLine(colors: { border: string; foreground: string }, fill: string): string {
  const a = rgb(colors.border), b = rgb(colors.foreground);
  if (!a || !b) return colors.border;
  const mix = (step: number) => '#' + a.map((value, i) => Math.round(value + (b[i]! - value) * step).toString(16).padStart(2, '0')).join('');
  let step = 0;
  while (step < .6 && contrast(mix(step), fill) < FIELD_LINE_CONTRAST) step = Math.round((step + .02) * 100) / 100;
  return mix(step);
}
/** REQ-67 ④: how much livelier the done stage is than the host's success colour. */
export const DONE_SATURATION = .12;
/** REQ-40: the step a board plane must clear to read as separate from the one behind it. */
export const SURFACE_STEP = 1.15;
export function palette(theme: PluginTheme) {
  const c = theme.colors, light = themeMode(theme) === 'light';
  const a = auxiliary[light ? 'light' : 'dark'];
  // The light board reads as a brighter card on a grey column panel over the page background. Dark used
  // to take the darkest host surface for the panel, which is the page colour itself, so the columns
  // vanished into the background (REQ-40). Both themes now keep the same two steps: the panel must
  // separate from surface0, and the card from the panel.
  let panel = c.surface2, card = light ? c.surface0 : a.card;
  if ((luminance(card) ?? 0) <= (luminance(panel) ?? 0) || contrast(panel, card) < SURFACE_STEP
    || contrast(panel, c.surface0) < SURFACE_STEP) { panel = a.panel; card = a.card; }
  // The stage band sits inside the panel, so it stays on the brighter side of it in both themes.
  const panelHeader = (luminance(c.surface1) ?? 0) > (luminance(panel) ?? 0) ? c.surface1 : a.panelHeader;
  return { ...c, ...a, panel, card, panelHeader,
    ...(luminance(c.surface0) === null ? { draft: c.foregroundMuted, blocked: c.statusDanger, running: c.accent,
      statusDotWarning: c.statusWarning, statusDotDanger: c.statusDanger, statusDotSuccess: c.statusSuccess } : {}),
    stageBlue: blueAccent(c.accent) ? c.accent : a.stageBlue,
    // REQ-67 ④: the done stage (dot, stripe, tab, progress) — the host success hue, a little more saturated.
    stageDone: saturate(c.statusSuccess, DONE_SATURATION) };
}
export type Palette = ReturnType<typeof palette>;
/**
 * REQ-95 (replacing REQ-94's state-coloured edge): a card's non-text marks — a parent's 1px edge in its stage's colour
 * (the stripe's token, `stageColor`), and the stripe and edge in the reply colour while an answer is awaited — moved only
 * as far as it takes to stand 3:1 from the card's face (tinted or not, ⑨) and from the column around it.
 */
export function markLine(base: string, colors: Palette, face: string): string {
  return readable(readable(base, colors.panel, 3), face, 3);
}
/**
 * REQ-100 (research/153 B, the owner's choice): a lead's crown is a fixed deep gold (`crown`), not its stage's colour and not
 * the reply orange (the crown and the orange stripe tell "Response needed" apart by shape) — moved only as far as it takes to
 * stand 3:1 from the card's face, tinted or not (light #bb8e14, dark #F2C230 as is). An archived lead's crown is filled and a
 * tone further down (`crownArchived`: research/153 A's archived gold, hue 44°, at ×0.7 saturation and a step toward the face,
 * ≈2.5:1), deliberately under the 3:1 a mark needs — a lead that has gone out, still told apart by its filled shape.
 *
 * REQ-117, REQ-120 (research/194 v2 M2, the owner's choice): a topic lead (`topic`, a lead under the workspace's lead) wears
 * a two-tone medal instead, so the one gold crown still names the workspace's lead. REQ-123 (research/209 B, the owner's choice
 * "은색보다 눈에 들어오되 금 왕관보다 덜 튀게"): an antique gold medal where it was silver. `topic` gives the medal's base
 * (ring and disc, `crownSub`: light #987a59, dark #bba07f — less saturated and less bright than the crown's gold), moved only
 * as far as it takes to stand 3:1 from the face; `medalColors` adds its champagne face. An archived topic lead's base
 * (`crownSubArchived`: light #b5a99b, dark #71675b) sinks toward the card, under 3:1 and not run through `readable`, as the
 * archived gold does.
 */
export function crownColor(colors: Palette, face: string, archived = false, topic = false): string {
  if (topic) return archived ? colors.crownSubArchived : readable(colors.crownSub, face, 3);
  return archived ? colors.crownArchived : readable(colors.crown, face, 3);
}
/**
 * REQ-122 (research/202 K3, the owner's choice; research/203): the lead's crown in two tones — `base` as `crownColor` (the gold,
 * dark #F2C230 kept as is), `beads` the three beads on its points (`crownBead`: light #6c4701, dark #8a5d00 — a deep amber,
 * darker than the gold: 2.75 and 3.44:1 on it, where a white bead measures 1.68 on the dark gold and on a light card turns the
 * points into holes; the gold rim round each bead keeps the crown's outline). Archived: `crownArchivedBead` (light #777165,
 * dark #585246), a step under the archived gold, the way the archived crown sinks.
 */
export function crownColors(colors: Palette, face: string, archived = false): { base: string; beads: string } {
  return { base: crownColor(colors, face, archived), beads: archived ? colors.crownArchivedBead : colors.crownBead };
}
/**
 * REQ-120: the topic lead's medal, its layers' tints — `base` as `crownColor`'s `topic`, `light` its face (REQ-123 champagne,
 * `crownSubLight`: light #f1e7d2, dark #f5eedc; archived `crownSubArchivedLight`: light #e5e1d9, dark #8c8982), drawn inside
 * the base's ring.
 * REQ-121 (research/202 R3, the owner's choice): `ribbon` its tails, a quiet petrol (`crownSubRibbon`: light #497b83, dark
 * #82b5be — hue 209°, clear of the stage blues and greens, the gold and the reply orange), moved only as far as it takes to stand
 * 3:1 from the face as the base is (4.73 and 5.14:1 on the default cards, so unchanged there); archived `crownSubRibbonArchived`
 * (light #9cafb2, dark #5b6d70) sinks under 3:1 with the archived base.
 */
export function medalColors(colors: Palette, face: string, archived = false): { ribbon: string; base: string; light: string } {
  return { ribbon: archived ? colors.crownSubRibbonArchived : readable(colors.crownSubRibbon, face, 3),
    base: crownColor(colors, face, archived, true), light: archived ? colors.crownSubArchivedLight : colors.crownSubLight };
}
/**
 * REQ-105 (replacing REQ-95 ①/REQ-98's stage-coloured edge, the owner's own choice: "총괄 아이콘과 외곽선 색상까지 있으니
 * 너무 시선을 끄는 요소가 많음. 하나만 있으면 됨"): a lead's edge is no longer its stage's colour, so the gold crown is the
 * one thing calling for a look. It takes the grey an archived lead's edge already used (`colors.foregroundMuted`, 3:1 by
 * `markLine`), and an archived lead steps to a darker, hue-neutral grey of its own (`leaderOutlineArchived`) — not run
 * through `markLine`, so it can sit under 3:1 the way the archived crown does (a quieter lead, not a louder one; on a
 * light face this darker grey can measure a higher contrast number than the active grey, which is expected). "Response
 * needed" still wins (REQ-95 ③) — the stripe and the edge both turn orange regardless of archived.
 */
export function leaderOutline(colors: Palette, face: string, archived = false): string {
  return archived ? colors.leaderOutlineArchived : markLine(colors.foregroundMuted, colors, face);
}
/** REQ-95 ③: "Response needed" — the warning dot's orange, on every card whatever its stage. */
export const replyColor = (colors: Palette) => colors.statusDotWarning;
/**
 * J5 (research/149): "Response needed ↗" is a link, so it looks like one — a small chip of that orange: a faint fill of it
 * over `face` (deeper under the mouse), its edge the stripe's 3:1 orange (`markLine`), the words 4.5:1 on the fill.
 */
export const REPLY_CHIP_FILL = { rest: .1, hover: .2 };
export function replyChip(colors: Palette, face: string, hovered = false) {
  const fill = mixColors(face, replyColor(colors), hovered ? REPLY_CHIP_FILL.hover : REPLY_CHIP_FILL.rest);
  return { backgroundColor: fill, borderColor: markLine(replyColor(colors), colors, fill), color: readable(colors.statusWarning, fill) };
}
/**
 * REQ-95 ④ (replacing REQ-85 ⑨'s main-colour tint): the card just looked at is a grey step from its face — toward the
 * theme's text colour, just far enough to stand `VIEWED_CONTRAST` from it — so it never reads as "chosen" or "done".
 * J4 (research/149): 1.12 measured 1.13 and read too faint; 1.3 now.
 */
export const VIEWED_CONTRAST = 1.3;
export function viewedTint(colors: { foreground: string }, base: string): string {
  let step = .02;
  while (step < .3 && contrast(mixColors(base, colors.foreground, step), base) < VIEWED_CONTRAST) step = Math.round((step + .01) * 100) / 100;
  return mixColors(base, colors.foreground, step);
}

// Paseo v0.8.0 identity-colors.ts (Apache-2.0), ordered identity background palette.
// https://github.com/getpaseo/paseo/blob/v0.8.0/packages/app/src/styles/identity-colors.ts
export const projectColors = ['#7a6aa8', '#3d7ea6', '#388068', '#a4673a', '#b05c80',
  '#6a70b8', '#368080', '#b06260', '#8f7838', '#5179b0'] as const;
export const projectIconForeground = '#ffffff';

// Paseo v0.8.0 identityForeground dark values (Apache-2.0). Its sidebar WorkspaceLabelDot shows this
// one set in light and dark (measured), so the dots here use it in both themes.
const labelColors = { violet: '#a392d5', sky: '#6aa6ce', emerald: '#6cae96', orange: '#cc8f64', pink: '#d87da3',
  indigo: '#9299d5', teal: '#6cacab', red: '#d88381', amber: '#b29d64', blue: '#7ba1d5' };
export function workspaceLabelColor(color: keyof typeof labelColors): string { return labelColors[color]; }
