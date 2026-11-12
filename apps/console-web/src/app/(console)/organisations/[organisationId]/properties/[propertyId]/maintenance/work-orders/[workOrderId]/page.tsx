'use client';

import type {
  MaintenanceAssigneeDto,
  PropertyDetailResponse,
  WorkOrderDetailDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { ReasonButton } from '@/components/maintenance';
import { Alert, Button, EmptyState, ErrorState, LoadingState, SelectField } from '@/components/ui';
import { WorkOrderView } from '@/components/work-order';
import { ApiRequestError, api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useSession } from '@/lib/session';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

/** A work order for staff: assign it, cancel it, record and correct its costs. */
export default function StaffWorkOrderPage() {
  const { organisationId, propertyId, workOrderId } = useParams<{
    organisationId: string;
    propertyId: string;
    workOrderId: string;
  }>();
  const propertyPath = `/organisations/${organisationId}/properties/${propertyId}`;
  const base = `${propertyPath}/maintenance`;
  const path = `${base}/work-orders/${workOrderId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyPath);
  const detail = useApiQuery<WorkOrderDetailDto>(path);
  const canManage =
    property.status === 'success' &&
    property.data.permissions.includes('property.maintenance.manage');
  const assignees = useApiQuery<{ data: MaintenanceAssigneeDto[] }>(
    canManage ? `${base}/assignees` : null,
  );
  const { session } = useSession();

  useEffect(() => {
    if (detail.status === 'success')
      document.title = `${detail.data.workOrder.number} · VEYRA Console`;
  }, [detail]);

  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={propertyPath}>Property</Link>
      {' / '}
      <Link href={base}>Maintenance</Link>
    </nav>
  );
  if (detail.status === 'loading' || property.status === 'loading') {
    return <LoadingState label="Loading work order" />;
  }
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && [403, 404].includes(detail.error.status)) {
      return (
        <>
          {crumbs}
          <EmptyState title="Work order not found">
            It does not exist, or you cannot see it.
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
        paths={{ self: path, attachment: (id) => `${base}/attachments/${id}` }}
        {...(w.requestId ? { requestLink: `${base}/requests/${w.requestId}` } : {})}
        canWrite={canManage}
        canVoidCosts={canManage}
        myUserId={session.status === 'signed-in' ? session.user.id : ''}
        onChanged={detail.reload}
        actions={
          canManage && live ? (
            <Assign
              path={path}
              current={w.assignedTo?.userId ?? ''}
              canUnassign={w.status === 'ASSIGNED'}
              people={assignees.status === 'success' ? assignees.data.data : []}
              onDone={detail.reload}
            />
          ) : null
        }
      />
    </>
  );
}

function Assign({
  path,
  current,
  canUnassign,
  people,
  onDone,
}: {
  path: string;
  current: string;
  canUnassign: boolean;
  people: MaintenanceAssigneeDto[];
  onDone(): void;
}) {
  const act = useAction();
  const [userId, setUserId] = useState(current);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId || userId === current) return;
    const ok = await act.run(() => api.post(`${path}/assign`, { userId }));
    if (ok) onDone();
  }
  return (
    <>
      {act.error ? <Alert>{errorMessage(act.error)}</Alert> : null}
      <form className="form form--inline" noValidate onSubmit={onSubmit} aria-label="Assign">
        <SelectField label="Give it to" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose…</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </SelectField>
        <Button type="submit" variant="secondary" busy={act.busy}>
          {current ? 'Reassign' : 'Assign'}
        </Button>
      </form>
      <div className="form__actions">
        {canUnassign ? (
          <Button
            variant="secondary"
            busy={act.busy}
            onClick={() =>
              void act.run(() => api.post(`${path}/unassign`)).then((ok) => ok && onDone())
            }
          >
            Unassign
          </Button>
        ) : null}
        <ReasonButton
          label="Cancel work"
          field="Reason"
          variant="danger"
          submit={(reason) => api.post(`${path}/cancel`, { reason })}
          onDone={onDone}
        />
      </div>
    </>
  );
}
