import { describe, expect, it } from 'vitest';
import {
  entitled,
  entitlementOf,
  FEATURE_OF,
  FEATURES,
} from '../../src/modules/access-control/domain/entitlements';
import { PERMISSIONS } from '../../src/modules/access-control/domain/permissions';

const NOW = new Date('2026-11-12T12:00:00Z');

describe('entitlements', () => {
  it('give every permission a known feature', () => {
    for (const p of PERMISSIONS) expect(FEATURES).toContain(FEATURE_OF[p]);
  });

  it('keep core permissions and those of the plan only', () => {
    const e = entitlementOf({ status: 'ACTIVE', trialEndsAt: null, features: ['finance'] }, NOW);
    expect([
      ...entitled(
        ['property.profile.read', 'property.finance.read', 'property.incident.read'] as const,
        e,
      ),
    ]).toEqual(['property.profile.read', 'property.finance.read']);
  });

  it('lapse when cancelled or when a trial has ended, not when payment is late', () => {
    const at = (status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED', trialEndsAt: Date | null) =>
      entitlementOf({ status, trialEndsAt, features: [] }, NOW).lapsed;
    expect(at('ACTIVE', null)).toBe(false);
    expect(at('PAST_DUE', null)).toBe(false);
    expect(at('CANCELLED', null)).toBe(true);
    expect(at('TRIAL', new Date('2026-12-01T00:00:00Z'))).toBe(false);
    expect(at('TRIAL', new Date('2026-11-01T00:00:00Z'))).toBe(true);
    expect(entitlementOf(null, NOW)).toMatchObject({ lapsed: true });
  });
});
