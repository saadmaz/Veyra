import { describe, expect, it } from 'vitest';
import {
  dayBefore,
  periodsOverlap,
} from '../../src/modules/residents/application/residents-staff.service';
import {
  addVehicleSchema,
  createPersonSchema,
  createTenancySchema,
  dateSchema,
  fractionsSumToOne,
  setOwnersSchema,
} from '../../src/modules/residents/domain/resident-rules';

const P1 = '0193b5a2-7c1d-7e3f-8a9b-0c1d2e3f4a51';
const P2 = '0193b5a2-7c1d-7e3f-8a9b-0c1d2e3f4a52';
const P3 = '0193b5a2-7c1d-7e3f-8a9b-0c1d2e3f4a53';

describe('exact ownership shares', () => {
  it('accepts fractions that add up to exactly one, including thirds', () => {
    expect(fractionsSumToOne([{ shareNumerator: 1, shareDenominator: 1 }])).toBe(true);
    expect(
      fractionsSumToOne([
        { shareNumerator: 1, shareDenominator: 3 },
        { shareNumerator: 1, shareDenominator: 3 },
        { shareNumerator: 1, shareDenominator: 3 },
      ]),
    ).toBe(true);
    expect(
      fractionsSumToOne([
        { shareNumerator: 1, shareDenominator: 3 },
        { shareNumerator: 2, shareDenominator: 3 },
      ]),
    ).toBe(true);
    expect(
      fractionsSumToOne([
        { shareNumerator: 7, shareDenominator: 1_000_000 },
        { shareNumerator: 999_993, shareDenominator: 1_000_000 },
      ]),
    ).toBe(true);
  });

  it('rejects anything else, and an empty list', () => {
    expect(
      fractionsSumToOne([
        { shareNumerator: 1, shareDenominator: 2 },
        { shareNumerator: 2, shareDenominator: 3 },
      ]),
    ).toBe(false);
    expect(
      fractionsSumToOne([
        { shareNumerator: 333_333, shareDenominator: 1_000_000 },
        { shareNumerator: 2, shareDenominator: 3 },
      ]),
    ).toBe(false);
    expect(fractionsSumToOne([])).toBe(false);
  });

  it('validates a set-owners request', () => {
    const owners = [
      { personId: P1, shareNumerator: 1, shareDenominator: 2 },
      { personId: P2, shareNumerator: 1, shareDenominator: 2 },
    ];
    expect(setOwnersSchema.safeParse({ effectiveFrom: '2026-01-01', owners }).success).toBe(true);
    expect(
      setOwnersSchema.safeParse({ effectiveFrom: '2026-01-01', owners: [owners[0]] }).success,
    ).toBe(false);
    expect(
      setOwnersSchema.safeParse({
        effectiveFrom: '2026-01-01',
        owners: [owners[0], { ...owners[0] }],
      }).success,
    ).toBe(false);
    expect(
      setOwnersSchema.safeParse({
        effectiveFrom: '2026-01-01',
        owners: [{ personId: P3, shareNumerator: 3, shareDenominator: 2 }],
      }).success,
    ).toBe(false);
  });
});

describe('dates and periods', () => {
  it('accepts real calendar dates only', () => {
    expect(dateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '26-01-01',
      '2026-1-1',
      '2026-01-01T00:00:00Z',
    ]) {
      expect(dateSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('computes the day before across month, year and leap-day boundaries', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2028-03-01')).toBe('2028-02-29');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });

  it('treats inclusive periods sharing a day as overlapping', () => {
    expect(periodsOverlap('2026-01-01', '2026-06-30', '2026-06-30', null)).toBe(true);
    expect(periodsOverlap('2026-01-01', '2026-06-30', '2026-07-01', null)).toBe(false);
    expect(periodsOverlap('2026-01-01', null, '2030-01-01', '2030-12-31')).toBe(true);
  });
});

describe('tenancies, people and vehicles', () => {
  it('requires exactly one primary tenant and an end on or after the start', () => {
    const base = {
      startDate: '2026-01-01',
      occupants: [{ personId: P1, isPrimary: true }, { personId: P2 }],
    };
    expect(createTenancySchema.safeParse(base).success).toBe(true);
    expect(createTenancySchema.safeParse({ ...base, occupants: [{ personId: P1 }] }).success).toBe(
      false,
    );
    expect(
      createTenancySchema.safeParse({
        ...base,
        occupants: [
          { personId: P1, isPrimary: true },
          { personId: P2, isPrimary: true },
        ],
      }).success,
    ).toBe(false);
    expect(createTenancySchema.safeParse({ ...base, endDate: '2025-12-31' }).success).toBe(false);
  });

  it('normalises phone numbers to E.164 and emails to lower case', () => {
    expect(
      createPersonSchema.parse({
        fullName: 'Ann',
        phone: '+92 300 123-4567',
        email: ' Ann@Example.TEST ',
      }),
    ).toMatchObject({
      phone: '+923001234567',
      email: 'ann@example.test',
    });
    expect(createPersonSchema.safeParse({ fullName: 'Ann', phone: '03001234567' }).success).toBe(
      false,
    );
  });

  it('normalises plates and requires a unit or a person', () => {
    expect(addVehicleSchema.parse({ plate: 'lea 1234', unitId: P1 }).plate).toBe('LEA1234');
    expect(addVehicleSchema.safeParse({ plate: 'LEA1234' }).success).toBe(false);
  });
});
