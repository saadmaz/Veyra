import type {
  LateEntry,
  OfflineListEntry,
  OfflineListResponse,
  PassRejectionReason,
} from '@veyra/api-contracts';

/*
 * Offline gate (Phase 5 Part 5). While online the gate screen keeps a short-lived list of the
 * passes usable in the next 4 hours: hashes only, never codes. Offline, a scanned or typed pass
 * is hashed exactly as the API does and looked up; admissions, refusals and departures queue on
 * this device and are sent when the connection returns. The server re-checks every entry at the
 * time it happened and flags the ones the pass would not have allowed.
 */

export const normaliseCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

/** SHA-256 as lowercase hex. Each platform supplies its own (WebCrypto, expo-crypto). */
export type Sha256Hex = (value: string) => Promise<string>;

/** Hashes a scanned token or a typed code exactly as the API stores them. */
export function gateHashes(sha256hex: Sha256Hex) {
  return {
    hashToken: (token: string) => sha256hex(`token:${token}`),
    hashCode: (propertyId: string, code: string) =>
      sha256hex(`code:${propertyId}:${normaliseCode(code)}`),
  };
}

/** Offline-only reasons on top of the API's own. */
export type OfflineRejection = PassRejectionReason | 'LIST_EXPIRED' | 'NO_LIST';

export type OfflineCheck =
  | { valid: true; entry: OfflineListEntry }
  | { valid: false; reason: OfflineRejection };

/**
 * Checks a pass against the offline list. Refuses everything once the list is past its
 * trustUntil (owner decision: 4 hours), so a stale copy never decides on its own.
 * `queuedAdmissions` counts admissions on this device not yet sent, per passId.
 */
export function checkOffline(
  list: OfflineListResponse | null,
  match: { tokenHash?: string; codeHash?: string },
  queuedAdmissions: ReadonlyMap<string, number>,
  now: number = Date.now(),
): OfflineCheck {
  if (!list) return { valid: false, reason: 'NO_LIST' };
  if (now > Date.parse(list.trustUntil)) return { valid: false, reason: 'LIST_EXPIRED' };
  const entry = list.entries.find((e) =>
    match.tokenHash ? e.tokenHash === match.tokenHash : e.codeHash === match.codeHash,
  );
  if (!entry) return { valid: false, reason: 'NOT_FOUND' };
  if (now < Date.parse(entry.validFrom)) return { valid: false, reason: 'NOT_YET_VALID' };
  if (now > Date.parse(entry.validUntil)) return { valid: false, reason: 'EXPIRED' };
  if (entry.entriesLeft - (queuedAdmissions.get(entry.passId) ?? 0) <= 0) {
    return { valid: false, reason: 'NO_ENTRIES_LEFT' };
  }
  return { valid: true, entry };
}

/** A queued entry plus what the guard needs to see about it while it waits. */
export interface QueuedEntry {
  entry: LateEntry;
  label: string;
}

export function queuedAdmissionsByPass(queue: readonly QueuedEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { entry } of queue) {
    if (entry.kind === 'ADMIT' && entry.passId) {
      counts.set(entry.passId, (counts.get(entry.passId) ?? 0) + 1);
    }
  }
  return counts;
}

/*
 * Storage keys per property. Each app keeps the list and queue on the device only: the list
 * holds visitor names, plates and unit numbers for at most 4 hours ahead, is replaced on every
 * refresh and is ignored once expired.
 */
export const offlineListKey = (propertyId: string) => `veyra.offline-list.${propertyId}`;
export const offlineQueueKey = (propertyId: string) => `veyra.offline-queue.${propertyId}`;
