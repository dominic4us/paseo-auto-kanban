// REQ-118 (the owner's screenshot, 2026-09-29): the filter glyph's count as quiet as the glyph it sits on, on a wide screen
// and a phone alike (one IconButton badge). D42: a hidden project Paseo no longer has is neither counted nor shown, and
// stays in the stored list. The screens are exercised in tests/web/run.mjs ("REQ-118"); these are the pure parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNT_BADGE, countBadge, PASEO_THEMES, palette, contrast, selectedLine, selectedTint } from '../dist/client/palette.js';
import { activeFilters, emptyFilters, filterCount, keepGoneHidden, presentHidden } from '../dist/client/filter-model.js';
import { copy } from '../dist/client/i18n.js';

test('REQ-118 the count: the glyph\'s tint, a thin line, a main-colour figure at 4.5:1, in light and dark', () => {
  for (const mode of ['light', 'dark']) {
    const c = palette(PASEO_THEMES[mode]), look = countBadge(c, c.surface0);
    assert.equal(look.fill, selectedTint(c, c.surface0), mode + ': the tint an "on" glyph takes');
    assert.ok(contrast(look.text, look.fill) >= 4.5, mode + ': the figure reads ' + contrast(look.text, look.fill).toFixed(2));
    assert.notEqual(look.text.toLowerCase(), c.accentForeground.toLowerCase(), mode + ': not the white figure of a solid disc');
    // The line is its own edge on the tinted glyph, yet softer than the main colour itself.
    assert.ok(contrast(look.line, look.fill) > 1.2, mode + ': the line stands off the tint');
    assert.ok(contrast(look.line, c.surface0) < contrast(selectedLine(c, c.surface0), c.surface0), mode + ': the line is quieter than the main colour');
    assert.ok(contrast(look.fill, c.surface0) < 1.5, mode + ': the fill is a tint, not a solid colour');
  }
  // Smaller and lighter than the 16px, weight 600 disc it replaces.
  assert.ok(COUNT_BADGE.size < 16 && COUNT_BADGE.size >= 14);
  assert.ok(Number(COUNT_BADGE.fontWeight) < 600);
  assert.ok(COUNT_BADGE.lineHeight + 2 <= COUNT_BADGE.size, 'the figure fits inside the 1px line');
});

test('D42 only the projects there now are counted and shown as hidden', () => {
  const stored = ['prj_a', 'prj_gone1', 'prj_b', 'prj_gone2', 'prj_gone3'], present = new Set(['prj_a', 'prj_b', 'prj_c', '']);
  assert.deepEqual(presentHidden(stored, present), ['prj_a', 'prj_b']);
  assert.deepEqual(presentHidden(stored, null), stored, 'the list as stored while the projects are not known');
  assert.notEqual(presentHidden(stored, null), stored, 'a copy');
  const filters = { ...emptyFilters(), hiddenProjects: presentHidden(stored, present) };
  assert.equal(copy('ko').hiddenProjectsFilter(Number(activeFilters(filters)[0].value)), '프로젝트 2개 숨김');
  // Only gone ones stored: nothing is filtered at all.
  assert.equal(filterCount({ ...emptyFilters(), hiddenProjects: presentHidden(['prj_gone1'], present) }), 0);
  assert.deepEqual(activeFilters({ ...emptyFilters(), hiddenProjects: presentHidden(['prj_gone1'], present) }), []);
});

test('D42 a choice among the projects there now keeps the gone ones stored', () => {
  const stored = ['prj_a', 'prj_gone1', 'prj_gone2'], present = new Set(['prj_a', 'prj_b']);
  assert.deepEqual(keepGoneHidden(['prj_a', 'prj_b'], stored, present), ['prj_a', 'prj_b', 'prj_gone1', 'prj_gone2'], 'hiding one more');
  assert.deepEqual(keepGoneHidden([], stored, present), ['prj_gone1', 'prj_gone2'], 'clearing the projects filter');
  assert.deepEqual(keepGoneHidden(['prj_gone1'], stored, present), ['prj_gone1', 'prj_gone2'], 'never twice');
  assert.deepEqual(keepGoneHidden(['prj_b'], stored, null), ['prj_b'], 'not known yet: as chosen');
  // A project that comes back is hidden again, as it was.
  assert.deepEqual(presentHidden(keepGoneHidden([], stored, present), new Set(['prj_a', 'prj_b', 'prj_gone1'])), ['prj_gone1']);
});
