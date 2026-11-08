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
};

export const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;
