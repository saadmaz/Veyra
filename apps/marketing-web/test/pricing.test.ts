import { describe, expect, it } from 'vitest';
import { comparison, formatUsd, plans, unitPriceCents } from '../src/lib/pricing';

describe('pricing', () => {
  it('keeps every list price in integer cents', () => {
    for (const p of plans) {
      if (p.monthlyCents !== null) expect(Number.isInteger(p.monthlyCents)).toBe(true);
    }
  });

  it('charges the monthly price on monthly billing', () => {
    expect(unitPriceCents(240, 'monthly')).toBe(240);
  });

  it('gives two months free on annual billing, rounded half-up to the cent', () => {
    expect(unitPriceCents(240, 'annual')).toBe(200);
    expect(unitPriceCents(160, 'annual')).toBe(133); // 133.33…
    expect(unitPriceCents(1, 'annual')).toBe(1); // 0.83… rounds up
  });

  it('rejects fractional or negative cents', () => {
    expect(() => unitPriceCents(1.5, 'monthly')).toThrow(RangeError);
    expect(() => unitPriceCents(-1, 'annual')).toThrow(RangeError);
  });

  it('formats cents as dollars', () => {
    expect(formatUsd(240)).toBe('$2.40');
    expect(formatUsd(133)).toBe('$1.33');
    expect(formatUsd(5)).toBe('$0.05');
  });

  it('has one comparison value per plan', () => {
    for (const row of comparison) expect(row.values).toHaveLength(plans.length);
  });
});
