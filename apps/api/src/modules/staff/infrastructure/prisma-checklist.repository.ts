import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  ChecklistRepository,
  ChecklistUnitOfWork,
  RunRecord,
  TemplateRecord,
} from '../application/checklist-ports';
import type { ChecklistResult, ChecklistStatus } from '../domain/checklist-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const TEMPLATE_SELECT = {
  id: true,
  title: true,
  departmentId: true,
  items: true,
  status: true,
  createdAt: true,
  department: { select: { name: true } },
} as const;

const RUN_SELECT = {
  id: true,
  templateId: true,
  title: true,
  assignedToUserId: true,
  shiftId: true,
  dueOn: true,
  status: true,
  submittedAt: true,
  verifiedAt: true,
  statusNote: true,
  createdAt: true,
  assignedTo: { select: { displayName: true } },
  verifiedBy: { select: { displayName: true } },
  items: {
    select: { position: true, text: true, result: true, note: true, answeredAt: true },
    orderBy: { position: 'asc' as const },
  },
} as const;

const toTemplate = ({
  department,
  ...row
}: Omit<TemplateRecord, 'departmentName'> & {
  department: { name: string } | null;
}): TemplateRecord => ({
  ...row,
  departmentName: department?.name ?? null,
});

const toRun = ({
  assignedTo,
  verifiedBy,
  dueOn,
  ...row
}: Omit<RunRecord, 'assignedToName' | 'verifiedByName' | 'dueOn'> & {
  dueOn: Date;
  assignedTo: { displayName: string };
  verifiedBy: { displayName: string } | null;
}): RunRecord => ({
  ...row,
  dueOn: dueOn.toISOString().slice(0, 10),
  assignedToName: assignedTo.displayName,
  verifiedByName: verifiedBy?.displayName ?? null,
});

class PrismaChecklistUnitOfWork implements ChecklistUnitOfWork {
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

  async templates(includeArchived: boolean) {
    const rows = await this.tx.checklistTemplate.findMany({
      where: { ...this.scope, ...(includeArchived ? {} : { status: 'ACTIVE' as const }) },
      select: TEMPLATE_SELECT,
      orderBy: { title: 'asc' },
    });
    return rows.map(toTemplate);
  }

  async template(id: string) {
    const row = await this.tx.checklistTemplate.findFirst({
      where: { ...this.scope, id },
      select: TEMPLATE_SELECT,
    });
    return row ? toTemplate(row) : null;
  }

  department(id: string) {
    return this.tx.department.findFirst({
      where: { ...this.scope, id },
      select: { id: true, status: true },
    });
  }

  async createTemplate(input: { title: string; departmentId: string | null; items: string[] }) {
    const { id } = await this.tx.checklistTemplate.create({
      data: { ...this.scope, ...input, createdByUserId: this.userId },
      select: { id: true },
    });
    return id;
  }

  async updateTemplate(
    id: string,
    patch: { title?: string; departmentId?: string | null; items?: string[]; status?: 'ARCHIVED' },
  ) {
    await this.tx.checklistTemplate.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  shift(id: string) {
    return this.tx.shift.findFirst({
      where: { ...this.scope, id },
      select: { id: true, userId: true, status: true },
    });
  }

  async runs(filter: { status?: ChecklistStatus; userId?: string }, limit: number) {
    const rows = await this.tx.checklistRun.findMany({
      where: {
        ...this.scope,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.userId ? { assignedToUserId: filter.userId } : {}),
      },
      select: RUN_SELECT,
      orderBy: [{ dueOn: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    return rows.map(toRun);
  }

  async run(id: string) {
    const row = await this.tx.checklistRun.findFirst({
      where: { ...this.scope, id },
      select: RUN_SELECT,
    });
    return row ? toRun(row) : null;
  }

  async createRun(input: {
    template: TemplateRecord;
    assignedToUserId: string;
    shiftId: string | null;
    dueOn: string;
  }) {
    const { id } = await this.tx.checklistRun.create({
      data: {
        ...this.scope,
        templateId: input.template.id,
        title: input.template.title,
        assignedToUserId: input.assignedToUserId,
        shiftId: input.shiftId,
        dueOn: new Date(`${input.dueOn}T00:00:00Z`),
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    await this.tx.checklistRunItem.createMany({
      data: input.template.items.map((text, i) => ({
        ...this.scope,
        runId: id,
        position: i + 1,
        text,
      })),
    });
    return id;
  }

  async answer(runId: string, position: number, result: ChecklistResult, note: string | null) {
    const { count } = await this.tx.checklistRunItem.updateMany({
      where: { ...this.scope, runId, position },
      data: { result, note },
    });
    return count > 0;
  }

  async setStatus(id: string, status: ChecklistStatus, note: string | null) {
    await this.tx.checklistRun.updateMany({
      where: { ...this.scope, id },
      data: { status, statusNote: note },
    });
  }

  async audit(event: {
    action: string;
    resourceType: 'checklist_template' | 'checklist';
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

/** Checklist persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaChecklistRepository implements ChecklistRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: ChecklistUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaChecklistUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}
