import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { RESIDENTS_REPOSITORY, ResidentsService } from './application/residents.service';
import { PrismaResidentsRepository } from './infrastructure/prisma-residents.repository';
import { ResidentsController } from './presentation/residents.controller';

/**
 * Residents (Phase 4): resident profiles and their relations to units. Part 2 provides the
 * resident-facing read side; staff-side management of people, ownerships and tenancies follows
 * in Part 3.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [ResidentsController],
  providers: [
    ResidentsService,
    { provide: RESIDENTS_REPOSITORY, useClass: PrismaResidentsRepository },
  ],
})
export class ResidentsModule {}
