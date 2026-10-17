/**
 * REQ-146 gate 381 F1 — negative controls, added as a client module by `tests/hermes-runtime.test.mjs` (never shipped).
 * Each pair holds two values that differ only in what the old snapshot dropped (a Date's time, an Error's message, NaN
 * against "NaN", -0 against 0, a key that is not enumerable…), behind D54's own loop getter: Hermes, with no block scope,
 * reads `a` as `b`, node reads each. Every pair must show a difference at its `a`, or the encoder hides that kind.
 * The other exports are what the checker must refuse even when both engines agree: thrown and returned errors, kinds the
 * encoder does not know, nesting past its depth, and gate 381's own dates (`2026/10/16` parses in node, not in Hermes).
 */
function d54(a: unknown, b: unknown): { a: unknown; b: unknown } {
  const out = {} as { a: unknown; b: unknown };
  for (const [key, value] of Object.entries({ a, b })) Object.defineProperty(out, key, { get: () => value, enumerable: true });
  return out;
}
function cycle() { const self: Record<string, unknown> = {}; self.self = self; return self; }
function hidden(value: number) { const out = {}; Object.defineProperty(out, 'size', { value, enumerable: false }); return out; }
function first() { return 1; }
function last() { return 1; }

export const PAIRS = {
  nan: d54(NaN, 'NaN'),
  undefined: d54(undefined, '[undefined]'),
  negativeZero: d54(-0, 0),
  infinity: d54(Infinity, 'Infinity'),
  bigint: d54(BigInt(1), '1'),
  symbol: d54(Symbol('a'), 'Symbol(a)'),
  functionName: d54(first, last),
  functionString: d54(() => 1, '[function]'),
  dateTime: d54(new Date(1700000000000), new Date(1800000000000)),
  dateInvalid: d54(new Date(NaN), new Date(0)),
  dateObject: d54(new Date(0), {}),
  errorMessage: d54(new Error('first'), new Error('last')),
  errorName: d54(new TypeError('x'), new Error('x')),
  errorObject: d54(new Error('x'), {}),
  mapValue: d54(new Map([[1, 'a']]), new Map([[1, 'b']])),
  mapObject: d54(new Map(), {}),
  setArray: d54(new Set([1]), [1]),
  regexp: d54(/a/g, '/a/g'),
  cycle: d54(cycle(), '[cycle]'),
  hiddenKey: d54(hidden(44), hidden(12)),
  hole: d54([, 1], [undefined, 1]),
  tagLookalike: d54({ $t: 'number', v: 'NaN' }, NaN),
  nullPrototype: d54(Object.create(null), {}),
  arrayObject: d54([1], { 0: 1 }),
};
export const PARSED_DATES = ['2026/10/16', '10/16/2026', '2026-10-16'].map(text => new Date(text));
export const RETURNED_ERROR = { ok: false, error: new Error('gate381 returned error') };
export const UNSUPPORTED = { promise: Promise.resolve(1), weak: new WeakMap(), bytes: new Uint8Array([1]) };
export const DEEP = Array.from({ length: 40 }).reduce((inner: unknown) => ({ inner }), 'bottom');
export const THROWING_GETTER = Object.defineProperty({}, 'value', { get: () => { throw new Error('gate381 getter'); }, enumerable: true });
