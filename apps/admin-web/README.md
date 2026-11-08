# VEYRA Platform Admin (`@veyra/admin-web`)

Internal tool for VEYRA staff at `admin.veyra.com`: create and suspend customer organisations,
manage plans and feature flags, and grant **time-boxed, audited** support access. Never
customer-facing, never indexed, and in production reachable only through staff SSO with MFA
(and ideally an IP allow-list).

```powershell
bun run --cwd apps/admin-web dev   # http://localhost:3002
```

Platform staff do not see tenant data by default (see docs/security/ACCESS_CONTROL.md).
