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
import type {
  AssetDetailDto,
  AssetDto,
  MaintenanceScheduleDto,
  RaiseDueWorkResultDto,
  ScheduleOverviewDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { AssetRecord, AssetWorkRecord, ScheduleRecord } from '../application/asset-ports';
import { AssetsService } from '../application/assets.service';
import {
  assetListQuerySchema,
  assetReasonSchema,
  type CreateAssetInput,
  type CreateScheduleInput,
  createAssetSchema,
  createScheduleSchema,
  type UpdateAssetInput,
  type UpdateScheduleInput,
  updateAssetSchema,
  updateScheduleSchema,
} from '../domain/asset-rules';
import { formatWorkOrderNumber } from '../domain/maintenance-rules';

const uuid = new ParseUUIDPipe();
const M = 'properties/:propertyId/maintenance';

const toAsset = (a: AssetRecord, today: string): AssetDto => ({
  id: a.id,
  tag: a.tag,
  name: a.name,
  category: a.category,
  unitId: a.unitId,
  unitNumber: a.unitNumber,
  commonAreaId: a.commonAreaId,
  commonAreaName: a.commonAreaName,
  manufacturer: a.manufacturer,
  model: a.model,
  serialNumber: a.serialNumber,
  installedOn: a.installedOn,
  warrantyExpiresOn: a.warrantyExpiresOn,
  underWarranty: a.warrantyExpiresOn !== null && a.warrantyExpiresOn >= today,
  supplier: a.supplierVendorId ? { id: a.supplierVendorId, name: a.supplierName ?? '' } : null,
  notes: a.notes,
  status: a.status,
  statusNote: a.statusNote,
  retiredAt: a.retiredAt?.toISOString() ?? null,
  createdAt: a.createdAt.toISOString(),
});

const toSchedule = (s: ScheduleRecord): MaintenanceScheduleDto => ({
  id: s.id,
  assetId: s.assetId,
  title: s.title,
  description: s.description,
  priority: s.priority,
  intervalUnit: s.intervalUnit,
  intervalCount: s.intervalCount,
  nextDueOn: s.nextDueOn,
  leadDays: s.leadDays,
  vendor: s.vendorId ? { id: s.vendorId, name: s.vendorName ?? '' } : null,
  active: s.active,
  createdAt: s.createdAt.toISOString(),
});

const toWork = (w: AssetWorkRecord) => ({
  id: w.id,
  number: formatWorkOrderNumber(w.number),
  title: w.title,
  status: w.status,
  scheduledFor: w.scheduledFor,
  completedAt: w.completedAt?.toISOString() ?? null,
  createdAt: w.createdAt.toISOString(),
});

const toDetail = (d: {
  asset: AssetRecord;
  schedules: ScheduleRecord[];
  history: AssetWorkRecord[];
  today: string;
}): AssetDetailDto => ({
  asset: toAsset(d.asset, d.today),
  schedules: d.schedules.map(toSchedule),
  history: d.history.map(toWork),
});

/** A property's asset register and preventive maintenance, for maintenance staff. */
@ApiTags('maintenance')
@Controller('organisations/:organisationId')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get(`${M}/assets`)
  @RequirePermission('property.maintenance.read')
  @ApiOperation({ summary: 'Assets by tag (at most 500).' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(assetListQuerySchema)) query: z.infer<typeof assetListQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: AssetDto[] }> {
    const { assets, today } = await this.assets.list(access, query.status, requestMeta(req));
    return { data: assets.map((a) => toAsset(a, today)) };
  }

  @Post(`${M}/assets`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Add equipment to the register.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createAssetSchema)) body: CreateAssetInput,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(await this.assets.create(access, body, requestMeta(req)));
  }

  @Get(`${M}/assets/:assetId`)
  @RequirePermission('property.maintenance.read')
  @ApiOperation({ summary: 'An asset with its schedules and service history.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('assetId', uuid) id: string,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(await this.assets.detail(access, id, requestMeta(req)));
  }

  @Patch(`${M}/assets/:assetId`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: "Change an asset's details or place." })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Param('assetId', uuid) id: string,
    @Body(new ZodValidationPipe(updateAssetSchema)) body: UpdateAssetInput,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(await this.assets.update(access, id, body, requestMeta(req)));
  }

  @Post(`${M}/assets/:assetId/out-of-service`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Mark it out of service, saying why (no preventive work is raised).' })
  async outOfService(
    @CurrentAccess() access: OrganisationAccess,
    @Param('assetId', uuid) id: string,
    @Body(new ZodValidationPipe(assetReasonSchema)) body: z.infer<typeof assetReasonSchema>,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(
      await this.assets.setStatus(access, id, 'OUT_OF_SERVICE', body.reason, requestMeta(req)),
    );
  }

  @Post(`${M}/assets/:assetId/back-in-service`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Back in service.' })
  async backInService(
    @CurrentAccess() access: OrganisationAccess,
    @Param('assetId', uuid) id: string,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(await this.assets.setStatus(access, id, 'ACTIVE', null, requestMeta(req)));
  }

  @Post(`${M}/assets/:assetId/retire`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Retire for good (schedules paused and no open work first).' })
  async retire(
    @CurrentAccess() access: OrganisationAccess,
    @Param('assetId', uuid) id: string,
    @Body(new ZodValidationPipe(assetReasonSchema)) body: z.infer<typeof assetReasonSchema>,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(
      await this.assets.setStatus(access, id, 'RETIRED', body.reason, requestMeta(req)),
    );
  }

  @Post(`${M}/assets/:assetId/schedules`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Repeat work on the asset every few days, weeks or months.' })
  async addSchedule(
    @CurrentAccess() access: OrganisationAccess,
    @Param('assetId', uuid) id: string,
    @Body(new ZodValidationPipe(createScheduleSchema)) body: CreateScheduleInput,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(await this.assets.addSchedule(access, id, body, requestMeta(req)));
  }

  @Get(`${M}/schedules`)
  @RequirePermission('property.maintenance.read')
  @ApiOperation({ summary: 'Active schedules, soonest due first, saying which are due now.' })
  async schedules(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<ScheduleOverviewDto> {
    const result = await this.assets.schedules(access, requestMeta(req));
    return {
      today: result.today,
      data: result.schedules.map((s) => ({
        schedule: toSchedule(s.schedule),
        asset: s.asset ? { id: s.asset.id, tag: s.asset.tag, name: s.asset.name } : null,
        due: s.due,
      })),
    };
  }

  @Patch(`${M}/schedules/:scheduleId`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Change, pause or resume a schedule.' })
  async updateSchedule(
    @CurrentAccess() access: OrganisationAccess,
    @Param('scheduleId', uuid) id: string,
    @Body(new ZodValidationPipe(updateScheduleSchema)) body: UpdateScheduleInput,
    @Req() req: Request,
  ): Promise<AssetDetailDto> {
    return toDetail(await this.assets.updateSchedule(access, id, body, requestMeta(req)));
  }

  @Post(`${M}/schedules/raise-due`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Raise the preventive work that is due (safe to repeat).' })
  raiseDue(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<RaiseDueWorkResultDto> {
    return this.assets.raiseDue(access, requestMeta(req));
  }
}
