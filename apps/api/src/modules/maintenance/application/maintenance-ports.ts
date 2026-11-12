import type { RequestMeta } from '../../../platform/request-meta';
import type {
  Category,
  Priority,
  RequestStatus,
  Visibility,
  WorkOrderStatus,
} from '../domain/maintenance-rules';

/** A unit or a common area of the property. */
export interface Place {
  unitId: string | null;
  unitNumber: string | null;
  commonAreaId: string | null;
  commonAreaName: string | null;
}

export interface RequestRecord extends Place {
  id: string;
  number: bigint;
  category: Category;
  priority: Priority;
  title: string;
  description: string;
  locationDetail: string | null;
  status: RequestStatus;
  statusNote: string | null;
  submittedByUserId: string;
  submittedByName: string;
  acceptedAt: Date | null;
  responseDueAt: Date | null;
  resolutionDueAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  reopenCount: number;
  createdAt: Date;
}

export interface WorkOrderRecord extends Place {
  id: string;
  number: bigint;
  requestId: string | null;
  requestNumber: bigint | null;
  category: Category;
  priority: Priority;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  statusNote: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  createdByUserId: string;
  dueAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface CostRecord {
  id: string;
  workOrderId: string;
  kind: 'LABOUR' | 'MATERIAL' | 'OTHER';
  description: string;
  amountMinor: bigint;
  currency: string;
  recordedByUserId: string;
  recordedByName: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface EventRecord {
  id: string;
  sequence: bigint;
  requestId: string | null;
  workOrderId: string | null;
  workOrderNumber: bigint | null;
  type: 'STATUS_CHANGED' | 'ASSIGNEE_CHANGED' | 'PRIORITY_CHANGED' | 'NOTE';
  visibility: Visibility;
  fromValue: string | null;
  toValue: string | null;
  body: string | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: Date;
}

export interface MaintenanceAuditEvent {
  action: string;
  resourceType: string;
  resourceId: string;
  /** Never personal data or free text. */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * One transaction in the organisation's RLS context, limited to one property. Every query filters
 * by organisation and property explicitly as well.
 */
export interface MaintenanceUnitOfWork {
  property(): Promise<{ currency: string; status: 'ONBOARDING' | 'ACTIVE' | 'ARCHIVED' }>;
  unit(id: string): Promise<{ id: string; number: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;
  commonArea(
    id: string,
  ): Promise<{ id: string; name: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;
  /** Whether the caller is a current owner, tenant or household member of the unit. */
  callerIsResidentOf(unitId: string): Promise<boolean>;

  createRequest(input: {
    unitId: string | null;
    commonAreaId: string | null;
    category: Category;
    priority: Priority;
    title: string;
    description: string;
    locationDetail: string | null;
  }): Promise<string>;
  request(id: string): Promise<RequestRecord | null>;
  /** Newest first, at most 200. */
  requests(filter: { status?: RequestStatus; unitId?: string }): Promise<RequestRecord[]>;
  updateRequest(
    id: string,
    patch: {
      status?: RequestStatus;
      statusNote?: string | null;
      priority?: Priority;
      category?: Category;
    },
  ): Promise<void>;

  createWorkOrder(input: {
    requestId: string | null;
    unitId: string | null;
    commonAreaId: string | null;
    category: Category;
    priority: Priority;
    title: string;
    description: string | null;
    assignedToUserId: string | null;
    dueAt: Date | null;
  }): Promise<string>;
  workOrder(id: string): Promise<WorkOrderRecord | null>;
  /** Newest first, at most 200. */
  workOrders(filter: {
    status?: WorkOrderStatus;
    assignedToUserId?: string;
    requestId?: string;
  }): Promise<WorkOrderRecord[]>;
  updateWorkOrder(
    id: string,
    patch: {
      status?: WorkOrderStatus;
      statusNote?: string | null;
      assignedToUserId?: string | null;
      priority?: Priority;
      dueAt?: Date | null;
    },
  ): Promise<void>;

  costs(workOrderId: string): Promise<CostRecord[]>;
  cost(id: string): Promise<CostRecord | null>;
  createCost(input: {
    workOrderId: string;
    kind: CostRecord['kind'];
    description: string;
    amountMinor: bigint;
    currency: string;
  }): Promise<string>;
  voidCost(id: string, reason: string): Promise<void>;

  /** In order; only the given visibility when set. */
  events(
    target: { requestId: string } | { workOrderId: string },
    visibility?: Visibility,
  ): Promise<EventRecord[]>;
  addNote(input: {
    requestId: string | null;
    workOrderId: string | null;
    visibility: Visibility;
    body: string;
  }): Promise<void>;
  audit(event: MaintenanceAuditEvent): Promise<void>;
}

export interface MaintenanceRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: MaintenanceUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const MAINTENANCE_REPOSITORY = Symbol('MAINTENANCE_REPOSITORY');
