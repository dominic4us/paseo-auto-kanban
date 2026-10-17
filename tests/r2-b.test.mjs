import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isOrphanedCard, countOrphanedCards, hasSignalIcon, signalBucket } from '../dist/client/signal-model.js';
import { boardHeaderWidth } from '../dist/client/layout.js';
import { swimlaneModel, swimlaneWidth } from '../dist/client/swimlane-model.js';
import { createDemoData, demoArchived } from '../dist/client/demo.js';
import { copy, displayStageNames } from '../dist/client/i18n.js';
import { createReadHandlers } from '../dist/server/handlers.js';
import { overviewGet, boardGet } from '../dist/shared/rpc.js';
import { openStore } from '../dist/server/core/index.js';
import { fixture, request, add } from './helpers.mjs';

test('R2-B quiet glyph policy and positive archival evidence distinguish orphaned from unknown/done/unassigned', () => {
  const archived = id => ['a', 'b'].includes(id);
  assert.equal(isOrphanedCard(['a', 'b', 'a'], false, archived), true);
  for (const [ids, done] of [[[], false], [['a','unknown'],false], [['a'],true]]) assert.equal(isOrphanedCard(ids, done, archived), false);
  assert.equal(countOrphanedCards([{ countsAsDone:false, cards:[{agentIds:['a']},{agentIds:['a','unknown']}] },
    {countsAsDone:true,cards:[{agentIds:['a']}]}],archived),1);
  assert.deepEqual(['error','orphaned','permission','working','attention','idle','unknown'].filter(hasSignalIcon),
    ['error','orphaned','permission','working','attention']);
  assert.equal(signalBucket({status:'error',archivedAt:'2026-01-01'}),'idle');
});
// REQ-74 ④ retired `modelLabel` ("Astra (high)"): the detail names a model as the card does (req73 `modelShortName`).
test('R2-B wide row width equals indent plus four columns, clamped to the padded viewport', () => {
  // REQ-60: the indent is now 24, so the shared right edge moves out by the same 8px.
  assert.equal(swimlaneWidth(),24+4*280+3*8);
  assert.deepEqual([1900,1400,1100,900,0].map(w=>boardHeaderWidth(w,swimlaneWidth())),[1168,1168,1068,868,0]);
});
test('R2-B demo has exactly one orphaned card, included once in attention/filter/collapsed project totals', () => {
  const demo=createDemoData('en'), archived=id=>demoArchived.includes(id);
  const cards=demo.boards.flatMap(b=>b.stages.flatMap(s=>s.cards.filter(c=>isOrphanedCard(c.agentIds,s.countsAsDone,archived))));
  assert.equal(cards.length,1);
  const orphaned=new Set(cards.map(c=>c.id));
  const model=swimlaneModel(demo.boards,demo.directory,[],true,{}, {orphaned,projects:{demo_project_0:true}});
  assert.ok(model.groups.flatMap(g=>g.lanes).some(l=>l.board.stages.some(s=>s.cards.some(c=>orphaned.has(c.id)))));
  const plain=swimlaneModel(demo.boards,demo.directory,[],false);
  const combined=swimlaneModel(demo.boards,demo.directory,[],false,{}, {orphaned});
  // The demo orphan already awaits the user: union, not sum.
  assert.equal(combined.attention,plain.attention);
  assert.equal(copy('en').waitingStage,'To Do'); assert.equal(copy('ko').waitingStage,'대기');
});
test('R2-B overview/board/card about and English To Do fields use existing reads; stored templates stay intact', async t => {
  const {store,id}=await fixture(t);
  const added=await store.mutateBoard(id,request([add()]));
  const h=createReadHandlers(store), overview=await h.overview({includeBoards:true}), board=await h.board({boardId:id});
  overviewGet.output.parse(overview); boardGet.output.parse(board);
  const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(overview.data.about.version,pkg.version); assert.deepEqual(board.data.about,overview.data.about);
  assert.equal(displayStageNames(overview.data.boardViews[0], 'en').stages[0].name,'To Do');
  assert.equal(displayStageNames(board.data.board, 'en').stages[0].name,'To Do');
  const card=await h.card({boardId:id,cardId:added.data.cardIds[0]});
  assert.equal(displayStageNames(card.data, 'en').template.stages[0].name,'To Do');
  const custom={template:{id:'custom',version:1,stages:[{stageId:'todo',name:'Waiting'}]}};
  assert.equal(displayStageNames(custom,'en'),custom);
  assert.equal((await store.readBoard(id)).template.stages[0].name,'Waiting','stored core template remains untouched');
});
test('R2-B → REQ-141 W1: a new install (no config) reads en, a config with no locale keeps ko, an explicit en stays, nothing written', async t => {
  const root=await fs.mkdtemp(join(tmpdir(),'kanban-r2b-locale-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=await openStore({dataDir:join(root,'data')}), h=createReadHandlers(store);
  assert.equal((await h.overview({})).data.locale,'en');
  await assert.rejects(fs.stat(join(root,'data','config.json')),e=>e.code==='ENOENT');
  await fs.mkdir(store.dataDir,{recursive:true});
  const config=join(store.dataDir,'config.json'), base={schemaVersion:1,exportEnabled:true,export:{detail:'compact'}};
  await fs.writeFile(config,JSON.stringify(base)); const before=await fs.readFile(config,'utf8');
  assert.equal((await h.overview({})).data.locale,'ko'); assert.equal(await fs.readFile(config,'utf8'),before);
  await fs.writeFile(config,JSON.stringify({...base,locale:'en'})); assert.equal((await h.overview({})).data.locale,'en');
});
test('R2-B build metadata takes version from package and optional release from a matching release record', async t => {
  const root=await fs.mkdtemp(join(tmpdir(),'kanban-r2b-version-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(join(root,'scripts')); await fs.mkdir(join(root,'server'));
  await fs.copyFile(new URL('../scripts/sync-server-version.mjs',import.meta.url),join(root,'scripts','sync-server-version.mjs'));
  await fs.writeFile(join(root,'package.json'),JSON.stringify({version:'0.1.2',type:'module'}));
  const run=()=>spawnSync(process.execPath,[join(root,'scripts','sync-server-version.mjs')],{encoding:'utf8'});
  assert.equal(run().status,0); assert.match(await fs.readFile(join(root,'server','version.ts'),'utf8'),/BUILD_RELEASE: string \| undefined = undefined/);
  await fs.writeFile(join(root,'release.json'),JSON.stringify({version:'0.1.2',release:'6ac9a9c',date:'2026-09-22'}));
  assert.equal(run().status,0); assert.match(await fs.readFile(join(root,'server','version.ts'),'utf8'),/BUILD_RELEASE: string \| undefined = "6ac9a9c"/);
  await fs.writeFile(join(root,'package.json'),JSON.stringify({version:'0.1.3',type:'module'})); assert.notEqual(run().status,0,'stale release fails the build');
});
