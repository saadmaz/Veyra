import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  AttachmentRecord,
  CostRecord,
  EventRecord,
  MaintenanceAuditEvent,
  MaintenanceRepository,
  MaintenanceUnitOfWork,
  RequestRecord,
  SlaTargetRecord,
  WorkOrderRecord,
} from '../application/maintenance-ports';
import type {
  Category,
  Priority,
  RequestStatus,
  Visibility,
  WorkOrderStatus,
} from '../domain/maintenance-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const PLACE_SELECT = {
  unitId: true,
  commonAreaId: true,
  unit: { select: { number: true } },
  commonArea: { select: { name: true } },
} as const;

const place = (row: {
  unitId: string | null;
  commonAreaId: string | null;
  unit: { number: string } | null;
  commonArea: { name: string } | null;
}) => ({
  unitId: row.unitId,
  unitNumber: row.unit?.number ?? null,
  commonAreaId: row.commonAreaId,
  commonAreaName: row.commonArea?.name ?? null,
});

const REQUEST_SELECT = {
  ...PLACE_SELECT,
  id: true,
  requestNumber: true,
  category: true,
  priority: true,
  title: true,
  description: true,
  locationDetail: true,
  status: true,
  statusNote: true,
  submittedByUserId: true,
  submittedBy: { select: { displayName: true } },
  acceptedAt: true,
  responseDueAt: true,
  resolutionDueAt: true,
  responseBreachedAt: true,
  resolutionBreachedAt: true,
  resolvedAt: true,
  closedAt: true,
  reopenCount: true,
  createdAt: true,
} as const;

type RequestRow = {
  id: string;
  requestNumber: bigint | null;
  category: Category;
  priority: Priority;
  title: string;
  description: string;
  locationDetail: string | null;
  status: RequestStatus;
  statusNote: string | null;
  submittedByUserId: string;
  submittedBy: { displayName: string };
  acceptedAt: Date | null;
  responseDueAt: Date | null;
  resolutionDueAt: Date | null;
  responseBreachedAt: Date | null;
  resolutionBreachedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  reopenCount: number;
  createdAt: Date;
  unitId: string | null;
  commonAreaId: string | null;
  unit: { number: string } | null;
  commonArea: { name: string } | null;
};

const toRequest = (row: RequestRow): RequestRecord => ({
  ...place(row),
  id: row.id,
  number: row.requestNumber ?? 0n,
  category: row.category,
  priority: row.priority,
  title: row.title,
  description: row.description,
  locationDetail: row.locationDetail,
  status: row.status,
  statusNote: row.statusNote,
  submittedByUserId: row.submittedByUserId,
  submittedByName: row.submittedBy.displayName,
  acceptedAt: row.acceptedAt,
  responseDueAt: row.responseDueAt,
  resolutionDueAt: row.resolutionDueAt,
  responseBreachedAt: row.responseBreachedAt,
  resolutionBreachedAt: row.resolutionBreachedAt,
  resolvedAt: row.resolvedAt,
  closedAt: row.closedAt,
  reopenCount: row.reopenCount,
  createdAt: row.createdAt,
});

const WORK_ORDER_SELECT = {
  ...PLACE_SELECT,
  id: true,
  workOrderNumber: true,
  requestId: true,
  request: { select: { requestNumber: true } },
  category: true,
  priority: true,
  title: true,
  description: true,
  status: true,
  statusNote: true,
  assignedToUserId: true,
  assignedTo: { select: { displayName: true } },
  createdByUserId: true,
  dueAt: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const;

type WorkOrderRow = {
  id: string;
  workOrderNumber: bigint | null;
  requestId: string | null;
  request: { requestNumber: bigint | null } | null;
  category: Category;
  priority: Priority;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  statusNote: string | null;
  assignedToUserId: string | null;
  assignedTo: { displayName: string } | null;
  createdByUserId: string;
  dueAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  unitId: string | null;
  commonAreaId: string | null;
  unit: { number: string } | null;
  commonArea: { name: string } | null;
};

const toWorkOrder = (row: WorkOrderRow): WorkOrderRecord => ({
  ...place(row),
  id: row.id,
  number: row.workOrderNumber ?? 0n,
  requestId: row.requestId,
  requestNumber: row.request?.requestNumber ?? null,
  category: row.category,
  priority: row.priority,
  title: row.title,
  description: row.description,
  status: row.status,
  statusNote: row.statusNote,
  assignedToUserId: row.assignedToUserId,
  assignedToName: row.assignedTo?.displayName ?? null,
  createdByUserId: row.createdByUserId,
  dueAt: row.dueAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  createdAt: row.createdAt,
});

const COST_SELECT = {
  id: true,
  workOrderId: true,
  kind: true,
  description: true,
  amountMinor: true,
  currency: true,
  recordedByUserId: true,
  recordedBy: { select: { displayName: true } },
  createdAt: true,
  voidedAt: true,
  voidReason: true,
} as const;

const toCost = (row: {
  id: string;
  workOrderId: string;
  kind: CostRecord['kind'];
  description: string;
  amountMinor: bigint;
  currency: string;
  recordedByUserId: string;
  recordedBy: { displayName: string };
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}): CostRecord => {
  const { recordedBy, currency, ...rest } = row;
  return { ...rest, currency: currency.trim(), recordedByName: recordedBy.displayName };
};

const ATTACHMENT_SELECT = {
  id: true,
  requestId: true,
  workOrderId: true,
  storageKey: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  kind: true,
  visibility: true,
  status: true,
  uploadedByUserId: true,
  uploadedBy: { select: { displayName: true } },
  createdAt: true,
  readyAt: true,
  removedAt: true,
} as const;

const toAttachment = ({
  uploadedBy,
  ...row
}: Omit<AttachmentRecord, 'uploadedByName'> & {
  uploadedBy: { displayName: string };
}): AttachmentRecord => ({ ...row, uploadedByName: uploadedBy.displayName });

class PrismaMaintenanceUnitOfWork implements MaintenanceUnitOfWork {
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

  async property() {
    const row = await this.tx.property.findFirst({
      where: { id: this.propertyId, organisationId: this.organisationId },
      select: { currency: true, status: true },
    });
    if (!row) throw new Error('Property vanished inside its own transaction');
    return { currency: row.currency.trim(), status: row.status };
  }

  unit(id: string) {
    return this.tx.unit.findFirst({
      where: { ...this.scope, id },
      select: { id: true, number: true, status: true },
    });
  }

  commonArea(id: string) {
    return this.tx.commonArea.findFirst({
      where: { ...this.scope, id },
      select: { id: true, name: true, status: true },
    });
  }

  async callerIsResidentOf(unitId: string): Promise<boolean> {
    const rows = await this.tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app_resident_grants(${this.userId}::uuid) g
       WHERE g."unit_id" = ${unitId}::uuid AND g."property_id" = ${this.propertyId}::uuid`;
    return (rows[0]?.n ?? 0) > 0;
  }

  async createRequest(input: {
    unitId: string | null;
    commonAreaId: string | null;
    category: Category;
    priority: Priority;
    title: string;
    description: string;
    locationDetail: string | null;
  }): Promise<string> {
    const { id } = await this.tx.maintenanceRequest.create({
      data: { ...this.scope, ...input, submittedByUserId: this.userId },
      select: { id: true },
    });
    return id;
  }

  async request(id: string): Promise<RequestRecord | null> {
    const row = await this.tx.maintenanceRequest.findFirst({
      where: { ...this.scope, id },
      select: REQUEST_SELECT,
    });
    return row && toRequest(row);
  }

  async requests(filter: { status?: RequestStatus; unitId?: string }): Promise<RequestRecord[]> {
    const rows = await this.tx.maintenanceRequest.findMany({
      where: {
        ...this.scope,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.unitId ? { unitId: filter.unitId } : {}),
      },
      select: REQUEST_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(toRequest);
  }

  async openRequests(): Promise<RequestRecord[]> {
    const rows = await this.tx.maintenanceRequest.findMany({
      where: { ...this.scope, status: { in: ['SUBMITTED', 'ACCEPTED'] } },
      select: REQUEST_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map(toRequest);
  }

  async slaTargets(): Promise<SlaTargetRecord[]> {
    return this.tx.maintenanceSlaTarget.findMany({
      where: this.scope,
      select: { priority: true, responseMinutes: true, resolutionMinutes: true },
    });
  }

  async replaceSlaTargets(targets: readonly SlaTargetRecord[]): Promise<void> {
    await this.tx.maintenanceSlaTarget.deleteMany({ where: this.scope });
    if (targets.length > 0) {
      await this.tx.maintenanceSlaTarget.createMany({
        data: targets.map((t) => ({ ...this.scope, ...t })),
      });
    }
  }

  async updateRequest(
    id: string,
    patch: {
      status?: RequestStatus;
      statusNote?: string | null;
      priority?: Priority;
      category?: Category;
    },
  ): Promise<void> {
    await this.tx.maintenanceRequest.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: patch,
    });
  }

  async createWorkOrder(input: {
    requestId: string | null;
    unitId: string | null;
    commonAreaId: string | null;
    category: Category;
    priority: Priority;
    title: string;
    description: string | null;
    assignedToUserId: string | null;
    dueAt: Date | null;
  }): Promise<string> {
    const { id } = await this.tx.workOrder.create({
      data: {
        ...this.scope,
        ...input,
        status: input.assignedToUserId ? 'ASSIGNED' : 'OPEN',
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    return id;
  }

  async workOrder(id: string): Promise<WorkOrderRecord | null> {
    const row = await this.tx.workOrder.findFirst({
      where: { ...this.scope, id },
      select: WORK_ORDER_SELECT,
    });
    return row && toWorkOrder(row);
  }

  async workOrders(filter: {
    status?: WorkOrderStatus;
    assignedToUserId?: string;
    requestId?: string;
  }): Promise<WorkOrderRecord[]> {
    const rows = await this.tx.workOrder.findMany({
      where: {
        ...this.scope,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.assignedToUserId ? { assignedToUserId: filter.assignedToUserId } : {}),
        ...(filter.requestId ? { requestId: filter.requestId } : {}),
      },
      select: WORK_ORDER_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(toWorkOrder);
  }

  async updateWorkOrder(
    id: string,
    patch: {
      status?: WorkOrderStatus;
      statusNote?: string | null;
      assignedToUserId?: string | null;
      priority?: Priority;
      dueAt?: Date | null;
    },
  ): Promise<void> {
    await this.tx.workOrder.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: patch,
    });
  }

  async costs(workOrderId: string): Promise<CostRecord[]> {
    const rows = await this.tx.workOrderCost.findMany({
      where: { ...this.scope, workOrderId },
      select: COST_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toCost);
  }

  async cost(id: string): Promise<CostRecord | null> {
    const row = await this.tx.workOrderCost.findFirst({
      where: { ...this.scope, id },
      select: COST_SELECT,
    });
    return row && toCost(row);
  }

  async createCost(input: {
    workOrderId: string;
    kind: CostRecord['kind'];
    description: string;
    amountMinor: bigint;
    currency: string;
  }): Promise<string> {
    const { id } = await this.tx.workOrderCost.create({
      data: { ...this.scope, ...input, recordedByUserId: this.userId },
      select: { id: true },
    });
    return id;
  }

  async voidCost(id: string, reason: string): Promise<void> {
    await this.tx.workOrderCost.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: { voidedAt: new Date(), voidedByUserId: this.userId, voidReason: reason },
    });
  }

  async events(
    target: { requestId: string } | { workOrderId: string },
    visibility?: Visibility,
  ): Promise<EventRecord[]> {
    const rows = await this.tx.maintenanceEvent.findMany({
      where: { ...this.scope, ...target, ...(visibility ? { visibility } : {}) },
      select: {
        id: true,
        sequence: true,
        requestId: true,
        workOrderId: true,
        workOrder: { select: { workOrderNumber: true } },
        type: true,
        visibility: true,
        fromValue: true,
        toValue: true,
        body: true,
        actorUserId: true,
        actor: { select: { displayName: true } },
        createdAt: true,
      },
      orderBy: { sequence: 'asc' },
      take: 1000,
    });
    return rows.map(({ workOrder, actor, ...row }) => ({
      ...row,
      workOrderNumber: workOrder?.workOrderNumber ?? null,
      actorName: actor?.displayName ?? null,
    }));
  }

  async addNote(input: {
    requestId: string | null;
    workOrderId: string | null;
    visibility: Visibility;
    body: string;
  }): Promise<void> {
    await this.tx.maintenanceEvent.create({
      data: { ...this.scope, ...input, type: 'NOTE', actorUserId: this.userId },
      select: { id: true },
    });
  }

  async createAttachment(input: {
    id: string;
    storageKey: string;
    requestId: string | null;
    workOrderId: string | null;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    kind: AttachmentRecord['kind'];
    visibility: Visibility;
  }): Promise<void> {
    await this.tx.maintenanceAttachment.create({
      data: { ...this.scope, ...input, uploadedByUserId: this.userId },
      select: { id: true },
    });
  }

  async attachment(id: string, options?: { lock?: boolean }): Promise<AttachmentRecord | null> {
    if (options?.lock) {
      await this.tx.$queryRaw`
        SELECT 1 FROM "maintenance_attachments"
         WHERE "id" = ${id}::uuid AND "organisation_id" = ${this.organisationId}::uuid
           AND "property_id" = ${this.propertyId}::uuid
         FOR UPDATE`;
    }
    const row = await this.tx.maintenanceAttachment.findFirst({
      where: { ...this.scope, id },
      select: ATTACHMENT_SELECT,
    });
    return row && toAttachment(row);
  }

  async attachments(
    target: { requestId: string } | { workOrderId: string },
  ): Promise<AttachmentRecord[]> {
    const rows = await this.tx.maintenanceAttachment.findMany({
      where: { ...this.scope, ...target, status: { not: 'REJECTED' }, removedAt: null },
      select: ATTACHMENT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map(toAttachment);
  }

  async setAttachmentStatus(id: string, status: 'READY' | 'REJECTED'): Promise<void> {
    await this.tx.maintenanceAttachment.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: { status },
    });
  }

  async removeAttachment(id: string): Promise<void> {
    await this.tx.maintenanceAttachment.update({
      where: { id, organisationId: this.organisationId, propertyId: this.propertyId },
      data: { removedAt: new Date(), removedByUserId: this.userId },
    });
  }

  async audit(event: MaintenanceAuditEvent): Promise<void> {
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

/** Maintenance persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaMaintenanceRepository implements MaintenanceRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: MaintenanceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaMaintenanceUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}
