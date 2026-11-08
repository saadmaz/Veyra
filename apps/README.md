# Apps

Each folder is one deployable application. Naming: `<product>-<platform>` for user-facing apps,
plain names for backend processes.

| Folder | Product name | Who uses it | Tech | Local port | Production URL |
| ------ | ------------ | ----------- | ---- | ---------- | -------------- |
| [`api/`](api/) | VEYRA API | Every client app and integrations | NestJS | 4000 | `api.veyra.com` |
| [`worker/`](worker/) | VEYRA Worker | Nobody directly (background jobs) | Node + BullMQ | 4001 (health) | internal |
| [`console-web/`](console-web/) | VEYRA Console (+ Operations PWA) | Org admins, property managers, finance, committee, security and maintenance staff | Next.js | 3000 | `app.veyra.com` |
| [`resident-mobile/`](resident-mobile/) | VEYRA Resident | Owners, tenants, household members | React Native + Expo | 8081 (Metro) | App Store / Google Play |
| [`marketing-web/`](marketing-web/) | VEYRA website | Prospects, the public | Next.js | 3001 | `veyra.com` |
| [`admin-web/`](admin-web/) | VEYRA Platform Admin | VEYRA staff only | Next.js | 3002 | `admin.veyra.com` (restricted) |

Rules:

- All business logic and authorisation lives in `api/` (and `packages/domain`). Client apps call
  the API; they never talk to the database.
- Shared code goes in `packages/`, not copied between apps.
- Hosted services (status page, help centre, CRM, analytics, identity provider) are not in this
  repo; see [docs/product/PLATFORM_SURFACES.md](../docs/product/PLATFORM_SURFACES.md).
