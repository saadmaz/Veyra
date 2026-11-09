import { describe, expect, it } from 'vitest';
import {
  isPermission,
  PERMISSIONS,
  type Permission,
  permissionScope,
} from '../../src/modules/access-control/domain/permissions';
import {
  type AccessScope,
  canAssignRole,
  type Grant,
  hasCoveringGrant,
  isGrantEffective,
  organisationPermissions,
  permissionsAt,
  permissionsForAssignment,
  propertiesWithPermission,
} from '../../src/modules/access-control/domain/policy';
import { ROLES, type RoleDefinition } from '../../src/modules/access-control/domain/roles';

const now = new Date('2026-11-08T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const HOUR = 3_600_000;
const ORG = '00000000-0000-7000-8000-000000000001';
const P1 = '00000000-0000-7000-8000-0000000000a1';
const P2 = '00000000-0000-7000-8000-0000000000a2';

const grant = (overrides: Partial<Grant> = {}): Grant => ({
  role: 'ORGANISATION_ADMIN',
  scopeType: 'ORGANISATION',
  scopeId: ORG,
  status: 'ACTIVE',
  validFrom: at(-HOUR),
  validUntil: null,
  ...overrides,
});
const managerOf = (propertyId: string, overrides: Partial<Grant> = {}) =>
  grant({ role: 'PROPERTY_MANAGER', scopeType: 'PROPERTY', scopeId: propertyId, ...overrides });
const property = (
  propertyId: string,
  status: 'ONBOARDING' | 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
): AccessScope => ({
  type: 'PROPERTY',
  propertyId,
  propertyStatus: status,
});

describe('registry', () => {
  it('every role only uses registered permissions', () => {
    for (const role of Object.values(ROLES) as RoleDefinition[]) {
      for (const permission of role.permissions) expect(isPermission(permission)).toBe(true);
    }
  });

  it('organisation admins hold every registered permission', () => {
    const admin = new Set<string>(ROLES.ORGANISATION_ADMIN.permissions);
    for (const permission of PERMISSIONS) expect(admin.has(permission)).toBe(true);
  });

  it('permission names follow <module>.<resource>.<action>', () => {
    for (const permission of PERMISSIONS) expect(permission).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_]+$/);
  });

  it('classifies property.* permissions as property-scoped, everything else as organisation', () => {
    expect(permissionScope('property.profile.read')).toBe('property');
    expect(permissionScope('organisation.property.create')).toBe('organisation');
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

describe('organisation-level permissions', () => {
  it('unions the organisation permissions of effective organisation grants', () => {
    const permissions = organisationPermissions(
      [grant({ role: 'FINANCE_OFFICER' }), grant({ status: 'REVOKED' })],
      'ACTIVE',
      now,
    );
    expect([...permissions]).toEqual(['organisation.profile.read']);
  });

  it('gives a property-scoped member only the baseline profile read, never more', () => {
    expect([...organisationPermissions([managerOf(P1)], 'ACTIVE', now)]).toEqual([
      'organisation.profile.read',
    ]);
  });

  it('grants nothing for an unknown role key (deny by default)', () => {
    for (const role of ['SUPER_USER', '__proto__', 'constructor']) {
      const permissions = organisationPermissions([grant({ role })], 'ACTIVE', now);
      // Only the member baseline; the unknown role itself adds nothing.
      expect([...permissions]).toEqual(['organisation.profile.read']);
    }
  });

  it('keeps only read permissions while suspended or offboarding, nothing when archived', () => {
    for (const status of ['SUSPENDED', 'OFFBOARDING'] as const) {
      const permissions = organisationPermissions([grant()], status, now);
      expect([...permissions].sort()).toEqual([
        'organisation.member.read',
        'organisation.profile.read',
      ]);
    }
    expect(organisationPermissions([grant()], 'ARCHIVED', now).size).toBe(0);
  });
});

describe('property-level permissions (downward-only inheritance)', () => {
  it('an organisation grant covers every property', () => {
    expect(permissionsAt([grant()], 'ACTIVE', property(P1), now).has('property.profile.read')).toBe(
      true,
    );
    expect(permissionsAt([grant()], 'ACTIVE', property(P2), now).has('property.profile.read')).toBe(
      true,
    );
  });

  it('a property grant covers its own property and no other', () => {
    expect(hasCoveringGrant([managerOf(P1)], property(P1), now)).toBe(true);
    expect(hasCoveringGrant([managerOf(P1)], property(P2), now)).toBe(false);
    expect(permissionsAt([managerOf(P1)], 'ACTIVE', property(P2), now).size).toBe(0);
  });

  it('a property grant never reaches upward to organisation permissions', () => {
    const atProperty = permissionsAt([managerOf(P1)], 'ACTIVE', property(P1), now);
    expect(atProperty.size).toBeGreaterThan(0);
    for (const permission of atProperty) expect(permission.startsWith('property.')).toBe(true);
    expect(hasCoveringGrant([managerOf(P1)], { type: 'ORGANISATION' }, now)).toBe(false);
  });

  it('building- and unit-scoped grants do not cover the whole property', () => {
    const buildingGrant = grant({ role: 'PROPERTY_MANAGER', scopeType: 'BUILDING', scopeId: P1 });
    expect(hasCoveringGrant([buildingGrant], property(P1), now)).toBe(false);
  });

  it('ignores suspended or expired property grants', () => {
    expect(hasCoveringGrant([managerOf(P1, { status: 'SUSPENDED' })], property(P1), now)).toBe(
      false,
    );
    expect(hasCoveringGrant([managerOf(P1, { validUntil: at(-1) })], property(P1), now)).toBe(
      false,
    );
  });

  it('makes an archived property read-only', () => {
    const permissions = permissionsAt([grant()], 'ACTIVE', property(P1, 'ARCHIVED'), now);
    expect([...permissions].sort()).toEqual(['property.profile.read', 'property.structure.read']);
    expect(permissions.has('property.structure.manage')).toBe(false);
  });
});

describe('propertiesWithPermission (list filtering)', () => {
  it('returns all properties for an organisation-wide role', () => {
    expect(
      propertiesWithPermission(
        [grant({ role: 'FINANCE_OFFICER' })],
        'ACTIVE',
        'property.profile.read',
        now,
      ),
    ).toEqual({
      all: true,
    });
  });

  it('returns exactly the covered properties for property-scoped roles', () => {
    const result = propertiesWithPermission(
      [managerOf(P1), managerOf(P2, { status: 'SUSPENDED' }), managerOf(P1)],
      'ACTIVE',
      'property.profile.read',
      now,
    );
    expect(result).toEqual({ all: false, propertyIds: [P1] });
  });

  it('returns nothing in an archived organisation', () => {
    expect(propertiesWithPermission([grant()], 'ARCHIVED', 'property.profile.read', now)).toEqual({
      all: false,
      propertyIds: [],
    });
  });
});

describe('anti-escalation', () => {
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

  it('allows assigning a role whose permissions the actor holds, refuses any missing one', () => {
    expect(
      canAssignRole(
        holding('organisation.profile.read', 'organisation.member.invite'),
        'READER',
        'ORGANISATION',
        lookup,
      ),
    ).toBe(true);
    expect(
      canAssignRole(holding('organisation.member.invite'), 'MANAGER', 'ORGANISATION', lookup),
    ).toBe(false);
  });

  it('refuses unknown roles and scopes the role does not allow', () => {
    expect(canAssignRole(holding(), 'NOPE', 'ORGANISATION', lookup)).toBe(false);
    expect(canAssignRole(holding(), 'UNIT_ROLE', 'ORGANISATION', lookup)).toBe(false);
    expect(
      canAssignRole(holding('property.profile.read'), 'PROPERTY_MANAGER', 'ORGANISATION'),
    ).toBe(false);
  });

  it('an organisation admin may assign every system role at its allowed scopes', () => {
    const atOrg = permissionsForAssignment([grant()], 'ACTIVE', { type: 'ORGANISATION' }, now);
    const atP1 = permissionsForAssignment([grant()], 'ACTIVE', property(P1), now);
    expect(canAssignRole(atOrg, 'FINANCE_OFFICER', 'ORGANISATION')).toBe(true);
    expect(canAssignRole(atOrg, 'ORGANISATION_ADMIN', 'ORGANISATION')).toBe(true);
    expect(canAssignRole(atP1, 'PROPERTY_MANAGER', 'PROPERTY')).toBe(true);
  });

  it('a property manager holds nothing over another property or over the organisation', () => {
    expect(permissionsForAssignment([managerOf(P1)], 'ACTIVE', property(P2), now).size).toBe(0);
    const overOrg = permissionsForAssignment(
      [managerOf(P1)],
      'ACTIVE',
      { type: 'ORGANISATION' },
      now,
    );
    expect(canAssignRole(overOrg, 'FINANCE_OFFICER', 'ORGANISATION')).toBe(false);
  });

  it('a finance officer cannot assign organisation admin', () => {
    const held = permissionsForAssignment(
      [grant({ role: 'FINANCE_OFFICER' })],
      'ACTIVE',
      { type: 'ORGANISATION' },
      now,
    );
    expect(canAssignRole(held, 'ORGANISATION_ADMIN', 'ORGANISATION')).toBe(false);
  });

  it('nothing is assignable in a read-only organisation or an archived property', () => {
    expect(
      permissionsForAssignment([grant()], 'SUSPENDED', { type: 'ORGANISATION' }, now).size,
    ).toBe(0);
    expect(permissionsForAssignment([grant()], 'ACTIVE', property(P1, 'ARCHIVED'), now).size).toBe(
      0,
    );
  });
});

describe('unit scope and derived resident roles', () => {
  const U1 = '00000000-0000-7000-8000-0000000000c1';
  const U2 = '00000000-0000-7000-8000-0000000000c2';
  const unitIn = (
    unitId: string,
    propertyId = P1,
    status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
  ): AccessScope => ({
    type: 'UNIT',
    unitId,
    propertyId,
    propertyStatus: status,
  });
  const resident = (role: string, unitId: string) =>
    grant({ role, scopeType: 'UNIT', scopeId: unitId });

  it('classifies unit.* permissions as unit-scoped', () => {
    expect(permissionScope('unit.profile.read')).toBe('unit');
  });

  it('an owner covers their unit only, never a sibling unit, the property or the organisation', () => {
    const owner = [resident('OWNER', U1)];
    expect([...permissionsAt(owner, 'ACTIVE', unitIn(U1), now)].sort()).toEqual([
      'unit.profile.read',
      'unit.residents.read',
    ]);
    expect(hasCoveringGrant(owner, unitIn(U2), now)).toBe(false);
    expect(hasCoveringGrant(owner, property(P1), now)).toBe(false);
    expect([...organisationPermissions(owner, 'ACTIVE', now)]).toEqual([
      'organisation.profile.read',
    ]);
  });

  it('a household member sees the unit but not who else lives there', () => {
    const permissions = permissionsAt(
      [resident('HOUSEHOLD_MEMBER', U1)],
      'ACTIVE',
      unitIn(U1),
      now,
    );
    expect([...permissions]).toEqual(['unit.profile.read']);
  });

  it('staff cover units through their property or organisation grants', () => {
    expect(hasCoveringGrant([managerOf(P1)], unitIn(U1, P1), now)).toBe(true);
    expect(hasCoveringGrant([managerOf(P1)], unitIn(U2, P2), now)).toBe(false);
    expect(permissionsAt([grant()], 'ACTIVE', unitIn(U2, P2), now).has('unit.residents.read')).toBe(
      true,
    );
    // Finance officers see units but not resident names (data minimisation).
    const finance = permissionsAt([grant({ role: 'FINANCE_OFFICER' })], 'ACTIVE', unitIn(U1), now);
    expect([...finance]).toEqual(['unit.profile.read']);
  });

  it('derived roles can never be assigned, even by an organisation admin', () => {
    const admin = permissionsForAssignment([grant()], 'ACTIVE', unitIn(U1), now);
    for (const role of ['OWNER', 'TENANT', 'HOUSEHOLD_MEMBER']) {
      expect(canAssignRole(admin, role, 'UNIT')).toBe(false);
    }
  });

  it('a resident of an archived property keeps read access only', () => {
    const permissions = permissionsAt(
      [resident('TENANT', U1)],
      'ACTIVE',
      unitIn(U1, P1, 'ARCHIVED'),
      now,
    );
    expect([...permissions].sort()).toEqual(['unit.profile.read', 'unit.residents.read']);
  });
});
