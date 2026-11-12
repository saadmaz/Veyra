import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type { BookingStatus, FacilityStatus, OpeningRange } from '../domain/facility-rules';

export interface FacilitySettings {
  description: string | null;
  slotMinutes: number;
  capacity: number;
  approvalRequired: boolean;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  maxSlotsPerBooking: number;
  maxUpcomingPerUnit: number | null;
  cancellationMinutes: number;
  feeChargeTypeId: string | null;
  feePerSlotMinor: bigint | null;
  depositChargeTypeId: string | null;
  depositMinor: bigint | null;
}

export interface FacilityRecord extends FacilitySettings {
  id: string;
  commonAreaId: string;
  name: string;
  type: string;
  status: FacilityStatus;
  openingHours: OpeningRange[];
}

export interface ClosureRecord {
  id: string;
  facilityId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdAt: Date;
  liftedAt: Date | null;
}

export interface BookingRecord {
  id: string;
  number: bigint;
  facilityId: string;
  facilityName: string;
  unitId: string;
  unitNumber: string;
  startsAt: Date;
  endsAt: Date;
  slotCount: number;
  status: BookingStatus;
  statusNote: string | null;
  purpose: string | null;
  bookedByUserId: string;
  bookedByName: string;
  decidedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  /** The facility's cancellation window, for residents. */
  cancellationMinutes: number;
  /** What the booking costs, in the property's currency (minor units); 0 when free. */
  feeMinor: bigint;
  depositMinor: bigint;
  currency: string;
  invoiceId: string | null;
  depositReleasedAt: Date | null;
}

export interface BookingEventRecord {
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  note: string | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: Date;
}

/** One slot of a local day with the live bookings overlapping it. */
export interface SlotRecord {
  startsAt: Date;
  endsAt: Date;
  /** Local minutes after midnight of the start. */
  localMinutes: number;
  taken: number;
  closed: boolean;
}

export interface BookingFilter {
  unitId?: string;
  facilityId?: string;
  status?: BookingStatus;
  from?: Date;
  to?: Date;
}

export interface FacilityAuditEvent {
  action: string;
  resourceType: 'facility' | 'facility_booking' | 'facility_closure';
  resourceId: string;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * One transaction in the organisation's RLS context, limited to one property. Every query filters
 * by organisation and property explicitly as well.
 */
export interface FacilityUnitOfWork {
  property(): Promise<{
    timeZone: string;
    currency: string;
    status: 'ONBOARDING' | 'ACTIVE' | 'ARCHIVED';
  }>;
  /** The open transaction, for work other modules do in the same commit (finance charges). */
  transaction(): TransactionHandle;
  /** An active charge type of the property and whether it books to income or a liability. */
  chargeType(id: string): Promise<{ id: string; accountType: string; status: string } | null>;
  unit(id: string): Promise<{ id: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;
  commonArea(id: string): Promise<{ id: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;

  facilities(options: { activeOnly: boolean }): Promise<FacilityRecord[]>;
  /** With `lock`, holds the facility's lock (the one the database takes) until commit. */
  facility(id: string, options?: { lock?: boolean }): Promise<FacilityRecord | null>;
  facilityForArea(commonAreaId: string): Promise<{ id: string } | null>;
  createFacility(input: FacilitySettings & { commonAreaId: string }): Promise<string>;
  updateFacility(id: string, patch: Partial<FacilitySettings>): Promise<void>;
  replaceOpeningHours(id: string, ranges: readonly OpeningRange[]): Promise<void>;
  archiveFacility(id: string): Promise<void>;

  /** Not lifted and ending after `after`, soonest first. */
  closures(facilityId: string, after: Date): Promise<ClosureRecord[]>;
  closure(id: string): Promise<ClosureRecord | null>;
  createClosure(input: {
    facilityId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string;
  }): Promise<string>;
  liftClosure(id: string): Promise<void>;

  /** The slots of a facility's local day (property time zone) with what is taken. */
  slots(facilityId: string, date: string): Promise<SlotRecord[]>;

  bookings(filter: BookingFilter, limit: number): Promise<BookingRecord[]>;
  booking(id: string): Promise<BookingRecord | null>;
  createBooking(input: {
    facilityId: string;
    unitId: string;
    startsAt: Date;
    endsAt: Date;
    purpose: string | null;
  }): Promise<string>;
  setBookingStatus(id: string, status: BookingStatus, note: string | null): Promise<void>;
  setBookingInvoice(id: string, invoiceId: string): Promise<void>;
  markDepositReleased(id: string): Promise<void>;
  bookingEvents(id: string): Promise<BookingEventRecord[]>;

  audit(event: FacilityAuditEvent): Promise<void>;
}

export interface FacilityRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: FacilityUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const FACILITY_REPOSITORY = Symbol('FACILITY_REPOSITORY');
