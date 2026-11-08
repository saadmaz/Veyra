import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { InvitationsService } from './application/invitations.service';
import { MembershipsService } from './application/memberships.service';
import { OrganisationsService } from './application/organisations.service';
import { ORGANISATIONS_REPOSITORY } from './application/ports';
import { PrismaOrganisationsRepository } from './infrastructure/prisma-organisations.repository';
import {
  InvitationAcceptanceController,
  OrganisationsController,
} from './presentation/organisations.controller';

/**
 * Organisations, memberships and invitations. Owns writes to these tables; access-control reads
 * memberships to evaluate permissions (one-way dependency: organisations -> access-control).
 */
@Module({
  imports: [AccessControlModule],
  controllers: [OrganisationsController, InvitationAcceptanceController],
  providers: [
    OrganisationsService,
    MembershipsService,
    InvitationsService,
    { provide: ORGANISATIONS_REPOSITORY, useClass: PrismaOrganisationsRepository },
  ],
})
export class OrganisationsModule {}
