/**
 * H4 (research/133): the state mark's press tooltip (REQ-44) is one at a time and goes when anything else is pressed —
 * another card, its ⋯ or long-press menu, a menu of the screen. It used to stay until its own mark was pressed again,
 * and sat over other cards while their menus were open.
 *
 * `claim` makes a card's tooltip the open one (closing the one before); `dismissPressTip` closes it from the places a
 * press starts something else (a card's press, the stage menu). On the web a press anywhere outside the card closes it
 * too (`outside`), which covers the screen's own menus.
 */
let open: (() => void) | null = null;
export function claimPressTip(close: () => void): () => void {
  if (open && open !== close) open();
  open = close;
  return () => { if (open === close) open = null; };
}
export function dismissPressTip() { const close = open; open = null; close?.(); }
type Doc = { addEventListener(type: string, run: (event: { target?: unknown }) => void, capture: boolean): void;
  removeEventListener(type: string, run: (event: { target?: unknown }) => void, capture: boolean): void };
type Box = { contains?: (node: unknown) => boolean };
/** Web only: calls `close` on a press that starts outside `box` (the card around the tooltip). Returns the cleanup. */
export function outsidePress(box: unknown, close: () => void): () => void {
  const doc = (globalThis as { document?: Doc }).document, area = box as Box | null;
  if (!doc || typeof doc.addEventListener !== 'function' || typeof area?.contains !== 'function') return () => {};
  const run = (event: { target?: unknown }) => { if (!area.contains!(event.target)) close(); };
  doc.addEventListener('pointerdown', run, true);
  return () => doc.removeEventListener('pointerdown', run, true);
}
