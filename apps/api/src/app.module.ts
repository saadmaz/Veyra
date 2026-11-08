import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccessControlModule } from './modules/access-control/access-control.module';
import { PermissionGuard } from './modules/access-control/presentation/permission.guard';
import { IdentityModule } from './modules/identity/identity.module';
import { AuthGuard } from './modules/identity/presentation/auth.guard';
import { OrganisationsModule } from './modules/organisations/organisations.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { ConfigModule } from './platform/config/config.module';
import type { ApiEnv } from './platform/config/env';
import { ApiExceptionFilter } from './platform/errors/api-exception.filter';
import { HealthController } from './platform/health/health.controller';
import { HealthService } from './platform/health/health.service';
import { InfrastructureModule } from './platform/infrastructure/infrastructure.module';
import { RequestIdMiddleware } from './platform/request-id/request-id.middleware';

@Module({})
export class AppModule implements NestModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        InfrastructureModule,
        IdentityModule,
        AccessControlModule,
        OrganisationsModule,
        PropertiesModule,
      ],
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        // Global guards run in this order: authenticate, then authorise. Both deny by default.
        { provide: APP_GUARD, useExisting: AuthGuard },
        { provide: APP_GUARD, useExisting: PermissionGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
