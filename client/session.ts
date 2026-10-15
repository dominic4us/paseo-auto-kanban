import { useState, type Dispatch, type SetStateAction } from 'react';
import { sessionFor } from './session-store.js';

export function useSessionValue<T>(scope: string, key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const state = sessionFor(scope);
  const [snapshot, setValue] = useState(() => ({ scope, key, value: state.has(key) ? state.get(key) as T : initial }));
  const value = snapshot.scope === scope && snapshot.key === key ? snapshot.value : state.has(key) ? state.get(key) as T : initial;
  const update: Dispatch<SetStateAction<T>> = next => {
    const previous = state.has(key) ? state.get(key) as T : initial;
    const result = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
    state.set(key, result); setValue({ scope, key, value: result });
  };
  return [value, update];
}
