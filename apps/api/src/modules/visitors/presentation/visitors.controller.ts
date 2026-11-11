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
  ValidatePassResponse,
  VisitDto,
  VisitorInvitationDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { InvitationRecord, VisitRecord } from '../application/visitor-ports';
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
  type ValidatePassInput,
  validatePassSchema,
  visitLogQuerySchema,
  type WalkInInput,
  walkInSchema,
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
});

const UNIT = 'properties/:propertyId/units/:unitId/visitor-invitations';
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
      'Someone without a pass. To a unit: needs the resident’s approval (409 until Part 3). To the property: admitted.',
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
}
