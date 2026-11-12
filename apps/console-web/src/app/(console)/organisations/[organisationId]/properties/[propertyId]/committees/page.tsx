'use client';

import type {
  CommitteeCandidateDto,
  CommitteeDto,
  CommitteePosition,
  MeetingDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { type PropertyContext, PropertyFrame } from '@/components/property-frame';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import { POSITION_LABELS } from '@/lib/governance';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant, instantToZonedLocal, zonedLocalToInstant } from '@/lib/visitors';

/** A property's committees, their members and meetings. */
export default function CommitteesPage() {
  return (
    <PropertyFrame
      title="Committees"
      permission="property.governance.read"
      denied={{
        title: 'You cannot see committees here',
        text: 'Committees are for their members and the property managers.',
      }}
    >
      {(ctx) => <Committees ctx={ctx} />}
    </PropertyFrame>
  );
}

function Committees({ ctx }: { ctx: PropertyContext }) {
  const committees = useApiQuery<{ data: CommitteeDto[] }>(`${ctx.propertyPath}/committees`);
  const meetings = useApiQuery<{ data: MeetingDto[] }>(`${ctx.propertyPath}/meetings`);
  const manage = ctx.can('property.governance.manage');
  const rows = committees.status === 'success' ? committees.data.data : [];
  const reload = () => {
    committees.reload();
    meetings.reload();
  };
  return (
    <>
      {committees.status === 'loading' ? <LoadingState label="Loading committees" /> : null}
      {committees.status === 'error' ? (
        <ErrorState error={committees.error} onRetry={committees.reload} />
      ) : null}
      {committees.status === 'success' && rows.length === 0 ? (
        <p className="muted">No committees yet.</p>
      ) : null}
      {rows.map((c) => (
        <Committee key={c.id} ctx={ctx} committee={c} manage={manage} onDone={reload} />
      ))}
      {manage ? <NewCommittee ctx={ctx} onDone={committees.reload} /> : null}
      <Card title="Meetings">
        {meetings.status === 'loading' ? <LoadingState label="Loading meetings" /> : null}
        {meetings.status === 'error' ? (
          <ErrorState error={meetings.error} onRetry={meetings.reload} />
        ) : null}
        {meetings.status === 'success' && meetings.data.data.length === 0 ? (
          <p className="muted">No meetings yet.</p>
        ) : null}
        {meetings.status === 'success' && meetings.data.data.length > 0 ? (
          <ul className="list" aria-label="Meetings">
            {meetings.data.data.map((m) => (
              <li key={m.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${ctx.propertyPath}/meetings/${m.id}`}>{m.title}</Link>{' '}
                    <StatusBadge status={m.status} />{' '}
                    {m.minutesApprovedAt ? <Badge tone="success">minutes approved</Badge> : null}
                  </p>
                  <p className="list__meta">
                    {m.committee.name} · {formatInstant(m.scheduledAt, ctx.property.timeZone)}
                    {m.resolutions.length > 0 ? ` · ${m.resolutions.length} resolutions` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}

function Committee({
  ctx,
  committee: c,
  manage,
  onDone,
}: {
  ctx: PropertyContext;
  committee: CommitteeDto;
  manage: boolean;
  onDone: () => void;
}) {
  const path = `${ctx.propertyPath}/committees/${c.id}`;
  const [error, setError] = useState<unknown>(null);
  const active = c.status === 'ACTIVE';
  const current = c.seats.filter((s) => s.current);

  async function endTerm(seatId: string) {
    setError(null);
    try {
      await api.post(`${path}/seats/${seatId}/end`, {
        termEnd: instantToZonedLocal(new Date(), ctx.property.timeZone).slice(0, 10),
      });
      onDone();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Card title={c.name}>
      {c.purpose ? <p className="note">{c.purpose}</p> : null}
      {active ? null : <Badge>dissolved</Badge>}
      {current.length === 0 ? <p className="muted">Nobody holds a seat now.</p> : null}
      {current.length > 0 ? (
        <ul className="list" aria-label={`Members of ${c.name}`}>
          {current.map((s) => (
            <li key={s.id} className="list__item">
              <div>
                <p className="list__primary">
                  {s.name} · {POSITION_LABELS[s.position]}
                </p>
                <p className="list__meta">
                  Since {s.termStart}
                  {s.termEnd ? `, until ${s.termEnd}` : ''}
                </p>
              </div>
              {manage && active && !s.termEnd ? (
                <Button variant="secondary" onClick={() => endTerm(s.id)}>
                  End term today
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {manage && active ? (
        <>
          <AddSeat ctx={ctx} path={path} name={c.name} onDone={onDone} />
          <Schedule ctx={ctx} path={path} name={c.name} onDone={onDone} />
        </>
      ) : null}
    </Card>
  );
}

function AddSeat({
  ctx,
  path,
  name,
  onDone,
}: {
  ctx: PropertyContext;
  path: string;
  name: string;
  onDone: () => void;
}) {
  const people = useApiQuery<{ data: CommitteeCandidateDto[] }>(
    `${ctx.propertyPath}/committees/candidates`,
  );
  const options = people.status === 'success' ? people.data.data : [];
  const today = instantToZonedLocal(new Date(), ctx.property.timeZone).slice(0, 10);
  const [form, setForm] = useState({
    userId: '',
    position: 'MEMBER' as CommitteePosition,
    termStart: today,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const userId = form.userId || options[0]?.userId || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}/seats`, { ...form, userId });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (people.status === 'success' && options.length === 0) {
    return (
      <p className="muted">
        To seat someone, first invite them to the property with the Committee member role.
      </p>
    );
  }
  return (
    <form onSubmit={submit} aria-label={`Add a member to ${name}`} className="form">
      <div className="form__row">
        <SelectField
          label="Person"
          value={userId}
          onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
        >
          {options.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Position"
          value={form.position}
          onChange={(e) =>
            setForm((f) => ({ ...f, position: e.target.value as CommitteePosition }))
          }
        >
          {Object.entries(POSITION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Term starts"
          type="date"
          value={form.termStart}
          onChange={(e) => setForm((f) => ({ ...f, termStart: e.target.value }))}
          required
        />
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" variant="secondary" busy={busy}>
          Add member
        </Button>
      </div>
    </form>
  );
}

function Schedule({
  ctx,
  path,
  name,
  onDone,
}: {
  ctx: PropertyContext;
  path: string;
  name: string;
  onDone: () => void;
}) {
  const tz = ctx.property.timeZone;
  const [form, setForm] = useState({
    title: '',
    when: instantToZonedLocal(new Date(), tz),
    location: '',
    agenda: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}/meetings`, {
        title: form.title,
        scheduledAt: zonedLocalToInstant(form.when, tz),
        location: form.location || null,
        agenda: form.agenda
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((title) => ({ title })),
      });
      setForm((f) => ({ ...f, title: '', agenda: '' }));
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label={`Schedule a meeting of ${name}`} className="form">
      <div className="form__row">
        <TextField
          label="Meeting"
          value={form.title}
          maxLength={160}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          required
        />
        <TextField
          label="When"
          type="datetime-local"
          value={form.when}
          onChange={(e) => setForm((f) => ({ ...f, when: e.target.value }))}
          required
        />
        <TextField
          label="Where (optional)"
          value={form.location}
          maxLength={200}
          onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`agenda-${path}`}>
          Agenda (one item per line)
        </label>
        <textarea
          id={`agenda-${path}`}
          className="field__input"
          value={form.agenda}
          onChange={(e) => setForm((f) => ({ ...f, agenda: e.target.value }))}
        />
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" busy={busy}>
          Schedule meeting
        </Button>
      </div>
    </form>
  );
}

function NewCommittee({ ctx, onDone }: { ctx: PropertyContext; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', purpose: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${ctx.propertyPath}/committees`, {
        name: form.name,
        purpose: form.purpose || null,
      });
      setForm({ name: '', purpose: '' });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Form a committee">
      <form onSubmit={submit} aria-label="Form a committee" className="form">
        <div className="form__row">
          <TextField
            label="Name"
            value={form.name}
            maxLength={120}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
          />
          <TextField
            label="Purpose (optional)"
            value={form.purpose}
            maxLength={2000}
            onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
          />
        </div>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <div className="form__actions">
          <Button type="submit" variant="secondary" busy={busy}>
            Form committee
          </Button>
        </div>
      </form>
    </Card>
  );
}
