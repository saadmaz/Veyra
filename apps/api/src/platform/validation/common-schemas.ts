import { isCountryCode } from '@veyra/domain';
import { z } from 'zod';

/** Validators shared by several modules. Business modules import these, not each other's rules. */

const TIME_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));
const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/** IANA zone such as "Asia/Karachi". "UTC" is accepted explicitly. */
export const timeZoneSchema = z
  .string()
  .refine((value) => value === 'UTC' || TIME_ZONES.has(value), 'Unknown IANA time zone');

/** ISO 3166-1 alpha-2, normalised to upper case. */
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use an ISO 3166-1 alpha-2 code')
  .refine(isCountryCode, 'Unknown country code');

/** ISO 4217, normalised to upper case. */
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((code) => CURRENCIES.has(code), 'Unknown ISO 4217 currency code');

/** Optional free text: trimmed, empty becomes undefined. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === '' ? undefined : value));

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
