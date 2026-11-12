import { TRADES } from '@veyra/domain';
import { z } from 'zod';
import { PRIORITIES } from './maintenance-rules';

/*
 * Assets and preventive maintenance (PRD 3.8, DATA_MODEL section 9). The database enforces the
 * rules again (migration 20261120090000_assets); these give a clear answer before it does.
 */

export type AssetStatus = 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED';
export type IntervalUnit = 'DAY' | 'WEEK' | 'MONTH';

/**
 * The date one interval after `date` (YYYY-MM-DD). Months keep the day of the month, or the last
 * day of a shorter month (31 January + 1 month = 28 or 29 February).
 */
export function addInterval(date: string, unit: IntervalUnit, count: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (unit !== 'MONTH') {
    const t = new Date(Date.UTC(y, m - 1, d + count * (unit === 'WEEK' ? 7 : 1)));
    return t.toISOString().slice(0, 10);
  }
  const months = m - 1 + count;
  const year = y + Math.floor(months / 12);
  const month = months % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last))).toISOString().slice(0, 10);
}

/** Whether work for this due date should be raised today: within `leadDays` of it, or late. */
export function isDue(nextDueOn: string, leadDays: number, today: string): boolean {
  return addInterval(nextDueOn, 'DAY', -leadDays) <= today;
}

/**
 * The next due date after raising work for `dueOn`: one interval on, and further until it is
 * after today, so missed periods are skipped instead of raised all at once.
 */
export function nextDueAfter(
  dueOn: string,
  unit: IntervalUnit,
  count: number,
  today: string,
): string {
  let next = addInterval(dueOn, unit, count);
  while (next <= today) next = addInterval(next, unit, count);
  return next;
}

// ------------------------------------------------------------------ input schemas

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const place = {
  unitId: z.uuid().optional(),
  commonAreaId: z.uuid().optional(),
};
const onePlace = (v: { unitId?: string | undefined; commonAreaId?: string | undefined }) =>
  (v.unitId === undefined) !== (v.commonAreaId === undefined);

const details = {
  name: text(120),
  category: z.enum(TRADES),
  manufacturer: optional(120),
  model: optional(120),
  serialNumber: optional(120),
  installedOn: z.iso.date().nullable().optional(),
  warrantyExpiresOn: z.iso.date().nullable().optional(),
  supplierVendorId: z.uuid().nullable().optional(),
  notes: optional(2000),
};

export const createAssetSchema = z
  .object({
    tag: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(
        z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,29}$/, 'Use letters, digits, dots and hyphens'),
      ),
    ...details,
    ...place,
  })
  .refine(onePlace, { message: 'Give either a unit or a common area', path: ['unitId'] });
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = z
  .object({ ...details, ...place })
  .partial()
  .refine((v) => v.unitId === undefined || v.commonAreaId === undefined, {
    message: 'Give either a unit or a common area',
    path: ['unitId'],
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one detail');
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

export const assetListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED']).optional(),
});

export const assetReasonSchema = z.object({ reason: text(1000) });

const schedule = {
  title: text(120),
  description: optional(2000),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  intervalUnit: z.enum(['DAY', 'WEEK', 'MONTH']),
  intervalCount: z.int().min(1).max(366),
  nextDueOn: z.iso.date(),
  leadDays: z.int().min(0).max(90).default(7),
  vendorId: z.uuid().nullable().optional(),
};

export const createScheduleSchema = z.object(schedule);
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = z
  .object({
    ...schedule,
    priority: z.enum(PRIORITIES),
    leadDays: z.int().min(0).max(90),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one setting');
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
