import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  type DbTransaction,
  isUniqueViolation,
  withInvitationTokenTransaction,
  withTenantTransaction,
  withUserTransaction,
} from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import {
  InvitationPendingError,
  type InvitationRecord,
  type MembershipRecord,
  type MembershipWithUser,
  type OrganisationRecord,
  type OrganisationsRepository,
  type OrganisationUnitOfWork,
  type Page,
  type PageRequest,
  SlugTakenError,
  type TenantAuditEvent,
} from '../application/ports';

const ORGANISATION_SELECT = {
  id: true,
  name: true,
  slug: true,
  countryCode: true,
  defaultCurrency: true,
  defaultTimeZone: true,
  status: true,
  createdAt: true,
} as const;

const MEMBERSHIP_SELECT = {
  id: true,
  organisationId: true,
  userId: true,
  role: true,
  scopeType: true,
  scopeId: true,
  status: true,
  validFrom: true,
  validUntil: true,
  createdAt: true,
} as const;

const INVITATION_SELECT = {
  id: true,
  organisationId: true,
  email: true,
  role: true,
  scopeType: true,
  scopeId: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  invitedById: true,
  createdAt: true,
} as const;

/** Column list for raw SELECT ... FOR UPDATE, aliased to the record shape. */
const MEMBERSHIP_COLUMNS = `id, organisation_id AS "organisationId", user_id AS "userId", role,
  scope_type::text AS "scopeType", scope_id AS "scopeId", status::text AS status,
  valid_from AS "validFrom", valid_until AS "validUntil", created_at AS "createdAt"`;

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/** Keyset pagination on UUIDv7 ids (time-ordered). Fetches one extra row to detect a next page. */
function pageArgs({ limit, cursor }: PageRequest) {
  return {
    take: limit + 1,
    orderBy: { id: 'asc' as const },
    ...(cursor ? { where: { id: { gt: cursor } } } : {}),
  };
}

function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
}

class PrismaOrganisationUnitOfWork implements OrganisationUnitOfWork {
  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {}

  async createOrganisation(
    data: Omit<OrganisationRecord, 'status' | 'createdAt'>,
  ): Promise<OrganisationRecord> {
    try {
      return await this.tx.organisation.create({ data, select: ORGANISATION_SELECT });
    } catch (error) {
      if (isUniqueViolation(error, 'slug')) throw new SlugTakenError();
      throw error;
    }
  }

  getOrganisation(): Promise<OrganisationRecord | null> {
    return this.tx.organisation.findUnique({
      where: { id: this.organisationId },
      select: ORGANISATION_SELECT,
    });
  }

  updateOrganisation(patch: {
    name?: string;
    defaultTimeZone?: string;
  }): Promise<OrganisationRecord> {
    return this.tx.organisation.update({
      where: { id: this.organisationId },
      data: patch,
      select: ORGANISATION_SELECT,
    });
  }

  async listMemberships(page: PageRequest): Promise<Page<MembershipWithUser>> {
    const { where, ...args } = pageArgs(page);
    const rows = await this.tx.membership.findMany({
      ...args,
      where: { organisationId: this.organisationId, ...where },
      select: { ...MEMBERSHIP_SELECT, user: { select: { email: true, displayName: true } } },
    });
    return toPage(rows, page.limit);
  }

  async lockMembership(membershipId: string): Promise<MembershipRecord | null> {
    const rows = await this.tx.$queryRawUnsafe<MembershipRecord[]>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM memberships
        WHERE id = $1::uuid AND organisation_id = $2::uuid FOR UPDATE`,
      membershipId,
      this.organisationId,
    );
    return rows[0] ?? null;
  }

  lockAdminMemberships(adminRole: string): Promise<MembershipRecord[]> {
    return this.tx.$queryRawUnsafe<MembershipRecord[]>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM memberships
        WHERE organisation_id = $1::uuid AND role = $2 AND scope_type = 'ORGANISATION'
        ORDER BY id FOR UPDATE`,
      this.organisationId,
      adminRole,
    );
  }

  setMembershipStatus(
    membershipId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED',
    actorUserId: string,
    at: Date,
  ): Promise<MembershipRecord> {
    return this.tx.membership.update({
      where: { id: membershipId },
      data:
        status === 'REVOKED'
          ? { status, revokedAt: at, revokedById: actorUserId }
          : { status, revokedAt: null, revokedById: null },
      select: MEMBERSHIP_SELECT,
    });
  }

  grantMembership(data: {
    userId: string;
    role: string;
    scopeType: MembershipRecord['scopeType'];
    scopeId: string;
    grantedById: string;
  }): Promise<MembershipRecord> {
    const key = {
      organisationId: this.organisationId,
      userId: data.userId,
      role: data.role,
      scopeType: data.scopeType,
      scopeId: data.scopeId,
    };
    return this.tx.membership.upsert({
      where: { organisationId_userId_role_scopeType_scopeId: key },
      create: { ...key, grantedById: data.grantedById },
      update: {
        status: 'ACTIVE',
        revokedAt: null,
        revokedById: null,
        validUntil: null,
        grantedById: data.grantedById,
      },
      select: MEMBERSHIP_SELECT,
    });
  }

  findUserMemberships(userId: string): Promise<MembershipRecord[]> {
    return this.tx.membership.findMany({
      where: { organisationId: this.organisationId, userId },
      select: MEMBERSHIP_SELECT,
    });
  }

  async listInvitations(page: PageRequest): Promise<Page<InvitationRecord>> {
    const { where, ...args } = pageArgs(page);
    const rows = await this.tx.invitation.findMany({
      ...args,
      where: { organisationId: this.organisationId, ...where },
      select: INVITATION_SELECT,
    });
    return toPage(rows, page.limit);
  }

  findPendingInvitation(email: string, role: string): Promise<InvitationRecord | null> {
    return this.tx.invitation.findFirst({
      where: {
        organisationId: this.organisationId,
        email,
        role,
        acceptedAt: null,
        revokedAt: null,
      },
      select: INVITATION_SELECT,
    });
  }

  async createInvitation(data: {
    email: string;
    role: string;
    scopeType: InvitationRecord['scopeType'];
    scopeId: string;
    tokenHash: string;
    expiresAt: Date;
    invitedById: string;
  }): Promise<InvitationRecord> {
    try {
      return await this.tx.invitation.create({
        data: { ...data, organisationId: this.organisationId },
        select: INVITATION_SELECT,
      });
    } catch (error) {
      // invitations_one_pending_per_role: a concurrent request created the same invitation.
      if (isUniqueViolation(error)) throw new InvitationPendingError();
      throw error;
    }
  }

  async lockInvitation(invitationId: string): Promise<InvitationRecord | null> {
    const rows = await this.tx.$queryRawUnsafe<InvitationRecord[]>(
      `SELECT id, organisation_id AS "organisationId", email, role, scope_type::text AS "scopeType",
              scope_id AS "scopeId", expires_at AS "expiresAt", accepted_at AS "acceptedAt",
              revoked_at AS "revokedAt", invited_by_id AS "invitedById", created_at AS "createdAt"
         FROM invitations WHERE id = $1::uuid AND organisation_id = $2::uuid FOR UPDATE`,
      invitationId,
      this.organisationId,
    );
    return rows[0] ?? null;
  }

  async revokeInvitation(invitationId: string, at: Date): Promise<void> {
    await this.tx.invitation.updateMany({
      where: {
        id: invitationId,
        organisationId: this.organisationId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: at },
    });
  }

  async markInvitationAccepted(
    invitationId: string,
    tokenHash: string,
    userId: string,
    at: Date,
  ): Promise<boolean> {
    const { count } = await this.tx.invitation.updateMany({
      where: {
        id: invitationId,
        organisationId: this.organisationId,
        tokenHash,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: at },
      },
      data: { acceptedAt: at, acceptedById: userId },
    });
    return count === 1;
  }

  async audit(event: TenantAuditEvent): Promise<void> {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: event.metadata ?? {},
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/**
 * All tenant data access goes through inOrganisation, which opens one transaction with the
 * organisation and user as RLS context (withTenantTransaction). Queries also filter by
 * organisation_id explicitly: RLS is the second line of defence, not the only one.
 */
@Injectable()
export class PrismaOrganisationsRepository implements OrganisationsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: OrganisationUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaOrganisationUnitOfWork(tx, organisationId, userId, meta)),
      { userId },
    );
  }

  listForUser(
    userId: string,
  ): Promise<{ organisation: OrganisationRecord; memberships: MembershipRecord[] }[]> {
    return withUserTransaction(this.db, userId, async (tx) => {
      // Two queries, joined here: RLS shows only organisations with an ACTIVE membership, so a
      // nested include would fail for memberships whose organisation is hidden.
      const organisations = await tx.organisation.findMany({ select: ORGANISATION_SELECT });
      const memberships = await tx.membership.findMany({
        where: { userId, organisationId: { in: organisations.map((o) => o.id) } },
        select: MEMBERSHIP_SELECT,
      });
      return organisations.map((organisation) => ({
        organisation,
        memberships: memberships.filter((m) => m.organisationId === organisation.id),
      }));
    });
  }

  findInvitationByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return withInvitationTokenTransaction(this.db, tokenHash, (tx) =>
      tx.invitation.findUnique({ where: { tokenHash }, select: INVITATION_SELECT }),
    );
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    const user = await this.db.user.findUnique({ where: { email }, select: { id: true } });
    return user?.id ?? null;
  }
}
