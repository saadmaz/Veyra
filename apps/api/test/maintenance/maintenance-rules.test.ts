import { describe, expect, it } from 'vitest';
import { ROLES } from '../../src/modules/access-control/domain/roles';
import {
  canMoveRequest,
  canMoveWorkOrder,
  canResolve,
  createWorkOrderSchema,
  formatRequestNumber,
  formatWorkOrderNumber,
  parseCost,
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
