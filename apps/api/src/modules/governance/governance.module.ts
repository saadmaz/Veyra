import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { GovernanceService } from './application/governance.service';
import { GOVERNANCE_REPOSITORY } from './application/governance-ports';
import { PrismaGovernanceRepository } from './infrastructure/prisma-governance.repository';
import { GovernanceController } from './presentation/governance.controller';

/** Governance (Phase 11): committees and seats, meetings, minutes and resolutions. */
@Module({
  imports: [AccessControlModule],
  controllers: [GovernanceController],
  providers: [
    GovernanceService,
    { provide: GOVERNANCE_REPOSITORY, useClass: PrismaGovernanceRepository },
  ],
})
export class GovernanceModule {}
