import { startTestDatabase } from '@veyra/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** veyra_app: the restricted role the API uses in production. */
    appDatabaseUrl: string;
    /** veyra_owner: for test fixtures that the application role may not perform. */
    ownerDatabaseUrl: string;
    /** postgres superuser: only to read platform audit rows, which RLS hides from app roles. */
    superuserDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const db = await startTestDatabase();
  project.provide('appDatabaseUrl', db.appDatabaseUrl);
  project.provide('ownerDatabaseUrl', db.ownerDatabaseUrl);
  project.provide('superuserDatabaseUrl', db.superuserDatabaseUrl);
  return () => db.stop();
}
