import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { VISITORS_REPOSITORY } from './application/visitor-ports';
import { VisitorsService } from './application/visitors.service';
import { PrismaVisitorsRepository } from './infrastructure/prisma-visitors.repository';
import { VisitorsController } from './presentation/visitors.controller';

/**
 * Visitors and access (Phase 5): visitor invitations and passes, the gate (validate, admit,
 * deny, walk-ins, departures) and the visit log. Owns visitor_invitations, visitor_passes,
 * visits and access_events.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [VisitorsController],
  providers: [
    VisitorsService,
    { provide: VISITORS_REPOSITORY, useClass: PrismaVisitorsRepository },
  ],
})
export class VisitorsModule {}
