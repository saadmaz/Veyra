import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  type DbTransaction,
  databaseErrorCode,
  withUserTransaction,
} from '@veyra/db';
import { z } from 'zod';
import { ApiError } from '../../platform/errors/api-error';
import { DB_CLIENT } from '../../platform/infrastructure/infrastructure.module';

const reason = z.string().trim().min(1).max(500);

export const subscriptionChangeSchema = z
  .object({
    planCode: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,29}$/),
    status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED']),
    trialEndsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    reason,
  })
  .refine((v) => v.status !== 'TRIAL' || Boolean(v.trialEndsAt), {
    message: 'A trial needs an end',
    path: ['trialEndsAt'],
  });
export type SubscriptionChangeInput = z.infer<typeof subscriptionChangeSchema>;
export const reasonSchema = z.object({ reason });

const ORGANISATION = {
  id: true,
  name: true,
  slug: true,
  countryCode: true,
  status: true,
  createdAt: true,
  subscription: {
    select: {
      planCode: true,
      status: true,
      trialEndsAt: true,
      plan: { select: { name: true } },
    },
  },
} as const;

/** Someone who is not a platform administrator sees no platform routes at all. */
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

/**
 * Platform administration (Phase 13 Part 2). VEYRA staff listed in platform_admins see every
 * organisation's name, status, plan and usage counts, never its data; they change plans and
 * suspend or reactivate organisations only through database functions that check them again,
 * need a reason and write the organisation's own audit log, so the customer can see what was done.
 */
@Injectable()
export class PlatformAdminService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  isAdmin(userId: string) {
    return withUserTransaction(this.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<
        { admin: boolean }[]
      >`SELECT app_is_platform_admin() AS admin`;
      return rows[0]?.admin === true;
    });
  }

  organisations(userId: string, search: string | undefined) {
    return this.asAdmin(userId, (tx) =>
      tx.organisation.findMany({
        where: search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { slug: { contains: search.toLowerCase() } },
              ],
            }
          : {},
        select: ORGANISATION,
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  organisation(userId: string, id: string) {
    return this.asAdmin(userId, async (tx) => {
      const organisation = await tx.organisation.findUnique({
        where: { id },
        select: ORGANISATION,
      });
      if (!organisation) throw notFound();
      const [usage] = await tx.$queryRaw<{ properties: number; units: number; members: number }[]>`
        SELECT * FROM app_platform_usage(${id}::uuid)`;
      const history = await tx.subscriptionEvent.findMany({
        where: { organisationId: id },
        select: {
          fromPlan: true,
          toPlan: true,
          fromStatus: true,
          toStatus: true,
          reason: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return { organisation, usage: usage ?? { properties: 0, units: 0, members: 0 }, history };
    });
  }

  plans(userId: string) {
    return this.asAdmin(userId, (tx) =>
      tx.plan.findMany({
        select: {
          code: true,
          name: true,
          features: true,
          maxProperties: true,
          maxUnits: true,
          active: true,
        },
        orderBy: { position: 'asc' },
      }),
    );
  }

  async changeSubscription(userId: string, id: string, input: SubscriptionChangeInput) {
    await this.asAdmin(userId, async (tx) => {
      const plan = await tx.plan.findUnique({
        where: { code: input.planCode },
        select: { code: true },
      });
      if (!plan) throw new ApiError(422, 'UNKNOWN_PLAN', 'There is no such plan');
      await tx.$executeRaw`
        SELECT app_platform_set_subscription(${id}::uuid, ${input.planCode},
          ${input.status}::"SubscriptionStatus",
          ${input.status === 'TRIAL' ? (input.trialEndsAt ?? null) : null}::timestamptz, ${input.reason})`;
    });
    return this.organisation(userId, id);
  }

  async setStatus(userId: string, id: string, status: 'ACTIVE' | 'SUSPENDED', why: string) {
    await this.asAdmin(
      userId,
      (tx) =>
        tx.$executeRaw`
        SELECT app_platform_set_organisation_status(${id}::uuid, ${status}::"OrganisationStatus", ${why})`,
    );
    return this.organisation(userId, id);
  }

  private async asAdmin<T>(userId: string, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    try {
      return await withUserTransaction(this.db, userId, async (tx) => {
        const rows = await tx.$queryRaw<
          { admin: boolean }[]
        >`SELECT app_is_platform_admin() AS admin`;
        if (rows[0]?.admin !== true) throw notFound();
        return work(tx);
      });
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === '23514') {
        throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'That change is not possible now');
      }
      throw error;
    }
  }
}
