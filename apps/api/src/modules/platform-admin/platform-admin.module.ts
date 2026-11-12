import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';

/** Platform administration (Phase 13): VEYRA staff managing organisations and plans. */
@Module({
  imports: [IdentityModule],
  controllers: [PlatformAdminController],
  providers: [PlatformAdminService],
})
export class PlatformAdminModule {}
