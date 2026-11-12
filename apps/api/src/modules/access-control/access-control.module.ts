import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MfaPolicy } from '../../platform/auth/mfa-policy';
import { AccessControlService, GRANT_REPOSITORY } from './application/access-control.service';
import { PrismaGrantRepository } from './infrastructure/prisma-grant.repository';
import { PermissionGuard } from './presentation/permission.guard';
import { RouteAccessVerifier } from './presentation/route-access.verifier';

/**
 * Roles, permissions and policy evaluation (docs/security/ACCESS_CONTROL.md). Other modules use
 * @RequirePermission / @CurrentAccess, the domain policy functions and AccessControlService.
 * PermissionGuard is registered globally by AppModule, after the authentication guard.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    AccessControlService,
    PermissionGuard,
    RouteAccessVerifier,
    MfaPolicy,
    { provide: GRANT_REPOSITORY, useClass: PrismaGrantRepository },
  ],
  exports: [AccessControlService, PermissionGuard, MfaPolicy],
})
export class AccessControlModule {}
