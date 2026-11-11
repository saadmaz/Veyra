import { describe, expect, it } from 'vitest';
import { ROLES } from '../../src/modules/access-control/domain/roles';
import {
  belongsTo,
  partiesFor,
  residentParties,
  submitTransferSchema,
} from '../../src/modules/finance/domain/resident-finance-rules';

const T = '0190a0b0-0000-7000-8000-000000000001';
const OTHER_T = '0190a0b0-0000-7000-8000-000000000002';

describe('residentParties', () => {
  it('gives an owner the owners account and a tenant only their tenancy', () => {
    expect(residentParties({ owner: true, tenancyId: null })).toEqual([
      { paidBy: 'OWNERS', tenancyId: null },
    ]);
    expect(residentParties({ owner: false, tenancyId: T })).toEqual([
      { paidBy: 'TENANTS', tenancyId: T },
    ]);
  });

  it('gives someone who owns and rents the same unit both, owners first', () => {
    expect(residentParties({ owner: true, tenancyId: T }).map((p) => p.paidBy)).toEqual([
      'OWNERS',
      'TENANTS',
    ]);
  });

  it('gives nothing to someone with no current records (staff, household, former residents)', () => {
    expect(residentParties({ owner: false, tenancyId: null })).toEqual([]);
  });
});

describe('partiesFor', () => {
  const tenant = residentParties({ owner: false, tenancyId: T });

  it('returns all of the caller accounts when none is asked for', () => {
    expect(partiesFor(tenant, undefined)).toEqual(tenant);
  });

  it('refuses an account that is not the caller (a tenant asking for the owners)', () => {
    expect(partiesFor(tenant, 'OWNERS')).toBeNull();
    expect(partiesFor([], 'TENANTS')).toBeNull();
  });
});

describe('belongsTo', () => {
  const tenant = residentParties({ owner: false, tenancyId: T });

  it('matches only the same account, tenancy included', () => {
    expect(belongsTo(tenant, { paidBy: 'TENANTS', tenancyId: T })).toBe(true);
    // A previous tenancy of the same unit is someone else's account.
    expect(belongsTo(tenant, { paidBy: 'TENANTS', tenancyId: OTHER_T })).toBe(false);
    expect(belongsTo(tenant, { paidBy: 'OWNERS', tenancyId: null })).toBe(false);
  });
});

describe('submitTransferSchema', () => {
  const valid = {
    paidBy: 'OWNERS',
    amount: '2500.00',
    transferredOn: '2026-11-10',
    reference: '  FT-12345 ',
  };

  it('trims the reference and drops an empty note', () => {
    const parsed = submitTransferSchema.parse({ ...valid, note: '   ' });
    expect(parsed.reference).toBe('FT-12345');
    expect(parsed.note).toBeUndefined();
  });

  it('refuses a blank or long reference and a malformed date', () => {
    expect(submitTransferSchema.safeParse({ ...valid, reference: '  ' }).success).toBe(false);
    expect(submitTransferSchema.safeParse({ ...valid, reference: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(submitTransferSchema.safeParse({ ...valid, transferredOn: '10/11/2026' }).success).toBe(
      false,
    );
  });
});

describe('finance permissions of resident roles', () => {
  it('owners and tenants see and pay their own account; household members do not', () => {
    for (const role of [ROLES.OWNER, ROLES.TENANT]) {
      expect(role.permissions).toContain('unit.finance.read');
      expect(role.permissions).toContain('unit.finance.pay');
    }
    expect(ROLES.HOUSEHOLD_MEMBER.permissions as readonly string[]).not.toContain(
      'unit.finance.read',
    );
  });

  it('property managers, guards and finance officers get no resident finance permission', () => {
    for (const role of [ROLES.PROPERTY_MANAGER, ROLES.SECURITY_GUARD, ROLES.FINANCE_OFFICER]) {
      expect(role.permissions as readonly string[]).not.toContain('unit.finance.pay');
    }
  });
});
