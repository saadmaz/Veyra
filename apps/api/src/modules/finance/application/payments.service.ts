import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  type AllocatePaymentInput,
  type CreatePaymentIntentInput,
  cashAccountKey,
  type IsoDate,
  type PaidBy,
  parsePositiveAmount,
  type RecordPaymentInput,
} from '../domain/finance-rules';
import { applyCredit, postAllocationEntry, requireOpenPeriod, systemAccount } from './credit';
import {
  FINANCE_REPOSITORY,
  type FinanceRepository,
  type FinanceUnitOfWork,
  IdempotencyConflict,
  type Party,
  type PaymentRecord,
  type PropertyFinanceInfo,
} from './finance-ports';
import {
  type CallbackHeaders,
  type GatewayEvent,
  PAYMENT_GATEWAYS,
  type PaymentGateway,
  type PaymentGateways,
} from './payment-gateway';

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const invalid = (message: string) => new ApiError(422, 'VALIDATION_FAILED', message);

/** How long a payer has to finish an online payment. */
const INTENT_LIFETIME_MS = 60 * 60_000;

export type CallbackOutcome =
  | 'RECORDED'
  | 'FAILED'
  | 'DUPLICATE'
  | 'IGNORED_NOT_PENDING'
  | 'AMOUNT_MISMATCH'
  | 'UNKNOWN_REFERENCE';

/**
 * Payments (Phase 6 Part 3). Money received is posted to the unit's credit (debit bank, cash or
 * gateway clearing) and then applied to the paying party's unpaid invoices, oldest first;
 * whatever is left stays as credit for later invoices. Finance staff can release an allocation
 * and allocate it again. Online payments go through a gateway adapter: an intent, then a signed
 * callback processed once per provider event.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(FINANCE_REPOSITORY) private readonly repository: FinanceRepository,
    @Inject(PAYMENT_GATEWAYS) private readonly gateways: PaymentGateways,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ manual payments

  /**
   * Records money received. The same Idempotency-Key returns the payment already recorded (and
   * refuses a different request under the same key), so a retried request never records twice.
   */
  recordPayment(
    access: OrganisationAccess,
    idempotencyKey: string,
    input: RecordPaymentInput,
    meta: RequestMeta,
  ): Promise<{ payment: PaymentRecord; replayed: boolean }> {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const amountMinor = parsePositiveAmount(input.amount, property.currency);
      const existing = await uow.paymentByIdempotencyKey(idempotencyKey);
      if (existing) {
        const same =
          existing.unitId === input.unitId &&
          existing.paidBy === input.paidBy &&
          existing.method === input.method &&
          existing.amountMinor === amountMinor &&
          existing.receivedOn === input.receivedOn;
        if (!same) throw idempotencyReused();
        return { payment: existing, replayed: true };
      }
      if (input.receivedOn > property.today) {
        throw invalid('A payment cannot be received in the future');
      }
      const unit = await uow.unit(input.unitId);
      if (!unit) throw notFound('Unit');
      const party = await this.partyOf(uow, input.unitId, input.paidBy, input.receivedOn);

      const id = await this.receive(uow, property, {
        unitId: unit.id,
        unitNumber: unit.number,
        party,
        method: input.method,
        amountMinor,
        receivedOn: input.receivedOn,
        reference: input.reference ?? null,
        idempotencyKey,
        paymentIntentId: null,
      });
      await uow.audit({
        action: 'payment.recorded',
        resourceType: 'payment',
        resourceId: id,
        metadata: {
          unitId: unit.id,
          method: input.method,
          amountMinor: amountMinor.toString(),
          paidBy: input.paidBy,
        },
      });
      return { payment: await this.mustFind(uow, id), replayed: false };
    });
  }

  payments(access: OrganisationAccess, filter: { unitId?: string }, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.payments(filter));
  }

  payment(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const payment = await uow.payment(id);
      if (!payment) throw notFound('Payment');
      return payment;
    });
  }

  // ------------------------------------------------------------------ reallocation

  /** Applies part of a payment's unused money to a chosen invoice of the same party. */
  allocate(
    access: OrganisationAccess,
    paymentId: string,
    input: AllocatePaymentInput,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const payment = await uow.payment(paymentId);
      if (!payment) throw notFound('Payment');
      const amountMinor = parsePositiveAmount(input.amount, property.currency);
      const invoice = await uow.invoice(input.invoiceId);
      if (!invoice || invoice.unitId !== payment.unitId) throw notFound('Invoice');
      if (invoice.status !== 'ISSUED') throw invalid('Payments go to issued invoices only');
      if (invoice.billTo !== payment.paidBy || invoice.tenancyId !== payment.tenancyId) {
        throw invalid('This invoice is addressed to someone else than whoever made this payment');
      }
      if (payment.reversedOn)
        throw new ApiError(409, 'PAYMENT_REVERSED', 'This payment was reversed');
      const unused = payment.amountMinor - activeTotal(payment.allocations) - payment.refundedMinor;
      if (amountMinor > unused) throw invalid('That is more than what is left of this payment');
      if (amountMinor > invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor) {
        throw invalid('That is more than what is left to pay on this invoice');
      }
      const entryId = await postAllocationEntry(uow, {
        unitId: payment.unitId,
        amountMinor,
        date: property.today,
        currency: property.currency,
        release: false,
      });
      const allocationId = await uow.createAllocation({
        unitId: payment.unitId,
        paymentId,
        invoiceId: invoice.id,
        amountMinor,
        journalEntryId: entryId,
      });
      await uow.audit({
        action: 'payment.allocated',
        resourceType: 'payment_allocation',
        resourceId: allocationId,
        metadata: { paymentId, invoiceId: invoice.id, amountMinor: amountMinor.toString() },
      });
      return this.mustFind(uow, paymentId);
    });
  }

  /**
   * Takes an allocation back: the amount returns to the payment's unused money (and the unit's
   * credit) and the invoice is owed again. Credit is not re-applied automatically, so staff can
   * allocate it elsewhere.
   */
  release(access: OrganisationAccess, allocationId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const allocation = await uow.allocation(allocationId);
      if (!allocation) throw notFound('Allocation');
      if (allocation.releasedAt) {
        throw new ApiError(409, 'ALREADY_RELEASED', 'This allocation is already released');
      }
      const entryId = await postAllocationEntry(uow, {
        unitId: allocation.unitId,
        amountMinor: allocation.amountMinor,
        date: property.today,
        currency: property.currency,
        release: true,
      });
      await uow.releaseAllocation(allocationId, entryId);
      await uow.audit({
        action: 'payment.allocation_released',
        resourceType: 'payment_allocation',
        resourceId: allocationId,
        metadata: {
          paymentId: allocation.paymentId,
          invoiceId: allocation.invoiceId,
          amountMinor: allocation.amountMinor.toString(),
        },
      });
      return this.mustFind(uow, allocation.paymentId);
    });
  }

  // ------------------------------------------------------------------ online payments

  /** Starts an online payment for a unit through the configured gateway. */
  createIntent(access: OrganisationAccess, input: CreatePaymentIntentInput, meta: RequestMeta) {
    const gateway = this.gateway();
    return this.inProperty(access, meta, async (uow) => {
      const property = await uow.property();
      const amountMinor = parsePositiveAmount(input.amount, property.currency);
      const unit = await uow.unit(input.unitId);
      if (!unit) throw notFound('Unit');
      const party = await this.partyOf(uow, unit.id, input.paidBy, property.today);
      systemAccount(await uow.accounts(), 'GATEWAY_CLEARING');
      const checkout = await gateway.createCheckout({
        amountMinor,
        currency: property.currency,
        description: `Payment for unit ${unit.number}`,
      });
      const id = await uow.createPaymentIntent({
        unitId: unit.id,
        party,
        amountMinor,
        currency: property.currency,
        provider: gateway.key,
        providerReference: checkout.providerReference,
        expiresAt: new Date(this.clock.now().getTime() + INTENT_LIFETIME_MS),
      });
      await uow.audit({
        action: 'payment_intent.created',
        resourceType: 'payment_intent',
        resourceId: id,
        metadata: { unitId: unit.id, amountMinor: amountMinor.toString(), provider: gateway.key },
      });
      const intent = await uow.paymentIntent(id);
      if (!intent) throw new Error('Payment intent vanished inside its own transaction');
      return { intent, checkoutUrl: checkout.checkoutUrl };
    });
  }

  intent(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const intent = await uow.paymentIntent(id);
      if (!intent) throw notFound('Payment intent');
      return intent;
    });
  }

  /**
   * A provider's callback. Unsigned or wrongly signed callbacks are refused before anything is
   * read. Each provider event is processed once; a success records the payment (and applies it)
   * only if it matches the intent's amount and currency.
   */
  async handleCallback(
    provider: string,
    rawBody: Buffer,
    headers: CallbackHeaders,
    meta: RequestMeta,
  ): Promise<CallbackOutcome> {
    const gateway = this.gateways.get(provider);
    if (!gateway) throw new ApiError(404, 'NOT_FOUND', 'Unknown payment provider');
    const event = gateway.verifyCallback(rawBody, headers, this.clock.now());
    if (!event) throw new ApiError(401, 'INVALID_SIGNATURE', 'The callback signature is not valid');

    const target = await this.repository.intentByProviderReference(
      provider,
      event.providerReference,
    );
    if (!target) {
      this.logger.warn(`Callback for an unknown ${provider} payment reference`);
      return 'UNKNOWN_REFERENCE';
    }
    return this.repository.inProperty(target.organisationId, target.propertyId, null, meta, (uow) =>
      this.processEvent(uow, gateway, event, target.id),
    );
  }

  private async processEvent(
    uow: FinanceUnitOfWork,
    gateway: PaymentGateway,
    event: GatewayEvent,
    intentId: string,
  ): Promise<CallbackOutcome> {
    const intent = await uow.paymentIntent(intentId, { lock: true });
    if (!intent) return 'UNKNOWN_REFERENCE';
    if (await uow.providerEventSeen(gateway.key, event.eventId)) return 'DUPLICATE';

    let outcome: CallbackOutcome;
    if (intent.status !== 'PENDING') {
      outcome = 'IGNORED_NOT_PENDING';
    } else if (event.type === 'payment.failed') {
      await uow.completePaymentIntent(intent.id, 'FAILED');
      outcome = 'FAILED';
    } else if (event.amountMinor !== intent.amountMinor || event.currency !== intent.currency) {
      // Money may have moved, but not what was asked: left pending for finance to resolve.
      outcome = 'AMOUNT_MISMATCH';
    } else {
      const property = await uow.property();
      const unit = await uow.unit(intent.unitId);
      if (!unit) throw new Error('Payment intent for a unit that does not exist');
      await this.receive(uow, property, {
        unitId: unit.id,
        unitNumber: unit.number,
        party: { billTo: intent.paidBy, tenancyId: intent.tenancyId },
        method: 'GATEWAY',
        amountMinor: intent.amountMinor,
        receivedOn: property.today,
        reference: intent.providerReference,
        idempotencyKey: null,
        paymentIntentId: intent.id,
      });
      await uow.completePaymentIntent(intent.id, 'SUCCEEDED');
      outcome = 'RECORDED';
    }
    await uow.recordProviderEvent({
      provider: gateway.key,
      eventId: event.eventId,
      type: event.type,
      intentId: intent.id,
      outcome,
    });
    await uow.audit({
      action: 'payment_intent.callback',
      resourceType: 'payment_intent',
      resourceId: intent.id,
      metadata: { provider: gateway.key, type: event.type, outcome },
    });
    return outcome;
  }

  // ------------------------------------------------------------------ shared

  /** Posts the payment (debit bank, cash or clearing; credit unit credit), then applies credit. */
  private async receive(
    uow: FinanceUnitOfWork,
    property: PropertyFinanceInfo,
    input: {
      unitId: string;
      unitNumber: string;
      party: Party;
      method: PaymentRecord['method'];
      amountMinor: bigint;
      receivedOn: IsoDate;
      reference: string | null;
      idempotencyKey: string | null;
      paymentIntentId: string | null;
    },
  ): Promise<string> {
    await requireOpenPeriod(uow, input.receivedOn);
    const accounts = await uow.accounts();
    const cash = systemAccount(accounts, cashAccountKey(input.method));
    const credit = systemAccount(accounts, 'UNIT_CREDIT');
    const entryId = await uow.postEntry(
      'PAYMENT',
      `Payment for unit ${input.unitNumber}`,
      input.receivedOn,
      property.currency,
      [
        { accountId: cash.id, unitId: null, debitMinor: input.amountMinor, creditMinor: 0n },
        {
          accountId: credit.id,
          unitId: input.unitId,
          debitMinor: 0n,
          creditMinor: input.amountMinor,
        },
      ],
    );
    const id = await uow.createPayment({
      unitId: input.unitId,
      party: input.party,
      method: input.method,
      amountMinor: input.amountMinor,
      currency: property.currency,
      receivedOn: input.receivedOn,
      reference: input.reference,
      journalEntryId: entryId,
      idempotencyKey: input.idempotencyKey,
      paymentIntentId: input.paymentIntentId,
    });
    await applyCredit(uow, {
      unitId: input.unitId,
      party: input.party,
      date: property.today,
      currency: property.currency,
    });
    return id;
  }

  /** OWNERS, or the tenancy of the unit on the date. */
  private async partyOf(
    uow: FinanceUnitOfWork,
    unitId: string,
    paidBy: PaidBy,
    date: IsoDate,
  ): Promise<Party> {
    if (paidBy === 'OWNERS') return { billTo: 'OWNERS', tenancyId: null };
    const tenancy = (await uow.parties([unitId], date)).get(unitId)?.tenancy;
    if (!tenancy) throw invalid('This unit had no tenancy on that date');
    return { billTo: 'TENANTS', tenancyId: tenancy.id };
  }

  private gateway(): PaymentGateway {
    const first = this.gateways.values().next();
    if (first.done) {
      throw new ApiError(409, 'GATEWAY_NOT_CONFIGURED', 'Online payments are not configured');
    }
    return first.value;
  }

  private async mustFind(uow: FinanceUnitOfWork, id: string): Promise<PaymentRecord> {
    const payment = await uow.payment(id);
    if (!payment) throw new Error('Payment vanished inside its own transaction');
    return payment;
  }

  private propertyOf(access: OrganisationAccess): string {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: FinanceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflict) throw idempotencyReused();
      throw error;
    }
  }
}

const activeTotal = (allocations: readonly { amountMinor: bigint; releasedAt: Date | null }[]) =>
  allocations.filter((a) => a.releasedAt === null).reduce((sum, a) => sum + a.amountMinor, 0n);

const idempotencyReused = () =>
  new ApiError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was used for a different payment, or that payment is still being recorded',
  );
