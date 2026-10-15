// D54 (research/364): the phone apps run the client on Hermes, whose default build gives let/const no block scope — a
// function made inside a loop that keeps a loop variable sees the loop's last value there (`scaled()` gave every MOBILE size
// 12 and every RING size 900), while V8 in the browser and in these tests gives each pass its own. `npm run test:hermes`
// only compiles, so this reads the code instead: a function made in a loop body may keep a let/const of that loop only when
// an array method runs it at once (map, filter, …). It also runs `scaled()` with every let/const made a `var` — what Hermes
// does — and checks each field keeps its own value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AT_ONCE = new Set(['find', 'findIndex', 'findLast', 'findLastIndex', 'filter', 'some', 'every', 'map', 'forEach', 'reduce', 'reduceRight', 'flatMap', 'sort']);
const isLoop = n => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
const isFn = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);
const blockScoped = list => !!list && ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
function names(binding, into) {
  if (ts.isIdentifier(binding)) into.add(binding.text);
  else for (const element of binding.elements) if (!ts.isOmittedExpression(element)) names(element.name, into);
  return into;
}
/** The names a scope node declares itself: a function's parameters, own name and `var`s; a block's let/const, classes and functions; a loop head's let/const. */
function declared(scope) {
  const out = new Set();
  if (isFn(scope)) {
    for (const p of scope.parameters) names(p.name, out);
    if ((ts.isFunctionExpression(scope)) && scope.name) out.add(scope.name.text);
    const vars = n => { if (isFn(n) || ts.isClassLike(n)) return;
      if (ts.isVariableDeclarationList(n) && !blockScoped(n)) for (const d of n.declarations) names(d.name, out);
      ts.forEachChild(n, vars); };
    if (scope.body) ts.forEachChild(scope.body, vars);
    if (scope.body && ts.isBlock(scope.body)) for (const name of declared(scope.body)) out.add(name);
  } else if (ts.isBlock(scope) || ts.isCaseBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
    const statements = ts.isCaseBlock(scope) ? scope.clauses.flatMap(c => [...c.statements]) : scope.statements;
    for (const st of statements) {
      if (ts.isVariableStatement(st) && blockScoped(st.declarationList)) for (const d of st.declarationList.declarations) names(d.name, out);
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) out.add(st.name.text);
      if (ts.isSourceFile(scope)) { if (ts.isImportDeclaration(st)) out.add('*'); if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) names(d.name, out); }
    }
  } else if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && blockScoped(scope.initializer)) {
    for (const d of scope.initializer.declarations) names(d.name, out);
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration) names(scope.variableDeclaration.name, out);
  return out;
}
/** The scope node that declares `name` as seen from `node` — every scope out to the file, through functions too. */
function bindingOf(node, name) {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isSourceFile(up)) return null;
    if ((isFn(up) || ts.isBlock(up) || ts.isCaseBlock(up) || isLoop(up) || ts.isCatchClause(up)) && declared(up).has(name)) return up;
  }
  return null;
}
/** The loop a scope belongs to when its let/const are made anew on each pass (its head, or a block inside its body). */
function passLoop(scope) {
  if (isLoop(scope)) return scope;
  for (let up = scope; up && !isFn(up); up = up.parent) if (up.parent && isLoop(up.parent) && up.parent.statement === up) return up.parent;
  return null;
}
const inTypes = (n, stop) => { for (let up = n.parent; up && up !== stop; up = up.parent) if (ts.isTypeNode(up) || ts.isTypeAliasDeclaration(up) || ts.isInterfaceDeclaration(up)) return true; return false; };
const isReference = n => !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
  && !(ts.isBindingElement(n.parent) && n.parent.propertyName === n) && !(ts.isMethodDeclaration(n.parent) && n.parent.name === n)
  && !(ts.isJsxAttribute(n.parent) && n.parent.name === n) && !ts.isLabeledStatement(n.parent) && !ts.isBreakOrContinueStatement(n.parent)
  && !(ts.isQualifiedName(n.parent) && n.parent.right === n) && !(ts.isPropertyDeclaration(n.parent) && n.parent.name === n);
const syncFn = fn => !fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) && !fn.asteriskToken;
/**
 * Run at once and done with: a synchronous callback handed straight to a real array's (or Set's, Map's) method, `Array.from`'s
 * mapper or a Promise's executor, or a synchronous function called where it is made. An async one goes on after its await, when
 * later passes have changed the loop's variables (366 F2); a function it returns or schedules is a function of its own and is
 * checked as one. Gate 367: the receiver must be typed an array, a Set or a Map — any other object's `.map` may keep the callback.
 */
const COLLECTIONS = new Set(['Set', 'ReadonlySet', 'Map', 'ReadonlyMap']);
function collection(checker, expression) {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(expression));
  const one = t => checker.isArrayType(t) || checker.isTupleType(t) || COLLECTIONS.has(t.getSymbol()?.getName() ?? '');
  return type.isUnion() ? type.types.every(one) : type.isIntersection() ? type.types.some(one) : one(type);
}
function runAtOnce(fn, checker) {
  if (!syncFn(fn)) return false;
  let callee = fn; while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
  if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee) return true;
  const call = fn.parent;
  if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || !(call.arguments ?? []).includes(fn)) return false;
  if (ts.isNewExpression(call)) return call.expression.getText() === 'Promise';
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text, receiver = call.expression.expression;
  if (method === 'from') return receiver.getText() === 'Array';
  return AT_ONCE.has(method) && collection(checker, receiver);
}
/**
 * The code a function runs later than where it is made: its body and its parameters' defaults (`(x = id) => x`, gate 367); a class's
 * field initialisers run at each `new`, later too.
 */
const deferred = n => (isFn(n) && !!n.body) || (ts.isPropertyDeclaration(n) && !!n.initializer && !n.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword));
function scan(source, checker) {
  const file = source.fileName, found = [];
  const contains = (outer, inner) => { for (let up = inner; up; up = up.parent) if (up === outer) return true; return false; };
  const visit = n => {
    if (deferred(n) && !(isFn(n) && runAtOnce(n, checker))) {
      const caught = new Set();
      const keep = (node, name) => { const scope = bindingOf(node, name);
        // Declared outside this function, by a scope that makes it anew on each pass of a loop the function is made in.
        if (scope && !contains(n, scope) && contains(scope, n) && passLoop(scope) && contains(passLoop(scope), n)) caught.add(name); };
      const walk = x => {
        if (ts.isIdentifier(x) && isReference(x) && !inTypes(x, n)) keep(x, x.text);
        if (ts.isShorthandPropertyAssignment(x)) keep(x, x.name.text);
        ts.forEachChild(x, walk);
      };
      if (isFn(n)) { for (const p of n.parameters) { if (p.initializer) walk(p.initializer); walk(p.name); } walk(n.body); }
      else walk(n.initializer);
      if (caught.size) found.push(`${file}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${[...caught].sort().join(',')}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return found;
}
/** Every function made in a loop that keeps one of that loop's per-pass let/const and is not run at once: "file:line names". */
export function findLoopCaptures(file, text) {
  // One file on its own, typed with the standard library (a snippet's `[0].map` is an array, `queue.map` of an object is not).
  const options = { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], noEmit: true, jsx: ts.JsxEmit.ReactJSX, allowJs: true, skipLibCheck: true };
  const host = ts.createCompilerHost(options), base = { ...host };
  host.getSourceFile = (name, version) => name === file ? ts.createSourceFile(file, text, version, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : base.getSourceFile(name, version);
  host.fileExists = name => name === file || base.fileExists(name);
  host.readFile = name => name === file ? text : base.readFile(name);
  const program = ts.createProgram({ rootNames: [file], options, host });
  return scan(program.getSourceFile(file), program.getTypeChecker());
}
/** The same over the project's own client/ and shared/ sources, typed as the build types them (tsconfig.json). */
export function findLoopCapturesInProject(dir) {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(dir, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true } }), checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter(sf => /^(client|shared)\//.test(path.relative(dir, sf.fileName)) && !sf.fileName.endsWith('.d.ts'));
  return { files: files.length, found: files.flatMap(sf => scan(sf, checker).map(line => path.relative(dir, sf.fileName) + line.slice(sf.fileName.length))) };
}
const filesUnder = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(path.join(dir, e.name))
  : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []);

// v0.2.1's two (research/364), word for word: the check must find both.
const OLD_SCALED = `export function scaled<T extends Record<string, unknown>>(base: T, fixed: readonly (keyof T)[] = []): T {
  const table = {} as T;
  for (const key of Object.keys(base) as (keyof T)[]) {
    const value = base[key];
    if (typeof value !== 'number' || fixed.includes(key)) Object.defineProperty(table, key, { value, enumerable: true });
    else Object.defineProperty(table, key, { get: () => px(value), enumerable: true });
  }
  return Object.freeze(table);
}`;
const OLD_JOIN = `export function joinHandlers(...sets: Handlers[]): Handlers {
  const out: Handlers = {};
  for (const set of sets) for (const [key, handler] of Object.entries(set)) {
    const before = out[key];
    if (handler) out[key] = before ? (event?: never) => { before(event); handler(event); } : handler;
  }
  return out;
}`;

test('D54 the check finds what v0.2.1 had: the getter in scaled() and the joined handler in joinHandlers()', () => {
  assert.deepEqual(findLoopCaptures('old-ui-scale.ts', OLD_SCALED), ['old-ui-scale.ts:6 value']);
  assert.deepEqual(findLoopCaptures('old-components.tsx', OLD_JOIN), ['old-components.tsx:5 before,handler']);
  // Run at once by an array method, or keeping nothing of the loop: not counted.
  assert.deepEqual(findLoopCaptures('ok.ts', 'declare const b: number[], list: number[], later: (f: () => void) => void;\nfor (const a of b) { const c = a; list.filter(x => x === c); Array.from(b, () => c); later(() => b); }'), []);
  // An async function run at once still reads the variable after its await, when later passes have changed it: counted.
  assert.deepEqual(findLoopCaptures('async.ts', 'while (q.length) { const id = q.shift(); void (async () => { await x; use(id); })(); }'), ['async.ts:1 id']);
});

// Gate 366·367 F2: the forms earlier checks let through (research/366 prove-misses, research/367 extra-proofs), each giving
// [3,3,3] under Hermes rules where the browser gives [1,2,3]; and the safe forms it must keep passing (366 mutation-check, 367).
const MISSED = {
  'async-map': `const jobs=[];for(const id of [1,2,3]){jobs.push(...[0].map(async()=>{await Promise.resolve();return id}))}globalThis.result=Promise.all(jobs);`,
  'async-forEach': `const values=[];for(const id of [1,2,3]){[0].forEach(async()=>{await Promise.resolve();values.push(id)})}globalThis.result=Promise.resolve().then(()=>Promise.resolve()).then(()=>values);`,
  'async-Array-from': `const jobs=[];for(const id of [1,2,3]){jobs.push(...Array.from([0],async()=>{await Promise.resolve();return id}))}globalThis.result=Promise.all(jobs);`,
  'map-return-arrow': `const saved=[];for(const id of [1,2,3]){saved.push(...[0].map(()=>()=>id))}globalThis.result=saved.map(fn=>fn());`,
  'foreach-timeout': `const jobs=[];for(const id of [1,2,3]){[0].forEach(()=>jobs.push(new Promise(resolve=>setTimeout(()=>resolve(id),0))))}globalThis.result=Promise.all(jobs);`,
  'nested-declaration-shadow': `const saved=[];for(const id of [1,2,3]){saved.push(()=>{function g(){const id=0;return id};return id})}globalThis.result=saved.map(fn=>fn());`,
  // Gate 367 F2 (research/367 extra-proofs): parameter defaults run at each call, and another object's `.map` may keep its callback.
  'default-arrow': 'const saved=[];for(const id of [1,2,3]){saved.push((x=id)=>x)}globalThis.result=saved.map(f=>f());',
  'default-function': 'const saved=[];for(const id of [1,2,3]){saved.push(function(x=id){return x})}globalThis.result=saved.map(f=>f());',
  'default-destructure': 'const saved=[];for(const id of [1,2,3]){saved.push(({x=id}={})=>x)}globalThis.result=saved.map(f=>f());',
  'custom-map': 'const saved=[];const queue={map:fn=>saved.push(fn)};for(const id of [1,2,3]){queue.map(()=>id)}globalThis.result=saved.map(f=>f());',
  // Found while hunting the same family: a class field's initialiser (run at each `new`), a getter, a generator, a method's default.
  'class-field': 'const saved=[];for(const id of [1,2,3]){saved.push(class{v=id})}globalThis.result=saved.map(C=>new C().v);',
  'object-getter': 'const saved=[];for(const id of [1,2,3]){saved.push({get v(){return id}})}globalThis.result=saved.map(o=>o.v);',
  'generator': 'const saved=[];for(const id of [1,2,3]){saved.push(function*(){yield id})}globalThis.result=saved.map(g=>g().next().value);',
  'method-default': 'const saved=[];for(const id of [1,2,3]){saved.push({f(x=id){return x}})}globalThis.result=saved.map(o=>o.f());',
};
const SAFE = {
  'bind-by-value': 'const saved=[];const use=x=>x;for(const id of [1,2,3]){saved.push(use.bind(null,id))}globalThis.result=saved.map(fn=>fn());',
  'function-factory': 'const saved=[];const make=id=>()=>id;for(const id of [1,2,3]){saved.push(make(id))}globalThis.result=saved.map(fn=>fn());',
  'sync-map': 'const result=[];for(const id of [1,2,3]){result.push(...[0].map(x=>x+id))}globalThis.result=result;',
  'own-parameter': 'const saved=[];for(const id of [1,2,3]){saved.push((id)=>id)}globalThis.result=saved.map(fn=>fn(7));',
  // Gate 367: run where they are made, or read at once — a synchronous IIFE, a computed key, a tagged template, a static field,
  // a Set's forEach; and a default that is the parameter's own.
  'sync-iife': 'const values=[];for(const id of [1,2,3]){values.push((()=>id)())}globalThis.result=values;',
  'computed-key': 'const r=[];for(const id of [1,2,3]){r.push(Number(Object.keys({[id]:1})[0]))}globalThis.result=r;',
  'tagged-template': 'const tag=(s,...v)=>v[0];const r=[];for(const id of [1,2,3]){r.push(tag`${id}`)}globalThis.result=r;',
  'static-field': 'const r=[];for(const id of [1,2,3]){r.push(class{static v=id}.v)}globalThis.result=r;',
  'set-forEach': 'const r=[];for(const id of [1,2,3]){new Set([0]).forEach(()=>r.push(id))}globalThis.result=r;',
  'own-default': 'const saved=[];for(const id of [1,2,3]){saved.push((id=7)=>id)}globalThis.result=saved.map(f=>f());',
};
async function runAs(code, hermes) {
  const context = { setTimeout, Promise, globalThis: {} };
  context.globalThis = context;
  vm.runInNewContext(hermes ? code.replace(/\b(?:const|let)\b/g, 'var') : code, context);
  return JSON.stringify(await context.result);
}
test('D54 / gate 366·367 F2: the forms the earlier checks missed are found in client/ and shared/, and each is wrong under Hermes rules', async () => {
  for (const [name, code] of Object.entries(MISSED)) {
    for (const dir of ['client', 'shared']) assert.ok(findLoopCaptures(dir + '/gate-negative.ts', code).length > 0, dir + ': ' + name);
    assert.deepEqual([await runAs(code, false), await runAs(code, true)], ['[1,2,3]', '[3,3,3]'], name + ' differs under Hermes rules');
  }
});
test('D54 / gate 366·367 F2: the safe forms still pass — bind by value, a factory, a synchronous map or IIFE, own parameters, computed keys and the like', async () => {
  for (const [name, code] of Object.entries(SAFE)) {
    for (const dir of ['client', 'shared']) assert.deepEqual(findLoopCaptures(dir + '/gate-positive.ts', code), [], dir + ': ' + name);
    assert.equal(await runAs(code, false), await runAs(code, true), name + ' is the same under Hermes rules');
  }
});

test('D54 no function made in a loop in client/ or shared/ keeps a let/const of that loop (Hermes would give it the last value)', () => {
  const { files, found } = findLoopCapturesInProject(root);
  assert.ok(files > 30, 'the client and shared sources are read: ' + files);
  assert.deepEqual(found, [], 'make the function outside the loop and pass the value in (research/364)');
});

/** `scaled()` from a source, every let/const made a `var` as Hermes treats them, with `px` at 100%. */
function hermesScaled(source) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
    .replace(/\b(?:const|let)\b/g, 'var');
  const context = { exports: {}, module: {}, Object };
  vm.runInNewContext(js, context);
  return context.exports.scaled;
}
test('D54 scaled() under Hermes rules keeps each field\'s own size (v0.2.1\'s gave every field the last one)', () => {
  const now = fs.readFileSync(path.join(root, 'client/ui-scale.ts'), 'utf8');
  const fixed = hermesScaled(now)({ appbarHeight: 44, controlHeight: 36, gap: 8, zIndex: 3, label: 'x' }, ['zIndex']);
  assert.deepEqual({ ...fixed }, { appbarHeight: 44, controlHeight: 36, gap: 8, zIndex: 3, label: 'x' });
  const old = now.replace(/export function scaled[\s\S]*?\n}\n/, OLD_SCALED + '\n');
  assert.notEqual(old, now, 'the old scaled() was put in');
  const broken = hermesScaled(old)({ appbarHeight: 44, controlHeight: 36, gap: 8, last: 12 });
  assert.deepEqual({ ...broken }, { appbarHeight: 12, controlHeight: 12, gap: 12, last: 12 }, 'the emulation shows the fault it guards against');
});
