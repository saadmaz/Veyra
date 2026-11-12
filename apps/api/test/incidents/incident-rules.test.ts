import { describe, expect, it } from 'vitest';
import {
  alertsManagers,
  canMoveIncident,
  canSeeIncident,
  contactsFor,
  moveIncidentSchema,
  reportIncidentSchema,
} from '../../src/modules/incidents/domain/incident-rules';

describe('incident rules', () => {
  it('move forward, or reopen from resolved; closed is final', () => {
    expect(canMoveIncident('OPEN', 'RESPONDING')).toBe(true);
    expect(canMoveIncident('OPEN', 'RESOLVED')).toBe(true);
    expect(canMoveIncident('OPEN', 'CLOSED')).toBe(false);
    expect(canMoveIncident('RESOLVED', 'RESPONDING')).toBe(true);
    expect(canMoveIncident('RESOLVED', 'CLOSED')).toBe(true);
    expect(canMoveIncident('CLOSED', 'RESPONDING')).toBe(false);
  });

  it('show sensitive incidents to managers and the reporter only', () => {
    const i = { sensitive: true, reportedByUserId: 'a' };
    expect(canSeeIncident(i, { userId: 'a', manager: false })).toBe(true);
    expect(canSeeIncident(i, { userId: 'b', manager: true })).toBe(true);
    expect(canSeeIncident(i, { userId: 'b', manager: false })).toBe(false);
    expect(canSeeIncident({ ...i, sensitive: false }, { userId: 'b', manager: false })).toBe(true);
  });

  it('alert managers for high and critical incidents only', () => {
    expect(alertsManagers('LOW')).toBe(false);
    expect(alertsManagers('MEDIUM')).toBe(false);
    expect(alertsManagers('HIGH')).toBe(true);
    expect(alertsManagers('CRITICAL')).toBe(true);
  });

  it('pick active contacts for every kind or for this kind', () => {
    const all = { categories: [], active: true, n: 1 };
    const fire = { categories: ['FIRE' as const], active: true, n: 2 };
    const retired = { categories: [], active: false, n: 3 };
    expect(contactsFor([all, fire, retired], 'FIRE').map((c) => c.n)).toEqual([1, 2]);
    expect(contactsFor([all, fire, retired], 'FLOOD').map((c) => c.n)).toEqual([1]);
  });

  it('need an outcome to resolve, one place at most, and a time not in the future', () => {
    expect(moveIncidentSchema.safeParse({ status: 'RESOLVED' }).success).toBe(false);
    expect(moveIncidentSchema.safeParse({ status: 'RESOLVED', outcome: 'Fixed' }).success).toBe(
      true,
    );
    const base = {
      category: 'FIRE',
      severity: 'LOW',
      title: 'Alarm',
      description: 'The test alarm went off',
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
    };
    expect(reportIncidentSchema.safeParse(base).success).toBe(true);
    const id = '0190a0a0-0000-7000-8000-000000000000';
    expect(reportIncidentSchema.safeParse({ ...base, unitId: id, commonAreaId: id }).success).toBe(
      false,
    );
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(reportIncidentSchema.safeParse({ ...base, occurredAt: future }).success).toBe(false);
  });
});
