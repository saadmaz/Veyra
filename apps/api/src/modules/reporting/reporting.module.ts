import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { ReportingService } from './application/reporting.service';
import { REPORTING_REPOSITORY } from './application/reporting-ports';
import { PrismaReportingRepository } from './infrastructure/prisma-reporting.repository';
import { ReportingController } from './presentation/reporting.controller';

/**
 * Reporting (Phase 12): role-scoped read models over the other modules' tables. Read-only; owns
 * no tables.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [ReportingController],
  providers: [
    ReportingService,
    { provide: REPORTING_REPOSITORY, useClass: PrismaReportingRepository },
  ],
})
export class ReportingModule {}
