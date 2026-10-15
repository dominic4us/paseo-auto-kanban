/**
 * REQ-139: how large the Kanban screens draw — the browser's Cmd +/− for the plugin's own area only (the host's sidebar,
 * chat and window frames are not ours and stay as they are). Every fixed size the screens draw with — a font, a line, a
 * padding, a column — goes through `px`, so one factor reaches them all and a new screen follows by writing `px(12)`.
 * The factor is not a CSS zoom or a transform over the whole screen: those leave the drag targets, popovers and tips
 * measured in one space and drawn in another (research/329 method B). Here the sizes themselves change, so whatever is
 * measured is where it is drawn.
 * Not scaled: a line's thickness (1px stays crisp; `borderWidth` is never sent through `px`), what the host owns (its
 * header, the system bar), the widths that choose a layout (760: wide or phone), times and counts.
 * At 100% `px(n)` is `n` itself, so the screens are exactly what they were before.
 * The factor is the user's, per host, stored with the other display settings in `ui-state.json` (`uiScale`); the root
 * of each screen sets it before its children draw (`useUiScale` in settings.ts).
 */
export const UI_SCALE = { min: 80, max: 150, step: 10, default: 100 } as const;
/** A stored or chosen percentage, made one of the steps between 80 and 150; anything unreadable is 100. */
export function clampScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_SCALE.default;
  const stepped = Math.round(value / UI_SCALE.step) * UI_SCALE.step;
  return Math.min(UI_SCALE.max, Math.max(UI_SCALE.min, stepped));
}
/** One step smaller (−1) or larger (+1), kept inside 80–150. */
export const stepScale = (percent: number, direction: -1 | 1) => clampScale(clampScale(percent) + direction * UI_SCALE.step);
export const canStep = (percent: number, direction: -1 | 1) => stepScale(percent, direction) !== clampScale(percent);

let factor = 1;
/** Called by a screen's root while it draws, before its children: every `px` under it then reads this percentage. */
export function setUiScale(percent: number) { factor = clampScale(percent) / 100; }
export const uiScaleFactor = () => factor;
/** A fixed size at the current scale. At 100% the number itself; otherwise rounded to a hundredth of a pixel. */
export function px(n: number): number {
  return factor === 1 ? n : Math.round(n * factor * 100) / 100;
}
/**
 * A table of sizes read at the current scale: each field is read through `px` when it is read, so a table built when the
 * module loaded still follows a later change. `fixed` names the fields that are not sizes (a z-index, an opacity, a
 * count, a line's thickness, a breakpoint) and are read as written.
 */
export function scaled<T extends Record<string, unknown>>(base: T, fixed: readonly (keyof T)[] = []): T {
  const table = {} as T;
  // D54 (research/364): Hermes, the phone apps' engine, has no block scope for let/const by default, so a getter made in the
  // loop would read the loop's last value (every MOBILE size 12, every RING size 900). Each value is held by a call of its own.
  const define = (key: keyof T, value: unknown) => Object.defineProperty(table, key, typeof value !== 'number' || fixed.includes(key)
    ? { value, enumerable: true } : { get: () => px(value), enumerable: true });
  for (const key of Object.keys(base) as (keyof T)[]) define(key, base[key]);
  return Object.freeze(table);
}
