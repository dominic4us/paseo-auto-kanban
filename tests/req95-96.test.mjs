// REQ-95 (the owner's own choice after research/147, replacing REQ-94's state-coloured edge): a lead card (one with sub-cards)
// is outlined in its stage's colour, carries a crown, sits first in its column whatever the order, and shows only the
// head of an automatic title; an awaited answer turns the stripe (and a lead's edge) orange on every card; the card just
// looked at is tinted grey. REQ-96: "Go to agent ↗" and "Response needed" lead to the agent. The screens are exercised in
// plugin-ui.test.mjs ("REQ-95"/"REQ-96") and tests/web/run.mjs (real input).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBoardDTO } from '../dist/server/read-model.js';
import { cardParents } from '../dist/server/card-parents.js';
import { applyOperations } from '../dist/shared/core/domain.js';
import { laneModel } from '../dist/client/swimlane-model.js';
import { mobileSwimlaneModel } from '../dist/client/mobile-model.js';
import { compareCards, sortCards, CARD_ORDERS } from '../dist/client/card-order.js';
import { leadTitle } from '../dist/client/card-groups.js';
import { isArchivedLead } from '../dist/client/signal-model.js';
import { stageColor } from '../dist/client/stage-color.js';
import { jumpFor } from '../dist/client/agent-jump.js';
import { CROWN_FILLED_PNG } from '../dist/client/leader-icons.js';
import { PASEO_THEMES, contrast, crownColor, luminance, markLine, palette, replyColor, resolveTheme, rgb, selectedTint, viewedTint,
  VIEWED_CONTRAST } from '../dist/client/palette.js';
import { board, add, context, actor } from './helpers.mjs';

const WORKSPACE = 'wks_example01';
const LEAD = '00000000-0000-4000-8000-0000000000b1', W1 = '00000000-0000-4000-8000-0000000000c1';
const T = minute => `2026-09-26T0${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
const directory = { [WORKSPACE]: { id: WORKSPACE, name: 'Example Workspace', projectId: 'prj_example01', projectName: 'Example Project' } };
const titles = cards => cards.map(c => c.title);

/** Four plain cards in review around the lead card (made third, low priority), and its sub-card at work. */
function sample() {
  let value = board(), minute = 1;
  const make = (title, stageId, extra = {}, agentId) => {
    value = applyOperations(value, [{ ...add(title), stageId, ...extra }], actor, context(T(minute++))).board;
    const id = value.cards.at(-1).id;
    if (agentId) value = applyOperations(value, [{ op: 'link', id, agentId }], actor, context(T(minute++))).board;
    return id;
  };
  make('Old high', 'review', { priority: 'high' }); make('Old normal', 'review');
  make('총괄-03_example-app_Opus', 'review', { priority: 'low' }, LEAD);
  make('New normal', 'review'); make('Newest high', 'review', { priority: 'high' });
  make('Worker', 'doing', {}, W1);
  const parents = { [W1]: { parentAgentId: LEAD, at: T(0) } };
  return toBoardDTO(value, 'en', 'off', Date.now(), cardParents(value, { agents: {}, parents }));
}
/** The same five cards and lead, in "done" (a completion column) instead of "review". */
function doneSample() {
  let value = board(), minute = 1;
  const make = (title, stageId, extra = {}, agentId) => {
    value = applyOperations(value, [{ ...add(title), stageId, ...extra }], actor, context(T(minute++))).board;
    const id = value.cards.at(-1).id;
    if (agentId) value = applyOperations(value, [{ op: 'link', id, agentId }], actor, context(T(minute++))).board;
    return id;
  };
  make('Old high', 'done', { priority: 'high' }); make('Old normal', 'done');
  make('총괄-03_example-app_Opus', 'done', { priority: 'low' }, LEAD);
  make('New normal', 'done'); make('Newest high', 'done', { priority: 'high' });
  make('Worker', 'doing', {}, W1);
  const parents = { [W1]: { parentAgentId: LEAD, at: T(0) } };
  return toBoardDTO(value, 'en', 'off', Date.now(), cardParents(value, { agents: {}, parents }));
}
const cellOf = (lane, id) => lane.cells.find(c => c.stageId === id);

test('REQ-95 ⑤ a lead card is first in its column in every order, before the preview and "+N" cut it; the rest keep the order', () => {
  const dto = sample();
  const expected = {
    default: ['총괄-03_example-app_Opus', 'Old high', 'Newest high', 'Old normal', 'New normal'],
    updated: ['총괄-03_example-app_Opus', 'Newest high', 'New normal', 'Old normal', 'Old high'],
    created: ['총괄-03_example-app_Opus', 'Newest high', 'New normal', 'Old normal', 'Old high'],
  };
  for (const order of CARD_ORDERS) {
    const cell = cellOf(laneModel(dto, {}, false, '', new Set(), order), 'review');
    assert.deepEqual(titles(cell.matching), expected[order], order);
    assert.deepEqual(titles(cell.cards), expected[order].slice(0, 3), order + ': the preview keeps the lead');
    assert.equal(cell.remaining, 2);
    // The phone's list of the same stage.
    const phone = mobileSwimlaneModel([dto], directory, [], false, {}, 'review', { cardOrder: order });
    assert.equal(phone.sections[0].cell.cards[0].title, '총괄-03_example-app_Opus', order + ' on a phone');
  }
  // Without families (the ledger's own cards), the order is exactly REQ-79's.
  const plain = [{ id: 'a', priority: 'low', createdAt: T(1) }, { id: 'b', priority: 'high', createdAt: T(2) }];
  assert.deepEqual(sortCards(plain, 'default').map(c => c.id), ['b', 'a']);
  assert.deepEqual(sortCards([...plain, { id: 'c', priority: 'low', createdAt: T(0), family: { total: 1, open: 1 } }], 'default').map(c => c.id), ['c', 'b', 'a']);
  assert.ok(compareCards('updated')({ id: 'x', priority: 'low', family: {} }, { id: 'y', priority: 'high', updatedAt: T(9) }) < 0);
});

test('REQ-102 an archived lead keeps its place first everywhere but a completion column, where the column\'s own order takes over', () => {
  const archived = id => id === LEAD;
  // "done" counts as complete: an archived lead there falls back to "updated" (newest changed first), no different from a plain card.
  const done = cellOf(laneModel(doneSample(), {}, false, '', new Set(), 'updated', archived), 'done');
  assert.deepEqual(titles(done.matching), ['Newest high', 'New normal', '총괄-03_example-app_Opus', 'Old normal', 'Old high'],
    'the archived lead in "done" sorts by its own updatedAt, not first');
  // The same "done" column, but nobody archived: the lead still leads.
  const doneLive = cellOf(laneModel(doneSample(), {}, false, '', new Set(), 'updated'), 'done');
  assert.equal(doneLive.matching[0].title, '총괄-03_example-app_Opus', 'an unarchived lead still leads a completion column');
  // "review" is not a completion column: an archived lead there still leads, same as REQ-95 ⑤.
  const review = cellOf(laneModel(sample(), {}, false, '', new Set(), 'updated', archived), 'review');
  assert.equal(review.matching[0].title, '총괄-03_example-app_Opus', 'an archived lead still leads outside a completion column');
});

test('REQ-95 ⑥ a lead card shows the head of an automatic title "<head>_<workspace>_<model>"; any other shape stays whole', () => {
  assert.equal(leadTitle('총괄-03_sample-app_Opus'), '총괄-03');
  assert.equal(leadTitle('총괄-5_sample-tool_Opus-5.5'), '총괄-5');
  assert.equal(leadTitle('Lead_my_folder_Opus'), 'Lead', 'a folder with "_" in it');
  for (const title of ['Lead card', 'fix_login', '_sample-app_Opus', '총괄-03__Opus', '총괄-03_sample-app_']) assert.equal(leadTitle(title), title);
});

test('REQ-95 ①③④ the stage edge, the reply orange and the grey tint stand apart in all four theme choices, light and dark', () => {
  const stages = [{ stageId: 'todo', countsAsDone: false }, { stageId: 'doing', countsAsDone: false },
    { stageId: 'review', countsAsDone: false }, { stageId: 'done', countsAsDone: true }];
  for (const host of ['light', 'dark']) for (const choice of ['paseo', 'system', 'light', 'dark']) for (const system of ['light', 'dark', null]) {
    const c = palette(resolveTheme(PASEO_THEMES[host], choice, system)), label = `${host}/${choice}/${system}`;
    const tint = viewedTint(c, c.card);
    // ④: grey — no hue of its own beyond the theme's text and card — and a visible step from the card.
    const [r, g, b] = rgb(tint);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, label + ' grey tint ' + tint);
    assert.ok(contrast(tint, c.card) >= VIEWED_CONTRAST, label + ' tint step ' + contrast(tint, c.card));
    // J4 (research/149): 1.13 read too faint; 1.25–1.35 from the card now.
    assert.ok(contrast(tint, c.card) >= 1.25 && contrast(tint, c.card) <= 1.35, label + ' tint step in 1.25–1.35: ' + contrast(tint, c.card));
    assert.notEqual(tint, selectedTint(c, c.card), label + ' not the main colour\'s tint');
    const lines = new Set();
    for (const face of [c.card, tint]) {
      for (const stage of stages) {
        const line = markLine(stageColor(stage.stageId, stages, c), c, face);
        assert.ok(contrast(line, face) >= 3 && contrast(line, c.panel) >= 3, `${label} ${stage.stageId} edge on ${face}: ${contrast(line, face)}`);
        if (face === c.card) lines.add(line);
      }
      const orange = markLine(replyColor(c), c, face);
      assert.ok(contrast(orange, face) >= 3 && contrast(orange, c.panel) >= 3, `${label} reply on ${face}: ${contrast(orange, face)}`);
      if (face === c.card) assert.ok(![...lines].includes(orange), label + ' orange is none of the stage colours');
    }
    // ①: the stage colours stay apart — waiting grey, in progress blue, review purple, done green.
    assert.equal(lines.size, 4, label + ' four stage edges');
  }
  // The stripe's own token where it already stands 3:1 (light: in progress keeps the stripe's blue).
  const light = palette(PASEO_THEMES.light);
  assert.equal(markLine(light.stageBlue, light, light.card), light.stageBlue);
  assert.ok((luminance(viewedTint(light, light.card)) ?? 1) < (luminance(light.card) ?? 0), 'light: a step darker');
  const dark = palette(PASEO_THEMES.dark);
  assert.ok((luminance(viewedTint(dark, dark.card)) ?? 0) > (luminance(dark.card) ?? 1), 'dark: a step lighter');
});

test('REQ-98 isArchivedLead: every linked agent archived, whatever the card\'s stage — unlike isOrphanedCard, a done card counts too', () => {
  const archived = new Set(['a1', 'a2']);
  const isArchived = id => archived.has(id);
  assert.equal(isArchivedLead(['a1'], isArchived), true);
  assert.equal(isArchivedLead(['a1', 'a2'], isArchived), true, 'every linked agent, not just one');
  assert.equal(isArchivedLead(['a1', 'a3'], isArchived), false, 'one still around');
  assert.equal(isArchivedLead([], isArchived), false, 'no agent ever linked');
  assert.equal(isArchivedLead([''], isArchived), false, 'an empty id links nobody');
  assert.equal(isArchivedLead(['a3'], isArchived), false);
});

test('REQ-98 an archived lead\'s edge is the backlog stage\'s own grey token, apart from every other stage\'s edge and the reply orange', () => {
  const stages = [{ stageId: 'todo', countsAsDone: false }, { stageId: 'doing', countsAsDone: false },
    { stageId: 'review', countsAsDone: false }, { stageId: 'done', countsAsDone: true }];
  for (const host of ['light', 'dark']) for (const choice of ['paseo', 'system', 'light', 'dark']) for (const system of ['light', 'dark', null]) {
    const c = palette(resolveTheme(PASEO_THEMES[host], choice, system)), label = `${host}/${choice}/${system}`;
    // The archived grey reuses the backlog stage's own token (`foregroundMuted`, "대기" grey) — no new colour.
    const archivedEdge = markLine(c.foregroundMuted, c, c.card);
    assert.equal(archivedEdge, markLine(stageColor('todo', stages, c), c, c.card), label + ' the backlog stage\'s own edge');
    // It stands 3:1 on the card and the column, same bar every stage edge already clears.
    assert.ok(contrast(archivedEdge, c.card) >= 3 && contrast(archivedEdge, c.panel) >= 3, label + ' archived edge contrast');
    // Apart from the review/doing/done edges of a card in that stage (an archived lead in "완료" no longer reads green).
    for (const stage of stages.filter(s => s.stageId !== 'todo')) {
      assert.notEqual(archivedEdge, markLine(stageColor(stage.stageId, stages, c), c, c.card), `${label} apart from ${stage.stageId}`);
    }
    // "Response needed" still wins over the archived grey (REQ-95 ③'s rule applies to every card, a lead included).
    const orange = markLine(replyColor(c), c, c.card);
    assert.notEqual(archivedEdge, orange, label + ' apart from the reply orange');
  }
});

test('REQ-100 a lead\'s crown is a fixed deep gold at 3:1 on its face; an archived lead\'s is a filled crown a tone under research/153 A\'s archived gold', () => {
  const hue = value => { const [r, g, b] = rgb(value).map(n => n / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    const h = max === r ? (g - b) / d % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l }; };
  // research/153: B's line gold, and A's archived gold (the owner: one tone further down than that).
  const want = { light: { line: '#bb8e14', a: '#a09474' }, dark: { line: '#F2C230', a: '#8c8161' } };
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), gold = crownColor(c, c.card), out = crownColor(c, c.card, true);
    assert.equal(gold, want[mode].line, mode + ' the line crown\'s gold');
    assert.ok(contrast(gold, c.card) >= 3, mode + ' 3:1 on the card');
    assert.equal(out, c.crownArchived, mode + ' the archived token, as is');
    const a = hue(want[mode].a), x = hue(out);
    assert.ok(Math.abs(x.h - a.h) <= 3, `${mode} the same hue (${x.h} vs ${a.h})`);
    assert.ok(Math.abs(x.s / a.s - .7) <= .05, `${mode} ×0.7 saturation (${x.s / a.s})`);
    assert.ok(contrast(out, c.card) < contrast(want[mode].a, c.card) && contrast(out, c.card) >= 2.2,
      `${mode} a step toward the face, still seen (${contrast(out, c.card)})`);
    assert.ok(mode === 'light' ? x.l > a.l : x.l < a.l, mode + ' lighter on light, darker on dark');
    // Not the stage colours nor the reply orange (REQ-95 ③): the crown is the one gold on the card.
    assert.ok(![c.stageBlue, c.stagePurple, c.stageDone, c.foregroundMuted, replyColor(c)].some(v => v.toLowerCase() === gold.toLowerCase()));
    // The card just looked at (tinted grey) still has its gold at 3:1.
    assert.ok(contrast(crownColor(c, viewedTint(c, c.card)), viewedTint(c, c.card)) >= 3, mode + ' on the looked-at tint');
  }
  // Every theme choice lands on one of the two sets, so the crown holds 3:1 there too.
  for (const host of ['light', 'dark']) for (const choice of ['paseo', 'system', 'light', 'dark']) for (const system of ['light', 'dark', null]) {
    const c = palette(resolveTheme(PASEO_THEMES[host], choice, system));
    assert.ok(contrast(crownColor(c, c.card), c.card) >= 3, `${host}/${choice}/${system}`);
  }
  // The filled crown is a 48px PNG, like the provider marks, tinted by the card.
  assert.match(CROWN_FILLED_PNG, /^data:image\/png;base64,iVBOR/);
  const png = Buffer.from(CROWN_FILLED_PNG.split(',')[1], 'base64');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [48, 48]);
});

test('REQ-96 "Go to agent" opens the agent, else the workspace, else nothing; a folder board or no navigation offers nothing', () => {
  const calls = [], navigation = { openAgent: input => calls.push(['agent', input]), openWorkspace: input => calls.push(['workspace', input]) };
  const board = { workspaceId: WORKSPACE, hasLedger: true };
  const agent = jumpFor(navigation, LEAD, board);
  assert.equal(agent.kind, 'agent'); agent.go();
  const workspace = jumpFor(navigation, undefined, board);
  assert.equal(workspace.kind, 'workspace'); workspace.go();
  assert.deepEqual(calls, [['agent', { agentId: LEAD }], ['workspace', { workspaceId: WORKSPACE }]]);
  assert.equal(jumpFor(navigation, undefined, { workspaceId: 'local_abc' }), null, 'a folder with no Paseo workspace');
  assert.equal(jumpFor(navigation, undefined, { workspaceId: WORKSPACE, hasLedger: false }), null, 'a board not made yet');
  assert.equal(jumpFor(navigation, undefined, undefined), null);
  assert.equal(jumpFor(undefined, LEAD, board), null, 'an older host without navigation');
});
