/**
 * Public interface of the identity module. Other modules import from here only
 * (ARCHITECTURE section 2).
 */
export {
  type AuthenticatedPrincipal,
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from './application/identity-provider';
export { CurrentPrincipal } from './presentation/current-principal.decorator';
