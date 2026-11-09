import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AcceptInvitationResponse,
  CreateInvitationResponse,
  InvitationDto,
  MembershipDto,
  MyOrganisationDto,
  OrganisationDetailResponse,
  OrganisationDto,
  Paginated,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import { Authenticated } from '../../../platform/auth/route-access';
import { CLOCK, type Clock } from '../../../platform/clock';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { type AuthenticatedPrincipal, CurrentPrincipal } from '../../identity';
import { InvitationsService } from '../application/invitations.service';
import { MembershipsService } from '../application/memberships.service';
import { OrganisationsService } from '../application/organisations.service';
import {
  acceptInvitationSchema,
  type CreateInvitationInput,
  type CreateOrganisationInput,
  changeMembershipStatusSchema,
  createInvitationSchema,
  createOrganisationSchema,
  type ListQuery,
  listQuerySchema,
  type MembershipStatus,
  type UpdateOrganisationInput,
  updateOrganisationSchema,
} from '../domain/organisation-rules';
import { toInvitationDto, toMembershipDto, toOrganisationDto } from './mappers';

const uuid = new ParseUUIDPipe({ version: undefined });

@ApiTags('organisations')
@Controller('organisations')
export class OrganisationsController {
  constructor(
    private readonly organisations: OrganisationsService,
    private readonly memberships: MembershipsService,
    private readonly invitations: InvitationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @Authenticated()
  @ApiOperation({ summary: 'Create an organisation. The caller becomes its organisation admin.' })
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createOrganisationSchema)) body: CreateOrganisationInput,
    @Req() req: Request,
  ): Promise<OrganisationDto> {
    return toOrganisationDto(
      await this.organisations.create(principal.userId, body, requestMeta(req)),
    );
  }

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Organisations where the caller has an active membership.' })
  async listMine(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<{ data: MyOrganisationDto[] }> {
    const rows = await this.organisations.listMine(principal.userId);
    return {
      data: rows.map((row) => ({
        organisation: toOrganisationDto(row.organisation),
        roles: row.roles,
      })),
    };
  }

  @Get(':organisationId')
  @RequirePermission('organisation.profile.read')
  @ApiOperation({ summary: 'The organisation and the permissions the caller holds in it.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<OrganisationDetailResponse> {
    const organisation = await this.organisations.get(access, requestMeta(req));
    return { ...toOrganisationDto(organisation), permissions: [...access.permissions].sort() };
  }

  @Patch(':organisationId')
  @RequirePermission('organisation.settings.manage')
  @ApiOperation({ summary: 'Change the organisation name or default time zone.' })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(updateOrganisationSchema)) body: UpdateOrganisationInput,
    @Req() req: Request,
  ): Promise<OrganisationDto> {
    return toOrganisationDto(await this.organisations.update(access, body, requestMeta(req)));
  }

  @Get(':organisationId/memberships')
  @RequirePermission('organisation.member.read')
  @ApiOperation({ summary: 'Members of the organisation and their roles.' })
  async listMemberships(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
    @Req() req: Request,
  ): Promise<Paginated<MembershipDto>> {
    const page = await this.memberships.list(access, query, requestMeta(req));
    return { data: page.data.map(toMembershipDto), nextCursor: page.nextCursor };
  }

  @Patch(':organisationId/memberships/:membershipId')
  @RequirePermission('organisation.member.manage')
  @ApiOperation({ summary: 'Suspend, reactivate or revoke a membership.' })
  async changeMembershipStatus(
    @CurrentAccess() access: OrganisationAccess,
    @Param('membershipId', uuid) membershipId: string,
    @Body(new ZodValidationPipe(changeMembershipStatusSchema)) body: { status: MembershipStatus },
    @Req() req: Request,
  ): Promise<{ id: string; status: MembershipStatus }> {
    const updated = await this.memberships.changeStatus(
      access,
      membershipId,
      body.status,
      requestMeta(req),
    );
    return { id: updated.id, status: updated.status };
  }

  @Post(':organisationId/invitations')
  @RequirePermission('organisation.member.invite')
  @ApiOperation({ summary: 'Invite someone by email. Returns the one-time acceptance token.' })
  async createInvitation(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationInput,
    @Req() req: Request,
  ): Promise<CreateInvitationResponse> {
    const issued = await this.invitations.create(access, body, requestMeta(req));
    return {
      invitation: toInvitationDto(issued.invitation, this.clock.now()),
      token: issued.token,
    };
  }

  @Get(':organisationId/invitations')
  @RequirePermission('organisation.member.invite')
  @ApiOperation({ summary: 'Invitations of the organisation (tokens are never shown again).' })
  async listInvitations(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
    @Req() req: Request,
  ): Promise<Paginated<InvitationDto>> {
    const page = await this.invitations.list(access, query, requestMeta(req));
    const now = this.clock.now();
    return { data: page.data.map((i) => toInvitationDto(i, now)), nextCursor: page.nextCursor };
  }

  @Post(':organisationId/persons/:personId/invitations')
  @RequirePermission('organisation.member.invite')
  @ApiOperation({
    summary: 'Invite a resident to link their profile to a login (one-time token, email-bound).',
  })
  async createResidentInvitation(
    @CurrentAccess() access: OrganisationAccess,
    @Param('personId', uuid) personId: string,
    @Req() req: Request,
  ): Promise<CreateInvitationResponse> {
    const issued = await this.invitations.createResidentInvitation(
      access,
      personId,
      requestMeta(req),
    );
    return {
      invitation: toInvitationDto(issued.invitation, this.clock.now()),
      token: issued.token,
    };
  }

  @Post(':organisationId/invitations/:invitationId/revoke')
  @HttpCode(204)
  @RequirePermission('organisation.member.invite')
  @ApiOperation({ summary: 'Withdraw a pending invitation.' })
  async revokeInvitation(
    @CurrentAccess() access: OrganisationAccess,
    @Param('invitationId', uuid) invitationId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.invitations.revoke(access, invitationId, requestMeta(req));
  }
}

@ApiTags('organisations')
@Controller('invitations')
export class InvitationAcceptanceController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('accept')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Accept an invitation sent to the signed-in user’s email address.' })
  async accept(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: { token: string },
    @Req() req: Request,
  ): Promise<AcceptInvitationResponse> {
    const { organisation, role } = await this.invitations.accept(
      { userId: principal.userId, email: principal.email },
      body.token,
      requestMeta(req),
    );
    return { organisation: toOrganisationDto(organisation), role };
  }
}
