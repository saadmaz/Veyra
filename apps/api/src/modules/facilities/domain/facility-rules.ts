import { z } from 'zod';

/*
 * Facility and booking rules (PRD 3.6, DATA_MODEL section 8, owner decisions of 2026-11-12 in
 * ROADMAP). The database enforces every rule again under a per-facility lock (migration
 * 20261117090000_facilities); these give a clear answer before it does.
 */

export type FacilityStatus = 'ACTIVE' | 'ARCHIVED';
export type BookingStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'NO_SHOW';

export const LIVE_BOOKING: readonly BookingStatus[] = ['PENDING', 'CONFIRMED'];

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  PENDING: ['CONFIRMED', 'REJECTED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED', 'COMPLETED', 'NO_SHOW'],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
};

export const canMoveBooking = (from: BookingStatus, to: BookingStatus) =>
  TRANSITIONS[from].includes(to);

/** Rejecting, and cancelling a confirmed booking, need a reason. */
export const needsReason = (from: BookingStatus, to: BookingStatus) =>
  to === 'REJECTED' || (from === 'CONFIRMED' && to === 'CANCELLED');

export const formatBookingNumber = (n: bigint) => `BK-${n.toString().padStart(6, '0')}`;

/** Whether a resident may still cancel: before the facility's cancellation window. */
export const residentMayCancel = (startsAt: Date, cancellationMinutes: number, now: Date) =>
  now.getTime() <= startsAt.getTime() - cancellationMinutes * 60_000;

// ------------------------------------------------------------------ times

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** "HH:MM" to minutes after midnight (24:00 = 1440). */
export const minutesOf = (time: string) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Minutes after midnight to "HH:MM". */
export const timeOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export interface OpeningRange {
  weekday: number;
  opensAt: string;
  closesAt: string;
}

/** The first problem with a week of opening hours, or null. */
export function openingHoursProblem(ranges: readonly OpeningRange[]): string | null {
  for (const r of ranges) {
    if (minutesOf(r.closesAt) <= minutesOf(r.opensAt)) {
      return `On day ${r.weekday} closing must be after opening`;
    }
  }
  for (let day = 1; day <= 7; day++) {
    const sorted = ranges
      .filter((r) => r.weekday === day)
      .sort((a, b) => minutesOf(a.opensAt) - minutesOf(b.opensAt));
    for (let i = 1; i < sorted.length; i++) {
      if (
        minutesOf((sorted[i] as OpeningRange).opensAt) <
        minutesOf((sorted[i - 1] as OpeningRange).closesAt)
      ) {
        return `Opening hours on day ${day} overlap`;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ input schemas

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

const range = z.object({
  weekday: z.int().min(1).max(7),
  opensAt: z.string().regex(TIME, 'Use HH:MM'),
  closesAt: z.string().regex(TIME, 'Use HH:MM'),
});

const openingHours = z
  .array(range)
  .max(70)
  .superRefine((ranges, ctx) => {
    const problem = openingHoursProblem(ranges);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const settings = {
  description: optionalText(2000),
  slotMinutes: z
    .int()
    .min(5)
    .max(1440)
    .refine((v) => v % 5 === 0, 'Use a multiple of 5 minutes'),
  capacity: z.int().min(1).max(1000),
  approvalRequired: z.boolean(),
  minNoticeMinutes: z.int().min(0).max(525600),
  maxAdvanceDays: z.int().min(1).max(730),
  maxSlotsPerBooking: z.int().min(1).max(288),
  maxUpcomingPerUnit: z.int().min(1).max(100).nullable(),
  cancellationMinutes: z.int().min(0).max(525600),
};

export const createFacilitySchema = z.object({
  commonAreaId: z.uuid(),
  ...settings,
  capacity: settings.capacity.default(1),
  approvalRequired: settings.approvalRequired.default(false),
  minNoticeMinutes: settings.minNoticeMinutes.default(0),
  maxAdvanceDays: settings.maxAdvanceDays.default(30),
  maxSlotsPerBooking: settings.maxSlotsPerBooking.default(1),
  maxUpcomingPerUnit: settings.maxUpcomingPerUnit.default(null),
  cancellationMinutes: settings.cancellationMinutes.default(0),
  openingHours: openingHours.default([]),
});
export type CreateFacilityInput = z.infer<typeof createFacilitySchema>;

export const updateFacilitySchema = z
  .object({ ...settings, description: z.string().trim().max(2000).nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one setting');
export type UpdateFacilityInput = z.infer<typeof updateFacilitySchema>;

export const openingHoursSchema = z.object({ openingHours });

export const closureSchema = z
  .object({
    startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    endsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    reason: text(500),
    /** Cancel the pending and confirmed bookings in the period (with the reason) first. */
    cancelBookings: z.boolean().default(false),
  })
  .refine((v) => v.endsAt > v.startsAt, { message: 'End after the start', path: ['endsAt'] });
export type ClosureInput = z.infer<typeof closureSchema>;

export const availabilityQuerySchema = z.object({
  /** A property-local calendar date. */
  date: z.iso.date(),
});

export const bookingSchema = z.object({
  facilityId: z.uuid(),
  /** The start of the first slot, as given by the availability route. */
  startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  slots: z.int().min(1).max(288).default(1),
  purpose: optionalText(200),
});
export type BookingInput = z.infer<typeof bookingSchema>;

export const bookingListQuerySchema = z.object({
  status: z
    .enum(['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'])
    .optional(),
  facilityId: z.uuid().optional(),
  unitId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type BookingListQuery = z.infer<typeof bookingListQuerySchema>;

export const reasonSchema = z.object({ reason: text(1000) });
export const optionalReasonSchema = z.object({ reason: optionalText(1000) });
