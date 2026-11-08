import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Paginated, PropertyDetailResponse, PropertyDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import { requestMeta } from '../../../platform/request-meta';
import { type ListQuery, listQuerySchema } from '../../../platform/validation/common-schemas';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { PropertyRecord } from '../application/ports';
import { PropertiesService } from '../application/properties.service';
import { type CreatePropertyInput, createPropertySchema } from '../domain/property-rules';

function toPropertyDto(property: PropertyRecord): PropertyDto {
  return {
    id: property.id,
    name: property.name,
    code: property.code,
    type: property.type,
    status: property.status,
    addressLine1: property.addressLine1,
    addressLine2: property.addressLine2,
    city: property.city,
    region: property.region,
    postalCode: property.postalCode,
    countryCode: property.countryCode,
    timeZone: property.timeZone,
    currency: property.currency,
    createdAt: property.createdAt.toISOString(),
  };
}

@ApiTags('properties')
@Controller('organisations/:organisationId/properties')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Post()
  @RequirePermission('organisation.property.create')
  @ApiOperation({
    summary: 'Add a property. Country, time zone and currency default to the organisation.',
  })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createPropertySchema)) body: CreatePropertyInput,
    @Req() req: Request,
  ): Promise<PropertyDto> {
    return toPropertyDto(await this.properties.create(access, body, requestMeta(req)));
  }

  @Get()
  @RequirePermission('organisation.profile.read')
  @ApiOperation({ summary: 'Properties the caller may see (all, or only their assigned ones).' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
  ): Promise<Paginated<PropertyDto>> {
    const page = await this.properties.list(access, query);
    return { data: page.data.map(toPropertyDto), nextCursor: page.nextCursor };
  }

  @Get(':propertyId')
  @RequirePermission('property.profile.read')
  @ApiOperation({ summary: 'One property and the permissions the caller holds on it.' })
  async get(@CurrentAccess() access: OrganisationAccess): Promise<PropertyDetailResponse> {
    const property = await this.properties.get(access);
    return { ...toPropertyDto(property), permissions: [...access.permissions].sort() };
  }
}
