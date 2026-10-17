import { createContext, useContext } from 'react';
import { emptySignalSource, type SignalSource } from './agent-signals.js';
/** Screens publish one source; cards and lane headers subscribe to it individually. */
export const SignalContext = createContext<SignalSource>(emptySignalSource);
export const useSignalSource = () => useContext(SignalContext);
