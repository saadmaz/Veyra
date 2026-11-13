'use client';

import type { CurrentSessionResponse } from '@veyra/api-contracts';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'not-staff'; email: string }
  | { kind: 'staff'; email: string }
  | { kind: 'error'; message: string };

/**
 * Shows its children only to a signed-in platform administrator. Others get a sign-in form or
 * a plain refusal. The API checks every request again; this only decides what to show.
 */
export function StaffGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const check = useCallback(async () => {
    try {
      const session = await api.get<CurrentSessionResponse>('/auth/session');
      const me = await api.get<{ platformAdmin: boolean }>('/platform/me');
      setState(
        me.platformAdmin
          ? { kind: 'staff', email: session.user.email }
          : { kind: 'not-staff', email: session.user.email },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setState({ kind: 'signed-out' });
      else setState({ kind: 'error', message: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function signOut() {
    await api.post('/auth/sign-out').catch(() => undefined);
    setState({ kind: 'signed-out' });
  }

  if (state.kind === 'loading') {
    return (
      <div className="center">
        <p className="muted" role="status">
          Loading…
        </p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="center">
        <div role="alert" className="alert">
          {state.message}{' '}
          <button type="button" className="button button--secondary" onClick={() => void check()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (state.kind === 'signed-out') {
    return (
      <div className="center">
        <SignIn onSignedIn={() => void check()} />
      </div>
    );
  }
  if (state.kind === 'not-staff') {
    return (
      <div className="center">
        <section className="panel" aria-labelledby="refused">
          <h1 id="refused">Not for this account</h1>
          <p className="muted">
            {state.email} is not a VEYRA platform administrator. Ask an operator if you should be.
          </p>
          <button type="button" className="button button--secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </section>
      </div>
    );
  }
  return (
    <div className="admin">
      <aside className="sidebar">
        <a href="/" className="brand" aria-label="Platform Admin home">
          <span className="brand__mark" aria-hidden="true">
            V
          </span>
          <span className="brand__text">
            <span className="brand__word">VEYRA</span>
            <span className="brand__sub">Platform admin</span>
          </span>
        </a>
        <nav aria-label="Main">
          <a href="/" className="sidebar__link" aria-current="page">
            Organisations
          </a>
        </nav>
        <p className="sidebar__notice">Production · every action is audited</p>
        <div className="sidebar__account">
          <span className="sidebar__email" title={state.email}>
            {state.email}
          </span>
          <button type="button" className="link-button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="admin__main">{children}</div>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/sign-in', { email, password, client: 'web' });
      onSignedIn();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 401 ? 'Wrong email or password.' : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="sign-in">
      <p className="eyebrow">VEYRA · Internal</p>
      <h1 id="sign-in">Platform Admin</h1>
      <form className="form" onSubmit={submit} aria-label="Sign in">
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error ? (
          <p role="alert" className="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
