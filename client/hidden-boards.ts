import { useSessionValue } from './session.js';

/**
 * REQ-138: the boards a screen lists. A board the server marks `emptyGone` — its workspace archived or gone from Paseo, no
 * live card — is left out unless `reveal` is on, and counted, so the settings can say how many and bring them back for a
 * while (their lane's menu still opens their archived cards). The ledger keeps them as they are.
 */
export function shownBoards<T>(boards: readonly T[], reveal: boolean, summary: (board: T) => { emptyGone?: true | undefined }):
  { boards: T[]; hidden: number } {
  const hidden = boards.filter(board => summary(board).emptyGone === true).length;
  return { boards: reveal || !hidden ? [...boards] : boards.filter(board => summary(board).emptyGone !== true), hidden };
}
/** What the settings' "Hidden empty boards" row needs: how many, and the switch that shows them again. */
export type HiddenBoards = { count: number; shown: boolean; onChange: (next: boolean) => void };
/**
 * REQ-138: whether this host's screens show the hidden boards again — this session only, never saved, so a hidden board
 * is hidden again the next time Paseo opens. The list and the Kanban screens share it (`scope`, the host's surface).
 */
export function useRevealHidden(scope: string): [boolean, (next: boolean) => void] {
  const [reveal, setReveal] = useSessionValue<boolean>(scope, 'revealEmptyGone', false);
  return [reveal, next => setReveal(next)];
}
