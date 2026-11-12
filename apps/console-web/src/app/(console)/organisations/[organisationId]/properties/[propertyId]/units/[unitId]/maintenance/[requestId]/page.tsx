'use client';

import type { ResidentMaintenanceRequestDetailDto, UnitDetailResponse } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import {
  Attachments,
  NoteForm,
  ReasonButton,
  RequestBadge,
  Timeline,
} from '@/components/maintenance';
import { Alert, Button, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { CATEGORY_LABELS, PRIORITY_LABELS, placeText } from '@/lib/maintenance';
import { errorMessage } from '@/lib/messages';
import { useSession } from '@/lib/session';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

const FINAL = ['CLOSED', 'REJECTED', 'CANCELLED'];

/**
 * One request as its unit's residents see it: the report, its updates and photos. The requester
 * can withdraw it before work starts; any resident confirms the work or sends it back.
 */
export default function MyRequestPage() {
  const { organisationId, propertyId, unitId, requestId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
    requestId: string;
  }>();
  const unitPath = `/organisations/${organisationId}/properties/${propertyId}/units/${unitId}`;
  const base = `${unitPath}/maintenance-requests/${requestId}`;
  const unit = useApiQuery<UnitDetailResponse>(unitPath);
  const detail = useApiQuery<ResidentMaintenanceRequestDetailDto>(base);
  const { session } = useSession();
  const confirm = useAction();

  useEffect(() => {
    if (detail.status === 'success') {
      document.title = `${detail.data.request.title} · VEYRA Console`;
    }
  }, [detail]);

  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={unitPath}>Unit</Link>
      {' / '}
      <Link href={`${unitPath}/maintenance`}>Maintenance</Link>
    </nav>
  );
  if (detail.status === 'loading' || unit.status === 'loading') {
    return <LoadingState label="Loading request" />;
  }
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && detail.error.status === 404) {
      return (
        <>
          {crumbs}
          <EmptyState title="Request not found">
            It does not exist, or it belongs to another home.
          </EmptyState>
        </>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }
  const { request: r, events, attachments } = detail.data;
  const timeZone = unit.status === 'success' ? unit.data.propertyTimeZone : 'UTC';
  const isResident = unit.status === 'success' && unit.data.myRoles.length > 0;
  const me = session.status === 'signed-in' ? session.user.id : '';
  const live = !FINAL.includes(r.status);

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>{r.title}</h1>
        <RequestBadge status={r.status} />
      </div>
      {r.status === 'RESOLVED' ? (
        <Alert tone="info">
          The property team says this is done. Confirm it, or send it back if the problem is still
          there.
        </Alert>
      ) : null}
      {r.status === 'REJECTED' && r.statusNote ? (
        <Alert tone="info">The property team declined this request: {r.statusNote}</Alert>
      ) : null}
      <Card title="Report">
        <dl className="details">
          <div>
            <dt>Reference</dt>
            <dd>{r.number}</dd>
          </div>
          <div>
            <dt>Where</dt>
            <dd>{placeText(r)}</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{CATEGORY_LABELS[r.category]}</dd>
          </div>
          <div>
            <dt>Urgency</dt>
            <dd>{PRIORITY_LABELS[r.priority]}</dd>
          </div>
          <div>
            <dt>Reported</dt>
            <dd>
              {formatInstant(r.createdAt, timeZone)} by {r.submittedBy.name}
            </dd>
          </div>
        </dl>
        <p className="note">{r.description}</p>
        {confirm.error ? <Alert>{errorMessage(confirm.error)}</Alert> : null}
        <div className="form__actions">
          {r.status === 'RESOLVED' && isResident ? (
            <>
              <Button
                busy={confirm.busy}
                onClick={() =>
                  void confirm
                    .run(() => api.post(`${base}/confirm`))
                    .then((ok) => ok && detail.reload())
                }
              >
                Confirm it is fixed
              </Button>
              <ReasonButton
                label="Not fixed: send it back"
                field="What is still wrong"
                submit={(reason) => api.post(`${base}/reopen`, { reason })}
                onDone={detail.reload}
              />
            </>
          ) : null}
          {(r.status === 'SUBMITTED' || r.status === 'ACCEPTED') && r.submittedBy.userId === me ? (
            <ReasonButton
              label="Withdraw request"
              field="Why"
              variant="danger"
              submit={(reason) => api.post(`${base}/cancel`, { reason })}
              onDone={detail.reload}
            />
          ) : null}
        </div>
      </Card>
      <Attachments
        items={attachments}
        pathOf={(a) => `${base}/attachments/${a.id}`}
        canRemove={(a) => a.uploadedBy.userId === me && live}
        {...(live ? { upload: { base: `${base}/attachments` } } : {})}
        timeZone={timeZone}
        onChanged={detail.reload}
      />
      {live ? (
        <Card title="Message the property team">
          <NoteForm path={`${base}/notes`} chooseVisibility={false} onAdded={detail.reload} />
        </Card>
      ) : null}
      <Timeline events={events} timeZone={timeZone} />
    </>
  );
}
