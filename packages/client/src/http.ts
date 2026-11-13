import type { ErrorEnvelope } from '@veyra/api-contracts';

/*
 * The VEYRA API client shared by the console and the mobile apps (ADR 0008). It only moves
 * requests and errors: the API decides everything, and anything a client hides is a convenience.
 *
 *   Web:    the session is an httpOnly cookie the API sets on its own host; the browser sends it
 *           with `credentials: 'include'` and this code never sees it.
 *   Mobile: the session token comes from the platform secure store and travels as
 *           `Authorization: Bearer <token>` (ADR 0005).
 */

const BRAND = Symbol.for('veyra.ApiRequestError');

/**
 * A failed API call, carrying the stable error code from the error envelope. `instanceof` works
 * across copies of this module (bundlers and test runners can load it twice).
 */
export class ApiRequestError extends Error {
  readonly [BRAND] = true;

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[BRAND] === true
    );
  }

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

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers, e.g. Idempotency-Key. */
  headers?: Record<string, string>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientConfig {
  /** e.g. https://api.example.com/api/v1, without a trailing slash. */
  baseUrl: string;
  /** Web: send the session cookie. */
  credentials?: 'include' | 'omit' | 'same-origin';
  /** Mobile: the session token, sent as a bearer token when present. */
  getToken?: () => string | null | Promise<string | null>;
  /** Called after any 401, so an app can forget a session the API no longer accepts. */
  onUnauthenticated?: () => void;
  fetchImpl?: FetchLike;
}

const isAbort = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { name?: unknown }).name === 'AbortError';

export async function sendApiRequest<T>(
  config: ApiClientConfig,
  method: Method,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('API paths must be absolute paths on the API host');
  }
  const token = config.getToken ? await config.getToken() : null;
  const fetchImpl = config.fetchImpl ?? (fetch as FetchLike);
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      ...(config.credentials ? { credentials: config.credentials } : {}),
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiRequestError(0, NETWORK_ERROR, 'The service could not be reached');
  }

  if (response.status === 401) config.onUnauthenticated?.();
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

export interface ApiClient {
  request<T>(method: Method, path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const request = <T>(method: Method, path: string, options?: RequestOptions) =>
    sendApiRequest<T>(config, method, path, options);
  return {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    delete: (path, options) => request('DELETE', path, options),
  };
}

/** A file to upload: a browser File, or the bytes of a file picked on a phone. */
export interface UploadSource {
  name: string;
  type: string;
  size: number;
  body: Blob;
}

/**
 * PUTs bytes to the signed storage URL the API handed out (ADR 0007). The API then checks the
 * stored file before anyone can use it.
 */
export async function putToStorage(
  upload: { url: string; headers: Record<string, string> },
  body: Blob,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<void> {
  let stored: Response;
  try {
    stored = await fetchImpl(upload.url, { method: 'PUT', headers: upload.headers, body });
  } catch {
    throw new ApiRequestError(0, 'UPLOAD_FAILED', 'The file could not be uploaded');
  }
  if (!stored.ok) throw new ApiRequestError(stored.status, 'UPLOAD_FAILED', 'Upload refused');
}
