import { DomainError, Money } from '@veyra/domain';
import { z } from 'zod';

/*
 * Maintenance rules (PRD 3.5, DATA_MODEL section 7, owner decisions of 2026-11-11 in ROADMAP).
 * The database enforces every transition again (migration 20261114090000_maintenance); these
 * give a clear answer before it does.
 */

export const CATEGORIES = [
  'PLUMBING',
  'ELECTRICAL',
  'HVAC',
  'APPLIANCE',
  'STRUCTURAL',
  'CARPENTRY',
  'PAINTING',
  'PEST_CONTROL',
  'CLEANING',
  'LIFT',
  'SECURITY_SYSTEM',
  'OTHER',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type RequestStatus =
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'RESOLVED'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED';
export type WorkOrderStatus =
  | 'OPEN'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CANCELLED';
export type Visibility = 'RESIDENT' | 'INTERNAL';

const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  SUBMITTED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'ACCEPTED'],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
};

const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, readonly WorkOrderStatus[]> = {
  OPEN: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['OPEN', 'IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const canMoveRequest = (from: RequestStatus, to: RequestStatus) =>
  REQUEST_TRANSITIONS[from].includes(to);
export const canMoveWorkOrder = (from: WorkOrderStatus, to: WorkOrderStatus) =>
  WORK_ORDER_TRANSITIONS[from].includes(to);

/** Work still to be done: it blocks resolving or cancelling its request. */
export const isLiveWork = (status: WorkOrderStatus) =>
  status !== 'COMPLETED' && status !== 'CANCELLED';

/** Work someone is on: it can be reassigned. */
export const isAssignedWork = (status: WorkOrderStatus) =>
  status === 'ASSIGNED' || status === 'IN_PROGRESS' || status === 'ON_HOLD';

/** A request resolves once some work is completed and none is still live. */
export function canResolve(workStatuses: readonly WorkOrderStatus[]): boolean {
  return workStatuses.includes('COMPLETED') && !workStatuses.some(isLiveWork);
}

export const formatRequestNumber = (n: bigint) => `MR-${n.toString().padStart(6, '0')}`;
export const formatWorkOrderNumber = (n: bigint) => `WO-${n.toString().padStart(6, '0')}`;

// ------------------------------------------------------------------ input schemas

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));
const reason = text(1000);

const report = {
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  title: text(120),
  description: text(4000),
  locationDetail: optionalText(200),
};

/** A resident's report for their unit (the unit comes from the route). */
export const residentRequestSchema = z.object(report);
export type ResidentRequestInput = z.infer<typeof residentRequestSchema>;

/** Staff report for a unit or a common area of the property. */
export const staffRequestSchema = z
  .object({ ...report, unitId: z.uuid().optional(), commonAreaId: z.uuid().optional() })
  .refine((v) => (v.unitId === undefined) !== (v.commonAreaId === undefined), {
    message: 'Give either a unit or a common area',
    path: ['unitId'],
  });
export type StaffRequestInput = z.infer<typeof staffRequestSchema>;

export const requestListQuerySchema = z.object({
  status: z
    .enum(['SUBMITTED', 'ACCEPTED', 'RESOLVED', 'CLOSED', 'REJECTED', 'CANCELLED'])
    .optional(),
  unitId: z.uuid().optional(),
});

export const acceptSchema = z.object({
  priority: z.enum(PRIORITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  /** Shown to the requester. */
  note: optionalText(2000),
});
export type AcceptInput = z.infer<typeof acceptSchema>;

export const reasonSchema = z.object({ reason });
export const optionalNoteSchema = z.object({ note: optionalText(2000) });

export const updateRequestSchema = z
  .object({ priority: z.enum(PRIORITIES).optional(), category: z.enum(CATEGORIES).optional() })
  .refine((v) => v.priority !== undefined || v.category !== undefined, {
    message: 'Change the priority or the category',
  });

export const noteSchema = z.object({
  body: text(2000),
  visibility: z.enum(['RESIDENT', 'INTERNAL']),
});
export type NoteInput = z.infer<typeof noteSchema>;

export const residentNoteSchema = z.object({ body: text(2000) });

export const createWorkOrderSchema = z
  .object({
    requestId: z.uuid().optional(),
    unitId: z.uuid().optional(),
    commonAreaId: z.uuid().optional(),
    /** Defaults to the request's. */
    title: text(120).optional(),
    description: optionalText(4000),
    category: z.enum(CATEGORIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignedToUserId: z.uuid().optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    (v) =>
      v.requestId !== undefined
        ? v.unitId === undefined && v.commonAreaId === undefined
        : (v.unitId === undefined) !== (v.commonAreaId === undefined),
    { message: 'Give a request, or else either a unit or a common area', path: ['requestId'] },
  )
  .refine((v) => v.requestId !== undefined || (v.title !== undefined && v.category !== undefined), {
    message: 'Work without a request needs a title and a category',
    path: ['title'],
  });
export type CreateWorkOrderInput = z.infer<typeof createWorkOrderSchema>;

export const workOrderListQuerySchema = z.object({
  status: z
    .enum(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'])
    .optional(),
  assignedToUserId: z.uuid().optional(),
  requestId: z.uuid().optional(),
});

export const myWorkQuerySchema = z.object({
  status: z.enum(['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
});

export const assignSchema = z.object({ userId: z.uuid() });

export const updateWorkOrderSchema = z
  .object({
    priority: z.enum(PRIORITIES).optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => v.priority !== undefined || v.dueAt !== undefined, {
    message: 'Change the priority or the due time',
  });

export const completeSchema = z.object({ note: reason });

export const costSchema = z.object({
  kind: z.enum(['LABOUR', 'MATERIAL', 'OTHER']),
  description: text(200),
  /** A decimal in the property's currency, e.g. "1500.50". */
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,13}(\.\d{1,4})?$/, 'Use a positive amount such as 1500.50'),
});
export type CostInput = z.infer<typeof costSchema>;

export const voidCostSchema = z.object({ reason: text(500) });

export class AssigneeNotAllowed extends DomainError {
  constructor() {
    super('ASSIGNEE_NOT_ALLOWED', 'This person cannot be given maintenance work at this property');
  }
}

/** A positive amount in the currency's minor units; refuses more decimals than it has. */
export function parseCost(decimal: string, currency: string): bigint {
  const minor = Money.parse(decimal, currency).amountMinor;
  if (minor <= 0n) throw new DomainError('INVALID_MONEY', 'The amount must be more than zero');
  return minor;
}

/** 10 MB, as in the database. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']),
  sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  /** Staff and technicians: before/after evidence. */
  kind: z.enum(['BEFORE', 'AFTER', 'OTHER']).default('OTHER'),
  /** Staff and technicians; residents' files are always resident-visible. */
  visibility: z.enum(['RESIDENT', 'INTERNAL']).default('INTERNAL'),
});
export type UploadInput = z.infer<typeof uploadSchema>;
