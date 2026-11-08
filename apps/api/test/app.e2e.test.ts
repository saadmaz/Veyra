import 'reflect-metadata';
import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DomainError } from '@veyra/domain';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { Public } from '../src/platform/auth/public.decorator';
import { type ApiEnv, loadApiEnv } from '../src/platform/config/env';
import { HEALTH_CHECKS, type HealthCheck } from '../src/platform/health/health.service';
import { DB_CLIENT, REDIS_CLIENT } from '../src/platform/infrastructure/infrastructure.module';
import { ZodValidationPipe } from '../src/platform/validation/zod-validation.pipe';

const probeSchema = z.object({ name: z.string().min(1), units: z.number().int().positive() });

/** Test-only routes that exercise the global error and validation pipeline. */
@Public()
@Controller('probe')
class ProbeController {
  @Post('validate')
  validate(@Body(new ZodValidationPipe(probeSchema)) body: z.infer<typeof probeSchema>) {
    return body;
  }

  @Get('domain-error')
  domainError(): never {
    throw new DomainError('BOOKING_SLOT_TAKEN', 'The selected slot is already booked');
  }

  @Get('crash')
  crash(): never {
    throw new Error('connection to db-internal-host:5432 refused: password=hunter2');
  }
}

/** No @Public(): must be rejected without a session (the guard is global, deny by default). */
@Controller('protected-probe')
class ProtectedProbeController {
  @Get()
  read() {
    return { secret: true };
  }
}

const env: ApiEnv = loadApiEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/veyra_test',
  REDIS_URL: 'redis://localhost:6379',
  API_CORS_ORIGINS: 'http://localhost:3000',
});

const health = { database: true, redis: true };
const checks: HealthCheck[] = [
  {
    name: 'database',
    check: async () => {
      if (!health.database) throw new Error('down');
    },
  },
  {
    name: 'redis',
    check: async () => {
      if (!health.redis) throw new Error('down');
    },
  },
];

describe('API platform (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
      controllers: [ProbeController, ProtectedProbeController],
    })
      .overrideProvider(DB_CLIENT)
      .useValue({ $disconnect: async () => undefined })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ quit: async () => 'OK' })
      .overrideProvider(HEALTH_CHECKS)
      .useValue(checks)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, env);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    health.database = true;
    health.redis = true;
  });

  it('serves liveness under the versioned prefix', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports ready when all dependencies are up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('returns 503 and names the failing dependency when one is down', async () => {
    health.redis = false;
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
    expect(res.body).toEqual({ status: 'error', checks: { database: 'up', redis: 'down' } });
  });

  it('assigns a request id, or propagates a well-formed one', async () => {
    const generated = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const propagated = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('x-request-id', 'trace-abc-12345');
    expect(propagated.headers['x-request-id']).toBe('trace-abc-12345');
  });

  it('does not reflect unsafe request ids', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('x-request-id', '<script>alert(1)</script>');
    expect(res.headers['x-request-id']).not.toContain('<');
  });

  it('returns the error envelope for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns field-level validation errors', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/validate')
      .send({ name: '', units: 1.5 })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'name',
      'units',
    ]);
  });

  it('strips unknown fields from validated input', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/validate')
      .send({ name: 'Tower A', units: 40, isAdmin: true })
      .expect(201);
    expect(res.body).toEqual({ name: 'Tower A', units: 40 });
  });

  it('maps domain errors to 422 with their code', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/probe/domain-error').expect(422);
    expect(res.body.error).toMatchObject({
      code: 'BOOKING_SLOT_TAKEN',
      message: 'The selected slot is already booked',
    });
  });

  it('never leaks internal error details', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/probe/crash').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|db-internal-host/);
  });

  it('sets security headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('only allows configured CORS origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const denied = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies routes that are not marked public when no session is presented', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/protected-probe').expect(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects state-changing requests from origins outside the allow-list', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/validate')
      .set('Origin', 'https://evil.example')
      .send({ name: 'Tower A', units: 40 })
      .expect(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('publishes an OpenAPI document outside production', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toContain('/api/v1/health/ready');
  });
});
