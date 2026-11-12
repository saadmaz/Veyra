import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { IdentityModule } from '../identity/identity.module';
import { ANNOUNCEMENT_REPOSITORY } from './application/announcement-ports';
import { AnnouncementsService } from './application/announcements.service';
import { NOTIFICATION_STORE } from './application/notification-ports';
import { NotificationsService } from './application/notifications.service';
import { PrismaAnnouncementRepository } from './infrastructure/prisma-announcement.repository';
import { PrismaNotificationStore } from './infrastructure/prisma-notification.store';
import { AnnouncementsController, InboxController } from './presentation/announcements.controller';
import {
  DeliveriesController,
  NotificationsController,
} from './presentation/notifications.controller';

/**
 * Communications (Phase 10): announcements, their delivery to inboxes, reads and
 * acknowledgements. Owns the announcement tables.
 */
@Module({
  imports: [AccessControlModule, IdentityModule],
  controllers: [
    AnnouncementsController,
    InboxController,
    NotificationsController,
    DeliveriesController,
  ],
  providers: [
    AnnouncementsService,
    { provide: ANNOUNCEMENT_REPOSITORY, useClass: PrismaAnnouncementRepository },
    NotificationsService,
    { provide: NOTIFICATION_STORE, useClass: PrismaNotificationStore },
  ],
  exports: [NotificationsService],
})
export class CommunicationsModule {}
