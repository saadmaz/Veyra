import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import { RATE_LIMITER, type RateLimiter } from '../../../platform/rate-limit/rate-limiter';
import type { RequestMeta } from '../../../platform/request-meta';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isWellFormedOpaqueToken,
} from '../../../platform/security/opaque-token';
import {
  canAssignRole,
  isGrantEffective,
  type OrganisationAccess,
  roleDefinition,
} from '../../access-control';
import {
  type CreateInvitationInput,
  INVITATION_LIFETIME_MS,
  invitationStatus,
} from '../domain/organisation-rules';
import {
  InvitationPendingError,
  type InvitationRecord,
  type MembershipRecord,
  ORGANISATIONS_REPOSITORY,
  type OrganisationRecord,
  type OrganisationsRepository,
  type Page,
  type PageRequest,
} from './ports';

/** Acceptance attempts per user, so tokens cannot be guessed through the API. */
export const INVITATION_ACCEPT_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 } as const;

export interface IssuedInvitation {
  invitation: InvitationRecord;
  /**
   * Returned to the inviter exactly once; only its hash is stored. Until the notifications
   * module sends invitation emails, the inviter shares the acceptance link themselves.
   */
  token: string;
}

const invitationNotFound = () =>
  new ApiError(404, 'INVITATION_NOT_FOUND', 'This invitation link is not valid');

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    @Inject(ORGANISATIONS_REPOSITORY) private readonly repository: OrganisationsRepository,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    access: OrganisationAccess,
    input: CreateInvitationInput,
    meta: RequestMeta,
  ): Promise<IssuedInvitation> {
    // Anti-escalation: you can only invite to roles whose permissions you hold yourself.
    if (!canAssignRole(access.permissions, input.role, 'ORGANISATION')) {
      throw new ApiError(403, 'ROLE_NOT_ASSIGNABLE', 'You cannot invite members with this role');
    }
    const now = this.clock.now();
    const token = generateOpaqueToken();
    const existingUserId = await this.repository.findUserIdByEmail(input.email);

    try {
      return await this.repository.inOrganisation(
        access.organisationId,
        access.userId,
        meta,
        async (uow) => {
          if (existingUserId) {
            const memberships = await uow.findUserMemberships(existingUserId);
            const alreadyHasRole = memberships.some(
              (m) =>
                m.role === input.role && m.scopeType === 'ORGANISATION' && isGrantEffective(m, now),
            );
            if (alreadyHasRole) {
              throw new ApiError(409, 'ALREADY_MEMBER', 'This person already has this role');
            }
          }

          const pending = await uow.findPendingInvitation(input.email, input.role);
          if (pending) {
            if (invitationStatus(pending, now) === 'PENDING') throw new InvitationPendingError();
            // Expired but never answered: retire it so a fresh one can be issued.
            await uow.revokeInvitation(pending.id, now);
          }

          const invitation = await uow.createInvitation({
            email: input.email,
            role: input.role,
            scopeType: 'ORGANISATION',
            scopeId: access.organisationId,
            tokenHash: hashOpaqueToken(token),
            expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
            invitedById: access.userId,
          });
          await uow.audit({
            action: 'invitation.created',
            resourceType: 'invitation',
            resourceId: invitation.id,
            metadata: { role: input.role },
          });
          return { invitation, token };
        },
      );
    } catch (error) {
      if (error instanceof InvitationPendingError) {
        throw new ApiError(
          409,
          'INVITATION_PENDING',
          'An invitation for this email and role is already pending',
        );
      }
      throw error;
    }
  }

  list(
    access: OrganisationAccess,
    page: PageRequest,
    meta: RequestMeta,
  ): Promise<Page<InvitationRecord>> {
    return this.repository.inOrganisation(access.organisationId, access.userId, meta, (uow) =>
      uow.listInvitations(page),
    );
  }

  async revoke(access: OrganisationAccess, invitationId: string, meta: RequestMeta): Promise<void> {
    const now = this.clock.now();
    await this.repository.inOrganisation(
      access.organisationId,
      access.userId,
      meta,
      async (uow) => {
        const invitation = await uow.lockInvitation(invitationId);
        if (!invitation) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found');
        const status = invitationStatus(invitation, now);
        if (status === 'REVOKED') return;
        if (status === 'ACCEPTED') {
          throw new ApiError(
            409,
            'INVITATION_ALREADY_USED',
            'This invitation was accepted; manage the membership instead',
          );
        }
        await uow.revokeInvitation(invitationId, now);
        await uow.audit({
          action: 'invitation.revoked',
          resourceType: 'invitation',
          resourceId: invitationId,
        });
      },
    );
  }

  /**
   * Accepts an invitation for the signed-in user. The invitation is bound to an email address:
   * only an account with that address can accept it. The token is single use; concurrent
   * attempts are serialised by a conditional update.
   */
  async accept(
    user: { userId: string; email: string },
    token: string,
    meta: RequestMeta,
  ): Promise<{ organisation: OrganisationRecord; membership: MembershipRecord }> {
    await this.enforceAcceptLimit(user.userId);
    if (!isWellFormedOpaqueToken(token)) throw invitationNotFound();

    const tokenHash = hashOpaqueToken(token);
    const invitation = await this.repository.findInvitationByTokenHash(tokenHash);
    if (!invitation) throw invitationNotFound();

    const now = this.clock.now();
    const status = invitationStatus(invitation, now);
    if (status === 'ACCEPTED') {
      throw new ApiError(409, 'INVITATION_ALREADY_USED', 'This invitation has already been used');
    }
    if (status === 'REVOKED') {
      throw new ApiError(409, 'INVITATION_REVOKED', 'This invitation was withdrawn');
    }
    if (status === 'EXPIRED') {
      throw new ApiError(409, 'INVITATION_EXPIRED', 'This invitation has expired');
    }
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ApiError(
        403,
        'INVITATION_EMAIL_MISMATCH',
        'This invitation was sent to a different email address',
      );
    }
    if (!roleDefinition(invitation.role)?.grantableAt.includes(invitation.scopeType)) {
      throw new ApiError(409, 'INVITATION_INVALID', 'This invitation can no longer be accepted');
    }

    return this.repository.inOrganisation(
      invitation.organisationId,
      user.userId,
      meta,
      async (uow) => {
        const organisation = await uow.getOrganisation();
        if (!organisation || organisation.status === 'ARCHIVED') throw invitationNotFound();

        const accepted = await uow.markInvitationAccepted(
          invitation.id,
          tokenHash,
          user.userId,
          now,
        );
        if (!accepted) {
          throw new ApiError(
            409,
            'INVITATION_ALREADY_USED',
            'This invitation has already been used',
          );
        }
        const membership = await uow.grantMembership({
          userId: user.userId,
          role: invitation.role,
          scopeType: invitation.scopeType,
          scopeId: invitation.scopeId,
          grantedById: invitation.invitedById,
        });
        await uow.audit({
          action: 'invitation.accepted',
          resourceType: 'invitation',
          resourceId: invitation.id,
        });
        await uow.audit({
          action: 'membership.granted',
          resourceType: 'membership',
          resourceId: membership.id,
          metadata: { role: invitation.role, via: 'invitation' },
        });
        return { organisation, membership };
      },
    );
  }

  private async enforceAcceptLimit(userId: string): Promise<void> {
    let state: { count: number; resetInMs: number };
    try {
      state = await this.limiter.hit(
        `invitation:accept:user:${userId}`,
        INVITATION_ACCEPT_LIMIT.windowMs,
      );
    } catch (error) {
      this.logger.warn(
        `Rate limiter unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Temporarily unavailable. Try again shortly.');
    }
    if (state.count > INVITATION_ACCEPT_LIMIT.limit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
        retryAfterSeconds: Math.max(1, Math.ceil(state.resetInMs / 1000)),
      });
    }
  }
}
