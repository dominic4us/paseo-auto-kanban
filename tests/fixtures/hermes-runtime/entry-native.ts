/**
 * REQ-146 (research/378): every client/shared module loaded with React Native standing in (`native-host.mjs`), so the
 * screens' own size tables (status-icon's RING, components' TIP, quick-move's STEP) and the handler joining D54 also broke
 * (`joinHandlers`) are compared too. Nothing is drawn: only what a module computes when it loads, and the calls below.
 * `client/__all_modules.ts` is written into the copy by `scripts/hermes-runtime.mjs` (every client/shared source).
 * This file itself runs in Hermes with no block scope: no function made in a loop may keep the loop's variable.
 */
import { MODULES } from './client/__all_modules.js';
import { setUiScale } from './client/ui-scale.js';
import { joinHandlers } from './client/components.js';
import { attempt, type Json } from './client/__snapshot.js';

function exportedValues(): Json {
  const out: { [key: string]: Json } = {};
  for (const name of Object.keys(MODULES)) {
    const module = MODULES[name]!, values: { [key: string]: Json } = {};
    for (const key of Object.keys(module).sort()) if (typeof module[key] !== 'function') values[key] = attempt(() => module[key]);
    out[name] = values;
  }
  return out;
}
/** D54's second place: each event must call every handler given for it, in order — not the last pair's, twice. */
function joined(): Json {
  const calls: string[] = [];
  const log = (name: string) => () => { calls.push(name); };
  const out = joinHandlers({ onHoverIn: log('tip in'), onHoverOut: log('tip out') }, { onHoverIn: log('hover in'), onHoverOut: log('hover out') },
    { onPress: log('press') }, { onHoverIn: undefined, onPress: log('press 2') });
  for (const event of Object.keys(out).sort()) out[event]!();
  return { events: Object.keys(out).sort(), calls };
}

export default function compute(): Json {
  const scales: { [key: string]: Json } = {};
  for (const percent of [100, 80, 150]) {
    setUiScale(percent);
    scales[String(percent)] = exportedValues();
  }
  setUiScale(100);
  return { scales, joinHandlers: attempt(joined), modules: Object.keys(MODULES) };
}
