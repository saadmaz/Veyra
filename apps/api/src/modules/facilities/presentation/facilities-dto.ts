import type {
  FacilityAvailabilityDto,
  FacilityBookingDetailDto,
  FacilityBookingDto,
  FacilityClosureDto,
  FacilityDetailDto,
  FacilityDto,
} from '@veyra/api-contracts';
import type { Slot } from '../application/facilities.service';
import type {
  BookingEventRecord,
  BookingRecord,
  ClosureRecord,
  FacilityRecord,
} from '../application/facility-ports';
import { formatBookingNumber, residentMayCancel, timeOf } from '../domain/facility-rules';

const money = (amountMinor: bigint, currency: string) => ({
  amountMinor: amountMinor.toString(),
  currency,
});

export const toFacility = (f: FacilityRecord, timeZone: string, currency: string): FacilityDto => ({
  id: f.id,
  commonAreaId: f.commonAreaId,
  name: f.name,
  type: f.type,
  description: f.description,
  status: f.status,
  slotMinutes: f.slotMinutes,
  capacity: f.capacity,
  approvalRequired: f.approvalRequired,
  minNoticeMinutes: f.minNoticeMinutes,
  maxAdvanceDays: f.maxAdvanceDays,
  maxSlotsPerBooking: f.maxSlotsPerBooking,
  maxUpcomingPerUnit: f.maxUpcomingPerUnit,
  cancellationMinutes: f.cancellationMinutes,
  openingHours: f.openingHours,
  timeZone,
  fee:
    f.feeChargeTypeId && f.feePerSlotMinor !== null
      ? { chargeTypeId: f.feeChargeTypeId, perSlot: money(f.feePerSlotMinor, currency) }
      : null,
  deposit:
    f.depositChargeTypeId && f.depositMinor !== null
      ? { chargeTypeId: f.depositChargeTypeId, amount: money(f.depositMinor, currency) }
      : null,
});

export const toClosure = (c: ClosureRecord): FacilityClosureDto => ({
  id: c.id,
  startsAt: c.startsAt.toISOString(),
  endsAt: c.endsAt.toISOString(),
  reason: c.reason,
  createdAt: c.createdAt.toISOString(),
  liftedAt: c.liftedAt?.toISOString() ?? null,
});

export const toFacilityDetail = (d: {
  facility: FacilityRecord;
  closures: ClosureRecord[];
  timeZone: string;
  currency: string;
}): FacilityDetailDto => ({
  facility: toFacility(d.facility, d.timeZone, d.currency),
  closures: d.closures.map(toClosure),
});

export const toAvailability = (a: {
  facility: FacilityRecord;
  date: string;
  timeZone: string;
  slots: Slot[];
}): FacilityAvailabilityDto => ({
  facilityId: a.facility.id,
  date: a.date,
  timeZone: a.timeZone,
  slotMinutes: a.facility.slotMinutes,
  slots: a.slots.map((s) => ({
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    time: timeOf(s.localMinutes),
    available: s.available,
    state: s.state,
  })),
});

export const toBooking = (b: BookingRecord, now = new Date()): FacilityBookingDto => ({
  id: b.id,
  number: formatBookingNumber(b.number),
  facilityId: b.facilityId,
  facilityName: b.facilityName,
  unitId: b.unitId,
  unitNumber: b.unitNumber,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt.toISOString(),
  slotCount: b.slotCount,
  status: b.status,
  statusNote: b.statusNote,
  purpose: b.purpose,
  bookedBy: { userId: b.bookedByUserId, name: b.bookedByName },
  decidedAt: b.decidedAt?.toISOString() ?? null,
  cancelledAt: b.cancelledAt?.toISOString() ?? null,
  createdAt: b.createdAt.toISOString(),
  fee: money(b.feeMinor, b.currency),
  deposit: money(b.depositMinor, b.currency),
  invoiceId: b.invoiceId,
  depositReleasedAt: b.depositReleasedAt?.toISOString() ?? null,
  cancellable:
    (b.status === 'PENDING' || b.status === 'CONFIRMED') &&
    residentMayCancel(b.startsAt, b.cancellationMinutes, now),
});

const toEvent = (e: BookingEventRecord) => ({
  fromStatus: e.fromStatus,
  toStatus: e.toStatus,
  note: e.note,
  actor: e.actorUserId ? { userId: e.actorUserId, name: e.actorName ?? '' } : null,
  createdAt: e.createdAt.toISOString(),
});

export const toBookingDetail = (d: {
  booking: BookingRecord;
  events: BookingEventRecord[];
}): FacilityBookingDetailDto => ({
  booking: toBooking(d.booking),
  events: d.events.map(toEvent),
});
