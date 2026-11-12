'use client';

import type {
  IncidentAssigneeDto,
  IncidentDetailDto,
  IncidentSeverity,
} from '@veyra/api-contracts';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ContactList } from '@/components/incidents';
import { type PropertyContext, PropertyFrame } from '@/components/property-frame';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_STATUS_LABELS,
  incidentMoves,
  SEVERITY_LABELS,
  SEVERITY_TONES,
} from '@/lib/governance';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

/** One incident: what happened, its timeline, follow-ups and whom to call. */
export default function IncidentPage() {
  return (
    <PropertyFrame
      title="Incident"
      permission="property.incident.read"
      crumb={{ label: 'Incidents', path: '/incidents' }}
      denied={{
        title: 'You cannot see incidents here',
        text: 'Incidents are for the property team: managers, security and maintenance staff.',
      }}
    >
      {(ctx) => <Incident ctx={ctx} />}
    </PropertyFrame>
  );
}

function Incident({ ctx }: { ctx: PropertyContext }) {
  const { incidentId } = useParams<{ incidentId: string }>();
  const path = `${ctx.propertyPath}/incidents/${incidentId}`;
  const detail = useApiQuery<IncidentDetailDto>(path);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const manage = ctx.can('property.incident.manage');
  const tz = ctx.property.timeZone;

  async function post(sub: string, body?: unknown, after?: () => void) {
    if (
      sub === '/status' &&
      (body as { status: string }).status === 'RESOLVED' &&
      !outcome.trim()
    ) {
      setProblem('Say how the incident ended to resolve it.');
      return;
    }
    setProblem(null);
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}${sub}`, body);
      after?.();
      detail.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (detail.status === 'loading') return <LoadingState label="Loading incident" />;
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && detail.error.status === 404) {
      return (
        <EmptyState title="Incident not found">
          It does not exist, or it is a sensitive incident you cannot see.
        </EmptyState>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }
  const { incident: i, updates, actions, contacts } = detail.data;
  const closed = i.status === 'CLOSED';
  const moves = incidentMoves(i.status, i.openActions);

  return (
    <>
      <Card title={`${i.reference} ${i.title}`}>
        <p>
          <Badge tone={SEVERITY_TONES[i.severity]}>{SEVERITY_LABELS[i.severity]}</Badge>{' '}
          <Badge>{INCIDENT_STATUS_LABELS[i.status]}</Badge>{' '}
          {i.sensitive ? <Badge>sensitive</Badge> : null}
        </p>
        <p className="note">{i.description}</p>
        <p className="list__meta">
          {INCIDENT_CATEGORY_LABELS[i.category]} · {formatInstant(i.occurredAt, tz)}
          {i.unit ? ` · unit ${i.unit.number}` : ''}
          {i.commonArea ? ` · ${i.commonArea.name}` : ''}
          {i.locationDetail ? ` · ${i.locationDetail}` : ''} · reported by {i.reportedBy}
        </p>
        {i.outcome ? <p className="note">Outcome: {i.outcome}</p> : null}
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {problem ? <Alert>{problem}</Alert> : null}
        {manage && !closed ? (
          <>
            <Severity path={path} severity={i.severity} onError={setError} onDone={detail.reload} />
            {moves.some((m) => m.to === 'RESOLVED') ? (
              <div className="field">
                <label className="field__label" htmlFor="incident-outcome">
                  How it ended (needed to resolve)
                </label>
                <textarea
                  id="incident-outcome"
                  className="field__input"
                  maxLength={4000}
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                />
              </div>
            ) : null}
            <div className="form__actions">
              {moves.map((m) => (
                <Button
                  key={m.to}
                  variant={
                    m.to === 'RESPONDING' && i.status === 'RESOLVED' ? 'secondary' : 'primary'
                  }
                  busy={busy}
                  onClick={() =>
                    post(
                      '/status',
                      m.to === 'RESOLVED' ? { status: m.to, outcome } : { status: m.to },
                      () => setOutcome(''),
                    )
                  }
                >
                  {m.label}
                </Button>
              ))}
            </div>
            {i.status === 'RESOLVED' && i.openActions > 0 ? (
              <p className="muted">Finish the follow-ups to close the incident.</p>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card title="Timeline">
        <ol className="list" aria-label="Timeline">
          {updates.map((u) => (
            <li key={u.id} className="list__item">
              <div>
                <p className="list__primary">
                  {u.kind === 'NOTE'
                    ? u.body
                    : u.fromStatus
                      ? `${INCIDENT_STATUS_LABELS[u.fromStatus]} → ${INCIDENT_STATUS_LABELS[u.toStatus ?? 'OPEN']}`
                      : 'Reported'}
                </p>
                <p className="list__meta">
                  {formatInstant(u.createdAt, tz)}
                  {u.actor ? ` · ${u.actor}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ol>
        {!closed && ctx.can('property.incident.report') ? (
          <form
            aria-label="Add a note"
            className="form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              post('/notes', { body: note }, () => setNote(''));
            }}
          >
            <TextField
              label="Note"
              value={note}
              maxLength={4000}
              onChange={(e) => setNote(e.target.value)}
              required
            />
            <div className="form__actions">
              <Button type="submit" variant="secondary" busy={busy}>
                Add note
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      <Card title="Follow-ups">
        {actions.length === 0 ? <p className="muted">No follow-ups.</p> : null}
        {actions.length > 0 ? (
          <ul className="list" aria-label="Follow-ups">
            {actions.map((a) => (
              <li key={a.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {a.description} {a.doneAt ? <Badge tone="success">done</Badge> : null}
                  </p>
                  <p className="list__meta">
                    {a.assignedTo ? `for ${a.assignedTo.name}` : 'not assigned'}
                    {a.dueOn ? ` · due ${a.dueOn}` : ''}
                    {a.doneAt ? ` · done by ${a.doneBy ?? ''}` : ''}
                  </p>
                </div>
                {!a.doneAt && (manage || a.assignedTo?.userId === ctx.currentUserId) ? (
                  <Button
                    variant="secondary"
                    busy={busy}
                    onClick={() => post(`/actions/${a.id}/done`)}
                  >
                    Mark done
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {manage && !closed ? <AddAction ctx={ctx} path={path} onDone={detail.reload} /> : null}
      </Card>

      <Card title="Whom to call">
        {contacts.length === 0 ? (
          <p className="muted">No escalation contacts for this kind of incident.</p>
        ) : (
          <ContactList contacts={contacts} />
        )}
      </Card>
    </>
  );
}

function Severity({
  path,
  severity,
  onError,
  onDone,
}: {
  path: string;
  severity: IncidentSeverity;
  onError: (e: unknown) => void;
  onDone: () => void;
}) {
  async function change(next: IncidentSeverity) {
    try {
      await api.patch(path, { severity: next });
      onDone();
    } catch (e) {
      onError(e);
    }
  }
  return (
    <SelectField
      label="Severity"
      value={severity}
      onChange={(e) => change(e.target.value as IncidentSeverity)}
    >
      {Object.entries(SEVERITY_LABELS).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </SelectField>
  );
}

function AddAction({
  ctx,
  path,
  onDone,
}: {
  ctx: PropertyContext;
  path: string;
  onDone: () => void;
}) {
  const people = useApiQuery<{ data: IncidentAssigneeDto[] }>(
    `${ctx.propertyPath}/incidents/assignees`,
  );
  const [form, setForm] = useState({ description: '', assignedToUserId: '', dueOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}/actions`, {
        description: form.description,
        assignedToUserId: form.assignedToUserId || null,
        dueOn: form.dueOn || null,
      });
      setForm({ description: '', assignedToUserId: '', dueOn: '' });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add a follow-up" className="form">
      <div className="form__row">
        <TextField
          label="Follow-up"
          value={form.description}
          maxLength={500}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          required
        />
        <SelectField
          label="For"
          value={form.assignedToUserId}
          onChange={(e) => setForm((f) => ({ ...f, assignedToUserId: e.target.value }))}
        >
          <option value="">Nobody yet</option>
          {(people.status === 'success' ? people.data.data : []).map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Due (optional)"
          type="date"
          value={form.dueOn}
          onChange={(e) => setForm((f) => ({ ...f, dueOn: e.target.value }))}
        />
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" variant="secondary" busy={busy}>
          Add follow-up
        </Button>
      </div>
    </form>
  );
}
