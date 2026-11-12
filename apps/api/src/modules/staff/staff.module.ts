import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { CHECKLIST_REPOSITORY } from './application/checklist-ports';
import { ChecklistsService } from './application/checklists.service';
import { StaffService } from './application/staff.service';
import { STAFF_REPOSITORY } from './application/staff-ports';
import { PrismaChecklistRepository } from './infrastructure/prisma-checklist.repository';
import { PrismaStaffRepository } from './infrastructure/prisma-staff.repository';
import { ChecklistsController } from './presentation/checklists.controller';
import { StaffController } from './presentation/staff.controller';

/**
 * Staff operations (Phase 9): departments, members, shifts and handovers. Owns the department and
 * shift tables.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [StaffController, ChecklistsController],
  providers: [
    StaffService,
    { provide: STAFF_REPOSITORY, useClass: PrismaStaffRepository },
    ChecklistsService,
    { provide: CHECKLIST_REPOSITORY, useClass: PrismaChecklistRepository },
  ],
})
export class StaffModule {}
