import { px } from './ui-scale.js';
export type OptionId = string | null;
export type DropdownState = { open: boolean; selected: readonly OptionId[]; restoreFocus: boolean };
export type DropdownEvent = { type: 'open' } | { type: 'select'; id: OptionId }
  | { type: 'close'; reason: 'escape' | 'outside' | 'toggle' };
/** Single choice closes; multiple choice remains open until an explicit dismissal. */
export function dropdownTransition(state: DropdownState, event: DropdownEvent, multiple = false): DropdownState {
  if (event.type === 'open') return { ...state, open: true, restoreFocus: false };
  if (event.type === 'close') return { ...state, open: false, restoreFocus: state.open };
  const selected = multiple ? state.selected.includes(event.id)
    ? state.selected.filter(id => id !== event.id) : [...state.selected, event.id] : [event.id];
  return { open: multiple, selected, restoreFocus: !multiple && state.open };
}
export function dropdownPosition(anchor: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number }, options: number, rowHeight = px(32)) {
  const width = Math.min(px(240), Math.max(0, viewport.width - px(16)));
  const height = Math.min(px(280), options * rowHeight + px(10), Math.max(0, viewport.height - px(16)));
  const below = viewport.height - anchor.y - anchor.height - px(12);
  const top = below >= height || below >= anchor.y - px(12) ? anchor.y + anchor.height + px(4) : anchor.y - height - px(4);
  return { left: Math.max(px(8), Math.min(anchor.x, viewport.width - width - px(8))),
    top: Math.max(px(8), Math.min(top, viewport.height - height - px(8))), width, maxHeight: height };
}
