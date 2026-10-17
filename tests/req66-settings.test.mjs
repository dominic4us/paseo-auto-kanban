import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardOffset, boardHeaderWidth, settingsWindowSize } from '../dist/client/layout.js';
import { swimlaneWidth } from '../dist/client/swimlane-model.js';
import { createPoller } from '../dist/client/refresh-model.js';
import { readUiState, writeUiState } from '../dist/server/ui-state.js';
import { uiStateSet, boardGet } from '../dist/shared/rpc.js';

async function dataDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-req66-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

test('REQ-66 ② board position: the spare width goes left, both sides or right; none when the board must scroll', () => {
  const board = swimlaneWidth();
  assert.equal(board, 1168);
  // 1600px plugin area: 1600 − 32 − 1168 = 400 spare.
  assert.equal(boardOffset(1600, board, 'left'), 0);
  assert.equal(boardOffset(1600, board, 'center'), 200);
  assert.equal(boardOffset(1600, board, 'right'), 400);
  // The right edge the title row, the filter row and the board share (REQ-54) moves by the same offset.
  for (const align of ['left', 'center', 'right']) {
    const offset = boardOffset(1600, board, align);
    assert.ok(16 + offset + boardHeaderWidth(1600, board) <= 1600 - 16, align + ' stays inside the 16px padding');
  }
  // An odd spare rounds down, never to a half pixel.
  assert.equal(boardOffset(1601, board, 'center'), 200);
  // Narrower than the board (1080 plugin area) or exactly the board: left start whatever the setting.
  for (const width of [1080, 1200, 400]) for (const align of ['left', 'center', 'right'])
    assert.equal(boardOffset(width, board, align), 0, width + ' ' + align);
});

test('REQ-66 ① window size: min(720, area − 96) × min(560, area height − 96)', () => {
  assert.deepEqual(settingsWindowSize({ width: 1400, height: 900 }), { width: 720, height: 560 });
  assert.deepEqual(settingsWindowSize({ width: 1080, height: 700 }), { width: 720, height: 560 });
  assert.deepEqual(settingsWindowSize({ width: 800, height: 600 }), { width: 704, height: 504 });
  assert.deepEqual(settingsWindowSize({ width: 760, height: 300 }), { width: 664, height: 240 }, 'a floor keeps the rows usable');
});

test('REQ-66 storage: one row per write, beside the filter and order, other rows and hosts untouched, only real changes written', async t => {
  const dir = await dataDir(t), host = 'host_sample', other = 'host_other';
  // Before REQ-66 there is no settings key at all, and reading says so (defaults apply on the client).
  assert.deepEqual(await readUiState(dir, host), { hiddenProjects: [], order: { projects: [], workspaces: [] } });
  await writeUiState(dir, other, { hiddenProjects: ['prj_other'] });
  await writeUiState(dir, host, { hiddenProjects: ['prj_hidden'], order: { projects: ['prj_a'], workspaces: [] } });
  let result = await writeUiState(dir, host, { settings: { boardAlign: 'left' } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings, { boardAlign: 'left' });
  result = await writeUiState(dir, host, { settings: { autoRefresh: false } });
  assert.deepEqual(result.settings, { boardAlign: 'left', autoRefresh: false }, 'the second row keeps the first');
  assert.deepEqual(result.hiddenProjects, ['prj_hidden'], 'the filter is kept');
  // Saving the filter or the order afterwards never drops the settings.
  await writeUiState(dir, host, { hiddenProjects: [] });
  await writeUiState(dir, host, { order: { projects: [], workspaces: ['wks_a'] } });
  const read = await readUiState(dir, host);
  assert.deepEqual(read.settings, { boardAlign: 'left', autoRefresh: false });
  assert.deepEqual(read.order, { projects: [], workspaces: ['wks_a'] });
  assert.deepEqual(await readUiState(dir, other), { hiddenProjects: ['prj_other'], order: { projects: [], workspaces: [] } },
    'another host is untouched');
  // The same value again is no change and no write.
  let writes = 0;
  result = await writeUiState(dir, host, { settings: { boardAlign: 'left' } }, { write: async () => { writes++; } });
  assert.equal(result.changed, false); assert.equal(writes, 0);
  // Stored shape.
  const file = JSON.parse(await readFile(join(dir, 'ui-state.json'), 'utf8'));
  assert.deepEqual(file.hosts[host].settings, { boardAlign: 'left', autoRefresh: false });
  assert.equal(file.hosts[other].settings, undefined, 'a host that never changed a setting keeps the old shape');
});

test('REQ-66 storage: unknown or damaged values read as the defaults, and a failed write leaves the file as it was', async t => {
  const dir = await dataDir(t), host = 'host_sample';
  await writeFile(join(dir, 'ui-state.json'), JSON.stringify({ schemaVersion: 1, hosts: {
    [host]: { hiddenProjects: [], order: { projects: [], workspaces: [] }, settings: { boardAlign: 'diagonal', autoRefresh: 'yes', extra: 1 } } } }));
  assert.equal((await readUiState(dir, host)).settings, undefined, 'nothing valid, nothing reported');
  await writeUiState(dir, host, { settings: { autoRefresh: false } });
  const before = await readFile(join(dir, 'ui-state.json'), 'utf8');
  await assert.rejects(writeUiState(dir, host, { settings: { boardAlign: 'right' } }, { rename: async () => { throw new Error('disk full'); } }));
  assert.equal(await readFile(join(dir, 'ui-state.json'), 'utf8'), before, 'the refused write changed nothing');
  assert.deepEqual((await readUiState(dir, host)).settings, { autoRefresh: false });
});

test('REQ-66 RPC: a settings row is a valid write on its own; an empty or unknown one is refused; board.get takes the host', () => {
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { boardAlign: 'center' } }).success, true);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { autoRefresh: false } }).success, true);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: {} }).success, false);
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { boardAlign: 'middle' } }).success, false);
  // REQ-70 added `theme` (tests/req70-theme.test.mjs); a field no unit defines is still refused.
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h', settings: { fontSize: 14 } }).success, false, 'no fields outside the known rows');
  assert.equal(uiStateSet.input.safeParse({ hostId: 'h' }).success, false);
  assert.equal(boardGet.input.safeParse({ workspaceId: 'wks_example01', hostId: 'h' }).success, true);
});

/** A hand-driven clock like the REQ-62 poller tests. */
function clock() {
  let now = 0, next = 1; const due = new Map();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { now: () => now, timers: { set: (run, ms) => { const id = next++; due.set(id, { at: now + ms, run }); return id; }, clear: id => { due.delete(id); } },
    async advance(ms) {
      await flush(); const end = now + ms;
      for (;;) {
        const first = [...due].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at; due.delete(first[0]); first[1].run(); await flush();
      }
      now = end; await flush();
    } };
}
test('REQ-66 ④ poller status: live while looking, paused after 3 minutes with the last look, live again on a touch — never per look', async () => {
  const c = clock(), reports = [];
  const p = createPoller({ now: c.now, timers: c.timers, config: { intervalMs: 4000, idleMs: 180_000, minGapMs: 1000 },
    check: async () => {}, onStatus: status => reports.push(status) });
  p.start();
  assert.deepEqual(reports, [{ live: true }]);
  await c.advance(60_000);
  assert.ok(p.state().checks >= 14, 'it looked many times');
  assert.deepEqual(reports, [{ live: true }], 'and said nothing about each look');
  await c.advance(130_000);
  assert.equal(reports.length, 2);
  assert.equal(reports[1].live, false);
  assert.ok(reports[1].lastLook > 170_000 && reports[1].lastLook <= 180_000, 'paused since the last finished look');
  const stopped = p.state().checks;
  await c.advance(60_000);
  assert.equal(p.state().checks, stopped, 'no request while paused');
  assert.equal(reports.length, 2, 'and no report');
  p.activity();
  await c.advance(0);
  assert.equal(reports.at(-1).live, true, 'a touch makes it live again');
  // Hidden (another Paseo screen): paused too; shown again: live.
  p.visibility(false);
  assert.equal(reports.at(-1).live, false);
  p.visibility(true); await c.advance(0);
  assert.equal(reports.at(-1).live, true);
  const count = reports.length;
  p.dispose(); await c.advance(10_000);
  assert.equal(reports.length, count, 'nothing after dispose');
});
