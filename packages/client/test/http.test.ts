import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createApiClient, NETWORK_ERROR, putToStorage } from '../src/http';
import { gateHashes, normaliseCode } from '../src/offline-gate';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createApiClient', () => {
  it('sends the mobile session as a bearer token and no cookie mode', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true }));
    const client = createApiClient({
      baseUrl: 'https://api.test/api/v1/',
      getToken: async () => 'tok-123',
      fetchImpl,
    });
    await expect(client.post('/units', { a: 1 })).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/units');
    expect(init.credentials).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('sends no Authorization header without a token', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await createApiClient({ baseUrl: 'https://api.test', getToken: () => null, fetchImpl }).get(
      '/x',
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('tells the app when the API no longer accepts the session', async () => {
    const onUnauthenticated = vi.fn();
    const fetchImpl = vi.fn(async () =>
      json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }),
    );
    const client = createApiClient({ baseUrl: 'https://api.test', onUnauthenticated, fetchImpl });
    await expect(client.get('/auth/session')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('reports unreachable APIs as a network error but lets aborts through', async () => {
    const offline = createApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await expect(offline.get('/x')).rejects.toMatchObject({ status: 0, code: NETWORK_ERROR });
    const aborted = createApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    await expect(aborted.get('/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses paths that could point at another host', async () => {
    const fetchImpl = vi.fn();
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await expect(client.get('//evil.example/x')).rejects.toThrow();
    await expect(client.get('https://evil.example')).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('putToStorage', () => {
  it('turns a refused or failed upload into UPLOAD_FAILED', async () => {
    const upload = { url: 'https://storage.test/k', headers: { 'Content-Type': 'image/png' } };
    await expect(
      putToStorage(upload, new Blob(['x']), async () => new Response(null, { status: 403 })),
    ).rejects.toEqual(expect.any(ApiRequestError));
    await expect(
      putToStorage(upload, new Blob(['x']), async () => {
        throw new TypeError('offline');
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED', status: 0 });
  });
});

describe('gateHashes', () => {
  it('hashes with the platform function, normalising typed codes', async () => {
    const seen: string[] = [];
    const { hashToken, hashCode } = gateHashes(async (v) => {
      seen.push(v);
      return `h(${v})`;
    });
    expect(await hashToken('abc')).toBe('h(token:abc)');
    expect(await hashCode('p1', 'k7q2 m9-xa')).toBe('h(code:p1:K7Q2M9XA)');
    expect(normaliseCode(' ab-c d')).toBe('ABCD');
    expect(seen).toHaveLength(2);
  });
});
