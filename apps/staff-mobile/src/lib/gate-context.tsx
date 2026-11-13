import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { type OfflineGate, useConnection, useOfflineGate } from './use-gate';

/*
 * One connection state, one offline list and one queue per site, shared by the gate, walk-in
 * and inside-now screens, so an entry queued on one screen counts on the others.
 */

interface GateContextValue extends OfflineGate {
  online: boolean;
  markOffline(): void;
  checkConnection(): Promise<void>;
  /** Optional gate name recorded with each entry (e.g. "Main gate"). */
  gate: string;
  setGate(gate: string): void;
}

const GateContext = createContext<GateContextValue | null>(null);

export function GateProvider({
  propertyId,
  base,
  children,
}: {
  propertyId: string;
  base: string;
  children: ReactNode;
}) {
  const { online, markOffline, check } = useConnection();
  const offline = useOfflineGate(propertyId, base, online);
  const [gate, setGate] = useState('');
  const value = useMemo(
    () => ({ ...offline, online, markOffline, checkConnection: check, gate, setGate }),
    [offline, online, markOffline, check, gate],
  );
  return <GateContext.Provider value={value}>{children}</GateContext.Provider>;
}

/** The site's gate state, or null where this person cannot work the gate. */
export const useGate = () => useContext(GateContext);
