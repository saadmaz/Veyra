import { defineConfig } from 'prisma/config';

// Prisma CLI configuration (migrate, generate, studio). Migrations run as the schema owner
// (MIGRATION_DATABASE_URL, role veyra_owner). The application connects as the restricted
// veyra_app role through createDbClient(DATABASE_URL) in src/client.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Fallback lets `prisma generate` and `prisma validate` run without a database.
    url:
      process.env.MIGRATION_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://localhost:5432/veyra',
  },
});
