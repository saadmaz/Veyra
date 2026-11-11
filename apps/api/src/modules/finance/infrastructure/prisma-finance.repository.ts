import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  type DbTransaction,
  databaseErrorCode,
  isUniqueViolation,
  withTenantTransaction,
} from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import {
  AlreadyBilled,
  type ChargeTypeRecord,
  type FinanceAuditEvent,
  type FinanceRepository,
  type FinanceUnitOfWork,
  type InvoiceDetailRecord,
  type InvoiceRecord,
  type LedgerAccountRecord,
  type NewInvoice,
  type NewLedgerLine,
  type PeriodState,
  type PropertyFinanceInfo,
  type RecurringChargeRecord,
  type UnitForBilling,
} from '../application/finance-ports';
import {
  type AccountDefinition,
  type CreateChargeTypeInput,
  type InvoiceListQuery,
  type IsoDate,
  monthBounds,
  type UnitParties,
} from '../domain/finance-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));
/** Calendar dates travel as UTC midnight (connections pin TimeZone=UTC). */
const toDate = (iso: IsoDate) => new Date(`${iso}T00:00:00Z`);
const toIso = (date: Date) => date.toISOString().slice(0, 10);
const toIsoOrNull = (date: Date | null) => (date === null ? null : toIso(date));

/** UUID v7 (time-ordered, like Prisma's ids) for the one row inserted with raw SQL. */
function uuidV7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CHARGE_TYPE_SELECT = {
  id: true,
  code: true,
  name: true,
  liableParty: true,
  incomeAccountId: true,
  status: true,
} as const;

const RECURRING_SELECT = {
  id: true,
  unitId: true,
  chargeTypeId: true,
  basis: true,
  amountMinor: true,
  startMonth: true,
  endMonth: true,
  unit: { select: { number: true } },
  chargeType: { select: { code: true, name: true, liableParty: true } },
  property: { select: { currency: true } },
} as const;

type RecurringRow = {
  id: string;
  unitId: string | null;
  chargeTypeId: string;
  basis: RecurringChargeRecord['basis'];
  amountMinor: bigint;
  startMonth: Date;
  endMonth: Date | null;
  unit: { number: string } | null;
  chargeType: { code: string; name: string; liableParty: RecurringChargeRecord['liableParty'] };
  property: { currency: string };
};

const toRecurring = (row: RecurringRow): RecurringChargeRecord => ({
  id: row.id,
  unitId: row.unitId,
  unitNumber: row.unit?.number ?? null,
  chargeTypeId: row.chargeTypeId,
  chargeTypeCode: row.chargeType.code,
  chargeTypeName: row.chargeType.name,
  liableParty: row.chargeType.liableParty,
  basis: row.basis,
  amountMinor: row.amountMinor,
  currency: row.property.currency.trim(),
  startMonth: toIso(row.startMonth),
  endMonth: toIsoOrNull(row.endMonth),
});

const INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  status: true,
  unitId: true,
  billTo: true,
  billingMonth: true,
  billingDate: true,
  dueDate: true,
  issueDate: true,
  currency: true,
  totalMinor: true,
  journalEntryId: true,
  createdAt: true,
  issuedAt: true,
  unit: { select: { number: true } },
  recipients: {
    select: {
      personId: true,
      shareNumerator: true,
      shareDenominator: true,
      person: { select: { fullName: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

type InvoiceRow = {
  id: string;
  invoiceNumber: bigint | null;
  status: InvoiceRecord['status'];
  unitId: string;
  billTo: InvoiceRecord['billTo'];
  billingMonth: Date | null;
  billingDate: Date;
  dueDate: Date;
  issueDate: Date | null;
  currency: string;
  totalMinor: bigint;
  journalEntryId: string | null;
  createdAt: Date;
  issuedAt: Date | null;
  unit: { number: string };
  recipients: {
    personId: string;
    shareNumerator: number | null;
    shareDenominator: number | null;
    person: { fullName: string };
  }[];
};

const toInvoice = (row: InvoiceRow): InvoiceRecord => ({
  id: row.id,
  invoiceNumber: row.invoiceNumber,
  status: row.status,
  unitId: row.unitId,
  unitNumber: row.unit.number,
  billTo: row.billTo,
  recipients: row.recipients.map((r) => ({
    personId: r.personId,
    fullName: r.person.fullName,
    share:
      r.shareNumerator !== null && r.shareDenominator !== null
        ? { numerator: r.shareNumerator, denominator: r.shareDenominator }
        : null,
  })),
  billingMonth: toIsoOrNull(row.billingMonth),
  billingDate: toIso(row.billingDate),
  dueDate: toIso(row.dueDate),
  issueDate: toIsoOrNull(row.issueDate),
  currency: row.currency,
  totalMinor: row.totalMinor,
  journalEntryId: row.journalEntryId,
  createdAt: row.createdAt,
  issuedAt: row.issuedAt,
});

class PrismaFinanceUnitOfWork implements FinanceUnitOfWork {
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

  async property(): Promise<PropertyFinanceInfo> {
    const [row] = await this.tx.$queryRaw<
      { currency: string; status: PropertyFinanceInfo['status']; today: Date }[]
    >`
      SELECT "currency", "status"::text AS "status", (now() AT TIME ZONE "time_zone")::date AS "today"
        FROM "properties"
       WHERE "id" = ${this.propertyId}::uuid AND "organisation_id" = ${this.organisationId}::uuid`;
    if (!row) throw new Error('Property not found inside an authorised request');
    return { currency: row.currency.trim(), status: row.status, today: toIso(row.today) };
  }

  async accounts(): Promise<LedgerAccountRecord[]> {
    return this.tx.ledgerAccount.findMany({
      where: this.scope,
      select: { id: true, code: true, name: true, type: true, systemKey: true, status: true },
      orderBy: { code: 'asc' },
    });
  }

  async createAccounts(definitions: readonly AccountDefinition[]): Promise<number> {
    const existing = await this.tx.ledgerAccount.findMany({
      where: this.scope,
      select: { code: true, systemKey: true },
    });
    const codes = new Set(existing.map((a) => a.code));
    const keys = new Set(existing.map((a) => a.systemKey));
    const missing = definitions.filter((d) => !codes.has(d.code) && !keys.has(d.systemKey));
    if (missing.length === 0) return 0;
    const { count } = await this.tx.ledgerAccount.createMany({
      data: missing.map((d) => ({ ...this.scope, ...d })),
    });
    return count;
  }

  chargeTypes(): Promise<ChargeTypeRecord[]> {
    return this.tx.chargeType.findMany({
      where: this.scope,
      select: CHARGE_TYPE_SELECT,
      orderBy: { code: 'asc' },
    });
  }

  chargeType(id: string): Promise<ChargeTypeRecord | null> {
    return this.tx.chargeType.findFirst({
      where: { ...this.scope, id },
      select: CHARGE_TYPE_SELECT,
    });
  }

  chargeTypeByCode(code: string): Promise<ChargeTypeRecord | null> {
    return this.tx.chargeType.findFirst({
      where: { ...this.scope, code },
      select: CHARGE_TYPE_SELECT,
    });
  }

  createChargeType(input: CreateChargeTypeInput): Promise<ChargeTypeRecord> {
    return this.tx.chargeType.create({
      data: { ...this.scope, ...input },
      select: CHARGE_TYPE_SELECT,
    });
  }

  archiveChargeType(id: string): Promise<ChargeTypeRecord> {
    return this.tx.chargeType.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
      select: CHARGE_TYPE_SELECT,
    });
  }

  async unit(id: string): Promise<UnitForBilling | null> {
    const row = await this.tx.unit.findFirst({
      where: { ...this.scope, id },
      select: { id: true, number: true, areaSqm: true, status: true },
    });
    return row && { ...row, areaSqm: row.areaSqm?.toFixed(2) ?? null };
  }

  async activeUnits(): Promise<UnitForBilling[]> {
    const rows = await this.tx.unit.findMany({
      where: { ...this.scope, status: 'ACTIVE' },
      select: { id: true, number: true, areaSqm: true, status: true },
      orderBy: { number: 'asc' },
    });
    return rows.map((row) => ({ ...row, areaSqm: row.areaSqm?.toFixed(2) ?? null }));
  }

  async recurringCharges(): Promise<RecurringChargeRecord[]> {
    const rows = await this.tx.recurringCharge.findMany({
      where: this.scope,
      select: RECURRING_SELECT,
      orderBy: [{ startMonth: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return rows.map(toRecurring);
  }

  async recurringCharge(id: string): Promise<RecurringChargeRecord | null> {
    const row = await this.tx.recurringCharge.findFirst({
      where: { ...this.scope, id },
      select: RECURRING_SELECT,
    });
    return row && toRecurring(row);
  }

  async createRecurringCharge(input: {
    unitId: string | null;
    chargeTypeId: string;
    basis: RecurringChargeRecord['basis'];
    amountMinor: bigint;
    startMonth: IsoDate;
    endMonth: IsoDate | null;
  }): Promise<string> {
    const row = await this.tx.recurringCharge.create({
      data: {
        ...this.scope,
        unitId: input.unitId,
        chargeTypeId: input.chargeTypeId,
        basis: input.basis,
        amountMinor: input.amountMinor,
        startMonth: toDate(input.startMonth),
        endMonth: input.endMonth === null ? null : toDate(input.endMonth),
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async endRecurringCharge(id: string, endMonth: IsoDate): Promise<void> {
    await this.tx.recurringCharge.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: { endMonth: toDate(endMonth) },
    });
  }

  async chargesForMonth(month: IsoDate): Promise<RecurringChargeRecord[]> {
    const date = toDate(month);
    const rows = await this.tx.recurringCharge.findMany({
      where: {
        ...this.scope,
        startMonth: { lte: date },
        OR: [{ endMonth: null }, { endMonth: { gte: date } }],
        chargeType: { status: 'ACTIVE' },
      },
      select: RECURRING_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRecurring);
  }

  async billedForMonth(month: IsoDate): Promise<Set<string>> {
    const rows = await this.tx.invoiceLine.findMany({
      where: { ...this.scope, billingMonth: toDate(month), recurringChargeId: { not: null } },
      select: { recurringChargeId: true, unitId: true },
    });
    return new Set(rows.map((r) => `${r.recurringChargeId}:${r.unitId}`));
  }

  async parties(unitIds: readonly string[], date: IsoDate): Promise<Map<string, UnitParties>> {
    const day = toDate(date);
    const covering = {
      voidedAt: null,
    };
    const [ownerships, tenancies] = await Promise.all([
      this.tx.ownership.findMany({
        where: {
          ...this.scope,
          unitId: { in: [...unitIds] },
          ...covering,
          effectiveFrom: { lte: day },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
        },
        select: {
          unitId: true,
          personId: true,
          shareNumerator: true,
          shareDenominator: true,
          person: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.tx.tenancy.findMany({
        where: {
          ...this.scope,
          unitId: { in: [...unitIds] },
          ...covering,
          startDate: { lte: day },
          OR: [{ endDate: null }, { endDate: { gte: day } }],
        },
        select: {
          id: true,
          unitId: true,
          occupants: {
            select: { personId: true, isPrimary: true, person: { select: { fullName: true } } },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
        },
      }),
    ]);
    const result = new Map<string, UnitParties>();
    const entry = (unitId: string) => {
      const existing = result.get(unitId);
      if (existing) return existing;
      const created: UnitParties = { owners: [], tenancy: null };
      result.set(unitId, created);
      return created;
    };
    for (const o of ownerships) {
      entry(o.unitId).owners.push({
        personId: o.personId,
        fullName: o.person.fullName,
        numerator: o.shareNumerator,
        denominator: o.shareDenominator,
      });
    }
    for (const t of tenancies) {
      entry(t.unitId).tenancy = {
        id: t.id,
        occupants: t.occupants.map((o) => ({ personId: o.personId, fullName: o.person.fullName })),
      };
    }
    return result;
  }

  async createInvoice(invoice: NewInvoice): Promise<string> {
    const total = invoice.lines.reduce((sum, line) => sum + line.amountMinor, 0n);
    try {
      const { id } = await this.tx.invoice.create({
        data: {
          ...this.scope,
          unitId: invoice.unitId,
          billTo: invoice.billTo,
          tenancyId: invoice.tenancyId,
          billingMonth: invoice.billingMonth === null ? null : toDate(invoice.billingMonth),
          billingDate: toDate(invoice.billingDate),
          dueDate: toDate(invoice.dueDate),
          currency: invoice.currency,
          totalMinor: total,
          createdByUserId: this.userId,
        },
        select: { id: true },
      });
      await this.tx.invoiceLine.createMany({
        data: invoice.lines.map((line, index) => ({
          ...this.scope,
          invoiceId: id,
          lineNumber: index + 1,
          chargeTypeId: line.chargeTypeId,
          description: line.description.slice(0, 300),
          amountMinor: line.amountMinor,
          recurringChargeId: line.recurringChargeId,
          unitId: line.recurringChargeId ? invoice.unitId : null,
          billingMonth:
            line.recurringChargeId && invoice.billingMonth ? toDate(invoice.billingMonth) : null,
        })),
      });
      await this.tx.invoiceRecipient.createMany({
        data: invoice.recipients.map((r) => ({
          ...this.scope,
          invoiceId: id,
          personId: r.personId,
          shareNumerator: r.share?.numerator ?? null,
          shareDenominator: r.share?.denominator ?? null,
        })),
      });
      return id;
    } catch (error) {
      if (isUniqueViolation(error) || databaseErrorCode(error) === '23505') {
        throw new AlreadyBilled();
      }
      throw error;
    }
  }

  async invoice(id: string, options: { lock?: boolean } = {}): Promise<InvoiceDetailRecord | null> {
    if (options.lock) {
      await this.tx.$queryRaw`
        SELECT 1 FROM "invoices"
         WHERE "id" = ${id}::uuid AND "organisation_id" = ${this.organisationId}::uuid
           AND "property_id" = ${this.propertyId}::uuid
         FOR UPDATE`;
    }
    const row = await this.tx.invoice.findFirst({
      where: { ...this.scope, id },
      select: {
        ...INVOICE_SELECT,
        lines: {
          select: {
            lineNumber: true,
            chargeTypeId: true,
            description: true,
            amountMinor: true,
            billingMonth: true,
            chargeType: { select: { code: true, incomeAccountId: true } },
          },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });
    if (!row) return null;
    const { lines, ...rest } = row;
    return {
      ...toInvoice(rest),
      lines: lines.map((line) => ({
        lineNumber: line.lineNumber,
        chargeTypeId: line.chargeTypeId,
        chargeTypeCode: line.chargeType.code,
        incomeAccountId: line.chargeType.incomeAccountId,
        description: line.description,
        amountMinor: line.amountMinor,
        billingMonth: toIsoOrNull(line.billingMonth),
      })),
    };
  }

  async invoices(filter: InvoiceListQuery): Promise<InvoiceRecord[]> {
    const rows = await this.tx.invoice.findMany({
      where: {
        ...this.scope,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.unitId ? { unitId: filter.unitId } : {}),
        ...(filter.billingMonth ? { billingMonth: toDate(filter.billingMonth) } : {}),
      },
      select: INVOICE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(toInvoice);
  }

  async setDueDate(id: string, dueDate: IsoDate): Promise<void> {
    await this.tx.invoice.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: { dueDate: toDate(dueDate) },
    });
  }

  async deleteDraftInvoice(id: string): Promise<void> {
    const where = { ...this.scope, invoiceId: id };
    await this.tx.invoiceLine.deleteMany({ where });
    await this.tx.invoiceRecipient.deleteMany({ where });
    await this.tx.invoice.deleteMany({ where: { ...this.scope, id, status: 'DRAFT' } });
  }

  async ensureMonthlyPeriod(date: IsoDate): Promise<PeriodState> {
    const { start, end } = monthBounds(date);
    // ON CONFLICT DO NOTHING also covers the exclusion constraint: a concurrent request opening
    // the same month, or an existing period overlapping it, leaves the table as it is.
    await this.tx.$executeRaw`
      INSERT INTO "accounting_periods" ("id", "organisation_id", "property_id", "start_date", "end_date", "updated_at")
      VALUES (${uuidV7()}::uuid, ${this.organisationId}::uuid, ${this.propertyId}::uuid,
              ${start}::date, ${end}::date, now())
      ON CONFLICT DO NOTHING`;
    const period = await this.tx.accountingPeriod.findFirst({
      where: { ...this.scope, startDate: { lte: toDate(date) }, endDate: { gte: toDate(date) } },
      select: { status: true },
    });
    return period?.status ?? 'NONE';
  }

  async postInvoiceEntry(
    description: string,
    entryDate: IsoDate,
    currency: string,
    lines: NewLedgerLine[],
  ): Promise<string> {
    const { id } = await this.tx.journalEntry.create({
      data: {
        ...this.scope,
        entryDate: toDate(entryDate),
        description: description.slice(0, 500),
        source: 'INVOICE',
        currency,
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    await this.tx.journalLine.createMany({
      data: lines.map((line, index) => ({
        ...this.scope,
        entryId: id,
        lineNumber: index + 1,
        accountId: line.accountId,
        unitId: line.unitId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency,
      })),
    });
    await this.tx.journalEntry.update({
      where: { id },
      data: { status: 'POSTED', postedByUserId: this.userId },
    });
    return id;
  }

  async markIssued(id: string, journalEntryId: string, issueDate: IsoDate): Promise<void> {
    await this.tx.invoice.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: {
        status: 'ISSUED',
        journalEntryId,
        issueDate: toDate(issueDate),
        issuedByUserId: this.userId,
      },
    });
  }

  async audit(event: FinanceAuditEvent): Promise<void> {
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

@Injectable()
export class PrismaFinanceRepository implements FinanceRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: FinanceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaFinanceUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}
