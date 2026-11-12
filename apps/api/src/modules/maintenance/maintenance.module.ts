import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { CommunicationsModule } from '../communications/communications.module';
import { VendorsModule } from '../vendors/vendors.module';
import { ASSET_REPOSITORY } from './application/asset-ports';
import { AssetsService } from './application/assets.service';
import { AttachmentsService } from './application/attachments.service';
import { MaintenanceService } from './application/maintenance.service';
import { MAINTENANCE_REPOSITORY } from './application/maintenance-ports';
import { ResidentMaintenanceService } from './application/resident-maintenance.service';
import { PrismaAssetRepository } from './infrastructure/prisma-asset.repository';
import { PrismaMaintenanceRepository } from './infrastructure/prisma-maintenance.repository';
import { AssetsController } from './presentation/assets.controller';
import { MaintenanceController } from './presentation/maintenance.controller';
import { UnitMaintenanceController } from './presentation/unit-maintenance.controller';

/**
 * Maintenance and work orders (Phase 7): residents' requests, staff triage and work orders,
 * technicians' own work, costs for reporting, and the database-written history. Owns the
 * maintenance tables.
 */
@Module({
  imports: [AccessControlModule, VendorsModule, CommunicationsModule],
  controllers: [MaintenanceController, UnitMaintenanceController, AssetsController],
  providers: [
    MaintenanceService,
    ResidentMaintenanceService,
    AttachmentsService,
    { provide: MAINTENANCE_REPOSITORY, useClass: PrismaMaintenanceRepository },
    AssetsService,
    { provide: ASSET_REPOSITORY, useClass: PrismaAssetRepository },
  ],
})
export class MaintenanceModule {}
