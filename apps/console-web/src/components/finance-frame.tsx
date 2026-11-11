'use client';

import type { PropertyDetailResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { ApiRequestError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useApiQuery } from '@/lib/use-api';
import { EmptyState, ErrorState, LoadingState } from './ui';

export type FinanceSection =
  | 'overview'
  | 'invoices'
  | 'payments'
  | 'approvals'
  | 'billing'
  | 'reports';

const SECTIONS: { key: FinanceSection; label: string; path: string }[] = [
  { key: 'overview', label: 'Overview', path: '' },
  { key: 'invoices', label: 'Invoices', path: '/invoices' },
  { key: 'payments', label: 'Payments', path: '/payments' },
  { key: 'approvals', label: 'Approvals', path: '/approvals' },
  { key: 'billing', label: 'Billing setup', path: '/billing' },
  { key: 'reports', label: 'Reports', path: '/reports' },
];

export interface FinanceContext {
  property: PropertyDetailResponse;
  /** Console path of the property, e.g. /organisations/o/properties/p. */
  propertyPath: string;
  /** Console path of the finance pages, which is also the API path of the finance endpoints. */
  financePath: string;
  /** Whether the caller holds a permission on the property (UI only; the API decides). */
  can(permission: string): boolean;
  currentUserId: string;
}

/**
 * Frame of every finance page: loads the property and the caller's permissions, handles the
 * loading, not-found, error and permission-denied states, and renders the breadcrumb, heading
 * and section navigation. Hiding things here is a convenience: the API checks every request.
 */
export function FinanceFrame({
  section,
  title,
  crumb,
  actions,
  children,
}: {
  section: FinanceSection;
  title: string;
  /** An extra breadcrumb level below Finance (e.g. Invoices on an invoice page). */
  crumb?: { label: string; path: string };
  actions?: ReactNode;
  children: (context: FinanceContext) => ReactNode;
}) {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const propertyPath = `/organisations/${organisationId}/properties/${propertyId}`;
  const financePath = `${propertyPath}/finance`;
  const property = useApiQuery<PropertyDetailResponse>(propertyPath);
  const { session } = useSession();

  useEffect(() => {
    if (property.status === 'success')
      document.title = `${title} · ${property.data.name} · VEYRA Console`;
  }, [property, title]);

  if (property.status === 'loading') return <LoadingState label="Loading finance" />;
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
  const can = (permission: string) => p.permissions.includes(permission);
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={propertyPath}>{p.name}</Link>
      {section !== 'overview' || crumb ? (
        <>
          {' / '}
          <Link href={financePath}>Finance</Link>
        </>
      ) : null}
      {crumb ? (
        <>
          {' / '}
          <Link href={`${financePath}${crumb.path}`}>{crumb.label}</Link>
        </>
      ) : null}
    </nav>
  );
  if (!can('property.finance.read')) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>{title}</h1>
        </div>
        <EmptyState title="You cannot view finance">
          Finance is for finance officers, organisation admins and the property's managers.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>{title}</h1>
        {actions}
      </div>
      <nav aria-label="Finance sections">
        <ul className="subnav">
          {SECTIONS.map((s) => (
            <li key={s.key}>
              <Link
                href={`${financePath}${s.path}`}
                aria-current={s.key === section && !crumb ? 'page' : undefined}
              >
                {s.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children({
        property: p,
        propertyPath,
        financePath,
        can,
        currentUserId: session.status === 'signed-in' ? session.user.id : '',
      })}
    </>
  );
}
