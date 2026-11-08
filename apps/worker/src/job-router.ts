import { assertJobEnvelope, DomainError, type JobEnvelope } from '@veyra/domain';

export type JobHandler<T = unknown> = (envelope: JobEnvelope<T>) => Promise<unknown>;

export interface JobDefinition<T = unknown> {
  /** Platform jobs run without a tenant; every other job must carry one. */
  readonly platform: boolean;
  readonly handle: JobHandler<T>;
}

/**
 * Routes a job by name to its handler after validating the envelope. Centralising this means
 * no handler can run without tenant context (or an explicit platform declaration).
 */
export class JobRouter {
  private readonly definitions = new Map<string, JobDefinition>();

  register<T>(name: string, definition: JobDefinition<T>): this {
    if (this.definitions.has(name)) {
      throw new Error(`Job "${name}" is already registered`);
    }
    this.definitions.set(name, definition as JobDefinition);
    return this;
  }

  async dispatch(name: string, data: unknown): Promise<unknown> {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new DomainError('UNKNOWN_JOB', `No handler registered for job "${name}"`);
    }
    const envelope = assertJobEnvelope(data as JobEnvelope<unknown>);
    if (Boolean(envelope.platformJob) !== definition.platform) {
      throw new DomainError(
        'INVALID_JOB_ENVELOPE',
        `Job "${name}" is ${definition.platform ? '' : 'not '}a platform job`,
      );
    }
    return definition.handle(envelope);
  }
}
