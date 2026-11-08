# Platform Surfaces

Everything VEYRA needs as a product, what it is for, and whether it is built in this repository
or provided by a hosted service. Rule: build what differentiates VEYRA, use services for the rest.

## Customer-facing

| Surface | Purpose | Build or service | Location | URL |
| ------- | ------- | ---------------- | -------- | --- |
| Website | Product, pricing, blog, trust, legal, contact | Build | `apps/marketing-web` | `veyra.com` |
| VEYRA Console | Management web app | Build | `apps/console-web` | `app.veyra.com` |
| VEYRA Operations | Frontline staff PWA | Build | inside `apps/console-web` | `app.veyra.com` |
| VEYRA Resident | iOS/Android resident app | Build | `apps/resident-mobile` | App Store, Google Play |
| Public API | Integrations and partners | Build | `apps/api` | `api.veyra.com` |
| Developer docs | API reference generated from OpenAPI | Build (generated) or Scalar/Redocly/Mintlify | later `apps/developer-docs` | `developers.veyra.com` |
| Status page | Uptime, incidents, maintenance notices, subscriptions | **Service**: Better Stack, Instatus or Atlassian Statuspage. Must be hosted separately from VEYRA so it stays up when VEYRA is down | external | `status.veyra.com` |
| Help centre | Guides and FAQs for admins and residents | Service (Intercom, HelpScout, Crisp) | external | `help.veyra.com` |
| Transactional email/SMS | Invites, receipts, alerts, visitor passes | Templates built (`packages/emails`); sending via Resend/Postmark/SES and Twilio | `packages/emails` + worker | n/a |
| Vendor portal | Contractors see only assigned jobs | Build (later) | area of `apps/console-web` | `app.veyra.com` |

## Internal

| Tool | Purpose | Build or service |
| ---- | ------- | ---------------- |
| Platform Admin | Provision customers, plans, feature flags, audited support access | Build: `apps/admin-web` (`admin.veyra.com`, staff SSO + MFA) |
| Support inbox / chat | Customer tickets | Service (Intercom, HelpScout, Zendesk) |
| CRM | Leads, demos, deals | Service (HubSpot, Pipedrive) |
| Subscription billing | Charging VEYRA customers, tax, dunning | Service (Stripe Billing or Paddle); VEYRA reads entitlements |
| Product analytics | Feature usage, funnels | Service (PostHog, Mixpanel) |
| Feature flags | Per-tenant rollout | PostHog / Unleash / GrowthBook, or a database table |

## Infrastructure services

| Need | Recommendation |
| ---- | -------------- |
| API + worker hosting | Railway, Render or Fly.io first; AWS/GCP later |
| PostgreSQL | Managed with point-in-time restore (Neon, Supabase, RDS, Railway) |
| Redis | Managed (Upstash, Railway) |
| Object storage | Cloudflare R2 or S3 |
| Identity provider | Clerk, WorkOS, Auth0, or self-hosted Zitadel/Keycloak. Never build auth in-house |
| DNS, CDN, TLS, WAF | Cloudflare |
| Web hosting | Vercel or Cloudflare Pages |
| Error tracking | Sentry |
| Logs, metrics, uptime, alerting | Better Stack, Grafana Cloud or Datadog |
| Push notifications | Expo Push Service (backed by FCM/APNs) |
| Mobile builds and store submission | EAS Build / EAS Submit |
| Resident payments | Country-specific gateways behind the payment adapter |
| CI/CD | GitHub Actions |
| Secrets | Hosting platform secrets, Doppler or 1Password |

## Business and legal

Domains (and a trademark check for "VEYRA"), Terms of Service, Privacy Policy, Data Processing
Agreement, sub-processor list, company entity and bank account, business email (`support@`,
`security@`, `billing@`), `security.txt`, SLA document, Apple Developer and Google Play accounts.

## Domain map

```
veyra.com              apps/marketing-web
app.veyra.com          apps/console-web (Console + Operations PWA)
api.veyra.com          apps/api
admin.veyra.com        apps/admin-web (restricted)
developers.veyra.com   API docs
help.veyra.com         help centre (service)
status.veyra.com       status page (service, separate infrastructure)
```
