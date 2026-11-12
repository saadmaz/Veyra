'use client';

import type { MaintenanceRequestDto, UnitDetailResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ReportForm, RequestBadge } from '@/components/maintenance';
import { Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { CATEGORY_LABELS } from '@/lib/maintenance';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

/** A unit's maintenance requests for its residents: report a problem and follow it. */
export default function UnitMaintenancePage() {
  const { organisationId, propertyId, unitId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const router = useRouter();
  const unitPath = `/organisations/${organisationId}/properties/${propertyId}/units/${unitId}`;
  const base = `${unitPath}/maintenance-requests`;
  const unit = useApiQuery<UnitDetailResponse>(unitPath);
  const requests = useApiQuery<{ data: MaintenanceRequestDto[] }>(base);

  useEffect(() => {
    if (unit.status === 'success') {
      document.title = `Maintenance · Unit ${unit.data.unitNumber} · VEYRA Console`;
    }
  }, [unit]);

  if (unit.status === 'loading') return <LoadingState label="Loading unit" />;
  if (unit.status === 'error') {
    if (unit.error instanceof ApiRequestError && unit.error.status === 404) {
      return (
        <EmptyState title="Unit not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={unit.error} onRetry={unit.reload} />;
  }
  const u = unit.data;
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={`/organisations/${organisationId}`}>{u.propertyName}</Link>
      {' / '}
      <Link href={unitPath}>Unit {u.unitNumber}</Link>
    </nav>
  );
  if (!u.permissions.includes('unit.maintenance.request')) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>Maintenance</h1>
        </div>
        <EmptyState title="Maintenance is for the people who live here">
          Owners, tenants and household members report problems in their home here.
        </EmptyState>
      </>
    );
  }
  const rows = requests.status === 'success' ? requests.data.data : [];
  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Maintenance</h1>
      </div>
      {u.status === 'ACTIVE' ? (
        <Card title="Report a problem">
          <p className="muted">
            The property team sees your report and keeps you updated here. Add photos on the next
            page.
          </p>
          <ReportForm
            path={base}
            onCreated={(id) => router.push(`${unitPath}/maintenance/${id}`)}
          />
        </Card>
      ) : null}
      <Card title="Requests">
        {requests.status === 'loading' ? <LoadingState label="Loading requests" /> : null}
        {requests.status === 'error' ? (
          <ErrorState error={requests.error} onRetry={requests.reload} />
        ) : null}
        {requests.status === 'success' && rows.length === 0 ? (
          <p className="muted">Nothing has been reported for this home yet.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Requests">
            {rows.map((r) => (
              <li key={r.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${unitPath}/maintenance/${r.id}`}>{r.title}</Link>{' '}
                    <RequestBadge status={r.status} />
                  </p>
                  <p className="list__meta">
                    {r.number} · {CATEGORY_LABELS[r.category]} · reported by {r.submittedBy.name} on{' '}
                    {formatInstant(r.createdAt, u.propertyTimeZone)}
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
