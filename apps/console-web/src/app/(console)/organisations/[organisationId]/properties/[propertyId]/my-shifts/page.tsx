'use client';

import type {
  ChecklistDto,
  ChecklistResult,
  MyShiftDetailDto,
  PropertyDetailResponse,
  ShiftDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { ChecklistBadge, ShiftBadge } from '@/components/staff';
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
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant, formatTime } from '@/lib/visitors';

/** A worker's own shifts (start, end with a handover) and checklists (answer and hand in). */
export default function MyShiftsPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canWork =
    property.status === 'success' && property.data.permissions.includes('property.staff.work');
  const shifts = useApiQuery<{ data: ShiftDto[] }>(canWork ? `${base}/my-shifts` : null);
  const checklists = useApiQuery<{ data: ChecklistDto[] }>(
    canWork ? `${base}/my-checklists` : null,
  );

  useEffect(() => {
    if (property.status === 'success')
      document.title = `My shifts · ${property.data.name} · VEYRA Console`;
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
  if (!canWork) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>My shifts</h1>
        </div>
        <EmptyState title="You do not work shifts here">
          Staff of the property see their shifts and checklists here.
        </EmptyState>
      </>
    );
  }
  const live = (shifts.status === 'success' ? shifts.data.data : []).filter(
    (s) => s.status === 'SCHEDULED' || s.status === 'STARTED',
  );
  const open = (checklists.status === 'success' ? checklists.data.data : []).filter(
    (c) => c.status === 'OPEN' || c.status === 'SUBMITTED',
  );

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>My shifts</h1>
      </div>
      <Card title="Shifts">
        {shifts.status === 'loading' ? <LoadingState label="Loading shifts" /> : null}
        {shifts.status === 'error' ? (
          <ErrorState error={shifts.error} onRetry={shifts.reload} />
        ) : null}
        {shifts.status === 'success' && live.length === 0 ? (
          <p className="muted">No shifts coming up.</p>
        ) : null}
        {live.length > 0 ? (
          <ul className="list" aria-label="My shifts">
            {live.map((s) => (
              <li key={s.id} className="list__item">
                <ShiftItem base={base} shift={s} timeZone={p.timeZone} onChange={shifts.reload} />
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <Card title="Checklists">
        {checklists.status === 'loading' ? <LoadingState label="Loading checklists" /> : null}
        {checklists.status === 'error' ? (
          <ErrorState error={checklists.error} onRetry={checklists.reload} />
        ) : null}
        {checklists.status === 'success' && open.length === 0 ? (
          <p className="muted">No checklists to do.</p>
        ) : null}
        {open.map((c) => (
          <ChecklistForm key={c.id} base={base} checklist={c} onChange={checklists.reload} />
        ))}
      </Card>
    </>
  );
}

function ShiftItem({
  base,
  shift,
  timeZone,
  onChange,
}: {
  base: string;
  shift: ShiftDto;
  timeZone: string;
  onChange: () => void;
}) {
  const detail = useApiQuery<MyShiftDetailDto>(`${base}/my-shifts/${shift.id}`);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const handover = detail.status === 'success' ? detail.data.previousHandover : null;

  async function act(action: 'start' | 'end', event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `${base}/my-shifts/${shift.id}/${action}`,
        action === 'end' ? { handoverNote: note } : undefined,
      );
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-form">
      <p className="list__primary">
        {shift.department.name}, {formatInstant(shift.startsAt, timeZone)}–
        {formatTime(shift.endsAt, timeZone)} <ShiftBadge status={shift.status} />
      </p>
      {handover ? (
        <p className="list__meta">
          Handover from {handover.by}: {handover.note}
        </p>
      ) : null}
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {shift.status === 'SCHEDULED' ? (
        <div className="form__actions">
          <Button busy={busy} onClick={() => act('start')}>
            Start shift
          </Button>
        </div>
      ) : (
        <form onSubmit={(e) => act('end', e)} aria-label="End shift" className="form">
          <TextField
            label="Handover for the next shift"
            value={note}
            maxLength={4000}
            onChange={(e) => setNote(e.target.value)}
            required
          />
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              End shift
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

const RESULTS: { value: ChecklistResult; label: string }[] = [
  { value: 'PASS', label: 'OK' },
  { value: 'FAIL', label: 'Problem' },
  { value: 'NOT_APPLICABLE', label: 'Not applicable' },
];

function ChecklistForm({
  base,
  checklist: c,
  onChange,
}: {
  base: string;
  checklist: ChecklistDto;
  onChange: () => void;
}) {
  const [notes, setNotes] = useState<Record<number, string>>(
    Object.fromEntries(c.items.map((i) => [i.position, i.note ?? ''])),
  );
  const [error, setError] = useState<unknown>(null);
  const path = `${base}/my-checklists/${c.id}`;
  const editable = c.status === 'OPEN';

  async function answer(position: number, result: ChecklistResult) {
    setError(null);
    try {
      const note = notes[position]?.trim();
      if (result === 'FAIL' && !note) {
        setError(new Error('Say what was wrong in the note before marking a problem.'));
        return;
      }
      await api.put(`${path}/items/${position}`, { result, ...(note ? { note } : {}) });
      onChange();
    } catch (e) {
      setError(e);
    }
  }

  async function submit() {
    setError(null);
    try {
      await api.post(`${path}/submit`);
      onChange();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section aria-label={c.title} className="checklist">
      <h2 className="card__subtitle">
        {c.title} <ChecklistBadge status={c.status} /> <span className="muted">due {c.dueOn}</span>
      </h2>
      {c.statusNote ? <Alert tone="info">Sent back: {c.statusNote}</Alert> : null}
      <ol className="list">
        {c.items.map((i) => (
          <li key={i.position} className="list__item">
            <div className="inline-form">
              <p className="list__primary">{i.text}</p>
              {editable ? (
                <>
                  <TextField
                    label={`Note for "${i.text}" (needed for a problem)`}
                    value={notes[i.position] ?? ''}
                    maxLength={1000}
                    onChange={(e) => setNotes((n) => ({ ...n, [i.position]: e.target.value }))}
                  />
                  <fieldset className="form__actions answer-group">
                    <legend className="visually-hidden">Answer for {i.text}</legend>
                    {RESULTS.map((r) => (
                      <Button
                        key={r.value}
                        variant={i.result === r.value ? 'primary' : 'secondary'}
                        aria-pressed={i.result === r.value}
                        onClick={() => answer(i.position, r.value)}
                      >
                        {r.label}
                      </Button>
                    ))}
                  </fieldset>
                </>
              ) : (
                <p className="list__meta">
                  {RESULTS.find((r) => r.value === i.result)?.label}
                  {i.note ? `: ${i.note}` : ''}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {error ? (
        <Alert>
          {error instanceof ApiRequestError ? errorMessage(error) : (error as Error).message}
        </Alert>
      ) : null}
      {editable ? (
        <div className="form__actions">
          <Button onClick={submit} disabled={c.answered < c.items.length}>
            Hand in ({c.answered} of {c.items.length} answered)
          </Button>
        </div>
      ) : null}
    </section>
  );
}
