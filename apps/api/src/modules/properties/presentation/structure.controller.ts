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
  BuildingDto,
  CommonAreaDto,
  FloorDto,
  Paginated,
  UnitDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { StructureService } from '../application/structure.service';
import type {
  BuildingRecord,
  CommonAreaRecord,
  FloorRecord,
  UnitRecord,
} from '../application/structure-ports';
import {
  type CreateBuildingInput,
  type CreateCommonAreaInput,
  type CreateFloorInput,
  type CreateUnitInput,
  createBuildingSchema,
  createCommonAreaSchema,
  createFloorSchema,
  createUnitSchema,
  type StructureListQuery,
  structureListSchema,
  type UnitListQuery,
  type UpdateBuildingInput,
  type UpdateCommonAreaInput,
  type UpdateFloorInput,
  type UpdateUnitInput,
  unitListSchema,
  updateBuildingSchema,
  updateCommonAreaSchema,
  updateFloorSchema,
  updateUnitSchema,
} from '../domain/structure-rules';

const uuid = new ParseUUIDPipe();
const iso = (date: Date | null) => date?.toISOString() ?? null;

const toBuilding = (b: BuildingRecord): BuildingDto => ({
  id: b.id,
  propertyId: b.propertyId,
  name: b.name,
  code: b.code,
  status: b.status,
  archivedAt: iso(b.archivedAt),
  createdAt: b.createdAt.toISOString(),
});
const toFloor = (f: FloorRecord): FloorDto => ({
  id: f.id,
  propertyId: f.propertyId,
  buildingId: f.buildingId,
  level: f.level,
  name: f.name,
  status: f.status,
  archivedAt: iso(f.archivedAt),
  createdAt: f.createdAt.toISOString(),
});
const toUnit = (u: UnitRecord): UnitDto => ({
  id: u.id,
  propertyId: u.propertyId,
  buildingId: u.buildingId,
  floorId: u.floorId,
  number: u.number,
  type: u.type,
  areaSqm: u.areaSqm,
  shareRatio: u.shareRatio,
  status: u.status,
  archivedAt: iso(u.archivedAt),
  createdAt: u.createdAt.toISOString(),
});
const toCommonArea = (a: CommonAreaRecord): CommonAreaDto => ({
  id: a.id,
  propertyId: a.propertyId,
  buildingId: a.buildingId,
  name: a.name,
  type: a.type,
  status: a.status,
  archivedAt: iso(a.archivedAt),
  createdAt: a.createdAt.toISOString(),
});
const page = <R, D>(
  p: { data: R[]; nextCursor: string | null },
  map: (r: R) => D,
): Paginated<D> => ({
  data: p.data.map(map),
  nextCursor: p.nextCursor,
});

const READ = 'property.structure.read' as const;
const MANAGE = 'property.structure.manage' as const;

/**
 * Buildings, floors, units and common areas of one property. Reading needs
 * property.structure.read at that property; every change needs property.structure.manage.
 * Archiving replaces deleting.
 */
@ApiTags('property structure')
@Controller('organisations/:organisationId/properties/:propertyId')
export class StructureController {
  constructor(private readonly structure: StructureService) {}

  // ------------------------------------------------------------------ buildings

  @Get('buildings')
  @RequirePermission(READ)
  @ApiOperation({ summary: 'Buildings of the property (active by default; ?status=ARCHIVED).' })
  async listBuildings(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(structureListSchema)) query: StructureListQuery,
    @Req() req: Request,
  ): Promise<Paginated<BuildingDto>> {
    return page(await this.structure.listBuildings(access, query, requestMeta(req)), toBuilding);
  }

  @Post('buildings')
  @RequirePermission(MANAGE)
  async createBuilding(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createBuildingSchema)) body: CreateBuildingInput,
    @Req() req: Request,
  ): Promise<BuildingDto> {
    return toBuilding(await this.structure.createBuilding(access, body, requestMeta(req)));
  }

  @Get('buildings/:buildingId')
  @RequirePermission(READ)
  async getBuilding(
    @CurrentAccess() access: OrganisationAccess,
    @Param('buildingId', uuid) buildingId: string,
    @Req() req: Request,
  ): Promise<BuildingDto> {
    return toBuilding(await this.structure.getBuilding(access, buildingId, requestMeta(req)));
  }

  @Patch('buildings/:buildingId')
  @RequirePermission(MANAGE)
  async updateBuilding(
    @CurrentAccess() access: OrganisationAccess,
    @Param('buildingId', uuid) buildingId: string,
    @Body(new ZodValidationPipe(updateBuildingSchema)) body: UpdateBuildingInput,
    @Req() req: Request,
  ): Promise<BuildingDto> {
    return toBuilding(
      await this.structure.updateBuilding(access, buildingId, body, requestMeta(req)),
    );
  }

  @Post('buildings/:buildingId/archive')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  @ApiOperation({
    summary: 'Archive a building with no active units; its floors and common areas follow.',
  })
  async archiveBuilding(
    @CurrentAccess() access: OrganisationAccess,
    @Param('buildingId', uuid) buildingId: string,
    @Req() req: Request,
  ): Promise<BuildingDto> {
    return toBuilding(await this.structure.archiveBuilding(access, buildingId, requestMeta(req)));
  }

  // ------------------------------------------------------------------ floors

  @Get('buildings/:buildingId/floors')
  @RequirePermission(READ)
  async listFloors(
    @CurrentAccess() access: OrganisationAccess,
    @Param('buildingId', uuid) buildingId: string,
    @Query(new ZodValidationPipe(structureListSchema)) query: StructureListQuery,
    @Req() req: Request,
  ): Promise<Paginated<FloorDto>> {
    return page(
      await this.structure.listFloors(access, buildingId, query, requestMeta(req)),
      toFloor,
    );
  }

  @Post('buildings/:buildingId/floors')
  @RequirePermission(MANAGE)
  async createFloor(
    @CurrentAccess() access: OrganisationAccess,
    @Param('buildingId', uuid) buildingId: string,
    @Body(new ZodValidationPipe(createFloorSchema)) body: CreateFloorInput,
    @Req() req: Request,
  ): Promise<FloorDto> {
    return toFloor(await this.structure.createFloor(access, buildingId, body, requestMeta(req)));
  }

  @Patch('buildings/:buildingId/floors/:floorId')
  @RequirePermission(MANAGE)
  async updateFloor(
    @CurrentAccess() access: OrganisationAccess,
    @Param('buildingId', uuid) buildingId: string,
    @Param('floorId', uuid) floorId: string,
    @Body(new ZodValidationPipe(updateFloorSchema)) body: UpdateFloorInput,
    @Req() req: Request,
  ): Promise<FloorDto> {
    return toFloor(
      await this.structure.updateFloor(access, buildingId, floorId, body, requestMeta(req)),
    );
  }

  @Post('buildings/:buildingId/floors/:floorId/archive')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  async archiveFloor(
    @CurrentAccess() access: OrganisationAccess,
    @Param('buildingId', uuid) buildingId: string,
    @Param('floorId', uuid) floorId: string,
    @Req() req: Request,
  ): Promise<FloorDto> {
    return toFloor(
      await this.structure.archiveFloor(access, buildingId, floorId, requestMeta(req)),
    );
  }

  // ------------------------------------------------------------------ units

  @Get('units')
  @RequirePermission(READ)
  @ApiOperation({ summary: 'Units, optionally filtered by building or floor.' })
  async listUnits(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(unitListSchema)) query: UnitListQuery,
    @Req() req: Request,
  ): Promise<Paginated<UnitDto>> {
    return page(await this.structure.listUnits(access, query, requestMeta(req)), toUnit);
  }

  @Post('units')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Add a unit. Area and share ratio are decimal strings, e.g. "85.50".' })
  async createUnit(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createUnitSchema)) body: CreateUnitInput,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return toUnit(await this.structure.createUnit(access, body, requestMeta(req)));
  }

  @Patch('units/:unitId')
  @RequirePermission(MANAGE)
  async updateUnit(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Body(new ZodValidationPipe(updateUnitSchema)) body: UpdateUnitInput,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return toUnit(await this.structure.updateUnit(access, unitId, body, requestMeta(req)));
  }

  @Post('units/:unitId/archive')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  async archiveUnit(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return toUnit(await this.structure.archiveUnit(access, unitId, requestMeta(req)));
  }

  // ------------------------------------------------------------------ common areas

  @Get('common-areas')
  @RequirePermission(READ)
  async listCommonAreas(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(structureListSchema)) query: StructureListQuery,
    @Req() req: Request,
  ): Promise<Paginated<CommonAreaDto>> {
    return page(
      await this.structure.listCommonAreas(access, query, requestMeta(req)),
      toCommonArea,
    );
  }

  @Post('common-areas')
  @RequirePermission(MANAGE)
  async createCommonArea(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createCommonAreaSchema)) body: CreateCommonAreaInput,
    @Req() req: Request,
  ): Promise<CommonAreaDto> {
    return toCommonArea(await this.structure.createCommonArea(access, body, requestMeta(req)));
  }

  @Patch('common-areas/:commonAreaId')
  @RequirePermission(MANAGE)
  async updateCommonArea(
    @CurrentAccess() access: OrganisationAccess,
    @Param('commonAreaId', uuid) commonAreaId: string,
    @Body(new ZodValidationPipe(updateCommonAreaSchema)) body: UpdateCommonAreaInput,
    @Req() req: Request,
  ): Promise<CommonAreaDto> {
    return toCommonArea(
      await this.structure.updateCommonArea(access, commonAreaId, body, requestMeta(req)),
    );
  }

  @Post('common-areas/:commonAreaId/archive')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  async archiveCommonArea(
    @CurrentAccess() access: OrganisationAccess,
    @Param('commonAreaId', uuid) commonAreaId: string,
    @Req() req: Request,
  ): Promise<CommonAreaDto> {
    return toCommonArea(
      await this.structure.archiveCommonArea(access, commonAreaId, requestMeta(req)),
    );
  }
}
