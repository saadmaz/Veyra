import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { CommunicationsModule } from '../communications/communications.module';
import { FinanceModule } from '../finance/finance.module';
import { FacilitiesService } from './application/facilities.service';
import { FACILITY_REPOSITORY } from './application/facility-ports';
import { PrismaFacilityRepository } from './infrastructure/prisma-facility.repository';
import { FacilitiesController } from './presentation/facilities.controller';
import { UnitFacilitiesController } from './presentation/unit-facilities.controller';

/**
 * Facilities and reservations (Phase 8): facility setup, opening hours and closures,
 * availability in the property's time zone, residents' bookings and staff decisions. Owns the
 * facility tables.
 */
@Module({
  imports: [AccessControlModule, FinanceModule, CommunicationsModule],
  controllers: [FacilitiesController, UnitFacilitiesController],
  providers: [
    FacilitiesService,
    { provide: FACILITY_REPOSITORY, useClass: PrismaFacilityRepository },
  ],
})
export class FacilitiesModule {}
