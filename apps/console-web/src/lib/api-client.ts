import type { ErrorEnvelope } from '@veyra/api-contracts';

/**
 * Browser client for the VEYRA API.
 *
 * The session lives in an httpOnly cookie that the API sets on its own host. The browser sends
 * it with `credentials: 'include'` (console and API are the same site, so the SameSite=Lax
 * cookie is allowed). This code never sees the token. Authorisation is enforced by the API;
 * anything hidden in the UI is a convenience only.
 */

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1'
).replace(/\/+$/, '');

/** A failed API call, carrying the stable error code from the error envelope. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { path: string; message: string }[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Status 0: the API could not be reached (offline, DNS, CORS, server down). */
export const NETWORK_ERROR = 'NETWORK_ERROR';

type Method = 'GET' | 'POST' | 'PATCH';

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T>(
  method: Method,
  path: string,
  options: RequestOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('API paths must be absolute paths on the API host');
  }
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, NETWORK_ERROR, 'The service could not be reached');
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);
  if (response.ok) return payload as T;

  const envelope = payload as Partial<ErrorEnvelope> | undefined;
  const error = envelope?.error;
  throw new ApiRequestError(
    response.status,
    error?.code ?? 'HTTP_ERROR',
    error?.message ?? `Request failed with status ${response.status}`,
    error?.details ?? [],
    error?.requestId,
  );
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => apiRequest<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>('PATCH', path, { ...options, body }),
};
