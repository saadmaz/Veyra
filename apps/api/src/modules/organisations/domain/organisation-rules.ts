import { isCountryCode } from '@veyra/domain';
import { z } from 'zod';
import { ROLE_KEYS, type RoleKey } from '../../access-control';

const TIME_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));
const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/** IANA zone such as "Asia/Karachi". "UTC" is accepted explicitly. */
export const timeZoneSchema = z
  .string()
  .refine((value) => value === 'UTC' || TIME_ZONES.has(value), 'Unknown IANA time zone');

const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use an ISO 3166-1 alpha-2 code')
  .refine(isCountryCode, 'Unknown country code');

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((code) => CURRENCIES.has(code), 'Unknown ISO 4217 currency code');

const nameSchema = z.string().trim().min(2).max(120);

export const createOrganisationSchema = z.object({
  name: nameSchema,
  /** URL-safe identifier: lower-case words joined by hyphens, 3-63 characters. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single hyphens')
    .min(3)
    .max(63),
  countryCode: countryCodeSchema,
  defaultCurrency: currencySchema,
  defaultTimeZone: timeZoneSchema,
});
export type CreateOrganisationInput = z.infer<typeof createOrganisationSchema>;

/**
 * Country and currency are fixed after creation: changing them would silently re-denominate
 * financial records. That needs a dedicated, audited migration path.
 */
export const updateOrganisationSchema = z
  .object({ name: nameSchema.optional(), defaultTimeZone: timeZoneSchema.optional() })
  .refine((value) => value.name !== undefined || value.defaultTimeZone !== undefined, {
    message: 'Provide at least one field to change',
  });
export type UpdateOrganisationInput = z.infer<typeof updateOrganisationSchema>;

export const createInvitationSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email({ message: 'Enter a valid email address' }))
    .transform((email) => email.toLowerCase()),
  role: z.enum(ROLE_KEYS as [RoleKey, ...RoleKey[]]),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({ token: z.string().min(1).max(128) });

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export const changeMembershipStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
});

/**
 * Allowed membership transitions. REVOKED is final: access is restored with a new invitation,
 * which leaves a clear audit trail.
 */
const TRANSITIONS: Readonly<Record<MembershipStatus, readonly MembershipStatus[]>> = {
  ACTIVE: ['SUSPENDED', 'REVOKED'],
  SUSPENDED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
};

export function canTransitionMembership(from: MembershipStatus, to: MembershipStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export function invitationStatus(
  invitation: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date,
): InvitationStatus {
  if (invitation.acceptedAt) return 'ACCEPTED';
  if (invitation.revokedAt) return 'REVOKED';
  return now.getTime() >= invitation.expiresAt.getTime() ? 'EXPIRED' : 'PENDING';
}

export const ORGANISATION_ADMIN_ROLE: RoleKey = 'ORGANISATION_ADMIN';

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
