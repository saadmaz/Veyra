import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AttachmentsService } from './application/attachments.service';
import { MaintenanceService } from './application/maintenance.service';
import { MAINTENANCE_REPOSITORY } from './application/maintenance-ports';
import { ResidentMaintenanceService } from './application/resident-maintenance.service';
import { PrismaMaintenanceRepository } from './infrastructure/prisma-maintenance.repository';
import { MaintenanceController } from './presentation/maintenance.controller';
import { UnitMaintenanceController } from './presentation/unit-maintenance.controller';

/**
 * Maintenance and work orders (Phase 7): residents' requests, staff triage and work orders,
 * technicians' own work, costs for reporting, and the database-written history. Owns the
 * maintenance tables.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [MaintenanceController, UnitMaintenanceController],
  providers: [
    MaintenanceService,
    ResidentMaintenanceService,
    AttachmentsService,
    { provide: MAINTENANCE_REPOSITORY, useClass: PrismaMaintenanceRepository },
  ],
})
export class MaintenanceModule {}
