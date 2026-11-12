'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Button, TextField } from '@/components/ui';
import { api } from '@/lib/api-client';
import { errorMessage, fieldErrors } from '@/lib/messages';

/** Asks for a reset link. The answer is the same whether or not the account exists. */
export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Forgot your password · VEYRA Console';
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password-reset', { email });
      setSent(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const fields = fieldErrors(error);
  return (
    <>
      <h1 className="auth__title">Forgot your password?</h1>
      {sent ? (
        <Alert tone="success" title="Check your email">
          If an account uses that address, we have sent it a link to choose a new password. The link
          works for an hour.
        </Alert>
      ) : (
        <form className="form" method="post" onSubmit={onSubmit} noValidate>
          <p className="muted">We will email you a link to choose a new password.</p>
          {error ? <Alert>{errorMessage(error)}</Alert> : null}
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            required
            error={fields.email}
          />
          <Button type="submit" busy={busy}>
            Send the link
          </Button>
        </form>
      )}
      <p className="auth__switch">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </>
  );
}
