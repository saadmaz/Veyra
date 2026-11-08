import type { RequestMeta } from '../../../platform/request-meta';
import type { Grant, OrganisationStatus, ScopeType } from '../../access-control';

export interface OrganisationRecord {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  defaultTimeZone: string;
  status: OrganisationStatus;
  createdAt: Date;
}

export interface MembershipRecord extends Grant {
  id: string;
  organisationId: string;
  userId: string;
  scopeId: string;
  createdAt: Date;
}

export interface MembershipWithUser extends MembershipRecord {
  user: { email: string; displayName: string };
}

export interface InvitationRecord {
  id: string;
  organisationId: string;
  email: string;
  role: string;
  scopeType: ScopeType;
  scopeId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedById: string;
  createdAt: Date;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface PageRequest {
  limit: number;
  cursor?: string | undefined;
}

export interface TenantAuditEvent {
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Operations inside one transaction scoped to one organisation (RLS context set). Every
 * mutation the service performs, including its audit record, commits or rolls back together.
 */
export interface OrganisationUnitOfWork {
  createOrganisation(
    data: Omit<OrganisationRecord, 'status' | 'createdAt'>,
  ): Promise<OrganisationRecord>;
  getOrganisation(): Promise<OrganisationRecord | null>;
  updateOrganisation(patch: {
    name?: string;
    defaultTimeZone?: string;
  }): Promise<OrganisationRecord>;

  listMemberships(page: PageRequest): Promise<Page<MembershipWithUser>>;
  /** Locks the row (SELECT ... FOR UPDATE) until the transaction ends. */
  lockMembership(membershipId: string): Promise<MembershipRecord | null>;
  /** Locks every organisation-scoped admin membership, to serialise "last admin" checks. */
  lockAdminMemberships(adminRole: string): Promise<MembershipRecord[]>;
  setMembershipStatus(
    membershipId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED',
    actorUserId: string,
    at: Date,
  ): Promise<MembershipRecord>;
  /** Creates the membership, or reactivates an existing one for the same user, role and scope. */
  grantMembership(data: {
    userId: string;
    role: string;
    scopeType: ScopeType;
    scopeId: string;
    grantedById: string;
  }): Promise<MembershipRecord>;
  findUserMemberships(userId: string): Promise<MembershipRecord[]>;

  listInvitations(page: PageRequest): Promise<Page<InvitationRecord>>;
  findPendingInvitation(email: string, role: string): Promise<InvitationRecord | null>;
  createInvitation(data: {
    email: string;
    role: string;
    scopeType: ScopeType;
    scopeId: string;
    tokenHash: string;
    expiresAt: Date;
    invitedById: string;
  }): Promise<InvitationRecord>;
  /** Locks the invitation row until the transaction ends. */
  lockInvitation(invitationId: string): Promise<InvitationRecord | null>;
  revokeInvitation(invitationId: string, at: Date): Promise<void>;
  /**
   * Marks the invitation accepted only if it is still pending and unexpired at `at`. Returns
   * false when another request accepted or revoked it first.
   */
  markInvitationAccepted(
    invitationId: string,
    tokenHash: string,
    userId: string,
    at: Date,
  ): Promise<boolean>;

  audit(event: TenantAuditEvent): Promise<void>;
}

/** Signals a slug that is already in use (including a concurrent creation). */
export class SlugTakenError extends Error {}
/** Signals a pending invitation that already exists (including a concurrent one). */
export class InvitationPendingError extends Error {}

export interface OrganisationsRepository {
  /** Runs `work` in one transaction with the organisation (and acting user) as RLS context. */
  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: OrganisationUnitOfWork) => Promise<T>,
  ): Promise<T>;

  /** Organisations where the user holds any membership, with those memberships. */
  listForUser(
    userId: string,
  ): Promise<{ organisation: OrganisationRecord; memberships: MembershipRecord[] }[]>;

  /** The invitation whose token hash is given, visible without tenant context. */
  findInvitationByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;

  findUserIdByEmail(email: string): Promise<string | null>;
}
export const ORGANISATIONS_REPOSITORY = Symbol('ORGANISATIONS_REPOSITORY');
