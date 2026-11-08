import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { PROPERTIES_REPOSITORY } from './application/ports';
import { PropertiesService } from './application/properties.service';
import { PrismaPropertiesRepository } from './infrastructure/prisma-properties.repository';
import { PropertiesController } from './presentation/properties.controller';

/**
 * Properties and their structure (Phase 3). Depends on access-control for property-scoped
 * authorisation; nothing depends on this module yet.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [PropertiesController],
  providers: [
    PropertiesService,
    { provide: PROPERTIES_REPOSITORY, useClass: PrismaPropertiesRepository },
  ],
})
export class PropertiesModule {}
