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
  /** Add a property to the organisation. */
  'organisation.property.create',
  /** View a property's profile. Property-scoped: evaluated against the route's :propertyId. */
  'property.profile.read',
  /** Edit a property's name, type, address and time zone (country and currency while onboarding). */
  'property.settings.manage',
  /** Activate or archive a property. Archiving archives its whole structure. */
  'property.lifecycle.manage',
  /** View buildings, floors, units and common areas. */
  'property.structure.read',
  /** Create, edit and archive buildings, floors, units and common areas. */
  'property.structure.manage',
  /** View a unit and its own details. Unit-scoped: evaluated against the route's :unitId. */
  'unit.profile.read',
  /** See who currently owns, rents and lives in a unit (names and roles, no contact details). */
  'unit.residents.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionScope = 'organisation' | 'property' | 'unit';

/**
 * Where a permission is evaluated. `property.*` permissions apply to one property (the route's
 * :propertyId) and are granted by organisation-scoped grants or grants on that property.
 * Everything else applies to the whole organisation and only organisation-scoped grants count.
 */
export function permissionScope(permission: Permission): PermissionScope {
  if (permission.startsWith('unit.')) return 'unit';
  return permission.startsWith('property.') ? 'property' : 'organisation';
}

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
