import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import {
  type AnnouncementStatus,
  type DraftInput,
  reachesResidents,
  reachesStaff,
  type UpdateDraftInput,
} from '../domain/announcement-rules';
import {
  ANNOUNCEMENT_REPOSITORY,
  type AnnouncementRepository,
  type AnnouncementUnitOfWork,
} from './announcement-ports';
import { NotificationsService } from './notifications.service';

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Announcement not found');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);

/**
 * Announcements (Phase 10 Part 1). Managers (property.announcement.manage) draft, publish and
 * withdraw them; publishing delivers a copy to every person in the audience at that moment:
 * residents living there today with a login, and people working at the property (anyone holding
 * property.profile.read there). Anyone signed in reads their own inbox in an organisation, marks
 * copies read and acknowledges those that ask for it.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    @Inject(ANNOUNCEMENT_REPOSITORY) private readonly repository: AnnouncementRepository,
    private readonly accessControl: AccessControlService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  list(access: OrganisationAccess, status: AnnouncementStatus | undefined, meta: RequestMeta) {
    return this.run(access.organisationId, access.userId, meta, (uow) =>
      uow.announcements(this.propertyOf(access), status),
    );
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access.organisationId, access.userId, meta, async (uow) => {
      const announcement = await this.mustFind(uow, access, id);
      return { announcement, recipients: await uow.recipients(id) };
    });
  }

  createDraft(access: OrganisationAccess, input: DraftInput, meta: RequestMeta) {
    return this.run(access.organisationId, access.userId, meta, async (uow) => {
      const propertyId = this.propertyOf(access);
      if (input.buildingId) await this.requireBuilding(uow, propertyId, input.buildingId);
      const id = await uow.createDraft(propertyId, {
        title: input.title,
        body: input.body,
        priority: input.priority,
        audience: input.audience,
        buildingId: input.audience === 'BUILDING_RESIDENTS' ? (input.buildingId ?? null) : null,
        requiresAcknowledgement: input.requiresAcknowledgement,
      });
      await uow.audit({ action: 'announcement.drafted', propertyId, resourceId: id });
      return { announcement: await this.mustFind(uow, access, id), recipients: [] };
    });
  }

  updateDraft(access: OrganisationAccess, id: string, input: UpdateDraftInput, meta: RequestMeta) {
    return this.run(access.organisationId, access.userId, meta, async (uow) => {
      const propertyId = this.propertyOf(access);
      const current = await this.mustFind(uow, access, id);
      if (current.status !== 'DRAFT') throw invalidState('A published announcement never changes');
      if (input.buildingId) await this.requireBuilding(uow, propertyId, input.buildingId);
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      if (input.audience && input.audience !== 'BUILDING_RESIDENTS') patch.buildingId = null;
      await uow.updateDraft(propertyId, id, patch);
      return { announcement: await this.mustFind(uow, access, id), recipients: [] };
    });
  }

  /** Publishes and delivers to the audience as it is now. */
  publish(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access.organisationId, access.userId, meta, async (uow) => {
      const propertyId = this.propertyOf(access);
      const announcement = await this.mustFind(uow, access, id);
      if (announcement.status !== 'DRAFT')
        throw invalidState('This announcement is already published');
      const audience = new Set<string>();
      if (reachesResidents(announcement.audience)) {
        const building =
          announcement.audience === 'BUILDING_RESIDENTS' ? announcement.buildingId : null;
        for (const u of await uow.residentUsers(propertyId, building)) audience.add(u);
      }
      if (reachesStaff(announcement.audience)) {
        const staff = await this.accessControl.usersWithPropertyPermission(
          access.organisationId,
          propertyId,
          'property.profile.read',
        );
        for (const s of staff) audience.add(s.userId);
      }
      await uow.setStatus(propertyId, id, 'PUBLISHED', null);
      const delivered = await uow.deliver(propertyId, id, [...audience]);
      // An emergency broadcast also goes out by email (and stands out in the feed).
      if (announcement.priority === 'URGENT') {
        await this.notifications.notifyWithin(
          uow.transaction(),
          access.organisationId,
          [...audience].map((userId) => ({
            userId,
            propertyId,
            kind: 'announcement.urgent',
            title: announcement.title,
            body: announcement.body.slice(0, 2000),
            link: `/organisations/${access.organisationId}/inbox`,
            urgent: true,
            email: true,
          })),
        );
      }
      await uow.audit({
        action: 'announcement.published',
        propertyId,
        resourceId: id,
        metadata: {
          audience: announcement.audience,
          recipients: delivered,
          urgent: announcement.priority === 'URGENT',
        },
      });
      return {
        announcement: await this.mustFind(uow, access, id),
        recipients: await uow.recipients(id),
      };
    });
  }

  withdraw(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.run(access.organisationId, access.userId, meta, async (uow) => {
      const propertyId = this.propertyOf(access);
      const announcement = await this.mustFind(uow, access, id);
      if (announcement.status !== 'PUBLISHED')
        throw invalidState('Only a published announcement can be withdrawn');
      await uow.setStatus(propertyId, id, 'WITHDRAWN', reason);
      await uow.audit({ action: 'announcement.withdrawn', propertyId, resourceId: id });
      return {
        announcement: await this.mustFind(uow, access, id),
        recipients: await uow.recipients(id),
      };
    });
  }

  // ------------------------------------------------------------------ the caller's inbox

  inbox(organisationId: string, userId: string, meta: RequestMeta) {
    return this.run(organisationId, userId, meta, (uow) => uow.inbox(userId, 200));
  }

  read(organisationId: string, userId: string, id: string, meta: RequestMeta) {
    return this.run(organisationId, userId, meta, async (uow) => {
      if (!(await uow.inboxItem(userId, id))) throw notFound();
      await uow.markRead(userId, id);
      return uow.inboxItem(userId, id);
    });
  }

  acknowledge(organisationId: string, userId: string, id: string, meta: RequestMeta) {
    return this.run(organisationId, userId, meta, async (uow) => {
      const item = await uow.inboxItem(userId, id);
      if (!item) throw notFound();
      if (!item.announcement.requiresAcknowledgement) {
        throw invalidState('This announcement does not ask for acknowledgement');
      }
      await uow.acknowledge(userId, id);
      return uow.inboxItem(userId, id);
    });
  }

  // ------------------------------------------------------------------ shared

  private async mustFind(uow: AnnouncementUnitOfWork, access: OrganisationAccess, id: string) {
    const announcement = await uow.announcement(this.propertyOf(access), id);
    if (!announcement) throw notFound();
    return announcement;
  }

  private async requireBuilding(uow: AnnouncementUnitOfWork, propertyId: string, id: string) {
    const building = await uow.building(propertyId, id);
    if (building?.status !== 'ACTIVE') {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose an active building of this property');
    }
  }

  private propertyOf(access: OrganisationAccess) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async run<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: AnnouncementUnitOfWork) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.repository.inOrganisation(organisationId, userId, meta, work);
    } catch (error) {
      if (databaseErrorCode(error) === '23514') {
        throw invalidState('This change is not possible any more. Reload and try again.');
      }
      throw error;
    }
  }
}
