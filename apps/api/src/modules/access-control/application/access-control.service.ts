import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import { type Entitlement, entitled } from '../domain/entitlements';
import { type Permission, permissionScope } from '../domain/permissions';
import {
  type AccessScope,
  type Grant,
  hasCoveringGrant,
  isGrantEffective,
  type OrganisationStatus,
  type PropertyStatus,
  permissionsAt,
  permissionsForAssignment,
  propertiesWithPermission,
} from '../domain/policy';
import { ROLE_KEYS, ROLES, type RoleDefinition, roleDefinition } from '../domain/roles';

/** What a request may do at one scope. Resolved per request, never cached. */
export interface OrganisationAccess {
  userId: string;
  organisationId: string;
  /** Set on property- and unit-scoped routes: the property the permissions apply to. */
  propertyId?: string;
  /** Set on unit-scoped routes. */
  unitId?: string;
  permissions: ReadonlySet<Permission>;
  /**
   * Holds a privileged role here (organisation admin, finance officer): changes need a session
   * verified with a second factor where MFA is enforced (rule 7).
   */
  privileged?: boolean;
}

export interface LoadedGrants {
  /** The organisation's status; a lapsed subscription reads as SUSPENDED (read-only). */
  organisationStatus: OrganisationStatus;
  /** What the subscription allows (rule 5). */
  entitlement: Entitlement;
  /** All of the user's memberships in the organisation, at every scope. */
  grants: Grant[];
  /** Present when a property was asked for: its status, or null if it is not in the organisation. */
  property?: { status: PropertyStatus } | null;
  /** Present when a unit was asked for: whether it belongs to that property. */
  unitInProperty?: boolean;
}

/** Someone who can be given work at a property (see usersWithPropertyPermission). */
export interface PermissionHolder {
  userId: string;
  displayName: string;
}

export interface GrantRepository {
  /**
   * Memberships plus derived resident grants (OWNER / TENANT / HOUSEHOLD_MEMBER, scope UNIT,
   * valid today in the property's time zone). Null when the organisation does not exist.
   */
  loadGrants(
    userId: string,
    organisationId: string,
    propertyId?: string,
    unitId?: string,
  ): Promise<LoadedGrants | null>;
  /**
   * ACTIVE users with an ACTIVE membership of one of the roles, granted for the whole
   * organisation or for the property, whose window has not ended. Effectiveness is checked again
   * by the policy.
   */
  membershipHolders(
    organisationId: string,
    propertyId: string,
    roles: readonly string[],
  ): Promise<PermissionHolder[]>;
}
export const GRANT_REPOSITORY = Symbol('GRANT_REPOSITORY');

/** Permissions at a scope, as far as the subscription allows. */
function entitledPermissions(
  loaded: LoadedGrants,
  scope: AccessScope,
  now: Date,
): ReadonlySet<Permission> {
  return entitled(
    permissionsAt(loaded.grants, loaded.organisationStatus, scope, now),
    loaded.entitlement,
  );
}

const PRIVILEGED_ROLES = new Set(['ORGANISATION_ADMIN', 'FINANCE_OFFICER']);

/** ACCESS_CONTROL rule 7: an effective organisation admin or finance officer grant. */
function isPrivileged(loaded: LoadedGrants, now: Date): boolean {
  return loaded.grants.some((g) => PRIVILEGED_ROLES.has(g.role) && isGrantEffective(g, now));
}

const forbidden = () =>
  new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action');

/**
 * Policy evaluation (docs/security/ACCESS_CONTROL.md). Grants are read from the database on
 * every request, so suspensions, revocations and expiry take effect on the next request.
 */
@Injectable()
export class AccessControlService {
  constructor(
    @Inject(GRANT_REPOSITORY) private readonly grants: GrantRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Organisation-scoped permission check.
   *   - organisation missing, or caller holds no effective membership in it -> 404, so
   *     outsiders cannot discover which organisations exist;
   *   - member without the permission -> 403.
   */
  async authorise(
    userId: string,
    organisationId: string,
    permission: Permission,
  ): Promise<OrganisationAccess> {
    if (permissionScope(permission) !== 'organisation') {
      throw new Error(`${permission} is not organisation-scoped`);
    }
    const access = await this.resolve(userId, organisationId);
    if (!access) throw new ApiError(404, 'NOT_FOUND', 'Organisation not found');
    if (!access.permissions.has(permission)) throw forbidden();
    return access;
  }

  /**
   * Property-scoped permission check.
   *   - property not in the organisation, or no effective grant covering it (an organisation
   *     grant or a grant on this property) -> 404: a manager of P1 cannot tell that P2 exists;
   *   - covered but without the permission -> 403.
   */
  async authoriseProperty(
    userId: string,
    organisationId: string,
    propertyId: string,
    permission: Permission,
  ): Promise<OrganisationAccess> {
    if (permissionScope(permission) !== 'property') {
      throw new Error(`${permission} is not property-scoped`);
    }
    const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');
    const loaded = await this.grants.loadGrants(userId, organisationId, propertyId);
    if (!loaded?.property) throw notFound();
    const now = this.clock.now();
    const scope: AccessScope = {
      type: 'PROPERTY',
      propertyId,
      propertyStatus: loaded.property.status,
    };
    if (!hasCoveringGrant(loaded.grants, scope, now)) throw notFound();
    const permissions = entitledPermissions(loaded, scope, now);
    if (!permissions.has(permission)) throw forbidden();
    return {
      userId,
      organisationId,
      propertyId,
      permissions,
      privileged: isPrivileged(loaded, now),
    };
  }

  /**
   * Unit-scoped permission check. Covered by an organisation grant, a grant on the unit's
   * property, or a (derived) grant on the unit itself. Unit not in that property, or not covered
   * -> 404 (a resident of U1 cannot tell that U2 exists); covered without the permission -> 403.
   */
  async authoriseUnit(
    userId: string,
    organisationId: string,
    propertyId: string,
    unitId: string,
    permission: Permission,
  ): Promise<OrganisationAccess> {
    if (permissionScope(permission) !== 'unit') throw new Error(`${permission} is not unit-scoped`);
    const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');
    const loaded = await this.grants.loadGrants(userId, organisationId, propertyId, unitId);
    if (!loaded?.property || !loaded.unitInProperty) throw notFound();
    const now = this.clock.now();
    const scope: AccessScope = {
      type: 'UNIT',
      unitId,
      propertyId,
      propertyStatus: loaded.property.status,
    };
    if (!hasCoveringGrant(loaded.grants, scope, now)) throw notFound();
    const permissions = entitledPermissions(loaded, scope, now);
    if (!permissions.has(permission)) throw forbidden();
    return {
      userId,
      organisationId,
      propertyId,
      unitId,
      permissions,
      privileged: isPrivileged(loaded, now),
    };
  }

  /**
   * Whether a user holds a property permission at a property right now (for checks on someone
   * other than the caller, e.g. that a work order's assignee may do the work).
   */
  async holdsPropertyPermission(
    userId: string,
    organisationId: string,
    propertyId: string,
    permission: Permission,
  ): Promise<boolean> {
    if (permissionScope(permission) !== 'property') {
      throw new Error(`${permission} is not property-scoped`);
    }
    const loaded = await this.grants.loadGrants(userId, organisationId, propertyId);
    if (!loaded?.property) return false;
    const scope: AccessScope = {
      type: 'PROPERTY',
      propertyId,
      propertyStatus: loaded.property.status,
    };
    return entitledPermissions(loaded, scope, this.clock.now()).has(permission);
  }

  /** Everyone who holds a property permission at the property through a membership, by name. */
  async usersWithPropertyPermission(
    organisationId: string,
    propertyId: string,
    permission: Permission,
  ): Promise<PermissionHolder[]> {
    if (permissionScope(permission) !== 'property') {
      throw new Error(`${permission} is not property-scoped`);
    }
    const roles = ROLE_KEYS.filter(
      (key) =>
        !(ROLES[key] as RoleDefinition).derived &&
        (ROLES[key].permissions as readonly Permission[]).includes(permission),
    );
    const holders = await this.grants.membershipHolders(organisationId, propertyId, roles);
    const result: PermissionHolder[] = [];
    for (const holder of holders) {
      // The policy decides (lifecycle, archived property, validity), not the query.
      if (
        await this.holdsPropertyPermission(holder.userId, organisationId, propertyId, permission)
      ) {
        result.push({ userId: holder.userId, displayName: holder.displayName });
      }
    }
    return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Current derived resident grants of the user in the organisation (for "my units"). */
  async residentGrants(userId: string, organisationId: string): Promise<Grant[]> {
    const loaded = await this.grants.loadGrants(userId, organisationId);
    return (loaded?.grants ?? []).filter(
      (grant) => grant.scopeType === 'UNIT' && roleDefinition(grant.role)?.derived,
    );
  }

  /** The caller's organisation-level access, or null when they are not an effective member. */
  async resolve(userId: string, organisationId: string): Promise<OrganisationAccess | null> {
    const loaded = await this.grants.loadGrants(userId, organisationId);
    if (!loaded) return null;
    const now = this.clock.now();
    // A member is anyone with an effective grant at any scope (a property manager is a member
    // of the organisation, with only the baseline organisation permissions).
    if (!loaded.grants.some((grant) => isGrantEffective(grant, now))) return null;
    return {
      userId,
      organisationId,
      permissions: entitledPermissions(loaded, { type: 'ORGANISATION' }, now),
      privileged: isPrivileged(loaded, now),
    };
  }

  /** For list filtering: which properties a property permission reaches for this user. */
  async propertiesReachable(
    userId: string,
    organisationId: string,
    permission: Permission,
  ): Promise<{ all: true } | { all: false; propertyIds: string[] }> {
    const loaded = await this.grants.loadGrants(userId, organisationId);
    if (!loaded) return { all: false, propertyIds: [] };
    return propertiesWithPermission(
      loaded.grants,
      loaded.organisationStatus,
      permission,
      this.clock.now(),
    );
  }

  /**
   * Everything the user holds over a target scope, for anti-escalation when granting or
   * changing roles. Null when the target property is not in the organisation.
   */
  async permissionsForAssignment(
    userId: string,
    organisationId: string,
    target: { type: 'ORGANISATION' } | { type: 'PROPERTY'; propertyId: string },
  ): Promise<ReadonlySet<Permission> | null> {
    const propertyId = target.type === 'PROPERTY' ? target.propertyId : undefined;
    const loaded = await this.grants.loadGrants(userId, organisationId, propertyId);
    if (!loaded) return null;
    let scope: AccessScope = { type: 'ORGANISATION' };
    if (target.type === 'PROPERTY') {
      if (!loaded.property) return null;
      scope = {
        type: 'PROPERTY',
        propertyId: target.propertyId,
        propertyStatus: loaded.property.status,
      };
    }
    return permissionsForAssignment(
      loaded.grants,
      loaded.organisationStatus,
      scope,
      this.clock.now(),
    );
  }
}
