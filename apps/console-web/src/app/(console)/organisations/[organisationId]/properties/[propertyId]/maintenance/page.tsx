'use client';

import type {
  CommonAreaDto,
  MaintenanceRequestDto,
  MaintenanceRequestStatus,
  MaintenanceSlaTargetDto,
  Paginated,
  PropertyDetailResponse,
  UnitDto,
  WorkOrderDto,
  WorkOrderStatus,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { DueText, ReportForm, RequestBadge, WorkBadge } from '@/components/maintenance';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TableWrap,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  CATEGORY_LABELS,
  isOverdue,
  PRIORITIES,
  PRIORITY_LABELS,
  placeText,
  REQUEST_STATUS_LABELS,
  WORK_STATUS_LABELS,
} from '@/lib/maintenance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';

type Tab = 'queue' | 'requests' | 'work' | 'sla';

/**
 * Maintenance for staff: the queue (overdue first), every request, work orders, and the
 * property's response and resolution targets. Reading needs property.maintenance.read; acting
 * property.maintenance.manage (the API checks both).
 */
export default function MaintenancePage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const propertyPath = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(propertyPath);
  const [tab, setTab] = useState<Tab>('queue');

  useEffect(() => {
    if (property.status === 'success') {
      document.title = `Maintenance · ${property.data.name} · VEYRA Console`;
    }
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading maintenance" />;
  if (property.status === 'error') {
    if (property.error instanceof ApiRequestError && property.error.status === 404) {
      return (
        <EmptyState title="Property not found">It does not exist, or it is not yours.</EmptyState>
      );
    }
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }
  const p = property.data;
  const can = (permission: string) => p.permissions.includes(permission);
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={propertyPath}>{p.name}</Link>
    </nav>
  );
  if (!can('property.maintenance.read')) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>Maintenance</h1>
        </div>
        <EmptyState title="You cannot view maintenance">
          Maintenance is for the property's managers and maintenance team.
          {can('property.maintenance.work') ? ' Your own work is under My work.' : ''}
        </EmptyState>
      </>
    );
  }
  const base = `${propertyPath}/maintenance`;
  const tabs: { key: Tab; label: string }[] = [
    { key: 'queue', label: 'Queue' },
    { key: 'requests', label: 'All requests' },
    { key: 'work', label: 'Work orders' },
    { key: 'sla', label: 'Targets' },
  ];
  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Maintenance</h1>
      </div>
      <nav aria-label="Maintenance sections">
        <ul className="subnav">
          {tabs.map((t) => (
            <li key={t.key}>
              <button type="button" aria-pressed={t.key === tab} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {tab === 'queue' ? (
        <>
          <Queue base={base} timeZone={p.timeZone} />
          {can('property.maintenance.manage') ? (
            <StaffReport propertyPath={propertyPath} base={base} />
          ) : null}
        </>
      ) : null}
      {tab === 'requests' ? <AllRequests base={base} /> : null}
      {tab === 'work' ? <WorkOrders base={base} /> : null}
      {tab === 'sla' ? (
        <Targets base={base} canManage={can('property.maintenance.manage')} />
      ) : null}
    </>
  );
}

function RequestTable({
  rows,
  base,
  timeZone,
  label,
}: {
  rows: MaintenanceRequestDto[];
  base: string;
  timeZone?: string;
  label: string;
}) {
  return (
    <TableWrap label={label}>
      <table className="table">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            <th scope="col">Request</th>
            <th scope="col">Where</th>
            <th scope="col">Priority</th>
            <th scope="col">Status</th>
            {timeZone ? <th scope="col">Next target</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`${base}/requests/${r.id}`}>{r.title}</Link>
                <br />
                <span className="muted">{r.number}</span>
              </td>
              <td>{placeText(r)}</td>
              <td>{PRIORITY_LABELS[r.priority]}</td>
              <td>
                <RequestBadge status={r.status} />
              </td>
              {timeZone ? (
                <td>
                  <DueText
                    iso={
                      r.status === 'SUBMITTED'
                        ? (r.responseDueAt ?? r.resolutionDueAt)
                        : r.resolutionDueAt
                    }
                    overdue={isOverdue(r)}
                    timeZone={timeZone}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function Queue({ base, timeZone }: { base: string; timeZone: string }) {
  const queue = useApiQuery<{ data: MaintenanceRequestDto[] }>(`${base}/queue`);
  const rows = queue.status === 'success' ? queue.data.data : [];
  const overdueCount = rows.filter(isOverdue).length;
  return (
    <Card title="Queue">
      <p className="muted">
        New and in-hand requests, overdue first, then by priority and due time.
      </p>
      {queue.status === 'loading' ? <LoadingState label="Loading queue" /> : null}
      {queue.status === 'error' ? <ErrorState error={queue.error} onRetry={queue.reload} /> : null}
      {overdueCount > 0 ? (
        <Alert tone="info">
          {overdueCount} {overdueCount === 1 ? 'request is' : 'requests are'} past a target.
        </Alert>
      ) : null}
      {queue.status === 'success' && rows.length === 0 ? (
        <p className="muted">Nothing is waiting.</p>
      ) : null}
      {rows.length > 0 ? (
        <RequestTable rows={rows} base={base} timeZone={timeZone} label="Queue" />
      ) : null}
    </Card>
  );
}

function AllRequests({ base }: { base: string }) {
  const [status, setStatus] = useState<MaintenanceRequestStatus | ''>('');
  const requests = useApiQuery<{ data: MaintenanceRequestDto[] }>(
    `${base}/requests${status ? `?status=${status}` : ''}`,
  );
  const rows = requests.status === 'success' ? requests.data.data : [];
  return (
    <Card title="All requests">
      <div className="form form--inline">
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as MaintenanceRequestStatus | '')}
        >
          <option value="">Any</option>
          {(Object.keys(REQUEST_STATUS_LABELS) as MaintenanceRequestStatus[]).map((s) => (
            <option key={s} value={s}>
              {REQUEST_STATUS_LABELS[s]}
            </option>
          ))}
        </SelectField>
      </div>
      {requests.status === 'loading' ? <LoadingState label="Loading requests" /> : null}
      {requests.status === 'error' ? (
        <ErrorState error={requests.error} onRetry={requests.reload} />
      ) : null}
      {requests.status === 'success' && rows.length === 0 ? (
        <p className="muted">No requests here.</p>
      ) : null}
      {rows.length > 0 ? <RequestTable rows={rows} base={base} label="All requests" /> : null}
    </Card>
  );
}

function WorkOrders({ base }: { base: string }) {
  const [status, setStatus] = useState<WorkOrderStatus | ''>('');
  const work = useApiQuery<{ data: WorkOrderDto[] }>(
    `${base}/work-orders${status ? `?status=${status}` : ''}`,
  );
  const rows = work.status === 'success' ? work.data.data : [];
  return (
    <Card title="Work orders">
      <div className="form form--inline">
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as WorkOrderStatus | '')}
        >
          <option value="">Any</option>
          {(Object.keys(WORK_STATUS_LABELS) as WorkOrderStatus[]).map((s) => (
            <option key={s} value={s}>
              {WORK_STATUS_LABELS[s]}
            </option>
          ))}
        </SelectField>
      </div>
      {work.status === 'loading' ? <LoadingState label="Loading work orders" /> : null}
      {work.status === 'error' ? <ErrorState error={work.error} onRetry={work.reload} /> : null}
      {work.status === 'success' && rows.length === 0 ? (
        <p className="muted">No work orders here.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Work orders">
          {rows.map((w) => (
            <li key={w.id} className="list__item">
              <div>
                <p className="list__primary">
                  <Link href={`${base}/work-orders/${w.id}`}>{w.title}</Link>{' '}
                  <WorkBadge status={w.status} />
                </p>
                <p className="list__meta">
                  {w.number} · {placeText(w)} · {CATEGORY_LABELS[w.category]} ·{' '}
                  {w.assignedTo ? w.assignedTo.name : 'nobody yet'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function StaffReport({ propertyPath, base }: { propertyPath: string; base: string }) {
  const router = useRouter();
  const units = useApiQuery<Paginated<UnitDto>>(`${propertyPath}/units?limit=200`);
  const areas = useApiQuery<Paginated<CommonAreaDto>>(`${propertyPath}/common-areas`);
  if (units.status !== 'success' || areas.status !== 'success') return null;
  return (
    <Card title="Report a problem">
      <p className="muted">For a unit or a common area, for example after an inspection.</p>
      <ReportForm
        path={`${base}/requests`}
        places={{
          units: units.data.data.map((u) => ({ id: u.id, number: u.number })),
          commonAreas: areas.data.data.map((a) => ({ id: a.id, name: a.name })),
        }}
        onCreated={(id) => router.push(`${base}/requests/${id}`)}
      />
    </Card>
  );
}

const hours = (minutes: number) =>
  minutes % 60 === 0 ? String(minutes / 60) : (minutes / 60).toFixed(2);

/** Response and resolution targets per priority, in hours. Empty means no target. */
function Targets({ base, canManage }: { base: string; canManage: boolean }) {
  const targets = useApiQuery<{ data: MaintenanceSlaTargetDto[] }>(`${base}/sla-targets`);
  const save = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  if (targets.status === 'loading') return <LoadingState label="Loading targets" />;
  if (targets.status === 'error')
    return <ErrorState error={targets.error} onRetry={targets.reload} />;
  const current = new Map(targets.data.data.map((t) => [t.priority, t]));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: Record<string, string> = {};
    const list: MaintenanceSlaTargetDto[] = [];
    for (const priority of PRIORITIES) {
      const response = String(data.get(`${priority}-response`) ?? '').trim();
      const resolution = String(data.get(`${priority}-resolution`) ?? '').trim();
      if (!response && !resolution) continue;
      const r = Number(response);
      const s = Number(resolution);
      if (!(r > 0) || !(s > 0)) {
        found[priority] = 'Give both, in hours (for example 4 and 48), or leave both empty.';
      } else if (s < r) {
        found[priority] = 'Fixing cannot be due before the first response.';
      } else {
        list.push({
          priority,
          responseMinutes: Math.round(r * 60),
          resolutionMinutes: Math.round(s * 60),
        });
      }
    }
    setProblems(found);
    setSaved(false);
    if (Object.keys(found).length > 0) return;
    const ok = await save.run(() => api.put(`${base}/sla-targets`, { targets: list }));
    if (ok) {
      setSaved(true);
      targets.reload();
    }
  }

  return (
    <Card title="Targets">
      <p className="muted">
        How quickly the property promises to respond to (accept) and to fix requests of each
        priority. They apply to requests reported from now on. Leave a row empty for no target.
      </p>
      {saved ? <Alert tone="success">Targets saved.</Alert> : null}
      {save.error && Object.keys(fieldErrors(save.error)).length === 0 ? (
        <Alert>{errorMessage(save.error)}</Alert>
      ) : null}
      <form className="form" noValidate onSubmit={onSubmit} aria-label="Targets">
        {PRIORITIES.map((priority) => {
          const t = current.get(priority);
          return (
            <fieldset key={priority} className="form form--inline">
              <legend>{PRIORITY_LABELS[priority]}</legend>
              {problems[priority] ? <Alert>{problems[priority]}</Alert> : null}
              <TextField
                label="Respond within (hours)"
                name={`${priority}-response`}
                inputMode="decimal"
                defaultValue={t ? hours(t.responseMinutes) : ''}
                disabled={!canManage}
              />
              <TextField
                label="Fix within (hours)"
                name={`${priority}-resolution`}
                inputMode="decimal"
                defaultValue={t ? hours(t.resolutionMinutes) : ''}
                disabled={!canManage}
              />
              {!t ? <Badge>no target</Badge> : null}
            </fieldset>
          );
        })}
        {canManage ? (
          <Button type="submit" busy={save.busy}>
            Save targets
          </Button>
        ) : null}
      </form>
    </Card>
  );
}
