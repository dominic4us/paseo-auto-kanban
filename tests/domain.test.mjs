import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { applyOperations,
     validateBoard,
     validateTemplate,
     normalizeOperations,
     parseJson,
     stableStringify,
     builtinTemplate,
     needsHuman,
     summarizeBoard,
     renderProcess,
     boardView } from '../dist/server/core/index.js';
import { board, context, add, actor } from './helpers.mjs';
const apply = (b, ops, clock = context()) => applyOperations(b, ops, actor, clock);

test('domain source has no imports, ambient clock, filesystem access, timers, or watchers', async () => {
  const names = (await readdir('shared/core')).filter(n => /^domain.*\.ts$/.test(n));
  assert.ok(names.length);
  for (const name of names) {
    const source = await readFile(`shared/core/${name}`, 'utf8');
    const forbidden = [
      /\bimport\s|\brequire\s*\(|\bDate\.now\s*\(|new\s+Date\s*\(\s*\)|\bcrypto\./,
      /\bset(?:Timeout|Interval)\s*\(|\bwatch(?:File)?\s*\(/,
      /\bstructuredClone\b|\bBuffer\b|\bprocess\.|\bperformance\.|\bTextDecoder\b|\bqueueMicrotask\b/,
    ];
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
  }
});
test('strict JSON rejects duplicate escaped keys and malformed documents', () => {
  assert.deepEqual(parseJson('{"a":[1,true,null,{"b":"text"}]}'), { a: [1, true, null, { b: 'text' }] });
  for (const value of ['{"a":1,"\\u0061":2}', '[1,]', '{"x":NaN}', '{"x":1}extra', '"bad\ntext"', '{', '']) assert.throws(() => parseJson(value));
  assert.equal(stableStringify(parseJson('{"__proto__":{"value":1},"z":2}')), '{"__proto__":{"value":1},"z":2}');
});
test('builtin templates are localized constants with stable ids and isolated copies', () => {
  const en = builtinTemplate(); const ko = builtinTemplate('ko'); validateTemplate(en); validateTemplate(ko);
  assert.deepEqual(en.stages.map(x => x.stageId), ko.stages.map(x => x.stageId));
  assert.equal(en.stages[0].name, 'Waiting'); assert.equal(ko.stages[0].name, '대기');
  en.stages[0].name = 'Changed'; assert.equal(builtinTemplate().stages[0].name, 'Waiting');
  const invalid = builtinTemplate(); invalid.stages[1].stageId = invalid.stages[0].stageId; assert.throws(() => validateTemplate(invalid));
});
test('draft, requested, completion, block and reopen rules', () => {
  const start = board(); const draft = apply(start, [{ op: 'add', title: 'Draft' }]); const id = draft.cardIds[0];
  assert.equal(draft.board.cards[0].intent, 'draft'); assert.throws(() => apply(draft.board, [{ op: 'move', id, to: 'doing' }]), { code: 'E_TRANSITION' });
  assert.throws(() => apply(start, [{ op: 'add', title: 'Invalid', intent: 'requested' }]), { code: 'E_TRANSITION' });
  const ready = apply(draft.board, [{ op: 'update', id, patch: { intent: 'requested', acceptanceCriteria: 'Result verified', blockedReason: 'Awaiting access' } }]);
  assert.throws(() => apply(ready.board, [{ op: 'move', id, to: 'done' }]), { code: 'E_TRANSITION' });
  const done = apply(ready.board, [{ op: 'update', id, patch: { blockedReason: null } }, { op: 'move', id, to: 'done' }]);
  const reopened = apply(done.board, [{ op: 'move', id, to: 'doing' }]); assert.equal(reopened.board.cards[0].stageId, 'doing');
  const archived = apply(reopened.board, [{ op: 'archive', id }]); assert.throws(() => apply(archived.board, [{ op: 'update', id, patch: { notes: 'Changed' } }]), { code: 'E_TRANSITION' });
  assert.equal(apply(archived.board, [{ op: 'archive', id }]).changed, false);
  assert.equal(apply(archived.board, [{ op: 'restore', id }]).board.cards[0].archivedAt, null);
});
test('patches preserve unspecified fields, normalize inputs and reject unknown properties', () => {
  const initial = board(); const created = apply(initial, [{ ...add('  Example  '), notes: 'line\r\nnext' }]); const id = created.cardIds[0];
  assert.equal(initial.cards.length, 0); assert.equal(created.board.cards[0].title, 'Example');
  const edited = apply(created.board, [{ op: 'update', id, patch: { nextAction: 'Review' } }]);
  assert.equal(edited.board.cards[0].notes, 'line\nnext'); assert.equal(edited.board.cards[0].createdAt, created.board.cards[0].createdAt);
  assert.throws(() => normalizeOperations([{ ...add(),
       unexpected: 1 }]));
       assert.throws(() => apply(created.board,
       [{ op: 'move',
       id: `card_${randomUUID()}`,
       to: 'doing' }]),
       { code: 'E_NOT_FOUND' });
});
test('many-to-many links preserve timestamps and snapshot labels', () => {
  const created = apply(board(), [add('A'), add('B')]); const [a, b] = created.cardIds; const agent = randomUUID();
  const linked = apply(created.board, [a, b].map(id => ({ op: 'link', id, agentId: agent, role: 'Research', label: 'Example Agent' })));
  assert.equal(linked.board.cards[0].agents[0].agentId, linked.board.cards[1].agents[0].agentId);
  const timestamp = linked.board.cards[0].agents[0].linkedAt;
  const edited = apply(linked.board, [{ op: 'link', id: a, agentId: agent, role: 'Reviewer' }], context('2026-01-02T00:00:00.000Z'));
  assert.equal(edited.board.cards[0].agents[0].linkedAt, timestamp); assert.equal(edited.board.cards[0].agents[0].label, 'Example Agent');
  assert.equal(apply(edited.board, [{ op: 'link', id: a, agentId: agent }]).changed, false);
  const removed = apply(edited.board, [{ op: 'unlink', id: a, agentId: agent }]);
  const again = apply(removed.board, [{ op: 'link', id: a, agentId: agent }], context('2026-01-03T00:00:00.000Z'));
  assert.notEqual(again.board.cards[0].agents[0].linkedAt, timestamp);
});
test('net-zero batches preserve all metadata, while actual changes record final moves only', () => {
  const initial = apply(board(), [add()]); const id = initial.cardIds[0];
  const unchanged = apply(initial.board, [{ op: 'move', id, to: 'doing' }, { op: 'move', id, to: 'todo' }]);
  assert.equal(unchanged.changed, false); assert.deepEqual(unchanged.board, initial.board);
  const changed = apply(initial.board, [{ op: 'move', id, to: 'doing' }, { op: 'move', id, to: 'review' }]);
  assert.equal(changed.board.history.length, 2); assert.equal(changed.board.history[1].from, 'todo'); assert.equal(changed.board.history[1].to, 'review');
});
test('REQ-18 preserves awaiting but excludes completed cards from attention; progress excludes drafts and archives', () => {
  const made = apply(board(), [add('A'), add('B'), { op: 'add', title: 'Draft' }]); const [a, b] = made.cardIds;
  const edited = apply(made.board, [{ op: 'move', id: a, to: 'done' }, { op: 'update', id: a, patch: { awaiting: 'user' } }, { op: 'move', id: b, to: 'review' }]);
  assert.equal(needsHuman(edited.board.cards[0], edited.board.template.stages), false); assert.equal(needsHuman(edited.board.cards[1], edited.board.template.stages), false);
  // REQ-52: `archivedDone` says how many finished cards were archived (none here); see tests/req52-archive.test.mjs.
  assert.deepEqual(summarizeBoard(edited.board).progress, { done: 1, requested: 2, draft: 1, archived: 0, archivedDone: 0, percent: 50 });
  assert.equal(boardView(edited.board).needsHuman.length, 1); assert.equal('notes' in boardView(edited.board).stages[0].cards[0], false);
  assert.equal('notes' in boardView(edited.board, true).stages[0].cards[0], true);
});
test('deliverables stay relative and safe, without requiring files to exist', () => {
  const created = apply(board(), [{ ...add(), deliverables: ['docs/result.md', 'docs/result.md'] }]);
  assert.deepEqual(created.board.cards[0].deliverables, ['docs/result.md']);
  for (const name of ['/etc/example', '../outside', 'x/../y', 'C:/example', 'x\\y', 'a//b', './file']) assert.throws(() => apply(board(), [{ ...add(), deliverables: [name] }]));
});
test('time skew is bounded, no-op timestamps are unchanged, and history is count-bounded', () => {
  const made = apply(board(), [add()]); const id = made.cardIds[0]; made.board.updatedAt = '2030-01-01T00:00:00.000Z';
  const edited = apply(made.board, [{ op: 'update', id, patch: { notes: 'Result' } }], context());
  assert.equal(edited.board.updatedAt, '2026-01-02T01:00:00.000Z'); assert.equal(edited.warnings[0].code, 'W_CLOCK_SKEW');
  edited.board.history = Array.from({ length: 1000 }, () => structuredClone(edited.board.history[0]));
  const moved = apply(edited.board, [{ op: 'move', id, to: 'doing' }]); assert.equal(moved.board.history.length, 1000);
});
test('rendering is deterministic, localized and escapes user content', () => {
  const created = apply(board(), [{ ...add('<script>*Title*</script>'), deliverables: ['docs/result.md'] }]);
  const en = renderProcess(created.board); assert.equal(en, renderProcess(created.board)); assert.match(en, /Generated file/); assert.doesNotMatch(en, /<script>/); assert.match(en, /&lt;script&gt;/);
  assert.match(renderProcess(created.board, 'ko', 'full'),
       /자동 생성 파일/);
       assert.match(renderProcess(created.board, 'ko', 'full'),
       /## 대기/);
       assert.match(renderProcess(created.board, 'ko', 'full'),
       /실행 요청/);
       assert.ok(en.endsWith('\n'));
});
test('stored schemas reject unknown fields, duplicate links and invalid references', () => {
  const b = apply(board(), [add()]).board;
  assert.throws(() => validateBoard({ ...b, unknown: 1 })); assert.throws(() => validateBoard({ ...b, schemaVersion: 2 }), { code: 'E_SCHEMA_VERSION' });
  const damaged = structuredClone(b); damaged.cards[0].stageId = 'missing'; assert.throws(() => validateBoard(damaged));
  const agent = { agentId: randomUUID(), role: 'worker', label: '', linkedAt: b.createdAt }; b.cards[0].agents = [agent, agent]; assert.throws(() => validateBoard(b));
});

test('domain operations work without host-supplied globals', async () => {
  const source = (await readFile('dist/shared/core/domain.js', 'utf8')).replace(/^export /gm, '');
  const sandbox = { input: board(), operations: [add()], actor, context: context(),
    structuredClone: undefined, Buffer: undefined, process: undefined,
    performance: undefined, TextDecoder: undefined, queueMicrotask: undefined };
  vm.runInNewContext(source + '\nresult = applyOperations(input, operations, actor, context); view = boardView(result.board, true);', sandbox);
  assert.equal(sandbox.result.changed, true);
  assert.equal(sandbox.view.stages[0].cards[0].title, 'Example task');
});
test('compact output omits empty noise and full detail remains available', () => {
  const made = apply(board(), [add('A (result).')]); const id = made.cardIds[0];
  const agentId = randomUUID();
  const linked = apply(made.board, [{ op: 'link', id, agentId },
    { op: 'update', id, patch: { notes: 'Detailed evidence.', nextAction: 'Confirm the decision.' } }]);
  const compact = renderProcess(linked.board);
  const full = renderProcess(linked.board, 'en', 'full');
  assert.match(compact, /A \(result\)\./);
  assert.match(compact, /Confirm the decision\./);
  assert.doesNotMatch(compact, /Awaiting: None|Assigned: None|Detailed evidence|\\[.()-]/);
  assert.equal(compact.split(agentId.slice(0, 8)).length - 1, 1);
  assert.ok(!compact.includes(agentId));
  assert.ok(!compact.includes(id));
  assert.match(full, /Detailed evidence/); assert.ok(full.includes(id));
  assert.equal((compact.match(/Last changed/g) || []).length, 1);
  assert.match(compact, /2026-01-01 01:00 UTC/);
});

test('snapshot validation memo never trusts mutated values or a changed template', async () => {
  const { createBoardValidator } = await import('../dist/shared/core/domain.js');
  const validate = createBoardValidator();
  const made = apply(board(), [add()]).board;
  validate(made);
  made.cards[0].blockedReason = Infinity;
  assert.throws(() => validate(made));
  made.cards[0].blockedReason = 'Waiting'; made.cards[0].stageId = 'doing';
  validate(made);
  made.template.stages[1].countsAsDone = true;
  assert.throws(() => validate(made));
});
