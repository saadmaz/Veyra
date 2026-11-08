import { DomainError } from './errors';

/**
 * The tenant scope an operation runs in. Resolved server-side (route + verified membership,
 * or a job envelope) and never taken from client input alone. See docs/architecture/MULTI_TENANCY.md.
 */
export interface TenantContext {
  readonly organisationId: string;
  readonly propertyId?: string;
}

/** Metadata every background job must carry so workers can re-establish tenant context. */
export interface JobEnvelope<TPayload> {
  readonly tenant: TenantContext | null;
  /** True only for declared platform-level jobs that legitimately run without a tenant. */
  readonly platformJob?: boolean;
  readonly actorId: string | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTenantContext(tenant: TenantContext | null | undefined): TenantContext {
  if (!tenant || !UUID_PATTERN.test(tenant.organisationId)) {
    throw new DomainError('TENANT_CONTEXT_REQUIRED', 'Operation requires a valid tenant context');
  }
  if (tenant.propertyId !== undefined && !UUID_PATTERN.test(tenant.propertyId)) {
    throw new DomainError('TENANT_CONTEXT_REQUIRED', 'Invalid property in tenant context');
  }
  return tenant;
}

/**
 * Validates a job envelope before processing. Tenant-less jobs are rejected unless they are
 * explicitly declared platform jobs.
 */
export function assertJobEnvelope<T>(envelope: JobEnvelope<T>): JobEnvelope<T> {
  if (envelope.platformJob) {
    if (envelope.tenant) {
      throw new DomainError('INVALID_JOB_ENVELOPE', 'Platform jobs must not carry a tenant');
    }
  } else {
    assertTenantContext(envelope.tenant);
  }
  if (!envelope.requestId || !envelope.idempotencyKey) {
    throw new DomainError('INVALID_JOB_ENVELOPE', 'requestId and idempotencyKey are required');
  }
  return envelope;
}
