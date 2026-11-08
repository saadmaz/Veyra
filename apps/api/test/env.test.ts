import { describe, expect, it } from 'vitest';
import { loadApiEnv } from '../src/platform/config/env';

const valid = {
  DATABASE_URL: 'postgresql://veyra:secret@localhost:5432/veyra',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadApiEnv', () => {
  it('applies defaults and parses lists', () => {
    const env = loadApiEnv({ ...valid, API_CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.API_CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('coerces the port and rejects out-of-range values', () => {
    expect(loadApiEnv({ ...valid, API_PORT: '8080' }).API_PORT).toBe(8080);
    expect(() => loadApiEnv({ ...valid, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('lists every missing or invalid variable', () => {
    expect(() => loadApiEnv({ REDIS_URL: 'http://not-redis' })).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL/,
    );
  });

  it('rejects non-PostgreSQL database URLs', () => {
    expect(() => loadApiEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /PostgreSQL/,
    );
  });

  it('never includes secret values in the error message', () => {
    try {
      loadApiEnv({ DATABASE_URL: 'mysql://root:topsecret@db/x', REDIS_URL: valid.REDIS_URL });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('topsecret');
    }
  });
});
