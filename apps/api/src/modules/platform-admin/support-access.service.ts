import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  databaseErrorCode,
  withTenantTransaction,
  withUserTransaction,
} from '@veyra/db';
import { z } from 'zod';
import { ApiError } from '../../platform/errors/api-error';
import { DB_CLIENT } from '../../platform/infrastructure/infrastructure.module';
import type { OrganisationAccess } from '../access-control';

export const supportRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  hours: z.int().min(1).max(24),
});
export type SupportRequestInput = z.infer<typeof supportRequestSchema>;

const SELECT = {
  id: true,
  organisationId: true,
  reason: true,
  hours: true,
  status: true,
  decidedAt: true,
  startsAt: true,
  endsAt: true,
  revokedAt: true,
  createdAt: true,
  requestedBy: { select: { displayName: true, email: true } },
  decidedBy: { select: { displayName: true } },
  organisation: { select: { name: true } },
} as const;

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

/**
 * Support access (Phase 13 Part 3). A platform administrator asks for read-only access to one
 * organisation (a reason, 1-24 hours); an organisation admin approves or denies it and can
 * revoke it at any time. While approved, the access-control grant loader gives the requester the
 * read-only SUPPORT_AGENT role in that organisation until the window ends.
 */
@Injectable()
export class SupportAccessService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  /** The organisation's requests, newest first. */
  list(access: OrganisationAccess) {
    return withTenantTransaction(
      this.db,
      { organisationId: access.organisationId },
      (tx) =>
        tx.supportAccess.findMany({
          where: { organisationId: access.organisationId },
          select: SELECT,
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      { userId: access.userId },
    );
  }

  /** Approve, deny or revoke; the database checks the move, the decider and sets the times. */
  decide(access: OrganisationAccess, id: string, status: 'APPROVED' | 'DENIED' | 'REVOKED') {
    return this.translate(
      withTenantTransaction(
        this.db,
        { organisationId: access.organisationId },
        async (tx) => {
          const current = await tx.supportAccess.findFirst({
            where: { id, organisationId: access.organisationId },
            select: { status: true },
          });
          if (!current) throw notFound();
          await tx.supportAccess.updateMany({
            where: { id, organisationId: access.organisationId },
            data: { status },
          });
          return tx.supportAccess.findFirstOrThrow({ where: { id }, select: SELECT });
        },
        { userId: access.userId },
      ),
    );
  }

  /** A platform administrator's request (checked again by the database function). */
  request(userId: string, organisationId: string, input: SupportRequestInput) {
    return this.translate(
      withUserTransaction(this.db, userId, async (tx) => {
        const rows = await tx.$queryRaw<
          { admin: boolean }[]
        >`SELECT app_is_platform_admin() AS admin`;
        if (rows[0]?.admin !== true) throw notFound();
        const [created] = await tx.$queryRaw<{ id: string }[]>`
          SELECT app_support_request(${organisationId}::uuid, ${input.reason}, ${input.hours})::text AS id`;
        if (!created) throw notFound();
        return tx.supportAccess.findFirstOrThrow({ where: { id: created.id }, select: SELECT });
      }),
    );
  }

  /** A platform administrator's own requests. */
  mine(userId: string) {
    return withUserTransaction(this.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<
        { admin: boolean }[]
      >`SELECT app_is_platform_admin() AS admin`;
      if (rows[0]?.admin !== true) throw notFound();
      return tx.supportAccess.findMany({
        where: { requestedByUserId: userId },
        select: SELECT,
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });
  }

  private async translate<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === '23514') {
        throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'That change is not possible now');
      }
      if (code === '42501') {
        throw new ApiError(403, 'FORBIDDEN', 'The organisation decides, not the requester');
      }
      if (code === '22P02' || code === '23503') throw notFound();
      throw error;
    }
  }
}
