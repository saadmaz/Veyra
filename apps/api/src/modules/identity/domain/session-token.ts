/** Session tokens are opaque bearer secrets; see platform/security/opaque-token.ts. */
export {
  generateOpaqueToken as generateSessionToken,
  hashOpaqueToken as hashSessionToken,
  isWellFormedOpaqueToken as isWellFormedSessionToken,
} from '../../../platform/security/opaque-token';
