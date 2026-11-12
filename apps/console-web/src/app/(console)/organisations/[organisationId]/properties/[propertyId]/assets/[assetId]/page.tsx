'use client';

import type { AssetDetailDto, PropertyDetailResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { BookingAction } from '@/components/facilities';
import { WorkBadge } from '@/components/maintenance';
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
import { CATEGORY_LABELS } from '@/lib/maintenance';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

const UNIT_LABELS = { DAY: 'day', WEEK: 'week', MONTH: 'month' } as const;

/** One piece of equipment: details, schedules of repeating work, and its service history. */
export default function AssetPage() {
  const { organisationId, propertyId, assetId } = useParams<{
    organisationId: string;
    propertyId: string;
    assetId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const path = `${base}/maintenance/assets/${assetId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const detail = useApiQuery<AssetDetailDto>(path);

  useEffect(() => {
    if (detail.status === 'success')
      document.title = `${detail.data.asset.tag} · Assets · VEYRA Console`;
  }, [detail]);

  if (detail.status === 'loading' || property.status === 'loading')
    return <LoadingState label="Loading asset" />;
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && [403, 404].includes(detail.error.status)) {
      return (
        <EmptyState title="Asset not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }
  if (property.status === 'error')
    return <ErrorState error={property.error} onRetry={property.reload} />;
  const { asset: a, schedules, history } = detail.data;
  const canManage =
    property.data.permissions.includes('property.maintenance.manage') && a.status !== 'RETIRED';

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{property.data.name}</Link>
        {' / '}
        <Link href={`${base}/assets`}>Assets</Link>
      </nav>
      <div className="page__header">
        <h1>
          {a.tag} · {a.name} <StatusBadge status={a.status} />
        </h1>
      </div>

      <Card title="Details">
        <dl className="details">
          <div>
            <dt>Trade</dt>
            <dd>{CATEGORY_LABELS[a.category]}</dd>
          </div>
          <div>
            <dt>Where</dt>
            <dd>{a.unitNumber ? `Unit ${a.unitNumber}` : a.commonAreaName}</dd>
          </div>
          <div>
            <dt>Make and model</dt>
            <dd>
              {[a.manufacturer, a.model, a.serialNumber].filter(Boolean).join(' · ') ||
                'Not recorded'}
            </dd>
          </div>
          <div>
            <dt>Warranty</dt>
            <dd>
              {a.warrantyExpiresOn
                ? `${a.underWarranty ? 'until' : 'ended'} ${a.warrantyExpiresOn}`
                : 'Not recorded'}
            </dd>
          </div>
          {a.supplier ? (
            <div>
              <dt>Supplier</dt>
              <dd>{a.supplier.name}</dd>
            </div>
          ) : null}
          {a.statusNote ? (
            <div>
              <dt>Note</dt>
              <dd>{a.statusNote}</dd>
            </div>
          ) : null}
        </dl>
        {canManage ? (
          <div className="form__actions">
            {a.status === 'ACTIVE' ? (
              <BookingAction
                label="Out of service"
                path={`${path}/out-of-service`}
                reason="required"
                onDone={detail.reload}
              />
            ) : (
              <BookingAction
                label="Back in service"
                path={`${path}/back-in-service`}
                reason="none"
                onDone={detail.reload}
              />
            )}
            <BookingAction
              label="Retire"
              path={`${path}/retire`}
              reason="required"
              variant="danger"
              onDone={detail.reload}
            />
          </div>
        ) : null}
      </Card>

      <Card title="Repeating work">
        {schedules.length === 0 ? <p className="muted">No schedules.</p> : null}
        {schedules.length > 0 ? (
          <ul className="list" aria-label="Schedules">
            {schedules.map((s) => (
              <li key={s.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {s.title}{' '}
                    {s.active ? <Badge tone="success">active</Badge> : <Badge>paused</Badge>}
                  </p>
                  <p className="list__meta">
                    Every {s.intervalCount} {UNIT_LABELS[s.intervalUnit]}
                    {s.intervalCount === 1 ? '' : 's'} · next due {s.nextDueOn} · raised{' '}
                    {s.leadDays} days before
                    {s.vendor ? ` · ${s.vendor.name}` : ''}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      api
                        .patch(`${base}/maintenance/schedules/${s.id}`, { active: !s.active })
                        .then(detail.reload)
                    }
                  >
                    {s.active ? 'Pause' : 'Resume'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canManage ? <AddSchedule path={path} onAdded={detail.reload} /> : null}
      </Card>

      <Card title="Service history">
        {history.length === 0 ? <p className="muted">No work recorded on this equipment.</p> : null}
        {history.length > 0 ? (
          <ul className="list" aria-label="Service history">
            {history.map((w) => (
              <li key={w.id} className="list__item">
                <p className="list__primary">
                  <Link href={`${base}/maintenance/work-orders/${w.id}`}>
                    {w.number} · {w.title}
                  </Link>{' '}
                  <WorkBadge status={w.status} />
                </p>
                <p className="list__meta">
                  {w.scheduledFor ? `Scheduled for ${w.scheduledFor}` : 'Raised by hand'}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}

function AddSchedule({ path, onAdded }: { path: string; onAdded: () => void }) {
  const [form, setForm] = useState({
    title: '',
    intervalUnit: 'MONTH',
    intervalCount: '1',
    nextDueOn: '',
    leadDays: '7',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}/schedules`, {
        title: form.title,
        intervalUnit: form.intervalUnit,
        intervalCount: Number(form.intervalCount),
        nextDueOn: form.nextDueOn,
        leadDays: Number(form.leadDays),
      });
      setForm({
        title: '',
        intervalUnit: 'MONTH',
        intervalCount: '1',
        nextDueOn: '',
        leadDays: '7',
      });
      onAdded();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add repeating work" className="form">
      <div className="form__row">
        <TextField
          label="Work"
          value={form.title}
          maxLength={120}
          onChange={set('title')}
          required
        />
        <TextField
          label="Every"
          type="number"
          min={1}
          value={form.intervalCount}
          onChange={set('intervalCount')}
        />
        <SelectField label="Period" value={form.intervalUnit} onChange={set('intervalUnit')}>
          <option value="DAY">days</option>
          <option value="WEEK">weeks</option>
          <option value="MONTH">months</option>
        </SelectField>
      </div>
      <div className="form__row">
        <TextField
          label="First due"
          type="date"
          value={form.nextDueOn}
          onChange={set('nextDueOn')}
          required
        />
        <TextField
          label="Raise this many days before"
          type="number"
          min={0}
          value={form.leadDays}
          onChange={set('leadDays')}
        />
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" busy={busy}>
          Add schedule
        </Button>
      </div>
    </form>
  );
}
