import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ValidationFailedException } from '../errors/validation-failed.exception';

/**
 * Validates and parses a request part (body, query, params) against a Zod schema.
 * Usage: `@Body(new ZodValidationPipe(createUnitSchema)) body: CreateUnitInput`.
 * The parsed value (with defaults and coercions applied) replaces the raw input, and unknown
 * keys are stripped by Zod's default object behaviour.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationFailedException(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
