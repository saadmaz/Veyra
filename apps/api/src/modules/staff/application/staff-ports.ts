import type { RequestMeta } from '../../../platform/request-meta';
import type { ShiftStatus } from '../domain/staff-rules';

export interface DepartmentRecord {
  id: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
  archivedAt: Date | null;
  createdAt: Date;
  /** Current members. */
  members: { userId: string; name: string; addedAt: Date }[];
}

export interface ShiftRecord {
  id: string;
  departmentId: string;
  departmentName: string;
  userId: string;
  userName: string;
  startsAt: Date;
  endsAt: Date;
  status: ShiftStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  handoverNote: string | null;
  cancelReason: string | null;
  createdAt: Date;
}

export interface ShiftFilter {
  from?: Date;
  to?: Date;
  departmentId?: string;
  userId?: string;
  status?: ShiftStatus;
}

/** One transaction in the organisation's RLS context, limited to one property. */
export interface StaffUnitOfWork {
  departments(includeArchived: boolean): Promise<DepartmentRecord[]>;
  department(id: string): Promise<DepartmentRecord | null>;
  nameTaken(name: string, exceptId?: string): Promise<boolean>;
  createDepartment(name: string): Promise<string>;
  updateDepartment(id: string, patch: { name?: string; status?: 'ARCHIVED' }): Promise<void>;
  addMember(departmentId: string, userId: string): Promise<void>;
  removeMember(departmentId: string, userId: string): Promise<boolean>;
  shifts(filter: ShiftFilter, limit: number, order: 'asc' | 'desc'): Promise<ShiftRecord[]>;
  shift(id: string): Promise<ShiftRecord | null>;
  /** Whether the person has a scheduled or started shift overlapping these times. */
  overlaps(userId: string, startsAt: Date, endsAt: Date, exceptId?: string): Promise<boolean>;
  createShift(input: {
    departmentId: string;
    userId: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<string>;
  updateShift(
    id: string,
    patch: {
      startsAt?: Date;
      endsAt?: Date;
      status?: ShiftStatus;
      handoverNote?: string;
      cancelReason?: string;
    },
  ): Promise<void>;
  audit(event: {
    action: string;
    resourceType: 'department' | 'shift';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface StaffRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: StaffUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const STAFF_REPOSITORY = Symbol('STAFF_REPOSITORY');
