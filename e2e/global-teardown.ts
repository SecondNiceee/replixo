import { existsSync } from 'node:fs'
import { Pool } from 'pg'
import { E2E_EMAIL_DOMAIN } from './helpers'

for (const file of ['.env.development.local', '.env.local', '.env']) {
  if (!process.env.DATABASE_URL && existsSync(file)) process.loadEnvFile(file)
}

export default async function globalTeardown() {
  if (!process.env.DATABASE_URL) {
    console.warn('[e2e] DATABASE_URL не задан — тестовые аккаунты не удалены')
    return
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    // Сессии, аккаунты и прочие связанные записи удаляются каскадом.
    const { rowCount } = await pool.query(
      `DELETE FROM "user" WHERE email LIKE $1`,
      [`e2e-%@${E2E_EMAIL_DOMAIN}`],
    )
    console.log(`[e2e] удалено тестовых аккаунтов: ${rowCount ?? 0}`)
  } finally {
    await pool.end()
  }
}
