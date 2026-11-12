import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';

export interface EndpointRecord {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: 'ACTIVE' | 'DISABLED';
  secretVersion: number;
  createdAt: Date;
}

export interface DeliveryRecord {
  id: string;
  eventType: string;
  eventId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

/** One transaction in the organisation's RLS context. */
export interface WebhookUnitOfWork {
  endpoints(): Promise<EndpointRecord[]>;
  endpoint(id: string): Promise<EndpointRecord | null>;
  createEndpoint(input: {
    url: string;
    description: string | null;
    events: string[];
  }): Promise<string>;
  updateEndpoint(
    id: string,
    patch: {
      url?: string;
      description?: string | null;
      events?: string[];
      status?: 'ACTIVE' | 'DISABLED';
      secretVersion?: number;
    },
  ): Promise<void>;
  deliveries(endpointId: string, limit: number): Promise<DeliveryRecord[]>;
  /** Queues one delivery per endpoint; the database hands each to the worker. */
  queue(
    endpointIds: string[],
    event: { id: string; type: string; payload: unknown },
  ): Promise<void>;
  audit(event: {
    action: string;
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface WebhookRepository {
  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: WebhookUnitOfWork) => Promise<T>,
  ): Promise<T>;
  /** The endpoints subscribed to an event type, on another module's open transaction. */
  subscribersWithin(
    transaction: TransactionHandle,
    organisationId: string,
    type: string,
  ): Promise<string[]>;
  queueWithin(
    transaction: TransactionHandle,
    organisationId: string,
    endpointIds: string[],
    event: { id: string; type: string; payload: unknown },
  ): Promise<void>;
}

export const WEBHOOK_REPOSITORY = Symbol('WEBHOOK_REPOSITORY');

/** The master key secrets are derived from, or null when webhooks are not set up. */
export const WEBHOOK_KEY = Symbol('WEBHOOK_KEY');
