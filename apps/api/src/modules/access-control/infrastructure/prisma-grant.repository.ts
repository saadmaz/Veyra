import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { GrantRepository, LoadedGrants } from '../application/access-control.service';
import type { Grant } from '../domain/policy';

/** Derived grants are valid "today" by construction; the window only satisfies the Grant shape. */
const ALWAYS = new Date(0);

/**
 * Read-only view of grants for policy evaluation:
 *   - memberships (owned by the organisations module);
 *   - derived resident grants, from app_resident_grants(user) (migration 20261109180000), which
 *     applies the effective dates in each property's local calendar.
 * access-control only reads, which keeps the dependency one-way.
 */
@Injectable()
export class PrismaGrantRepository implements GrantRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  loadGrants(
    userId: string,
    organisationId: string,
    propertyId?: string,
    unitId?: string,
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
        const memberships = await tx.membership.findMany({
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
        const derived = await tx.$queryRaw<{ role: string; unit_id: string }[]>`
          SELECT "role", "unit_id" FROM app_resident_grants(${userId}::uuid)`;
        const grants: Grant[] = [
          ...memberships,
          ...derived.map((row) => ({
            role: row.role,
            scopeType: 'UNIT' as const,
            scopeId: row.unit_id,
            status: 'ACTIVE' as const,
            validFrom: ALWAYS,
            validUntil: null,
          })),
        ];

        const loaded: LoadedGrants = { organisationStatus: organisation.status, grants };
        if (propertyId !== undefined) {
          // Filtering by organisation_id as well as RLS: a property id from another tenant is
          // simply not found.
          loaded.property = await tx.property.findFirst({
            where: { id: propertyId, organisationId },
            select: { status: true },
          });
        }
        if (propertyId !== undefined && unitId !== undefined) {
          const unit = await tx.unit.findFirst({
            where: { id: unitId, propertyId, organisationId },
            select: { id: true },
          });
          loaded.unitInProperty = unit !== null;
        }
        return loaded;
      },
      { userId },
    );
  }
}
