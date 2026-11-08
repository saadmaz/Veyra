import type { ReadinessResponse } from '@veyra/api-contracts';

export type ApiStatus = 'online' | 'degraded' | 'offline';

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Asks the API whether it and its dependencies are ready.
 * - online: 200 and every dependency up
 * - degraded: API reachable but reports a dependency down (503)
 * - offline: network failure, timeout or unexpected response
 */
export async function checkApiStatus(
  baseUrl: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<ApiStatus> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const res = await fetchImpl(`${baseUrl}/health/ready`, { signal: options.signal });
    if (res.status !== 200 && res.status !== 503) return 'offline';
    const body = (await res.json()) as Partial<ReadinessResponse>;
    if (res.ok && body.status === 'ok') return 'online';
    return body.status === 'error' ? 'degraded' : 'offline';
  } catch {
    return 'offline';
  }
}
