import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import type { Permission } from '../domain/permissions';
import {
  type Grant,
  isGrantEffective,
  type OrganisationStatus,
  organisationPermissions,
} from '../domain/policy';

/** What a request may do in one organisation. Resolved per request, never cached. */
export interface OrganisationAccess {
  userId: string;
  organisationId: string;
  permissions: ReadonlySet<Permission>;
}

export interface GrantRepository {
  /**
   * The organisation's status and all of the user's memberships in it, or null when the
   * organisation does not exist.
   */
  loadGrants(
    userId: string,
    organisationId: string,
  ): Promise<{ organisationStatus: OrganisationStatus; grants: Grant[] } | null>;
}
export const GRANT_REPOSITORY = Symbol('GRANT_REPOSITORY');

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Organisation not found');

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
   * Resolves the caller's access to an organisation and requires one permission.
   *   - organisation missing, or caller holds no effective membership in it -> 404, so
   *     outsiders cannot discover which organisations exist;
   *   - member without the permission -> 403.
   */
  async authorise(
    userId: string,
    organisationId: string,
    permission: Permission,
  ): Promise<OrganisationAccess> {
    const access = await this.resolve(userId, organisationId);
    if (!access) throw notFound();
    if (!access.permissions.has(permission)) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }
    return access;
  }

  /** The caller's access, or null when they are not an effective member. */
  async resolve(userId: string, organisationId: string): Promise<OrganisationAccess | null> {
    const loaded = await this.grants.loadGrants(userId, organisationId);
    if (!loaded) return null;
    const now = this.clock.now();
    if (!loaded.grants.some((grant) => isGrantEffective(grant, now))) return null;
    return {
      userId,
      organisationId,
      permissions: organisationPermissions(loaded.grants, loaded.organisationStatus, now),
    };
  }
}
