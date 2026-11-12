import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import { NotificationsService } from '../../communications/application/notifications.service';
import { VendorsService } from '../../vendors/application/vendors.service';
import {
  type AcceptInput,
  AssigneeNotAllowed,
  type Category,
  type CostInput,
  type CreateWorkOrderInput,
  canMoveRequest,
  canMoveWorkOrder,
  canResolve,
  isAssignedWork,
  isLiveWork,
  type NoteInput,
  type Priority,
  parseCost,
  queueOrder,
  type RequestStatus,
  type SlaTargetsInput,
  type StaffRequestInput,
  type WorkOrderStatus,
} from '../domain/maintenance-rules';
import {
  MAINTENANCE_REPOSITORY,
  type MaintenanceRepository,
  type MaintenanceUnitOfWork,
  type RequestRecord,
  type WorkOrderRecord,
} from './maintenance-ports';

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);

/**
 * Maintenance for staff (Phase 7 Part 2). Managers (property.maintenance.manage) triage requests
 * and run work orders; anyone with property.maintenance.read sees everything, internal notes and
 * costs included. Technicians (property.maintenance.work) see and progress only the work assigned
 * to them, through the "my work" methods. The database repeats every transition rule; a refusal
 * there (a race) becomes 409 INVALID_STATE_TRANSITION.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(MAINTENANCE_REPOSITORY) private readonly repository: MaintenanceRepository,
    private readonly accessControl: AccessControlService,
    @Inject(VendorsService) private readonly vendors: VendorsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ SLAs and queue (Part 4)

  slaTargets(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.slaTargets());
  }

  /** Replaces the targets for new requests; existing requests keep their due times. */
  replaceSlaTargets(access: OrganisationAccess, input: SlaTargetsInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await uow.replaceSlaTargets(input.targets);
      await uow.audit({
        action: 'maintenance.sla_targets.replaced',
        resourceType: 'property',
        resourceId: this.propertyOf(access),
        metadata: { targets: input.targets.length },
      });
      return uow.slaTargets();
    });
  }

  /** New and accepted requests, overdue first, then by priority and the next due time. */
  queue(access: OrganisationAccess, now: Date, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => queueOrder(await uow.openRequests(), now));
  }

  // ------------------------------------------------------------------ requests

  requests(
    access: OrganisationAccess,
    filter: { status?: RequestStatus; unitId?: string },
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, (uow) => uow.requests(filter));
  }

  request(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const request = await this.mustFindRequest(uow, id);
      const [workOrders, events, attachments] = await Promise.all([
        uow.workOrders({ requestId: id }),
        uow.events({ requestId: id }),
        uow.attachments({ requestId: id }),
      ]);
      return { request, workOrders, events, attachments };
    });
  }

  /** Staff report a problem in a unit or a common area (e.g. found on an inspection). */
  createRequest(access: OrganisationAccess, input: StaffRequestInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.requireActivePlace(uow, input.unitId ?? null, input.commonAreaId ?? null);
      const id = await uow.createRequest({
        unitId: input.unitId ?? null,
        commonAreaId: input.commonAreaId ?? null,
        category: input.category,
        priority: input.priority,
        title: input.title,
        description: input.description,
        locationDetail: input.locationDetail ?? null,
      });
      await uow.audit({
        action: 'maintenance.request.created',
        resourceType: 'maintenance_request',
        resourceId: id,
        metadata: { byStaff: true, priority: input.priority },
      });
      return this.mustFindRequest(uow, id);
    });
  }

  accept(access: OrganisationAccess, id: string, input: AcceptInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const request = await this.mustFindRequest(uow, id);
      this.requireRequestMove(request, 'ACCEPTED');
      if (request.status !== 'SUBMITTED') throw invalidState('Only a new request is accepted');
      await uow.updateRequest(id, {
        status: 'ACCEPTED',
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.category ? { category: input.category } : {}),
      });
      if (input.note) {
        await uow.addNote({
          requestId: id,
          workOrderId: null,
          visibility: 'RESIDENT',
          body: input.note,
        });
      }
      await this.auditRequest(uow, id, 'accepted');
      await this.tellRequester(uow, access, id, 'accepted');
      return this.mustFindRequest(uow, id);
    });
  }

  reject(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.moveRequest(access, id, 'REJECTED', reason, meta);
  }

  cancel(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const request = await this.mustFindRequest(uow, id);
      this.requireRequestMove(request, 'CANCELLED');
      const work = await uow.workOrders({ requestId: id });
      if (work.some((w) => isLiveWork(w.status))) {
        throw invalidState('Cancel the open work orders of this request first');
      }
      await uow.updateRequest(id, { status: 'CANCELLED', statusNote: reason });
      await this.auditRequest(uow, id, 'cancelled');
      return this.mustFindRequest(uow, id);
    });
  }

  /** The work is done: the requester is asked to confirm (or reopen). */
  resolve(access: OrganisationAccess, id: string, note: string | undefined, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const request = await this.mustFindRequest(uow, id);
      this.requireRequestMove(request, 'RESOLVED');
      const work = await uow.workOrders({ requestId: id });
      if (!canResolve(work.map((w) => w.status))) {
        throw invalidState(
          'A request is resolved once its work is completed and none is still open',
        );
      }
      await uow.updateRequest(id, { status: 'RESOLVED' });
      if (note) {
        await uow.addNote({ requestId: id, workOrderId: null, visibility: 'RESIDENT', body: note });
      }
      await this.auditRequest(uow, id, 'resolved');
      await this.tellRequester(uow, access, id, 'resolved');
      return this.mustFindRequest(uow, id);
    });
  }

  /** Closes a resolved request without waiting for the requester (e.g. no answer). */
  close(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.moveRequest(access, id, 'CLOSED', null, meta);
  }

  updateRequest(
    access: OrganisationAccess,
    id: string,
    patch: { priority?: Priority; category?: Category },
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const request = await this.mustFindRequest(uow, id);
      if (request.status !== 'SUBMITTED' && request.status !== 'ACCEPTED') {
        throw invalidState('Only a new or accepted request can change its priority or category');
      }
      await uow.updateRequest(id, patch);
      return this.mustFindRequest(uow, id);
    });
  }

  addRequestNote(access: OrganisationAccess, id: string, input: NoteInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.mustFindRequest(uow, id);
      await uow.addNote({ requestId: id, workOrderId: null, ...input });
      return uow.events({ requestId: id });
    });
  }

  // ------------------------------------------------------------------ work orders

  workOrders(
    access: OrganisationAccess,
    filter: { status?: WorkOrderStatus; assignedToUserId?: string; requestId?: string },
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, (uow) => uow.workOrders(filter));
  }

  workOrder(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => this.workOrderDetail(uow, id));
  }

  createWorkOrder(access: OrganisationAccess, input: CreateWorkOrderInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      let defaults: RequestRecord | null = null;
      if (input.requestId) {
        defaults = await this.mustFindRequest(uow, input.requestId);
        if (defaults.status !== 'ACCEPTED') {
          throw invalidState('Work orders are raised for accepted requests only');
        }
      } else {
        await this.requireActivePlace(uow, input.unitId ?? null, input.commonAreaId ?? null);
      }
      if (input.assignedToUserId) await this.requireAssignable(access, input.assignedToUserId);
      const description =
        input.description ??
        (defaults
          ? [
              defaults.description,
              defaults.locationDetail ? `Where: ${defaults.locationDetail}` : null,
            ]
              .filter(Boolean)
              .join('\n')
              .slice(0, 4000)
          : null);
      const id = await uow.createWorkOrder({
        requestId: defaults?.id ?? null,
        unitId: defaults ? defaults.unitId : (input.unitId ?? null),
        commonAreaId: defaults ? defaults.commonAreaId : (input.commonAreaId ?? null),
        category: input.category ?? (defaults?.category as Category),
        priority: input.priority ?? defaults?.priority ?? 'MEDIUM',
        title: input.title ?? (defaults?.title as string),
        description,
        assignedToUserId: input.assignedToUserId ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      });
      await uow.audit({
        action: 'maintenance.work_order.created',
        resourceType: 'work_order',
        resourceId: id,
        metadata: { fromRequest: defaults !== null, assigned: Boolean(input.assignedToUserId) },
      });
      return this.workOrderDetail(uow, id);
    });
  }

  /** Gives the work to someone, or to someone else while it is live. */
  assign(access: OrganisationAccess, id: string, userId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mustFindWorkOrder(uow, id);
      if (work.status !== 'OPEN' && !isAssignedWork(work.status)) {
        throw invalidState('Finished work cannot be assigned');
      }
      await this.requireAssignable(access, userId);
      await uow.updateWorkOrder(id, {
        assignedToUserId: userId,
        ...(work.status === 'OPEN' ? { status: 'ASSIGNED' as const } : {}),
      });
      await this.auditWork(uow, id, 'assigned');
      return this.workOrderDetail(uow, id);
    });
  }

  /**
   * Gives the work to an active vendor (Phase 9), with or without a technician, or takes the
   * vendor off it (null). Work with nobody left on it goes back to the open pool if not started.
   */
  assignVendor(access: OrganisationAccess, id: string, vendorId: string | null, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mustFindWorkOrder(uow, id);
      if (work.status !== 'OPEN' && !isAssignedWork(work.status)) {
        throw invalidState('Finished work cannot be assigned');
      }
      if (vendorId) {
        const vendor = await uow.vendor(vendorId);
        if (!vendor) throw notFound('Vendor');
        if (vendor.status !== 'ACTIVE') {
          throw new ApiError(409, 'VENDOR_NOT_ACTIVE', 'This vendor is not taking work');
        }
        await uow.updateWorkOrder(id, {
          vendorId,
          ...(work.status === 'OPEN' ? { status: 'ASSIGNED' as const } : {}),
        });
      } else {
        if (!work.vendorId) throw invalidState('No vendor is on this work');
        if (!work.assignedToUserId && work.status !== 'ASSIGNED') {
          throw invalidState('Give the work to someone else before taking the vendor off it');
        }
        await uow.updateWorkOrder(id, {
          vendorId: null,
          ...(work.assignedToUserId ? {} : { status: 'OPEN' as const }),
        });
      }
      await this.auditWork(uow, id, vendorId ? 'vendor_assigned' : 'vendor_removed');
      return this.workOrderDetail(uow, id);
    });
  }

  /** Active vendors to give work to, with their compliance. */
  activeVendors(access: OrganisationAccess, meta: RequestMeta) {
    return this.vendors.list(access, 'ACTIVE', meta);
  }

  /** Takes assigned (not yet started) work back to the open pool. */
  unassign(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mustFindWorkOrder(uow, id);
      if (work.status !== 'ASSIGNED') {
        throw invalidState('Only assigned work that has not started can be unassigned');
      }
      await uow.updateWorkOrder(id, { status: 'OPEN', assignedToUserId: null, vendorId: null });
      await this.auditWork(uow, id, 'unassigned');
      return this.workOrderDetail(uow, id);
    });
  }

  cancelWorkOrder(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mustFindWorkOrder(uow, id);
      if (!canMoveWorkOrder(work.status, 'CANCELLED')) {
        throw invalidState(`Work that is ${work.status.toLowerCase()} cannot be cancelled`);
      }
      await uow.updateWorkOrder(id, { status: 'CANCELLED', statusNote: reason });
      await this.auditWork(uow, id, 'cancelled');
      return this.workOrderDetail(uow, id);
    });
  }

  updateWorkOrder(
    access: OrganisationAccess,
    id: string,
    patch: { priority?: Priority; dueAt?: string | null },
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mustFindWorkOrder(uow, id);
      if (!isLiveWork(work.status)) throw invalidState('Finished work no longer changes');
      await uow.updateWorkOrder(id, {
        ...(patch.priority ? { priority: patch.priority } : {}),
        ...(patch.dueAt !== undefined
          ? { dueAt: patch.dueAt === null ? null : new Date(patch.dueAt) }
          : {}),
      });
      return this.workOrderDetail(uow, id);
    });
  }

  addWorkOrderNote(access: OrganisationAccess, id: string, input: NoteInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mustFindWorkOrder(uow, id);
      await this.addWorkNote(uow, work, input);
      return this.workOrderDetail(uow, id);
    });
  }

  recordCost(access: OrganisationAccess, id: string, input: CostInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mustFindWorkOrder(uow, id);
      await this.addCost(uow, work, input);
      return this.workOrderDetail(uow, id);
    });
  }

  voidCost(access: OrganisationAccess, costId: string, reason: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const cost = await uow.cost(costId);
      if (!cost) throw notFound('Cost');
      if (cost.voidedAt) throw invalidState('This cost is already voided');
      await uow.voidCost(costId, reason);
      await uow.audit({
        action: 'maintenance.cost.voided',
        resourceType: 'work_order_cost',
        resourceId: costId,
        metadata: { workOrderId: cost.workOrderId },
      });
      return this.workOrderDetail(uow, cost.workOrderId);
    });
  }

  /** People who can be given maintenance work at the property. */
  assignees(access: OrganisationAccess) {
    return this.accessControl.usersWithPropertyPermission(
      access.organisationId,
      this.propertyOf(access),
      'property.maintenance.work',
    );
  }

  // ------------------------------------------------------------------ my work (technicians)

  myWorkOrders(access: OrganisationAccess, status: WorkOrderStatus | undefined, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) =>
      uow.workOrders({ assignedToUserId: access.userId, ...(status ? { status } : {}) }),
    );
  }

  myWorkOrder(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.mine(uow, access, id);
      return this.workOrderDetail(uow, id);
    });
  }

  /** start: ASSIGNED or ON_HOLD to IN_PROGRESS; hold and complete need a note. */
  progress(
    access: OrganisationAccess,
    id: string,
    to: 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED',
    note: string | null,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mine(uow, access, id);
      if (!canMoveWorkOrder(work.status, to)) {
        throw invalidState(
          `Work that is ${work.status.toLowerCase().replace('_', ' ')} cannot move to ${to.toLowerCase().replace('_', ' ')}`,
        );
      }
      await uow.updateWorkOrder(id, { status: to, statusNote: note });
      await this.auditWork(uow, id, to.toLowerCase());
      return this.workOrderDetail(uow, id);
    });
  }

  addMyNote(access: OrganisationAccess, id: string, input: NoteInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mine(uow, access, id);
      await this.addWorkNote(uow, work, input);
      return this.workOrderDetail(uow, id);
    });
  }

  recordMyCost(access: OrganisationAccess, id: string, input: CostInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const work = await this.mine(uow, access, id);
      await this.addCost(uow, work, input);
      return this.workOrderDetail(uow, id);
    });
  }

  // ------------------------------------------------------------------ shared

  private async workOrderDetail(uow: MaintenanceUnitOfWork, id: string) {
    const workOrder = await this.mustFindWorkOrder(uow, id);
    const [costs, events, attachments, property] = await Promise.all([
      uow.costs(id),
      uow.events({ workOrderId: id }),
      uow.attachments({ workOrderId: id }),
      uow.property(),
    ]);
    return { workOrder, costs, events, attachments, currency: property.currency };
  }

  /** Work assigned to the caller; anyone else's work does not exist for them (404). */
  private async mine(uow: MaintenanceUnitOfWork, access: OrganisationAccess, id: string) {
    const work = await uow.workOrder(id);
    if (!work || work.assignedToUserId !== access.userId) throw notFound('Work order');
    return work;
  }

  private async addWorkNote(uow: MaintenanceUnitOfWork, work: WorkOrderRecord, input: NoteInput) {
    if (input.visibility === 'RESIDENT' && !work.requestId) {
      throw new ApiError(
        422,
        'VALIDATION_FAILED',
        'This work has no request, so there is no resident to tell',
      );
    }
    await uow.addNote({ requestId: null, workOrderId: work.id, ...input });
  }

  private async addCost(uow: MaintenanceUnitOfWork, work: WorkOrderRecord, input: CostInput) {
    if (work.status === 'CANCELLED') throw invalidState('Cancelled work has no costs');
    const property = await uow.property();
    const id = await uow.createCost({
      workOrderId: work.id,
      kind: input.kind,
      description: input.description,
      amountMinor: parseCost(input.amount, property.currency),
      currency: property.currency,
    });
    await uow.audit({
      action: 'maintenance.cost.recorded',
      resourceType: 'work_order_cost',
      resourceId: id,
      metadata: { workOrderId: work.id, kind: input.kind },
    });
  }

  private async moveRequest(
    access: OrganisationAccess,
    id: string,
    to: RequestStatus,
    note: string | null,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const request = await this.mustFindRequest(uow, id);
      this.requireRequestMove(request, to);
      await uow.updateRequest(id, { status: to, statusNote: note });
      await this.auditRequest(uow, id, to.toLowerCase());
      if (to === 'REJECTED') await this.tellRequester(uow, access, id, 'rejected');
      return this.mustFindRequest(uow, id);
    });
  }

  private requireRequestMove(request: RequestRecord, to: RequestStatus) {
    if (!canMoveRequest(request.status, to)) {
      throw invalidState(
        `A request that is ${request.status.toLowerCase()} cannot become ${to.toLowerCase()}`,
      );
    }
  }

  private async requireAssignable(access: OrganisationAccess, userId: string) {
    const allowed = await this.accessControl.holdsPropertyPermission(
      userId,
      access.organisationId,
      this.propertyOf(access),
      'property.maintenance.work',
    );
    if (!allowed) throw new AssigneeNotAllowed();
  }

  private async requireActivePlace(
    uow: MaintenanceUnitOfWork,
    unitId: string | null,
    commonAreaId: string | null,
  ) {
    const place = unitId ? await uow.unit(unitId) : await uow.commonArea(commonAreaId ?? '');
    if (!place) throw notFound(unitId ? 'Unit' : 'Common area');
    if (place.status !== 'ACTIVE') {
      throw new ApiError(409, 'ARCHIVED', 'This place is archived');
    }
  }

  private async mustFindRequest(uow: MaintenanceUnitOfWork, id: string) {
    const request = await uow.request(id);
    if (!request) throw notFound('Maintenance request');
    return request;
  }

  private async mustFindWorkOrder(uow: MaintenanceUnitOfWork, id: string) {
    const work = await uow.workOrder(id);
    if (!work) throw notFound('Work order');
    return work;
  }

  /** Tells whoever raised the request what the property team did (in-app and email). */
  private async tellRequester(
    uow: MaintenanceUnitOfWork,
    access: OrganisationAccess,
    id: string,
    what: 'accepted' | 'resolved' | 'rejected',
  ) {
    const r = await this.mustFindRequest(uow, id);
    if (r.submittedByUserId === access.userId) return;
    const property = this.propertyOf(access);
    const text = {
      accepted: ['Your request is in hand', `The property team accepted "${r.title}".`],
      resolved: [
        'Please confirm the work is done',
        `The work on "${r.title}" is done. Confirm it, or reopen it if not.`,
      ],
      rejected: [
        'Your request was declined',
        `"${r.title}" was declined: ${r.statusNote ?? ''}`.trim(),
      ],
    }[what];
    await this.notifications.notifyWithin(uow.transaction(), access.organisationId, [
      {
        userId: r.submittedByUserId,
        propertyId: property,
        kind: `maintenance.request.${what}`,
        title: text[0] as string,
        body: (text[1] as string).slice(0, 2000),
        link: r.unitId
          ? `/organisations/${access.organisationId}/properties/${property}/units/${r.unitId}/maintenance/${id}`
          : null,
        urgent: false,
        email: true,
      },
    ]);
  }

  private auditRequest(uow: MaintenanceUnitOfWork, id: string, what: string) {
    return uow.audit({
      action: `maintenance.request.${what}`,
      resourceType: 'maintenance_request',
      resourceId: id,
    });
  }

  private auditWork(uow: MaintenanceUnitOfWork, id: string, what: string) {
    return uow.audit({
      action: `maintenance.work_order.${what}`,
      resourceType: 'work_order',
      resourceId: id,
    });
  }

  private propertyOf(access: OrganisationAccess): string {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: MaintenanceUnitOfWork) => Promise<T>,
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
      // A CHECK or trigger refused: something changed between our check and the write.
      if (databaseErrorCode(error) === '23514') {
        throw invalidState('This change is not possible any more. Reload and try again.');
      }
      throw error;
    }
  }
}
