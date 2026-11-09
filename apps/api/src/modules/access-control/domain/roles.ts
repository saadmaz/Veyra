import type { Permission } from './permissions';

export type ScopeType = 'ORGANISATION' | 'PROPERTY' | 'BUILDING' | 'UNIT';

export interface RoleDefinition {
  name: string;
  /** Scopes at which the role may be granted. */
  grantableAt: readonly ScopeType[];
  permissions: readonly Permission[];
  /**
   * Derived roles come from records (ownership, tenancy, household), never from memberships or
   * invitations, and so can never be assigned (canAssignRole refuses them).
   */
  derived?: boolean;
}

/**
 * System roles (ACCESS_CONTROL section 4). Memberships store the key. Roles appear as their
 * scopes and permissions become real: security, maintenance and vendor roles arrive with later
 * phases. An unknown key in the database grants nothing.
 *
 * A role's permissions apply at the scope it is granted and below: an organisation-scoped grant
 * covers every property and unit; a property-scoped grant covers that property and its units; a
 * unit-scoped grant covers only that unit.
 */
export const ROLES = {
  ORGANISATION_ADMIN: {
    name: 'Organisation admin',
    grantableAt: ['ORGANISATION'],
    permissions: [
      'organisation.profile.read',
      'organisation.settings.manage',
      'organisation.member.read',
      'organisation.member.manage',
      'organisation.member.invite',
      'organisation.property.create',
      'organisation.resident.read',
      'property.profile.read',
      'property.settings.manage',
      'property.lifecycle.manage',
      'property.structure.read',
      'property.structure.manage',
      'property.resident.read',
      'property.resident.manage',
      'unit.profile.read',
      'unit.residents.read',
    ],
  },
  PROPERTY_MANAGER: {
    name: 'Property manager',
    grantableAt: ['PROPERTY'],
    // Runs the property day to day; archiving or activating it stays with organisation admins.
    permissions: [
      'property.profile.read',
      'property.settings.manage',
      'property.structure.read',
      'property.structure.manage',
      'property.resident.read',
      'property.resident.manage',
      'unit.profile.read',
      'unit.residents.read',
    ],
  },
  FINANCE_OFFICER: {
    name: 'Finance officer',
    grantableAt: ['ORGANISATION', 'PROPERTY'],
    // Finance permissions are added with the finance module (Phase 6). Resident names are not
    // needed until billing exists (data minimisation).
    permissions: [
      'organisation.profile.read',
      'property.profile.read',
      'property.structure.read',
      'unit.profile.read',
    ],
  },
  // ------------------------------------------------------------------ derived resident roles
  OWNER: {
    name: 'Owner',
    grantableAt: ['UNIT'],
    derived: true,
    permissions: ['unit.profile.read', 'unit.residents.read'],
  },
  TENANT: {
    name: 'Tenant',
    grantableAt: ['UNIT'],
    derived: true,
    permissions: ['unit.profile.read', 'unit.residents.read'],
  },
  HOUSEHOLD_MEMBER: {
    name: 'Household member',
    grantableAt: ['UNIT'],
    derived: true,
    // Delegated rights (visitors, bookings) arrive with those modules.
    permissions: ['unit.profile.read'],
  },
} as const satisfies Record<string, RoleDefinition>;

export type RoleKey = keyof typeof ROLES;

export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

/** Roles that can be given through memberships and invitations (derived roles excluded). */
export const ASSIGNABLE_ROLE_KEYS = ROLE_KEYS.filter(
  (key) => !(ROLES[key] as RoleDefinition).derived,
);

export function roleDefinition(key: string): RoleDefinition | undefined {
  return Object.hasOwn(ROLES, key) ? ROLES[key as RoleKey] : undefined;
}

export function isRoleKey(key: string): key is RoleKey {
  return Object.hasOwn(ROLES, key);
}
