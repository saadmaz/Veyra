import type { PlatformOrganisationDto } from '@veyra/api-contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, errorText, request } from '../src/lib/api';
import { planChangeProblem, planSummary } from '../src/lib/platform';

const org = (subscription: PlatformOrganisationDto['subscription']): PlatformOrganisationDto => ({
  id: 'o',
  name: 'Harbour Group',
  slug: 'harbour',
  countryCode: 'PK',
  status: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00Z',
  subscription,
});

describe('platform helpers', () => {
  it('summarise the plan', () => {
    expect(
      planSummary(
        org({ planCode: 'STARTER', planName: 'Starter', status: 'PAST_DUE', trialEndsAt: null }),
      ),
    ).toBe('Starter · Payment overdue');
    expect(
      planSummary(
        org({
          planCode: 'ENTERPRISE',
          planName: 'Enterprise',
          status: 'TRIAL',
          trialEndsAt: '2026-12-12T00:00:00Z',
        }),
      ),
    ).toBe('Enterprise · Trial until 12 Dec 2026');
    expect(planSummary(org(null))).toBe('No subscription');
  });

  it('need a reason, and an end date for trials', () => {
    expect(planChangeProblem({ status: 'ACTIVE', trialEndsOn: '', reason: ' ' })).toMatch(/reason/);
    expect(planChangeProblem({ status: 'TRIAL', trialEndsOn: '', reason: 'Extension' })).toMatch(
      /end date/,
    );
    expect(planChangeProblem({ status: 'ACTIVE', trialEndsOn: '', reason: 'Signed' })).toBeNull();
  });

  it('turn refused requests into API errors with the field problems', async () => {
    const refused = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'x',
            details: [{ path: 'reason', message: 'Required' }],
          },
        }),
        { status: 400 },
      );
    const error = await request('POST', '/x', {}, refused as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(errorText(error)).toBe('Required');
    await expect(request('GET', 'relative')).rejects.toThrow(/absolute/);
  });
});
