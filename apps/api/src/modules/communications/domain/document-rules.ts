import { z } from 'zod';
import { ALLOWED_CONTENT_TYPES } from '../../../platform/storage/object-storage';

/*
 * Documents (PRD 3.9, DATA_MODEL section 11). The database enforces the file rules again
 * (migration 20261125090000_documents).
 */

export const DOCUMENT_CATEGORIES = [
  'RULES',
  'MINUTES',
  'NOTICE',
  'FORM',
  'FINANCIAL',
  'CONTRACT',
  'INSURANCE',
  'OTHER',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
export type DocumentAudience = 'EVERYONE' | 'RESIDENTS' | 'OWNERS' | 'STAFF';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const EXPIRING_SOON_DAYS = 30;

/** What a reader may see: staff readers, residents (owners of the unit or not). */
export type DocumentReader =
  | { kind: 'manager' }
  | { kind: 'staff' }
  | { kind: 'resident'; owner: boolean };

export function audiencesFor(reader: DocumentReader): DocumentAudience[] | null {
  if (reader.kind === 'manager') return null;
  if (reader.kind === 'staff') return ['EVERYONE', 'STAFF'];
  return reader.owner ? ['EVERYONE', 'RESIDENTS', 'OWNERS'] : ['EVERYONE', 'RESIDENTS'];
}

/** Expiry as of `today` (YYYY-MM-DD). */
export function expiry(
  expiresOn: string | null,
  today: string,
): 'NONE' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' {
  if (!expiresOn) return 'NONE';
  if (expiresOn < today) return 'EXPIRED';
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + EXPIRING_SOON_DAYS);
  return expiresOn <= soon.toISOString().slice(0, 10) ? 'EXPIRING_SOON' : 'VALID';
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

export const fileSchema = z.object({
  fileName: text(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.int().min(1).max(MAX_DOCUMENT_BYTES),
});

const details = {
  title: text(160),
  description: optional(2000),
  category: z.enum(DOCUMENT_CATEGORIES),
  audience: z.enum(['EVERYONE', 'RESIDENTS', 'OWNERS', 'STAFF']),
  expiresOn: z.iso.date().nullable().optional(),
};

export const createDocumentSchema = z.object({ ...details, file: fileSchema });
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z
  .object(details)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const newVersionSchema = z.object({ file: fileSchema, note: optional(500) });
export type NewVersionInput = z.infer<typeof newVersionSchema>;
