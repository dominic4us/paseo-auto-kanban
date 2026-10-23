import path from 'node:path';
import fs from 'node:fs';
import { copy } from '../../dist/client/i18n.js';
import { switchRow, underPlaced } from './req160.mjs';

/**
 * REQ-161 (research/509): on a phone a settings row keeps one short line (or its name alone) and shows its whole description
 * only while the ⓘ after its name is held; the wide window shows the shortened description itself. Real input only: touches
 * through the browser's touch events (CDP), the mouse and keys on the narrow web window. The page's fake server answers with
 * REQ-151's three workspaces, the left menu's row and the update check (run.mjs `req161-<percent>-<lang>-<state>`).
 *   KANBAN_WEB_ONLY=req161 node tests/web/run.mjs
 */
const ROWS = {
  display: [['setting-theme', 'theme', 'themeHelp', null], ['setting-ui-scale', 'uiScale', 'uiScaleHelp', 'uiScaleShort'],
    ['setting-board-align', 'boardAlign', 'boardAlignHelp', null], ['setting-open-in', 'openIn', 'openInHelp', 'openInShort'],
    ['setting-order-reset', 'resetAllOrder', 'resetOrderHelp', 'resetOrderShort']],
  cards: [['setting-auto-cards', 'autoCards', 'autoCardsHelp', 'autoCardsShort'],
    ['setting-auto-cards-workspaces', 'autoCardsWorkspaces', 'autoCardsWorkspacesHelp', 'autoCardsWorkspacesShort']],
  archive: [['setting-auto-archive', 'autoArchive', 'autoArchiveHelp', 'autoArchiveShort']],
  status: [['setting-auto-refresh', 'autoRefresh', 'autoRefreshHelp', null], ['setting-update-check', 'updateCheck', 'updateCheckHelp', 'updateCheckShort'],
    ['setting-lead-status', 'leadStatusTitle', 'leadStatusHelp', null]],
  about: [['setting-demo', 'demo', 'demoHelp', 'demoShort'], ['setting-connection', 'connectedHost', null, null],
    ['setting-version', 'versionRow', null, null], ['setting-update', 'updateRow', null, null]],
  labs: [['setting-labs-mail', 'labsMail', 'labsMailHelp', null], ['setting-labs-mail-dir', 'labsMailDir', 'labsMailDirHelp', 'labsMailDirShort'],
    ['setting-labs-mail-alias', 'labsMailAlias', 'labsMailAliasHelp', null]],
};
/** The rows whose switch sits beside the title (REQ-160 `inline`): their short line runs under the switch. */
const BESIDE = new Set(['setting-auto-cards', 'setting-auto-refresh', 'setting-update-check', 'setting-demo', 'setting-hidden-boards', 'setting-labs-mail']);
const PAGES = [['display', null], ['automation', 'cards'], ['automation', 'archive'], ['automation', 'status'], ['about', null], ['labs', null]];
const overlap = (a, b) => !!a && !!b && a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5;

export async function runReq161({ browser, page, out, check, byId }) {
  const log = [];
  const shots = path.join(out, 'req161'); fs.mkdirSync(shots, { recursive: true });
  const cases = [];
  for (const lang of ['ko', 'en']) { cases.push({ width: 360, lang, mode: 'light', percent: 100 }); cases.push({ width: 360, lang, mode: 'dark', percent: 150 }); }
  // 511 F1: the 390px phone too, at both sizes and in both languages (every ⓘ's touch box tried at its corners).
  for (const lang of ['ko', 'en']) for (const percent of [100, 150]) cases.push({ width: 390, lang, mode: percent === 150 ? 'dark' : 'light', percent });
  // 513 F2: the widest narrow window as well (one short of the wide window), touch on.
  for (const lang of ['ko', 'en']) for (const percent of [100, 150]) cases.push({ width: 759, lang, mode: percent === 150 ? 'dark' : 'light', percent });
  for (const lang of ['ko', 'en']) cases.push({ width: 1400, lang, mode: 'light', percent: 100 });
  cases.push({ width: 760, lang: 'ko', mode: 'dark', percent: 150 });
  // The narrow web window: a mouse and keys, no touch.
  cases.push({ width: 700, lang: 'ko', mode: 'light', percent: 100, pointer: true });
  // 508 J1: the damaged notice wide, at both sizes and in both languages.
  for (const width of [1400, 760]) for (const percent of [100, 150]) for (const lang of ['ko', 'en']) cases.push({ width, lang, mode: 'light', percent, state: 'damaged' });
  // Room above or not: a short window at 150%, with the left menu's row scrolled up under the sheet's head.
  cases.push({ width: 360, height: 480, lang: 'ko', mode: 'dark', percent: 150, flip: true });

  for (const { width, height: tall, lang, mode, percent, state = 'newer', pointer = false, flip = false } of cases) {
    const narrow = width < 760, touch = narrow && !pointer, m = copy(lang), height = tall ?? (narrow ? 844 : 900);
    const scene = `req161-${width}x${height}-${lang}-${mode}-${percent}-${state}${pointer ? '-pointer' : ''}${flip ? '-flip' : ''}`;
    // KANBAN_WEB_REQ161_SCENE=<a,b> runs only the scenes named (a gate re-running one).
    if (process.env.KANBAN_WEB_REQ161_SCENE && !process.env.KANBAN_WEB_REQ161_SCENE.split(',').includes(scene)) continue;
    const context = await browser.newContext({ viewport: { width, height }, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    await context.addInitScript(() => { window.localStorage.setItem('paseo-kanban:dev-demo', '1'); });
    const p = await context.newPage(); p.setDefaultTimeout(8000);
    if (process.env.KANBAN_WEB_REQ161_DEBUG) p.on('console', msg => console.log('[page]', msg.text()));
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const cdp = touch ? await context.newCDPSession(p) : null;
    const el = id => p.locator(byId(id)).first();
    const count = id => p.locator(byId(id)).count();
    const press = async id => { await el(id).scrollIntoViewIfNeeded(); if (touch) await el(id).tap(); else await el(id).click(); await p.waitForTimeout(200); };
    const rect = id => p.evaluate(id => { const e = document.querySelector(`[data-testid="${id}"]`); if (!e) return null;
      const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; }, id);
    const balloon = () => p.evaluate(() => {
      const e = document.querySelector('[data-testid="setting-info-balloon"]'), t = document.querySelector('[data-testid="setting-info-text"]');
      if (!e || !t) return null;
      const b = e.getBoundingClientRect(), s = getComputedStyle(t);
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height, opacity: Number(getComputedStyle(e).opacity),
        text: t.textContent, lines: Math.round(t.getBoundingClientRect().height / parseFloat(s.lineHeight)), font: parseFloat(s.fontSize),
        hidden: e.getAttribute('aria-hidden'), pointer: getComputedStyle(e).pointerEvents };
    });
    const touchAt = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const sheet = narrow ? 'settings-sheet' : 'settings-window';
    const open = async (category, tab) => {
      if (!(await count(sheet)) || !(await el(sheet).isVisible())) await press('open-settings');
      await p.waitForSelector(byId(sheet));
      if (narrow && (await count('settings-back')) && await el('settings-back').isVisible()) await press('settings-back');
      await press((narrow ? 'settings-open-' : 'settings-tab-') + category);
      if (tab) await press('automation-tab-' + tab);
    };
    const rowsOf = key => ROWS[key];
    try {
      await p.goto(page(mode, narrow, `req161-${percent}-${lang}-${state}`));
      await p.waitForSelector(byId('open-settings'), { timeout: 20000 });
      const scale = percent / 100;
      if (state === 'damaged') {
        // 508 J1: wide, the notice under the description over the row's width; the title and description keep their width.
        await open('automation', 'status');
        await el('update-check-damaged').scrollIntoViewIfNeeded();
        const g = await switchRow(p, 'setting-update-check', 'update-check-toggle', 'update-check-damaged'); log.push({ scene, j1: g });
        check(scene, 'J1 the damaged notice under the description, full width; the title and description wide', underPlaced(g, narrow)
          && g.title.right - g.title.left > 40 && g.help.right - g.help.left > 40, JSON.stringify(g));
        check(scene, 'J1 the switch right of the description, inside the row', g.sw.left >= g.help.right - .5 && g.sw.right <= g.row.right + 1, JSON.stringify(g));
        await p.mouse.move(0, 0); await el(sheet).screenshot({ path: path.join(shots, scene + '-status.png') });
        check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
        await context.close(); continue;
      }
      for (const [category, tab] of PAGES) {
        await open(category, tab);
        await p.waitForTimeout(150);
        if (narrow) {
          // 513 F2: how many rows the first screen shows before any scroll — a title seen / a row whole (logged, compared in the report).
          const first = await p.evaluate(({ sheet, ids }) => {
            const root = document.querySelector(`[data-testid="${sheet}"]`), view = (document.querySelector('[data-testid="automation-scroll"]') ?? root.querySelector('[data-testid="sheet-content"]') ?? root).getBoundingClientRect();
            const bottom = Math.min(view.bottom, root.getBoundingClientRect().bottom), rows = ids.map(id => root.querySelector(`[data-testid="${id}"]`)).filter(Boolean);
            return { titles: rows.filter(r => r.querySelector('[dir="auto"]').getBoundingClientRect().top < bottom - 1).length,
              whole: rows.filter(r => r.getBoundingClientRect().bottom <= bottom + .5).length, rows: rows.length };
          }, { sheet, ids: rowsOf(tab ?? category).map(r => r[0]) });
          log.push({ scene, firstScreen: tab ?? category, ...first });
          if (process.env.KANBAN_WEB_REQ161_FIRST === '1') continue;
        }
        for (const [row, titleKey, helpKey, shortKey] of rowsOf(tab ?? category)) {
          if (!(await count(row))) { log.push({ scene, row, absent: true }); continue; }
          const tag = (tab ?? category) + ' ' + row, help = helpKey && m[helpKey], short = shortKey && m[shortKey];
          const facts = await p.evaluate(({ row }) => {
            const q = id => document.querySelector(`[data-testid="${id}"]`), r = q(row), info = q('info-' + row), sw = r.querySelector('[role="switch"]');
            const text = id => id ? document.getElementById(id)?.textContent ?? null : null;
            const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
            // The name's printed letters (a Range: the element's box may run past them).
            const range = document.createRange(); range.selectNodeContents(r.querySelector('[dir="auto"]'));
            const letters = [...range.getClientRects()].reduce((end, b) => Math.max(end, b.right), 0), name = box(r.querySelector('[dir="auto"]'));
            const controls = [...r.querySelectorAll('[role="switch"],[role="radio"],[role="button"],input')].filter(e => !e.dataset.testid?.startsWith('info-')).map(box);
            return { visible: r.innerText, info: info ? { label: info.getAttribute('aria-label'), described: text(info.getAttribute('aria-describedby')), box: box(info),
              tabbable: info.tabIndex >= 0 } : null, glyph: box(q('info-glyph-' + row)), short: q('short-' + row) ? { text: q('short-' + row).textContent, box: box(q('short-' + row)),
              line: parseFloat(getComputedStyle(q('short-' + row)).lineHeight) } : null, help: q('help-' + row)?.textContent ?? null, row: box(r),
              letters, name, sw: box(sw), swDescribed: sw ? text(sw.getAttribute('aria-describedby')) : null, controls };
          }, { row });
          log.push({ scene, row, ...facts });
          if (narrow) {
            check(scene, tag + ': ⓘ after the name only where there is a description', !!facts.info === !!help, JSON.stringify(facts.info));
            check(scene, tag + ': the short line as written (509), none where it has none', short ? facts.short?.text === short : !facts.short, JSON.stringify(facts.short));
            check(scene, tag + ': the description not on the row', !facts.help && (!help || !facts.visible.includes(help)), facts.visible);
            if (short && percent === 100 && width === 360) check(scene, tag + ': the short line on one line at 360px · 100%', facts.short.box.height <= facts.short.line * 1.5, JSON.stringify(facts.short));
            if (short && facts.sw && BESIDE.has(row)) check(scene, tag + ': the short line runs under the switch, the row\'s width',
              facts.short.box.right >= facts.sw.left && facts.short.box.top >= facts.sw.bottom - 1, JSON.stringify({ s: facts.short.box, sw: facts.sw }));
            if (short && facts.sw) check(scene, tag + ': the switch says the short line', facts.swDescribed === short, String(facts.swDescribed));
            if (help) {
              const ib = facts.info.box;
              check(scene, tag + ': ⓘ named "name · more information", its description the whole text', facts.info.label === m.settingInfo(m[titleKey]) && facts.info.described === help,
                JSON.stringify(facts.info));
              check(scene, tag + ': the ⓘ glyph right after the name (a wrapped name: after its block), not over a letter', facts.glyph.left >= facts.letters - .5 && facts.glyph.left - facts.name.right <= 8 * scale,
                JSON.stringify({ glyph: facts.glyph, letters: facts.letters, name: facts.name }));
              check(scene, tag + ': ⓘ at least 44×44, apart from every control in the row', ib.width >= 44 - .01 && ib.height >= 44 - .01 && facts.controls.every(c => !overlap(ib, c)),
                JSON.stringify({ ib, controls: facts.controls }));
              if (touch) {
                // 511 F1: the whole 44×44 box is the ⓘ's to touch — 1px inside each corner and the centre each reach the ⓘ itself
                // (nothing drawn over it, the short line included) and open the balloon.
                await el('info-' + row).scrollIntoViewIfNeeded(); await p.waitForTimeout(100);
                const hb = await rect('info-' + row), hits = [];
                for (const [px, py] of [[hb.left + 1, hb.top + 1], [hb.right - 1, hb.top + 1], [hb.left + 1, hb.bottom - 1], [hb.right - 1, hb.bottom - 1],
                  [hb.left + hb.width / 2, hb.top + hb.height / 2]]) {
                  const at = await p.evaluate(({ x, y, id }) => { const e = document.elementFromPoint(x, y), i = document.querySelector(`[data-testid="${id}"]`);
                    return { own: !!e && !!i && i.contains(e), at: e?.closest('[data-testid]')?.dataset.testid ?? e?.tagName ?? null }; }, { x: px, y: py, id: 'info-' + row });
                  await touchAt('touchStart', px, py); await p.waitForTimeout(120);
                  const opened = await balloon();
                  await touchAt('touchEnd'); await p.waitForTimeout(100);
                  hits.push({ x: px, y: py, ...at, opened: !!opened && opened.text === help, closed: !(await balloon()) });
                }
                log.push({ scene, row, hits, box: hb });
                // 513 F2: the box is the ⓘ's alone — no short line, no other control (switch, choice, button, field) inside it.
                const crossing = await p.evaluate(({ id, sheet }) => {
                  const i = document.querySelector(`[data-testid="${id}"]`), b = i.getBoundingClientRect(), root = document.querySelector(`[data-testid="${sheet}"]`);
                  const others = [...root.querySelectorAll('[data-testid^="short-"],[role="switch"],[role="radio"],[role="button"],[role="tab"],input')]
                    .filter(e => e !== i && !e.contains(i) && !i.contains(e) && !/-backdrop$/.test(e.dataset.testid ?? ''));
                  return others.map(e => { const r = e.getBoundingClientRect();
                    const w = Math.min(b.right, r.right) - Math.max(b.left, r.left), h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
                    return { id: e.dataset.testid ?? e.getAttribute('role'), w, h }; }).filter(o => o.w > .01 && o.h > .01);
                }, { id: 'info-' + row, sheet });
                check(scene, tag + ': the ⓘ box crosses no short line or control', crossing.length === 0, JSON.stringify({ box: hb, crossing }));
                // Exact presses (a pointer, no finger forgiveness — as the phone app and the narrow window's mouse hit-test): just outside
                // each side of the box, and on the short line (its top line +1 included), reach something else and open nothing.
                const pressAt = async (x, y) => {
                  await p.mouse.move(x, y); const at = await p.evaluate(({ x, y, id }) => { const e = document.elementFromPoint(x, y), i = document.querySelector(`[data-testid="${id}"]`);
                    return { mine: !!e && i.contains(e), at: e?.closest('[data-testid]')?.dataset.testid ?? null }; }, { x, y, id: 'info-' + row });
                  await p.mouse.down(); await p.waitForTimeout(100); const opened = !!(await balloon()); await p.mouse.up(); await p.waitForTimeout(60);
                  return { x, y, ...at, opened };
                };
                const outside = [];
                for (const [x, y] of [[hb.left + hb.width / 2, hb.top - 1], [hb.left + hb.width / 2, hb.bottom + 1], [hb.left - 1, hb.top + hb.height / 2], [hb.right + 1, hb.top + hb.height / 2]])
                  outside.push(await pressAt(x, y));
                check(scene, tag + ': 1px outside the box (each side), an exact press is not the ⓘ\'s and opens nothing', outside.every(o => !o.mine && !o.opened), JSON.stringify({ box: hb, outside }));
                if (short) {
                  await el('short-' + row).scrollIntoViewIfNeeded(); await p.waitForTimeout(80);
                  const sb = await rect('short-' + row), cx = hb.left + hb.width / 2, on = [];
                  for (const [x, y] of [[cx, sb.top + 1], [hb.left + 1, sb.top + 1], [cx, sb.top + sb.height / 2], [sb.left + 2, sb.top + 1], [sb.left + sb.width / 2, sb.bottom - 1]])
                    on.push(await pressAt(Math.min(x, sb.right - 1), y));
                  check(scene, tag + ': on the short line (its top +1 too) an exact press reaches the line and opens nothing', on.every(o => o.at === 'short-' + row && !o.opened), JSON.stringify({ short: sb, on }));
                  // Dragging across the short line from under the ⓘ (or, where its letters end sooner, from 20 before their end) selects them.
                  const letters = await p.evaluate(id => { const range = document.createRange(); range.selectNodeContents(document.querySelector(`[data-testid="${id}"]`));
                    return [...range.getClientRects()].reduce((end, b) => Math.max(end, b.right), 0); }, 'short-' + row);
                  const from = Math.max(sb.left + 2, Math.min(cx, letters - 20));
                  // Two starts 4 apart: a drag starting exactly on a glyph boundary may select nothing in Chromium (seen at 759px · 100%).
                  let picked = '';
                  for (const start of [from, from + 4]) {
                    await p.evaluate(() => window.getSelection()?.removeAllRanges());
                    await p.mouse.move(start, sb.top + 1); await p.mouse.down(); await p.mouse.move(start + 60, sb.top + 1, { steps: 6 }); await p.mouse.up();
                    picked = await p.evaluate(() => window.getSelection()?.toString() ?? '');
                    if (picked.trim()) break;
                  }
                  await p.evaluate(() => window.getSelection()?.removeAllRanges()); await p.waitForTimeout(60);
                  check(scene, tag + ': a drag on the short line selects its letters', picked.trim().length > 0 && short.includes(picked.trim()), JSON.stringify({ picked }));
                  // And with a finger (the browser's touch, its forgiveness on): the short line — its top +1 under the ⓘ included — is the
                  // line's, not the ⓘ's. (A touch on empty room or on the name near the ⓘ still goes to it, as to any button: the browser's
                  // forgiveness, research/510 'F2'; the exact presses above hold there.)
                  const fingers = [];
                  for (const [x, y] of [[cx, sb.top + 1], [cx, sb.top + sb.height / 2], [Math.min(hb.left + 1, sb.right - 1), sb.top + 1], [sb.left + 2, sb.top + 1]]) {
                    await touchAt('touchStart', x, y); await p.waitForTimeout(120); const opened = !!(await balloon()); await touchAt('touchEnd'); await p.waitForTimeout(100);
                    fingers.push({ x, y, opened });
                  }
                  check(scene, tag + ': a finger on the short line (its top +1 under the ⓘ too) opens nothing', fingers.every(t => !t.opened), JSON.stringify({ box: hb, short: sb, fingers }));
                  log.push({ scene, row, exact: { outside, on, picked }, fingers });
                } else log.push({ scene, row, exact: { outside } });
                await p.mouse.move(0, 0);
                check(scene, tag + ': every corner of the 44×44 ⓘ box and its centre reach the ⓘ and open the balloon',
                  hits.every(h => h.own && h.opened && h.closed), JSON.stringify({ box: hb, hits }));
                // Held: shown at once, above the finger (or below where there is no room), inside the window, ⓘ and switch uncovered.
                await el('info-glyph-' + row).scrollIntoViewIfNeeded(); await p.waitForTimeout(100);
                const glyph = await rect('info-glyph-' + row), x = glyph.left + glyph.width / 2, y = glyph.top + glyph.height / 2;
                const sw = facts.sw ? await rect(await p.evaluate(row => document.querySelector(`[data-testid="${row}"] [role="switch"]`)?.dataset.testid ?? '', row)) : null;
                await touchAt('touchStart', x, y); await p.waitForTimeout(120);
                const b = await balloon();
                const room = b && y - 32 - b.height >= 16 - .5;
                log.push({ scene, row, hold: { x, y, b, glyph, sw } });
                check(scene, tag + ': held, the whole description in a balloon', !!b && b.opacity === 1 && b.text === help, JSON.stringify(b));
                if (b) {
                  check(scene, tag + ': the balloon above the finger by 32, or below by 32 when there is no room above', room ? b.bottom <= y - 32 + 1 : b.top >= y + 32 - 1, JSON.stringify({ y, b }));
                  check(scene, tag + ': inside the window, 16 from its edges, at most 320 wide', b.left >= 16 - .5 && b.right <= width - 16 + .5 && b.top >= 16 - .5
                    && b.bottom <= height - 16 + .5 && b.width <= 320 + .5, JSON.stringify(b));
                  check(scene, tag + ': ⓘ and the switch uncovered', !overlap(b, glyph) && !overlap(b, sw), JSON.stringify({ b, glyph, sw }));
                  check(scene, tag + ': 14 (scaled), at most 12 lines, untouchable and hidden from a screen reader', Math.abs(b.font - 14 * scale) < .6 && b.lines <= 12
                    && b.pointer === 'none' && b.hidden === 'true', JSON.stringify(b));
                }
                await touchAt('touchEnd'); await p.waitForTimeout(120);
                check(scene, tag + ': let go, the balloon goes', !(await balloon()));
              }
            }
          } else {
            check(scene, tag + ': wide, the shortened description itself, no ⓘ or short line', (help ? facts.help === help : facts.help === null) && !facts.info && !facts.short,
              JSON.stringify({ help: facts.help, info: facts.info, short: facts.short }));
          }
        }
        if (category === 'about') {
          // ⑯: the commands' instructions stay out in the open on a phone as wide; no ⓘ on the row.
          const text = await el('setting-update').innerText();
          check(scene, '⑯ the update instructions always shown, no ⓘ', text.includes(m.updateCommandsHelp) && (await count('info-setting-update')) === 0, text);
        }
        if (touch && category === 'automation' && tab === 'status') {
          // A finger that moves past 8pt is a scroll: the balloon goes, and stays away until the next press.
          await el('info-glyph-setting-update-check').scrollIntoViewIfNeeded(); await p.waitForTimeout(100);
          const glyph = await rect('info-glyph-setting-update-check'), x = glyph.left + glyph.width / 2, y = glyph.top + glyph.height / 2;
          await touchAt('touchStart', x, y); await p.waitForTimeout(100);
          await touchAt('touchMove', x + 4, y + 4); await p.waitForTimeout(80);
          const steady = !!(await balloon());
          await touchAt('touchMove', x, y + 9); await p.waitForTimeout(80);
          const moved = await balloon();
          await touchAt('touchMove', x, y); await p.waitForTimeout(80);
          const back = await balloon();
          await touchAt('touchEnd'); await p.waitForTimeout(100);
          check(scene, 'moved 8pt or less: the balloon stays; past 8pt: it goes and does not come back', steady && !moved && !back, JSON.stringify({ steady, moved, back }));
          // A long read: still there after 1.5s held.
          await touchAt('touchStart', x, y); await p.waitForTimeout(1500);
          const long = await balloon();
          if (percent === 150 && mode === 'dark' && width === 360) await p.screenshot({ path: path.join(shots, scene + '-balloon-status.png') });
          await touchAt('touchEnd'); await p.waitForTimeout(100);
          check(scene, 'held 1.5s: still shown; let go: gone', !!long && long.opacity === 1 && !(await balloon()), JSON.stringify(long));
        }
        if (!narrow && category === 'automation' && tab === 'status') { await p.mouse.move(0, 0); await el(sheet).screenshot({ path: path.join(shots, scene + '-status.png') }); }
        if (narrow && percent === 150 && mode === 'dark' && category === 'display' && touch && !flip) {
          const glyph = await rect('info-glyph-setting-ui-scale');
          await el('info-glyph-setting-ui-scale').scrollIntoViewIfNeeded();
          const g = await rect('info-glyph-setting-ui-scale');
          await touchAt('touchStart', g.left + g.width / 2, g.top + g.height / 2); await p.waitForTimeout(150);
          await p.screenshot({ path: path.join(shots, scene + '-balloon-display.png') });
          await touchAt('touchEnd'); await p.waitForTimeout(100);
          log.push({ scene, shot: 'display', glyph });
        }
        if (flip && category === 'display') {
          // No room above: the row's ⓘ near the top of the sheet; the balloon goes below the finger instead.
          await p.evaluate(() => document.querySelector('[data-testid="setting-open-in"]').scrollIntoView({ block: 'start' }));
          await p.waitForTimeout(200);
          const g = await rect('info-glyph-setting-open-in'), x = g.left + g.width / 2, y = g.top + g.height / 2;
          await touchAt('touchStart', x, y); await p.waitForTimeout(150);
          const b = await balloon(); log.push({ scene, flip: { x, y, b } });
          await p.screenshot({ path: path.join(shots, scene + '-balloon-below.png') });
          await touchAt('touchEnd'); await p.waitForTimeout(100);
          check(scene, 'no room above: the balloon 32 below the finger, inside the window', !!b && y - 32 - b.height < 16 && b.top >= y + 32 - 1 && b.bottom <= height - 16 + .5,
            JSON.stringify({ y, b }));
        }
        if (pointer && category === 'display') {
          // The narrow web window: a resting pointer shows it, leaving hides it; Tab's focus shows it, Escape hides it and keeps the sheet.
          const g = await rect('info-glyph-setting-theme');
          await p.mouse.move(g.left + g.width / 2, g.top + g.height / 2); await p.waitForTimeout(150);
          const hovered = await balloon();
          await p.mouse.move(0, 0); await p.waitForTimeout(150);
          check(scene, 'pointer resting on ⓘ: shown; moved away: gone', hovered?.text === m.themeHelp && !(await balloon()), JSON.stringify(hovered));
          let focused = null;
          for (let i = 0; i < 12 && focused !== 'info-setting-theme'; i++) { await p.keyboard.press('Tab'); focused = await p.evaluate(() => document.activeElement?.dataset?.testid ?? null); }
          await p.waitForTimeout(100);
          const byKey = await balloon();
          await p.keyboard.press('Escape'); await p.waitForTimeout(200);
          check(scene, 'Tab onto ⓘ: shown; Escape: gone, the sheet still open', focused === 'info-setting-theme' && byKey?.text === m.themeHelp && !(await balloon())
            && await el(sheet).isVisible(), JSON.stringify({ focused, byKey }));
        }
        if (pointer && category === 'automation' && tab === 'status') {
          // Changing tab, the app going to the back and closing the sheet each put it away.
          const hover = async id => { const g = await rect(id); await p.mouse.move(g.left + g.width / 2, g.top + g.height / 2); await p.waitForTimeout(150); return await balloon(); };
          const before = await hover('info-glyph-setting-auto-refresh');
          await el('automation-tab-status').focus(); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(200);
          const tabbed = await balloon();
          await press('automation-tab-cards');
          const shown = await hover('info-glyph-setting-auto-cards');
          await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
          await p.waitForTimeout(200);
          const away = await balloon();
          await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
          await p.mouse.move(0, 0); await p.waitForTimeout(100);
          const again = await hover('info-glyph-setting-auto-cards');
          await el('settings-close').focus(); await p.keyboard.press('Escape');
          const gone = await p.waitForSelector(byId(sheet), { state: 'detached', timeout: 3000 }).then(() => true, () => false);
          const closed = gone ? await balloon() : 'sheet still open';
          check(scene, 'tab change, the app away and closing put the balloon away', !!before && !tabbed && !!shown && !away && !!again && !closed,
            JSON.stringify({ before: !!before, tabbed, shown: !!shown, away, again: !!again, closed }));
          await open('automation', 'status');
        }
      }
      check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    } catch (error) {
      check(scene, 'ran to the end', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
    }
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'req161-geometry.json'), JSON.stringify(log, null, 1) + '\n');
}
