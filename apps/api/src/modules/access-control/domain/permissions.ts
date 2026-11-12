/**
 * Permission registry (docs/security/ACCESS_CONTROL.md). Format: <module>.<resource>.<action>.
 * A permission exists here only once an endpoint uses it; modules add theirs with their first
 * real use case. Routes reference these through @RequirePermission, and startup fails on any
 * string that is not registered here.
 */
export const PERMISSIONS = [
  /** View the organisation's profile and settings. */
  'organisation.profile.read',
  /** Change organisation settings (name, default time zone). */
  'organisation.settings.manage',
  /** List members and their roles. */
  'organisation.member.read',
  /** Suspend, reactivate or revoke memberships. */
  'organisation.member.manage',
  /** Create, list and revoke invitations. */
  'organisation.member.invite',
  /** Add a property to the organisation. */
  'organisation.property.create',
  /** View a property's profile. Property-scoped: evaluated against the route's :propertyId. */
  'property.profile.read',
  /** Edit a property's name, type, address and time zone (country and currency while onboarding). */
  'property.settings.manage',
  /** Activate or archive a property. Archiving archives its whole structure. */
  'property.lifecycle.manage',
  /** View buildings, floors, units and common areas. */
  'property.structure.read',
  /** Create, edit and archive buildings, floors, units and common areas. */
  'property.structure.manage',
  /** Search the organisation's resident directory (all profiles, with contact details). */
  'organisation.resident.read',
  /** View residents of a property: profiles with contact details and their unit records. */
  'property.resident.read',
  /** Add and edit residents of a property; record ownership, tenancies, household, vehicles. */
  'property.resident.manage',
  /** View a unit and its own details. Unit-scoped: evaluated against the route's :unitId. */
  'unit.profile.read',
  /** See who currently owns, rents and lives in a unit (names and roles, no contact details). */
  'unit.residents.read',
  /** Register, list and revoke visitors for a unit (residents of the unit and property staff). */
  'unit.visitor.invite',
  /** Operate a gate: validate passes, admit, deny and record departures (security staff). */
  'property.visitor.check_in',
  /** View the property's visit log and visitor invitations. */
  'property.visitor.read',
  /** Revoke any visitor invitation of the property. */
  'property.visitor.manage',
  /** View the property's chart of accounts, charge types, recurring charges and invoices. */
  'property.finance.read',
  /** Set up the property's finance, manage charge types and recurring charges, run billing, issue and discard invoices. */
  'property.finance.manage',
  /** Approve or reject someone else's request for a reversal, refund, write-off or period reopening. */
  'property.finance.approve',
  /** See your own account on a unit: its invoices, receipts and statement (owners and current tenants). */
  'unit.finance.read',
  /** Tell finance about a bank transfer you made for your own account on a unit. */
  'unit.finance.pay',
  /** Raise and follow a unit's maintenance requests (its residents, and staff on their behalf). */
  'unit.maintenance.request',
  /** View the property's maintenance requests and work orders, with internal notes and costs. */
  'property.maintenance.read',
  /** Triage requests, raise, assign and cancel work orders, record and void costs. */
  'property.maintenance.manage',
  /** Be assigned work orders and carry them out: only the work assigned to you. */
  'property.maintenance.work',
  /** See the property's announcements and who received, read and acknowledged them. */
  'property.announcement.read',
  /** Draft, publish and withdraw the property's announcements. */
  'property.announcement.manage',
  /** Read the property's documents meant for staff (managers: all of them). */
  'property.document.read',
  /** Add documents and versions, edit their details and archive them. */
  'property.document.manage',
  /** Read the documents meant for a unit's residents (owners also those for owners). */
  'unit.document.read',
  /** See the property's incidents (sensitive ones only if you reported them) and whom to call. */
  'property.incident.read',
  /** Report incidents and add notes to the ones you can see. */
  'property.incident.report',
  /** Run the response: statuses, follow-up actions, sensitive records, escalation contacts. */
  'property.incident.manage',
  /** See the property's departments, shifts and handover notes. */
  'property.staff.read',
  /** Keep departments and their members; schedule, move and cancel shifts. */
  'property.staff.manage',
  /** Work shifts at the property: see your own, start them and end them with a handover. */
  'property.staff.work',
  /** View the organisation's vendors and their compliance documents. */
  'organisation.vendor.read',
  /** Register, edit, suspend and archive vendors; add and void their documents. */
  'organisation.vendor.manage',
  /** Book, follow and cancel a unit's facility bookings (owners and tenants, and staff on their behalf). */
  'unit.facility.book',
  /** View the property's facilities, closures and every booking. */
  'property.facility.read',
  /** Set up facilities and closures; approve, reject, cancel and mark bookings used or not used. */
  'property.facility.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionScope = 'organisation' | 'property' | 'unit';

/**
 * Where a permission is evaluated. `property.*` permissions apply to one property (the route's
 * :propertyId) and are granted by organisation-scoped grants or grants on that property.
 * Everything else applies to the whole organisation and only organisation-scoped grants count.
 */
export function permissionScope(permission: Permission): PermissionScope {
  if (permission.startsWith('unit.')) return 'unit';
  return permission.startsWith('property.') ? 'property' : 'organisation';
}

const REGISTERED: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return REGISTERED.has(value);
}

/**
 * Read-only permissions stay available while an organisation is SUSPENDED or OFFBOARDING
 * (ACCESS_CONTROL rule 4). By convention their action is "read".
 */
export function isReadOnlyPermission(permission: Permission): boolean {
  return permission.endsWith('.read');
}
