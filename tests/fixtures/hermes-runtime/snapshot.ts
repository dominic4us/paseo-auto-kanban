/**
 * REQ-146 (research/378, gate 381 F1): a value's canonical form for comparing node and Hermes, keeping its kind. Two
 * values that differ — a Date's time, an Error's name or message, NaN against the string "NaN", -0 against 0, a key that is
 * not enumerable — never give the same form. `scripts/hermes-runtime.mjs` copies this file into the plugin copy (as
 * `client/__snapshot.ts`) for both entries, so node and Hermes run the one encoder.
 * - JSON's own values stay as they are: strings, booleans, null, finite numbers other than -0, arrays, plain objects.
 * - Every other kind is an object tagged `$t`: number (NaN, ±Infinity, -0), undefined, bigint, symbol, function, date,
 *   error, regexp, map, set, hole (an array's missing index), ref (a value met again on its own path: a cycle).
 *   A plain object's own key that starts with `$` is written with one more `$`, so no data reads as a tag.
 *   An own key that is not enumerable goes under `$hidden`, a symbol key under `$symbols`, a prototype that is not
 *   Object's under `$proto`.
 * - `thrown` (a computation or a getter threw), `unsupported` (a kind this encoder does not know: a Promise, a WeakMap, a
 *   typed array…), `depth` (nested deeper than DEPTH) and `size` (one result over NODES values) are diagnostics: the checker
 *   fails on each, never compares past it.
 * - A zod schema is `schema` with its type: a library's object graph, not a computed value (its behaviour is compared
 *   through `safeParse` in the entry's workflows scenario).
 * This file runs in Hermes with no block scope: no function made in a loop may keep the loop's variable.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const DEPTH = 24, NODES = 200000;
let left = NODES;

const tag = (kind: string, fields: { [key: string]: Json } = {}): Json => ({ $t: kind, ...fields });
const kindOf = (value: object) => Object.prototype.toString.call(value).slice(8, -1);
const escapeKey = (key: string) => key.charAt(0) === '$' ? '$' + key : key;
function errorFields(error: unknown): { [key: string]: Json } {
  const e = error as { name?: unknown; message?: unknown };
  return { name: String(e && e.name), message: String(e && e.message) };
}
/** Reads one field; a getter that throws becomes a `thrown` diagnostic in its place. */
function read(owner: object, key: PropertyKey): { value?: unknown; thrown?: Json } {
  try { return { value: (owner as Record<PropertyKey, unknown>)[key] }; } catch (error) { return { thrown: tag('thrown', errorFields(error)) }; }
}

export function encode(value: unknown, path = '', stack: unknown[] = [], paths: string[] = []): Json {
  if (--left < 0) return tag('size', { limit: NODES });
  switch (typeof value) {
    case 'string': case 'boolean': return value;
    case 'undefined': return tag('undefined');
    case 'bigint': return tag('bigint', { v: String(value) });
    case 'symbol': return tag('symbol', { v: String(value.description) });
    case 'function': return tag('function', { name: String(value.name), length: value.length });
    case 'number':
      if (value !== value) return tag('number', { v: 'NaN' });
      if (value === Infinity || value === -Infinity) return tag('number', { v: String(value) });
      if (value === 0 && 1 / value < 0) return tag('number', { v: '-0' });
      return value;
  }
  if (value === null) return null;
  const object = value as object, at = stack.indexOf(object);
  if (at >= 0) return tag('ref', { path: paths[at] || '/' });
  if (stack.length >= DEPTH) return tag('depth', { limit: DEPTH });
  const zod = (object as { _zod?: { def?: { type?: unknown } }; safeParse?: unknown });
  if (typeof zod.safeParse === 'function' && zod._zod) return tag('schema', { type: String(zod._zod.def && zod._zod.def.type) });
  stack.push(object); paths.push(path);
  try {
    const kind = kindOf(object);
    const inner = (item: unknown, key: string) => encode(item, path + '/' + key, stack, paths);
    if (kind === 'Date') {
      const time = (object as Date).getTime();
      return tag('date', time === time ? { v: time, iso: (object as Date).toISOString() } : { v: 'Invalid' });
    }
    if (kind === 'Error') {
      const own: { [key: string]: Json } = {};
      for (const key of Object.getOwnPropertyNames(object).sort())
        if (key !== 'stack' && key !== 'message' && key !== 'name') own[escapeKey(key)] = inner(read(object, key).value, key);
      return tag('error', { ...errorFields(object), own });
    }
    if (kind === 'RegExp') return tag('regexp', { source: (object as RegExp).source, flags: (object as RegExp).flags });
    if (kind === 'Map') return tag('map', { entries: Array.from((object as Map<unknown, unknown>).entries())
      .map((entry, i) => [inner(entry[0], 'key' + i), inner(entry[1], 'value' + i)]) });
    if (kind === 'Set') return tag('set', { values: Array.from((object as Set<unknown>).values()).map((item, i) => inner(item, String(i))) });
    if (kind === 'Array') {
      const list = object as unknown[], items: Json[] = [];
      for (let i = 0; i < list.length; i++) {
        if (!(i in list)) { items.push(tag('hole')); continue; }
        const field = read(list, i);
        items.push(field.thrown ?? inner(field.value, String(i)));
      }
      return items;
    }
    if (kind !== 'Object') return tag('unsupported', { kind });
    const out: { [key: string]: Json } = {}, hidden: { [key: string]: Json } = {};
    for (const key of Object.getOwnPropertyNames(object)) {
      const field = read(object, key), encoded = field.thrown ?? inner(field.value, key);
      if (Object.prototype.propertyIsEnumerable.call(object, key)) out[escapeKey(key)] = encoded; else hidden[escapeKey(key)] = encoded;
    }
    if (Object.keys(hidden).length) out.$hidden = hidden;
    const symbols = Object.getOwnPropertySymbols(object);
    if (symbols.length) out.$symbols = symbols.map(symbol => [String(symbol.description), read(object, symbol).thrown ?? inner(read(object, symbol).value, String(symbol.description))]);
    const proto = Object.getPrototypeOf(object);
    if (proto === null) out.$proto = null;
    else if (proto !== Object.prototype) out.$proto = encode(proto && proto.constructor && proto.constructor.name, path + '/$proto', stack, paths);
    return out;
  } finally { stack.pop(); paths.pop(); }
}
/** One computed result, or the error it threw as a `thrown` diagnostic — the checker fails on it even when both engines threw alike. */
export function attempt(make: () => unknown): Json {
  left = NODES;
  try { return encode(make()); } catch (error) { return tag('thrown', errorFields(error)); }
}
