import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  canMoveRequest,
  isLiveWork,
  type RequestStatus,
  type ResidentRequestInput,
} from '../domain/maintenance-rules';
import {
  MAINTENANCE_REPOSITORY,
  type MaintenanceRepository,
  type MaintenanceUnitOfWork,
  type RequestRecord,
} from './maintenance-ports';

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Maintenance request not found');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);
const residentsOnly = () =>
  new ApiError(403, 'FORBIDDEN', 'Only residents of the unit can confirm or reopen a request');

/**
 * A unit's maintenance requests as its residents see them (Phase 7 Part 2): owners, tenants and
 * household members raise them (owner decision, 2026-11-11), follow their resident-visible
 * history, add notes, confirm the work or reopen it. Work orders, internal notes, costs and who
 * is assigned stay with staff. Staff holding unit.maintenance.request can raise and read here on
 * a resident's behalf, but only a resident confirms or reopens, and only the requester (or staff
 * on the property routes) cancels.
 */
@Injectable()
export class ResidentMaintenanceService {
  constructor(@Inject(MAINTENANCE_REPOSITORY) private readonly repository: MaintenanceRepository) {}

  list(access: OrganisationAccess, meta: RequestMeta) {
    return this.inUnit(access, meta, (uow, unitId) => uow.requests({ unitId }));
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inUnit(access, meta, (uow, unitId) => this.view(uow, unitId, id));
  }

  create(access: OrganisationAccess, input: ResidentRequestInput, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      const unit = await uow.unit(unitId);
      if (unit?.status !== 'ACTIVE') {
        throw new ApiError(409, 'ARCHIVED', 'This unit is archived');
      }
      const id = await uow.createRequest({
        unitId,
        commonAreaId: null,
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
        metadata: { byStaff: false, priority: input.priority },
      });
      return this.view(uow, unitId, id);
    });
  }

  /** The requester withdraws it before the work is done. */
  cancel(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      const request = await this.mustFind(uow, unitId, id);
      if (request.submittedByUserId !== access.userId) {
        throw new ApiError(403, 'NOT_REQUESTER', 'Only the person who raised it can cancel it');
      }
      this.requireMove(request, 'CANCELLED');
      const work = await uow.workOrders({ requestId: id });
      if (work.some((w) => isLiveWork(w.status))) {
        throw invalidState('Work has already started. Ask the property team to cancel it.');
      }
      await uow.updateRequest(id, { status: 'CANCELLED', statusNote: reason });
      await this.audit(uow, id, 'cancelled');
      return this.view(uow, unitId, id);
    });
  }

  /** The work is done to the resident's satisfaction. */
  confirm(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      if (!(await uow.callerIsResidentOf(unitId))) throw residentsOnly();
      const request = await this.mustFind(uow, unitId, id);
      this.requireMove(request, 'CLOSED');
      await uow.updateRequest(id, { status: 'CLOSED' });
      await this.audit(uow, id, 'confirmed');
      return this.view(uow, unitId, id);
    });
  }

  /** The problem is not fixed: back to the property team, with a reason. */
  reopen(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      if (!(await uow.callerIsResidentOf(unitId))) throw residentsOnly();
      const request = await this.mustFind(uow, unitId, id);
      if (request.status !== 'RESOLVED') {
        throw invalidState('Only a resolved request can be reopened');
      }
      await uow.updateRequest(id, { status: 'ACCEPTED', statusNote: reason });
      await this.audit(uow, id, 'reopened');
      return this.view(uow, unitId, id);
    });
  }

  addNote(access: OrganisationAccess, id: string, body: string, meta: RequestMeta) {
    return this.inUnit(access, meta, async (uow, unitId) => {
      const request = await this.mustFind(uow, unitId, id);
      if (['CLOSED', 'REJECTED', 'CANCELLED'].includes(request.status)) {
        throw invalidState('This request is finished; raise a new one');
      }
      await uow.addNote({ requestId: id, workOrderId: null, visibility: 'RESIDENT', body });
      return this.view(uow, unitId, id);
    });
  }

  // ------------------------------------------------------------------ shared

  /** The request with its resident-visible history only. */
  private async view(uow: MaintenanceUnitOfWork, unitId: string, id: string) {
    const request = await this.mustFind(uow, unitId, id);
    const [events, attachments] = await Promise.all([
      uow.events({ requestId: id }, 'RESIDENT'),
      uow.attachments({ requestId: id }),
    ]);
    return {
      request,
      events,
      attachments: attachments.filter((a) => a.status === 'READY' && a.visibility === 'RESIDENT'),
    };
  }

  private async mustFind(
    uow: MaintenanceUnitOfWork,
    unitId: string,
    id: string,
  ): Promise<RequestRecord> {
    const request = await uow.request(id);
    if (!request || request.unitId !== unitId) throw notFound();
    return request;
  }

  private requireMove(request: RequestRecord, to: RequestStatus) {
    if (!canMoveRequest(request.status, to)) {
      throw invalidState(
        `A request that is ${request.status.toLowerCase()} cannot become ${to.toLowerCase()}`,
      );
    }
  }

  private audit(uow: MaintenanceUnitOfWork, id: string, what: string) {
    return uow.audit({
      action: `maintenance.request.${what}`,
      resourceType: 'maintenance_request',
      resourceId: id,
    });
  }

  private async inUnit<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: MaintenanceUnitOfWork, unitId: string) => Promise<T>,
  ): Promise<T> {
    const { propertyId, unitId } = access;
    if (!propertyId || !unitId) throw new Error('Unit route without a resolved property and unit');
    try {
      return await this.repository.inProperty(
        access.organisationId,
        propertyId,
        access.userId,
        meta,
        (uow) => work(uow, unitId),
      );
    } catch (error) {
      if (databaseErrorCode(error) === '23514') {
        throw invalidState('This change is not possible any more. Reload and try again.');
      }
      throw error;
    }
  }
}
