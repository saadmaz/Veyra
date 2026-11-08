import { defineConfig } from 'prisma/config';

// Prisma CLI configuration (migrate, generate, studio). The application itself connects
// through createDbClient() in src/client.ts using a driver adapter.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Fallback lets `prisma generate` and `prisma validate` run without a database (e.g. in CI
    // lint jobs). Commands that connect (migrate) need a real DATABASE_URL.
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/veyra',
  },
});
