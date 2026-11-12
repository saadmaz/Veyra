'use client';

import type { MfaSetupDto, MfaStatusDto } from '@veyra/api-contracts';
import { type FormEvent, useEffect, useState } from 'react';
import { VerifyMfa } from '@/components/mfa';
import { QrCode } from '@/components/qr-code';
import { Alert, Button, Card, ErrorState, LoadingState, TextField } from '@/components/ui';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useSession } from '@/lib/session';
import { useApiQuery } from '@/lib/use-api';

/** Two-step sign-in: set it up with an authenticator app, keep recovery codes, or turn it off. */
export default function SecurityPage() {
  const status = useApiQuery<MfaStatusDto>('/auth/mfa');
  const { refresh } = useSession();
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    document.title = 'Two-step sign-in · VEYRA Console';
  }, []);

  const done = async () => {
    status.reload();
    await refresh().catch(() => undefined);
  };

  return (
    <>
      <div className="page__header">
        <h1>Two-step sign-in</h1>
      </div>
      <p className="muted">
        Signing in then needs your password and a code from an authenticator app on your phone.
        Organisation admins, finance officers and VEYRA staff need it to make changes.
      </p>
      {status.status === 'loading' ? <LoadingState label="Loading" /> : null}
      {status.status === 'error' ? (
        <ErrorState error={status.error} onRetry={status.reload} />
      ) : null}
      {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : null}
      {status.status === 'success' && !codes ? (
        status.data.enabled ? (
          <On status={status.data} onChanged={done} />
        ) : (
          <SetUp
            onConfirmed={async (recoveryCodes) => {
              setCodes(recoveryCodes);
              await done();
            }}
          />
        )
      ) : null}
    </>
  );
}

function SetUp({ onConfirmed }: { onConfirmed: (codes: string[]) => Promise<void> }) {
  const [setup, setSetup] = useState<MfaSetupDto | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.post<MfaSetupDto>('/auth/mfa/setup'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/confirm', {
        code: code.replace(/\s/g, ''),
      });
      await onConfirmed(result.recoveryCodes);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Turn it on">
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {!setup ? (
        <div className="form__actions">
          <Button busy={busy} onClick={start}>
            Set up an authenticator app
          </Button>
        </div>
      ) : (
        <form className="form" onSubmit={confirm} aria-label="Confirm the authenticator">
          <p>1. Scan this with your authenticator app (or type the key in).</p>
          <QrCode value={setup.otpauthUri} label="Authenticator setup code" />
          <p className="note">
            Key: <code>{setup.secret}</code>
          </p>
          <p>2. Enter the 6-digit code the app shows.</p>
          <TextField
            label="6-digit code"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              Turn on
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <Card title="Keep your recovery codes">
      <Alert tone="success" title="Two-step sign-in is on">
        If you lose your phone, each of these codes lets you in once. They are shown only now: save
        them somewhere safe, such as a password manager.
      </Alert>
      <ul className="list" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="list__primary">
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="form__actions">
        <Button onClick={onDone}>I have saved them</Button>
      </div>
    </Card>
  );
}

function On({ status, onChanged }: { status: MfaStatusDto; onChanged: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function turnOff(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/mfa/disable', { code: code.replace(/\s/g, '') });
      setCode('');
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="Two-step sign-in is on">
        <p>
          {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left.
          {status.sessionVerified ? ' This session is verified.' : ''}
        </p>
      </Card>
      {status.sessionVerified ? (
        <Card title="Turn it off">
          <form className="form" onSubmit={turnOff} aria-label="Turn off two-step sign-in">
            <p className="muted">
              Your role may need it to make changes. Enter a current code to turn it off.
            </p>
            <TextField
              label="6-digit code"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            {error ? <Alert>{errorMessage(error)}</Alert> : null}
            <div className="form__actions">
              <Button type="submit" variant="danger" busy={busy}>
                Turn off
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <VerifyMfa title="Verify this session to manage two-step sign-in" />
      )}
    </>
  );
}
