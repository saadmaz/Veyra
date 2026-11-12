import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { CommunicationsModule } from '../communications/communications.module';
import { APPROVAL_REPOSITORY } from './application/approval-ports';
import { ApprovalsService } from './application/approvals.service';
import { GovernanceService } from './application/governance.service';
import { GOVERNANCE_REPOSITORY } from './application/governance-ports';
import { PrismaApprovalRepository } from './infrastructure/prisma-approval.repository';
import { PrismaGovernanceRepository } from './infrastructure/prisma-governance.repository';
import { ApprovalsController } from './presentation/approvals.controller';
import { GovernanceController } from './presentation/governance.controller';

/** Governance (Phase 11): committees and seats, meetings, minutes, resolutions and approvals. */
@Module({
  imports: [AccessControlModule, CommunicationsModule],
  controllers: [GovernanceController, ApprovalsController],
  providers: [
    GovernanceService,
    { provide: GOVERNANCE_REPOSITORY, useClass: PrismaGovernanceRepository },
    ApprovalsService,
    { provide: APPROVAL_REPOSITORY, useClass: PrismaApprovalRepository },
  ],
})
export class GovernanceModule {}
