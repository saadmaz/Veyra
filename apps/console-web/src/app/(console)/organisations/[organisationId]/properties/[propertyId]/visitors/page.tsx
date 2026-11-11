'use client';

import type {
  Paginated,
  PropertyDetailResponse,
  SyncLateEntriesResponse,
  UnitDto,
  VisitDto,
  VisitorInvitationDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { enumLabel, errorMessage } from '@/lib/messages';
import { todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import {
  formatInstant,
  formatTime,
  instantToZonedLocal,
  REJECTION_MESSAGES,
  VISITOR_CATEGORIES,
  zonedLocalToInstant,
} from '@/lib/visitors';

/** Why a paper or offline entry needs review, in words. */
const REVIEW_REASONS: Record<string, string> = {
  ...REJECTION_MESSAGES,
  WALK_IN_WITHOUT_APPROVAL: 'Let into a unit without a resident\u2019s approval.',
};

const SOURCE_LABELS: Record<VisitDto['source'], string | null> = {
  ONLINE: null,
  OFFLINE_SYNC: 'offline',
  PAPER: 'paper log',
};

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
      <NeedsReview
        base={base}
        timeZone={p.timeZone}
        canReview={p.permissions.includes('property.visitor.manage')}
      />
      <VisitLog base={base} timeZone={p.timeZone} />
      <Invitations
        base={base}
        timeZone={p.timeZone}
        canRevoke={p.permissions.includes('property.visitor.manage')}
      />
      {p.permissions.includes('property.visitor.manage') ? (
        <PaperLog base={base} timeZone={p.timeZone} />
      ) : null}
    </>
  );
}

/**
 * Paper and offline entries the pass would not have allowed at the time they happened. Nothing
 * is deleted: a supervisor looks into each and marks it reviewed, with a note.
 */
function NeedsReview({
  base,
  timeZone,
  canReview,
}: {
  base: string;
  timeZone: string;
  canReview: boolean;
}) {
  const flagged = useApiQuery<{ data: VisitDto[] }>(`${base}/visits/needs-review`);
  const review = useAction();
  const [reviewing, setReviewing] = useState<string | null>(null);
  const rows = flagged.status === 'success' ? flagged.data.data : [];
  if (flagged.status === 'success' && rows.length === 0) return null;
  return (
    <Card title="Needs review">
      <p className="muted">
        Entries recorded offline or from the paper log that the pass would not have allowed at the
        time. Look into each one, then mark it reviewed.
      </p>
      {review.error ? <Alert>{errorMessage(review.error)}</Alert> : null}
      {flagged.status === 'loading' ? <LoadingState label="Loading entries to review" /> : null}
      {flagged.status === 'error' ? (
        <ErrorState error={flagged.error} onRetry={flagged.reload} />
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Entries to review">
          {rows.map((v) => (
            <li key={v.id} className="list__item">
              <div>
                <p className="list__primary">
                  {v.visitorName}{' '}
                  <span className="muted">
                    {v.unitNumber ? `unit ${v.unitNumber}` : 'property'} ·{' '}
                    {formatInstant(v.arrivedAt, timeZone)} · {SOURCE_LABELS[v.source]}
                  </span>
                </p>
                <p className="list__meta">
                  {REVIEW_REASONS[v.reviewReason ?? ''] ?? v.reviewReason}
                </p>
              </div>
              {canReview && reviewing !== v.id ? (
                <Button
                  variant="secondary"
                  aria-label={`Review entry for ${v.visitorName}`}
                  onClick={() => setReviewing(v.id)}
                >
                  Review
                </Button>
              ) : null}
              {canReview && reviewing === v.id ? (
                <form
                  className="form form--inline"
                  noValidate
                  aria-label={`Review entry for ${v.visitorName}`}
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    const note = String(new FormData(event.currentTarget).get('note') ?? '').trim();
                    void review
                      .run(() => api.post(`${base}/visits/${v.id}/review`, note ? { note } : {}))
                      .then((ok) => {
                        if (!ok) return;
                        setReviewing(null);
                        flagged.reload();
                      });
                  }}
                >
                  <TextField label="What you found (optional)" name="note" maxLength={500} />
                  <Button type="submit" busy={review.busy}>
                    Mark reviewed
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/**
 * Typing in the gate's paper log after an outage. Each entry keeps the time written down and
 * is checked like an offline entry; the ones the pass would not have allowed go to review.
 */
function PaperLog({ base, timeZone }: { base: string; timeZone: string }) {
  const units = useApiQuery<Paginated<UnitDto>>(`${base}/units?limit=200`);
  const send = useAction();
  const [kind, setKind] = useState<'ADMIT' | 'WALK_IN' | 'DENY'>('ADMIT');
  const [outcome, setOutcome] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const occurredAt = zonedLocalToInstant(text('occurredAt'), timeZone);
    if (!occurredAt) return setProblem('Enter when it happened.');
    setProblem(null);
    setOutcome(null);
    const entry = {
      clientRef: crypto.randomUUID(),
      kind,
      occurredAt,
      ...(text('gate') ? { gate: text('gate') } : {}),
      ...(text('code') ? { code: text('code') } : {}),
      ...(text('reason') ? { reason: text('reason') } : {}),
      ...(text('visitorName') ? { visitorName: text('visitorName') } : {}),
      ...(text('visitorName') ? { category: text('category') } : {}),
      ...(text('unitId') ? { unitId: text('unitId') } : {}),
    };
    let response: SyncLateEntriesResponse | undefined;
    const ok = await send.run(async () => {
      response = await api.post<SyncLateEntriesResponse>(`${base}/gate/late-entries`, {
        source: 'PAPER',
        entries: [entry],
      });
    });
    const result = response?.results[0];
    if (!ok || !result) return;
    if (result.status === 'REJECTED') {
      setOutcome({
        tone: 'danger',
        text:
          result.error === 'NOT_FOUND'
            ? 'No pass or unit matches what was written down. Check the code.'
            : result.error === 'TOO_OLD'
              ? 'This is more than 7 days ago: write an incident report instead.'
              : `Not recorded (${result.error}).`,
      });
      return;
    }
    setOutcome({
      tone: 'success',
      text: result.reviewReason
        ? 'Recorded. It needs a review: see "Needs review".'
        : result.status === 'ALREADY_RECORDED'
          ? 'Already recorded.'
          : 'Recorded.',
    });
    formElement.reset();
  }

  return (
    <Card title="Enter from the paper log">
      <p className="muted">
        For entries written down while VEYRA could not be reached. Give the time each one happened.
      </p>
      <form
        className="form form--inline"
        onSubmit={onSubmit}
        noValidate
        aria-label="Paper log entry"
      >
        {problem ? <Alert>{problem}</Alert> : null}
        {send.error ? <Alert>{errorMessage(send.error)}</Alert> : null}
        {outcome ? <Alert tone={outcome.tone}>{outcome.text}</Alert> : null}
        <SelectField
          label="What happened"
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="ADMIT">Admitted on a pass</option>
          <option value="WALK_IN">Admitted without a pass</option>
          <option value="DENY">Refused</option>
        </SelectField>
        <TextField
          label="When"
          name="occurredAt"
          type="datetime-local"
          required
          defaultValue={instantToZonedLocal(new Date(), timeZone)}
          hint={`Property time (${timeZone.replaceAll('_', ' ')})`}
        />
        {kind !== 'WALK_IN' ? (
          <TextField
            label={kind === 'ADMIT' ? 'Reference code' : 'Reference code (if any)'}
            name="code"
            maxLength={20}
            autoComplete="off"
          />
        ) : null}
        {kind !== 'ADMIT' ? (
          <>
            <TextField
              label={kind === 'DENY' ? "Visitor's name (if no code)" : "Visitor's name"}
              name="visitorName"
              maxLength={200}
              autoComplete="off"
            />
            <SelectField label="Visitor type" name="category" defaultValue="GUEST">
              {VISITOR_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {enumLabel(c)}
                </option>
              ))}
            </SelectField>
          </>
        ) : null}
        {kind === 'WALK_IN' ? (
          <SelectField label="Going to" name="unitId" defaultValue="">
            <option value="">The property itself</option>
            {units.status === 'success'
              ? units.data.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    Unit {u.number}
                  </option>
                ))
              : null}
          </SelectField>
        ) : null}
        {kind === 'DENY' ? (
          <TextField label="Reason for refusing" name="reason" maxLength={500} />
        ) : null}
        <TextField label="Gate (optional)" name="gate" maxLength={60} />
        <Button type="submit" busy={send.busy}>
          Record entry
        </Button>
      </form>
    </Card>
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
                    {SOURCE_LABELS[v.source] ? (
                      <span className="muted"> · {SOURCE_LABELS[v.source]}</span>
                    ) : null}
                    {v.reviewReason && !v.reviewedAt ? (
                      <span className="badge badge--warning"> needs review</span>
                    ) : null}
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
