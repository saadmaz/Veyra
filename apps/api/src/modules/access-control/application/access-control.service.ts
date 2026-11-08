import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
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

/** What a request may do at one scope. Resolved per request, never cached. */
export interface OrganisationAccess {
  userId: string;
  organisationId: string;
  /** Set on property-scoped routes: the property the permissions apply to. */
  propertyId?: string;
  permissions: ReadonlySet<Permission>;
}

export interface LoadedGrants {
  organisationStatus: OrganisationStatus;
  /** All of the user's memberships in the organisation, at every scope. */
  grants: Grant[];
  /** Present when a property was asked for: its status, or null if it is not in the organisation. */
  property?: { status: PropertyStatus } | null;
}

export interface GrantRepository {
  /** Null when the organisation does not exist. */
  loadGrants(
    userId: string,
    organisationId: string,
    propertyId?: string,
  ): Promise<LoadedGrants | null>;
}
export const GRANT_REPOSITORY = Symbol('GRANT_REPOSITORY');

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
      throw new Error(`${permission} is property-scoped; use authoriseProperty`);
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
      throw new Error(`${permission} is organisation-scoped; use authorise`);
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
    const permissions = permissionsAt(loaded.grants, loaded.organisationStatus, scope, now);
    if (!permissions.has(permission)) throw forbidden();
    return { userId, organisationId, propertyId, permissions };
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
      permissions: permissionsAt(
        loaded.grants,
        loaded.organisationStatus,
        { type: 'ORGANISATION' },
        now,
      ),
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
