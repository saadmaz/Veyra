import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client';

export type DbClient = PrismaClient;

/** The client handed to `$transaction(async (tx) => ...)` callbacks. */
export type DbTransaction = Prisma.TransactionClient;

/** Generated model row types, for repositories that map rows to domain objects. */
export type { Session as SessionRow, User as UserRow } from './generated/prisma/client';

/**
 * True when `error` is a unique-constraint violation, optionally on a specific column. Lets
 * callers turn races (two sign-ups with one email) into a domain error without importing Prisma.
 */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (column === undefined) return true;
  return JSON.stringify(error.meta ?? {}).includes(column);
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The PostgreSQL SQLSTATE (e.g. "23514" check violation, "23P01" exclusion violation) inside an
 * error raised through Prisma and its driver adapter, or undefined. The code may sit at
 * different depths depending on where the error was raised (statement or deferred check at
 * commit), so nested `code` / `originalCode` fields are searched. Prisma's own codes (P2002...)
 * are not SQLSTATEs and are ignored.
 */
export function databaseErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['originalCode', 'code']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && SQLSTATE.test(candidate) && !candidate.startsWith('P')) {
        return candidate;
      }
    }
    for (const key of ['cause', 'meta', 'driverAdapterError', 'error']) {
      const found = visit(record[key], depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(error, 0);
}

/**
 * Creates the Prisma client for the API and worker. Prisma 7 connects through a driver adapter
 * (node-postgres). The connection is opened lazily on the first query, so a process can boot and
 * report "not ready" while the database is unavailable.
 */
export function createDbClient(databaseUrl: string): DbClient {
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('createDbClient requires a PostgreSQL connection URL');
  }
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      // Pin the session time zone to UTC. The pg driver adapter mis-reads timestamptz values
      // when the server's TimeZone is not UTC (the offset is dropped), which would shift every
      // expiry by the server's offset. Regression test: test/integration/time-zone.int.test.ts.
      options: '-c TimeZone=UTC',
    }),
  });
}
