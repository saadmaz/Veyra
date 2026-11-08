import { isReadOnlyPermission, type Permission, permissionScope } from './permissions';
import { type RoleDefinition, roleDefinition, type ScopeType } from './roles';

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type OrganisationStatus =
  | 'PENDING_ONBOARDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'OFFBOARDING'
  | 'ARCHIVED';
export type PropertyStatus = 'ONBOARDING' | 'ACTIVE' | 'ARCHIVED';

export interface Grant {
  role: string;
  scopeType: ScopeType;
  scopeId: string;
  status: MembershipStatus;
  validFrom: Date;
  validUntil: Date | null;
}

/** Where a permission set is evaluated. */
export type AccessScope =
  | { type: 'ORGANISATION' }
  | { type: 'PROPERTY'; propertyId: string; propertyStatus: PropertyStatus };

/**
 * Every effective member may read the organisation's basic profile (name, country, currency),
 * whatever their scope: a property manager's console must be able to name the organisation.
 */
const MEMBER_BASELINE: readonly Permission[] = ['organisation.profile.read'];

/** ACCESS_CONTROL rule 2: ACTIVE and validFrom <= now < validUntil (UTC instants). */
export function isGrantEffective(grant: Grant, now: Date): boolean {
  return (
    grant.status === 'ACTIVE' &&
    grant.validFrom.getTime() <= now.getTime() &&
    (grant.validUntil === null || now.getTime() < grant.validUntil.getTime())
  );
}

/**
 * Whether a grant covers the scope. Inheritance flows downwards only: an organisation grant
 * covers every property, a property grant covers only its own property, and nothing covers the
 * organisation except an organisation grant.
 */
function covers(grant: Grant, scope: AccessScope): boolean {
  if (grant.scopeType === 'ORGANISATION') return true;
  return (
    scope.type === 'PROPERTY' &&
    grant.scopeType === 'PROPERTY' &&
    grant.scopeId === scope.propertyId
  );
}

/** True when at least one effective grant covers the scope ("is this caller in scope?"). */
export function hasCoveringGrant(grants: readonly Grant[], scope: AccessScope, now: Date): boolean {
  return grants.some((grant) => isGrantEffective(grant, now) && covers(grant, scope));
}

/**
 * Permissions of one user at one scope.
 *
 * - Only effective grants that cover the scope count; unknown role keys grant nothing.
 * - Only permissions evaluated at that scope are returned (organisation permissions at the
 *   organisation, property permissions at a property), so a property-scoped role can never
 *   produce organisation-wide rights.
 * - Lifecycle (ACCESS_CONTROL rule 4): an ARCHIVED organisation grants nothing; a SUSPENDED or
 *   OFFBOARDING organisation, or an ARCHIVED property, keeps only read permissions.
 */
export function permissionsAt(
  grants: readonly Grant[],
  organisationStatus: OrganisationStatus,
  scope: AccessScope,
  now: Date,
): Set<Permission> {
  const permissions = new Set<Permission>();
  if (organisationStatus === 'ARCHIVED') return permissions;
  const wanted = scope.type === 'ORGANISATION' ? 'organisation' : 'property';

  for (const grant of grants) {
    if (!isGrantEffective(grant, now) || !covers(grant, scope)) continue;
    for (const permission of roleDefinition(grant.role)?.permissions ?? []) {
      if (permissionScope(permission) === wanted) permissions.add(permission);
    }
  }
  if (scope.type === 'ORGANISATION' && grants.some((grant) => isGrantEffective(grant, now))) {
    for (const permission of MEMBER_BASELINE) permissions.add(permission);
  }

  const readOnly =
    organisationStatus === 'SUSPENDED' ||
    organisationStatus === 'OFFBOARDING' ||
    (scope.type === 'PROPERTY' && scope.propertyStatus === 'ARCHIVED');
  if (readOnly) {
    for (const permission of permissions) {
      if (!isReadOnlyPermission(permission)) permissions.delete(permission);
    }
  }
  return permissions;
}

/** Organisation-level permissions (kept as a named helper for readability at call sites). */
export function organisationPermissions(
  grants: readonly Grant[],
  organisationStatus: OrganisationStatus,
  now: Date,
): Set<Permission> {
  return permissionsAt(grants, organisationStatus, { type: 'ORGANISATION' }, now);
}

/**
 * Which properties a permission reaches, for filtering lists: all of them when an organisation
 * grant carries it, otherwise exactly the properties whose grants carry it.
 */
export function propertiesWithPermission(
  grants: readonly Grant[],
  organisationStatus: OrganisationStatus,
  permission: Permission,
  now: Date,
): { all: true } | { all: false; propertyIds: string[] } {
  if (organisationStatus === 'ARCHIVED') return { all: false, propertyIds: [] };
  const carries = (grant: Grant) =>
    isGrantEffective(grant, now) &&
    (roleDefinition(grant.role)?.permissions ?? []).includes(permission);
  if (grants.some((grant) => grant.scopeType === 'ORGANISATION' && carries(grant))) {
    return { all: true };
  }
  const propertyIds = grants
    .filter((grant) => grant.scopeType === 'PROPERTY' && carries(grant))
    .map((grant) => grant.scopeId);
  return { all: false, propertyIds: [...new Set(propertyIds)] };
}

/**
 * Everything the actor holds over a target scope, for anti-escalation: all permissions (any
 * kind) of effective grants covering that scope. An organisation admin therefore holds the
 * property permissions of an organisation-wide role; a property manager of P1 holds nothing
 * over P2 or over the organisation as a whole.
 */
export function permissionsForAssignment(
  grants: readonly Grant[],
  organisationStatus: OrganisationStatus,
  scope: AccessScope,
  now: Date,
): Set<Permission> {
  const permissions = new Set<Permission>();
  // Granting roles is a change: nothing is assignable in a read-only organisation or property.
  if (organisationStatus !== 'ACTIVE' && organisationStatus !== 'PENDING_ONBOARDING') {
    return permissions;
  }
  if (scope.type === 'PROPERTY' && scope.propertyStatus === 'ARCHIVED') return permissions;
  for (const grant of grants) {
    if (!isGrantEffective(grant, now) || !covers(grant, scope)) continue;
    for (const permission of roleDefinition(grant.role)?.permissions ?? []) {
      permissions.add(permission);
    }
  }
  return permissions;
}

/**
 * Anti-escalation (ACCESS_CONTROL section 5): an actor may grant or change a role only if they
 * hold every permission that role carries (see permissionsForAssignment), and only at a scope
 * the role allows.
 */
export function canAssignRole(
  actorPermissions: ReadonlySet<Permission>,
  role: string,
  scopeType: ScopeType,
  lookup: (key: string) => RoleDefinition | undefined = roleDefinition,
): boolean {
  const definition = lookup(role);
  if (!definition?.grantableAt.includes(scopeType)) return false;
  return definition.permissions.every((permission) => actorPermissions.has(permission));
}
