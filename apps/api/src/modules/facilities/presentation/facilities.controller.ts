import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  FacilityAvailabilityDto,
  FacilityBookingDetailDto,
  FacilityBookingDto,
  FacilityDetailDto,
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
  type BookingListQuery,
  bookingListQuerySchema,
  type ClosureInput,
  type CreateFacilityInput,
  closureSchema,
  createFacilitySchema,
  openingHoursSchema,
  optionalReasonSchema,
  reasonSchema,
  type UpdateFacilityInput,
  updateFacilitySchema,
} from '../domain/facility-rules';
import {
  toAvailability,
  toBooking,
  toBookingDetail,
  toFacility,
  toFacilityDetail,
} from './facilities-dto';

const uuid = new ParseUUIDPipe();
const F = 'properties/:propertyId/facilities';
const B = 'properties/:propertyId/facility-bookings';

/**
 * A property's facilities and bookings for staff: setup, opening hours and closures
 * (property.facility.manage), availability and every booking (property.facility.read), and
 * decisions on bookings (property.facility.manage). Staff book for a unit through the unit's
 * routes.
 */
@ApiTags('facilities')
@Controller('organisations/:organisationId')
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Get(F)
  @RequirePermission('property.facility.read')
  @ApiOperation({ summary: "The property's facilities, archived ones included." })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: FacilityDto[] }> {
    const { facilities, timeZone } = await this.facilities.list(access, requestMeta(req));
    return { data: facilities.map((f) => toFacility(f, timeZone)) };
  }

  @Post(F)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Make a common area bookable.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createFacilitySchema)) body: CreateFacilityInput,
    @Req() req: Request,
  ): Promise<FacilityDetailDto> {
    return toFacilityDetail(await this.facilities.create(access, body, requestMeta(req)));
  }

  @Get(`${F}/:facilityId`)
  @RequirePermission('property.facility.read')
  @ApiOperation({ summary: 'A facility with its current and coming closures.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Req() req: Request,
  ): Promise<FacilityDetailDto> {
    return toFacilityDetail(await this.facilities.detail(access, id, requestMeta(req)));
  }

  @Patch(`${F}/:facilityId`)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: "Change a facility's settings (bookings already made stay)." })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Body(new ZodValidationPipe(updateFacilitySchema)) body: UpdateFacilityInput,
    @Req() req: Request,
  ): Promise<FacilityDetailDto> {
    return toFacilityDetail(await this.facilities.update(access, id, body, requestMeta(req)));
  }

  @Put(`${F}/:facilityId/opening-hours`)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Replace the weekly opening hours (bookings already made stay).' })
  async hours(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Body(new ZodValidationPipe(openingHoursSchema)) body: z.infer<typeof openingHoursSchema>,
    @Req() req: Request,
  ): Promise<FacilityDetailDto> {
    return toFacilityDetail(
      await this.facilities.replaceHours(access, id, body.openingHours, requestMeta(req)),
    );
  }

  @Post(`${F}/:facilityId/archive`)
  @HttpCode(200)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Stop taking bookings for good (nothing upcoming may be booked).' })
  async archive(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Req() req: Request,
  ): Promise<FacilityDetailDto> {
    return toFacilityDetail(await this.facilities.archive(access, id, requestMeta(req)));
  }

  @Post(`${F}/:facilityId/closures`)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Close a facility for a period, optionally cancelling bookings in it.' })
  async close(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Body(new ZodValidationPipe(closureSchema)) body: ClosureInput,
    @Req() req: Request,
  ): Promise<FacilityDetailDto> {
    return toFacilityDetail(await this.facilities.addClosure(access, id, body, requestMeta(req)));
  }

  @Post(`${F}/:facilityId/closures/:closureId/lift`)
  @HttpCode(200)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Lift a closure.' })
  async lift(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Param('closureId', uuid) closureId: string,
    @Req() req: Request,
  ): Promise<FacilityDetailDto> {
    return toFacilityDetail(
      await this.facilities.liftClosure(access, id, closureId, requestMeta(req)),
    );
  }

  @Get(`${F}/:facilityId/availability`)
  @RequirePermission('property.facility.read')
  @ApiOperation({ summary: "A local day's slots with the places left." })
  async availability(
    @CurrentAccess() access: OrganisationAccess,
    @Param('facilityId', uuid) id: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema))
    query: z.infer<typeof availabilityQuerySchema>,
    @Req() req: Request,
  ): Promise<FacilityAvailabilityDto> {
    return toAvailability(
      await this.facilities.availability(access, id, query.date, requestMeta(req)),
    );
  }

  // ------------------------------------------------------------------ bookings

  @Get(B)
  @RequirePermission('property.facility.read')
  @ApiOperation({ summary: 'Bookings, latest start first (at most 500).' })
  async bookings(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(bookingListQuerySchema)) query: BookingListQuery,
    @Req() req: Request,
  ): Promise<{ data: FacilityBookingDto[] }> {
    const rows = await this.facilities.bookings(access, query, requestMeta(req));
    return { data: rows.map((b) => toBooking(b)) };
  }

  @Get(`${B}/:bookingId`)
  @RequirePermission('property.facility.read')
  @ApiOperation({ summary: 'A booking with its history.' })
  async booking(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return toBookingDetail(await this.facilities.bookingDetail(access, id, requestMeta(req)));
  }

  @Post(`${B}/:bookingId/approve`)
  @HttpCode(200)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Approve a pending booking.' })
  approve(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return this.decide(access, id, 'CONFIRMED', undefined, req);
  }

  @Post(`${B}/:bookingId/reject`)
  @HttpCode(200)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Reject a pending booking, saying why.' })
  reject(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return this.decide(access, id, 'REJECTED', body.reason, req);
  }

  @Post(`${B}/:bookingId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'Cancel a booking at any time (a reason once confirmed).' })
  cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Body(new ZodValidationPipe(optionalReasonSchema)) body: z.infer<typeof optionalReasonSchema>,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return this.decide(access, id, 'CANCELLED', body.reason, req);
  }

  @Post(`${B}/:bookingId/complete`)
  @HttpCode(200)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'The booking was used.' })
  complete(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return this.decide(access, id, 'COMPLETED', undefined, req);
  }

  @Post(`${B}/:bookingId/no-show`)
  @HttpCode(200)
  @RequirePermission('property.facility.manage')
  @ApiOperation({ summary: 'The booking was not used.' })
  noShow(
    @CurrentAccess() access: OrganisationAccess,
    @Param('bookingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return this.decide(access, id, 'NO_SHOW', undefined, req);
  }

  private async decide(
    access: OrganisationAccess,
    id: string,
    to: 'CONFIRMED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW',
    reason: string | undefined,
    req: Request,
  ): Promise<FacilityBookingDetailDto> {
    return toBookingDetail(await this.facilities.decide(access, id, to, reason, requestMeta(req)));
  }
}
