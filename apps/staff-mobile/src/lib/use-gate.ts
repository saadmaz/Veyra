import type { LateEntry, OfflineListResponse, SyncLateEntriesResponse } from '@veyra/api-contracts';
import { ApiRequestError, NETWORK_ERROR } from '@veyra/client/http';
import type { QueuedEntry } from '@veyra/client/offline-gate';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { readSyncResults, type SyncSummary, stampEntry } from './gate';
import {
  loadOfflineList,
  loadQueue,
  newClientRef,
  saveOfflineList,
  saveQueue,
} from './gate-device';
import { useClient } from './session';

export const isNetworkError = (error: unknown) =>
  error instanceof ApiRequestError && error.code === NETWORK_ERROR;

/** Refresh the offline list this often while online; check the connection this often offline. */
const LIST_REFRESH_MS = 15 * 60_000;
const RECONNECT_MS = 20_000;

/**
 * Whether VEYRA can be reached, as the last request showed. While offline it checks again every
 * 20 seconds and whenever the app comes back to the foreground.
 */
export function useConnection() {
  const client = useClient();
  const [online, setOnline] = useState(true);
  const markOffline = useCallback(() => setOnline(false), []);
  const check = useCallback(
    () =>
      client
        .get('/health/live')
        .then(() => setOnline(true))
        .catch((error: unknown) => {
          // Any answer from the API means it can be reached.
          setOnline(!isNetworkError(error));
        }),
    [client],
  );
  useEffect(() => {
    if (online) return;
    const timer = setInterval(check, RECONNECT_MS);
    const subscription = AppState.addEventListener('change', (s) => s === 'active' && check());
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [online, check]);
  return { online, markOffline, check };
}

/**
 * The gate device's offline state for one property: the saved list (refreshed while online), the
 * queue of entries made offline, and sending that queue when the connection returns.
 */
export function useOfflineGate(propertyId: string, base: string, online: boolean) {
  const client = useClient();
  const [list, setList] = useState<OfflineListResponse | null>(null);
  const [queue, setQueue] = useState<QueuedEntry[]>([]);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const syncing = useRef(false);

  useEffect(() => {
    setList(loadOfflineList(propertyId));
    setQueue(loadQueue(propertyId));
  }, [propertyId]);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    const refresh = () =>
      client
        .get<OfflineListResponse>(`${base}/gate/offline-list`)
        .then((fresh) => {
          if (cancelled) return;
          setList(fresh);
          saveOfflineList(propertyId, fresh);
        })
        .catch(() => undefined); // Keep the previous list; it expires on its own.
    void refresh();
    const timer = setInterval(refresh, LIST_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, online, base, propertyId]);

  const enqueue = useCallback(
    (entry: Omit<LateEntry, 'clientRef' | 'occurredAt'>, label: string) => {
      const queued: QueuedEntry = { label, entry: stampEntry(entry, newClientRef()) };
      setQueue((current) => {
        const next = [...current, queued];
        saveQueue(propertyId, next);
        return next;
      });
      return queued.entry.clientRef;
    },
    [propertyId],
  );

  useEffect(() => {
    if (!online || queue.length === 0 || syncing.current) return;
    syncing.current = true;
    const batch = queue.slice(0, 200);
    client
      .post<SyncLateEntriesResponse>(`${base}/gate/late-entries`, {
        source: 'OFFLINE_SYNC',
        entries: batch.map((q) => q.entry),
      })
      .then(({ results }) => {
        const { summary, answered } = readSyncResults(batch, results);
        setLastSync(summary);
        setQueue((current) => {
          const next = current.filter((q) => !answered.has(q.entry.clientRef));
          saveQueue(propertyId, next);
          return next;
        });
      })
      .catch(() => undefined) // Everything stays queued for the next attempt.
      .finally(() => {
        syncing.current = false;
      });
  }, [client, online, queue, base, propertyId]);

  return { list, queue, enqueue, lastSync };
}

export type OfflineGate = ReturnType<typeof useOfflineGate>;
