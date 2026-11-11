import { z } from 'zod';
import { calendarDateSchema } from '../../../platform/validation/common-schemas';
import { amountSchema, type IsoDate } from './finance-rules';

/*
 * Controls and reports (Phase 6 Part 4). Owner decisions (2026-11-11 and 2026-11-12): reversals,
 * write-offs, refunds and reopening a closed period need a second person's approval; any finance
 * officer or organisation admin other than the requester may approve. The database repeats the
 * rule (finance_approvals CHECK and the action triggers).
 */

const reason = z.string().trim().min(1).max(500);

export const approvalRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('REVERSE_PAYMENT'), paymentId: z.uuid(), reason }),
  z.object({
    action: z.literal('REFUND'),
    paymentId: z.uuid(),
    amount: amountSchema,
    method: z.enum(['BANK_TRANSFER', 'CASH', 'CHEQUE']),
    reason,
  }),
  z.object({ action: z.literal('WRITE_OFF'), invoiceId: z.uuid(), amount: amountSchema, reason }),
  z.object({ action: z.literal('REOPEN_PERIOD'), periodId: z.uuid(), reason }),
]);
export type ApprovalRequestInput = z.infer<typeof approvalRequestSchema>;

export const decisionSchema = z.object({
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

export const approvalListQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
});

export const creditNoteSchema = z.object({
  lineNumber: z.number().int().min(1),
  amount: amountSchema,
  reason,
});
export type CreditNoteInput = z.infer<typeof creditNoteSchema>;

export const statementQuerySchema = z.object({
  paidBy: z.enum(['OWNERS', 'TENANTS']),
  /** TENANTS: the tenancy; defaults to the current one. */
  tenancyId: z.uuid().optional(),
});

export const ageingQuerySchema = z.object({ asOf: calendarDateSchema.optional() });

// ------------------------------------------------------------------ ageing

export type AgeBucket = 'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'over90';
export const AGE_BUCKETS: readonly AgeBucket[] = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
];

/** Whole days from one calendar date to another (positive when `to` is later). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Not yet due (or due today) is current; then 1-30, 31-60, 61-90 and over 90 days overdue. */
export function ageBucket(dueDate: IsoDate, asOf: IsoDate): AgeBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'days1to30';
  if (overdue <= 60) return 'days31to60';
  if (overdue <= 90) return 'days61to90';
  return 'over90';
}

// ------------------------------------------------------------------ statements

export type StatementKind =
  | 'INVOICE'
  | 'CREDIT_NOTE'
  | 'WRITE_OFF'
  | 'PAYMENT'
  | 'REFUND'
  | 'PAYMENT_REVERSAL';

export interface StatementEvent {
  date: IsoDate;
  /** Tie-break within a date. */
  at: Date;
  kind: StatementKind;
  reference: string;
  /** Increases what is owed (invoices, refunds, reversed payments). */
  debitMinor: bigint;
  /** Decreases it (payments, credit notes, write-offs). */
  creditMinor: bigint;
}

/**
 * Orders the events and adds a running balance: positive means the party owes money, negative
 * that it holds credit.
 */
export function buildStatement(events: readonly StatementEvent[]): {
  lines: (StatementEvent & { balanceMinor: bigint })[];
  balanceMinor: bigint;
} {
  const sorted = [...events].sort(
    (a, b) => a.date.localeCompare(b.date) || a.at.getTime() - b.at.getTime(),
  );
  let balance = 0n;
  const lines = sorted.map((event) => {
    balance += event.debitMinor - event.creditMinor;
    return { ...event, balanceMinor: balance };
  });
  return { lines, balanceMinor: balance };
}

/** "CRN-000042". */
export const formatCreditNumber = (n: bigint | number) => `CRN-${String(n).padStart(6, '0')}`;
