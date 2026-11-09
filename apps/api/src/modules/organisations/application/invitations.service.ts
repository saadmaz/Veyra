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
  AccessControlService,
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
  ORGANISATIONS_REPOSITORY,
  type OrganisationRecord,
  type OrganisationsRepository,
  type Page,
  type PageRequest,
} from './ports';

/** Pseudo-role of invitations that link a resident profile instead of granting a membership. */
export const RESIDENT_ROLE = 'RESIDENT';

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
    private readonly accessControl: AccessControlService,
  ) {}

  async create(
    access: OrganisationAccess,
    input: CreateInvitationInput,
    meta: RequestMeta,
  ): Promise<IssuedInvitation> {
    const scope =
      input.propertyId === undefined
        ? { scopeType: 'ORGANISATION' as const, scopeId: access.organisationId }
        : { scopeType: 'PROPERTY' as const, scopeId: input.propertyId };

    if (!roleDefinition(input.role)?.grantableAt.includes(scope.scopeType)) {
      throw new ApiError(
        422,
        'ROLE_SCOPE_MISMATCH',
        scope.scopeType === 'ORGANISATION'
          ? 'This role must be given for a specific property'
          : 'This role cannot be limited to a single property',
      );
    }
    // Anti-escalation: you can only invite to roles whose permissions you hold over the target.
    const held = await this.accessControl.permissionsForAssignment(
      access.userId,
      access.organisationId,
      scope.scopeType === 'PROPERTY'
        ? { type: 'PROPERTY', propertyId: scope.scopeId }
        : { type: 'ORGANISATION' },
    );
    if (!held) throw new ApiError(404, 'NOT_FOUND', 'Property not found');
    if (!canAssignRole(held, input.role, scope.scopeType)) {
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
                m.role === input.role &&
                m.scopeType === scope.scopeType &&
                m.scopeId === scope.scopeId &&
                isGrantEffective(m, now),
            );
            if (alreadyHasRole) {
              throw new ApiError(409, 'ALREADY_MEMBER', 'This person already has this role');
            }
          }

          const pending = await uow.findPendingInvitation(
            input.email,
            input.role,
            scope.scopeType,
            scope.scopeId,
          );
          if (pending) {
            if (invitationStatus(pending, now) === 'PENDING') throw new InvitationPendingError();
            // Expired but never answered: retire it so a fresh one can be issued.
            await uow.revokeInvitation(pending.id, now);
          }

          const invitation = await uow.createInvitation({
            email: input.email,
            role: input.role,
            ...scope,
            tokenHash: hashOpaqueToken(token),
            expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
            invitedById: access.userId,
          });
          await uow.audit({
            action: 'invitation.created',
            resourceType: 'invitation',
            resourceId: invitation.id,
            metadata: { role: input.role, scopeType: scope.scopeType },
          });
          return { invitation, token };
        },
      );
    } catch (error) {
      if (error instanceof InvitationPendingError) {
        throw new ApiError(
          409,
          'INVITATION_PENDING',
          'An invitation for this email, role and scope is already pending',
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
  ): Promise<{ organisation: OrganisationRecord; role: string }> {
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
    const isResident = invitation.personId !== null;
    if (
      !isResident &&
      !roleDefinition(invitation.role)?.grantableAt.includes(invitation.scopeType)
    ) {
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

        if (invitation.personId) {
          // Resident invitation: link the profile; access then derives from its records.
          const result = await uow.linkPerson(invitation.personId, user.userId);
          if (result === 'PERSON_ALREADY_LINKED') {
            throw new ApiError(
              409,
              'PERSON_ALREADY_LINKED',
              'This resident profile is already linked to an account',
            );
          }
          if (result === 'USER_ALREADY_LINKED') {
            throw new ApiError(
              409,
              'USER_ALREADY_LINKED',
              'Your account is already linked to another resident profile here',
            );
          }
          await uow.audit({
            action: 'invitation.accepted',
            resourceType: 'invitation',
            resourceId: invitation.id,
          });
          await uow.audit({
            action: 'person.linked',
            resourceType: 'person',
            resourceId: invitation.personId,
          });
          return { organisation, role: 'RESIDENT' };
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
        return { organisation, role: membership.role };
      },
    );
  }

  /**
   * Invites a resident to link their profile to a login. The invitation goes to the profile's
   * email; accepting it links the profile (never a membership). Owner, tenant and household
   * access then follows from the profile's records.
   */
  async createResidentInvitation(
    access: OrganisationAccess,
    personId: string,
    meta: RequestMeta,
  ): Promise<IssuedInvitation> {
    const now = this.clock.now();
    const token = generateOpaqueToken();
    try {
      return await this.repository.inOrganisation(
        access.organisationId,
        access.userId,
        meta,
        async (uow) => {
          const person = await uow.getPerson(personId);
          if (!person) throw new ApiError(404, 'NOT_FOUND', 'Resident not found');
          if (person.status !== 'ACTIVE') {
            throw new ApiError(409, 'ARCHIVED', 'This resident profile is archived');
          }
          if (person.userId) {
            throw new ApiError(
              409,
              'PERSON_ALREADY_LINKED',
              'This resident profile is already linked to an account',
            );
          }
          if (!person.email) {
            throw new ApiError(
              422,
              'PERSON_HAS_NO_EMAIL',
              'Add an email address to the resident profile before inviting them',
            );
          }

          const scope = { scopeType: 'ORGANISATION' as const, scopeId: access.organisationId };
          const pending = await uow.findPendingInvitation(
            person.email,
            RESIDENT_ROLE,
            scope.scopeType,
            scope.scopeId,
          );
          if (pending) {
            if (invitationStatus(pending, now) === 'PENDING') throw new InvitationPendingError();
            await uow.revokeInvitation(pending.id, now);
          }

          const invitation = await uow.createInvitation({
            email: person.email,
            role: RESIDENT_ROLE,
            ...scope,
            personId,
            tokenHash: hashOpaqueToken(token),
            expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
            invitedById: access.userId,
          });
          await uow.audit({
            action: 'invitation.created',
            resourceType: 'invitation',
            resourceId: invitation.id,
            metadata: { role: RESIDENT_ROLE },
          });
          return { invitation, token };
        },
      );
    } catch (error) {
      if (error instanceof InvitationPendingError) {
        throw new ApiError(
          409,
          'INVITATION_PENDING',
          'An invitation for this resident is already pending',
        );
      }
      throw error;
    }
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
