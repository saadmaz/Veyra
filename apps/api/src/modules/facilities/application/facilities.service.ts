import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode, databaseErrorMessage } from '@veyra/db';
import { Money } from '@veyra/domain';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import { NotificationsService } from '../../communications/application/notifications.service';
import {
  BookingChargesService,
  type ChargeLine,
  type ChargeScope,
} from '../../finance/application/booking-charges.service';
import {
  type BookingInput,
  type BookingListQuery,
  type BookingStatus,
  type ClosureInput,
  type CreateFacilityInput,
  canMoveBooking,
  formatBookingNumber,
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
  type FacilitySettings,
  type FacilityUnitOfWork,
  type SlotRecord,
} from './facility-ports';

const facilityNotFound = () => new ApiError(404, 'NOT_FOUND', 'Facility not found');
const bookingNotFound = () => new ApiError(404, 'NOT_FOUND', 'Booking not found');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);
const chargesGone = () =>
  new ApiError(409, 'CHARGE_NOT_SET_UP', "This facility's fee or deposit is no longer set up");

/** A booking invoice has the fee on line 1 (when there is one) and the deposit after it. */
const depositLine = (b: BookingRecord) => (b.feeMinor > 0n ? 2 : 1);

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
  constructor(
    @Inject(FACILITY_REPOSITORY) private readonly repository: FacilityRepository,
    @Inject(BookingChargesService) private readonly charges: BookingChargesService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ staff: setup

  list(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => ({
      facilities: await uow.facilities({ activeOnly: false }),
      ...(await this.place(uow)),
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
      const {
        openingHours,
        commonAreaId,
        description,
        feeChargeTypeId,
        feePerSlot,
        depositChargeTypeId,
        deposit,
        ...settings
      } = input;
      const money = await this.chargeSettings(uow, {
        feeChargeTypeId,
        feePerSlot,
        depositChargeTypeId,
        deposit,
      });
      const id = await uow.createFacility({
        commonAreaId,
        description: description ?? null,
        feeChargeTypeId: null,
        feePerSlotMinor: null,
        depositChargeTypeId: null,
        depositMinor: null,
        ...settings,
        ...money,
      });
      await uow.replaceOpeningHours(id, openingHours);
      await uow.audit({ action: 'facility.created', resourceType: 'facility', resourceId: id });
      return this.view(uow, id);
    });
  }

  update(access: OrganisationAccess, id: string, input: UpdateFacilityInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeFacility(uow, id);
      const { feeChargeTypeId, feePerSlot, depositChargeTypeId, deposit, ...settings } = input;
      const money = await this.chargeSettings(uow, {
        feeChargeTypeId,
        feePerSlot,
        depositChargeTypeId,
        deposit,
      });
      await uow.updateFacility(id, { ...settings, ...money });
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
        await this.creditOnCancel(uow, access, meta, b.id);
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
      if (to === 'CONFIRMED') await this.chargeIfConfirmed(uow, access, meta, id);
      if (to === 'CANCELLED') await this.creditOnCancel(uow, access, meta, id);
      if (to === 'CONFIRMED' || to === 'REJECTED' || to === 'CANCELLED') {
        await this.tellBooker(uow, access, id, to);
      }
      return this.bookingView(uow, id);
    });
  }

  // ------------------------------------------------------------------ a unit's residents

  unitFacilities(access: OrganisationAccess, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow) => ({
      facilities: await uow.facilities({ activeOnly: true }),
      ...(await this.place(uow)),
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
      await this.chargeIfConfirmed(uow, access, meta, id);
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
      await this.creditOnCancel(uow, access, meta, id);
      return this.bookingView(uow, id);
    });
  }

  /**
   * Gives the deposit back after the booking: a credit note on its line, while it is unpaid. A
   * paid deposit is refunded through finance (release the payment, credit the line, refund).
   */
  releaseDeposit(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const booking = await this.mustFindBooking(uow, id);
      if (!booking.invoiceId || booking.depositMinor === 0n) {
        throw invalidState('This booking has no deposit');
      }
      if (booking.depositReleasedAt) throw invalidState('The deposit is already released');
      if (booking.status !== 'COMPLETED' && booking.status !== 'NO_SHOW') {
        throw invalidState('Release the deposit once the booking is marked used or not used');
      }
      const scope = this.scope(uow, access, meta);
      const line = depositLine(booking);
      const creditable = await this.charges.creditable(scope, booking.invoiceId, line);
      if (creditable < booking.depositMinor) {
        throw new ApiError(
          409,
          'DEPOSIT_PAID',
          'The deposit has been paid. Refund it through finance: release the payment, credit the deposit line, then refund.',
        );
      }
      await this.charges.credit(
        scope,
        booking.invoiceId,
        line,
        booking.depositMinor,
        `Deposit released for ${formatBookingNumber(booking.number)}`,
      );
      await uow.markDepositReleased(id);
      await this.auditBooking(uow, id, 'deposit_released', { byStaff: true });
      return this.bookingView(uow, id);
    });
  }

  // ------------------------------------------------------------------ shared

  /** Tells whoever booked what staff decided (in-app and email). */
  private async tellBooker(
    uow: FacilityUnitOfWork,
    access: OrganisationAccess,
    id: string,
    to: 'CONFIRMED' | 'REJECTED' | 'CANCELLED',
  ) {
    const b = await this.mustFindBooking(uow, id);
    if (b.bookedByUserId === access.userId) return;
    const number = formatBookingNumber(b.number);
    const [title, body] = {
      CONFIRMED: ['Booking approved', `${b.facilityName} booking ${number} is confirmed.`],
      REJECTED: [
        'Booking declined',
        `${b.facilityName} booking ${number} was declined: ${b.statusNote ?? ''}`.trim(),
      ],
      CANCELLED: [
        'Booking cancelled',
        `${b.facilityName} booking ${number} was cancelled: ${b.statusNote ?? ''}`.trim(),
      ],
    }[to];
    const property = access.propertyId as string;
    await this.notifications.notifyWithin(uow.transaction(), access.organisationId, [
      {
        userId: b.bookedByUserId,
        propertyId: property,
        kind: `facility.booking.${{ CONFIRMED: 'approved', REJECTED: 'rejected', CANCELLED: 'cancelled' }[to]}`,
        title: title as string,
        body: (body as string).slice(0, 2000),
        link: `/organisations/${access.organisationId}/properties/${property}/units/${b.unitId}/facilities`,
        urgent: false,
        email: true,
      },
    ]);
  }

  /** A confirmed booking with a fee or deposit is invoiced to its unit in the same transaction. */
  private async chargeIfConfirmed(
    uow: FacilityUnitOfWork,
    access: OrganisationAccess,
    meta: RequestMeta,
    id: string,
  ) {
    const b = await this.mustFindBooking(uow, id);
    if (b.status !== 'CONFIRMED' || b.invoiceId || b.feeMinor + b.depositMinor === 0n) return;
    const facility = await this.mustFindFacility(uow, b.facilityId);
    const number = formatBookingNumber(b.number);
    const lines: ChargeLine[] = [];
    if (b.feeMinor > 0n) {
      if (!facility.feeChargeTypeId) throw chargesGone();
      lines.push({
        chargeTypeId: facility.feeChargeTypeId,
        description: `${b.facilityName} booking ${number} (${b.slotCount} slot${b.slotCount === 1 ? '' : 's'})`,
        amountMinor: b.feeMinor,
      });
    }
    if (b.depositMinor > 0n) {
      if (!facility.depositChargeTypeId) throw chargesGone();
      lines.push({
        chargeTypeId: facility.depositChargeTypeId,
        description: `${b.facilityName} deposit ${number}`,
        amountMinor: b.depositMinor,
      });
    }
    const invoice = await this.charges.charge(this.scope(uow, access, meta), b.unitId, lines);
    await uow.setBookingInvoice(id, invoice.id);
    await this.auditBooking(uow, id, 'charged', { invoiceId: invoice.id });
  }

  /**
   * A cancelled booking's fee and deposit are credited back as far as they are unpaid; anything
   * paid stays with finance to refund. The deposit counts as released once credited in full.
   */
  private async creditOnCancel(
    uow: FacilityUnitOfWork,
    access: OrganisationAccess,
    meta: RequestMeta,
    id: string,
  ) {
    const b = await this.mustFindBooking(uow, id);
    if (!b.invoiceId) return;
    const scope = this.scope(uow, access, meta);
    const reason = `Booking ${formatBookingNumber(b.number)} cancelled`;
    let fee = 0n;
    if (b.feeMinor > 0n) fee = await this.charges.credit(scope, b.invoiceId, 1, b.feeMinor, reason);
    let deposit = 0n;
    if (b.depositMinor > 0n && !b.depositReleasedAt) {
      deposit = await this.charges.credit(
        scope,
        b.invoiceId,
        depositLine(b),
        b.depositMinor,
        reason,
      );
      if (deposit === b.depositMinor) await uow.markDepositReleased(id);
    }
    await this.auditBooking(uow, id, 'credited', {
      feeMinor: fee.toString(),
      depositMinor: deposit.toString(),
    });
  }

  /** A fee and deposit with their charge types (income and a liability), in minor units. */
  private async chargeSettings(
    uow: FacilityUnitOfWork,
    input: {
      feeChargeTypeId?: string | null | undefined;
      feePerSlot?: string | null | undefined;
      depositChargeTypeId?: string | null | undefined;
      deposit?: string | null | undefined;
    },
  ): Promise<Partial<FacilitySettings>> {
    const out: Partial<FacilitySettings> = {};
    const { currency } = await uow.property();
    const pairs = [
      ['fee', input.feeChargeTypeId, input.feePerSlot, 'INCOME'],
      ['deposit', input.depositChargeTypeId, input.deposit, 'LIABILITY'],
    ] as const;
    for (const [what, typeId, amount, accountType] of pairs) {
      if (typeId === undefined && amount === undefined) continue;
      if (((typeId ?? null) === null) !== ((amount ?? null) === null)) {
        throw new ApiError(
          422,
          'VALIDATION_FAILED',
          `Give the ${what} with its charge type, or neither`,
        );
      }
      let minor: bigint | null = null;
      if (typeId && amount) {
        const chargeType = await uow.chargeType(typeId);
        if (!chargeType) throw new ApiError(404, 'NOT_FOUND', 'Charge type not found');
        if (chargeType.status !== 'ACTIVE' || chargeType.accountType !== accountType) {
          throw new ApiError(
            422,
            'VALIDATION_FAILED',
            what === 'fee'
              ? 'Charge the fee through an active charge type that books to income'
              : 'Charge the deposit through an active charge type that books to a liability (deposits held)',
          );
        }
        minor = Money.parse(amount, currency).amountMinor;
        if (minor <= 0n) {
          throw new ApiError(422, 'VALIDATION_FAILED', `The ${what} must be more than zero`);
        }
      }
      if (what === 'fee') {
        out.feeChargeTypeId = typeId ?? null;
        out.feePerSlotMinor = minor;
      } else {
        out.depositChargeTypeId = typeId ?? null;
        out.depositMinor = minor;
      }
    }
    return out;
  }

  private scope(
    uow: FacilityUnitOfWork,
    access: OrganisationAccess,
    meta: RequestMeta,
  ): ChargeScope {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return {
      transaction: uow.transaction(),
      organisationId: access.organisationId,
      propertyId: access.propertyId,
      userId: access.userId,
      meta,
    };
  }

  private async place(uow: FacilityUnitOfWork) {
    const { timeZone, currency } = await uow.property();
    return { timeZone, currency };
  }

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
    return { facility, closures, timeZone: property.timeZone, currency: property.currency };
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
