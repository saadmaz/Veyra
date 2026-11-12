'use client';

import type {
  MaintenanceAssigneeDto,
  MaintenancePriority,
  MaintenanceRequestDetailDto,
  PropertyDetailResponse,
  WorkOrderDetailDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Attachments,
  DueText,
  NoteForm,
  PriorityField,
  ReasonButton,
  RequestBadge,
  Timeline,
  WorkBadge,
} from '@/components/maintenance';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { CATEGORY_LABELS, PRIORITY_LABELS, placeText } from '@/lib/maintenance';
import { errorMessage } from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

const FINAL = ['CLOSED', 'REJECTED', 'CANCELLED'];

/** A request for staff: triage, its work orders, files, messages and the full history. */
export default function StaffRequestPage() {
  const { organisationId, propertyId, requestId } = useParams<{
    organisationId: string;
    propertyId: string;
    requestId: string;
  }>();
  const propertyPath = `/organisations/${organisationId}/properties/${propertyId}`;
  const base = `${propertyPath}/maintenance`;
  const path = `${base}/requests/${requestId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyPath);
  const detail = useApiQuery<MaintenanceRequestDetailDto>(path);
  const canManage =
    property.status === 'success' &&
    property.data.permissions.includes('property.maintenance.manage');
  const assignees = useApiQuery<{ data: MaintenanceAssigneeDto[] }>(
    canManage ? `${base}/assignees` : null,
  );
  const act = useAction();

  useEffect(() => {
    if (detail.status === 'success')
      document.title = `${detail.data.request.title} · VEYRA Console`;
  }, [detail]);

  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={propertyPath}>Property</Link>
      {' / '}
      <Link href={base}>Maintenance</Link>
    </nav>
  );
  if (detail.status === 'loading' || property.status === 'loading') {
    return <LoadingState label="Loading request" />;
  }
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && [403, 404].includes(detail.error.status)) {
      return (
        <>
          {crumbs}
          <EmptyState title="Request not found">
            It does not exist, or you cannot see it.
          </EmptyState>
        </>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }
  const { request: r, workOrders, events, attachments } = detail.data;
  const timeZone = property.status === 'success' ? property.data.timeZone : 'UTC';
  const people = assignees.status === 'success' ? assignees.data.data : [];
  const nameOf = (id: string) => people.find((p) => p.userId === id)?.name ?? 'a team member';
  const live = !FINAL.includes(r.status);
  const run = (fn: () => Promise<unknown>) => void act.run(fn).then((ok) => ok && detail.reload());

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>{r.title}</h1>
        <RequestBadge status={r.status} />
      </div>
      <Card title="Request">
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
            <dt>Priority</dt>
            <dd>{PRIORITY_LABELS[r.priority]}</dd>
          </div>
          <div>
            <dt>Reported</dt>
            <dd>
              {formatInstant(r.createdAt, timeZone)} by {r.submittedBy.name}
            </dd>
          </div>
          <div>
            <dt>Respond by</dt>
            <dd>
              <DueText iso={r.responseDueAt} overdue={r.overdue.response} timeZone={timeZone} />
              {r.responseBreachedAt ? <Badge tone="danger">missed</Badge> : null}
            </dd>
          </div>
          <div>
            <dt>Fix by</dt>
            <dd>
              <DueText iso={r.resolutionDueAt} overdue={r.overdue.resolution} timeZone={timeZone} />
              {r.resolutionBreachedAt ? <Badge tone="danger">missed</Badge> : null}
            </dd>
          </div>
          {r.reopenCount > 0 ? (
            <div>
              <dt>Reopened</dt>
              <dd>{r.reopenCount} times</dd>
            </div>
          ) : null}
        </dl>
        <p className="note">{r.description}</p>
        {r.statusNote ? <p className="list__meta">Latest reason: {r.statusNote}</p> : null}
      </Card>

      {canManage && live ? (
        <Card title="Decide">
          {act.error ? <Alert>{errorMessage(act.error)}</Alert> : null}
          {r.status === 'SUBMITTED' ? (
            <Accept path={path} current={r.priority} onDone={detail.reload} />
          ) : null}
          <div className="form__actions">
            {r.status === 'SUBMITTED' ? (
              <ReasonButton
                label="Decline"
                field="Reason (shown to the resident)"
                variant="danger"
                submit={(reason) => api.post(`${path}/reject`, { reason })}
                onDone={detail.reload}
              />
            ) : null}
            {r.status === 'ACCEPTED' ? (
              <ReasonButton
                label="Mark as done"
                field="Message to the resident (optional)"
                optional
                submit={(note) => api.post(`${path}/resolve`, note ? { note } : {})}
                onDone={detail.reload}
              />
            ) : null}
            {r.status === 'RESOLVED' ? (
              <Button
                variant="secondary"
                busy={act.busy}
                onClick={() => run(() => api.post(`${path}/close`))}
              >
                Close without the resident
              </Button>
            ) : null}
            {r.status === 'SUBMITTED' || r.status === 'ACCEPTED' ? (
              <ReasonButton
                label="Cancel request"
                field="Reason (shown to the resident)"
                variant="danger"
                submit={(reason) => api.post(`${path}/cancel`, { reason })}
                onDone={detail.reload}
              />
            ) : null}
          </div>
          {r.status === 'ACCEPTED' ? (
            <ChangePriority path={path} current={r.priority} onDone={detail.reload} />
          ) : null}
        </Card>
      ) : null}

      <Card title="Work">
        {workOrders.length === 0 ? <p className="muted">No work orders yet.</p> : null}
        {workOrders.length > 0 ? (
          <ul className="list" aria-label="Work orders">
            {workOrders.map((w) => (
              <li key={w.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${base}/work-orders/${w.id}`}>{w.number}</Link>{' '}
                    <WorkBadge status={w.status} />
                  </p>
                  <p className="list__meta">
                    {w.assignedTo ? w.assignedTo.name : 'Nobody yet'}
                    {w.statusNote ? ` · ${w.statusNote}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {canManage && r.status === 'ACCEPTED' ? (
          <NewWork base={base} requestId={r.id} people={people} />
        ) : null}
      </Card>

      <Attachments
        items={attachments}
        pathOf={(a) => `${base}/attachments/${a.id}`}
        canRemove={() => canManage && live}
        {...(canManage && live
          ? { upload: { base: `${path}/attachments`, choose: { kind: false, visibility: true } } }
          : {})}
        timeZone={timeZone}
        onChanged={detail.reload}
      />
      {canManage && live ? (
        <Card title="Add a message">
          <NoteForm path={`${path}/notes`} chooseVisibility onAdded={detail.reload} />
        </Card>
      ) : null}
      <Timeline events={events} timeZone={timeZone} names={nameOf} showVisibility />
    </>
  );
}

function Accept({
  path,
  current,
  onDone,
}: {
  path: string;
  current: MaintenancePriority;
  onDone(): void;
}) {
  const act = useAction();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const note = String(data.get('note') ?? '').trim();
    const ok = await act.run(() =>
      api.post(`${path}/accept`, {
        priority: String(data.get('priority')),
        ...(note ? { note } : {}),
      }),
    );
    if (ok) onDone();
  }
  return (
    <form className="form" noValidate onSubmit={onSubmit} aria-label="Accept">
      {act.error ? <Alert>{errorMessage(act.error)}</Alert> : null}
      <PriorityField defaultValue={current} label="Priority" />
      <div className="field">
        <label htmlFor="accept-note" className="field__label">
          Message to the resident (optional)
        </label>
        <input id="accept-note" name="note" className="field__input" maxLength={2000} />
      </div>
      <Button type="submit" busy={act.busy}>
        Accept
      </Button>
    </form>
  );
}

function ChangePriority({
  path,
  current,
  onDone,
}: {
  path: string;
  current: MaintenancePriority;
  onDone(): void;
}) {
  const act = useAction();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const priority = String(new FormData(event.currentTarget).get('priority'));
    if (priority === current) return;
    const ok = await act.run(() => api.patch(path, { priority }));
    if (ok) onDone();
  }
  return (
    <form className="form form--inline" noValidate onSubmit={onSubmit} aria-label="Change priority">
      {act.error ? <Alert>{errorMessage(act.error)}</Alert> : null}
      <PriorityField defaultValue={current} label="Priority" />
      <Button type="submit" variant="secondary" busy={act.busy}>
        Change priority
      </Button>
    </form>
  );
}

function NewWork({
  base,
  requestId,
  people,
}: {
  base: string;
  requestId: string;
  people: MaintenanceAssigneeDto[];
}) {
  const router = useRouter();
  const act = useAction();
  const [assignee, setAssignee] = useState('');
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let created: WorkOrderDetailDto | undefined;
    const ok = await act.run(async () => {
      created = await api.post<WorkOrderDetailDto>(`${base}/work-orders`, {
        requestId,
        ...(assignee ? { assignedToUserId: assignee } : {}),
      });
    });
    if (ok && created) router.push(`${base}/work-orders/${created.workOrder.id}`);
  }
  return (
    <form className="form form--inline" noValidate onSubmit={onSubmit} aria-label="New work order">
      {act.error ? <Alert>{errorMessage(act.error)}</Alert> : null}
      <SelectField
        label="Give it to"
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
      >
        <option value="">Nobody yet</option>
        {people.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.name}
          </option>
        ))}
      </SelectField>
      <Button type="submit" busy={act.busy}>
        Create work order
      </Button>
    </form>
  );
}
