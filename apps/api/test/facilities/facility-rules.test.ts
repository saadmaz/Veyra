import { describe, expect, it } from 'vitest';
import { slotState } from '../../src/modules/facilities/application/facilities.service';
import type { FacilityRecord } from '../../src/modules/facilities/application/facility-ports';
import {
  bookingSchema,
  canMoveBooking,
  closureSchema,
  createFacilitySchema,
  formatBookingNumber,
  minutesOf,
  needsReason,
  openingHoursProblem,
  residentMayCancel,
  timeOf,
} from '../../src/modules/facilities/domain/facility-rules';

const facility: FacilityRecord = {
  id: 'f',
  commonAreaId: 'a',
  name: 'Pool',
  type: 'POOL',
  status: 'ACTIVE',
  description: null,
  slotMinutes: 60,
  capacity: 2,
  approvalRequired: false,
  minNoticeMinutes: 60,
  maxAdvanceDays: 7,
  maxSlotsPerBooking: 2,
  maxUpcomingPerUnit: null,
  cancellationMinutes: 120,
  openingHours: [],
};

const now = new Date('2026-11-12T10:00:00Z');
const slot = (hoursAhead: number, taken = 0, closed = false) => {
  const startsAt = new Date(now.getTime() + hoursAhead * 3_600_000);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    localMinutes: 0,
    taken,
    closed,
  };
};

describe('booking transitions', () => {
  it('follow the database and need reasons where it does', () => {
    expect(canMoveBooking('PENDING', 'CONFIRMED')).toBe(true);
    expect(canMoveBooking('PENDING', 'COMPLETED')).toBe(false);
    expect(canMoveBooking('CONFIRMED', 'NO_SHOW')).toBe(true);
    expect(canMoveBooking('CANCELLED', 'CONFIRMED')).toBe(false);
    expect(needsReason('PENDING', 'REJECTED')).toBe(true);
    expect(needsReason('PENDING', 'CANCELLED')).toBe(false);
    expect(needsReason('CONFIRMED', 'CANCELLED')).toBe(true);
    expect(formatBookingNumber(42n)).toBe('BK-000042');
  });

  it('let residents cancel only before the cancellation window', () => {
    const start = new Date(now.getTime() + 3 * 3_600_000);
    expect(residentMayCancel(start, 180, now)).toBe(true);
    expect(residentMayCancel(start, 181, now)).toBe(false);
  });
});

describe('slots', () => {
  it('are open with the places left, or say why not', () => {
    expect(slotState(facility, slot(2, 1), now)).toMatchObject({ state: 'OPEN', available: 1 });
    expect(slotState(facility, slot(2, 2), now)).toMatchObject({ state: 'FULL', available: 0 });
    expect(slotState(facility, slot(2, 0, true), now)).toMatchObject({ state: 'CLOSED' });
    expect(slotState(facility, slot(0.5), now)).toMatchObject({ state: 'TOO_SOON' });
    expect(slotState(facility, slot(8 * 24), now)).toMatchObject({ state: 'TOO_FAR' });
  });
});

describe('opening hours', () => {
  it('read and write HH:MM, midnight as 24:00', () => {
    expect(minutesOf('06:30')).toBe(390);
    expect(minutesOf('24:00')).toBe(1440);
    expect(timeOf(390)).toBe('06:30');
  });

  it('close after they open and never overlap on a day', () => {
    expect(openingHoursProblem([{ weekday: 1, opensAt: '06:00', closesAt: '12:00' }])).toBeNull();
    expect(
      openingHoursProblem([
        { weekday: 1, opensAt: '06:00', closesAt: '12:00' },
        { weekday: 1, opensAt: '12:00', closesAt: '24:00' },
      ]),
    ).toBeNull();
    expect(
      openingHoursProblem([
        { weekday: 2, opensAt: '06:00', closesAt: '12:00' },
        { weekday: 2, opensAt: '11:00', closesAt: '13:00' },
      ]),
    ).toMatch(/overlap/);
    expect(openingHoursProblem([{ weekday: 3, opensAt: '10:00', closesAt: '09:00' }])).toMatch(
      /after opening/,
    );
  });
});

describe('input', () => {
  it('needs slots in multiples of 5 minutes and valid hours', () => {
    const base = { commonAreaId: '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f60', slotMinutes: 60 };
    expect(createFacilitySchema.safeParse(base).success).toBe(true);
    expect(createFacilitySchema.safeParse({ ...base, slotMinutes: 7 }).success).toBe(false);
    expect(
      createFacilitySchema.safeParse({
        ...base,
        openingHours: [{ weekday: 1, opensAt: '25:00', closesAt: '26:00' }],
      }).success,
    ).toBe(false);
  });

  it('takes bookings and closures with explicit offsets', () => {
    const facilityId = '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f60';
    expect(bookingSchema.parse({ facilityId, startsAt: '2026-11-20T05:00:00Z' }).slots).toBe(1);
    expect(bookingSchema.safeParse({ facilityId, startsAt: '2026-11-20 05:00' }).success).toBe(
      false,
    );
    expect(
      closureSchema.safeParse({
        startsAt: '2026-11-20T05:00:00Z',
        endsAt: '2026-11-20T04:00:00Z',
        reason: 'Repair',
      }).success,
    ).toBe(false);
  });
});
