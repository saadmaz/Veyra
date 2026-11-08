import { describe, expect, it, vi } from 'vitest';
import { checkApiStatus } from '../src/lib/api-client';

const respond = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

describe('checkApiStatus', () => {
  it('reports online when the API and its dependencies are ready', async () => {
    const fetchImpl = respond(200, { status: 'ok', checks: { database: 'up' } });
    await expect(checkApiStatus('https://api.test/api/v1', { fetchImpl })).resolves.toBe('online');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/api/v1/health/ready', {
      signal: undefined,
    });
  });

  it('reports degraded when a dependency is down', async () => {
    const fetchImpl = respond(503, { status: 'error', checks: { database: 'down' } });
    await expect(checkApiStatus('https://api.test', { fetchImpl })).resolves.toBe('degraded');
  });

  it('reports offline on network errors and unexpected responses', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(checkApiStatus('https://api.test', { fetchImpl: failing })).resolves.toBe(
      'offline',
    );
    await expect(checkApiStatus('https://api.test', { fetchImpl: respond(404, {}) })).resolves.toBe(
      'offline',
    );
    await expect(
      checkApiStatus('https://api.test', { fetchImpl: respond(200, { status: 'weird' }) }),
    ).resolves.toBe('offline');
  });
});
