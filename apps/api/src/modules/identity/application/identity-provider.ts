import type { SessionClientType } from '../domain/session-policy';
import type { RequestMeta } from './ports';

/** The authenticated caller. Carries identity only: authorisation is decided per request. */
export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
  client: SessionClientType;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

/** A token as presented on the wire, and the transport it arrived on. */
export interface PresentedCredential {
  token: string;
  transport: SessionClientType;
}

/**
 * The identity port (ADR 0005). Guards and other modules depend only on this interface, so the
 * built-in implementation can be replaced by an OIDC provider without touching them.
 */
export interface IdentityProvider {
  /** Resolves a presented credential to a principal, or null if it is not valid now. */
  authenticate(credential: PresentedCredential): Promise<AuthenticatedPrincipal | null>;
  /** Ends the principal's current session. */
  signOut(principal: AuthenticatedPrincipal, meta: RequestMeta): Promise<void>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
