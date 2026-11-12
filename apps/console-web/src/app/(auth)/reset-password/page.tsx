'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Button, TextField } from '@/components/ui';
import { tokenFromHash } from '@/lib/account';
import { api } from '@/lib/api-client';
import { errorMessage, fieldErrors } from '@/lib/messages';

/** Opened from the reset email: choose a new password. Signs the account out everywhere. */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    document.title = 'Choose a new password · VEYRA Console';
    setToken(tokenFromHash(window.location.hash));
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password-reset/confirm', { token, password });
      setDone(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const fields = fieldErrors(error);
  return (
    <>
      <h1 className="auth__title">Choose a new password</h1>
      {token === null ? (
        <Alert title="This link is incomplete">
          Open it again from the email, or <Link href="/forgot-password">ask for a new one</Link>.
        </Alert>
      ) : null}
      {done ? (
        <Alert tone="success" title="Your password is changed">
          You have been signed out everywhere. <Link href="/sign-in">Sign in</Link> with the new
          password.
        </Alert>
      ) : null}
      {token && !done ? (
        <form className="form" method="post" onSubmit={onSubmit} noValidate>
          {error ? (
            <Alert>
              {errorMessage(error)} <Link href="/forgot-password">Ask for a new link</Link>.
            </Alert>
          ) : null}
          <TextField
            label="New password"
            name="password"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters. A short sentence works well."
            required
            error={fields.password}
          />
          <TextField
            label="Repeat it"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            error={mismatch ? 'The two passwords differ.' : undefined}
          />
          <Button type="submit" busy={busy}>
            Change password
          </Button>
        </form>
      ) : null}
    </>
  );
}
