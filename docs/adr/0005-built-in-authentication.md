# ADR 0005: Built-in authentication behind a replaceable identity port

- **Status:** Accepted
- **Date:** 2026-11-08
- **Amends:** the "OIDC-compatible provider" line in the technology stack (AGENTS.md, section 3)
  and the Phase 2 plan in the roadmap, for the prototype and pilot stages

## Context

The brief names an OIDC-compatible identity provider. Candidates were Keycloak or Zitadel
(self-hosted) and Auth0, WorkOS or Clerk (managed). For the prototype the product owner decided
not to take on an external provider yet: it adds cost, an extra service to run (self-hosted) or
a vendor contract (managed), and slows local development, before the product has pilot users.

The cost of getting authentication wrong is high (account takeover is threat T3), so "built in"
must not mean "simplified".

## Decision

1. VEYRA implements **built-in authentication** in the API (Phase 2, Part 4):
   - Email + password. Passwords hashed with **argon2id** (memory-hard, parameters reviewed
     against current OWASP guidance), stored as a PHC string in `password_credentials`.
   - **Server-side sessions**: an opaque 32-byte random token is given to the client; only its
     SHA-256 hash is stored (`sessions.token_hash`). Sessions have an idle expiry and an absolute
     expiry and can be revoked individually or all at once.
   - Web: token in an `httpOnly`, `Secure`, `SameSite=Lax` cookie. Mobile: bearer token in the
     platform secure store.
   - Redis-backed rate limiting on sign-in, sign-up and invitation endpoints; generic error
     messages that do not reveal whether an account exists.
   - Sign-in, sign-out, failed sign-in and session revocation are written to the append-only
     audit log.
2. All of this sits behind an **identity port** (an `IdentityProvider`-style interface in the
   API's identity module). Controllers, guards and other modules depend only on the port's
   output: an authenticated internal `userId` and session metadata. Nothing outside the
   identity module reads `password_credentials` or `sessions`.
3. **Authorisation stays in VEYRA** regardless of the authentication provider: memberships,
   roles, scopes and row-level security (MULTI_TENANCY, ACCESS_CONTROL) do not change when the
   provider changes.

## Consequences

- No external service or vendor is needed for development, CI or the first pilot.
- VEYRA owns password storage, so it also owns breach exposure for credentials. Mitigations:
  argon2id, no plaintext or hashes in logs or API responses, rate limiting, audit, dependency
  scanning, and penetration testing before commercial launch (Phase 14).
- **Provided in Phase 14 Part 1:** email verification and password reset through one-time
  links (only SHA-256 hashes stored, a day and an hour respectively; a reset ends every
  session; the reset request answers the same whether or not the account exists).
- **Not yet provided**, and required before a privileged customer goes live: MFA (TOTP or
  WebAuthn) for privileged roles, email verification, password reset, and breached-password
  checks. These are tracked in the roadmap. ACCESS_CONTROL's MFA requirement for privileged
  mutating operations still applies and will be enforced from session metadata instead of an
  `amr` claim.
- **Migration path to OIDC** (Clerk, WorkOS, Zitadel or similar): add an `external_identities`
  table (`user_id`, `issuer`, `subject`, unique `(issuer, subject)`), implement the port with
  token validation against the provider's JWKS, link existing users by verified email, then
  retire `password_credentials`. Enterprise SSO (SAML/OIDC per customer) is expected to be the
  trigger for this change.
- Revisit this decision before Stage 4 (enterprise controls) or earlier if a customer requires
  SSO or a certified identity provider.
