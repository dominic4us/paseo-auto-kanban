// research/281 (the gate on v0.1.53, REQ-137) F1 and F2, kept from coming back. F1: who leads a workspace is judged once, by
// the server, for the draft's receiver and for the screens (`judgeLead` → the board views' `summary.leadNow`): the chats' own
// order (not their cards'), the root's chat before a worktree's, and a mark on another board's chat said to be out of effect.
// F2: a sent request keeps the rule it went by while the mark is unchanged, and says only "Sent" once the mark has moved or
// been taken off (`dispatchMode`; the ledger keeps no receiver's role). Made-up names and folders only, a temporary store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../dist/server/core/index.js';
import { createDispatcher, judgeLead, readLeadEntry } from '../dist/server/dispatch.js';
import { createAutoCards, leadRecord, parseAutoState, readAutoState, writeAutoState, AUTO_STATE_FILE, WORKSPACE_LIMIT } from '../dist/server/auto-cards.js';
import { dispatchMode, toBoardDTO } from '../dist/server/read-model.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { boardLead, boardMark, leadAgentIds, linkStages, workspaceLeadEntries } from '../dist/client/card-groups.js';
import { dispatchFallback, dispatchLine } from '../dist/client/dispatch-view.js';
import { copy } from '../dist/client/i18n.js';
import { actor, request } from './helpers.mjs';

const en = copy('en'), ko = copy('ko');
const at = n => `2026-10-03T00:${String(n).padStart(2, '0')}:00.000Z`;
const uid = n => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const COMPLETE = rows => ({ rows, read: 'complete' });

/** A store with boards at made-up folders, cards linked to chats, and a host that lists `agents` and the workspace `rows`. */
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-281-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openStore({ dataDir: join(root, 'data') });
  const agents = [], rows = [], sent = [];
  const board = async (name, workspaceId) => {
    const cwd = join(root, name); await mkdir(cwd, { recursive: true });
    const made = await store.initBoard({ cwd, workspaceId, actor, requestId: randomUUID() });
    rows.push({ id: workspaceId, workspaceDirectory: cwd });
    return { id: made.data.boardId, cwd, workspaceId };
  };
  const chat = (id, where, n, title, extra = {}) => { agents.push({ id, cwd: where.cwd, workspaceId: where.workspaceId, title, createdAt: at(n), archivedAt: null, status: 'idle', labels: {}, ...extra }); return id; };
  const card = async (b, title, agentId) => {
    await store.mutateBoard(b.id, request([{ op: 'add', title, stageId: 'doing', intent: 'requested', acceptanceCriteria: 'x' }]));
    const made = (await store.readBoard(b.id)).cards.at(-1);
    if (agentId) await store.mutateBoard(b.id, request([{ op: 'link', id: made.id, agentId, role: 'worker' }]));
    await pause(3);
    return made.id;
  };
  const paseo = { agents: { list: async () => ({ entries: agents.filter(a => !a.archivedAt).map(agent => ({ agent })), pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => ({ agent: { ...agents.find(a => a.id === id), activeTurn: null, pendingPermissions: [] } }), send: async () => { sent.push(id); } }) },
    workspaces: { list: async () => ({ entries: rows, pageInfo: { nextCursor: null } }) } };
  const state = await readAutoState(store.dataDir); state.activatedAt = at(0); state.autoBoardFloor = at(0); await writeAutoState(store.dataDir, state);
  const auto = createAutoCards({ store, log: () => {} });
  const dispatcher = createDispatcher({ store, log: () => {}, sleep: async () => {}, fallbackFloor: async () => at(0) });
  const handlers = createReadHandlers(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, (p, boards) => dispatcher.leadsNow(p, boards));
  const view = async b => (await handlers.board({ boardId: b.id }, paseo)).data.board;
  /** The server's receiver of a new draft (the sheet's preview — the same `targetOf` as the send). */
  const receiver = async b => {
    await store.mutateBoard(b.id, request([{ op: 'add', title: 'Probe', intent: 'draft', acceptanceCriteria: 'x' }]));
    const probe = (await store.readBoard(b.id)).cards.at(-1), look = await dispatcher.preview(paseo, b.id, probe.id);
    await store.mutateBoard(b.id, request([{ op: 'archive', id: probe.id }]));
    return look.lead;
  };
  const info = id => { const a = agents.find(x => x.id === id); return a ? { title: a.title, role: a.labels.role } : undefined; };
  return { root, store, agents, rows, sent, board, chat, card, paseo, auto, dispatcher, handlers, view, receiver, info };
}

test('281 F1 the settings name the server\'s receiver: chats in their own order, not their cards\'; the root before a worktree', async t => {
  const w = await world(t);
  const r = await w.board('example-root', 'wks_example01');
  // Lead-01's chat is the older, its card the newer; Lead-02 the other way round.
  const one = w.chat(uid(1), r, 1, 'Lead-01_sample_Opus'), two = w.chat(uid(2), r, 5, 'Lead-02_sample_Opus');
  await w.card(r, 'Lead-02_sample_Opus', two); await w.card(r, 'Lead-01_sample_Opus', one);
  const lead = await w.receiver(r), v = await w.view(r);
  assert.equal(lead.agentId, two, 'the server: the newer chat');
  assert.deepEqual(v.summary.leadNow, { agentId: two, title: 'Lead-02_sample_Opus', by: 'name' }, 'the board view carries the server\'s answer');
  for (const m of [ko, en]) assert.equal(workspaceLeadEntries([v], {}, w.info, () => false, m)[0].text, m.leadStatusName('Lead-02'));
  // A worktree's lead (newer chat, newer card) on the root's board: the root's chat first, as the receiver.
  const wr = await w.board('example-wroot', 'wks_example02'), tree = join(w.root, 'example-wtree');
  w.rows.push({ id: 'wks_example09', workspaceKind: 'worktree', workspaceDirectory: tree, projectRootPath: wr.cwd });
  const rootLead = w.chat(uid(3), wr, 1, 'Lead-02_wroot_Opus'), treeLead = w.chat(uid(4), { cwd: tree, workspaceId: 'wks_example09' }, 9, 'Lead-03_wtree_Opus');
  await w.card(wr, 'Lead-02_wroot_Opus', rootLead); await w.card(wr, 'Lead-03_wtree_Opus', treeLead);
  await pause(2100); // past the dispatcher's short reuse of one host listing
  assert.equal((await w.receiver(wr)).agentId, rootLead);
  const wv = await w.view(wr);
  assert.equal(wv.summary.leadNow.agentId, rootLead);
  assert.equal(boardLead(wv, w.info).name, 'Lead-02', 'the settings: the root\'s, as the server');
});

test('281 F1 a mark on another board\'s chat is kept but out of effect: no "set by you" crown, the settings say who takes drafts', async t => {
  const w = await world(t);
  const a = await w.board('example-a', 'wks_example03'), b = await w.board('example-b', 'wks_example04');
  const elsewhere = w.chat(uid(5), b, 3, 'Plain chat elsewhere'), named = w.chat(uid(6), a, 2, 'Lead-05_a_Opus');
  await w.card(b, 'Plain chat elsewhere', elsewhere);
  const linked = await w.card(a, 'Plain chat elsewhere', elsewhere); await w.card(a, 'Lead-05_a_Opus', named);
  await w.auto.setLead(a.id, linked, true);
  assert.equal(leadRecord(await readAutoState(w.store.dataDir), a.cwd).agentId, elsewhere, 'the mark is kept as saved');
  assert.equal((await w.receiver(a)).agentId, named, 'the server: by name, the marked chat is not this board\'s');
  const v = await w.view(a);
  assert.deepEqual(v.summary.leadNow, { agentId: named, title: 'Lead-05_a_Opus', by: 'name', mark: 'unusable' });
  assert.equal(v.summary.lead, elsewhere, 'the kept mark is still said (the menu can take it off)');
  assert.equal(boardMark(v.summary), null, 'not drawn as the lead');
  assert.equal(linkStages(v.stages, w.info, boardMark(v.summary)).flatMap(s => s.cards).some(c => c.designated), false, 'no "set by you" crown');
  assert.equal(leadAgentIds([v], w.info).includes(elsewhere), false);
  assert.deepEqual(workspaceLeadEntries([v], {}, w.info, () => false, en).map(l => [l.kind, l.text]),
    [['setUnusable', 'Plain chat elsewhere · set by you, but it cannot take this workspace\'s drafts — Lead-05 by name for now']]);
  assert.equal(workspaceLeadEntries([v], {}, w.info, () => false, ko)[0].text, 'Plain chat elsewhere · 직접 지정, 이 워크스페이스의 초안을 받을 수 없는 채팅 — 지금은 Lead-05(이름 규칙)');
  // Marked on its own board, the same chat is in effect there.
  await w.auto.setLead(b.id, (await w.store.readBoard(b.id)).cards[0].id, true);
  await pause(2100);
  const bv = await w.view(b);
  assert.deepEqual([bv.summary.leadNow.by, boardMark(bv.summary), boardLead(bv, w.info).kind], ['set', elsewhere, 'set']);
});

test('281 F1 judgeLead: the mark first; archived → said so and the next rule; unread listing → not judged; no lead → null', () => {
  const b = { workspaceId: 'wks_example01', cwd: '/tmp/example-root' }, here = { cwd: b.cwd, workspaceId: b.workspaceId };
  const list = (...xs) => xs.map(x => readLeadEntry({ agent: { archivedAt: null, labels: {}, ...here, ...x } }));
  const crowd = list({ id: uid(1), title: 'Plain', createdAt: at(1) }, { id: uid(2), title: 'Lead-02', createdAt: at(5) }, { id: uid(3), title: 'Newest', createdAt: at(9) });
  const rows = COMPLETE([{ id: 'wks_example01', workspaceDirectory: b.cwd }]), none = () => false;
  assert.deepEqual(judgeLead(crowd, b, rows, none, uid(1)), { agentId: uid(1), title: 'Plain', by: 'set' });
  assert.deepEqual(judgeLead(crowd, b, rows, none, null), { agentId: uid(2), title: 'Lead-02', by: 'name' });
  assert.deepEqual(judgeLead(crowd.filter(a => a.id !== uid(1)), b, rows, none, uid(1), true), { agentId: uid(2), title: 'Lead-02', by: 'name', mark: 'archived' });
  assert.deepEqual(judgeLead(crowd.filter(a => a.id !== uid(2)), b, rows, none, null), { agentId: null, title: '', by: null }, 'no lead: the screens\' own words');
  const sub = list({ id: uid(4), title: 'Sub', createdAt: at(2), labels: { 'paseo.parent-agent-id': uid(1) } })[0];
  assert.equal(judgeLead([...crowd, sub], b, rows, none, uid(4)).mark, 'unusable', 'a sub-chat');
  const topic = list({ id: uid(6), title: 'Topic', createdAt: at(2), labels: { role: 'topic-lead' } })[0];
  assert.equal(judgeLead([...crowd, topic], b, rows, none, uid(6)).mark, 'unusable', 'a topic lead');
  const closing = COMPLETE([{ id: 'wks_example01', workspaceDirectory: b.cwd, archivingAt: at(10) }]);
  assert.deepEqual(judgeLead(crowd, b, closing, none, uid(1)), { agentId: null, title: '', by: null, mark: 'unusable' }, 'a closing workspace sends to nobody');
  const far = list({ id: uid(7), title: 'Far', createdAt: at(3), cwd: '/tmp/example-far', workspaceId: 'wks_example08' })[0];
  assert.equal(judgeLead([...crowd, far], b, { rows: [], read: 'partial' }, none, uid(7)), null, 'its workspace unread: not judged');
});

test('281 F1 boardLead and the crown take the server\'s answer as it is; without one, the board\'s own reading as before', () => {
  const card = (id, title, agentId, n) => ({ id, title, stageId: 'doing', priority: 'normal', intent: 'requested', blocked: false, nextAction: '',
    agents: 1, awaiting: null, agentIds: [agentId], completedAt: null, createdAt: at(n), updatedAt: at(n) });
  const stages = [{ stageId: 'doing', countsAsDone: false, cards: [card('c1', 'Lead-01_x_Opus', uid(1), 9), card('c2', 'Lead-02_x_Opus', uid(2), 1)] }];
  const info = id => ({ [uid(1)]: { title: 'Lead-01_x_Opus' }, [uid(2)]: { title: 'Lead-02_x_Opus' } })[id];
  assert.equal(boardLead({ stages, summary: {} }, info).name, 'Lead-01', 'no server answer: the card order (the old reading)');
  assert.equal(boardLead({ stages, summary: { leadNow: { agentId: uid(2), title: 'Lead-02_x_Opus', by: 'name' } } }, info).name, 'Lead-02', 'the server\'s');
  assert.deepEqual(boardLead({ stages, summary: { leadNow: { agentId: null, title: '', by: null } } }, info), { kind: 'none', name: '' }, 'the server: nobody by name');
  const archived = { lead: uid(1), leadNow: { agentId: uid(2), title: 'Lead-02_x_Opus', by: 'name', mark: 'archived' } };
  assert.deepEqual(boardLead({ stages, summary: archived }, info), { kind: 'setArchived', name: 'Lead-01', now: 'Lead-02' });
  assert.equal(workspaceLeadEntries([{ stages, summary: { workspaceId: 'wks_example01', cwd: '/tmp/x', ...archived } }], {}, info, () => true, en)[0].text,
    'Lead-01 · set by you, archived — Lead-02 by name for now');
  assert.equal(boardMark(archived), uid(1), 'archived: its crown stays, in the archived look (REQ-98)');
  assert.equal(boardMark({ lead: uid(1) }), uid(1), 'not judged: the kept mark');
  assert.equal(boardMark({ lead: uid(1), leadNow: { agentId: uid(1), title: '', by: 'set' } }), uid(1));
  assert.equal(boardMark({ lead: uid(1), leadNow: { agentId: null, title: '', by: null, mark: 'unusable' } }), null);
  assert.equal(boardMark(undefined), null);
});

test('281 F2 dispatchMode: waiting by the mark now; sent by the mark as it was — after it changed, or unknown, only "Sent"', () => {
  const sent = (target, sentAt = at(5)) => ({ state: 'sent', sentAt, targetAgentId: target });
  const mark = (agentId, n) => ({ agentId, changedAt: at(n) });
  assert.deepEqual(dispatchMode({ state: 'pending', sentAt: null, targetAgentId: uid(1) }, mark(uid(1), 9)), { marked: true }, 'waiting: the mark now');
  assert.deepEqual(dispatchMode({ state: 'pending', sentAt: null, targetAgentId: uid(2) }, mark(uid(1), 1)), {});
  assert.deepEqual(dispatchMode(sent(uid(1)), mark(uid(1), 1)), { marked: true }, 'sent after the mark was set, unchanged since');
  assert.deepEqual(dispatchMode(sent(uid(1)), mark(uid(1), 5)), { marked: true }, 'the same moment counts as unchanged');
  assert.deepEqual(dispatchMode(sent(uid(3)), mark(uid(1), 1)), {}, 'sent elsewhere under that mark: by name or the latest, as the target says');
  assert.deepEqual(dispatchMode(sent(uid(1)), mark(uid(2), 7)), { modeUnknown: true }, 'the mark moved after it was sent');
  assert.deepEqual(dispatchMode(sent(uid(1)), mark(null, 7)), { modeUnknown: true }, 'the mark taken off after it was sent');
  assert.deepEqual(dispatchMode(sent(uid(3)), mark(null, 1)), {}, 'sent after the mark was taken off: no mark then');
  assert.deepEqual(dispatchMode(sent(uid(3)), null), {}, 'no mark ever kept here: as before v0.1.53');
  assert.deepEqual(dispatchMode(sent(uid(3)), undefined), { modeUnknown: true }, 'the file unknown: nothing claimed');
  assert.deepEqual(dispatchMode(sent(uid(3), null), mark(null, 1)), { modeUnknown: true }, 'no sending time: nothing claimed');
  // The words: "latest agent" only when the server says nothing against it.
  const info = () => ({ title: 'Plain chat' }), line = d => dispatchLine(d, en, dispatchFallback(d, info));
  assert.match(line({ ...sent(uid(3)), ...dispatchMode(sent(uid(3)), null) }), /latest agent/);
  for (const flags of [{ marked: true }, { modeUnknown: true }]) assert.doesNotMatch(line({ ...sent(uid(3)), ...flags }), /latest agent|최근/);
});

test('281 F2 a request sent to the marked chat: the card and the detail keep saying "Sent" after the mark moves and is taken off', async t => {
  const w = await world(t);
  const s = await w.board('example-s', 'wks_example05');
  const old = w.chat(uid(7), s, 1, 'Plain old chat'), newest = w.chat(uid(8), s, 9, 'Plain newest chat'); w.chat(uid(9), s, 5, 'Lead-06_s_Opus');
  const oldCard = await w.card(s, 'Plain old chat', old), newCard = await w.card(s, 'Plain newest chat', newest); await w.card(s, 'Lead-06_s_Opus', uid(9));
  await w.auto.setLead(s.id, oldCard, true);
  await w.store.mutateBoard(s.id, request([{ op: 'add', title: 'History request', intent: 'draft', acceptanceCriteria: 'x' }]));
  const history = (await w.store.readBoard(s.id)).cards.at(-1).id;
  await w.store.mutateBoard(s.id, request([{ op: 'dispatch', id: history, to: 'doing' }]), 'board');
  assert.equal(await w.dispatcher.kick(w.paseo, s.id), 'sent');
  assert.equal(w.sent.at(-1), old, 'it went to the marked (older, plain) chat');
  const look = async () => {
    const chip = (await w.view(s)).stages.flatMap(x => x.cards).find(c => c.id === history).dispatch;
    const data = (await w.handlers.card({ boardId: s.id, cardId: history })).data;
    return { chip, mode: data.dispatchMode, card: dispatchLine(chip, en, dispatchFallback(chip, w.info)),
      detail: dispatchLine(data.card.dispatch, ko, dispatchFallback({ ...data.card.dispatch, ...data.dispatchMode }, w.info)) };
  };
  const first = await look();
  assert.equal(first.chip.marked, true); assert.deepEqual(first.mode, { marked: true });
  for (const [what, act] of [['moved', () => w.auto.setLead(s.id, newCard, true)], ['taken off', () => w.auto.setLead(s.id, newCard, false)]]) {
    await pause(3); await act();
    const now = await look();
    assert.equal(now.chip.modeUnknown, true, what); assert.deepEqual(now.mode, { modeUnknown: true }, what);
    assert.doesNotMatch(now.card, /latest agent/, what + ': the card'); assert.doesNotMatch(now.detail, /최근 에이전트/, what + ': the detail');
  }
  // The ledger keeps no receiver's role: only the plugin's file holds when the mark changed.
  const card = (await w.store.readBoard(s.id)).cards.find(c => c.id === history);
  assert.deepEqual(Object.keys(card.dispatch).sort(), ['messageId', 'requestedAt', 'sentAt', 'state', 'targetAgentId']);
});

test('281 F2 a request that really went to the latest agent is still said so; a mark set later makes it a plain "Sent"', async t => {
  const w = await world(t);
  const f = await w.board('example-f', 'wks_example06');
  const only = w.chat(uid(1).replace('1111111', 'aaaaaaa'), f, 4, 'Plain only chat');
  const onlyCard = await w.card(f, 'Plain only chat', only);
  await w.store.mutateBoard(f.id, request([{ op: 'add', title: 'Fallback request', intent: 'draft', acceptanceCriteria: 'x' }]));
  const id = (await w.store.readBoard(f.id)).cards.at(-1).id;
  await w.store.mutateBoard(f.id, request([{ op: 'dispatch', id, to: 'doing' }]), 'board');
  assert.equal(await w.dispatcher.kick(w.paseo, f.id), 'sent');
  const line = async () => { const chip = (await w.view(f)).stages.flatMap(x => x.cards).find(c => c.id === id).dispatch; return dispatchLine(chip, en, dispatchFallback(chip, w.info)); };
  assert.match(await line(), /latest agent/, 'no mark ever, no lead by name: the latest agent');
  await pause(3); await w.auto.setLead(f.id, onlyCard, true); await w.auto.setLead(f.id, onlyCard, false);
  assert.doesNotMatch(await line(), /latest agent/, 'the mark changed since: by which rule is not kept, only "Sent"');
});

test('281 F2 the file keeps a mark taken off as its time only; such records make room when full, a mark never does', async t => {
  const base = { schemaVersion: 1, activatedAt: null, hosts: {}, agents: {} };
  const off = parseAutoState(JSON.stringify({ ...base, leads: { '/tmp/example-x': { agentId: null, changedAt: at(1) } } }));
  assert.equal(off.damaged, undefined); assert.deepEqual(leadRecord(off, '/tmp/example-x'), { agentId: null, changedAt: at(1) });
  assert.equal(leadRecord(off, '/tmp/example-y'), null); assert.equal(leadRecord(null, '/tmp/example-x'), undefined);
  assert.equal(parseAutoState(JSON.stringify({ ...base, leads: { '/tmp/x': { agentId: 7, changedAt: at(1) } } })).damaged, true, 'still a rule');
  const w = await world(t);
  const b = await w.board('example-full', 'wks_example07'), id = w.chat(uid(2), b, 1, 'Plain chat'), card = await w.card(b, 'Plain chat', id);
  const full = await readAutoState(w.store.dataDir);
  full.leads = Object.fromEntries(Array.from({ length: WORKSPACE_LIMIT }, (_, i) => ['/tmp/example-' + i, { agentId: i === 0 ? null : uid(3), changedAt: at(i % 50) }]));
  await writeAutoState(w.store.dataDir, full);
  assert.equal((await w.auto.setLead(b.id, card, true)).changed, true, 'a record of a mark taken off made room');
  const after = JSON.parse(await readFile(join(w.store.dataDir, AUTO_STATE_FILE), 'utf8')).leads;
  assert.equal(Object.keys(after).length, WORKSPACE_LIMIT); assert.equal(after['/tmp/example-0'], undefined);
  full.leads = Object.fromEntries(Array.from({ length: WORKSPACE_LIMIT }, (_, i) => ['/tmp/example-' + i, { agentId: uid(3), changedAt: at(1) }]));
  await writeAutoState(w.store.dataDir, full);
  await assert.rejects(w.auto.setLead(b.id, card, true), /At most/, 'only marks: none pushed out');
  await writeFile(join(w.store.dataDir, AUTO_STATE_FILE), '{"schemaVersion":1,"leads":[]}\n');
  assert.equal(leadRecord(await readAutoState(w.store.dataDir), b.cwd), undefined, 'damaged: unknown');
});

test('281 F1 the board views say nothing of who leads without a host (an older server\'s answer), and toBoardDTO keeps an id as before', async t => {
  const w = await world(t);
  const r = await w.board('example-plain', 'wks_example01');
  const v = (await w.handlers.board({ boardId: r.id })).data.board;
  assert.equal(v.summary.leadNow, undefined, 'no host: not judged');
  const dto = toBoardDTO(await w.store.readBoard(r.id), 'en', 'off', Date.now(), undefined, undefined, undefined, null, uid(1));
  assert.equal(dto.summary.lead, uid(1)); assert.equal(dto.summary.leadNow, undefined);
});
