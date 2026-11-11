import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { PassRejectionReason } from '@veyra/api-contracts';
import { z } from 'zod';
import {
  optionalText,
  phoneSchema,
  plateSchema,
} from '../../../platform/validation/common-schemas';

/*
 * Visitor rules (PRD 3.3, DATA_MODEL section 5). The database repeats the essential ones
 * (CHECK constraints, the online admission backstop). Visitor personal data is limited to name,
 * optional phone and optional plate (owner decision, 2026-11-11).
 */

export const VISITOR_CATEGORIES = ['GUEST', 'DELIVERY', 'CONTRACTOR', 'SERVICE_PROVIDER'] as const;

const DAY_MS = 86_400_000;
/** Longest window a single invitation may cover (repeated in a CHECK constraint). */
export const MAX_WINDOW_MS = 31 * DAY_MS;
/** How far ahead a visit may be registered. */
export const MAX_LEAD_MS = 90 * DAY_MS;

/** ISO 8601 instant with an explicit offset or Z; never a local time without a zone. */
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/**
 * Cross-field checks still run when a field failed to parse (it then holds the raw input), so
 * they only judge a window whose ends are both real dates; the field errors are reported anyway.
 */
const isWindow = (v: { from: unknown; until: unknown }): v is { from: Date; until: Date } =>
  v.from instanceof Date && v.until instanceof Date;
const visitorName = z.string().trim().min(1).max(200);
const category = z.enum(VISITOR_CATEGORIES);
const gate = optionalText(60);

export const createInvitationSchema = z
  .object({
    category,
    visitorName,
    visitorPhone: phoneSchema.optional(),
    vehiclePlate: plateSchema.optional(),
    validFrom: instant,
    validUntil: instant,
    maxEntries: z.number().int().min(1).max(50).default(1),
  })
  .refine(
    (v) => !isWindow({ from: v.validFrom, until: v.validUntil }) || v.validUntil > v.validFrom,
    {
      message: 'The end must be after the start',
      path: ['validUntil'],
    },
  )
  .refine(
    (v) =>
      !isWindow({ from: v.validFrom, until: v.validUntil }) ||
      v.validUntil.getTime() - v.validFrom.getTime() <= MAX_WINDOW_MS,
    {
      message: 'A visit can cover at most 31 days',
      path: ['validUntil'],
    },
  );
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

/**
 * Reference codes: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as
 * XXXX-XXXX. About 39 bits; guessing is limited by rate limits and a code only works with the
 * pass's window, and never replaces checking the person.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

export function normaliseCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

export const validatePassSchema = z
  .object({
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'Not a VEYRA pass')
      .optional(),
    code: z
      .string()
      .max(20)
      .transform(normaliseCode)
      .pipe(z.string().regex(CODE_PATTERN, 'Codes have 8 letters and digits'))
      .optional(),
    gate,
  })
  .refine((v) => (v.token === undefined) !== (v.code === undefined), {
    message: 'Scan the QR code or type the reference code (one of them)',
    path: ['token'],
  });
export type ValidatePassInput = z.infer<typeof validatePassSchema>;

export const admitSchema = z.object({ passId: z.uuid(), gate });
export type AdmitInput = z.infer<typeof admitSchema>;

export const denySchema = z
  .object({
    passId: z.uuid().optional(),
    unitId: z.uuid().optional(),
    category: category.optional(),
    visitorName: visitorName.optional(),
    vehiclePlate: plateSchema.optional(),
    reason: z.string().trim().min(1).max(500),
    gate,
  })
  .refine((v) => v.passId !== undefined || (v.category && v.visitorName), {
    message: 'For someone without a pass, give their name and category',
    path: ['visitorName'],
  });
export type DenyInput = z.infer<typeof denySchema>;

export const walkInSchema = z.object({
  unitId: z.uuid().optional(),
  category,
  visitorName,
  visitorPhone: phoneSchema.optional(),
  vehiclePlate: plateSchema.optional(),
  gate,
});
export type WalkInInput = z.infer<typeof walkInSchema>;

export const departSchema = z.object({ gate });

export const visitLogQuerySchema = z
  .object({ from: instant, to: instant })
  .refine(
    (v) =>
      !isWindow({ from: v.from, until: v.to }) ||
      (v.to > v.from && v.to.getTime() - v.from.getTime() <= MAX_WINDOW_MS),
    {
      message: 'Choose a period of up to 31 days',
      path: ['to'],
    },
  );

// ------------------------------------------------------------------------------ pass secrets

export interface PassSecret {
  /** 32 random bytes, base64url (43 characters). Encoded in the QR code. */
  token: string;
  /** 8 characters from CODE_ALPHABET. */
  code: string;
}

export function newPassSecret(): PassSecret {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return { token: randomBytes(32).toString('base64url'), code };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only hashes are stored. Tokens are unique on their own (256 random bits). */
export const hashToken = (token: string) => sha256(`token:${token}`);
/** Codes are short, so they are bound to the property they are valid at. */
export const hashCode = (propertyId: string, code: string) =>
  sha256(`code:${propertyId}:${normaliseCode(code)}`);

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

// ------------------------------------------------------------------------------ validity

export interface PassState {
  passRevoked: boolean;
  invitationStatus: 'ACTIVE' | 'REVOKED';
  validFrom: Date;
  validUntil: Date;
  maxEntries: number;
  entriesUsed: number;
  /** False when the resident who registered the visitor no longer lives at the unit. */
  hostStillResident: boolean;
}

/**
 * Why a pass cannot be used now, or null when it can. Checked when a guard scans and again,
 * under a row lock, when the visitor is admitted. Stale access never wins: a revoked invitation,
 * a host who moved out or a used-up allowance all refuse entry.
 */
export function passRejection(state: PassState, now: Date): PassRejectionReason | null {
  if (state.passRevoked || state.invitationStatus === 'REVOKED') return 'REVOKED';
  if (now < state.validFrom) return 'NOT_YET_VALID';
  if (now > state.validUntil) return 'EXPIRED';
  if (state.entriesUsed >= state.maxEntries) return 'NO_ENTRIES_LEFT';
  if (!state.hostStillResident) return 'HOST_NO_LONGER_RESIDENT';
  return null;
}
