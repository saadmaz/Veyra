import type { PassRejectionReason, WalkInRequestStatus } from '@veyra/api-contracts';

/*
 * Visitor helpers. Visit times are instants; people enter and read them as wall-clock times in
 * the property's IANA time zone, whatever the time zone of the device in their hand.
 */

export const VISITOR_CATEGORIES = ['GUEST', 'DELIVERY', 'CONTRACTOR', 'SERVICE_PROVIDER'] as const;

/** UTC offset of a time zone at an instant, in minutes (e.g. +300 for Asia/Karachi). */
function offsetMinutes(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

/**
 * A wall-clock time at the property ("2026-11-12T18:00", as from <input type="datetime-local">)
 * to an ISO instant. Returns null for malformed input.
 */
export function zonedLocalToInstant(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset around daylight-saving changes.
  let instant = naive - offsetMinutes(naive, timeZone) * 60_000;
  instant = naive - offsetMinutes(instant, timeZone) * 60_000;
  return new Date(instant).toISOString();
}

/** An instant as the property's wall-clock time, for a datetime-local input. */
export function instantToZonedLocal(instant: Date | string, timeZone: string): string {
  const ms = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  const local = new Date(ms + offsetMinutes(ms, timeZone) * 60_000);
  return local.toISOString().slice(0, 16);
}

/** "12 Nov 2026, 18:00" in the property's time zone. */
export function formatInstant(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

/** "18:00" in the property's time zone. */
export function formatTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

/** What a guard is told when a pass is refused. Never personal data. */
export const REJECTION_MESSAGES: Record<PassRejectionReason, string> = {
  NOT_FOUND: 'No pass matches this code at this property.',
  REVOKED: 'This pass was cancelled.',
  NOT_YET_VALID: 'This pass is not valid yet.',
  EXPIRED: 'This pass has expired.',
  NO_ENTRIES_LEFT: 'This pass has already been used.',
  HOST_NO_LONGER_RESIDENT: 'The resident who registered this visitor no longer lives there.',
};

export const WALK_IN_STATUS_LABELS: Record<WalkInRequestStatus, string> = {
  PENDING: 'Waiting for the resident',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  CANCELLED: 'Cancelled',
  EXPIRED: 'No answer in time',
};

/** Seconds until a deadline, never negative. */
export function secondsUntil(instant: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(instant) - now) / 1000));
}
