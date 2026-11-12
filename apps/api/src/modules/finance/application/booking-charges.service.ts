import { Inject, Injectable } from '@nestjs/common';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import { formatInvoiceNumber } from '../domain/finance-rules';
import { ControlsService } from './controls.service';
import { FinanceService } from './finance.service';
import { FINANCE_REPOSITORY, type FinanceRepository } from './finance-ports';

/** Who is acting, where, on the caller's open transaction. */
export interface ChargeScope {
  transaction: TransactionHandle;
  organisationId: string;
  propertyId: string;
  userId: string;
  meta: RequestMeta;
}

export interface ChargeLine {
  chargeTypeId: string;
  description: string;
  amountMinor: bigint;
}

export interface ChargedInvoice {
  id: string;
  number: string;
  totalMinor: bigint;
  paidMinor: bigint;
  creditedMinor: bigint;
  currency: string;
}

/**
 * Charges other modules make to a unit's account (Phase 8: facility fees and deposits), on the
 * caller's transaction so that the change and its invoice or credit commit together. Uses the
 * same invoice, issue and credit-note rules as finance staff: billed to the party the charge type
 * names, posted to the ledger, the unit's existing credit applied at once.
 */
@Injectable()
export class BookingChargesService {
  constructor(
    @Inject(FINANCE_REPOSITORY) private readonly repository: FinanceRepository,
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(ControlsService) private readonly controls: ControlsService,
  ) {}

  /** Drafts and issues an invoice due today for the unit; returns it. */
  async charge(scope: ChargeScope, unitId: string, lines: readonly ChargeLine[]) {
    const uow = this.uow(scope);
    const property = await uow.property();
    const id = await this.finance.draftWithin(uow, property, unitId, lines, property.today);
    await this.finance.issueWithin(uow, property, id, undefined);
    return this.invoice(scope, id);
  }

  /** What a line can still be credited: what is left of it and still owed (unpaid). */
  async creditable(scope: ChargeScope, invoiceId: string, lineNumber: number): Promise<bigint> {
    const invoice = await this.uow(scope).invoice(invoiceId);
    return invoice ? ControlsService.creditable(invoice, lineNumber) : 0n;
  }

  /**
   * Credits an invoice line by what can still be credited, at most `max` (nothing of what has
   * been paid: finance refunds that). Returns the amount credited.
   */
  async credit(
    scope: ChargeScope,
    invoiceId: string,
    lineNumber: number,
    max: bigint,
    reason: string,
  ): Promise<bigint> {
    const uow = this.uow(scope);
    const property = await uow.property();
    const invoice = await uow.invoice(invoiceId);
    if (!invoice) return 0n;
    const possible = ControlsService.creditable(invoice, lineNumber);
    const amount = possible < max ? possible : max;
    if (amount <= 0n) return 0n;
    await this.controls.creditNoteWithin(uow, property, invoiceId, lineNumber, amount, reason);
    return amount;
  }

  async invoice(scope: ChargeScope, invoiceId: string): Promise<ChargedInvoice> {
    const invoice = await this.uow(scope).invoice(invoiceId);
    if (!invoice) throw new Error('Invoice vanished inside its own transaction');
    return {
      id: invoice.id,
      number: formatInvoiceNumber(invoice.invoiceNumber ?? 0n),
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      creditedMinor: invoice.creditedMinor,
      currency: invoice.currency,
    };
  }

  private uow(scope: ChargeScope) {
    return this.repository.within(
      scope.transaction,
      scope.organisationId,
      scope.propertyId,
      scope.userId,
      scope.meta,
    );
  }
}
