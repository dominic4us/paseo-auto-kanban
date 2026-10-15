import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, builtinTemplate } from '../dist/server/core/index.js';
export const actor = { kind: 'user' };
export const request = (operations, extra = {}) => ({ actor, requestId: randomUUID(), operations, ...extra });
export const add = (title = 'Example task') => ({ op: 'add', title, intent: 'requested', acceptanceCriteria: 'A reviewable result exists.' });
/**
 * The ledger writes its files 0600 and the tests check that. A TMPDIR on a mount that ignores file modes (some bind
 * mounts from a host show a 0600 file as 0777) fails those checks for the mount's sake, not the code's,
 * so such a TMPDIR gives way to the system's /tmp; when /tmp ignores modes too, TMPDIR stays and the checks say so.
 */
let modeRoot;
export function testTmpdir() {
  return modeRoot ??= (async () => {
    for (const base of new Set([tmpdir(), '/tmp'])) {
      const probe = await mkdtemp(join(base, 'kanban-mode-')).catch(() => null);
      if (!probe) continue;
      try {
        await writeFile(join(probe, 'f'), '', { mode: 0o600 });
        if (((await stat(join(probe, 'f'))).mode & 0o777) === 0o600) return base;
      } finally { await rm(probe, { recursive: true, force: true }); }
    }
    return tmpdir();
  })();
}
export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await testTmpdir(), 'kanban-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const store = await openStore({ dataDir: join(root, 'data'), ...options });
  const initial = await store.initBoard({ cwd, workspaceId: 'wks_example01', actor, requestId: randomUUID() });
  return { root, cwd, store, id: initial.data.boardId, initial };
}
export function board() {
  return { schemaVersion: 1, id: `board_${'a'.repeat(64)}`, workspaceId: 'wks_example01', cwd: '/tmp/example-workspace', workspaceStatus: 'active', template: builtinTemplate(), revision: `${randomUUID()}:1`, cards: [], history: [], receipts: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}
export const context = (now = '2026-01-01T01:00:00.000Z') => ({ newId: randomUUID, now: () => now });
