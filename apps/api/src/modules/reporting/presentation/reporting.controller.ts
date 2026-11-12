import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ExportListDto, PropertyDashboardDto } from '@veyra/api-contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { ExportsService } from '../application/exports.service';
import { ReportingService } from '../application/reporting.service';
import { EXPORTS, type RangeInput, rangeSchema } from '../domain/export-rules';

const exportName = new ZodValidationPipe(z.enum(EXPORTS));

/** Role-scoped dashboards. */
@ApiTags('reporting')
@Controller('organisations/:organisationId')
export class ReportingController {
  constructor(
    private readonly reporting: ReportingService,
    private readonly exports: ExportsService,
  ) {}

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

  @Get('properties/:propertyId/exports')
  @RequirePermission('property.profile.read')
  @ApiOperation({ summary: 'The CSV exports you may download here.' })
  available(@CurrentAccess() access: OrganisationAccess): ExportListDto {
    return { data: this.exports.available(access) };
  }

  @Get('properties/:propertyId/exports/:name')
  @RequirePermission('property.report.export')
  @ApiOperation({
    summary: "Download a CSV export (dates are the property's, at most 366 days; audited).",
  })
  async download(
    @CurrentAccess() access: OrganisationAccess,
    @Param('name', exportName) name: (typeof EXPORTS)[number],
    @Query(new ZodValidationPipe(rangeSchema)) range: RangeInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const file = await this.exports.export(access, name, range, requestMeta(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return file.csv;
  }
}

const money = (amountMinor: bigint, currency: string) => ({
  amountMinor: amountMinor.toString(),
  currency,
});
