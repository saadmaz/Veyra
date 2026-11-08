import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IDENTITY_PROVIDER } from './application/identity-provider';
import { PasswordAuthService } from './application/password-auth.service';
import { IDENTITY_REPOSITORY, PASSWORD_HASHER } from './application/ports';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { PrismaIdentityRepository } from './infrastructure/prisma-identity.repository';
import { AuthController } from './presentation/auth.controller';
import { AuthGuard } from './presentation/auth.guard';

/**
 * Authentication (ADR 0005). Other modules use only IDENTITY_PROVIDER, the @Public() decorator
 * and @CurrentPrincipal(); they never read users, credentials or sessions directly.
 */
@Module({
  controllers: [AuthController],
  providers: [
    PasswordAuthService,
    { provide: IDENTITY_PROVIDER, useExisting: PasswordAuthService },
    { provide: IDENTITY_REPOSITORY, useClass: PrismaIdentityRepository },
    { provide: PASSWORD_HASHER, useFactory: () => new Argon2PasswordHasher() },
    // Global and deny-by-default: every route needs a session unless marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [IDENTITY_PROVIDER],
})
export class IdentityModule {}
