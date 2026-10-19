// REQ-152: real Explorer contribution in a wide host mock; only the panel width changes.
// The host's routing/panel persistence is a mock assertion, not a live Paseo integration test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstalledSidebar } from './req152-installed.mjs';

export async function runReq152({ browser, page, out, check, byId, longPress, copy }) {
  // Playwright's real pointer click waits for moving sheets to settle before pressing their close control.
  const clickAt = async (p, selector) => { await p.locator(selector).first().click(); await p.waitForTimeout(150); };
  const geometry = [], title = '총괄-03_example-app_Opus', card = `[data-testid^="kanban-card-"][aria-label="${title}"]`;
  const widths = [360, 500, 700, 900, 1200];
  // A failed scene can be checked alone on a busy NAS; omit for the complete bundle.
  const selected = process.env.KANBAN_WEB_REQ152_SCENES?.split(',');
  if (selected) {
    const known = new Set(['host', 'entry', 'req158', 'boundary', 'phone', ...['dark', 'light'].flatMap(mode => ['ko', 'en'].flatMap(lang => widths.map(width => `req152-${width}-${lang}-${mode}`)))]);
    if (selected.some(scene => !known.has(scene))) throw new Error('Unknown KANBAN_WEB_REQ152_SCENES scene');
  }
  if (!selected || selected.includes('host')) await runInstalledSidebar({ root: fileURLToPath(new URL('../..', import.meta.url)), out, check });
  if (!selected || selected.includes('entry')) await runEntryNavigation({ browser, page, out, check, byId });
  if (!selected || selected.includes('req158')) await runReq158Settings({ browser, page, out, check, byId, clickAt, copy });
  const screen = width => byId(width < 760 ? 'mobile-swimlane-screen' : 'swimlane-screen');
  const ready = async (p, width) => {
    await p.waitForSelector(screen(width), { timeout: 15000 });
    await p.waitForSelector('[data-testid^="kanban-card-"]', { timeout: 15000 });
    await p.waitForTimeout(150);
  };
  const bounded = async (p, scene, width) => {
    const geo = await p.evaluate(() => {
      const panel = document.querySelector('[data-testid=kanban-explorer]'), r = panel.getBoundingClientRect();
      const ids = ['mobile-appbar', 'mobile-control-row', 'mobile-tab-todo', 'mobile-tab-doing', 'mobile-tab-review', 'mobile-tab-done',
        'mobile-attention-chip', 'swimlane-title-row', 'swimlane-fixed-header', 'open-settings', 'view-toggle', 'list-title-row'];
      const controls = [...panel.querySelectorAll('[data-testid]')].filter(e => ids.includes(e.dataset.testid)).map(e => {
        const b = e.getBoundingClientRect();
        return { id: e.dataset.testid, x: b.x, right: b.right, y: b.y, bottom: b.bottom, width: b.width, height: b.height };
      });
      const textClipped = [...panel.querySelectorAll('[data-testid^="mobile-tab-"], [data-testid="mobile-attention-chip"], [data-testid="open-settings"], [data-testid="view-toggle"]')]
        .flatMap(control => [...control.querySelectorAll('[dir="auto"]')].filter(e => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
          .map(e => ({ control: control.dataset.testid, text: e.textContent, width: e.clientWidth, scroll: e.scrollWidth })));
      const clipped = controls.filter(b => b.x < r.x - 1 || b.right > r.right + 1 || b.width <= 0 || b.height <= 0);
      return { panel: { x: r.x, right: r.right, width: r.width, height: r.height }, controls, clipped, textClipped,
        rootOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        panelOverflow: Math.max(0, panel.scrollWidth - panel.clientWidth) };
    });
    geometry.push({ scene, ...geo });
    fs.writeFileSync(path.join(out, 'explorer-geometry.json'), JSON.stringify(geometry, null, 2) + '\n');
    check(scene, 'panel measures its own width', Math.abs(geo.panel.width - width) < 1, JSON.stringify(geo.panel));
    check(scene, 'zero root or panel horizontal spill (board keeps its existing inner scroll)', geo.rootOverflow === 0 && geo.panelOverflow === 0, JSON.stringify(geo));
    check(scene, 'header and tab labels are not clipped', geo.textClipped.length === 0, JSON.stringify(geo.textClipped));
    check(scene, 'header and tab controls stay whole inside panel', geo.clipped.length === 0, JSON.stringify(geo.clipped));
  };
  for (const mode of ['dark', 'light']) for (const lang of ['ko', 'en']) for (const width of widths) {
    const scene = `req152-${width}-${lang}-${mode}`, m = copy(lang);
    if (selected && !selected.includes(scene)) continue;
    const context = await browser.newContext({ viewport: { width: 2200, height: 1000 }, hasTouch: true });
    const p = await context.newPage(), errors = [];
    p.on('pageerror', error => errors.push(String(error)));
    try {
    await p.goto(page(mode, false, `req152-${lang}-${width}`));
    await ready(p, width);
    const registrations = await p.evaluate(() => window.__registrations);
    const explorer = registrations.filter(r => r.kind === 'panel' && r.locations?.includes('explorer'));
    check(scene, 'one Explorer Kanban tab with Columns3 and workspace context', explorer.length === 1 && explorer[0].title === 'Kanban'
      && explorer[0].icon === 'Columns3' && explorer[0].context === 'workspace' && JSON.stringify(explorer[0].locations) === '["explorer"]', JSON.stringify(explorer));
    check(scene, 'sidebar overview and original workspace board remain', registrations.some(r => r.kind === 'sidebar' && r.id === 'overview' && r.title === 'Kanban')
      && registrations.some(r => r.kind === 'surface' && r.id === 'overview')
      && registrations.some(r => r.kind === 'panel' && r.id === 'board' && !r.locations));
    check(scene, 'existing layout chosen by panel width, not 2200px window', await p.locator(screen(width)).count() === 1
      && await p.locator(screen(width < 760 ? 900 : 360)).count() === 0);
    const body = await p.locator(screen(width)).innerText();
    check(scene, 'overview includes both workspaces, not just active one', body.includes('Example Workspace') && body.includes('Second Workspace'), body.slice(0, 700));
    check(scene, 'host locale reaches panel', body.includes(m.reviewStage), body.slice(0, 100));
    await bounded(p, scene, width);

    // Settings uses the measured panel area and keeps the existing sheet/dialog implementation.
    await clickAt(p, byId('open-settings'));
    await p.waitForSelector(byId(width < 760 ? 'settings-sheet' : 'settings-window'));
    check(scene, 'settings opens through existing implementation', await p.locator(byId('settings-close')).isVisible());
    await clickAt(p, byId('settings-close'));
    await p.waitForSelector(byId('settings-close'), { state: 'detached' });

    // A card opens the actual card.get path in the same page.
    if (width < 760) await clickAt(p, byId('mobile-tab-review'));
    await p.waitForSelector(card);
    await clickAt(p, card + ' ' + byId('card-title'));
    await p.waitForSelector(byId('detail-title'));
    const detailRead = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.card.get').at(-1));
    const detailId = await p.locator(card).getAttribute('data-testid');
    check(scene, 'card detail calls card.get with selected board/card', !!detailRead && detailRead.input.cardId === detailId?.replace('kanban-card-', '')
      && typeof detailRead.input.boardId === 'string', JSON.stringify(detailRead));
    await clickAt(p, byId('sheet-close'));
    await p.waitForSelector(byId('detail-title'), { state: 'detached' });

    // Wide board: ↗ on hover; compact board: the reused phone long-press menu.
    if (width >= 760) {
      await p.locator(card).hover();
      await clickAt(p, card + ' ' + byId('card-jump'));
    } else {
      await longPress(p, card + ' ' + byId('card-title'));
      await p.waitForSelector(byId('card-menu-jump'));
      await clickAt(p, byId('card-menu-jump'));
    }
    await p.waitForSelector(byId('agent-leave-open'));
    check(scene, 'existing cross-workspace warning remains before host navigation', await p.evaluate(() => window.__opened.length === 0));
    await clickAt(p, byId('agent-leave-open'));
    await p.waitForFunction(() => window.__opened.length === 1);
    const opened = await p.evaluate(() => window.__opened);
    check(scene, 'agent link uses provided host navigation in same page', JSON.stringify(opened) === JSON.stringify([['agent', '00000000-0000-4000-8000-0000000003a1']])
      && context.pages().length === 1 && (await p.locator(byId('host-main')).innerText()).includes(opened[0][1]), JSON.stringify(opened));
    check(scene, 'host mock retains mounted Explorer after agent open', await p.locator(screen(width)).isVisible());

    // The overview/list switch is the same one as the left menu; its title must size to the panel too.
    await clickAt(p, width < 760 ? byId('view-toggle') : byId('view-list'));
    await p.waitForSelector(byId('list-title-row'));
    await bounded(p, scene + '-list', width);
    const projectLabel = await p.locator(byId('projects-button')).getAttribute('aria-label') ?? await p.locator(byId('projects-button')).innerText();
    check(scene, 'list includes project filter', projectLabel.trim() === m.projectCount(1, 1), projectLabel);
    await clickAt(p, width < 760 ? byId('view-toggle') : byId('view-swimlane'));
    await ready(p, width);

    if (width === 900 && lang === 'ko') {
      for (const shotWidth of [1000, 400]) {
        await p.evaluate(value => window.__panelWidth(value), shotWidth);
        await ready(p, shotWidth);
        await p.screenshot({ path: path.join(out, `explorer-${shotWidth}-ko-${mode}.png`) });
      }
    }
    check(scene, 'no browser errors', errors.length === 0, errors.join(' | '));
    } catch (error) {
      await p.screenshot({ path: path.join(out, scene + '-failure.png') });
      fs.writeFileSync(path.join(out, scene + '-failure.html'), await p.content());
      throw error;
    } finally { await context.close(); }
  }
  // Resize the panel through the exact existing boundary without changing the host viewport or remounting.
  if (!selected || selected.includes('boundary')) {
  const p = await (await browser.newContext({ viewport: { width: 2200, height: 1000 } })).newPage();
  await p.goto(page('dark', false, 'req152-ko-900'));
  await ready(p, 900);
  for (const width of [759, 760, 761, 700, 1200, 360]) {
    await p.evaluate(value => window.__panelWidth(value), width);
    await ready(p, width);
    await bounded(p, `req152-boundary-${width}`, width);
    check(`req152-boundary-${width}`, 'layout follows existing 760px boundary on resize', await p.locator(screen(width)).count() === 1);
  }
  await p.context().close();
  }
  // Explorer does not render in a phone host; its ordinary overview is unchanged by registration.
  if (!selected || selected.includes('phone')) {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const errors = []; phone.on('pageerror', error => errors.push(String(error)));
  await phone.goto(page('dark', true)); await ready(phone, 390);
  check('req152-phone', 'ordinary phone screen with no Explorer wrapper', await phone.locator(byId('kanban-explorer')).count() === 0);
  await clickAt(phone, byId('open-settings')); await phone.waitForSelector(byId('settings-sheet'));
  // REQ-158: the phone's Display rows are as before (a phone browser's menu is the host's; no new row in this mock).
  await clickAt(phone, byId('settings-open-display')); await phone.waitForSelector(byId('setting-board-align'));
  check('req158-phone', 'phone Display rows unchanged: no left-menu row', await phone.locator(byId('setting-open-in')).count() === 0);
  await phone.screenshot({ path: path.join(out, 'req158-phone-390-display-dark.png') });
  await clickAt(phone, byId('settings-close')); await phone.waitForSelector(byId('settings-close'), { state: 'detached' });
  check('req152-phone', 'phone settings still works with zero errors', errors.length === 0, errors.join(' | '));
  await phone.context().close();
  }
  fs.writeFileSync(path.join(out, 'explorer-geometry.json'), JSON.stringify(geometry, null, 2) + '\n');
}

// Real registration + real sidebar/command callbacks; the host adapter only records routing and pane state.
// REQ-158 (requirement change): the menu opens the right panel only once this device chose "Right panel" in Display settings;
// REQ-152's cases below run with that choice, the 'main' cases with nothing chosen (the default, the main screen).
async function runEntryNavigation({ browser, page, out, check, byId }) {
  const cases = [];
  for (const choice of ['panel', 'main']) for (const api of ['new', 'old']) for (const workspace of [true, false]) for (const panelOpen of [false, true])
    cases.push({ api, workspace, panelOpen, platform: 'web', choice });
  cases.push({ api: 'footer', workspace: true, panelOpen: false, platform: 'web' });
  for (const platform of ['ios', 'android']) cases.push({ api: 'new', workspace: true, panelOpen: false, platform });
  for (const problem of ['cache', 'foreign', 'route', 'throw', 'missing', 'compact'])
    cases.push({ api: 'new', workspace: true, panelOpen: false, platform: 'web', problem });
  const evidence = [];
  for (const item of cases) {
    const { api, workspace, panelOpen, platform, problem = '', choice = 'panel' } = item;
    const base = `entry-${api}-${workspace ? 'workspace' : 'none'}-${panelOpen ? 'open' : 'closed'}-${platform}${problem ? '-' + problem : ''}`;
    const scene = (choice === 'main' ? 'req158-' : 'req152-') + base;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    // REQ-158: the device's choice, as the Display settings row writes it (client/settings.ts).
    if (choice === 'panel') await context.addInitScript(() => localStorage.setItem('paseo-kanban:open-in:host_example', 'panel'));
    const p = await context.newPage(), errors = [];
    p.on('pageerror', error => errors.push(String(error)));
    const file = page('dark', false, base);
    // Serve synthetic fixture and bundle entirely from Playwright. This is neither a daemon nor an external request.
    const html = fs.readFileSync(new URL(file), 'utf8');
    const bundle = fs.readFileSync(new URL('page.js', file));
    await context.route('https://req152.test/**', route => route.fulfill({ status: 200,
      contentType: route.request().url().split('?')[0].endsWith('/page.js') ? 'text/javascript' : 'text/html',
      body: route.request().url().split('?')[0].endsWith('/page.js') ? bundle : html }));
    const host = problem === 'foreign' ? 'other-host' : 'host_example';
    const pathname = !workspace ? '/h/host_example' : problem === 'route' ? ['/h/host_example', 'workspace', '%2Flegacy%2Ffolder'].join('/') : [`/h/${host}`, 'workspace', 'wks_example01'].join('/');
    await p.goto('https://req152.test' + pathname);
    await p.waitForSelector(byId('kanban-sidebar'));
    const registrations = await p.evaluate(() => window.__registrations);
    const menu = registrations.filter(row => row.kind.startsWith('sidebar'));
    check(scene, 'exactly one Kanban menu', menu.length === 1 && menu[0].title === 'Kanban' && await p.locator(byId('kanban-sidebar')).count() === 1, JSON.stringify(menu));
    check(scene, 'new header preferred, footer-only supported, native/old legacy preserved', menu[0]?.kind === (platform !== 'web' || api === 'old' ? 'sidebar' : api === 'footer' ? 'sidebar-footer' : 'sidebar-header'), JSON.stringify(menu));
    await p.locator(byId('kanban-sidebar')).click();
    const opensPanel = choice === 'panel' && platform === 'web' && api !== 'old' && workspace && (!problem || problem === 'cache');
    const calls = await p.evaluate(() => window.__entryCalls);
    const expected = opensPanel ? [{ kind: 'panel', id: 'explorer', options: { workspaceId: 'wks_example01', location: 'explorer' } }]
      : choice === 'panel' && (problem === 'throw' || problem === 'missing') ? [{ kind: 'panel', id: 'explorer', options: { workspaceId: 'wks_example01', location: 'explorer' } }, { kind: 'surface', id: 'overview' }]
      : [{ kind: 'surface', id: 'overview' }];
    if (choice === 'main') check(scene, 'REQ-158: by default the menu opens the main screen, never the right panel',
      calls.length === 1 && calls[0].kind === 'surface' && (await p.locator(byId('host-entry-main')).innerText()) === 'Kanban overview', JSON.stringify(calls));
    check(scene, 'sidebar opens current workspace Explorer or existing overview fallback', JSON.stringify(calls) === JSON.stringify(expected), JSON.stringify(calls));
    check(scene, 'closed panel unfolds and open panel stays open without another menu', (await p.locator(byId('host-entry-panel')).getAttribute('data-open')) === String(opensPanel || panelOpen));
    if (problem === 'compact') {
      check(scene, 'F1: compact sidebar closes through host openScreen', await p.locator(byId('host-sidebar')).getAttribute('data-open') === 'false'
        && await p.evaluate(() => window.__entryScreenCalls.length === 1));
      await p.evaluate(() => window.__resetEntry(true));
      await p.locator(byId('kanban-sidebar')).click();
      check(scene, 'F1: already-open overview still closes compact sidebar', await p.locator(byId('host-sidebar')).getAttribute('data-open') === 'false'
        && await p.evaluate(() => window.__entryScreenCalls.length === 1));
    }
    const command = registrations.find(row => row.kind === 'command' && row.id === 'explorer');
    check(scene, 'Explorer command is workspace-only and absent on native apps', platform !== 'web' ? !command : command?.context === 'workspace', JSON.stringify(command));
    check(scene, 'host offers command only with a workspace', await p.locator(byId('host-command-explorer')).count() === (platform === 'web' && workspace ? 1 : 0));
    if (platform === 'web' && workspace && problem !== 'throw' && problem !== 'missing') {
      await p.evaluate(() => window.__resetEntry());
      await p.locator(byId('host-command-explorer')).click();
      const commandCalls = await p.evaluate(() => window.__entryCalls);
      check(scene, 'Command Center callback explicitly opens explorer location', JSON.stringify(commandCalls) === JSON.stringify([{ kind: 'panel', id: 'explorer', options: { workspaceId: 'wks_example01', location: 'explorer' } }]), JSON.stringify(commandCalls));
    }
    if (choice === 'panel' && api === 'new' && platform === 'web' && workspace && !problem) {
      // It reads the URL when pressed; changing workspace after mounting cannot use a remembered selection.
      await p.evaluate(() => { window.__resetEntry(); history.replaceState(null, '', '/h/host_example'); });
      await p.locator(byId('kanban-sidebar')).click();
      check(scene, 'leaving the workspace before pressing falls back instead of reusing stale context', JSON.stringify(await p.evaluate(() => window.__entryCalls)) === JSON.stringify([{ kind: 'surface', id: 'overview' }]));
    }
    check(scene, 'zero browser errors', errors.length === 0, errors.join(' | '));
    evidence.push({ scene, menu, calls });
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'entry-navigation.json'), JSON.stringify(evidence, null, 2) + '\n');
}

// REQ-158: the Display row "Sidebar link opens in" in the real settings window at 1400px, chosen by real pointer clicks; the
// choice is in this browser's storage and drawn again after a reload. The press of the menu itself is runEntryNavigation's.
async function runReq158Settings({ browser, page, out, check, byId, clickAt, copy }) {
  for (const [mode, lang] of [['dark', 'en'], ['light', 'en'], ['dark', 'ko'], ['light', 'ko']]) {
    const scene = `req158-settings-1400-${lang}-${mode}`, m = copy(lang);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const p = await context.newPage(), errors = [];
    p.on('pageerror', error => errors.push(String(error)));
    const file = page(mode, false, 'req158-' + lang), html = fs.readFileSync(new URL(file), 'utf8'), bundle = fs.readFileSync(new URL('page.js', file));
    // Served from one origin so the browser's storage survives the reload (file:// pages share none reliably).
    await context.route('https://req158.test/**', route => route.fulfill({ status: 200,
      contentType: route.request().url().endsWith('/page.js') ? 'text/javascript' : 'text/html',
      body: route.request().url().endsWith('/page.js') ? bundle : html }));
    try {
      const openDisplay = async () => {
        await p.waitForSelector(byId('swimlane-screen'), { timeout: 15000 });
        await clickAt(p, byId('open-settings'));
        await p.waitForSelector(byId('settings-window'));
        await clickAt(p, byId('settings-tab-display'));
        await p.waitForSelector(byId('setting-open-in'));
      };
      const checked = () => p.evaluate(() => ['main', 'panel'].map(id => document.querySelector(`[data-testid="open-in-${id}"]`)?.getAttribute('aria-checked')));
      await p.goto('https://req158.test/h/host_example');
      await openDisplay();
      const text = await p.locator(byId('setting-open-in')).innerText();
      check(scene, 'row title, help and both choices in the host language', [m.openIn, m.openInHelp, m.openInMain, m.openInPanel].every(v => text.includes(v)), text);
      check(scene, 'main screen chosen by default', JSON.stringify(await checked()) === '["true","false"]', JSON.stringify(await checked()));
      const geo = await p.evaluate(() => {
        const row = document.querySelector('[data-testid="setting-open-in"]').getBoundingClientRect();
        const align = document.querySelector('[data-testid="setting-board-align"]').getBoundingClientRect();
        const win = document.querySelector('[data-testid="settings-window"]').getBoundingClientRect();
        return { row: { y: row.y, bottom: row.bottom, x: row.x, right: row.right }, alignBottom: align.bottom, win: { x: win.x, right: win.right } };
      });
      check(scene, 'below the board position, inside the window', geo.row.y >= geo.alignBottom - 1 && geo.row.x >= geo.win.x && geo.row.right <= geo.win.right + 1, JSON.stringify(geo));
      await p.locator(byId('setting-open-in')).scrollIntoViewIfNeeded();
      await p.screenshot({ path: path.join(out, `${scene}.png`) });
      await clickAt(p, byId('open-in-panel'));
      check(scene, 'Right panel kept in this browser', await p.evaluate(() => localStorage.getItem('paseo-kanban:open-in:host_example')) === 'panel'
        && JSON.stringify(await checked()) === '["false","true"]');
      if (lang === 'en') await p.screenshot({ path: path.join(out, `${scene}-panel.png`) });
      await p.reload();
      await openDisplay();
      check(scene, 'restored after a reload', JSON.stringify(await checked()) === '["false","true"]', JSON.stringify(await checked()));
      await p.keyboard.press('Escape');
      check(scene, 'zero browser errors', errors.length === 0, errors.join(' | '));
    } catch (error) {
      await p.screenshot({ path: path.join(out, scene + '-failure.png') });
      throw error;
    } finally { await context.close(); }
  }
}
