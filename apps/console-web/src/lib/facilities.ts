import type {
  FacilityBookingStatus,
  FacilityDto,
  FacilitySlotDto,
  OpeningRangeDto,
} from '@veyra/api-contracts';

/*
 * Facility helpers for the console (Phase 8). The API decides what can be booked and by whom;
 * these only shape what is shown.
 */

export const BOOKING_STATUS_LABELS: Record<FacilityBookingStatus, string> = {
  PENDING: 'waiting for approval',
  CONFIRMED: 'confirmed',
  REJECTED: 'declined',
  CANCELLED: 'cancelled',
  COMPLETED: 'used',
  NO_SHOW: 'not used',
};

export const BOOKING_STATUS_TONES: Record<
  FacilityBookingStatus,
  'success' | 'warning' | 'muted' | 'danger'
> = {
  PENDING: 'warning',
  CONFIRMED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'muted',
  COMPLETED: 'muted',
  NO_SHOW: 'danger',
};

export const SLOT_STATE_LABELS: Record<FacilitySlotDto['state'], string> = {
  OPEN: 'free',
  FULL: 'full',
  CLOSED: 'closed',
  TOO_SOON: 'too soon to book',
  TOO_FAR: 'not open for booking yet',
};

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** Today's calendar date ("YYYY-MM-DD") in a time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** "1 hour", "30 minutes", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.join(' ') || '0 minutes';
}

/** Weekly hours as lines like "Monday to Sunday: 06:00–22:00". Days with the same hours merge. */
export function describeHours(ranges: readonly OpeningRangeDto[]): string[] {
  const byDay = WEEKDAYS.map((_, i) =>
    ranges
      .filter((r) => r.weekday === i + 1)
      .map((r) => `${r.opensAt}–${r.closesAt}`)
      .join(', '),
  );
  const lines: string[] = [];
  let start = 0;
  for (let i = 1; i <= 7; i++) {
    if (i === 7 || byDay[i] !== byDay[start]) {
      const hours = byDay[start] || 'closed';
      const days = i - 1 === start ? WEEKDAYS[start] : `${WEEKDAYS[start]} to ${WEEKDAYS[i - 1]}`;
      lines.push(`${days}: ${hours}`);
      start = i;
    }
  }
  return lines;
}

/** The booking rules a resident should know, in plain words. */
export function describeRules(f: FacilityDto): string[] {
  const rules = [
    `Slots of ${formatDuration(f.slotMinutes)}, up to ${f.maxSlotsPerBooking} in a row.`,
    f.capacity === 1 ? 'One booking at a time.' : `Up to ${f.capacity} bookings at the same time.`,
    f.approvalRequired
      ? 'Bookings wait for the property team to approve them.'
      : 'Bookings are confirmed at once.',
    `Book up to ${f.maxAdvanceDays} days ahead${f.minNoticeMinutes > 0 ? `, at least ${formatDuration(f.minNoticeMinutes)} before` : ''}.`,
  ];
  if (f.maxUpcomingPerUnit !== null) {
    rules.push(`A home can hold ${f.maxUpcomingPerUnit} upcoming booking(s) here.`);
  }
  if (f.cancellationMinutes > 0) {
    rules.push(`Cancel here up to ${formatDuration(f.cancellationMinutes)} before the start.`);
  }
  return rules;
}

/** Every day open at the same hours, as the create form offers. */
export function everyDay(opensAt: string, closesAt: string): OpeningRangeDto[] {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opensAt, closesAt }));
}
