'use client';

import type { PropertyDetailResponse, WorkOrderDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WorkBadge } from '@/components/maintenance';
import { Card, EmptyState, ErrorState, LoadingState, SelectField } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { CATEGORY_LABELS, PRIORITY_LABELS, placeText } from '@/lib/maintenance';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

type Show = 'current' | 'COMPLETED' | 'CANCELLED';
const CURRENT = ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

/** A technician's own work at a property (property.maintenance.work): nobody else's. */
export default function MyWorkPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const propertyPath = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyPath);
  const [show, setShow] = useState<Show>('current');
  const work = useApiQuery<{ data: WorkOrderDto[] }>(
    `${propertyPath}/my-work-orders${show === 'current' ? '' : `?status=${show}`}`,
  );

  useEffect(() => {
    if (property.status === 'success')
      document.title = `My work · ${property.data.name} · VEYRA Console`;
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading" />;
  if (property.status === 'error') {
    if (property.error instanceof ApiRequestError && property.error.status === 404) {
      return (
        <EmptyState title="Property not found">It does not exist, or it is not yours.</EmptyState>
      );
    }
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }
  const p = property.data;
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={propertyPath}>{p.name}</Link>
    </nav>
  );
  if (!p.permissions.includes('property.maintenance.work')) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>My work</h1>
        </div>
        <EmptyState title="No maintenance work for your role">
          Technicians and the maintenance team see the work assigned to them here.
        </EmptyState>
      </>
    );
  }
  const rows =
    work.status === 'success'
      ? work.data.data.filter((w) => (show === 'current' ? CURRENT.includes(w.status) : true))
      : [];
  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>My work</h1>
      </div>
      <Card title="Work assigned to you">
        <div className="form form--inline">
          <SelectField label="Show" value={show} onChange={(e) => setShow(e.target.value as Show)}>
            <option value="current">To do</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </SelectField>
        </div>
        {work.status === 'loading' ? <LoadingState label="Loading work" /> : null}
        {work.status === 'error' ? <ErrorState error={work.error} onRetry={work.reload} /> : null}
        {work.status === 'success' && rows.length === 0 ? (
          <p className="muted">
            {show === 'current' ? 'Nothing to do right now.' : 'Nothing here.'}
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="My work">
            {rows.map((w) => (
              <li key={w.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${propertyPath}/my-work/${w.id}`}>{w.title}</Link>{' '}
                    <WorkBadge status={w.status} />
                  </p>
                  <p className="list__meta">
                    {w.number} · {placeText(w)} · {CATEGORY_LABELS[w.category]} ·{' '}
                    {PRIORITY_LABELS[w.priority]}
                    {w.dueAt ? ` · due ${formatInstant(w.dueAt, p.timeZone)}` : ''}
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
