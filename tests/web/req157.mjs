// REQ-157: the check up's list by family — a lead's sub-cards under it, moved in with a thin guide line, or under the lead's heading
// (a crown, its short name and workspace, a tick for its sub-cards only) when the lead is not a candidate in that group; a card whose
// parent is not read stays flat. "Select all" and a group's tick take the group's cards as before. Only real taps and pointer presses;
// nothing is written (no Done, no Archive). The boards are `req157Reads` in run.mjs.
import fs from 'node:fs';
import path from 'node:path';

export const R157T = { lead: 'Lead-02_example_Opus', s1: 'Release script dry run', s2: 'Report wording', s3: 'Release notes check',
  solo: 'Licence decision', stray: 'Old migration note', leadTwo: 'Lead-07_second_Sonnet', subTwo: 'Second board leftover' };
/** What each group shows, top to bottom: a row's title, or "# " and a heading's short name. */
const WANT = {
  orphaned: [R157T.leadTwo, '  ' + R157T.subTwo, '# Lead-02', '  ' + R157T.s1],
  stalled: [R157T.solo, '# Lead-02', '  ' + R157T.s3, '  ' + R157T.s2, R157T.stray],
};

export async function req157Scenes({ browser, page, out, check, byId, clickAt, copy }) {
  const geometry = [];
  const cases = [[390, true, 100, 'ko', 'light'], [390, true, 100, 'ko', 'dark'], [390, true, 150, 'en', 'light'], [390, true, 150, 'ko', 'dark'],
    [390, true, 150, 'en', 'dark'], [360, true, 150, 'en', 'light'], [1920, false, 100, 'ko', 'light'], [1920, false, 100, 'en', 'dark'], [1920, false, 150, 'en', 'light']];
  for (const [W, mobile, percent, lang, mode] of cases) {
    const m = copy(lang), k = percent / 100, scene = `req157-${mobile ? 'phone' : 'wide'}-${W}-${percent}-${lang}-${mode}`, H = mobile ? 780 : 1080;
    const context = await browser.newContext(mobile ? { viewport: { width: W, height: H }, hasTouch: true, isMobile: true } : { viewport: { width: W, height: H } });
    const p = await context.newPage(); p.setDefaultTimeout(5000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const press = async sel => { await p.locator(sel).first().scrollIntoViewIfNeeded(); await p.waitForTimeout(100);
      if (mobile) await p.locator(sel).first().tap(); else await clickAt(p, sel); await p.waitForTimeout(250); };
    const text = async sel => (await p.locator(sel).first().textContent())?.trim() ?? '';
    const ticked = sel => p.locator(sel).first().getAttribute('aria-checked');
    try {
      await p.goto(page(mode, mobile, `req157-${percent}-${lang}`));
      const countSel = mobile ? byId('open-settings-badge') : byId('checkup-count');
      await p.waitForSelector(byId(mobile ? 'mobile-swimlane-screen' : 'checkup-button'), { timeout: 15000 });
      check(scene, 'seven cards found', await p.waitForFunction(sel => document.querySelector(sel)?.textContent?.trim() === '7', countSel, { timeout: 10000 })
        .then(() => true, () => false), await text(countSel).catch(() => 'none'));
      if (mobile) { await press(byId('open-settings')); await p.waitForSelector(byId('settings-checkup')); await press(byId('settings-checkup')); }
      else await press(byId('checkup-button'));
      await p.waitForSelector(byId('checkup-sheet')); await p.waitForTimeout(400);
      const sheet = await p.locator(byId('checkup-sheet')).first().boundingBox();
      // Each group's children in order: rows (title, left edge, ticked) and headings (name, left edge, tick).
      const shape = () => p.evaluate(() => Object.fromEntries(['orphaned', 'stalled'].map(rule => {
        const group = document.querySelector(`[data-testid="checkup-group-${rule}"]`);
        const items = group ? [...group.querySelectorAll('[data-testid^="checkup-row-"], [data-testid="checkup-lead"]')]
          .filter(e => e.dataset.testid === 'checkup-lead' || /^checkup-row-[a-z]+-\d+$/.test(e.dataset.testid)) : [];
        return [rule, items.map(e => {
          const r = e.getBoundingClientRect(), lead = e.dataset.testid === 'checkup-lead';
          const tick = e.querySelector(lead ? '[data-testid="checkup-lead-tick"]' : '[data-testid="checkup-tick"]');
          const words = lead ? e.querySelector('[data-testid="checkup-lead-name"]') : null;
          return { lead, id: e.dataset.testid, x: r.x, y: r.y, w: r.width, h: r.height, tick: tick?.getAttribute('aria-checked'),
            name: lead ? (words?.textContent ?? '') + (e.querySelector('[data-testid="checkup-lead-workspace"]')?.textContent ?? '') : (e.querySelector('[data-testid="checkup-title"]')?.getAttribute('aria-label') ?? '').replace(/^[^:]*: /, ''),
            whole: words ? words.scrollWidth <= words.clientWidth + 1 && words.scrollHeight <= words.clientHeight + 1 : true, label: e.getAttribute('aria-label') ?? '',
            guide: !!e.querySelector(':scope > [data-testid="checkup-guide"]') };
        })];
      })));
      const now = await shape();
      for (const rule of ['orphaned', 'stalled']) {
        const items = now[rule], base = items.find(i => !i.lead)?.x ?? 0;
        const drawn = items.map(i => i.lead ? '# ' + i.name.split(' · ')[0] : (Math.abs(i.x - base) > 2 ? '  ' : '') + i.name);
        check(scene, `${rule}: each family together, sub-cards under their lead`, JSON.stringify(drawn) === JSON.stringify(WANT[rule]), JSON.stringify(drawn));
        const indent = (mobile ? 24 : 30) * k;
        check(scene, `${rule}: a sub-card moved in by one level, a heading and a card on their own at the same edge`, items.every(i =>
          WANT[rule][items.indexOf(i)]?.startsWith('  ') ? Math.abs(i.x - base - indent) <= 1.5 && i.guide : Math.abs(i.x - base) <= 1.5 && !i.guide),
          JSON.stringify(items.map(i => [i.name.slice(0, 12), Math.round((i.x - base) * 10) / 10, i.guide])));
        check(scene, `${rule}: everything inside the window`, items.every(i => i.x >= sheet.x - .5 && i.x + i.w <= sheet.x + sheet.width + .5), JSON.stringify(items.map(i => [i.x, i.w])));
        const heads = items.filter(i => i.lead);
        check(scene, `${rule}: the heading names the lead (whole) and its workspace, for a screen reader too`, heads.length === 1
          && heads[0].name === 'Lead-02 · Example Workspace' && heads[0].whole && heads[0].tick === 'false'
          && heads[0].label === m.checkupLeadHead(R157T.lead, rule === 'stalled' ? 2 : 1), JSON.stringify(heads));
        geometry.push({ scene, rule, sheet, items });
      }
      check(scene, 'the page no wider than the screen', await p.evaluate(() => document.documentElement.scrollWidth) <= W + 1);
      await p.screenshot({ path: path.join(out, `${scene}-list.png`) });
      // "Select all" in a group: its four cards, the heading's two among them — as before, whatever the families.
      await press(byId('checkup-group-all-stalled'));
      let s = await shape();
      check(scene, '"Select all" takes the group\'s four cards, the heading ticked with them', s.stalled.filter(i => !i.lead && i.tick === 'true').length === 4
        && s.stalled.find(i => i.lead).tick === 'true' && s.orphaned.every(i => i.tick === 'false'), JSON.stringify(s.stalled.map(i => [i.name.slice(0, 10), i.tick])));
      await press(byId('checkup-group-all-stalled'));
      // The heading's tick: its two sub-cards only; the group's tick some.
      await press(`${byId('checkup-group-stalled')} ${byId('checkup-lead-tick')}`);
      s = await shape();
      check(scene, 'the heading\'s tick takes its two sub-cards only', JSON.stringify(s.stalled.filter(i => !i.lead && i.tick === 'true').map(i => i.name)) === JSON.stringify([R157T.s3, R157T.s2])
        && await ticked(byId('checkup-group-tick-stalled')) === 'mixed', JSON.stringify(s.stalled.map(i => [i.name.slice(0, 10), i.tick])));
      check(scene, 'the bottom row counts them', mobile ? await text(byId('checkup-done')) === m.checkupDoneCount(2) : await text(byId('checkup-selected')) === m.checkupSelected(2),
        mobile ? await text(byId('checkup-done')) : await text(byId('checkup-selected')));
      await p.screenshot({ path: path.join(out, `${scene}-heading-ticked.png`) });
      await press(`${byId('checkup-group-stalled')} [data-testid^="checkup-row-stalled-"]:has-text("${R157T.s2}") ${byId('checkup-tick')}`);
      check(scene, 'one of them off: the heading says some', await ticked(`${byId('checkup-group-stalled')} ${byId('checkup-lead-tick')}`) === 'mixed');
      // A lead that is a candidate keeps a tick of its own: it takes that card alone.
      await press(`${byId('checkup-group-orphaned')} [data-testid="checkup-row-orphaned-0"] ${byId('checkup-tick')}`);
      s = await shape();
      check(scene, 'a lead\'s own tick takes the lead alone', JSON.stringify(s.orphaned.filter(i => i.tick === 'true').map(i => i.name)) === JSON.stringify([R157T.leadTwo]),
        JSON.stringify(s.orphaned.map(i => [i.name.slice(0, 10), i.tick])));
      check(scene, 'nothing written', await p.evaluate(() => window.__inputs.filter(v => v.name === 'kanban.v1.board.mutate').length) === 0);
    } catch (error) {
      check(scene, 'stopped by an error', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
    }
    check(scene, 'no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'req157-geometry.json'), JSON.stringify(geometry, null, 1) + '\n');
}
