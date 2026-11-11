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
  tenancyId: string | null;
  recipients: InvoiceRecipientRecord[];
  billingMonth: IsoDate | null;
  billingDate: IsoDate;
  dueDate: IsoDate;
  issueDate: IsoDate | null;
  currency: string;
  totalMinor: bigint;
  /** Sum of the allocations not released. */
  paidMinor: bigint;
  /** Credit notes and write-offs. */
  creditedMinor: bigint;
  /** Issued, not fully settled and past its due date (property-local today). */
  overdue: boolean;
  journalEntryId: string | null;
  createdAt: Date;
  issuedAt: Date | null;
}

export interface InvoiceCreditRecord {
  id: string;
  kind: 'CREDIT_NOTE' | 'WRITE_OFF';
  creditNumber: bigint | null;
  lineNumber: number | null;
  amountMinor: bigint;
  reason: string;
  creditedOn: IsoDate;
  createdAt: Date;
}

export interface InvoiceDetailRecord extends InvoiceRecord {
  lines: InvoiceLineRecord[];
  credits: InvoiceCreditRecord[];
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

/** Who paid, or who an invoice is addressed to: the owners, or one tenancy. */
export interface Party {
  billTo: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
}

export interface AllocationRecord {
  id: string;
  paymentId: string;
  invoiceId: string;
  invoiceNumber: bigint | null;
  unitId: string;
  amountMinor: bigint;
  createdAt: Date;
  releasedAt: Date | null;
}

export interface PaymentRecord {
  id: string;
  receiptNumber: bigint;
  unitId: string;
  unitNumber: string;
  paidBy: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  method: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | 'GATEWAY';
  amountMinor: bigint;
  currency: string;
  receivedOn: IsoDate;
  reference: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  allocations: AllocationRecord[];
  refundedMinor: bigint;
  /** Set when the payment was reversed (e.g. a bounced cheque). */
  reversedOn: IsoDate | null;
}

export interface AccountingPeriodRecord {
  id: string;
  startDate: IsoDate;
  endDate: IsoDate;
  status: 'OPEN' | 'CLOSED';
  closedAt: Date | null;
}

export type ApprovalAction = 'REVERSE_PAYMENT' | 'REFUND' | 'WRITE_OFF' | 'REOPEN_PERIOD';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface ApprovalRecord {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  paymentId: string | null;
  invoiceId: string | null;
  periodId: string | null;
  amountMinor: bigint | null;
  /** The property's currency. */
  currency: string;
  refundMethod: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | null;
  reason: string;
  requestedByUserId: string;
  requestedByName: string;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  executedAt: Date | null;
  createdAt: Date;
}

export interface StatementData {
  invoices: { invoiceNumber: bigint; issueDate: IsoDate; totalMinor: bigint; issuedAt: Date }[];
  credits: {
    kind: 'CREDIT_NOTE' | 'WRITE_OFF';
    creditNumber: bigint | null;
    invoiceNumber: bigint | null;
    creditedOn: IsoDate;
    amountMinor: bigint;
    createdAt: Date;
  }[];
  payments: { receiptNumber: bigint; receivedOn: IsoDate; amountMinor: bigint; createdAt: Date }[];
  refunds: { receiptNumber: bigint; refundedOn: IsoDate; amountMinor: bigint; createdAt: Date }[];
  reversals: { receiptNumber: bigint; reversedOn: IsoDate; amountMinor: bigint; createdAt: Date }[];
}

export interface OutstandingInvoice {
  invoiceId: string;
  unitId: string;
  unitNumber: string;
  billTo: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  dueDate: IsoDate;
  outstandingMinor: bigint;
}

export interface NewPayment {
  unitId: string;
  party: Party;
  method: PaymentRecord['method'];
  amountMinor: bigint;
  currency: string;
  receivedOn: IsoDate;
  reference: string | null;
  journalEntryId: string;
  idempotencyKey: string | null;
  paymentIntentId: string | null;
}

export interface PaymentIntentRecord {
  id: string;
  unitId: string;
  paidBy: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  amountMinor: bigint;
  currency: string;
  provider: string;
  providerReference: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  expiresAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  paymentId: string | null;
}

/** A resident's report of a bank transfer (Phase 6 Part 6). */
export interface BankTransferRecord {
  id: string;
  unitId: string;
  unitNumber: string;
  paidBy: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  amountMinor: bigint;
  currency: string;
  transferredOn: IsoDate;
  reference: string;
  note: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
  submittedByUserId: string;
  submittedByName: string;
  idempotencyKey: string;
  decidedAt: Date | null;
  rejectionReason: string | null;
  paymentId: string | null;
  receiptNumber: bigint | null;
  createdAt: Date;
}

/** Thrown when another request with the same Idempotency-Key is being recorded right now. */
export class IdempotencyConflict extends Error {}

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
  /** Creates and posts a journal entry; returns its id. */
  postEntry(
    source: 'INVOICE' | 'PAYMENT' | 'ALLOCATION' | 'CREDIT_NOTE' | 'WRITE_OFF' | 'REFUND',
    description: string,
    entryDate: IsoDate,
    currency: string,
    lines: NewLedgerLine[],
  ): Promise<string>;
  markIssued(id: string, journalEntryId: string, issueDate: IsoDate): Promise<void>;
  /** Throws IdempotencyConflict when the key was used concurrently. */
  createPayment(payment: NewPayment): Promise<string>;
  payment(id: string): Promise<PaymentRecord | null>;
  paymentByIdempotencyKey(key: string): Promise<PaymentRecord | null>;
  payments(filter: { unitId?: string }): Promise<PaymentRecord[]>;
  /** The party's payments with money not yet allocated, oldest first. */
  creditSources(
    unitId: string,
    party: Party,
  ): Promise<{ paymentId: string; remainingMinor: bigint }[]>;
  /** The party's issued invoices not fully paid, oldest due first. */
  openInvoices(
    unitId: string,
    party: Party,
  ): Promise<{ invoiceId: string; outstandingMinor: bigint }[]>;
  createAllocation(input: {
    unitId: string;
    paymentId: string;
    invoiceId: string;
    amountMinor: bigint;
    journalEntryId: string;
  }): Promise<string>;
  allocation(id: string): Promise<AllocationRecord | null>;
  releaseAllocation(id: string, releaseEntryId: string): Promise<void>;
  createPaymentIntent(input: {
    unitId: string;
    party: Party;
    amountMinor: bigint;
    currency: string;
    provider: string;
    providerReference: string;
    expiresAt: Date;
  }): Promise<string>;
  paymentIntent(id: string, options?: { lock?: boolean }): Promise<PaymentIntentRecord | null>;
  completePaymentIntent(id: string, status: 'SUCCEEDED' | 'FAILED'): Promise<void>;
  /** True when this provider event was already processed. */
  providerEventSeen(provider: string, eventId: string): Promise<boolean>;
  recordProviderEvent(input: {
    provider: string;
    eventId: string;
    type: string;
    intentId: string;
    outcome: string;
  }): Promise<void>;
  /** The ledger entry a payment was posted with. */
  paymentEntryId(paymentId: string): Promise<string>;
  /** Posts the mirror image of a posted entry (source REVERSAL); returns its id. */
  postReversal(entryId: string, date: IsoDate, description: string): Promise<string>;
  periods(): Promise<AccountingPeriodRecord[]>;
  period(id: string): Promise<AccountingPeriodRecord | null>;
  setPeriodStatus(id: string, status: 'OPEN' | 'CLOSED'): Promise<void>;
  createApproval(input: {
    action: ApprovalAction;
    paymentId: string | null;
    invoiceId: string | null;
    periodId: string | null;
    amountMinor: bigint | null;
    refundMethod: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | null;
    reason: string;
  }): Promise<string>;
  approval(id: string, options?: { lock?: boolean }): Promise<ApprovalRecord | null>;
  approvals(filter: { status?: ApprovalStatus }): Promise<ApprovalRecord[]>;
  /** APPROVED also marks the approval carried out (executed_at) in this transaction. */
  decideApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'PENDING'>,
    note: string | null,
  ): Promise<void>;
  createInvoiceCredit(input: {
    unitId: string;
    invoiceId: string;
    kind: 'CREDIT_NOTE' | 'WRITE_OFF';
    lineNumber: number | null;
    amountMinor: bigint;
    reason: string;
    creditedOn: IsoDate;
    journalEntryId: string;
    approvalId: string | null;
  }): Promise<string>;
  createRefund(input: {
    unitId: string;
    paymentId: string;
    amountMinor: bigint;
    method: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';
    refundedOn: IsoDate;
    journalEntryId: string;
    approvalId: string;
  }): Promise<void>;
  createReversal(input: {
    paymentId: string;
    reversedOn: IsoDate;
    journalEntryId: string;
    approvalId: string;
  }): Promise<void>;
  statementData(unitId: string, party: Party): Promise<StatementData>;
  /** What the user's own records (an ACTIVE linked person) make them on the unit on the date. */
  residentStanding(
    userId: string,
    unitId: string,
    date: IsoDate,
  ): Promise<{ owner: boolean; tenancyId: string | null }>;
  /** Issued invoices of the unit addressed to any of the parties, newest first (at most 200). */
  partyInvoices(unitId: string, parties: readonly Party[]): Promise<InvoiceRecord[]>;
  /** Payments of the unit made by any of the parties, newest first (at most 200). */
  partyPayments(unitId: string, parties: readonly Party[]): Promise<PaymentRecord[]>;
  /** Throws IdempotencyConflict when the key was already used (or is being used right now). */
  createTransfer(input: {
    unitId: string;
    party: Party;
    amountMinor: bigint;
    currency: string;
    transferredOn: IsoDate;
    reference: string;
    note: string | null;
    idempotencyKey: string;
  }): Promise<string>;
  transfer(id: string, options?: { lock?: boolean }): Promise<BankTransferRecord | null>;
  /** Throws IdempotencyConflict when the key belongs to another property. */
  transferByIdempotencyKey(key: string): Promise<BankTransferRecord | null>;
  /** Newest first, at most 200. */
  transfers(filter: {
    status?: BankTransferRecord['status'];
    unitId?: string;
    parties?: readonly Party[];
  }): Promise<BankTransferRecord[]>;
  confirmTransfer(id: string, paymentId: string): Promise<void>;
  rejectTransfer(id: string, reason: string): Promise<void>;
  outstandingInvoices(): Promise<OutstandingInvoice[]>;
  audit(event: FinanceAuditEvent): Promise<void>;
}

export interface FinanceRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    /** Null for provider callbacks (no signed-in user). */
    userId: string | null,
    meta: RequestMeta,
    work: (uow: FinanceUnitOfWork) => Promise<T>,
  ): Promise<T>;
  /** Finds the intent a verified provider callback refers to, across organisations. */
  intentByProviderReference(
    provider: string,
    providerReference: string,
  ): Promise<{ id: string; organisationId: string; propertyId: string } | null>;
}

export const FINANCE_REPOSITORY = Symbol('FINANCE_REPOSITORY');
