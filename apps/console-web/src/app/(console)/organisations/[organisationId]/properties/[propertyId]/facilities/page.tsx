'use client';

import type {
  CommonAreaDto,
  FacilityBookingDto,
  FacilityBookingStatus,
  FacilityDetailDto,
  FacilityDto,
  Paginated,
  PropertyDetailResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { BookingAction, BookingSummary } from '@/components/facilities';
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
import { BOOKING_STATUS_LABELS, describeHours, everyDay, formatDuration } from '@/lib/facilities';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

const QUEUE_FILTERS: (FacilityBookingStatus | 'ALL')[] = ['PENDING', 'CONFIRMED', 'ALL'];

/** A property's facilities and bookings for staff: set up, approve, cancel, mark used. */
export default function PropertyFacilitiesPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canRead =
    property.status === 'success' && property.data.permissions.includes('property.facility.read');
  const facilities = useApiQuery<{ data: FacilityDto[] }>(canRead ? `${base}/facilities` : null);
  const [filter, setFilter] = useState<FacilityBookingStatus | 'ALL'>('PENDING');
  const bookings = useApiQuery<{ data: FacilityBookingDto[] }>(
    canRead ? `${base}/facility-bookings${filter === 'ALL' ? '' : `?status=${filter}`}` : null,
  );

  useEffect(() => {
    if (property.status === 'success') {
      document.title = `Facilities · ${property.data.name} · VEYRA Console`;
    }
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
  const canManage = p.permissions.includes('property.facility.manage');
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={`/organisations/${organisationId}`}>Properties</Link>
      {' / '}
      <Link href={base}>{p.name}</Link>
    </nav>
  );
  if (!canRead) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>Facilities</h1>
        </div>
        <EmptyState title="You cannot see facilities here">
          Property managers and security supervisors see this property's facilities and bookings.
        </EmptyState>
      </>
    );
  }
  const list = facilities.status === 'success' ? facilities.data.data : [];
  const rows = bookings.status === 'success' ? bookings.data.data : [];
  const act = (b: FacilityBookingDto, action: string) =>
    `${base}/facility-bookings/${b.id}/${action}`;
  const started = (b: FacilityBookingDto) => new Date(b.startsAt).getTime() <= Date.now();

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Facilities</h1>
      </div>

      <Card title="Bookings">
        <div className="form__row">
          <SelectField
            label="Show"
            value={filter}
            onChange={(e) => setFilter(e.target.value as FacilityBookingStatus | 'ALL')}
          >
            {QUEUE_FILTERS.map((f) => (
              <option key={f} value={f}>
                {f === 'ALL' ? 'All bookings' : `Only ${BOOKING_STATUS_LABELS[f]}`}
              </option>
            ))}
          </SelectField>
        </div>
        {bookings.status === 'loading' ? <LoadingState label="Loading bookings" /> : null}
        {bookings.status === 'error' ? (
          <ErrorState error={bookings.error} onRetry={bookings.reload} />
        ) : null}
        {bookings.status === 'success' && rows.length === 0 ? (
          <p className="muted">No bookings to show.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Facility bookings">
            {rows.map((b) => (
              <li key={b.id} className="list__item">
                <div>
                  <BookingSummary booking={b} timeZone={p.timeZone} showUnit />
                </div>
                {canManage ? (
                  <div className="form__actions">
                    {b.status === 'PENDING' ? (
                      <>
                        <BookingAction
                          label="Approve"
                          path={act(b, 'approve')}
                          reason="none"
                          variant="primary"
                          onDone={bookings.reload}
                        />
                        <BookingAction
                          label="Decline"
                          path={act(b, 'reject')}
                          reason="required"
                          variant="danger"
                          onDone={bookings.reload}
                        />
                      </>
                    ) : null}
                    {b.status === 'CONFIRMED' && started(b) ? (
                      <>
                        <BookingAction
                          label="Mark used"
                          path={act(b, 'complete')}
                          reason="none"
                          onDone={bookings.reload}
                        />
                        <BookingAction
                          label="Mark not used"
                          path={act(b, 'no-show')}
                          reason="none"
                          onDone={bookings.reload}
                        />
                      </>
                    ) : null}
                    {b.status === 'PENDING' || b.status === 'CONFIRMED' ? (
                      <BookingAction
                        label="Cancel booking"
                        path={act(b, 'cancel')}
                        reason={b.status === 'CONFIRMED' ? 'required' : 'optional'}
                        variant="danger"
                        onDone={bookings.reload}
                      />
                    ) : null}
                    {(b.status === 'COMPLETED' || b.status === 'NO_SHOW') &&
                    b.invoiceId &&
                    b.deposit.amountMinor !== '0' &&
                    !b.depositReleasedAt ? (
                      <BookingAction
                        label="Release deposit"
                        path={act(b, 'release-deposit')}
                        reason="none"
                        onDone={bookings.reload}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Bookable facilities">
        {facilities.status === 'loading' ? <LoadingState label="Loading facilities" /> : null}
        {facilities.status === 'error' ? (
          <ErrorState error={facilities.error} onRetry={facilities.reload} />
        ) : null}
        {facilities.status === 'success' && list.length === 0 ? (
          <p className="muted">No common area is bookable yet.</p>
        ) : null}
        {list.length > 0 ? (
          <ul className="list" aria-label="Facilities">
            {list.map((f) => (
              <li key={f.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${base}/facilities/${f.id}`}>{f.name}</Link>{' '}
                    <StatusBadge status={f.status} />
                  </p>
                  <p className="list__meta">
                    {formatDuration(f.slotMinutes)} slots ·{' '}
                    {f.approvalRequired ? 'approval needed' : 'confirmed at once'} ·{' '}
                    {describeHours(f.openingHours).join('; ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {canManage ? (
        <CreateFacility
          base={base}
          taken={new Set(list.map((f) => f.commonAreaId))}
          onCreated={facilities.reload}
        />
      ) : null}
    </>
  );
}

/** Make a common area bookable: slot length, opening hours (every day) and the main rules. */
function CreateFacility({
  base,
  taken,
  onCreated,
}: {
  base: string;
  taken: Set<string>;
  onCreated: () => void;
}) {
  const router = useRouter();
  const areas = useApiQuery<Paginated<CommonAreaDto>>(`${base}/common-areas?limit=200`);
  const [form, setForm] = useState({
    commonAreaId: '',
    slotMinutes: '60',
    capacity: '1',
    maxSlotsPerBooking: '2',
    opensAt: '06:00',
    closesAt: '22:00',
    maxAdvanceDays: '30',
    cancellationMinutes: '120',
    approvalRequired: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const free =
    areas.status === 'success'
      ? areas.data.data.filter((a) => a.status === 'ACTIVE' && !taken.has(a.id))
      : [];
  const areaId = form.commonAreaId || free[0]?.id || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<FacilityDetailDto>(`${base}/facilities`, {
        commonAreaId: areaId,
        slotMinutes: Number(form.slotMinutes),
        capacity: Number(form.capacity),
        maxSlotsPerBooking: Number(form.maxSlotsPerBooking),
        maxAdvanceDays: Number(form.maxAdvanceDays),
        cancellationMinutes: Number(form.cancellationMinutes),
        approvalRequired: form.approvalRequired,
        openingHours: everyDay(form.opensAt, form.closesAt === '00:00' ? '24:00' : form.closesAt),
      });
      onCreated();
      router.push(`${base}/facilities/${created.facility.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const errors = fieldErrors(error);
  return (
    <Card title="Make a common area bookable">
      {areas.status === 'loading' ? <LoadingState label="Loading common areas" /> : null}
      {areas.status === 'error' ? <ErrorState error={areas.error} onRetry={areas.reload} /> : null}
      {areas.status === 'success' && free.length === 0 ? (
        <p className="muted">Every active common area is already bookable. Add one first.</p>
      ) : null}
      {free.length > 0 ? (
        <form onSubmit={submit} aria-label="Make a common area bookable" className="form">
          <div className="form__row">
            <SelectField label="Common area" value={areaId} onChange={set('commonAreaId')}>
              {free.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Slot length (minutes)"
              type="number"
              min={5}
              step={5}
              value={form.slotMinutes}
              onChange={set('slotMinutes')}
              error={errors.slotMinutes}
            />
            <TextField
              label="Bookings at the same time"
              type="number"
              min={1}
              value={form.capacity}
              onChange={set('capacity')}
              error={errors.capacity}
            />
          </div>
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
          <div className="form__row">
            <TextField
              label="Most slots in one booking"
              type="number"
              min={1}
              value={form.maxSlotsPerBooking}
              onChange={set('maxSlotsPerBooking')}
            />
            <TextField
              label="Days ahead residents can book"
              type="number"
              min={1}
              value={form.maxAdvanceDays}
              onChange={set('maxAdvanceDays')}
            />
            <TextField
              label="Residents cancel up to (minutes before)"
              type="number"
              min={0}
              value={form.cancellationMinutes}
              onChange={set('cancellationMinutes')}
            />
          </div>
          <CheckboxField
            label="Bookings need approval"
            checked={form.approvalRequired}
            onChange={(e) => setForm((f) => ({ ...f, approvalRequired: e.target.checked }))}
          />
          {error ? <Alert>{errorMessage(error)}</Alert> : null}
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              Make bookable
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
