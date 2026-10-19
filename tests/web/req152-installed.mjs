// Gate 459: actual installed Paseo 0.11.2 functions, not an idealised ref().current() mock.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import { createRequire } from 'node:module';
const jsx = createRequire(import.meta.url)('react/jsx-runtime');
import * as zod from 'zod';

export async function runInstalledSidebar({ root, out, check }) {
  // Optional local copies of installed app code are deliberately kept outside Git.
  const fixtureDir = process.env.KANBAN_REQ152_INSTALLED_DIR || path.join(os.homedir(), '.cache/paseo-auto-kanban/req152-installed');
  let fixtureText;
  try {
    fixtureText = fs.readFileSync(path.join(fixtureDir, 'req152-installed-0.11.2.json'), 'utf8');
    fs.accessSync(path.join(fixtureDir, 'req152-paseo-LICENSE'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('건너뜀: 로컬 고정 자료 없음');
    return;
  }
  const fixture = JSON.parse(fixtureText);
  const source = name => {
    const item = fixture.sources[name];
    if (createHash('sha256').update(item.code).digest('hex') !== item.sha256) throw new Error('Host fixture changed: ' + name);
    return item.code;
  };
  const evaluate = (code, dependencies, globals = {}) => {
    const exported = {}, context = vm.createContext({ console, AbortController, ...globals,
      __d: (factory, _id, ids) => factory({}, id => dependencies[ids.indexOf(id)], {}, {}, {}, exported, ids) });
    vm.runInContext(code, context);
    return exported;
  };
  const compiled = await build({ entryPoints: [path.join(root, 'index.client.tsx')], write: false, bundle: true,
    format: 'cjs', platform: 'neutral', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client/react-native'],
    plugins: [{ name: 'registration-only-screen-standins', setup(builder) {
      builder.onResolve({ filter: /\.\/client\/(overview|panel|explorer-panel)\.js$/ }, args => ({ path: args.path, namespace: 'standin' }));
      builder.onLoad({ filter: /.*/, namespace: 'standin' }, () => ({ loader: 'js', contents:
        'export function OverviewScreen(){}; export function WorkspacePanel(){}; export function ExplorerPanel(){};' }));
    } }] });
  const bundle = '(function(require){var module={exports:{}};var exports=module.exports;' + compiled.outputFiles[0].text + ';return module.exports;})';
  const sdkModule = evaluate(source('installed-sdk-api.js'), [
    { __esModule: true, default: (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key))) },
    {}, { createTerminalActions: () => ({}) },
  ]);
  const workspace = { id: 'wks_example01', projectId: 'project_example', workspaceDirectory: '/synthetic/example', status: 'active', name: 'Example Workspace' };
  let reads = 0;
  const sdk = sdkModule.createPaseoApi({ fetchWorkspaces: async () => { reads++; return { entries: [workspace], pageInfo: { nextCursor: null } }; } });
  const native = { Platform: { OS: 'web' }, Pressable: 'Pressable', Text: 'Text', View: 'View' };
  // REQ-158: the F2 rows press the menu after this device chose "Right panel" (client/settings.ts); the last row clears it.
  const choices = new Map([['paseo-kanban:open-in:host_example', 'panel']]);
  const environment = { window: { location: { pathname: ['/h/host_example', 'workspace', 'wks_example01'].join('/') } },
    localStorage: { getItem: key => choices.get(key) ?? null, setItem: (key, value) => choices.set(key, value) } };
  const registration = evaluate(source('host-0.11.2-installed-registration.js'), [
    {}, {}, {}, {}, {}, React, jsx, native, {}, {}, { resolvePluginIcon: () => {} }, { pluginReactNativeRuntime: { Icon: () => null } }, {},
  ], environment);
  const locations = evaluate(source('eresolvePluginPanelOpenLocation.js'), [{}, {}, {}]);
  const parseScreen = (_plugin, input) => ({ screenId: typeof input === 'string' ? input : input.screenId, params: input.params });
  const capabilities = evaluate(source('ecreatePluginCapabilities.js'), [{}, locations, { parsePluginOpenScreenInput: parseScreen }]);
  const model = evaluate(source('mobile-target-1.js'), [{}, zod]);
  let state;
  const create = () => initialize => {
    const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
    state = initialize(set);
    const store = selector => selector(state); store.getState = () => state; return store;
  };
  const panelStore = evaluate(source('mobile-target-0.js'), [{ create }, { persist: initialize => initialize }, {}, {}, model,
    { isWeb: true }, { createValidatedPersistStorage: () => ({}) }]).usePanelStore;
  let routes = [], workspaceNavigations = [], shown = [], isOpen = false, closed = 0;
  const routeFor = (host, plugin, target) => `/h/${host}/plugin/${plugin}/${target.kind}/${target.id}`;
  const hostNavigation = evaluate(source('ecreatePluginNavigation.js'), [{}, { router: { push: value => routes.push(value) } },
    { navigateToWorkspace: value => workspaceNavigations.push(value) },
    { useWorkspaceLayoutStore: { getState: () => ({ showExplorerSidebar: key => { shown.push({ key, wasOpen: isOpen }); isOpen = true; return 'explorer-pane'; } }) } },
    { buildPluginSurfaceRoute: routeFor },
  ]);
  const globalNavigation = hostNavigation.createPluginNavigation({ serverId: 'host_example', workspaceId: null });
  const workspaceNavigation = hostNavigation.createPluginNavigation({ serverId: 'host_example', workspaceId: workspace.id });
  const plugin = { id: 'kanban', serverId: 'host_example', paseo: sdk,
    workspacePanels: [{ id: 'explorer', context: 'workspace', locations: ['explorer'] }] };
  const calls = [];
  const runtime = registration.runPluginClientBundle('kanban', bundle, {
    paseo: sdk, openSurface: id => { calls.push({ kind: 'direct-surface', id }); globalNavigation.openSurface('kanban', id); },
    openPanel: (id, options) => {
      calls.push({ kind: 'panel', id, options });
      const context = capabilities.createPluginWorkspaceActionContext({ plugin, navigation: workspaceNavigation,
        state: { getWorkspace: id => id === workspace.id ? workspace : null }, workspaceId: options.workspaceId });
      if (!context) throw new Error('Plugin panel context is unavailable');
      context.openPanel(id, { location: options.location });
    },
  });
  const Component = runtime.sidebarItems.header[0].Component;
  const closeSidebar = () => { closed++; panelStore.getState().showMobileAgent(); };
  // Execute the installed sidebar consumer's exact openScreen callback, including onBeforeNavigate.
  const consumer = source('sidebar-consumer-PluginSidebarItem-0.js');
  const callback = consumer.match(/U=(e=>\{const\{screenId:n,params:o\}=[\s\S]*?\}),n\[13\]=A/);
  if (!callback) throw new Error('Installed sidebar openScreen callback changed');
  const openScreen = vm.runInNewContext('(' + callback[1] + ')', {
    x: { parsePluginOpenScreenInput: parseScreen }, t: plugin,
    S: { pluginScreensHostKey: id => id, rememberPluginContributionHost: () => {} }, _: () => {}, A: closeSidebar,
    s: { router: { push: route => routes.push(route) } }, I: { buildPluginSurfaceRoute: routeFor },
  });
  const props = { host: { id: 'host_example' }, layout: { platform: 'web', compact: false }, theme: { colors: {} }, currentScreen: null, openScreen };
  const reset = () => { routes = []; workspaceNavigations = []; shown = []; closed = 0; calls.length = 0; panelStore.getState().showMobileAgentList(); };
  const proof = { origin: fixture.origin, bundleSHA256: fixture.bundleSHA256, moduleHashes: Object.fromEntries(Object.entries(fixture.sources).map(([name, item]) => [name, item.sha256])), sdk: {}, rows: [] };
  try {
    for (const phase of ['fresh', 'after-list', 'after-other-handle-refresh']) {
      if (phase === 'after-list') await sdk.workspaces.list();
      if (phase === 'after-other-handle-refresh') {
        const other = sdk.workspaces.ref(workspace.id); await other.refresh();
        proof.sdk.refreshedHandle = other.current();
        check('req152-host-sdk', 'retained refreshed handle has the workspace', other.current()?.id === workspace.id);
      }
      const current = sdk.workspaces.ref(workspace.id).current();
      proof.sdk[phase] = current;
      check('req152-host-sdk', phase + ': a newly created actual handle has current null', current === null);
      for (const initiallyOpen of [false, true]) {
        reset(); isOpen = initiallyOpen;
        Component(props).props.onPress();
        const row = { phase, initiallyOpen, current, calls: structuredClone(calls), shown: structuredClone(shown), workspaceNavigations: structuredClone(workspaceNavigations), routes: [...routes] };
        proof.rows.push(row);
        check('req152-host-F2', phase + '/' + initiallyOpen + ': actual host opens Explorer despite new SDK handle current null',
          shown.length === 1 && shown[0].key === 'host_example:' + workspace.id && shown[0].wasOpen === initiallyOpen
          && workspaceNavigations.length === 1 && workspaceNavigations[0].target.panelId === 'explorer'
          && workspaceNavigations[0].placement.paneId === 'explorer-pane' && routes.length === 0, JSON.stringify(row));
      }
    }
    for (const alreadyOpen of [false, true]) {
      reset(); props.layout.compact = true; props.currentScreen = alreadyOpen ? { screenId: 'overview' } : null;
      Component(props).props.onPress();
      const visibleSidebar = model.selectIsAgentListOpen(state, { isCompact: true });
      const row = { alreadyOpen, closed, mobilePanel: structuredClone(state.mobilePanel), visibleSidebar, routes: [...routes], calls: structuredClone(calls) };
      proof.rows.push(row);
      check('req152-host-F1', 'compact/' + alreadyOpen + ': installed openScreen callback closes sidebar exactly once', closed === 1 && !visibleSidebar
        && state.mobilePanel.target === 'agent' && routes.length === 1 && calls.length === 0, JSON.stringify(row));
    }
    reset(); props.layout.compact = false; environment.window.location.pathname = ['/h/host_example', 'workspace', 'wks_missing'].join('/');
    Component(props).props.onPress();
    const row = { calls: structuredClone(calls), routes: [...routes], closed, workspaceNavigations: structuredClone(workspaceNavigations) };
    proof.rows.push(row);
    check('req152-host-unknown', 'actual host rejects unknown workspace; host openScreen handles fallback and close', closed === 1
      && routes.length === 1 && workspaceNavigations.length === 0 && calls.length === 1 && calls[0].kind === 'panel', JSON.stringify(row));
    // REQ-158: nothing chosen — the installed host's openScreen route, the panel never asked for, even with a workspace open.
    reset(); choices.clear(); environment.window.location.pathname = ['/h/host_example', 'workspace', 'wks_example01'].join('/');
    Component(props).props.onPress();
    const main = { calls: structuredClone(calls), routes: [...routes], closed, shown: structuredClone(shown), workspaceNavigations: structuredClone(workspaceNavigations) };
    proof.rows.push({ req158: 'default', ...main });
    check('req158-host-default', 'actual host: the default opens the main screen through openScreen, not the Explorer', calls.length === 0
      && shown.length === 0 && workspaceNavigations.length === 0 && routes.length === 1 && closed === 1, JSON.stringify(main));
    proof.daemonReads = reads;
  } finally {
    await runtime.cleanup(); await sdk.dispose();
    fs.writeFileSync(path.join(out, 'installed-host-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  }
}
