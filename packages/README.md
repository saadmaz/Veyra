# Packages

Shared libraries used by the apps. Packages are never deployed on their own.

| Folder | Package | Purpose | Used by |
| ------ | ------- | ------- | ------- |
| [`domain/`](domain/) | `@veyra/domain` | Framework-free shared kernel: `Money`, `TenantContext`, `JobEnvelope`, `DomainError` | api, worker, web apps |
| [`db/`](db/) | `@veyra/db` | Prisma schema and migrations, database client, tenant transaction helper | api, worker |
| [`api-contracts/`](api-contracts/) | `@veyra/api-contracts` | Wire types for the REST API (error envelope, pagination, money); later generated from OpenAPI | api, console-web, admin-web, resident-mobile |
| [`design-tokens/`](design-tokens/) | `@veyra/design-tokens` | Colours, spacing, type and radius for web (CSS variables) and mobile (JS objects) | all web apps, resident-mobile |
| [`emails/`](emails/) | `@veyra/emails` | Transactional email templates (HTML + plain text) | worker |
| [`web-config/`](web-config/) | `@veyra/web-config` | Shared Next.js configuration (security headers) | console-web, marketing-web, admin-web |

Dependency rules: `domain` depends on nothing internal. No package may import from an app.
