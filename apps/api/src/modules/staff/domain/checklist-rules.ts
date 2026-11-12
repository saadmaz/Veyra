import { z } from 'zod';

/*
 * Checklists and inspections (PRD 3.7, DATA_MODEL section 10). The database enforces every rule
 * again (migration 20261122090000_checklists).
 */

export type ChecklistStatus = 'OPEN' | 'SUBMITTED' | 'VERIFIED' | 'CANCELLED';
export type ChecklistResult = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

export const MAX_CHECKS = 50;

/** Whether every check has an answer. */
export const complete = (items: readonly { result: ChecklistResult | null }[]) =>
  items.length > 0 && items.every((i) => i.result !== null);

/** How many checks failed. */
export const failures = (items: readonly { result: ChecklistResult | null }[]) =>
  items.filter((i) => i.result === 'FAIL').length;

const text = (max: number) => z.string().trim().min(1).max(max);

export const templateSchema = z.object({
  title: text(120),
  departmentId: z.uuid().nullable().optional(),
  items: z.array(text(200)).min(1).max(MAX_CHECKS),
});
export type TemplateInput = z.infer<typeof templateSchema>;

export const updateTemplateSchema = templateSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const assignSchema = z.object({
  templateId: z.uuid(),
  assignedToUserId: z.uuid(),
  dueOn: z.iso.date(),
  shiftId: z.uuid().optional(),
});
export type AssignInput = z.infer<typeof assignSchema>;

export const checklistListQuerySchema = z.object({
  status: z.enum(['OPEN', 'SUBMITTED', 'VERIFIED', 'CANCELLED']).optional(),
  userId: z.uuid().optional(),
});

export const answerSchema = z
  .object({
    result: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']),
    note: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => (v === '' ? undefined : v)),
  })
  .refine((v) => v.result !== 'FAIL' || v.note !== undefined, {
    message: 'Say what was wrong',
    path: ['note'],
  });
export type AnswerInput = z.infer<typeof answerSchema>;

export const noteSchema = z.object({ reason: text(1000) });
