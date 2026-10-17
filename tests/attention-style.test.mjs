import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { needsHuman, boardView, renderProcess, applyOperations } from '../dist/shared/core/domain.js';
import { exportCommittedBoard } from '../dist/server/core/export.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { toBoardDTO } from '../dist/server/read-model.js';
import { laneModel } from '../dist/client/swimlane-model.js';
import { panelTokens, cardDecoration, lanePanelHeight } from '../dist/client/panel-style.js';
import { palette, contrast, luminance } from '../dist/client/palette.js';
import { firstCardY, mobileControls } from '../dist/client/mobile-layout.js';
import { fixture, request, add, board, actor, context } from './helpers.mjs';

test('REQ-18 uses template completion flags, not reserved stage names, and preserves signals', () => {
  const b = applyOperations(board(), [{ ...add(), awaiting: 'user' }], actor, context()).board;
  const c = b.cards[0];
  const stages = [{ stageId: 'todo', countsAsDone: true }, { stageId: 'done', countsAsDone: false }];
  for (const signal of [{ awaiting: 'user' }, { blockedReason: 'Needs input' }, { intent: 'draft' }]) {
    const before = { ...c, awaiting: null, blockedReason: null, ...signal };
    assert.equal(needsHuman(before, stages), false);
    assert.equal(needsHuman({ ...before, stageId: 'done' }, stages), true);
    assert.equal(needsHuman({ ...before, stageId: 'done', archivedAt: c.createdAt }, stages), false);
    assert.deepEqual(before, { ...c, awaiting: null, blockedReason: null, ...signal });
  }
});
test('REQ-18 core, actual CLI, exported PROCESS and overview count the same active human requests without read-time writes', async t => {
  const f = await fixture(t, { afterCommit: exportCommittedBoard });
  await f.store.mutateBoard(f.id, request([
    { ...add('Active response'), awaiting: 'user' },
    { ...add('Finished response'), awaiting: 'user', stageId: 'done' },
    { ...add('Agent signal'), awaiting: 'agent', stageId: 'done' },
  ]));
  const file = join(f.store.dataDir, 'boards', f.id + '.json');
  const original = await readFile(file), before = await stat(file);
  const env = { ...process.env }; delete env.PASEO_AGENT_CWD; delete env.PASEO_AGENT_ID; delete env.KANBAN_DATA_DIR;
  const run = (...args) => {
    const r = spawnSync(process.execPath, [resolve('dist/src/cli/main.js'), ...args, '--data-dir', f.store.dataDir],
      { cwd: f.cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const cli = JSON.parse(run('ls', '--all', '--json'));
  assert.equal(cli.data.needsHuman.length, 1); assert.equal(cli.data.needsHuman[0].title, 'Active response');
  const human = run('ls', '--all');
  assert.match(human, /Needs human/); assert.match(human, /Active response/); assert.doesNotMatch(human, /Finished response/);
  const overview = await createReadHandlers(f.store).overview({ includeBoards: true });
  assert.equal(overview.ok, true); assert.equal(overview.data.boards[0].needsHuman, 1); assert.equal(overview.data.attention.length, 1);
  const b = JSON.parse(original); assert.equal(boardView(b).needsHuman.length, 1);
  assert.equal(laneModel(toBoardDTO(b), {}, true).attention, 1);
  const processText = await readFile(join(f.cwd, 'PROCESS.md'), 'utf8');
  assert.equal((processText.match(/Awaiting: User/g) ?? []).length, 1);
  assert.match(processText, /\[x\] Finished response/);
  assert.match(processText.split('\n').find(l => l.includes('Agent signal')), /Awaiting: Agent/);
  assert.doesNotMatch(processText.split('\n').find(l => l.includes('Finished response')), /Awaiting:/);
  for (const locale of ['en', 'ko']) for (const detail of ['compact', 'full']) {
    const text = renderProcess(b, locale, detail);
    assert.doesNotMatch(text.split('\n').find(l => l.includes('Finished response')), /Awaiting:|기다림:/);
  }
  assert.equal(b.cards.find(c => c.title === 'Finished response').awaiting, 'user');
  assert.deepEqual(await readFile(file), original); assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});
test('D6 surfaces keep a brighter card with at least 1.15 contrast and decorative outer shadows', () => {
  for (const surfaces of [['#ffffff', '#fafafa', '#f3f3f3'], ['#181b1a', '#1e2120', '#252927']]) {
    const colors = palette({ colors: { surface0: surfaces[0], surface1: surfaces[1], surface2: surfaces[2],
      accent: '#557755', statusWarning: '#e0a000', statusDanger: '#cc4455', border: '#777777' } });
    assert.deepEqual(panelTokens(colors), { panel: colors.panel, card: colors.card });
    assert.ok(luminance(colors.card) > luminance(colors.panel));
    assert.ok(contrast(colors.card, colors.panel) >= 1.15);
    const shadow = cardDecoration(colors);
    assert.equal(shadow.backgroundColor, colors.card); assert.equal(shadow.elevation, 2);
    assert.ok(shadow.shadowOpacity > 0); assert.equal(shadow.overflow, undefined);
  }
});
test('lane panels share the tallest content budget including extra actions; empty cells remain measurable', () => {
  const short = { nextAction: '' }, tall = { nextAction: 'Review' };
  const cells = [{ cards: [short], remaining: 0 }, { cards: [short, tall, short], remaining: 2 },
    { cards: [], remaining: 0 }, { cards: [tall], remaining: 0 }];
  assert.equal(lanePanelHeight(cells), 36 + 16 + 84 + 104 + 84 + 16 + 38);
  assert.equal(lanePanelHeight([{ cards: [], remaining: 0 }]), 52);
  assert.equal(lanePanelHeight(cells.toReversed()), lanePanelHeight(cells));
});
test('D4 includes the extra host tab header and keeps panel actions/tabs at disjoint 44px targets', () => {
  assert.equal(firstCardY('panel'), 149); assert.equal(firstCardY('board'), 156); assert.equal(firstCardY('surface'), 168);
  for (const width of [360, 390, 430, 759]) {
    // REQ-71: tabs, then a divider and the 76px chip, then the panel's 44px actions.
    const controls = mobileControls(width, 4, 76, 44);
    assert.equal(controls.contentWidth, width - 16); assert.ok(controls.tabWidth >= 44);
    assert.equal(controls.tabWidth * 4 + 4 + 1 + 4 + 76 + 48, controls.contentWidth);
    assert.ok(firstCardY('panel') <= 170);
  }
});
