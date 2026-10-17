// The gate-356 760px component case: no parent-added source notes, exactly three rounds on every loop.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export async function d53FlowScenes(browser, out, check) {
  const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..'), dir = path.join(out, 'd53-component');
  fs.mkdirSync(dir, { recursive: true });
  await build({ stdin: { resolveDir: here, loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { FlowView, workflowWords } from '../../client/workflow.js';
    import { builtinDefinition, BUILTIN_WORKFLOWS } from '../../shared/workflow-templates.js';
    import { copy } from '../../client/i18n.js';
    import { palette, PASEO_THEMES } from '../../client/palette.js';
    const {lang, mode} = window.__FLOW_CASE__, definition = builtinDefinition(BUILTIN_WORKFLOWS.find(t => t.id === 'sales-b2b'), lang);
    const loops = new Map(definition.edges.flatMap((e, i) => e.back ? [[i, [{from:301,to:302}, {from:303,to:304}, {from:305,to:306}]]] : []));
    createRoot(document.getElementById('root')).render(<FlowView model={{defined:true, definition, totals:[], releases:[]}} width={760}
      colors={palette(PASEO_THEMES[mode])} overlay={{loops, notes:{}, passed:new Set(), hot:new Set(), states:{}}} counts={{}}
      noSource={new Set()} words={workflowWords(copy(lang))} maxColumn={undefined} />);
  ` }, bundle: true, format: 'iife', outfile: path.join(dir, 'page.js'), jsx: 'automatic', target: 'es2022', logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' }, nodePaths: [path.join(here, 'node_modules'), path.join(root, 'node_modules')],
    alias: { 'react-native': 'react-native-web', '@getpaseo/plugin/client/react-native': path.join(here, 'shims/plugin-react-native.tsx'),
      '@getpaseo/plugin/client': path.join(here, 'shims/plugin-client.tsx'), react: path.join(root, 'node_modules/react'), 'react-dom': path.join(here, 'node_modules/react-dom') },
    // Expose the component in this test bundle only. No product export or DOM override.
    plugins: [{ name: 'd53-flow-component', setup(b) { b.onLoad({ filter: /\/client\/workflow\.tsx$/ }, args => ({
      contents: fs.readFileSync(args.path, 'utf8') + '\nexport { FlowView };\n', loader: 'tsx', resolveDir: path.dirname(args.path) })); } }] });
  const results = [];
  for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) {
    const scene = `d53-component-760-${lang}-${mode}`, file = path.join(dir, scene + '.html');
    fs.writeFileSync(file, `<!doctype html><html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script>window.__FLOW_CASE__=${JSON.stringify({lang,mode})}</script><script src="page.js"></script></body></html>`);
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } }), p = await context.newPage(), errors = [];
    p.on('pageerror', e => errors.push(String(e)));
    try {
      await p.goto(pathToFileURL(file).href); await p.getByTestId('flow-canvas').waitFor(); await p.evaluate(() => document.fonts.ready);
      const geo = await p.getByTestId('flow-canvas').evaluate(el => {
        const rect = e => { const r = e.getBoundingClientRect(); return { l:r.left, r:r.right, t:r.top, b:r.bottom }; };
        const obstacles = [...el.querySelectorAll('[data-testid^="flow-node-"], [data-testid^="flow-count-"], [data-testid="flow-edge-label"]')].map(e => ({ id:e.dataset.testid, text:e.innerText, rect:rect(e) }));
        const loops = [...el.querySelectorAll('[data-testid="flow-loop-label"]')].map(e => ({ text:e.innerText, rect:rect(e), clipped:[...e.querySelectorAll('*')].some(n => n.scrollWidth > n.clientWidth + 1) })), canvas = rect(el), hits = [];
        for (const [i,l] of loops.entries()) for (const o of [...obstacles, ...loops.slice(i+1)]) {
          const w = Math.min(l.rect.r,o.rect.r)-Math.max(l.rect.l,o.rect.l), h = Math.min(l.rect.b,o.rect.b)-Math.max(l.rect.t,o.rect.t);
          if (w > 0 && h > 0) hits.push({ loop:l.text, other:o.text, w, h });
        }
        const forwardHits = [];
        for (const [i,a] of obstacles.entries()) for (const b of obstacles.slice(i+1)) {
          if (a.id !== 'flow-edge-label' && b.id !== 'flow-edge-label') continue;
          const w = Math.min(a.rect.r,b.rect.r)-Math.max(a.rect.l,b.rect.l), h = Math.min(a.rect.b,b.rect.b)-Math.max(a.rect.t,b.rect.t);
          if (w > 0 && h > 0) forwardHits.push({ a:a.text, b:b.text, w, h });
        }
        return { canvas, loops, hits, forwardHits, notes:el.querySelectorAll('[data-testid^="flow-note-"], [data-testid^="flow-count-"]').length,
          outside:[...loops, ...obstacles.filter(o => o.id === 'flow-edge-label')].filter(l => l.rect.l < canvas.l || l.rect.r > canvas.r || l.rect.t < canvas.t || l.rect.b > canvas.b) };
      });
      check(scene, 'D56 component forward border overlap is exactly zero', geo.forwardHits.length === 0, JSON.stringify(geo.forwardHits));
      check(scene, 'D53 exact bare fixture: two labels, no notes or counts', geo.loops.length === 2 && geo.notes === 0 && geo.loops.every(l => l.text.includes('301→302 · 303→304 · 305→306')), JSON.stringify(geo));
      check(scene, 'D53 component loop border overlap is exactly zero', geo.hits.length === 0, JSON.stringify(geo.hits));
      check(scene, 'D53 component labels inside canvas and uncut', geo.outside.length === 0 && geo.loops.every(l => !l.clipped), JSON.stringify(geo.outside));
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      results.push({ scene, ...geo, errors });
      await p.getByTestId('flow-canvas').screenshot({ path: path.join(dir, scene + '.png') });
    } finally { await context.close(); }
  }
  fs.writeFileSync(path.join(out, 'd53-component.json'), JSON.stringify(results, null, 2));
}
