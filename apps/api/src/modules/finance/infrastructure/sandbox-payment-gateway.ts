import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  CallbackHeaders,
  Checkout,
  CheckoutRequest,
  GatewayEvent,
  PaymentGateway,
} from '../application/payment-gateway';

/** Header carrying "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>". */
export const SANDBOX_SIGNATURE_HEADER = 'veyra-sandbox-signature';
/** Callbacks older or newer than this are refused (replay protection). */
const TOLERANCE_SECONDS = 300;

const eventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['payment.succeeded', 'payment.failed']),
  data: z.object({
    reference: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
    amountMinor: z.string().regex(/^\d{1,19}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
});

/** Signs a sandbox callback body as the sandbox provider would (tests and local simulation). */
export function signSandboxPayload(secret: string, rawBody: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

/**
 * A stand-in provider for development and tests: no money moves. Its callbacks are signed like
 * real providers' (HMAC over timestamp and raw body), so the callback path is exercised exactly
 * as it will be with a real adapter. Never enabled in production (env validation).
 */
export class SandboxPaymentGateway implements PaymentGateway {
  readonly key = 'sandbox';

  constructor(private readonly secret: string) {}

  async createCheckout(_request: CheckoutRequest): Promise<Checkout> {
    const providerReference = `sbx_${randomBytes(18).toString('base64url')}`;
    return {
      providerReference,
      checkoutUrl: `https://sandbox.payments.invalid/checkout/${providerReference}`,
    };
  }

  verifyCallback(rawBody: Buffer, headers: CallbackHeaders, now: Date): GatewayEvent | null {
    const header = headers[SANDBOX_SIGNATURE_HEADER];
    if (typeof header !== 'string') return null;
    const parts = Object.fromEntries(
      header.split(',').map((part) => {
        const [k, ...v] = part.trim().split('=');
        return [k, v.join('=')];
      }),
    );
    const t = Number(parts.t);
    const v1 = parts.v1;
    if (!Number.isInteger(t) || typeof v1 !== 'string' || !/^[0-9a-f]{64}$/.test(v1)) return null;
    if (Math.abs(now.getTime() / 1000 - t) > TOLERANCE_SECONDS) return null;
    const expected = createHmac('sha256', this.secret).update(`${t}.`).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(v1, 'hex'))) return null;

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) return null;
    return {
      eventId: parsed.data.id,
      providerReference: parsed.data.data.reference,
      type: parsed.data.type,
      amountMinor: BigInt(parsed.data.data.amountMinor),
      currency: parsed.data.data.currency,
    };
  }
}
