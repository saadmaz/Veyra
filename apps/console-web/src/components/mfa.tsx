'use client';

import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useSession } from '@/lib/session';
import { Alert, Button, TextField } from './ui';

/**
 * Asks for an authenticator code (or a recovery code) to verify this session. Shown to people
 * with two-step sign-in on whose session is not verified yet.
 */
export function VerifyMfa({ title = 'Confirm it is you' }: { title?: string }) {
  const { refresh } = useSession();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(
        '/auth/mfa/verify',
        useRecovery ? { recoveryCode: value } : { code: value.replace(/\s/g, '') },
      );
      setValue('');
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Alert tone="info" title={title}>
      <form className="form" onSubmit={submit} aria-label="Verify with a code">
        <p className="muted">
          Enter the code from your authenticator app before making changes. Looking things up works
          without it.
        </p>
        <TextField
          label={useRecovery ? 'Recovery code' : '6-digit code'}
          value={value}
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          maxLength={useRecovery ? 20 : 7}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Verify
          </Button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setUseRecovery((r) => !r);
              setValue('');
            }}
          >
            {useRecovery ? 'Use the app code instead' : 'Use a recovery code'}
          </button>
        </div>
      </form>
    </Alert>
  );
}
