import type { JobEnvelope } from '@veyra/domain';
import { describe, expect, it } from 'vitest';
import {
  type DeliveryStore,
  deliverNotification,
  type EmailSender,
  LogEmailSender,
  type PendingDelivery,
} from '../src/notification-jobs';

const tenant = { organisationId: '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f60' };
const deliveryId = '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f61';
const envelope = (payload: unknown) =>
  ({
    tenant,
    payload,
    jobId: 'j',
    createdAt: new Date().toISOString(),
  }) as unknown as JobEnvelope<unknown>;

function fakeStore(
  delivery: PendingDelivery | null,
  after: 'PENDING' | 'SENT' | 'FAILED' = 'SENT',
) {
  const recorded: unknown[] = [];
  const store: DeliveryStore = {
    load: async () => delivery,
    record: async (_t, _id, outcome) => {
      recorded.push(outcome);
      return outcome.sent ? 'SENT' : after;
    },
  };
  return { store, recorded };
}

const pending: PendingDelivery = {
  id: deliveryId,
  channel: 'EMAIL',
  status: 'PENDING',
  to: 'resident@example.test',
  subject: 'Booking approved',
  text: 'Your hall booking is confirmed.',
};

describe('notification delivery job', () => {
  it('sends a pending email and records it, logging only the delivery id', async () => {
    const lines: string[] = [];
    const { store, recorded } = fakeStore(pending);
    const result = await deliverNotification(
      store,
      new LogEmailSender((l) => lines.push(l)),
    )(envelope({ deliveryId }));
    expect(result).toEqual({ status: 'SENT' });
    expect(recorded).toEqual([{ sent: true, reference: `log-${deliveryId}` }]);
    expect(lines.join('\n')).not.toContain('resident@example.test');
    expect(lines.join('\n')).not.toContain('confirmed');
  });

  it('records a failure and throws so the queue retries, until the last attempt fails it', async () => {
    const broken: EmailSender = {
      name: 'broken',
      send: async () => {
        throw new Error('SMTP timeout');
      },
    };
    const retrying = fakeStore(pending, 'PENDING');
    await expect(
      deliverNotification(retrying.store, broken)(envelope({ deliveryId })),
    ).rejects.toThrow(/will retry/);
    expect(retrying.recorded).toEqual([{ sent: false, error: 'SMTP timeout' }]);
    const last = fakeStore(pending, 'FAILED');
    expect(await deliverNotification(last.store, broken)(envelope({ deliveryId }))).toEqual({
      status: 'FAILED',
    });
  });

  it('skips deliveries that are gone or finished, and refuses bad payloads', async () => {
    const email = new LogEmailSender(() => undefined);
    expect(
      await deliverNotification(fakeStore(null).store, email)(envelope({ deliveryId })),
    ).toEqual({ skipped: true });
    const sent = fakeStore({ ...pending, status: 'SENT' });
    expect(await deliverNotification(sent.store, email)(envelope({ deliveryId }))).toEqual({
      skipped: true,
    });
    expect(sent.recorded).toEqual([]);
    await expect(
      deliverNotification(sent.store, email)(envelope({ deliveryId: 'x' })),
    ).rejects.toThrow(/payload/);
  });
});
