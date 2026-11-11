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

const encoder = new TextEncoder();

async function sha256hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const normaliseCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
export const hashToken = (token: string) => sha256hex(`token:${token}`);
export const hashCode = (propertyId: string, code: string) =>
  sha256hex(`code:${propertyId}:${normaliseCode(code)}`);

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

// ------------------------------------------------------------------ device storage

/*
 * Stored per property in this browser only. The list holds visitor names, plates and unit
 * numbers for at most 4 hours ahead; it is replaced on every refresh and ignored once expired.
 * Every read and write tolerates blocked storage (private windows): the gate then works online
 * only, and says so.
 */

const listKey = (propertyId: string) => `veyra.offline-list.${propertyId}`;
const queueKey = (propertyId: string) => `veyra.offline-queue.${propertyId}`;

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
