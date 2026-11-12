import type { JobEnvelope } from '@veyra/domain';

export interface OutboxEvent {
  id: string;
  organisationId: string | null;
  type: string;
  payload: unknown;
}

export interface OutboxStore {
  claim(types: readonly string[], limit: number): Promise<OutboxEvent[]>;
  published(ids: readonly string[]): Promise<void>;
  failed(id: string, error: string): Promise<void>;
}

/** Puts a job on the queue; the job id makes a repeated relay of the same event a no-op. */
export type Enqueue = (
  jobName: string,
  envelope: JobEnvelope<unknown>,
  jobId: string,
) => Promise<void>;

/** Which job each outbox event type becomes. */
export type OutboxRoutes = Readonly<Record<string, string>>;

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * Relays due outbox events to the job queue (ARCHITECTURE section 5): state changes and their
 * events are committed together, and the worker turns events into jobs, at least once. Tenant
 * events become tenant jobs (the job router refuses a tenant job without a tenant); the outbox id
 * is both the job id and the idempotency key, so relaying an event twice queues one job.
 */
export class OutboxRelay {
  constructor(
    private readonly store: OutboxStore,
    private readonly enqueue: Enqueue,
    private readonly routes: OutboxRoutes,
    private readonly batchSize = 100,
  ) {}

  /** One pass: returns how many events were relayed. */
  async tick(): Promise<number> {
    const events = await this.store.claim(Object.keys(this.routes), this.batchSize);
    const done: string[] = [];
    for (const event of events) {
      const jobName = this.routes[event.type];
      try {
        if (!jobName) throw new Error(`No job for outbox event type "${event.type}"`);
        if (!event.organisationId) throw new Error('Tenant outbox event without an organisation');
        const payload = (event.payload ?? {}) as { propertyId?: unknown };
        await this.enqueue(
          jobName,
          {
            tenant: {
              organisationId: event.organisationId,
              ...(typeof payload.propertyId === 'string' ? { propertyId: payload.propertyId } : {}),
            },
            actorId: null,
            requestId: `outbox:${event.id}`,
            idempotencyKey: event.id,
            payload: event.payload,
          },
          event.id,
        );
        done.push(event.id);
      } catch (error) {
        await this.store.failed(event.id, errorText(error));
      }
    }
    await this.store.published(done);
    return done.length;
  }
}
