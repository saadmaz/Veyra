import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { webhookSecret } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type { OrganisationAccess } from '../../access-control';
import {
  type EndpointInput,
  envelope,
  TEST_EVENT,
  type UpdateEndpointInput,
  type WebhookEvent,
} from '../domain/webhook-rules';
import {
  type EndpointRecord,
  WEBHOOK_KEY,
  WEBHOOK_REPOSITORY,
  type WebhookRepository,
  type WebhookUnitOfWork,
} from './webhook-ports';

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Webhook endpoint not found');
const notConfigured = () =>
  new ApiError(409, 'WEBHOOKS_NOT_CONFIGURED', 'Webhooks are not set up for this service');

/**
 * Webhooks (Phase 12 Part 3). Organisation admins (organisation.webhook.manage) register HTTPS
 * endpoints for event types; the secret that signs deliveries is shown once (and on rotation),
 * never stored. Other modules call emitWithin() on their own transaction, so a delivery exists
 * exactly when its change does; the worker sends, signs, retries and records it.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(WEBHOOK_REPOSITORY) private readonly repository: WebhookRepository,
    @Inject(WEBHOOK_KEY) private readonly key: Buffer | null,
  ) {}

  /** Queues an event for every active endpoint subscribed to it. */
  async emitWithin(
    transaction: TransactionHandle,
    organisationId: string,
    type: WebhookEvent,
    data: Record<string, unknown>,
  ) {
    const endpoints = await this.repository.subscribersWithin(transaction, organisationId, type);
    if (endpoints.length === 0) return;
    const id = randomUUID();
    await this.repository.queueWithin(transaction, organisationId, endpoints, {
      id,
      type,
      payload: envelope({ id, type, organisationId, occurredAt: new Date(), data }),
    });
  }

  list(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, (uow) => uow.endpoints());
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => ({
      endpoint: await this.mustFind(uow, id),
      deliveries: await uow.deliveries(id, 50),
    }));
  }

  create(access: OrganisationAccess, input: EndpointInput, meta: RequestMeta) {
    const key = this.requireKey();
    return this.run(access, meta, async (uow) => {
      const id = await uow.createEndpoint(input);
      await uow.audit({ action: 'webhook.created', resourceId: id });
      const endpoint = await this.mustFind(uow, id);
      return { endpoint, secret: webhookSecret(key, id, endpoint.secretVersion) };
    });
  }

  update(access: OrganisationAccess, id: string, patch: UpdateEndpointInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      await this.mustFind(uow, id);
      await uow.updateEndpoint(id, patch);
      await uow.audit({
        action: 'webhook.updated',
        resourceId: id,
        metadata: { fields: Object.keys(patch).sort().join(',') },
      });
      return this.mustFind(uow, id);
    });
  }

  rotate(access: OrganisationAccess, id: string, meta: RequestMeta) {
    const key = this.requireKey();
    return this.run(access, meta, async (uow) => {
      const current = await this.mustFind(uow, id);
      await uow.updateEndpoint(id, { secretVersion: current.secretVersion + 1 });
      await uow.audit({ action: 'webhook.secret_rotated', resourceId: id });
      const endpoint = await this.mustFind(uow, id);
      return { endpoint, secret: webhookSecret(key, id, endpoint.secretVersion) };
    });
  }

  /** Sends a test event to one endpoint. */
  test(access: OrganisationAccess, id: string, meta: RequestMeta) {
    this.requireKey();
    return this.run(access, meta, async (uow) => {
      const endpoint = await this.mustFind(uow, id);
      if (endpoint.status !== 'ACTIVE') {
        throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Enable the endpoint first');
      }
      const eventId = randomUUID();
      await uow.queue([id], {
        id: eventId,
        type: TEST_EVENT,
        payload: envelope({
          id: eventId,
          type: TEST_EVENT,
          organisationId: access.organisationId,
          occurredAt: new Date(),
          data: { message: 'This is a test delivery from VEYRA.' },
        }),
      });
      await uow.audit({ action: 'webhook.tested', resourceId: id });
      return { endpoint, deliveries: await uow.deliveries(id, 50) };
    });
  }

  private requireKey() {
    if (!this.key) throw notConfigured();
    return this.key;
  }

  private async mustFind(uow: WebhookUnitOfWork, id: string): Promise<EndpointRecord> {
    const endpoint = await uow.endpoint(id);
    if (!endpoint) throw notFound();
    return endpoint;
  }

  private run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: WebhookUnitOfWork) => Promise<T>,
  ) {
    return this.repository.inOrganisation(access.organisationId, access.userId, meta, work);
  }
}
