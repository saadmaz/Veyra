import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SubscriptionDto } from '@veyra/api-contracts';
import { ApiError } from '../../../platform/errors/api-error';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { SubscriptionsService } from '../application/subscriptions.service';

/** An organisation's plan and usage. */
@ApiTags('subscriptions')
@Controller('organisations/:organisationId')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('subscription')
  // A read permission only organisation admins hold, so it stays visible when the
  // organisation is read-only (that is when they most need to see why).
  @RequirePermission('organisation.member.read')
  @ApiOperation({ summary: 'The plan, what it allows, its limits, usage and recent changes.' })
  async current(@CurrentAccess() access: OrganisationAccess): Promise<SubscriptionDto> {
    const s = await this.subscriptions.current(access);
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'No subscription');
    return {
      plan: s.plan,
      status: s.status,
      trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
      lapsed: s.lapsed,
      usage: s.usage,
      history: s.history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
    };
  }
}
