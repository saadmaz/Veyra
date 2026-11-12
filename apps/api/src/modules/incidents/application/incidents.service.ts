import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import { NotificationsService } from '../../communications/application/notifications.service';
import {
  type ActionInput,
  alertsManagers,
  type ContactInput,
  canMoveIncident,
  canSeeIncident,
  contactsFor,
  type IncidentCategory,
  type MoveIncidentInput,
  type ReportIncidentInput,
  type UpdateContactInput,
  type UpdateIncidentInput,
} from '../domain/incident-rules';
import {
  INCIDENT_REPOSITORY,
  type IncidentRecord,
  type IncidentRepository,
  type IncidentUnitOfWork,
} from './incident-ports';

const notFound = (what = 'Incident') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);

export interface IncidentDetail {
  incident: IncidentRecord;
  updates: Awaited<ReturnType<IncidentUnitOfWork['updates']>>;
  actions: Awaited<ReturnType<IncidentUnitOfWork['actions']>>;
  contacts: Awaited<ReturnType<IncidentUnitOfWork['contacts']>>;
}

/**
 * Incidents (Phase 11 Part 1). Staff (property.incident.report) report what happened and add
 * notes; managers (property.incident.manage) run the response: severity, sensitivity, status,
 * follow-up actions and escalation contacts. Sensitive incidents are seen only by managers and
 * their reporter. High and critical reports alert the managers at once, in the same commit.
 */
@Injectable()
export class IncidentsService {
  constructor(
    @Inject(INCIDENT_REPOSITORY) private readonly repository: IncidentRepository,
    private readonly accessControl: AccessControlService,
    private readonly notifications: NotificationsService,
  ) {}

  list(access: OrganisationAccess, open: boolean, meta: RequestMeta) {
    return this.run(access, meta, async (uow) =>
      (await uow.incidents({ open })).filter((i) => canSeeIncident(i, this.viewer(access))),
    );
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.load(uow, access, id));
  }

  report(access: OrganisationAccess, input: ReportIncidentInput, meta: RequestMeta) {
    const sensitive = Boolean(input.sensitive);
    return this.run(access, meta, async (uow) => {
      const occurredAt = new Date(input.occurredAt);
      const id = await uow.createIncident({
        category: input.category,
        severity: input.severity,
        title: input.title,
        description: input.description,
        occurredAt,
        unitId: input.unitId ?? null,
        commonAreaId: input.commonAreaId ?? null,
        locationDetail: input.locationDetail ?? null,
        sensitive,
      });
      await uow.audit({
        action: 'incident.reported',
        resourceType: 'incident',
        resourceId: id,
        metadata: { severity: input.severity, category: input.category, sensitive },
      });
      const incident = await this.mustFind(uow, id);
      if (alertsManagers(input.severity)) await this.alertManagers(uow, access, incident);
      return this.load(uow, access, id);
    });
  }

  update(access: OrganisationAccess, id: string, patch: UpdateIncidentInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const incident = await this.mustFind(uow, id);
      if (incident.status === 'CLOSED') throw invalidState('This incident is closed');
      await uow.updateIncident(id, patch);
      await uow.audit({
        action: 'incident.updated',
        resourceType: 'incident',
        resourceId: id,
        metadata: { fields: Object.keys(patch).sort().join(',') },
      });
      if (patch.severity && alertsManagers(patch.severity) && !alertsManagers(incident.severity)) {
        await this.alertManagers(uow, access, { ...incident, severity: patch.severity });
      }
      return this.load(uow, access, id);
    });
  }

  move(access: OrganisationAccess, id: string, input: MoveIncidentInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const incident = await this.mustFind(uow, id);
      if (!canMoveIncident(incident.status, input.status)) {
        throw invalidState(
          `An incident that is ${incident.status.toLowerCase()} cannot become ${input.status.toLowerCase()}`,
        );
      }
      if (input.status === 'CLOSED' && incident.openActions > 0) {
        throw invalidState('Finish the follow-up actions before closing the incident');
      }
      await uow.updateIncident(id, {
        status: input.status,
        ...(input.status === 'RESOLVED' ? { outcome: input.outcome ?? null } : {}),
      });
      await uow.audit({
        action: `incident.${input.status.toLowerCase()}`,
        resourceType: 'incident',
        resourceId: id,
      });
      return this.load(uow, access, id);
    });
  }

  addNote(access: OrganisationAccess, id: string, body: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const incident = await this.visible(uow, access, id);
      if (incident.status === 'CLOSED') throw invalidState('This incident is closed');
      await uow.addNote(id, body);
      return this.load(uow, access, id);
    });
  }

  async addAction(access: OrganisationAccess, id: string, input: ActionInput, meta: RequestMeta) {
    if (input.assignedToUserId) await this.requireStaff(access, input.assignedToUserId);
    return this.run(access, meta, async (uow) => {
      const incident = await this.mustFind(uow, id);
      if (incident.status === 'CLOSED') throw invalidState('This incident is closed');
      const actionId = await uow.addAction({
        incidentId: id,
        description: input.description,
        assignedToUserId: input.assignedToUserId ?? null,
        dueOn: input.dueOn ?? null,
      });
      await uow.audit({
        action: 'incident.action_added',
        resourceType: 'incident',
        resourceId: id,
        metadata: { actionId },
      });
      return this.load(uow, access, id);
    });
  }

  /** Managers, or the person the action was given to. */
  completeAction(access: OrganisationAccess, id: string, actionId: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      await this.visible(uow, access, id);
      const action = await uow.action(id, actionId);
      if (!action || (!this.manager(access) && action.assignedToUserId !== access.userId)) {
        throw notFound('Action');
      }
      if (action.doneAt) throw invalidState('This action is already done');
      await uow.completeAction(actionId);
      await uow.audit({
        action: 'incident.action_done',
        resourceType: 'incident',
        resourceId: id,
        metadata: { actionId },
      });
      return this.load(uow, access, id);
    });
  }

  /** People who can be given a follow-up action: those who can see the property's incidents. */
  assignees(access: OrganisationAccess) {
    return this.accessControl.usersWithPropertyPermission(
      access.organisationId,
      this.propertyOf(access),
      'property.incident.read',
    );
  }

  contacts(access: OrganisationAccess, category: IncidentCategory | undefined, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const all = await uow.contacts();
      return this.manager(access) && !category ? all : contactsFor(all, category);
    });
  }

  addContact(access: OrganisationAccess, input: ContactInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const id = await uow.createContact(input);
      await uow.audit({
        action: 'escalation_contact.created',
        resourceType: 'escalation_contact',
        resourceId: id,
      });
      return this.mustFindContact(uow, id);
    });
  }

  updateContact(
    access: OrganisationAccess,
    id: string,
    patch: UpdateContactInput,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      await this.mustFindContact(uow, id);
      await uow.updateContact(id, patch);
      await uow.audit({
        action: 'escalation_contact.updated',
        resourceType: 'escalation_contact',
        resourceId: id,
        metadata: { fields: Object.keys(patch).sort().join(',') },
      });
      return this.mustFindContact(uow, id);
    });
  }

  private async load(
    uow: IncidentUnitOfWork,
    access: OrganisationAccess,
    id: string,
  ): Promise<IncidentDetail> {
    const incident = await this.visible(uow, access, id);
    const [updates, actions, contacts] = await Promise.all([
      uow.updates(id),
      uow.actions(id),
      uow.contacts(),
    ]);
    return { incident, updates, actions, contacts: contactsFor(contacts, incident.category) };
  }

  private async alertManagers(
    uow: IncidentUnitOfWork,
    access: OrganisationAccess,
    incident: IncidentRecord,
  ) {
    const property = this.propertyOf(access);
    const managers = await this.accessControl.usersWithPropertyPermission(
      access.organisationId,
      property,
      'property.incident.manage',
    );
    const label = `IN-${String(incident.number).padStart(6, '0')}`;
    await this.notifications.notifyWithin(
      uow.transaction(),
      access.organisationId,
      managers
        .filter((m) => m.userId !== access.userId)
        .map((m) => ({
          userId: m.userId,
          propertyId: property,
          kind: 'incident.reported',
          title: `${incident.severity === 'CRITICAL' ? 'Critical' : 'High'} incident ${label}`,
          // Sensitive incidents name no details outside the console.
          body: incident.sensitive ? 'A sensitive incident was reported.' : incident.title,
          link: `/organisations/${access.organisationId}/properties/${property}/incidents/${incident.id}`,
          urgent: true,
          email: true,
        })),
    );
  }

  private async requireStaff(access: OrganisationAccess, userId: string) {
    const allowed = await this.accessControl.holdsPropertyPermission(
      userId,
      access.organisationId,
      this.propertyOf(access),
      'property.incident.read',
    );
    if (!allowed) {
      throw new ApiError(
        422,
        'ASSIGNEE_NOT_ALLOWED',
        'This person cannot be given incident work here',
      );
    }
  }

  private async visible(uow: IncidentUnitOfWork, access: OrganisationAccess, id: string) {
    const incident = await uow.incident(id);
    if (!incident || !canSeeIncident(incident, this.viewer(access))) throw notFound();
    return incident;
  }

  private async mustFind(uow: IncidentUnitOfWork, id: string) {
    const incident = await uow.incident(id);
    if (!incident) throw notFound();
    return incident;
  }

  private async mustFindContact(uow: IncidentUnitOfWork, id: string) {
    const contact = await uow.contact(id);
    if (!contact) throw notFound('Contact');
    return contact;
  }

  private manager(access: OrganisationAccess) {
    return access.permissions.has('property.incident.manage');
  }

  private viewer(access: OrganisationAccess) {
    return { userId: access.userId, manager: this.manager(access) };
  }

  private propertyOf(access: OrganisationAccess) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: IncidentUnitOfWork) => Promise<T>,
  ) {
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
      if (code === '23503') {
        throw new ApiError(
          422,
          'UNKNOWN_LOCATION',
          'That unit or common area is not at this property',
        );
      }
      if (code === '23514') {
        throw invalidState('This change is not possible. Reload and try again.');
      }
      throw error;
    }
  }
}
