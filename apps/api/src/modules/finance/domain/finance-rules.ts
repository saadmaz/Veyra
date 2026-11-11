import { DomainError, Money } from '@veyra/domain';
import { z } from 'zod';
import { calendarDateSchema } from '../../../platform/validation/common-schemas';

/*
 * Finance rules (PRD 3.4, DATA_MODEL section 6, owner decisions of 2026-11-11 in ROADMAP).
 * Money is bigint minor units; amounts arrive as decimal strings in the property's currency.
 * The database repeats the essential rules (posting, issuing, no double billing).
 */

export type IsoDate = string;
export type LiableParty = 'OWNERS' | 'OCCUPANT';
export type RecurringBasis = 'FLAT' | 'PER_SQM';

// ------------------------------------------------------------------ default set-up

export interface AccountDefinition {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  systemKey: string;
}

/**
 * The accounts every property starts with. Finance staff may add their own; these are found by
 * their system key, so renaming them does not break posting.
 */
export const DEFAULT_ACCOUNTS: readonly AccountDefinition[] = [
  { code: '1000', name: 'Bank', type: 'ASSET', systemKey: 'BANK' },
  { code: '1010', name: 'Cash', type: 'ASSET', systemKey: 'CASH' },
  { code: '1050', name: 'Payment gateway clearing', type: 'ASSET', systemKey: 'GATEWAY_CLEARING' },
  { code: '1100', name: 'Receivables from units', type: 'ASSET', systemKey: 'RECEIVABLES' },
  { code: '2100', name: 'Unit credit (overpayments)', type: 'LIABILITY', systemKey: 'UNIT_CREDIT' },
  { code: '3000', name: 'Opening balances', type: 'EQUITY', systemKey: 'OPENING_BALANCE' },
  {
    code: '4000',
    name: 'Service charge income',
    type: 'INCOME',
    systemKey: 'SERVICE_CHARGE_INCOME',
  },
  { code: '4100', name: 'Utility income', type: 'INCOME', systemKey: 'UTILITY_INCOME' },
  { code: '4900', name: 'Other income', type: 'INCOME', systemKey: 'OTHER_INCOME' },
];

/** The two charge types of the owner's decision: service charges to owners, utilities to occupants. */
export const DEFAULT_CHARGE_TYPES: readonly {
  code: string;
  name: string;
  liableParty: LiableParty;
  incomeSystemKey: string;
}[] = [
  {
    code: 'SERVICE',
    name: 'Service charge',
    liableParty: 'OWNERS',
    incomeSystemKey: 'SERVICE_CHARGE_INCOME',
  },
  {
    code: 'UTILITIES',
    name: 'Utilities',
    liableParty: 'OCCUPANT',
    incomeSystemKey: 'UTILITY_INCOME',
  },
];

// ------------------------------------------------------------------ input

/** "YYYY-MM", returned as the first day of the month ("YYYY-MM-01"). */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
  .transform((value) => `${value}-01`);

/** A positive decimal amount such as "1500.50"; checked against the currency's decimals later. */
export const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,4})?$/, 'Use a positive amount such as 1500.50');

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2-20 letters, digits and hyphens');
const name = z.string().trim().min(1).max(120);

export const createChargeTypeSchema = z.object({
  code,
  name,
  liableParty: z.enum(['OWNERS', 'OCCUPANT']),
  incomeAccountId: z.uuid(),
});
export type CreateChargeTypeInput = z.infer<typeof createChargeTypeSchema>;

export const createRecurringChargeSchema = z
  .object({
    unitId: z.uuid().optional(),
    chargeTypeId: z.uuid(),
    basis: z.enum(['FLAT', 'PER_SQM']),
    amount: amountSchema,
    startMonth: monthSchema,
    endMonth: monthSchema.optional(),
  })
  .refine((v) => v.endMonth === undefined || v.endMonth >= v.startMonth, {
    message: 'The last month cannot be before the first',
    path: ['endMonth'],
  });
export type CreateRecurringChargeInput = z.infer<typeof createRecurringChargeSchema>;

export const endRecurringChargeSchema = z.object({ endMonth: monthSchema });

export const billingRunSchema = z
  .object({
    month: monthSchema,
    dueDate: calendarDateSchema,
    issue: z.boolean().default(false),
  })
  .refine((v) => v.dueDate >= v.month, {
    message: 'The due date cannot be before the month billed',
    path: ['dueDate'],
  });
export type BillingRunInput = z.infer<typeof billingRunSchema>;

export const createInvoiceSchema = z.object({
  unitId: z.uuid(),
  dueDate: calendarDateSchema,
  lines: z
    .array(
      z.object({
        chargeTypeId: z.uuid(),
        description: z
          .string()
          .trim()
          .max(300)
          .optional()
          .transform((v) => (v === '' ? undefined : v)),
        amount: amountSchema,
      }),
    )
    .min(1)
    .max(50),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const issueInvoiceSchema = z.object({ dueDate: calendarDateSchema.optional() });

export const invoiceListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'ISSUED']).optional(),
  unitId: z.uuid().optional(),
  billingMonth: monthSchema.optional(),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

// ------------------------------------------------------------------ amounts

/** A positive amount in the currency's minor units; refuses more decimals than it has. */
export function parsePositiveAmount(decimal: string, currency: string): bigint {
  const minor = Money.parse(decimal, currency).amountMinor;
  if (minor <= 0n) throw new DomainError('INVALID_MONEY', 'The amount must be more than zero');
  return minor;
}

/**
 * A per-square-metre charge: rate (minor units per sqm) times the unit's area (up to 2 decimals),
 * rounded half up to a whole minor unit. Exact: bigint arithmetic on hundredths of a sqm.
 */
export function perSqmAmount(rateMinor: bigint, areaSqm: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(areaSqm);
  if (!match) throw new DomainError('INVALID_AREA', `Invalid area "${areaSqm}"`);
  const hundredths = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return (rateMinor * hundredths + 50n) / 100n;
}

/** The amount a recurring charge bills a unit for one month, or null when it cannot be priced. */
export function recurringAmount(
  charge: { basis: RecurringBasis; amountMinor: bigint },
  areaSqm: string | null,
): bigint | null {
  if (charge.basis === 'FLAT') return charge.amountMinor;
  if (areaSqm === null) return null;
  const amount = perSqmAmount(charge.amountMinor, areaSqm);
  return amount > 0n ? amount : null;
}

// ------------------------------------------------------------------ billing

export interface RecurringChargeRef {
  id: string;
  unitId: string | null;
  chargeTypeId: string;
}

/**
 * The recurring charges that apply to a unit: its own charges, plus property-wide charges of the
 * types it has no own charge for (a unit's own charge replaces the property-wide one).
 */
export function chargesForUnit<T extends RecurringChargeRef>(
  charges: readonly T[],
  unitId: string,
): T[] {
  const own = charges.filter((c) => c.unitId === unitId);
  const ownTypes = new Set(own.map((c) => c.chargeTypeId));
  return [...own, ...charges.filter((c) => c.unitId === null && !ownTypes.has(c.chargeTypeId))];
}

export interface OwnerShare {
  personId: string;
  fullName: string;
  numerator: number;
  denominator: number;
}

export interface UnitParties {
  owners: OwnerShare[];
  tenancy: { id: string; occupants: { personId: string; fullName: string }[] } | null;
}

export type BillTo =
  | { billTo: 'OWNERS'; tenancyId: null; recipients: OwnerShare[] }
  | {
      billTo: 'TENANTS';
      tenancyId: string;
      recipients: { personId: string; fullName: string }[];
    };

/**
 * Who pays (owner decision, 2026-11-11): OWNERS charges go to the owners; OCCUPANT charges to the
 * current tenancy, or to the owners while the unit has none. Null when there is nobody to bill.
 */
export function resolveBillTo(party: LiableParty, parties: UnitParties): BillTo | null {
  if (party === 'OCCUPANT' && parties.tenancy && parties.tenancy.occupants.length > 0) {
    return {
      billTo: 'TENANTS',
      tenancyId: parties.tenancy.id,
      recipients: parties.tenancy.occupants,
    };
  }
  if (parties.owners.length === 0) return null;
  return { billTo: 'OWNERS', tenancyId: null, recipients: parties.owners };
}

/** Invoices of one unit are grouped by who they are addressed to. */
export function billToKey(target: BillTo): string {
  return target.billTo === 'OWNERS' ? 'OWNERS' : `TENANTS:${target.tenancyId}`;
}

/** "January 2027" for "2027-01-01". */
export function monthLabel(month: IsoDate): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}T00:00:00Z`));
}

/** "2027-01" for "2027-01-01". */
export const toMonth = (date: IsoDate) => date.slice(0, 7);

/** First and last day of the month containing the date. */
export function monthBounds(date: IsoDate): { start: IsoDate; end: IsoDate } {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start: `${date.slice(0, 7)}-01`, end };
}

/** "INV-000042". */
export const formatInvoiceNumber = (n: bigint | number) => `INV-${String(n).padStart(6, '0')}`;

// ------------------------------------------------------------------ payments (Part 3)

export type PaidBy = 'OWNERS' | 'TENANTS';
export type ManualPaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';

export const recordPaymentSchema = z.object({
  unitId: z.uuid(),
  paidBy: z.enum(['OWNERS', 'TENANTS']),
  method: z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE']),
  amount: amountSchema,
  receivedOn: calendarDateSchema,
  reference: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const allocatePaymentSchema = z.object({ invoiceId: z.uuid(), amount: amountSchema });
export type AllocatePaymentInput = z.infer<typeof allocatePaymentSchema>;

export const createPaymentIntentSchema = z.object({
  unitId: z.uuid(),
  paidBy: z.enum(['OWNERS', 'TENANTS']),
  amount: amountSchema,
});
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;

export const paymentListQuerySchema = z.object({ unitId: z.uuid().optional() });

/** The Idempotency-Key header: a UUID chosen by the client for one logical request. */
export const idempotencyKeySchema = z.uuid({ message: 'Send an Idempotency-Key header (a UUID)' });

/** The ledger account money arrives in, by payment method. */
export function cashAccountKey(method: ManualPaymentMethod | 'GATEWAY'): string {
  if (method === 'CASH') return 'CASH';
  if (method === 'GATEWAY') return 'GATEWAY_CLEARING';
  return 'BANK';
}

export interface CreditSource {
  paymentId: string;
  remainingMinor: bigint;
}

export interface OpenInvoice {
  invoiceId: string;
  outstandingMinor: bigint;
}

/**
 * Oldest first (owner decision, 2026-11-11): the oldest unpaid invoice is paid from the oldest
 * unused payment, and so on. Both lists arrive oldest first. Whatever is left stays as credit.
 */
export function planAllocations(
  credits: readonly CreditSource[],
  invoices: readonly OpenInvoice[],
): { paymentId: string; invoiceId: string; amountMinor: bigint }[] {
  const left = credits.map((c) => ({ ...c }));
  const plan: { paymentId: string; invoiceId: string; amountMinor: bigint }[] = [];
  let source = 0;
  for (const invoice of invoices) {
    let due = invoice.outstandingMinor;
    while (due > 0n && source < left.length) {
      const credit = left[source];
      if (!credit || credit.remainingMinor <= 0n) {
        source += 1;
        continue;
      }
      // biome-ignore lint/complexity/useMathMinMax: Math.min does not accept bigint.
      const amount = credit.remainingMinor < due ? credit.remainingMinor : due;
      plan.push({ paymentId: credit.paymentId, invoiceId: invoice.invoiceId, amountMinor: amount });
      credit.remainingMinor -= amount;
      due -= amount;
    }
    if (source >= left.length) break;
  }
  return plan;
}

/** "RCT-000042". */
export const formatReceiptNumber = (n: bigint | number) => `RCT-${String(n).padStart(6, '0')}`;
