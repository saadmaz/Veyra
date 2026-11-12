'use client';

import type { DocumentDto, UnitDetailResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { DocumentItem } from '@/components/documents';
import { Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { useApiQuery } from '@/lib/use-api';

/** Documents for the people who live in a home (owners also see those for owners). */
export default function UnitDocumentsPage() {
  const { organisationId, propertyId, unitId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const unitPath = `/organisations/${organisationId}/properties/${propertyId}/units/${unitId}`;
  const unit = useApiQuery<UnitDetailResponse>(unitPath);
  const canRead = unit.status === 'success' && unit.data.permissions.includes('unit.document.read');
  const documents = useApiQuery<{ data: DocumentDto[] }>(canRead ? `${unitPath}/documents` : null);

  useEffect(() => {
    if (unit.status === 'success')
      document.title = `Documents · Unit ${unit.data.unitNumber} · VEYRA Console`;
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
  const rows = documents.status === 'success' ? documents.data.data : [];
  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={`/organisations/${organisationId}`}>{u.propertyName}</Link>
        {' / '}
        <Link href={unitPath}>Unit {u.unitNumber}</Link>
      </nav>
      <div className="page__header">
        <h1>Documents</h1>
      </div>
      {!canRead ? (
        <EmptyState title="Documents are for the people who live here">
          Owners, tenants and household members read the property's documents here.
        </EmptyState>
      ) : (
        <Card title="For your home">
          {documents.status === 'loading' ? <LoadingState label="Loading documents" /> : null}
          {documents.status === 'error' ? (
            <ErrorState error={documents.error} onRetry={documents.reload} />
          ) : null}
          {documents.status === 'success' && rows.length === 0 ? (
            <p className="muted">No documents yet.</p>
          ) : null}
          {rows.length > 0 ? (
            <ul className="list" aria-label="Documents">
              {rows.map((d) => (
                <li key={d.id} className="list__item">
                  <DocumentItem
                    document={d}
                    downloadPath={`${unitPath}/documents/${d.id}/download`}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      )}
    </>
  );
}
