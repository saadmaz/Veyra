/*
 * Grants or revokes VEYRA platform administration (Phase 13). Run by an operator with the
 * database owner's credentials; the application role can only read platform_admins.
 *
 *   DATABASE_OWNER_URL=postgres://... bun run --cwd packages/db platform-admin grant someone@example.com "note"
 *   DATABASE_OWNER_URL=postgres://... bun run --cwd packages/db platform-admin revoke someone@example.com
 *   DATABASE_OWNER_URL=postgres://... bun run --cwd packages/db platform-admin list
 *
 * The person must already have signed up. Platform administrators should use MFA once it exists
 * (ACCESS_CONTROL rule 7); until then grant it sparingly.
 */
import pg from 'pg';

async function main() {
  const [command, email, note] = process.argv.slice(2);
  const url = process.env.DATABASE_OWNER_URL;
  if (!url || !command || !['grant', 'revoke', 'list'].includes(command)) {
    console.error(
      'Usage: platform-admin grant|revoke <email> [note] | list  (needs DATABASE_OWNER_URL)',
    );
    process.exit(2);
  }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    if (command === 'list') {
      const { rows } = await db.query(
        `SELECT u.email, a.note, a.granted_at, a.revoked_at
           FROM platform_admins a JOIN users u ON u.id = a.user_id ORDER BY a.granted_at`,
      );
      console.table(rows);
      return;
    }
    const user = await db.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
    const id = user.rows[0]?.id as string | undefined;
    if (!id) throw new Error(`No user with the email ${email}`);
    if (command === 'grant') {
      await db.query(
        `INSERT INTO platform_admins (user_id, note) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET revoked_at = NULL, granted_at = now(), note = EXCLUDED.note`,
        [id, note ?? null],
      );
      console.log(`${email} is a platform administrator.`);
    } else {
      await db.query(`UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1`, [id]);
      console.log(`${email} is no longer a platform administrator.`);
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
