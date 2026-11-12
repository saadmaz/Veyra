import { z } from 'zod';

/*
 * Governance (PRD 3.11, DATA_MODEL section 11). The database enforces seats, meeting states,
 * minutes approval and resolution permanence again (migration 20261127090000_governance). The
 * application records decisions taken by the committee; it does not run votes.
 */

export const COMMITTEE_POSITIONS = [
  'CHAIR',
  'VICE_CHAIR',
  'SECRETARY',
  'TREASURER',
  'MEMBER',
] as const;
export type CommitteePosition = (typeof COMMITTEE_POSITIONS)[number];
export type MeetingStatus = 'SCHEDULED' | 'HELD' | 'CANCELLED';
export type ResolutionOutcome = 'PASSED' | 'REJECTED' | 'DEFERRED';

/** Whether a seat is held on `today` (YYYY-MM-DD). */
export const seatCurrent = (seat: { termStart: string; termEnd: string | null }, today: string) =>
  seat.termStart <= today && (seat.termEnd === null || seat.termEnd >= today);

/** What can still happen to a meeting. */
export function meetingAllows(
  meeting: { status: MeetingStatus; minutesApproved: boolean },
  what: 'edit' | 'agenda' | 'hold' | 'cancel' | 'minutes' | 'resolution' | 'approve',
) {
  if (meeting.status === 'SCHEDULED') return ['edit', 'agenda', 'hold', 'cancel'].includes(what);
  if (meeting.status === 'HELD' && !meeting.minutesApproved) {
    return ['minutes', 'resolution', 'approve'].includes(what);
  }
  return false;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : (v ?? null)));

export const committeeSchema = z.object({ name: text(120), purpose: optional(2000) });
export type CommitteeInput = z.infer<typeof committeeSchema>;
export const updateCommitteeSchema = committeeSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');

export const seatSchema = z
  .object({
    userId: z.uuid(),
    position: z.enum(COMMITTEE_POSITIONS),
    termStart: z.iso.date(),
    termEnd: z.iso.date().nullable().optional(),
  })
  .refine((v) => !v.termEnd || v.termEnd >= v.termStart, {
    message: 'The term cannot end before it starts',
    path: ['termEnd'],
  });
export type SeatInput = z.infer<typeof seatSchema>;
export const endSeatSchema = z.object({ termEnd: z.iso.date() });

const agendaItem = z.object({ title: text(200), details: optional(2000) });
export const meetingSchema = z.object({
  title: text(160),
  scheduledAt: z.iso.datetime({ offset: true }),
  location: optional(200),
  agenda: z.array(agendaItem).max(100).default([]),
});
export type MeetingInput = z.infer<typeof meetingSchema>;
export const updateMeetingSchema = z
  .object({
    title: text(160),
    scheduledAt: z.iso.datetime({ offset: true }),
    location: optional(200),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
export const agendaItemSchema = agendaItem;
export type AgendaItemInput = z.infer<typeof agendaItem>;
export const cancelSchema = z.object({ reason: text(500) });
export const minutesSchema = z.object({ minutes: text(50000) });

const count = z.int().min(0).max(100000).nullable().optional();
export const resolutionSchema = z.object({
  title: text(200),
  text: text(10000),
  outcome: z.enum(['PASSED', 'REJECTED', 'DEFERRED']),
  votesFor: count,
  votesAgainst: count,
  abstentions: count,
  documentId: z.uuid().nullable().optional(),
});
export type ResolutionInput = z.infer<typeof resolutionSchema>;
