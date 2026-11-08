import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { IdentityModule } from './modules/identity/identity.module';
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
      imports: [ConfigModule.forRoot(env), InfrastructureModule, IdentityModule],
      controllers: [HealthController],
      providers: [HealthService, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
