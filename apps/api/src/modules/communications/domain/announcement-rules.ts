import { z } from 'zod';

/*
 * Announcements (PRD 3.9, DATA_MODEL section 11). The database enforces the rules again
 * (migration 20261123090000_announcements).
 */

export type AnnouncementStatus = 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';
export type Audience = 'EVERYONE' | 'RESIDENTS' | 'BUILDING_RESIDENTS' | 'STAFF';
export type Priority = 'NORMAL' | 'URGENT';

/** Whether an audience includes residents, and whether it includes staff. */
export const reachesResidents = (a: Audience) => a !== 'STAFF';
export const reachesStaff = (a: Audience) => a === 'EVERYONE' || a === 'STAFF';

const text = (max: number) => z.string().trim().min(1).max(max);

const content = {
  title: text(160),
  body: text(10000),
  priority: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
  audience: z.enum(['EVERYONE', 'RESIDENTS', 'BUILDING_RESIDENTS', 'STAFF']),
  buildingId: z.uuid().nullable().optional(),
  requiresAcknowledgement: z.boolean().default(false),
};

const oneBuilding = (v: {
  audience?: Audience | undefined;
  buildingId?: string | null | undefined;
}) => v.audience === undefined || (v.audience === 'BUILDING_RESIDENTS') === Boolean(v.buildingId);

export const draftSchema = z.object(content).refine(oneBuilding, {
  message: 'Choose a building for building residents only',
  path: ['buildingId'],
});
export type DraftInput = z.infer<typeof draftSchema>;

export const updateDraftSchema = z
  .object({
    ...content,
    priority: z.enum(['NORMAL', 'URGENT']),
    requiresAcknowledgement: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing')
  .refine(oneBuilding, {
    message: 'Choose a building for building residents only',
    path: ['buildingId'],
  });
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

export const announcementListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED', 'WITHDRAWN']).optional(),
});

export const withdrawSchema = z.object({ reason: text(1000) });
