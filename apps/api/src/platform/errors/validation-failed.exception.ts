import type { ErrorDetail } from './error-envelope';

export class ValidationFailedException extends Error {
  constructor(readonly details: ErrorDetail[]) {
    super('Request validation failed');
    this.name = 'ValidationFailedException';
  }
}
