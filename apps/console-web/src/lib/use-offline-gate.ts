'use client';

import type {
  LateEntry,
  LateEntryResult,
  OfflineListResponse,
  SyncLateEntriesResponse,
} from '@veyra/api-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api, NETWORK_ERROR } from './api-client';
import {
  loadOfflineList,
  loadQueue,
  type QueuedEntry,
  saveOfflineList,
  saveQueue,
} from './offline-gate';

/** Whether VEYRA can be reached, as far as the browser knows or a failed request showed. */
export function useConnection() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  const markOffline = useCallback(() => setOnline(false), []);
  return { online, markOffline };
}

export const isNetworkError = (error: unknown) =>
  error instanceof ApiRequestError && error.code === NETWORK_ERROR;

/** Refresh the offline list this often while online. */
const LIST_REFRESH_MS = 15 * 60_000;

export interface SyncSummary {
  at: string;
  recorded: number;
  /** Recorded, but a supervisor will review them. */
  flagged: string[];
  /** Could not be recorded at all: write these in the paper log. */
  failed: { label: string; error: string }[];
}

/**
 * The gate device's offline state for one property: the offline list (refreshed while online),
 * the queue of entries made while offline, and sending that queue when the connection returns.
 */
export function useOfflineGate(propertyId: string, base: string, online: boolean) {
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
      api
        .get<OfflineListResponse>(`${base}/gate/offline-list`)
        .then((fresh) => {
          if (cancelled) return;
          setList(fresh);
          saveOfflineList(propertyId, fresh);
        })
        .catch(() => undefined); // Keep the previous list; it expires on its own.
    void refresh();
    const timer = window.setInterval(refresh, LIST_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [online, base, propertyId]);

  const enqueue = useCallback(
    (entry: Omit<LateEntry, 'clientRef' | 'occurredAt'>, label: string) => {
      const queued: QueuedEntry = {
        label,
        entry: { ...entry, clientRef: crypto.randomUUID(), occurredAt: new Date().toISOString() },
      };
      setQueue((current) => {
        const next = [...current, queued];
        saveQueue(propertyId, next);
        return next;
      });
      return queued.entry.clientRef;
    },
    [propertyId],
  );

  // Send the queue once the connection is back. Entries the server answered (recorded, already
  // recorded or refused) leave the queue; on a network error everything stays for next time.
  useEffect(() => {
    if (!online || queue.length === 0 || syncing.current) return;
    syncing.current = true;
    const batch = queue.slice(0, 200);
    api
      .post<SyncLateEntriesResponse>(`${base}/gate/late-entries`, {
        source: 'OFFLINE_SYNC',
        entries: batch.map((q) => q.entry),
      })
      .then(({ results }) => {
        const byRef = new Map<string, LateEntryResult>(results.map((r) => [r.clientRef, r]));
        const summary: SyncSummary = {
          at: new Date().toISOString(),
          recorded: 0,
          flagged: [],
          failed: [],
        };
        for (const q of batch) {
          const result = byRef.get(q.entry.clientRef);
          if (!result) continue;
          if (result.status === 'REJECTED') {
            summary.failed.push({ label: q.label, error: result.error ?? 'REJECTED' });
          } else {
            summary.recorded += 1;
            if (result.reviewReason) summary.flagged.push(q.label);
          }
        }
        setLastSync(summary);
        setQueue((current) => {
          const next = current.filter((q) => !byRef.has(q.entry.clientRef));
          saveQueue(propertyId, next);
          return next;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        syncing.current = false;
      });
  }, [online, queue, base, propertyId]);

  return { list, queue, enqueue, lastSync };
}

export type OfflineGate = ReturnType<typeof useOfflineGate>;
