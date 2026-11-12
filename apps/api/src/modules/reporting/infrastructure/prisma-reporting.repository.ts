import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type { ReportingReader, ReportingRepository } from '../application/reporting-ports';

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const big = (v: bigint | number | string | null | undefined) => BigInt(v ?? 0);

/*
 * Aggregate queries for dashboards. Every query filters by property; RLS adds the organisation.
 * Parameters are bound by Prisma's tagged template (no string building).
 */
class PrismaReportingReader implements ReportingReader {
  constructor(
    private readonly tx: DbTransaction,
    private readonly propertyId: string,
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
    _meta: RequestMeta,
    work: (reader: ReportingReader) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaReportingReader(tx, propertyId)),
      { userId },
    );
  }
}
