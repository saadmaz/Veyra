import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MyUnitDto, UnitDetailResponse, UnitResidentsResponse } from '@veyra/api-contracts';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { ResidentsService } from '../application/residents.service';

@ApiTags('residents')
@Controller('organisations/:organisationId')
export class ResidentsController {
  constructor(private readonly residents: ResidentsService) {}

  @Get('my-units')
  @RequirePermission('organisation.profile.read')
  @ApiOperation({
    summary: 'Units on which the caller is owner, tenant or household member today.',
  })
  async myUnits(@CurrentAccess() access: OrganisationAccess): Promise<{ data: MyUnitDto[] }> {
    const units = await this.residents.myUnits(access);
    return {
      data: units.map((u) => ({
        unitId: u.unitId,
        unitNumber: u.unitNumber,
        unitType: u.unitType,
        propertyId: u.propertyId,
        propertyName: u.propertyName,
        buildingName: u.buildingName,
        roles: u.roles,
      })),
    };
  }

  @Get('properties/:propertyId/units/:unitId')
  @RequirePermission('unit.profile.read')
  @ApiOperation({ summary: 'One unit, for its residents and for staff covering it.' })
  async unit(@CurrentAccess() access: OrganisationAccess): Promise<UnitDetailResponse> {
    const unit = await this.residents.unit(access);
    return { ...unit, permissions: [...access.permissions].sort() };
  }

  @Get('properties/:propertyId/units/:unitId/residents')
  @RequirePermission('unit.residents.read')
  @ApiOperation({ summary: 'Current owners, tenants and household members (names only).' })
  residentsOf(@CurrentAccess() access: OrganisationAccess): Promise<UnitResidentsResponse> {
    return this.residents.residents(access);
  }
}
