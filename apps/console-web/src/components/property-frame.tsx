'use client';

import type { PropertyDetailResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { ApiRequestError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useApiQuery } from '@/lib/use-api';
import { EmptyState, ErrorState, LoadingState } from './ui';

export interface PropertyContext {
  property: PropertyDetailResponse;
  /** Console path of the property, which is also the API path of its endpoints. */
  propertyPath: string;
  /** Whether the caller holds a permission on the property (UI only; the API decides). */
  can(permission: string): boolean;
  currentUserId: string;
}

/**
 * Frame of a property page: loads the property and the caller's permissions, handles the
 * loading, not-found, error and permission-denied states, and renders the breadcrumb and
 * heading. Hiding things here is a convenience: the API checks every request.
 */
export function PropertyFrame({
  title,
  permission,
  denied,
  crumb,
  children,
}: {
  title: string;
  /** Needed to see the page; any one of them if several. */
  permission: string | string[];
  /** Shown to people without it. */
  denied: { title: string; text: string };
  /** An extra breadcrumb level below the property. */
  crumb?: { label: string; path: string };
  children: (context: PropertyContext) => ReactNode;
}) {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const propertyPath = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyPath);
  const { session } = useSession();

  useEffect(() => {
    if (property.status === 'success') {
      document.title = `${title} · ${property.data.name} · VEYRA Console`;
    }
  }, [property, title]);

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
  const can = (x: string) => p.permissions.includes(x);
  const allowed = (Array.isArray(permission) ? permission : [permission]).some(can);
  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={propertyPath}>{p.name}</Link>
        {crumb ? (
          <>
            {' / '}
            <Link href={`${propertyPath}${crumb.path}`}>{crumb.label}</Link>
          </>
        ) : null}
      </nav>
      <div className="page__header">
        <h1>{title}</h1>
      </div>
      {allowed ? (
        children({
          property: p,
          propertyPath,
          can,
          currentUserId: session.status === 'signed-in' ? session.user.id : '',
        })
      ) : (
        <EmptyState title={denied.title}>{denied.text}</EmptyState>
      )}
    </>
  );
}
