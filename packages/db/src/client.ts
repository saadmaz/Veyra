import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export type DbClient = PrismaClient;

/**
 * Creates the Prisma client for the API and worker. Prisma 7 connects through a driver adapter
 * (node-postgres). The connection is opened lazily on the first query, so a process can boot and
 * report "not ready" while the database is unavailable.
 */
export function createDbClient(databaseUrl: string): DbClient {
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('createDbClient requires a PostgreSQL connection URL');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
