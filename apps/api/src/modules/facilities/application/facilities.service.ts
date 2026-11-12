import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode, databaseErrorMessage } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  type BookingInput,
  type BookingListQuery,
  type BookingStatus,
  type ClosureInput,
  type CreateFacilityInput,
  canMoveBooking,
  LIVE_BOOKING,
  needsReason,
  type OpeningRange,
  residentMayCancel,
  type UpdateFacilityInput,
} from '../domain/facility-rules';
import {
  type BookingRecord,
  FACILITY_REPOSITORY,
  type FacilityRecord,
  type FacilityRepository,
  type FacilityUnitOfWork,
  type SlotRecord,
} from './facility-ports';

const facilityNotFound = () => new ApiError(404, 'NOT_FOUND', 'Facility not found');
const bookingNotFound = () => new ApiError(404, 'NOT_FOUND', 'Booking not found');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);

export type SlotState = 'OPEN' | 'FULL' | 'CLOSED' | 'TOO_SOON' | 'TOO_FAR';

export interface Slot extends SlotRecord {
  available: number;
  state: SlotState;
}

/** Whether and how many places a slot has for a new booking at `now`. */
export function slotState(facility: FacilityRecord, slot: SlotRecord, now: Date): Slot {
  const start = slot.startsAt.getTime();
  let state: SlotState = 'OPEN';
  if (slot.closed) state = 'CLOSED';
  else if (start < now.getTime() + facility.minNoticeMinutes * 60_000) state = 'TOO_SOON';
  else if (start > now.getTime() + facility.maxAdvanceDays * 86_400_000) state = 'TOO_FAR';
  else if (slot.taken >= facility.capacity) state = 'FULL';
  return { ...slot, state, available: state === 'OPEN' ? facility.capacity - slot.taken : 0 };
}

/** The database's own words for the booking rules it enforces, as API errors. */
const DATABASE_RULES: [RegExp, number, string][] = [
  [/fully booked/, 409, 'SLOT_UNAVAILABLE'],
  [/closed then/, 409, 'FACILITY_CLOSED'],
  [/upcoming bookings of this facility/, 409, 'BOOKING_LIMIT'],
  [
    /whole \d+ minute slots|at most \d+ slots|minutes ahead|days ahead/,
    422,
    'INVALID_BOOKING_TIME',
  ],
  [/is archived/, 409, 'ARCHIVED'],
  [/cancel the (upcoming )?bookings/, 409, 'BOOKINGS_IN_THE_WAY'],
  [/opening hours of one day cannot overlap/, 422, 'INVALID_OPENING_HOURS'],
];

function translateDatabaseError(error: unknown): never {
  const code = databaseErrorCode(error);
  if (code === '23514') {
    const message = databaseErrorMessage(error) ?? '';
    for (const [pattern, status, apiCode] of DATABASE_RULES) {
      if (pattern.test(message)) {
        throw new ApiError(status, apiCode, message.charAt(0).toUpperCase() + message.slice(1));
      }
    }
    throw invalidState('This change is not possible any more. Reload and try again.');
  }
  if (code === '23505') {
    throw new ApiError(409, 'ALREADY_EXISTS', 'This common area already has a facility');
  }
  throw error;
}

/**
 * Facilities and bookings (Phase 8 Part 2). Staff set up facilities, opening hours and closures
 * and decide on bookings (property.facility.*). A unit's residents (owners and tenants, owner
 * decision 2026-11-12) and staff on their behalf book through the unit's routes
 * (unit.facility.book); residents cancel only before the facility's cancellation window. Every
 * rule is enforced again by the database under a per-facility lock.
 */
@Injectable()
export class FacilitiesService {
  constructor(@Inject(FACILITY_REPOSITORY) private readonly repository: FacilityRepository) {}

  // ------------------------------------------------------------------ staff: setup

  list(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => ({
      facilities: await uow.facilities({ activeOnly: false }),
      timeZone: (await uow.property()).timeZone,
    }));
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => this.view(uow, id));
  }

  create(access: OrganisationAccess, input: CreateFacilityInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const area = await uow.commonArea(input.commonAreaId);
      if (!area) throw new ApiError(404, 'NOT_FOUND', 'Common area not found');
      if (area.status !== 'ACTIVE')
        throw new ApiError(409, 'ARCHIVED', 'This common area is archived');
      if (await uow.facilityForArea(input.commonAreaId)) {
        throw new ApiError(409, 'ALREADY_EXISTS', 'This common area already has a facility');
      }
      const { openingHours, commonAreaId, description, ...settings } = input;
      const id = await uow.createFacility({
        commonAreaId,
        description: description ?? null,
        ...settings,
      });
      await uow.replaceOpeningHours(id, openingHours);
      await uow.audit({ action: 'facility.created', resourceType: 'facility', resourceId: id });
      return this.view(uow, id);
    });
  }

  update(access: OrganisationAccess, id: string, input: UpdateFacilityInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeFacility(uow, id);
      await uow.updateFacility(id, input);
      await uow.audit({
        action: 'facility.updated',
        resourceType: 'facility',
        resourceId: id,
        metadata: { fields: Object.keys(input).join(',') },
      });
      return this.view(uow, id);
    });
  }

  replaceHours(access: OrganisationAccess, id: string, ranges: OpeningRange[], meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeFacility(uow, id, true);
      await uow.replaceOpeningHours(id, ranges);
      await uow.audit({
        action: 'facility.hours_replaced',
        resourceType: 'facility',
        resourceId: id,
      });
      return this.view(uow, id);
    });
  }

  archive(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeFacility(uow, id, true);
      const upcoming = await uow.bookings({ facilityId: id, from: new Date(0) }, 500);
      const now = Date.now();
      if (upcoming.some((b) => LIVE_BOOKING.includes(b.status) && b.endsAt.getTime() > now)) {
        throw new ApiError(
          409,
          'BOOKINGS_IN_THE_WAY',
          'Cancel the upcoming bookings of this facility before archiving it',
        );
      }
      await uow.archiveFacility(id);
      await uow.audit({ action: 'facility.archived', resourceType: 'facility', resourceId: id });
      return this.view(uow, id);
    });
  }

  addClosure(access: OrganisationAccess, id: string, input: ClosureInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeFacility(uow, id, true);
      const inTheWay = (await uow.bookings({ facilityId: id, to: input.endsAt }, 1000)).filter(
        (b) => LIVE_BOOKING.includes(b.status) && b.endsAt > input.startsAt,
      );
      if (inTheWay.length > 0 && !input.cancelBookings) {
        throw new ApiError(
          409,
          'BOOKINGS_IN_THE_WAY',
          `${inTheWay.length} booking(s) fall in this period. Cancel them with the closure, or choose another period.`,
        );
      }
      const note = `Facility closed: ${input.reason}`.slice(0, 1000);
      for (const b of inTheWay) {
        await uow.setBookingStatus(b.id, 'CANCELLED', note);
        await this.auditBooking(uow, b.id, 'cancelled', { byStaff: true, closure: true });
      }
      const closureId = await uow.createClosure({
        facilityId: id,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason,
      });
      await uow.audit({
        action: 'facility.closure.created',
        resourceType: 'facility_closure',
        resourceId: closureId,
        metadata: { facilityId: id, cancelledBookings: inTheWay.length },
      });
      return this.view(uow, id);
    });
  }

  liftClosure(access: OrganisationAccess, id: string, closureId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.mustFindFacility(uow, id);
      const closure = await uow.closure(closureId);
      if (!closure || closure.facilityId !== id) {
        throw new ApiError(404, 'NOT_FOUND', 'Closure not found');
      }
      if (closure.liftedAt) throw invalidState('This closure is already lifted');
      await uow.liftClosure(closureId);
      await uow.audit({
        action: 'facility.closure.lifted',
        resourceType: 'facility_closure',
        resourceId: closureId,
      });
      return this.view(uow, id);
    });
  }

  availability(access: OrganisationAccess, id: string, date: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const facility = await this.mustFindFacility(uow, id);
      return this.slots(uow, facility, date);
    });
  }

  // ------------------------------------------------------------------ staff: bookings

  bookings(access: OrganisationAccess, query: BookingListQuery, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) =>
      uow.bookings(
        {
          ...(query.status ? { status: query.status } : {}),
          ...(query.facilityId ? { facilityId: query.facilityId } : {}),
          ...(query.unitId ? { unitId: query.unitId } : {}),
          ...(query.from ? { from: new Date(query.from) } : {}),
          ...(query.to ? { to: new Date(query.to) } : {}),
        },
        500,
      ),
    );
  }

  bookingDetail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => this.bookingView(uow, id));
  }

  /** Approve, reject, cancel, or mark a booking used or not used. */
  decide(
    access: OrganisationAccess,
    id: string,
    to: Exclude<BookingStatus, 'PENDING'>,
    reason: string | undefined,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const booking = await this.mustFindBooking(uow, id);
      this.requireMove(booking, to, reason);
      const now = Date.now();
      if (to === 'CONFIRMED' && booking.endsAt.getTime() <= now) {
        throw invalidState('This booking has already ended');
      }
      if ((to === 'COMPLETED' || to === 'NO_SHOW') && booking.startsAt.getTime() > now) {
        throw invalidState('A booking is marked used or not used once it has started');
      }
      await uow.setBookingStatus(id, to, reason ?? null);
      await this.auditBooking(uow, id, to.toLowerCase(), { byStaff: true });
      return this.bookingView(uow, id);
    });
  }

  // ------------------------------------------------------------------ a unit's residents

  unitFacilities(access: OrganisationAccess, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow) => ({
      facilities: await uow.facilities({ activeOnly: true }),
      timeZone: (await uow.property()).timeZone,
    }));
  }

  unitAvailability(access: OrganisationAccess, id: string, date: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow) => {
      const facility = await this.mustFindFacility(uow, id);
      if (facility.status !== 'ACTIVE') throw facilityNotFound();
      return this.slots(uow, facility, date);
    });
  }

  unitBookings(access: OrganisationAccess, meta: RequestMeta) {
    return this.inUnit(access, meta, (uow, unitId) => uow.bookings({ unitId }, 200));
  }

  unitBookingDetail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      await this.mustFindUnitBooking(uow, unitId, id);
      return this.bookingView(uow, id);
    });
  }

  book(access: OrganisationAccess, input: BookingInput, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      const facility = await this.mustFindFacility(uow, input.facilityId, true);
      if (facility.status !== 'ACTIVE') throw facilityNotFound();
      if (input.slots > facility.maxSlotsPerBooking) {
        throw new ApiError(
          422,
          'INVALID_BOOKING_TIME',
          `A booking is at most ${facility.maxSlotsPerBooking} slots`,
        );
      }
      const endsAt = new Date(
        input.startsAt.getTime() + input.slots * facility.slotMinutes * 60_000,
      );
      const id = await uow.createBooking({
        facilityId: facility.id,
        unitId,
        startsAt: input.startsAt,
        endsAt,
        purpose: input.purpose ?? null,
      });
      await this.auditBooking(uow, id, 'created', {
        byStaff: access.permissions.has('property.facility.manage'),
        slots: input.slots,
      });
      return this.bookingView(uow, id);
    });
  }

  /** Withdraw a booking of the unit, before the facility's cancellation window. */
  unitCancel(
    access: OrganisationAccess,
    id: string,
    reason: string | undefined,
    meta: RequestMeta,
  ) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      const booking = await this.mustFindUnitBooking(uow, unitId, id);
      if (!canMoveBooking(booking.status, 'CANCELLED')) {
        throw invalidState(`A booking that is ${this.word(booking.status)} cannot be cancelled`);
      }
      if (!residentMayCancel(booking.startsAt, booking.cancellationMinutes, new Date())) {
        throw new ApiError(
          409,
          'TOO_LATE_TO_CANCEL',
          'It is too late to cancel this booking here. Please contact the property team.',
        );
      }
      const note = reason ?? (booking.status === 'CONFIRMED' ? 'Cancelled by the resident' : null);
      await uow.setBookingStatus(id, 'CANCELLED', note);
      await this.auditBooking(uow, id, 'cancelled', { byStaff: false });
      return this.bookingView(uow, id);
    });
  }

  // ------------------------------------------------------------------ shared

  private async slots(uow: FacilityUnitOfWork, facility: FacilityRecord, date: string) {
    const [rows, property] = await Promise.all([uow.slots(facility.id, date), uow.property()]);
    const now = new Date();
    return {
      facility,
      date,
      timeZone: property.timeZone,
      slots: rows.map((s) => slotState(facility, s, now)),
    };
  }

  private async view(uow: FacilityUnitOfWork, id: string) {
    const facility = await this.mustFindFacility(uow, id);
    const [closures, property] = await Promise.all([uow.closures(id, new Date()), uow.property()]);
    return { facility, closures, timeZone: property.timeZone };
  }

  private async bookingView(uow: FacilityUnitOfWork, id: string) {
    const booking = await this.mustFindBooking(uow, id);
    return { booking, events: await uow.bookingEvents(id) };
  }

  private async mustFindFacility(uow: FacilityUnitOfWork, id: string, lock = false) {
    const facility = await uow.facility(id, { lock });
    if (!facility) throw facilityNotFound();
    return facility;
  }

  private async activeFacility(uow: FacilityUnitOfWork, id: string, lock = false) {
    const facility = await this.mustFindFacility(uow, id, lock);
    if (facility.status !== 'ACTIVE') {
      throw new ApiError(409, 'ARCHIVED', 'This facility is archived');
    }
    return facility;
  }

  private async mustFindBooking(uow: FacilityUnitOfWork, id: string): Promise<BookingRecord> {
    const booking = await uow.booking(id);
    if (!booking) throw bookingNotFound();
    return booking;
  }

  private async mustFindUnitBooking(uow: FacilityUnitOfWork, unitId: string, id: string) {
    const booking = await uow.booking(id);
    if (!booking || booking.unitId !== unitId) throw bookingNotFound();
    return booking;
  }

  private requireMove(booking: BookingRecord, to: BookingStatus, reason: string | undefined) {
    if (!canMoveBooking(booking.status, to)) {
      throw invalidState(
        `A booking that is ${this.word(booking.status)} cannot become ${this.word(to)}`,
      );
    }
    if (needsReason(booking.status, to) && !reason) {
      throw new ApiError(422, 'REASON_REQUIRED', 'Give a reason');
    }
  }

  private word(status: BookingStatus) {
    return status.toLowerCase().replace('_', ' ');
  }

  private auditBooking(
    uow: FacilityUnitOfWork,
    id: string,
    what: string,
    metadata: Record<string, string | number | boolean>,
  ) {
    return uow.audit({
      action: `facility.booking.${what}`,
      resourceType: 'facility_booking',
      resourceId: id,
      metadata,
    });
  }

  private async inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: FacilityUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const { propertyId } = access;
    if (!propertyId) throw new Error('Property route without a resolved property');
    try {
      return await this.repository.inProperty(
        access.organisationId,
        propertyId,
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  private inUnit<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: FacilityUnitOfWork, unitId: string) => Promise<T>,
  ): Promise<T> {
    const { unitId } = access;
    if (!unitId) throw new Error('Unit route without a resolved unit');
    return this.inProperty(access, meta, (uow) => work(uow, unitId));
  }
}
