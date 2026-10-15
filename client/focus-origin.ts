/**
 * REQ-77 F1: whether the focus a control is getting right now was moved there by Tab (or Shift+Tab). A window,
 * sheet or dropdown that closes hands focus back to the control that opened it (`settings-sheet.tsx`,
 * `dropdown.tsx`, RN's Modal), and a click leaves focus on what was clicked; neither is the keyboard's, so neither
 * should bring a label up beside a glyph and leave it there.
 *
 * On the web the browser moves focus as the default action of the Tab key-down, in the same task as the key-down
 * itself; the flag set by the key-down is dropped at the next task. A Tab key-down is noticed in the capture phase,
 * before anything on the page can stop it. Without a document (native) nothing tells the two apart, so every
 * focus counts as the keyboard's, as before.
 */
type KeyTarget = { addEventListener(type: 'keydown', listener: (event: { key?: string }) => void, capture: boolean): void };
const watched = new WeakSet<object>();
let tabbing = false;
const page = () => {
  const doc = (globalThis as { document?: Partial<KeyTarget> }).document;
  return doc && typeof doc.addEventListener === 'function' ? doc as KeyTarget : null;
};
/** Starts listening for Tab on this page, once. Call it before the first focus that has to be told apart. */
export function watchFocusKeys() {
  const doc = page();
  if (!doc || watched.has(doc)) return;
  watched.add(doc);
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    tabbing = true;
    setTimeout(() => { tabbing = false; }, 0);
  }, true);
}
/**
 * How long after focus is handed back a hover still counts as the click's. A window closed by Escape leaves the mouse
 * where it clicked ⚙; once the window is gone the browser reports the mouse over ⚙ again without it having moved.
 */
export const RETURNED_HOVER_MS = 400;
/** True while handling a focus that Tab moved — or any focus, where there is no page to watch. */
export function focusFromKeyboard(): boolean {
  const doc = page();
  if (!doc) return true;
  watchFocusKeys();
  return tabbing;
}
/**
 * REQ-82: runs `run` once the event being handled is over — after a press on a control inside a card has also
 * reached the card (the web hands it on), so the card can tell the two apart until then.
 */
export function afterThisTask(run: () => void) { setTimeout(run, 0); }
