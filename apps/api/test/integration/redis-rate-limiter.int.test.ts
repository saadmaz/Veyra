import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisRateLimiter } from '../../src/platform/rate-limit/rate-limiter';

/**
 * Runs against a real Redis when REDIS_URL is set (CI provides a Redis 7 service container).
 * Without it (local machines without Docker) the suite is reported as skipped, never as passed.
 */
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('RedisRateLimiter against real Redis', () => {
  let redis: Redis;
  let limiter: RedisRateLimiter;
  const key = () => `test:${randomUUID()}`;

  beforeAll(() => {
    redis = new Redis(redisUrl as string, { maxRetriesPerRequest: 1 });
    limiter = new RedisRateLimiter(redis);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it('counts hits within one window and reports when it resets', async () => {
    const k = key();
    expect((await limiter.hit(k, 60_000)).count).toBe(1);
    const second = await limiter.hit(k, 60_000);
    expect(second.count).toBe(2);
    expect(second.resetInMs).toBeGreaterThan(55_000);
    expect(second.resetInMs).toBeLessThanOrEqual(60_000);
    expect(await limiter.peek(k)).toMatchObject({ count: 2 });
  });

  it('does not extend the window on later hits (fixed window)', async () => {
    const k = key();
    await limiter.hit(k, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const later = await limiter.hit(k, 120_000);
    expect(later.resetInMs).toBeLessThanOrEqual(60_000);
  });

  it('starts a new window after expiry', async () => {
    const k = key();
    await limiter.hit(k, 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await limiter.hit(k, 100)).count).toBe(1);
  });

  it('peeks without counting and resets on request', async () => {
    const k = key();
    expect(await limiter.peek(k)).toEqual({ count: 0, resetInMs: 0 });
    await limiter.hit(k, 60_000);
    await limiter.reset(k);
    expect((await limiter.peek(k)).count).toBe(0);
  });

  it('is atomic under concurrent hits', async () => {
    const k = key();
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.hit(k, 60_000)));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });
});
