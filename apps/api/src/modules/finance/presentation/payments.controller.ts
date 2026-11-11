import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreatePaymentIntentResponse,
  MoneyDto,
  PaymentDto,
  PaymentIntentDto,
} from '@veyra/api-contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Public } from '../../../platform/auth/route-access';
import { ApiError } from '../../../platform/errors/api-error';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { PaymentIntentRecord, PaymentRecord } from '../application/finance-ports';
import { PaymentsService } from '../application/payments.service';
import {
  type AllocatePaymentInput,
  allocatePaymentSchema,
  type CreatePaymentIntentInput,
  createPaymentIntentSchema,
  formatInvoiceNumber,
  formatReceiptNumber,
  idempotencyKeySchema,
  paymentListQuerySchema,
  type RecordPaymentInput,
  recordPaymentSchema,
} from '../domain/finance-rules';

const uuid = new ParseUUIDPipe();

const money = (amountMinor: bigint, currency: string): MoneyDto => ({
  amountMinor: amountMinor.toString(),
  currency,
});

export const toPayment = (p: PaymentRecord): PaymentDto => {
  const allocated = p.allocations
    .filter((a) => a.releasedAt === null)
    .reduce((sum, a) => sum + a.amountMinor, 0n);
  return {
    id: p.id,
    receiptNumber: formatReceiptNumber(p.receiptNumber),
    unitId: p.unitId,
    unitNumber: p.unitNumber,
    paidBy: p.paidBy,
    method: p.method,
    amount: money(p.amountMinor, p.currency),
    allocated: money(allocated, p.currency),
    unallocated: money(p.reversedOn ? 0n : p.amountMinor - allocated - p.refundedMinor, p.currency),
    refunded: money(p.refundedMinor, p.currency),
    reversedOn: p.reversedOn,
    receivedOn: p.receivedOn,
    reference: p.reference,
    allocations: p.allocations.map((a) => ({
      id: a.id,
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoiceNumber === null ? null : formatInvoiceNumber(a.invoiceNumber),
      amount: money(a.amountMinor, p.currency),
      createdAt: a.createdAt.toISOString(),
      releasedAt: a.releasedAt?.toISOString() ?? null,
    })),
    createdAt: p.createdAt.toISOString(),
  };
};

const toIntent = (i: PaymentIntentRecord): PaymentIntentDto => ({
  id: i.id,
  unitId: i.unitId,
  paidBy: i.paidBy,
  amount: money(i.amountMinor, i.currency),
  provider: i.provider,
  status: i.status,
  expiresAt: i.expiresAt.toISOString(),
  completedAt: i.completedAt?.toISOString() ?? null,
  paymentId: i.paymentId,
});

const FINANCE = 'properties/:propertyId/finance';

/**
 * Payments and receipts (Phase 6 Part 3): recording money received, reallocating it, and online
 * payments through the configured gateway. Finance staff only (property.finance.*).
 */
@ApiTags('finance')
@Controller('organisations/:organisationId')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(`${FINANCE}/payments`)
  @RequirePermission('property.finance.manage')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'A UUID per payment' })
  @ApiOperation({
    summary:
      "Record money received for a unit. It is applied to the payer's unpaid invoices, oldest first; the rest stays as credit.",
  })
  async record(
    @CurrentAccess() access: OrganisationAccess,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(recordPaymentSchema)) body: RecordPaymentInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const parsedKey = idempotencyKeySchema.safeParse(key);
    if (!parsedKey.success) {
      throw new ApiError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header (a UUID)',
      );
    }
    const { payment, replayed } = await this.payments.recordPayment(
      access,
      parsedKey.data.toLowerCase(),
      body,
      requestMeta(req),
    );
    // A replay returns the payment recorded the first time.
    res.status(replayed ? 200 : 201);
    return toPayment(payment);
  }

  @Get(`${FINANCE}/payments`)
  @RequirePermission('property.finance.read')
  @ApiOperation({ summary: 'The 200 most recent payments, optionally for one unit.' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(paymentListQuerySchema))
    query: z.infer<typeof paymentListQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: PaymentDto[] }> {
    const rows = await this.payments.payments(access, query, requestMeta(req));
    return { data: rows.map(toPayment) };
  }

  @Get(`${FINANCE}/payments/:paymentId`)
  @RequirePermission('property.finance.read')
  @ApiOperation({ summary: 'A payment and its allocations (the receipt).' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('paymentId', uuid) paymentId: string,
    @Req() req: Request,
  ): Promise<PaymentDto> {
    return toPayment(await this.payments.payment(access, paymentId, requestMeta(req)));
  }

  @Post(`${FINANCE}/payments/:paymentId/allocations`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  @ApiOperation({
    summary: "Apply part of a payment's unused money to an invoice of the same payer.",
  })
  async allocate(
    @CurrentAccess() access: OrganisationAccess,
    @Param('paymentId', uuid) paymentId: string,
    @Body(new ZodValidationPipe(allocatePaymentSchema)) body: AllocatePaymentInput,
    @Req() req: Request,
  ): Promise<PaymentDto> {
    return toPayment(await this.payments.allocate(access, paymentId, body, requestMeta(req)));
  }

  @Post(`${FINANCE}/allocations/:allocationId/release`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Take an allocation back to reallocate it.' })
  async release(
    @CurrentAccess() access: OrganisationAccess,
    @Param('allocationId', uuid) allocationId: string,
    @Req() req: Request,
  ): Promise<PaymentDto> {
    return toPayment(await this.payments.release(access, allocationId, requestMeta(req)));
  }

  @Post(`${FINANCE}/payment-intents`)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Start an online payment for a unit through the configured gateway.' })
  async createIntent(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createPaymentIntentSchema)) body: CreatePaymentIntentInput,
    @Req() req: Request,
  ): Promise<CreatePaymentIntentResponse> {
    const { intent, checkoutUrl } = await this.payments.createIntent(
      access,
      body,
      requestMeta(req),
    );
    return { intent: toIntent(intent), checkoutUrl };
  }

  @Get(`${FINANCE}/payment-intents/:intentId`)
  @RequirePermission('property.finance.read')
  async intent(
    @CurrentAccess() access: OrganisationAccess,
    @Param('intentId', uuid) intentId: string,
    @Req() req: Request,
  ): Promise<PaymentIntentDto> {
    return toIntent(await this.payments.intent(access, intentId, requestMeta(req)));
  }
}

/**
 * Payment provider callbacks. Public (providers have no session) but authenticated by the
 * provider's signature over the raw body, verified before anything else is read.
 */
@ApiTags('finance')
@Controller('payment-callbacks')
export class PaymentCallbacksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @ApiOperation({ summary: 'Signed payment provider callback; each event is processed once.' })
  async callback(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true; outcome: string }> {
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(provider)) {
      throw new ApiError(404, 'NOT_FOUND', 'Unknown payment provider');
    }
    if (!req.rawBody) throw new ApiError(400, 'BODY_REQUIRED', 'The callback body is missing');
    const outcome = await this.payments.handleCallback(
      provider,
      req.rawBody,
      req.headers,
      requestMeta(req),
    );
    return { received: true, outcome };
  }
}
