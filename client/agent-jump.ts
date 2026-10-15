/**
 * REQ-96: where a card's "Go to agent ↗" leads — the Paseo conversation of `agentId` (the card's first agent, or the one
 * that waits for an answer), else the board's workspace; null when there is neither, or the host has no navigation
 * (older hosts, the demo), and the control is not drawn.
 * REQ-142: with `open` (`useAgentLeave`), the agent is opened through it, so an agent of another workspace asks first.
 */
export type HostNavigation = { openAgent: (input: { agentId: string }) => void; openWorkspace: (input: { workspaceId: string }) => void };
export interface Jump { kind: 'agent' | 'workspace'; go: () => void }
/** Opens `agentId` — at once, or after a question (`useAgentLeave`). */
export type GuardedOpen = (agentId: string) => void;
export function jumpFor(navigation: HostNavigation | undefined, agentId: string | undefined,
  board: { workspaceId: string; hasLedger?: boolean | undefined } | undefined, open?: GuardedOpen): Jump | null {
  if (!navigation) return null;
  if (agentId) return { kind: 'agent', go: () => open ? open(agentId) : navigation.openAgent({ agentId }) };
  // As the workspace board's own ↗ (board.tsx): a board of a folder with no Paseo workspace has nothing to open.
  const workspaceId = board && board.hasLedger !== false && !board.workspaceId.startsWith('local_') ? board.workspaceId : null;
  return workspaceId ? { kind: 'workspace', go: () => navigation.openWorkspace({ workspaceId }) } : null;
}

/**
 * REQ-142 (research/336): Paseo archives an agent with no parent when its tab is closed — and, with it, its sub-agents in
 * the same workspace. "Go to agent ↗" to an agent of another workspace opens such a tab there, so it asks first; an agent of
 * the workspace being looked at opens at once, as before. `here` is the workspace the screen is in (the workspace panel's);
 * the overview and a board opened from it are in none. `there` is the agent's own workspace (gate 340 F1: not its card's
 * board's — a worktree agent's card sits on its project root's board). Anything not known to be the same asks (fail safe).
 */
export function leavesWorkspace(here: string | undefined, there: string | undefined): boolean {
  return !here || !there || here !== there;
}
