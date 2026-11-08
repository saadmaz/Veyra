import { z } from 'zod';

/**
 * Password rules follow NIST SP 800-63B: length matters, composition rules do not. No
 * "must contain a symbol" rules; any printable Unicode is allowed, including spaces.
 * Breached-password screening is a follow-up (ADR 0005).
 */
export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound keeps hashing cost bounded (denial-of-service protection). */
export const PASSWORD_MAX_LENGTH = 128;

/** Emails are compared and stored lower-case and trimmed (matches the database CHECK). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }))
  .transform(normaliseEmail);

/** Unicode-normalised so the same password typed on different devices hashes identically. */
const passwordSchema = z
  .string()
  .transform((value) => value.normalize('NFKC'))
  .refine((value) => [...value].length >= PASSWORD_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  .refine((value) => [...value].length <= PASSWORD_MAX_LENGTH, {
    message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  });

const clientSchema = z.enum(['web', 'mobile']).default('web');

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(100),
  client: clientSchema,
});

/**
 * Sign-in does not apply the length policy: rejecting a short password here would tell an
 * attacker something about the account. It only bounds the size of the input.
 */
export const signInSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH * 4)
    .transform((value) => value.normalize('NFKC')),
  client: clientSchema,
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
