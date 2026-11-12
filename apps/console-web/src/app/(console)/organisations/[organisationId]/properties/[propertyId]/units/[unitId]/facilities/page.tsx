'use client';

import type {
  FacilityAvailabilityDto,
  FacilityBookingDto,
  FacilityDto,
  UnitDetailResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BookingAction, BookingSummary, SlotPicker } from '@/components/facilities';
import {
  Alert,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { describeHours, describeRules, todayIn } from '@/lib/facilities';
import { formatMoney } from '@/lib/finance';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

/** A unit's facility bookings for its owners and tenants: see free times, book and cancel. */
export default function UnitFacilitiesPage() {
  const { organisationId, propertyId, unitId } = useParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const unitPath = `/organisations/${organisationId}/properties/${propertyId}/units/${unitId}`;
  const unit = useApiQuery<UnitDetailResponse>(unitPath);
  const canBook = unit.status === 'success' && unit.data.permissions.includes('unit.facility.book');
  const facilities = useApiQuery<{ data: FacilityDto[] }>(
    canBook ? `${unitPath}/facilities` : null,
  );
  const bookings = useApiQuery<{ data: FacilityBookingDto[] }>(
    canBook ? `${unitPath}/facility-bookings` : null,
  );
  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [booked, setBooked] = useState<FacilityBookingDto | null>(null);

  const list = facilities.status === 'success' ? facilities.data.data : [];
  const chosen = list.find((f) => f.id === facilityId) ?? list[0] ?? null;
  const day = date ?? (chosen ? todayIn(chosen.timeZone) : null);
  const availability = useApiQuery<FacilityAvailabilityDto>(
    chosen && day ? `${unitPath}/facilities/${chosen.id}/availability?date=${day}` : null,
  );

  useEffect(() => {
    if (unit.status === 'success') {
      document.title = `Facilities · Unit ${unit.data.unitNumber} · VEYRA Console`;
    }
  }, [unit]);

  if (unit.status === 'loading') return <LoadingState label="Loading unit" />;
  if (unit.status === 'error') {
    if (unit.error instanceof ApiRequestError && unit.error.status === 404) {
      return (
        <EmptyState title="Unit not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={unit.error} onRetry={unit.reload} />;
  }
  const u = unit.data;
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={`/organisations/${organisationId}`}>{u.propertyName}</Link>
      {' / '}
      <Link href={unitPath}>Unit {u.unitNumber}</Link>
    </nav>
  );
  const header = (
    <div className="page__header">
      <h1>Facilities</h1>
    </div>
  );
  if (!canBook) {
    return (
      <>
        {crumbs}
        {header}
        <EmptyState title="Bookings are for owners and tenants">
          The owners and tenants of this home book the pool, gym and other facilities here.
        </EmptyState>
      </>
    );
  }

  const reloadAll = () => {
    bookings.reload();
    availability.reload();
  };
  const rows = bookings.status === 'success' ? bookings.data.data : [];

  return (
    <>
      {crumbs}
      {header}
      {facilities.status === 'loading' ? <LoadingState label="Loading facilities" /> : null}
      {facilities.status === 'error' ? (
        <ErrorState error={facilities.error} onRetry={facilities.reload} />
      ) : null}
      {facilities.status === 'success' && list.length === 0 ? (
        <EmptyState title="Nothing to book yet">
          The property team has not opened any facility for booking.
        </EmptyState>
      ) : null}
      {chosen && day ? (
        <Card title="Book a facility">
          <div className="form__row">
            <SelectField
              label="Facility"
              value={chosen.id}
              onChange={(e) => {
                setFacilityId(e.target.value);
                setBooked(null);
              }}
            >
              {list.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Day"
              type="date"
              value={day}
              min={todayIn(chosen.timeZone)}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
              }}
            />
          </div>
          {chosen.description ? <p>{chosen.description}</p> : null}
          <ul className="muted" aria-label="Booking rules">
            {[
              ...describeRules(chosen),
              ...describeHours(chosen.openingHours).map((line) => `Open ${line}.`),
              ...(chosen.fee ? [`Fee: ${formatMoney(chosen.fee.perSlot)} per slot.`] : []),
              ...(chosen.deposit
                ? [`Refundable deposit: ${formatMoney(chosen.deposit.amount)}.`]
                : []),
            ].map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
          {chosen.fee || chosen.deposit ? (
            <p className="muted">
              Charges go on your home's account when the booking is confirmed.
            </p>
          ) : null}
          {booked ? (
            <Alert tone="success" title="Booked">
              {booked.number}:{' '}
              {booked.status === 'PENDING'
                ? 'the property team will confirm it.'
                : 'confirmed. See it under Your bookings.'}
            </Alert>
          ) : null}
          {availability.status === 'loading' ? <LoadingState label="Loading free times" /> : null}
          {availability.status === 'error' ? (
            <ErrorState error={availability.error} onRetry={availability.reload} />
          ) : null}
          {availability.status === 'success' ? (
            <SlotPicker
              key={`${chosen.id}:${day}`}
              availability={availability.data}
              maxSlots={chosen.maxSlotsPerBooking}
              path={`${unitPath}/facility-bookings`}
              facilityId={chosen.id}
              onBooked={(b) => {
                setBooked(b);
                reloadAll();
              }}
            />
          ) : null}
        </Card>
      ) : null}
      <Card title="Your bookings">
        {bookings.status === 'loading' ? <LoadingState label="Loading bookings" /> : null}
        {bookings.status === 'error' ? (
          <ErrorState error={bookings.error} onRetry={bookings.reload} />
        ) : null}
        {bookings.status === 'success' && rows.length === 0 ? (
          <p className="muted">This home has no bookings yet.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Bookings">
            {rows.map((b) => (
              <li key={b.id} className="list__item">
                <div>
                  <BookingSummary booking={b} timeZone={u.propertyTimeZone} />
                  {(b.status === 'PENDING' || b.status === 'CONFIRMED') && !b.cancellable ? (
                    <p className="list__meta">
                      Too close to the start to cancel here; ask the property team.
                    </p>
                  ) : null}
                  <p className="list__meta">
                    Booked {formatInstant(b.createdAt, u.propertyTimeZone)}
                  </p>
                </div>
                {b.cancellable ? (
                  <BookingAction
                    label="Cancel booking"
                    path={`${unitPath}/facility-bookings/${b.id}/cancel`}
                    reason="optional"
                    variant="danger"
                    onDone={reloadAll}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}
