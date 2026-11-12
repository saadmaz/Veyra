import { describe, expect, it } from 'vitest';
import { ROLES } from '../../src/modules/access-control/domain/roles';
import {
  canMoveRequest,
  canMoveWorkOrder,
  canResolve,
  createWorkOrderSchema,
  formatRequestNumber,
  formatWorkOrderNumber,
  overdue,
  parseCost,
  queueOrder,
  slaTargetsSchema,
  staffRequestSchema,
} from '../../src/modules/maintenance/domain/maintenance-rules';

const U = '0190a0b0-0000-7000-8000-000000000001';

describe('transitions', () => {
  it('match the database: requests', () => {
    expect(canMoveRequest('SUBMITTED', 'ACCEPTED')).toBe(true);
    expect(canMoveRequest('RESOLVED', 'ACCEPTED')).toBe(true);
    expect(canMoveRequest('SUBMITTED', 'RESOLVED')).toBe(false);
    expect(canMoveRequest('ACCEPTED', 'REJECTED')).toBe(false);
    for (const final of ['CLOSED', 'REJECTED', 'CANCELLED'] as const) {
      expect(canMoveRequest(final, 'ACCEPTED')).toBe(false);
    }
  });

  it('match the database: work orders', () => {
    expect(canMoveWorkOrder('ASSIGNED', 'IN_PROGRESS')).toBe(true);
    expect(canMoveWorkOrder('ON_HOLD', 'IN_PROGRESS')).toBe(true);
    expect(canMoveWorkOrder('OPEN', 'IN_PROGRESS')).toBe(false);
    expect(canMoveWorkOrder('ON_HOLD', 'COMPLETED')).toBe(false);
    expect(canMoveWorkOrder('COMPLETED', 'CANCELLED')).toBe(false);
  });

  it('resolve a request only with completed work and none still live', () => {
    expect(canResolve([])).toBe(false);
    expect(canResolve(['COMPLETED'])).toBe(true);
    expect(canResolve(['COMPLETED', 'CANCELLED'])).toBe(true);
    expect(canResolve(['COMPLETED', 'ON_HOLD'])).toBe(false);
    expect(canResolve(['CANCELLED'])).toBe(false);
  });
});

describe('inputs', () => {
  const report = { category: 'PLUMBING', title: 'Leak', description: 'Under the sink' };

  it('staff give exactly one place; priority defaults to medium', () => {
    expect(staffRequestSchema.safeParse(report).success).toBe(false);
    expect(staffRequestSchema.safeParse({ ...report, unitId: U, commonAreaId: U }).success).toBe(
      false,
    );
    expect(staffRequestSchema.parse({ ...report, unitId: U }).priority).toBe('MEDIUM');
  });

  it('work orders come from a request, or need a place, a title and a category', () => {
    expect(createWorkOrderSchema.safeParse({ requestId: U }).success).toBe(true);
    expect(createWorkOrderSchema.safeParse({ requestId: U, unitId: U }).success).toBe(false);
    expect(createWorkOrderSchema.safeParse({ unitId: U, title: 'Paint' }).success).toBe(false);
    expect(
      createWorkOrderSchema.safeParse({ unitId: U, title: 'Paint', category: 'PAINTING' }).success,
    ).toBe(true);
  });

  it('costs are exact minor units in the currency', () => {
    expect(parseCost('1500.50', 'PKR')).toBe(150050n);
    expect(parseCost('1500', 'JPY')).toBe(1500n);
    expect(() => parseCost('1.234', 'PKR')).toThrow();
    expect(() => parseCost('0', 'PKR')).toThrow();
  });

  it('numbers requests and work orders', () => {
    expect(formatRequestNumber(42n)).toBe('MR-000042');
    expect(formatWorkOrderNumber(7n)).toBe('WO-000007');
  });
});

describe('maintenance roles', () => {
  const has = (role: keyof typeof ROLES, permission: string) =>
    (ROLES[role].permissions as readonly string[]).includes(permission);

  it('residents raise requests; staff roles do what the matrix says', () => {
    for (const role of ['OWNER', 'TENANT', 'HOUSEHOLD_MEMBER'] as const) {
      expect(has(role, 'unit.maintenance.request')).toBe(true);
      expect(has(role, 'property.maintenance.read')).toBe(false);
    }
    for (const role of ['PROPERTY_MANAGER', 'MAINTENANCE_MANAGER'] as const) {
      expect(has(role, 'property.maintenance.manage')).toBe(true);
      expect(has(role, 'property.maintenance.work')).toBe(true);
    }
    expect(has('FINANCE_OFFICER', 'property.maintenance.read')).toBe(true);
    expect(has('FINANCE_OFFICER', 'property.maintenance.manage')).toBe(false);
  });

  it('technicians only work, with no resident data or request queue', () => {
    expect([...ROLES.TECHNICIAN.permissions].sort()).toEqual([
      'property.maintenance.work',
      'property.profile.read',
      'property.structure.read',
    ]);
    expect(ROLES.TECHNICIAN.grantableAt).toEqual(['PROPERTY']);
    expect(has('SECURITY_GUARD', 'property.maintenance.work')).toBe(false);
  });
});

describe('SLAs', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 12, 10, minutes));
  const now = at(30);
  const req = (over: Partial<Parameters<typeof overdue>[0]> & { id?: string } = {}) => ({
    id: 'r',
    status: 'SUBMITTED' as const,
    priority: 'MEDIUM' as const,
    responseDueAt: at(60),
    resolutionDueAt: at(120),
    responseBreachedAt: null,
    resolutionBreachedAt: null,
    createdAt: at(0),
    ...over,
  });

  it('is overdue only past a target not yet met', () => {
    expect(overdue(req(), now)).toEqual({ response: false, resolution: false });
    expect(overdue(req({ responseDueAt: at(30) }), now).response).toBe(true);
    // Accepted: the response target was met; resolution still counts.
    expect(
      overdue(req({ status: 'ACCEPTED', responseDueAt: at(10), resolutionDueAt: at(20) }), now),
    ).toEqual({
      response: false,
      resolution: true,
    });
    expect(overdue(req({ status: 'RESOLVED', resolutionDueAt: at(1) }), now).resolution).toBe(
      false,
    );
    expect(overdue(req({ responseDueAt: null, resolutionDueAt: null }), now)).toEqual({
      response: false,
      resolution: false,
    });
  });

  it('puts overdue first, then priority, then the next target, then the oldest', () => {
    const order = queueOrder(
      [
        req({ id: 'low-old', priority: 'LOW', createdAt: at(0) }),
        req({ id: 'urgent', priority: 'URGENT', responseDueAt: at(90) }),
        req({ id: 'overdue-low', priority: 'LOW', responseDueAt: at(5) }),
        req({ id: 'medium-soon', responseDueAt: at(40) }),
        req({ id: 'medium-later', responseDueAt: at(70) }),
        req({ id: 'no-target', responseDueAt: null, resolutionDueAt: null }),
      ],
      now,
    ).map((r) => r.id);
    expect(order).toEqual([
      'overdue-low',
      'urgent',
      'medium-soon',
      'medium-later',
      'no-target',
      'low-old',
    ]);
  });

  it('takes at most one target per priority, resolution not before response', () => {
    const t = { priority: 'URGENT', responseMinutes: 60, resolutionMinutes: 240 };
    expect(slaTargetsSchema.safeParse({ targets: [t] }).success).toBe(true);
    expect(slaTargetsSchema.safeParse({ targets: [] }).success).toBe(true);
    expect(slaTargetsSchema.safeParse({ targets: [t, t] }).success).toBe(false);
    expect(slaTargetsSchema.safeParse({ targets: [{ ...t, resolutionMinutes: 30 }] }).success).toBe(
      false,
    );
    expect(slaTargetsSchema.safeParse({ targets: [{ ...t, responseMinutes: 0 }] }).success).toBe(
      false,
    );
  });
});
