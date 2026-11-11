import { z } from 'zod';
import { calendarDateSchema } from '../../../platform/validation/common-schemas';
import { amountSchema, type PaidBy } from './finance-rules';

/*
 * Residents' finance (Phase 6 Part 6). Owner decisions (2026-11-11): owners and current tenants
 * see their invoices, receipts and statement and can submit a bank-transfer reference for
 * finance to confirm. Each resident sees only their own account ("party") of a unit: an owner
 * the owners' account, a tenant the account of the tenancy they are on today. Household members
 * see no finance. The database repeats the submission rules (bank_transfer_submissions trigger).
 */

/** At most this many submissions wait for finance per account (the database enforces it). */
export const MAX_PENDING_TRANSFERS = 10;

/** One account of a unit: the owners', or one tenancy's. */
export interface ResidentParty {
  paidBy: PaidBy;
  tenancyId: string | null;
}

/** What the caller's own records make them on a unit today. */
export interface ResidentStanding {
  owner: boolean;
  /** The tenancy they are a tenant on today, if any. */
  tenancyId: string | null;
}

/** The accounts a resident may see, owners' first. */
export function residentParties(standing: ResidentStanding): ResidentParty[] {
  const parties: ResidentParty[] = [];
  if (standing.owner) parties.push({ paidBy: 'OWNERS', tenancyId: null });
  if (standing.tenancyId) parties.push({ paidBy: 'TENANTS', tenancyId: standing.tenancyId });
  return parties;
}

/**
 * The accounts a request covers: the one asked for, or all of the caller's. Null when the caller
 * asked for an account that is not theirs (the API answers 404, revealing nothing about it).
 */
export function partiesFor(
  parties: readonly ResidentParty[],
  paidBy: PaidBy | undefined,
): ResidentParty[] | null {
  if (paidBy === undefined) return [...parties];
  const match = parties.filter((p) => p.paidBy === paidBy);
  return match.length > 0 ? match : null;
}

/** Whether a record (invoice, payment, submission) belongs to one of the accounts. */
export function belongsTo(
  parties: readonly ResidentParty[],
  record: { paidBy: PaidBy; tenancyId: string | null },
): boolean {
  return parties.some((p) => p.paidBy === record.paidBy && p.tenancyId === record.tenancyId);
}

const paidBy = z.enum(['OWNERS', 'TENANTS']);

export const residentPartyQuerySchema = z.object({ paidBy: paidBy.optional() });

export const residentStatementQuerySchema = z.object({ paidBy });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

/** Send with an Idempotency-Key header: a retry never submits twice. */
export const submitTransferSchema = z.object({
  paidBy,
  amount: amountSchema,
  /** The date the money was sent (property-local); not in the future. */
  transferredOn: calendarDateSchema,
  /** The bank's reference for the transfer. */
  reference: z.string().trim().min(1).max(100),
  note: optionalText(500),
});
export type SubmitTransferInput = z.infer<typeof submitTransferSchema>;

export const transferListQuerySchema = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'REJECTED']).optional(),
});

export const confirmTransferSchema = z.object({
  /** The date the money reached the bank account; defaults to the date the resident gave. */
  receivedOn: calendarDateSchema.optional(),
});
export type ConfirmTransferInput = z.infer<typeof confirmTransferSchema>;

export const rejectTransferSchema = z.object({
  /** Shown to the resident. */
  reason: z.string().trim().min(1).max(500),
});
