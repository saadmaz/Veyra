import type { RateLimiter, RateLimitState } from '../../src/platform/rate-limit/rate-limiter';

/** Same fixed-window semantics as RedisRateLimiter, in process. Tests only. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  failing = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async hit(key: string, windowMs: number): Promise<RateLimitState> {
    if (this.failing) throw new Error('limiter down');
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { count: window.count, resetInMs: window.resetAt - now };
  }

  async peek(key: string): Promise<RateLimitState> {
    if (this.failing) throw new Error('limiter down');
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) return { count: 0, resetInMs: 0 };
    return { count: window.count, resetInMs: window.resetAt - now };
  }

  async reset(key: string): Promise<void> {
    if (this.failing) throw new Error('limiter down');
    this.windows.delete(key);
  }

  clear(): void {
    this.windows.clear();
    this.failing = false;
  }
}
