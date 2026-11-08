'use client';

import type { AcceptInvitationResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { Alert, Button, ButtonLink, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api-client';
import { errorMessage, roleLabel } from '@/lib/messages';
import { readInvitationToken } from '@/lib/navigation';
import { useSession } from '@/lib/session';

/**
 * The token arrives in the URL fragment (#token=...), which browsers never send to servers. It
 * is moved to sessionStorage (this tab only) so it survives signing in or creating an account,
 * and removed from the address bar and storage as soon as it is no longer needed.
 */
const STORAGE_KEY = 'veyra.invitationToken';
const RETURN_PATH = '/invitations/accept';

function takeToken(): string | null {
  const fromHash = readInvitationToken(window.location.hash);
  if (fromHash) {
    try {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
    } catch {
      // Storage unavailable (private mode): the token still works for this page view.
    }
    window.history.replaceState(null, '', RETURN_PATH);
    return fromHash;
  }
  try {
    return readInvitationToken(`token=${sessionStorage.getItem(STORAGE_KEY) ?? ''}`);
  } catch {
    return null;
  }
}

function forgetToken() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

export default function AcceptInvitationPage() {
  const { session, refresh, signOut } = useSession();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [accepted, setAccepted] = useState<AcceptInvitationResponse | null>(null);

  useEffect(() => {
    document.title = 'Accept invitation · VEYRA Console';
    setToken(takeToken());
  }, []);

  async function accept() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<AcceptInvitationResponse>('/invitations/accept', { token });
      forgetToken();
      setAccepted(response);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  let content: ReactNode;
  if (token === undefined || session.status === 'loading') {
    content = <LoadingState />;
  } else if (accepted) {
    content = (
      <Alert tone="success" title={`You joined ${accepted.organisation.name}`}>
        <p>Your role: {roleLabel(accepted.role)}.</p>
        <ButtonLink href={`/organisations/${accepted.organisation.id}`}>
          Open organisation
        </ButtonLink>
      </Alert>
    );
  } else if (!token) {
    content = (
      <Alert>
        This invitation link is incomplete or not valid. Open the link exactly as you received it,
        or ask for a new invitation.
      </Alert>
    );
  } else if (session.status === 'error') {
    content = <ErrorState error={session.error} onRetry={() => void refresh()} />;
  } else if (session.status === 'signed-out') {
    const next = encodeURIComponent(RETURN_PATH);
    content = (
      <>
        <p>
          Sign in, or create an account, with the email address the invitation was sent to. You will
          come back here to accept it.
        </p>
        <div className="form__actions">
          <ButtonLink href={`/sign-in?next=${next}`}>Sign in</ButtonLink>
          <ButtonLink href={`/sign-up?next=${next}`} variant="secondary">
            Create an account
          </ButtonLink>
        </div>
      </>
    );
  } else {
    content = (
      <>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <p>
          You are signed in as <strong>{session.user.email}</strong>. Accepting gives this account
          access to the organisation that invited you.
        </p>
        <div className="form__actions">
          <Button busy={busy} onClick={() => void accept()}>
            Accept invitation
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              await signOut().catch(() => undefined);
            }}
          >
            Use a different account
          </Button>
        </div>
      </>
    );
  }

  return (
    <main id="main" className="auth">
      <div className="auth__panel">
        <p className="brand brand--large">VEYRA</p>
        <h1 className="auth__title">Accept invitation</h1>
        {content}
        <p className="auth__switch">
          <Link href="/organisations">Go to your organisations</Link>
        </p>
      </div>
    </main>
  );
}
