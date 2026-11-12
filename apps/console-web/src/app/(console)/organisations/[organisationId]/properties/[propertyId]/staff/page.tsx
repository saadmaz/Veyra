'use client';

import type {
  ChecklistDto,
  ChecklistTemplateDto,
  DepartmentDto,
  PropertyDetailResponse,
  ShiftDto,
  StaffPersonDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { BookingAction } from '@/components/facilities';
import { ChecklistBadge, ShiftBadge } from '@/components/staff';
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
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant, formatTime, zonedLocalToInstant } from '@/lib/visitors';

/** Departments, shifts and checklists of a property, for supervisors and managers. */
export default function StaffPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canRead =
    property.status === 'success' && property.data.permissions.includes('property.staff.read');
  const canManage =
    property.status === 'success' && property.data.permissions.includes('property.staff.manage');
  const departments = useApiQuery<{ data: DepartmentDto[] }>(
    canRead ? `${base}/staff/departments` : null,
  );
  const people = useApiQuery<{ data: StaffPersonDto[] }>(canManage ? `${base}/staff/people` : null);

  useEffect(() => {
    if (property.status === 'success')
      document.title = `Staff · ${property.data.name} · VEYRA Console`;
  }, [property]);

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
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={base}>{p.name}</Link>
    </nav>
  );
  if (!canRead) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>Staff</h1>
        </div>
        <EmptyState title="You cannot see staff here">
          Supervisors and managers plan shifts and checklists.
        </EmptyState>
      </>
    );
  }
  const depts =
    departments.status === 'success'
      ? departments.data.data.filter((d) => d.status === 'ACTIVE')
      : [];
  const workers = people.status === 'success' ? people.data.data : [];

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Staff</h1>
      </div>
      <Departments base={base} state={departments} workers={workers} canManage={canManage} />
      <Shifts base={base} timeZone={p.timeZone} departments={depts} canManage={canManage} />
      <Checklists base={base} departments={depts} workers={workers} canManage={canManage} />
    </>
  );
}

function Departments({
  base,
  state,
  workers,
  canManage,
}: {
  base: string;
  state: ReturnType<typeof useApiQuery<{ data: DepartmentDto[] }>>;
  workers: StaffPersonDto[];
  canManage: boolean;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const list =
    state.status === 'success' ? state.data.data.filter((d) => d.status === 'ACTIVE') : [];

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.post(`${base}/staff/departments`, { name });
      setName('');
      state.reload();
    } catch (e) {
      setError(e);
    }
  }

  async function addMember(departmentId: string) {
    const userId = adding[departmentId] || workers[0]?.userId;
    if (!userId) return;
    setError(null);
    try {
      await api.post(`${base}/staff/departments/${departmentId}/members`, { userId });
      state.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Card title="Departments">
      {state.status === 'loading' ? <LoadingState label="Loading departments" /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
      {state.status === 'success' && list.length === 0 ? (
        <p className="muted">No departments yet.</p>
      ) : null}
      {list.length > 0 ? (
        <ul className="list" aria-label="Departments">
          {list.map((d) => (
            <li key={d.id} className="list__item">
              <div>
                <p className="list__primary">{d.name}</p>
                <p className="list__meta">
                  {d.members.map((m) => m.name).join(', ') || 'Nobody yet'}
                </p>
              </div>
              {canManage && workers.length > 0 ? (
                <div className="form__actions">
                  <SelectField
                    label={`Add to ${d.name}`}
                    value={adding[d.id] ?? workers[0]?.userId ?? ''}
                    onChange={(e) => setAdding((a) => ({ ...a, [d.id]: e.target.value }))}
                  >
                    {workers.map((w) => (
                      <option key={w.userId} value={w.userId}>
                        {w.name}
                      </option>
                    ))}
                  </SelectField>
                  <Button variant="secondary" onClick={() => addMember(d.id)}>
                    Add member
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {canManage ? (
        <form onSubmit={create} aria-label="Add a department" className="form">
          <div className="form__row">
            <TextField
              label="New department"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="form__actions">
            <Button type="submit">Add department</Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function Shifts({
  base,
  timeZone,
  departments,
  canManage,
}: {
  base: string;
  timeZone: string;
  departments: DepartmentDto[];
  canManage: boolean;
}) {
  const [from] = useState(() => new Date(Date.now() - 12 * 3_600_000).toISOString());
  const [to] = useState(() => new Date(Date.now() + 8 * 86_400_000).toISOString());
  const shifts = useApiQuery<{ data: ShiftDto[] }>(
    `${base}/staff/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  const [form, setForm] = useState({ departmentId: '', userId: '', start: '', end: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dept = departments.find((d) => d.id === form.departmentId) ?? departments[0];
  const userId = form.userId || dept?.members[0]?.userId || '';
  const rows = shifts.status === 'success' ? shifts.data.data : [];

  async function schedule(event: FormEvent) {
    event.preventDefault();
    const startsAt = zonedLocalToInstant(form.start, timeZone);
    const endsAt = zonedLocalToInstant(form.end, timeZone);
    if (!dept || !userId || !startsAt || !endsAt) {
      setError(new Error('Choose a department, a person, a start and an end.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/staff/shifts`, { departmentId: dept.id, userId, startsAt, endsAt });
      setForm((f) => ({ ...f, start: '', end: '' }));
      shifts.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Shifts this week">
      {shifts.status === 'loading' ? <LoadingState label="Loading shifts" /> : null}
      {shifts.status === 'error' ? (
        <ErrorState error={shifts.error} onRetry={shifts.reload} />
      ) : null}
      {shifts.status === 'success' && rows.length === 0 ? (
        <p className="muted">No shifts planned.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Shifts">
          {rows.map((s) => (
            <li key={s.id} className="list__item">
              <div>
                <p className="list__primary">
                  {s.person.name}, {formatInstant(s.startsAt, timeZone)}–
                  {formatTime(s.endsAt, timeZone)} <ShiftBadge status={s.status} />
                </p>
                <p className="list__meta">
                  {s.department.name}
                  {s.handoverNote ? ` · Handover: ${s.handoverNote}` : ''}
                  {s.cancelReason ? ` · Cancelled: ${s.cancelReason}` : ''}
                </p>
              </div>
              {canManage && s.status === 'SCHEDULED' ? (
                <BookingAction
                  label="Cancel shift"
                  path={`${base}/staff/shifts/${s.id}/cancel`}
                  reason="required"
                  variant="danger"
                  onDone={shifts.reload}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage && departments.length > 0 ? (
        <form onSubmit={schedule} aria-label="Plan a shift" className="form">
          <div className="form__row">
            <SelectField
              label="Department"
              value={dept?.id ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value, userId: '' }))}
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Person"
              value={userId}
              onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
            >
              {(dept?.members ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Starts"
              type="datetime-local"
              value={form.start}
              onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
            />
            <TextField
              label="Ends"
              type="datetime-local"
              value={form.end}
              onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
            />
          </div>
          {error ? (
            <Alert>
              {error instanceof ApiRequestError ? errorMessage(error) : (error as Error).message}
            </Alert>
          ) : null}
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              Plan shift
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function Checklists({
  base,
  departments,
  workers,
  canManage,
}: {
  base: string;
  departments: DepartmentDto[];
  workers: StaffPersonDto[];
  canManage: boolean;
}) {
  const templates = useApiQuery<{ data: ChecklistTemplateDto[] }>(
    `${base}/staff/checklist-templates`,
  );
  const review = useApiQuery<{ data: ChecklistDto[] }>(`${base}/staff/checklists?status=SUBMITTED`);
  const [template, setTemplate] = useState({ title: '', items: '' });
  const [assign, setAssign] = useState({ templateId: '', userId: '', dueOn: '' });
  const [error, setError] = useState<unknown>(null);
  const active =
    templates.status === 'success' ? templates.data.data.filter((t) => t.status === 'ACTIVE') : [];
  const templateId = assign.templateId || active[0]?.id || '';
  const assignee = assign.userId || workers[0]?.userId || '';
  const waiting = review.status === 'success' ? review.data.data : [];

  async function createTemplate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.post(`${base}/staff/checklist-templates`, {
        title: template.title,
        items: template.items
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        departmentId: departments[0]?.id ?? null,
      });
      setTemplate({ title: '', items: '' });
      templates.reload();
    } catch (e) {
      setError(e);
    }
  }

  async function give(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.post(`${base}/staff/checklists`, {
        templateId,
        assignedToUserId: assignee,
        dueOn: assign.dueOn,
      });
      setAssign((a) => ({ ...a, dueOn: '' }));
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Card title="Checklists">
      <h2 className="card__subtitle">Waiting for you to check</h2>
      {review.status === 'loading' ? <LoadingState label="Loading checklists" /> : null}
      {review.status === 'error' ? (
        <ErrorState error={review.error} onRetry={review.reload} />
      ) : null}
      {review.status === 'success' && waiting.length === 0 ? (
        <p className="muted">Nothing to check.</p>
      ) : null}
      {waiting.length > 0 ? (
        <ul className="list" aria-label="Checklists to check">
          {waiting.map((c) => (
            <li key={c.id} className="list__item">
              <div>
                <p className="list__primary">
                  {c.title} by {c.assignedTo.name} <ChecklistBadge status={c.status} />
                </p>
                <ul className="list__meta">
                  {c.items.map((i) => (
                    <li key={i.position}>
                      {i.text}:{' '}
                      {i.result === 'PASS'
                        ? 'OK'
                        : i.result === 'FAIL'
                          ? 'problem'
                          : 'not applicable'}
                      {i.note ? ` (${i.note})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
              {canManage ? (
                <div className="form__actions">
                  <BookingAction
                    label="Verify"
                    path={`${base}/staff/checklists/${c.id}/verify`}
                    reason="none"
                    variant="primary"
                    onDone={review.reload}
                  />
                  <BookingAction
                    label="Send back"
                    path={`${base}/staff/checklists/${c.id}/return`}
                    reason="required"
                    onDone={review.reload}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {canManage ? (
        <>
          <form onSubmit={createTemplate} aria-label="New checklist template" className="form">
            <div className="form__row">
              <TextField
                label="Template title"
                value={template.title}
                maxLength={120}
                onChange={(e) => setTemplate((t) => ({ ...t, title: e.target.value }))}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="checks">
                Checks (one per line)
              </label>
              <textarea
                id="checks"
                className="field__input"
                value={template.items}
                onChange={(e) => setTemplate((t) => ({ ...t, items: e.target.value }))}
                required
              />
            </div>
            <div className="form__actions">
              <Button type="submit">Save template</Button>
            </div>
          </form>
          {active.length > 0 && workers.length > 0 ? (
            <form onSubmit={give} aria-label="Give a checklist" className="form">
              <div className="form__row">
                <SelectField
                  label="Checklist"
                  value={templateId}
                  onChange={(e) => setAssign((a) => ({ ...a, templateId: e.target.value }))}
                >
                  {active.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="To"
                  value={assignee}
                  onChange={(e) => setAssign((a) => ({ ...a, userId: e.target.value }))}
                >
                  {workers.map((w) => (
                    <option key={w.userId} value={w.userId}>
                      {w.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label="Due"
                  type="date"
                  value={assign.dueOn}
                  onChange={(e) => setAssign((a) => ({ ...a, dueOn: e.target.value }))}
                  required
                />
              </div>
              <div className="form__actions">
                <Button type="submit">Give checklist</Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
