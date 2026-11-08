/**
 * Wire-level types for the VEYRA REST API (docs/architecture/API_DESIGN.md).
 * Hand-written for platform-wide shapes; per-endpoint types will be generated from the
 * OpenAPI document once business endpoints exist.
 */

export interface ErrorDetail {
  path: string;
  message: string;
}

/** Body of every non-2xx response. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
  };
}

/** Cursor-paginated list response. */
export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

/** Monetary amount on the wire: minor units as a string so JSON never loses precision. */
export interface MoneyDto {
  amountMinor: string;
  currency: string;
}

export interface LivenessResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  checks: Record<string, 'up' | 'down'>;
}
