import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_CORS_ORIGINS: csv,
  DATABASE_URL: z
    .string()
    .url()
    .refine((url) => /^postgres(ql)?:\/\//.test(url), 'DATABASE_URL must be a PostgreSQL URL'),
  REDIS_URL: z
    .string()
    .url()
    .refine((url) => /^rediss?:\/\//.test(url), 'REDIS_URL must be a Redis URL'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Parses and validates the environment once at boot. Invalid configuration stops the process
 * with a readable list of problems instead of failing later at first use.
 * Secrets are never echoed: only variable names and messages are reported.
 */
export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const result = apiEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid API configuration:\n${problems}`);
  }
  return result.data;
}

export const API_ENV = Symbol('API_ENV');
