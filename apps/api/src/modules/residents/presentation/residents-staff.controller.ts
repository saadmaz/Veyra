import {
  Body,
  Controller,
  Delete,
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
  EmergencyContactDto,
  HouseholdMemberDto,
  OwnershipDto,
  Paginated,
  PersonDetailResponse,
  PersonDto,
  PropertyResidentDto,
  TenancyDto,
  VehicleDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { ResidentsStaffService } from '../application/residents-staff.service';
import type {
  HouseholdRecord,
  OwnershipRecord,
  PersonRecord,
  TenancyRecord,
} from '../application/staff-ports';
import {
  type AddEmergencyContactInput,
  type AddHouseholdMemberInput,
  type AddVehicleInput,
  addEmergencyContactSchema,
  addHouseholdMemberSchema,
  addVehicleSchema,
  type CreatePersonInput,
  type CreateTenancyInput,
  createPersonSchema,
  createTenancySchema,
  endPeriodSchema,
  personSearchSchema,
  type SetOwnersInput,
  setOwnersSchema,
  type UpdatePersonInput,
  updatePersonSchema,
  voidOwnershipsSchema,
  voidSchema,
} from '../domain/resident-rules';

const uuid = new ParseUUIDPipe();
const vehicleListSchema = z.object({ status: z.enum(['ACTIVE', 'ARCHIVED']).default('ACTIVE') });

const toPerson = (p: PersonRecord): PersonDto => ({
  id: p.id,
  fullName: p.fullName,
  email: p.email,
  phone: p.phone,
  preferredLanguage: p.preferredLanguage,
  status: p.status,
  linked: p.linked,
  createdAt: p.createdAt.toISOString(),
});
const toOwnership = (o: OwnershipRecord): OwnershipDto => ({
  ...o,
  voidedAt: o.voidedAt?.toISOString() ?? null,
});
const toTenancy = (t: TenancyRecord): TenancyDto => ({
  ...t,
  voidedAt: t.voidedAt?.toISOString() ?? null,
});
const toHousehold = (h: HouseholdRecord): HouseholdMemberDto => ({
  ...h,
  voidedAt: h.voidedAt?.toISOString() ?? null,
});
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Record vanished inside its own transaction');
  return value;
};

const READ = 'property.resident.read' as const;
const MANAGE = 'property.resident.manage' as const;

/**
 * Staff management of residents. Property routes need property.resident.read / .manage at that
 * property (organisation admins and property managers); the organisation directory needs
 * organisation.resident.read (admins). Every change is audited.
 */
@ApiTags('residents (staff)')
@Controller('organisations/:organisationId')
export class ResidentsStaffController {
  constructor(private readonly staff: ResidentsStaffService) {}

  // ------------------------------------------------------------------ organisation directory

  @Get('persons')
  @RequirePermission('organisation.resident.read')
  @ApiOperation({ summary: 'Search all resident profiles of the organisation by name or email.' })
  async search(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(personSearchSchema)) query: z.infer<typeof personSearchSchema>,
  ): Promise<Paginated<PersonDto>> {
    const page = await this.staff.searchPersons(access, query.query, query);
    return { data: page.data.map(toPerson), nextCursor: page.nextCursor };
  }

  @Get('persons/:personId')
  @RequirePermission('organisation.resident.read')
  async personInOrganisation(
    @CurrentAccess() access: OrganisationAccess,
    @Param('personId', uuid) personId: string,
    @Req() req: Request,
  ): Promise<{ person: PersonDto; emergencyContacts: EmergencyContactDto[] }> {
    const result = await this.staff.personInOrganisation(access, personId, requestMeta(req));
    return { person: toPerson(result.person), emergencyContacts: result.emergencyContacts };
  }

  // ------------------------------------------------------------------ people of a property

  @Post('properties/:propertyId/persons')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Create a resident profile (name, email, phone, language only).' })
  async createPerson(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createPersonSchema)) body: CreatePersonInput,
    @Req() req: Request,
  ): Promise<PersonDto> {
    return toPerson(await this.staff.createPerson(access, body, requestMeta(req)));
  }

  @Get('properties/:propertyId/persons')
  @RequirePermission(READ)
  @ApiOperation({
    summary:
      'People staff can pick for this property: related to it, or not yet attached anywhere.',
  })
  async selectablePersons(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(personSearchSchema)) query: z.infer<typeof personSearchSchema>,
    @Req() req: Request,
  ): Promise<{ data: PersonDto[] }> {
    const people = await this.staff.listSelectablePersons(access, query.query, requestMeta(req));
    return { data: people.map(toPerson) };
  }

  @Get('properties/:propertyId/residents')
  @RequirePermission(READ)
  @ApiOperation({ summary: 'Current residents of the property with their units and roles.' })
  async residents(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: PropertyResidentDto[] }> {
    const rows = await this.staff.listPropertyResidents(access, requestMeta(req));
    return { data: rows.map((r) => ({ person: toPerson(r.person), units: r.units })) };
  }

  @Get('properties/:propertyId/persons/:personId')
  @RequirePermission(READ)
  async person(
    @CurrentAccess() access: OrganisationAccess,
    @Param('personId', uuid) personId: string,
    @Req() req: Request,
  ): Promise<PersonDetailResponse> {
    const r = await this.staff.personInProperty(access, personId, requestMeta(req));
    return {
      person: toPerson(r.person),
      ownerships: r.ownerships.map(toOwnership),
      tenancies: r.tenancies.map(toTenancy),
      household: r.household.map(toHousehold),
      emergencyContacts: r.emergencyContacts,
    };
  }

  @Patch('properties/:propertyId/persons/:personId')
  @RequirePermission(MANAGE)
  async updatePerson(
    @CurrentAccess() access: OrganisationAccess,
    @Param('personId', uuid) personId: string,
    @Body(new ZodValidationPipe(updatePersonSchema)) body: UpdatePersonInput,
    @Req() req: Request,
  ): Promise<PersonDto> {
    return toPerson(await this.staff.updatePerson(access, personId, body, requestMeta(req)));
  }

  @Post('properties/:propertyId/persons/:personId/emergency-contacts')
  @RequirePermission(MANAGE)
  addEmergencyContact(
    @CurrentAccess() access: OrganisationAccess,
    @Param('personId', uuid) personId: string,
    @Body(new ZodValidationPipe(addEmergencyContactSchema)) body: AddEmergencyContactInput,
    @Req() req: Request,
  ): Promise<EmergencyContactDto> {
    return this.staff.addEmergencyContact(access, personId, body, requestMeta(req));
  }

  @Delete('properties/:propertyId/persons/:personId/emergency-contacts/:contactId')
  @HttpCode(204)
  @RequirePermission(MANAGE)
  async removeEmergencyContact(
    @CurrentAccess() access: OrganisationAccess,
    @Param('personId', uuid) personId: string,
    @Param('contactId', uuid) contactId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.staff.removeEmergencyContact(access, personId, contactId, requestMeta(req));
  }

  // ------------------------------------------------------------------ ownership

  @Get('properties/:propertyId/units/:unitId/ownerships')
  @RequirePermission(READ)
  @ApiOperation({
    summary: 'Full ownership history of a unit, including ended and voided records.',
  })
  async ownerships(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Req() req: Request,
  ): Promise<{ data: OwnershipDto[] }> {
    return {
      data: (await this.staff.listOwnerships(access, unitId, requestMeta(req))).map(toOwnership),
    };
  }

  @Post('properties/:propertyId/units/:unitId/owners')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  @ApiOperation({
    summary:
      'Set the owners from a date (first owner or transfer). Shares are exact fractions summing to one.',
  })
  async setOwners(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Body(new ZodValidationPipe(setOwnersSchema)) body: SetOwnersInput,
    @Req() req: Request,
  ): Promise<{ data: OwnershipDto[] }> {
    return {
      data: (await this.staff.setOwners(access, unitId, body, requestMeta(req))).map(toOwnership),
    };
  }

  @Post('properties/:propertyId/units/:unitId/ownerships/void')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  async voidOwnerships(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Body(new ZodValidationPipe(voidOwnershipsSchema)) body: z.infer<typeof voidOwnershipsSchema>,
    @Req() req: Request,
  ): Promise<{ data: OwnershipDto[] }> {
    const rows = await this.staff.voidOwnerships(
      access,
      unitId,
      body.ownershipIds,
      body.reason,
      requestMeta(req),
    );
    return { data: rows.map(toOwnership) };
  }

  // ------------------------------------------------------------------ tenancies

  @Get('properties/:propertyId/units/:unitId/tenancies')
  @RequirePermission(READ)
  async tenancies(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Req() req: Request,
  ): Promise<{ data: TenancyDto[] }> {
    return {
      data: (await this.staff.listTenancies(access, unitId, requestMeta(req))).map(toTenancy),
    };
  }

  @Post('properties/:propertyId/units/:unitId/tenancies')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Move-in: start a tenancy with its tenants (exactly one primary).' })
  async createTenancy(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Body(new ZodValidationPipe(createTenancySchema)) body: CreateTenancyInput,
    @Req() req: Request,
  ): Promise<TenancyDto> {
    return toTenancy(
      required(await this.staff.createTenancy(access, unitId, body, requestMeta(req))),
    );
  }

  @Post('properties/:propertyId/units/:unitId/tenancies/:tenancyId/end')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Move-out: set the last day of the tenancy.' })
  async endTenancy(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Param('tenancyId', uuid) tenancyId: string,
    @Body(new ZodValidationPipe(endPeriodSchema)) body: { endDate: string },
    @Req() req: Request,
  ): Promise<TenancyDto> {
    return toTenancy(
      required(
        await this.staff.endTenancy(access, unitId, tenancyId, body.endDate, requestMeta(req)),
      ),
    );
  }

  @Post('properties/:propertyId/units/:unitId/tenancies/:tenancyId/void')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  async voidTenancy(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Param('tenancyId', uuid) tenancyId: string,
    @Body(new ZodValidationPipe(voidSchema)) body: { reason: string },
    @Req() req: Request,
  ): Promise<TenancyDto> {
    return toTenancy(
      required(
        await this.staff.voidTenancy(access, unitId, tenancyId, body.reason, requestMeta(req)),
      ),
    );
  }

  // ------------------------------------------------------------------ household

  @Get('properties/:propertyId/units/:unitId/household')
  @RequirePermission(READ)
  async household(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Req() req: Request,
  ): Promise<{ data: HouseholdMemberDto[] }> {
    return {
      data: (await this.staff.listHousehold(access, unitId, requestMeta(req))).map(toHousehold),
    };
  }

  @Post('properties/:propertyId/units/:unitId/household')
  @RequirePermission(MANAGE)
  async addHouseholdMember(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Body(new ZodValidationPipe(addHouseholdMemberSchema)) body: AddHouseholdMemberInput,
    @Req() req: Request,
  ): Promise<HouseholdMemberDto> {
    return toHousehold(
      required(await this.staff.addHouseholdMember(access, unitId, body, requestMeta(req))),
    );
  }

  @Post('properties/:propertyId/units/:unitId/household/:memberId/end')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  async endHouseholdMember(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Param('memberId', uuid) memberId: string,
    @Body(new ZodValidationPipe(endPeriodSchema)) body: { endDate: string },
    @Req() req: Request,
  ): Promise<HouseholdMemberDto> {
    return toHousehold(
      required(
        await this.staff.endHouseholdMember(
          access,
          unitId,
          memberId,
          body.endDate,
          requestMeta(req),
        ),
      ),
    );
  }

  @Post('properties/:propertyId/units/:unitId/household/:memberId/void')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  async voidHouseholdMember(
    @CurrentAccess() access: OrganisationAccess,
    @Param('unitId', uuid) unitId: string,
    @Param('memberId', uuid) memberId: string,
    @Req() req: Request,
  ): Promise<HouseholdMemberDto> {
    return toHousehold(
      required(await this.staff.voidHouseholdMember(access, unitId, memberId, requestMeta(req))),
    );
  }

  // ------------------------------------------------------------------ vehicles

  @Get('properties/:propertyId/vehicles')
  @RequirePermission(READ)
  async vehicles(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(vehicleListSchema)) query: z.infer<typeof vehicleListSchema>,
    @Req() req: Request,
  ): Promise<{ data: VehicleDto[] }> {
    return { data: await this.staff.listVehicles(access, query.status, requestMeta(req)) };
  }

  @Post('properties/:propertyId/vehicles')
  @RequirePermission(MANAGE)
  addVehicle(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(addVehicleSchema)) body: AddVehicleInput,
    @Req() req: Request,
  ): Promise<VehicleDto> {
    return this.staff.addVehicle(access, body, requestMeta(req));
  }

  @Post('properties/:propertyId/vehicles/:vehicleId/archive')
  @HttpCode(200)
  @RequirePermission(MANAGE)
  archiveVehicle(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vehicleId', uuid) vehicleId: string,
    @Req() req: Request,
  ): Promise<VehicleDto> {
    return this.staff.archiveVehicle(access, vehicleId, requestMeta(req));
  }
}
