# Platform administration runbook

Platform administrators are VEYRA staff who manage customer organisations: they see every
organisation's name, status, plan and usage counts (properties, units, members), change plans
and subscription status, and suspend or reactivate organisations. They do **not** see tenant data
(residents, finance, visitors, documents, ...); support access to that comes with Phase 13 Part 3
and is approved by the customer.

## Granting and revoking

Only an operator with the database owner's credentials can grant or revoke the role; the
application can only read it.

```powershell
$env:DATABASE_OWNER_URL = 'postgres://owner:...@host:5432/veyra'
bun run --cwd packages/db platform-admin grant staff@example.com "Support team"
bun run --cwd packages/db platform-admin list
bun run --cwd packages/db platform-admin revoke staff@example.com
```

The person must have signed up first. Revocation takes effect on their next request.

Until MFA exists (ACCESS_CONTROL rule 7), keep the list short and review it monthly.

## The admin tool

`apps/admin-web` (`bun run --cwd apps/admin-web dev`, http://localhost:3002) signs staff in with
their VEYRA account and shows nothing to anyone who is not a platform administrator: the
organisation list with plans, an organisation's usage and history, the plan form, suspension and
reactivation, and support access requests. `API_CORS_ORIGINS` must include its address.

## What platform administrators can do (API `/api/v1/platform`)

| Action | Route | Notes |
| ------ | ----- | ----- |
| Check the role | `GET me` | `{ platformAdmin }`; every other route answers 404 to non-admins |
| List organisations | `GET organisations?search=` | Name, slug, country, status, plan; at most 200 |
| One organisation | `GET organisations/{id}` | Usage counts and subscription history |
| Plans | `GET plans` | Starter, Professional, Enterprise |
| Change the plan or status | `POST organisations/{id}/subscription` | `{ planCode, status, trialEndsAt?, reason }` |
| Suspend / reactivate | `POST organisations/{id}/suspend` or `/reactivate` | `{ reason }`; suspended organisations are read-only |

Every change needs a reason and is written by the database into the customer's own subscription
history and audit log, so they can see who changed what and why.

## Support access

To look at a customer's data, ask them: `POST /api/v1/platform/organisations/{id}/support-access`
with `{ reason, hours }` (1 to 24). An organisation admin approves or denies it in the console;
once approved you can read everything in that organisation, and change nothing, until the hours
end or they revoke it. Every step is in their audit log. `GET /api/v1/platform/support-access`
lists your requests.

## Subscription states

| Status | Effect |
| ------ | ------ |
| `TRIAL` | Everything in the plan until `trial_ends_at`; afterwards read-only |
| `ACTIVE` | Everything in the plan |
| `PAST_DUE` | Everything in the plan (grace while payment is chased) |
| `CANCELLED` | Read-only |

Plan limits (properties, units) are enforced by the database: a customer over a limit after a
downgrade keeps what they have but cannot add more.
