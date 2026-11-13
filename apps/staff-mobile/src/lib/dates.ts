import { zonedLocalToInstant } from '@veyra/client/visitors';

/*
 * Choosing a day and a time on a phone without a native picker: the property's next days as
 * chips and a typed 24-hour time. Days and times are the property's wall clock, whatever the
 * phone's own time zone.
 */

export interface DayOption {
  /** YYYY-MM-DD at the property. */
  date: string;
  label: string;
}

/** Today's date at the property, YYYY-MM-DD. */
export function todayAt(timeZone: string, now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

function addDaysTo(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The next `count` days at the property, starting today: "Today", "Tomorrow", "Sat 15 Nov". */
export function dayOptions(timeZone: string, count: number, now: number = Date.now()): DayOption[] {
  const today = todayAt(timeZone, now);
  return Array.from({ length: count }, (_, i) => {
    const date = addDaysTo(today, i);
    const label =
      i === 0
        ? 'Today'
        : i === 1
          ? 'Tomorrow'
          : new Intl.DateTimeFormat('en-GB', {
              timeZone: 'UTC',
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            }).format(new Date(`${date}T00:00:00Z`));
    return { date, label };
  });
}

/** "9:5", "09:05" or "0905" → "09:05"; null when it is not a time of day. */
export function parseClock(text: string): string | null {
  const match = /^\s*(\d{1,2})\s*[:.h]?\s*(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** A day and a typed time at the property as an ISO instant, or null if the time is invalid. */
export function instantAt(date: string, time: string, timeZone: string): string | null {
  const clock = parseClock(time);
  return clock ? zonedLocalToInstant(`${date}T${clock}`, timeZone) : null;
}

/** An instant plus whole hours, as an ISO instant. */
export const plusHours = (instant: string, hours: number) =>
  new Date(Date.parse(instant) + hours * 3_600_000).toISOString();
