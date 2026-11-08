import { spawnSync } from 'node:child_process';
import { describe, expect, inject, it } from 'vitest';
import { dbPackageRoot } from '../../src/testing';

describe('migrations', () => {
  it('produce exactly the database that schema.prisma describes (no drift)', () => {
    // Compares the migrated database with the Prisma schema. Exit code 0 = identical,
    // 2 = differences (a schema change without a migration, or a hand edit Prisma does not model).
    const result = spawnSync(
      'bunx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        cwd: dbPackageRoot,
        env: { ...process.env, MIGRATION_DATABASE_URL: inject('ownerDatabaseUrl') },
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    expect(result.stdout + result.stderr).not.toMatch(/\[\+\]|\[-\]|\[\*\]/);
    expect(result.status).toBe(0);
  });
});
