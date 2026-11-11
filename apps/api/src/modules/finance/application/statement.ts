import { buildStatement, formatCreditNumber, type StatementEvent } from '../domain/control-rules';
import { formatInvoiceNumber, formatReceiptNumber } from '../domain/finance-rules';
import type { FinanceUnitOfWork, Party } from './finance-ports';

/**
 * Everything billed to and paid by one party of a unit, with a running balance. Shared by the
 * staff statement (Phase 6 Part 4) and residents' own statement (Part 6), so both always agree.
 */
export async function partyStatement(uow: FinanceUnitOfWork, unitId: string, party: Party) {
  const data = await uow.statementData(unitId, party);
  const events: StatementEvent[] = [
    ...data.invoices.map((i) => ({
      date: i.issueDate,
      at: i.issuedAt,
      kind: 'INVOICE' as const,
      reference: formatInvoiceNumber(i.invoiceNumber),
      debitMinor: i.totalMinor,
      creditMinor: 0n,
    })),
    ...data.credits.map((c) => ({
      date: c.creditedOn,
      at: c.createdAt,
      kind: c.kind,
      reference:
        c.kind === 'CREDIT_NOTE' && c.creditNumber !== null
          ? formatCreditNumber(c.creditNumber)
          : `Write-off ${formatInvoiceNumber(c.invoiceNumber ?? 0n)}`,
      debitMinor: 0n,
      creditMinor: c.amountMinor,
    })),
    ...data.payments.map((p) => ({
      date: p.receivedOn,
      at: p.createdAt,
      kind: 'PAYMENT' as const,
      reference: formatReceiptNumber(p.receiptNumber),
      debitMinor: 0n,
      creditMinor: p.amountMinor,
    })),
    ...data.refunds.map((r) => ({
      date: r.refundedOn,
      at: r.createdAt,
      kind: 'REFUND' as const,
      reference: `Refund ${formatReceiptNumber(r.receiptNumber)}`,
      debitMinor: r.amountMinor,
      creditMinor: 0n,
    })),
    ...data.reversals.map((r) => ({
      date: r.reversedOn,
      at: r.createdAt,
      kind: 'PAYMENT_REVERSAL' as const,
      reference: `Reversal ${formatReceiptNumber(r.receiptNumber)}`,
      debitMinor: r.amountMinor,
      creditMinor: 0n,
    })),
  ];
  return buildStatement(events);
}
