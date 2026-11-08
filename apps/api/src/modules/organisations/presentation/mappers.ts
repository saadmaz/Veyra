import type { InvitationDto, MembershipDto, OrganisationDto } from '@veyra/api-contracts';
import type {
  InvitationRecord,
  MembershipWithUser,
  OrganisationRecord,
} from '../application/ports';
import { invitationStatus } from '../domain/organisation-rules';

export function toOrganisationDto(organisation: OrganisationRecord): OrganisationDto {
  return {
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    countryCode: organisation.countryCode,
    defaultCurrency: organisation.defaultCurrency,
    defaultTimeZone: organisation.defaultTimeZone,
    status: organisation.status,
    createdAt: organisation.createdAt.toISOString(),
  };
}

export function toMembershipDto(membership: MembershipWithUser): MembershipDto {
  return {
    id: membership.id,
    userId: membership.userId,
    email: membership.user.email,
    displayName: membership.user.displayName,
    role: membership.role,
    scopeType: membership.scopeType,
    scopeId: membership.scopeId,
    status: membership.status,
    validFrom: membership.validFrom.toISOString(),
    validUntil: membership.validUntil?.toISOString() ?? null,
  };
}

/** Never includes the token or its hash. */
export function toInvitationDto(invitation: InvitationRecord, now: Date): InvitationDto {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitationStatus(invitation, now),
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
  };
}
