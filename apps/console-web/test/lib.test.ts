import { describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, ApiRequestError, apiRequest, NETWORK_ERROR } from '../src/lib/api-client';
import { errorMessage, fieldErrors } from '../src/lib/messages';
import {
  invitationLink,
  readInvitationToken,
  safeNextPath,
  signInPath,
} from '../src/lib/navigation';
import { suggestSlug } from '../src/lib/slug';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('apiRequest', () => {
  it('sends credentials and JSON to the API base URL', async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    await expect(
      apiRequest('POST', '/auth/sign-in', { body: { email: 'a@b.test' } }, fetchMock),
    ).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/sign-in`);
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"email":"a@b.test"}');
  });

  it('turns the error envelope into ApiRequestError with its code and details', async () => {
    const fetchMock = vi.fn(async () =>
      json(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: [{ path: 'email', message: 'Enter a valid email address' }],
          requestId: 'req-1',
        },
      }),
    );
    const error = await apiRequest('POST', '/x', {}, fetchMock).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', requestId: 'req-1' });
    expect(fieldErrors(error)).toEqual({ email: 'Enter a valid email address' });
  });

  it('reports unreachable APIs as a network error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(apiRequest('GET', '/x', {}, fetchMock)).rejects.toMatchObject({
      status: 0,
      code: NETWORK_ERROR,
    });
  });

  it('returns undefined for 204 responses', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(apiRequest('POST', '/auth/sign-out', {}, fetchMock)).resolves.toBeUndefined();
  });

  it('refuses paths that could point at another host', async () => {
    const fetchMock = vi.fn();
    await expect(apiRequest('GET', '//evil.example/x', {}, fetchMock)).rejects.toThrow();
    await expect(apiRequest('GET', 'https://evil.example', {}, fetchMock)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('errorMessage', () => {
  it('uses friendly text for known codes and never shows server text for 5xx', () => {
    expect(errorMessage(new ApiRequestError(401, 'INVALID_CREDENTIALS', 'x'))).toMatch(/incorrect/);
    expect(
      errorMessage(new ApiRequestError(500, 'INTERNAL_ERROR', 'stack trace here')),
    ).not.toMatch(/stack/);
    expect(errorMessage(new Error('boom'))).not.toMatch(/boom/);
  });
});

describe('safeNextPath (open-redirect protection)', () => {
  it('keeps same-site paths with their query', () => {
    expect(safeNextPath('/organisations/abc?tab=members')).toBe('/organisations/abc?tab=members');
    expect(safeNextPath('/invitations/accept')).toBe('/invitations/accept');
  });

  it.each([
    'https://evil.example',
    '//evil.example/path',
    '/\\evil.example',
    'javascript:alert(1)',
    'organisations',
    '/\u0000evil',
    '',
    null,
  ])('rejects %j', (value) => {
    expect(safeNextPath(value)).toBe('/organisations');
  });

  it('builds sign-in links with a validated, encoded next path', () => {
    expect(signInPath('/organisations/1')).toBe('/sign-in?next=%2Forganisations%2F1');
    expect(signInPath('https://evil.example')).toBe('/sign-in?next=%2Forganisations');
  });
});

describe('invitation links', () => {
  const token = 'a'.repeat(43);

  it('put the token in the fragment, which browsers never send to servers', () => {
    const link = invitationLink('https://app.veyra.com', token);
    expect(link).toBe(`https://app.veyra.com/invitations/accept#token=${token}`);
    expect(new URL(link).search).toBe('');
  });

  it('read only well-formed tokens', () => {
    expect(readInvitationToken(`#token=${token}`)).toBe(token);
    expect(readInvitationToken('#token=short')).toBeNull();
    expect(readInvitationToken('')).toBeNull();
  });
});

describe('suggestSlug', () => {
  it('produces a valid slug from a display name', () => {
    expect(suggestSlug('Harbour View Résidences, Block B')).toBe('harbour-view-residences-block-b');
    expect(suggestSlug('  --  ')).toBe('');
    expect(suggestSlug('x'.repeat(80))).toHaveLength(63);
  });
});
