import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { DomainError } from '@veyra/domain';
import type { Request, Response } from 'express';
import { ApiError } from './api-error';
import type { ErrorEnvelope } from './error-envelope';
import { ValidationFailedException } from './validation-failed.exception';

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Maps every thrown error to the standard error envelope. Unknown errors become a generic
 * 500 so internal details (stack traces, SQL, provider messages) never reach clients.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = request.requestId;

    const { status, body } = this.toEnvelope(exception);
    if (requestId) body.error.requestId = requestId;
    if (exception instanceof ApiError && exception.options.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(exception.options.retryAfterSeconds));
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} -> ${status} [${requestId ?? '-'}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(body);
  }

  private toEnvelope(exception: unknown): { status: number; body: ErrorEnvelope } {
    if (exception instanceof ValidationFailedException) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            details: exception.details,
          },
        },
      };
    }

    if (exception instanceof ApiError) {
      return {
        status: exception.status,
        body: { error: { code: exception.code, message: exception.message } },
      };
    }

    if (exception instanceof DomainError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        body: { error: { code: exception.code, message: exception.message } },
      };
    }

    const dbCode = databaseErrorCode(exception);
    if (dbCode === 'VE401' || dbCode === 'VE402') {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          error: {
            code: 'PLAN_LIMIT_REACHED',
            message:
              dbCode === 'VE401'
                ? 'Your plan allows no more properties. Change the plan to add more.'
                : 'Your plan allows no more units. Change the plan to add more.',
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR');
      const message = status >= 500 ? 'Internal server error' : this.httpMessage(exception);
      return { status, body: { error: { code, message } } };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    };
  }

  private httpMessage(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object' && 'message' in response) {
      const message = (response as { message: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join('; ');
    }
    return exception.message;
  }
}
