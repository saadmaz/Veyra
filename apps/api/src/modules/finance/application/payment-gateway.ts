/**
 * Payment gateway port (API_DESIGN: integrations through adapters). Core billing logic never
 * depends on a provider: an adapter creates the provider's checkout and turns its signed callback
 * into a GatewayEvent. VEYRA never sees or stores card data.
 */

export interface CheckoutRequest {
  amountMinor: bigint;
  currency: string;
  description: string;
}

export interface Checkout {
  /** The provider's id for this payment; callbacks refer to it. */
  providerReference: string;
  /** Where the payer completes the payment. */
  checkoutUrl: string;
}

export interface GatewayEvent {
  /** Unique per provider: the same event delivered twice is processed once. */
  eventId: string;
  providerReference: string;
  type: 'payment.succeeded' | 'payment.failed';
  amountMinor: bigint;
  currency: string;
}

export type CallbackHeaders = Record<string, string | string[] | undefined>;

export interface PaymentGateway {
  /** Adapter key used in routes and stored on intents, e.g. "sandbox". */
  readonly key: string;
  createCheckout(request: CheckoutRequest): Promise<Checkout>;
  /**
   * Verifies the callback's signature over the exact raw body and parses it. Null when the
   * signature is missing, wrong or too old, or the body is not a valid event.
   */
  verifyCallback(rawBody: Buffer, headers: CallbackHeaders, now: Date): GatewayEvent | null;
}

/** The configured adapters by key (empty when no gateway is configured). */
export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');
export type PaymentGateways = ReadonlyMap<string, PaymentGateway>;
