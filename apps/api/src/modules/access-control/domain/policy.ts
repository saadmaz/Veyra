import { isReadOnlyPermission, type Permission } from './permissions';
import { type RoleDefinition, roleDefinition, type ScopeType } from './roles';

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type OrganisationStatus =
  | 'PENDING_ONBOARDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'OFFBOARDING'
  | 'ARCHIVED';

export interface Grant {
  role: string;
  scopeType: ScopeType;
  status: MembershipStatus;
  validFrom: Date;
  validUntil: Date | null;
}

/** ACCESS_CONTROL rule 2: ACTIVE and validFrom <= now < validUntil (UTC instants). */
export function isGrantEffective(grant: Grant, now: Date): boolean {
  return (
    grant.status === 'ACTIVE' &&
    grant.validFrom.getTime() <= now.getTime() &&
    (grant.validUntil === null || now.getTime() < grant.validUntil.getTime())
  );
}

/**
 * Organisation-level permissions of one user in one organisation.
 *
 * Only ORGANISATION-scoped grants count: scope inheritance flows downwards, so a property-scoped
 * role never yields organisation-wide permissions. Unknown role keys grant nothing. The
 * organisation's lifecycle limits the result (ACCESS_CONTROL rule 4).
 */
export function organisationPermissions(
  grants: readonly Grant[],
  organisationStatus: OrganisationStatus,
  now: Date,
): Set<Permission> {
  const permissions = new Set<Permission>();
  if (organisationStatus === 'ARCHIVED') return permissions;

  for (const grant of grants) {
    if (grant.scopeType !== 'ORGANISATION' || !isGrantEffective(grant, now)) continue;
    for (const permission of roleDefinition(grant.role)?.permissions ?? []) {
      permissions.add(permission);
    }
  }

  if (organisationStatus === 'SUSPENDED' || organisationStatus === 'OFFBOARDING') {
    for (const permission of permissions) {
      if (!isReadOnlyPermission(permission)) permissions.delete(permission);
    }
  }
  return permissions;
}

/**
 * Anti-escalation (ACCESS_CONTROL section 5): an actor may grant or change a role only if they
 * hold every permission that role carries, and only at a scope the role allows.
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
