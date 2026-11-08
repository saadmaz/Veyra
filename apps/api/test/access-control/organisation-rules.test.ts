import { describe, expect, it } from 'vitest';
import {
  canTransitionMembership,
  createInvitationSchema,
  createOrganisationSchema,
  invitationStatus,
  updateOrganisationSchema,
} from '../../src/modules/organisations/domain/organisation-rules';

const valid = {
  name: 'Harbour View Residences',
  slug: 'harbour-view',
  countryCode: 'pk',
  defaultCurrency: 'pkr',
  defaultTimeZone: 'Asia/Karachi',
};

describe('organisation input', () => {
  it('normalises country and currency codes', () => {
    expect(createOrganisationSchema.parse(valid)).toMatchObject({
      countryCode: 'PK',
      defaultCurrency: 'PKR',
    });
  });

  it.each([
    ['slug with upper case and spaces', { slug: 'Harbour View' }],
    ['slug with double hyphen', { slug: 'harbour--view' }],
    ['too short slug', { slug: 'hv' }],
    ['unknown time zone', { defaultTimeZone: 'Mars/Olympus' }],
    ['unknown currency', { defaultCurrency: 'ZZZ' }],
    ['unknown country', { countryCode: 'ZZ' }],
    ['empty name', { name: ' ' }],
  ])('rejects %s', (_label, override) => {
    expect(createOrganisationSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it('does not allow changing country or currency after creation', () => {
    const parsed = updateOrganisationSchema.parse({ name: 'New name', defaultCurrency: 'USD' });
    expect(parsed).toEqual({ name: 'New name' });
    expect(updateOrganisationSchema.safeParse({}).success).toBe(false);
  });
});

describe('invitation input', () => {
  it('normalises the email and accepts only registered roles', () => {
    expect(
      createInvitationSchema.parse({ email: ' New.Member@Example.TEST ', role: 'FINANCE_OFFICER' }),
    ).toEqual({ email: 'new.member@example.test', role: 'FINANCE_OFFICER' });
    expect(
      createInvitationSchema.safeParse({ email: 'a@example.test', role: 'PLATFORM_SUPER_ADMIN' })
        .success,
    ).toBe(false);
  });

  it('accepts an optional property scope, as a normalised UUID', () => {
    const id = '0193B5A2-7C1D-7E3F-8A9B-0C1D2E3F4A5B';
    expect(
      createInvitationSchema.parse({
        email: 'pm@example.test',
        role: 'PROPERTY_MANAGER',
        propertyId: id,
      }).propertyId,
    ).toBe(id.toLowerCase());
    expect(
      createInvitationSchema.safeParse({
        email: 'pm@example.test',
        role: 'PROPERTY_MANAGER',
        propertyId: 'P1',
      }).success,
    ).toBe(false);
  });
});

describe('membership transitions', () => {
  it('allows suspend, reactivate and revoke, and treats revoked as final', () => {
    expect(canTransitionMembership('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransitionMembership('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canTransitionMembership('ACTIVE', 'REVOKED')).toBe(true);
    expect(canTransitionMembership('SUSPENDED', 'REVOKED')).toBe(true);
    expect(canTransitionMembership('REVOKED', 'ACTIVE')).toBe(false);
    expect(canTransitionMembership('REVOKED', 'SUSPENDED')).toBe(false);
  });
});

describe('invitation status', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const base = { acceptedAt: null, revokedAt: null, expiresAt: new Date(now.getTime() + 1) };

  it('derives the status from timestamps', () => {
    expect(invitationStatus(base, now)).toBe('PENDING');
    expect(invitationStatus({ ...base, expiresAt: now }, now)).toBe('EXPIRED');
    expect(invitationStatus({ ...base, acceptedAt: now }, now)).toBe('ACCEPTED');
    expect(invitationStatus({ ...base, revokedAt: now }, now)).toBe('REVOKED');
  });
});
