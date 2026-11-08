import type { TestProject } from 'vitest/node';
import { startTestDatabase } from '../../src/testing';

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

/**
 * Starts a throwaway PostgreSQL 17 (real binaries, no Docker), creates the VEYRA roles,
 * applies the real Prisma migrations and hands connection URLs to the tests.
 */
export default async function setup(project: TestProject) {
  const db = await startTestDatabase();
  project.provide('appDatabaseUrl', db.appDatabaseUrl);
  project.provide('ownerDatabaseUrl', db.ownerDatabaseUrl);
  project.provide('superuserDatabaseUrl', db.superuserDatabaseUrl);
  return () => db.stop();
}
