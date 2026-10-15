import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openStore, stableStringify } from '../dist/server/core/index.js';
const entry = resolve('dist/src/cli/main.js');
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'kanban-cli-')); const cwd = join(root, 'work'); const data = join(root, 'data'); await fs.mkdir(cwd);
  const children = new Set(); let maximum = 0;
  t.after(async () => { for (const child of children) child.kill('SIGKILL'); await fs.rm(root, { recursive: true, force: true }); });
  async function run(args, options = {}) {
    const env = { ...process.env }; delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID; delete env.KANBAN_DATA_DIR;
    Object.assign(env, options.env ?? {});
    const argv = [entry, ...args, ...(options.dataOption === false ? [] : ['--data-dir', data]), ...(options.json === false ? [] : ['--json'])];
    const child = spawn(process.execPath, argv, { cwd: options.cwd ?? cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child); maximum = Math.max(maximum, children.size);
    let stdout = ''; let stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.stdin.end(options.input ?? '');
    return await new Promise((resolve,
         reject) => { child.once('error',
         reject);
         child.once('close',
         code => { children.delete(child);
         let value;
         if (options.json !== false && stdout) { try { value = JSON.parse(stdout);
         } catch (error) { reject(new Error(`Invalid JSON output: ${stdout}\n${stderr}`,
         { cause: error }));
         return;
         } } resolve({ code,
         stdout,
         stderr,
         value });
         });
         });
  }
  async function ok(args,
       options = {}) { const result = await run(args,
       options);
       assert.equal(result.code,
       0,
       result.stderr);
       if (options.json !== false) assert.equal(result.value.ok,
       true);
       return result;
       }
  return { root, cwd, data, run, ok, maximum: () => maximum };
}
const addArgs = ['card', 'add', '--title', 'Example review', '--criteria', 'Findings recorded', '--intent', 'requested'];

test('root help fits one screen and all twelve command help pages are self-contained', async t => {
  const f = await fixture(t); const root = await f.ok(['--help'], { json: false, dataOption: false });
  assert.ok(root.stdout.trimEnd().split('\n').length <= 40); assert.match(root.stdout, /Common flow/); assert.match(root.stdout, /kanban init/);
  for (const args of [['init'], ['rev'], ['ls'], ['card', 'add'], ['card', 'move'], ['card', 'update'], ['card', 'link'], ['card', 'show'], ['apply'], ['export'], ['doctor'], ['unlock']]) {
    const output = await f.ok([...args, '--help'], { json: false }); assert.match(output.stdout, /Usage:/); assert.match(output.stdout, /Example:/); assert.match(output.stdout, /--json/);
  }
  const version = await f.ok(['--version'], { dataOption: false }); assert.equal(version.value.data.version, JSON.parse(await fs.readFile('package.json', 'utf8')).version);
  await assert.rejects(fs.stat(f.data), { code: 'ENOENT' });
});
test('common CLI workflow generates output and preserves mtime when unchanged', async t => {
  const f = await fixture(t); const init = await f.ok(['init']); assert.equal(init.value.data.export, 'written');
  const created = await f.ok(addArgs); assert.equal(created.value.committed, true); assert.equal(created.value.meta.io.exportWrites, 1);
  const id = created.value.data.cardIds[0]; const prefix = id.slice(0, 13); const agent = randomUUID();
  await f.ok(['card', 'link', prefix, '--agent', agent, '--role', 'reviewer', '--label', 'Example Agent']);
  await f.ok(['card', 'move', prefix, '--to', 'review']);
  await f.ok(['card', 'update', prefix, '--notes', 'Detailed evidence', '--awaiting', 'user', '--next-action', 'Confirm findings', '--deliverable', 'docs/result.md']);
  const listed = await f.ok(['ls']);
       const summary = listed.value.data.stages.flatMap(s => s.cards)[0];
       assert.equal('notes' in summary,
       false);
       assert.equal(summary.agents,
       1);
       assert.equal(summary.awaiting,
       'user');
  const shown = await f.ok(['card',
       'show',
       prefix]);
       assert.equal(shown.value.data.card.notes,
       'Detailed evidence');
       assert.equal(shown.value.data.card.agents[0].label,
       'Example Agent');
       assert.equal(shown.value.data.history.length,
       2);
  const output = join(f.cwd,
       'PROCESS.md');
       const before = await fs.stat(output);
       const bytes = await fs.readFile(output,
       'utf8');
       assert.match(bytes,
       /Generated file/);
       assert.match(bytes,
       /Confirm findings/);
       assert.doesNotMatch(bytes,
       /Detailed evidence/);
       assert.match(bytes,
       /Example Agent/);
  const exported = await f.ok(['export']);
       assert.equal(exported.value.data.status,
       'unchanged');
       assert.equal(exported.value.meta.io.exportWrites,
       0);
       assert.equal(exported.value.meta.io.fsyncCalls,
       0);
       assert.equal((await fs.stat(output)).mtimeMs,
       before.mtimeMs);
  const repeat = await f.ok(['card', 'move', prefix, '--to', 'review']); assert.equal(repeat.value.data.changed, false); assert.equal((await fs.stat(output)).mtimeMs, before.mtimeMs);
  const full = await f.ok(['ls', '--full'], { json: false }); assert.match(full.stdout, /Detailed evidence/);
  await f.ok(['card', 'link', prefix, '--agent', agent, '--remove']); await f.ok(['card', 'update', prefix, '--archive']); assert.equal((await f.ok(['ls'])).value.data.summary.progress.archived, 1);
  await f.ok(['card', 'show', prefix]); await f.ok(['card', 'update', prefix, '--restore']);
});
test('locale switching selects Korean generated text without changing stage ids', async t => {
  const f = await fixture(t); await f.ok(['init']); const created = await f.ok(addArgs); const prefix = created.value.data.cardIds[0].slice(0, 13);
  await f.ok(['card',
       'update',
       prefix,
       '--awaiting',
       'user']);
       const config = join(f.data,
       'config.json');
       await fs.writeFile(config,
       JSON.stringify({ schemaVersion: 1,
       exportEnabled: true,
       locale: 'ko' }));
  const exported = await f.ok(['export']);
       assert.equal(exported.value.data.status,
       'written');
       const bytes = await fs.readFile(join(f.cwd,
       'PROCESS.md'),
       'utf8');
       assert.match(bytes,
       /자동 생성 파일/);
       assert.match(bytes,
       /## 대기/);
       assert.match(bytes,
       /사용자/);
  assert.equal((await f.ok(['card', 'show', prefix])).value.data.card.stageId, 'todo');
});
test('workspace selection follows explicit, agent environment, then current directory', async t => {
  const f = await fixture(t); const second = join(f.root, 'second'); const nested = join(f.cwd, 'child'); await fs.mkdir(second); await fs.mkdir(nested);
  const first = await f.ok(['init']); const other = await f.ok(['init', '--workspace', second]);
  const current = await f.ok(['rev']); assert.equal(current.value.data.boardId, first.value.data.boardId);
  const environment = await f.ok(['rev'], { env: { PASEO_AGENT_CWD: second } }); assert.equal(environment.value.data.boardId, other.value.data.boardId);
  const explicit = await f.ok(['rev', '--workspace', first.value.data.boardId], { env: { PASEO_AGENT_CWD: second } }); assert.equal(explicit.value.data.boardId, first.value.data.boardId);
  assert.equal((await f.ok(['init'], { cwd: nested })).value.data.boardId, first.value.data.boardId);
  const child = await f.ok(['init'], { env: { PASEO_AGENT_CWD: nested } }); assert.notEqual(child.value.data.boardId, first.value.data.boardId);
  assert.equal((await f.run(['rev'], { env: { PASEO_AGENT_CWD: 'relative' } })).code, 2);
  const envData = await f.ok(['rev'], { dataOption: false, env: { KANBAN_DATA_DIR: f.data } }); assert.equal(envData.value.data.boardId, first.value.data.boardId);
});
test('actor defaults, explicit id registration, saved maps and template inspection work', async t => {
  const f = await fixture(t); const templates = await f.ok(['init', '--list-templates']); assert.equal(templates.value.data[0].id, 'basic'); await f.ok(['init', '--show-template', 'basic@1']);
  const map = join(f.root, 'map.json'); await fs.writeFile(map, JSON.stringify([{ workspaceId: 'wks_example01', cwd: f.cwd, project: 'Example Project' }]));
  await f.ok(['init', '--paseo-map', map]); const user = await f.ok(['card', 'add', '--title', 'Draft']);
  assert.equal((await f.ok(['card', 'show', user.value.data.cardIds[0]])).value.data.card.intent, 'draft');
  const agentId = randomUUID(); const agent = await f.ok(['card', 'add', '--title', 'Agent work', '--criteria', 'Result recorded'], { env: { PASEO_AGENT_ID: agentId } });
  const shown = await f.ok(['card',
       'show',
       agent.value.data.cardIds[0]]);
       assert.equal(shown.value.data.card.intent,
       'requested');
       assert.deepEqual(shown.value.data.card.createdBy,
       { kind: 'agent',
       agentId });
  assert.equal((await f.run(addArgs, { env: { PASEO_AGENT_ID: '' } })).code, 2);
  assert.equal((await f.run(addArgs, { env: { PASEO_AGENT_ID: 'invalid' } })).code, 2);
});
test('ambiguous card prefixes and workspace paths return candidate details', async t => {
  const f = await fixture(t); const initialized = await f.ok(['init', '--workspace-id', 'wks_example01']); const boardId = initialized.value.data.boardId;
  const first = await f.ok(addArgs);
       const boardFile = join(f.data,
       'boards',
       `${boardId}.json`);
       const b = JSON.parse(await fs.readFile(boardFile,
       'utf8'));
       const copy = structuredClone(b.cards[0]);
       copy.id = `${copy.id.slice(0,
       14)}ffff-4fff-8fff-ffffffffffff`;
       b.cards.push(copy);
       await fs.writeFile(boardFile,
       stableStringify(b));
  const ambiguous = await f.run(['card',
       'show',
       first.value.data.cardIds[0].slice(0,
       13)]);
       assert.equal(ambiguous.code,
       3);
       assert.equal(ambiguous.value.error.code,
       'E_CARD_AMBIGUOUS');
       assert.equal(ambiguous.value.error.details.length,
       2);
  await f.ok(['init',
       '--workspace-id',
       'wks_example02']);
       const selection = await f.run(['ls']);
       assert.equal(selection.code,
       3);
       assert.equal(selection.value.error.code,
       'E_WORKSPACE_AMBIGUOUS');
       assert.equal(selection.value.error.details.length,
       2);
});
test('summary output excludes large notes and remains bounded', async t => {
  const f = await fixture(t); await f.ok(['init']);
  const batch = { operations: Array.from({ length: 100 }, (_, i) => ({ op: 'add', title: `Task ${i}`, intent: 'requested', acceptanceCriteria: 'Result', notes: 'x'.repeat(7000) })) };
  await f.ok(['apply', '-'], { input: JSON.stringify(batch) });
  const small = await f.ok(['ls']); assert.ok(Buffer.byteLength(small.stdout) < 100000); assert.doesNotMatch(small.stdout, /"notes"|"acceptanceCriteria"|"createdBy"|"linkedAt"/);
  const full = await f.ok(['ls', '--full']); assert.ok(Buffer.byteLength(full.stdout) > 700000);
});
test('apply is all-or-nothing, supports optional guards, and rejects duplicates and null guards', async t => {
  const f = await fixture(t); const initial = await f.ok(['init']); const before = await fs.readFile(join(f.data, 'boards', `${initial.value.data.boardId}.json`));
  const bad = await f.run(['apply',
       '-'],
       { input: JSON.stringify({ operations: [{ op: 'add',
       title: 'Valid draft' },
       { op: 'add',
       title: 'Missing criteria',
       intent: 'requested' }] }) });
       assert.equal(bad.code,
       2);
       assert.deepEqual(await fs.readFile(join(f.data,
       'boards',
       `${initial.value.data.boardId}.json`)),
       before);
  const key = randomUUID(); const body = JSON.stringify({ requestId: key, operations: [{ op: 'add', title: 'Batch draft' }] });
  const first = await f.ok(['apply',
       '-'],
       { input: body });
       const replay = await f.ok(['apply',
       '-'],
       { input: body });
       assert.equal(replay.value.data.replayed,
       true);
       assert.deepEqual(replay.value.data.cardIds,
       first.value.data.cardIds);
  assert.equal((await f.run(['apply', '-', '--request-id', key], { input: body })).code, 2);
  assert.equal((await f.run(['apply', '-'], { input: '{"operations":[],"operations":[]}' })).code, 2);
  assert.equal((await f.run(['apply', '-'], { input: '{"requestId":null,"operations":[{"op":"add","title":"Draft"}]}' })).code, 2);
  assert.equal((await f.run(['apply', '-'], { input: '{"ifRevision":null,"operations":[{"op":"add","title":"Draft"}]}' })).code, 2);
  const revision = (await f.ok(['rev'])).value.data.revision; await f.ok(addArgs);
  const conflict = await f.run([...addArgs, '--if-revision', revision]); assert.equal(conflict.code, 4); assert.equal(conflict.value.error.code, 'E_REVISION_CONFLICT');
});
test('export failures preserve committed cards and existing targets', async t => {
  const f = await fixture(t); await f.ok(['init']); const target = join(f.cwd, 'PROCESS.md'); await fs.writeFile(target, '# Manually maintained\n');
  const changed = await f.ok(addArgs);
       assert.equal(changed.value.committed,
       true);
       assert.equal(changed.value.data.export,
       'failed');
       assert.match(changed.stderr,
       /W_EXPORT_TARGET/);
       assert.equal(await fs.readFile(target,
       'utf8'),
       '# Manually maintained\n');
  const manual = await f.run(['export']); assert.equal(manual.code, 6); assert.equal(manual.value.error.code, 'E_EXPORT');
  const config = join(f.data,
       'config.json');
       await fs.writeFile(config,
       JSON.stringify({ schemaVersion: 1,
       exportEnabled: false,
       locale: 'en' }));
       assert.equal((await f.ok(['export'])).value.data.status,
       'skipped');
  await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, exportEnabled: true, locale: 'en' })); await fs.unlink(target);
  const outside = join(f.root, 'outside.txt'); await fs.writeFile(outside, 'Keep me'); await fs.symlink(outside, target);
  assert.equal((await f.run(['export'])).code, 6); assert.equal(await fs.readFile(outside, 'utf8'), 'Keep me');
});
test('forbidden and missing cwd exports are skipped with warnings, without writes', async t => {
  const f = await fixture(t);
       const initialized = await f.ok(['init']);
       const id = initialized.value.data.boardId;
       const target = join(f.data,
       'boards',
       `${id}.json`);
       const b = JSON.parse(await fs.readFile(target,
       'utf8'));
  const protectedDir = join(f.root, 'protected'); await fs.mkdir(protectedDir); b.cwd = protectedDir; await fs.writeFile(target, stableStringify(b));
  const blocked = await f.ok(['export',
       '--workspace',
       id],
       { env: { PASEO_HOME: protectedDir } });
       assert.equal(blocked.value.data.status,
       'skipped');
       assert.match(blocked.stderr,
       /W_PATH_FORBIDDEN/);
       await assert.rejects(fs.stat(join(protectedDir,
       'PROCESS.md')),
       { code: 'ENOENT' });
  b.cwd = join(f.root, 'missing'); await fs.writeFile(target, stableStringify(b)); const missing = await f.ok(['export', '--workspace', id]); assert.match(missing.stderr, /W_CWD_MISSING/);
});
test('doctor detects damage and missing output without repairing either', async t => {
  const f = await fixture(t); const initialized = await f.ok(['init']); const id = initialized.value.data.boardId;
  await fs.unlink(join(f.cwd,
       'PROCESS.md'));
       const check = await f.ok(['doctor']);
       assert.ok(check.value.warnings.some(w => w.code === 'W_EXPORT_STALE'));
       await assert.rejects(fs.stat(join(f.cwd,
       'PROCESS.md')),
       { code: 'ENOENT' });
  const target = join(f.data,
       'boards',
       `${id}.json`);
       await fs.writeFile(target,
       '{broken');
       const report = await f.run(['doctor',
       '--workspace',
       id]);
       assert.equal(report.code,
       7);
       assert.equal(report.value.ok,
       false);
       assert.match(report.value.error.nextAction,
       /Preserve|backup/i);
       assert.equal(await fs.readFile(target,
       'utf8'),
       '{broken');
});
test('unlock refuses live ownership and requires offline force for partial locks', async t => {
  const f = await fixture(t); const initialized = await f.ok(['init']); const id = initialized.value.data.boardId; const store = await openStore({ dataDir: f.data });
  let previousOwner;
  await store.withBoardLock(id,
       async () => { previousOwner = JSON.parse(await fs.readFile(join(f.data,
       'boards',
       `${id}.lock`),
       'utf8'));
       const report = await f.run(['unlock',
       '--force']);
       assert.equal(report.code,
       5);
       assert.equal(report.value.error.code,
       'E_LOCK_ACTIVE');
       });
  const target = join(f.data, 'boards', `${id}.lock`);
  previousOwner.createdAt = new Date(Date.now() - 61000).toISOString(); previousOwner.procStartTicks = '0'; await fs.writeFile(target, JSON.stringify(previousOwner));
  assert.equal((await f.ok(['unlock'])).value.data.unlocked, true);
  await fs.writeFile(target, '{partial');
  assert.equal((await f.run(['unlock'])).code,
       5);
       const cleared = await f.ok(['unlock',
       '--force']);
       assert.equal(cleared.value.data.unlocked,
       true);
       await assert.rejects(fs.stat(target),
       { code: 'ENOENT' });
  assert.equal((await f.ok(['unlock', '--global'])).value.data.unlocked, false);
});
test('usage errors include nextAction and human rev is a single short line', async t => {
  const f = await fixture(t); await f.ok(['init']);
  for (const args of [['ls',
       '--all',
       '--full'],
       ['ls',
       '--archive'],
       ['ls',
       '--workspace',
       ''],
       ['card',
       'add',
       '--title',
       'A',
       '--title',
       'B'],
       ['card',
       'move'],
       ['unknown']]) { const outcome = await f.run(args);
       assert.equal(outcome.code,
       2);
       assert.ok(outcome.value.error.nextAction);
       assert.match(outcome.stderr,
       /Next:/);
       }
  const rev = await f.ok(['rev'], { json: false }); assert.equal(rev.stdout.trimEnd().split('\n').length, 1); assert.ok(rev.stdout.length < 70);
  const all = await f.ok(['ls', '--all']); assert.equal(all.value.data.boards.length, 1);
});
test('twenty actual CLI additions on one board preserve all cards and newest export', { timeout: 90000 }, async t => {
  const f = await fixture(t); await f.ok(['init']);
  await f.ok(['apply', '-'], { input: JSON.stringify({ operations: Array.from({ length: 100 }, (_, i) => ({ op: 'add', title: `Existing ${i}` })) }) });
  const start = performance.now(); const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.ok(['card', 'add', '--title', `Concurrent ${i}`])));
  t.diagnostic(`CLI processes: 20; peak active: ${f.maximum()}; elapsed: ${Math.round(performance.now() - start)} ms`);
  assert.equal(results.length, 20); assert.equal(new Set(results.map(r => r.value.data.cardIds[0])).size, 20); assert.equal(f.maximum(), 20);
  const full = await f.ok(['ls', '--full']); assert.equal(full.value.data.stages.flatMap(s => s.cards).length, 120);
  assert.ok((await fs.readFile(join(f.cwd, 'PROCESS.md'), 'utf8')).includes(full.value.data.summary.revision));
});

test('human changes identify the workspace, stages and actual output path without UUID noise', async t => {
  const f = await fixture(t);
  await f.ok(['--help'], { json: false });
  await f.ok(['init']); const created = await f.ok(addArgs);
  const id = created.value.data.cardIds[0];
  const added = await f.ok(['card', 'add', '--title', 'A draft'], { json: false });
  assert.match(added.stdout, /added card_[0-9a-f-]{36}/);
  assert.ok(added.stdout.includes('@ ' + f.cwd));
  const moved = await f.ok(['card', 'move', id.slice(0, 13), '--to', 'review'], { json: false });
  assert.ok(moved.stdout.startsWith('moved ' + id.slice(0, 13) + ' → review (rev '));
  assert.ok(!moved.stdout.includes(id)); assert.doesNotMatch(moved.stdout, /request=|export=|board_/);
  assert.ok(moved.stdout.includes('exported ' + join(f.cwd, 'PROCESS.md')));
  const list = await f.ok(['ls'], { json: false }); assert.match(list.stdout, /todo \(Waiting\):/);
  const invalid = await f.run(['card', 'move', id, '--to', 'missing']);
  assert.deepEqual(invalid.value.error.details.validStageIds, ['todo', 'doing', 'review', 'done']);
  const noCriteria = await f.run(['card', 'add', '--title', 'Agent work'], { env: { PASEO_AGENT_ID: randomUUID() } });
  assert.match(noCriteria.value.error.nextAction, /--criteria.*--intent draft/);
});
