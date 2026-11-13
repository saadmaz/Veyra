import type { OfflineListResponse } from '@veyra/api-contracts';

import {
  gateHashes,
  offlineListKey,
  offlineQueueKey,
  type QueuedEntry,
} from '@veyra/client/offline-gate';

export * from '@veyra/client/offline-gate';

const encoder = new TextEncoder();

async function sha256hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const { hashToken, hashCode } = gateHashes(sha256hex);

// ------------------------------------------------------------------ device storage

/*
 * Stored per property in this browser only. The list holds visitor names, plates and unit
 * numbers for at most 4 hours ahead; it is replaced on every refresh and ignored once expired.
 * Every read and write tolerates blocked storage (private windows): the gate then works online
 * only, and says so.
 */

const listKey = offlineListKey;
const queueKey = offlineQueueKey;

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadOfflineList = (propertyId: string) =>
  read<OfflineListResponse>(listKey(propertyId));
export const saveOfflineList = (propertyId: string, list: OfflineListResponse | null) =>
  write(listKey(propertyId), list);
export const loadQueue = (propertyId: string) => read<QueuedEntry[]>(queueKey(propertyId)) ?? [];
export const saveQueue = (propertyId: string, queue: QueuedEntry[]) =>
  write(queueKey(propertyId), queue.length > 0 ? queue : null);
