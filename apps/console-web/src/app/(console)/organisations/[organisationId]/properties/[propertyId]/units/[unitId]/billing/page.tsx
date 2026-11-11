'use client';

import type { UnitDetailResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { MyFinance } from '@/components/my-finance';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { useApiQuery } from '@/lib/use-api';

/**
 * A resident's billing for one unit: their own account only (owners: the owners' account;
 * tenants: their tenancy's). Staff use the property's finance pages instead.
 */
export default function UnitBillingPage() {
  const { organisationId, propertyId, unitId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const unitPath = `/organisations/${organisationId}/properties/${propertyId}/units/${unitId}`;
  const unit = useApiQuery<UnitDetailResponse>(unitPath);

  useEffect(() => {
    if (unit.status === 'success') {
      document.title = `Billing · Unit ${unit.data.unitNumber} · VEYRA Console`;
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
  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={`/organisations/${organisationId}`}>{u.propertyName}</Link>
        {' / '}
        <Link href={unitPath}>Unit {u.unitNumber}</Link>
      </nav>
      <div className="page__header">
        <h1>Billing</h1>
      </div>
      {u.permissions.includes('unit.finance.read') ? (
        <MyFinance unitPath={unitPath} canPay={u.permissions.includes('unit.finance.pay')} />
      ) : (
        <EmptyState title="Billing is for owners and tenants">
          The unit's owners and current tenants see their invoices, receipts and statement here.
        </EmptyState>
      )}
    </>
  );
}
