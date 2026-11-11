import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  BillingRunResponse,
  ChargeTypeDto,
  FinanceSetupResponse,
  InvoiceDetailDto,
  InvoiceDto,
  LedgerAccountDto,
  MoneyDto,
  RecurringChargeDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { FinanceService } from '../application/finance.service';
import type {
  InvoiceDetailRecord,
  InvoiceRecord,
  RecurringChargeRecord,
} from '../application/finance-ports';
import { formatCreditNumber } from '../domain/control-rules';
import {
  type BillingRunInput,
  billingRunSchema,
  type CreateChargeTypeInput,
  type CreateInvoiceInput,
  type CreateRecurringChargeInput,
  createChargeTypeSchema,
  createInvoiceSchema,
  createRecurringChargeSchema,
  endRecurringChargeSchema,
  formatInvoiceNumber,
  type InvoiceListQuery,
  invoiceListQuerySchema,
  issueInvoiceSchema,
  toMonth,
} from '../domain/finance-rules';

const uuid = new ParseUUIDPipe();

const money = (amountMinor: bigint, currency: string): MoneyDto => ({
  amountMinor: amountMinor.toString(),
  currency,
});

const toRecurring = (r: RecurringChargeRecord): RecurringChargeDto => ({
  id: r.id,
  unitId: r.unitId,
  unitNumber: r.unitNumber,
  chargeTypeId: r.chargeTypeId,
  chargeTypeCode: r.chargeTypeCode,
  basis: r.basis,
  amount: money(r.amountMinor, r.currency),
  startMonth: toMonth(r.startMonth),
  endMonth: r.endMonth === null ? null : toMonth(r.endMonth),
});

export const toInvoice = (i: InvoiceRecord): InvoiceDto => ({
  id: i.id,
  number: i.invoiceNumber === null ? null : formatInvoiceNumber(i.invoiceNumber),
  status: i.status,
  unitId: i.unitId,
  unitNumber: i.unitNumber,
  billTo: i.billTo,
  recipients: i.recipients,
  billingMonth: i.billingMonth === null ? null : toMonth(i.billingMonth),
  billingDate: i.billingDate,
  dueDate: i.dueDate,
  issueDate: i.issueDate,
  total: money(i.totalMinor, i.currency),
  paid: money(i.paidMinor, i.currency),
  credited: money(i.creditedMinor, i.currency),
  outstanding: money(i.totalMinor - i.paidMinor - i.creditedMinor, i.currency),
  overdue: i.overdue,
  createdAt: i.createdAt.toISOString(),
  issuedAt: i.issuedAt?.toISOString() ?? null,
});

export const toInvoiceDetail = (i: InvoiceDetailRecord): InvoiceDetailDto => ({
  ...toInvoice(i),
  lines: i.lines.map((line) => ({
    lineNumber: line.lineNumber,
    chargeTypeId: line.chargeTypeId,
    chargeTypeCode: line.chargeTypeCode,
    description: line.description,
    amount: money(line.amountMinor, i.currency),
    billingMonth: line.billingMonth === null ? null : toMonth(line.billingMonth),
  })),
  journalEntryId: i.journalEntryId,
  credits: i.credits.map((c) => ({
    id: c.id,
    kind: c.kind,
    number: c.creditNumber === null ? null : formatCreditNumber(c.creditNumber),
    lineNumber: c.lineNumber,
    amount: money(c.amountMinor, i.currency),
    reason: c.reason,
    creditedOn: c.creditedOn,
  })),
});

const FINANCE = 'properties/:propertyId/finance';

/**
 * Billing (Phase 6 Part 2). Finance officers and organisation admins manage it
 * (property.finance.manage); property managers read it (property.finance.read). All amounts are
 * in the property's currency.
 */
@ApiTags('finance')
@Controller('organisations/:organisationId')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  // ------------------------------------------------------------------ set-up and accounts

  @Post(`${FINANCE}/setup`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  @ApiOperation({
    summary: 'Create the default chart of accounts and charge types (missing ones only).',
  })
  async setUp(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<FinanceSetupResponse> {
    return this.finance.setUp(access, requestMeta(req));
  }

  @Get(`${FINANCE}/accounts`)
  @RequirePermission('property.finance.read')
  @ApiOperation({ summary: "The property's chart of accounts." })
  async accounts(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: LedgerAccountDto[] }> {
    return { data: await this.finance.accounts(access, requestMeta(req)) };
  }

  // ------------------------------------------------------------------ charge types

  @Get(`${FINANCE}/charge-types`)
  @RequirePermission('property.finance.read')
  async chargeTypes(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: ChargeTypeDto[] }> {
    return { data: await this.finance.chargeTypes(access, requestMeta(req)) };
  }

  @Post(`${FINANCE}/charge-types`)
  @RequirePermission('property.finance.manage')
  async createChargeType(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createChargeTypeSchema)) body: CreateChargeTypeInput,
    @Req() req: Request,
  ): Promise<ChargeTypeDto> {
    return this.finance.createChargeType(access, body, requestMeta(req));
  }

  @Post(`${FINANCE}/charge-types/:chargeTypeId/archive`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  async archiveChargeType(
    @CurrentAccess() access: OrganisationAccess,
    @Param('chargeTypeId', uuid) chargeTypeId: string,
    @Req() req: Request,
  ): Promise<ChargeTypeDto> {
    return this.finance.archiveChargeType(access, chargeTypeId, requestMeta(req));
  }

  // ------------------------------------------------------------------ recurring charges

  @Get(`${FINANCE}/recurring-charges`)
  @RequirePermission('property.finance.read')
  async recurringCharges(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: RecurringChargeDto[] }> {
    const rows = await this.finance.recurringCharges(access, requestMeta(req));
    return { data: rows.map(toRecurring) };
  }

  @Post(`${FINANCE}/recurring-charges`)
  @RequirePermission('property.finance.manage')
  @ApiOperation({
    summary: 'Add a monthly charge for one unit, or for every unit when unitId is left out.',
  })
  async createRecurringCharge(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createRecurringChargeSchema)) body: CreateRecurringChargeInput,
    @Req() req: Request,
  ): Promise<RecurringChargeDto> {
    const charge = await this.finance.createRecurringCharge(access, body, requestMeta(req));
    return toRecurring(charge);
  }

  @Post(`${FINANCE}/recurring-charges/:chargeId/end`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  async endRecurringCharge(
    @CurrentAccess() access: OrganisationAccess,
    @Param('chargeId', uuid) chargeId: string,
    @Body(new ZodValidationPipe(endRecurringChargeSchema))
    body: z.infer<typeof endRecurringChargeSchema>,
    @Req() req: Request,
  ): Promise<RecurringChargeDto> {
    const charge = await this.finance.endRecurringCharge(
      access,
      chargeId,
      body.endMonth,
      requestMeta(req),
    );
    return toRecurring(charge);
  }

  // ------------------------------------------------------------------ billing and invoices

  @Post(`${FINANCE}/billing-runs`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  @ApiOperation({
    summary:
      "Bill every active unit for the month's recurring charges not billed yet. Drafts unless issue is true.",
  })
  async runBilling(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(billingRunSchema)) body: BillingRunInput,
    @Req() req: Request,
  ): Promise<BillingRunResponse> {
    const result = await this.finance.runBilling(access, body, requestMeta(req));
    return {
      month: toMonth(result.month),
      invoices: result.invoices.map(toInvoice),
      skipped: result.skipped,
    };
  }

  @Get(`${FINANCE}/invoices`)
  @RequirePermission('property.finance.read')
  @ApiOperation({ summary: 'The 200 most recent invoices matching the filters.' })
  async invoices(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(invoiceListQuerySchema)) query: InvoiceListQuery,
    @Req() req: Request,
  ): Promise<{ data: InvoiceDto[] }> {
    const rows = await this.finance.invoices(access, query, requestMeta(req));
    return { data: rows.map(toInvoice) };
  }

  @Post(`${FINANCE}/invoices`)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Create a one-off draft invoice for a unit.' })
  async createInvoice(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
    @Req() req: Request,
  ): Promise<InvoiceDetailDto> {
    return toInvoiceDetail(await this.finance.createInvoice(access, body, requestMeta(req)));
  }

  @Get(`${FINANCE}/invoices/:invoiceId`)
  @RequirePermission('property.finance.read')
  async invoice(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invoiceId', uuid) invoiceId: string,
    @Req() req: Request,
  ): Promise<InvoiceDetailDto> {
    return toInvoiceDetail(await this.finance.invoice(access, invoiceId, requestMeta(req)));
  }

  @Post(`${FINANCE}/invoices/:invoiceId/issue`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Issue a draft: number it and post it to the ledger.' })
  async issue(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invoiceId', uuid) invoiceId: string,
    @Body(new ZodValidationPipe(issueInvoiceSchema)) body: z.infer<typeof issueInvoiceSchema>,
    @Req() req: Request,
  ): Promise<InvoiceDetailDto> {
    return toInvoiceDetail(
      await this.finance.issueInvoice(access, invoiceId, body.dueDate, requestMeta(req)),
    );
  }

  @Post(`${FINANCE}/invoices/:invoiceId/discard`)
  @HttpCode(204)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Discard a draft invoice. Issued invoices cannot be discarded.' })
  async discard(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invoiceId', uuid) invoiceId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.finance.discardInvoice(access, invoiceId, requestMeta(req));
  }
}
