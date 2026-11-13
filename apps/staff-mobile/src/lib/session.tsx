import type { AuthResponse, AuthUserDto, CurrentSessionResponse } from '@veyra/api-contracts';
import {
  type ApiClient,
  ApiRequestError,
  createApiClient,
  NETWORK_ERROR,
} from '@veyra/client/http';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiBaseUrl } from './config';

/*
 * The session on this device (ADR 0005, ADR 0008). The token lives only in the platform secure
 * store and travels as a bearer token; any 401 forgets it. Staff accounts with two-step sign-in
 * confirm the authenticator code before using the app, so privileged changes are allowed
 * (ACCESS_CONTROL rule 7). Gate phones are often shared: signing out ends the session on the
 * server too.
 */

const TOKEN_KEY = 'veyra.staff.session-token';
const USER_KEY = 'veyra.staff.session-user';

export type SessionState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'mfa-required'; user: AuthUserDto }
  | { status: 'signed-in'; user: AuthUserDto };

interface SessionContextValue {
  state: SessionState;
  client: ApiClient;
  signIn(email: string, password: string): Promise<void>;
  verify(input: { code: string } | { recoveryCode: string }): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function configuredBaseUrl(): string | null {
  try {
    return apiBaseUrl();
  } catch {
    return null;
  }
}

const stateFor = (user: AuthUserDto, mfaVerified: boolean): SessionState =>
  user.mfaEnabled && !mfaVerified
    ? { status: 'mfa-required', user }
    : { status: 'signed-in', user };

export function SessionProvider({ children }: { children: ReactNode }) {
  const baseUrl = configuredBaseUrl();
  const [state, setState] = useState<SessionState>(
    baseUrl ? { status: 'loading' } : { status: 'unconfigured' },
  );
  const token = useRef<string | null>(null);

  const forget = useCallback(async () => {
    token.current = null;
    setState({ status: 'signed-out' });
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ]).catch(() => undefined);
  }, []);

  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: baseUrl ?? 'http://unconfigured.invalid',
        getToken: () => token.current,
        onUnauthenticated: () => {
          if (token.current) void forget();
        },
      }),
    [baseUrl, forget],
  );

  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    (async () => {
      const [stored, storedUser] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ]).catch(() => [null, null] as const);
      if (!stored) return !cancelled && setState({ status: 'signed-out' });
      token.current = stored;
      try {
        const current = await client.get<CurrentSessionResponse>('/auth/session');
        if (!cancelled) setState(stateFor(current.user, current.session.mfaVerified));
      } catch (error) {
        if (cancelled) return;
        // Offline at start (the gate must keep working): keep the last known user. The API
        // checks every request again, and the offline gate never decides on a stale list.
        if (error instanceof ApiRequestError && error.code === NETWORK_ERROR && storedUser) {
          setState({ status: 'signed-in', user: JSON.parse(storedUser) as AuthUserDto });
        } else if (!(error instanceof ApiRequestError && error.status === 401)) {
          setState({ status: 'signed-out' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, client]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const response = await client.post<AuthResponse>('/auth/sign-in', {
        email,
        password,
        client: 'mobile',
      });
      if (!response.token) throw new Error('The API did not return a mobile session');
      token.current = response.token;
      await SecureStore.setItemAsync(TOKEN_KEY, response.token);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(response.user));
      setState(stateFor(response.user, false));
    },
    [client],
  );

  const verify = useCallback(
    async (input: { code: string } | { recoveryCode: string }) => {
      await client.post('/auth/mfa/verify', input);
      const current = await client.get<CurrentSessionResponse>('/auth/session');
      setState(stateFor(current.user, current.session.mfaVerified));
    },
    [client],
  );

  const signOut = useCallback(async () => {
    try {
      await client.post('/auth/sign-out');
    } catch {
      // The token is forgotten on this device either way; the server expires it.
    }
    await forget();
  }, [client, forget]);

  const value = useMemo(
    () => ({ state, client, signIn, verify, signOut }),
    [state, client, signIn, verify, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

export const useClient = () => useSession().client;
