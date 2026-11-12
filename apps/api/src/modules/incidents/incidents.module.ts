import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { CommunicationsModule } from '../communications/communications.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { INCIDENT_REPOSITORY } from './application/incident-ports';
import { IncidentsService } from './application/incidents.service';
import { PrismaIncidentRepository } from './infrastructure/prisma-incident.repository';
import { IncidentsController } from './presentation/incidents.controller';

/**
 * Incidents (Phase 11): reports, their timeline and follow-up actions, escalation contacts.
 * Owns the incident tables; alerts managers through communications.
 */
@Module({
  imports: [AccessControlModule, CommunicationsModule, IntegrationsModule],
  controllers: [IncidentsController],
  providers: [
    IncidentsService,
    { provide: INCIDENT_REPOSITORY, useClass: PrismaIncidentRepository },
  ],
})
export class IncidentsModule {}
