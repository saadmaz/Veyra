import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Documents (migration 20261125090000_documents): versions are numbered per document, only on
 * active documents, under the tenant's key prefix, of an allowed type and size; checked once and
 * never changed otherwise; archived documents are final and take no versions; tenant-isolated.
 */

let app: pg.Pool;
const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  manager: randomUUID(),
};

async function inTenant<T>(org: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.manager]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const asOrg = <T>(work: (c: pg.PoolClient) => Promise<T>) => inTenant(ids.org, work);

async function document(c: pg.PoolClient) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO documents (id, organisation_id, property_id, title, category, audience, created_by_user_id, updated_at)
     VALUES ($1, $2, $3, 'House rules', 'RULES', 'EVERYONE', $4, now())`,
    [id, ids.org, ids.prop, ids.manager],
  );
  return id;
}

async function version(
  c: pg.PoolClient,
  documentId: string,
  over: { key?: string; type?: string; size?: number } = {},
) {
  const id = randomUUID();
  const { rows } = await c.query(
    `INSERT INTO document_versions (id, organisation_id, property_id, document_id, storage_key, file_name, content_type,
       size_bytes, uploaded_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'rules.pdf', $6, $7, $8) RETURNING version_number`,
    [
      id,
      ids.org,
      ids.prop,
      documentId,
      over.key ?? `org/${ids.org}/prop/${ids.prop}/documents/${id}`,
      over.type ?? 'application/pdf',
      over.size ?? 1000,
      ids.manager,
    ],
  );
  return { id, number: rows[0].version_number as number };
}

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Manager', now())`,
    [ids.manager, `doc-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `dc-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Docs', 'DC', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

describe('documents', () => {
  it('number versions, keep files under the tenant prefix, allow only safe types and sizes', async () => {
    const d = await asOrg(document);
    expect((await asOrg((c) => version(c, d))).number).toBe(1);
    expect((await asOrg((c) => version(c, d))).number).toBe(2);
    await expect(asOrg((c) => version(c, d, { key: `org/${ids.otherOrg}/x` }))).rejects.toThrow(
      /document_versions_key/,
    );
    await expect(asOrg((c) => version(c, d, { type: 'text/html' }))).rejects.toThrow(
      /document_versions_file/,
    );
    await expect(asOrg((c) => version(c, d, { size: 21 * 1024 * 1024 }))).rejects.toThrow(
      /document_versions_file/,
    );
  });

  it('check a version once, and take no versions once archived', async () => {
    const d = await asOrg(document);
    const v = await asOrg((c) => version(c, d));
    await asOrg((c) =>
      c.query(`UPDATE document_versions SET status = 'READY' WHERE id = $1`, [v.id]),
    );
    await expect(
      asOrg((c) =>
        c.query(`UPDATE document_versions SET status = 'REJECTED' WHERE id = $1`, [v.id]),
      ),
    ).rejects.toThrow(/checked once/);
    await asOrg((c) => c.query(`UPDATE documents SET status = 'ARCHIVED' WHERE id = $1`, [d]));
    await expect(asOrg((c) => version(c, d))).rejects.toThrow(/document is archived/);
    await expect(
      asOrg((c) => c.query(`UPDATE documents SET title = 'x' WHERE id = $1`, [d])),
    ).rejects.toThrow(/archived and no longer changes/);
  });

  it('are invisible to another organisation and never deleted', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM documents)::int AS d, (SELECT count(*) FROM document_versions)::int AS v`,
      ),
    );
    expect(rows[0]).toEqual({ d: 0, v: 0 });
    await expect(asOrg((c) => c.query(`DELETE FROM document_versions`))).rejects.toThrow(
      /permission denied/,
    );
  });
});
