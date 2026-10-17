// D53: the gate-356 history + count chips, and real files that the reader turns into three completed loops.
import { builtinDefinition, BUILTIN_WORKFLOWS } from '../../dist/shared/workflow-templates.js';
import { readWorkflow } from '../../dist/server/workflow.js';
import { writeWorkspace } from './workflow-fixtures.mjs';

export function d53History(base, counts = true) {
  const model = structuredClone(base), walk = [];
  let doc = 301;
  for (const e of model.definition.edges.filter(e => e.back)) {
    walk.push({ stage: e.to, doc: doc++, round: 'first', verdict: 'fail' });
    for (let i = 0; i < 3; i++) walk.push({ stage: e.from, doc: doc++ }, { stage: e.to, doc: doc++, round: 'again', verdict: i === 2 ? 'pass' : 'fail' });
  }
  model.releases = [{ release: '0.2.1', reqs: [], firstVerdict: 'fail', finalVerdict: 'pass', regates: 3, warnings: [], path: walk,
    cells: model.definition.stages.map(s => ({ stage: s.id, state: s.shape === 'diamond' ? 'decision' : 'no-record', events: [] })) }];
  // No release-cell notes. The full screen can still add source notes; d53-flow.mjs tests the bare component directly.
  if (!counts) model.releases[0].cells = [];
  if (counts) model.totals = model.definition.stages.filter(s => s.shape !== 'diamond').map(s => ({ stage: s.id,
    window: { count: 12, pass: 10, fail: 1, conditional: 1, unknown: 0 }, all: { count: 12, pass: 10, fail: 1, conditional: 1, unknown: 0 } }));
  model.key += '-d53';
  return model;
}

export async function d53Reading(dir, id, locale, single = false) {
  const def = builtinDefinition(BUILTIN_WORKFLOWS.find(t => t.id === id), locale);
  const loops = def.edges.filter(e => e.back).slice(0, single ? 1 : undefined), targets = new Set(loops.map(e => e.to));
  delete def.note;
  def.sources = def.stages.flatMap(s => targets.has(s.id) ? ['first', 'again'].map(round => ({ stage: s.id, read: 'verdict', round,
    files: [s.id + '/*_' + round + '.md'], markers: ['Verdict'], words: { pass: ['PASS'], fail: ['FAIL'], conditional: ['CONDITIONAL'] }, release: 'name-version' }))
    : [{ stage: s.id, read: 'names', files: [s.id + '/*.md'], release: 'name-version' }]);
  const files = {}, touched = new Set();
  let doc = 301;
  const put = (stage, round, word) => { const n = doc++; files[`${stage}/${n}_v0201_${round}.md`] = `# ${n} release 0.2.1\n\nVerdict: ${word}\n`; };
  for (const e of loops) {
    touched.add(e.from); touched.add(e.to); put(e.to, 'first', 'FAIL');
    for (let i = 0; i < 3; i++) { put(e.from, 'name', ''); put(e.to, 'again', i === 2 ? 'PASS' : 'FAIL'); }
  }
  for (const s of def.stages) if (!touched.has(s.id)) put(s.id, 'name', '');
  return readWorkflow(await writeWorkspace(dir, def, files), { now: () => new Date('2026-10-15T05:30:00Z') });
}
