import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import { RATE_LIMITER, type RateLimiter } from '../../../platform/rate-limit/rate-limiter';
import type { RequestMeta } from '../../../platform/request-meta';
import { isGrantEffective, type OrganisationAccess } from '../../access-control';
import {
  type CreateOrganisationInput,
  ORGANISATION_ADMIN_ROLE,
  type UpdateOrganisationInput,
} from '../domain/organisation-rules';
import {
  ORGANISATIONS_REPOSITORY,
  type OrganisationRecord,
  type OrganisationsRepository,
  SlugTakenError,
} from './ports';

/** Self-service creation is open to any signed-in user, so it is rate limited per user. */
export const ORGANISATION_CREATION_LIMIT = { limit: 5, windowMs: 24 * 60 * 60 * 1000 } as const;

export interface MyOrganisation {
  organisation: OrganisationRecord;
  roles: string[];
}

@Injectable()
export class OrganisationsService {
  private readonly logger = new Logger(OrganisationsService.name);

  constructor(
    @Inject(ORGANISATIONS_REPOSITORY) private readonly repository: OrganisationsRepository,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Creates the organisation and makes the creator its first organisation admin. */
  async create(
    userId: string,
    input: CreateOrganisationInput,
    meta: RequestMeta,
  ): Promise<OrganisationRecord> {
    await this.enforceCreationLimit(userId);
    // The id is chosen first because RLS only admits the insert inside that tenant's context.
    const organisationId = randomUUID();
    try {
      return await this.repository.inOrganisation(organisationId, userId, meta, async (uow) => {
        const organisation = await uow.createOrganisation({ id: organisationId, ...input });
        const membership = await uow.grantMembership({
          userId,
          role: ORGANISATION_ADMIN_ROLE,
          scopeType: 'ORGANISATION',
          scopeId: organisationId,
          grantedById: userId,
        });
        await uow.audit({
          action: 'organisation.created',
          resourceType: 'organisation',
          resourceId: organisationId,
        });
        await uow.audit({
          action: 'membership.granted',
          resourceType: 'membership',
          resourceId: membership.id,
          metadata: { role: ORGANISATION_ADMIN_ROLE, via: 'organisation_creation' },
        });
        return organisation;
      });
    } catch (error) {
      if (error instanceof SlugTakenError) {
        throw new ApiError(409, 'SLUG_TAKEN', 'This organisation address is already in use');
      }
      throw error;
    }
  }

  /** Organisations where the user currently holds an effective membership. */
  async listMine(userId: string): Promise<MyOrganisation[]> {
    const now = this.clock.now();
    const rows = await this.repository.listForUser(userId);
    return rows
      .map(({ organisation, memberships, residentRoles }) => ({
        organisation,
        // Assigned roles (memberships) and roles derived today from residency records.
        roles: [
          ...new Set([
            ...memberships.filter((m) => isGrantEffective(m, now)).map((m) => m.role),
            ...residentRoles,
          ]),
        ].sort(),
      }))
      .filter((row) => row.roles.length > 0 && row.organisation.status !== 'ARCHIVED')
      .sort((a, b) => a.organisation.name.localeCompare(b.organisation.name));
  }

  async get(access: OrganisationAccess, meta: RequestMeta): Promise<OrganisationRecord> {
    const organisation = await this.repository.inOrganisation(
      access.organisationId,
      access.userId,
      meta,
      (uow) => uow.getOrganisation(),
    );
    if (!organisation) throw new ApiError(404, 'NOT_FOUND', 'Organisation not found');
    return organisation;
  }

  async update(
    access: OrganisationAccess,
    input: UpdateOrganisationInput,
    meta: RequestMeta,
  ): Promise<OrganisationRecord> {
    return this.repository.inOrganisation(
      access.organisationId,
      access.userId,
      meta,
      async (uow) => {
        const updated = await uow.updateOrganisation(input);
        await uow.audit({
          action: 'organisation.updated',
          resourceType: 'organisation',
          resourceId: access.organisationId,
          metadata: { fields: Object.keys(input).sort().join(',') },
        });
        return updated;
      },
    );
  }

  private async enforceCreationLimit(userId: string): Promise<void> {
    let state: { count: number; resetInMs: number };
    try {
      state = await this.limiter.hit(
        `org:create:user:${userId}`,
        ORGANISATION_CREATION_LIMIT.windowMs,
      );
    } catch (error) {
      this.logger.warn(
        `Rate limiter unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Temporarily unavailable. Try again shortly.');
    }
    if (state.count > ORGANISATION_CREATION_LIMIT.limit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many organisations created. Try again later.', {
        retryAfterSeconds: Math.max(1, Math.ceil(state.resetInMs / 1000)),
      });
    }
  }
}
