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

export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_CORS_ORIGINS: csv,
    /**
     * Number of reverse proxies in front of the API (e.g. 1 behind Cloudflare or a load balancer).
     * Decides which X-Forwarded-For entry is the client IP, which rate limiting relies on. Leave 0
     * when clients connect directly, otherwise any client could spoof its IP.
     */
    API_TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    DATABASE_URL: z
      .string()
      .url()
      .refine((url) => /^postgres(ql)?:\/\//.test(url), 'DATABASE_URL must be a PostgreSQL URL'),
    REDIS_URL: z
      .string()
      .url()
      .refine((url) => /^rediss?:\/\//.test(url), 'REDIS_URL must be a Redis URL'),
    /**
     * Enables the sandbox payment gateway (no money moves) with this callback signing secret.
     * Development and test only: refused in production.
     */
    PAYMENT_SANDBOX_SECRET: z.string().min(32).optional(),
    /**
     * Two-step sign-in (Phase 14): the key that encrypts authenticator secrets (base64, at least
     * 32 bytes; the first 32 are used). Without it, setting up MFA answers 409.
     */
    MFA_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length >= 32, 'Use at least 32 bytes, base64')
      .optional(),
    /** "privileged" requires MFA for privileged changes; defaults to it in production only. */
    MFA_ENFORCEMENT: z.enum(['off', 'privileged']).optional(),
    /** The console's address, for links in account emails (verification, password reset). */
    CONSOLE_URL: z.string().url().default('http://localhost:3000'),
    /**
     * Master key for webhook signing secrets (Phase 12): at least 32 bytes, base64. The worker
     * needs the same value. Without it, webhook endpoints answer 409 WEBHOOKS_NOT_CONFIGURED.
     */
    WEBHOOK_SIGNING_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length >= 32, 'Use at least 32 bytes, base64')
      .optional(),
    /**
     * S3-compatible object storage for uploaded files (ADR 0007). Without STORAGE_BUCKET, file
     * features answer 409 STORAGE_NOT_CONFIGURED. STORAGE_ENDPOINT is omitted for AWS S3 and
     * must be reachable by browsers (signed URLs point at it).
     */
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_REGION: z.string().min(1).default('auto'),
    STORAGE_BUCKET: z.string().min(3).optional(),
    STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** true for SeaweedFS and other self-hosted servers (path-style URLs). */
    STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine(
    (env) =>
      env.STORAGE_BUCKET === undefined ||
      (env.STORAGE_ACCESS_KEY_ID !== undefined && env.STORAGE_SECRET_ACCESS_KEY !== undefined),
    {
      message: 'STORAGE_BUCKET needs STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY',
      path: ['STORAGE_BUCKET'],
    },
  )
  .refine((env) => env.NODE_ENV !== 'production' || env.PAYMENT_SANDBOX_SECRET === undefined, {
    message: 'The sandbox payment gateway cannot be enabled in production',
    path: ['PAYMENT_SANDBOX_SECRET'],
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
