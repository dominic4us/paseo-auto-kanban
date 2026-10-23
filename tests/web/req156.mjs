import path from 'node:path';
import { switchBeside, switchRow, underPlaced } from './req160.mjs';
import fs from 'node:fs';
import { copy } from '../../dist/client/i18n.js';
import { UPDATE_COMMANDS } from '../../dist/shared/update-check.js';
import { checkedTime } from '../../dist/client/update-model.js';

/**
 * REQ-156 (research/485): the new-version notice on the real screens, by real input only (taps on a phone, the mouse on a wide
 * screen). The page's fake server answers the reads with the update check's states (run.mjs `req156-<lang>-<state>`) and keeps the
 * switch (page.tsx `kanban.v1.update_check.set`). No network: the screens never ask the registry; the server is not running here.
 *   KANBAN_WEB_ONLY=req156 node tests/web/run.mjs
 */
export async function runReq156({ browser, page, out, check, byId }) {
  const geometry = [];
  const cases = [];
  for (const width of [1400, 390]) for (const lang of ['en', 'ko']) for (const mode of ['light', 'dark']) cases.push({ width, lang, mode, state: 'newer', scale: 100 });
  for (const lang of ['en', 'ko']) cases.push({ width: 390, lang, mode: 'dark', state: 'newer', scale: 150 });
  for (const state of ['current', 'unchecked', 'off', 'damaged', 'none']) for (const lang of ['en', 'ko'])
    cases.push({ width: state === 'damaged' || state === 'off' ? 390 : 1400, lang, mode: state === 'damaged' ? 'dark' : 'light', state, scale: 100 });
  for (const { width, lang, mode, state, scale } of cases) {
    const scene = `req156-${width}-${lang}-${mode}-${scale}-${state}`, mobile = width < 760, m = copy(lang);
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, permissions: ['clipboard-read', 'clipboard-write'],
      ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    const p = await context.newPage(); p.setDefaultTimeout(8000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const el = id => p.locator(byId(id)).first();
    const count = id => p.locator(byId(id)).count();
    const press = async id => { await el(id).scrollIntoViewIfNeeded(); if (mobile) await el(id).tap(); else await el(id).click(); await p.waitForTimeout(200); };
    const sheet = mobile ? 'settings-sheet' : 'settings-window';
    const open = async category => {
      if (!(await count(sheet)) || !(await el(sheet).isVisible())) await press('open-settings');
      await p.waitForSelector(byId(sheet));
      if (mobile && (await count('settings-back')) && await el('settings-back').isVisible()) await press('settings-back');
      await press((mobile ? 'settings-open-' : 'settings-tab-') + category);
    };
    const close = async () => { await press('settings-close'); await p.waitForSelector(byId(sheet), { state: 'detached', timeout: 5000 }).catch(() => {}); };
    try {
      await p.goto(page(mode, mobile, `req156-${lang}-${state}`));
      if (scale !== 100) {
        // REQ-139: the screens drawn at 150% — set the way a person does, in Display.
        await p.waitForSelector(byId('open-settings'));
        await open('display');
        for (let i = 0; i < 5; i++) await press('ui-scale-larger');
        await close();
      }
      await p.waitForSelector(byId('open-settings'));
      const dot = (await count('open-settings-dot')) > 0, label = await el('open-settings').getAttribute('aria-label');
      // A phone's gear may also count the check up's cards ("Kanban settings · 10 cards to check up"); the update part comes last.
      const base = mobile ? m.checkupSettingsBadge(10) : m.settings, badged = mobile ? base + ' · ' + m.updateAvailableShort : m.settingsUpdateBadge;
      if (state === 'newer') {
        check(scene, 'the gear carries the dot and says why', dot && label === badged, JSON.stringify({ dot, label, badged }));
        const look = await p.evaluate(() => {
          const r = e => e?.getBoundingClientRect(), dot = document.querySelector('[data-testid="open-settings-dot"]'), count = document.querySelector('[data-testid="open-settings-badge"]');
          const d = r(dot), c = r(count);
          return { w: d.width, h: d.height, x: d.x, y: d.y, count: c ? { x: c.x, y: c.y, w: c.width, h: c.height } : null };
        });
        const apart = !look.count || look.x + look.w <= look.count.x || look.count.x + look.count.w <= look.x;
        check(scene, 'the dot is small and does not cover the count', look.w <= 14 && look.w >= 6 && look.h === look.w && apart, JSON.stringify(look));
        if (mobile) await p.locator(byId('open-settings')).first().screenshot({ path: path.join(out, `${scene}-gear.png`) }).catch(() => {});
      } else check(scene, 'no dot without a newer version', !dot && label === base, JSON.stringify({ dot, label, base }));

      await open('about');
      const rows = await count('setting-update');
      if (state === 'none') {
        check(scene, 'an older server: no update row, no switch', rows === 0);
        await close(); await open('automation'); await press('automation-tab-status');
        check(scene, 'an older server: no switch under Status & refresh', (await count('setting-update-check')) === 0);
      } else {
        const line = (await el('update-line').textContent()).trim();
        const want = { newer: m.updateNewer('0.2.6', '0.2.5'), current: m.updateCurrent(checkedTime(Date.parse('2026-10-19T00:30:00.000Z'))),
          unchecked: m.updateNotChecked, off: m.updateOff, damaged: m.updateCheckDamaged }[state];
        check(scene, 'the About line says the state', line === want, JSON.stringify({ line, want }));
        check(scene, 'the version row still says the version', (await el('settings-version').textContent()).includes('0.2.5'));
        const commands = await p.locator('[data-testid^="update-command-"]').allTextContents();
        if (state === 'newer') {
          check(scene, 'the two update commands, as README gives them', JSON.stringify(commands) === JSON.stringify([...UPDATE_COMMANDS]), JSON.stringify(commands));
          // Inside the sheet: nothing of the row runs past its edges (a long command wraps).
          const geo = await p.evaluate(sheetId => {
            const win = document.querySelector(`[data-testid="${sheetId}"]`), row = win.querySelector('[data-testid="setting-update"]');
            const bounds = win.getBoundingClientRect(), outside = [];
            for (const e of [row, ...row.querySelectorAll('*')]) {
              const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
              if (r.left < bounds.left - 1 || r.right > bounds.right + 1) outside.push((e.dataset.testid || e.textContent).slice(0, 40));
            }
            const lines = [...row.querySelectorAll('[data-testid^="update-command-"]')].map(e => ({ w: e.scrollWidth, cw: e.clientWidth }));
            return { outside, lines, sheet: { left: bounds.left, right: bounds.right } };
          }, sheet);
          geometry.push({ scene, ...geo });
          check(scene, 'nothing of the row runs past the sheet', geo.outside.length === 0 && geo.lines.every(l => l.w <= l.cw + 1), JSON.stringify(geo));
          await p.mouse.move(0, 0);
          await el(sheet).screenshot({ path: path.join(out, `${scene}-about.png`) });
          await press('update-copy');
          await p.waitForSelector(byId('update-copy-result'));
          const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(error => 'unreadable: ' + error);
          check(scene, 'Copy puts both lines on the clipboard and says so', clip === UPDATE_COMMANDS.join('\n')
            && (await el('update-copy-result').textContent()).trim() === m.updateCopied, clip);
          if (!mobile && lang === 'en' && mode === 'light') {
            await p.evaluate(() => { window.__noClipboard = true; });
            await press('update-copy');
            await p.waitForFunction(text => document.querySelector('[data-testid="update-copy-result"]')?.textContent?.trim() === text, m.updateCopyFailed, { timeout: 4000 }).catch(() => {});
            check(scene, 'a refused copy says to select the lines', (await el('update-copy-result').textContent()).trim() === m.updateCopyFailed);
            await p.evaluate(() => { window.__noClipboard = false; });
          }
        } else check(scene, 'no commands without a newer version', commands.length === 0, JSON.stringify(commands));
        if (state !== 'newer') { await p.mouse.move(0, 0); await el(sheet).screenshot({ path: path.join(out, `${scene}-about.png`) }); }

        // Automation → Status & refresh: the switch, on by default; damaged says so and marks the tab.
        if (mobile) await press('settings-back');
        await press((mobile ? 'settings-open-' : 'settings-tab-') + 'automation');
        const statusTab = await el('automation-tab-status').getAttribute('aria-label');
        check(scene, 'the Status tab asks for attention only when the file is damaged',
          state === 'damaged' ? statusTab.includes(m.automationNeedsAttention) : !statusTab.includes(m.automationNeedsAttention), statusTab);
        await press('automation-tab-status');
        await el('update-check-toggle').scrollIntoViewIfNeeded();
        const on = await el('update-check-toggle').getAttribute('aria-checked');
        check(scene, 'the switch shows the server\'s value', on === String(state !== 'off' && state !== 'damaged'), on);
        check(scene, 'the damaged notice is shown only for a damaged file', ((await count('update-check-damaged')) > 0) === (state === 'damaged'));
        { // REQ-160: the switch right of its title; a damaged notice under the description, the row's full width on a phone
          const g = await switchRow(p, 'setting-update-check', 'update-check-toggle', 'update-check-damaged'); geometry.push({ scene, req160: g });
          check(scene, 'REQ-160 the switch right of its title, at its height', switchBeside(g, mobile), JSON.stringify(g));
          // REQ-161 (508 J1): wide as well, so the notice no longer widens the switch's column over the title.
          if (state === 'damaged') check(scene, 'REQ-160/161 the damaged notice under the description, full width, the title keeping its width', underPlaced(g, mobile), JSON.stringify(g));
        }
        await p.mouse.move(0, 0);
        await el(sheet).screenshot({ path: path.join(out, `${scene}-automation.png`) });
        if (state === 'newer' || state === 'damaged') {
          // Off (newer) / on again (damaged): one write each, the switch follows the reply.
          await press('update-check-toggle'); await p.waitForTimeout(300);
          const calls = await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.update_check.set').map(v => v.input));
          const want = state === 'newer' ? false : true;
          check(scene, 'the switch writes once and follows the reply', JSON.stringify(calls) === JSON.stringify([{ enabled: want }])
            && await el('update-check-toggle').getAttribute('aria-checked') === String(want), JSON.stringify(calls));
          if (state === 'newer') {
            if (mobile) await press('settings-back');
            await press((mobile ? 'settings-open-' : 'settings-tab-') + 'about');
            check(scene, 'off: About says it is off and shows no commands', (await el('update-line').textContent()).trim() === m.updateOff
              && (await count('update-commands')) === 0);
            await close();
            check(scene, 'off: the dot is gone from the gear', (await count('open-settings-dot')) === 0
              && await el('open-settings').getAttribute('aria-label') === base);
          } else check(scene, 'saved again: the damaged notice is gone', (await count('update-check-damaged')) === 0);
        }
      }
    } catch (error) { check(scene, 'stopped by an error', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')); }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'req156-geometry.json'), JSON.stringify(geometry, null, 1) + '\n');
  await runLive({ browser, page, out, check, byId });
}

/**
 * Gate 486 F4 (research/486 gate486.mjs, kept as a test): a screen left open on a quiet board — no board changes at all — hears of a
 * check that finished after its read, and of another device turning the check off, through the revisions it polls (their `updates`
 * fingerprint), without a manual refresh. The fake server changes only its reading of the check, as the real one would.
 */
async function runLive({ browser, page, out, check, byId }) {
  const live = [];
  for (const width of [1400, 390]) {
    const mobile = width < 760, scene = 'req156-live-' + width, m = copy('en');
    const context = await browser.newContext({ viewport: { width, height: 900 }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
    // Auto refresh on, as it is by default for a person (the fixture turns it off for the still scenes).
    await context.addInitScript(() => {
      let value;
      Object.defineProperty(window, '__FIXTURE__', { configurable: true, get: () => value, set: v => { value = v; value.ui.settings.autoRefresh = true; } });
    });
    const p = await context.newPage(); p.setDefaultTimeout(8000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const press = async id => { const el = p.locator(byId(id)).first(); await el.scrollIntoViewIfNeeded(); if (mobile) await el.tap(); else await el.click(); await p.waitForTimeout(200); };
    const reading = value => p.evaluate(update => {
      window.__FIXTURE__.overview.updateCheck = update;
      for (const board of Object.values(window.__FIXTURE__.boards)) board.updateCheck = update;
    }, value);
    const dotWithin = async (want, ms) => { const end = Date.now() + ms;
      for (;;) { const n = await p.locator(byId('open-settings-dot')).count(); if (n === want || Date.now() > end) return n; await p.waitForTimeout(250); } };
    try {
      await p.goto(page('light', mobile, 'req156-en-unchecked'));
      await p.waitForSelector(byId('open-settings'));
      check(scene, 'starts without a dot', (await p.locator(byId('open-settings-dot')).count()) === 0);
      const readsBefore = await p.evaluate(() => window.__calls.filter(c => c === 'kanban.v1.overview.get' || c === 'kanban.v1.board.get').length);
      // The registry answers on the server after the screen's read; no board changes.
      await reading({ enabled: true, newer: '0.2.6', checkedAt: '2026-10-19T00:30:00.000Z' });
      const dot = await dotWithin(1, 12000);
      const calls = await p.evaluate(() => [...window.__calls]);
      const polls = calls.filter(c => c === 'kanban.v1.revisions.get').length;
      const reads = calls.filter(c => c === 'kanban.v1.overview.get' || c === 'kanban.v1.board.get').length - readsBefore;
      check(scene, 'a finished check reaches the open screen: the dot appears without a refresh', dot === 1, JSON.stringify({ dot, polls, reads }));
      check(scene, 'one re-read for the one change', reads === 1, String(reads));
      await press('open-settings');
      await press(mobile ? 'settings-open-about' : 'settings-tab-about');
      const line = (await p.locator(byId('update-line')).textContent()).trim();
      check(scene, 'About says the new version', line === m.updateNewer('0.2.6', '0.2.5'), line);
      await p.mouse.move(0, 0);
      await p.screenshot({ path: path.join(out, scene + '-delivered.png') });
      await press('settings-close');
      // Another device turns the check off: the dot goes, again by the poll alone.
      await reading({ enabled: false });
      const after = await dotWithin(0, 12000);
      check(scene, 'another device\'s off reaches the open screen: the dot goes', after === 0, String(after));
      await press('open-settings');
      await press(mobile ? 'settings-open-about' : 'settings-tab-about');
      const offLine = (await p.locator(byId('update-line')).textContent()).trim();
      check(scene, 'About says it is off', offLine === m.updateOff, offLine);
      await p.mouse.move(0, 0);
      await p.screenshot({ path: path.join(out, scene + '-other-device-off.png') });
      // Nothing changes any more: the polls go on without reading again.
      await press('settings-close');
      const settled = await p.evaluate(() => window.__calls.filter(c => c === 'kanban.v1.overview.get' || c === 'kanban.v1.board.get').length);
      await p.waitForTimeout(9000);
      const again = await p.evaluate(() => window.__calls.filter(c => c === 'kanban.v1.overview.get' || c === 'kanban.v1.board.get').length);
      check(scene, 'an unchanged fingerprint reads nothing again', again === settled, JSON.stringify({ settled, again }));
      live.push({ scene, polls, reads, dot, line, after, offLine });
    } catch (error) { check(scene, 'stopped by an error', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')); }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'req156-live.json'), JSON.stringify(live, null, 1) + '\n');
}
