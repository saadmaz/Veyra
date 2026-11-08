import type { Redis } from 'ioredis';

export interface RateLimitWindow {
  /** Maximum events allowed within the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitState {
  /** Events recorded in the current window (after this call, for `hit`). */
  count: number;
  /** Milliseconds until the window resets (0 when there is no window). */
  resetInMs: number;
}

/**
 * Fixed-window counters keyed by a caller-chosen string. Implementations must be shared across
 * API instances (Redis in production), otherwise limits multiply by the instance count.
 * Errors propagate: callers decide whether to fail closed.
 */
export interface RateLimiter {
  /** Records one event and returns the updated state. */
  hit(key: string, windowMs: number): Promise<RateLimitState>;
  /** Reads the state without recording an event. */
  peek(key: string): Promise<RateLimitState>;
  /** Clears a key (e.g. failed-attempt counter after a successful sign-in). */
  reset(key: string): Promise<void>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

const KEY_PREFIX = 'veyra:rl:';

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, windowMs: number): Promise<RateLimitState> {
    const fullKey = KEY_PREFIX + key;
    // INCR and set-expiry-if-missing in one atomic round trip. PEXPIRE ... NX (Redis 7) starts
    // the window on the first event without extending it on later ones.
    const results = await this.redis
      .multi()
      .incr(fullKey)
      .pexpire(fullKey, windowMs, 'NX')
      .pttl(fullKey)
      .exec();
    if (!results) throw new Error('Rate limiter transaction aborted');
    for (const [error] of results) if (error) throw error;
    return { count: Number(results[0]?.[1]), resetInMs: Math.max(0, Number(results[2]?.[1])) };
  }

  async peek(key: string): Promise<RateLimitState> {
    const fullKey = KEY_PREFIX + key;
    const results = await this.redis.multi().get(fullKey).pttl(fullKey).exec();
    if (!results) throw new Error('Rate limiter transaction aborted');
    for (const [error] of results) if (error) throw error;
    const count = Number(results[0]?.[1] ?? 0);
    return {
      count: Number.isFinite(count) ? count : 0,
      resetInMs: Math.max(0, Number(results[1]?.[1])),
    };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + key);
  }
}
