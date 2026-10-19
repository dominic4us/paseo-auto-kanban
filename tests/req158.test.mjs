// REQ-158 (research/493): Paseo's left-menu Kanban opens the main screen by default; the Display setting "Open from the left
// menu" can send it to the right panel (REQ-152's Explorer tab) on this device, which still falls back to the main screen
// without a workspace, in a narrow window, or when the panel cannot open. The real registration (index.client.tsx) and the
// real sidebar/settings modules run here; the host is a recording mock, and the screens are stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const KEY = 'paseo-kanban:open-in:host_example';
const WORKSPACE = ['/h/host_example', 'workspace', 'wks_example01'].join('/');

/** A browser's storage; `broken` throws as private browsing may. */
function storage(initial = {}, broken = false) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => { if (broken) throw new Error('denied'); return values.get(key) ?? null; },
    setItem: (key, value) => { if (broken) throw new Error('denied'); values.set(key, String(value)); } };
}
/** Loads the client fresh (module state included), as a reload of the app does. */
function load({ os = 'web', pathname = WORKSPACE, store = storage() } = {}) {
  const platform = { OS: os };
  globalThis.window = { location: { pathname } };
  globalThis.localStorage = store;
  const mocks = {
    'react-native': { Platform: platform, Pressable: 'Pressable', Text: 'Text', View: 'View',
      Appearance: { getColorScheme: () => null, addChangeListener: () => ({ remove() {} }) } },
    '@getpaseo/plugin/client': { useRpc: () => async () => ({}) },
    '@getpaseo/plugin/client/react-native': { Icon: 'Icon' },
  };
  const standins = { 'client/overview': { OverviewScreen() {} }, 'client/panel': { WorkspacePanel() {} },
    'client/explorer-panel': { ExplorerPanel() {} } };
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const localRequire = id => {
      if (mocks[id]) return mocks[id];
      if (!id.startsWith('.')) return nativeRequire(id);
      const target = path.resolve(path.dirname(file), id.replace(/\.js$/, ''));
      const standin = standins[path.relative(path.resolve('.'), target)];
      if (standin) return standin;
      return load(['.ts', '.tsx'].map(ext => target + ext).find(name => fs.existsSync(name)));
    };
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  };
  return { platform, store, entry: load(path.resolve('index.client.tsx')).default, settings: load(path.resolve('client/open-location.ts')) };
}
/** The host: what Kanban registered and every navigation it asked for. */
function host({ api = 'new', panelFails = false } = {}) {
  const registered = [], calls = [];
  const register = kind => value => { registered.push({ kind, ...value }); return () => { registered.splice(registered.findIndex(row => row.id === value.id && row.kind === kind), 1); }; };
  const client = {
    addSurface: (id, Component) => register('surface')({ id, Component }), addSidebarItem: register('sidebar'),
    addWorkspacePanel: register('panel'), addCommandCenterItem: register('command'),
    openPanel: (id, options) => { calls.push({ kind: 'panel', id, options }); if (panelFails) throw new Error('Explorer is unavailable'); },
    ...(api === 'new' ? { addSidebarHeaderItem: register('sidebar-header') } : {}),
    ...(api === 'new' || api === 'footer' ? { addSidebarFooterItem: register('sidebar-footer') } : {}),
  };
  return { client, registered, calls };
}
/** Presses the left menu's Kanban once. */
function press(h, { compact = false } = {}) {
  const item = h.registered.find(row => row.kind.startsWith('sidebar-'));
  const props = { host: { id: 'host_example' }, layout: { platform: 'web', compact }, theme: { colors: {} }, currentScreen: null,
    openScreen: input => h.calls.push({ kind: 'screen', ...input }) };
  item.Component(props).props.onPress();
  return h.calls.splice(0);
}
const PANEL = { kind: 'panel', id: 'explorer', options: { workspaceId: 'wks_example01', location: 'explorer' } };
const MAIN = { kind: 'screen', screenId: 'overview' };

test('REQ-158 ① by default the left menu opens the main screen, even with a workspace open in a wide window', () => {
  const app = load(), h = host();
  app.entry(h.client);
  assert.deepEqual(press(h), [MAIN], 'the main screen, never the right panel');
  assert.equal(app.settings.readOpenLocation('host_example'), 'main');
  assert.equal(app.store.values.size, 0, 'nothing is written by pressing');
});
test('REQ-158 ② "Right panel" opens the current workspace\'s Explorer tab, as REQ-152 did', () => {
  for (const api of ['new', 'footer']) {
    const app = load({ store: storage({ [KEY]: 'panel' }) }), h = host({ api });
    app.entry(h.client);
    assert.deepEqual(press(h), [PANEL], api);
  }
});
test('REQ-158 ③ "Right panel" still opens the main screen without a workspace, in a narrow window, or when the panel fails', () => {
  const saved = { [KEY]: 'panel' };
  for (const pathname of ['/h/host_example', ['/h/other-host', 'workspace', 'wks_example01'].join('/'),
    ['/h/host_example', 'workspace', '%2Flegacy%2Ffolder'].join('/')]) {
    const app = load({ pathname, store: storage(saved) }), h = host();
    app.entry(h.client);
    assert.deepEqual(press(h), [MAIN], pathname);
  }
  let app = load({ store: storage(saved) }), h = host();
  app.entry(h.client);
  assert.deepEqual(press(h, { compact: true }), [MAIN], 'a narrow window (phone browser) has no right panel');
  app = load({ store: storage(saved) }); h = host({ panelFails: true });
  app.entry(h.client);
  assert.deepEqual(press(h), [PANEL, MAIN], 'the panel refused: the main screen keeps Kanban reachable');
});
test('REQ-158 ④ phone apps and older hosts keep the legacy menu item, and the setting is not offered there', () => {
  for (const os of ['ios', 'android']) {
    const app = load({ os, store: storage({ [KEY]: 'panel' }) }), h = host();
    app.entry(h.client);
    assert.deepEqual(h.registered.filter(row => row.kind.startsWith('sidebar')).map(({ Component, ...row }) => row),
      [{ kind: 'sidebar', id: 'overview', title: 'Kanban', icon: 'Columns3', surface: 'overview' }], os);
    assert.equal(app.settings.sidebarCanOpenPanel(), false, os + ': no right panel, so no choice');
  }
  const app = load(), h = host({ api: 'old' });
  app.entry(h.client);
  assert.deepEqual(h.registered.filter(row => row.kind.startsWith('sidebar')).map(row => row.kind), ['sidebar']);
  assert.equal(app.settings.sidebarCanOpenPanel(), false, 'an older web host opens the main screen whatever is chosen');
});
test('REQ-158 ⑤ the choice is offered while a newer web host registered the menu, and withdrawn with it', () => {
  const app = load(), h = host();
  assert.equal(app.settings.sidebarCanOpenPanel(), false);
  const cleanup = app.entry(h.client);
  assert.equal(app.settings.sidebarCanOpenPanel(), true);
  cleanup();
  assert.equal(app.settings.sidebarCanOpenPanel(), false);
});
test('REQ-158 ⑥ Command Center: the overview and the workspace board stay; the right-panel command says where it opens', () => {
  for (const os of ['web', 'ios']) {
    const app = load({ os }), h = host();
    app.entry(h.client);
    const commands = h.registered.filter(row => row.kind === 'command');
    assert.deepEqual(commands.map(row => [row.id, row.title, row.context]), [
      ['overview', 'Kanban: Overview', 'global'], ['board', 'Kanban: Workspace board', 'workspace'],
      ...(os === 'web' ? [['explorer', 'Kanban: Open in right panel', 'workspace']] : [])], os);
    const opened = [];
    commands.find(row => row.id === 'overview').onSelect({ openSurface: id => opened.push(['surface', id]) });
    commands.find(row => row.id === 'explorer')?.onSelect({ openPanel: (id, options) => opened.push(['panel', id, options]) });
    assert.deepEqual(opened, [['surface', 'overview'], ...(os === 'web' ? [['panel', 'explorer', { location: 'explorer' }]] : [])]);
    // REQ-152's Explorer tab (beside Files and Changes) and the chat-row board tab are both still registered.
    const panels = h.registered.filter(row => row.kind === 'panel').map(row => [row.id, row.title, JSON.stringify(row.locations)]);
    assert.deepEqual(panels, [['board', 'Kanban', undefined], ['explorer', 'Kanban', '["explorer"]']]);
  }
});
test('REQ-158 ⑦ the choice is kept on this device, per host, survives a reload and is read at each press', () => {
  const store = storage();
  let app = load({ store }), h = host();
  app.entry(h.client);
  app.settings.writeOpenLocation('host_example', 'panel');
  assert.equal(store.values.get(KEY), 'panel');
  assert.deepEqual(press(h), [PANEL], 'a menu item drawn before the change follows it');
  assert.equal(app.settings.readOpenLocation('host_other'), 'main', 'another host keeps its own choice');
  app = load({ store }); h = host();
  app.entry(h.client);
  assert.equal(app.settings.readOpenLocation('host_example'), 'panel', 'restored after a reload');
  assert.deepEqual(press(h), [PANEL]);
  app.settings.writeOpenLocation('host_example', 'main');
  assert.equal(store.values.get(KEY), 'main');
  assert.deepEqual(press(h), [MAIN]);
  for (const damaged of ['right', '', 'PANEL']) {
    app = load({ store: storage({ [KEY]: damaged }) });
    assert.equal(app.settings.readOpenLocation('host_example'), 'main', JSON.stringify(damaged) + ' reads as the default');
  }
  // Private browsing: the choice holds until the app reloads, and the press never throws.
  app = load({ store: storage({}, true) }); h = host();
  app.entry(h.client);
  app.settings.writeOpenLocation('host_example', 'panel');
  assert.equal(app.settings.readOpenLocation('host_example'), 'panel');
  assert.deepEqual(press(h), [PANEL]);
});
test('REQ-158 ⑧ a change made in another window of this browser is read at the next press', () => {
  const store = storage(), app = load({ store }), h = host();
  app.entry(h.client);
  app.settings.writeOpenLocation('host_example', 'panel');
  store.values.set(KEY, 'main');
  assert.deepEqual(press(h), [MAIN], 'the stored value wins over this window\'s memory');
});
