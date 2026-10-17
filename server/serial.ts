/**
 * D44: one queue per key for the whole plugin process. A board is made for a folder in exactly one place at a time — the
 * automatic board (server/auto-cards.ts) and a person's first card (server/mutations.ts `board.ensure`) take the same key,
 * `boardCreateKey`, so two signals or a signal and a tap at the same moment still leave one board.
 */
const chains = new Map<string, Promise<unknown>>();
export function serially<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
/** The key for making a board in a folder: its real path (symbolic links followed), in the one spelling (`normalizeCwd`). */
export const boardCreateKey = (realCwd: string) => 'board-create:' + realCwd;
