'use client';

import type { PropertyDetailResponse, WorkOrderDetailDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { ReasonButton } from '@/components/maintenance';
import { Alert, Button, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { WorkOrderView } from '@/components/work-order';
import { ApiRequestError, api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useSession } from '@/lib/session';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/** One piece of the technician's own work: start, pause, finish, costs, before/after photos. */
export default function MyWorkOrderPage() {
  const { organisationId, propertyId, workOrderId } = useParams<{
    organisationId: string;
    propertyId: string;
    workOrderId: string;
  }>();
  const propertyPath = `/organisations/${organisationId}/properties/${propertyId}`;
  const path = `${propertyPath}/my-work-orders/${workOrderId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyPath);
  const detail = useApiQuery<WorkOrderDetailDto>(path);
  const { session } = useSession();
  const start = useAction();

  useEffect(() => {
    if (detail.status === 'success')
      document.title = `${detail.data.workOrder.number} · VEYRA Console`;
  }, [detail]);

  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={propertyPath}>Property</Link>
      {' / '}
      <Link href={`${propertyPath}/my-work`}>My work</Link>
    </nav>
  );
  if (detail.status === 'loading' || property.status === 'loading') {
    return <LoadingState label="Loading work" />;
  }
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && [403, 404].includes(detail.error.status)) {
      return (
        <>
          {crumbs}
          <EmptyState title="Work not found">
            It does not exist, or it is not assigned to you.
          </EmptyState>
        </>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }
  if (property.status === 'error')
    return <ErrorState error={property.error} onRetry={property.reload} />;
  const w = detail.data.workOrder;
  const live = w.status !== 'COMPLETED' && w.status !== 'CANCELLED';
  return (
    <>
      {crumbs}
      <WorkOrderView
        detail={detail.data}
        timeZone={property.data.timeZone}
        currency={property.data.currency}
        paths={{ self: path, attachment: (id) => `${path}/attachments/${id}` }}
        canWrite={live}
        canVoidCosts={false}
        myUserId={session.status === 'signed-in' ? session.user.id : ''}
        onChanged={detail.reload}
        actions={
          live ? (
            <>
              {start.error ? <Alert>{errorMessage(start.error)}</Alert> : null}
              <div className="form__actions">
                {w.status === 'ASSIGNED' || w.status === 'ON_HOLD' ? (
                  <Button
                    busy={start.busy}
                    onClick={() =>
                      void start
                        .run(() => api.post(`${path}/start`))
                        .then((ok) => ok && detail.reload())
                    }
                  >
                    {w.status === 'ON_HOLD' ? 'Resume' : 'Start work'}
                  </Button>
                ) : null}
                {w.status === 'IN_PROGRESS' ? (
                  <>
                    <ReasonButton
                      label="Finish"
                      field="What was done"
                      variant="primary"
                      submit={(note) => api.post(`${path}/complete`, { note })}
                      onDone={detail.reload}
                    />
                    <ReasonButton
                      label="Pause"
                      field="Why (for example: waiting for a part)"
                      submit={(reason) => api.post(`${path}/hold`, { reason })}
                      onDone={detail.reload}
                    />
                  </>
                ) : null}
              </div>
            </>
          ) : null
        }
      />
    </>
  );
}
