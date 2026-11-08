import 'reflect-metadata';
import { Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import type { AuthenticatedPrincipal } from '../../src/modules/identity/application/identity-provider';
import { CurrentPrincipal } from '../../src/modules/identity/presentation/current-principal.decorator';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/** A protected route with no @Public(): proves the guard is global and deny-by-default. */
@Controller('probe')
class ProtectedProbeController {
  @Get('whoami')
  whoami(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { userId: principal.userId };
  }

  @Post('mutate')
  mutate() {
    return { ok: true };
  }
}

const ALLOWED_ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

let app: INestApplication;
let db: pg.Pool;
const limiter = new InMemoryRateLimiter();
let emailCounter = 0;
const nextEmail = () => `resident${++emailCounter}-${Date.now()}@example.test`;

const http = () => request(app.getHttpServer());

function sessionCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith('veyra_session='));
  if (!cookie) throw new Error('no session cookie set');
  return cookie;
}
const cookiePair = (setCookie: string) => setCookie.split(';')[0] as string;

async function signUp(client: 'web' | 'mobile' = 'web', email = nextEmail()) {
  const res = await http()
    .post('/api/v1/auth/sign-up')
    .send({ email, password: PASSWORD, displayName: 'Test Resident', client })
    .expect(201);
  return { res, email };
}

/**
 * Platform audit rows (organisation_id NULL) are invisible to veyra_app and veyra_owner through
 * RLS by design, so the test reads them as the superuser. The application never does this.
 */
async function auditActions(userId: string): Promise<{ action: string; metadata: unknown }[]> {
  const superuser = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
  await superuser.connect();
  try {
    const { rows } = await superuser.query(
      'SELECT action, metadata FROM audit_logs WHERE actor_user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return rows;
  } finally {
    await superuser.end();
  }
}

beforeAll(async () => {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    REDIS_URL: 'redis://localhost:6379',
    API_CORS_ORIGINS: ALLOWED_ORIGIN,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env)],
    controllers: [ProtectedProbeController],
  })
    .overrideProvider(REDIS_CLIENT)
    .useValue({ quit: async () => 'OK' })
    .overrideProvider(RATE_LIMITER)
    .useValue(limiter)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();
  db = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

beforeEach(() => limiter.clear());

describe('deny by default', () => {
  it('rejects protected routes without credentials', async () => {
    const res = await http().get('/api/v1/probe/whoami').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    await http().get('/api/v1/auth/session').expect(401);
  });

  it('keeps health checks public', async () => {
    await http().get('/api/v1/health/live').expect(200);
  });

  it('rejects garbage cookies and bearer tokens', async () => {
    await http().get('/api/v1/probe/whoami').set('Cookie', 'veyra_session=garbage').expect(401);
    await http()
      .get('/api/v1/probe/whoami')
      .set('Authorization', `Bearer ${'A'.repeat(43)}`)
      .expect(401);
  });
});

describe('web sign-up and session', () => {
  it('sets an httpOnly SameSite=Lax cookie and never returns the token in the body', async () => {
    const { res } = await signUp('web');
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.token).toBeUndefined();
    expect(res.body.session.client).toBe('web');
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password/i);
  });

  it('stores only an argon2id password hash and a SHA-256 token hash', async () => {
    const { res, email } = await signUp('web');
    const token = cookiePair(sessionCookie(res)).split('=')[1] as string;
    const { rows } = await db.query(
      `SELECT pc.password_hash, s.token_hash, s.client
         FROM users u
         JOIN password_credentials pc ON pc.user_id = u.id
         JOIN sessions s ON s.user_id = u.id
        WHERE u.email = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].client).toBe('WEB');
  });

  it('authenticates with the cookie and returns the current user', async () => {
    const { res, email } = await signUp('web');
    const cookie = cookiePair(sessionCookie(res));
    const session = await http().get('/api/v1/auth/session').set('Cookie', cookie).expect(200);
    expect(session.body).toEqual({
      user: { id: res.body.user.id, email, displayName: 'Test Resident' },
      session: { client: 'web' },
    });
    const probe = await http().get('/api/v1/probe/whoami').set('Cookie', cookie).expect(200);
    expect(probe.body.userId).toBe(res.body.user.id);
  });

  it('normalises the email and rejects a duplicate in any letter case (409)', async () => {
    const email = nextEmail();
    await signUp('web', email);
    const res = await http()
      .post('/api/v1/auth/sign-up')
      .send({ email: `  ${email.toUpperCase()} `, password: PASSWORD, displayName: 'Again' })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('turns concurrent duplicate sign-ups into exactly one account', async () => {
    const email = nextEmail();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        http()
          .post('/api/v1/auth/sign-up')
          .send({ email, password: PASSWORD, displayName: 'Race' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [
      email,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('returns field errors for invalid input without echoing the password', async () => {
    const res = await http()
      .post('/api/v1/auth/sign-up')
      .send({ email: 'not-an-email', password: 'short-pw', displayName: '' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'displayName',
      'email',
      'password',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('short-pw');
  });

  it('records sign-up, sign-in, failed sign-in and sign-out as platform audit events', async () => {
    const { res, email } = await signUp('web');
    await http()
      .post('/api/v1/auth/sign-in')
      .send({ email, password: 'wrong password!' })
      .expect(401);
    const signedIn = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    await http()
      .post('/api/v1/auth/sign-out')
      .set('Cookie', cookiePair(sessionCookie(signedIn)))
      .expect(204);
    const events = await auditActions(res.body.user.id);
    expect(events.map((e) => e.action)).toEqual([
      'auth.sign_up',
      'auth.sign_in_failed',
      'auth.sign_in',
      'auth.sign_out',
    ]);
    expect(events[1]?.metadata).toEqual({ reason: 'wrong_password' });
    expect(JSON.stringify(events)).not.toMatch(/argon2|correct horse/);
  });
});

describe('sign-in', () => {
  it('signs in with the right password and gives the same 401 for wrong password and unknown email', async () => {
    const { email } = await signUp('web');
    const ok = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    expect(sessionCookie(ok)).toBeTruthy();

    const wrong = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email, password: 'not the password' })
      .expect(401);
    const unknown = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: nextEmail(), password: PASSWORD })
      .expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect({ ...unknown.body.error, requestId: undefined }).toEqual({
      ...wrong.body.error,
      requestId: undefined,
    });
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('returns 429 with Retry-After after 5 failures for one email, even with the right password', async () => {
    const { email } = await signUp('web');
    for (let i = 0; i < 5; i++) {
      await http()
        .post('/api/v1/auth/sign-in')
        .send({ email, password: 'nope nope nope' })
        .expect(401);
    }
    const blocked = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('refuses sign-in and existing sessions once the user is disabled', async () => {
    const { res, email } = await signUp('web');
    const cookie = cookiePair(sessionCookie(res));
    await db.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [res.body.user.id]);
    await http().get('/api/v1/auth/session').set('Cookie', cookie).expect(401);
    await http().post('/api/v1/auth/sign-in').send({ email, password: PASSWORD }).expect(401);
  });
});

describe('mobile sessions', () => {
  it('returns a bearer token in the body and sets no cookie', async () => {
    const { res } = await signUp('mobile');
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers['set-cookie']).toBeUndefined();
    await http()
      .get('/api/v1/auth/session')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200);
  });

  it('does not accept a mobile token as a cookie, or a web cookie as a bearer token', async () => {
    const mobile = await signUp('mobile');
    await http()
      .get('/api/v1/auth/session')
      .set('Cookie', `veyra_session=${mobile.res.body.token}`)
      .expect(401);

    const web = await signUp('web');
    const webToken = cookiePair(sessionCookie(web.res)).split('=')[1];
    await http().get('/api/v1/auth/session').set('Authorization', `Bearer ${webToken}`).expect(401);
  });
});

describe('sign-out and expiry', () => {
  it('revokes the session server-side and clears the cookie', async () => {
    const { res } = await signUp('web');
    const cookie = cookiePair(sessionCookie(res));
    const out = await http()
      .post('/api/v1/auth/sign-out')
      .set('Cookie', cookie)
      .set('Origin', ALLOWED_ORIGIN)
      .expect(204);
    expect(String(out.headers['set-cookie'])).toMatch(/veyra_session=;.*Expires=Thu, 01 Jan 1970/);
    // Replaying the old cookie does not work: revocation is server-side.
    await http().get('/api/v1/auth/session').set('Cookie', cookie).expect(401);
    const { rows } = await db.query('SELECT revoked_at FROM sessions WHERE user_id = $1', [
      res.body.user.id,
    ]);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('rejects a session whose idle or absolute expiry has passed', async () => {
    const idle = await signUp('web');
    await db.query(
      `UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [idle.res.body.user.id],
    );
    await http()
      .get('/api/v1/auth/session')
      .set('Cookie', cookiePair(sessionCookie(idle.res)))
      .expect(401);

    const absolute = await signUp('mobile');
    await db.query(
      `UPDATE sessions SET idle_expires_at = now() - interval '2 seconds',
                           absolute_expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [absolute.res.body.user.id],
    );
    await http()
      .get('/api/v1/auth/session')
      .set('Authorization', `Bearer ${absolute.res.body.token}`)
      .expect(401);
  });
});

describe('cross-site request protection', () => {
  it('rejects state-changing requests from origins outside the allow-list', async () => {
    const { res } = await signUp('web');
    const cookie = cookiePair(sessionCookie(res));
    const forged = await http()
      .post('/api/v1/probe/mutate')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(forged.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    await http()
      .post('/api/v1/probe/mutate')
      .set('Cookie', cookie)
      .set('Origin', ALLOWED_ORIGIN)
      .expect(201);
  });

  it('blocks forged sign-ins (login CSRF) from other origins', async () => {
    const { email } = await signUp('web');
    await http()
      .post('/api/v1/auth/sign-in')
      .set('Origin', 'https://evil.example')
      .send({ email, password: PASSWORD })
      .expect(403);
  });
});
