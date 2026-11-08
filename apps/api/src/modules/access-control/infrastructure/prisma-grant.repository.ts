import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { GrantRepository, LoadedGrants } from '../application/access-control.service';

/**
 * Read-only view of memberships (and the scoped property's status) for policy evaluation. The
 * organisations and properties modules own the writes; access-control only reads, which keeps
 * the dependency one-way.
 */
@Injectable()
export class PrismaGrantRepository implements GrantRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  loadGrants(
    userId: string,
    organisationId: string,
    propertyId?: string,
  ): Promise<LoadedGrants | null> {
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
          select: {
            role: true,
            scopeType: true,
            scopeId: true,
            status: true,
            validFrom: true,
            validUntil: true,
          },
        });
        const loaded: LoadedGrants = { organisationStatus: organisation.status, grants };
        if (propertyId !== undefined) {
          // Filtering by organisation_id as well as RLS: a property id from another tenant is
          // simply not found.
          loaded.property = await tx.property.findFirst({
            where: { id: propertyId, organisationId },
            select: { status: true },
          });
        }
        return loaded;
      },
      { userId },
    );
  }
}
