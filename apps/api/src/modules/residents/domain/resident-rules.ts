import { z } from 'zod';
import {
  listQuerySchema,
  phoneSchema,
  plateSchema,
} from '../../../platform/validation/common-schemas';

/*
 * Input rules for residents (DATA_MODEL section 4). The database repeats the essential ones
 * (CHECK and exclusion constraints, share-sum trigger).
 */

/** Calendar date YYYY-MM-DD (property-local; no time, no zone). */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Not a real calendar date');

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === '' ? undefined : value));

const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }))
  .transform((value) => value.toLowerCase());

const phone = phoneSchema;

const languageTag = z
  .string()
  .trim()
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language tag such as en or ur-PK');

export const createPersonSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: email.optional(),
  phone: phone.optional(),
  preferredLanguage: languageTag.optional(),
});
export type CreatePersonInput = z.infer<typeof createPersonSchema>;

/** null clears an optional field. */
export const updatePersonSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    preferredLanguage: languageTag.nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Provide at least one field to change',
  });
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;

export const personSearchSchema = listQuerySchema.extend({
  query: optionalTrimmed(100),
});

const share = z.object({
  personId: z.uuid(),
  shareNumerator: z.number().int().min(1),
  shareDenominator: z.number().int().min(1).max(1_000_000),
});

/** Exact sum of fractions; true when it is exactly one. BigInt avoids rounding and overflow. */
export function fractionsSumToOne(
  parts: { shareNumerator: number; shareDenominator: number }[],
): boolean {
  let numerator = 0n;
  let denominator = 1n;
  for (const part of parts) {
    const n = BigInt(part.shareNumerator);
    const d = BigInt(part.shareDenominator);
    numerator = numerator * d + n * denominator;
    denominator *= d;
  }
  return parts.length > 0 && numerator === denominator;
}

/**
 * Sets the owners of a unit from a date: current owners end the day before, the new owners
 * start on that date. Records the first owner and transfers alike.
 */
export const setOwnersSchema = z
  .object({
    effectiveFrom: dateSchema,
    owners: z.array(share).min(1).max(50),
  })
  .refine((value) => value.owners.every((o) => o.shareNumerator <= o.shareDenominator), {
    message: 'A share cannot exceed the whole',
    path: ['owners'],
  })
  .refine((value) => new Set(value.owners.map((o) => o.personId)).size === value.owners.length, {
    message: 'Each person can appear once',
    path: ['owners'],
  })
  .refine((value) => fractionsSumToOne(value.owners), {
    message: 'Shares must add up to exactly one (for example 1/2 + 1/2, or 1/3 + 2/3)',
    path: ['owners'],
  });
export type SetOwnersInput = z.infer<typeof setOwnersSchema>;

const reason = z.string().trim().min(1).max(500);
export const voidOwnershipsSchema = z.object({
  ownershipIds: z.array(z.uuid()).min(1).max(50),
  reason,
});
export const voidSchema = z.object({ reason });

export const createTenancySchema = z
  .object({
    startDate: dateSchema,
    endDate: dateSchema.optional(),
    occupants: z
      .array(z.object({ personId: z.uuid(), isPrimary: z.boolean().default(false) }))
      .min(1)
      .max(20),
  })
  .refine((t) => t.endDate === undefined || t.endDate >= t.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  })
  .refine((t) => t.occupants.filter((o) => o.isPrimary).length === 1, {
    message: 'Choose exactly one primary tenant',
    path: ['occupants'],
  })
  .refine((t) => new Set(t.occupants.map((o) => o.personId)).size === t.occupants.length, {
    message: 'Each person can appear once',
    path: ['occupants'],
  });
export type CreateTenancyInput = z.infer<typeof createTenancySchema>;

/** Move-out: the last day (inclusive) of the tenancy or household period. */
export const endPeriodSchema = z.object({ endDate: dateSchema });

export const HOUSEHOLD_RELATIONSHIPS = [
  'SPOUSE_OR_PARTNER',
  'CHILD',
  'PARENT',
  'OTHER_RELATIVE',
  'DOMESTIC_STAFF',
  'OTHER',
] as const;

export const addHouseholdMemberSchema = z
  .object({
    personId: z.uuid(),
    relationship: z.enum(HOUSEHOLD_RELATIONSHIPS),
    validFrom: dateSchema,
    validTo: dateSchema.optional(),
  })
  .refine((h) => h.validTo === undefined || h.validTo >= h.validFrom, {
    message: 'The end date cannot be before the start date',
    path: ['validTo'],
  });
export type AddHouseholdMemberInput = z.infer<typeof addHouseholdMemberSchema>;

export const addVehicleSchema = z
  .object({
    /** Normalised: upper case, spaces removed. */
    plate: plateSchema,
    make: optionalTrimmed(60),
    model: optionalTrimmed(60),
    colour: optionalTrimmed(40),
    unitId: z.uuid().optional(),
    personId: z.uuid().optional(),
  })
  .refine((v) => v.unitId !== undefined || v.personId !== undefined, {
    message: 'Link the vehicle to a unit or a person',
    path: ['unitId'],
  });
export type AddVehicleInput = z.infer<typeof addVehicleSchema>;

export const addEmergencyContactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone,
  relationship: optionalTrimmed(60),
});
export type AddEmergencyContactInput = z.infer<typeof addEmergencyContactSchema>;
