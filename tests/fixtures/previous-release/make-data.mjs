// D66 G2b (research/498): writes `<release>/data/` — a data folder made by that release's own code, the way an installed
// board gets its cards: the automatic cards' engine running on agents' signals, people moving cards on the board, an
// orchestrator linking and unlinking, an agent's own CLI move, an archive. Run once per release when the fixture is made:
//   node tests/fixtures/previous-release/make-data.mjs 0.2.4 [<built dist of that release>]
// Without a dist the pinned sources are used (tests/previous-release.mjs); with one, that build. Not run by `npm test`;
// the bytes it wrote are what the tests read. `expected.json` names each card's case and what an upgrade should make of it.
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { previousRelease } from '../../previous-release.mjs';

const [release, dist] = process.argv.slice(2);
if (!['0.2.3', '0.2.4'].includes(release)) throw new Error('usage: make-data.mjs 0.2.3|0.2.4 [dist]');
const old = dist
  ? { ...await import(pathToFileURL(join(dist, 'shared/core/domain.js')).href), ...await import(pathToFileURL(join(dist, 'server/core/auto-state.js')).href),
    ...await import(pathToFileURL(join(dist, 'server/core/store.js')).href), ...await import(pathToFileURL(join(dist, 'server/auto-cards.js')).href) }
  : await previousRelease(release);

const here = fileURLToPath(new URL(`./${release}/`, import.meta.url));
const dataDir = join(here, 'data');
// The tests make this folder before they use the board (the ledger keeps the workspace folder it was made for).
export const cwd = `/tmp/kanban-previous-fixture/${release}/project`;
await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(cwd, { recursive: true });

let tick = Date.parse(release === '0.2.3' ? '2026-10-05T00:00:00.000Z' : '2026-10-12T00:00:00.000Z'), serial = 0;
const now = () => new Date(tick += 1000).toISOString();
const newId = () => {
  const h = createHash('sha256').update(release + ':' + serial++).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const context = { now, newId };
const store = await old.openStore({ dataDir, context });
const boardId = (await store.initBoard({ cwd, workspaceId: 'wks_example01', actor: { kind: 'user' }, requestId: newId() })).data.boardId;
const auto = old.createAutoCards({ store, locale: () => 'en', now, newId, log: () => {} });
const agent = name => ({ id: newId(), workspaceId: 'wks_example01', cwd, parentAgentId: null, title: name });
const write = (actor, operations) => store.mutateBoard(boardId, { actor, requestId: newId(), operations });
const person = operations => write({ kind: 'user' }, operations);
const cli = (agentId, operations) => write({ kind: 'agent', agentId }, operations);
const add = title => ({ op: 'add', title, intent: 'requested', acceptanceCriteria: 'A reviewable result exists.' });
const cardOf = async a => (await store.readBoard(boardId)).cards.find(c => c.agents.some(l => l.agentId === a.id)).id;
const signal = async (a, kind) => { const outcome = await auto.signal(a, kind); if (outcome === 'held') throw new Error('held ' + kind); return outcome; };
const orchestrator = newId();
const cases = [];
const expect = (name, cardId, mode, why) => cases.push({ name, cardId, mode, why });

// 1–2. Engine cards the engine itself moved last: its memory names the card's newest stage record.
{ const a = agent('Adopt doing'); await signal(a, 'created'); await signal(a, 'turn_started');
  expect('engine moved it last (doing)', await cardOf(a), 'managed', 'the newest stage record is the engine\'s remembered move'); }
{ const a = agent('Adopt review'); await signal(a, 'created'); await signal(a, 'turn_started'); await signal(a, 'turn_ended');
  expect('engine moved it last (review)', await cardOf(a), 'managed', 'the newest stage record is the engine\'s remembered move'); }
// 3. A person completed it; the engine saw that and paused.
{ const a = agent('Done by a person'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await person([{ op: 'move', id, to: 'done' }]); await signal(a, 'turn_ended');
  expect('a person completed it', id, 'paused', 'a completion stage is protected'); }
// 4. A person moved it back; the engine saw that and paused (its memory has the pause).
{ const a = agent('Paused by a person'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await person([{ op: 'move', id, to: 'todo' }]); await signal(a, 'turn_ended');
  expect('a person moved it and the engine paused', id, 'paused', 'the memory holds the pause'); }
// 5. A person moved it; no signal came after.
{ const a = agent('Moved, not seen'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await person([{ op: 'move', id, to: 'review' }]);
  expect('a person moved it, the engine never saw', id, 'paused', 'the newest stage record is a person\'s'); }
// 6. Paused, then resumed in that release, and nothing moved since: that resume is not carried over (470 B5 3).
{ const a = agent('Resumed, not moved'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await person([{ op: 'move', id, to: 'todo' }]); await signal(a, 'turn_ended'); await auto.resume(boardId, id);
  expect('resumed in that release, not moved since', id, 'paused', 'the newest stage record is still the person\'s'); }
// 7. Paused, resumed, and the engine moved it again: adopted like 1.
{ const a = agent('Resumed and moved'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await person([{ op: 'move', id, to: 'todo' }]); await signal(a, 'turn_ended'); await auto.resume(boardId, id);
  await signal(a, 'turn_started');
  expect('resumed in that release and moved by the engine since', id, 'managed', 'the newest stage record is the engine\'s remembered move'); }
// 8. A person's card an orchestrator linked; that agent never signalled — linked, nothing remembered (owner decision 2026-10-18).
{ const a = agent('Linked, nothing remembered');
  const id = (await person([add('Linked by an orchestrator')])).data.cardIds[0]; await cli(orchestrator, [{ op: 'link', id, agentId: a.id }]);
  expect('linked, nothing remembered', id, 'unknown', 'a link without the engine\'s memory needs a check'); }
// 9. A person's card arranged, then linked (gate 443 F2): no proof the arrangement was not a choice.
{ const a = agent('Arranged then linked');
  const id = (await person([add('Arranged then linked')])).data.cardIds[0]; await person([{ op: 'move', id, to: 'review' }]);
  await cli(orchestrator, [{ op: 'link', id, agentId: a.id }]);
  expect('arranged by a person, then linked', id, 'unknown', 'a link without the engine\'s memory needs a check'); }
// 10. The card's own agent moved it with the CLI: an agent actor, but not the engine's remembered move.
{ const a = agent('Own CLI move'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await cli(a.id, [{ op: 'move', id, to: 'review' }]);
  expect('its own agent moved it with the CLI', id, 'unknown', 'the newest stage record is an agent\'s, not the remembered move'); }
// 11–13. A person's cards nobody linked.
{ const id = (await person([add('Free card')])).data.cardIds[0];
  expect('a person\'s card, never linked', id, 'unowned', 'never tracked'); }
{ const id = (await person([add('Arranged card')])).data.cardIds[0]; await person([{ op: 'move', id, to: 'review' }]);
  expect('a person\'s card arranged, never linked', id, 'unowned', 'arranging an untracked card decides nothing'); }
{ const id = (await person([add('Done by hand')])).data.cardIds[0]; await person([{ op: 'move', id, to: 'done' }]);
  expect('a person\'s card completed, never linked', id, 'paused', 'a completion stage is protected'); }
// 14. Completed by a person and archived.
{ const a = agent('Archived done'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await person([{ op: 'move', id, to: 'done' }]); await signal(a, 'turn_ended'); await person([{ op: 'archive', id }]);
  expect('completed and archived', id, 'paused', 'a completion stage is protected'); }
// 15. The engine's card whose agent an orchestrator unlinked: remembered, but no linked agent to adopt it for.
{ const a = agent('Unlinked'); await signal(a, 'created'); await signal(a, 'turn_started');
  const id = await cardOf(a); await cli(orchestrator, [{ op: 'unlink', id, agentId: a.id }]);
  expect('remembered, its agent unlinked', id, 'unknown', 'no linked agent\'s memory names the newest stage record'); }

// Left out: the lock files (not data) and the ledger's per-commit backups under `_archive/` — the repository's commit
// guard keeps every `_archive` path out, and an upgrade reads none of them. Nothing else is left out.
for (const entry of await fs.readdir(dataDir, { recursive: true, withFileTypes: true }))
  if (entry.isFile() && /\.lock$|\.lock\./.test(entry.name)) await fs.rm(join(entry.parentPath ?? entry.path, entry.name));
await fs.rm(join(dataDir, '_archive'), { recursive: true, force: true });
await fs.writeFile(join(here, 'expected.json'), JSON.stringify({ release, commit: old.commit ?? null, boardId, cwd,
  agents: Object.fromEntries((await old.readAutoState(dataDir)).agents ? Object.entries((await old.readAutoState(dataDir)).agents).map(([id, e]) => [id, e.cardId]) : []),
  cases }, null, 2) + '\n');
console.log(release, boardId, cases.length + ' cards');
