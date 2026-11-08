# VEYRA Security, Privacy and Trust Baseline

VEYRA processes resident identity and contact details, property relationships, visitor records, financial information, operational incidents, and potentially sensitive documents. Security and privacy are core product requirements.

This document is an engineering baseline, not legal advice or a compliance certification.

## 1. Threat model

Protect against:
- Cross-organisation and cross-property data exposure.
- Privilege escalation and role misuse.
- Account takeover and weak authentication.
- Insecure visitor-pass reuse or forgery.
- Payment replay, forged callbacks, and duplicate processing.
- Unauthorised access to identity documents and incident records.
- Malicious file uploads and unsafe document sharing.
- Insider misuse and untracked support access.
- API abuse, scraping, and denial of service.
- Data loss, ransomware, and misconfigured backups.
- Compromised third-party integrations.

## 2. Identity and access

- Use a maintained OIDC identity provider or managed identity service.
- Require MFA for platform operators and privileged customer administrators.
- Support secure invitation, verification, recovery, session expiry, and revocation.
- Apply least privilege and default-deny authorisation.
- Separate authentication from application authorisation.
- Evaluate both role and resource scope.
- Re-check access when a user changes property context.
- Revoke access on move-out, employment termination, vendor contract end, or membership suspension.
- Log sensitive reads and all privileged mutations.

## 3. Tenant isolation

- Derive organisation context from validated membership.
- Never trust organisation/property identifiers from request bodies as authority.
- Scope every query and mutation.
- Enforce tenant-aware constraints.
- Test horizontal and vertical privilege escalation.
- Include tenant context in jobs, events, exports, and webhook processing.
- Treat platform support access as privileged break-glass access with approval, expiry, reason, and audit trail.

## 4. Application security

- Validate and normalise all input.
- Use parameterised queries.
- Encode output and defend against XSS.
- Apply CSRF protection where cookie-based sessions require it.
- Set secure cookies and security headers.
- Rate-limit authentication, invitation, visitor, export, and payment endpoints.
- Use secure CORS allowlists.
- Protect against SSRF in URL fetch and integration features.
- Scan uploaded files; restrict type, size, and storage access.
- Keep secrets in a secrets manager or secure deployment environment.
- Scan dependencies, containers, and source code in CI.
- Use security review for sensitive changes.

## 5. Financial security

- Use idempotency keys for payment initiation and callback processing.
- Verify provider signatures and callback authenticity.
- Never trust browser redirects as proof of payment.
- Reconcile provider transactions independently.
- Do not store raw card details.
- Keep posted ledger records immutable.
- Use approval thresholds and separation of duties.
- Audit manual payment changes, write-offs, refunds, and adjustments.

## 6. Access control and visitor privacy

- Visitor passes should be random, time-limited, revocable, and scoped to a property/gate/visit.
- QR codes should not expose resident personal information.
- A pass is a reference to a server-side record, not proof of visitor identity.
- Security screens should show minimum necessary information.
- Define retention for visitor logs and incident evidence.
- Do not add facial recognition or biometrics without explicit business necessity, legal assessment, privacy impact assessment, and strong safeguards.

## 7. Privacy governance

For each jurisdiction, obtain qualified legal advice on:
- Controller/processor roles.
- Lawful basis and notices.
- Consent where applicable.
- Purpose limitation and data minimisation.
- Data subject rights.
- Retention and deletion.
- International transfers and data residency.
- Vendor/subprocessor agreements.
- Breach notification obligations.
- CCTV and access-log rules.
- Children and household-member data.

Maintain a data inventory and processing register. Complete a privacy impact assessment for high-risk features.

## 8. Audit and monitoring

Capture:
- Actor and effective identity
- Organisation/property scope
- Action and target resource
- Timestamp
- Outcome
- Correlation/request ID
- Relevant before/after fields where safe

Do not log passwords, access tokens, payment secrets, full identity numbers, or unnecessary sensitive content. Protect audit records against tampering and restrict access.

## 9. Resilience

- Encrypt data in transit and at rest.
- Automate backups and test restores.
- Define RPO/RTO with the customer.
- Separate production from development data.
- Use deployment rollback and database migration safeguards.
- Document incident response, breach response, and disaster recovery.
- Monitor backup success and restore-test outcomes.

## 10. Release security gates

Before production:
- Threat model reviewed.
- Tenant-isolation tests pass.
- Privileged access and MFA verified.
- Dependency and secret scans pass.
- Sensitive file access tested.
- Payment callback and idempotency tests pass.
- Logging reviewed for personal-data leakage.
- Backup restore demonstrated.
- Penetration test or independent security review completed at a risk-appropriate stage.
