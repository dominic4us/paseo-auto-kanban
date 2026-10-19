import { useEffect, useRef, useState } from 'react';
import { sessionFor } from './session-store.js';

type Ticket = { scope: string; epoch: number; key: string; sequence: number };
/** A read or a successful current response is the only source of a value. Never store pending values.
 * Read tokens change for every accepted server read, including identical values. Per-key tickets let
 * different workspace writes merge while newer writes, reads, scope changes and unmounts reject old replies.
 */
export function useConfirmedValue<T>(scope: string, remote: T, readToken: unknown = remote, legacyKey?: string) {
  const [, redraw] = useState(0);
  const state = useRef({ scope, readToken, value: remote, epoch: 0, clock: 0, alive: true, requests: new Map<string, number>() });
  const current = state.current;
  if (current.scope !== scope || current.readToken !== readToken) {
    current.scope = scope; current.readToken = readToken; current.value = remote;
    current.epoch++; current.requests.clear();
  }
  useEffect(() => {
    const owner = state.current; owner.alive = true;
    // Discard the old installation-lifetime setting cache, including a pending value left by old code.
    if (legacyKey) sessionFor(scope).delete(legacyKey);
    return () => { owner.alive = false; owner.epoch++; owner.requests.clear(); };
  }, [scope, legacyKey]);
  const begin = (key = 'value'): Ticket | null => {
    const owner = state.current;
    if (!owner.alive || owner.scope !== scope) return null;
    const sequence = ++owner.clock; owner.requests.set(key, sequence);
    return { scope, epoch: owner.epoch, key, sequence };
  };
  const confirm = (ticket: Ticket, next: T | ((value: T) => T)): boolean => {
    const owner = state.current;
    if (!owner.alive || owner.scope !== ticket.scope || owner.epoch !== ticket.epoch || owner.requests.get(ticket.key) !== ticket.sequence) return false;
    owner.value = typeof next === 'function' ? (next as (value: T) => T)(owner.value) : next;
    owner.requests.delete(ticket.key); redraw(value => value + 1); return true;
  };
  return { value: current.value, begin, confirm };
}
