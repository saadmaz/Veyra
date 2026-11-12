import { z } from 'zod';

/*
 * Staff operations (PRD 3.7, DATA_MODEL section 10). The database enforces the rules again
 * (migration 20261121090000_staff_shifts); these give a clear answer before it does.
 */

export type ShiftStatus = 'SCHEDULED' | 'STARTED' | 'ENDED' | 'CANCELLED';

/** A shift can be started from this long before it is due to start until it is due to end. */
export const EARLY_START_MINUTES = 60;

export function canStart(startsAt: Date, endsAt: Date, now: Date): boolean {
  return (
    now.getTime() >= startsAt.getTime() - EARLY_START_MINUTES * 60_000 &&
    now.getTime() < endsAt.getTime()
  );
}

const MINUTE = 60_000;
export const MIN_SHIFT_MINUTES = 15;
export const MAX_SHIFT_MINUTES = 24 * 60;

export function shiftLengthProblem(startsAt: Date, endsAt: Date): string | null {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / MINUTE;
  if (minutes < MIN_SHIFT_MINUTES) return 'A shift is at least 15 minutes';
  if (minutes > MAX_SHIFT_MINUTES) return 'A shift is at most 24 hours';
  return null;
}

// ------------------------------------------------------------------ input schemas

const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const departmentSchema = z.object({ name: text(80) });
export const memberSchema = z.object({ userId: z.uuid() });

const times = z.object({ startsAt: instant, endsAt: instant }).superRefine((v, ctx) => {
  const problem = shiftLengthProblem(v.startsAt, v.endsAt);
  if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['endsAt'] });
});

export const createShiftSchema = z.object({ departmentId: z.uuid(), userId: z.uuid() }).and(times);
export type CreateShiftInput = z.infer<typeof createShiftSchema>;

export const rescheduleSchema = times;
export type RescheduleInput = z.infer<typeof rescheduleSchema>;

export const shiftListQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  departmentId: z.uuid().optional(),
  userId: z.uuid().optional(),
});
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;

export const reasonSchema = z.object({ reason: text(1000) });
export const handoverSchema = z.object({ handoverNote: text(4000) });
