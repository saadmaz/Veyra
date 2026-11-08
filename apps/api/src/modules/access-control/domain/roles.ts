import type { Permission } from './permissions';

export type ScopeType = 'ORGANISATION' | 'PROPERTY' | 'BUILDING' | 'UNIT';

export interface RoleDefinition {
  name: string;
  /** Scopes at which the role may be granted. */
  grantableAt: readonly ScopeType[];
  permissions: readonly Permission[];
}

/**
 * System roles (ACCESS_CONTROL section 4). Memberships store the key. Only roles that can be
 * granted with today's scopes are defined: property-, building- and unit-scoped roles
 * (property manager, security, maintenance, owner, tenant...) arrive with properties (Phase 3)
 * and residents (Phase 4). An unknown key in the database grants nothing.
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
    ],
  },
  FINANCE_OFFICER: {
    name: 'Finance officer',
    grantableAt: ['ORGANISATION'],
    // Finance permissions are added with the finance module (Phase 6).
    permissions: ['organisation.profile.read'],
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
