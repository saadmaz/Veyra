import { describe, expect, it } from 'vitest';
import { assertJobEnvelope, assertTenantContext, DomainError, type JobEnvelope } from '../src';

const ORG = '0192f0a4-7c1e-7b2a-9c4d-1a2b3c4d5e6f';
const PROPERTY = '0192f0a4-7c1e-7b2a-9c4d-6f5e4d3c2b1a';

const envelope = (overrides: Partial<JobEnvelope<unknown>> = {}): JobEnvelope<unknown> => ({
  tenant: { organisationId: ORG },
  actorId: null,
  requestId: 'req-1',
  idempotencyKey: 'key-1',
  payload: {},
  ...overrides,
});

describe('assertTenantContext', () => {
  it('accepts a valid organisation and optional property', () => {
    expect(assertTenantContext({ organisationId: ORG })).toEqual({ organisationId: ORG });
    expect(assertTenantContext({ organisationId: ORG, propertyId: PROPERTY }).propertyId).toBe(
      PROPERTY,
    );
  });

  it('rejects missing or malformed tenant context', () => {
    expect(() => assertTenantContext(null)).toThrow(DomainError);
    expect(() => assertTenantContext(undefined)).toThrow(DomainError);
    expect(() => assertTenantContext({ organisationId: '' })).toThrow(DomainError);
    expect(() => assertTenantContext({ organisationId: "1' OR '1'='1" })).toThrow(DomainError);
    expect(() => assertTenantContext({ organisationId: ORG, propertyId: 'x' })).toThrow(
      DomainError,
    );
  });
});

describe('assertJobEnvelope', () => {
  it('accepts tenant jobs with tracing metadata', () => {
    expect(() => assertJobEnvelope(envelope())).not.toThrow();
  });

  it('rejects tenant-less jobs that are not declared platform jobs', () => {
    expect(() => assertJobEnvelope(envelope({ tenant: null }))).toThrow(/tenant context/);
  });

  it('accepts declared platform jobs without a tenant, and rejects platform jobs with one', () => {
    expect(() => assertJobEnvelope(envelope({ tenant: null, platformJob: true }))).not.toThrow();
    expect(() => assertJobEnvelope(envelope({ platformJob: true }))).toThrow(DomainError);
  });

  it('requires requestId and idempotencyKey', () => {
    expect(() => assertJobEnvelope(envelope({ requestId: '' }))).toThrow(DomainError);
    expect(() => assertJobEnvelope(envelope({ idempotencyKey: '' }))).toThrow(DomainError);
  });
});
