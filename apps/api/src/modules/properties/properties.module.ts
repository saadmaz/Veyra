import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { PROPERTIES_REPOSITORY } from './application/ports';
import { PropertiesService } from './application/properties.service';
import { StructureService } from './application/structure.service';
import { STRUCTURE_REPOSITORY } from './application/structure-ports';
import { PrismaPropertiesRepository } from './infrastructure/prisma-properties.repository';
import { PrismaStructureRepository } from './infrastructure/prisma-structure.repository';
import { PropertiesController } from './presentation/properties.controller';
import { StructureController } from './presentation/structure.controller';

/**
 * Properties and their structure (Phase 3). Depends on access-control for property-scoped
 * authorisation; nothing depends on this module yet.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [PropertiesController, StructureController],
  providers: [
    PropertiesService,
    StructureService,
    { provide: STRUCTURE_REPOSITORY, useClass: PrismaStructureRepository },
    { provide: PROPERTIES_REPOSITORY, useClass: PrismaPropertiesRepository },
  ],
})
export class PropertiesModule {}
