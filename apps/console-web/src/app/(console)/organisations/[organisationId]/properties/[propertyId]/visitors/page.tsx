'use client';

import type { PropertyDetailResponse, VisitDto, VisitorInvitationDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { enumLabel, errorMessage } from '@/lib/messages';
import { todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant, formatTime, zonedLocalToInstant } from '@/lib/visitors';

/** The visit log and registered visitors of a property (supervisors and managers). */
export default function VisitorLogPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);

  useEffect(() => {
    if (property.status === 'success')
      document.title = `Visitors · ${property.data.name} · VEYRA Console`;
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading visitors" />;
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
  const header = (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{p.name}</Link>
      </nav>
      <div className="page__header">
        <h1>Visitors</h1>
      </div>
    </>
  );
  if (!p.permissions.includes('property.visitor.read')) {
    return (
      <>
        {header}
        <EmptyState title="You cannot view the visit log">
          The visit log is for security supervisors and the property's managers.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {header}
      <VisitLog base={base} timeZone={p.timeZone} />
      <Invitations
        base={base}
        timeZone={p.timeZone}
        canRevoke={p.permissions.includes('property.visitor.manage')}
      />
    </>
  );
}

function VisitLog({ base, timeZone }: { base: string; timeZone: string }) {
  const [day, setDay] = useState(() => todayIn(timeZone));
  const from = zonedLocalToInstant(`${day}T00:00`, timeZone);
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const to = zonedLocalToInstant(`${next.toISOString().slice(0, 10)}T00:00`, timeZone);
  const visits = useApiQuery<{ data: VisitDto[] }>(
    from && to
      ? `${base}/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      : null,
  );
  const rows = visits.status === 'success' ? visits.data.data : [];
  return (
    <Card title="Visit log">
      <div className="form form--inline">
        <TextField
          label="Day"
          name="day"
          type="date"
          value={day}
          onChange={(event) => event.target.value && setDay(event.target.value)}
          hint={`Property time (${timeZone.replaceAll('_', ' ')})`}
        />
      </div>
      {visits.status === 'loading' ? <LoadingState label="Loading the log" /> : null}
      {visits.status === 'error' ? (
        <ErrorState error={visits.error} onRetry={visits.reload} />
      ) : null}
      {visits.status === 'success' && rows.length === 0 ? (
        <p className="muted">No visits on this day.</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Visits on {day}</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Visitor</th>
                <th scope="col">Unit</th>
                <th scope="col">Decision</th>
                <th scope="col">Left</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td>{formatTime(v.arrivedAt, timeZone)}</td>
                  <td>
                    {v.visitorName} <span className="muted">({enumLabel(v.category)})</span>
                    {v.vehiclePlate ? <span className="muted"> · {v.vehiclePlate}</span> : null}
                  </td>
                  <td>{v.unitNumber ?? 'Property'}</td>
                  <td>
                    {v.decision === 'ADMITTED' ? 'Admitted' : `Refused: ${v.denialReason}`}
                    {v.gate ? <span className="muted"> · {v.gate}</span> : null}
                  </td>
                  <td>{v.departedAt ? formatTime(v.departedAt, timeZone) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function Invitations({
  base,
  timeZone,
  canRevoke,
}: {
  base: string;
  timeZone: string;
  canRevoke: boolean;
}) {
  const invitations = useApiQuery<{ data: VisitorInvitationDto[] }>(`${base}/visitor-invitations`);
  const revoke = useAction();
  const now = Date.now();
  const rows =
    invitations.status === 'success'
      ? invitations.data.data.filter((i) => Date.parse(i.validUntil) >= now)
      : [];
  return (
    <Card title="Expected visitors">
      {revoke.error ? <Alert>{errorMessage(revoke.error)}</Alert> : null}
      {invitations.status === 'loading' ? <LoadingState label="Loading expected visitors" /> : null}
      {invitations.status === 'error' ? (
        <ErrorState error={invitations.error} onRetry={invitations.reload} />
      ) : null}
      {invitations.status === 'success' && rows.length === 0 ? (
        <p className="muted">No visitors are expected.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Expected visitors">
          {rows.map((i) => (
            <li key={i.id} className="list__item">
              <div>
                <p className="list__primary">
                  {i.visitorName} <span className="muted">to unit {i.unitNumber}</span>
                </p>
                <p className="list__meta">
                  {formatInstant(i.validFrom, timeZone)} to {formatInstant(i.validUntil, timeZone)}{' '}
                  · {i.entriesUsed} of {i.maxEntries} used
                </p>
              </div>
              {i.status === 'REVOKED' ? (
                <span className="badge badge--muted">cancelled</span>
              ) : canRevoke ? (
                <Button
                  variant="danger"
                  busy={revoke.busy}
                  aria-label={`Cancel pass of ${i.visitorName}`}
                  onClick={() => {
                    if (!window.confirm(`Cancel the pass of ${i.visitorName}?`)) return;
                    void revoke
                      .run(() => api.post(`${base}/visitor-invitations/${i.id}/revoke`))
                      .then((ok) => ok && invitations.reload());
                  }}
                >
                  Cancel pass
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
