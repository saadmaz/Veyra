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

// ---------------------------------------------------------------------------------------------
// Authentication (ADR 0005)
// ---------------------------------------------------------------------------------------------

/** `web` gets an httpOnly cookie; `mobile` gets a bearer token in the response body. */
export type AuthClient = 'web' | 'mobile';

export interface SignUpRequest {
  email: string;
  password: string;
  displayName: string;
  client?: AuthClient;
}

export interface SignInRequest {
  email: string;
  password: string;
  client?: AuthClient;
}

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthSessionDto {
  client: AuthClient;
  /** ISO 8601. Extended by activity, never beyond absoluteExpiresAt. */
  idleExpiresAt: string;
  /** ISO 8601. The session ends here regardless of activity. */
  absoluteExpiresAt: string;
}

/** Response of sign-up and sign-in. `token` is present only for `mobile` clients. */
export interface AuthResponse {
  user: AuthUserDto;
  session: AuthSessionDto;
  token?: string;
}

/** Response of GET /auth/session. */
export interface CurrentSessionResponse {
  user: AuthUserDto;
  session: { client: AuthClient };
}
