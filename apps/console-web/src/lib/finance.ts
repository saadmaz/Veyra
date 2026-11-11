import type {
  FinanceApprovalAction,
  InvoiceDto,
  MoneyDto,
  PaymentMethod,
  StatementLineKind,
} from '@veyra/api-contracts';
import { DomainError, Money } from '@veyra/domain';
import { ApiRequestError } from './api-client';

/*
 * Finance helpers for the console. Amounts arrive as minor units in strings and are handled as
 * bigint through Money, never as JavaScript numbers. Amounts are sent back as decimal strings in
 * the property's currency; the API checks them again.
 */

const minor = (money: MoneyDto) => BigInt(money.amountMinor);

/** Groups the whole part of a decimal string by thousands: "1250000.50" → "1,250,000.50". */
function groupThousands(decimal: string): string {
  const [whole = '0', fraction] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** "PKR 12,500.50", or "-PKR 500.00" for a negative amount. Uses the ISO 4217 minor unit. */
export function formatMoney(money: MoneyDto): string {
  const decimal = Money.fromJSON(money).toDecimalString();
  const negative = decimal.startsWith('-');
  const text = `${money.currency} ${groupThousands(negative ? decimal.slice(1) : decimal)}`;
  return negative ? `-${text}` : text;
}

/** The amount as a plain decimal string, for prefilling an amount input ("12500.50"). */
export function moneyInput(money: MoneyDto): string {
  return Money.fromJSON(money).toDecimalString();
}

export const isZero = (money: MoneyDto) => minor(money) === 0n;
export const isPositive = (money: MoneyDto) => minor(money) > 0n;
export const isNegative = (money: MoneyDto) => minor(money) < 0n;

/** The smaller of two amounts in the same currency. */
export function minMoney(a: MoneyDto, b: MoneyDto): MoneyDto {
  return minor(a) <= minor(b) ? a : b;
}

/**
 * Checks an amount typed by a person: a positive decimal with no more decimals than the
 * currency has. Spaces and thousands separators are ignored. Returns the normalised decimal
 * string to send, or an error message.
 */
export function parseAmount(
  text: string,
  currency: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const cleaned = text.replace(/[\s,]/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter an amount.' };
  try {
    const money = Money.parse(cleaned, currency);
    if (money.isNegative() || money.isZero()) {
      return { ok: false, error: 'Enter an amount more than zero.' };
    }
    return { ok: true, value: money.toDecimalString() };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const exponent = Money.minorUnitExponent(currency);
    if (/^\d+\.\d+$/.test(cleaned)) {
      return {
        ok: false,
        error:
          exponent === 0
            ? `${currency} amounts have no decimals.`
            : `${currency} amounts have at most ${exponent} decimals.`,
      };
    }
    return {
      ok: false,
      error: `Enter an amount such as ${exponent === 0 ? '1500' : `1500.${'5'.padEnd(exponent, '0')}`}.`,
    };
  }
}

/** "2026-11" → "November 2026". */
export function formatMonth(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00Z`);
  if (!/^\d{4}-\d{2}$/.test(month) || Number.isNaN(parsed.getTime())) return month;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(parsed);
}

/** A property-local date plus some days ("2026-11-30", 5 → "2026-12-05"). */
export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Payments carry an Idempotency-Key so a retry never records the money twice. The key is kept
 * for a retry unless the API certainly recorded nothing: a 400 or 422 refusal. After a network
 * failure, a server error or a conflict the first attempt may have been recorded, so the same
 * key must be sent again (the API then returns the payment it already has).
 */
export function canDiscardIdempotencyKey(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 400 || error.status === 422);
}

export const PARTY_LABELS: Record<'OWNERS' | 'TENANTS', string> = {
  OWNERS: 'Owners',
  TENANTS: 'Tenants',
};

export const LIABLE_PARTY_LABELS: Record<'OWNERS' | 'OCCUPANT', string> = {
  OWNERS: 'Owners',
  OCCUPANT: 'Occupant (tenants, or owners while vacant)',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  GATEWAY: 'Online',
};

export const MANUAL_PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CHEQUE'] as const;

export const APPROVAL_ACTION_LABELS: Record<FinanceApprovalAction, string> = {
  REVERSE_PAYMENT: 'Reverse a payment',
  REFUND: 'Refund',
  WRITE_OFF: 'Write off',
  REOPEN_PERIOD: 'Reopen a period',
};

export const STATEMENT_KIND_LABELS: Record<StatementLineKind, string> = {
  INVOICE: 'Invoice',
  CREDIT_NOTE: 'Credit note',
  WRITE_OFF: 'Write-off',
  PAYMENT: 'Payment',
  REFUND: 'Refund',
  PAYMENT_REVERSAL: 'Payment reversed',
};

export type InvoiceState = 'draft' | 'settled' | 'overdue' | 'part paid' | 'issued';

/** One word for where an invoice stands, for lists and badges. */
export function invoiceState(invoice: InvoiceDto): InvoiceState {
  if (invoice.status === 'DRAFT') return 'draft';
  if (isZero(invoice.outstanding)) return 'settled';
  if (invoice.overdue) return 'overdue';
  if (isPositive(invoice.paid) || isPositive(invoice.credited)) return 'part paid';
  return 'issued';
}

export const INVOICE_STATE_TONES: Record<InvoiceState, 'success' | 'warning' | 'muted' | 'danger'> =
  {
    draft: 'muted',
    settled: 'success',
    overdue: 'danger',
    'part paid': 'warning',
    issued: 'muted',
  };

/** The later of two property-local dates ("YYYY-MM-DD" strings sort chronologically). */
export function laterDate(a: string, b: string): string {
  return [a, b].sort()[1] ?? a;
}
