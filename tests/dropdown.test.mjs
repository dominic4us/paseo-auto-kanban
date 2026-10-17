import test from 'node:test';
import assert from 'node:assert/strict';
import { dropdownTransition, dropdownPosition } from '../dist/client/dropdown-state.js';
const state = { open: false, selected: ['first'], restoreFocus: false };
test('G1 Escape, outside and trigger dismissal close and request opener focus without changing selection', () => {
  for (const reason of ['escape', 'outside', 'toggle']) {
    const opened = dropdownTransition(state, { type: 'open' });
    assert.equal(opened.open, true); assert.equal(opened.restoreFocus, false);
    const closed = dropdownTransition(opened, { type: 'close', reason });
    assert.deepEqual(closed, { open: false, selected: ['first'], restoreFocus: true });
    assert.equal(dropdownTransition(closed, { type: 'close', reason }).restoreFocus, false);
    assert.equal(dropdownTransition(closed, { type: 'open' }).restoreFocus, false);
  }
});
test('single selection closes and restores focus, including an unchanged selection or null all-projects choice', () => {
  for (const id of ['first', 'second', null]) {
    const next = dropdownTransition({ ...state, open: true }, { type: 'select', id });
    assert.deepEqual(next, { open: false, selected: [id], restoreFocus: true });
  }
  assert.deepEqual(state.selected, ['first']);
});
test('reusable multi-selection toggles values and remains open; Escape/outside share focus restoration', () => {
  let current = { ...state, open: true };
  current = dropdownTransition(current, { type: 'select', id: 'second' }, true);
  assert.deepEqual(current, { open: true, selected: ['first', 'second'], restoreFocus: false });
  current = dropdownTransition(current, { type: 'select', id: 'first' }, true);
  assert.deepEqual(current.selected, ['second']);
  for (const reason of ['escape', 'outside']) {
    const closed = dropdownTransition(current, { type: 'close', reason }, true);
    assert.equal(closed.open, false); assert.equal(closed.restoreFocus, true); assert.deepEqual(closed.selected, ['second']);
  }
});
test('modal menu preserves the measured anchor gap and stays inside the viewport', () => {
  assert.deepEqual(dropdownPosition({ x: 336, y: 90, width: 220, height: 30 }, { width: 1400, height: 900 }, 2),
    { left: 336, top: 124, width: 240, maxHeight: 74 });
  const edge = dropdownPosition({ x: 340, y: 700, width: 220, height: 30 }, { width: 390, height: 844 }, 20);
  assert.equal(edge.left, 142); assert.equal(edge.top, 416); assert.equal(edge.maxHeight, 280);
  const small = dropdownPosition({ x: 0, y: 90, width: 220, height: 30 }, { width: 200, height: 160 }, 20);
  assert.equal(small.width, 184); assert.equal(small.top, 8); assert.equal(small.maxHeight, 144);
});
