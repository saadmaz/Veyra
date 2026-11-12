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
  DepartmentDto,
  MyShiftDetailDto,
  ShiftDto,
  StaffPersonDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { StaffService } from '../application/staff.service';
import type { DepartmentRecord, ShiftRecord } from '../application/staff-ports';
import {
  type CreateShiftInput,
  createShiftSchema,
  departmentSchema,
  handoverSchema,
  memberSchema,
  type RescheduleInput,
  reasonSchema,
  rescheduleSchema,
  type ShiftListQuery,
  shiftListQuerySchema,
} from '../domain/staff-rules';

const uuid = new ParseUUIDPipe();
const S = 'properties/:propertyId/staff';
const MY = 'properties/:propertyId/my-shifts';

const toDepartment = (d: DepartmentRecord): DepartmentDto => ({
  id: d.id,
  name: d.name,
  status: d.status,
  archivedAt: d.archivedAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
  members: d.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    addedAt: m.addedAt.toISOString(),
  })),
});

const toShift = (s: ShiftRecord): ShiftDto => ({
  id: s.id,
  department: { id: s.departmentId, name: s.departmentName },
  person: { userId: s.userId, name: s.userName },
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  status: s.status,
  startedAt: s.startedAt?.toISOString() ?? null,
  endedAt: s.endedAt?.toISOString() ?? null,
  handoverNote: s.handoverNote,
  cancelReason: s.cancelReason,
  createdAt: s.createdAt.toISOString(),
});

const toMine = (d: {
  shift: ShiftRecord;
  previousHandover: ShiftRecord | null;
}): MyShiftDetailDto => ({
  shift: toShift(d.shift),
  previousHandover: d.previousHandover
    ? {
        note: d.previousHandover.handoverNote ?? '',
        by: d.previousHandover.userName,
        endedAt: d.previousHandover.endedAt?.toISOString() ?? '',
      }
    : null,
});

/** Departments, members and shifts for supervisors; one's own shifts for staff. */
@ApiTags('staff')
@Controller('organisations/:organisationId')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get(`${S}/departments`)
  @RequirePermission('property.staff.read')
  @ApiOperation({ summary: 'Departments with their current members (archived included).' })
  async departments(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: DepartmentDto[] }> {
    return { data: (await this.staff.departments(access, requestMeta(req))).map(toDepartment) };
  }

  @Post(`${S}/departments`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Add a department.' })
  async createDepartment(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(departmentSchema)) body: z.infer<typeof departmentSchema>,
    @Req() req: Request,
  ): Promise<DepartmentDto> {
    return toDepartment(await this.staff.createDepartment(access, body.name, requestMeta(req)));
  }

  @Patch(`${S}/departments/:departmentId`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Rename a department.' })
  async rename(
    @CurrentAccess() access: OrganisationAccess,
    @Param('departmentId', uuid) id: string,
    @Body(new ZodValidationPipe(departmentSchema)) body: z.infer<typeof departmentSchema>,
    @Req() req: Request,
  ): Promise<DepartmentDto> {
    return toDepartment(await this.staff.renameDepartment(access, id, body.name, requestMeta(req)));
  }

  @Post(`${S}/departments/:departmentId/archive`)
  @HttpCode(200)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Archive (final; no live shifts allowed).' })
  async archive(
    @CurrentAccess() access: OrganisationAccess,
    @Param('departmentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<DepartmentDto> {
    return toDepartment(await this.staff.archiveDepartment(access, id, requestMeta(req)));
  }

  @Get(`${S}/people`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'People who can work shifts at this property.' })
  async people(@CurrentAccess() access: OrganisationAccess): Promise<{ data: StaffPersonDto[] }> {
    const rows = await this.staff.people(access);
    return { data: rows.map((r) => ({ userId: r.userId, name: r.displayName })) };
  }

  @Post(`${S}/departments/:departmentId/members`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Add someone who works at the property to the department.' })
  async addMember(
    @CurrentAccess() access: OrganisationAccess,
    @Param('departmentId', uuid) id: string,
    @Body(new ZodValidationPipe(memberSchema)) body: z.infer<typeof memberSchema>,
    @Req() req: Request,
  ): Promise<DepartmentDto> {
    return toDepartment(await this.staff.addMember(access, id, body.userId, requestMeta(req)));
  }

  @Post(`${S}/departments/:departmentId/members/:userId/remove`)
  @HttpCode(200)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Take someone out of the department (no live shifts allowed).' })
  async removeMember(
    @CurrentAccess() access: OrganisationAccess,
    @Param('departmentId', uuid) id: string,
    @Param('userId', uuid) userId: string,
    @Req() req: Request,
  ): Promise<DepartmentDto> {
    return toDepartment(await this.staff.removeMember(access, id, userId, requestMeta(req)));
  }

  @Get(`${S}/departments/:departmentId/handovers`)
  @RequirePermission('property.staff.read')
  @ApiOperation({ summary: 'The latest handover notes of a department.' })
  async handovers(
    @CurrentAccess() access: OrganisationAccess,
    @Param('departmentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<{ data: ShiftDto[] }> {
    return { data: (await this.staff.handovers(access, id, requestMeta(req))).map(toShift) };
  }

  @Get(`${S}/shifts`)
  @RequirePermission('property.staff.read')
  @ApiOperation({ summary: 'Shifts overlapping a period, earliest first (at most 500).' })
  async shifts(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(shiftListQuerySchema)) query: ShiftListQuery,
    @Req() req: Request,
  ): Promise<{ data: ShiftDto[] }> {
    return { data: (await this.staff.shifts(access, query, requestMeta(req))).map(toShift) };
  }

  @Post(`${S}/shifts`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Schedule a shift for a member of a department.' })
  async createShift(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createShiftSchema)) body: CreateShiftInput,
    @Req() req: Request,
  ): Promise<ShiftDto> {
    return toShift(await this.staff.createShift(access, body, requestMeta(req)));
  }

  @Patch(`${S}/shifts/:shiftId`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Move a shift that has not started.' })
  async reschedule(
    @CurrentAccess() access: OrganisationAccess,
    @Param('shiftId', uuid) id: string,
    @Body(new ZodValidationPipe(rescheduleSchema)) body: RescheduleInput,
    @Req() req: Request,
  ): Promise<ShiftDto> {
    return toShift(await this.staff.reschedule(access, id, body, requestMeta(req)));
  }

  @Post(`${S}/shifts/:shiftId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Call off a shift that has not started, saying why.' })
  async cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('shiftId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<ShiftDto> {
    return toShift(await this.staff.cancel(access, id, body.reason, requestMeta(req)));
  }

  // ------------------------------------------------------------------ my shifts

  @Get(MY)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'Your shifts from a week ago onwards.' })
  async mine(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: ShiftDto[] }> {
    return { data: (await this.staff.myShifts(access, requestMeta(req))).map(toShift) };
  }

  @Get(`${MY}/:shiftId`)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'Your shift with the last handover of the department before it.' })
  async myShift(
    @CurrentAccess() access: OrganisationAccess,
    @Param('shiftId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MyShiftDetailDto> {
    return toMine(await this.staff.myShift(access, id, requestMeta(req)));
  }

  @Post(`${MY}/:shiftId/start`)
  @HttpCode(200)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'Start your shift (from an hour before).' })
  async start(
    @CurrentAccess() access: OrganisationAccess,
    @Param('shiftId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MyShiftDetailDto> {
    return toMine(await this.staff.start(access, id, requestMeta(req)));
  }

  @Post(`${MY}/:shiftId/end`)
  @HttpCode(200)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'End your shift with a handover note for the next one.' })
  async end(
    @CurrentAccess() access: OrganisationAccess,
    @Param('shiftId', uuid) id: string,
    @Body(new ZodValidationPipe(handoverSchema)) body: z.infer<typeof handoverSchema>,
    @Req() req: Request,
  ): Promise<MyShiftDetailDto> {
    return toMine(await this.staff.end(access, id, body.handoverNote, requestMeta(req)));
  }
}
