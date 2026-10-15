import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dispatchMessage } from '../dist/shared/dispatch.js';
import { dispatchPreview } from '../dist/shared/rpc.js';
import { createDispatcher, isFallbackAgent, pickLead, readLeadEntry, takesCard } from '../dist/server/dispatch.js';
import { createAutoCards, readAutoState, writeAutoState } from '../dist/server/auto-cards.js';
import { dispatchFallback, dispatchLine } from '../dist/client/dispatch-view.js';
import { copy } from '../dist/client/i18n.js';
import { fixture, request } from './helpers.mjs';

/**
 * v0.1.46-B (research/239, research/252): a request reaches an agent with no skill, no kanban CLI and no lead named by
 * the "총괄-" rule — the newest top-level agent of the workspace gets it, only for cards requested since this version's
 * first run; the message is in the board's language with the real ids on its kanban line; the server links the agent it
 * sent to. A lead by name still comes first (REQ-97 as before, tests/req97-dispatch.test.mjs).
 */
const LEAD = '99999999-9999-4999-8999-999999999999';
const PLAIN_OLD = '11111111-1111-4111-8111-111111111111', PLAIN_NEW = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333', REMEMBERED = '44444444-4444-4444-8444-444444444444';
const TOPIC = '55555555-5555-4555-8555-555555555555', ARCHIVED = '66666666-6666-4666-8666-666666666666';
const ELSEWHERE = '77777777-7777-4777-8777-777777777777';
const minute = m => `2026-01-01T00:${String(m).padStart(2, '0')}:00.000Z`;
const agent = (id, cwd, created, extra = {}) => ({ id, title: 'Chat ' + id.slice(0, 4), cwd, workspaceId: 'wks_example01',
  createdAt: minute(created), archivedAt: null, labels: {}, status: 'idle', ...extra });
/** Every kind the fallback must pass over, each newer than the one it should pick. */
const crowd = cwd => [agent(PLAIN_OLD, cwd, 1), agent(PLAIN_NEW, cwd, 2),
  agent(CHILD, cwd, 5, { labels: { 'paseo.parent-agent-id': PLAIN_OLD } }), agent(REMEMBERED, cwd, 6),
  agent(TOPIC, cwd, 7, { labels: { role: '주제총괄' } }), agent(ARCHIVED, cwd, 8, { archivedAt: minute(9) }),
  agent(ELSEWHERE, '/elsewhere/other', 9, { workspaceId: 'wks_other01' })];

function fakePaseo(agents, { fail = false } = {}) {
  const sent = [];
  return { sent, agents: {
    list: async () => ({ entries: agents.map(a => ({ agent: a })), pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => ({ agent: { id, status: 'idle', activeTurn: null, archivedAt: null, pendingPermissions: [] } }),
      send: async (text, options) => { if (fail) throw new Error('daemon unavailable'); sent.push({ id, text, messageId: options?.messageId }); } }),
  }, workspaces: { list: async () => ({ entries: [{ id: 'wks_example01', title: 'Example board' }], pageInfo: { nextCursor: null } }) } };
}
async function requestDrafts(store, id, titles) {
  await store.mutateBoard(id, request(titles.map(title => ({ op: 'add', title, intent: 'draft', acceptanceCriteria: '' }))));
  const cards = (await store.readBoard(id)).cards.filter(c => titles.includes(c.title) && !c.dispatch);
  for (const card of cards) await store.mutateBoard(id, request([{ op: 'dispatch', id: card.id, to: 'doing' }]), 'board');
  return cards.map(c => c.id);
}
/** auto-cards.json in the test's own data folder: a remembered sub-agent and, when given, this version's start line. */
async function autoState(store, floor = null) {
  const state = await readAutoState(store.dataDir);
  state.parents = { [REMEMBERED]: { parentAgentId: PLAIN_OLD, at: minute(6) } };
  state.autoBoardFloor = floor;
  await writeAutoState(store.dataDir, state);
}
const quiet = { log: () => {}, sleep: async () => {} };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('v0.1.46-B pickLead: a lead by name first; else the newest top-level, unarchived, non-topic agent here, parents remembered', () => {
  const cwd = '/tmp/example-workspace', b = { workspaceId: 'wks_example01', cwd };
  const read = list => list.map(readLeadEntry);
  const parents = { [REMEMBERED]: { parentAgentId: PLAIN_OLD, at: minute(6) } };
  const withLead = read([...crowd(cwd), agent(LEAD, cwd, 0, { title: '총괄-99 시험' })]);
  assert.deepEqual([pickLead(withLead, b, parents)?.id, pickLead(withLead, b, parents)?.fallback], [LEAD, false], '(a) the named lead, though older');
  const picked = pickLead(read(crowd(cwd)), b, parents);
  assert.deepEqual([picked?.id, picked?.fallback], [PLAIN_NEW, true], '(b) sub-agent, remembered sub-agent, topic lead, archived, elsewhere passed over');
  assert.equal(pickLead(read(crowd(cwd)), b), null, 'no fallback asked for: no lead, as before');
  assert.equal(pickLead(read(crowd(cwd)), b, {})?.id, REMEMBERED, 'without the remembered parent it would count as top-level');
  assert.equal(isFallbackAgent(readLeadEntry(agent(TOPIC, cwd, 1, { labels: { role: '주제총괄' } })), {}), false);
  assert.equal(pickLead([], b, parents), null, '(f) nobody at all');
  // The start line: a lead takes every card, a fallback only those requested at or after it.
  assert.equal(takesCard({ fallback: false }, minute(1), null), true);
  assert.equal(takesCard({ fallback: true }, minute(1), minute(2)), false);
  assert.equal(takesCard({ fallback: true }, minute(2), minute(2)), true);
  assert.equal(takesCard({ fallback: true }, minute(3), null), false, 'no start line known: no fallback');
  assert.equal(takesCard(null, minute(3), minute(2)), false);
});

test('v0.1.46-B server: with no lead the newest agent gets the card, linked once; a named lead still takes it first', async t => {
  const { store, id, cwd } = await fixture(t);
  await autoState(store, minute(0));
  const [cardId] = await requestDrafts(store, id, ['Sample request']);
  const paseo = fakePaseo(crowd(cwd));
  const dispatcher = createDispatcher({ store, ...quiet });
  assert.equal(await dispatcher.kick(paseo, id), 'sent');
  assert.deepEqual(paseo.sent.map(s => s.id), [PLAIN_NEW], '(b) the newest top-level agent');
  const card = (await store.readBoard(id)).cards.find(c => c.id === cardId);
  assert.equal(card.dispatch.state, 'sent'); assert.equal(card.dispatch.targetAgentId, PLAIN_NEW);
  assert.deepEqual(card.agents.map(a => [a.agentId, a.role]), [[PLAIN_NEW, 'worker']], '(e) linked by the server in the same write');
  assert.match(paseo.sent[0].text, new RegExp(`kanban card link ${cardId} --agent ${PLAIN_NEW}`), '(d) the real ids');
  // (a) a lead by name appears: the next card goes to it, not to the newer plain agent.
  const lead = agent(LEAD, cwd, 0, { title: '총괄-99 시험' });
  const [second] = await requestDrafts(store, id, ['Second request']);
  const withLead = fakePaseo([...crowd(cwd), lead]);
  assert.equal(await createDispatcher({ store, ...quiet }).kick(withLead, id), 'sent');
  assert.deepEqual(withLead.sent.map(s => s.id), [LEAD]);
  const after = (await store.readBoard(id)).cards.find(c => c.id === second);
  assert.deepEqual(after.agents.map(a => a.agentId), [LEAD]);
});

test('v0.1.46-B upgrade: a card left waiting before the start line never falls back; one requested after it does', async t => {
  const { store, id, cwd } = await fixture(t);
  await autoState(store);
  const [old] = await requestDrafts(store, id, ['Before the upgrade']);
  // Before this version: nobody by name, so the card says so.
  assert.equal(await createDispatcher({ store, ...quiet }).kick(fakePaseo([]), id), 'noLead');
  assert.equal((await store.readBoard(id)).cards[0].dispatch.state, 'noLead');
  await tick();
  let floor = new Date().toISOString();
  await tick();
  const dispatcher = createDispatcher({ store, ...quiet, fallbackFloor: async () => floor });
  const paseo = fakePaseo(crowd(cwd));
  assert.equal(await dispatcher.kick(paseo, id), 'noLead', 'the old card does not go to the newest agent');
  assert.equal(paseo.sent.length, 0);
  assert.equal((await store.readBoard(id)).cards.find(c => c.id === old).dispatch.state, 'noLead');
  const [fresh] = await requestDrafts(store, id, ['After the upgrade']);
  assert.equal(await dispatcher.kick(paseo, id), 'sent');
  assert.deepEqual(paseo.sent.map(s => s.messageId), [(await store.readBoard(id)).cards.find(c => c.id === fresh).dispatch.messageId]);
  assert.equal(await dispatcher.kick(paseo, id), 'noLead', 'the old one still waits for a lead');
  assert.equal(paseo.sent.length, 1);
  // A lead by name made later gets the old card, as before.
  const lead = fakePaseo([...crowd(cwd), agent(LEAD, cwd, 0, { title: '총괄-99 시험' })]);
  assert.equal(await dispatcher.kick(lead, id), 'sent');
  assert.deepEqual(lead.sent.map(s => s.id), [LEAD]);
  // No start line known (no reader, none kept; or a reader that fails): no fallback.
  floor = null;
  const [third] = await requestDrafts(store, id, ['No start line']);
  assert.equal(await dispatcher.kick(paseo, id), 'noLead');
  assert.equal((await store.readBoard(id)).cards.find(c => c.id === third).dispatch.state, 'noLead');
});

test('v0.1.46-B the start line: kept once in auto-cards.json by AutoCards, read by default; a damaged file means no fallback', async t => {
  const { store, id, cwd } = await fixture(t);
  const auto = createAutoCards({ store, locale: async () => 'ko', log: () => {} });
  const first = await auto.dispatchFloor();
  assert.ok(first && !Number.isNaN(Date.parse(first)));
  assert.equal((await readAutoState(store.dataDir)).autoBoardFloor, first, 'kept in the file');
  assert.equal(await createAutoCards({ store, locale: async () => 'ko', log: () => {} }).dispatchFloor(), first, 'a restart keeps it');
  await tick();
  const [cardId] = await requestDrafts(store, id, ['Default reader']);
  const paseo = fakePaseo(crowd(cwd));
  assert.equal(await createDispatcher({ store, ...quiet }).kick(paseo, id), 'sent', 'no reader given: the kept autoBoardFloor');
  assert.equal(paseo.sent[0].id, REMEMBERED, 'no parents remembered in this file: that agent counts as top-level');
  assert.equal((await store.readBoard(id)).cards.find(c => c.id === cardId).dispatch.state, 'sent');
  // Damaged: the rules are unknown — no start line from AutoCards, no fallback from the default reader either.
  await writeFile(join(store.dataDir, 'auto-cards.json'), '{ not json');
  assert.equal(await auto.dispatchFloor(), null);
  const [held] = await requestDrafts(store, id, ['Damaged file']);
  const again = fakePaseo(crowd(cwd));
  assert.equal(await createDispatcher({ store, ...quiet }).kick(again, id), 'noLead');
  assert.equal(await createDispatcher({ store, ...quiet, fallbackFloor: async () => minute(0) }).kick(again, id), 'noLead', 'parents unknown either');
  assert.equal(again.sent.length, 0);
  assert.equal((await store.readBoard(id)).cards.find(c => c.id === held).dispatch.state, 'noLead');
});

test('v0.1.46-B the message: ko and en, the preview builds the very words sent, the kanban line names the real ids', async t => {
  for (const locale of ['ko', 'en']) {
    const { store, id, cwd } = await fixture(t);
    await autoState(store, minute(0));
    await store.mutateBoard(id, request([{ op: 'add', title: 'Sample request', intent: 'draft', acceptanceCriteria: '', notes: 'Some notes' }]));
    const card = (await store.readBoard(id)).cards[0];
    const paseo = fakePaseo(crowd(cwd));
    const dispatcher = createDispatcher({ store, ...quiet, locale: async () => locale });
    const preview = await dispatcher.preview(paseo, id, card.id);
    assert.equal(dispatchPreview.output.safeParse({ ok: true, data: preview, committed: false, warnings: [] }).success, true, 'the RPC shape');
    assert.deepEqual(preview.lead, { agentId: PLAIN_NEW, title: 'Chat 2222', fallback: true });
    assert.equal(preview.locale, locale);
    // What the sheet shows (client/dispatch-confirm.tsx) — the criteria typed there, empty here, fall back to the title.
    const shown = dispatchMessage({ title: card.title, cardId: card.id, boardTitle: preview.boardTitle, notes: card.notes,
      criteria: card.title, locale: preview.locale, agentId: preview.lead.agentId });
    await store.mutateBoard(id, request([{ op: 'dispatch', id: card.id, to: 'doing' }]), 'board');
    assert.equal(await dispatcher.kick(paseo, id), 'sent');
    assert.equal(paseo.sent[0].text, shown, locale + ': preview = sent');
    const lines = shown.split('\n');
    assert.equal(lines[0], (locale === 'ko' ? '[칸반 요청] ' : '[Kanban request] ') + 'Sample request');
    assert.match(lines.at(-2), locale === 'ko' ? /^할 일: / : /^To do: /, 'the task in plain words, for an agent with no CLI');
    assert.ok(lines.at(-1).includes(`kanban card link ${card.id} --agent ${PLAIN_NEW}`), 'the last line: the command with the real ids');
    assert.match(lines.at(-1), locale === 'ko' ? /CLI가 없으면 이 줄은 건너뛰세요/ : /no CLI\? skip this line/);
  }
  // No agent to send to yet: no command line (no id to name).
  assert.doesNotMatch(dispatchMessage({ title: 'T', cardId: 'card_x', boardTitle: 'B', notes: '', criteria: 'C', locale: 'en' }), /kanban card link/);
});

test('v0.1.46-B link: already linked stays once; a failed send links nothing and the card waits', async t => {
  const { store, id, cwd } = await fixture(t);
  await autoState(store, minute(0));
  const [linked, failing] = await requestDrafts(store, id, ['Linked before', 'Send fails']);
  await store.mutateBoard(id, request([{ op: 'link', id: linked, agentId: PLAIN_NEW, role: 'lead', label: 'kept' }]));
  const paseo = fakePaseo(crowd(cwd));
  assert.equal(await createDispatcher({ store, ...quiet }).kick(paseo, id), 'sent');
  const card = (await store.readBoard(id)).cards.find(c => c.id === linked);
  assert.deepEqual(card.agents.map(a => [a.agentId, a.role, a.label]), [[PLAIN_NEW, 'lead', 'kept']], 'no second link, its role untouched');
  const broken = fakePaseo(crowd(cwd), { fail: true });
  assert.equal(await createDispatcher({ store, ...quiet }).kick(broken, id), 'failed');
  const waiting = (await store.readBoard(id)).cards.find(c => c.id === failing);
  assert.equal(waiting.dispatch.state, 'pending'); assert.deepEqual(waiting.agents, [], '(e) nothing linked on a failed send');
});

test('v0.1.46-B no agent at all: the card waits, the preview names nobody, and the words say to open a chat', async t => {
  const { store, id } = await fixture(t);
  await autoState(store, minute(0));
  await store.mutateBoard(id, request([{ op: 'add', title: 'Lonely', intent: 'draft', acceptanceCriteria: '' }]));
  const card = (await store.readBoard(id)).cards[0];
  const dispatcher = createDispatcher({ store, ...quiet });
  assert.equal((await dispatcher.preview(fakePaseo([]), id, card.id)).lead, null);
  await store.mutateBoard(id, request([{ op: 'dispatch', id: card.id, to: 'doing' }]), 'board');
  assert.equal(await dispatcher.kick(fakePaseo([]), id), 'noLead');
  const ko = copy('ko'), en = copy('en');
  assert.match(ko.dispatchNoLead, /보낼 에이전트가 없습니다 — 새 채팅을 먼저 여세요/);
  assert.match(en.dispatchNoLead, /no agent to send to — open a new chat first/);
  for (const m of [ko, en]) assert.doesNotMatch(m.dispatchNoLead + m.dispatchNoLeadTitle + m.dispatchNoLeadChip + m.dispatchQueued(null), /총괄|lead/i,
    'no "lead" naming rule a person without the skill would not know');
  // The fallback said on the card and in the sheet.
  assert.equal(dispatchLine({ state: 'pending', sentAt: null }, ko, true), '전송 대기 ⏳ · 최근 에이전트');
  assert.match(dispatchLine({ state: 'sent', sentAt: minute(3) }, en, true), /^Sent \d\d:\d\d · latest agent$/, 'the time first: a narrow card cuts the end');
  assert.match(dispatchLine({ state: 'sent', sentAt: minute(3) }, ko, true), /^전송됨 \d\d:\d\d · 최근 에이전트$/);
  assert.match(ko.dispatchFallbackWhen('Chat 2222'), /가장 최근 에이전트에게 보냅니다.*Chat 2222/);
  assert.equal(ko.dispatchQueued('Chat 2222', true), '가장 최근 에이전트(Chat 2222)에게 전송 대기');
  const info = { [PLAIN_NEW]: { title: 'Chat 2222' }, [LEAD]: { title: '총괄-99 시험' } };
  assert.equal(dispatchFallback({ targetAgentId: PLAIN_NEW }, id => info[id]), true);
  assert.equal(dispatchFallback({ targetAgentId: LEAD }, id => info[id]), false, 'a lead by name: the plain words');
  assert.equal(dispatchFallback({ targetAgentId: CHILD }, id => info[id]), false, 'not looked up yet: the plain words');
  assert.equal(dispatchFallback({ targetAgentId: null }, id => info[id]), false);
});
