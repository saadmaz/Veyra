import type { DbClient } from '@veyra/db';
import type { JobEnvelope } from '@veyra/domain';
import { describe, expect, it, vi } from 'vitest';
import { createJobRouter, OUTBOX_ROUTES } from '../src/jobs';
import { checkSlaBreach, SLA_CHECK_JOB, SLA_DUE_EVENT } from '../src/maintenance-jobs';
import { type OutboxEvent, OutboxRelay, type OutboxStore } from '../src/outbox-relay';

const ORG = '0192f0a4-7c1e-7b2a-9c4d-1a2b3c4d5e6f';
const PROP = '0192f0a4-7c1e-7b2a-9c4d-1a2b3c4d5e70';
const REQ = '0192f0a4-7c1e-7b2a-9c4d-1a2b3c4d5e71';

const sla = (id: string, organisationId: string | null = ORG): OutboxEvent => ({
  id,
  organisationId,
  type: SLA_DUE_EVENT,
  payload: {
    requestId: REQ,
    propertyId: PROP,
    target: 'RESPONSE',
    dueAt: '2026-11-12T10:00:00.000Z',
  },
});

function store(events: OutboxEvent[]) {
  return {
    claim: vi.fn(async () => events),
    published: vi.fn(async () => undefined),
    failed: vi.fn(async () => undefined),
  } satisfies OutboxStore;
}

describe('OutboxRelay', () => {
  it('turns due events into tenant jobs keyed by the outbox id, then marks them published', async () => {
    const s = store([sla('e1'), sla('e2')]);
    const enqueue = vi.fn(async () => undefined);
    const relay = new OutboxRelay(s, enqueue, OUTBOX_ROUTES);
    await expect(relay.tick()).resolves.toBe(2);
    expect(s.claim).toHaveBeenCalledWith([SLA_DUE_EVENT], 100);
    expect(enqueue).toHaveBeenCalledWith(
      SLA_CHECK_JOB,
      expect.objectContaining({
        tenant: { organisationId: ORG, propertyId: PROP },
        actorId: null,
        idempotencyKey: 'e1',
        requestId: 'outbox:e1',
      }),
      'e1',
    );
    expect(s.published).toHaveBeenCalledWith(['e1', 'e2']);
    expect(s.failed).not.toHaveBeenCalled();
  });

  it('holds back an event it cannot relay and still publishes the others', async () => {
    const s = store([sla('bad', null), sla('ok')]);
    const enqueue = vi.fn(async () => undefined);
    await new OutboxRelay(s, enqueue, OUTBOX_ROUTES).tick();
    expect(s.failed).toHaveBeenCalledWith('bad', 'Tenant outbox event without an organisation');
    expect(s.published).toHaveBeenCalledWith(['ok']);
  });

  it('keeps an event unpublished when the queue is down', async () => {
    const s = store([sla('e1')]);
    const enqueue = vi.fn(async () => {
      throw new Error('Connection is closed.');
    });
    await expect(new OutboxRelay(s, enqueue, OUTBOX_ROUTES).tick()).resolves.toBe(0);
    expect(s.failed).toHaveBeenCalledWith('e1', 'Connection is closed.');
    expect(s.published).toHaveBeenCalledWith([]);
  });
});

describe('maintenance.sla.check', () => {
  const envelope = (
    payload: unknown,
    tenant: JobEnvelope<unknown>['tenant'] = { organisationId: ORG },
  ) =>
    ({
      tenant,
      actorId: null,
      requestId: 'r',
      idempotencyKey: 'k',
      payload,
    }) as JobEnvelope<unknown>;

  /** A database double: records the tenant context and answers the breach check. */
  function fakeDb(hit: boolean) {
    const settings: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => {
        settings.push(String(values[0]));
        return 1;
      }),
      $queryRaw: vi.fn(async () => [{ hit }]),
    };
    const db = { $transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
    return { db: db as unknown as DbClient, tx, settings };
  }

  it('asks the database in the tenant context and reports whether a breach was recorded', async () => {
    const { db, tx, settings } = fakeDb(true);
    const handle = checkSlaBreach(db);
    await expect(handle(envelope(sla('e').payload))).resolves.toEqual({ breached: true });
    expect(settings).toEqual([ORG]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed payload before touching the database', async () => {
    const { db, tx } = fakeDb(true);
    const handle = checkSlaBreach(db);
    await expect(
      handle(envelope({ requestId: 'x', target: 'RESPONSE', dueAt: 'soon' })),
    ).rejects.toMatchObject({
      code: 'INVALID_JOB_PAYLOAD',
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('is a tenant job: the router refuses it without a tenant', async () => {
    const { db } = fakeDb(false);
    const router = createJobRouter({ db });
    await expect(
      router.dispatch(SLA_CHECK_JOB, { ...envelope(sla('e').payload, null), platformJob: true }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_ENVELOPE' });
    await expect(router.dispatch(SLA_CHECK_JOB, envelope(sla('e').payload))).resolves.toEqual({
      breached: false,
    });
  });
});
