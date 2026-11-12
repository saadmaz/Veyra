import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import {
  ACCOUNT_MAILER,
  type AccountMailer,
} from '../../src/modules/identity/application/account.service';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Email verification and password reset over HTTP (Phase 14 Part 1): sign-up sends a one-time
 * link that confirms the address; a reset link is sent only to existing accounts but the answer
 * is the same either way; a reset replaces the password, ends every session and works once; only
 * the newest link of each kind works.
 */

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a much better passphrase here';
const run = randomUUID().slice(0, 8);
let app: INestApplication;
const sent: { userId: string; to: string; subject: string; text: string }[] = [];
const mailer: AccountMailer = {
  send: async (m) => {
    sent.push(m);
  },
};
const http = () => request(app.getHttpServer());
const tokenIn = (text: string) => /#token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
const lastTo = (to: string) => [...sent].reverse().find((m) => m.to === to);

beforeAll(async () => {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    REDIS_URL: 'redis://localhost:6379',
    API_CORS_ORIGINS: 'http://localhost:3000',
    CONSOLE_URL: 'https://console.veyra.example',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(REDIS_CLIENT)
    .useValue({ quit: async () => 'OK' })
    .overrideProvider(RATE_LIMITER)
    .useValue(new InMemoryRateLimiter())
    .overrideProvider(ACCOUNT_MAILER)
    .useValue(mailer)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

async function signUp(name: string) {
  const email = `${name}-${run}@example.test`;
  const res = await http()
    .post('/api/v1/auth/sign-up')
    .send({ email, password: PASSWORD, displayName: name })
    .expect(201);
  const cookie = ((res.headers['set-cookie'] as unknown as string[])[0] as string).split(
    ';',
  )[0] as string;
  return { email, cookie, body: res.body };
}

describe('email verification', () => {
  it('confirms the address once through the emailed link', async () => {
    const ada = await signUp('ada');
    expect(ada.body.user.emailVerified).toBe(false);
    const mail = lastTo(ada.email);
    expect(mail?.subject).toBe('Confirm your email address for VEYRA');
    expect(mail?.text).toContain('https://console.veyra.example/verify-email#token=');
    const token = tokenIn(mail?.text ?? '');
    await http().post('/api/v1/auth/verify-email').send({ token: 'not-a-token' }).expect(400);
    await http().post('/api/v1/auth/verify-email').send({ token }).expect(204);
    await http().post('/api/v1/auth/verify-email').send({ token }).expect(400);
    const session = await http().get('/api/v1/auth/session').set('Cookie', ada.cookie).expect(200);
    expect(session.body.user.emailVerified).toBe(true);
    const before = sent.length;
    await http().post('/api/v1/auth/verify-email/resend').set('Cookie', ada.cookie).expect(202);
    expect(sent.length).toBe(before);
  });

  it('keeps only the newest link working', async () => {
    const bea = await signUp('bea');
    const first = tokenIn(lastTo(bea.email)?.text ?? '');
    await http().post('/api/v1/auth/verify-email/resend').set('Cookie', bea.cookie).expect(202);
    const second = tokenIn(lastTo(bea.email)?.text ?? '');
    expect(second).not.toBe(first);
    await http().post('/api/v1/auth/verify-email').send({ token: first }).expect(400);
    await http().post('/api/v1/auth/verify-email').send({ token: second }).expect(204);
  });
});

describe('password reset', () => {
  it('answers the same for unknown addresses and sends nothing', async () => {
    const before = sent.length;
    await http()
      .post('/api/v1/auth/password-reset')
      .send({ email: `nobody-${run}@example.test` })
      .expect(202);
    expect(sent.length).toBe(before);
  });

  it('replaces the password once and signs out everywhere', async () => {
    const cy = await signUp('cy');
    await http()
      .post('/api/v1/auth/password-reset')
      .send({ email: cy.email.toUpperCase() })
      .expect(202);
    const mail = lastTo(cy.email);
    expect(mail?.subject).toBe('Reset your VEYRA password');
    const token = tokenIn(mail?.text ?? '');
    await http()
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, password: 'short' })
      .expect(400);
    await http()
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, password: NEW_PASSWORD })
      .expect(204);
    await http().get('/api/v1/auth/session').set('Cookie', cy.cookie).expect(401);
    await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: cy.email, password: PASSWORD })
      .expect(401);
    const signedIn = await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: cy.email, password: NEW_PASSWORD })
      .expect(200);
    expect(signedIn.body.user.emailVerified).toBe(true);
    await http()
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, password: 'yet another long passphrase' })
      .expect(400);
  });
});
