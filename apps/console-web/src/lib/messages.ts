import { ApiRequestError, NETWORK_ERROR } from './api-client';

/**
 * User-facing text for API error codes. Kept in one place so it can move to the localisation
 * catalogue unchanged. Unknown codes fall back to a generic message, never to raw server text
 * for 5xx errors.
 */
const ERROR_MESSAGES: Record<string, string> = {
  [NETWORK_ERROR]: 'We could not reach VEYRA. Check your connection and try again.',
  INVALID_CREDENTIALS: 'The email or password is incorrect.',
  EMAIL_ALREADY_REGISTERED: 'An account with this email already exists. Sign in instead.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  SERVICE_UNAVAILABLE: 'VEYRA is temporarily unavailable. Try again shortly.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_FOUND: 'This page does not exist or you do not have access to it.',
  SLUG_TAKEN: 'This web address is already taken. Choose another.',
  ROLE_NOT_ASSIGNABLE: 'You cannot give someone a role with more access than your own.',
  ALREADY_MEMBER: 'This person already has this role.',
  INVITATION_PENDING: 'An invitation for this email and role is already waiting to be accepted.',
  INVITATION_NOT_FOUND: 'This invitation link is not valid. Ask for a new one.',
  INVITATION_ALREADY_USED: 'This invitation has already been used.',
  INVITATION_REVOKED: 'This invitation was withdrawn. Ask for a new one.',
  INVITATION_EXPIRED: 'This invitation has expired. Ask for a new one.',
  INVITATION_EMAIL_MISMATCH:
    'This invitation was sent to a different email address. Sign in with that address.',
  ORIGIN_NOT_ALLOWED: 'This request was blocked for your security. Reload the page and try again.',
  VALIDATION_FAILED: 'Some fields need attention.',
  ROLE_SCOPE_MISMATCH: 'This role has to be given for a specific property.',
  PROPERTY_CODE_TAKEN: 'Another property already uses this code. Choose another.',
  BUILDING_CODE_TAKEN: 'Another building in this property already uses this code.',
  FLOOR_LEVEL_TAKEN: 'This building already has a floor at this level.',
  UNIT_NUMBER_TAKEN: 'This unit number is already used here.',
  COMMON_AREA_NAME_TAKEN: 'Another common area in this property already has this name.',
  STRUCTURE_IN_USE: 'This still has active units. Archive them first.',
  ARCHIVED: 'This is archived and can no longer be changed.',
  PROPERTY_FINANCIALS_LOCKED:
    'Country and currency can only change while the property is being set up.',
  INVALID_STATE_TRANSITION: 'This change is not possible in the current state.',
  PERSON_EMAIL_TAKEN: 'Another resident in this organisation already uses this email address.',
  PERSON_ALREADY_LINKED: 'This resident has already linked their profile to an account.',
  PERSON_HAS_NO_EMAIL: 'Add an email address to this resident before inviting them.',
  PLATE_TAKEN: 'A vehicle with this plate is already registered at this property.',
  OWNERSHIP_CONFLICT:
    'Owners are already recorded from this date or later. Void that change first if it was a mistake.',
  TENANCY_OVERLAP: 'This unit already has a tenancy during that period.',
  HOUSEHOLD_OVERLAP: 'This person is already in the household during that period.',
  INVALID_PERIOD: 'The end date cannot be before the start date.',
  VOIDED: 'This record was voided and can no longer be changed.',
  RESIDENCY_RULE_VIOLATED:
    'This change would leave the records inconsistent: owner shares must add up to one, and periods cannot overlap.',
  PASS_NOT_VALID: 'This pass can no longer be used. Check it again.',
  WALK_IN_NEEDS_APPROVAL: 'A visitor without a pass needs a resident to approve them first.',
  WALK_IN_NOT_APPROVED:
    'This visitor has not been approved, or the approval has already been used or has lapsed.',
  WALK_IN_NOT_PENDING: 'This request has already been answered.',
  WALK_IN_EXPIRED: 'This request expired before it was answered.',
  TOO_MANY_WALK_IN_REQUESTS:
    'This unit already has several requests waiting. Wait for an answer or cancel one first.',
  VISIT_ALREADY_DEPARTED: 'This departure has already been recorded.',
};

const GENERIC = 'Something went wrong. Try again, and contact support if it keeps happening.';

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return ERROR_MESSAGES[error.code] ?? (error.status >= 500 ? GENERIC : error.message || GENERIC);
  }
  return GENERIC;
}

/** Field-level messages from a VALIDATION_FAILED response, keyed by field path. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiRequestError) || error.code !== 'VALIDATION_FAILED') return {};
  const result: Record<string, string> = {};
  for (const detail of error.details) result[detail.path] ??= detail.message;
  return result;
}

export const ROLE_LABELS: Record<string, string> = {
  ORGANISATION_ADMIN: 'Organisation admin',
  FINANCE_OFFICER: 'Finance officer',
  PROPERTY_MANAGER: 'Property manager',
};

/** Roles that can be given for the whole organisation (property managers are per property). */
export const ORGANISATION_ROLES = ['FINANCE_OFFICER', 'ORGANISATION_ADMIN'] as const;

export const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

/** Turns an enum value such as FUNCTION_ROOM into readable text: "Function room". */
export function enumLabel(value: string): string {
  const text = value.toLowerCase().replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const PROPERTY_TYPES = [
  'CONDOMINIUM',
  'APARTMENT_COMPLEX',
  'GATED_COMMUNITY',
  'MIXED_USE',
  'OTHER',
] as const;
export const UNIT_TYPES = [
  'APARTMENT',
  'PENTHOUSE',
  'STUDIO',
  'DUPLEX',
  'VILLA',
  'TOWNHOUSE',
  'SHOP',
  'OFFICE',
  'STORAGE',
  'OTHER',
] as const;
export const HOUSEHOLD_RELATIONSHIPS = [
  'SPOUSE_OR_PARTNER',
  'CHILD',
  'PARENT',
  'OTHER_RELATIVE',
  'DOMESTIC_STAFF',
  'OTHER',
] as const;

const RESIDENT_ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  TENANT: 'Tenant',
  HOUSEHOLD_MEMBER: 'Household member',
};

export const residentRoleLabel = (role: string) => RESIDENT_ROLE_LABELS[role] ?? enumLabel(role);

export const COMMON_AREA_TYPES = [
  'LOBBY',
  'POOL',
  'GYM',
  'CLUBHOUSE',
  'FUNCTION_ROOM',
  'SPORTS_FACILITY',
  'PLAYGROUND',
  'GARDEN',
  'PARKING',
  'OTHER',
] as const;
