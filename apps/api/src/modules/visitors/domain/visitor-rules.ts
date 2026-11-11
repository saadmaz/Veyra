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

// ------------------------------------------------------------------------------ walk-ins (Part 3)

/** Residents have this long to answer a guard's request. */
export const WALK_IN_ANSWER_MS = 10 * 60_000;
/** After an approval, the guard has this long to admit (the database checks the same limit). */
export const WALK_IN_APPROVAL_MS = 15 * 60_000;
/** Open requests per unit at once, so a unit cannot be flooded with requests. */
export const MAX_PENDING_WALK_INS_PER_UNIT = 5;

export const walkInRequestSchema = walkInSchema.extend({ unitId: z.uuid() });
export type WalkInRequestInput = z.infer<typeof walkInRequestSchema>;

export type WalkInStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'EXPIRED';

/** A stored request's status as seen now: an unanswered request past its deadline is EXPIRED. */
export function walkInStatus(
  request: { status: Exclude<WalkInStatus, 'EXPIRED'>; expiresAt: Date },
  now: Date,
): WalkInStatus {
  return request.status === 'PENDING' && now > request.expiresAt ? 'EXPIRED' : request.status;
}

/** Why a guard cannot admit on this request now, or null when they can. */
export function walkInAdmissionProblem(
  request: {
    status: Exclude<WalkInStatus, 'EXPIRED'>;
    expiresAt: Date;
    decidedAt: Date | null;
    used: boolean;
  },
  now: Date,
): 'NOT_APPROVED' | 'APPROVAL_LAPSED' | 'ALREADY_USED' | null {
  if (walkInStatus(request, now) !== 'APPROVED' || !request.decidedAt) return 'NOT_APPROVED';
  if (request.used) return 'ALREADY_USED';
  if (now.getTime() > request.decidedAt.getTime() + WALK_IN_APPROVAL_MS) return 'APPROVAL_LAPSED';
  return null;
}

// ------------------------------------------------------------------------------ offline (Part 5)

/** How long a gate device may trust its offline list (owner decision, 2026-11-11). */
export const OFFLINE_TRUST_MS = 4 * 3_600_000;
/** Paper and offline entries older than this are refused: write an incident report instead. */
export const LATE_ENTRY_MAX_AGE_MS = 7 * 86_400_000;
/** Device clocks drift: entries up to this far in the future are accepted as "now". */
export const CLOCK_SKEW_MS = 5 * 60_000;

const lateEntrySchema = z
  .object({
    clientRef: z.uuid(),
    kind: z.enum(['ADMIT', 'DENY', 'WALK_IN', 'DEPART']),
    occurredAt: instant,
    gate,
    passId: z.uuid().optional(),
    code: z
      .string()
      .max(20)
      .transform(normaliseCode)
      .pipe(z.string().regex(CODE_PATTERN, 'Codes have 8 letters and digits'))
      .optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    category: category.optional(),
    visitorName: visitorName.optional(),
    vehiclePlate: plateSchema.optional(),
    unitId: z.uuid().optional(),
    visitId: z.uuid().optional(),
    departRef: z.uuid().optional(),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string, path: string) =>
      ctx.addIssue({ code: 'custom', message, path: [path] });
    const withPass = e.passId !== undefined || e.code !== undefined;
    if (e.kind === 'ADMIT' && !withPass) fail('An admission needs the pass or its code', 'passId');
    if (e.kind === 'DENY' && !e.reason) fail('A refusal needs a reason', 'reason');
    if (e.kind === 'DENY' && !withPass && !(e.category && e.visitorName))
      fail('For someone without a pass, give their name and category', 'visitorName');
    if (e.kind === 'WALK_IN' && !(e.category && e.visitorName))
      fail('A walk-in needs a name and category', 'visitorName');
    if (e.kind === 'DEPART' && (e.visitId === undefined) === (e.departRef === undefined))
      fail('A departure names the visit or the earlier entry (one of them)', 'visitId');
  });
export type LateEntryInput = z.infer<typeof lateEntrySchema>;

export const syncLateEntriesSchema = z.object({
  source: z.enum(['OFFLINE_SYNC', 'PAPER']),
  entries: z.array(lateEntrySchema).min(1).max(200),
});
export type SyncLateEntriesInput = z.infer<typeof syncLateEntriesSchema>;

export const reviewSchema = z.object({ note: z.string().trim().min(1).max(500).optional() });

export interface LateEntryState {
  invitationStatus: 'ACTIVE' | 'REVOKED';
  invitationRevokedAt: Date | null;
  passRevokedAt: Date | null;
  validFrom: Date;
  validUntil: Date;
  maxEntries: number;
  /** Admissions already recorded on the invitation (before this one). */
  entriesUsed: number;
  hostStillResident: boolean;
}

/**
 * Whether an admission recorded after the fact needs a supervisor's review: judged at the time
 * it happened, so a pass cancelled after the visitor came in is not flagged, and one cancelled
 * before is, even if the gate's offline copy did not know.
 */
export function lateAdmissionFlag(s: LateEntryState, at: Date): PassRejectionReason | null {
  const revokedBefore = (when: Date | null) => when !== null && when <= at;
  if (revokedBefore(s.invitationRevokedAt) || revokedBefore(s.passRevokedAt)) return 'REVOKED';
  if (at < s.validFrom) return 'NOT_YET_VALID';
  if (at > s.validUntil) return 'EXPIRED';
  if (s.entriesUsed >= s.maxEntries) return 'NO_ENTRIES_LEFT';
  if (!s.hostStillResident) return 'HOST_NO_LONGER_RESIDENT';
  return null;
}

/** Why a late entry is refused outright (nothing recorded), or null. */
export function lateEntryTimeProblem(
  occurredAt: Date,
  now: Date,
): 'TOO_OLD' | 'IN_THE_FUTURE' | null {
  if (occurredAt.getTime() > now.getTime() + CLOCK_SKEW_MS) return 'IN_THE_FUTURE';
  if (now.getTime() - occurredAt.getTime() > LATE_ENTRY_MAX_AGE_MS) return 'TOO_OLD';
  return null;
}
