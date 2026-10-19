import { useRpc } from '@getpaseo/plugin/client';
import { autoCardsSet, autoCardsWorkspaceSet, normalizeCwd } from '../shared/rpc.js';
import { useConfirmedValue } from './confirmed-value.js';
import { workspaceLabel, type Directory } from './presentation.js';

export type AutoCardsSwitch = readonly [boolean, (next: boolean) => Promise<boolean>];

/**
 * REQ-61 ⑧: the agent auto-card switch, remembered per host outside the ledger. Since REQ-66 it lives in
 * the settings window. The screen shows what the server remembered (on unless turned off) until a write
 * the server confirmed, then that value wins. A refused or lost write changes nothing and reports false,
 * so the row can say so and offer the same write again (it used to be swallowed and the switch lied).
 * The demo keeps its own scope and never saves.
 */
export function useAutoCards(scope: string, hostId: string, remote: boolean | undefined, persist: boolean, readToken: unknown = remote): AutoCardsSwitch {
  const save = useRpc(autoCardsSet), confirmed = useConfirmedValue(scope, remote, readToken, 'autoCards');
  const set = async (next: boolean) => {
    if (!persist) return false;
    const ticket = confirmed.begin(); if (!ticket) return false;
    const reply = await save({ hostId, enabled: next });
    if (!reply?.ok) return false;
    confirmed.confirm(ticket, reply.data.enabled); return true;
  };
  return [confirmed.value ?? true, set];
}
/** D44: one workspace's switch, by the folder its lane shows. */
export type WorkspaceAutoSwitch = { isOn: (cwd: string) => boolean; set: (cwd: string, next: boolean) => Promise<boolean> };
/**
 * D44: the auto-card switch of each workspace (on unless turned off), beside the host's. The screen shows what the
 * server remembered (`autoCardsOff`: of the boards the same answer shows, the folders that are off, in the spelling their
 * rows carry) until a write the server confirmed, as the host switch does. 249-D3: rows are matched by that spelling
 * (`normalizeCwd`) and never folded here — two Windows folders differing only in case may be two folders with two switches;
 * the server's one judgement (`folderSwitch`) already folded what is one folder.
 */
export function useWorkspaceAutoCards(scope: string, remoteOff: readonly string[] | undefined, persist: boolean,
  readToken: unknown = remoteOff): WorkspaceAutoSwitch {
  const save = useRpc(autoCardsWorkspaceSet), confirmed = useConfirmedValue(scope, remoteOff, readToken, 'autoCardsWorkspaces');
  const isOn = (cwd: string) => !(confirmed.value ?? []).map(normalizeCwd).includes(normalizeCwd(cwd));
  const set = async (cwd: string, next: boolean) => {
    if (!persist) return false;
    const key = normalizeCwd(cwd), ticket = confirmed.begin(key); if (!ticket) return false;
    const reply = await save({ cwd, enabled: next });
    if (!reply?.ok) return false;
    confirmed.confirm(ticket, previous => {
      const off = (previous ?? []).map(normalizeCwd);
      return reply.data.enabled ? off.filter(value => value !== key) : [...new Set([...off, key])];
    });
    return true;
  };
  return { isOn, set };
}
/** D44: the settings window's workspace rows — the screen's boards, by the name their lane shows (project · detail). */
/** REQ-137: kept with the board's judgement (card-groups.ts), named here beside the switches' entries. */
export { workspaceLeadEntries } from './card-groups.js';
export function workspaceAutoEntries(boards: readonly { workspaceId: string; cwd: string }[], directory: Directory) {
  return boards.map(b => ({ cwd: b.cwd, name: workspaceLabel(b.workspaceId, b.cwd, directory) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
