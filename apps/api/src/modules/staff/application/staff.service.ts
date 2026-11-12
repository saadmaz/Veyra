import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import {
  type CreateShiftInput,
  canStart,
  EARLY_START_MINUTES,
  type RescheduleInput,
  type ShiftListQuery,
} from '../domain/staff-rules';
import {
  type ShiftRecord,
  STAFF_REPOSITORY,
  type StaffRepository,
  type StaffUnitOfWork,
} from './staff-ports';

const departmentNotFound = () => new ApiError(404, 'NOT_FOUND', 'Department not found');
const shiftNotFound = () => new ApiError(404, 'NOT_FOUND', 'Shift not found');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);
const nameTaken = () => new ApiError(409, 'NAME_TAKEN', 'Another active department has this name');
const archived = () => new ApiError(409, 'ARCHIVED', 'This department is archived');

/**
 * Staff operations (Phase 9 Part 3). Supervisors and managers (property.staff.manage) keep the
 * property's departments and their members and schedule, move and cancel shifts; anyone with
 * property.staff.read sees them. Staff (property.staff.work) see their own shifts, start them
 * (from an hour before) and end them with a handover note, which the next shift of the
 * department reads.
 */
@Injectable()
export class StaffService {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repository: StaffRepository,
    private readonly accessControl: AccessControlService,
  ) {}

  // ------------------------------------------------------------------ departments

  departments(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, (uow) => uow.departments(true));
  }

  createDepartment(access: OrganisationAccess, name: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      if (await uow.nameTaken(name)) throw nameTaken();
      const id = await uow.createDepartment(name);
      await uow.audit({ action: 'department.created', resourceType: 'department', resourceId: id });
      return this.mustFindDepartment(uow, id);
    });
  }

  renameDepartment(access: OrganisationAccess, id: string, name: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const department = await this.mustFindDepartment(uow, id);
      if (department.status === 'ARCHIVED') throw archived();
      if (await uow.nameTaken(name, id)) throw nameTaken();
      await uow.updateDepartment(id, { name });
      await uow.audit({ action: 'department.renamed', resourceType: 'department', resourceId: id });
      return this.mustFindDepartment(uow, id);
    });
  }

  archiveDepartment(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const department = await this.mustFindDepartment(uow, id);
      if (department.status === 'ARCHIVED') throw archived();
      const live = await uow.shifts({ departmentId: id, from: new Date() }, 500, 'asc');
      if (live.some((s) => s.status === 'SCHEDULED' || s.status === 'STARTED')) {
        throw new ApiError(
          409,
          'SHIFTS_IN_THE_WAY',
          'Cancel or finish the shifts of this department before archiving it',
        );
      }
      await uow.updateDepartment(id, { status: 'ARCHIVED' });
      await uow.audit({
        action: 'department.archived',
        resourceType: 'department',
        resourceId: id,
      });
      return this.mustFindDepartment(uow, id);
    });
  }

  /** People who can work shifts at the property (hold property.staff.work there). */
  people(access: OrganisationAccess) {
    return this.accessControl.usersWithPropertyPermission(
      access.organisationId,
      this.propertyOf(access),
      'property.staff.work',
    );
  }

  addMember(access: OrganisationAccess, id: string, userId: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const department = await this.mustFindDepartment(uow, id);
      if (department.status === 'ARCHIVED') throw archived();
      if (department.members.some((m) => m.userId === userId)) {
        throw new ApiError(409, 'ALREADY_MEMBER', 'This person is already in the department');
      }
      await this.requireWorker(access, userId);
      await uow.addMember(id, userId);
      await uow.audit({
        action: 'department.member_added',
        resourceType: 'department',
        resourceId: id,
        metadata: { userId },
      });
      return this.mustFindDepartment(uow, id);
    });
  }

  removeMember(access: OrganisationAccess, id: string, userId: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      await this.mustFindDepartment(uow, id);
      const upcoming = await uow.shifts({ departmentId: id, userId, from: new Date() }, 50, 'asc');
      if (upcoming.some((s) => s.status === 'SCHEDULED' || s.status === 'STARTED')) {
        throw new ApiError(409, 'SHIFTS_IN_THE_WAY', 'Cancel or finish their shifts first');
      }
      if (!(await uow.removeMember(id, userId))) {
        throw new ApiError(404, 'NOT_FOUND', 'This person is not in the department');
      }
      await uow.audit({
        action: 'department.member_removed',
        resourceType: 'department',
        resourceId: id,
        metadata: { userId },
      });
      return this.mustFindDepartment(uow, id);
    });
  }

  // ------------------------------------------------------------------ shifts (supervisors)

  shifts(access: OrganisationAccess, query: ShiftListQuery, meta: RequestMeta) {
    return this.run(access, meta, (uow) =>
      uow.shifts(
        {
          ...(query.from ? { from: new Date(query.from) } : {}),
          ...(query.to ? { to: new Date(query.to) } : {}),
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          ...(query.userId ? { userId: query.userId } : {}),
        },
        500,
        'asc',
      ),
    );
  }

  createShift(access: OrganisationAccess, input: CreateShiftInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const department = await this.mustFindDepartment(uow, input.departmentId);
      if (department.status === 'ARCHIVED') throw archived();
      if (!department.members.some((m) => m.userId === input.userId)) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Add this person to the department first');
      }
      if (await uow.overlaps(input.userId, input.startsAt, input.endsAt)) throw overlapping();
      const id = await uow.createShift(input);
      await uow.audit({
        action: 'shift.scheduled',
        resourceType: 'shift',
        resourceId: id,
        metadata: { departmentId: input.departmentId, userId: input.userId },
      });
      return this.mustFindShift(uow, id);
    });
  }

  reschedule(access: OrganisationAccess, id: string, input: RescheduleInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const shift = await this.mustFindShift(uow, id);
      if (shift.status !== 'SCHEDULED')
        throw invalidState('A shift is moved only before it starts');
      if (await uow.overlaps(shift.userId, input.startsAt, input.endsAt, id)) throw overlapping();
      await uow.updateShift(id, { startsAt: input.startsAt, endsAt: input.endsAt });
      await uow.audit({ action: 'shift.rescheduled', resourceType: 'shift', resourceId: id });
      return this.mustFindShift(uow, id);
    });
  }

  cancel(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const shift = await this.mustFindShift(uow, id);
      if (shift.status !== 'SCHEDULED')
        throw invalidState('Only a shift that has not started can be cancelled');
      await uow.updateShift(id, { status: 'CANCELLED', cancelReason: reason });
      await uow.audit({ action: 'shift.cancelled', resourceType: 'shift', resourceId: id });
      return this.mustFindShift(uow, id);
    });
  }

  /** The latest handover notes of a department, newest first. */
  handovers(access: OrganisationAccess, departmentId: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      await this.mustFindDepartment(uow, departmentId);
      return uow.shifts({ departmentId, status: 'ENDED' }, 20, 'desc');
    });
  }

  // ------------------------------------------------------------------ my shifts (staff)

  /** The caller's shifts from a week ago onwards. */
  myShifts(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, (uow) =>
      uow.shifts(
        { userId: access.userId, from: new Date(Date.now() - 7 * 86_400_000) },
        200,
        'asc',
      ),
    );
  }

  /** One of the caller's shifts, with the latest handover of its department before it. */
  myShift(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.withHandover(uow, access, id));
  }

  start(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const shift = await this.mustFindOwnShift(uow, access, id);
      if (shift.status !== 'SCHEDULED')
        throw invalidState('This shift has already started or is over');
      if (!canStart(shift.startsAt, shift.endsAt, new Date())) {
        throw new ApiError(
          409,
          'NOT_YET',
          `A shift can be started from ${EARLY_START_MINUTES} minutes before it begins until it is due to end`,
        );
      }
      await uow.updateShift(id, { status: 'STARTED' });
      await uow.audit({ action: 'shift.started', resourceType: 'shift', resourceId: id });
      return this.withHandover(uow, access, id);
    });
  }

  end(access: OrganisationAccess, id: string, handoverNote: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const shift = await this.mustFindOwnShift(uow, access, id);
      if (shift.status !== 'STARTED') throw invalidState('Start the shift before ending it');
      await uow.updateShift(id, { status: 'ENDED', handoverNote });
      await uow.audit({ action: 'shift.ended', resourceType: 'shift', resourceId: id });
      return this.withHandover(uow, access, id);
    });
  }

  // ------------------------------------------------------------------ shared

  private async withHandover(uow: StaffUnitOfWork, access: OrganisationAccess, id: string) {
    const shift = await this.mustFindOwnShift(uow, access, id);
    const previous = (
      await uow.shifts(
        { departmentId: shift.departmentId, status: 'ENDED', to: shift.startsAt },
        20,
        'desc',
      )
    ).find((s) => s.id !== id && s.endedAt !== null && s.endedAt.getTime() <= Date.now());
    return { shift, previousHandover: previous ?? null };
  }

  private async mustFindDepartment(uow: StaffUnitOfWork, id: string) {
    const department = await uow.department(id);
    if (!department) throw departmentNotFound();
    return department;
  }

  private async mustFindShift(uow: StaffUnitOfWork, id: string): Promise<ShiftRecord> {
    const shift = await uow.shift(id);
    if (!shift) throw shiftNotFound();
    return shift;
  }

  /** Someone else's shift does not exist for the caller (404). */
  private async mustFindOwnShift(uow: StaffUnitOfWork, access: OrganisationAccess, id: string) {
    const shift = await uow.shift(id);
    if (!shift || shift.userId !== access.userId) throw shiftNotFound();
    return shift;
  }

  private async requireWorker(access: OrganisationAccess, userId: string) {
    const people = await this.people(access);
    if (!people.some((p) => p.userId === userId)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'This person does not work at this property');
    }
  }

  private propertyOf(access: OrganisationAccess) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: StaffUnitOfWork) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === '23505')
        throw new ApiError(
          409,
          'CONFLICT',
          'This changed at the same time elsewhere. Reload and try again.',
        );
      if (code === '23514')
        throw invalidState('This change is not possible any more. Reload and try again.');
      throw error;
    }
  }
}

const overlapping = () =>
  new ApiError(409, 'SHIFT_OVERLAP', 'This person already has a shift at that time');
