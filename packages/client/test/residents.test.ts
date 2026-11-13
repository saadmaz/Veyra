import type { OwnershipDto } from '@veyra/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatPeriod,
  formatShare,
  groupOwnerships,
  parseShare,
  periodStatus,
  sharesSumToOne,
  todayIn,
} from '../src/residents';

describe('parseShare', () => {
  it('reads whole numbers and fractions', () => {
    expect(parseShare('1')).toEqual({ shareNumerator: 1, shareDenominator: 1 });
    expect(parseShare('1/2')).toEqual({ shareNumerator: 1, shareDenominator: 2 });
    expect(parseShare(' 2 / 3 ')).toEqual({ shareNumerator: 2, shareDenominator: 3 });
  });

  it('rejects anything that is not a share of at most the whole unit', () => {
    for (const text of ['', '0', '0/2', '3/2', '1/0', '0.5', '50%', '-1/2', '1/2/3', 'abc']) {
      expect(parseShare(text), text).toBeNull();
    }
    expect(parseShare('1/1000001')).toBeNull();
  });
});

describe('sharesSumToOne', () => {
  const s = (n: number, d: number) => ({ shareNumerator: n, shareDenominator: d });

  it('accepts exact sums, including thirds that floating point gets wrong', () => {
    expect(sharesSumToOne([s(1, 1)])).toBe(true);
    expect(sharesSumToOne([s(1, 2), s(1, 2)])).toBe(true);
    expect(sharesSumToOne([s(1, 3), s(1, 3), s(1, 3)])).toBe(true);
    expect(sharesSumToOne([s(1, 10), s(2, 10), s(7, 10)])).toBe(true);
  });

  it('rejects sums that are not exactly one', () => {
    expect(sharesSumToOne([])).toBe(false);
    expect(sharesSumToOne([s(1, 2)])).toBe(false);
    expect(sharesSumToOne([s(1, 2), s(2, 3)])).toBe(false);
    expect(sharesSumToOne([s(333_333, 1_000_000), s(2, 3)])).toBe(false);
  });
});

describe('dates and periods', () => {
  it("computes today in the property's time zone, not the viewer's", () => {
    // 20:30 UTC on 31 Dec is already 1 Jan in Karachi (UTC+5) but not in New York.
    const instant = new Date('2026-12-31T20:30:00Z');
    expect(todayIn('Asia/Karachi', instant)).toBe('2027-01-01');
    expect(todayIn('America/New_York', instant)).toBe('2026-12-31');
  });

  it('formats calendar dates without shifting them', () => {
    expect(formatDate('2026-01-05')).toBe('5 Jan 2026');
    expect(formatPeriod('2026-01-05', null)).toBe('From 5 Jan 2026');
    expect(formatPeriod('2026-01-05', '2026-06-30')).toBe('5 Jan 2026 to 30 Jun 2026');
  });

  it('classifies periods with inclusive end dates', () => {
    const today = '2026-06-15';
    expect(periodStatus('2026-01-01', null, null, today)).toBe('CURRENT');
    expect(periodStatus('2026-01-01', '2026-06-15', null, today)).toBe('CURRENT');
    expect(periodStatus('2026-01-01', '2026-06-14', null, today)).toBe('ENDED');
    expect(periodStatus('2026-06-16', null, null, today)).toBe('UPCOMING');
    expect(periodStatus('2026-01-01', null, '2026-02-01T00:00:00Z', today)).toBe('VOIDED');
  });

  it('describes shares', () => {
    expect(formatShare({ shareNumerator: 1, shareDenominator: 1 })).toBe('Whole unit');
    expect(formatShare({ shareNumerator: 1, shareDenominator: 2 })).toBe('1/2');
  });
});

describe('groupOwnerships', () => {
  const ownership = (
    personId: string,
    effectiveFrom: string,
    extra: Partial<OwnershipDto> = {},
  ): OwnershipDto => ({
    id: `${personId}-${effectiveFrom}`,
    unitId: 'unit',
    personId,
    fullName: personId,
    shareNumerator: 1,
    shareDenominator: 2,
    effectiveFrom,
    effectiveTo: null,
    voidedAt: null,
    voidReason: null,
    ...extra,
  });

  it('groups owners recorded together, newest change first, voided after live', () => {
    const groups = groupOwnerships([
      ownership('a', '2025-01-01', { effectiveTo: '2025-12-31' }),
      ownership('b', '2025-01-01', { effectiveTo: '2025-12-31' }),
      ownership('c', '2026-01-01', { voidedAt: '2026-01-02T00:00:00Z', voidReason: 'Typo' }),
      ownership('d', '2026-01-01'),
    ]);
    expect(groups.map((g) => g.owners.map((o) => o.personId))).toEqual([['d'], ['c'], ['a', 'b']]);
    expect(groups[1]?.voidReason).toBe('Typo');
  });
});
