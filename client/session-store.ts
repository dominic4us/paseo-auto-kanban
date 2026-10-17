// Installation-lifetime memory, isolated by host/surface scope. No settings/storage writes.
// Keeping it outside React also survives host theme-driven component remounts.
const sessions = new Map<string, Map<string, unknown>>();
export function sessionFor(scope: string): Map<string, unknown> {
  let state = sessions.get(scope);
  if (!state) { state = new Map(); sessions.set(scope, state); }
  return state;
}
