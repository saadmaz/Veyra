import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  PlatformOrganisationDetailDto,
  PlatformOrganisationDto,
  PlatformPlanDto,
} from '@veyra/api-contracts';
import { z } from 'zod';
import { MfaPolicy } from '../../platform/auth/mfa-policy';
import { Authenticated } from '../../platform/auth/route-access';
import { ZodValidationPipe } from '../../platform/validation/zod-validation.pipe';
import { type AuthenticatedPrincipal, CurrentPrincipal } from '../identity';
import {
  PlatformAdminService,
  reasonSchema,
  type SubscriptionChangeInput,
  subscriptionChangeSchema,
} from './platform-admin.service';

const uuid = new ParseUUIDPipe();
const searchSchema = z.object({ search: z.string().trim().max(100).optional() });

type OrganisationRow = Awaited<ReturnType<PlatformAdminService['organisations']>>[number];

const toOrganisation = (o: OrganisationRow): PlatformOrganisationDto => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  countryCode: o.countryCode,
  status: o.status,
  createdAt: o.createdAt.toISOString(),
  subscription: o.subscription
    ? {
        planCode: o.subscription.planCode,
        planName: o.subscription.plan.name,
        status: o.subscription.status,
        trialEndsAt: o.subscription.trialEndsAt?.toISOString() ?? null,
      }
    : null,
});

const toDetail = (
  r: Awaited<ReturnType<PlatformAdminService['organisation']>>,
): PlatformOrganisationDetailDto => ({
  organisation: toOrganisation(r.organisation),
  usage: r.usage,
  history: r.history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
});

/**
 * Platform administration. Routes need a signed-in user; the service answers 404 to anyone who
 * is not a platform administrator, so the routes do not reveal themselves.
 */
@ApiTags('platform')
@Controller('platform')
export class PlatformAdminController {
  constructor(
    private readonly platform: PlatformAdminService,
    private readonly mfa: MfaPolicy,
  ) {}

  @Get('me')
  @Authenticated()
  @ApiOperation({ summary: 'Whether you are a platform administrator.' })
  async me(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<{ platformAdmin: boolean }> {
    return { platformAdmin: await this.platform.isAdmin(principal.userId) };
  }

  @Get('plans')
  @Authenticated()
  @ApiOperation({ summary: 'The plan catalogue (platform administrators).' })
  async plans(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<{ data: PlatformPlanDto[] }> {
    return { data: await this.platform.plans(principal.userId) };
  }

  @Get('organisations')
  @Authenticated()
  @ApiOperation({ summary: 'Organisations with their plan (no tenant data; at most 200).' })
  async organisations(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(searchSchema)) query: z.infer<typeof searchSchema>,
  ): Promise<{ data: PlatformOrganisationDto[] }> {
    const rows = await this.platform.organisations(principal.userId, query.search || undefined);
    return { data: rows.map(toOrganisation) };
  }

  @Get('organisations/:organisationId')
  @Authenticated()
  @ApiOperation({ summary: 'An organisation, its usage counts and subscription history.' })
  async organisation(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('organisationId', uuid) id: string,
  ): Promise<PlatformOrganisationDetailDto> {
    return toDetail(await this.platform.organisation(principal.userId, id));
  }

  @Post('organisations/:organisationId/subscription')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Change the plan or status, with a reason (audited for the customer).' })
  async subscription(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('organisationId', uuid) id: string,
    @Body(new ZodValidationPipe(subscriptionChangeSchema)) body: SubscriptionChangeInput,
  ): Promise<PlatformOrganisationDetailDto> {
    this.mfa.requireForPrivilegedChange(principal);
    return toDetail(await this.platform.changeSubscription(principal.userId, id, body));
  }

  @Post('organisations/:organisationId/suspend')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Suspend an organisation (read-only), with a reason.' })
  async suspend(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('organisationId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<PlatformOrganisationDetailDto> {
    this.mfa.requireForPrivilegedChange(principal);
    return toDetail(await this.platform.setStatus(principal.userId, id, 'SUSPENDED', body.reason));
  }

  @Post('organisations/:organisationId/reactivate')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Reactivate a suspended organisation, with a reason.' })
  async reactivate(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('organisationId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<PlatformOrganisationDetailDto> {
    this.mfa.requireForPrivilegedChange(principal);
    return toDetail(await this.platform.setStatus(principal.userId, id, 'ACTIVE', body.reason));
  }
}
