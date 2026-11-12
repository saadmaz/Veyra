'use client';

import type {
  FacilityAvailabilityDto,
  FacilityBookingDetailDto,
  FacilityBookingDto,
  FacilityBookingStatus,
} from '@veyra/api-contracts';
import { type FormEvent, useState } from 'react';
import { Alert, Badge, Button, SelectField, TextField } from '@/components/ui';
import { api } from '@/lib/api-client';
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONES, SLOT_STATE_LABELS } from '@/lib/facilities';
import { formatMoney, isPositive } from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { formatInstant, formatTime } from '@/lib/visitors';

export function BookingBadge({ status }: { status: FacilityBookingStatus }) {
  return <Badge tone={BOOKING_STATUS_TONES[status]}>{BOOKING_STATUS_LABELS[status]}</Badge>;
}

/** What a booking costs, or nothing when it is free. */
export function bookingCost(b: FacilityBookingDto): string | null {
  const parts: string[] = [];
  if (isPositive(b.fee)) parts.push(`fee ${formatMoney(b.fee)}`);
  if (isPositive(b.deposit)) {
    parts.push(
      `deposit ${formatMoney(b.deposit)}${b.depositReleasedAt ? ' (released)' : ' (refundable)'}`,
    );
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** A booking's place, time and cost on one line. */
export function BookingSummary({
  booking: b,
  timeZone,
  showUnit = false,
}: {
  booking: FacilityBookingDto;
  timeZone: string;
  showUnit?: boolean;
}) {
  const cost = bookingCost(b);
  return (
    <>
      <p className="list__primary">
        {b.facilityName}, {formatInstant(b.startsAt, timeZone)}–{formatTime(b.endsAt, timeZone)}{' '}
        <BookingBadge status={b.status} />
      </p>
      <p className="list__meta">
        {b.number}
        {showUnit ? ` · Unit ${b.unitNumber}` : ''} · booked by {b.bookedBy.name}
        {b.purpose ? ` · ${b.purpose}` : ''}
        {cost ? ` · ${cost}` : ''}
      </p>
      {b.statusNote ? <p className="list__meta">Reason: {b.statusNote}</p> : null}
    </>
  );
}

/**
 * A local day's slots as buttons: pick a free start, how many slots and (optionally) what it is
 * for, then book. The API checks everything again.
 */
export function SlotPicker({
  availability,
  maxSlots,
  path,
  facilityId,
  onBooked,
}: {
  availability: FacilityAvailabilityDto;
  maxSlots: number;
  path: string;
  facilityId: string;
  onBooked: (booking: FacilityBookingDto) => void;
}) {
  const [start, setStart] = useState<string | null>(null);
  const [slots, setSlots] = useState('1');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { timeZone } = availability;

  if (availability.slots.length === 0) {
    return <p className="muted">Closed all day.</p>;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!start) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<FacilityBookingDetailDto>(path, {
        facilityId,
        startsAt: start,
        slots: Number(slots),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      });
      setStart(null);
      setPurpose('');
      onBooked(created.booking);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Book a time">
      <fieldset className="slots">
        <legend>Start time ({timeZone})</legend>
        <ul className="slots__list">
          {availability.slots.map((s) => {
            const free = s.state === 'OPEN';
            const chosen = start === s.startsAt;
            return (
              <li key={s.startsAt}>
                <button
                  type="button"
                  className={`slot${chosen ? ' slot--chosen' : ''}`}
                  disabled={!free}
                  aria-pressed={chosen}
                  onClick={() => setStart(s.startsAt)}
                >
                  <span className="slot__time">{s.time}</span>
                  <span className="slot__state">
                    {free && s.available > 1 ? `${s.available} free` : SLOT_STATE_LABELS[s.state]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div className="form__row">
        <SelectField label="How long" value={slots} onChange={(e) => setSlots(e.target.value)}>
          {Array.from({ length: maxSlots }, (_, i) => i + 1).map((n) => (
            <option key={n} value={String(n)}>
              {n} slot{n === 1 ? '' : 's'}
            </option>
          ))}
        </SelectField>
        <TextField
          label="What it is for (optional)"
          value={purpose}
          maxLength={200}
          onChange={(e) => setPurpose(e.target.value)}
        />
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" busy={busy} disabled={!start}>
          {start ? `Book from ${formatTime(start, timeZone)}` : 'Choose a start time'}
        </Button>
      </div>
    </form>
  );
}

/** A button that asks for a reason (when one is needed) and posts an action on a booking. */
export function BookingAction({
  label,
  path,
  reason,
  variant = 'secondary',
  onDone,
}: {
  label: string;
  path: string;
  reason: 'required' | 'optional' | 'none';
  variant?: 'primary' | 'secondary' | 'danger';
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        path,
        reason === 'none' ? undefined : text.trim() ? { reason: text.trim() } : {},
      );
      setOpen(false);
      setText('');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (reason !== 'none' && open) {
    return (
      <div className="inline-form">
        <TextField
          label={reason === 'required' ? 'Reason' : 'Reason (optional)'}
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
        />
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <div className="form__actions">
          <Button
            variant={variant}
            busy={busy}
            disabled={reason === 'required' && !text.trim()}
            onClick={run}
          >
            {label}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Keep it
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <Button
        variant={variant}
        busy={busy}
        onClick={() => (reason === 'none' ? run() : setOpen(true))}
      >
        {label}
      </Button>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
    </>
  );
}
