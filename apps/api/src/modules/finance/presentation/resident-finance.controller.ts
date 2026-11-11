import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  BankTransferDto,
  InvoiceDto,
  MoneyDto,
  MyFinanceDto,
  MyInvoiceDetailDto,
  PaymentDto,
  StatementDto,
} from '@veyra/api-contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../../platform/errors/api-error';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { BankTransferRecord } from '../application/finance-ports';
import { ResidentFinanceService } from '../application/resident-finance.service';
import { formatReceiptNumber, idempotencyKeySchema } from '../domain/finance-rules';
import {
  residentPartyQuerySchema,
  residentStatementQuerySchema,
  type SubmitTransferInput,
  submitTransferSchema,
} from '../domain/resident-finance-rules';
import { toInvoice, toInvoiceDetail } from './finance.controller';
import { toPayment } from './payments.controller';

const uuid = new ParseUUIDPipe();

const money = (amountMinor: bigint, currency: string): MoneyDto => ({
  amountMinor: amountMinor.toString(),
  currency,
});

export const toTransfer = (t: BankTransferRecord): BankTransferDto => ({
  id: t.id,
  unitId: t.unitId,
  unitNumber: t.unitNumber,
  paidBy: t.paidBy,
  amount: money(t.amountMinor, t.currency),
  transferredOn: t.transferredOn,
  reference: t.reference,
  note: t.note,
  status: t.status,
  submittedBy: { name: t.submittedByName },
  decidedAt: t.decidedAt?.toISOString() ?? null,
  rejectionReason: t.rejectionReason,
  paymentId: t.paymentId,
  receiptNumber: t.receiptNumber === null ? null : formatReceiptNumber(t.receiptNumber),
  createdAt: t.createdAt.toISOString(),
});

const MINE = 'properties/:propertyId/units/:unitId/my-finance';

/**
 * Residents' finance (Phase 6 Part 6): an owner or current tenant's own account of a unit — its
 * issued invoices, receipts and statement — and bank transfers reported for finance to check.
 * Unit-scoped (unit.finance.read, unit.finance.pay); the service narrows every answer to the
 * caller's own account, and anything else is 404.
 */
@ApiTags('resident finance')
@Controller('organisations/:organisationId')
export class ResidentFinanceController {
  constructor(private readonly finance: ResidentFinanceService) {}

  @Get(MINE)
  @RequirePermission('unit.finance.read')
  @ApiOperation({ summary: 'Your accounts on the unit: what you owe, overdue and reported.' })
  async summary(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<MyFinanceDto> {
    const s = await this.finance.summary(access, requestMeta(req));
    const currency = s.property.currency;
    return {
      unitId: s.unit.id,
      unitNumber: s.unit.number,
      asOf: s.property.today,
      currency,
      accounts: s.accounts.map((a) => ({
        paidBy: a.party.paidBy,
        tenancyId: a.party.tenancyId,
        balance: money(a.balanceMinor, currency),
        overdue: money(a.overdueMinor, currency),
        pendingTransfers: money(a.pendingTransferMinor, currency),
      })),
    };
  }

  @Get(`${MINE}/invoices`)
  @RequirePermission('unit.finance.read')
  @ApiOperation({ summary: 'Your issued invoices for the unit, newest first (at most 200).' })
  async invoices(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(residentPartyQuerySchema))
    query: z.infer<typeof residentPartyQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: InvoiceDto[] }> {
    const rows = await this.finance.invoices(access, query.paidBy, requestMeta(req));
    return { data: rows.map(toInvoice) };
  }

  @Get(`${MINE}/invoices/:invoiceId`)
  @RequirePermission('unit.finance.read')
  @ApiOperation({ summary: 'One of your invoices with its lines and credit notes.' })
  async invoice(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invoiceId', uuid) invoiceId: string,
    @Req() req: Request,
  ): Promise<MyInvoiceDetailDto> {
    const { journalEntryId: _ledger, ...detail } = toInvoiceDetail(
      await this.finance.invoice(access, invoiceId, requestMeta(req)),
    );
    return {
      ...detail,
      // A write-off's reason is finance's internal note; residents see that it was written off.
      credits: detail.credits.map((c) =>
        c.kind === 'WRITE_OFF' ? { ...c, reason: 'Written off' } : c,
      ),
    };
  }

  @Get(`${MINE}/payments`)
  @RequirePermission('unit.finance.read')
  @ApiOperation({ summary: 'Your receipts for the unit, newest first (at most 200).' })
  async payments(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(residentPartyQuerySchema))
    query: z.infer<typeof residentPartyQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: PaymentDto[] }> {
    const rows = await this.finance.payments(access, query.paidBy, requestMeta(req));
    return { data: rows.map(toPayment) };
  }

  @Get(`${MINE}/payments/:paymentId`)
  @RequirePermission('unit.finance.read')
  @ApiOperation({ summary: 'One of your receipts and the invoices it paid.' })
  async payment(
    @CurrentAccess() access: OrganisationAccess,
    @Param('paymentId', uuid) paymentId: string,
    @Req() req: Request,
  ): Promise<PaymentDto> {
    return toPayment(await this.finance.payment(access, paymentId, requestMeta(req)));
  }

  @Get(`${MINE}/statement`)
  @RequirePermission('unit.finance.read')
  @ApiOperation({ summary: 'Your statement for the unit with a running balance.' })
  async statement(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(residentStatementQuerySchema))
    query: z.infer<typeof residentStatementQuerySchema>,
    @Req() req: Request,
  ): Promise<StatementDto> {
    const s = await this.finance.statement(access, query.paidBy, requestMeta(req));
    return {
      unitId: s.unit.id,
      unitNumber: s.unit.number,
      paidBy: s.party.paidBy,
      tenancyId: s.party.tenancyId,
      asOf: s.today,
      lines: s.lines.map((l) => ({
        date: l.date,
        kind: l.kind,
        reference: l.reference,
        debit: money(l.debitMinor, s.currency),
        credit: money(l.creditMinor, s.currency),
        balance: money(l.balanceMinor, s.currency),
      })),
      balance: money(s.balanceMinor, s.currency),
    };
  }

  @Get(`${MINE}/bank-transfers`)
  @RequirePermission('unit.finance.read')
  @ApiOperation({ summary: 'Bank transfers reported for your accounts, newest first.' })
  async transfers(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: BankTransferDto[] }> {
    const rows = await this.finance.transfers(access, requestMeta(req));
    return { data: rows.map(toTransfer) };
  }

  @Post(`${MINE}/bank-transfers`)
  @RequirePermission('unit.finance.pay')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'A UUID per transfer' })
  @ApiOperation({
    summary: 'Tell finance about a bank transfer you made; they confirm it once it arrives.',
  })
  async submit(
    @CurrentAccess() access: OrganisationAccess,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(submitTransferSchema)) body: SubmitTransferInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BankTransferDto> {
    const parsedKey = idempotencyKeySchema.safeParse(key);
    if (!parsedKey.success) {
      throw new ApiError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header (a UUID)',
      );
    }
    const { transfer, replayed } = await this.finance.submitTransfer(
      access,
      parsedKey.data.toLowerCase(),
      body,
      requestMeta(req),
    );
    res.status(replayed ? 200 : 201);
    return toTransfer(transfer);
  }
}
