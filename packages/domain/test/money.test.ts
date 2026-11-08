import { describe, expect, it } from 'vitest';
import { DomainError, Money } from '../src';

describe('Money', () => {
  it('parses decimal strings using the currency minor unit', () => {
    expect(Money.parse('1250.50', 'USD').amountMinor).toBe(125050n);
    expect(Money.parse('1250', 'JPY').amountMinor).toBe(1250n);
    expect(Money.parse('1.234', 'KWD').amountMinor).toBe(1234n);
    expect(Money.parse('-0.05', 'EUR').amountMinor).toBe(-5n);
  });

  it('rejects more decimal places than the currency supports instead of rounding', () => {
    expect(() => Money.parse('10.005', 'USD')).toThrow(DomainError);
    expect(() => Money.parse('10.5', 'JPY')).toThrow(DomainError);
  });

  it('rejects malformed amounts and currency codes', () => {
    expect(() => Money.parse('1e5', 'USD')).toThrow(DomainError);
    expect(() => Money.parse('12.', 'USD')).toThrow(DomainError);
    expect(() => Money.zero('usd')).toThrow(DomainError);
    expect(() => Money.zero('US')).toThrow(DomainError);
  });

  it('does not suffer floating-point drift', () => {
    const a = Money.parse('0.10', 'USD');
    const b = Money.parse('0.20', 'USD');
    expect(a.add(b).equals(Money.parse('0.30', 'USD'))).toBe(true);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const big = Money.parse('90071992547409.93', 'USD');
    expect(big.add(Money.parse('0.01', 'USD')).toDecimalString()).toBe('90071992547409.94');
  });

  it('refuses to combine different currencies', () => {
    const usd = Money.parse('1.00', 'USD');
    const pkr = Money.parse('1.00', 'PKR');
    expect(() => usd.add(pkr)).toThrow(/Cannot combine USD with PKR/);
    expect(() => usd.compare(pkr)).toThrow(DomainError);
  });

  it('allocates without losing or creating minor units', () => {
    const parts = Money.parse('100.00', 'USD').allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([3334n, 3333n, 3333n]);
    const sum = parts.reduce((acc, p) => acc.add(p), Money.zero('USD'));
    expect(sum.amountMinor).toBe(10000n);
  });

  it('allocates negative amounts and skips zero ratios', () => {
    const parts = Money.ofMinor(-10n, 'USD').allocate([0n, 1n, 2n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([0n, -4n, -6n]);
  });

  it('rejects invalid allocation ratios', () => {
    expect(() => Money.zero('USD').allocate([])).toThrow(DomainError);
    expect(() => Money.zero('USD').allocate([0n, 0n])).toThrow(DomainError);
    expect(() => Money.zero('USD').allocate([-1n, 2n])).toThrow(DomainError);
  });

  it('formats and round-trips through JSON as strings', () => {
    const m = Money.parse('-1250.05', 'USD');
    expect(m.toDecimalString()).toBe('-1250.05');
    expect(JSON.stringify(m)).toBe('{"amountMinor":"-125005","currency":"USD"}');
    expect(Money.fromJSON(m.toJSON()).equals(m)).toBe(true);
    expect(Money.ofMinor(5n, 'USD').toDecimalString()).toBe('0.05');
    expect(Money.ofMinor(5n, 'JPY').toDecimalString()).toBe('5');
  });

  it('rejects non-integer JSON amounts', () => {
    expect(() => Money.fromJSON({ amountMinor: '1.5', currency: 'USD' })).toThrow(DomainError);
  });
});
