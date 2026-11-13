import { useCallback, useEffect, useRef, useState } from 'react';
import { useClient } from './session';

export type QueryState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: unknown };

/**
 * Loads `path` and reloads when it changes or `reload()` is called; null skips. A reload keeps
 * showing the previous data until new data arrives. Stale responses are discarded.
 */
export function useApiQuery<T>(
  path: string | null,
): QueryState<T> & { reload(): void; refreshing: boolean } {
  const client = useClient();
  const [state, setState] = useState<QueryState<T> & { path: string | null }>({
    status: 'loading',
    path,
  });
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version triggers a reload.
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState((previous) =>
      previous.status === 'success' && previous.path === path
        ? previous
        : { status: 'loading', path },
    );
    client
      .get<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'success', data, path });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', error, path });
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [client, path, version]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setVersion((v) => v + 1);
  }, []);
  const { path: _path, ...publicState } = state;
  return { ...(publicState as QueryState<T>), reload, refreshing };
}

/** Runs one change at a time and keeps its error for the screen to show. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);
  return { pending, error, run, clear: () => setError(null) };
}
