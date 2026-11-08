import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { createDbClient } from '../../src';
import { TEST_SERVER_TIME_ZONE } from '../../src/testing';

/**
 * The test server runs in a non-UTC zone. Timestamps must mean the same instant whether written
 * or compared by SQL (now()) or by the application through Prisma.
 */
describe('time zones', () => {
  it('the test server really runs in a non-UTC zone', async () => {
    const client = new pg.Client({ connectionString: inject('appDatabaseUrl') });
    await client.connect();
    try {
      const { rows } = await client.query('SHOW timezone');
      expect(rows[0].TimeZone).toBe(TEST_SERVER_TIME_ZONE);
    } finally {
      await client.end();
    }
  });

  it('Prisma reads server-side now() as the correct instant', async () => {
    const db = createDbClient(inject('appDatabaseUrl'));
    try {
      const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      expect(Math.abs((row?.now.getTime() ?? 0) - Date.now())).toBeLessThan(5_000);
    } finally {
      await db.$disconnect();
    }
  });

  it('values written by Prisma compare correctly with now() in SQL', async () => {
    const db = createDbClient(inject('appDatabaseUrl'));
    const id = randomUUID();
    try {
      await db.user.create({ data: { id, email: `tz-${id}@example.test`, displayName: 'TZ' } });
      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 60_000);
      await db.session.create({
        data: {
          userId: id,
          tokenHash: randomUUID(),
          client: 'WEB',
          idleExpiresAt: past,
          absoluteExpiresAt: future,
        },
      });
      const [row] = await db.$queryRaw<{ idle_passed: boolean; absolute_passed: boolean }[]>`
        SELECT idle_expires_at < now() AS idle_passed, absolute_expires_at < now() AS absolute_passed
          FROM sessions WHERE user_id = ${id}::uuid`;
      expect(row).toEqual({ idle_passed: true, absolute_passed: false });

      const read = await db.session.findFirstOrThrow({ where: { userId: id } });
      expect(read.idleExpiresAt.getTime()).toBe(past.getTime());
    } finally {
      await db.$disconnect();
    }
  });
});
