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
      'unit.visitor.invite',
      'property.visitor.check_in',
      'property.visitor.read',
      'property.visitor.manage',
      'property.finance.read',
      'property.finance.manage',
      'property.finance.approve',
      // Unit-scoped "your own account" permissions: they show nothing unless the admin is also
      // an owner or tenant of the unit (the account is resolved from their own records).
      'unit.finance.read',
      'unit.finance.pay',
      'unit.maintenance.request',
      'property.maintenance.read',
      'property.maintenance.manage',
      'property.maintenance.work',
      'unit.facility.book',
      'property.facility.read',
      'property.facility.manage',
      'property.staff.read',
      'property.staff.manage',
      'property.staff.work',
      'organisation.vendor.read',
      'organisation.vendor.manage',
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
      'unit.visitor.invite',
      'property.visitor.check_in',
      'property.visitor.read',
      'property.visitor.manage',
      // Reads the property's billing; finance officers run it (ACCESS_CONTROL section 4).
      'property.finance.read',
      // Runs maintenance (ACCESS_CONTROL section 4: M), and may do work themselves.
      'unit.maintenance.request',
      'property.maintenance.read',
      'property.maintenance.manage',
      'property.maintenance.work',
      'unit.facility.book',
      'property.facility.read',
      'property.facility.manage',
      'property.staff.read',
      'property.staff.manage',
      'property.staff.work',
    ],
  },
  MAINTENANCE_MANAGER: {
    name: 'Maintenance manager',
    grantableAt: ['PROPERTY'],
    // Runs maintenance for a property: triage, work orders, technicians, costs. Sees who lives
    // where (to arrange access), not finance or visitors.
    permissions: [
      'property.profile.read',
      'property.structure.read',
      'property.resident.read',
      'unit.profile.read',
      'unit.residents.read',
      'unit.maintenance.request',
      'property.maintenance.read',
      'property.maintenance.manage',
      'property.maintenance.work',
      'property.staff.read',
      'property.staff.manage',
      'property.staff.work',
    ],
  },
  TECHNICIAN: {
    name: 'Technician',
    grantableAt: ['PROPERTY'],
    // Only the work assigned to them (ACCESS_CONTROL section 4: O). No resident data: a work
    // order shows the unit or common area and the problem, not who reported it.
    permissions: [
      'property.profile.read',
      'property.structure.read',
      'property.maintenance.work',
      'property.staff.work',
    ],
  },
  SECURITY_SUPERVISOR: {
    name: 'Security supervisor',
    grantableAt: ['PROPERTY'],
    // Runs the gate team: operates the gate, reads the visit log, revokes invitations.
    permissions: [
      'property.profile.read',
      'property.structure.read',
      'property.visitor.check_in',
      'property.visitor.read',
      'property.visitor.manage',
      'property.staff.read',
      'property.staff.manage',
      'property.staff.work',
      // Sees who has booked a facility, to let them in.
      'property.facility.read',
    ],
  },
  SECURITY_GUARD: {
    name: 'Security guard',
    grantableAt: ['PROPERTY'],
    // Gate work only. Sees unit numbers and the visitor in front of them, never resident contact
    // details or the full visit log (PRD 3.3: the minimum necessary).
    permissions: [
      'property.profile.read',
      'property.structure.read',
      'property.visitor.check_in',
      'property.staff.work',
    ],
  },
  FINANCE_OFFICER: {
    name: 'Finance officer',
    grantableAt: ['ORGANISATION', 'PROPERTY'],
    // Runs billing. Sees the names of the people an invoice is addressed to through finance
    // views only, not the resident directory or contact details (data minimisation).
    permissions: [
      'organisation.profile.read',
      'property.profile.read',
      'property.structure.read',
      'unit.profile.read',
      'property.finance.read',
      'property.finance.manage',
      'property.finance.approve',
      // Maintenance costs for reporting (ACCESS_CONTROL section 4: R).
      'property.maintenance.read',
      // Vendors they pay (Phase 9).
      'organisation.vendor.read',
    ],
  },
  // ------------------------------------------------------------------ derived resident roles
  OWNER: {
    name: 'Owner',
    grantableAt: ['UNIT'],
    derived: true,
    // Finance: the owners' account of the unit only (owner decision, 2026-11-11).
    permissions: [
      'unit.profile.read',
      'unit.residents.read',
      'unit.visitor.invite',
      'unit.finance.read',
      'unit.finance.pay',
      'unit.maintenance.request',
      'unit.facility.book',
    ],
  },
  TENANT: {
    name: 'Tenant',
    grantableAt: ['UNIT'],
    derived: true,
    // Finance: their current tenancy's account only, never the owners'.
    permissions: [
      'unit.profile.read',
      'unit.residents.read',
      'unit.visitor.invite',
      'unit.finance.read',
      'unit.finance.pay',
      'unit.maintenance.request',
      'unit.facility.book',
    ],
  },
  HOUSEHOLD_MEMBER: {
    name: 'Household member',
    grantableAt: ['UNIT'],
    derived: true,
    // Household members may register visitors and raise maintenance requests (owner decisions,
    // 2026-11-11). Facility bookings only once delegated (owner decision, 2026-11-12); delegation
    // is not built yet, so they do not book.
    permissions: ['unit.profile.read', 'unit.visitor.invite', 'unit.maintenance.request'],
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
