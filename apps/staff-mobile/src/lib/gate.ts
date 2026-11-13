import type { LateEntry, LateEntryResult } from '@veyra/api-contracts';
import type { OfflineRejection, QueuedEntry } from '@veyra/client/offline-gate';
import { REJECTION_MESSAGES } from '@veyra/client/visitors';

/*
 * Gate rules that are the device's own (Phase 5 Part 5, ADR 0008): what a guard is told when a
 * pass is refused without a connection, how a queued entry is stamped, and what a sync result
 * means. The pass checks themselves are shared with the console (@veyra/client/offline-gate),
 * and the server re-checks every queued entry at the time it happened.
 */

export const OFFLINE_MESSAGES: Record<OfflineRejection, string> = {
  ...REJECTION_MESSAGES,
  LIST_EXPIRED:
    'The saved list is too old to trust. Do not let the visitor in on it: follow the paper procedure until the connection returns.',
  NO_LIST:
    'This device has no saved list yet. Follow the paper procedure until the connection returns.',
};

/** A queued entry, stamped with its own reference and the time it really happened. */
export function stampEntry(
  entry: Omit<LateEntry, 'clientRef' | 'occurredAt'>,
  clientRef: string,
  now: Date = new Date(),
): LateEntry {
  return { ...entry, clientRef, occurredAt: now.toISOString() };
}

export interface SyncSummary {
  at: string;
  recorded: number;
  /** Recorded, but a supervisor will review them (the pass would not have allowed it). */
  flagged: string[];
  /** Could not be recorded at all: these go in the paper log. */
  failed: { label: string; error: string }[];
}

/**
 * Reads the server's answers for a sent batch. Answered entries (recorded, already recorded or
 * refused) leave the queue; unanswered ones stay for the next attempt.
 */
export function readSyncResults(
  batch: readonly QueuedEntry[],
  results: readonly LateEntryResult[],
  at: Date = new Date(),
): { summary: SyncSummary; answered: Set<string> } {
  const byRef = new Map(results.map((r) => [r.clientRef, r]));
  const summary: SyncSummary = { at: at.toISOString(), recorded: 0, flagged: [], failed: [] };
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
  return { summary, answered: new Set(byRef.keys()) };
}

/** Minutes until the saved list stops being trusted, or null when there is none or it expired. */
export function listMinutesLeft(trustUntil: string | undefined, now: number = Date.now()) {
  if (!trustUntil) return null;
  const left = Math.floor((Date.parse(trustUntil) - now) / 60_000);
  return left >= 0 ? left : null;
}
