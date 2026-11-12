import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  REDIS_URL: z
    .string()
    .url()
    .refine((url) => /^rediss?:\/\//.test(url), 'REDIS_URL must be a Redis URL'),
  /** The restricted application role (veyra_app): tenant jobs run under row-level security. */
  DATABASE_URL: z
    .string()
    .url()
    .refine((url) => /^postgres(ql)?:\/\//.test(url), 'DATABASE_URL must be a PostgreSQL URL'),
  /** How often the outbox relay looks for due events. */
  OUTBOX_POLL_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
  /** Email provider adapter. Only "log" exists yet: it accepts and logs delivery ids (Phase 10). */
  EMAIL_ADAPTER: z.enum(['log']).default('log'),
  /** The API's webhook master key (base64, at least 32 bytes); without it webhooks fail. */
  WEBHOOK_SIGNING_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length >= 32, 'Use at least 32 bytes, base64')
    .optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker configuration:\n${problems}`);
  }
  return result.data;
}
