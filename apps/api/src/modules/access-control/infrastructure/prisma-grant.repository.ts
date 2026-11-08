import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { GrantRepository } from '../application/access-control.service';
import type { Grant, OrganisationStatus } from '../domain/policy';

/**
 * Read-only view of memberships for policy evaluation. The organisations module owns
 * membership writes; access-control only reads them, which keeps the dependency one-way
 * (organisations -> access-control).
 */
@Injectable()
export class PrismaGrantRepository implements GrantRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  loadGrants(
    userId: string,
    organisationId: string,
  ): Promise<{ organisationStatus: OrganisationStatus; grants: Grant[] } | null> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const organisation = await tx.organisation.findUnique({
          where: { id: organisationId },
          select: { status: true },
        });
        if (!organisation) return null;
        const grants = await tx.membership.findMany({
          where: { organisationId, userId },
          select: { role: true, scopeType: true, status: true, validFrom: true, validUntil: true },
        });
        return { organisationStatus: organisation.status, grants };
      },
      { userId },
    );
  }
}
