import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  DepartmentRecord,
  ShiftFilter,
  ShiftRecord,
  StaffRepository,
  StaffUnitOfWork,
} from '../application/staff-ports';
import type { ShiftStatus } from '../domain/staff-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const DEPARTMENT_SELECT = {
  id: true,
  name: true,
  status: true,
  archivedAt: true,
  createdAt: true,
  members: {
    where: { removedAt: null },
    select: { userId: true, addedAt: true, user: { select: { displayName: true } } },
    orderBy: { addedAt: 'asc' as const },
  },
} as const;

const SHIFT_SELECT = {
  id: true,
  departmentId: true,
  userId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  startedAt: true,
  endedAt: true,
  handoverNote: true,
  cancelReason: true,
  createdAt: true,
  department: { select: { name: true } },
  user: { select: { displayName: true } },
} as const;

const toDepartment = (row: {
  id: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
  archivedAt: Date | null;
  createdAt: Date;
  members: { userId: string; addedAt: Date; user: { displayName: string } }[];
}): DepartmentRecord => ({
  id: row.id,
  name: row.name,
  status: row.status,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  members: row.members.map((m) => ({
    userId: m.userId,
    name: m.user.displayName,
    addedAt: m.addedAt,
  })),
});

const toShift = ({
  department,
  user,
  ...row
}: Omit<ShiftRecord, 'departmentName' | 'userName'> & {
  department: { name: string };
  user: { displayName: string };
}): ShiftRecord => ({ ...row, departmentName: department.name, userName: user.displayName });

class PrismaStaffUnitOfWork implements StaffUnitOfWork {
  private readonly scope: { organisationId: string; propertyId: string };

  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {
    this.scope = { organisationId, propertyId };
  }

  async departments(includeArchived: boolean) {
    const rows = await this.tx.department.findMany({
      where: { ...this.scope, ...(includeArchived ? {} : { status: 'ACTIVE' as const }) },
      select: DEPARTMENT_SELECT,
      orderBy: { name: 'asc' },
    });
    return rows.map(toDepartment);
  }

  async department(id: string) {
    const row = await this.tx.department.findFirst({
      where: { ...this.scope, id },
      select: DEPARTMENT_SELECT,
    });
    return row ? toDepartment(row) : null;
  }

  async nameTaken(name: string, exceptId?: string) {
    const count = await this.tx.department.count({
      where: {
        ...this.scope,
        status: 'ACTIVE',
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    return count > 0;
  }

  async createDepartment(name: string) {
    const { id } = await this.tx.department.create({
      data: { ...this.scope, name },
      select: { id: true },
    });
    return id;
  }

  async updateDepartment(id: string, patch: { name?: string; status?: 'ARCHIVED' }) {
    await this.tx.department.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  async addMember(departmentId: string, userId: string) {
    await this.tx.departmentMember.create({ data: { ...this.scope, departmentId, userId } });
  }

  async removeMember(departmentId: string, userId: string) {
    const { count } = await this.tx.departmentMember.updateMany({
      where: { ...this.scope, departmentId, userId, removedAt: null },
      data: { removedAt: new Date() },
    });
    return count > 0;
  }

  async shifts(filter: ShiftFilter, limit: number, order: 'asc' | 'desc') {
    const rows = await this.tx.shift.findMany({
      where: {
        ...this.scope,
        ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from ? { endsAt: { gt: filter.from } } : {}),
        ...(filter.to ? { startsAt: { lt: filter.to } } : {}),
      },
      select: SHIFT_SELECT,
      orderBy: [{ startsAt: order }],
      take: limit,
    });
    return rows.map(toShift);
  }

  async shift(id: string) {
    const row = await this.tx.shift.findFirst({
      where: { ...this.scope, id },
      select: SHIFT_SELECT,
    });
    return row ? toShift(row) : null;
  }

  async overlaps(userId: string, startsAt: Date, endsAt: Date, exceptId?: string) {
    const count = await this.tx.shift.count({
      where: {
        organisationId: this.organisationId,
        userId,
        status: { in: ['SCHEDULED', 'STARTED'] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    return count > 0;
  }

  async createShift(input: { departmentId: string; userId: string; startsAt: Date; endsAt: Date }) {
    const { id } = await this.tx.shift.create({
      data: { ...this.scope, ...input, createdByUserId: this.userId },
      select: { id: true },
    });
    return id;
  }

  async updateShift(
    id: string,
    patch: {
      startsAt?: Date;
      endsAt?: Date;
      status?: ShiftStatus;
      handoverNote?: string;
      cancelReason?: string;
    },
  ) {
    await this.tx.shift.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  async audit(event: {
    action: string;
    resourceType: 'department' | 'shift';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: { propertyId: this.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Staff persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaStaffRepository implements StaffRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: StaffUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaStaffUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}
