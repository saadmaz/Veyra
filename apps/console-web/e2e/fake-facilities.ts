import { randomUUID } from 'node:crypto';
import type {
  FacilityBookingDto,
  FacilityBookingStatus,
  FacilityDto,
  FacilitySlotDto,
  OpeningRangeDto,
  PropertyDto,
  UnitDto,
} from '@veyra/api-contracts';

/*
 * Facilities and bookings for the fake API (Phase 8). Follows the wire contracts and the main
 * rules (whole slots in opening hours, capacity, approval, the residents' cancellation window);
 * the API's own integration tests prove the rest against a real database. Properties in the fake
 * are in Asia/Karachi (UTC+5, no daylight saving), so local times convert with a fixed offset.
 */

interface Reply {
  status: number;
  body?: unknown;
}

const fail = (status: number, code: string, message = code): Reply => ({
  status,
  body: { error: { code, message, details: [] } },
});
const ok = (body: unknown, status = 200): Reply => ({ status, body });

const OFFSET = '+05:00';
const LIVE: FacilityBookingStatus[] = ['PENDING', 'CONFIRMED'];
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const localInstant = (date: string, minutes: number) =>
  new Date(new Date(`${date}T00:00:00${OFFSET}`).getTime() + minutes * 60_000).toISOString();

type Facility = FacilityDto & { propertyId: string };
type Booking = FacilityBookingDto & { propertyId: string };

interface Ctx {
  method: string;
  sub: string;
  body: Record<string, unknown>;
  url: URL;
  property: PropertyDto;
  user: { id: string; displayName: string };
}

export class FakeFacilities {
  facilities: Facility[] = [];
  bookings: Booking[] = [];
  private counter = 0;

  add(
    propertyId: string,
    commonAreaId: string,
    name: string,
    settings: Partial<FacilityDto> = {},
  ): Facility {
    const facility: Facility = {
      id: randomUUID(),
      propertyId,
      commonAreaId,
      name,
      type: 'POOL',
      description: null,
      status: 'ACTIVE',
      slotMinutes: 60,
      capacity: 1,
      approvalRequired: false,
      minNoticeMinutes: 0,
      maxAdvanceDays: 30,
      maxSlotsPerBooking: 2,
      maxUpcomingPerUnit: null,
      cancellationMinutes: 120,
      openingHours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        opensAt: '06:00',
        closesAt: '22:00',
      })),
      timeZone: 'Asia/Karachi',
      fee: null,
      deposit: null,
      ...settings,
    };
    this.facilities.push(facility);
    return facility;
  }

  private slots(f: Facility, date: string): FacilitySlotDto[] {
    const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const now = Date.now();
    const result: FacilitySlotDto[] = [];
    for (const r of f.openingHours.filter((h: OpeningRangeDto) => h.weekday === weekday)) {
      for (
        let m = minutesOf(r.opensAt);
        m + f.slotMinutes <= minutesOf(r.closesAt);
        m += f.slotMinutes
      ) {
        const startsAt = localInstant(date, m);
        const endsAt = localInstant(date, m + f.slotMinutes);
        const taken = this.bookings.filter(
          (b) =>
            b.facilityId === f.id &&
            LIVE.includes(b.status) &&
            b.startsAt < endsAt &&
            b.endsAt > startsAt,
        ).length;
        const start = new Date(startsAt).getTime();
        let state: FacilitySlotDto['state'] = 'OPEN';
        if (start < now + f.minNoticeMinutes * 60_000) state = 'TOO_SOON';
        else if (start > now + f.maxAdvanceDays * 86_400_000) state = 'TOO_FAR';
        else if (taken >= f.capacity) state = 'FULL';
        result.push({
          startsAt,
          endsAt,
          time: hhmm(m),
          available: state === 'OPEN' ? f.capacity - taken : 0,
          state,
        });
      }
    }
    return result;
  }

  private cancellable(b: Booking) {
    const f = this.facilities.find((x) => x.id === b.facilityId);
    return (
      LIVE.includes(b.status) &&
      Date.now() <= new Date(b.startsAt).getTime() - (f?.cancellationMinutes ?? 0) * 60_000
    );
  }

  private view(b: Booking): FacilityBookingDto {
    const { propertyId: _, ...rest } = b;
    return { ...rest, cancellable: this.cancellable(b) };
  }

  private setStatus(b: Booking, status: FacilityBookingStatus, note: string | null) {
    b.status = status;
    if (status === 'REJECTED' || status === 'CANCELLED') b.statusNote = note;
    if (status === 'CANCELLED') b.cancelledAt = new Date().toISOString();
    if (status === 'CONFIRMED' || status === 'REJECTED') b.decidedAt = new Date().toISOString();
  }

  /** A unit's routes: `sub` starts with /facilities or /facility-bookings. */
  handleUnit(c: Ctx & { unit: UnitDto }): Reply | null {
    const { method, sub, body, url, property, user, unit } = c;
    const facilityOf = (id: string) =>
      this.facilities.find(
        (f) => f.id === id && f.propertyId === property.id && f.status === 'ACTIVE',
      );
    if (sub === '/facilities' && method === 'GET') {
      return ok({
        data: this.facilities.filter((f) => f.propertyId === property.id && f.status === 'ACTIVE'),
      });
    }
    const avail = /^\/facilities\/([^/]+)\/availability$/.exec(sub);
    if (avail && method === 'GET') {
      const f = facilityOf(avail[1] as string);
      const date = url.searchParams.get('date');
      if (!f || !date) return fail(404, 'NOT_FOUND');
      return ok({
        facilityId: f.id,
        date,
        timeZone: f.timeZone,
        slotMinutes: f.slotMinutes,
        slots: this.slots(f, date),
      });
    }
    if (sub === '/facility-bookings' && method === 'GET') {
      return ok({
        data: this.bookings
          .filter((b) => b.unitId === unit.id)
          .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
          .map((b) => this.view(b)),
      });
    }
    if (sub === '/facility-bookings' && method === 'POST') {
      const f = facilityOf(String(body.facilityId));
      if (!f) return fail(404, 'NOT_FOUND');
      const slots = Number(body.slots ?? 1);
      if (slots > f.maxSlotsPerBooking) {
        return fail(
          422,
          'INVALID_BOOKING_TIME',
          `A booking is at most ${f.maxSlotsPerBooking} slots`,
        );
      }
      const startsAt = new Date(String(body.startsAt)).toISOString();
      const endsAt = new Date(
        new Date(startsAt).getTime() + slots * f.slotMinutes * 60_000,
      ).toISOString();
      const taken = this.bookings.filter(
        (b) =>
          b.facilityId === f.id &&
          LIVE.includes(b.status) &&
          b.startsAt < endsAt &&
          b.endsAt > startsAt,
      ).length;
      if (taken >= f.capacity) return fail(409, 'SLOT_UNAVAILABLE', 'That time is fully booked');
      this.counter += 1;
      const now = new Date().toISOString();
      const booking: Booking = {
        id: randomUUID(),
        propertyId: property.id,
        number: `BK-${String(this.counter).padStart(6, '0')}`,
        facilityId: f.id,
        facilityName: f.name,
        unitId: unit.id,
        unitNumber: unit.number,
        startsAt,
        endsAt,
        slotCount: slots,
        status: f.approvalRequired ? 'PENDING' : 'CONFIRMED',
        statusNote: null,
        purpose: typeof body.purpose === 'string' ? body.purpose : null,
        bookedBy: { userId: user.id, name: user.displayName },
        decidedAt: null,
        cancelledAt: null,
        createdAt: now,
        fee: { amountMinor: '0', currency: property.currency },
        deposit: { amountMinor: '0', currency: property.currency },
        invoiceId: null,
        depositReleasedAt: null,
        cancellable: true,
      };
      this.bookings.push(booking);
      return ok({ booking: this.view(booking), events: [] }, 201);
    }
    const cancel = /^\/facility-bookings\/([^/]+)\/cancel$/.exec(sub);
    if (cancel && method === 'POST') {
      const b = this.bookings.find((x) => x.id === cancel[1] && x.unitId === unit.id);
      if (!b) return fail(404, 'NOT_FOUND');
      if (!this.cancellable(b)) {
        return fail(409, 'TOO_LATE_TO_CANCEL', 'It is too late to cancel this booking here.');
      }
      const reason = typeof body.reason === 'string' ? body.reason : null;
      this.setStatus(
        b,
        'CANCELLED',
        reason ?? (b.status === 'CONFIRMED' ? 'Cancelled by the resident' : null),
      );
      return ok({ booking: this.view(b), events: [] });
    }
    return null;
  }

  /** A property's staff routes: `sub` starts with /facilities or /facility-bookings. */
  handleProperty(
    c: Ctx & { permissions: string[]; commonAreas: { id: string; name: string }[] },
  ): Reply | null {
    const { method, sub, body, url, property, permissions, commonAreas } = c;
    if (!sub.startsWith('/facilities') && !sub.startsWith('/facility-bookings')) return null;
    if (!permissions.includes('property.facility.read')) return fail(403, 'FORBIDDEN');
    const manage = permissions.includes('property.facility.manage');
    const detail = (f: Facility) => ({ facility: f, closures: [] });
    if (sub === '/facilities' && method === 'GET') {
      return ok({ data: this.facilities.filter((f) => f.propertyId === property.id) });
    }
    if (sub === '/facilities' && method === 'POST') {
      if (!manage) return fail(403, 'FORBIDDEN');
      if (this.facilities.some((f) => f.commonAreaId === body.commonAreaId)) {
        return fail(409, 'ALREADY_EXISTS', 'This common area already has a facility');
      }
      const area = commonAreas.find((a) => a.id === body.commonAreaId);
      if (!area) return fail(404, 'NOT_FOUND');
      const f = this.add(property.id, area.id, area.name, {
        slotMinutes: Number(body.slotMinutes),
        capacity: Number(body.capacity ?? 1),
        maxSlotsPerBooking: Number(body.maxSlotsPerBooking ?? 1),
        maxAdvanceDays: Number(body.maxAdvanceDays ?? 30),
        cancellationMinutes: Number(body.cancellationMinutes ?? 0),
        approvalRequired: Boolean(body.approvalRequired),
        openingHours: (body.openingHours as OpeningRangeDto[]) ?? [],
      });
      return ok(detail(f), 201);
    }
    const one = /^\/facilities\/([^/]+)(\/.*)?$/.exec(sub);
    if (one) {
      const f = this.facilities.find((x) => x.id === one[1] && x.propertyId === property.id);
      if (!f) return fail(404, 'NOT_FOUND');
      const rest = one[2] ?? '';
      if (rest === '' && method === 'GET') return ok(detail(f));
      if (rest === '/availability' && method === 'GET') {
        const date = url.searchParams.get('date') ?? '';
        return ok({
          facilityId: f.id,
          date,
          timeZone: f.timeZone,
          slotMinutes: f.slotMinutes,
          slots: this.slots(f, date),
        });
      }
      return fail(404, 'NOT_FOUND');
    }
    if (sub === '/facility-bookings' && method === 'GET') {
      const status = url.searchParams.get('status');
      return ok({
        data: this.bookings
          .filter((b) => b.propertyId === property.id && (!status || b.status === status))
          .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
          .map((b) => this.view(b)),
      });
    }
    const action = /^\/facility-bookings\/([^/]+)\/([a-z-]+)$/.exec(sub);
    if (action && method === 'POST') {
      if (!manage) return fail(403, 'FORBIDDEN');
      const b = this.bookings.find((x) => x.id === action[1] && x.propertyId === property.id);
      if (!b) return fail(404, 'NOT_FOUND');
      const reason = typeof body.reason === 'string' ? body.reason : null;
      const moves: Record<string, [FacilityBookingStatus[], FacilityBookingStatus]> = {
        approve: [['PENDING'], 'CONFIRMED'],
        reject: [['PENDING'], 'REJECTED'],
        cancel: [['PENDING', 'CONFIRMED'], 'CANCELLED'],
        complete: [['CONFIRMED'], 'COMPLETED'],
        'no-show': [['CONFIRMED'], 'NO_SHOW'],
      };
      const move = moves[action[2] as string];
      if (!move) return fail(404, 'NOT_FOUND');
      if (!move[0].includes(b.status)) return fail(409, 'INVALID_STATE_TRANSITION');
      if (
        (move[1] === 'REJECTED' || (move[1] === 'CANCELLED' && b.status === 'CONFIRMED')) &&
        !reason
      ) {
        return fail(422, 'REASON_REQUIRED', 'Give a reason');
      }
      this.setStatus(b, move[1], reason);
      return ok({ booking: this.view(b), events: [] });
    }
    return null;
  }
}
