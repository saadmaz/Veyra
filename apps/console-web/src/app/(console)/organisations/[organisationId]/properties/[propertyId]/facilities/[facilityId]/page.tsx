'use client';

import type {
  ChargeTypeDto,
  FacilityAvailabilityDto,
  FacilityDetailDto,
  PropertyDetailResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CheckboxField,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  describeHours,
  describeRules,
  everyDay,
  SLOT_STATE_LABELS,
  todayIn,
} from '@/lib/facilities';
import { formatMoney, moneyInput } from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant, zonedLocalToInstant } from '@/lib/visitors';

/** One facility for staff: its rules, hours, charges, closures and a day's bookings. */
export default function FacilityPage() {
  const { organisationId, propertyId, facilityId } = useParams<{
    organisationId: string;
    propertyId: string;
    facilityId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const path = `${base}/facilities/${facilityId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const detail = useApiQuery<FacilityDetailDto>(path);
  const [date, setDate] = useState<string | null>(null);
  const tz = property.status === 'success' ? property.data.timeZone : null;
  const day = date ?? (tz ? todayIn(tz) : null);
  const availability = useApiQuery<FacilityAvailabilityDto>(
    day ? `${path}/availability?date=${day}` : null,
  );

  useEffect(() => {
    if (detail.status === 'success') {
      document.title = `${detail.data.facility.name} · Facilities · VEYRA Console`;
    }
  }, [detail]);

  if (property.status === 'loading' || detail.status === 'loading') {
    return <LoadingState label="Loading facility" />;
  }
  if (detail.status === 'error' || property.status === 'error') {
    const error = detail.status === 'error' ? detail.error : (property as { error: unknown }).error;
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
      return (
        <EmptyState title="Facility not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={error} onRetry={detail.reload} />;
  }
  const p = property.data;
  const { facility: f, closures } = detail.data;
  const canManage = p.permissions.includes('property.facility.manage') && f.status === 'ACTIVE';

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{p.name}</Link>
        {' / '}
        <Link href={`${base}/facilities`}>Facilities</Link>
      </nav>
      <div className="page__header">
        <h1>
          {f.name} <StatusBadge status={f.status} />
        </h1>
      </div>

      <Card title="Rules">
        <ul aria-label="Rules">
          {[...describeRules(f), ...describeHours(f.openingHours).map((l) => `Open ${l}.`)].map(
            (rule) => (
              <li key={rule}>{rule}</li>
            ),
          )}
          <li>
            {f.fee ? `Fee ${formatMoney(f.fee.perSlot)} per slot.` : 'No fee.'}{' '}
            {f.deposit ? `Deposit ${formatMoney(f.deposit.amount)}.` : 'No deposit.'}
          </li>
        </ul>
      </Card>

      {canManage ? (
        <Settings
          path={path}
          base={base}
          detail={detail.data}
          canSeeCharges={p.permissions.includes('property.finance.read')}
          onSaved={detail.reload}
        />
      ) : null}

      <Card title="Closures">
        {closures.length === 0 ? <p className="muted">No closures coming up.</p> : null}
        {closures.length > 0 ? (
          <ul className="list" aria-label="Closures">
            {closures.map((c) => (
              <li key={c.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {formatInstant(c.startsAt, p.timeZone)} to {formatInstant(c.endsAt, p.timeZone)}
                  </p>
                  <p className="list__meta">{c.reason}</p>
                </div>
                {canManage ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      api.post(`${path}/closures/${c.id}/lift`).then(() => {
                        detail.reload();
                        availability.reload();
                      })
                    }
                  >
                    Lift closure
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canManage ? (
          <CloseForm
            path={path}
            timeZone={p.timeZone}
            onClosed={() => {
              detail.reload();
              availability.reload();
            }}
          />
        ) : null}
      </Card>

      {day ? (
        <Card title="Day view">
          <TextField
            label="Day"
            type="date"
            value={day}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
          />
          {availability.status === 'loading' ? <LoadingState label="Loading the day" /> : null}
          {availability.status === 'error' ? (
            <ErrorState error={availability.error} onRetry={availability.reload} />
          ) : null}
          {availability.status === 'success' && availability.data.slots.length === 0 ? (
            <p className="muted">Closed all day.</p>
          ) : null}
          {availability.status === 'success' && availability.data.slots.length > 0 ? (
            <ul className="list" aria-label="Slots">
              {availability.data.slots.map((s) => (
                <li key={s.startsAt} className="list__item">
                  <p className="list__primary">
                    {s.time}: {SLOT_STATE_LABELS[s.state]}
                    {s.state === 'OPEN' ? ` (${s.available} of ${f.capacity} free)` : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {canManage ? (
        <Card title="Stop taking bookings">
          <p className="muted">
            Archiving is final. Cancel upcoming bookings first; past ones stay in the history.
          </p>
          <Archive path={path} onDone={detail.reload} />
        </Card>
      ) : null}
    </>
  );
}

function Settings({
  path,
  base,
  detail,
  canSeeCharges,
  onSaved,
}: {
  path: string;
  base: string;
  detail: FacilityDetailDto;
  canSeeCharges: boolean;
  onSaved: () => void;
}) {
  const f = detail.facility;
  const first = f.openingHours[0];
  const types = useApiQuery<{ data: ChargeTypeDto[] }>(
    canSeeCharges ? `${base}/finance/charge-types` : null,
  );
  const [form, setForm] = useState({
    description: f.description ?? '',
    capacity: String(f.capacity),
    maxSlotsPerBooking: String(f.maxSlotsPerBooking),
    maxAdvanceDays: String(f.maxAdvanceDays),
    minNoticeMinutes: String(f.minNoticeMinutes),
    cancellationMinutes: String(f.cancellationMinutes),
    maxUpcomingPerUnit: f.maxUpcomingPerUnit === null ? '' : String(f.maxUpcomingPerUnit),
    approvalRequired: f.approvalRequired,
    opensAt: first?.opensAt ?? '08:00',
    closesAt: first?.closesAt === '24:00' ? '00:00' : (first?.closesAt ?? '20:00'),
    feeChargeTypeId: f.fee?.chargeTypeId ?? '',
    feePerSlot: f.fee ? moneyInput(f.fee.perSlot) : '',
    depositChargeTypeId: f.deposit?.chargeTypeId ?? '',
    deposit: f.deposit ? moneyInput(f.deposit.amount) : '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((v) => ({ ...v, [key]: e.target.value }));
  const sameEveryDay =
    f.openingHours.length === 0 ||
    (f.openingHours.length === 7 &&
      f.openingHours.every((r) => r.opensAt === first?.opensAt && r.closesAt === first?.closesAt));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch(path, {
        description: form.description.trim() || null,
        capacity: Number(form.capacity),
        maxSlotsPerBooking: Number(form.maxSlotsPerBooking),
        maxAdvanceDays: Number(form.maxAdvanceDays),
        minNoticeMinutes: Number(form.minNoticeMinutes),
        cancellationMinutes: Number(form.cancellationMinutes),
        maxUpcomingPerUnit: form.maxUpcomingPerUnit ? Number(form.maxUpcomingPerUnit) : null,
        approvalRequired: form.approvalRequired,
        ...(canSeeCharges
          ? {
              feeChargeTypeId: form.feeChargeTypeId || null,
              feePerSlot: form.feeChargeTypeId ? form.feePerSlot : null,
              depositChargeTypeId: form.depositChargeTypeId || null,
              deposit: form.depositChargeTypeId ? form.deposit : null,
            }
          : {}),
      });
      if (sameEveryDay) {
        await api.put(`${path}/opening-hours`, {
          openingHours: everyDay(form.opensAt, form.closesAt === '00:00' ? '24:00' : form.closesAt),
        });
      }
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const chargeTypes = types.status === 'success' ? types.data.data : [];
  return (
    <Card title="Settings">
      <form onSubmit={submit} aria-label="Facility settings" className="form">
        <TextField
          label="Rules shown to residents (optional)"
          value={form.description}
          maxLength={2000}
          onChange={set('description')}
        />
        <div className="form__row">
          <TextField
            label="Bookings at the same time"
            type="number"
            min={1}
            value={form.capacity}
            onChange={set('capacity')}
          />
          <TextField
            label="Most slots in one booking"
            type="number"
            min={1}
            value={form.maxSlotsPerBooking}
            onChange={set('maxSlotsPerBooking')}
          />
          <TextField
            label="Most upcoming bookings per home (optional)"
            type="number"
            min={1}
            value={form.maxUpcomingPerUnit}
            onChange={set('maxUpcomingPerUnit')}
          />
        </div>
        <div className="form__row">
          <TextField
            label="Days ahead residents can book"
            type="number"
            min={1}
            value={form.maxAdvanceDays}
            onChange={set('maxAdvanceDays')}
          />
          <TextField
            label="Book at least (minutes before)"
            type="number"
            min={0}
            value={form.minNoticeMinutes}
            onChange={set('minNoticeMinutes')}
          />
          <TextField
            label="Residents cancel up to (minutes before)"
            type="number"
            min={0}
            value={form.cancellationMinutes}
            onChange={set('cancellationMinutes')}
          />
        </div>
        {sameEveryDay ? (
          <div className="form__row">
            <TextField
              label="Opens (every day)"
              type="time"
              value={form.opensAt}
              onChange={set('opensAt')}
            />
            <TextField
              label="Closes"
              type="time"
              value={form.closesAt}
              onChange={set('closesAt')}
              hint="00:00 means midnight at the end of the day"
            />
          </div>
        ) : (
          <p className="muted">Opening hours differ by day and are kept as they are.</p>
        )}
        <CheckboxField
          label="Bookings need approval"
          checked={form.approvalRequired}
          onChange={(e) => setForm((v) => ({ ...v, approvalRequired: e.target.checked }))}
        />
        {canSeeCharges ? (
          <div className="form__row">
            <SelectField
              label="Fee charged as"
              value={form.feeChargeTypeId}
              onChange={set('feeChargeTypeId')}
            >
              <option value="">No fee</option>
              {chargeTypes
                .filter((t) => t.status === 'ACTIVE')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </SelectField>
            <TextField
              label="Fee per slot"
              inputMode="decimal"
              value={form.feePerSlot}
              onChange={set('feePerSlot')}
              disabled={!form.feeChargeTypeId}
            />
            <SelectField
              label="Deposit charged as"
              value={form.depositChargeTypeId}
              onChange={set('depositChargeTypeId')}
            >
              <option value="">No deposit</option>
              {chargeTypes
                .filter((t) => t.status === 'ACTIVE')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </SelectField>
            <TextField
              label="Deposit"
              inputMode="decimal"
              value={form.deposit}
              onChange={set('deposit')}
              disabled={!form.depositChargeTypeId}
            />
          </div>
        ) : null}
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {saved ? (
          <Alert tone="success">Saved. Bookings already made keep their terms.</Alert>
        ) : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CloseForm({
  path,
  timeZone,
  onClosed,
}: {
  path: string;
  timeZone: string;
  onClosed: () => void;
}) {
  const [form, setForm] = useState({ from: '', to: '', reason: '' });
  const [cancelBookings, setCancelBookings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((v) => ({ ...v, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const startsAt = zonedLocalToInstant(form.from, timeZone);
    const endsAt = zonedLocalToInstant(form.to, timeZone);
    if (!startsAt || !endsAt || !form.reason.trim()) {
      setError(new Error('Give a start, an end and a reason.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}/closures`, {
        startsAt,
        endsAt,
        reason: form.reason.trim(),
        cancelBookings,
      });
      setForm({ from: '', to: '', reason: '' });
      setCancelBookings(false);
      onClosed();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Close the facility" className="form">
      <div className="form__row">
        <TextField
          label="Closed from"
          type="datetime-local"
          value={form.from}
          onChange={set('from')}
        />
        <TextField label="Until" type="datetime-local" value={form.to} onChange={set('to')} />
        <TextField label="Reason" value={form.reason} maxLength={500} onChange={set('reason')} />
      </div>
      <CheckboxField
        label="Cancel the bookings in this period (residents see the reason)"
        checked={cancelBookings}
        onChange={(e) => setCancelBookings(e.target.checked)}
      />
      {error ? (
        <Alert>
          {error instanceof ApiRequestError ? errorMessage(error) : (error as Error).message}
        </Alert>
      ) : null}
      <div className="form__actions">
        <Button type="submit" busy={busy}>
          Close for this period
        </Button>
      </div>
    </form>
  );
}

function Archive({ path, onDone }: { path: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <Button
        variant="danger"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.post(`${path}/archive`);
            onDone();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Archive facility
      </Button>
    </>
  );
}
