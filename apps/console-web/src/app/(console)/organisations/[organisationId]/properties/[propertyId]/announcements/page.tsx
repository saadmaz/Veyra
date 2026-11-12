'use client';

import type {
  AnnouncementAudience,
  AnnouncementDetailDto,
  AnnouncementDto,
  BuildingDto,
  NotificationDeliveryDto,
  Paginated,
  PropertyDetailResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { BookingAction } from '@/components/facilities';
import {
  Alert,
  Badge,
  Button,
  Card,
  CheckboxField,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { AUDIENCE_LABELS } from '@/lib/communications';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

/** A property's announcements for managers: draft, publish, withdraw, and who read them. */
export default function AnnouncementsPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canRead =
    property.status === 'success' &&
    property.data.permissions.includes('property.announcement.read');
  const list = useApiQuery<{ data: AnnouncementDto[] }>(canRead ? `${base}/announcements` : null);
  const deliveries = useApiQuery<{ data: NotificationDeliveryDto[] }>(
    canRead ? `${base}/notification-deliveries?status=FAILED` : null,
  );

  useEffect(() => {
    if (property.status === 'success')
      document.title = `Announcements · ${property.data.name} · VEYRA Console`;
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading property" />;
  if (property.status === 'error') {
    if (property.error instanceof ApiRequestError && property.error.status === 404) {
      return (
        <EmptyState title="Property not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }
  const p = property.data;
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={base}>{p.name}</Link>
    </nav>
  );
  if (!canRead) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>Announcements</h1>
        </div>
        <EmptyState title="You cannot see announcements here">
          Property managers publish announcements.
        </EmptyState>
      </>
    );
  }
  const canManage = p.permissions.includes('property.announcement.manage');
  const rows = list.status === 'success' ? list.data.data : [];
  const failed = deliveries.status === 'success' ? deliveries.data.data : [];

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Announcements</h1>
      </div>
      {canManage ? <Compose base={base} onDone={list.reload} /> : null}
      <Card title="Sent and drafts">
        {list.status === 'loading' ? <LoadingState label="Loading announcements" /> : null}
        {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.status === 'success' && rows.length === 0 ? (
          <p className="muted">No announcements yet.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Announcements">
            {rows.map((a) => (
              <li key={a.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {a.title} <StatusBadge status={a.status} />{' '}
                    {a.priority === 'URGENT' ? <Badge tone="danger">urgent</Badge> : null}
                  </p>
                  <p className="list__meta">
                    {AUDIENCE_LABELS[a.audience]}
                    {a.building ? ` (${a.building.name})` : ''}
                    {a.status !== 'DRAFT'
                      ? ` · reached ${a.delivery.recipients}, read by ${a.delivery.read}${a.requiresAcknowledgement ? `, acknowledged by ${a.delivery.acknowledged}` : ''}`
                      : ''}
                    {a.withdrawReason ? ` · withdrawn: ${a.withdrawReason}` : ''}
                  </p>
                </div>
                {canManage && a.status === 'DRAFT' ? (
                  <BookingAction
                    label="Publish"
                    path={`${base}/announcements/${a.id}/publish`}
                    reason="none"
                    variant="primary"
                    onDone={list.reload}
                  />
                ) : null}
                {canManage && a.status === 'PUBLISHED' ? (
                  <BookingAction
                    label="Withdraw"
                    path={`${base}/announcements/${a.id}/withdraw`}
                    reason="required"
                    variant="danger"
                    onDone={list.reload}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <Card title="Emails that could not be sent">
        {deliveries.status === 'success' && failed.length === 0 ? (
          <p className="muted">Every email went out, or is still being sent.</p>
        ) : null}
        {failed.length > 0 ? (
          <ul className="list" aria-label="Failed deliveries">
            {failed.map((d) => (
              <li key={d.id} className="list__item">
                <p className="list__primary">
                  {d.title} to {d.recipient}
                </p>
                <p className="list__meta">
                  {d.attempts} attempts · {d.lastError ?? 'unknown error'}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}

function Compose({ base, onDone }: { base: string; onDone: () => void }) {
  const buildings = useApiQuery<Paginated<BuildingDto>>(`${base}/buildings?limit=200`);
  const [form, setForm] = useState({
    title: '',
    body: '',
    audience: 'RESIDENTS' as AnnouncementAudience,
    buildingId: '',
    urgent: false,
    ack: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const options =
    buildings.status === 'success' ? buildings.data.data.filter((b) => b.status === 'ACTIVE') : [];
  const buildingId = form.buildingId || options[0]?.id || '';

  async function submit(event: FormEvent, publish: boolean) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const draft = await api.post<AnnouncementDetailDto>(`${base}/announcements`, {
        title: form.title,
        body: form.body,
        audience: form.audience,
        buildingId: form.audience === 'BUILDING_RESIDENTS' ? buildingId : null,
        priority: form.urgent ? 'URGENT' : 'NORMAL',
        requiresAcknowledgement: form.ack,
      });
      if (publish) {
        const sent = await api.post<AnnouncementDetailDto>(
          `${base}/announcements/${draft.announcement.id}/publish`,
        );
        setDone(`Published to ${sent.announcement.delivery.recipients} people.`);
      } else {
        setDone('Saved as a draft.');
      }
      setForm((f) => ({ ...f, title: '', body: '' }));
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New announcement">
      <form onSubmit={(e) => submit(e, true)} aria-label="New announcement" className="form">
        <TextField
          label="Title"
          value={form.title}
          maxLength={160}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          required
        />
        <div className="field">
          <label className="field__label" htmlFor="announcement-body">
            Message
          </label>
          <textarea
            id="announcement-body"
            className="field__input"
            maxLength={10000}
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            required
          />
        </div>
        <div className="form__row">
          <SelectField
            label="Who"
            value={form.audience}
            onChange={(e) =>
              setForm((f) => ({ ...f, audience: e.target.value as AnnouncementAudience }))
            }
          >
            {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          {form.audience === 'BUILDING_RESIDENTS' ? (
            <SelectField
              label="Building"
              value={buildingId}
              onChange={(e) => setForm((f) => ({ ...f, buildingId: e.target.value }))}
            >
              {options.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
        <CheckboxField
          label="Urgent (also sent by email)"
          checked={form.urgent}
          onChange={(e) => setForm((f) => ({ ...f, urgent: e.target.checked }))}
        />
        <CheckboxField
          label="Ask people to confirm they have read it"
          checked={form.ack}
          onChange={(e) => setForm((f) => ({ ...f, ack: e.target.checked }))}
        />
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {done ? <Alert tone="success">{done}</Alert> : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Publish now
          </Button>
          <Button variant="secondary" busy={busy} onClick={(e) => submit(e, false)}>
            Save draft
          </Button>
        </div>
      </form>
    </Card>
  );
}
