'use client';

import type {
  OrganisationDetailResponse,
  WebhookEndpointDetailDto,
  WebhookEndpointDto,
  WebhookSecretDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CheckboxField,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { WEBHOOK_EVENT_LABELS } from '@/lib/reporting';
import { useApiQuery } from '@/lib/use-api';

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

/** An organisation's webhook endpoints (organisation admins). */
export default function WebhooksPage() {
  const { organisationId } = useParams<{ organisationId: string }>();
  const base = `/organisations/${organisationId}`;
  const organisation = useApiQuery<OrganisationDetailResponse>(base);
  const allowed =
    organisation.status === 'success' &&
    organisation.data.permissions.includes('organisation.webhook.manage');
  const endpoints = useApiQuery<{ data: WebhookEndpointDto[] }>(
    allowed ? `${base}/webhooks` : null,
  );
  const [secret, setSecret] = useState<WebhookSecretDto | null>(null);

  useEffect(() => {
    document.title = 'Webhooks · VEYRA Console';
  }, []);

  if (organisation.status === 'loading') return <LoadingState label="Loading organisation" />;
  if (organisation.status === 'error') {
    if (organisation.error instanceof ApiRequestError && organisation.error.status === 404) {
      return (
        <EmptyState title="Organisation not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={organisation.error} onRetry={organisation.reload} />;
  }
  const header = (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{organisation.data.name}</Link>
      </nav>
      <div className="page__header">
        <h1>Webhooks</h1>
      </div>
    </>
  );
  if (!allowed) {
    return (
      <>
        {header}
        <EmptyState title="Webhooks are for organisation admins">
          Ask an organisation admin to connect other systems.
        </EmptyState>
      </>
    );
  }
  const rows = endpoints.status === 'success' ? endpoints.data.data : [];
  return (
    <>
      {header}
      <p className="muted">
        Other systems can be told when things happen here. Each delivery is signed so they can check
        it came from VEYRA. Payloads carry references and states, never names.
      </p>
      {secret ? (
        <Alert tone="success" title="Copy the signing secret now">
          It is shown only once. Secret for {secret.endpoint.url}: <code>{secret.secret}</code>
        </Alert>
      ) : null}
      <Card title="Endpoints">
        {endpoints.status === 'loading' ? <LoadingState label="Loading endpoints" /> : null}
        {endpoints.status === 'error' ? (
          <ErrorState error={endpoints.error} onRetry={endpoints.reload} />
        ) : null}
        {endpoints.status === 'success' && rows.length === 0 ? (
          <p className="muted">No endpoints yet.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Endpoints">
            {rows.map((e) => (
              <li key={e.id} className="list__item">
                <Endpoint base={base} endpoint={e} onSecret={setSecret} onDone={endpoints.reload} />
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <AddEndpoint
        base={base}
        onCreated={(s) => {
          setSecret(s);
          endpoints.reload();
        }}
      />
    </>
  );
}

function Endpoint({
  base,
  endpoint: e,
  onSecret,
  onDone,
}: {
  base: string;
  endpoint: WebhookEndpointDto;
  onSecret: (s: WebhookSecretDto) => void;
  onDone: () => void;
}) {
  const path = `${base}/webhooks/${e.id}`;
  const [open, setOpen] = useState(false);
  const detail = useApiQuery<WebhookEndpointDetailDto>(open ? path : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
      if (open) detail.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="inline-form" aria-label={e.url}>
      <p className="list__primary">
        {e.url} <StatusBadge status={e.status} />
      </p>
      <p className="list__meta">
        {e.description ? `${e.description} · ` : ''}
        {e.events.map((x) => WEBHOOK_EVENT_LABELS[x] ?? x).join(', ')}
      </p>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide deliveries' : 'Show deliveries'}
        </Button>
        {e.status === 'ACTIVE' ? (
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => run(() => api.post(`${path}/test`))}
          >
            Send a test
          </Button>
        ) : null}
        <Button
          variant="secondary"
          busy={busy}
          onClick={() =>
            run(async () => onSecret(await api.post<WebhookSecretDto>(`${path}/rotate-secret`)))
          }
        >
          New secret
        </Button>
        <Button
          variant={e.status === 'ACTIVE' ? 'danger' : 'primary'}
          busy={busy}
          onClick={() =>
            run(() => api.patch(path, { status: e.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }))
          }
        >
          {e.status === 'ACTIVE' ? 'Disable' : 'Enable'}
        </Button>
      </div>
      {open && detail.status === 'loading' ? <LoadingState label="Loading deliveries" /> : null}
      {open && detail.status === 'success' ? (
        detail.data.deliveries.length === 0 ? (
          <p className="muted">Nothing sent yet.</p>
        ) : (
          <ul className="list" aria-label={`Deliveries to ${e.url}`}>
            {detail.data.deliveries.map((d) => (
              <li key={d.id} className="list__meta">
                {WEBHOOK_EVENT_LABELS[d.eventType] ?? d.eventType} ·{' '}
                <Badge
                  tone={
                    d.status === 'SUCCEEDED'
                      ? 'success'
                      : d.status === 'FAILED'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {d.status.toLowerCase()}
                </Badge>{' '}
                · {when(d.createdAt)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                {d.lastStatusCode ? ` · HTTP ${d.lastStatusCode}` : ''}
                {d.lastError ? ` · ${d.lastError}` : ''}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </article>
  );
}

function AddEndpoint({
  base,
  onCreated,
}: {
  base: string;
  onCreated: (s: WebhookSecretDto) => void;
}) {
  const events = useApiQuery<{ data: string[] }>(`${base}/webhooks/events`);
  const [form, setForm] = useState({ url: '', description: '', events: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fields = fieldErrors(error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<WebhookSecretDto>(`${base}/webhooks`, {
        url: form.url,
        description: form.description || null,
        events: form.events,
      });
      setForm({ url: '', description: '', events: [] });
      onCreated(created);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Add an endpoint">
      <form onSubmit={submit} aria-label="Add an endpoint" className="form">
        <div className="form__row">
          <TextField
            label="URL (HTTPS)"
            type="url"
            value={form.url}
            error={fields.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            required
          />
          <TextField
            label="Description (optional)"
            value={form.description}
            maxLength={200}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
        <fieldset className="field">
          <legend className="field__label">Send when</legend>
          {(events.status === 'success' ? events.data.data : []).map((name) => (
            <CheckboxField
              key={name}
              label={WEBHOOK_EVENT_LABELS[name] ?? name}
              checked={form.events.includes(name)}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  events: e.target.checked
                    ? [...f.events, name]
                    : f.events.filter((x) => x !== name),
                }))
              }
            />
          ))}
          {fields.events ? <p className="field__error">Choose at least one event.</p> : null}
        </fieldset>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Add endpoint
          </Button>
        </div>
      </form>
    </Card>
  );
}
