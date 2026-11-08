import { z } from 'zod';
import {
  countryCodeSchema,
  currencySchema,
  listQuerySchema,
  optionalText,
  timeZoneSchema,
} from '../../../platform/validation/common-schemas';
import { PROPERTY_TYPES } from './property-rules';

/*
 * Input rules for property settings and the building / floor / unit / common-area structure.
 * Database CHECK constraints repeat the essential ones (DATA_MODEL section 3).
 */

const name = z.string().trim().min(1).max(120);
const code = (max: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'Use letters, digits and single hyphens')
    .min(1)
    .max(max);

/**
 * Positive decimal sent as a string ("85.50"), never as a JSON number, so values never pass
 * through floating point. Stored as DECIMAL.
 */
const positiveDecimal = (integerDigits: number, fractionDigits: number) =>
  z
    .string()
    .trim()
    .regex(
      new RegExp(`^\\d{1,${integerDigits}}(\\.\\d{1,${fractionDigits}})?$`),
      `Use a positive number with up to ${fractionDigits} decimals, as a string`,
    )
    .refine((value) => /[1-9]/.test(value), 'Must be greater than zero');

export const UNIT_TYPES = [
  'APARTMENT',
  'PENTHOUSE',
  'STUDIO',
  'DUPLEX',
  'VILLA',
  'TOWNHOUSE',
  'SHOP',
  'OFFICE',
  'STORAGE',
  'OTHER',
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const COMMON_AREA_TYPES = [
  'LOBBY',
  'POOL',
  'GYM',
  'CLUBHOUSE',
  'FUNCTION_ROOM',
  'SPORTS_FACILITY',
  'PLAYGROUND',
  'GARDEN',
  'PARKING',
  'OTHER',
] as const;
export type CommonAreaType = (typeof COMMON_AREA_TYPES)[number];

const atLeastOne = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Provide at least one field to change',
  });

/**
 * Country and currency can change only while the property is ONBOARDING (checked by the
 * service): afterwards, financial records depend on them.
 */
export const updatePropertySchema = atLeastOne({
  name: name.optional(),
  type: z.enum(PROPERTY_TYPES).optional(),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: optionalText(200),
  city: z.string().trim().min(1).max(100).optional(),
  region: optionalText(100),
  postalCode: optionalText(20),
  timeZone: timeZoneSchema.optional(),
  countryCode: countryCodeSchema.optional(),
  currency: currencySchema.optional(),
});
export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;

export const createBuildingSchema = z.object({ name, code: code(20) });
export const updateBuildingSchema = atLeastOne({
  name: name.optional(),
  code: code(20).optional(),
});

export const createFloorSchema = z.object({
  level: z.number().int().min(-20).max(300),
  name: z.string().trim().min(1).max(60),
});
export const updateFloorSchema = atLeastOne({
  level: z.number().int().min(-20).max(300).optional(),
  name: z.string().trim().min(1).max(60).optional(),
});

export const createUnitSchema = z
  .object({
    number: z.string().trim().min(1).max(40),
    type: z.enum(UNIT_TYPES),
    buildingId: z.uuid().optional(),
    floorId: z.uuid().optional(),
    areaSqm: positiveDecimal(8, 2).optional(),
    shareRatio: positiveDecimal(6, 6).optional(),
  })
  .refine((unit) => unit.floorId === undefined || unit.buildingId !== undefined, {
    message: 'A floor requires a building',
    path: ['floorId'],
  });
/** Moving a unit between buildings is not supported; number, type and measures can change. */
export const updateUnitSchema = atLeastOne({
  number: z.string().trim().min(1).max(40).optional(),
  type: z.enum(UNIT_TYPES).optional(),
  areaSqm: positiveDecimal(8, 2).nullable().optional(),
  shareRatio: positiveDecimal(6, 6).nullable().optional(),
});

export const createCommonAreaSchema = z.object({
  name,
  type: z.enum(COMMON_AREA_TYPES),
  buildingId: z.uuid().optional(),
});
export const updateCommonAreaSchema = atLeastOne({
  name: name.optional(),
  type: z.enum(COMMON_AREA_TYPES).optional(),
});

/** Lists show active structure by default; ?status=ARCHIVED shows the archive. */
export const structureListSchema = listQuerySchema.extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).default('ACTIVE'),
});
export const unitListSchema = structureListSchema.extend({
  buildingId: z.uuid().optional(),
  floorId: z.uuid().optional(),
});

export type CreateBuildingInput = z.infer<typeof createBuildingSchema>;
export type UpdateBuildingInput = z.infer<typeof updateBuildingSchema>;
export type CreateFloorInput = z.infer<typeof createFloorSchema>;
export type UpdateFloorInput = z.infer<typeof updateFloorSchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;
export type CreateCommonAreaInput = z.infer<typeof createCommonAreaSchema>;
export type UpdateCommonAreaInput = z.infer<typeof updateCommonAreaSchema>;
export type StructureListQuery = z.infer<typeof structureListSchema>;
export type UnitListQuery = z.infer<typeof unitListSchema>;
