import path from 'node:path';

/**
 * D67: the phone settings sheet at 390×844 — Automation's sheet takes the full height its list scrolls in, the list
 * reaches its end inside the sheet, and taps on the three tabs (or anywhere else inside the sheet) change only what the
 * sheet shows: it stays open, at the same place and size. Only real taps and wheel turns.
 * The phone's own collapse is Yoga's (research/479); the web's flexbox sizes the old sheet to each tab instead, so here the
 * old code fails on the height and on the height changing with the tab.
 */
export async function d67Scenes({ browser, page, out, check, byId }) {
  const geometry = [];
  for (const mode of ['dark', 'light']) {
    const scene = `d67-390-ko-${mode}`, width = 390, height = 844;
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
    const p = await context.newPage(); p.setDefaultTimeout(8000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const el = id => p.locator(byId(id)).first();
    const tap = async id => { await el(id).tap(); await p.waitForTimeout(300); };
    const shot = async suffix => p.screenshot({ path: path.join(out, scene + '-' + suffix + '.png'), animations: 'disabled', caret: 'hide' });
    const measure = async tag => {
      const geo = await p.evaluate(() => {
        const sheet = document.querySelector('[data-testid="settings-sheet"]');
        if (!sheet) return { open: false };
        const r = e => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10, height: Math.round(b.height * 10) / 10 }; };
        const scroll = sheet.querySelector('[data-testid="automation-scroll"]'), panel = sheet.querySelector('[data-testid^="automation-panel-"]');
        return { open: true, vh: innerHeight, sheet: r(sheet), ...(scroll ? { scroll: r(scroll), scrollTop: scroll.scrollTop, scrollMax: scroll.scrollHeight - scroll.clientHeight } : {}),
          ...(panel ? { panel: { id: panel.dataset.testid, ...r(panel) } } : {}) };
      });
      geometry.push({ scene, tag, ...geo });
      return geo;
    };
    try {
      // Ten workspaces at 150%: the Cards list is longer than the sheet, so its end has to be scrolled to.
      await p.goto(page(mode, true, 'req151-150-ko-many'));
      await p.waitForSelector(byId('open-settings'), { timeout: 20000 });
      await tap('open-settings');
      await tap('settings-open-automation');
      const first = await measure('cards');
      await shot('automation-cards');
      check(scene, 'D67 ①: Automation\'s sheet takes the full height (90% of the window)', first.open && Math.abs(first.sheet.height - height * .9) <= 1, JSON.stringify(first));
      check(scene, 'D67 ①: the sheet sits inside the window', first.open && first.sheet.top >= 0 && first.sheet.bottom <= height + .5, JSON.stringify(first.sheet));
      // Turn the wheel over the list until it stops: its end must then be inside the sheet, above the window's edge.
      const box = await el('automation-scroll').boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
      for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 400); await p.waitForTimeout(60); }
      await p.waitForTimeout(200);
      const end = await measure('cards-end');
      await shot('automation-cards-end');
      const floor = Math.min(end.scroll.bottom, end.sheet.bottom, height);
      check(scene, 'D67 ①: the list scrolls to its end and the end is seen inside the sheet', end.scrollTop >= end.scrollMax - 1 && end.panel.bottom <= floor + 1, JSON.stringify(end));
      const last = await p.locator('[data-testid^="auto-cards-workspace-toggle-"]').last().boundingBox();
      check(scene, 'D67 ①: the last workspace switch is wholly on screen', !!last && last.y >= end.scroll.top - 1 && last.y + last.height <= floor + 1, JSON.stringify(last));
      for (const tab of ['archive', 'status', 'cards', 'archive']) {
        await tap('automation-tab-' + tab);
        const geo = await measure(tab);
        check(scene, 'D67 ② ' + tab + ': the tab press keeps the sheet open, same place and size', geo.open && Math.abs(geo.sheet.top - first.sheet.top) <= 1
          && Math.abs(geo.sheet.height - first.sheet.height) <= 1, JSON.stringify(geo));
        check(scene, 'D67 ② ' + tab + ': the tab changed inside the sheet', await el('automation-tab-' + tab).getAttribute('aria-selected') === 'true'
          && geo.panel?.id === 'automation-panel-' + tab && geo.panel.top < height, JSON.stringify(geo.panel));
        if (tab === 'archive') await shot('automation-archive');
        // Same family: a tap on the panel's title (no control) inside the sheet changes nothing.
        await tap('automation-panel-title');
        const still = await measure(tab + '-title-tap');
        check(scene, 'D67 ' + tab + ': a tap on plain text inside the sheet leaves it open', still.open && Math.abs(still.sheet.height - geo.sheet.height) <= 1 && Math.abs(still.sheet.top - geo.sheet.top) <= 1, JSON.stringify(still));
      }
      // The other categories: a tap on their rows' plain text inside the sheet leaves it open too.
      await tap('settings-back');
      for (const [category, plain] of [['display', 'setting-theme'], ['about', 'settings-version']]) {
        await tap('settings-open-' + category);
        const target = await el(plain).boundingBox();
        await p.touchscreen.tap(target.x + Math.min(12, target.width / 2), target.y + Math.min(10, target.height / 2)); await p.waitForTimeout(300);
        const geo = await measure(category);
        check(scene, 'D67 ' + category + ': a tap on a row inside the sheet leaves it open', geo.open && geo.sheet.top >= 0, JSON.stringify(geo));
        await tap('settings-back');
      }
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  }
  // 480 F1 (the gate's display-probe as a test): after Automation, each other category still scrolls to its end — at 100%
  // and 150%, opened straight or after the three tabs. The body's `flex` shorthand, dropped by the next category, took
  // its `flexShrink` with it on the web: the sheet's body stretched past the sheet and Display could not scroll at 150%.
  for (const mode of ['dark', 'light']) for (const percent of [100, 150]) for (const route of ['direct', 'via-automation']) {
    const scene = `d67-route-390-ko-${mode}-${percent}-${route}`;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await context.newPage(); p.setDefaultTimeout(8000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const el = id => p.locator(byId(id)).first();
    const tap = async id => { await el(id).tap(); await p.waitForTimeout(300); };
    const wheelOver = async (id, turns) => {
      const b = await el(id).boundingBox(); await p.mouse.move(b.x + b.width / 2, Math.min(b.y + b.height - 80, 760));
      for (let i = 0; i < turns; i++) { await p.mouse.wheel(0, 500); await p.waitForTimeout(40); }
      await p.waitForTimeout(200);
    };
    const swipe = async () => {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 720 }] });
      for (let y = 700; y >= 260; y -= 20) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] }); await p.waitForTimeout(20); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(400);
    };
    const end = category => p.evaluate(id => {
      const sheet = document.querySelector('[data-testid="settings-sheet"]'), body = document.querySelector('[data-testid="sheet-content"]');
      const box = document.querySelector(`[data-testid="settings-category-${id}"]`);
      return { end: box.getBoundingClientRect().bottom, sheet: sheet.getBoundingClientRect().bottom, body: body.getBoundingClientRect().height, bodyFlex: getComputedStyle(body).flex };
    }, category);
    try {
      await p.goto(page(mode, true, `req151-${percent}-ko-many`));
      await p.waitForSelector(byId('open-settings'), { timeout: 20000 });
      await tap('open-settings');
      if (route === 'via-automation') {
        await tap('settings-open-automation');
        for (const tab of ['cards', 'archive', 'status']) { await tap('automation-tab-' + tab); await wheelOver('automation-scroll', 14); }
        await tap('settings-back');
      }
      for (const category of route === 'direct' ? ['display'] : ['display', 'about']) {
        await tap('settings-open-' + category); await p.waitForTimeout(200);
        await wheelOver('settings-sheet', 20); await swipe();
        const got = await end(category);
        geometry.push({ scene, category, ...got });
        check(scene, `480 F1 ${category}: its end is seen after a wheel and a swipe`, got.end <= Math.min(844, got.sheet) + 1, JSON.stringify(got));
        if (percent === 150 && category === 'display') await p.screenshot({ path: path.join(out, scene + '-display-end.png'), animations: 'disabled', caret: 'hide' });
        await tap('settings-back');
      }
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  }
  // 480 J1: the check up keeps 39753a6's sizes (research/480 extra-geometry) — empty, as tall as its message on the phone
  // (317px) and in the wide window (300px); with cards, the phone's 90% sheet and the wide window as tall as its list (730px).
  const sizes = { '390-empty': 317, '390-full': 844 * .9, '1400-empty': 300, '1400-full': 730 };
  for (const [width, height] of [[390, 844], [1400, 900]]) for (const data of ['empty', 'full']) {
    const scene = `d67-checkup-${width}-ko-dark-${data}`, mobile = width < 760;
    const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const p = await context.newPage(); p.setDefaultTimeout(8000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const el = id => p.locator(byId(id)).first();
    try {
      await p.goto(page('dark', mobile, `req149-100-ko-${data}`));
      await p.waitForSelector(byId('open-settings'), { timeout: 20000 }); await p.waitForTimeout(1700);
      if (mobile) { await el('open-settings').tap(); await p.waitForTimeout(300); await el('settings-checkup').tap(); }
      else await el('checkup-button').click();
      await p.waitForTimeout(400);
      const got = await p.evaluate(() => {
        const sheet = document.querySelector('[data-testid="checkup-sheet"]').getBoundingClientRect();
        return { top: sheet.top, bottom: sheet.bottom, height: sheet.height };
      });
      geometry.push({ scene, checkup: got });
      const expected = sizes[width + '-' + data];
      check(scene, `480 J1: the ${data} check up is ${Math.round(expected)}px tall as in 39753a6`,
        Math.abs(got.height - expected) <= 2 && got.top >= 0 && got.bottom <= height + .5, JSON.stringify(got));
      await p.screenshot({ path: path.join(out, scene + '.png'), animations: 'disabled', caret: 'hide' });
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  }
  return geometry;
}
