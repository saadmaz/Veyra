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
  AccountingPeriodDto,
  AgeingBucketsDto,
  AgeingDto,
  FinanceApprovalDto,
  InvoiceDetailDto,
  MoneyDto,
  StatementDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { ControlsService } from '../application/controls.service';
import type { AccountingPeriodRecord, ApprovalRecord } from '../application/finance-ports';
import {
  AGE_BUCKETS,
  type AgeBucket,
  type ApprovalRequestInput,
  ageingQuerySchema,
  approvalListQuerySchema,
  approvalRequestSchema,
  type CreditNoteInput,
  creditNoteSchema,
  decisionSchema,
  statementQuerySchema,
} from '../domain/control-rules';
import { toInvoiceDetail } from './finance.controller';

const uuid = new ParseUUIDPipe();

const money = (amountMinor: bigint, currency: string): MoneyDto => ({
  amountMinor: amountMinor.toString(),
  currency,
});

const toPeriod = (p: AccountingPeriodRecord): AccountingPeriodDto => ({
  id: p.id,
  startDate: p.startDate,
  endDate: p.endDate,
  status: p.status,
  closedAt: p.closedAt?.toISOString() ?? null,
});

const toApproval = (a: ApprovalRecord): FinanceApprovalDto => ({
  id: a.id,
  action: a.action,
  status: a.status,
  paymentId: a.paymentId,
  invoiceId: a.invoiceId,
  periodId: a.periodId,
  amount: a.amountMinor === null ? null : money(a.amountMinor, a.currency),
  refundMethod: a.refundMethod,
  reason: a.reason,
  requestedBy: { userId: a.requestedByUserId, name: a.requestedByName },
  decidedBy:
    a.decidedByUserId === null ? null : { userId: a.decidedByUserId, name: a.decidedByName ?? '' },
  decidedAt: a.decidedAt?.toISOString() ?? null,
  decisionNote: a.decisionNote,
  createdAt: a.createdAt.toISOString(),
});

const toBuckets = (buckets: Record<AgeBucket, bigint>, currency: string): AgeingBucketsDto =>
  Object.fromEntries(
    AGE_BUCKETS.map((b) => [b, money(buckets[b], currency)]),
  ) as unknown as AgeingBucketsDto;

const FINANCE = 'properties/:propertyId/finance';

/**
 * Controls and reports (Phase 6 Part 4): accounting periods, maker-checker approvals for
 * reversals, refunds, write-offs and reopening periods, credit notes, statements and ageing.
 * Requests need property.finance.manage; decisions property.finance.approve, and the person
 * deciding is never the requester.
 */
@ApiTags('finance')
@Controller('organisations/:organisationId')
export class ControlsController {
  constructor(private readonly controls: ControlsService) {}

  // ------------------------------------------------------------------ periods

  @Get(`${FINANCE}/periods`)
  @RequirePermission('property.finance.read')
  async periods(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: AccountingPeriodDto[] }> {
    return { data: (await this.controls.periods(access, requestMeta(req))).map(toPeriod) };
  }

  @Post(`${FINANCE}/periods/:periodId/close`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Close a period: nothing can be posted into it until it is reopened.' })
  async close(
    @CurrentAccess() access: OrganisationAccess,
    @Param('periodId', uuid) periodId: string,
    @Req() req: Request,
  ): Promise<AccountingPeriodDto> {
    return toPeriod(await this.controls.closePeriod(access, periodId, requestMeta(req)));
  }

  // ------------------------------------------------------------------ approvals

  @Post(`${FINANCE}/approvals`)
  @RequirePermission('property.finance.manage')
  @ApiOperation({
    summary:
      'Request a payment reversal, refund, write-off or period reopening; someone else approves it.',
  })
  async request(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(approvalRequestSchema)) body: ApprovalRequestInput,
    @Req() req: Request,
  ): Promise<FinanceApprovalDto> {
    return toApproval(await this.controls.requestApproval(access, body, requestMeta(req)));
  }

  @Get(`${FINANCE}/approvals`)
  @RequirePermission('property.finance.read')
  async approvals(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(approvalListQuerySchema))
    query: z.infer<typeof approvalListQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: FinanceApprovalDto[] }> {
    const rows = await this.controls.approvals(access, query, requestMeta(req));
    return { data: rows.map(toApproval) };
  }

  @Get(`${FINANCE}/approvals/:approvalId`)
  @RequirePermission('property.finance.read')
  async approval(
    @CurrentAccess() access: OrganisationAccess,
    @Param('approvalId', uuid) approvalId: string,
    @Req() req: Request,
  ): Promise<FinanceApprovalDto> {
    const approval = await this.controls.approval(access, approvalId, requestMeta(req));
    return toApproval(approval);
  }

  @Post(`${FINANCE}/approvals/:approvalId/approve`)
  @HttpCode(200)
  @RequirePermission('property.finance.approve')
  @ApiOperation({ summary: 'Approve and carry out the action (not by the requester).' })
  async approve(
    @CurrentAccess() access: OrganisationAccess,
    @Param('approvalId', uuid) approvalId: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @Req() req: Request,
  ): Promise<FinanceApprovalDto> {
    const approval = await this.controls.approve(
      access,
      approvalId,
      body.note ?? null,
      requestMeta(req),
    );
    return toApproval(approval);
  }

  @Post(`${FINANCE}/approvals/:approvalId/reject`)
  @HttpCode(200)
  @RequirePermission('property.finance.approve')
  async reject(
    @CurrentAccess() access: OrganisationAccess,
    @Param('approvalId', uuid) approvalId: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @Req() req: Request,
  ): Promise<FinanceApprovalDto> {
    const approval = await this.controls.reject(
      access,
      approvalId,
      body.note ?? null,
      requestMeta(req),
    );
    return toApproval(approval);
  }

  @Post(`${FINANCE}/approvals/:approvalId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Withdraw your own pending request.' })
  async cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('approvalId', uuid) approvalId: string,
    @Req() req: Request,
  ): Promise<FinanceApprovalDto> {
    const approval = await this.controls.cancel(access, approvalId, requestMeta(req));
    return toApproval(approval);
  }

  // ------------------------------------------------------------------ credit notes

  @Post(`${FINANCE}/invoices/:invoiceId/credit-notes`)
  @RequirePermission('property.finance.manage')
  @ApiOperation({ summary: 'Correct an issued invoice line with a credit note.' })
  async creditNote(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invoiceId', uuid) invoiceId: string,
    @Body(new ZodValidationPipe(creditNoteSchema)) body: CreditNoteInput,
    @Req() req: Request,
  ): Promise<InvoiceDetailDto> {
    return toInvoiceDetail(
      await this.controls.createCreditNote(access, invoiceId, body, requestMeta(req)),
    );
  }

  // ------------------------------------------------------------------ reports

  @Get(`${FINANCE}/units/:unitId/statement`)
  @RequirePermission('property.finance.read')
  @ApiOperation({ summary: "A unit's statement for its owners or a tenancy." })
  async statement(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Query(new ZodValidationPipe(statementQuerySchema))
    query: z.infer<typeof statementQuerySchema>,
    @Req() req: Request,
  ): Promise<StatementDto> {
    const s = await this.controls.statement(access, unitId, query, requestMeta(req));
    return {
      unitId: s.unit.id,
      unitNumber: s.unit.number,
      paidBy: s.party.billTo,
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

  @Get(`${FINANCE}/ageing`)
  @RequirePermission('property.finance.read')
  @ApiOperation({ summary: 'What each unit and party still owes, by days overdue.' })
  async ageing(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(ageingQuerySchema)) query: z.infer<typeof ageingQuerySchema>,
    @Req() req: Request,
  ): Promise<AgeingDto> {
    const a = await this.controls.ageing(access, query.asOf, requestMeta(req));
    return {
      asOf: a.asOf,
      rows: a.rows.map((r) => ({
        unitId: r.unitId,
        unitNumber: r.unitNumber,
        billTo: r.billTo,
        tenancyId: r.tenancyId,
        buckets: toBuckets(r.buckets, a.currency),
        total: money(r.totalMinor, a.currency),
      })),
      totals: toBuckets(a.totals, a.currency),
    };
  }
}
