import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { canAssignRole, isGrantEffective, type OrganisationAccess } from '../../access-control';
import {
  canTransitionMembership,
  type MembershipStatus,
  ORGANISATION_ADMIN_ROLE,
} from '../domain/organisation-rules';
import {
  type MembershipRecord,
  type MembershipWithUser,
  ORGANISATIONS_REPOSITORY,
  type OrganisationsRepository,
  type Page,
  type PageRequest,
} from './ports';

@Injectable()
export class MembershipsService {
  constructor(
    @Inject(ORGANISATIONS_REPOSITORY) private readonly repository: OrganisationsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(
    access: OrganisationAccess,
    page: PageRequest,
    meta: RequestMeta,
  ): Promise<Page<MembershipWithUser>> {
    return this.repository.inOrganisation(access.organisationId, access.userId, meta, (uow) =>
      uow.listMemberships(page),
    );
  }

  /**
   * Suspends, reactivates or revokes a membership. Rules:
   *   - only allowed transitions (REVOKED is final);
   *   - the actor must hold every permission of the target's role (no acting above your level);
   *   - the organisation always keeps at least one effective admin.
   * Takes effect on the member's next request: permissions are evaluated per request.
   */
  async changeStatus(
    access: OrganisationAccess,
    membershipId: string,
    status: MembershipStatus,
    meta: RequestMeta,
  ): Promise<MembershipRecord> {
    const now = this.clock.now();
    return this.repository.inOrganisation(
      access.organisationId,
      access.userId,
      meta,
      async (uow) => {
        const target = await uow.lockMembership(membershipId);
        if (!target) throw new ApiError(404, 'NOT_FOUND', 'Membership not found');
        if (target.status === status) return target;
        if (!canTransitionMembership(target.status, status)) {
          throw new ApiError(
            409,
            'INVALID_STATE_TRANSITION',
            `A ${target.status.toLowerCase()} membership cannot become ${status.toLowerCase()}`,
          );
        }
        if (!canAssignRole(access.permissions, target.role, target.scopeType)) {
          throw new ApiError(
            403,
            'ROLE_NOT_ASSIGNABLE',
            'You cannot manage members with this role',
          );
        }

        const removesAdmin =
          target.role === ORGANISATION_ADMIN_ROLE &&
          target.scopeType === 'ORGANISATION' &&
          isGrantEffective(target, now) &&
          status !== 'ACTIVE';
        if (removesAdmin) {
          const admins = await uow.lockAdminMemberships(ORGANISATION_ADMIN_ROLE);
          const remaining = admins.filter((m) => m.id !== target.id && isGrantEffective(m, now));
          if (remaining.length === 0) {
            throw new ApiError(
              409,
              'LAST_ADMIN',
              'An organisation must keep at least one active organisation admin',
            );
          }
        }

        const updated = await uow.setMembershipStatus(membershipId, status, access.userId, now);
        await uow.audit({
          action: 'membership.status_changed',
          resourceType: 'membership',
          resourceId: membershipId,
          metadata: { from: target.status, to: status, role: target.role },
        });
        return updated;
      },
    );
  }
}
