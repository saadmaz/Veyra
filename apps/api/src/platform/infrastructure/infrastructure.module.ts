import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDbClient, type DbClient } from '@veyra/db';
import { Redis } from 'ioredis';
import { API_ENV, type ApiEnv } from '../config/env';
import { HEALTH_CHECKS, type HealthCheck } from '../health/health.service';

export const DB_CLIENT = Symbol('DB_CLIENT');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Owns connections to PostgreSQL and Redis and registers their readiness checks.
 * Connections are lazy so the process boots (and reports "not ready") even when a
 * dependency is down, instead of crash-looping.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): DbClient => createDbClient(env.DATABASE_URL),
    },
    {
      provide: REDIS_CLIENT,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Redis => {
        const logger = new Logger('Redis');
        const redis = new Redis(env.REDIS_URL, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });
        redis.on('error', (error: Error) => logger.warn(`Redis error: ${error.message}`));
        redis.connect().catch(() => {
          // Reconnection is automatic; readiness reports "down" until it succeeds.
        });
        return redis;
      },
    },
    {
      provide: HEALTH_CHECKS,
      inject: [DB_CLIENT, REDIS_CLIENT],
      useFactory: (db: DbClient, redis: Redis): HealthCheck[] => [
        {
          name: 'database',
          check: async () => {
            await db.$queryRaw`SELECT 1`;
          },
        },
        {
          name: 'redis',
          check: async () => {
            if ((await redis.ping()) !== 'PONG') throw new Error('Unexpected PING reply');
          },
        },
      ],
    },
  ],
  exports: [DB_CLIENT, REDIS_CLIENT, HEALTH_CHECKS],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.db.$disconnect(), this.redis.quit()]);
  }
}
