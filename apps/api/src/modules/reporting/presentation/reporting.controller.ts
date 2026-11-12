import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PropertyDashboardDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import { requestMeta } from '../../../platform/request-meta';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { ReportingService } from '../application/reporting.service';

/** Role-scoped dashboards. */
@ApiTags('reporting')
@Controller('organisations/:organisationId')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('properties/:propertyId/dashboard')
  @RequirePermission('property.profile.read')
  @ApiOperation({
    summary: "The property's figures; each area only for people who can see that area.",
  })
  async dashboard(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<PropertyDashboardDto> {
    const d = await this.reporting.dashboard(access, requestMeta(req));
    return {
      asOf: d.asOf,
      occupancy: d.occupancy,
      finance: d.finance
        ? {
            outstanding: money(d.finance.outstandingMinor, d.finance.currency),
            overdue: money(d.finance.overdueMinor, d.finance.currency),
            overdueInvoices: d.finance.overdueInvoices,
            collectedLast30Days: money(d.finance.collectedLast30DaysMinor, d.finance.currency),
          }
        : null,
      maintenance: d.maintenance,
      visitors: d.visitors,
      facilities: d.facilities,
      incidents: d.incidents,
      pendingApprovals: d.pendingApprovals,
    };
  }
}

const money = (amountMinor: bigint, currency: string) => ({
  amountMinor: amountMinor.toString(),
  currency,
});
