# Security Policy

VEYRA handles resident identity, access logs and financial records, so security reports are
taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately by email to **saadmazaa@gmail.com** with the subject line
`[VEYRA SECURITY] <short summary>`. Include:

- What is affected (app/package, endpoint, version or commit)
- Steps to reproduce or a proof of concept
- The impact you believe it has (e.g. cross-tenant data access, privilege escalation)

You will get an acknowledgement within 3 business days and a status update within 10 business
days. Please give us reasonable time to fix the issue before any disclosure.

## Scope

In scope: everything in this repository (`apps/*`, `packages/*`, CI configuration).
Highest priority: tenant isolation, authorisation, authentication, payment flows, visitor
passes, file access, and leakage of personal data or secrets.

Out of scope: denial-of-service volume testing, social engineering, and findings in third-party
services we use (report those to the provider).

## Supported versions

VEYRA is pre-release. Only the latest commit on `main` receives fixes.

See [docs/security/SECURITY_PRIVACY.md](docs/security/SECURITY_PRIVACY.md) and
[docs/security/THREAT_MODEL.md](docs/security/THREAT_MODEL.md) for the security baseline.
