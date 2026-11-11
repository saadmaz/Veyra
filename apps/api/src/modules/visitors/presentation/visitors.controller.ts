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
  CreateVisitorInvitationResponse,
  OfflineListResponse,
  SyncLateEntriesResponse,
  ValidatePassResponse,
  VisitDto,
  VisitorInvitationDto,
  WalkInRequestDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type {
  InvitationRecord,
  VisitRecord,
  WalkInRequestRecord,
} from '../application/visitor-ports';
import { VisitorsService } from '../application/visitors.service';
import {
  type AdmitInput,
  admitSchema,
  type CreateInvitationInput,
  createInvitationSchema,
  type DenyInput,
  denySchema,
  departSchema,
  formatCode,
  reviewSchema,
  type SyncLateEntriesInput,
  syncLateEntriesSchema,
  type ValidatePassInput,
  validatePassSchema,
  visitLogQuerySchema,
  WALK_IN_APPROVAL_MS,
  type WalkInInput,
  type WalkInRequestInput,
  walkInRequestSchema,
  walkInSchema,
  walkInStatus,
} from '../domain/visitor-rules';

const uuid = new ParseUUIDPipe();

const toInvitation = (i: InvitationRecord, userId: string): VisitorInvitationDto => ({
  id: i.id,
  unitId: i.unitId,
  unitNumber: i.unitNumber,
  category: i.category,
  visitorName: i.visitorName,
  visitorPhone: i.visitorPhone,
  vehiclePlate: i.vehiclePlate,
  validFrom: i.validFrom.toISOString(),
  validUntil: i.validUntil.toISOString(),
  maxEntries: i.maxEntries,
  entriesUsed: i.entriesUsed,
  status: i.status,
  revokedAt: i.revokedAt?.toISOString() ?? null,
  createdByMe: i.createdByUserId === userId,
  createdAt: i.createdAt.toISOString(),
});

const toVisit = (v: VisitRecord): VisitDto => ({
  id: v.id,
  unitId: v.unitId,
  unitNumber: v.unitNumber,
  invitationId: v.invitationId,
  category: v.category,
  visitorName: v.visitorName,
  vehiclePlate: v.vehiclePlate,
  decision: v.decision,
  denialReason: v.denialReason,
  gate: v.gate,
  arrivedAt: v.arrivedAt.toISOString(),
  departedAt: v.departedAt?.toISOString() ?? null,
  source: v.source,
  reviewReason: v.reviewReason,
  reviewedAt: v.reviewedAt?.toISOString() ?? null,
  reviewNote: v.reviewNote,
});

const toWalkIn = (r: WalkInRequestRecord, now: Date): WalkInRequestDto => ({
  id: r.id,
  unitId: r.unitId,
  unitNumber: r.unitNumber,
  category: r.category,
  visitorName: r.visitorName,
  visitorPhone: r.visitorPhone,
  vehiclePlate: r.vehiclePlate,
  gate: r.gate,
  status: walkInStatus(r, now),
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
  approvalValidUntil:
    r.status === 'APPROVED' && r.decidedAt
      ? new Date(r.decidedAt.getTime() + WALK_IN_APPROVAL_MS).toISOString()
      : null,
  used: r.used,
});

const UNIT = 'properties/:propertyId/units/:unitId/visitor-invitations';
const UNIT_WALK_INS = 'properties/:propertyId/units/:unitId/walk-in-requests';
const GATE_WALK_INS = 'properties/:propertyId/gate/walk-in-requests';
const PROPERTY = 'properties/:propertyId';

/**
 * Visitors and the gate (Phase 5 Part 2). Residents of a unit and property staff register
 * visitors (unit.visitor.invite at :unitId); guards operate the gate (property.visitor.check_in);
 * supervisors and managers read the log and revoke invitations. Guards see only what they need.
 */
@ApiTags('visitors')
@Controller('organisations/:organisationId')
export class VisitorsController {
  constructor(private readonly visitors: VisitorsService) {}

  // ------------------------------------------------------------------ a unit's visitors

  @Post(UNIT)
  @RequirePermission('unit.visitor.invite')
  @ApiOperation({
    summary: 'Register a visitor. The pass (QR token and reference code) is returned only here.',
  })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationInput,
    @Req() req: Request,
  ): Promise<CreateVisitorInvitationResponse> {
    const { invitation, pass } = await this.visitors.createInvitation(
      access,
      body,
      requestMeta(req),
    );
    return {
      invitation: toInvitation(invitation, access.userId),
      pass: { token: pass.token, code: formatCode(pass.code) },
    };
  }

  @Get(UNIT)
  @RequirePermission('unit.visitor.invite')
  @ApiOperation({ summary: "The unit's current, upcoming and recently ended visitor invitations." })
  async listForUnit(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: VisitorInvitationDto[] }> {
    const rows = await this.visitors.unitInvitations(access, requestMeta(req));
    return { data: rows.map((i) => toInvitation(i, access.userId)) };
  }

  @Post(`${UNIT}/:invitationId/revoke`)
  @HttpCode(200)
  @RequirePermission('unit.visitor.invite')
  async revokeForUnit(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invitationId', uuid) invitationId: string,
    @Req() req: Request,
  ): Promise<VisitorInvitationDto> {
    const invitation = await this.visitors.revokeUnitInvitation(
      access,
      invitationId,
      requestMeta(req),
    );
    return toInvitation(invitation, access.userId);
  }

  // ------------------------------------------------------------------ supervisors and managers

  @Get(`${PROPERTY}/visitor-invitations`)
  @RequirePermission('property.visitor.read')
  async listForProperty(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: VisitorInvitationDto[] }> {
    const rows = await this.visitors.propertyInvitations(access, requestMeta(req));
    return { data: rows.map((i) => toInvitation(i, access.userId)) };
  }

  @Post(`${PROPERTY}/visitor-invitations/:invitationId/revoke`)
  @HttpCode(200)
  @RequirePermission('property.visitor.manage')
  async revokeForProperty(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invitationId', uuid) invitationId: string,
    @Req() req: Request,
  ): Promise<VisitorInvitationDto> {
    const invitation = await this.visitors.revokePropertyInvitation(
      access,
      invitationId,
      requestMeta(req),
    );
    return toInvitation(invitation, access.userId);
  }

  @Get(`${PROPERTY}/visits`)
  @RequirePermission('property.visitor.read')
  @ApiOperation({ summary: 'Visit log for a period of up to 31 days (from, to: ISO instants).' })
  async log(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(visitLogQuerySchema)) query: z.infer<typeof visitLogQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: VisitDto[] }> {
    const rows = await this.visitors.visitLog(access, query.from, query.to, requestMeta(req));
    return { data: rows.map(toVisit) };
  }

  // ------------------------------------------------------------------ the gate

  @Post(`${PROPERTY}/gate/validate`)
  @HttpCode(200)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({
    summary:
      'Check a scanned QR token or typed reference code. A valid pass is not proof of identity.',
  })
  async validate(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(validatePassSchema)) body: ValidatePassInput,
    @Req() req: Request,
  ): Promise<ValidatePassResponse> {
    const check = await this.visitors.validatePass(access, body, requestMeta(req));
    if (!check.valid) return { valid: false, reason: check.reason };
    const i = check.invitation;
    return {
      valid: true,
      pass: {
        invitationId: i.id,
        passId: check.passId,
        category: i.category,
        visitorName: i.visitorName,
        vehiclePlate: i.vehiclePlate,
        unitNumber: i.unitNumber,
        validUntil: i.validUntil.toISOString(),
        entriesLeft: i.maxEntries - i.entriesUsed,
      },
    };
  }

  @Post(`${PROPERTY}/gate/admit`)
  @RequirePermission('property.visitor.check_in')
  async admit(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(admitSchema)) body: AdmitInput,
    @Req() req: Request,
  ): Promise<VisitDto> {
    return toVisit(await this.visitors.admit(access, body, requestMeta(req)));
  }

  @Post(`${PROPERTY}/gate/deny`)
  @RequirePermission('property.visitor.check_in')
  async deny(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(denySchema)) body: DenyInput,
    @Req() req: Request,
  ): Promise<VisitDto> {
    return toVisit(await this.visitors.deny(access, body, requestMeta(req)));
  }

  @Post(`${PROPERTY}/gate/walk-in`)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({
    summary:
      'Someone without a pass, to the property itself: admitted. To a unit: 409, send a walk-in request for the resident to approve.',
  })
  async walkIn(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(walkInSchema)) body: WalkInInput,
    @Req() req: Request,
  ): Promise<VisitDto> {
    return toVisit(await this.visitors.walkIn(access, body, requestMeta(req)));
  }

  @Post(`${PROPERTY}/visits/:visitId/depart`)
  @HttpCode(200)
  @RequirePermission('property.visitor.check_in')
  async depart(
    @CurrentAccess() access: OrganisationAccess,
    @Param('visitId', uuid) visitId: string,
    @Body(new ZodValidationPipe(departSchema)) body: z.infer<typeof departSchema>,
    @Req() req: Request,
  ): Promise<VisitDto> {
    return toVisit(await this.visitors.depart(access, visitId, body.gate, requestMeta(req)));
  }

  @Get(`${PROPERTY}/visits/inside`)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({ summary: 'Visitors admitted and not yet departed, for recording departures.' })
  async inside(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: VisitDto[] }> {
    return { data: (await this.visitors.visitorsInside(access, requestMeta(req))).map(toVisit) };
  }

  // ------------------------------------------------------------------ walk-in approval (Part 3)

  @Post(GATE_WALK_INS)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({
    summary: 'Ask the unit’s residents to let in someone without a pass (10 minutes to answer).',
  })
  async requestWalkIn(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(walkInRequestSchema)) body: WalkInRequestInput,
    @Req() req: Request,
  ): Promise<WalkInRequestDto> {
    return toWalkIn(await this.visitors.requestWalkIn(access, body, requestMeta(req)), new Date());
  }

  @Get(GATE_WALK_INS)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({
    summary: 'Walk-in requests of the last 24 hours, newest first (poll for answers).',
  })
  async gateWalkIns(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: WalkInRequestDto[] }> {
    const now = new Date();
    const rows = await this.visitors.gateWalkInRequests(access, requestMeta(req));
    return { data: rows.map((r) => toWalkIn(r, now)) };
  }

  @Get(`${GATE_WALK_INS}/:requestId`)
  @RequirePermission('property.visitor.check_in')
  async gateWalkIn(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Req() req: Request,
  ): Promise<WalkInRequestDto> {
    return toWalkIn(
      await this.visitors.gateWalkInRequest(access, requestId, requestMeta(req)),
      new Date(),
    );
  }

  @Post(`${GATE_WALK_INS}/:requestId/admit`)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({ summary: 'Admit on the resident’s approval: once, within 15 minutes of it.' })
  async admitWalkIn(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Body(new ZodValidationPipe(departSchema)) body: z.infer<typeof departSchema>,
    @Req() req: Request,
  ): Promise<VisitDto> {
    return toVisit(await this.visitors.admitWalkIn(access, requestId, body.gate, requestMeta(req)));
  }

  @Post(`${GATE_WALK_INS}/:requestId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.visitor.check_in')
  async cancelWalkIn(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Req() req: Request,
  ): Promise<WalkInRequestDto> {
    return toWalkIn(
      await this.visitors.cancelWalkIn(access, requestId, requestMeta(req)),
      new Date(),
    );
  }

  @Get(UNIT_WALK_INS)
  @RequirePermission('unit.visitor.invite')
  @ApiOperation({ summary: 'Walk-in requests for the unit: waiting for an answer, and recent.' })
  async unitWalkIns(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: WalkInRequestDto[] }> {
    const now = new Date();
    const rows = await this.visitors.unitWalkInRequests(access, requestMeta(req));
    return { data: rows.map((r) => toWalkIn(r, now)) };
  }

  @Post(`${UNIT_WALK_INS}/:requestId/approve`)
  @HttpCode(200)
  @RequirePermission('unit.visitor.invite')
  @ApiOperation({
    summary: 'A resident of the unit lets the visitor in (residents only, not staff).',
  })
  async approveWalkIn(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Req() req: Request,
  ): Promise<WalkInRequestDto> {
    return toWalkIn(
      await this.visitors.decideWalkIn(access, requestId, true, requestMeta(req)),
      new Date(),
    );
  }

  @Post(`${UNIT_WALK_INS}/:requestId/deny`)
  @HttpCode(200)
  @RequirePermission('unit.visitor.invite')
  async denyWalkIn(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Req() req: Request,
  ): Promise<WalkInRequestDto> {
    return toWalkIn(
      await this.visitors.decideWalkIn(access, requestId, false, requestMeta(req)),
      new Date(),
    );
  }

  // ------------------------------------------------------------------ offline gate (Part 5)

  @Get(`${PROPERTY}/gate/offline-list`)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({
    summary:
      'Passes usable in the next 4 hours, as hashes, for checking while offline. Do not use after trustUntil.',
  })
  async offlineList(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<OfflineListResponse> {
    const list = await this.visitors.offlineList(access, requestMeta(req));
    return {
      propertyId: access.propertyId as string,
      generatedAt: list.generatedAt.toISOString(),
      trustUntil: list.trustUntil.toISOString(),
      entries: list.entries,
    };
  }

  @Post(`${PROPERTY}/gate/late-entries`)
  @HttpCode(200)
  @RequirePermission('property.visitor.check_in')
  @ApiOperation({
    summary:
      'Record what happened while offline (OFFLINE_SYNC) or in the paper log (PAPER, supervisors). Idempotent per clientRef.',
  })
  async lateEntries(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(syncLateEntriesSchema)) body: SyncLateEntriesInput,
    @Req() req: Request,
  ): Promise<SyncLateEntriesResponse> {
    return { results: await this.visitors.syncLateEntries(access, body, requestMeta(req)) };
  }

  @Get(`${PROPERTY}/visits/needs-review`)
  @RequirePermission('property.visitor.read')
  @ApiOperation({
    summary: 'Paper and offline entries the pass would not have allowed, not yet reviewed.',
  })
  async needsReview(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: VisitDto[] }> {
    return {
      data: (await this.visitors.visitsNeedingReview(access, requestMeta(req))).map(toVisit),
    };
  }

  @Post(`${PROPERTY}/visits/:visitId/review`)
  @HttpCode(200)
  @RequirePermission('property.visitor.manage')
  async review(
    @CurrentAccess() access: OrganisationAccess,
    @Param('visitId', uuid) visitId: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: z.infer<typeof reviewSchema>,
    @Req() req: Request,
  ): Promise<VisitDto> {
    return toVisit(await this.visitors.reviewVisit(access, visitId, body.note, requestMeta(req)));
  }
}
