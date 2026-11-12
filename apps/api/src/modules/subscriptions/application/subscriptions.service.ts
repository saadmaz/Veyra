import { Inject, Injectable } from '@nestjs/common';
import type { OrganisationAccess } from '../../access-control';
import { entitlementOf } from '../../access-control/domain/entitlements';

export interface SubscriptionView {
  plan: {
    code: string;
    name: string;
    features: string[];
    maxProperties: number | null;
    maxUnits: number | null;
  };
  status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
  trialEndsAt: Date | null;
  lapsed: boolean;
  usage: { properties: number; units: number };
  history: {
    fromPlan: string | null;
    toPlan: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    createdAt: Date;
  }[];
}

export interface SubscriptionReader {
  read(organisationId: string, userId: string): Promise<Omit<SubscriptionView, 'lapsed'> | null>;
}

export const SUBSCRIPTION_READER = Symbol('SUBSCRIPTION_READER');

/**
 * Subscriptions (Phase 13 Part 1): an organisation's plan, what it allows and how much of it is
 * used. Changing plans is a platform operation (Part 2).
 */
@Injectable()
export class SubscriptionsService {
  constructor(@Inject(SUBSCRIPTION_READER) private readonly reader: SubscriptionReader) {}

  async current(access: OrganisationAccess): Promise<SubscriptionView | null> {
    const s = await this.reader.read(access.organisationId, access.userId);
    if (!s) return null;
    const { lapsed } = entitlementOf(
      { status: s.status, trialEndsAt: s.trialEndsAt, features: s.plan.features },
      new Date(),
    );
    return { ...s, lapsed };
  }
}
