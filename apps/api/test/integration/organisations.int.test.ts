import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Tenancy and authorisation over HTTP against the real database (ACCESS_CONTROL section 5):
 * cross-organisation access, permission checks, expired/future/suspended/revoked memberships,
 * revocation during a session, invitations and anti-escalation.
 */

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
let db: pg.Pool;
const limiter = new InMemoryRateLimiter();
const run = randomUUID().slice(0, 8);

const http = () => request(app.getHttpServer());

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

async function signUp(name: string): Promise<TestUser> {
  const email = `${name}-${run}@example.test`;
  const res = await http()
    .post('/api/v1/auth/sign-up')
    .send({ email, password: PASSWORD, displayName: name })
    .expect(201);
  const setCookie = (res.headers['set-cookie'] as unknown as string[])[0] as string;
  return { id: res.body.user.id, email, cookie: setCookie.split(';')[0] as string };
}

const as = (user: TestUser) => ({
  get: (url: string) => http().get(url).set('Cookie', user.cookie),
  post: (url: string) => http().post(url).set('Cookie', user.cookie),
  patch: (url: string) => http().patch(url).set('Cookie', user.cookie),
});

async function createOrganisation(owner: TestUser, slug: string): Promise<string> {
  const res = await as(owner)
    .post('/api/v1/organisations')
    .send({
      name: `Org ${slug}`,
      slug: `${slug}-${run}`,
      countryCode: 'PK',
      defaultCurrency: 'PKR',
      defaultTimeZone: 'Asia/Karachi',
    })
    .expect(201);
  return res.body.id;
}

/** Runs SQL as the application role inside a tenant context (for test fixtures only). */
async function inTenant(organisationId: string, sql: string, params: unknown[] = []) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function invite(
  admin: TestUser,
  organisationId: string,
  email: string,
  role = 'FINANCE_OFFICER',
) {
  const res = await as(admin)
    .post(`/api/v1/organisations/${organisationId}/invitations`)
    .send({ email, role })
    .expect(201);
  return res.body as { invitation: { id: string }; token: string };
}

async function membershipId(organisationId: string, userId: string): Promise<string> {
  const { rows } = await inTenant(organisationId, 'SELECT id FROM memberships WHERE user_id = $1', [
    userId,
  ]);
  return rows[0].id;
}

let alice: TestUser; // creates and administers organisation A
let bob: TestUser; // creates organisation B, never a member of A
let carol: TestUser; // invited into A as finance officer
let orgA: string;
let orgB: string;

beforeAll(async () => {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    REDIS_URL: 'redis://localhost:6379',
    API_CORS_ORIGINS: 'http://localhost:3000',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(REDIS_CLIENT)
    .useValue({ quit: async () => 'OK' })
    .overrideProvider(RATE_LIMITER)
    .useValue(limiter)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();
  db = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });

  alice = await signUp('alice');
  bob = await signUp('bob');
  carol = await signUp('carol');
  orgA = await createOrganisation(alice, 'tenant-a');
  orgB = await createOrganisation(bob, 'tenant-b');

  const { token } = await invite(alice, orgA, carol.email);
  await as(carol).post('/api/v1/invitations/accept').send({ token }).expect(200);
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('creating an organisation', () => {
  it('makes the creator its organisation admin and lists it as theirs', async () => {
    const mine = await as(alice).get('/api/v1/organisations').expect(200);
    expect(mine.body.data).toEqual([
      {
        organisation: expect.objectContaining({ id: orgA, status: 'ACTIVE' }),
        roles: ['ORGANISATION_ADMIN'],
      },
    ]);
    const detail = await as(alice).get(`/api/v1/organisations/${orgA}`).expect(200);
    expect(detail.body).toMatchObject({ id: orgA, countryCode: 'PK', defaultCurrency: 'PKR' });
    expect(detail.body.permissions).toContain('organisation.member.invite');
  });

  it('rejects a taken slug with 409 and invalid input with 400', async () => {
    const taken = await as(bob)
      .post('/api/v1/organisations')
      .send({
        name: 'Copycat',
        slug: `tenant-a-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(409);
    expect(taken.body.error.code).toBe('SLUG_TAKEN');

    const invalid = await as(bob)
      .post('/api/v1/organisations')
      .send({
        name: 'X',
        slug: 'Bad Slug',
        countryCode: 'EU',
        defaultCurrency: 'ZZZ',
        defaultTimeZone: 'Nowhere',
      })
      .expect(400);
    expect(invalid.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'countryCode',
      'defaultCurrency',
      'defaultTimeZone',
      'name',
      'slug',
    ]);
  });

  it('requires a session', async () => {
    await http().post('/api/v1/organisations').send({}).expect(401);
    await http().get('/api/v1/organisations').expect(401);
  });
});

describe('cross-organisation isolation', () => {
  const routes = (org: string): [string, (u: TestUser) => request.Test][] => [
    ['GET organisation', (u) => as(u).get(`/api/v1/organisations/${org}`)],
    [
      'PATCH organisation',
      (u) => as(u).patch(`/api/v1/organisations/${org}`).send({ name: 'Hijacked' }),
    ],
    ['GET memberships', (u) => as(u).get(`/api/v1/organisations/${org}/memberships`)],
    [
      'PATCH membership',
      (u) =>
        as(u)
          .patch(`/api/v1/organisations/${org}/memberships/${randomUUID()}`)
          .send({ status: 'REVOKED' }),
    ],
    [
      'POST invitation',
      (u) =>
        as(u)
          .post(`/api/v1/organisations/${org}/invitations`)
          .send({ email: 'x@example.test', role: 'ORGANISATION_ADMIN' }),
    ],
    ['GET invitations', (u) => as(u).get(`/api/v1/organisations/${org}/invitations`)],
    [
      'POST revoke invitation',
      (u) => as(u).post(`/api/v1/organisations/${org}/invitations/${randomUUID()}/revoke`),
    ],
  ];

  it('returns 404 on every organisation route for a non-member, revealing nothing', async () => {
    for (const [label, call] of routes(orgA)) {
      const res = await call(bob);
      expect(res.status, label).toBe(404);
      expect(res.body.error.code, label).toBe('NOT_FOUND');
    }
    const { rows } = await inTenant(orgA, 'SELECT name FROM organisations');
    expect(rows[0].name).toBe('Org tenant-a');
  });

  it('treats unknown and malformed organisation ids exactly like foreign ones', async () => {
    for (const id of [randomUUID(), 'not-a-uuid', orgB]) {
      const res = await as(alice).get(`/api/v1/organisations/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('never lists another organisation as the caller’s own', async () => {
    const mine = await as(bob).get('/api/v1/organisations').expect(200);
    expect(
      mine.body.data.map((row: { organisation: { id: string } }) => row.organisation.id),
    ).toEqual([orgB]);
  });
});

describe('permissions within an organisation', () => {
  it('lets a finance officer read the organisation but not members, settings or invitations', async () => {
    const detail = await as(carol).get(`/api/v1/organisations/${orgA}`).expect(200);
    expect(detail.body.permissions).toEqual(['organisation.profile.read', 'organisation.vendor.read']);
    for (const res of [
      await as(carol).get(`/api/v1/organisations/${orgA}/memberships`),
      await as(carol).patch(`/api/v1/organisations/${orgA}`).send({ name: 'Mine now' }),
      await as(carol)
        .post(`/api/v1/organisations/${orgA}/invitations`)
        .send({ email: `friend-${run}@example.test`, role: 'ORGANISATION_ADMIN' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('lets the admin update settings and list members, recording audit events', async () => {
    await as(alice)
      .patch(`/api/v1/organisations/${orgA}`)
      .send({ name: 'Harbour View', defaultTimeZone: 'Asia/Colombo', defaultCurrency: 'USD' })
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({
          name: 'Harbour View',
          defaultTimeZone: 'Asia/Colombo',
          defaultCurrency: 'PKR',
        });
      });
    const members = await as(alice).get(`/api/v1/organisations/${orgA}/memberships`).expect(200);
    expect(
      members.body.data.map((m: { email: string; role: string }) => [m.email, m.role]).sort(),
    ).toEqual([
      [alice.email, 'ORGANISATION_ADMIN'],
      [carol.email, 'FINANCE_OFFICER'],
    ]);

    // Compared as a set: rows written in the same millisecond tie on created_at, and UUIDv7 ids
    // are not ordered within a millisecond, so their relative order is not defined.
    const { rows } = await inTenant(orgA, 'SELECT action FROM audit_logs ORDER BY action');
    expect(rows.map((r) => r.action)).toEqual([
      'invitation.accepted',
      'invitation.created',
      'membership.granted',
      'membership.granted',
      'organisation.created',
      'organisation.updated',
    ]);
  });

  it('paginates members with an opaque cursor', async () => {
    const first = await as(alice)
      .get(`/api/v1/organisations/${orgA}/memberships?limit=1`)
      .expect(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await as(alice)
      .get(`/api/v1/organisations/${orgA}/memberships?limit=1&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('membership lifecycle takes effect on the next request', () => {
  it('suspension removes access, reactivation restores it, revocation is final', async () => {
    const id = await membershipId(orgA, carol.id);
    const url = `/api/v1/organisations/${orgA}/memberships/${id}`;

    await as(alice).patch(url).send({ status: 'SUSPENDED' }).expect(200);
    await as(carol).get(`/api/v1/organisations/${orgA}`).expect(404);
    expect((await as(carol).get('/api/v1/organisations').expect(200)).body.data).toEqual([]);

    await as(alice).patch(url).send({ status: 'ACTIVE' }).expect(200);
    await as(carol).get(`/api/v1/organisations/${orgA}`).expect(200);

    await as(alice).patch(url).send({ status: 'REVOKED' }).expect(200);
    await as(carol).get(`/api/v1/organisations/${orgA}`).expect(404);
    const again = await as(alice).patch(url).send({ status: 'ACTIVE' }).expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Access comes back only through a new invitation.
    const { token } = await invite(alice, orgA, carol.email);
    await as(carol).post('/api/v1/invitations/accept').send({ token }).expect(200);
    await as(carol).get(`/api/v1/organisations/${orgA}`).expect(200);
  });

  it('denies expired and future-dated memberships', async () => {
    const id = await membershipId(orgA, carol.id);
    await inTenant(
      orgA,
      `UPDATE memberships SET valid_from = now() - interval '2 hours', valid_until = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
    await as(carol).get(`/api/v1/organisations/${orgA}`).expect(404);

    await inTenant(
      orgA,
      `UPDATE memberships SET valid_until = NULL, valid_from = now() + interval '1 day' WHERE id = $1`,
      [id],
    );
    await as(carol).get(`/api/v1/organisations/${orgA}`).expect(404);

    // A second in the past, not now(): the database clock and the API's clock can differ by a
    // few milliseconds (seen on Windows), which made this check fail intermittently.
    await inTenant(
      orgA,
      `UPDATE memberships SET valid_from = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    await as(carol).get(`/api/v1/organisations/${orgA}`).expect(200);
  });

  it('never removes the last active organisation admin', async () => {
    const id = await membershipId(orgA, alice.id);
    for (const status of ['SUSPENDED', 'REVOKED']) {
      const res = await as(alice)
        .patch(`/api/v1/organisations/${orgA}/memberships/${id}`)
        .send({ status })
        .expect(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    }
    await as(alice).get(`/api/v1/organisations/${orgA}`).expect(200);
  });

  it('makes a suspended organisation read-only', async () => {
    await inTenant(orgB, `UPDATE organisations SET status = 'SUSPENDED' WHERE id = $1`, [orgB]);
    try {
      await as(bob).get(`/api/v1/organisations/${orgB}`).expect(200);
      await as(bob).get(`/api/v1/organisations/${orgB}/memberships`).expect(200);
      await as(bob).patch(`/api/v1/organisations/${orgB}`).send({ name: 'Nope' }).expect(403);
      await as(bob)
        .post(`/api/v1/organisations/${orgB}/invitations`)
        .send({ email: `x-${run}@example.test`, role: 'FINANCE_OFFICER' })
        .expect(403);
    } finally {
      await inTenant(orgB, `UPDATE organisations SET status = 'ACTIVE' WHERE id = $1`, [orgB]);
    }
  });
});

describe('invitations', () => {
  it('shows the token once and never again in lists', async () => {
    const email = `dana-${run}@example.test`;
    const { token, invitation } = await invite(alice, orgA, email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const list = await as(alice)
      .get(`/api/v1/organisations/${orgA}/invitations?limit=200`)
      .expect(200);
    const listed = list.body.data.find((i: { id: string }) => i.id === invitation.id);
    expect(listed).toMatchObject({ email, role: 'FINANCE_OFFICER', status: 'PENDING' });
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|token_hash/);
  });

  it('can only be accepted by an account with the invited email, once', async () => {
    const erin = await signUp('erin');
    const { token } = await invite(alice, orgA, erin.email);

    const wrongPerson = await as(bob)
      .post('/api/v1/invitations/accept')
      .send({ token })
      .expect(403);
    expect(wrongPerson.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    const results = await Promise.all([
      as(erin).post('/api/v1/invitations/accept').send({ token }),
      as(erin).post('/api/v1/invitations/accept').send({ token }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await as(erin).get(`/api/v1/organisations/${orgA}`).expect(200);
  });

  it('rejects unknown, revoked and expired invitations', async () => {
    const unknown = await as(bob)
      .post('/api/v1/invitations/accept')
      .send({ token: 'A'.repeat(43) })
      .expect(404);
    expect(unknown.body.error.code).toBe('INVITATION_NOT_FOUND');

    const frank = await signUp('frank');
    const revoked = await invite(alice, orgA, frank.email);
    await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations/${revoked.invitation.id}/revoke`)
      .expect(204);
    const r = await as(frank)
      .post('/api/v1/invitations/accept')
      .send({ token: revoked.token })
      .expect(409);
    expect(r.body.error.code).toBe('INVITATION_REVOKED');

    const expired = await invite(alice, orgA, frank.email);
    await inTenant(
      orgA,
      `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired.invitation.id],
    );
    const e = await as(frank)
      .post('/api/v1/invitations/accept')
      .send({ token: expired.token })
      .expect(409);
    expect(e.body.error.code).toBe('INVITATION_EXPIRED');

    // An expired, unanswered invitation does not block a fresh one.
    await invite(alice, orgA, frank.email);
  });

  it('refuses duplicates: a pending invitation, or a role the person already has', async () => {
    const email = `gina-${run}@example.test`;
    await invite(alice, orgA, email);
    const pending = await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations`)
      .send({ email, role: 'FINANCE_OFFICER' })
      .expect(409);
    expect(pending.body.error.code).toBe('INVITATION_PENDING');

    const member = await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations`)
      .send({ email: carol.email.toUpperCase(), role: 'FINANCE_OFFICER' })
      .expect(409);
    expect(member.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('does not let invitations from one organisation be revoked through another', async () => {
    const { invitation } = await invite(bob, orgB, `hank-${run}@example.test`);
    await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations/${invitation.id}/revoke`)
      .expect(404);
    const { rows } = await inTenant(orgB, 'SELECT revoked_at FROM invitations WHERE id = $1', [
      invitation.id,
    ]);
    expect(rows[0].revoked_at).toBeNull();
  });
});
