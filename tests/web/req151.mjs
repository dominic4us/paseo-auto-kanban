import fs from 'node:fs';
import { req151Races } from './req151-races.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { copy } from '../../dist/client/i18n.js';
import { palette, PASEO_THEMES, readable, contrast } from '../../dist/client/palette.js';

/** REQ-151: only real pointer/keyboard input; settings writes use the shared synthetic RPC page. */
export async function req151Scenes({ browser, page, out, check, byId }) {
  const baseline = !!process.env.KANBAN_WEB_REQ151_BASELINE, compare = process.env.KANBAN_WEB_REQ151_COMPARE;
  const geometry = [], comparisons = [], colors = [], confirmedValues = [], sha = data => createHash('sha256').update(data).digest('hex');
  const tabs = ['cards', 'archive', 'status'];
  const onlyScene = process.env.KANBAN_WEB_REQ151_SCENE;
  const cases = [];
  for (const width of [1400, 360, 390]) for (const lang of ['ko', 'en']) for (const mode of ['light', 'dark']) for (const percent of [100, 150])
    cases.push({ width, lang, mode, percent, data: 'normal' });
  if (!baseline) for (const data of ['empty', 'one', 'many', 'damaged', 'unusable']) for (const lang of ['ko', 'en'])
    cases.push({ width: 360, lang, mode: 'dark', percent: 150, data });

  for (const { width, lang, mode, percent, data } of cases) {
    const scene = `req151-${width}-${lang}-${mode}-${percent}-${data}`;
    if (process.env.KANBAN_WEB_REQ151_RACES_ONLY === '1') continue;
    if (onlyScene && !onlyScene.split(',').includes(scene)) continue;
    const mobile = width < 760, height = mobile ? 844 : 900, m = copy(lang);
    const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const p = await context.newPage(); p.setDefaultTimeout(8000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const el = id => p.locator(byId(id)).first();
    const press = async id => { await el(id).scrollIntoViewIfNeeded(); if (mobile) await el(id).tap(); else await el(id).click(); };
    const c = palette(PASEO_THEMES[mode]), errorColor = readable(c.statusDanger, c.surface0, 4.5).toLowerCase();
    const hex = value => '#' + (value.match(/\d+/g) ?? []).slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join('');
    const colorState = async (tab, state) => {
      const measured = await el('automation-tab-' + tab).evaluate(e => ({ color: getComputedStyle(e.querySelector('[dir="auto"]')).color,
        border: getComputedStyle(e).borderBottomColor, selected: e.getAttribute('aria-selected'), name: e.getAttribute('aria-label'), text: e.textContent }));
      const entry = { scene, tab, state, ...measured, hex: hex(measured.color), expectedError: errorColor, surface: c.surface0, contrast: contrast(hex(measured.color), c.surface0) };
      colors.push(entry); return entry;
    };
    const tabColors = async (tab, attention, tag) => {
      for (const active of [true, false]) {
        await press('automation-tab-' + (active ? tab : tab === 'cards' ? 'archive' : 'cards'));
        const got = await colorState(tab, tag + (active ? '-selected' : '-unselected'));
        const expected = attention ? errorColor : (active ? c.foreground : c.foregroundMuted).toLowerCase();
        check(scene, 'F1 ' + tag + ': ' + (active ? 'selected' : 'unselected') + (attention ? ' error token and 4.5:1 contrast' : ' normal color restored'),
          got.hex === expected && (!attention || got.contrast >= 4.5 && got.text.includes('!') && got.name.includes(m.automationNeedsAttention)), JSON.stringify(got));
      }
      await press('automation-tab-' + tab);
    };
    const confirmSwitch = async (control, tag) => {
      const checked = await el(control).getAttribute('aria-checked'), server = await p.evaluate(() => window.__settingsValues());
      const inputs = await p.evaluate(() => window.__inputs);
      const cwd = inputs.filter(v => v.name === 'kanban.v1.auto_cards.workspace.set').at(-1)?.input.cwd;
      const serverOn = control.startsWith('auto-cards-workspace-') ? !server.workspaceOff.includes(cwd) : control === 'auto-cards-toggle' ? server.autoCards : server.autoRefresh;
      confirmedValues.push({ scene, control, tag, checked, server, cwd });
      check(scene, 'F2 ' + tag + ': switch matches last confirmed server value', checked === String(serverOn), JSON.stringify(confirmedValues.at(-1)));
    };
    const settled = async () => { await p.waitForTimeout(150); };
    const selected = async id => await el('automation-tab-' + id).getAttribute('aria-selected') === 'true';
    const enterCategory = async id => {
      if (mobile && !(await el('settings-category-list').isVisible())) await press('settings-back');
      await press((mobile ? 'settings-open-' : 'settings-tab-') + id); await settled();
    };
    const shot = async suffix => {
      await p.mouse.move(0, 0); await settled();
      return await el(mobile ? 'settings-sheet' : 'settings-window').screenshot({ path: path.join(out, scene + '-' + suffix + '.png'), animations: 'disabled', caret: 'hide' });
    };
    const geometryCheck = async suffix => {
      const geo = await p.evaluate(({ mobile, width }) => {
        const win = document.querySelector(`[data-testid="${mobile ? 'settings-sheet' : 'settings-window'}"]`), panel = win.querySelector('[data-testid^="automation-panel-"]'), bar = win.querySelector('[data-testid="automation-tabs"]');
        const bounds = win.getBoundingClientRect(), b = bar.getBoundingClientRect();
        const horizontal = [], clipped = [];
        for (const e of panel.querySelectorAll('*')) {
          const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
          if (r.left < bounds.left - 1 || r.right > bounds.right + 1) horizontal.push(e.dataset.testid || e.textContent.slice(0, 35));
          if (e.getAttribute('dir') === 'auto') {
            // A Range for an entire line includes collapsed trailing spaces past its edge. Inspect only printed words.
            const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), rects = [];
            while (walker.nextNode()) for (const match of walker.currentNode.textContent.matchAll(/\S+/g)) {
              const range = document.createRange(); range.setStart(walker.currentNode, match.index); range.setEnd(walker.currentNode, match.index + match[0].length);
              rects.push(...range.getClientRects());
            }
            if (rects.some(t => t.left < r.left - 1.5 || t.right > r.right + 1.5 || t.top < r.top - 1.5 || t.bottom > r.bottom + 1.5)) clipped.push(e.textContent.slice(0, 80));
          }
        }
        const labels = [...bar.querySelectorAll('[role="tab"]')].map(e => {
          const r = e.getBoundingClientRect(), text = e.querySelector('[dir="auto"]'), range = document.createRange(); range.selectNodeContents(text);
          return { label: e.textContent, x: r.x, right: r.right, y: r.y, height: r.height, clipped: [...range.getClientRects()].some(t => t.left < r.left - 1 || t.right > r.right + 1 || t.top < r.top - 1 || t.bottom > r.bottom + 1) };
        });
        return { page: document.documentElement.scrollWidth, panel: { client: panel.clientWidth, scroll: panel.scrollWidth }, horizontal, clipped, labels,
          win: { x: bounds.x, right: bounds.right }, bar: { y: b.y, height: b.height }, width };
      }, { mobile, width });
      geometry.push({ scene, suffix, ...geo });
      check(scene, suffix + ': no horizontal overflow or text clipping', geo.page <= width && geo.panel.scroll <= geo.panel.client + 1 && !geo.horizontal.length && !geo.clipped.length, JSON.stringify(geo));
      check(scene, suffix + ': all three whole labels stay inside the window, touch targets at least 44px', geo.labels.length === 3 && geo.labels.every(t => !t.clipped && t.x >= geo.win.x - 1 && t.right <= geo.win.right + 1 && t.height >= 44), JSON.stringify(geo.labels));
      return geo;
    };
    try {
      await p.goto(page(mode, mobile, `req151-${percent}-${lang}-${data}`));
      await p.waitForSelector(byId('open-settings'), { timeout: 20000 }); await press('open-settings'); await settled();
      const captureCompare = async category => {
        const bytes = await shot(category), file = scene + '-' + category + '.png';
        if (compare) {
          const old = fs.readFileSync(path.join(compare, file)), same = bytes.equals(old);
          comparisons.push({ file, same, before: sha(old), after: sha(bytes) });
          check(scene, category + ': byte-identical to 6d668c4', same, JSON.stringify(comparisons.at(-1)));
        }
      };
      if (data === 'normal') {
        if (mobile) await captureCompare('categories');
        for (const category of ['display', 'about']) { await enterCategory(category); await captureCompare(category); }
      }
      if (baseline) { check(scene, 'baseline display/about captured', true); continue; }
      await enterCategory('automation');
      check(scene, 'three tabs, Cards first, one Tab stop', await el('automation-tabs').getAttribute('role') === 'tablist'
        && await p.locator(byId('automation-tabs') + ' [role="tab"]').count() === 3 && await selected('cards')
        && await p.locator(byId('automation-tabs') + ' [tabindex="0"]').count() === 1);
      for (const tab of tabs) {
        await press('automation-tab-' + tab); await settled();
        const relations = await el('automation-tab-' + tab).evaluate(e => {
          const panel = document.getElementById(e.getAttribute('aria-controls'));
          return !!panel && panel.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === e.id && panel.getAttribute('tabindex') === '0';
        });
        check(scene, tab + ': named panel and exactly one selected tab', relations && await selected(tab)
          && await p.locator(byId('automation-tabs') + ' [aria-selected="true"]').count() === 1);
        check(scene, tab + ': original title and help retained', (await el('automation-panel-' + tab).textContent()).includes(tab === 'cards' ? m.autoCardsHelp : tab === 'archive' ? m.autoArchiveHelp : m.autoRefreshHelp));
        const before = await geometryCheck(tab);
        if (data === 'normal') await shot(tab);
        if (tab === 'cards' && data !== 'empty') {
          const count = data === 'one' ? 1 : data === 'many' ? 10 : 3;
          check(scene, 'workspace list expanded, no disclosure button', await p.locator('[data-testid^="auto-cards-workspace-toggle-"]').count() === count && await p.locator(byId('automation-panel-cards') + ' [aria-expanded]').count() === 0);
          await press('auto-cards-workspace-toggle-' + (count - 1)); await settled();
          const after = await geometryCheck('cards-bottom');
          check(scene, 'tabs stay above the scrolled workspace list', Math.abs(before.bar.y - after.bar.y) < 1, JSON.stringify([before.bar, after.bar]));
          check(scene, 'workspace switch writes its folder, confirmed value retained', await el('auto-cards-workspace-toggle-' + (count - 1)).getAttribute('aria-checked') === 'false'
            && await p.evaluate(() => window.__inputs.some(v => v.name === 'kanban.v1.auto_cards.workspace.set' && v.input.enabled === false && typeof v.input.cwd === 'string')));
          await press('auto-cards-toggle'); await settled();
          check(scene, 'host switch still disables workspace switches and keeps its explanation', await el('auto-cards-toggle').getAttribute('aria-checked') === 'false'
            && await el('auto-cards-workspace-toggle-0').getAttribute('aria-disabled') === 'true' && (await el('setting-auto-cards-workspaces').textContent()).includes(m.autoCardsWorkspacesHostOff));
          await press('auto-cards-toggle'); await settled();
        } else if (tab === 'archive') {
          if (data === 'damaged') check(scene, 'archive damage shown on tab and in panel', (await el('automation-tab-archive').textContent()).includes('!') && await el('auto-archive-damaged').isVisible());
          if (data === 'normal') {
            // Stop polling: the successful write must survive refusal before any new overview reading.
            await press('automation-tab-status');
            if (await el('auto-refresh-toggle').getAttribute('aria-checked') === 'true') await press('auto-refresh-toggle');
            await press('automation-tab-archive');
            await press('auto-archive-30'); await settled();
            check(scene, 'F2 archive: 30 confirmed by server before refusal', await el('auto-archive-30').getAttribute('aria-checked') === 'true' && await p.evaluate(() => window.__settingsValues().archiveDays === 30));
            await p.evaluate(() => { window.__settingsFailNext = 'kanban.v1.archive.settings.set'; });
            await press('auto-archive-14');
            await p.waitForFunction(() => document.querySelector('[data-testid="automation-tab-archive"]')?.textContent.includes('!'));
            const server = await p.evaluate(() => window.__settingsValues());
            confirmedValues.push({ scene, control: 'archive', tag: 'success-30-refused-14', server, checked30: await el('auto-archive-30').getAttribute('aria-checked') });
            check(scene, 'F2 archive: refusal keeps confirmed 30, not old reading 7', server.archiveDays === 30 && await el('auto-archive-30').getAttribute('aria-checked') === 'true' && await el('setting-error').isVisible(), JSON.stringify(confirmedValues.at(-1)));
            await tabColors('archive', true, 'archive-error');
            await geometryCheck('archive-error');
            if (width === 360 && percent === 150) await shot('archive-confirmed-after-refusal');
            await press('setting-retry');
            await p.waitForFunction(() => !document.querySelector('[data-testid="automation-tab-archive"]')?.textContent.includes('!'));
            check(scene, 'archive: retry saves refused 14 and clears attention', await el('auto-archive-14').getAttribute('aria-checked') === 'true' && await p.evaluate(() => window.__settingsValues().archiveDays === 14));
            await tabColors('archive', false, 'archive-retried');
          }
          await press('auto-archive-14'); await settled();
          check(scene, 'archive days still saved', await el('auto-archive-14').getAttribute('aria-checked') === 'true' && await p.evaluate(() => window.__inputs.some(v => v.name === 'kanban.v1.archive.settings.set' && v.input.days === 14)));
        } else if (tab === 'status') {
          check(scene, 'lead list expanded with original read-only explanation', data === 'empty' ? await el('lead-status-list').count() === 0 : (await el('setting-lead-status').textContent()).includes(m.leadStatusHelp));
          if (data === 'unusable') check(scene, 'unusable lead indicated in tab text and accessible name', (await el('automation-tab-status').textContent()).includes('!') && (await el('automation-tab-status').getAttribute('aria-label')).includes(m.automationNeedsAttention));
          if (await el('auto-refresh-toggle').getAttribute('aria-checked') === 'false') await press('auto-refresh-toggle');
          await press('auto-refresh-toggle'); await settled();
          check(scene, 'refresh switch still saved', await el('auto-refresh-toggle').getAttribute('aria-checked') === 'false' && await p.evaluate(() => window.__writes.some(v => v.settings?.autoRefresh === false)));
          await press('auto-refresh-toggle'); await settled();
        }
      }
      // A keyboard user enters the tablist once, arrows wrap and activate, Home/End work, Tab enters its panel.
      await el('automation-tab-status').focus(); await p.keyboard.press('ArrowRight');
      check(scene, 'Right arrow wraps to Cards and focuses it', await selected('cards') && await el('automation-tab-cards').evaluate(e => e === document.activeElement));
      await p.keyboard.press('ArrowLeft'); check(scene, 'Left arrow wraps to Status', await selected('status'));
      await p.keyboard.press('Home'); check(scene, 'Home selects first', await selected('cards'));
      await p.keyboard.press('End'); check(scene, 'End selects last', await selected('status'));
      await p.keyboard.press(' '); await p.keyboard.press('Enter'); check(scene, 'Space and Enter keep selection', await selected('status'));
      await p.keyboard.press('Tab'); check(scene, 'Tab goes to active panel', await el('automation-panel-status').evaluate(e => e === document.activeElement));
      await enterCategory('about'); await enterCategory('automation'); check(scene, 'chosen tab survives category navigation', await selected('status'));
      if (data === 'normal') {
        await press('automation-tab-cards');
        await press('auto-cards-workspace-toggle-0'); await settled();
        await confirmSwitch('auto-cards-workspace-toggle-0', 'workspace-success');
        await p.evaluate(() => { window.__settingsFailNext = 'kanban.v1.auto_cards.workspace.set'; window.__settingsDelayNext = 600; });
        const old = await el('auto-cards-workspace-toggle-0').getAttribute('aria-checked');
        await press('auto-cards-workspace-toggle-0'); await press('automation-tab-archive');
        await p.waitForFunction(() => document.querySelector('[data-testid="automation-tab-cards"]')?.textContent.includes('!'));
        check(scene, 'late workspace failure visible on inactive tab, without stealing selection', await selected('archive') && (await el('automation-tab-cards').getAttribute('aria-label')).includes(m.automationNeedsAttention));
        await geometryCheck('inactive-error');
        if (lang === 'ko' && mode === 'light' && percent === 100 && width !== 360) await shot('inactive-error');
        await press('automation-tab-cards');
        check(scene, 'failed value kept, original retry shown', await el('setting-error').isVisible() && await el('auto-cards-workspace-toggle-0').getAttribute('aria-checked') === old);
        await confirmSwitch('auto-cards-workspace-toggle-0', 'workspace-success-then-refusal');
        await tabColors('cards', true, 'workspace-error');
        await geometryCheck('workspace-error');
        await press('setting-retry'); await p.waitForFunction(() => !document.querySelector('[data-testid="automation-tab-cards"]')?.textContent.includes('!'));
        check(scene, 'retry clears error and commits same switch', await el('auto-cards-workspace-toggle-0').getAttribute('aria-checked') !== old);
        await tabColors('cards', false, 'workspace-retried');
        // Refused host and refresh writes preserve their values and identify their tab too.
        for (const [tab, control, rpc] of [['cards', 'auto-cards-toggle', 'kanban.v1.auto_cards.set'], ['status', 'auto-refresh-toggle', 'kanban.v1.ui.set']]) {
          await press('automation-tab-' + tab);
          const field = control;
          await press(control); await settled();
          await confirmSwitch(control, tab + '-success');
          const was = await el(field).getAttribute('aria-checked');
          await p.evaluate(name => { window.__settingsFailNext = name; }, rpc); await press(control);
          await p.waitForFunction(id => document.querySelector(`[data-testid="automation-tab-${id}"]`)?.textContent.includes('!'), tab);
          check(scene, tab + ': refused write keeps value and marks tab in text', await el(field).getAttribute('aria-checked') === was && await el('setting-error').isVisible());
          await confirmSwitch(control, tab + '-success-then-refusal');
          await tabColors(tab, true, tab + '-error');
          await geometryCheck(tab + '-error');
          await press('setting-retry'); await p.waitForFunction(id => !document.querySelector(`[data-testid="automation-tab-${id}"]`)?.textContent.includes('!'), tab);
          check(scene, tab + ': retry clears tab attention', !(await el('automation-tab-' + tab).textContent()).includes('!'));
          await tabColors(tab, false, tab + '-retried');
        }
      }
      await press('settings-close'); await p.waitForTimeout(350); await press('open-settings'); await enterCategory('automation');
      check(scene, 'closing and reopening resets to Cards', await selected('cards'));
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    } catch (error) {
      check(scene, 'scene completed', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
      await p.screenshot({ path: path.join(out, scene + '-failure.png') }).catch(() => {});
    } finally { await context.close(); }
  }
  if (!baseline && !onlyScene) await req151Races({ browser, page, out, check, byId });
  fs.writeFileSync(path.join(out, 'req151-colors.json'), JSON.stringify(colors, null, 1) + '\n');
  fs.writeFileSync(path.join(out, 'req151-confirmed-values.json'), JSON.stringify(confirmedValues, null, 1) + '\n');
  fs.writeFileSync(path.join(out, 'req151-geometry.json'), JSON.stringify(geometry, null, 1) + '\n');
  fs.writeFileSync(path.join(out, 'req151-comparison.json'), JSON.stringify(comparisons, null, 1) + '\n');
}
