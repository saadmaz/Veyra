# Commercial launch checklist

Everything here is either done in the code base (✅) or an owner or operator action that must be
done per environment before real customer data is stored (☐). Phase 14's exit review records the
state at the end of the phase.

## Security

- ✅ Row-level security on every tenant table; the application role cannot bypass it.
- ✅ Two-step sign-in (TOTP) required for privileged changes in production.
- ✅ Email verification and password reset with single-use links.
- ✅ Structured logs with redaction; no secrets or personal data in logs.
- ✅ Content-Security-Policy, HSTS and the baseline security headers.
- ✅ Secret scanning (gitleaks) and dependency audit in CI.
- ✅ Upload scanning adapter (ClamAV).
- ☐ ClamAV running and `CLAMAV_HOST` set before uploads are offered.
- ☐ An independent penetration test before significant commercial deployment (AGENTS.md
  section 12), findings fixed or accepted in writing.
- ☐ WebAuthn and breached-password checks (planned, not required for the pilot).

## Operations

- ✅ One container image; full-stack smoke test and restore drill in CI.
- ✅ Production database roles script; deployment, backup and restore, platform admin runbooks.
- ☐ Managed PostgreSQL with point-in-time recovery; bucket versioning on.
- ☐ Keys and passwords generated per environment in a secrets manager.
- ☐ Error tracking and monitoring (OpenTelemetry and Sentry, AGENTS.md section 3) connected to
  the JSON logs and readiness checks; alerts for readiness, error rates and queue backlog.
- ☐ First monthly restore drill in staging, timed.

## Product and providers (owner decisions)

- ☐ Email provider and sending domain (account emails, notifications).
- ☐ Payment provider (online payments; only a sandbox exists).
- ☐ Billing provider for subscriptions, and trial reminders.
- ☐ Whether unconfirmed email addresses may accept invitations.
- ☐ SMS and push notifications (need phone numbers and the resident app).

## Legal and privacy

- ☐ Terms of service, privacy notice and data processing agreement for each target market.
- ☐ Data retention rules per record type; tenant export and deletion procedure (AGENTS.md
  section 13 critical scenarios).
- ☐ No claims of GDPR, ISO 27001 or other certification without the formal work (section 12).
