import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadApiEnv } from './platform/config/env';
import { JsonLogger } from './platform/logging/json-logger';

async function main(): Promise<void> {
  const env = loadApiEnv();
  const app = await NestFactory.create(AppModule.forRoot(env), {
    // Payment provider callbacks are verified against the exact bytes received.
    rawBody: true,
    logger:
      (env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty')) === 'json'
        ? new JsonLogger(
            env.LOG_LEVEL === 'trace' ? 'verbose' : env.LOG_LEVEL === 'debug' ? 'debug' : 'log',
          )
        : env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
          ? ['error', 'warn', 'log', 'debug', 'verbose']
          : ['error', 'warn', 'log'],
  });
  configureApp(app, env);
  await app.listen(env.API_PORT);
  Logger.log(`VEYRA API listening on port ${env.API_PORT}`, 'Bootstrap');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
