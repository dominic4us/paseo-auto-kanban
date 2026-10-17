// REQ-137 (research/273 B, the owner's choice): the lead is no longer told by the Korean name rule alone — English aliases
// ("Lead-", "Lead_", "topic-lead", any case), and a chat a person marks from a card's ⋯ ("Mark as lead"), kept in the plugin's
// own auto-cards.json (`leads`, never the ledger). One judgement (`leadRank`) for the crown, the lead's own status row, the
// draft's receiver and the topic lead's medal; the settings window lists who leads each workspace, read only. The screens are
// exercised in tests/web/run.mjs (KANBAN_WEB_ONLY=req137). Made-up names and folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLeadName, isTopicRole, leadRank, leadShortName, LEAD_TITLES, LEAD_PROFILES, TOPIC_LEAD_ROLES } from '../dist/shared/dispatch.js';
import { createDispatcher, isLeadAgent, pickLead, readLeadEntry } from '../dist/server/dispatch.js';
import { createAutoCards, designatedLead, parseAutoState, readAutoState, writeAutoState, AUTO_STATE_FILE, AUTO_STATE_BACKUP } from '../dist/server/auto-cards.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { groupsKey } from '../dist/server/card-parents.js';
import { boardLead, isTopicLead, leadAgentIds, leadMenu, linkStages, workspaceLeadEntries } from '../dist/client/card-groups.js';
import { dispatchFallback } from '../dist/client/dispatch-view.js';
import { copy } from '../dist/client/i18n.js';
import { add, fixture, request } from './helpers.mjs';

const en = copy('en'), ko = copy('ko');
const MARKED = '11111111-1111-4111-8111-111111111111', NAMED = '22222222-2222-4222-8222-222222222222';
const PLAIN = '33333333-3333-4333-8333-333333333333', CHILD = '44444444-4444-4444-8444-444444444444';
const TOPIC = '55555555-5555-4555-8555-555555555555', TREE = '66666666-6666-4666-8666-666666666666';
const minute = m => `2026-10-03T00:${String(m).padStart(2, '0')}:00.000Z`;
const quiet = { log: () => {}, sleep: async () => {} };

test('REQ-137 aliases: "Lead-"/"Lead_" and "topic-lead" in any case, Korean and English mixed, a prefix only', () => {
  assert.deepEqual([LEAD_TITLES, LEAD_PROFILES, TOPIC_LEAD_ROLES], [['총괄-', 'Lead-'], ['총괄_', 'Lead_'], ['주제총괄', 'topic-lead']]);
  for (const title of ['Lead-03_Shop-Renewal_Fable', 'lead-03', 'LEAD-1', '  Lead-x', '총괄-07_샘플_Opus', 'Lead-03 총괄 확인'])
    assert.equal(isLeadName(title, null), true, title);
  for (const profile of ['Lead_Opus-5.5', 'lead_x', 'LEAD_Y', '총괄_Opus-5.5']) assert.equal(isLeadName('Worker', profile), true, profile);
  for (const title of ['Leader notes', 'Lead gen 분석', 'Plan Lead-03', '총괄 확인', 'Mislead-1', '']) assert.equal(isLeadName(title, 'build_Opus'), false, title);
  for (const role of ['주제총괄', 'topic-lead', 'Topic-Lead', ' TOPIC-LEAD ']) assert.equal(isTopicRole(role), true, role);
  for (const role of ['topic lead', 'topiclead', 'lead', '', null]) assert.equal(isTopicRole(role), false, String(role));
  assert.equal(leadShortName('Lead-03_Shop-Renewal_Fable'), 'Lead-03');
  // The server and the board read the same aliases.
  assert.equal(isLeadAgent({ title: 'lead-02 sample', profile: '', role: '', parent: null, archived: false }), true);
  assert.equal(isLeadAgent({ title: 'Lead-02', profile: '', role: 'topic-lead', parent: null, archived: false }), false, 'a topic lead by its English role');
  assert.equal(isTopicLead({ role: 'Topic-Lead' }, false, false), true, 'the medal reads the alias too');
});

test('REQ-137 leadRank: the marked chat first, then a lead by name; never a sub-chat or a topic lead', () => {
  assert.equal(leadRank({ id: MARKED, title: 'Plain chat' }, MARKED), 'set');
  assert.equal(leadRank({ id: MARKED, title: 'Lead-01' }, MARKED), 'set', 'marked beats its own name');
  assert.equal(leadRank({ id: NAMED, title: 'Lead-01' }, MARKED), 'name');
  assert.equal(leadRank({ id: PLAIN, title: 'Plain chat' }, MARKED), null);
  assert.equal(leadRank({ id: MARKED, title: 'x', parent: NAMED }, MARKED), null, 'a sub-chat never leads');
  assert.equal(leadRank({ id: MARKED, title: 'x', role: 'topic-lead' }, MARKED), null, 'a topic lead never leads');
  assert.equal(leadRank({ id: MARKED, title: 'x' }, null), null);
});

test('REQ-137 auto-cards.json: `leads` is a rule — kept, written, and an unreadable entry damages the file (fail closed)', () => {
  const base = { schemaVersion: 1, activatedAt: null, hosts: {}, agents: {} };
  const ok = parseAutoState(JSON.stringify({ ...base, leads: { '/tmp/example-workspace': { agentId: MARKED, changedAt: minute(1) } } }));
  assert.equal(ok.damaged, undefined);
  assert.equal(designatedLead(ok, '/tmp/example-workspace/'), MARKED, 'by the folder\'s spelling (normalizeCwd)');
  assert.equal(designatedLead(ok, '/tmp/other'), null);
  for (const leads of [[], { '/tmp/x': { agentId: '' , changedAt: minute(1) } }, { '/tmp/x': { agentId: MARKED, changedAt: 'soon' } }, { '/tmp/x': 'agent' }]) {
    const state = parseAutoState(JSON.stringify({ ...base, leads }));
    assert.equal(state.damaged, true, JSON.stringify(leads));
    assert.equal(designatedLead(state, '/tmp/x'), null, 'a damaged file knows no mark');
  }
  assert.equal(parseAutoState(JSON.stringify(base)).leads && Object.keys(parseAutoState(JSON.stringify(base)).leads).length, 0, 'absent: none');
});

/** A board with three cards: a plain chat's, a named lead's and a sub-chat's (remembered in `parents`), and one with no chat. */
async function board(t) {
  const f = await fixture(t);
  await f.store.mutateBoard(f.id, request([add('Plain chat card'), add('Lead-07_sample_Opus'), add('Sub chat card'), add('No chat card')]));
  const cards = (await f.store.readBoard(f.id)).cards;
  const byTitle = title => cards.find(c => c.title === title).id;
  await f.store.mutateBoard(f.id, request([{ op: 'link', id: byTitle('Plain chat card'), agentId: MARKED, role: 'worker' },
    { op: 'link', id: byTitle('Lead-07_sample_Opus'), agentId: NAMED, role: 'worker' }, { op: 'link', id: byTitle('Sub chat card'), agentId: CHILD, role: 'worker' }]));
  const state = await readAutoState(f.store.dataDir);
  state.parents = { [CHILD]: { parentAgentId: MARKED, at: minute(1) } };
  await writeAutoState(f.store.dataDir, state);
  return { ...f, byTitle, auto: createAutoCards({ store: f.store, log: () => {} }) };
}

test('REQ-137 mark, move the mark, take it off: one per workspace, under the board\'s folder, only the plugin\'s file', async t => {
  const { store, id, cwd, byTitle, auto } = await board(t);
  const before = (await store.readBoard(id)).revision;
  assert.deepEqual(await auto.setLead(id, byTitle('Plain chat card'), true), { lead: MARKED, previous: null, changed: true });
  assert.equal(designatedLead(await readAutoState(store.dataDir), cwd), MARKED);
  assert.deepEqual(await auto.setLead(id, byTitle('Plain chat card'), true), { lead: MARKED, previous: MARKED, changed: false }, 'again: nothing written');
  assert.deepEqual(await auto.setLead(id, byTitle('Lead-07_sample_Opus'), true), { lead: NAMED, previous: MARKED, changed: true }, 'another card: the mark moves');
  assert.deepEqual(await auto.setLead(id, byTitle('Plain chat card'), false), { lead: NAMED, previous: NAMED, changed: false }, 'off from a card that is not marked: nothing');
  assert.deepEqual(await auto.setLead(id, byTitle('Lead-07_sample_Opus'), false), { lead: null, previous: NAMED, changed: true }, 'off: back to the rules');
  assert.equal(designatedLead(await readAutoState(store.dataDir), cwd), null);
  await assert.rejects(auto.setLead(id, byTitle('Sub chat card'), true), /sub-chat/i, 'a remembered sub-chat cannot be marked');
  await assert.rejects(auto.setLead(id, byTitle('No chat card'), true), /no chat/i);
  await assert.rejects(auto.setLead(id, 'card_00000000-0000-4000-8000-000000000000', true), /not found/i);
  assert.equal((await store.readBoard(id)).revision, before, 'the ledger is never written');
  const file = JSON.parse(await readFile(join(store.dataDir, AUTO_STATE_FILE), 'utf8'));
  // 281 F2: taken off, the folder keeps when its mark last changed (no chat), so an earlier request is not judged by today's mark.
  assert.deepEqual(Object.values(file.leads).map(v => v.agentId), [null], 'taken off: no chat, only when it changed');
  assert.equal(await readFile(join(store.dataDir, AUTO_STATE_BACKUP), 'utf8'), await readFile(join(store.dataDir, AUTO_STATE_FILE), 'utf8'), 'the backup keeps the same bytes');
});

test('REQ-137 a damaged auto-cards.json: the mark is neither saved nor read, and the bytes are kept', async t => {
  const { store, id, byTitle, auto } = await board(t);
  await auto.setLead(id, byTitle('Plain chat card'), true);
  const broken = '{"schemaVersion":1,"leads":{"/x":"not an entry"}}\n';
  await writeFile(join(store.dataDir, AUTO_STATE_FILE), broken);
  await assert.rejects(auto.setLead(id, byTitle('Lead-07_sample_Opus'), true), /could not be read/);
  assert.equal(await readFile(join(store.dataDir, AUTO_STATE_FILE), 'utf8'), broken, 'never written over');
  const state = await readAutoState(store.dataDir);
  assert.equal(state.damaged, true);
  assert.equal(designatedLead(state, (await store.readBoard(id)).cwd), null, 'no mark known: the lead by name alone');
});

const agent = (id, cwd, created, extra = {}) => ({ id, title: 'Chat ' + id.slice(0, 4), cwd, workspaceId: 'wks_example01',
  createdAt: minute(created), archivedAt: null, labels: {}, status: 'idle', ...extra });
test('REQ-137 pickLead: marked → by name → fallback; archived, elsewhere, a sub-chat or a topic lead gives way; a worktree\'s chat counts', () => {
  const cwd = '/tmp/example-workspace', b = { workspaceId: 'wks_example01', cwd }, read = list => list.map(readLeadEntry);
  const crowd = [agent(MARKED, cwd, 1), agent(NAMED, cwd, 5, { title: 'Lead-02_sample_Opus' }), agent(PLAIN, cwd, 9)];
  assert.equal(pickLead(read(crowd), b, null, undefined, MARKED)?.id, MARKED, '① the marked chat, though older than the named lead');
  assert.equal(pickLead(read(crowd), b, null, undefined, MARKED)?.fallback, false);
  assert.equal(pickLead(read(crowd), b, null)?.id, NAMED, '② no mark: the lead by name (English alias)');
  assert.deepEqual([pickLead(read([agent(PLAIN, cwd, 9)]), b, {})?.id, pickLead(read([agent(PLAIN, cwd, 9)]), b, {})?.fallback], [PLAIN, true], '③ neither: the newest chat');
  // The marked chat archived (the listing has no archived chats; an archived entry is passed over too): the next rule, until it is restored.
  assert.equal(pickLead(read([agent(MARKED, cwd, 1, { archivedAt: minute(2) }), crowd[1]]), b, null, undefined, MARKED)?.id, NAMED, 'archived: next rule');
  assert.equal(pickLead(read(crowd.slice(1)), b, null, undefined, MARKED)?.id, NAMED, 'not listed (archived): next rule');
  assert.equal(pickLead(read(crowd), b, null, undefined, MARKED)?.id, MARKED, 'restored: the marked chat again');
  assert.equal(pickLead(read([agent(MARKED, '/elsewhere', 1, { workspaceId: 'wks_other01' }), crowd[1]]), b, null, undefined, MARKED)?.id, NAMED, 'another workspace');
  assert.equal(pickLead(read([agent(MARKED, cwd, 1, { labels: { 'paseo.parent-agent-id': NAMED } }), crowd[1]]), b, null, undefined, MARKED)?.id, NAMED, 'a sub-chat');
  assert.equal(pickLead(read([agent(MARKED, cwd, 1, { labels: { role: 'topic-lead' } }), crowd[1]]), b, null, undefined, MARKED)?.id, NAMED, 'a topic lead');
  const tree = agent(TREE, '/tmp/example-workspace-wt/feature', 1, { workspaceId: 'wks_tree01' });
  assert.equal(pickLead(read([tree, crowd[1]]), b, null, a => a.id === TREE, TREE)?.id, TREE, 'a worktree chat whose cards land here (D25) can be the marked lead');
  assert.equal(pickLead(read([tree, crowd[1]]), b, null, () => false, TREE)?.id, NAMED, 'a worktree of another board cannot');
});

function fakePaseo(agents) {
  const sent = [];
  return { sent, agents: {
    list: async () => ({ entries: agents.map(a => ({ agent: a })), pageInfo: { nextCursor: null } }),
    ref: id => ({ refresh: async () => ({ agent: { id, status: 'idle', activeTurn: null, archivedAt: null, pendingPermissions: [] } }),
      send: async (text, options) => { sent.push({ id, text, messageId: options?.messageId }); } }),
  }, workspaces: { list: async () => ({ entries: [{ id: 'wks_example01', title: 'Example board' }], pageInfo: { nextCursor: null } }) } };
}
test('REQ-137 the draft\'s receiver (v0.1.47 one judgement): preview and send agree; archived → next, restored → back; damaged → by name', async t => {
  const { store, id, cwd, byTitle, auto } = await board(t);
  const named = agent(NAMED, cwd, 5, { title: 'Lead-07_sample_Opus' }), marked = agent(MARKED, cwd, 1, { title: 'Plain chat' });
  await auto.setLead(id, byTitle('Plain chat card'), true);
  const dispatcher = createDispatcher({ store, ...quiet, fallbackFloor: async () => minute(0) });
  const draft = async title => {
    await store.mutateBoard(id, request([{ op: 'add', title, intent: 'draft', acceptanceCriteria: '' }]));
    const card = (await store.readBoard(id)).cards.find(c => c.title === title);
    return card.id;
  };
  const first = await draft('First request');
  assert.equal((await dispatcher.preview(fakePaseo([marked, named]), id, first)).lead?.agentId, MARKED, 'the sheet names the marked chat');
  await store.mutateBoard(id, request([{ op: 'dispatch', id: first, to: 'doing' }]), 'board');
  const both = fakePaseo([marked, named]);
  assert.equal(await dispatcher.kick(both, id), 'sent');
  assert.deepEqual(both.sent.map(s => s.id), [MARKED], 'sent to the marked chat, not the newer named lead');
  // The marked chat archived: the listing leaves it out, so the next card goes to the lead by name.
  const second = await draft('Second request');
  assert.equal((await dispatcher.preview(fakePaseo([named]), id, second)).lead?.agentId, NAMED, 'archived: the next rule');
  // Restored: the marked chat again.
  assert.equal((await dispatcher.preview(fakePaseo([marked, named]), id, second)).lead?.agentId, MARKED, 'restored: marked again');
  // The board read says the card went to the marked lead (never "the latest agent").
  const dto = toBoardDTO(await store.readBoard(id), 'en', 'off', Date.now(), undefined, undefined, undefined, minute(0), MARKED);
  const sentCard = dto.stages.flatMap(s => s.cards).find(c => c.id === first);
  assert.equal(sentCard.dispatch.marked, true);
  assert.equal(dispatchFallback(sentCard.dispatch, () => ({ title: 'Plain chat' })), false, 'not called a fallback');
  assert.equal(dispatchFallback({ targetAgentId: MARKED, marked: true }, () => ({ title: 'Plain chat' })), false, 'the detail: by the server\'s flag');
  assert.equal(dispatchFallback({ targetAgentId: PLAIN }, () => ({ title: 'Plain chat' })), true, 'another plain chat still is');
  // auto-cards.json damaged: the mark is unknown, so only the lead by name takes it (and no fallback).
  await writeFile(join(store.dataDir, AUTO_STATE_FILE), '{"schemaVersion":1,"leads":[]}\n');
  assert.equal((await dispatcher.preview(fakePaseo([marked, named]), id, second)).lead?.agentId, NAMED, 'damaged: by name alone');
  const look = await dispatcher.preview(fakePaseo([marked]), id, second);
  assert.deepEqual([look.lead, look.held], [null, 'settings'], 'damaged and no lead by name: held, as before');
});

// ---- the board: crown, status row, medal, fingerprint, settings lines ----
const card = (id, title, stageId, agentId, n, parentCardId) => ({ id, title, stageId, priority: 'normal', intent: 'requested', blocked: false,
  nextAction: '', agents: agentId ? 1 : 0, awaiting: null, agentIds: agentId ? [agentId] : [], completedAt: null, createdAt: minute(n), updatedAt: minute(n),
  ...(parentCardId ? { parentCardId } : {}) });
const stagesOf = cards => [{ stageId: 'todo', countsAsDone: false, cards: [] }, { stageId: 'doing', countsAsDone: false, cards }, { stageId: 'done', countsAsDone: true, cards: [] }];
const flat = stages => Object.fromEntries(stages.flatMap(s => s.cards).map(c => [c.id, c]));
const links = map => id => map[id];

test('REQ-137 the crown: the marked card (known or not yet listed), an English name, a topic lead\'s medal; a sub-card never', () => {
  const cards = [card('c-marked', 'Shop renewal plan', 'doing', MARKED, 1), card('c-named', 'Lead-03_shop_Fable', 'doing', NAMED, 2),
    card('c-plain', 'Photo batch', 'doing', PLAIN, 3), card('c-sub', 'Sub task', 'doing', CHILD, 4, 'c-plain')];
  const info = { [MARKED]: { title: 'Shop renewal plan' }, [NAMED]: { title: 'Lead-03_shop_Fable' }, [PLAIN]: { title: 'Photo batch' }, [CHILD]: { parentAgentId: PLAIN } };
  const marked = flat(linkStages(stagesOf(cards), links(info), MARKED));
  assert.deepEqual(marked['c-marked'].family, { total: 0, open: 0 }); assert.equal(marked['c-marked'].designated, true);
  assert.deepEqual(marked['c-named'].family, { total: 0, open: 0 }, 'an English name: a crown'); assert.equal(marked['c-named'].designated, undefined);
  assert.deepEqual(marked['c-plain'].family, { total: 1, open: 1 }, 'sub-cards: a crown, as REQ-119');
  assert.ok(marked['c-marked'].crew, 'the marked lead has the status row\'s crew (REQ-130·133)');
  const before = flat(linkStages(stagesOf(cards), undefined, MARKED));
  assert.equal(before['c-marked'].designated, true, 'before the agents are listed, the mark alone crowns it');
  const none = flat(linkStages(stagesOf(cards), links(info)));
  assert.equal(none['c-marked'].family, undefined, 'no mark: a plain card again');
  const sub = flat(linkStages(stagesOf(cards), links(info), CHILD));
  assert.equal(sub['c-sub'].designated, undefined, 'a sub-card is never crowned by a mark');
  const topic = flat(linkStages(stagesOf([card('c-t', 'T01_topic', 'doing', TOPIC, 1)]), links({ [TOPIC]: { role: 'topic-lead', parentAgentId: NAMED } }), TOPIC));
  assert.equal(topic['c-t'].designated, undefined, 'a topic lead keeps its medal, never the mark');
  assert.deepEqual(leadAgentIds([{ stages: stagesOf(cards), summary: { lead: MARKED } }], links(info)).includes(MARKED), true, 'its archive state is asked first (D35)');
});

test('REQ-137 the board read carries the mark and folds it into the fingerprint, so another screen notices a change', async t => {
  const { store, id } = await board(t);
  const b = await store.readBoard(id);
  const plain = toBoardDTO(b, 'en'), withMark = toBoardDTO(b, 'en', 'off', Date.now(), undefined, undefined, undefined, null, MARKED);
  assert.equal(plain.summary.lead, undefined); assert.equal(withMark.summary.lead, MARKED);
  assert.equal(plain.summary.groups, undefined);
  assert.equal(withMark.summary.groups, groupsKey(undefined, MARKED));
  assert.notEqual(groupsKey(undefined, MARKED), groupsKey(undefined, NAMED));
  const parents = new Map([['c1', 'c0']]);
  assert.notEqual(groupsKey(parents, MARKED), groupsKey(parents), 'with sub-cards too');
  assert.equal(groupsKey(parents, null), groupsKey(parents), 'no mark: the fingerprint as before');
});

test('REQ-137 the card menu row: mark, move (names the current lead), unmark, faded for a sub-chat, a topic lead or no chat', () => {
  const view = (lead, cards) => ({ summary: { id: 'board_x', cwd: '/tmp/sample-shop', ...(lead ? { lead } : {}) }, stages: [{ stageId: 'doing', cards }] });
  const cards = [card('c-m', 'Shop renewal plan', 'doing', MARKED, 1), card('c-p', 'Photo batch', 'doing', PLAIN, 2),
    card('c-s', 'Sub', 'doing', CHILD, 3, 'c-p'), card('c-n', 'No chat', 'doing', null, 4), card('c-t', 'Topic', 'doing', TOPIC, 5)];
  const info = links({ [TOPIC]: { role: '주제총괄' } }), pressed = [];
  const row = (lead, id, m = ko) => leadMenu(view(lead, cards), cards.find(c => c.id === id), m, info, v => pressed.push(v));
  assert.deepEqual([row(null, 'c-p').state, row(null, 'c-p').help], ['mark', 'sample-shop의 총괄 — 초안이 이 채팅으로 갑니다']);
  assert.deepEqual([row(MARKED, 'c-p', en).state, row(MARKED, 'c-p', en).help], ['mark', 'Replaces Shop renewal plan as the lead — drafts go to this chat']);
  assert.equal(row(MARKED, 'c-m').state, 'unmark');
  assert.equal(row(null, 'c-s').state, 'blocked'); assert.equal(row(null, 'c-s', en).help, 'A sub-chat cannot be marked as the lead');
  assert.equal(row(null, 'c-t').state, 'blocked', 'a topic lead by its role');
  assert.equal(row(null, 'c-n').state, 'none');
  row(MARKED, 'c-m').onPress(false); assert.deepEqual(pressed, [false]);
});

test('REQ-137 the settings\' read-only lines: set / archived / by name / sub-cards / none, ko and en', () => {
  const view = (cwd, lead, cards) => ({ summary: { workspaceId: 'wks_' + cwd, cwd: '/tmp/' + cwd, ...(lead ? { lead } : {}) }, stages: stagesOf(cards) });
  const boards = [view('a-set', MARKED, [card('m', 'Shop renewal plan', 'doing', MARKED, 1)]),
    view('b-named', null, [card('n', 'Lead-03_shop_Fable', 'doing', NAMED, 1), card('p', 'Plain', 'doing', PLAIN, 2)]),
    view('c-family', null, [card('p', 'Photo batch', 'doing', PLAIN, 1), card('s', 'Sub', 'doing', CHILD, 2, 'p')]),
    view('d-none', null, [card('p', 'Plain', 'doing', PLAIN, 1)]),
    view('e-gone', MARKED, [card('m', 'Shop renewal plan', 'doing', MARKED, 1)])];
  const info = links({ [MARKED]: { title: 'Shop renewal plan' }, [NAMED]: { title: 'Lead-03_shop_Fable' }, [PLAIN]: { title: 'Plain' }, [CHILD]: { parentAgentId: PLAIN } });
  const archived = idOf => idOf === MARKED && archivedNow;
  let archivedNow = false;
  const lines = m => workspaceLeadEntries(boards, {}, info, archived, m).map(l => l.text);
  assert.deepEqual(lines(ko), ['Shop renewal plan · 직접 지정', 'Lead-03 · 이름 규칙', 'Photo batch · 하위 카드 있음', '없음 — 초안은 가장 최근 최상위 채팅으로', 'Shop renewal plan · 직접 지정']);
  assert.deepEqual(lines(en), ['Shop renewal plan · set by you', 'Lead-03 · by name', 'Photo batch · has sub-cards', 'None — drafts go to the newest top-level chat', 'Shop renewal plan · set by you']);
  archivedNow = true;
  assert.equal(lines(en)[0], 'Shop renewal plan · set by you, archived — next rule for now');
  assert.equal(boardLead(boards[1], info).kind, 'name');
  assert.equal(boardLead({ stages: stagesOf([]), summary: { lead: MARKED } }, info).name, 'Shop renewal plan', 'a mark whose card is not here: the agent\'s title');
});

test('REQ-137 the words: the held request quotes the real prefixes; every new key in both languages', () => {
  for (const held of ['beforeFloor', 'targetGone']) {
    assert.match(en.dispatchHeld(held), /"Lead-…" \(or "총괄-…"\), or one marked as lead/);
    assert.match(ko.dispatchHeld(held), /‘총괄-’\(또는 ‘Lead-’\)로 시작하거나 총괄로 표시한 채팅/);
  }
  assert.match(en.dispatchHeld('settings'), /nor to a chat marked as lead/, 'damaged: the mark is not known, said so');
  for (const key of ['leadSetByYou', 'markLead', 'unmarkLead', 'unmarkLeadHelp', 'markLeadBlocked', 'markLeadNoChat', 'leadUnmarked', 'leadMarkFailed',
    'leadStatusTitle', 'leadStatusHelp', 'leadStatusNone']) { assert.equal(typeof en[key], 'string', key); assert.equal(typeof ko[key], 'string', key); assert.notEqual(en[key], ko[key], key); }
  assert.equal(en.markLead, 'Mark as lead'); assert.equal(ko.markLead, '총괄로 표시'); assert.equal(ko.unmarkLead, '총괄 표시 해제');
});
