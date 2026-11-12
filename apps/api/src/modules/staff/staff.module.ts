import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { StaffService } from './application/staff.service';
import { STAFF_REPOSITORY } from './application/staff-ports';
import { PrismaStaffRepository } from './infrastructure/prisma-staff.repository';
import { StaffController } from './presentation/staff.controller';

/**
 * Staff operations (Phase 9): departments, members, shifts and handovers. Owns the department and
 * shift tables.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [StaffController],
  providers: [StaffService, { provide: STAFF_REPOSITORY, useClass: PrismaStaffRepository }],
})
export class StaffModule {}
