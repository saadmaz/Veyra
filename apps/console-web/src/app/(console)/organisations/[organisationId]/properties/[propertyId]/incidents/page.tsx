'use client';

import type {
  EscalationContactDto,
  IncidentCategory,
  IncidentDetailDto,
  IncidentDto,
  IncidentSeverity,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { ContactList } from '@/components/incidents';
import { type PropertyContext, PropertyFrame } from '@/components/property-frame';
import {
  Alert,
  Badge,
  Button,
  Card,
  CheckboxField,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import {
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_STATUS_LABELS,
  SEVERITY_LABELS,
  SEVERITY_TONES,
} from '@/lib/governance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant, instantToZonedLocal, zonedLocalToInstant } from '@/lib/visitors';

/** A property's incidents: staff report them, managers run the response and keep the contacts. */
export default function IncidentsPage() {
  return (
    <PropertyFrame
      title="Incidents"
      permission="property.incident.read"
      denied={{
        title: 'You cannot see incidents here',
        text: 'Incidents are for the property team: managers, security and maintenance staff.',
      }}
    >
      {(ctx) => <Incidents ctx={ctx} />}
    </PropertyFrame>
  );
}

function Incidents({ ctx }: { ctx: PropertyContext }) {
  const [all, setAll] = useState(false);
  const base = `${ctx.propertyPath}/incidents`;
  const list = useApiQuery<{ data: IncidentDto[] }>(`${base}?status=${all ? 'all' : 'open'}`);
  const rows = list.status === 'success' ? list.data.data : [];
  const tz = ctx.property.timeZone;
  return (
    <>
      <p className="muted">
        VEYRA records and coordinates the response. In an emergency, call the emergency services
        first.
      </p>
      <Card title={all ? 'All incidents' : 'Open incidents'}>
        <CheckboxField
          label="Show closed incidents too"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        {list.status === 'loading' ? <LoadingState label="Loading incidents" /> : null}
        {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.status === 'success' && rows.length === 0 ? (
          <p className="muted">No incidents.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Incidents">
            {rows.map((i) => (
              <li key={i.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${base}/${i.id}`}>
                      {i.reference} {i.title}
                    </Link>{' '}
                    <Badge tone={SEVERITY_TONES[i.severity]}>{SEVERITY_LABELS[i.severity]}</Badge>{' '}
                    {i.sensitive ? <Badge>sensitive</Badge> : null}
                  </p>
                  <p className="list__meta">
                    {INCIDENT_STATUS_LABELS[i.status]} · {INCIDENT_CATEGORY_LABELS[i.category]} ·{' '}
                    {formatInstant(i.occurredAt, tz)} · reported by {i.reportedBy}
                    {i.openActions > 0 ? ` · ${i.openActions} follow-ups open` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      {ctx.can('property.incident.report') ? <Report ctx={ctx} onDone={list.reload} /> : null}
      <Contacts ctx={ctx} />
    </>
  );
}

function Report({ ctx, onDone }: { ctx: PropertyContext; onDone: () => void }) {
  const tz = ctx.property.timeZone;
  const [form, setForm] = useState({
    title: '',
    description: '',
    category: 'SECURITY' as IncidentCategory,
    severity: 'MEDIUM' as IncidentSeverity,
    occurredAt: instantToZonedLocal(new Date(), tz),
    locationDetail: '',
    sensitive: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<IncidentDto | null>(null);
  const fields = fieldErrors(error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const occurredAt = zonedLocalToInstant(form.occurredAt, tz);
      const created = await api.post<IncidentDetailDto>(`${ctx.propertyPath}/incidents`, {
        category: form.category,
        severity: form.severity,
        title: form.title,
        description: form.description,
        occurredAt,
        locationDetail: form.locationDetail || null,
        sensitive: form.sensitive,
      });
      setDone(created.incident);
      setForm((f) => ({ ...f, title: '', description: '', locationDetail: '', sensitive: false }));
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Report an incident">
      <form onSubmit={submit} aria-label="Report an incident" className="form">
        <div className="form__row">
          <TextField
            label="What happened"
            value={form.title}
            maxLength={160}
            error={fields.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            required
          />
          <SelectField
            label="Kind"
            value={form.category}
            onChange={(e) =>
              setForm((f) => ({ ...f, category: e.target.value as IncidentCategory }))
            }
          >
            {Object.entries(INCIDENT_CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Severity"
            value={form.severity}
            onChange={(e) =>
              setForm((f) => ({ ...f, severity: e.target.value as IncidentSeverity }))
            }
          >
            {Object.entries(SEVERITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="incident-description">
            Details
          </label>
          <textarea
            id="incident-description"
            className="field__input"
            maxLength={4000}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            required
          />
        </div>
        <div className="form__row">
          <TextField
            label="When"
            type="datetime-local"
            value={form.occurredAt}
            error={fields.occurredAt}
            onChange={(e) => setForm((f) => ({ ...f, occurredAt: e.target.value }))}
            required
          />
          <TextField
            label="Where (optional)"
            value={form.locationDetail}
            maxLength={200}
            onChange={(e) => setForm((f) => ({ ...f, locationDetail: e.target.value }))}
          />
        </div>
        <CheckboxField
          label="Sensitive (only managers and you can see it)"
          checked={form.sensitive}
          onChange={(e) => setForm((f) => ({ ...f, sensitive: e.target.checked }))}
        />
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {done ? (
          <Alert tone="success">
            Reported as {done.reference}.
            {done.severity === 'HIGH' || done.severity === 'CRITICAL'
              ? ' The managers have been alerted.'
              : ''}
          </Alert>
        ) : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Report
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Contacts({ ctx }: { ctx: PropertyContext }) {
  const path = `${ctx.propertyPath}/escalation-contacts`;
  const contacts = useApiQuery<{ data: EscalationContactDto[] }>(path);
  const manage = ctx.can('property.incident.manage');
  const rows = contacts.status === 'success' ? contacts.data.data : [];
  return (
    <Card title="Whom to call">
      {contacts.status === 'loading' ? <LoadingState label="Loading contacts" /> : null}
      {contacts.status === 'error' ? (
        <ErrorState error={contacts.error} onRetry={contacts.reload} />
      ) : null}
      {contacts.status === 'success' && rows.length === 0 ? (
        <p className="muted">No escalation contacts yet.</p>
      ) : null}
      {rows.length > 0 ? <ContactList contacts={rows} /> : null}
      {manage ? <AddContact path={path} onDone={contacts.reload} /> : null}
    </Card>
  );
}

function AddContact({ path, onDone }: { path: string; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', role: '', phone: '', email: '', category: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fields = fieldErrors(error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(path, {
        name: form.name,
        role: form.role,
        phone: form.phone,
        email: form.email || null,
        categories: form.category ? [form.category] : [],
        position: 0,
      });
      setForm({ name: '', role: '', phone: '', email: '', category: '' });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add a contact" className="form">
      <div className="form__row">
        <TextField
          label="Name"
          value={form.name}
          maxLength={120}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
        />
        <TextField
          label="Role"
          value={form.role}
          maxLength={120}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
          required
        />
        <TextField
          label="Phone"
          type="tel"
          value={form.phone}
          error={fields.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          required
        />
        <TextField
          label="Email (optional)"
          type="email"
          value={form.email}
          error={fields.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
        <SelectField
          label="For"
          value={form.category}
          onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
        >
          <option value="">Every kind of incident</option>
          {Object.entries(INCIDENT_CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" variant="secondary" busy={busy}>
          Add contact
        </Button>
      </div>
    </form>
  );
}
