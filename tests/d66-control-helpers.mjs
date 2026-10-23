import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutoCards } from '../dist/server/auto-cards.js';
import { readLocale } from '../dist/server/handlers.js';
import { fixture, request } from './helpers.mjs';

/**
 * D66 G1 (research/477): shared setup for the card-control tests. Everything goes through the real Store and the real
 * engine; the only stand-ins are a person (`person`, the board screen's `user` actor), a CLI in an agent session (`cli`),
 * and an old writer that rewrites the ledger without knowing the control file (`outsideWrite`).
 */
export const WORKSPACE = 'wks_example01';
export async function d66(t, options = {}) {
  const f = await fixture(t, options.context ? { context: options.context } : {});
  const make = (store = f.store) => createAutoCards({ store, locale: readLocale, log: () => {}, ...(options.now ? { now: options.now } : {}) });
  const auto = make();
  const agentOf = (overrides = {}) => ({ id: randomUUID(), workspaceId: WORKSPACE, cwd: f.cwd, parentAgentId: null, title: 'D66 worker', ...overrides });
  const board = () => f.store.readBoard(f.id);
  const card = async id => (await board()).cards.find(c => c.id === id);
  const cardOf = async agentId => (await board()).cards.find(c => c.agents.some(a => a.agentId === agentId));
  const person = (operations, extra = {}) => f.store.mutateBoard(f.id, request(operations, extra));
  const cli = (agentId, operations) => f.store.mutateBoard(f.id, { actor: { kind: 'agent', agentId }, requestId: randomUUID(), operations });
  const controlPath = join(f.store.dataDir, 'auto-control', f.id + '.json');
  const control = async () => JSON.parse(await fs.readFile(controlPath, 'utf8'));
  /** The card's control entry as the file holds it. */
  const entry = async cardId => (await control()).cards[cardId];
  /** The card's control entry as the Store judges it now (the file reconciled with the ledger, nothing written). */
  const view = async cardId => (await f.store.readAutoControl(f.id)).cards[cardId];
  /** A listing with these agents, for a restart's repair (`wake`). */
  const listing = (...agents) => ({ agents: { list: async () => ({ entries: agents.map(a => ({ agent: { ...a, status: 'idle', labels: {},
    pendingPermissions: [], archivedAt: null, createdAt: '2026-10-18T00:00:00.000Z', lastUserMessageAt: '2026-10-18T00:00:01.000Z' } })),
    pageInfo: { nextCursor: null } }) } });
  /**
   * An older writer that knows nothing of the control file (an installed 0.2.4 CLI, a restored backup): rewrites the
   * ledger's bytes itself. `change(board)` edits a copy; `bump` advances the revision as a commit would.
   */
  const outsideWrite = async (change, bump = true) => {
    const file = join(f.store.dataDir, 'boards', f.id + '.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    change(raw);
    if (bump) { const [epoch, n] = raw.revision.split(':'); raw.revision = epoch + ':' + (Number(n) + 1); }
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  };
  return { ...f, make, auto, agentOf, board, card, cardOf, person, cli, controlPath, control, entry, view, listing, outsideWrite };
}

/**
 * The engine's writes, caught before they reach the ledger: `hook(input, method)` runs first, and may throw to stand for
 * a crash. Both entry points are caught so the same test reads the same on the code before G1 (which wrote through
 * `mutateBoard`) and after it (the engine's own `autoMutate`).
 */
export function catching(store, hook) {
  return new Proxy(store, { get(target, key) {
    if (key === 'autoMutate' || key === 'mutateBoard') {
      const original = Reflect.get(target, key);
      if (typeof original !== 'function') return original;
      return async (id, input, ...rest) => {
        const after = await hook(input, key);
        const result = await original.call(target, id, input, ...rest);
        if (typeof after === 'function') await after(result);
        return result;
      };
    }
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Every live signal of an agent, then a restart's repair: none may change the card's stage or add a stage record. */
export async function noAutomaticStageChange(s, agents, cardId, label = '') {
  const before = await s.board();
  const stage = before.cards.find(c => c.id === cardId).stageId;
  const records = before.history.filter(h => h.cardId === cardId).length;
  for (const agent of agents) {
    for (const signal of ['created', 'turn_started', 'turn_ended', 'permission_requested', 'permission_resolved', 'archived']) {
      await s.auto.signal(agent, signal);
      const now = await s.board();
      assert.equal(now.cards.find(c => c.id === cardId).stageId, stage, label + ' ' + signal + ': the stage stays');
      assert.equal(now.history.filter(h => h.cardId === cardId).length, records, label + ' ' + signal + ': no automatic stage record');
    }
  }
  for (let round = 0; round < 3; round++) {
    const restarted = s.make(); restarted.wake(s.listing(...agents)); await restarted.idle();
    for (const agent of agents) await restarted.signal(agent, 'turn_ended');
    assert.equal((await s.card(cardId)).stageId, stage, label + ' restart ' + round);
  }
}
