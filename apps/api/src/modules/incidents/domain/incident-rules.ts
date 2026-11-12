import { z } from 'zod';

/*
 * Incidents (PRD 3.10, DATA_MODEL section 12). The database enforces the status machine, the
 * outcome and the follow-up rule again (migration 20261126090000_incidents). VEYRA records and
 * coordinates the response; it does not replace emergency services.
 */

export const INCIDENT_CATEGORIES = [
  'SECURITY',
  'FIRE',
  'MEDICAL',
  'FLOOD',
  'POWER',
  'LIFT',
  'GAS',
  'NOISE',
  'DAMAGE',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export type IncidentStatus = 'OPEN' | 'RESPONDING' | 'RESOLVED' | 'CLOSED';

const MOVES: Record<IncidentStatus, readonly IncidentStatus[]> = {
  OPEN: ['RESPONDING', 'RESOLVED'],
  RESPONDING: ['RESOLVED'],
  RESOLVED: ['RESPONDING', 'CLOSED'],
  CLOSED: [],
};

export function canMoveIncident(from: IncidentStatus, to: IncidentStatus) {
  return MOVES[from].includes(to);
}

/** Managers see every incident; other staff the ones not sensitive, and those they reported. */
export function canSeeIncident(
  incident: { sensitive: boolean; reportedByUserId: string },
  viewer: { userId: string; manager: boolean },
) {
  return viewer.manager || !incident.sensitive || incident.reportedByUserId === viewer.userId;
}

/** Whether people who run incidents are told at once (in-app and email). */
export const alertsManagers = (severity: IncidentSeverity) =>
  severity === 'HIGH' || severity === 'CRITICAL';

/** Escalation contacts for a kind of incident: those for every kind, or for this one. */
export function contactsFor<T extends { categories: IncidentCategory[]; active: boolean }>(
  contacts: T[],
  category: IncidentCategory | undefined,
): T[] {
  return contacts.filter(
    (c) => c.active && (!category || c.categories.length === 0 || c.categories.includes(category)),
  );
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

export const reportIncidentSchema = z
  .object({
    category: z.enum(INCIDENT_CATEGORIES),
    severity: z.enum(INCIDENT_SEVERITIES),
    title: text(160),
    description: text(4000),
    occurredAt: z.iso.datetime({ offset: true }),
    unitId: z.uuid().nullable().optional(),
    commonAreaId: z.uuid().nullable().optional(),
    locationDetail: optional(200),
    sensitive: z.boolean().optional(),
  })
  .refine((v) => !(v.unitId && v.commonAreaId), 'Choose a unit or a common area, not both')
  .refine((v) => new Date(v.occurredAt).getTime() <= Date.now() + 5 * 60_000, {
    message: 'An incident cannot happen in the future',
    path: ['occurredAt'],
  });
export type ReportIncidentInput = z.infer<typeof reportIncidentSchema>;

export const updateIncidentSchema = z
  .object({
    category: z.enum(INCIDENT_CATEGORIES),
    severity: z.enum(INCIDENT_SEVERITIES),
    sensitive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

export const moveIncidentSchema = z
  .object({
    status: z.enum(['RESPONDING', 'RESOLVED', 'CLOSED']),
    outcome: optional(4000),
  })
  .refine((v) => v.status !== 'RESOLVED' || Boolean(v.outcome), {
    message: 'Say how the incident ended',
    path: ['outcome'],
  });
export type MoveIncidentInput = z.infer<typeof moveIncidentSchema>;

export const noteSchema = z.object({ body: text(4000) });

export const actionSchema = z.object({
  description: text(500),
  assignedToUserId: z.uuid().nullable().optional(),
  dueOn: z.iso.date().nullable().optional(),
});
export type ActionInput = z.infer<typeof actionSchema>;

const contact = {
  name: text(120),
  role: text(120),
  phone: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[+0-9 ()-]+$/, 'Digits, spaces, +, - and brackets only'),
  email: z
    .email()
    .trim()
    .toLowerCase()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  categories: z.array(z.enum(INCIDENT_CATEGORIES)).max(INCIDENT_CATEGORIES.length),
  position: z.int().min(0).max(1000),
};
export const contactSchema = z.object(contact);
export type ContactInput = z.infer<typeof contactSchema>;
export const updateContactSchema = z
  .object({ ...contact, active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
