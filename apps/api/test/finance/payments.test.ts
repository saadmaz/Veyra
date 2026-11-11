import { describe, expect, it } from 'vitest';
import { cashAccountKey, planAllocations } from '../../src/modules/finance/domain/finance-rules';
import {
  SANDBOX_SIGNATURE_HEADER,
  SandboxPaymentGateway,
  signSandboxPayload,
} from '../../src/modules/finance/infrastructure/sandbox-payment-gateway';

describe('oldest-first allocation', () => {
  it('pays the oldest invoices from the oldest payments and keeps the rest as credit', () => {
    const plan = planAllocations(
      [
        { paymentId: 'p1', remainingMinor: 700n },
        { paymentId: 'p2', remainingMinor: 500n },
      ],
      [
        { invoiceId: 'i1', outstandingMinor: 500n },
        { invoiceId: 'i2', outstandingMinor: 400n },
        { invoiceId: 'i3', outstandingMinor: 1000n },
      ],
    );
    expect(plan).toEqual([
      { paymentId: 'p1', invoiceId: 'i1', amountMinor: 500n },
      { paymentId: 'p1', invoiceId: 'i2', amountMinor: 200n },
      { paymentId: 'p2', invoiceId: 'i2', amountMinor: 200n },
      { paymentId: 'p2', invoiceId: 'i3', amountMinor: 300n },
    ]);
  });

  it('does nothing without credit or without unpaid invoices', () => {
    expect(planAllocations([], [{ invoiceId: 'i1', outstandingMinor: 1n }])).toEqual([]);
    expect(planAllocations([{ paymentId: 'p1', remainingMinor: 1n }], [])).toEqual([]);
  });

  it('books cash to cash, gateway money to clearing and the rest to the bank', () => {
    expect(cashAccountKey('CASH')).toBe('CASH');
    expect(cashAccountKey('GATEWAY')).toBe('GATEWAY_CLEARING');
    expect(cashAccountKey('CHEQUE')).toBe('BANK');
    expect(cashAccountKey('BANK_TRANSFER')).toBe('BANK');
  });
});

describe('sandbox gateway callbacks', () => {
  const secret = 'a'.repeat(40);
  const gateway = new SandboxPaymentGateway(secret);
  const now = new Date('2027-01-10T10:00:00Z');
  const t = Math.floor(now.getTime() / 1000);
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'payment.succeeded',
    data: { reference: 'sbx_abcdefgh', amountMinor: '150050', currency: 'PKR' },
  });
  const verify = (raw: string, signature: string | undefined, at = now) =>
    gateway.verifyCallback(Buffer.from(raw), { [SANDBOX_SIGNATURE_HEADER]: signature }, at);

  it('accepts a correctly signed event', () => {
    expect(verify(body, signSandboxPayload(secret, body, t))).toEqual({
      eventId: 'evt_1',
      providerReference: 'sbx_abcdefgh',
      type: 'payment.succeeded',
      amountMinor: 150050n,
      currency: 'PKR',
    });
  });

  it('refuses missing, wrong, tampered and stale signatures', () => {
    expect(verify(body, undefined)).toBeNull();
    expect(verify(body, signSandboxPayload('b'.repeat(40), body, t))).toBeNull();
    expect(
      verify(body.replace('150050', '999999'), signSandboxPayload(secret, body, t)),
    ).toBeNull();
    expect(
      verify(body, signSandboxPayload(secret, body, t), new Date(now.getTime() + 301_000)),
    ).toBeNull();
    const notAnEvent = JSON.stringify({ id: 'x' });
    expect(verify(notAnEvent, signSandboxPayload(secret, notAnEvent, t))).toBeNull();
  });

  it('creates unguessable references', async () => {
    const a = await gateway.createCheckout({ amountMinor: 1n, currency: 'PKR', description: 'x' });
    const b = await gateway.createCheckout({ amountMinor: 1n, currency: 'PKR', description: 'x' });
    expect(a.providerReference).toMatch(/^sbx_[A-Za-z0-9_-]{24}$/);
    expect(a.providerReference).not.toBe(b.providerReference);
  });
});
