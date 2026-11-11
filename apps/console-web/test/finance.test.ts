import type { InvoiceDto } from '@veyra/api-contracts';
import { describe, expect, it } from 'vitest';
import { ApiRequestError, NETWORK_ERROR } from '../src/lib/api-client';
import {
  addDays,
  balanceText,
  canDiscardIdempotencyKey,
  formatMoney,
  formatMonth,
  invoiceState,
  laterDate,
  minMoney,
  moneyInput,
  parseAmount,
} from '../src/lib/finance';
import { errorMessage } from '../src/lib/messages';

const pkr = (amountMinor: string) => ({ amountMinor, currency: 'PKR' });

describe('money display', () => {
  it('uses the ISO 4217 minor unit of each currency, never floating point', () => {
    expect(formatMoney(pkr('1250050'))).toBe('PKR 12,500.50');
    expect(formatMoney({ amountMinor: '1500', currency: 'JPY' })).toBe('JPY 1,500');
    expect(formatMoney({ amountMinor: '1234567', currency: 'KWD' })).toBe('KWD 1,234.567');
    expect(formatMoney(pkr('5'))).toBe('PKR 0.05');
    expect(formatMoney(pkr('-50000'))).toBe('-PKR 500.00');
    // Beyond Number.MAX_SAFE_INTEGER: exact.
    expect(formatMoney(pkr('900719925474099312'))).toBe('PKR 9,007,199,254,740,993.12');
  });

  it('prefills inputs with a plain decimal and compares exactly', () => {
    expect(moneyInput(pkr('1250050'))).toBe('12500.50');
    expect(minMoney(pkr('900719925474099313'), pkr('900719925474099312'))).toEqual(
      pkr('900719925474099312'),
    );
  });
});

describe('amounts typed by people', () => {
  it('accepts positive amounts within the currency decimals, ignoring separators', () => {
    expect(parseAmount('12,500.5', 'PKR')).toEqual({ ok: true, value: '12500.50' });
    expect(parseAmount(' 1500 ', 'JPY')).toEqual({ ok: true, value: '1500' });
    expect(parseAmount('1.125', 'KWD')).toEqual({ ok: true, value: '1.125' });
  });

  it('refuses rounding, zero, negatives and text', () => {
    expect(parseAmount('10.005', 'PKR')).toEqual({
      ok: false,
      error: 'PKR amounts have at most 2 decimals.',
    });
    expect(parseAmount('10.5', 'JPY')).toEqual({
      ok: false,
      error: 'JPY amounts have no decimals.',
    });
    expect(parseAmount('0', 'PKR')).toMatchObject({ ok: false });
    expect(parseAmount('-5', 'PKR')).toMatchObject({ ok: false });
    expect(parseAmount('ten', 'PKR')).toEqual({
      ok: false,
      error: 'Enter an amount such as 1500.50.',
    });
    expect(parseAmount('', 'PKR')).toEqual({ ok: false, error: 'Enter an amount.' });
  });
});

describe('dates and months', () => {
  it('formats months and moves dates without time zone shifts', () => {
    expect(formatMonth('2026-11')).toBe('November 2026');
    expect(formatMonth('nonsense')).toBe('nonsense');
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(laterDate('2026-11-01', '2026-10-31')).toBe('2026-11-01');
    expect(laterDate('2026-10-31', '2026-11-01')).toBe('2026-11-01');
  });
});

describe('payment retries', () => {
  it('keeps the Idempotency-Key unless the API certainly recorded nothing', () => {
    expect(canDiscardIdempotencyKey(new ApiRequestError(422, 'VALIDATION_FAILED', 'x'))).toBe(true);
    expect(canDiscardIdempotencyKey(new ApiRequestError(400, 'VALIDATION_FAILED', 'x'))).toBe(true);
    // The first attempt may have been recorded: retry with the same key.
    expect(canDiscardIdempotencyKey(new ApiRequestError(0, NETWORK_ERROR, 'x'))).toBe(false);
    expect(canDiscardIdempotencyKey(new ApiRequestError(500, 'INTERNAL', 'x'))).toBe(false);
    expect(canDiscardIdempotencyKey(new ApiRequestError(409, 'IDEMPOTENCY_KEY_REUSED', 'x'))).toBe(
      false,
    );
    expect(canDiscardIdempotencyKey(new Error('x'))).toBe(false);
  });
});

describe('invoice state', () => {
  const invoice = (overrides: Partial<InvoiceDto>): InvoiceDto => ({
    id: 'i',
    number: 'INV-000001',
    status: 'ISSUED',
    unitId: 'u',
    unitNumber: '101',
    billTo: 'OWNERS',
    recipients: [],
    billingMonth: '2026-11',
    billingDate: '2026-11-01',
    dueDate: '2026-11-15',
    issueDate: '2026-11-01',
    total: pkr('1000'),
    paid: pkr('0'),
    credited: pkr('0'),
    outstanding: pkr('1000'),
    overdue: false,
    createdAt: '',
    issuedAt: '',
    ...overrides,
  });

  it('says where an invoice stands', () => {
    expect(invoiceState(invoice({ status: 'DRAFT', number: null }))).toBe('draft');
    expect(invoiceState(invoice({}))).toBe('issued');
    expect(invoiceState(invoice({ paid: pkr('400'), outstanding: pkr('600') }))).toBe('part paid');
    expect(invoiceState(invoice({ overdue: true }))).toBe('overdue');
    expect(invoiceState(invoice({ paid: pkr('1000'), outstanding: pkr('0') }))).toBe('settled');
  });
});

describe('finance error messages', () => {
  it('shows business-rule refusals in their own words, but never server errors', () => {
    expect(
      errorMessage(
        new ApiRequestError(
          422,
          'VALIDATION_FAILED',
          'That is more than what is left of this payment',
        ),
      ),
    ).toBe('That is more than what is left of this payment');
    expect(
      errorMessage(
        new ApiRequestError(422, 'VALIDATION_FAILED', 'x', [{ path: 'amount', message: 'bad' }]),
      ),
    ).toBe('Some fields need attention.');
    expect(errorMessage(new ApiRequestError(403, 'SAME_PERSON', 'x'))).toBe(
      'Someone other than the person who asked must decide this.',
    );
    expect(errorMessage(new ApiRequestError(500, 'INTERNAL', 'stack trace'))).not.toContain(
      'stack',
    );
  });
});

describe("residents' account (Phase 6 Part 6)", () => {
  it('says what is owed or held in credit, in words', () => {
    expect(balanceText(pkr('100000'))).toBe('PKR 1,000.00 owed');
    expect(balanceText(pkr('-25050'))).toBe('PKR 250.50 in credit');
    expect(balanceText(pkr('0'))).toBe('Nothing owed');
  });

  it('explains a full transfer queue', () => {
    const error = new ApiRequestError(409, 'TOO_MANY_PENDING', 'raw server text');
    expect(errorMessage(error)).toMatch(/waiting for finance/);
  });
});
