/**
 * An error with a fixed HTTP status and a stable machine-readable code, for cases that are not
 * business-rule violations (those are DomainError -> 422): authentication, conflicts, rate
 * limits. Messages must be safe to show to any caller.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
