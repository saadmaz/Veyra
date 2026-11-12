import type {
  MaintenanceEventDto,
  MaintenanceRequestDto,
  MoneyDto,
  WorkOrderCostDto,
  WorkOrderDetailDto,
  WorkOrderDto,
} from '@veyra/api-contracts';
import type {
  CostRecord,
  EventRecord,
  RequestRecord,
  WorkOrderRecord,
} from '../application/maintenance-ports';
import { formatRequestNumber, formatWorkOrderNumber } from '../domain/maintenance-rules';

const iso = (date: Date | null) => date?.toISOString() ?? null;

export const toRequest = (r: RequestRecord): MaintenanceRequestDto => ({
  id: r.id,
  number: formatRequestNumber(r.number),
  unitId: r.unitId,
  unitNumber: r.unitNumber,
  commonAreaId: r.commonAreaId,
  commonAreaName: r.commonAreaName,
  category: r.category,
  priority: r.priority,
  title: r.title,
  description: r.description,
  locationDetail: r.locationDetail,
  status: r.status,
  statusNote: r.statusNote,
  submittedBy: { userId: r.submittedByUserId, name: r.submittedByName },
  acceptedAt: iso(r.acceptedAt),
  responseDueAt: iso(r.responseDueAt),
  resolutionDueAt: iso(r.resolutionDueAt),
  resolvedAt: iso(r.resolvedAt),
  closedAt: iso(r.closedAt),
  reopenCount: r.reopenCount,
  createdAt: r.createdAt.toISOString(),
});

export const toEvent = (e: EventRecord): MaintenanceEventDto => ({
  id: e.id,
  type: e.type,
  visibility: e.visibility,
  from: e.fromValue,
  to: e.toValue,
  body: e.body,
  actor: e.actorUserId ? { userId: e.actorUserId, name: e.actorName ?? '' } : null,
  workOrderNumber: e.workOrderNumber === null ? null : formatWorkOrderNumber(e.workOrderNumber),
  createdAt: e.createdAt.toISOString(),
});

export const toWorkOrder = (w: WorkOrderRecord): WorkOrderDto => ({
  id: w.id,
  number: formatWorkOrderNumber(w.number),
  requestId: w.requestId,
  requestNumber: w.requestNumber === null ? null : formatRequestNumber(w.requestNumber),
  unitId: w.unitId,
  unitNumber: w.unitNumber,
  commonAreaId: w.commonAreaId,
  commonAreaName: w.commonAreaName,
  category: w.category,
  priority: w.priority,
  title: w.title,
  description: w.description,
  status: w.status,
  statusNote: w.statusNote,
  assignedTo: w.assignedToUserId
    ? { userId: w.assignedToUserId, name: w.assignedToName ?? '' }
    : null,
  dueAt: iso(w.dueAt),
  startedAt: iso(w.startedAt),
  completedAt: iso(w.completedAt),
  createdAt: w.createdAt.toISOString(),
});

const money = (amountMinor: bigint, currency: string): MoneyDto => ({
  amountMinor: amountMinor.toString(),
  currency,
});

const toCost = (c: CostRecord): WorkOrderCostDto => ({
  id: c.id,
  kind: c.kind,
  description: c.description,
  amount: money(c.amountMinor, c.currency),
  recordedBy: { userId: c.recordedByUserId, name: c.recordedByName },
  createdAt: c.createdAt.toISOString(),
  voidedAt: iso(c.voidedAt),
  voidReason: c.voidReason,
});

export const toWorkOrderDetail = (d: {
  workOrder: WorkOrderRecord;
  costs: CostRecord[];
  events: EventRecord[];
  currency: string;
}): WorkOrderDetailDto => ({
  workOrder: toWorkOrder(d.workOrder),
  costs: d.costs.map(toCost),
  totalCost: money(
    d.costs.filter((c) => c.voidedAt === null).reduce((sum, c) => sum + c.amountMinor, 0n),
    d.currency,
  ),
  events: d.events.map(toEvent),
});
