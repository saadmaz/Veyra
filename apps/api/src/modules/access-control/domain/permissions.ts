/**
 * Permission registry (docs/security/ACCESS_CONTROL.md). Format: <module>.<resource>.<action>.
 * A permission exists here only once an endpoint uses it; modules add theirs with their first
 * real use case. Routes reference these through @RequirePermission, and startup fails on any
 * string that is not registered here.
 */
export const PERMISSIONS = [
  /** View the organisation's profile and settings. */
  'organisation.profile.read',
  /** Change organisation settings (name, default time zone). */
  'organisation.settings.manage',
  /** List members and their roles. */
  'organisation.member.read',
  /** Suspend, reactivate or revoke memberships. */
  'organisation.member.manage',
  /** Create, list and revoke invitations. */
  'organisation.member.invite',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const REGISTERED: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return REGISTERED.has(value);
}

/**
 * Read-only permissions stay available while an organisation is SUSPENDED or OFFBOARDING
 * (ACCESS_CONTROL rule 4). By convention their action is "read".
 */
export function isReadOnlyPermission(permission: Permission): boolean {
  return permission.endsWith('.read');
}
