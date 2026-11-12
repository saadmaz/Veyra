/*
 * The admin tool's API client: same-site cookie session (credentials included), JSON in and out,
 * errors as ApiError with the API's code and message. Platform routes answer 404 to anyone who is
 * not a platform administrator.
 */

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1'
).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API paths must be absolute');
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The service could not be reached');
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => undefined)) as unknown;
  if (response.ok) return payload as T;
  const error = (payload as { error?: { code?: string; message?: string; details?: [] } })?.error;
  throw new ApiError(
    response.status,
    error?.code ?? 'HTTP_ERROR',
    error?.message ?? `Request failed with status ${response.status}`,
    error?.details ?? [],
  );
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};

/** A message for people: the field problems of a refused form, or the API's own message. */
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.details.length > 0) return error.details.map((d) => d.message).join(' ');
  if (error.status === 0) return error.message;
  return error.message || 'Something went wrong. Try again.';
}
