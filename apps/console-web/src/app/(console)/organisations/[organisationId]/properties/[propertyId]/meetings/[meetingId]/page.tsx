'use client';

import type { DocumentDto, MeetingDto } from '@veyra/api-contracts';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { BookingAction } from '@/components/facilities';
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
  StatusBadge,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

/** A committee meeting: agenda, holding it, minutes and resolutions. */
export default function MeetingPage() {
  return (
    <PropertyFrame
      title="Meeting"
      permission="property.governance.read"
      crumb={{ label: 'Committees', path: '/committees' }}
      denied={{
        title: 'You cannot see meetings here',
        text: 'Meetings are for committee members and the property managers.',
      }}
    >
      {(ctx) => <Meeting ctx={ctx} />}
    </PropertyFrame>
  );
}

function Meeting({ ctx }: { ctx: PropertyContext }) {
  const { meetingId } = useParams<{ meetingId: string }>();
  const path = `${ctx.propertyPath}/meetings/${meetingId}`;
  const meeting = useApiQuery<MeetingDto>(path);
  const manage = ctx.can('property.governance.manage');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [item, setItem] = useState('');
  const [minutes, setMinutes] = useState('');
  const loaded = meeting.status === 'success' ? meeting.data : null;

  useEffect(() => {
    if (loaded) setMinutes(loaded.minutes ?? '');
  }, [loaded]);

  async function post(sub: string, body?: unknown, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}${sub}`, body);
      after?.();
      meeting.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (meeting.status === 'loading') return <LoadingState label="Loading meeting" />;
  if (meeting.status === 'error') {
    if (meeting.error instanceof ApiRequestError && meeting.error.status === 404) {
      return <EmptyState title="Meeting not found">It does not exist.</EmptyState>;
    }
    return <ErrorState error={meeting.error} onRetry={meeting.reload} />;
  }
  const m = meeting.data;
  const scheduled = m.status === 'SCHEDULED';
  const open = m.status === 'HELD' && !m.minutesApprovedAt;

  return (
    <>
      <Card title={m.title}>
        <p>
          <StatusBadge status={m.status} />{' '}
          {m.minutesApprovedAt ? <Badge tone="success">minutes approved</Badge> : null}
        </p>
        <p className="list__meta">
          {m.committee.name} · {formatInstant(m.scheduledAt, ctx.property.timeZone)}
          {m.location ? ` · ${m.location}` : ''}
          {m.cancelReason ? ` · cancelled: ${m.cancelReason}` : ''}
        </p>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {manage && scheduled ? (
          <div className="form__actions">
            <Button busy={busy} onClick={() => post('/held')}>
              Mark as held
            </Button>
            <BookingAction
              label="Cancel meeting"
              path={`${path}/cancel`}
              reason="required"
              variant="danger"
              onDone={meeting.reload}
            />
          </div>
        ) : null}
      </Card>

      <Card title="Agenda">
        {m.agenda.length === 0 ? <p className="muted">No agenda items.</p> : null}
        {m.agenda.length > 0 ? (
          <ol className="list" aria-label="Agenda">
            {m.agenda.map((a) => (
              <li key={a.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {a.position}. {a.title}
                  </p>
                  {a.details ? <p className="list__meta">{a.details}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        {manage && scheduled ? (
          <form
            aria-label="Add an agenda item"
            className="form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              post('/agenda', { title: item }, () => setItem(''));
            }}
          >
            <TextField
              label="Agenda item"
              value={item}
              maxLength={200}
              onChange={(e) => setItem(e.target.value)}
              required
            />
            <div className="form__actions">
              <Button type="submit" variant="secondary" busy={busy}>
                Add item
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      {m.status === 'HELD' ? (
        <Card title="Minutes">
          {manage && open ? (
            <form
              aria-label="Minutes"
              className="form"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                post('/minutes', { minutes });
              }}
            >
              <div className="field">
                <label className="field__label" htmlFor="meeting-minutes">
                  Minutes
                </label>
                <textarea
                  id="meeting-minutes"
                  className="field__input"
                  rows={8}
                  maxLength={50000}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  required
                />
              </div>
              <div className="form__actions">
                <Button type="submit" variant="secondary" busy={busy}>
                  Save minutes
                </Button>
                {m.minutes ? (
                  <Button busy={busy} onClick={() => post('/minutes/approve')}>
                    Approve minutes
                  </Button>
                ) : null}
              </div>
              <p className="muted">Once approved, the minutes and resolutions are final.</p>
            </form>
          ) : m.minutes ? (
            <p className="note">{m.minutes}</p>
          ) : (
            <p className="muted">No minutes yet.</p>
          )}
          {m.minutesApprovedAt ? (
            <p className="list__meta">
              Approved by {m.minutesApprovedBy} on{' '}
              {formatInstant(m.minutesApprovedAt, ctx.property.timeZone)}
            </p>
          ) : null}
        </Card>
      ) : null}

      {m.status === 'HELD' ? (
        <Card title="Resolutions">
          {m.resolutions.length === 0 ? <p className="muted">No resolutions recorded.</p> : null}
          {m.resolutions.length > 0 ? (
            <ul className="list" aria-label="Resolutions">
              {m.resolutions.map((r) => (
                <li key={r.id} className="list__item">
                  <div>
                    <p className="list__primary">
                      {r.reference} {r.title}{' '}
                      <Badge tone={r.outcome === 'PASSED' ? 'success' : 'muted'}>
                        {r.outcome.toLowerCase()}
                      </Badge>
                    </p>
                    <p className="note">{r.text}</p>
                    <p className="list__meta">
                      {r.votesFor !== null ? `For ${r.votesFor}` : ''}
                      {r.votesAgainst !== null ? ` · against ${r.votesAgainst}` : ''}
                      {r.abstentions !== null ? ` · abstained ${r.abstentions}` : ''}
                      {r.document ? ` · see "${r.document.title}"` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {manage && open ? <AddResolution ctx={ctx} path={path} onDone={meeting.reload} /> : null}
        </Card>
      ) : null}
    </>
  );
}

function AddResolution({
  ctx,
  path,
  onDone,
}: {
  ctx: PropertyContext;
  path: string;
  onDone: () => void;
}) {
  const documents = useApiQuery<{ data: DocumentDto[] }>(
    ctx.can('property.document.read') ? `${ctx.propertyPath}/documents` : null,
  );
  const [form, setForm] = useState({
    title: '',
    text: '',
    outcome: 'PASSED',
    votesFor: '',
    votesAgainst: '',
    abstentions: '',
    documentId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const count = (v: string) => (v.trim() === '' ? null : Number(v));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}/resolutions`, {
        title: form.title,
        text: form.text,
        outcome: form.outcome,
        votesFor: count(form.votesFor),
        votesAgainst: count(form.votesAgainst),
        abstentions: count(form.abstentions),
        documentId: form.documentId || null,
      });
      setForm((f) => ({
        ...f,
        title: '',
        text: '',
        votesFor: '',
        votesAgainst: '',
        abstentions: '',
      }));
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Record a resolution" className="form">
      <div className="form__row">
        <TextField
          label="Resolution"
          value={form.title}
          maxLength={200}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          required
        />
        <SelectField
          label="Outcome"
          value={form.outcome}
          onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))}
        >
          <option value="PASSED">Passed</option>
          <option value="REJECTED">Rejected</option>
          <option value="DEFERRED">Deferred</option>
        </SelectField>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="resolution-text">
          Text
        </label>
        <textarea
          id="resolution-text"
          className="field__input"
          maxLength={10000}
          value={form.text}
          onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
          required
        />
      </div>
      <div className="form__row">
        {(['votesFor', 'votesAgainst', 'abstentions'] as const).map((k) => (
          <TextField
            key={k}
            label={{ votesFor: 'For', votesAgainst: 'Against', abstentions: 'Abstained' }[k]}
            type="number"
            min={0}
            value={form[k]}
            onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
          />
        ))}
        <SelectField
          label="Supporting document"
          value={form.documentId}
          onChange={(e) => setForm((f) => ({ ...f, documentId: e.target.value }))}
        >
          <option value="">None</option>
          {(documents.status === 'success' ? documents.data.data : []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </SelectField>
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" busy={busy}>
          Record resolution
        </Button>
      </div>
    </form>
  );
}
