import { z } from 'zod';
import {
  countryCodeSchema,
  currencySchema,
  optionalText,
  timeZoneSchema,
} from '../../../platform/validation/common-schemas';

export const PROPERTY_TYPES = [
  'CONDOMINIUM',
  'APARTMENT_COMPLEX',
  'GATED_COMMUNITY',
  'MIXED_USE',
  'OTHER',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * New property. Country, time zone and currency default to the organisation's when omitted.
 * Database CHECK constraints repeat the format rules (DATA_MODEL section 3).
 */
export const createPropertySchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Short code unique in the organisation, e.g. "HVR": upper-case letters, digits, hyphens. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'Use letters, digits and single hyphens')
    .min(2)
    .max(20),
  type: z.enum(PROPERTY_TYPES),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: optionalText(200),
  city: z.string().trim().min(1).max(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  countryCode: countryCodeSchema.optional(),
  timeZone: timeZoneSchema.optional(),
  currency: currencySchema.optional(),
});
export type CreatePropertyInput = z.infer<typeof createPropertySchema>;
