import { Module } from '@nestjs/common';
import { API_ENV, type ApiEnv } from '../../platform/config/env';
import {
  ACCOUNT_MAILER,
  ACCOUNT_STORE,
  AccountService,
  CONSOLE_BASE_URL,
} from './application/account.service';
import { IDENTITY_PROVIDER } from './application/identity-provider';
import { PasswordAuthService } from './application/password-auth.service';
import { IDENTITY_REPOSITORY, PASSWORD_HASHER } from './application/ports';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { LogAccountMailer, PrismaAccountStore } from './infrastructure/prisma-account.store';
import { PrismaIdentityRepository } from './infrastructure/prisma-identity.repository';
import { AccountController } from './presentation/account.controller';
import { AuthController } from './presentation/auth.controller';
import { AuthGuard } from './presentation/auth.guard';
/**
 * Authentication (ADR 0005). Other modules use only IDENTITY_PROVIDER, the route-access
 * decorators and @CurrentPrincipal(); they never read credentials or sessions directly.
 * AuthGuard is registered globally by AppModule, before the permission guard.
 */
@Module({
  controllers: [AuthController, AccountController],
  providers: [
    PasswordAuthService,
    AuthGuard,
    { provide: IDENTITY_PROVIDER, useExisting: PasswordAuthService },
    { provide: IDENTITY_REPOSITORY, useClass: PrismaIdentityRepository },
    { provide: PASSWORD_HASHER, useFactory: () => new Argon2PasswordHasher() },
    AccountService,
    { provide: ACCOUNT_STORE, useClass: PrismaAccountStore },
    // Only a logging mailer exists until an email provider is chosen (as for notifications).
    {
      provide: ACCOUNT_MAILER,
      useFactory: (env: ApiEnv) => new LogAccountMailer(env.NODE_ENV === 'development'),
      inject: [API_ENV],
    },
    {
      provide: CONSOLE_BASE_URL,
      useFactory: (env: ApiEnv) => env.CONSOLE_URL.replace(/\/$/, ''),
      inject: [API_ENV],
    },
  ],
  exports: [IDENTITY_PROVIDER, AuthGuard],
})
export class IdentityModule {}
