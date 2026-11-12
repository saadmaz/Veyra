import type { Permission } from './permissions';

/*
 * Subscription entitlements (ACCESS_CONTROL rule 5, Phase 13). Every permission belongs to a
 * feature; a plan turns features on. "core" is always on. Typing the map by Permission makes a new
 * permission fail to compile until it is given a feature.
 */

export const FEATURES = [
  'core',
  'visitors',
  'finance',
  'maintenance',
  'communications',
  'facilities',
  'workforce',
  'vendors',
  'incidents',
  'reporting',
  'governance',
  'integrations',
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_OF: Record<Permission, Feature> = {
  'organisation.profile.read': 'core',
  'organisation.settings.manage': 'core',
  'organisation.member.read': 'core',
  'organisation.member.manage': 'core',
  'organisation.member.invite': 'core',
  'organisation.property.create': 'core',
  'organisation.resident.read': 'core',
  'property.profile.read': 'core',
  'property.settings.manage': 'core',
  'property.lifecycle.manage': 'core',
  'property.structure.read': 'core',
  'property.structure.manage': 'core',
  'property.resident.read': 'core',
  'property.resident.manage': 'core',
  'unit.profile.read': 'core',
  'unit.residents.read': 'core',
  'unit.visitor.invite': 'visitors',
  'property.visitor.check_in': 'visitors',
  'property.visitor.read': 'visitors',
  'property.visitor.manage': 'visitors',
  'property.finance.read': 'finance',
  'property.finance.manage': 'finance',
  'property.finance.approve': 'finance',
  'unit.finance.read': 'finance',
  'unit.finance.pay': 'finance',
  'unit.maintenance.request': 'maintenance',
  'property.maintenance.read': 'maintenance',
  'property.maintenance.manage': 'maintenance',
  'property.maintenance.work': 'maintenance',
  'property.announcement.read': 'communications',
  'property.announcement.manage': 'communications',
  'property.document.read': 'communications',
  'property.document.manage': 'communications',
  'unit.document.read': 'communications',
  'property.incident.read': 'incidents',
  'property.incident.report': 'incidents',
  'property.incident.manage': 'incidents',
  'property.governance.read': 'governance',
  'property.governance.manage': 'governance',
  'property.approval.read': 'governance',
  'property.approval.request': 'governance',
  'property.approval.decide': 'governance',
  'property.report.export': 'reporting',
  'property.staff.read': 'workforce',
  'property.staff.manage': 'workforce',
  'property.staff.work': 'workforce',
  'organisation.vendor.read': 'vendors',
  'organisation.vendor.manage': 'vendors',
  'organisation.webhook.manage': 'integrations',
  'unit.facility.book': 'facilities',
  'property.facility.read': 'facilities',
  'property.facility.manage': 'facilities',
};

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';

/** What an organisation's subscription allows right now. */
export interface Entitlement {
  features: ReadonlySet<string>;
  /** Cancelled, or a trial that has ended: the organisation is read-only. */
  lapsed: boolean;
}

export function entitlementOf(
  subscription: { status: SubscriptionStatus; trialEndsAt: Date | null; features: string[] } | null,
  now: Date,
): Entitlement {
  // No subscription row cannot happen after the migration; treat it as lapsed, not as everything.
  if (!subscription) return { features: new Set(), lapsed: true };
  const lapsed =
    subscription.status === 'CANCELLED' ||
    (subscription.status === 'TRIAL' &&
      subscription.trialEndsAt !== null &&
      subscription.trialEndsAt <= now);
  return { features: new Set(subscription.features), lapsed };
}

/** The permissions a subscription allows (core always). */
export function entitled<P extends Permission>(
  permissions: Iterable<P>,
  entitlement: Entitlement,
): Set<P> {
  const out = new Set<P>();
  for (const p of permissions) {
    const feature = FEATURE_OF[p];
    if (feature === 'core' || entitlement.features.has(feature)) out.add(p);
  }
  return out;
}
