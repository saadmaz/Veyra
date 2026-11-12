import { describe, expect, it } from 'vitest';
import {
  addInterval,
  createAssetSchema,
  isDue,
  nextDueAfter,
} from '../../src/modules/maintenance/domain/asset-rules';

describe('schedule dates', () => {
  it('add days, weeks and months, keeping the day or the end of a shorter month', () => {
    expect(addInterval('2026-11-30', 'DAY', 2)).toBe('2026-12-02');
    expect(addInterval('2026-12-28', 'WEEK', 1)).toBe('2027-01-04');
    expect(addInterval('2027-01-31', 'MONTH', 1)).toBe('2027-02-28');
    expect(addInterval('2028-01-31', 'MONTH', 1)).toBe('2028-02-29');
    expect(addInterval('2026-11-15', 'MONTH', 3)).toBe('2027-02-15');
    expect(addInterval('2026-12-01', 'DAY', -7)).toBe('2026-11-24');
  });

  it('are due within the lead time or late', () => {
    expect(isDue('2026-12-01', 7, '2026-11-23')).toBe(false);
    expect(isDue('2026-12-01', 7, '2026-11-24')).toBe(true);
    expect(isDue('2026-11-01', 0, '2026-11-12')).toBe(true);
  });

  it('skip missed periods instead of raising them all', () => {
    // Monthly from 1 August, raised on 12 November: next is 1 December, not September.
    expect(nextDueAfter('2026-08-01', 'MONTH', 1, '2026-11-12')).toBe('2026-12-01');
    expect(nextDueAfter('2026-12-01', 'MONTH', 3, '2026-11-24')).toBe('2027-03-01');
  });
});

describe('asset input', () => {
  it('upper-cases tags and needs exactly one place', () => {
    const area = '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f60';
    const parsed = createAssetSchema.parse({
      tag: 'lift-01',
      name: 'Passenger lift',
      category: 'LIFT',
      commonAreaId: area,
    });
    expect(parsed.tag).toBe('LIFT-01');
    expect(createAssetSchema.safeParse({ tag: 'X', name: 'X', category: 'LIFT' }).success).toBe(
      false,
    );
    expect(
      createAssetSchema.safeParse({
        tag: 'bad tag',
        name: 'X',
        category: 'LIFT',
        commonAreaId: area,
      }).success,
    ).toBe(false);
  });
});
