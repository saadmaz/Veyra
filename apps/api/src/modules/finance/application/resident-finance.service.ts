import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import { type PaidBy, parsePositiveAmount } from '../domain/finance-rules';
import {
  belongsTo,
  MAX_PENDING_TRANSFERS,
  partiesFor,
  type ResidentParty,
  residentParties,
  type SubmitTransferInput,
} from '../domain/resident-finance-rules';
import {
  type BankTransferRecord,
  FINANCE_REPOSITORY,
  type FinanceRepository,
  type FinanceUnitOfWork,
  IdempotencyConflict,
  type Party,
  type PropertyFinanceInfo,
} from './finance-ports';
import { partyStatement } from './statement';

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const invalid = (message: string) => new ApiError(422, 'VALIDATION_FAILED', message);

const toParty = (p: ResidentParty): Party => ({ billTo: p.paidBy, tenancyId: p.tenancyId });

/** What one request may see: the unit and the caller's own accounts on it today. */
interface ResidentScope {
  property: PropertyFinanceInfo;
  unit: { id: string; number: string };
  parties: ResidentParty[];
}

/**
 * Residents' finance (Phase 6 Part 6). Owners and current tenants see their own account of a
 * unit, never anyone else's: an owner the owners' account, a tenant the account of the tenancy
 * they are on today. The account is resolved from the caller's own records on every request, so
 * moving out or selling ends access at once. The route guard has already checked
 * unit.finance.read or unit.finance.pay on the unit; a caller with the permission but no account
 * (an organisation admin who does not live there) sees nothing (404).
 */
@Injectable()
export class ResidentFinanceService {
  constructor(@Inject(FINANCE_REPOSITORY) private readonly repository: FinanceRepository) {}

  /** The caller's accounts on the unit with what each owes now (negative: credit held). */
  summary(access: OrganisationAccess, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, scope) => {
      const accounts = [];
      for (const party of scope.parties) {
        const statement = await partyStatement(uow, scope.unit.id, toParty(party));
        const invoices = await uow.partyInvoices(scope.unit.id, [toParty(party)]);
        const overdueMinor = invoices
          .filter((i) => i.overdue)
          .reduce((sum, i) => sum + i.totalMinor - i.paidMinor - i.creditedMinor, 0n);
        const pending = await uow.transfers({
          status: 'PENDING',
          unitId: scope.unit.id,
          parties: [toParty(party)],
        });
        accounts.push({
          party,
          balanceMinor: statement.balanceMinor,
          overdueMinor,
          pendingTransferMinor: pending.reduce((sum, t) => sum + t.amountMinor, 0n),
        });
      }
      return { ...scope, accounts };
    });
  }

  invoices(access: OrganisationAccess, paidBy: PaidBy | undefined, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, scope) =>
      uow.partyInvoices(scope.unit.id, this.chosen(scope, paidBy).map(toParty)),
    );
  }

  invoice(access: OrganisationAccess, invoiceId: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, scope) => {
      const invoice = await uow.invoice(invoiceId);
      // Drafts are finance's work in progress; other accounts' invoices do not exist for you.
      if (
        !invoice ||
        invoice.unitId !== scope.unit.id ||
        invoice.status !== 'ISSUED' ||
        !belongsTo(scope.parties, { paidBy: invoice.billTo, tenancyId: invoice.tenancyId })
      ) {
        throw notFound('Invoice');
      }
      return invoice;
    });
  }

  payments(access: OrganisationAccess, paidBy: PaidBy | undefined, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, scope) =>
      uow.partyPayments(scope.unit.id, this.chosen(scope, paidBy).map(toParty)),
    );
  }

  payment(access: OrganisationAccess, paymentId: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, scope) => {
      const payment = await uow.payment(paymentId);
      if (!payment || payment.unitId !== scope.unit.id || !belongsTo(scope.parties, payment)) {
        throw notFound('Receipt');
      }
      return payment;
    });
  }

  statement(access: OrganisationAccess, paidBy: PaidBy, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, scope) => {
      const [party] = this.chosen(scope, paidBy) as [ResidentParty];
      const statement = await partyStatement(uow, scope.unit.id, toParty(party));
      return {
        unit: scope.unit,
        party,
        currency: scope.property.currency,
        today: scope.property.today,
        ...statement,
      };
    });
  }

  transfers(access: OrganisationAccess, meta: RequestMeta) {
    return this.inUnit(access, meta, (uow, scope) =>
      uow.transfers({ unitId: scope.unit.id, parties: scope.parties.map(toParty) }),
    );
  }

  /**
   * Reports a bank transfer for one of the caller's accounts. The same Idempotency-Key returns
   * the submission already made (and refuses a different request under the same key).
   */
  submitTransfer(
    access: OrganisationAccess,
    idempotencyKey: string,
    input: SubmitTransferInput,
    meta: RequestMeta,
  ): Promise<{ transfer: BankTransferRecord; replayed: boolean }> {
    return this.inUnit(access, meta, async (uow, scope) => {
      const amountMinor = parsePositiveAmount(input.amount, scope.property.currency);
      const existing = await uow.transferByIdempotencyKey(idempotencyKey);
      if (existing) {
        const same =
          existing.unitId === scope.unit.id &&
          existing.submittedByUserId === access.userId &&
          existing.paidBy === input.paidBy &&
          existing.amountMinor === amountMinor &&
          existing.transferredOn === input.transferredOn &&
          existing.reference === input.reference;
        if (!same) throw idempotencyReused();
        return { transfer: existing, replayed: true };
      }
      const [party] = this.chosen(scope, input.paidBy) as [ResidentParty];
      if (input.transferredOn > scope.property.today) {
        throw invalid('A transfer cannot be dated in the future');
      }
      const pending = await uow.transfers({
        status: 'PENDING',
        unitId: scope.unit.id,
        parties: [toParty(party)],
      });
      if (pending.length >= MAX_PENDING_TRANSFERS) {
        throw new ApiError(
          409,
          'TOO_MANY_PENDING',
          `${MAX_PENDING_TRANSFERS} transfers are already waiting for finance. Please wait until they are checked.`,
        );
      }
      const id = await uow.createTransfer({
        unitId: scope.unit.id,
        party: toParty(party),
        amountMinor,
        currency: scope.property.currency,
        transferredOn: input.transferredOn,
        reference: input.reference,
        note: input.note ?? null,
        idempotencyKey,
      });
      // No personal data or bank reference in the audit log.
      await uow.audit({
        action: 'bank_transfer.submitted',
        resourceType: 'bank_transfer_submission',
        resourceId: id,
        metadata: {
          unitId: scope.unit.id,
          paidBy: party.paidBy,
          amountMinor: amountMinor.toString(),
        },
      });
      const transfer = await uow.transfer(id);
      if (!transfer) throw new Error('Transfer vanished inside its own transaction');
      return { transfer, replayed: false };
    });
  }

  // ------------------------------------------------------------------ shared

  /** The accounts asked for among the caller's own; 404 for an account that is not theirs. */
  private chosen(scope: ResidentScope, paidBy: PaidBy | undefined): ResidentParty[] {
    const parties = partiesFor(scope.parties, paidBy);
    if (!parties) throw notFound('Account');
    return parties;
  }

  private async inUnit<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: FinanceUnitOfWork, scope: ResidentScope) => Promise<T>,
  ): Promise<T> {
    if (!access.propertyId || !access.unitId) {
      throw new Error('Unit route without a resolved property and unit');
    }
    const unitId = access.unitId;
    try {
      return await this.repository.inProperty(
        access.organisationId,
        access.propertyId,
        access.userId,
        meta,
        async (uow) => {
          const property = await uow.property();
          const unit = await uow.unit(unitId);
          if (!unit) throw notFound('Unit');
          const parties = residentParties(
            await uow.residentStanding(access.userId, unitId, property.today),
          );
          if (parties.length === 0) throw notFound('Account');
          return work(uow, { property, unit: { id: unit.id, number: unit.number }, parties });
        },
      );
    } catch (error) {
      if (error instanceof IdempotencyConflict) throw idempotencyReused();
      throw error;
    }
  }
}

const idempotencyReused = () =>
  new ApiError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was used for a different transfer, or that transfer is still being saved',
  );
