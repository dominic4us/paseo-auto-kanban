import fs from 'node:fs';
import path from 'node:path';
import { PASEO_THEMES } from '../../dist/client/palette.js';
import { autoCardsSet, autoCardsWorkspaceSet, archiveSettingsSet, uiStateSet } from '../../dist/shared/rpc.js';

const FIELDS = [
  { key: 'archive', tab: 'archive', control: 'auto-archive-7', rpc: 'kanban.v1.archive.settings.set' },
  { key: 'workspace', tab: 'cards', control: 'auto-cards-workspace-toggle-0', rpc: 'kanban.v1.auto_cards.workspace.set' },
  { key: 'global', tab: 'cards', control: 'auto-cards-toggle', rpc: 'kanban.v1.auto_cards.set' },
  { key: 'refresh', tab: 'status', control: 'auto-refresh-toggle', rpc: 'kanban.v1.ui.set' },
];
const CONTRACTS = [autoCardsSet, autoCardsWorkspaceSet, archiveSettingsSet, uiStateSet];
/** Table-driven real-input races. Without remount, B must be blocked by the existing saving-row lock. */
export async function req151Races({ browser, page, out, check, byId }) {
  const table = [], evidence = [];
  for (const field of FIELDS) for (const remount of [false, true]) for (const order of ['AB', 'BA'])
    for (const kind of ['both-refused', 'read-before-old-success']) table.push({ field, remount, order, kind });
  for (const order of ['AB', 'BA']) table.push({ field: FIELDS[1], remount: false, order, kind: 'workspace-merge' });
  for (const row of table) {
    const { field, remount, order, kind } = row;
    const scene = `req151-f3-${field.key}-${remount ? 'remount' : 'same'}-${order}-${kind}`;
    if (process.env.KANBAN_WEB_REQ151_RACE_SCENE && scene !== process.env.KANBAN_WEB_REQ151_RACE_SCENE) continue;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(() => {
      const state = { server: { days: 7, global: true, refresh: false, workspaceOff: [] }, plans: [], calls: [], releases: {}, reads: 0 };
      window.__req151Race = state;
      let original;
      Object.defineProperty(window, '__rpc', { configurable: true, set: v => { original = v; }, get: () => async (name, input) => {
        const setting = ['kanban.v1.archive.settings.set', 'kanban.v1.auto_cards.set', 'kanban.v1.auto_cards.workspace.set'].includes(name)
          || name === 'kanban.v1.ui.set' && Object.hasOwn(input.settings ?? {}, 'autoRefresh');
        if (!setting) {
          const reply = await original(name, input);
          if (reply.ok && ['kanban.v1.overview.get', 'kanban.v1.board.get'].includes(name)) {
            const server = state.server, data = reply.data;
            reply.data = { ...data, autoArchive: { days: server.days }, autoCards: server.global, autoCardsOff: [...server.workspaceOff],
              ...(data.ui ? { ui: { ...data.ui, settings: { ...data.ui.settings, autoRefresh: server.refresh } } } : {}),
              ...(data.settings ? { settings: { ...data.settings, autoRefresh: server.refresh } } : {}) };
            state.reads++;
          }
          return reply;
        }
        const at = state.plans.findIndex(p => p.rpc === name), plan = at < 0 ? { outcome: 'ok' } : state.plans.splice(at, 1)[0];
        const call = { name, input: structuredClone(input), plan, started: performance.now() }; state.calls.push(call);
        if (plan.outcome === 'ok') {
          if (name === 'kanban.v1.archive.settings.set') state.server.days = input.days;
          if (name === 'kanban.v1.auto_cards.set') state.server.global = input.enabled;
          if (name === 'kanban.v1.auto_cards.workspace.set') state.server.workspaceOff = input.enabled
            ? state.server.workspaceOff.filter(cwd => cwd !== input.cwd) : [...new Set([...state.server.workspaceOff, input.cwd])];
          if (name === 'kanban.v1.ui.set') state.server.refresh = input.settings.autoRefresh;
        }
        const reply = plan.outcome === 'ok' ? { ok: true, committed: false, warnings: [], data: name === 'kanban.v1.ui.set'
          ? { hiddenProjects: [], order: { projects: [], workspaces: [] }, settings: { autoRefresh: state.server.refresh }, changed: true }
          : { enabled: input.enabled, days: input.days, changed: true } }
          : { ok: false, committed: false, error: { code: 'E_LOCK_TIMEOUT', message: 'REQ-151 planned refusal before application', target: '', nextAction: 'Retry', details: null } };
        if (plan.hold) await new Promise(resolve => { state.releases[plan.key] = resolve; });
        call.ended = performance.now(); call.reply = structuredClone(reply); return reply;
      } });
    });
    const p = await context.newPage(); p.setDefaultTimeout(12000);
    const errors = []; p.on('pageerror', e => errors.push(String(e)));
    const el = id => p.locator(byId(id)).first(), press = async id => { await el(id).scrollIntoViewIfNeeded(); await el(id).click(); };
    const settings = async () => { await press('open-settings'); await press('settings-tab-automation'); await press('automation-tab-' + field.tab); };
    const save = async (key, outcome, hold, day, control) => {
      const n = await p.evaluate(() => window.__req151Race.calls.length);
      await p.evaluate(plan => { window.__req151Race.plans.push(plan); }, { rpc: field.rpc, outcome, hold, key });
      await press(control ?? (field.key === 'archive' ? 'auto-archive-' + day : field.control));
      await p.waitForFunction(n => window.__req151Race.calls.length > n, n);
      if (!hold) await el('setting-saving').waitFor({ state: 'detached' });
    };
    const inspect = async phase => {
      const current = field.key === 'archive' ? await p.locator('[data-testid^="auto-archive-"][aria-checked="true"]').getAttribute('data-testid')
        : await el(field.control).getAttribute('aria-checked');
      const data = await p.evaluate(() => ({ server: structuredClone(window.__req151Race.server), calls: structuredClone(window.__req151Race.calls), reads: window.__req151Race.reads }));
      const cwd = data.calls.find(c => c.name === 'kanban.v1.auto_cards.workspace.set')?.input.cwd;
      const expected = field.key === 'archive' ? 'auto-archive-' + data.server.days : String(field.key === 'global' ? data.server.global
        : field.key === 'refresh' ? data.server.refresh : !data.server.workspaceOff.includes(cwd));
      evidence.push({ scene, phase, row: { field: field.key, remount, order, kind }, current, expected, ...data });
      check(scene, 'F3 ' + phase + ': shown value equals authoritative server value', current === expected, JSON.stringify(evidence.at(-1)));
    };
    const fresh = async () => {
      await press('settings-close'); await el('settings-window').waitFor({ state: 'detached' });
      const before = await p.evaluate(() => window.__req151Race.reads);
      await p.getByRole('button', { name: 'Refresh', exact: true }).first().click();
      await p.waitForFunction(n => window.__req151Race.reads > n, before); await settings(); await p.waitForTimeout(150);
    };
    try {
      await p.goto(page('light', false, 'req151-100-en-normal')); await settings();
      if (field.key === 'archive') await save('initial', 'ok', false, 7);
      else { await save('initial-1', 'ok', false); await save('initial-2', 'ok', false); }
      await inspect('initial-confirmed');
      if (kind === 'workspace-merge') {
        await save('A', 'ok', true);
        await save('B', 'ok', true, undefined, 'auto-cards-workspace-toggle-1');
        for (const key of order) { await p.evaluate(key => { window.__req151Race.releases[key](); }, key);
          await p.waitForFunction(key => window.__req151Race.calls.some(c => c.plan.key === key && c.ended !== undefined), key); }
        await el('setting-saving').waitFor({ state: 'detached' }); await inspect('parallel-confirmed');
        check(scene, 'independent workspace confirmations merge in either order', await el('auto-cards-workspace-toggle-0').getAttribute('aria-checked') === 'false'
          && await el('auto-cards-workspace-toggle-1').getAttribute('aria-checked') === 'false');
        await fresh(); await inspect('parallel-after-read');
        await p.evaluate(() => { window.__req151Race.server.workspaceOff = []; }); await fresh(); await inspect('parallel-new-server-read');
        check(scene, 'server read resets both workspace confirmations', await el('auto-cards-workspace-toggle-0').getAttribute('aria-checked') === 'true'
          && await el('auto-cards-workspace-toggle-1').getAttribute('aria-checked') === 'true');
        check(scene, 'no page errors', !errors.length, errors.join(' | ')); continue;
      }
      await save('A', kind === 'both-refused' ? 'fail' : 'ok', true, 30);
      if (remount) {
        await p.evaluate(theme => window.__hostTheme(theme, true), PASEO_THEMES.dark);
        await el('settings-window').waitFor({ state: 'detached' }); await el('open-settings').waitFor(); await settings();
        check(scene, 'remount starts with an enabled control', await el(field.control).getAttribute('aria-disabled') !== 'true');
        await save('B', 'fail', true, 14);
      } else {
        check(scene, 'same instance blocks B while A is pending', await el(field.control).getAttribute('aria-disabled') === 'true');
        check(scene, 'blocked B sends no second request', await p.evaluate(() => !window.__req151Race.calls.some(c => c.plan.key === 'B')));
      }
      if (kind === 'read-before-old-success') {
        await p.evaluate(() => { const s = window.__req151Race.server; s.days = 7; s.global = true; s.refresh = false; s.workspaceOff = []; });
        await fresh(); await inspect('fresh-read-before-delivery');
      }
      for (const key of order) {
        const exists = await p.evaluate(key => !!window.__req151Race.releases[key], key);
        if (!exists) continue;
        await p.evaluate(key => { window.__req151Race.releases[key](); }, key);
        await p.waitForFunction(key => window.__req151Race.calls.some(c => c.plan.key === key && c.ended !== undefined), key);
      }
      await el('setting-saving').waitFor({ state: 'detached' }); await p.waitForTimeout(100); await inspect('after-deliveries');
      await fresh(); await inspect('after-refresh');
      // A newer server read must also replace a previously successful local confirmation, even when all earlier writes settled.
      await p.evaluate(() => { const s = window.__req151Race.server; s.days = 3; s.global = false; s.refresh = true; s.workspaceOff = ['/tmp/wks_req151_0']; });
      await fresh(); await inspect('server-changed-after-refresh');
      const calls = await p.evaluate(() => window.__req151Race.calls);
      const invalid = calls.filter(call => { const contract = CONTRACTS.find(c => c.name === call.name);
        return !contract?.input.safeParse(call.input).success || !contract?.output.safeParse(call.reply).success; });
      check(scene, 'all setting inputs and replies satisfy real RPC schemas', !invalid.length, JSON.stringify(invalid));
      check(scene, 'no page errors', !errors.length, errors.join(' | '));
      if (field.key === 'archive' && remount) await el('settings-window').screenshot({ path: path.join(out, scene + '.png'), animations: 'disabled', caret: 'hide' });
    } catch (error) { check(scene, 'F3 scene completed', false, String(error?.stack ?? error)); await p.screenshot({ path: path.join(out, scene + '-failure.png') }).catch(() => {}); }
    finally { await context.close(); }
  }
  fs.writeFileSync(path.join(out, 'req151-races.json'), JSON.stringify({ table: table.map(r => ({ ...r, field: r.field.key })), evidence }, null, 2) + '\n');
}
