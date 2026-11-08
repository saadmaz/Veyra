import type { Permission } from './permissions';

export type ScopeType = 'ORGANISATION' | 'PROPERTY' | 'BUILDING' | 'UNIT';

export interface RoleDefinition {
  name: string;
  /** Scopes at which the role may be granted. */
  grantableAt: readonly ScopeType[];
  permissions: readonly Permission[];
}

/**
 * System roles (ACCESS_CONTROL section 4). Memberships store the key. Roles appear as their
 * scopes and permissions become real: security, maintenance, owner and tenant roles arrive with
 * later phases. An unknown key in the database grants nothing.
 *
 * A role's permissions apply at the scope it is granted and below: an organisation-scoped grant
 * covers every property; a property-scoped grant covers only that property.
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
      'property.profile.read',
    ],
  },
  PROPERTY_MANAGER: {
    name: 'Property manager',
    grantableAt: ['PROPERTY'],
    // Structure and operations permissions are added with their endpoints (Phase 3 Part 3 on).
    permissions: ['property.profile.read'],
  },
  FINANCE_OFFICER: {
    name: 'Finance officer',
    grantableAt: ['ORGANISATION', 'PROPERTY'],
    // Finance permissions are added with the finance module (Phase 6).
    permissions: ['organisation.profile.read', 'property.profile.read'],
  },
} as const satisfies Record<string, RoleDefinition>;

export type RoleKey = keyof typeof ROLES;

export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

export function roleDefinition(key: string): RoleDefinition | undefined {
  return Object.hasOwn(ROLES, key) ? ROLES[key as RoleKey] : undefined;
}

export function isRoleKey(key: string): key is RoleKey {
  return Object.hasOwn(ROLES, key);
}
