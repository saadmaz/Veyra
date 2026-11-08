'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api-client';

export type QueryState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: unknown };

type Internal<T> = QueryState<T> & { path: string | null };

/**
 * Loads `path` from the API and re-loads when it changes or `reload()` is called. Pass null to
 * skip. A reload of the same path keeps showing the previous data until the new data arrives
 * (no flicker); a different path starts from a loading state. Stale responses are discarded.
 */
export function useApiQuery<T>(path: string | null): QueryState<T> & { reload(): void } {
  const [state, setState] = useState<Internal<T>>({ status: 'loading', path });
  const [version, setVersion] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers a reload.
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState((previous) =>
      previous.status === 'success' && previous.path === path
        ? previous
        : { status: 'loading', path },
    );
    api
      .get<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'success', data, path });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', error, path });
      });
    return () => controller.abort();
  }, [path, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const { path: _path, ...publicState } = state;
  return { ...(publicState as QueryState<T>), reload };
}
