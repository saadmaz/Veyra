'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, LoadingState } from '@/components/ui';
import { tokenFromHash } from '@/lib/account';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useSession } from '@/lib/session';

/** Opened from the confirmation email: the token is in the #fragment, never sent to a server log. */
export default function VerifyEmailPage() {
  const { refresh } = useSession();
  const [state, setState] = useState<'working' | 'done' | { error: unknown }>('working');

  useEffect(() => {
    document.title = 'Confirm your email · VEYRA Console';
    const token = tokenFromHash(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState({ error: new Error('missing') });
      return;
    }
    api
      .post('/auth/verify-email', { token })
      .then(async () => {
        setState('done');
        await refresh().catch(() => undefined);
      })
      .catch((error: unknown) => setState({ error }));
  }, [refresh]);

  return (
    <>
      <h1 className="auth__title">Confirm your email</h1>
      {state === 'working' ? <LoadingState label="Confirming" /> : null}
      {state === 'done' ? (
        <Alert tone="success" title="Thank you">
          Your email address is confirmed.
        </Alert>
      ) : null}
      {typeof state === 'object' ? (
        <Alert title="This link did not work">
          {state.error instanceof Error && state.error.message === 'missing'
            ? 'The link is incomplete. Open it again from the email.'
            : errorMessage(state.error)}{' '}
          Sign in to ask for a new one.
        </Alert>
      ) : null}
      <p className="auth__switch">
        <Link href="/">Go to VEYRA</Link>
      </p>
    </>
  );
}
