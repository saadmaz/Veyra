import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { RESIDENTS_REPOSITORY, ResidentsService } from './application/residents.service';
import { ResidentsStaffService } from './application/residents-staff.service';
import { RESIDENTS_STAFF_REPOSITORY } from './application/staff-ports';
import { PrismaResidentsRepository } from './infrastructure/prisma-residents.repository';
import { PrismaResidentsStaffRepository } from './infrastructure/prisma-residents-staff.repository';
import { ResidentsController } from './presentation/residents.controller';
import { ResidentsStaffController } from './presentation/residents-staff.controller';

/**
 * Residents (Phase 4): resident profiles and their relations to units. ResidentsController is
 * the resident-facing read side (derived access); ResidentsStaffController is staff management
 * (profiles, ownership, tenancies, household, vehicles, emergency contacts).
 */
@Module({
  imports: [AccessControlModule],
  controllers: [ResidentsController, ResidentsStaffController],
  providers: [
    ResidentsService,
    ResidentsStaffService,
    { provide: RESIDENTS_REPOSITORY, useClass: PrismaResidentsRepository },
    { provide: RESIDENTS_STAFF_REPOSITORY, useClass: PrismaResidentsStaffRepository },
  ],
})
export class ResidentsModule {}
