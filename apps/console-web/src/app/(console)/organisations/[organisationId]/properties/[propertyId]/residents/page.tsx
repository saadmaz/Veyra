'use client';

import type { PropertyDetailResponse, PropertyResidentDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { NewPersonForm } from '@/components/residents';
import { Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { residentRoleLabel } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

/** Everyone who lives in or owns a unit of the property today, with their units and roles. */
export default function PropertyResidentsPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const router = useRouter();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canRead =
    property.status === 'success' && property.data.permissions.includes('property.resident.read');
  // Only asked for when the role may see residents, so others get a clear message, not a 403.
  const residents = useApiQuery<{ data: PropertyResidentDto[] }>(
    canRead ? `${base}/residents` : null,
  );

  useEffect(() => {
    if (property.status === 'success')
      document.title = `Residents · ${property.data.name} · VEYRA Console`;
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading residents" />;
  if (property.status === 'error') {
    if (property.error instanceof ApiRequestError && property.error.status === 404) {
      return (
        <EmptyState title="Property not found">
          It does not exist, or it is not one of the properties assigned to you.
        </EmptyState>
      );
    }
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }

  const p = property.data;
  const canManage = p.permissions.includes('property.resident.manage');
  const header = (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{p.name}</Link>
      </nav>
      <div className="page__header">
        <h1>Residents</h1>
      </div>
    </>
  );

  if (!canRead) {
    return (
      <>
        {header}
        <EmptyState title="You cannot view residents">
          Resident details are available to organisation admins and the property's managers.
        </EmptyState>
      </>
    );
  }

  const rows =
    residents.status === 'success'
      ? [...residents.data.data].sort((a, b) => a.person.fullName.localeCompare(b.person.fullName))
      : [];
  return (
    <>
      {header}
      <Card title="Current residents">
        {residents.status === 'loading' ? <LoadingState label="Loading residents" /> : null}
        {residents.status === 'error' ? (
          <ErrorState error={residents.error} onRetry={residents.reload} />
        ) : null}
        {residents.status === 'success' && rows.length === 0 ? (
          <p className="muted">
            Nobody owns or lives in a unit here yet. Open a unit to record its owners and tenants.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Current residents of {p.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Units</th>
                  <th scope="col">Contact</th>
                  <th scope="col">App access</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ person, units }) => (
                  <tr key={person.id}>
                    <td>
                      <Link href={`${base}/residents/${person.id}`} className="list__link">
                        {person.fullName}
                      </Link>
                    </td>
                    <td>
                      {units.map((u, i) => (
                        <span key={u.unitId}>
                          {i > 0 ? '; ' : null}
                          <Link href={`${base}/units/${u.unitId}`}>{u.unitNumber}</Link>{' '}
                          <span className="muted">
                            ({u.roles.map(residentRoleLabel).join(', ')})
                          </span>
                        </span>
                      ))}
                    </td>
                    <td>{[person.email, person.phone].filter(Boolean).join(' · ') || '—'}</td>
                    <td>{person.linked ? 'Linked' : 'Not linked'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {canManage && p.status !== 'ARCHIVED' ? (
        <Card title="Add a person">
          <p className="muted">
            Creates a profile and opens it. To make them an owner, tenant or household member,
            record it on their unit.
          </p>
          <NewPersonForm
            base={base}
            onCreated={(person) => router.push(`${base}/residents/${person.id}`)}
          />
        </Card>
      ) : null}
    </>
  );
}
