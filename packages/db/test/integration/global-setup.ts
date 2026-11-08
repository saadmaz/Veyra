import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connects as veyra_app: NOSUPERUSER, NOBYPASSRLS. What the API and worker use. */
    appDatabaseUrl: string;
    /** Connects as veyra_owner: owns the schema, runs migrations. Still subject to FORCE RLS. */
    ownerDatabaseUrl: string;
    /** Connects as the postgres superuser, which bypasses RLS. Only for defence-in-depth tests. */
    superuserDatabaseUrl: string;
  }
}

const packageRoot = resolve(__dirname, '../..');

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolvePort(address.port)
          : reject(new Error('Could not allocate a port')),
      );
    });
  });
}

/**
 * Starts a throwaway PostgreSQL 17 (real binaries, no Docker), creates the VEYRA roles,
 * applies the real Prisma migrations and hands connection URLs to the tests.
 */
export default async function setup(project: TestProject) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'veyra-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: () => undefined,
    onError: (error: unknown) => console.error('[embedded-postgres]', error),
  });

  await pg.initialise();
  await pg.start();

  // Same role setup developers use locally (statements run one by one: CREATE DATABASE cannot
  // run inside a transaction).
  const admin = pg.getPgClient();
  await admin.connect();
  const statements = readFileSync(join(packageRoot, 'sql/bootstrap-roles.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await admin.query(statement);
  await admin.end();

  const ownerDatabaseUrl = `postgresql://veyra_owner:veyra_owner_dev@127.0.0.1:${port}/veyra`;
  const appDatabaseUrl = `postgresql://veyra_app:veyra_app_dev@127.0.0.1:${port}/veyra`;

  execSync('bunx prisma migrate deploy', {
    cwd: packageRoot,
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerDatabaseUrl },
    stdio: 'pipe',
  });

  project.provide('appDatabaseUrl', appDatabaseUrl);
  project.provide('ownerDatabaseUrl', ownerDatabaseUrl);
  project.provide('superuserDatabaseUrl', `postgresql://postgres:postgres@127.0.0.1:${port}/veyra`);

  return async () => {
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
