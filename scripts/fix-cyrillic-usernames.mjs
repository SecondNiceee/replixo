/**
 * fix-cyrillic-usernames.mjs
 *
 * Finds all users whose username contains non-latin characters
 * and renames them to a safe fallback: "user_<first8charsOfId>".
 *
 * Run: node --env-file-if-exists=/vercel/share/.env.project scripts/fix-cyrillic-usernames.mjs
 */
import pg from 'pg'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const USERNAME_RE = /^[a-zA-Z0-9_]{2,20}$/

async function main() {
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      'SELECT id, username, email FROM "user" WHERE username IS NOT NULL',
    )

    let fixed = 0
    for (const row of rows) {
      if (!USERNAME_RE.test(row.username)) {
        // Build a safe fallback from the user id
        const fallback = 'user_' + row.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
        // Make sure it's unique (append counter if needed)
        let candidate = fallback
        let counter = 1
        while (true) {
          const { rows: conflict } = await client.query(
            'SELECT id FROM "user" WHERE username = $1 AND id != $2',
            [candidate, row.id],
          )
          if (conflict.length === 0) break
          candidate = fallback + counter
          counter++
        }

        await client.query(
          'UPDATE "user" SET username = $1, name = $1, "updatedAt" = NOW() WHERE id = $2',
          [candidate, row.id],
        )
        console.log(`Fixed: ${row.email} | "${row.username}" -> "${candidate}"`)
        fixed++
      }
    }

    console.log(`\nDone. Fixed ${fixed} user(s) out of ${rows.length} total.`)
    if (fixed > 0) {
      console.log(
        'Affected users should log in and change their username via the pencil icon on /profile.',
      )
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
