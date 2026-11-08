import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  REDIS_URL: z
    .string()
    .url()
    .refine((url) => /^rediss?:\/\//.test(url), 'REDIS_URL must be a Redis URL'),
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
