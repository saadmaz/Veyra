import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SupportAccessDto } from '@veyra/api-contracts';
import { Authenticated } from '../../platform/auth/route-access';
import { ZodValidationPipe } from '../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../access-control';
import { type AuthenticatedPrincipal, CurrentPrincipal } from '../identity';
import {
  SupportAccessService,
  type SupportRequestInput,
  supportRequestSchema,
} from './support-access.service';

const uuid = new ParseUUIDPipe();

type Row = Awaited<ReturnType<SupportAccessService['list']>>[number];

const toDto = (r: Row, now = new Date()): SupportAccessDto => ({
  id: r.id,
  organisation: { id: r.organisationId, name: r.organisation.name },
  reason: r.reason,
  hours: r.hours,
  status: r.status,
  active:
    r.status === 'APPROVED' && !!r.startsAt && !!r.endsAt && r.startsAt <= now && now < r.endsAt,
  requestedBy: { name: r.requestedBy.displayName, email: r.requestedBy.email },
  decidedBy: r.decidedBy?.displayName ?? null,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  startsAt: r.startsAt?.toISOString() ?? null,
  endsAt: r.endsAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** Support access as the organisation sees and decides it. */
@ApiTags('platform')
@Controller('organisations/:organisationId/support-access')
export class OrganisationSupportAccessController {
  constructor(private readonly support: SupportAccessService) {}

  @Get()
  // A read permission only organisation admins hold: visible even while read-only.
  @RequirePermission('organisation.member.read')
  @ApiOperation({ summary: 'Support access asked for by VEYRA staff, newest first.' })
  async list(@CurrentAccess() access: OrganisationAccess): Promise<{ data: SupportAccessDto[] }> {
    return { data: (await this.support.list(access)).map((r) => toDto(r)) };
  }

  @Post(':supportId/approve')
  @HttpCode(200)
  @RequirePermission('organisation.member.manage')
  @ApiOperation({ summary: 'Approve: read-only access starts now for the asked hours.' })
  async approve(
    @CurrentAccess() access: OrganisationAccess,
    @Param('supportId', uuid) id: string,
  ): Promise<SupportAccessDto> {
    return toDto(await this.support.decide(access, id, 'APPROVED'));
  }

  @Post(':supportId/deny')
  @HttpCode(200)
  @RequirePermission('organisation.member.manage')
  @ApiOperation({ summary: 'Deny a request.' })
  async deny(
    @CurrentAccess() access: OrganisationAccess,
    @Param('supportId', uuid) id: string,
  ): Promise<SupportAccessDto> {
    return toDto(await this.support.decide(access, id, 'DENIED'));
  }

  @Post(':supportId/revoke')
  @HttpCode(200)
  @RequirePermission('organisation.member.manage')
  @ApiOperation({ summary: 'End approved access now.' })
  async revoke(
    @CurrentAccess() access: OrganisationAccess,
    @Param('supportId', uuid) id: string,
  ): Promise<SupportAccessDto> {
    return toDto(await this.support.decide(access, id, 'REVOKED'));
  }
}

/** Support access as VEYRA staff ask for it (404 to everyone else). */
@ApiTags('platform')
@Controller('platform')
export class PlatformSupportAccessController {
  constructor(private readonly support: SupportAccessService) {}

  @Get('support-access')
  @Authenticated()
  @ApiOperation({ summary: 'Your support access requests.' })
  async mine(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<{ data: SupportAccessDto[] }> {
    return { data: (await this.support.mine(principal.userId)).map((r) => toDto(r)) };
  }

  @Post('organisations/:organisationId/support-access')
  @Authenticated()
  @ApiOperation({ summary: 'Ask an organisation for read-only access (reason, 1-24 hours).' })
  async request(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('organisationId', uuid) organisationId: string,
    @Body(new ZodValidationPipe(supportRequestSchema)) body: SupportRequestInput,
  ): Promise<SupportAccessDto> {
    return toDto(await this.support.request(principal.userId, organisationId, body));
  }
}
