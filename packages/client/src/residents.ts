import type { OwnershipDto } from '@veyra/api-contracts';

/*
 * Pure helpers for resident records. Dates are calendar dates (YYYY-MM-DD) in the property's own
 * time zone, as the API stores them; end dates are inclusive and null means open-ended.
 */

export interface Share {
  shareNumerator: number;
  shareDenominator: number;
}

/** Largest denominator the API accepts. */
const MAX_DENOMINATOR = 1_000_000;

/**
 * Reads an ownership share typed as "1", "1/2" or "2 / 3". Returns null unless it is a fraction
 * of positive whole numbers that is not more than the whole unit. Never uses floating point.
 */
export function parseShare(text: string): Share | null {
  const match = /^\s*(\d{1,7})\s*(?:\/\s*(\d{1,7})\s*)?$/.exec(text);
  if (!match) return null;
  const shareNumerator = Number(match[1]);
  const shareDenominator = match[2] === undefined ? 1 : Number(match[2]);
  if (shareNumerator < 1 || shareDenominator < 1 || shareDenominator > MAX_DENOMINATOR) return null;
  if (shareNumerator > shareDenominator) return null;
  return { shareNumerator, shareDenominator };
}

/** Exact check that the shares add up to one whole unit (same rule as the API). */
export function sharesSumToOne(shares: Share[]): boolean {
  let numerator = 0n;
  let denominator = 1n;
  for (const share of shares) {
    const n = BigInt(share.shareNumerator);
    const d = BigInt(share.shareDenominator);
    numerator = numerator * d + n * denominator;
    denominator *= d;
  }
  return shares.length > 0 && numerator === denominator;
}

export function formatShare(share: Share): string {
  return share.shareNumerator === share.shareDenominator
    ? 'Whole unit'
    : `${share.shareNumerator}/${share.shareDenominator}`;
}

/** Today's date (YYYY-MM-DD) in an IANA time zone, e.g. the property's. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** "2026-01-05" → "5 Jan 2026". The date is not shifted by the viewer's time zone. */
export function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

export function formatPeriod(from: string, to: string | null): string {
  return to === null ? `From ${formatDate(from)}` : `${formatDate(from)} to ${formatDate(to)}`;
}

export type PeriodStatus = 'CURRENT' | 'UPCOMING' | 'ENDED' | 'VOIDED';

export function periodStatus(
  from: string,
  to: string | null,
  voidedAt: string | null,
  today: string,
): PeriodStatus {
  if (voidedAt !== null) return 'VOIDED';
  if (from > today) return 'UPCOMING';
  if (to !== null && to < today) return 'ENDED';
  return 'CURRENT';
}

/** Owners recorded together (same start date): one ownership change, voided as a whole. */
export interface OwnershipGroup {
  key: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  owners: OwnershipDto[];
}

export function groupOwnerships(ownerships: OwnershipDto[]): OwnershipGroup[] {
  const groups = new Map<string, OwnershipGroup>();
  for (const o of ownerships) {
    const key = `${o.effectiveFrom}|${o.voidedAt ?? ''}`;
    const group = groups.get(key);
    if (group) {
      group.owners.push(o);
    } else {
      groups.set(key, {
        key,
        effectiveFrom: o.effectiveFrom,
        effectiveTo: o.effectiveTo,
        voidedAt: o.voidedAt,
        voidReason: o.voidReason,
        owners: [o],
      });
    }
  }
  // Newest first; within a date, live records before voided ones.
  return [...groups.values()].sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom
      ? Number(a.voidedAt !== null) - Number(b.voidedAt !== null)
      : a.effectiveFrom < b.effectiveFrom
        ? 1
        : -1,
  );
}
