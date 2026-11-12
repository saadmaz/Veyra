'use client';

import type {
  AssetDetailDto,
  AssetDto,
  CommonAreaDto,
  Paginated,
  PropertyDetailResponse,
  RaiseDueWorkResultDto,
  ScheduleOverviewDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
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
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/maintenance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

/** The property's equipment and preventive maintenance, for maintenance staff. */
export default function AssetsPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canRead =
    property.status === 'success' &&
    property.data.permissions.includes('property.maintenance.read');
  const assets = useApiQuery<{ data: AssetDto[] }>(canRead ? `${base}/maintenance/assets` : null);
  const schedules = useApiQuery<ScheduleOverviewDto>(
    canRead ? `${base}/maintenance/schedules` : null,
  );
  const [raised, setRaised] = useState<RaiseDueWorkResultDto | null>(null);
  const [raising, setRaising] = useState(false);
  const [raiseError, setRaiseError] = useState<unknown>(null);

  useEffect(() => {
    if (property.status === 'success')
      document.title = `Assets · ${property.data.name} · VEYRA Console`;
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
          <h1>Assets</h1>
        </div>
        <EmptyState title="You cannot see assets here">
          Maintenance staff see the property's equipment.
        </EmptyState>
      </>
    );
  }
  const canManage = p.permissions.includes('property.maintenance.manage');
  const list = assets.status === 'success' ? assets.data.data : [];
  const due = schedules.status === 'success' ? schedules.data.data.filter((s) => s.due) : [];

  async function raiseDue() {
    setRaising(true);
    setRaiseError(null);
    try {
      setRaised(await api.post<RaiseDueWorkResultDto>(`${base}/maintenance/schedules/raise-due`));
      schedules.reload();
    } catch (e) {
      setRaiseError(e);
    } finally {
      setRaising(false);
    }
  }

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Assets</h1>
      </div>

      <Card title="Preventive work due">
        {schedules.status === 'loading' ? <LoadingState label="Loading schedules" /> : null}
        {schedules.status === 'error' ? (
          <ErrorState error={schedules.error} onRetry={schedules.reload} />
        ) : null}
        {schedules.status === 'success' && due.length === 0 ? (
          <p className="muted">
            Nothing is due. Schedules raise work orders within their lead time.
          </p>
        ) : null}
        {due.length > 0 ? (
          <ul className="list" aria-label="Due schedules">
            {due.map((s) => (
              <li key={s.schedule.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {s.schedule.title} <Badge tone="warning">due {s.schedule.nextDueOn}</Badge>
                  </p>
                  <p className="list__meta">
                    {s.asset ? `${s.asset.tag} · ${s.asset.name}` : ''}
                    {s.schedule.vendor ? ` · ${s.schedule.vendor.name}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {raised ? (
          <Alert tone="success" title="Work raised">
            {raised.raised.length === 0
              ? 'Nothing new to raise.'
              : raised.raised.map((r) => `${r.number} for ${r.assetTag}`).join(', ')}
            {raised.skipped.length > 0
              ? ` · ${raised.skipped.length} skipped (equipment out of service)`
              : ''}
          </Alert>
        ) : null}
        {raiseError ? <Alert>{errorMessage(raiseError)}</Alert> : null}
        {canManage ? (
          <div className="form__actions">
            <Button busy={raising} onClick={raiseDue}>
              Raise due work
            </Button>
          </div>
        ) : null}
      </Card>

      <Card title="Register">
        {assets.status === 'loading' ? <LoadingState label="Loading assets" /> : null}
        {assets.status === 'error' ? (
          <ErrorState error={assets.error} onRetry={assets.reload} />
        ) : null}
        {assets.status === 'success' && list.length === 0 ? (
          <p className="muted">No equipment registered yet.</p>
        ) : null}
        {list.length > 0 ? (
          <ul className="list" aria-label="Assets">
            {list.map((a) => (
              <li key={a.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${base}/assets/${a.id}`}>
                      {a.tag} · {a.name}
                    </Link>{' '}
                    <StatusBadge status={a.status} />
                  </p>
                  <p className="list__meta">
                    {CATEGORY_LABELS[a.category]} ·{' '}
                    {a.unitNumber ? `Unit ${a.unitNumber}` : a.commonAreaName}
                    {a.underWarranty ? ' · under warranty' : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {canManage ? <AddAsset base={base} /> : null}
    </>
  );
}

function AddAsset({ base }: { base: string }) {
  const router = useRouter();
  const areas = useApiQuery<Paginated<CommonAreaDto>>(`${base}/common-areas?limit=200`);
  const [form, setForm] = useState({ tag: '', name: '', category: 'PLUMBING', commonAreaId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const options =
    areas.status === 'success' ? areas.data.data.filter((a) => a.status === 'ACTIVE') : [];
  const areaId = form.commonAreaId || options[0]?.id || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<AssetDetailDto>(`${base}/maintenance/assets`, {
        tag: form.tag,
        name: form.name,
        category: form.category,
        commonAreaId: areaId,
      });
      router.push(`${base}/assets/${created.asset.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const errors = fieldErrors(error);
  return (
    <Card title="Register equipment">
      {areas.status === 'success' && options.length === 0 ? (
        <p className="muted">Add a common area (for example a plant room) first.</p>
      ) : null}
      {options.length > 0 ? (
        <form onSubmit={submit} aria-label="Register equipment" className="form">
          <div className="form__row">
            <TextField
              label="Tag"
              value={form.tag}
              maxLength={30}
              onChange={set('tag')}
              hint="For example LIFT-01"
              error={errors.tag}
              required
            />
            <TextField
              label="Name"
              value={form.name}
              maxLength={120}
              onChange={set('name')}
              required
            />
          </div>
          <div className="form__row">
            <SelectField label="Trade" value={form.category} onChange={set('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </SelectField>
            <SelectField label="Where" value={areaId} onChange={set('commonAreaId')}>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </SelectField>
          </div>
          {error ? <Alert>{errorMessage(error)}</Alert> : null}
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              Register
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
