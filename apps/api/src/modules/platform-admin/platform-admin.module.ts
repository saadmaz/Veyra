import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { IdentityModule } from '../identity/identity.module';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';
import {
  OrganisationSupportAccessController,
  PlatformSupportAccessController,
} from './support-access.controller';
import { SupportAccessService } from './support-access.service';

/**
 * Platform administration (Phase 13): VEYRA staff managing organisations and plans, and support
 * access that organisations approve.
 */
@Module({
  imports: [AccessControlModule, IdentityModule],
  controllers: [
    PlatformAdminController,
    PlatformSupportAccessController,
    OrganisationSupportAccessController,
  ],
  providers: [PlatformAdminService, SupportAccessService],
})
export class PlatformAdminModule {}
