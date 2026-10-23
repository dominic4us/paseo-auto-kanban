// Both Overview entry paths use the real screen. Explorer only resizes the registered panel.
import fs from 'node:fs';
import path from 'node:path';

export async function runScroll760({ browser, page, out, check, byId, copy }) {
  if (process.env.KANBAN_WEB_SCROLL760_PART === 'rapid474') return runRapid474({ browser, page, out, check, byId });
  const records = [];
  for (const surface of ['overview', 'explorer']) for (const lang of ['ko', 'en']) for (const [wide, narrow] of [[900, 759], [1200, 700]]) {
    const scene = `scroll760-${surface}-${lang}-${wide}-${narrow}`;
    const context = await browser.newContext({ viewport: { width: surface === 'explorer' ? 2200 : wide, height: 800 } });
    const p = await context.newPage(), errors = []; p.on('pageerror', e => errors.push(String(e)));
    const scroller = width => byId(width >= 760 ? 'swimlane-vertical' : 'mobile-workspace-sections');
    const ready = async width => {
      await p.waitForSelector(scroller(width));
      await p.waitForSelector(width >= 760 ? byId('swimlane-lane-section') : '[data-testid^="mobile-workspace-board_"]');
      await p.waitForTimeout(250);
    };
    const resize = async width => {
      if (surface === 'explorer') await p.evaluate(w => window.__panelWidth(w), width);
      else await p.setViewportSize({ width, height: 800 });
      await ready(width);
    };
    const position = width => p.locator(scroller(width)).evaluate(e => ({ y: e.scrollTop, max: Math.max(0, e.scrollHeight - e.clientHeight) }));
    const scroll = async (width, y) => {
      await p.locator(scroller(width)).evaluate((e, y) => (e.scrollTop = y), y);
      await p.waitForTimeout(180);
      return position(width);
    };
    try {
      await p.goto(page('dark', false, `scroll760-${lang}-${surface}-${wide}`)); await ready(wide);
      await p.locator(byId('board-search')).fill('Scroll');
      await p.waitForTimeout(150);
      const before = await scroll(wide, 440);
      check(scene, 'starts at 440px with enough content', Math.abs(before.y - 440) <= 1 && before.max > 1000, JSON.stringify(before));
      await resize(narrow);
      check(scene, 'new mobile layout starts at its own top', (await position(narrow)).y === 0);
      await p.locator(byId('mobile-tab-review')).click(); await p.waitForTimeout(150);
      const phone = await scroll(narrow, 270);
      await resize(wide);
      const after = await position(wide);
      check(scene, 'wide offset restored after layout swap', Math.abs(after.y - before.y) <= 1, JSON.stringify({ before, after }));
      check(scene, 'search/filter retained', await p.locator(byId('board-search')).inputValue() === 'Scroll');
      // Within one layout no remount or focus-taking is introduced.
      await p.locator(byId('board-search')).focus();
      await resize(wide === 900 ? 760 : 1000);
      check(scene, 'same-layout resize preserves keyboard focus', await p.locator(byId('board-search')).evaluate(e => e === document.activeElement));
      await resize(narrow);
      check(scene, 'mobile offset restored independently', Math.abs((await position(narrow)).y - phone.y) <= 1, JSON.stringify({ phone, now: await position(narrow) }));
      const mobileText = await p.locator(byId('mobile-swimlane-screen')).innerText();
      check(scene, 'selected Review tab retained', mobileText.includes(copy(lang).reviewStage) && mobileText.includes('review0') && !mobileText.includes('doing0'));
      await resize(wide);
      // Remove a workspace ABOVE the anchor while the wide layout is away. Pixel restoration alone leaves a different lane.
      const deep = await scroll(wide, 1100);
      const anchor = await p.locator(byId('swimlane-vertical')).evaluate(e => {
        const top = e.getBoundingClientRect().top;
        const lanes = [...e.querySelectorAll('[data-testid="swimlane-lane-section"]')];
        const lane = lanes.find(l => l.getBoundingClientRect().bottom > top + 1);
        return { name: lane.querySelector('[data-testid="lane-name"]').textContent, delta: lane.getBoundingClientRect().top - top };
      });
      await resize(narrow);
      await p.evaluate(() => { const o = window.__FIXTURE__.overview; o.boards = o.boards.slice(1); o.boardViews = o.boardViews.slice(1); });
      await resize(wide);
      const anchored = await p.locator(byId('swimlane-vertical')).evaluate((e, anchor) => {
        const lane = [...e.querySelectorAll('[data-testid="swimlane-lane-section"]')].find(l => l.querySelector('[data-testid="lane-name"]').textContent === anchor.name);
        return lane ? lane.getBoundingClientRect().top - e.getBoundingClientRect().top : null;
      }, anchor);
      check(scene, 'viewed workspace stays anchored when preceding content disappears', anchored !== null && Math.abs(anchored - anchor.delta) <= 1, JSON.stringify({ anchor, anchored, deep, after: await position(wide) }));
      await scroll(wide, 100000);
      await resize(narrow);
      await p.evaluate(() => window.__remember());
      await resize(wide);
      const shrunk = await position(wide);
      check(scene, 'missing anchor and shorter content clamp at bottom', shrunk.max < 1000 && Math.abs(shrunk.y - shrunk.max) <= 1, JSON.stringify(shrunk));
      // Reverse direction: mobile also clamps if its saved workspace disappears.
      await resize(narrow); const phoneEnd = await position(narrow);
      check(scene, 'mobile also clamps after content shrinks', Math.abs(phoneEnd.y - Math.min(phone.y, phoneEnd.max)) <= 1, JSON.stringify(phoneEnd));
      if (surface === 'overview') {
        await p.evaluate(() => window.__hostTheme(window.__FIXTURE__.theme, true));
        await ready(narrow);
        check(scene, 'new Overview instance starts at top while session filters remain', (await position(narrow)).y === 0
          && (await p.locator(byId('mobile-swimlane-screen')).innerText()).includes('review0'));
      }
      check(scene, 'no storage/RPC writes for scrolling', await p.evaluate(() => window.__writes.length === 0 && !window.__inputs.some(v => /\.(set|save|mutate)$/.test(v.name))));
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
      records.push({ scene, before, phone, after, anchor, anchored, shrunk });
      await p.screenshot({ path: path.join(out, scene + '.png') });
    } catch (e) {
      check(scene, 'scene completed', false, String(e.stack ?? e).split('\n').slice(0, 4).join(' | '));
      await p.screenshot({ path: path.join(out, scene + '-error.png') });
    } finally { await context.close(); }
  }
  fs.writeFileSync(path.join(out, 'scroll-positions.json'), JSON.stringify(records, null, 2) + '\n');
  await runGap473({ browser, page, out, check, byId });
  await runRapid474({ browser, page, out, check, byId });
}

// Gate 473 F1: 4px above workspace 3 is an inter-lane gap, in both layouts.
// Keep these eight conditions aligned with research/473/gap-evidence.json.
async function runGap473({ browser, page, out, check, byId }) {
  const evidence = [];
  for (const surface of ['overview', 'explorer']) for (const [wide, narrow] of [[900, 759], [1200, 700]]) for (const layout of ['wide', 'mobile']) {
    const from = layout === 'wide' ? wide : narrow, to = layout === 'wide' ? narrow : wide;
    const scene = `gap473-${surface}-${wide}-${narrow}-${layout}`;
    const context = await browser.newContext({ viewport: { width: surface === 'explorer' ? 2200 : wide, height: 800 } });
    const p = await context.newPage(), errors = []; p.on('pageerror', e => errors.push(String(e)));
    const selector = width => byId(width >= 760 ? 'swimlane-vertical' : 'mobile-workspace-sections');
    const ready = async width => {
      await p.waitForSelector(selector(width));
      await p.waitForSelector(width >= 760 ? byId('swimlane-lane-section') : '[data-testid^="mobile-workspace-board_"]');
      await p.waitForTimeout(250);
    };
    const resize = async width => {
      if (surface === 'explorer') await p.evaluate(w => window.__panelWidth(w), width);
      else await p.setViewportSize({ width, height: 800 });
      await ready(width);
    };
    const scenarios = [
      { kind: 'preceding-removed', remove: [0, 1], expected: 3 },
      { kind: 'anchor-removed', remove: [0, 1, 3], expected: 4 },
      { kind: 'next-also-removed', remove: [0, 1, 3, 4], expected: 5 },
      { kind: 'no-successor', remove: [0, 1, 3, 4, 5, 6, 7], expected: null },
    ];
    try {
      for (const scenario of scenarios) {
        if (surface === 'overview') await p.setViewportSize({ width: wide, height: 800 });
        await p.goto(page('dark', false, `scroll760-en-${surface}-${wide}`));
        await ready(wide);
        if (layout === 'mobile') await resize(narrow);
        const target = await p.locator(selector(from)).evaluate(e => {
          const nodes = [...e.querySelectorAll('[data-testid="swimlane-lane-section"],[data-testid^="mobile-workspace-board_"]')];
          const lane = nodes[3];
          return { y: e.scrollTop + lane.getBoundingClientRect().top - e.getBoundingClientRect().top - 4,
            name: lane.textContent.match(/Scroll Workspace \d+/)?.[0] };
        });
        await p.locator(selector(from)).evaluate((e, y) => { e.scrollTop = y; }, target.y);
        await p.waitForTimeout(180);
        const before = await p.locator(selector(from)).evaluate(e => {
          const top = e.getBoundingClientRect().top;
          const nodes = [...e.querySelectorAll('[data-testid="swimlane-lane-section"],[data-testid^="mobile-workspace-board_"]')];
          return { y: e.scrollTop, delta: nodes[3].getBoundingClientRect().top - top,
            covering: nodes.some(n => n.getBoundingClientRect().top <= top && n.getBoundingClientRect().bottom > top) };
        });
        check(scene, scenario.kind + ': starts in a 4px gap above workspace 3', target.name === 'Scroll Workspace 3'
          && !before.covering && Math.abs(before.delta - 4) <= 1, JSON.stringify({ target, before }));
        await resize(to);
        await p.evaluate(remove => {
          const f = window.__FIXTURE__, o = structuredClone(f.overview);
          o.boards = o.boards.filter((_, i) => !remove.includes(i));
          o.boardViews = o.boardViews.filter((_, i) => !remove.includes(i));
          f.overview = o;
        }, scenario.remove);
        await resize(from);
        const after = await p.locator(selector(from)).evaluate((e, expected) => {
          const area = e.getBoundingClientRect();
          const nodes = [...e.querySelectorAll('[data-testid="swimlane-lane-section"],[data-testid^="mobile-workspace-board_"]')];
          const lane = expected === null ? null : nodes.find(n => n.textContent.includes('Scroll Workspace ' + expected));
          const box = lane?.getBoundingClientRect();
          return { y: e.scrollTop, max: Math.max(0, e.scrollHeight - e.clientHeight),
            delta: box ? box.top - area.top : null, visible: !!box && box.bottom > area.top && box.top < area.bottom };
        }, scenario.expected);
        const restored = scenario.expected === null ? Math.abs(after.y - Math.min(before.y, after.max)) <= 1
          : after.visible && after.delta !== null && Math.abs(after.delta - before.delta) <= 1;
        check(scene, scenario.kind + (scenario.expected === null ? ': pixel fallback clamps at end' : ': first surviving anchor keeps its relative position'),
          restored, JSON.stringify({ before, after, expected: scenario.expected }));
        check(scene, scenario.kind + ': no page errors', errors.length === 0, errors.join(' | '));
        evidence.push({ scene, ...scenario, target, before, after, restored });
        if (!restored || scenario.kind === 'preceding-removed') await p.screenshot({ path: path.join(out, scene + '-' + scenario.kind + '.png') });
      }
    } catch (e) {
      check(scene, 'scene completed', false, String(e.stack ?? e).split('\n').slice(0, 4).join(' | '));
      await p.screenshot({ path: path.join(out, scene + '-error.png') });
    } finally { await context.close(); }
  }
  fs.writeFileSync(path.join(out, 'gap473-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}

// Gate 474 F2: control delivery order, not elapsed milliseconds. The callbacks are RN Web's real
// scroll-end timer and the browser's real animation-frame queue; no component handlers are called.
async function runRapid474({ browser, page, out, check, byId }) {
  const evidence = [];
  for (const surface of ['overview', 'explorer']) for (const [wide, narrow] of [[900, 759], [1200, 700]]) {
    const scene = `rapid474-${surface}-${wide}-${narrow}`;
    const context = await browser.newContext({ viewport: { width: surface === 'explorer' ? 2200 : wide, height: 800 } });
    const p = await context.newPage(), errors = []; p.on('pageerror', e => errors.push(String(e)));
    await p.addInitScript(() => {
      const raf = requestAnimationFrame.bind(window), caf = cancelAnimationFrame.bind(window);
      const timeout = setTimeout.bind(window), clear = clearTimeout.bind(window);
      let next = -1, heldFrames = false, heldEnds = true, canceled = [], capturedEnds = 0, deliveredEnds = 0;
      const frames = new Map(), ends = new Map();
      window.requestAnimationFrame = callback => {
        const id = next--, job = { callback, native: null };
        frames.set(id, job);
        if (!heldFrames) job.native = raf(time => { if (frames.delete(id)) callback(time); });
        return id;
      };
      window.cancelAnimationFrame = id => {
        const job = frames.get(id);
        if (job) { if (job.native !== null) caf(job.native); frames.delete(id); if (heldFrames) canceled.push(job.callback); }
        else caf(id);
      };
      window.setTimeout = (callback, delay, ...args) => {
        // ScrollViewBase schedules its final scroll event at 100ms. Keep the actual callback,
        // and release it at a known lifecycle boundary rather than sleeping until its deadline.
        if (delay === 100 && typeof callback === 'function' && String(callback).includes('handleScrollEnd')) {
          capturedEnds++;
          if (heldEnds) { const id = next--; ends.set(id, () => { deliveredEnds++; callback(...args); }); return id; }
          return timeout(() => { deliveredEnds++; callback(...args); }, delay);
        }
        return timeout(callback, delay, ...args);
      };
      window.clearTimeout = id => { if (!ends.delete(id)) clear(id); };
      const nextFrame = () => new Promise(resolve => raf(resolve));
      window.__rapid474 = {
        nextFrame,
        async frames(count) { for (let i = 0; i < count; i++) await nextFrame(); },
        stats: () => ({ frames: frames.size, ends: ends.size, canceled: canceled.length, capturedEnds, deliveredEnds }),
        holdFrames() { heldFrames = true; for (const job of frames.values()) if (job.native !== null) { caf(job.native); job.native = null; } },
        releaseFrames() {
          heldFrames = false;
          for (const [id, job] of frames) if (job.native === null) job.native = raf(time => { if (frames.delete(id)) job.callback(time); });
        },
        releaseEnds() { const jobs = [...ends.values()]; ends.clear(); for (const job of jobs) job(); },
        replayCanceled() { const jobs = canceled; canceled = []; for (const callback of jobs) callback(performance.now()); return jobs.length; },
      };
    });
    const selector = width => byId(width >= 760 ? 'swimlane-vertical' : 'mobile-workspace-sections');
    const ready = width => p.evaluate(async selector => {
      for (let frame = 0; frame < 240; frame++) {
        const node = document.querySelector(selector);
        if (node?.clientHeight > 0 && node.scrollHeight > node.clientHeight
          && node.querySelectorAll('[data-testid="swimlane-lane-section"],[data-testid^="mobile-workspace-board_"]').length === 8) return;
        await window.__rapid474.nextFrame();
      }
      throw new Error('Layout did not become measurable within 240 native frames: ' + selector);
    }, selector(width));
    const frames = count => p.evaluate(count => window.__rapid474.frames(count), count);
    const position = width => p.locator(selector(width)).evaluate(e => ({ y: e.scrollTop, max: e.scrollHeight - e.clientHeight }));
    const resize = async width => {
      if (surface === 'explorer') await p.evaluate(w => window.__panelWidth(w), width);
      else await p.setViewportSize({ width, height: 800 });
      await ready(width);
    };
    const seed = async (width, y) => {
      const before = await p.evaluate(() => window.__rapid474.stats().capturedEnds);
      await p.locator(selector(width)).evaluate((e, y) => { e.scrollTop = y; }, y);
      await p.waitForFunction(before => window.__rapid474.stats().capturedEnds > before, before, { polling: 'raf' });
      return position(width);
    };
    let failures = 0;
    try {
      // 50 trials total, balanced across both entry paths, width pairs and final directions.
      const trials = process.env.KANBAN_WEB_RAPID_SMOKE === '1' ? 1 : wide === 900 ? 13 : 12;
      for (let trial = 0; trial < trials; trial++) {
        if (surface === 'overview') await p.setViewportSize({ width: wide, height: 800 });
        await p.goto(page('dark', false, `scroll760-en-${surface}-${wide}`)); await ready(wide); await frames(6);
        const seededWide = await seed(wide, 630);
        await resize(narrow); await frames(6);
        const seededMobile = await seed(narrow, 345);
        const qualified = seededWide.y === 630 && seededMobile.y === 345;
        check(scene, `trial ${trial}: both positions seeded before rapid transitions`, qualified, JSON.stringify({ seededWide, seededMobile }));
        await p.evaluate(() => window.__rapid474.holdFrames());
        // Layouts must actually mount, but their restoration frames have not run yet.
        // Alternating the final direction exercises both pending layout owners.
        for (let step = 0; step < 16; step++) await resize((step + trial) % 2 ? wide : narrow);
        const pending = await p.evaluate(() => window.__rapid474.stats());
        const staleFrames = await p.evaluate(() => {
          window.__rapid474.releaseEnds();
          const count = window.__rapid474.replayCanceled();
          window.__rapid474.releaseFrames();
          return count;
        });
        await frames(6);
        await resize(wide); await frames(6);
        const returnedWide = await position(wide);
        await resize(narrow); await frames(6);
        await p.evaluate(() => window.__rapid474.releaseEnds());
        await frames(2);
        const returnedMobile = await position(narrow);
        await resize(wide); await frames(6);
        await p.evaluate(() => window.__rapid474.releaseEnds());
        await frames(2);
        const lateWide = await position(wide);
        const ok = qualified && returnedWide.y === 630 && returnedMobile.y === 345 && lateWide.y === 630;
        if (!ok) failures++;
        check(scene, `trial ${trial}: rapid transition and late callbacks keep both positions`, ok,
          JSON.stringify({ returnedWide, returnedMobile, lateWide, pending, staleFrames }));
        evidence.push({ scene, trial, qualified, pending, staleFrames, seededWide, seededMobile, returnedWide, returnedMobile, lateWide, ok });
        fs.writeFileSync(path.join(out, 'rapid474-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
        if (trial === 0 || !ok && failures === 1) await p.screenshot({ path: path.join(out, scene + '-' + trial + '.png') });
      }
      check(scene, 'controlled delivery exercised pending frames and delayed scroll-end events',
        evidence.filter(e => e.scene === scene).every(e => e.pending.frames > 0 && e.pending.ends > 0 && e.staleFrames > 0));
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    } catch (error) {
      check(scene, 'all configured trials completed', false, String(error.stack ?? error).split('\n').slice(0, 4).join(' | '));
      await p.screenshot({ path: path.join(out, scene + '-error.png') });
    } finally { await context.close(); }
  }
  const summary = Object.fromEntries([...new Set(evidence.map(e => e.scene))].map(scene => {
    const rows = evidence.filter(e => e.scene === scene);
    return [scene, { trials: rows.length, qualified: rows.filter(e => e.qualified).length, failures: rows.filter(e => !e.ok).length }];
  }));
  fs.writeFileSync(path.join(out, 'rapid474-summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
