/**
 * Violation of a business rule. Carries a stable machine-readable code that the API maps
 * to the standard error envelope (see docs/architecture/API_DESIGN.md).
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
