import { describe, expect, it } from 'vitest';
import {
  ageBucket,
  approvalRequestSchema,
  buildStatement,
  daysBetween,
  formatCreditNumber,
} from '../../src/modules/finance/domain/control-rules';

describe('ageing', () => {
  it('buckets by days past the due date', () => {
    expect(daysBetween('2027-01-31', '2027-03-01')).toBe(29);
    expect(ageBucket('2027-01-10', '2027-01-10')).toBe('current');
    expect(ageBucket('2027-01-10', '2027-01-01')).toBe('current');
    expect(ageBucket('2027-01-10', '2027-01-11')).toBe('days1to30');
    expect(ageBucket('2027-01-10', '2027-02-09')).toBe('days1to30');
    expect(ageBucket('2027-01-10', '2027-02-10')).toBe('days31to60');
    expect(ageBucket('2027-01-10', '2027-04-10')).toBe('days61to90');
    expect(ageBucket('2027-01-10', '2027-04-11')).toBe('over90');
  });
});

describe('statements', () => {
  it('orders events by date and keeps a running balance', () => {
    const at = (s: number) => new Date(1_800_000_000_000 + s * 1000);
    const { lines, balanceMinor } = buildStatement([
      {
        date: '2027-02-05',
        at: at(3),
        kind: 'PAYMENT',
        reference: 'RCT-1',
        debitMinor: 0n,
        creditMinor: 1500n,
      },
      {
        date: '2027-01-01',
        at: at(1),
        kind: 'INVOICE',
        reference: 'INV-1',
        debitMinor: 1000n,
        creditMinor: 0n,
      },
      {
        date: '2027-02-01',
        at: at(2),
        kind: 'INVOICE',
        reference: 'INV-2',
        debitMinor: 1000n,
        creditMinor: 0n,
      },
      {
        date: '2027-02-05',
        at: at(4),
        kind: 'CREDIT_NOTE',
        reference: 'CRN-1',
        debitMinor: 0n,
        creditMinor: 100n,
      },
    ]);
    expect(lines.map((l) => [l.reference, l.balanceMinor])).toEqual([
      ['INV-1', 1000n],
      ['INV-2', 2000n],
      ['RCT-1', 500n],
      ['CRN-1', 400n],
    ]);
    expect(balanceMinor).toBe(400n);
  });
});

describe('approval requests', () => {
  it('require the fields of their action', () => {
    const id = '0190b4a6-7a8e-7f00-8000-000000000001';
    expect(
      approvalRequestSchema.safeParse({ action: 'REFUND', paymentId: id, reason: 'x' }).success,
    ).toBe(false);
    expect(
      approvalRequestSchema.safeParse({
        action: 'REFUND',
        paymentId: id,
        amount: '10',
        method: 'GATEWAY',
        reason: 'x',
      }).success,
    ).toBe(false);
    expect(
      approvalRequestSchema.safeParse({ action: 'REOPEN_PERIOD', periodId: id, reason: ' ' })
        .success,
    ).toBe(false);
    expect(
      approvalRequestSchema.safeParse({
        action: 'WRITE_OFF',
        invoiceId: id,
        amount: '10',
        reason: 'Bad debt',
      }).success,
    ).toBe(true);
    expect(formatCreditNumber(7)).toBe('CRN-000007');
  });
});
