/**
 * Public interface of the access-control module. Other modules import from here only, never
 * from access-control/domain or /infrastructure directly (ARCHITECTURE section 2).
 */
export {
  AccessControlService,
  type OrganisationAccess,
} from './application/access-control.service';
export { PERMISSIONS, type Permission, permissionScope } from './domain/permissions';
export {
  canAssignRole,
  type Grant,
  isGrantEffective,
  type OrganisationStatus,
  type PropertyStatus,
} from './domain/policy';
export { ROLE_KEYS, ROLES, type RoleKey, roleDefinition, type ScopeType } from './domain/roles';
export {
  CurrentAccess,
  ORGANISATION_ID_PARAM,
  PROPERTY_ID_PARAM,
  RequirePermission,
} from './presentation/require-permission.decorator';
