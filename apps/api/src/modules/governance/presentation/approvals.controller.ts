import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ApprovalPolicyDto, ApprovalRequestDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { PolicyRecord } from '../application/approval-ports';
import { ApprovalsService, type RequestView } from '../application/approvals.service';
import {
  type ApprovalRequestInput,
  approvalRequestSchema,
  type DecisionInput,
  decisionSchema,
  type PolicyInput,
  policySchema,
  type UpdatePolicyInput,
  updatePolicySchema,
} from '../domain/approval-rules';

const uuid = new ParseUUIDPipe();
const P = 'properties/:propertyId/approval-policies';
const R = 'properties/:propertyId/approval-requests';
const listQuerySchema = z.object({ status: z.enum(['pending', 'all']).default('pending') });

const toPolicy = (p: PolicyRecord, currency: string): ApprovalPolicyDto => ({
  id: p.id,
  requestType: p.requestType,
  minAmount: { amountMinor: p.minAmountMinor.toString(), currency },
  requiredApprovals: p.requiredApprovals,
  approvers: p.approvers,
  committee: p.committeeId ? { id: p.committeeId, name: p.committeeName ?? '' } : null,
  active: p.active,
  createdAt: p.createdAt.toISOString(),
});

const toRequest = ({ request: r, canDecide }: RequestView): ApprovalRequestDto => ({
  id: r.id,
  reference: `AR-${String(r.number).padStart(6, '0')}`,
  requestType: r.requestType,
  title: r.title,
  description: r.description,
  amount:
    r.amountMinor !== null && r.currency
      ? { amountMinor: r.amountMinor.toString(), currency: r.currency }
      : null,
  document: r.document,
  requiredApprovals: r.requiredApprovals,
  approvers: r.approvers,
  committee: r.committee,
  status: r.status,
  requestedBy: { userId: r.requestedByUserId, name: r.requestedByName },
  decidedAt: r.decidedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  approvals: r.decisions.filter((d) => d.decision === 'APPROVE').length,
  decisions: r.decisions.map((d) => ({
    name: d.name,
    decision: d.decision,
    note: d.note,
    createdAt: d.createdAt.toISOString(),
  })),
  canDecide,
});

/** A property's approval policies and requests. */
@ApiTags('governance')
@Controller('organisations/:organisationId')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get(P)
  @RequirePermission('property.approval.read')
  @ApiOperation({ summary: 'Approval policies by request type and threshold.' })
  async policies(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: ApprovalPolicyDto[] }> {
    const { policies, currency } = await this.approvals.policies(access, requestMeta(req));
    return { data: policies.map((p) => toPolicy(p, currency)) };
  }

  @Post(P)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Add a policy: from an amount up, how many approvals and from whom.' })
  async createPolicy(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(policySchema)) body: PolicyInput,
    @Req() req: Request,
  ): Promise<ApprovalPolicyDto> {
    const { policy, currency } = await this.approvals.createPolicy(access, body, requestMeta(req));
    return toPolicy(policy, currency);
  }

  @Patch(`${P}/:policyId`)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Change the number of approvals, or retire a policy.' })
  async updatePolicy(
    @CurrentAccess() access: OrganisationAccess,
    @Param('policyId', uuid) id: string,
    @Body(new ZodValidationPipe(updatePolicySchema)) body: UpdatePolicyInput,
    @Req() req: Request,
  ): Promise<ApprovalPolicyDto> {
    const { policy, currency } = await this.approvals.updatePolicy(
      access,
      id,
      body,
      requestMeta(req),
    );
    return toPolicy(policy, currency);
  }

  @Get(R)
  @RequirePermission('property.approval.read')
  @ApiOperation({ summary: 'Approval requests, newest first (pending unless status=all).' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: ApprovalRequestDto[] }> {
    const rows = await this.approvals.list(access, query.status === 'pending', requestMeta(req));
    return { data: rows.map(toRequest) };
  }

  @Post(R)
  @RequirePermission('property.approval.request')
  @ApiOperation({ summary: 'Ask for an approval; the matching policy decides who approves.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(approvalRequestSchema)) body: ApprovalRequestInput,
    @Req() req: Request,
  ): Promise<ApprovalRequestDto> {
    return toRequest(await this.approvals.create(access, body, requestMeta(req)));
  }

  @Get(`${R}/:requestId`)
  @RequirePermission('property.approval.read')
  @ApiOperation({ summary: 'A request with its decisions, and whether you may decide it.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ApprovalRequestDto> {
    return toRequest(await this.approvals.detail(access, id, requestMeta(req)));
  }

  @Post(`${R}/:requestId/decisions`)
  @RequirePermission('property.approval.read')
  @ApiOperation({ summary: 'Approve or reject (with a reason), if you are one of its approvers.' })
  async decide(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: DecisionInput,
    @Req() req: Request,
  ): Promise<ApprovalRequestDto> {
    return toRequest(await this.approvals.decide(access, id, body, requestMeta(req)));
  }

  @Post(`${R}/:requestId/withdraw`)
  @HttpCode(200)
  @RequirePermission('property.approval.request')
  @ApiOperation({ summary: 'Withdraw your own pending request.' })
  async withdraw(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ApprovalRequestDto> {
    return toRequest(await this.approvals.withdraw(access, id, requestMeta(req)));
  }
}
