import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { IdentityModule } from '../identity/identity.module';
import { ANNOUNCEMENT_REPOSITORY } from './application/announcement-ports';
import { AnnouncementsService } from './application/announcements.service';
import { PrismaAnnouncementRepository } from './infrastructure/prisma-announcement.repository';
import { AnnouncementsController, InboxController } from './presentation/announcements.controller';

/**
 * Communications (Phase 10): announcements, their delivery to inboxes, reads and
 * acknowledgements. Owns the announcement tables.
 */
@Module({
  imports: [AccessControlModule, IdentityModule],
  controllers: [AnnouncementsController, InboxController],
  providers: [
    AnnouncementsService,
    { provide: ANNOUNCEMENT_REPOSITORY, useClass: PrismaAnnouncementRepository },
  ],
})
export class CommunicationsModule {}
