import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type {
  GrantRepository,
  LoadedGrants,
  PermissionHolder,
} from '../application/access-control.service';
import { entitlementOf } from '../domain/entitlements';
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

  membershipHolders(
    organisationId: string,
    propertyId: string,
    roles: readonly string[],
  ): Promise<PermissionHolder[]> {
    if (roles.length === 0) return Promise.resolve([]);
    return withTenantTransaction(this.db, { organisationId }, async (tx) => {
      const rows = await tx.membership.findMany({
        where: {
          organisationId,
          role: { in: [...roles] },
          status: 'ACTIVE',
          OR: [{ scopeType: 'ORGANISATION' }, { scopeType: 'PROPERTY', scopeId: propertyId }],
          AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }],
          user: { status: 'ACTIVE' },
        },
        select: { userId: true, user: { select: { displayName: true } } },
        take: 500,
      });
      // One row per membership: a user with several qualifying roles appears once.
      const seen = new Map<string, PermissionHolder>();
      for (const row of rows) {
        seen.set(row.userId, { userId: row.userId, displayName: row.user.displayName });
      }
      return [...seen.values()];
    });
  }

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
        // Approved support access (Phase 13): a read-only grant for the approved window.
        const support = await tx.supportAccess.findMany({
          where: { organisationId, requestedByUserId: userId, status: 'APPROVED' },
          select: { startsAt: true, endsAt: true },
        });
        const grants: Grant[] = [
          ...memberships,
          ...support
            .filter((s) => s.startsAt && s.endsAt)
            .map((s) => ({
              role: 'SUPPORT_AGENT',
              scopeType: 'ORGANISATION' as const,
              scopeId: organisationId,
              status: 'ACTIVE' as const,
              validFrom: s.startsAt as Date,
              validUntil: s.endsAt,
            })),
          ...derived.map((row) => ({
            role: row.role,
            scopeType: 'UNIT' as const,
            scopeId: row.unit_id,
            status: 'ACTIVE' as const,
            validFrom: ALWAYS,
            validUntil: null,
          })),
        ];

        const subscription = await tx.subscription.findUnique({
          where: { organisationId },
          select: { status: true, trialEndsAt: true, plan: { select: { features: true } } },
        });
        const entitlement = entitlementOf(
          subscription
            ? {
                status: subscription.status,
                trialEndsAt: subscription.trialEndsAt,
                features: subscription.plan.features,
              }
            : null,
          new Date(),
        );
        // A lapsed subscription makes an active organisation read-only (rule 4).
        const organisationStatus =
          entitlement.lapsed && organisation.status === 'ACTIVE'
            ? 'SUSPENDED'
            : organisation.status;
        const loaded: LoadedGrants = { organisationStatus, entitlement, grants };
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
