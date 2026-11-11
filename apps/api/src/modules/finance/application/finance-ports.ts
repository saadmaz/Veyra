import type { RequestMeta } from '../../../platform/request-meta';
import type {
  AccountDefinition,
  CreateChargeTypeInput,
  InvoiceListQuery,
  IsoDate,
  LiableParty,
  RecurringBasis,
  UnitParties,
} from '../domain/finance-rules';

export interface PropertyFinanceInfo {
  currency: string;
  status: 'ONBOARDING' | 'ACTIVE' | 'ARCHIVED';
  /** Today in the property's time zone. */
  today: IsoDate;
}

export interface LedgerAccountRecord {
  id: string;
  code: string;
  name: string;
  type: AccountDefinition['type'];
  systemKey: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface ChargeTypeRecord {
  id: string;
  code: string;
  name: string;
  liableParty: LiableParty;
  incomeAccountId: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface RecurringChargeRecord {
  id: string;
  unitId: string | null;
  unitNumber: string | null;
  chargeTypeId: string;
  chargeTypeCode: string;
  chargeTypeName: string;
  liableParty: LiableParty;
  basis: RecurringBasis;
  amountMinor: bigint;
  /** The property's currency. */
  currency: string;
  startMonth: IsoDate;
  endMonth: IsoDate | null;
}

export interface UnitForBilling {
  id: string;
  number: string;
  /** Square metres with up to 2 decimals, e.g. "85.50"; null when not recorded. */
  areaSqm: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface InvoiceRecipientRecord {
  personId: string;
  fullName: string;
  share: { numerator: number; denominator: number } | null;
}

export interface InvoiceLineRecord {
  lineNumber: number;
  chargeTypeId: string;
  chargeTypeCode: string;
  incomeAccountId: string;
  description: string;
  amountMinor: bigint;
  billingMonth: IsoDate | null;
}

export interface InvoiceRecord {
  id: string;
  invoiceNumber: bigint | null;
  status: 'DRAFT' | 'ISSUED';
  unitId: string;
  unitNumber: string;
  billTo: 'OWNERS' | 'TENANTS';
  recipients: InvoiceRecipientRecord[];
  billingMonth: IsoDate | null;
  billingDate: IsoDate;
  dueDate: IsoDate;
  issueDate: IsoDate | null;
  currency: string;
  totalMinor: bigint;
  journalEntryId: string | null;
  createdAt: Date;
  issuedAt: Date | null;
}

export interface InvoiceDetailRecord extends InvoiceRecord {
  lines: InvoiceLineRecord[];
}

export interface NewInvoice {
  unitId: string;
  billTo: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  billingMonth: IsoDate | null;
  billingDate: IsoDate;
  dueDate: IsoDate;
  currency: string;
  lines: {
    chargeTypeId: string;
    description: string;
    amountMinor: bigint;
    /** Set for lines of a billing run (with the invoice's unit and month). */
    recurringChargeId: string | null;
  }[];
  recipients: InvoiceRecipientRecord[];
}

export interface NewLedgerLine {
  accountId: string;
  unitId: string | null;
  debitMinor: bigint;
  creditMinor: bigint;
}

/** The state of the accounting period covering a date after trying to open its month. */
export type PeriodState = 'OPEN' | 'CLOSED' | 'NONE';

export interface FinanceAuditEvent {
  action: string;
  resourceType: string;
  resourceId: string;
  /** Never personal data. */
  metadata?: Record<string, string | number | boolean>;
}

/** Thrown when the request would bill a recurring charge again for a unit and month. */
export class AlreadyBilled extends Error {}

/**
 * One transaction in the organisation's RLS context, limited to one property. Every query filters
 * by organisation and property explicitly as well.
 */
export interface FinanceUnitOfWork {
  property(): Promise<PropertyFinanceInfo>;
  accounts(): Promise<LedgerAccountRecord[]>;
  /** Creates the accounts whose system key and code are both still free. */
  createAccounts(definitions: readonly AccountDefinition[]): Promise<number>;
  chargeTypes(): Promise<ChargeTypeRecord[]>;
  chargeType(id: string): Promise<ChargeTypeRecord | null>;
  chargeTypeByCode(code: string): Promise<ChargeTypeRecord | null>;
  createChargeType(input: CreateChargeTypeInput): Promise<ChargeTypeRecord>;
  archiveChargeType(id: string): Promise<ChargeTypeRecord>;
  unit(id: string): Promise<UnitForBilling | null>;
  activeUnits(): Promise<UnitForBilling[]>;
  recurringCharges(): Promise<RecurringChargeRecord[]>;
  recurringCharge(id: string): Promise<RecurringChargeRecord | null>;
  createRecurringCharge(input: {
    unitId: string | null;
    chargeTypeId: string;
    basis: RecurringBasis;
    amountMinor: bigint;
    startMonth: IsoDate;
    endMonth: IsoDate | null;
  }): Promise<string>;
  endRecurringCharge(id: string, endMonth: IsoDate): Promise<void>;
  /** Charges of ACTIVE charge types that cover the month. */
  chargesForMonth(month: IsoDate): Promise<RecurringChargeRecord[]>;
  /** "<recurringChargeId>:<unitId>" for every line already billed for the month. */
  billedForMonth(month: IsoDate): Promise<Set<string>>;
  /** Owners and the tenancy of each unit on the date (property-local, non-voided records). */
  parties(unitIds: readonly string[], date: IsoDate): Promise<Map<string, UnitParties>>;
  /** Throws AlreadyBilled when a recurring line was billed concurrently. */
  createInvoice(invoice: NewInvoice): Promise<string>;
  invoice(id: string, options?: { lock?: boolean }): Promise<InvoiceDetailRecord | null>;
  invoices(filter: InvoiceListQuery): Promise<InvoiceRecord[]>;
  setDueDate(id: string, dueDate: IsoDate): Promise<void>;
  deleteDraftInvoice(id: string): Promise<void>;
  /** Opens the month's period for the date unless a period already covers it. */
  ensureMonthlyPeriod(date: IsoDate): Promise<PeriodState>;
  /** Creates and posts an INVOICE journal entry; returns its id. */
  postInvoiceEntry(
    description: string,
    entryDate: IsoDate,
    currency: string,
    lines: NewLedgerLine[],
  ): Promise<string>;
  markIssued(id: string, journalEntryId: string, issueDate: IsoDate): Promise<void>;
  audit(event: FinanceAuditEvent): Promise<void>;
}

export interface FinanceRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: FinanceUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const FINANCE_REPOSITORY = Symbol('FINANCE_REPOSITORY');
