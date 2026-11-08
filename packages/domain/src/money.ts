import { DomainError } from './errors';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * ISO 4217 minor-unit exponents that differ from the default of 2.
 * Deliberately NOT taken from Intl.NumberFormat: Intl reflects CLDR *display* conventions
 * (e.g. it shows PKR, HUF and TWD with 0 decimals), while accounting must use the ISO 4217
 * minor unit (PKR has 2: paisa). Keep in sync with the ISO 4217 list when it changes.
 */
const ISO_4217_EXPONENTS: Readonly<Record<string, number>> = {
  // 0 decimals
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // 3 decimals
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // 4 decimals
  CLF: 4,
  UYW: 4,
};

/** Serialised form used in APIs: amount as a string so JSON never loses precision. */
export interface MoneyJson {
  amountMinor: string;
  currency: string;
}

/**
 * Immutable monetary amount in the currency's minor unit (e.g. cents, paisa).
 * Backed by bigint: never use JavaScript floating-point numbers for money.
 */
export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: string,
  ) {}

  static ofMinor(amountMinor: bigint, currency: string): Money {
    return new Money(amountMinor, Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return Money.ofMinor(0n, currency);
  }

  /**
   * Parses a decimal string such as "1250.50" using the currency's minor-unit exponent.
   * Rejects more fractional digits than the currency supports instead of rounding silently.
   */
  static parse(decimal: string, currency: string): Money {
    const code = Money.assertCurrency(currency);
    const exponent = Money.minorUnitExponent(code);
    const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
    if (!match) {
      throw new DomainError('INVALID_MONEY', `Invalid monetary amount "${decimal}"`);
    }
    const [, sign, whole = '0', fraction = ''] = match;
    if (fraction.length > exponent) {
      throw new DomainError(
        'INVALID_MONEY',
        `${code} supports at most ${exponent} decimal places, got "${decimal}"`,
      );
    }
    const minor = BigInt(whole + fraction.padEnd(exponent, '0'));
    return new Money(sign ? -minor : minor, code);
  }

  static fromJSON(json: MoneyJson): Money {
    if (!/^-?\d+$/.test(json.amountMinor)) {
      throw new DomainError('INVALID_MONEY', `Invalid amountMinor "${json.amountMinor}"`);
    }
    return Money.ofMinor(BigInt(json.amountMinor), json.currency);
  }

  /** ISO 4217 minor-unit digits for a currency code (USD 2, PKR 2, JPY 0, KWD 3). */
  static minorUnitExponent(currency: string): number {
    const code = Money.assertCurrency(currency);
    return ISO_4217_EXPONENTS[code] ?? 2;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  multiply(factor: bigint): Money {
    return new Money(this.amountMinor * factor, this.currency);
  }

  negate(): Money {
    return new Money(-this.amountMinor, this.currency);
  }

  /**
   * Splits the amount by integer ratios without losing or creating minor units.
   * Remainders are distributed one unit at a time to the first parts.
   */
  allocate(ratios: readonly bigint[]): Money[] {
    if (ratios.length === 0 || ratios.some((r) => r < 0n)) {
      throw new DomainError('INVALID_ALLOCATION', 'Ratios must be non-empty and non-negative');
    }
    const total = ratios.reduce((sum, r) => sum + r, 0n);
    if (total === 0n) {
      throw new DomainError('INVALID_ALLOCATION', 'Ratios must not all be zero');
    }
    const sign = this.amountMinor < 0n ? -1n : 1n;
    const absolute = this.amountMinor * sign;
    const parts = ratios.map((r) => (absolute * r) / total);
    let remainder = absolute - parts.reduce((sum, p) => sum + p, 0n);
    for (let i = 0; remainder > 0n; i = (i + 1) % parts.length) {
      if ((ratios[i] ?? 0n) === 0n) continue;
      parts[i] = (parts[i] ?? 0n) + 1n;
      remainder -= 1n;
    }
    return parts.map((p) => new Money(p * sign, this.currency));
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amountMinor === other.amountMinor) return 0;
    return this.amountMinor < other.amountMinor ? -1 : 1;
  }

  /** Exact decimal representation, e.g. "1250.50". */
  toDecimalString(): string {
    const exponent = Money.minorUnitExponent(this.currency);
    const negative = this.amountMinor < 0n;
    const digits = (negative ? -this.amountMinor : this.amountMinor)
      .toString()
      .padStart(exponent + 1, '0');
    const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
    const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
    return `${negative ? '-' : ''}${whole}${fraction}`;
  }

  toJSON(): MoneyJson {
    return { amountMinor: this.amountMinor.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }

  private static assertCurrency(currency: string): string {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new DomainError('INVALID_CURRENCY', `Invalid ISO 4217 currency code "${currency}"`);
    }
    return currency;
  }
}
