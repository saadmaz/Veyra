import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  FacilityAvailabilityDto,
  FacilityBookingDetailDto,
  FacilityBookingDto,
  FacilityDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { FacilitiesService } from '../application/facilities.service';
import {
  availabilityQuerySchema,
  type BookingInput,
  bookingSchema,
  optionalReasonSchema,
} from '../domain/facility-rules';
import { toAvailability, toBooking, toBookingDetail, toFacility } from './facilities-dto';

const uuid = new ParseUUIDPipe();
const UNIT = 'properties/:propertyId/units/:unitId';

/**
 * Facilities as a unit's residents see them (unit.facility.book): the property's active
 * facilities and their availability, the unit's own bookings, booking and cancelling. Bookings of
 * other units are 404; who booked other slots is never shown.
 */
@ApiTags('facilities')
@Controller('organisations/:organisationId')
export class UnitFacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Get(`${UNIT}/facilities`)
  @RequirePermission('unit.facility.book')
  @ApiOperation({ summary: 'Facilities the unit can book.' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: FacilityDto[] }> {
    const { facilities, timeZone, currency } = await this.facilities.unitFacilities(
      access,
      requestMeta(req),
    );
    return { data: facilities.map((f) => toFacility(f, timeZone, currency)) };
  }

  @Get(`${UNIT}/facilities/:facilityId/availability`)
  @RequirePermission('unit.facility.book')
  @ApiOperation({ summary: "A local day's slots with the places left." })
  async availability(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema))
    query: z.infer<typeof availabilityQuerySchema>,
    @Req() req: Request,
  ): Promise<FacilityAvailabilityDto> {
    return toAvailability(
      await this.facilities.unitAvailability(access, id, query.date, requestMeta(req)),
    );
  }

  @Get(`${UNIT}/facility-bookings`)
  @RequirePermission('unit.facility.book')
  @ApiOperation({ summary: "The unit's bookings, latest start first (at most 200)." })
  async bookings(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: FacilityBookingDto[] }> {
    const rows = await this.facilities.unitBookings(access, requestMeta(req));
    return { data: rows.map((b) => toBooking(b)) };
  }

  @Post(`${UNIT}/facility-bookings`)
  @RequirePermission('unit.facility.book')
  @ApiOperation({ summary: 'Book consecutive slots of a facility for the unit.' })
  async book(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(bookingSchema)) body: BookingInput,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return toBookingDetail(await this.facilities.book(access, body, requestMeta(req)));
  }

  @Get(`${UNIT}/facility-bookings/:bookingId`)
  @RequirePermission('unit.facility.book')
  @ApiOperation({ summary: 'A booking of the unit with its history.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return toBookingDetail(await this.facilities.unitBookingDetail(access, id, requestMeta(req)));
  }

  @Post(`${UNIT}/facility-bookings/:bookingId/cancel`)
  @HttpCode(200)
  @RequirePermission('unit.facility.book')
  @ApiOperation({ summary: "Cancel before the facility's cancellation window." })
  async cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Body(new ZodValidationPipe(optionalReasonSchema)) body: z.infer<typeof optionalReasonSchema>,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return toBookingDetail(
      await this.facilities.unitCancel(access, id, body.reason, requestMeta(req)),
    );
  }
}
