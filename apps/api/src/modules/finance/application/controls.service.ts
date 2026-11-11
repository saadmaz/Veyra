import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  AGE_BUCKETS,
  type AgeBucket,
  type ApprovalRequestInput,
  ageBucket,
  buildStatement,
  type CreditNoteInput,
  formatCreditNumber,
  type StatementEvent,
} from '../domain/control-rules';
import {
  cashAccountKey,
  formatInvoiceNumber,
  formatReceiptNumber,
  type IsoDate,
  parsePositiveAmount,
} from '../domain/finance-rules';
import { postAllocationEntry, requireOpenPeriod, systemAccount } from './credit';
import {
  type ApprovalRecord,
  type ApprovalStatus,
  FINANCE_REPOSITORY,
  type FinanceRepository,
  type FinanceUnitOfWork,
  type Party,
  type PropertyFinanceInfo,
} from './finance-ports';

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (code: string, message: string) => new ApiError(409, code, message);
const invalid = (message: string) => new ApiError(422, 'VALIDATION_FAILED', message);

export interface AgeingRow {
  unitId: string;
  unitNumber: string;
  billTo: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  buckets: Record<AgeBucket, bigint>;
  totalMinor: bigint;
}

/**
 * Controls and reports (Phase 6 Part 4). Risky actions are requested by one person and carried
 * out only when another approves (owner decision: any finance officer or organisation admin
 * other than the requester). Credit notes correct issued invoices without approval. Statements
 * and ageing are read models over invoices, credits, payments, refunds and reversals.
 */
@Injectable()
export class ControlsService {
  constructor(@Inject(FINANCE_REPOSITORY) private readonly repository: FinanceRepository) {}

  // ------------------------------------------------------------------ periods

  periods(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.periods());
  }

  /** Closing needs no approval; reopening does (requestApproval REOPEN_PERIOD). */
  closePeriod(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const period = await uow.period(id);
      if (!period) throw notFound('Accounting period');
      if (period.status === 'CLOSED')
        throw conflict('ALREADY_CLOSED', 'This period is already closed');
      await uow.setPeriodStatus(id, 'CLOSED');
      await uow.audit({
        action: 'accounting_period.closed',
        resourceType: 'accounting_period',
        resourceId: id,
        metadata: { startDate: period.startDate, endDate: period.endDate },
      });
      return this.mustFindPeriod(uow, id);
    });
  }

  // ------------------------------------------------------------------ approvals

  /** Records the request after checking that the action would be allowed now. */
  requestApproval(access: OrganisationAccess, input: ApprovalRequestInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const request = {
        action: input.action,
        paymentId: null as string | null,
        invoiceId: null as string | null,
        periodId: null as string | null,
        amountMinor: null as bigint | null,
        refundMethod: null as ApprovalRecord['refundMethod'],
        reason: input.reason,
      };
      if (input.action === 'REVERSE_PAYMENT' || input.action === 'REFUND') {
        const payment = await uow.payment(input.paymentId);
        if (!payment) throw notFound('Payment');
        if (payment.reversedOn)
          throw conflict('PAYMENT_REVERSED', 'This payment was already reversed');
        request.paymentId = payment.id;
        if (input.action === 'REVERSE_PAYMENT' && payment.refundedMinor > 0n) {
          throw conflict('PAYMENT_REFUNDED', 'A refunded payment cannot be reversed');
        }
        if (input.action === 'REFUND') {
          request.amountMinor = parsePositiveAmount(input.amount, property.currency);
          request.refundMethod = input.method;
          if (request.amountMinor > unusedOf(payment)) {
            throw invalid(
              "That is more than this payment's unused money; release allocations first",
            );
          }
        }
      } else if (input.action === 'WRITE_OFF') {
        const invoice = await uow.invoice(input.invoiceId);
        if (!invoice) throw notFound('Invoice');
        if (invoice.status !== 'ISSUED') throw invalid('Only issued invoices are written off');
        request.invoiceId = invoice.id;
        request.amountMinor = parsePositiveAmount(input.amount, property.currency);
        if (request.amountMinor > outstandingOf(invoice)) {
          throw invalid('That is more than the invoice still owes');
        }
      } else {
        const period = await uow.period(input.periodId);
        if (!period) throw notFound('Accounting period');
        if (period.status !== 'CLOSED') throw conflict('NOT_CLOSED', 'This period is open');
        request.periodId = period.id;
      }
      const id = await uow.createApproval(request);
      await uow.audit({
        action: 'finance_approval.requested',
        resourceType: 'finance_approval',
        resourceId: id,
        metadata: {
          approvalAction: input.action,
          ...(request.amountMinor !== null ? { amountMinor: request.amountMinor.toString() } : {}),
        },
      });
      return this.mustFindApproval(uow, id);
    });
  }

  approvals(access: OrganisationAccess, filter: { status?: ApprovalStatus }, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.approvals(filter));
  }

  approval(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => this.mustFindApproval(uow, id));
  }

  /** A second person approves; the action is carried out in the same transaction. */
  approve(access: OrganisationAccess, id: string, note: string | null, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const approval = await this.pending(uow, id);
      if (approval.requestedByUserId === access.userId) {
        throw new ApiError(
          403,
          'SAME_PERSON',
          'Someone other than the requester must approve this',
        );
      }
      const property = await uow.property();
      await uow.decideApproval(id, 'APPROVED', note);
      await this.execute(uow, property, approval);
      await uow.audit({
        action: 'finance_approval.approved',
        resourceType: 'finance_approval',
        resourceId: id,
        metadata: { approvalAction: approval.action },
      });
      return this.mustFindApproval(uow, id);
    });
  }

  reject(access: OrganisationAccess, id: string, note: string | null, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const approval = await this.pending(uow, id);
      if (approval.requestedByUserId === access.userId) {
        throw new ApiError(
          403,
          'SAME_PERSON',
          'The requester cancels a request; someone else rejects it',
        );
      }
      await uow.decideApproval(id, 'REJECTED', note);
      await uow.audit({
        action: 'finance_approval.rejected',
        resourceType: 'finance_approval',
        resourceId: id,
        metadata: { approvalAction: approval.action },
      });
      return this.mustFindApproval(uow, id);
    });
  }

  /** Only the requester withdraws their own request. */
  cancel(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const approval = await this.pending(uow, id);
      if (approval.requestedByUserId !== access.userId) {
        throw new ApiError(403, 'NOT_REQUESTER', 'Only the requester can cancel a request');
      }
      await uow.decideApproval(id, 'CANCELLED', null);
      await uow.audit({
        action: 'finance_approval.cancelled',
        resourceType: 'finance_approval',
        resourceId: id,
      });
      return this.mustFindApproval(uow, id);
    });
  }

  private async execute(
    uow: FinanceUnitOfWork,
    property: PropertyFinanceInfo,
    approval: ApprovalRecord,
  ): Promise<void> {
    const today = property.today;
    if (approval.action === 'REOPEN_PERIOD') {
      const period = approval.periodId ? await uow.period(approval.periodId) : null;
      if (!period) throw notFound('Accounting period');
      if (period.status !== 'CLOSED') throw conflict('NOT_CLOSED', 'This period is already open');
      await uow.setPeriodStatus(period.id, 'OPEN');
      return;
    }
    await requireOpenPeriod(uow, today);
    const accounts = await uow.accounts();

    if (approval.action === 'WRITE_OFF') {
      const invoice = approval.invoiceId ? await uow.invoice(approval.invoiceId) : null;
      if (!invoice) throw notFound('Invoice');
      const amount = approval.amountMinor ?? 0n;
      if (amount > outstandingOf(invoice)) {
        throw conflict(
          'NO_LONGER_OWED',
          'The invoice no longer owes that much; ask for a new approval',
        );
      }
      const entryId = await uow.postEntry(
        'WRITE_OFF',
        `Write-off of ${formatInvoiceNumber(invoice.invoiceNumber ?? 0n)}`,
        today,
        property.currency,
        [
          {
            accountId: systemAccount(accounts, 'BAD_DEBT').id,
            unitId: null,
            debitMinor: amount,
            creditMinor: 0n,
          },
          {
            accountId: systemAccount(accounts, 'RECEIVABLES').id,
            unitId: invoice.unitId,
            debitMinor: 0n,
            creditMinor: amount,
          },
        ],
      );
      await uow.createInvoiceCredit({
        unitId: invoice.unitId,
        invoiceId: invoice.id,
        kind: 'WRITE_OFF',
        lineNumber: null,
        amountMinor: amount,
        reason: approval.reason,
        creditedOn: today,
        journalEntryId: entryId,
        approvalId: approval.id,
      });
      return;
    }

    const payment = approval.paymentId ? await uow.payment(approval.paymentId) : null;
    if (!payment) throw notFound('Payment');
    if (payment.reversedOn) throw conflict('PAYMENT_REVERSED', 'This payment was already reversed');

    if (approval.action === 'REFUND') {
      const amount = approval.amountMinor ?? 0n;
      const method = approval.refundMethod ?? 'BANK_TRANSFER';
      if (amount > unusedOf(payment)) {
        throw conflict(
          'NO_LONGER_UNUSED',
          "The payment's unused money is less now; ask for a new approval",
        );
      }
      const entryId = await uow.postEntry(
        'REFUND',
        `Refund of ${formatReceiptNumber(payment.receiptNumber)}`,
        today,
        property.currency,
        [
          {
            accountId: systemAccount(accounts, 'UNIT_CREDIT').id,
            unitId: payment.unitId,
            debitMinor: amount,
            creditMinor: 0n,
          },
          {
            accountId: systemAccount(accounts, cashAccountKey(method)).id,
            unitId: null,
            debitMinor: 0n,
            creditMinor: amount,
          },
        ],
      );
      await uow.createRefund({
        unitId: payment.unitId,
        paymentId: payment.id,
        amountMinor: amount,
        method,
        refundedOn: today,
        journalEntryId: entryId,
        approvalId: approval.id,
      });
      return;
    }

    // REVERSE_PAYMENT: take back every allocation, then reverse the payment's own entry.
    if (payment.refundedMinor > 0n) {
      throw conflict('PAYMENT_REFUNDED', 'A refunded payment cannot be reversed');
    }
    for (const allocation of payment.allocations.filter((a) => a.releasedAt === null)) {
      const releaseEntry = await postAllocationEntry(uow, {
        unitId: payment.unitId,
        amountMinor: allocation.amountMinor,
        date: today,
        currency: property.currency,
        release: true,
      });
      await uow.releaseAllocation(allocation.id, releaseEntry);
    }
    const paymentEntry = await uow.paymentEntryId(payment.id);
    const reversalEntry = await uow.postReversal(
      paymentEntry,
      today,
      `Reversal of ${formatReceiptNumber(payment.receiptNumber)}`,
    );
    await uow.createReversal({
      paymentId: payment.id,
      reversedOn: today,
      journalEntryId: reversalEntry,
      approvalId: approval.id,
    });
  }

  // ------------------------------------------------------------------ credit notes

  /** Corrects an issued invoice line (income reduced); within what the invoice still owes. */
  createCreditNote(
    access: OrganisationAccess,
    invoiceId: string,
    input: CreditNoteInput,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const invoice = await uow.invoice(invoiceId);
      if (!invoice) throw notFound('Invoice');
      if (invoice.status !== 'ISSUED') throw invalid('Correct a draft by discarding it instead');
      const line = invoice.lines.find((l) => l.lineNumber === input.lineNumber);
      if (!line) throw invalid('The invoice has no such line');
      const amount = parsePositiveAmount(input.amount, property.currency);
      const creditedOnLine = invoice.credits
        .filter((c) => c.lineNumber === line.lineNumber)
        .reduce((sum, c) => sum + c.amountMinor, 0n);
      if (amount > line.amountMinor - creditedOnLine) throw invalid('That is more than the line');
      if (amount > outstandingOf(invoice)) {
        throw invalid('That is more than the invoice still owes; release its payments first');
      }
      await requireOpenPeriod(uow, property.today);
      const accounts = await uow.accounts();
      const entryId = await uow.postEntry(
        'CREDIT_NOTE',
        `Credit note for ${formatInvoiceNumber(invoice.invoiceNumber ?? 0n)}`,
        property.today,
        property.currency,
        [
          { accountId: line.incomeAccountId, unitId: null, debitMinor: amount, creditMinor: 0n },
          {
            accountId: systemAccount(accounts, 'RECEIVABLES').id,
            unitId: invoice.unitId,
            debitMinor: 0n,
            creditMinor: amount,
          },
        ],
      );
      const id = await uow.createInvoiceCredit({
        unitId: invoice.unitId,
        invoiceId,
        kind: 'CREDIT_NOTE',
        lineNumber: line.lineNumber,
        amountMinor: amount,
        reason: input.reason,
        creditedOn: property.today,
        journalEntryId: entryId,
        approvalId: null,
      });
      await uow.audit({
        action: 'credit_note.created',
        resourceType: 'invoice_credit',
        resourceId: id,
        metadata: { invoiceId, lineNumber: line.lineNumber, amountMinor: amount.toString() },
      });
      const updated = await uow.invoice(invoiceId);
      if (!updated) throw new Error('Invoice vanished inside its own transaction');
      return updated;
    });
  }

  // ------------------------------------------------------------------ reports

  /** Everything billed to and paid by one party of a unit, with a running balance. */
  statement(
    access: OrganisationAccess,
    unitId: string,
    query: { paidBy: 'OWNERS' | 'TENANTS'; tenancyId?: string },
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const unit = await uow.unit(unitId);
      if (!unit) throw notFound('Unit');
      let party: Party = { billTo: 'OWNERS', tenancyId: null };
      if (query.paidBy === 'TENANTS') {
        const tenancyId =
          query.tenancyId ?? (await uow.parties([unitId], property.today)).get(unitId)?.tenancy?.id;
        if (!tenancyId) throw invalid('This unit has no current tenancy; give a tenancyId');
        party = { billTo: 'TENANTS', tenancyId };
      }
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
      return {
        unit,
        party,
        currency: property.currency,
        today: property.today,
        ...buildStatement(events),
      };
    });
  }

  /** What every unit and party still owes, by how long it is overdue on the given date. */
  ageing(access: OrganisationAccess, asOf: IsoDate | undefined, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const date = asOf ?? property.today;
      const rows = new Map<string, AgeingRow>();
      for (const invoice of await uow.outstandingInvoices()) {
        const key = `${invoice.unitId}:${invoice.billTo}:${invoice.tenancyId ?? ''}`;
        const row =
          rows.get(key) ??
          ({
            unitId: invoice.unitId,
            unitNumber: invoice.unitNumber,
            billTo: invoice.billTo,
            tenancyId: invoice.tenancyId,
            buckets: Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0n])) as Record<
              AgeBucket,
              bigint
            >,
            totalMinor: 0n,
          } satisfies AgeingRow);
        row.buckets[ageBucket(invoice.dueDate, date)] += invoice.outstandingMinor;
        row.totalMinor += invoice.outstandingMinor;
        rows.set(key, row);
      }
      const sorted = [...rows.values()].sort((a, b) =>
        a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }),
      );
      const totals = Object.fromEntries(
        AGE_BUCKETS.map((b) => [b, sorted.reduce((sum, r) => sum + r.buckets[b], 0n)]),
      ) as Record<AgeBucket, bigint>;
      return { asOf: date, currency: property.currency, rows: sorted, totals };
    });
  }

  // ------------------------------------------------------------------ shared

  private async pending(uow: FinanceUnitOfWork, id: string): Promise<ApprovalRecord> {
    const approval = await uow.approval(id, { lock: true });
    if (!approval) throw notFound('Approval request');
    if (approval.status !== 'PENDING') {
      throw conflict('ALREADY_DECIDED', 'This request has already been decided');
    }
    return approval;
  }

  private async mustFindApproval(uow: FinanceUnitOfWork, id: string): Promise<ApprovalRecord> {
    const approval = await uow.approval(id);
    if (!approval) throw notFound('Approval request');
    return approval;
  }

  private async mustFindPeriod(uow: FinanceUnitOfWork, id: string) {
    const period = await uow.period(id);
    if (!period) throw new Error('Period vanished inside its own transaction');
    return period;
  }

  private propertyOf(access: OrganisationAccess): string {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: FinanceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.repository.inProperty(
      access.organisationId,
      this.propertyOf(access),
      access.userId,
      meta,
      work,
    );
  }
}

const unusedOf = (p: {
  amountMinor: bigint;
  refundedMinor: bigint;
  allocations: { amountMinor: bigint; releasedAt: Date | null }[];
}) =>
  p.amountMinor -
  p.refundedMinor -
  p.allocations.filter((a) => a.releasedAt === null).reduce((sum, a) => sum + a.amountMinor, 0n);

const outstandingOf = (i: { totalMinor: bigint; paidMinor: bigint; creditedMinor: bigint }) =>
  i.totalMinor - i.paidMinor - i.creditedMinor;
