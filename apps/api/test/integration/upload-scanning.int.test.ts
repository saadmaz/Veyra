import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import {
  FILE_SCANNER,
  type FileScanner,
  type ScanResult,
} from '../../src/platform/storage/file-scanner';
import { OBJECT_STORAGE } from '../../src/platform/storage/object-storage';
import { FakeObjectStorage } from '../support/fake-object-storage';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Malware scanning of uploads over HTTP (Phase 14 Part 3): an infected file is rejected and
 * deleted like a file that is not what it claims; when the scanner cannot be reached the upload
 * stays pending (503) and completes once scanning works again.
 */

/** A scanner the test controls: infected when the bytes carry a marker, or unavailable. */
let scannerDown = false;
const MARKER = 'TEST-MALWARE-MARKER';
const scanner: FileScanner = {
  name: 'test',
  scan: async (bytes): Promise<ScanResult> => {
    if (scannerDown) return 'unavailable';
    return Buffer.from(bytes).includes(MARKER) ? 'infected' : 'clean';
  },
};

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
const storage = new FakeObjectStorage();
const run = randomUUID().slice(0, 8);
const http = () => request(app.getHttpServer());
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(95).fill(0x20)]);

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
});

const u = {} as Record<'admin' | 'mgr' | 'guard' | 'owner' | 'tenant', TestUser>;
let org: string;
let P: string;
const units: Record<string, string> = {};
const orgUrl = () => `/api/v1/organisations/${org}`;
const dUrl = (path = '') => `${orgUrl()}/properties/${P}/documents${path ? `/${path}` : ''}`;
const unitDocs = (unit: string) => `${orgUrl()}/properties/${P}/units/${units[unit]}/documents`;
const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

/** Adds a document and uploads its file. */
async function addDocument(title: string, audience: string, bytes = PDF) {
  const created = (
    await as(u.mgr)
      .post(dUrl())
      .send({
        title,
        category: 'RULES',
        audience,
        file: { fileName: `${title}.pdf`, contentType: 'application/pdf', sizeBytes: PDF.length },
      })
      .expect(201)
  ).body;
  storage.put(created.upload.url, bytes);
  return created;
}

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
    .useValue(new InMemoryRateLimiter())
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .overrideProvider(FILE_SCANNER)
    .useValue(scanner)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();

  for (const name of ['admin', 'mgr', 'guard', 'owner', 'tenant'] as const)
    u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Scan Org',
        slug: `scan-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  P = (
    await as(u.admin)
      .post(`${orgUrl()}/properties`)
      .send({
        name: 'Scan Tower',
        code: 'ST',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role] of [
    [u.mgr, 'PROPERTY_MANAGER'],
    [u.guard, 'SECURITY_GUARD'],
  ] as const) {
    const invited = await as(u.admin)
      .post(`${orgUrl()}/invitations`)
      .send({ email: user.email, role, propertyId: P })
      .expect(201);
    await as(user)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
  }
  const pUrl = `${orgUrl()}/properties/${P}`;
  for (const number of ['D1', 'D2']) {
    units[number] = (
      await as(u.admin).post(`${pUrl}/units`).send({ number, type: 'APARTMENT' }).expect(201)
    ).body.id;
  }
  const link = async (user: TestUser, fullName: string) => {
    const person = (
      await as(u.admin).post(`${pUrl}/persons`).send({ fullName, email: user.email }).expect(201)
    ).body.id;
    const invited = await as(u.admin).post(`${orgUrl()}/persons/${person}/invitations`).expect(201);
    await as(user)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
    return person;
  };
  const owner = await link(u.owner, 'Olu Owner');
  await as(u.admin)
    .post(`${pUrl}/units/${units.D1}/owners`)
    .send({
      effectiveFrom: '2026-01-01',
      owners: [{ personId: owner, shareNumerator: 1, shareDenominator: 1 }],
    })
    .expect(200);
  const tenant = await link(u.tenant, 'Tara Tenant');
  await as(u.admin)
    .post(`${pUrl}/units/${units.D2}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: tenant, isPrimary: true }] })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
});

describe('upload scanning', () => {
  it('rejects and deletes infected files', async () => {
    const infected = new Uint8Array([
      ...PDF.slice(0, 50),
      ...Buffer.from(MARKER),
      ...PDF.slice(50 + MARKER.length),
    ]);
    expect(infected.length).toBe(PDF.length);
    const d = await addDocument('Suspicious', 'EVERYONE', infected);
    const key = [...storage.objects.keys()].find((k) => k.endsWith(d.versionId));
    expect(key).toBeDefined();
    const res = await as(u.mgr)
      .post(dUrl(`${d.document.id}/versions/${d.versionId}/complete`))
      .expect(422);
    expect(res.body.error.code).toBe('FILE_REJECTED');
    expect(storage.objects.has(key as string)).toBe(false);
  });

  it('keeps an upload pending while the scanner is down', async () => {
    const d = await addDocument('Rules', 'EVERYONE');
    scannerDown = true;
    const res = await as(u.mgr)
      .post(dUrl(`${d.document.id}/versions/${d.versionId}/complete`))
      .expect(503);
    expect(res.body.error.code).toBe('SCAN_UNAVAILABLE');
    expect((await as(u.tenant).get(unitDocs('D2')).expect(200)).body.data).toEqual([]);
    scannerDown = false;
    await as(u.mgr)
      .post(dUrl(`${d.document.id}/versions/${d.versionId}/complete`))
      .expect(200);
    expect(titles((await as(u.tenant).get(unitDocs('D2')).expect(200)).body.data)).toEqual([
      'Rules',
    ]);
  });
});
