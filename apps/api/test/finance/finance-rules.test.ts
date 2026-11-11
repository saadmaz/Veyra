import { describe, expect, it } from 'vitest';
import {
  billingRunSchema,
  chargesForUnit,
  createRecurringChargeSchema,
  formatInvoiceNumber,
  monthBounds,
  monthLabel,
  monthSchema,
  parsePositiveAmount,
  perSqmAmount,
  recurringAmount,
  resolveBillTo,
  type UnitParties,
} from '../../src/modules/finance/domain/finance-rules';

describe('amounts', () => {
  it('parses positive amounts in the currency minor unit and refuses extra decimals or zero', () => {
    expect(parsePositiveAmount('1500.50', 'PKR')).toBe(150050n);
    expect(parsePositiveAmount('1500', 'JPY')).toBe(1500n);
    expect(parsePositiveAmount('1.234', 'KWD')).toBe(1234n);
    expect(() => parsePositiveAmount('1.5', 'JPY')).toThrow(/decimal places/);
    expect(() => parsePositiveAmount('0.00', 'PKR')).toThrow(/more than zero/);
  });

  it('prices per square metre exactly, rounding half up to a minor unit', () => {
    expect(perSqmAmount(1250n, '85.50')).toBe(106875n);
    expect(perSqmAmount(333n, '1.5')).toBe(500n); // 499.5 -> 500
    expect(perSqmAmount(333n, '1.49')).toBe(496n); // 496.17 -> 496
    expect(perSqmAmount(9_007_199_254_740_993n, '2')).toBe(18_014_398_509_481_986n);
  });

  it('cannot price a per-sqm charge without an area', () => {
    expect(recurringAmount({ basis: 'FLAT', amountMinor: 500n }, null)).toBe(500n);
    expect(recurringAmount({ basis: 'PER_SQM', amountMinor: 500n }, null)).toBeNull();
    expect(recurringAmount({ basis: 'PER_SQM', amountMinor: 1n }, '0.01')).toBeNull();
  });
});

describe('billing', () => {
  it("lets a unit's own charge replace the property-wide one of the same type", () => {
    const charges = [
      { id: 'all-service', unitId: null, chargeTypeId: 'service' },
      { id: 'all-utility', unitId: null, chargeTypeId: 'utility' },
      { id: 'u1-service', unitId: 'u1', chargeTypeId: 'service' },
    ];
    expect(chargesForUnit(charges, 'u1').map((c) => c.id)).toEqual(['u1-service', 'all-utility']);
    expect(chargesForUnit(charges, 'u2').map((c) => c.id)).toEqual(['all-service', 'all-utility']);
  });

  const owners = [{ personId: 'o', fullName: 'Olu', numerator: 1, denominator: 1 }];
  const tenancy = { id: 't', occupants: [{ personId: 'p', fullName: 'Tara' }] };

  it('bills owners for owner charges and the occupant, or owners while vacant, for the rest', () => {
    const let_: UnitParties = { owners, tenancy };
    const vacant: UnitParties = { owners, tenancy: null };
    expect(resolveBillTo('OWNERS', let_)).toMatchObject({ billTo: 'OWNERS' });
    expect(resolveBillTo('OCCUPANT', let_)).toMatchObject({ billTo: 'TENANTS', tenancyId: 't' });
    expect(resolveBillTo('OCCUPANT', vacant)).toMatchObject({ billTo: 'OWNERS' });
    expect(resolveBillTo('OWNERS', { owners: [], tenancy })).toBeNull();
    expect(resolveBillTo('OCCUPANT', { owners: [], tenancy: null })).toBeNull();
  });
});

describe('dates and labels', () => {
  it('validates months and month ranges', () => {
    expect(monthSchema.parse('2027-01')).toBe('2027-01-01');
    expect(monthSchema.safeParse('2027-13').success).toBe(false);
    expect(
      createRecurringChargeSchema.safeParse({
        chargeTypeId: '0190b4a6-7a8e-7f00-8000-000000000001',
        basis: 'FLAT',
        amount: '10',
        startMonth: '2027-03',
        endMonth: '2027-02',
      }).success,
    ).toBe(false);
    expect(billingRunSchema.safeParse({ month: '2027-03', dueDate: '2027-02-28' }).success).toBe(
      false,
    );
  });

  it('finds month bounds, including leap years, and formats labels and numbers', () => {
    expect(monthBounds('2028-02-14')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthBounds('2027-12-31')).toEqual({ start: '2027-12-01', end: '2027-12-31' });
    expect(monthLabel('2027-01-01')).toBe('January 2027');
    expect(formatInvoiceNumber(42n)).toBe('INV-000042');
  });
});
