import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  DateRange,
  ReportingReader,
  ReportingRepository,
} from '../application/reporting-ports';

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const big = (v: bigint | number | string | null | undefined) => BigInt(v ?? 0);
const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/*
 * Aggregate queries for dashboards. Every query filters by property; RLS adds the organisation.
 * Parameters are bound by Prisma's tagged template (no string building).
 */
class PrismaReportingReader implements ReportingReader {
  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {}

  async today() {
    const rows = await this.tx.$queryRaw<{ today: string }[]>`
      SELECT to_char((now() AT TIME ZONE "time_zone")::date, 'YYYY-MM-DD') AS today
        FROM "properties" WHERE "id" = ${this.propertyId}::uuid`;
    const today = rows[0]?.today;
    if (!today) throw new Error('Property vanished inside its own transaction');
    return today;
  }

  async occupancy(today: string) {
    const [row] = await this.tx.$queryRaw<{ units: bigint; owned: bigint; tenanted: bigint }[]>`
      SELECT count(*) AS units,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "ownerships" o
                WHERE o."unit_id" = u."id" AND o."voided_at" IS NULL
                  AND o."effective_from" <= ${today}::date
                  AND (o."effective_to" IS NULL OR o."effective_to" >= ${today}::date))) AS owned,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "tenancies" t
                WHERE t."unit_id" = u."id" AND t."voided_at" IS NULL
                  AND t."start_date" <= ${today}::date
                  AND (t."end_date" IS NULL OR t."end_date" >= ${today}::date))) AS tenanted
        FROM "units" u
       WHERE u."property_id" = ${this.propertyId}::uuid AND u."status" = 'ACTIVE'`;
    return { units: n(row?.units), withOwner: n(row?.owned), tenanted: n(row?.tenanted) };
  }

  async finance(today: string) {
    const [row] = await this.tx.$queryRaw<
      {
        currency: string;
        outstanding: bigint;
        overdue: bigint;
        overdue_count: bigint;
        collected: bigint;
      }[]
    >`
      WITH open_invoices AS (
        SELECT i."due_date",
               i."total_minor"
                 - coalesce((SELECT sum(a."amount_minor") FROM "payment_allocations" a
                              WHERE a."invoice_id" = i."id" AND a."released_at" IS NULL), 0)
                 - coalesce((SELECT sum(c."amount_minor") FROM "invoice_credits" c
                              WHERE c."invoice_id" = i."id"), 0) AS owed
          FROM "invoices" i
         WHERE i."property_id" = ${this.propertyId}::uuid AND i."status" = 'ISSUED'
      )
      SELECT p."currency",
             coalesce((SELECT sum("owed") FROM open_invoices WHERE "owed" > 0), 0)::bigint AS outstanding,
             coalesce((SELECT sum("owed") FROM open_invoices WHERE "owed" > 0 AND "due_date" < ${today}::date), 0)::bigint AS overdue,
             (SELECT count(*) FROM open_invoices WHERE "owed" > 0 AND "due_date" < ${today}::date) AS overdue_count,
             coalesce((SELECT sum(pm."amount_minor") FROM "payments" pm
                        WHERE pm."property_id" = p."id"
                          AND pm."received_on" > ${today}::date - 30
                          AND NOT EXISTS (SELECT 1 FROM "payment_reversals" r WHERE r."payment_id" = pm."id")), 0)::bigint AS collected
        FROM "properties" p
       WHERE p."id" = ${this.propertyId}::uuid`;
    return {
      currency: (row?.currency ?? '').trim(),
      outstandingMinor: big(row?.outstanding),
      overdueMinor: big(row?.overdue),
      overdueInvoices: n(row?.overdue_count),
      collectedLast30DaysMinor: big(row?.collected),
    };
  }

  async maintenance() {
    const [row] = await this.tx.$queryRaw<{ open: bigint; overdue: bigint; work: bigint }[]>`
      SELECT (SELECT count(*) FROM "maintenance_requests"
               WHERE "property_id" = ${this.propertyId}::uuid AND "status" IN ('SUBMITTED', 'ACCEPTED')) AS open,
             (SELECT count(*) FROM "maintenance_requests"
               WHERE "property_id" = ${this.propertyId}::uuid AND "status" IN ('SUBMITTED', 'ACCEPTED')
                 AND "resolution_due_at" < now()) AS overdue,
             (SELECT count(*) FROM "work_orders"
               WHERE "property_id" = ${this.propertyId}::uuid
                 AND "status" IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD')) AS work`;
    return {
      openRequests: n(row?.open),
      overdueRequests: n(row?.overdue),
      openWorkOrders: n(row?.work),
    };
  }

  async visitors(today: string) {
    const [row] = await this.tx.$queryRaw<{ today: bigint; on_site: bigint; week: bigint }[]>`
      WITH local AS (
        SELECT v."arrived_at", v."departed_at",
               (v."arrived_at" AT TIME ZONE p."time_zone")::date AS day
          FROM "visits" v JOIN "properties" p ON p."id" = v."property_id"
         WHERE v."property_id" = ${this.propertyId}::uuid
           AND v."arrived_at" > now() - interval '8 days'
      )
      SELECT count(*) FILTER (WHERE day = ${today}::date) AS today,
             count(*) FILTER (WHERE "departed_at" IS NULL AND day = ${today}::date) AS on_site,
             count(*) FILTER (WHERE day > ${today}::date - 7) AS week
        FROM local`;
    return { arrivedToday: n(row?.today), onSiteNow: n(row?.on_site), last7Days: n(row?.week) };
  }

  async facilities() {
    const [row] = await this.tx.$queryRaw<{ upcoming: bigint; pending: bigint }[]>`
      SELECT count(*) FILTER (WHERE "status" = 'CONFIRMED' AND "starts_at" >= now()
                                AND "starts_at" < now() + interval '7 days') AS upcoming,
             count(*) FILTER (WHERE "status" = 'PENDING' AND "starts_at" >= now()) AS pending
        FROM "facility_bookings"
       WHERE "property_id" = ${this.propertyId}::uuid`;
    return { bookingsNext7Days: n(row?.upcoming), awaitingApproval: n(row?.pending) };
  }

  async incidents(includeSensitive: boolean) {
    const [row] = await this.tx.$queryRaw<{ open: bigint; serious: bigint }[]>`
      SELECT count(*) AS open,
             count(*) FILTER (WHERE "severity" IN ('HIGH', 'CRITICAL')) AS serious
        FROM "incidents"
       WHERE "property_id" = ${this.propertyId}::uuid AND "status" <> 'CLOSED'
         AND (${includeSensitive} OR NOT "sensitive")`;
    return { open: n(row?.open), openHighOrCritical: n(row?.serious) };
  }

  async property() {
    const [row] = await this.tx.$queryRaw<{ code: string; currency: string; time_zone: string }[]>`
      SELECT "code", "currency", "time_zone" FROM "properties" WHERE "id" = ${this.propertyId}::uuid`;
    if (!row) throw new Error('Property vanished inside its own transaction');
    return { code: row.code, currency: row.currency.trim(), timeZone: row.time_zone };
  }

  async occupancyByBuilding(today: string) {
    const rows = await this.tx.$queryRaw<
      { building: string | null; units: bigint; tenanted: bigint; owned: bigint }[]
    >`
      SELECT b."name" AS building, count(*) AS units,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "tenancies" t
                WHERE t."unit_id" = u."id" AND t."voided_at" IS NULL
                  AND t."start_date" <= ${today}::date
                  AND (t."end_date" IS NULL OR t."end_date" >= ${today}::date))) AS tenanted,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "ownerships" o
                WHERE o."unit_id" = u."id" AND o."voided_at" IS NULL
                  AND o."effective_from" <= ${today}::date
                  AND (o."effective_to" IS NULL OR o."effective_to" >= ${today}::date))) AS owned
        FROM "units" u LEFT JOIN "buildings" b ON b."id" = u."building_id"
       WHERE u."property_id" = ${this.propertyId}::uuid AND u."status" = 'ACTIVE'
       GROUP BY b."name"
       ORDER BY b."name" NULLS LAST`;
    return rows.map((r) => ({
      building: r.building,
      units: n(r.units),
      tenanted: n(r.tenanted),
      withOwner: n(r.owned),
    }));
  }

  async arrears(today: string) {
    const rows = await this.tx.$queryRaw<
      { unit: string; outstanding: bigint; overdue: bigint; oldest: string }[]
    >`
      WITH owed AS (
        SELECT i."unit_id", i."due_date",
               i."total_minor"
                 - coalesce((SELECT sum(a."amount_minor") FROM "payment_allocations" a
                              WHERE a."invoice_id" = i."id" AND a."released_at" IS NULL), 0)
                 - coalesce((SELECT sum(c."amount_minor") FROM "invoice_credits" c
                              WHERE c."invoice_id" = i."id"), 0) AS amount
          FROM "invoices" i
         WHERE i."property_id" = ${this.propertyId}::uuid AND i."status" = 'ISSUED'
      )
      SELECT u."number" AS unit,
             sum(o."amount")::bigint AS outstanding,
             coalesce(sum(o."amount") FILTER (WHERE o."due_date" < ${today}::date), 0)::bigint AS overdue,
             to_char(min(o."due_date"), 'YYYY-MM-DD') AS oldest
        FROM owed o JOIN "units" u ON u."id" = o."unit_id"
       WHERE o."amount" > 0
       GROUP BY u."number"
       ORDER BY u."number"`;
    return rows.map((r) => ({
      unit: r.unit,
      outstandingMinor: big(r.outstanding),
      overdueMinor: big(r.overdue),
      oldestDue: r.oldest,
    }));
  }

  async maintenanceRequests(range: DateRange, limit: number) {
    const rows = await this.tx.$queryRaw<
      {
        number: bigint;
        category: string;
        priority: string;
        status: string;
        place: string | null;
        created_at: Date;
        resolution_due_at: Date | null;
        resolved_at: Date | null;
        overdue: boolean;
      }[]
    >`
      SELECT r."request_number" AS number, r."category"::text, r."priority"::text, r."status"::text,
             coalesce(u."number", a."name") AS place, r."created_at", r."resolution_due_at",
             r."resolved_at", (r."resolution_breached_at" IS NOT NULL) AS overdue
        FROM "maintenance_requests" r
        JOIN "properties" p ON p."id" = r."property_id"
        LEFT JOIN "units" u ON u."id" = r."unit_id"
        LEFT JOIN "common_areas" a ON a."id" = r."common_area_id"
       WHERE r."property_id" = ${this.propertyId}::uuid
         AND (r."created_at" AT TIME ZONE p."time_zone")::date BETWEEN ${range.from}::date AND ${range.to}::date
       ORDER BY r."created_at"
       LIMIT ${limit}`;
    return rows.map((r) => ({
      number: n(r.number),
      category: r.category,
      priority: r.priority,
      status: r.status,
      place: r.place,
      createdAt: r.created_at,
      resolutionDueAt: r.resolution_due_at,
      resolvedAt: r.resolved_at,
      overdue: r.overdue,
    }));
  }

  async visits(range: DateRange, limit: number) {
    const rows = await this.tx.$queryRaw<
      {
        arrived_at: Date;
        departed_at: Date | null;
        unit: string | null;
        category: string;
        decision: string;
        gate: string | null;
      }[]
    >`
      SELECT v."arrived_at", v."departed_at", u."number" AS unit, v."category"::text,
             v."decision"::text, v."gate"
        FROM "visits" v
        JOIN "properties" p ON p."id" = v."property_id"
        LEFT JOIN "units" u ON u."id" = v."unit_id"
       WHERE v."property_id" = ${this.propertyId}::uuid
         AND (v."arrived_at" AT TIME ZONE p."time_zone")::date BETWEEN ${range.from}::date AND ${range.to}::date
       ORDER BY v."arrived_at"
       LIMIT ${limit}`;
    return rows.map((r) => ({
      arrivedAt: r.arrived_at,
      departedAt: r.departed_at,
      unit: r.unit,
      category: r.category,
      decision: r.decision,
      gate: r.gate,
    }));
  }

  async incidentList(range: DateRange, includeSensitive: boolean, limit: number) {
    const rows = await this.tx.$queryRaw<
      {
        number: bigint;
        category: string;
        severity: string;
        status: string;
        occurred_at: Date;
        resolved_at: Date | null;
        closed_at: Date | null;
      }[]
    >`
      SELECT i."incident_number" AS number, i."category"::text, i."severity"::text,
             i."status"::text, i."occurred_at", i."resolved_at", i."closed_at"
        FROM "incidents" i
        JOIN "properties" p ON p."id" = i."property_id"
       WHERE i."property_id" = ${this.propertyId}::uuid
         AND (${includeSensitive} OR NOT i."sensitive")
         AND (i."occurred_at" AT TIME ZONE p."time_zone")::date BETWEEN ${range.from}::date AND ${range.to}::date
       ORDER BY i."occurred_at"
       LIMIT ${limit}`;
    return rows.map((r) => ({
      number: n(r.number),
      category: r.category,
      severity: r.severity,
      status: r.status,
      occurredAt: r.occurred_at,
      resolvedAt: r.resolved_at,
      closedAt: r.closed_at,
    }));
  }

  async audit(event: { action: string; metadata: Record<string, string | number | boolean> }) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: 'property',
          resourceId: this.propertyId,
          metadata: { propertyId: this.propertyId, ...event.metadata },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }

  async pendingApprovals() {
    const [row] = await this.tx.$queryRaw<{ pending: bigint }[]>`
      SELECT count(*) AS pending FROM "approval_requests"
       WHERE "property_id" = ${this.propertyId}::uuid AND "status" = 'PENDING'`;
    return n(row?.pending);
  }
}

/** Dashboard reads over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaReportingRepository implements ReportingRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (reader: ReportingReader) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaReportingReader(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}
