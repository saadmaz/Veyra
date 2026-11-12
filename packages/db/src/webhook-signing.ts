import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Webhook secrets and signatures (Phase 12 Part 3), shared by the API (which shows an endpoint's
 * secret once) and the worker (which signs deliveries). Server-only.
 *
 * Secrets are derived, never stored: HMAC-SHA256(master key, "veyra.webhook:<endpoint>:<version>"),
 * so rotating means raising the version. A delivery carries
 *   Veyra-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Receivers recompute it and reject old timestamps (we suggest five minutes).
 */

/** The master key must be at least 32 bytes, given as base64. */
export function parseWebhookKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length < 32) throw new Error('WEBHOOK_SIGNING_KEY must be at least 32 bytes (base64)');
  return key;
}

export function webhookSecret(masterKey: Buffer, endpointId: string, version: number): string {
  const mac = createHmac('sha256', masterKey)
    .update(`veyra.webhook:${endpointId}:${version}`)
    .digest('base64url');
  return `whsec_${mac}`;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** Checks a signature header (for tests and for receivers written in TypeScript). */
export function verifyWebhook(
  secret: string,
  header: string,
  body: string,
  now: number,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > toleranceSeconds || !parts.v1) return false;
  const expected = Buffer.from(signWebhook(secret, t, body).split('v1=')[1] as string, 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
