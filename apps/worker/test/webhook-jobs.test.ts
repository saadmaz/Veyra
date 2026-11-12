import { verifyWebhook, webhookSecret } from '@veyra/db';
import type { JobEnvelope } from '@veyra/domain';
import { describe, expect, it } from 'vitest';
import {
  deliverWebhook,
  FetchWebhookSender,
  isPrivateAddress,
  type PendingWebhook,
  type WebhookOutcome,
  type WebhookSender,
  type WebhookStore,
} from '../src/webhook-jobs';

const tenant = { organisationId: '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f60' };
const deliveryId = '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f61';
const endpointId = '0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f62';
const key = Buffer.alloc(32, 7);
const NOW = 1_800_000_000;
const envelope = (payload: unknown) =>
  ({
    tenant,
    payload,
    jobId: 'j',
    createdAt: new Date().toISOString(),
  }) as unknown as JobEnvelope<unknown>;

const pending: PendingWebhook = {
  id: deliveryId,
  status: 'PENDING',
  eventType: 'incident.reported',
  payload: { id: 'e', type: 'incident.reported', data: { reference: 'IN-000001' } },
  endpoint: {
    id: endpointId,
    url: 'https://hooks.example.test/veyra',
    status: 'ACTIVE',
    secretVersion: 2,
  },
};

function fakeStore(delivery: PendingWebhook | null, onFailure: 'PENDING' | 'FAILED' = 'PENDING') {
  const recorded: WebhookOutcome[] = [];
  const store: WebhookStore = {
    load: async () => delivery,
    record: async (_t, _id, outcome) => {
      recorded.push(outcome);
      return outcome.succeeded ? 'SUCCEEDED' : onFailure;
    },
  };
  return { store, recorded };
}

function fakeSender(status: number | Error) {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const sender: WebhookSender = {
    post: async (url, headers, body) => {
      sent.push({ url, headers, body });
      if (status instanceof Error) throw status;
      return { status };
    },
  };
  return { sender, sent };
}

describe('webhook deliveries', () => {
  it('send the payload signed with the endpoint secret and record success', async () => {
    const { store, recorded } = fakeStore(pending);
    const { sender, sent } = fakeSender(204);
    const result = await deliverWebhook(store, sender, key, () => NOW)(envelope({ deliveryId }));
    expect(result).toEqual({ status: 'SUCCEEDED' });
    expect(recorded).toEqual([{ succeeded: true, statusCode: 204 }]);
    const [call] = sent;
    expect(call?.headers['veyra-event']).toBe('incident.reported');
    expect(call?.headers['veyra-delivery']).toBe(deliveryId);
    const secret = webhookSecret(key, endpointId, 2);
    expect(
      verifyWebhook(secret, call?.headers['veyra-signature'] ?? '', call?.body ?? '', NOW),
    ).toBe(true);
    expect(
      verifyWebhook(secret, call?.headers['veyra-signature'] ?? '', `${call?.body} `, NOW),
    ).toBe(false);
    expect(
      verifyWebhook(secret, call?.headers['veyra-signature'] ?? '', call?.body ?? '', NOW + 600),
    ).toBe(false);
    expect(
      verifyWebhook(
        webhookSecret(key, endpointId, 1),
        call?.headers['veyra-signature'] ?? '',
        call?.body ?? '',
        NOW,
      ),
    ).toBe(false);
  });

  it('record failures and throw so the queue retries, until the last attempt', async () => {
    const { store, recorded } = fakeStore(pending);
    await expect(
      deliverWebhook(store, fakeSender(500).sender, key)(envelope({ deliveryId })),
    ).rejects.toThrow(/will retry/);
    expect(recorded[0]).toMatchObject({ succeeded: false, statusCode: 500 });
    const last = fakeStore(pending, 'FAILED');
    const result = await deliverWebhook(
      last.store,
      fakeSender(new Error('timeout')).sender,
      key,
    )(envelope({ deliveryId }));
    expect(result).toEqual({ status: 'FAILED' });
    expect(last.recorded[0]).toMatchObject({
      succeeded: false,
      statusCode: null,
      error: 'timeout',
    });
  });

  it('skip settled deliveries and refuse disabled endpoints or a missing key', async () => {
    const settled = fakeStore({ ...pending, status: 'SUCCEEDED' });
    expect(
      await deliverWebhook(settled.store, fakeSender(200).sender, key)(envelope({ deliveryId })),
    ).toEqual({
      skipped: true,
    });
    const disabled = fakeStore(
      { ...pending, endpoint: { ...pending.endpoint, status: 'DISABLED' } },
      'FAILED',
    );
    const { sender, sent } = fakeSender(200);
    await deliverWebhook(disabled.store, sender, key)(envelope({ deliveryId }));
    expect(sent).toEqual([]);
    expect(disabled.recorded[0]).toMatchObject({ error: 'The endpoint is disabled' });
    const noKey = fakeStore(pending, 'FAILED');
    await deliverWebhook(noKey.store, sender, null)(envelope({ deliveryId }));
    expect(noKey.recorded[0]).toMatchObject({ error: 'Webhooks are not set up' });
    await expect(
      deliverWebhook(noKey.store, sender, key)(envelope({ deliveryId: 'x' })),
    ).rejects.toThrow(/Invalid/);
  });

  it('never reach private addresses, even through a public name', async () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    const rebinding = new FetchWebhookSender(async () => ['93.184.216.34', '10.0.0.5']);
    await expect(rebinding.post('https://hooks.example.test/x', {}, '{}')).rejects.toThrow(
      /private address/,
    );
  });
});
