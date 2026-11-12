'use client';

import type { AuthUserDto, CurrentSessionResponse } from '@veyra/api-contracts';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiRequestError, api } from './api-client';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; user: AuthUserDto; mfaVerified: boolean }
  | { status: 'signed-out' }
  /** The API could not be asked (network or server error): neither signed in nor out. */
  | { status: 'error'; error: unknown };

interface SessionContextValue {
  session: SessionState;
  /** Re-reads the session from the API (after sign-in, sign-up or a 401). */
  refresh(): Promise<SessionState>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

async function loadSession(): Promise<SessionState> {
  try {
    const response = await api.get<CurrentSessionResponse>('/auth/session');
    return { status: 'signed-in', user: response.user, mfaVerified: response.session.mfaVerified };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return { status: 'signed-out' };
    return { status: 'error', error };
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const next = await loadSession();
    setSession(next);
    return next;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/sign-out');
    } finally {
      // Even if the call failed, the UI must not keep showing signed-in data.
      setSession({ status: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ session, refresh, signOut }), [session, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
