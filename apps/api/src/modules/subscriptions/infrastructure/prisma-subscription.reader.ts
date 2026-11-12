import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { SubscriptionReader } from '../application/subscriptions.service';

/** Reads a subscription, its plan, usage and history inside the organisation's RLS context. */
@Injectable()
export class PrismaSubscriptionReader implements SubscriptionReader {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  read(organisationId: string, userId: string) {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const s = await tx.subscription.findUnique({
          where: { organisationId },
          select: {
            status: true,
            trialEndsAt: true,
            plan: {
              select: {
                code: true,
                name: true,
                features: true,
                maxProperties: true,
                maxUnits: true,
              },
            },
          },
        });
        if (!s) return null;
        const [properties, units, history] = await Promise.all([
          tx.property.count({ where: { organisationId, status: { not: 'ARCHIVED' } } }),
          tx.unit.count({ where: { organisationId, status: 'ACTIVE' } }),
          tx.subscriptionEvent.findMany({
            where: { organisationId },
            select: {
              fromPlan: true,
              toPlan: true,
              fromStatus: true,
              toStatus: true,
              reason: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
        ]);
        return { ...s, usage: { properties, units }, history };
      },
      { userId },
    );
  }
}
