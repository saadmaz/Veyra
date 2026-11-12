import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type {
  BookingEventRecord,
  BookingFilter,
  BookingRecord,
  ClosureRecord,
  FacilityAuditEvent,
  FacilityRecord,
  FacilityRepository,
  FacilitySettings,
  FacilityUnitOfWork,
  SlotRecord,
} from '../application/facility-ports';
import type { BookingStatus, OpeningRange } from '../domain/facility-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const FACILITY_SELECT = {
  id: true,
  commonAreaId: true,
  description: true,
  status: true,
  slotMinutes: true,
  capacity: true,
  approvalRequired: true,
  minNoticeMinutes: true,
  maxAdvanceDays: true,
  maxSlotsPerBooking: true,
  maxUpcomingPerUnit: true,
  cancellationMinutes: true,
  feeChargeTypeId: true,
  feePerSlotMinor: true,
  depositChargeTypeId: true,
  depositMinor: true,
  commonArea: { select: { name: true, type: true } },
} as const;

const BOOKING_SELECT = {
  id: true,
  bookingNumber: true,
  facilityId: true,
  unitId: true,
  startsAt: true,
  endsAt: true,
  slotCount: true,
  status: true,
  statusNote: true,
  purpose: true,
  bookedByUserId: true,
  decidedAt: true,
  cancelledAt: true,
  createdAt: true,
  feeMinor: true,
  depositMinor: true,
  invoiceId: true,
  depositReleasedAt: true,
  property: { select: { currency: true } },
  bookedBy: { select: { displayName: true } },
  unit: { select: { number: true } },
  facility: { select: { cancellationMinutes: true, commonArea: { select: { name: true } } } },
} as const;

interface BookingRow {
  id: string;
  bookingNumber: bigint | null;
  facilityId: string;
  unitId: string;
  startsAt: Date;
  endsAt: Date;
  slotCount: number;
  status: BookingStatus;
  statusNote: string | null;
  purpose: string | null;
  bookedByUserId: string;
  decidedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  feeMinor: bigint;
  depositMinor: bigint;
  invoiceId: string | null;
  depositReleasedAt: Date | null;
  property: { currency: string };
  bookedBy: { displayName: string };
  unit: { number: string };
  facility: { cancellationMinutes: number; commonArea: { name: string } };
}

const toBooking = (row: BookingRow): BookingRecord => ({
  id: row.id,
  number: row.bookingNumber ?? 0n,
  facilityId: row.facilityId,
  facilityName: row.facility.commonArea.name,
  unitId: row.unitId,
  unitNumber: row.unit.number,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  slotCount: row.slotCount,
  status: row.status,
  statusNote: row.statusNote,
  purpose: row.purpose,
  bookedByUserId: row.bookedByUserId,
  bookedByName: row.bookedBy.displayName,
  decidedAt: row.decidedAt,
  cancelledAt: row.cancelledAt,
  createdAt: row.createdAt,
  cancellationMinutes: row.facility.cancellationMinutes,
  feeMinor: row.feeMinor,
  depositMinor: row.depositMinor,
  currency: row.property.currency.trim(),
  invoiceId: row.invoiceId,
  depositReleasedAt: row.depositReleasedAt,
});

const toClosure = (row: ClosureRecord): ClosureRecord => ({
  id: row.id,
  facilityId: row.facilityId,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  reason: row.reason,
  createdAt: row.createdAt,
  liftedAt: row.liftedAt,
});

class PrismaFacilityUnitOfWork implements FacilityUnitOfWork {
  private readonly scope: { organisationId: string; propertyId: string };

  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {
    this.scope = { organisationId, propertyId };
  }

  async property() {
    const row = await this.tx.property.findFirst({
      where: { id: this.propertyId, organisationId: this.organisationId },
      select: { timeZone: true, currency: true, status: true },
    });
    if (!row) throw new Error('Property vanished inside its own transaction');
    return { ...row, currency: row.currency.trim() };
  }

  transaction(): TransactionHandle {
    return this.tx as unknown as TransactionHandle;
  }

  async chargeType(id: string) {
    const row = await this.tx.chargeType.findFirst({
      where: { ...this.scope, id },
      select: { id: true, status: true, incomeAccount: { select: { type: true } } },
    });
    return row ? { id: row.id, status: row.status, accountType: row.incomeAccount.type } : null;
  }

  unit(id: string) {
    return this.tx.unit.findFirst({
      where: { ...this.scope, id },
      select: { id: true, status: true },
    });
  }

  commonArea(id: string) {
    return this.tx.commonArea.findFirst({
      where: { ...this.scope, id },
      select: { id: true, status: true },
    });
  }

  private async hours(facilityIds: string[]): Promise<Map<string, OpeningRange[]>> {
    const map = new Map<string, OpeningRange[]>();
    if (facilityIds.length === 0) return map;
    const rows = await this.tx.$queryRaw<
      { facility_id: string; weekday: number; opens_at: string; closes_at: string }[]
    >`
      SELECT "facility_id"::text, "weekday", to_char("opens_at", 'HH24:MI') AS opens_at,
             to_char("closes_at", 'HH24:MI') AS closes_at
        FROM "facility_opening_hours"
       WHERE "organisation_id" = ${this.organisationId}::uuid AND "property_id" = ${this.propertyId}::uuid
         AND "facility_id" = ANY(${facilityIds}::uuid[])
       ORDER BY "weekday", "opens_at"`;
    for (const r of rows) {
      const list = map.get(r.facility_id) ?? [];
      list.push({ weekday: r.weekday, opensAt: r.opens_at, closesAt: r.closes_at });
      map.set(r.facility_id, list);
    }
    return map;
  }

  private async withHours(
    rows: {
      id: string;
      commonAreaId: string;
      description: string | null;
      status: 'ACTIVE' | 'ARCHIVED';
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
      commonArea: { name: string; type: string };
    }[],
  ): Promise<FacilityRecord[]> {
    const hours = await this.hours(rows.map((r) => r.id));
    return rows.map(({ commonArea, ...r }) => ({
      ...r,
      name: commonArea.name,
      type: commonArea.type,
      openingHours: hours.get(r.id) ?? [],
    }));
  }

  async facilities(options: { activeOnly: boolean }) {
    const rows = await this.tx.facility.findMany({
      where: { ...this.scope, ...(options.activeOnly ? { status: 'ACTIVE' as const } : {}) },
      select: FACILITY_SELECT,
      orderBy: { commonArea: { name: 'asc' } },
    });
    return this.withHours(rows);
  }

  async facility(id: string, options: { lock?: boolean } = {}) {
    if (options.lock) await this.tx.$executeRaw`SELECT app_facility_lock(${id}::uuid)`;
    const row = await this.tx.facility.findFirst({
      where: { ...this.scope, id },
      select: FACILITY_SELECT,
    });
    if (!row) return null;
    return (await this.withHours([row]))[0] ?? null;
  }

  facilityForArea(commonAreaId: string) {
    return this.tx.facility.findFirst({
      where: { ...this.scope, commonAreaId },
      select: { id: true },
    });
  }

  async createFacility(input: FacilitySettings & { commonAreaId: string }) {
    const { id } = await this.tx.facility.create({
      data: { ...this.scope, ...input },
      select: { id: true },
    });
    return id;
  }

  async updateFacility(id: string, patch: Partial<FacilitySettings>) {
    await this.tx.facility.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  async replaceOpeningHours(id: string, ranges: readonly OpeningRange[]) {
    await this.tx.facilityOpeningHours.deleteMany({ where: { ...this.scope, facilityId: id } });
    for (const r of ranges) {
      await this.tx.$executeRaw`
        INSERT INTO "facility_opening_hours" ("id", "organisation_id", "property_id", "facility_id",
                                              "weekday", "opens_at", "closes_at")
        VALUES (gen_random_uuid(), ${this.organisationId}::uuid, ${this.propertyId}::uuid, ${id}::uuid,
                ${r.weekday}, ${r.opensAt}::time, ${r.closesAt}::time)`;
    }
  }

  async archiveFacility(id: string) {
    await this.tx.facility.updateMany({
      where: { ...this.scope, id },
      data: { status: 'ARCHIVED' },
    });
  }

  async closures(facilityId: string, after: Date) {
    const rows = await this.tx.facilityClosure.findMany({
      where: { ...this.scope, facilityId, liftedAt: null, endsAt: { gt: after } },
      orderBy: { startsAt: 'asc' },
      take: 200,
    });
    return rows.map(toClosure);
  }

  async closure(id: string) {
    const row = await this.tx.facilityClosure.findFirst({ where: { ...this.scope, id } });
    return row ? toClosure(row) : null;
  }

  async createClosure(input: { facilityId: string; startsAt: Date; endsAt: Date; reason: string }) {
    const { id } = await this.tx.facilityClosure.create({
      data: { ...this.scope, ...input, createdByUserId: this.userId },
      select: { id: true },
    });
    return id;
  }

  async liftClosure(id: string) {
    await this.tx.facilityClosure.updateMany({
      where: { ...this.scope, id },
      data: { liftedByUserId: this.userId },
    });
  }

  async slots(facilityId: string, date: string): Promise<SlotRecord[]> {
    const rows = await this.tx.$queryRaw<
      { starts_at: Date; ends_at: Date; local_minutes: number; taken: number; closed: boolean }[]
    >`
      WITH f AS (
        SELECT f."id", f."slot_minutes", p."time_zone"
          FROM "facilities" f JOIN "properties" p ON p."id" = f."property_id"
         WHERE f."id" = ${facilityId}::uuid AND f."organisation_id" = ${this.organisationId}::uuid
           AND f."property_id" = ${this.propertyId}::uuid
      ), s AS (
        SELECT (${date}::date + h."opens_at" + make_interval(mins => n * f."slot_minutes")) AS local_start,
               (${date}::date + h."opens_at" + make_interval(mins => (n + 1) * f."slot_minutes")) AS local_end,
               f."time_zone"
          FROM f JOIN "facility_opening_hours" h ON h."facility_id" = f."id"
               CROSS JOIN LATERAL generate_series(
                 0, (extract(epoch FROM h."closes_at" - h."opens_at") / 60 / f."slot_minutes")::int - 1) n
         WHERE h."weekday" = extract(isodow FROM ${date}::date)
           AND (extract(epoch FROM h."closes_at" - h."opens_at") / 60)::int >= f."slot_minutes"
      )
      SELECT (s.local_start AT TIME ZONE s."time_zone") AS starts_at,
             (s.local_end AT TIME ZONE s."time_zone") AS ends_at,
             (extract(epoch FROM s.local_start - ${date}::date) / 60)::int AS local_minutes,
             (SELECT count(*) FROM "facility_bookings" b
               WHERE b."facility_id" = ${facilityId}::uuid AND b."status" IN ('PENDING', 'CONFIRMED')
                 AND b."starts_at" < (s.local_end AT TIME ZONE s."time_zone")
                 AND b."ends_at" > (s.local_start AT TIME ZONE s."time_zone"))::int AS taken,
             EXISTS (SELECT 1 FROM "facility_closures" c
                      WHERE c."facility_id" = ${facilityId}::uuid AND c."lifted_at" IS NULL
                        AND c."starts_at" < (s.local_end AT TIME ZONE s."time_zone")
                        AND c."ends_at" > (s.local_start AT TIME ZONE s."time_zone")) AS closed
        FROM s
       ORDER BY s.local_start`;
    return rows.map((r) => ({
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      localMinutes: r.local_minutes,
      taken: r.taken,
      closed: r.closed,
    }));
  }

  async bookings(filter: BookingFilter, limit: number) {
    const rows = await this.tx.facilityBooking.findMany({
      where: {
        ...this.scope,
        ...(filter.unitId ? { unitId: filter.unitId } : {}),
        ...(filter.facilityId ? { facilityId: filter.facilityId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? {
              startsAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lt: filter.to } : {}),
              },
            }
          : {}),
      },
      select: BOOKING_SELECT,
      orderBy: [{ startsAt: 'desc' }, { bookingNumber: 'desc' }],
      take: limit,
    });
    return rows.map(toBooking);
  }

  async booking(id: string) {
    const row = await this.tx.facilityBooking.findFirst({
      where: { ...this.scope, id },
      select: BOOKING_SELECT,
    });
    return row ? toBooking(row) : null;
  }

  async createBooking(input: {
    facilityId: string;
    unitId: string;
    startsAt: Date;
    endsAt: Date;
    purpose: string | null;
  }) {
    const { id } = await this.tx.facilityBooking.create({
      data: { ...this.scope, ...input, bookedByUserId: this.userId },
      select: { id: true },
    });
    return id;
  }

  async setBookingStatus(id: string, status: BookingStatus, note: string | null) {
    await this.tx.facilityBooking.updateMany({
      where: { ...this.scope, id },
      data: { status, statusNote: note },
    });
  }

  async setBookingInvoice(id: string, invoiceId: string) {
    await this.tx.facilityBooking.updateMany({ where: { ...this.scope, id }, data: { invoiceId } });
  }

  async markDepositReleased(id: string) {
    await this.tx.facilityBooking.updateMany({
      where: { ...this.scope, id },
      data: { depositReleasedAt: new Date() },
    });
  }

  async bookingEvents(id: string): Promise<BookingEventRecord[]> {
    const rows = await this.tx.facilityBookingEvent.findMany({
      where: { ...this.scope, bookingId: id },
      orderBy: { sequence: 'asc' },
      select: {
        fromStatus: true,
        toStatus: true,
        note: true,
        actorUserId: true,
        createdAt: true,
        actor: { select: { displayName: true } },
      },
    });
    return rows.map(({ actor, ...r }) => ({ ...r, actorName: actor?.displayName ?? null }));
  }

  async audit(event: FacilityAuditEvent): Promise<void> {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: { propertyId: this.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Facility persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaFacilityRepository implements FacilityRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: FacilityUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaFacilityUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}
