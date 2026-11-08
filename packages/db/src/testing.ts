import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * TEST-ONLY helper (import from "@veyra/db/testing"). Never import it from application code:
 * it depends on embedded-postgres, a development dependency.
 */
export interface TestDatabase {
  /** veyra_app: NOSUPERUSER, NOBYPASSRLS. What the API and worker use. */
  appDatabaseUrl: string;
  /** veyra_owner: owns the schema, runs migrations. Still subject to FORCE RLS. */
  ownerDatabaseUrl: string;
  /** postgres superuser: bypasses RLS. Only for defence-in-depth assertions. */
  superuserDatabaseUrl: string;
  stop(): Promise<void>;
}

/** Server default time zone of the test database. Deliberately not UTC. */
export const TEST_SERVER_TIME_ZONE = 'Pacific/Chatham';

// src/testing.ts and dist/testing.js both sit one level below the package root.
const packageRoot = resolve(__dirname, '..');

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

/** Reads bootstrap-roles.sql as individual statements (CREATE DATABASE cannot run in a transaction). */
function bootstrapStatements(): string[] {
  return readFileSync(join(packageRoot, 'sql/bootstrap-roles.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Starts a throwaway PostgreSQL 17 (real binaries, no Docker) on a free port with a temporary
 * data directory, creates the VEYRA roles exactly as local development does, and applies the
 * real Prisma migrations as veyra_owner.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'veyra-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    // Keep the library from deleting the data directory in stop(): it does so without retries,
    // which fails intermittently on Windows. removeDataDir() below deletes it with retries.
    persistent: true,
    // Linux and macOS binaries need shared-library symlinks that the platform package's
    // postinstall script normally creates. Bun skips untrusted postinstall scripts (CI runs on
    // Linux), so recreate any missing symlinks on start instead.
    autoRehydrateSymlinks: true,
    // Run the server in a non-UTC zone with an unusual offset (+13:45 / +12:45) on every
    // machine, including UTC CI runners, so time-zone handling bugs cannot hide.
    postgresFlags: ['-c', `timezone=${TEST_SERVER_TIME_ZONE}`],
    onLog: () => undefined,
    onError: (error: unknown) => console.error('[embedded-postgres]', error),
  });

  await pg.initialise();
  await pg.start();

  try {
    const admin = pg.getPgClient();
    await admin.connect();
    try {
      for (const statement of bootstrapStatements()) await admin.query(statement);
    } finally {
      await admin.end();
    }

    const ownerDatabaseUrl = `postgresql://veyra_owner:veyra_owner_dev@127.0.0.1:${port}/veyra`;
    execSync('bunx prisma migrate deploy', {
      cwd: packageRoot,
      env: { ...process.env, MIGRATION_DATABASE_URL: ownerDatabaseUrl },
      stdio: 'pipe',
    });

    return {
      appDatabaseUrl: `postgresql://veyra_app:veyra_app_dev@127.0.0.1:${port}/veyra`,
      ownerDatabaseUrl,
      superuserDatabaseUrl: `postgresql://postgres:postgres@127.0.0.1:${port}/veyra`,
      async stop() {
        await pg.stop();
        removeDataDir(dataDir);
      },
    };
  } catch (error) {
    await pg.stop();
    removeDataDir(dataDir);
    throw error;
  }
}

/**
 * On Windows the server processes can hold files for a moment after stop(), so deletion is
 * retried. A directory that still cannot be removed is only a leftover in the OS temp folder:
 * warn instead of failing a test run whose tests passed.
 */
function removeDataDir(dataDir: string): void {
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(
      `[test-database] could not remove ${dataDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Absolute path of the db package, for tests that run Prisma CLI commands. */
export const dbPackageRoot = packageRoot;
