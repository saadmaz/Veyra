import { Module } from '@nestjs/common';
import { IDENTITY_PROVIDER } from './application/identity-provider';
import { PasswordAuthService } from './application/password-auth.service';
import { IDENTITY_REPOSITORY, PASSWORD_HASHER } from './application/ports';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { PrismaIdentityRepository } from './infrastructure/prisma-identity.repository';
import { AuthController } from './presentation/auth.controller';
import { AuthGuard } from './presentation/auth.guard';

/**
 * Authentication (ADR 0005). Other modules use only IDENTITY_PROVIDER, the route-access
 * decorators and @CurrentPrincipal(); they never read credentials or sessions directly.
 * AuthGuard is registered globally by AppModule, before the permission guard.
 */
@Module({
  controllers: [AuthController],
  providers: [
    PasswordAuthService,
    AuthGuard,
    { provide: IDENTITY_PROVIDER, useExisting: PasswordAuthService },
    { provide: IDENTITY_REPOSITORY, useClass: PrismaIdentityRepository },
    { provide: PASSWORD_HASHER, useFactory: () => new Argon2PasswordHasher() },
  ],
  exports: [IDENTITY_PROVIDER, AuthGuard],
})
export class IdentityModule {}
