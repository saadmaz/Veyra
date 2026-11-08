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

/** Mirrors the API rule (NIST SP 800-63B): length only, no composition rules. */
const PASSWORD_MIN = 12;

export default function SignUpPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SignUpForm />
    </Suspense>
  );
}

function SignUpForm() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get('next'));
  const { session, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = 'Create an account · VEYRA Console';
  }, []);

  useEffect(() => {
    if (session.status === 'signed-in') router.replace(next);
  }, [session.status, router, next]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    // Quick feedback only; the API validates everything again.
    if ([...password].length < PASSWORD_MIN) {
      setLocalErrors({ password: `Use at least ${PASSWORD_MIN} characters.` });
      return;
    }
    setLocalErrors({});
    setBusy(true);
    setError(null);
    try {
      await api.post<AuthResponse>('/auth/sign-up', {
        displayName: String(form.get('displayName') ?? ''),
        email: String(form.get('email') ?? ''),
        password,
        client: 'web',
      });
      await refresh();
      router.replace(next);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  const fields = { ...fieldErrors(error), ...localErrors };
  return (
    <>
      <h1 className="auth__title">Create your account</h1>
      {/* method="post": if the form is submitted before scripts load, the browser must not put
          the email and password into the URL (a GET submission would). */}
      <form className="form" method="post" onSubmit={onSubmit} noValidate>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <TextField
          label="Full name"
          name="displayName"
          autoComplete="name"
          required
          maxLength={100}
          error={fields.displayName}
        />
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
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          maxLength={128}
          hint={`At least ${PASSWORD_MIN} characters. A short phrase of a few words works well.`}
          error={fields.password}
        />
        <Button type="submit" busy={busy}>
          Create account
        </Button>
      </form>
      <p className="auth__switch">
        Already have an account?{' '}
        <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </p>
    </>
  );
}
