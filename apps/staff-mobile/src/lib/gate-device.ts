import type { OfflineListResponse } from '@veyra/api-contracts';
import {
  gateHashes,
  offlineListKey,
  offlineQueueKey,
  type QueuedEntry,
} from '@veyra/client/offline-gate';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

/*
 * The gate's device side: SHA-256 from expo-crypto (Hermes has no WebCrypto), and the offline
 * list and queue as files in the app's private storage, per property. The list holds visitor
 * names, plates and unit numbers for at most 4 hours ahead; it is replaced on every refresh and
 * ignored once expired. Every read and write tolerates failure: the gate then works online only.
 */

export const { hashToken, hashCode } = gateHashes((value) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, {
    encoding: Crypto.CryptoEncoding.HEX,
  }),
);

export const newClientRef = () => Crypto.randomUUID();

const fileFor = (key: string) => new File(Paths.document, `${key}.json`);

function read<T>(key: string): T | null {
  try {
    const file = fileFor(key);
    return file.exists ? (JSON.parse(file.textSync()) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    const file = fileFor(key);
    if (value === null) {
      if (file.exists) file.delete();
      return true;
    }
    if (!file.exists) file.create();
    file.write(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadOfflineList = (propertyId: string) =>
  read<OfflineListResponse>(offlineListKey(propertyId));
export const saveOfflineList = (propertyId: string, list: OfflineListResponse | null) =>
  write(offlineListKey(propertyId), list);
export const loadQueue = (propertyId: string) =>
  read<QueuedEntry[]>(offlineQueueKey(propertyId)) ?? [];
export const saveQueue = (propertyId: string, queue: QueuedEntry[]) =>
  write(offlineQueueKey(propertyId), queue.length > 0 ? queue : null);
