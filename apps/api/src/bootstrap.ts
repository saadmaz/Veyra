import { type INestApplication, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { ApiEnv } from './platform/config/env';

export const API_PREFIX = 'api';

/**
 * Applies global HTTP configuration. Shared by main.ts and the e2e tests so tests exercise
 * exactly the production pipeline.
 */
export function configureApp(app: INestApplication, env: ApiEnv): void {
  if (env.API_TRUST_PROXY > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', env.API_TRUST_PROXY);
  }
  app.use(helmet());
  app.enableCors({
    origin: env.API_CORS_ORIGINS.length > 0 ? env.API_CORS_ORIGINS : false,
    credentials: true,
  });
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('VEYRA API')
      .setDescription('VEYRA platform REST API')
      .setVersion('1')
      .addBearerAuth()
      // Docs are served outside production only, where the cookie has no __Host- prefix.
      .addCookieAuth('veyra_session')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, document);
  }
}
