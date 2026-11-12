import { describe, expect, it } from 'vitest';
import {
  endpointSchema,
  envelope,
  webhookUrlProblem,
} from '../../src/modules/integrations/domain/webhook-rules';

describe('webhook rules', () => {
  it('accept HTTPS to public host names only', () => {
    expect(webhookUrlProblem('https://hooks.example.com/veyra')).toBeNull();
    expect(webhookUrlProblem('https://hooks.example.com:8443/x?y=1')).toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/x')).toMatch(/HTTPS/);
    expect(webhookUrlProblem('https://127.0.0.1/x')).toMatch(/public host/);
    expect(webhookUrlProblem('https://[::1]/x')).toMatch(/public host/);
    expect(webhookUrlProblem('https://localhost/x')).toMatch(/public host/);
    expect(webhookUrlProblem('https://db.internal/x')).toMatch(/public host/);
    expect(webhookUrlProblem('https://user:pw@hooks.example.com/x')).toMatch(/credentials/);
    expect(webhookUrlProblem('not a url')).toMatch(/full URL/);
  });

  it('need known events, without duplicates', () => {
    const base = { url: 'https://hooks.example.com/x' };
    expect(endpointSchema.safeParse({ ...base, events: [] }).success).toBe(false);
    expect(endpointSchema.safeParse({ ...base, events: ['payment.stolen'] }).success).toBe(false);
    const ok = endpointSchema.parse({
      ...base,
      events: ['incident.reported', 'incident.reported'],
    });
    expect(ok.events).toEqual(['incident.reported']);
  });

  it('wrap events in a stable envelope', () => {
    expect(
      envelope({
        id: 'e',
        type: 'incident.reported',
        organisationId: 'o',
        occurredAt: new Date('2026-11-12T10:00:00Z'),
        data: { reference: 'IN-000001' },
      }),
    ).toEqual({
      id: 'e',
      type: 'incident.reported',
      organisationId: 'o',
      occurredAt: '2026-11-12T10:00:00.000Z',
      data: { reference: 'IN-000001' },
    });
  });
});
