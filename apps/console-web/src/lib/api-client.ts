import {
  type ApiClient,
  ApiRequestError,
  NETWORK_ERROR,
  type RequestOptions,
  sendApiRequest,
} from '@veyra/client/http';

/**
 * Browser client for the VEYRA API, on the shared client (@veyra/client, ADR 0008).
 *
 * The session lives in an httpOnly cookie that the API sets on its own host. The browser sends
 * it with `credentials: 'include'` (console and API are the same site, so the SameSite=Lax
 * cookie is allowed). This code never sees the token. Authorisation is enforced by the API;
 * anything hidden in the UI is a convenience only.
 */

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1'
).replace(/\/+$/, '');

export { ApiRequestError, NETWORK_ERROR, type RequestOptions };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function apiRequest<T>(
  method: Method,
  path: string,
  options: RequestOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  return sendApiRequest<T>(
    { baseUrl: API_BASE_URL, credentials: 'include', fetchImpl },
    method,
    path,
    options,
  );
}

export const api: ApiClient = {
  request: (method, path, options) => apiRequest(method, path, options),
  get: (path, options) => apiRequest('GET', path, options),
  post: (path, body, options) => apiRequest('POST', path, { ...options, body }),
  put: (path, body, options) => apiRequest('PUT', path, { ...options, body }),
  patch: (path, body, options) => apiRequest('PATCH', path, { ...options, body }),
  delete: (path, options) => apiRequest('DELETE', path, options),
};
