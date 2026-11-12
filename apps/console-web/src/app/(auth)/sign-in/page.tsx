'use client';

import type { AuthResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { Alert, Button, LoadingState, TextField } from '@/components/ui';
import { api } from '@/lib/api-client';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { safeNextPath } from '@/lib/navigation';
import { useSession } from '@/lib/session';

export default function SignInPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get('next'));
  const { session, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Sign in · VEYRA Console';
  }, []);

  useEffect(() => {
    if (session.status === 'signed-in') router.replace(next);
  }, [session.status, router, next]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api.post<AuthResponse>('/auth/sign-in', {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        client: 'web',
      });
      await refresh();
      router.replace(next);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  const fields = fieldErrors(error);
  return (
    <>
      <h1 className="auth__title">Sign in</h1>
      {/* method="post": if the form is submitted before scripts load, the browser must not put
          the email and password into the URL (a GET submission would). */}
      <form className="form" method="post" onSubmit={onSubmit} noValidate>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          error={fields.email}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={fields.password}
        />
        <Button type="submit" busy={busy}>
          Sign in
        </Button>
      </form>
      <p className="auth__switch">
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="auth__switch">
        New to VEYRA?{' '}
        <Link href={`/sign-up?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
    </>
  );
}
