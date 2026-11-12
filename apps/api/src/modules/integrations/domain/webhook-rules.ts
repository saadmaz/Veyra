import { z } from 'zod';

/*
 * Webhooks (Phase 12 Part 3, DATA_MODEL section 11). The database checks the endpoint shape and
 * the delivery rules again (migration 20261129090000_webhooks); the worker checks the resolved
 * address before every send.
 */

/** Events an endpoint can subscribe to. Payloads carry references and states, never people. */
export const WEBHOOK_EVENTS = [
  'incident.reported',
  'incident.closed',
  'approval_request.created',
  'approval_request.settled',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Sent on request to check an endpoint; every endpoint takes it. */
export const TEST_EVENT = 'webhook.test';

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|[0-9.]+|\[.*\])$/i;

/** HTTPS to a named, public-looking host (no IP literals, localhost or internal names). */
export function webhookUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter a full URL such as https://example.com/hooks';
  }
  if (parsed.protocol !== 'https:') return 'Webhooks are sent only over HTTPS';
  if (parsed.username || parsed.password) return 'Leave credentials out of the URL';
  if (PRIVATE_HOST.test(parsed.hostname)) return 'Use a public host name, not an address';
  if (parsed.hash) return 'Leave the #fragment out';
  return null;
}

const url = z
  .string()
  .trim()
  .min(12)
  .max(500)
  .superRefine((value, ctx) => {
    const problem = webhookUrlProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
const events = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .transform((list) => [...new Set(list)]);
const description = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

export const endpointSchema = z.object({ url, events, description });
export type EndpointInput = z.infer<typeof endpointSchema>;

export const updateEndpointSchema = z
  .object({ url, events, description, status: z.enum(['ACTIVE', 'DISABLED']) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');
export type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>;

/** The body sent for an event. */
export function envelope(event: {
  id: string;
  type: string;
  organisationId: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}) {
  return {
    id: event.id,
    type: event.type,
    organisationId: event.organisationId,
    occurredAt: event.occurredAt.toISOString(),
    data: event.data,
  };
}
