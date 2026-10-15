import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PASEO_THEMES, contrast, palette, readable, resolveTheme, themeMode, fieldLine, selectedLine, FIELD_LINE_CONTRAST, FIELD_LINE_WIDTH } from '../dist/client/palette.js';
import { readUiState, writeUiState } from '../dist/server/ui-state.js';
import { uiStateSet } from '../dist/shared/rpc.js';

// REQ-70: 테마 4택 — Paseo (host colours), system, light, dark.
const TOKENS = ['surface0', 'surface1', 'surface2', 'border', 'foreground', 'foregroundMuted', 'accent', 'accentForeground',
  'statusSuccess', 'statusWarning', 'statusDanger'];
// A host in a tinted dark theme (Paseo's "Midnight") and one in its default light.
const midnight = { colors: { ...PASEO_THEMES.dark.colors, surface0: '#161820', surface1: '#1c1e27', surface2: '#252731',
  border: '#242636', foregroundMuted: '#9a9db0', accent: '#3b6fcf' } };
const hostLight = { colors: { ...PASEO_THEMES.light.colors } };

test('REQ-70 the built-in sets are Paseo 0.9.1 defaults with every PluginTheme token', () => {
  for (const mode of ['light', 'dark']) assert.deepEqual(Object.keys(PASEO_THEMES[mode].colors).sort(), [...TOKENS].sort());
  assert.equal(PASEO_THEMES.light.colors.surface0, '#ffffff');
  assert.equal(PASEO_THEMES.dark.colors.surface0, '#181B1A');
  assert.equal(themeMode(PASEO_THEMES.light), 'light');
  assert.equal(themeMode(PASEO_THEMES.dark), 'dark');
  assert.equal(themeMode(midnight), 'dark');
});

test('REQ-70 choosing the colour set: the host whenever it is already in the chosen mode', () => {
  for (const system of ['light', 'dark', null]) assert.equal(resolveTheme(midnight, 'paseo', system), midnight, 'Paseo is the host');
  assert.equal(resolveTheme(midnight, 'dark', null), midnight, 'dark on a dark host keeps its tint');
  assert.equal(resolveTheme(midnight, 'light', null), PASEO_THEMES.light);
  assert.equal(resolveTheme(hostLight, 'light', 'dark'), hostLight);
  assert.equal(resolveTheme(hostLight, 'dark', 'light'), PASEO_THEMES.dark);
  // System: the device's scheme, or the host when the device does not say.
  assert.equal(resolveTheme(midnight, 'system', 'light'), PASEO_THEMES.light);
  assert.equal(resolveTheme(midnight, 'system', 'dark'), midnight);
  assert.equal(resolveTheme(hostLight, 'system', 'dark'), PASEO_THEMES.dark);
  assert.equal(resolveTheme(hostLight, 'system', null), hostLight);
  assert.equal(resolveTheme(hostLight, 'system', undefined), hostLight);
  // Resolving twice changes nothing, so the board inside the Kanban screen can resolve again.
  for (const choice of ['paseo', 'system', 'light', 'dark']) for (const host of [midnight, hostLight]) {
    const once = resolveTheme(host, choice, 'light');
    assert.equal(resolveTheme(once, choice, 'light'), once, `${choice} on ${host.colors.surface0}`);
  }
});

test('REQ-70 ⑤ text keeps its contrast on both built-in sets (and the done colour on its card)', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]);
    for (const surface of ['surface0', 'surface1', 'surface2', 'card', 'panel', 'panelHeader'])
      assert.ok(contrast(c.foreground, c[surface]) >= 7, `${mode} foreground on ${surface}: ${contrast(c.foreground, c[surface])}`);
    for (const surface of ['surface0', 'card'])
      assert.ok(contrast(c.foregroundMuted, c[surface]) >= 4.5, `${mode} muted on ${surface}: ${contrast(c.foregroundMuted, c[surface])}`);
    assert.ok(contrast(c.accentForeground, c.accent) >= 4.5, `${mode} accent text`);
    assert.ok(contrast(c.stageDone, c.card) >= 3, `${mode} done on card: ${contrast(c.stageDone, c.card)}`);
    assert.ok(contrast(c.panel, c.surface0) >= 1.15 && contrast(c.card, c.panel) >= 1.15, `${mode} board planes separate`);
  }
});

test('D27 the quiet "+N" link and the card\'s "awaiting user" text clear 4.5:1 on the plane they actually sit on', () => {
  // QuietLink's resting colour sits on the column panel (not surface0); the card meta row sits on the card
  // face (which can differ from every surface token) — both are narrower planes than the built-in checks
  // above cover, so this exercises every theme choice across a light and a dark host.
  for (const choice of ['paseo', 'system', 'light', 'dark']) {
    for (const host of [hostLight, midnight]) {
      for (const system of ['light', 'dark']) {
        const theme = resolveTheme(host, choice, system);
        const c = palette(theme);
        const quietLink = readable(c.foregroundMuted, c.panel);
        const awaitingUser = readable(c.statusWarning, c.card);
        assert.ok(contrast(quietLink, c.panel) >= 4.5,
          `${choice}/${system} on ${host === midnight ? 'midnight' : 'light'} host: +N ${quietLink} on panel ${c.panel} = ${contrast(quietLink, c.panel).toFixed(3)}`);
        assert.ok(contrast(awaitingUser, c.card) >= 4.5,
          `${choice}/${system} on ${host === midnight ? 'midnight' : 'light'} host: awaiting-user ${awaitingUser} on card ${c.card} = ${contrast(awaitingUser, c.card).toFixed(3)}`);
      }
    }
  }
});

test('REQ-70 ② the theme is stored per host beside the other rows, never over them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-req70-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeUiState(dir, 'host_a', { hiddenProjects: ['prj_hidden'], order: { projects: ['prj_b'], workspaces: ['wks_c'] },
    settings: { boardAlign: 'left', autoRefresh: false } });
  const saved = await writeUiState(dir, 'host_a', { settings: { theme: 'dark' } });
  assert.equal(saved.changed, true);
  assert.deepEqual(await readUiState(dir, 'host_a'), { hiddenProjects: ['prj_hidden'], order: { projects: ['prj_b'], workspaces: ['wks_c'] },
    settings: { boardAlign: 'left', autoRefresh: false, theme: 'dark' } });
  assert.equal((await writeUiState(dir, 'host_a', { settings: { theme: 'dark' } })).changed, false, 'the same choice writes nothing');
  // Another host is untouched, and has the default (no field).
  await writeUiState(dir, 'host_b', { settings: { theme: 'system' } });
  assert.equal((await readUiState(dir, 'host_a')).settings.theme, 'dark');
  assert.deepEqual((await readUiState(dir, 'host_c')).settings, undefined);
  // A later row keeps the theme.
  await writeUiState(dir, 'host_a', { settings: { autoRefresh: true } });
  assert.equal((await readUiState(dir, 'host_a')).settings.theme, 'dark');
  // An unknown value in the file reads as the default.
  const file = JSON.parse(await readFile(join(dir, 'ui-state.json'), 'utf8'));
  file.hosts.host_b.settings.theme = 'sepia';
  await writeFile(join(dir, 'ui-state.json'), JSON.stringify(file));
  assert.deepEqual((await readUiState(dir, 'host_b')).settings, undefined);
});

test('REQ-70 the RPC accepts only the four choices', () => {
  const input = uiStateSet.input;
  for (const theme of ['paseo', 'system', 'light', 'dark'])
    assert.equal(input.safeParse({ hostId: 'host_a', settings: { theme } }).success, true, theme);
  assert.equal(input.safeParse({ hostId: 'host_a', settings: { theme: 'sepia' } }).success, false);
});

test('D28 the selected mobile stage tab reads at 4.5:1 on its own tab face, every stage colour', () => {
  for (const choice of ['paseo', 'system', 'light', 'dark']) {
    for (const host of [hostLight, midnight]) {
      for (const system of ['light', 'dark']) {
        const theme = resolveTheme(host, choice, system);
        const c = palette(theme);
        for (const [label, stageColor] of [['backlog', c.foregroundMuted], ['blue', c.stageBlue], ['purple', c.stagePurple], ['done', c.stageDone]]) {
          const tab = readable(stageColor, c.surface2);
          assert.ok(contrast(tab, c.surface2) >= 4.5,
            `${choice}/${system} on ${host === midnight ? 'midnight' : 'light'} host: ${label} tab ${tab} on ${c.surface2} = ${contrast(tab, c.surface2).toFixed(3)}`);
        }
      }
    }
  }
});

test('D28 the sheet drag handle clears 3:1 (no more opacity-.5 muted grey) and the row divider stays visible without a full border', () => {
  for (const choice of ['paseo', 'system', 'light', 'dark']) {
    for (const host of [hostLight, midnight]) {
      for (const system of ['light', 'dark']) {
        const c = palette(resolveTheme(host, choice, system));
        const handle = readable(c.foregroundMuted, c.surface0, 3);
        assert.ok(contrast(handle, c.surface0) >= 3, `${choice}/${system}: handle ${handle} on ${c.surface0} = ${contrast(handle, c.surface0).toFixed(3)}`);
        // The row divider stays a set colour (`c.divider`), not a synthesised one, so REQ-72's "chosen set only" holds.
        assert.ok(contrast(c.divider, c.surface0) >= 1.5, `${choice}/${system}: divider ${c.divider} on ${c.surface0} = ${contrast(c.divider, c.surface0).toFixed(3)}`);
      }
    }
  }
});

// REQ-88 ② replaces D28's field edge (3:1): the resting edge is faint and the main colour marks the field under the mouse and
// while typing, at the same 1px. The label above every field and that line are the boundary's cue instead.
test('REQ-88 ② (replaces D28) a field edge is faint at rest (≈1.5:1, never louder than 2:1) and the main colour at 3:1+ under the mouse', () => {
  for (const choice of ['paseo', 'system', 'light', 'dark']) {
    for (const host of [hostLight, midnight]) {
      for (const system of ['light', 'dark']) {
        const c = palette(resolveTheme(host, choice, system)), label = `${choice}/${system}`;
        const rest = fieldLine(c, c.surface1), active = selectedLine(c, c.surface1);
        assert.ok(contrast(rest, c.surface1) >= FIELD_LINE_CONTRAST && contrast(rest, c.surface1) < 2,
          `${label}: resting ${rest} on field ${c.surface1} = ${contrast(rest, c.surface1).toFixed(2)}`);
        assert.ok(contrast(active, c.surface1) >= 3, `${label}: hover/typing ${active} = ${contrast(active, c.surface1).toFixed(2)}`);
        assert.notEqual(rest, active);
        assert.ok(contrast(readable(c.foregroundMuted, c.surface0), c.surface0) >= 4.5, `${label}: the label above the field reads`);
      }
    }
  }
  // The sample's measured values on Paseo's own themes (research/129 ②A: #c8c8cd / #434947).
  assert.ok(Math.abs(contrast(fieldLine(palette(PASEO_THEMES.light), PASEO_THEMES.light.colors.surface1), PASEO_THEMES.light.colors.surface1) - 1.6) < .15);
  assert.ok(Math.abs(contrast(fieldLine(palette(PASEO_THEMES.dark), PASEO_THEMES.dark.colors.surface1), PASEO_THEMES.dark.colors.surface1) - 1.76) < .3);
  assert.equal(FIELD_LINE_WIDTH, 1, 'the hover line does not get thicker');
});

// REQ-72: Kanban draws every sheet and window itself — background, grab handle, title bar and content — from the
// chosen set, so what matters is each chosen set against its own page, for every choice on every host this plugin knows.
test('REQ-72 each theme choice reads on its own sheet: title, description, input, tiles, save and errors', () => {
  for (const [name, host] of [['Paseo light', PASEO_THEMES.light], ['Paseo dark', PASEO_THEMES.dark], ['Midnight', midnight]])
    for (const choice of ['light', 'dark', 'system', 'paseo']) for (const device of ['light', 'dark', null]) {
      const c = palette(resolveTheme(host, choice, device)), sheet = c.surface0, label = `${name} · ${choice} · device ${device}`;
      const pairs = [['title', c.foreground, sheet, 4.5], ['description', c.foregroundMuted, sheet, 4.5],
        ['input text', c.foreground, c.surface1, 4.5], ['selected tile', c.foreground, c.surface2, 4.5],
        ['button', c.foreground, c.surface2, 4.5], ['save', c.accentForeground, c.accent, 4.5], ['error', c.statusDanger, sheet, 4.5]];
      for (const [what, fg, bg, needed] of pairs)
        assert.ok(contrast(fg, bg) >= needed, `${label} ${what}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}`);
    }
});
