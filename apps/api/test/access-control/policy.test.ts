import { describe, expect, it } from 'vitest';
import {
  isPermission,
  PERMISSIONS,
  type Permission,
} from '../../src/modules/access-control/domain/permissions';
import {
  canAssignRole,
  type Grant,
  isGrantEffective,
  organisationPermissions,
} from '../../src/modules/access-control/domain/policy';
import { ROLES, type RoleDefinition } from '../../src/modules/access-control/domain/roles';

const now = new Date('2026-11-08T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const HOUR = 3_600_000;

const grant = (overrides: Partial<Grant> = {}): Grant => ({
  role: 'ORGANISATION_ADMIN',
  scopeType: 'ORGANISATION',
  status: 'ACTIVE',
  validFrom: at(-HOUR),
  validUntil: null,
  ...overrides,
});

describe('registry', () => {
  it('every role only uses registered permissions', () => {
    for (const role of Object.values(ROLES) as RoleDefinition[]) {
      for (const permission of role.permissions) expect(isPermission(permission)).toBe(true);
    }
  });

  it('organisation admins hold every organisation permission', () => {
    const admin = new Set<string>(ROLES.ORGANISATION_ADMIN.permissions);
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('organisation.'))) {
      expect(admin.has(permission)).toBe(true);
    }
  });

  it('permission names follow <module>.<resource>.<action>', () => {
    for (const permission of PERMISSIONS) expect(permission).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_]+$/);
  });
});

describe('isGrantEffective', () => {
  it('accepts an active grant inside its window', () => {
    expect(isGrantEffective(grant(), now)).toBe(true);
    expect(isGrantEffective(grant({ validUntil: at(HOUR) }), now)).toBe(true);
  });

  it('rejects future-dated grants until validFrom, inclusive start', () => {
    expect(isGrantEffective(grant({ validFrom: at(1) }), now)).toBe(false);
    expect(isGrantEffective(grant({ validFrom: now }), now)).toBe(true);
  });

  it('rejects expired grants, exclusive end', () => {
    expect(isGrantEffective(grant({ validUntil: now }), now)).toBe(false);
    expect(isGrantEffective(grant({ validUntil: at(-1) }), now)).toBe(false);
  });

  it('rejects suspended and revoked grants', () => {
    expect(isGrantEffective(grant({ status: 'SUSPENDED' }), now)).toBe(false);
    expect(isGrantEffective(grant({ status: 'REVOKED' }), now)).toBe(false);
  });
});

describe('organisationPermissions', () => {
  it('unions the permissions of effective organisation-scoped grants', () => {
    const permissions = organisationPermissions(
      [
        grant({ role: 'FINANCE_OFFICER' }),
        grant({ role: 'ORGANISATION_ADMIN', status: 'REVOKED' }),
      ],
      'ACTIVE',
      now,
    );
    expect([...permissions]).toEqual(['organisation.profile.read']);
  });

  it('ignores property-scoped grants (inheritance flows downwards only)', () => {
    expect(organisationPermissions([grant({ scopeType: 'PROPERTY' })], 'ACTIVE', now).size).toBe(0);
  });

  it('grants nothing for an unknown role key (deny by default)', () => {
    expect(organisationPermissions([grant({ role: 'SUPER_USER' })], 'ACTIVE', now).size).toBe(0);
    expect(organisationPermissions([grant({ role: '__proto__' })], 'ACTIVE', now).size).toBe(0);
  });

  it('keeps only read permissions while suspended or offboarding', () => {
    for (const status of ['SUSPENDED', 'OFFBOARDING'] as const) {
      const permissions = organisationPermissions([grant()], status, now);
      expect([...permissions].sort()).toEqual([
        'organisation.member.read',
        'organisation.profile.read',
      ]);
    }
  });

  it('grants nothing in an archived organisation', () => {
    expect(organisationPermissions([grant()], 'ARCHIVED', now).size).toBe(0);
  });
});

describe('canAssignRole (anti-escalation)', () => {
  const roles: Record<string, RoleDefinition> = {
    READER: {
      name: 'Reader',
      grantableAt: ['ORGANISATION'],
      permissions: ['organisation.profile.read'],
    },
    MANAGER: {
      name: 'Manager',
      grantableAt: ['ORGANISATION'],
      permissions: ['organisation.profile.read', 'organisation.member.invite'],
    },
    UNIT_ROLE: { name: 'Unit', grantableAt: ['UNIT'], permissions: [] },
  };
  const lookup = (key: string) => roles[key];
  const holding = (...permissions: Permission[]) => new Set(permissions);

  it('allows assigning a role whose permissions the actor holds', () => {
    expect(
      canAssignRole(
        holding('organisation.profile.read', 'organisation.member.invite'),
        'READER',
        'ORGANISATION',
        lookup,
      ),
    ).toBe(true);
  });

  it('refuses a role with any permission the actor lacks', () => {
    expect(
      canAssignRole(holding('organisation.member.invite'), 'MANAGER', 'ORGANISATION', lookup),
    ).toBe(false);
  });

  it('refuses unknown roles and scopes the role does not allow', () => {
    expect(canAssignRole(holding(), 'NOPE', 'ORGANISATION', lookup)).toBe(false);
    expect(canAssignRole(holding(), 'UNIT_ROLE', 'ORGANISATION', lookup)).toBe(false);
  });

  it('with the real registry: a finance officer cannot assign organisation admin', () => {
    const financeOfficer = new Set<Permission>(ROLES.FINANCE_OFFICER.permissions);
    expect(canAssignRole(financeOfficer, 'ORGANISATION_ADMIN', 'ORGANISATION')).toBe(false);
    const admin = new Set<Permission>(ROLES.ORGANISATION_ADMIN.permissions);
    expect(canAssignRole(admin, 'FINANCE_OFFICER', 'ORGANISATION')).toBe(true);
  });
});
