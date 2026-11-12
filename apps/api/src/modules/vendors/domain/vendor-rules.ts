import { TRADES } from '@veyra/domain';
import { z } from 'zod';

/*
 * Vendor rules (PRD 3.8, DATA_MODEL section 9). The database enforces them again (migration
 * 20261119090000_vendors); these give a clear answer before it does.
 */

export type VendorStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export const DOCUMENT_KINDS = ['INSURANCE', 'LICENCE', 'CONTRACT', 'CERTIFICATE', 'OTHER'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Documents expiring within this many days count as "expiring soon". */
export const EXPIRING_SOON_DAYS = 30;

export type Compliance = 'OK' | 'EXPIRING_SOON' | 'EXPIRED' | 'NO_DOCUMENTS';

/**
 * A vendor's compliance from its documents that are not voided, as of `today` (YYYY-MM-DD):
 * EXPIRED when any has passed its expiry date, EXPIRING_SOON when any expires within 30 days.
 */
export function compliance(
  documents: readonly { expiresOn: string | null; voided: boolean }[],
  today: string,
): Compliance {
  const live = documents.filter((d) => !d.voided);
  if (live.length === 0) return 'NO_DOCUMENTS';
  const soon = addDays(today, EXPIRING_SOON_DAYS);
  if (live.some((d) => d.expiresOn !== null && d.expiresOn < today)) return 'EXPIRED';
  if (live.some((d) => d.expiresOn !== null && d.expiresOn <= soon)) return 'EXPIRING_SOON';
  return 'OK';
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ input schemas

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const details = {
  name: text(160),
  categories: z.array(z.enum(TRADES)).max(TRADES.length).default([]),
  contactName: optional(160),
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase())
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  phone: optional(40).refine((v) => v == null || v.length >= 3, 'Use at least 3 characters'),
  taxReference: optional(60),
  notes: optional(2000),
};

export const createVendorSchema = z.object(details);
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = z
  .object(details)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one detail');
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const vendorListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
});

export const reasonSchema = z.object({ reason: text(1000) });

export const documentSchema = z
  .object({
    kind: z.enum(DOCUMENT_KINDS),
    title: text(160),
    reference: optional(120),
    validFrom: z.iso.date().nullable().optional(),
    expiresOn: z.iso.date().nullable().optional(),
  })
  .refine((v) => !v.validFrom || !v.expiresOn || v.expiresOn >= v.validFrom, {
    message: 'It cannot expire before it starts',
    path: ['expiresOn'],
  });
export type DocumentInput = z.infer<typeof documentSchema>;

export const voidSchema = z.object({ reason: text(500) });
