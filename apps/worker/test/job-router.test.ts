import { DomainError, type JobEnvelope } from '@veyra/domain';
import { describe, expect, it, vi } from 'vitest';
import { JobRouter } from '../src/job-router';
import { createJobRouter } from '../src/jobs';
import { loadWorkerEnv } from '../src/env';

const ORG = '0192f0a4-7c1e-7b2a-9c4d-1a2b3c4d5e6f';

const tenantJob = (payload: unknown = {}): JobEnvelope<unknown> => ({
  tenant: { organisationId: ORG },
  actorId: 'user-1',
  requestId: 'req-1',
  idempotencyKey: 'idem-1',
  payload,
});

const platformJob = (payload: unknown = {}): JobEnvelope<unknown> => ({
  tenant: null,
  platformJob: true,
  actorId: null,
  requestId: 'req-2',
  idempotencyKey: 'idem-2',
  payload,
});

describe('JobRouter', () => {
  it('dispatches tenant jobs with their envelope', async () => {
    const handle = vi.fn(async () => 'ok');
    const router = new JobRouter().register('invoice.generate', { platform: false, handle });
    await expect(router.dispatch('invoice.generate', tenantJob({ n: 1 }))).resolves.toBe('ok');
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ payload: { n: 1 } }));
  });

  it('rejects tenant jobs that arrive without tenant context', async () => {
    const handle = vi.fn();
    const router = new JobRouter().register('invoice.generate', { platform: false, handle });
    await expect(
      router.dispatch('invoice.generate', { ...tenantJob(), tenant: null }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a tenant-less envelope that claims to be a platform job for a tenant handler', async () => {
    const handle = vi.fn();
    const router = new JobRouter().register('invoice.generate', { platform: false, handle });
    await expect(router.dispatch('invoice.generate', platformJob())).rejects.toThrow(
      /not a platform job/,
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects unknown jobs and duplicate registrations', async () => {
    const router = new JobRouter();
    await expect(router.dispatch('missing', tenantJob())).rejects.toThrow(/No handler/);
    router.register('a', { platform: true, handle: async () => null });
    expect(() => router.register('a', { platform: true, handle: async () => null })).toThrow();
  });

  it('runs the built-in system.ping platform job', async () => {
    await expect(
      createJobRouter().dispatch('system.ping', platformJob({ sentAt: '2026-11-08T00:00:00Z' })),
    ).resolves.toEqual({ pong: true, sentAt: '2026-11-08T00:00:00Z' });
  });
});

describe('loadWorkerEnv', () => {
  it('validates configuration', () => {
    expect(loadWorkerEnv({ REDIS_URL: 'redis://localhost:6379' }).WORKER_CONCURRENCY).toBe(5);
    expect(() => loadWorkerEnv({})).toThrow(/REDIS_URL/);
  });
});
